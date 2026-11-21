"""
NEXOFIS — Motor de OCR de Alta Eficiência (Híbrido Nativo + PaddleOCR PT-BR)
Licença: GNU AGPL-3.0-only (Eduardo Muniz — DM Technology)

Recursos de eficiência:
1. Cache LRU em memória por hash SHA-256 (zero retrabalho em documentos repetidos).
2. Inspeção nativa por página via pypdfium2: páginas digitais extraem texto direto (<5 ms)
   e APENAS páginas escaneadas vão para o motor neural PaddleOCR.
3. Pré-processamento adaptativo (escala de cinza, autocontraste, nitidez) para scans de
   Diários Oficiais e contratos carimbados.
4. DPI adaptativo: renderização rápida em 180 DPI com retry automático em 260 DPI apenas
   quando a confiança média da página ficar abaixo do limiar configurado.
5. Processamento paralelo em pool de threads (OCR_WORKERS) + endpoint em lote (/ocr/batch).
"""

from __future__ import annotations

import hashlib
import io
import os
import re
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from typing import Any

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from PIL import Image, ImageFilter, ImageOps

MAX_UPLOAD_BYTES = int(os.getenv("OCR_MAX_UPLOAD_BYTES", str(20 * 1024 * 1024)))
MAX_PAGES = int(os.getenv("OCR_MAX_PAGES", "60"))
OCR_LANG = os.getenv("PADDLE_OCR_LANG", "pt")
OCR_WORKERS = max(1, min(int(os.getenv("OCR_WORKERS", "4")), 8))
DEFAULT_DPI = max(120, min(int(os.getenv("OCR_DEFAULT_DPI", "180")), 300))
RETRY_DPI = max(DEFAULT_DPI + 40, min(int(os.getenv("OCR_RETRY_DPI", "260")), 360))
LOW_CONFIDENCE_THRESHOLD = float(os.getenv("OCR_RETRY_CONFIDENCE", "0.78"))
NATIVE_MIN_CHARS = int(os.getenv("OCR_NATIVE_MIN_CHARS", "60"))
CACHE_MAX_ITEMS = int(os.getenv("OCR_CACHE_MAX_ITEMS", "128"))

app = FastAPI(title="NEXOFIS High-Efficiency OCR Engine", version="0.2.0")

_ocr_engine: Any = None
_engine_lock = Lock()
_cache: OrderedDict[str, dict[str, Any]] = OrderedDict()
_cache_lock = Lock()


def get_ocr_engine() -> Any:
    global _ocr_engine
    if _ocr_engine is None:
        with _engine_lock:
            if _ocr_engine is None:
                from paddleocr import PaddleOCR  # type: ignore

                _ocr_engine = PaddleOCR(
                    use_angle_cls=True,
                    lang=OCR_LANG,
                    enable_mkldnn=True,
                    show_log=False,
                )
    return _ocr_engine


def preprocess_for_ocr(img: Image.Image) -> Image.Image:
    """Melhora contraste e nitidez de contratos escaneados preservando leitura em RGB."""
    gray = ImageOps.grayscale(img)
    enhanced = ImageOps.autocontrast(gray, cutoff=1)
    sharpened = enhanced.filter(ImageFilter.SHARPEN)
    return sharpened.convert("RGB")


def postprocess_ptbr_text(text: str) -> str:
    """Remove quebras hifenizadas e normaliza espaços sem inventar conteúdo."""
    text = re.sub(r"([A-Za-zÀ-ÿ]{2,})-\n([a-zà-ÿ]{2,})", r"\1\2", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def run_paddle_on_image(img: Image.Image) -> tuple[str, float | None]:
    import numpy as np  # type: ignore

    processed = preprocess_for_ocr(img)
    engine = get_ocr_engine()
    # Serializa chamadas ao runtime Paddle em CPU compartilhada se necessário
    with _engine_lock:
        result = engine.ocr(np.array(processed), cls=True)

    lines: list[str] = []
    scores: list[float] = []
    if result and result[0]:
        for item in result[0]:
            if len(item) >= 2 and isinstance(item[1], (list, tuple)) and len(item[1]) >= 2:
                txt = str(item[1][0]).strip()
                conf = float(item[1][1])
                if txt:
                    lines.append(txt)
                    scores.append(conf)

    mean_score = round(sum(scores) / len(scores), 4) if scores else None
    return postprocess_ptbr_text("\n".join(lines)), mean_score


def extract_pdf_hybrid(pdf_bytes: bytes, force_ocr: bool = False) -> list[dict[str, Any]]:
    import pypdfium2 as pdfium  # type: ignore

    doc = pdfium.PdfDocument(pdf_bytes)
    total = min(len(doc), MAX_PAGES)

    native_results: dict[int, dict[str, Any]] = {}
    ocr_targets: list[tuple[int, Image.Image, float]] = []

    default_scale = DEFAULT_DPI / 72.0
    retry_scale = RETRY_DPI / 72.0

    for idx in range(total):
        page_num = idx + 1
        page = doc[idx]
        if not force_ocr:
            try:
                textpage = page.get_textpage()
                native_text = postprocess_ptbr_text(textpage.get_text_range() or "")
                textpage.close()
                if len(native_text) >= NATIVE_MIN_CHARS and "\ufffd" not in native_text:
                    native_results[page_num] = {
                        "page_number": page_num,
                        "method": "native",
                        "text": native_text,
                        "mean_ocr_score": 1.0,
                        "dpi": None,
                    }
                    continue
            except Exception:
                pass

        bitmap = page.render(scale=default_scale)
        ocr_targets.append((page_num, bitmap.to_pil().convert("RGB"), default_scale))

    def process_ocr_page(target: tuple[int, Image.Image, float]) -> dict[str, Any]:
        page_num, img, _scale = target
        text, mean_score = run_paddle_on_image(img)
        used_dpi = DEFAULT_DPI

        # Retry adaptativo em maior resolução apenas se a confiança ficar baixa
        if (mean_score is None or mean_score < LOW_CONFIDENCE_THRESHOLD) and len(text) < 2000:
            try:
                retry_doc = pdfium.PdfDocument(pdf_bytes)
                retry_img = retry_doc[page_num - 1].render(scale=retry_scale).to_pil().convert("RGB")
                retry_text, retry_score = run_paddle_on_image(retry_img)
                if (retry_score or 0.0) > (mean_score or 0.0) or len(retry_text) > len(text):
                    text, mean_score = retry_text, retry_score
                    used_dpi = RETRY_DPI
            except Exception:
                pass

        return {
            "page_number": page_num,
            "method": "paddleocr",
            "text": text,
            "mean_ocr_score": mean_score,
            "dpi": used_dpi,
        }

    ocr_results: dict[int, dict[str, Any]] = {}
    if ocr_targets:
        with ThreadPoolExecutor(max_workers=min(OCR_WORKERS, len(ocr_targets))) as pool:
            for res in pool.map(process_ocr_page, ocr_targets):
                ocr_results[res["page_number"]] = res

    ordered: list[dict[str, Any]] = []
    for page_num in range(1, total + 1):
        if page_num in native_results:
            ordered.append(native_results[page_num])
        elif page_num in ocr_results:
            ordered.append(ocr_results[page_num])
    return ordered


def cache_get(key: str) -> dict[str, Any] | None:
    with _cache_lock:
        val = _cache.get(key)
        if val is not None:
            _cache.move_to_end(key)
        return val


def cache_set(key: str, value: dict[str, Any]) -> None:
    with _cache_lock:
        _cache[key] = value
        _cache.move_to_end(key)
        while len(_cache) > CACHE_MAX_ITEMS:
            _cache.popitem(last=False)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "nexofis-ocr-engine",
        "version": "0.2.0",
        "lang": OCR_LANG,
        "workers": OCR_WORKERS,
        "default_dpi": DEFAULT_DPI,
        "retry_dpi": RETRY_DPI,
        "max_pages": MAX_PAGES,
        "cached_documents": len(_cache),
    }


def _process_single_payload(raw: bytes, content_type: str, force_ocr: bool) -> dict[str, Any]:
    started = time.perf_counter()
    if not raw:
        raise HTTPException(status_code=400, detail="Arquivo vazio.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Arquivo excede o limite máximo permitido.")

    sha256 = hashlib.sha256(raw).hexdigest()
    cache_key = f"{sha256}:{'force' if force_ocr else 'hybrid'}"
    hit = cache_get(cache_key)
    if hit is not None:
        return {**hit, "from_cache": True, "duration_ms": max(1, int((time.perf_counter() - started) * 1000))}

    try:
        if content_type == "application/pdf" or raw[:4] == b"%PDF":
            extracted_pages = extract_pdf_hybrid(raw, force_ocr=force_ocr)
        else:
            img = Image.open(io.BytesIO(raw)).convert("RGB")
            txt, score = run_paddle_on_image(img)
            extracted_pages = [
                {
                    "page_number": 1,
                    "method": "paddleocr",
                    "text": txt,
                    "mean_ocr_score": score,
                    "dpi": None,
                }
            ]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Falha ao decodificar documento: {exc}") from exc

    native_count = sum(1 for p in extracted_pages if p["method"] == "native")
    ocr_count = len(extracted_pages) - native_count
    duration_ms = max(1, int((time.perf_counter() - started) * 1000))

    response = {
        "sha256": sha256,
        "extractor_version": f"nexofis-paddleocr-{OCR_LANG}-0.2.0",
        "page_count": len(extracted_pages),
        "native_pages": native_count,
        "ocr_pages": ocr_count,
        "duration_ms": duration_ms,
        "from_cache": False,
        "text": "\n\n".join(p["text"] for p in extracted_pages if p["text"]),
        "pages": extracted_pages,
    }
    cache_set(cache_key, response)
    return response


@app.post("/ocr")
async def run_ocr(
    file: UploadFile = File(...),
    force_ocr: bool = Query(default=False),
) -> dict[str, Any]:
    raw = await file.read()
    return _process_single_payload(raw, (file.content_type or "").lower(), force_ocr)


@app.post("/ocr/batch")
async def run_ocr_batch(
    files: list[UploadFile] = File(...),
    force_ocr: bool = Query(default=False),
) -> dict[str, Any]:
    if len(files) > 10:
        raise HTTPException(status_code=400, detail="Máximo de 10 documentos por lote.")
    results = []
    for f in files:
        raw = await f.read()
        item = _process_single_payload(raw, (f.content_type or "").lower(), force_ocr)
        results.append({"filename": f.filename, **item})
    return {"count": len(results), "results": results}

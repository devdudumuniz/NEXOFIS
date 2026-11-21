FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN useradd --create-home --shell /bin/sh ocrworker \
    && chown -R ocrworker:ocrworker /app

COPY --chown=ocrworker:ocrworker ocr_worker.py .

USER ocrworker

ENV OCR_WORKER_PORT=8090 \
    PADDLE_OCR_LANG=pt \
    OCR_WORKERS=4 \
    OCR_DEFAULT_DPI=180

EXPOSE 8090

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.getenv(\"OCR_WORKER_PORT\", \"8090\")}/health', timeout=3)"

CMD ["sh", "-c", "uvicorn ocr_worker:app --host 0.0.0.0 --port ${OCR_WORKER_PORT:-8090}"]

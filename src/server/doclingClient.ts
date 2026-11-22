/**
 * NEXOFIS — Adaptador Real Docling Serve + PaddleOCR Worker (R-13 / A10 / A11)
 * Licença: GNU AGPL-3.0-only (Eduardo Muniz — DM Technology)
 *
 * Princípios obrigatórios:
 * - Nunca simular Docling ou PaddleOCR quando os serviços estiverem offline.
 * - Retornar estado explícito `source_unavailable` quando URLs não estiverem configuradas ou inacessíveis.
 * - Redigir URLs internas em respostas públicas de saúde/integração (A11).
 * - Preservar metadados de cobertura parcial de páginas (originalPageCount vs processedPageCount).
 */

import crypto from 'node:crypto';

export interface ExternalDocumentExtractionResult {
  status: 'ok' | 'source_unavailable' | 'error';
  engine: 'docling-serve' | 'paddleocr-worker';
  extractorVersion: string;
  text: string;
  markdown?: string;
  pageCount: number;
  originalPageCount?: number;
  processedPageCount?: number;
  truncated?: boolean;
  pages?: Array<{
    pageNumber: number;
    method: 'native' | 'docling' | 'paddleocr';
    text: string;
    confidence: number;
  }>;
  durationMs: number;
  inputSha256: string;
  errorDetail?: string;
}

export interface ExternalOcrServiceStatus {
  configured: boolean;
  reachable: boolean;
  detail: string;
}

export interface ExternalOcrHealthStatus {
  doclingServe: ExternalOcrServiceStatus;
  paddleOcr: ExternalOcrServiceStatus;
}

function getConfiguredUrl(envKey: 'DOCLING_SERVE_URL' | 'PADDLE_OCR_URL'): string | null {
  const raw = process.env[envKey]?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function sanitizeNetworkDetail(err: unknown): string {
  const raw = err instanceof Error ? err.message : 'Falha de conexão';
  // Strip any internal hostnames/IPs/ports from public error details
  return raw.replace(/https?:\/\/[^\s)]+/gi, '[serviço-interno]').slice(0, 140);
}

/**
 * Checks Docling Serve and PaddleOCR worker reachability WITHOUT leaking internal URLs/hosts/ports
 * in public responses (A11).
 */
export async function checkExternalOcrHealth(
  timeoutMs = 2500
): Promise<ExternalOcrHealthStatus> {
  const doclingUrl = getConfiguredUrl('DOCLING_SERVE_URL');
  const paddleUrl = getConfiguredUrl('PADDLE_OCR_URL');

  const probe = async (baseUrl: string | null, healthPath: string): Promise<ExternalOcrServiceStatus> => {
    if (!baseUrl) {
      return {
        configured: false,
        reachable: false,
        detail: 'Serviço não configurado no ambiente (.env).',
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${healthPath}`, { signal: controller.signal });
      clearTimeout(timer);
      return {
        configured: true,
        reachable: res.ok,
        detail: res.ok ? `Online (HTTP ${res.status})` : `Respondeu HTTP ${res.status}`,
      };
    } catch (err) {
      clearTimeout(timer);
      return {
        configured: true,
        reachable: false,
        detail: sanitizeNetworkDetail(err),
      };
    }
  };

  const [doclingServe, paddleOcr] = await Promise.all([
    probe(doclingUrl, '/health'),
    probe(paddleUrl, '/health'),
  ]);

  return { doclingServe, paddleOcr };
}

/**
 * Envia arquivo PDF/imagem ao Docling Serve (`/v1/convert/file`) quando configurado.
 */
export async function convertWithDoclingServe(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  options?: { doOcr?: boolean; timeoutMs?: number }
): Promise<ExternalDocumentExtractionResult> {
  const startedAt = Date.now();
  const inputSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const baseUrl = getConfiguredUrl('DOCLING_SERVE_URL');

  if (!baseUrl) {
    return {
      status: 'source_unavailable',
      engine: 'docling-serve',
      extractorVersion: 'docling-serve-unconfigured',
      text: '',
      pageCount: 0,
      durationMs: Date.now() - startedAt,
      inputSha256,
      errorDetail:
        'DOCLING_SERVE_URL não configurada. Suba o perfil full-ocr via docker compose e configure DOCLING_SERVE_URL no .env.',
    };
  }

  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? Number(process.env.DOCLING_TIMEOUT_MS ?? 45000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
    form.append('files', blob, filename);
    form.append('to_formats', 'md');
    form.append('to_formats', 'text');
    form.append('do_ocr', String(Boolean(options?.doOcr)));
    form.append('table_mode', 'accurate');

    const res = await fetch(`${baseUrl}/v1/convert/file`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return {
        status: 'error',
        engine: 'docling-serve',
        extractorVersion: 'docling-serve-http-error',
        text: '',
        pageCount: 0,
        durationMs: Date.now() - startedAt,
        inputSha256,
        errorDetail: `Docling Serve retornou HTTP ${res.status}.`,
      };
    }

    const payload = (await res.json()) as {
      document?: {
        md_content?: string;
        text_content?: string;
        json_content?: { pages?: Record<string, unknown> };
      };
      status?: string;
      processing_time?: number;
      version?: string;
    };

    const markdown = payload.document?.md_content ?? '';
    const text = payload.document?.text_content || markdown;
    const pagesObj = payload.document?.json_content?.pages;
    const pageCount = pagesObj ? Object.keys(pagesObj).length : 0;

    return {
      status: 'ok',
      engine: 'docling-serve',
      extractorVersion: payload.version ? `docling-serve-${payload.version}` : 'docling-serve-v1',
      text,
      markdown,
      pageCount,
      originalPageCount: pageCount,
      processedPageCount: pageCount,
      truncated: false,
      durationMs: Date.now() - startedAt,
      inputSha256,
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      status: 'source_unavailable',
      engine: 'docling-serve',
      extractorVersion: 'docling-serve-unreachable',
      text: '',
      pageCount: 0,
      durationMs: Date.now() - startedAt,
      inputSha256,
      errorDetail: `Docling Serve inacessível: ${sanitizeNetworkDetail(err)}.`,
    };
  }
}

/**
 * Envia arquivo escaneado/imagem ao worker Python PaddleOCR (`/ocr`) quando configurado.
 */
export async function extractWithPaddleOcrWorker(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  timeoutMs = 60000
): Promise<ExternalDocumentExtractionResult> {
  const startedAt = Date.now();
  const inputSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const baseUrl = getConfiguredUrl('PADDLE_OCR_URL');

  if (!baseUrl) {
    return {
      status: 'source_unavailable',
      engine: 'paddleocr-worker',
      extractorVersion: 'paddleocr-unconfigured',
      text: '',
      pageCount: 0,
      durationMs: Date.now() - startedAt,
      inputSha256,
      errorDetail:
        'PADDLE_OCR_URL não configurada. Suba o serviço `paddleocr-worker` via docker-compose.yml.',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);

    const res = await fetch(`${baseUrl}/ocr`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return {
        status: 'error',
        engine: 'paddleocr-worker',
        extractorVersion: 'paddleocr-http-error',
        text: '',
        pageCount: 0,
        durationMs: Date.now() - startedAt,
        inputSha256,
        errorDetail: `PaddleOCR worker retornou HTTP ${res.status}.`,
      };
    }

    const payload = (await res.json()) as {
      text?: string;
      page_count?: number;
      original_page_count?: number;
      processed_page_count?: number;
      truncated?: boolean;
      extractor_version?: string;
      pages?: Array<{
        page_number: number;
        method?: string;
        text?: string;
        mean_ocr_score?: number | null;
      }>;
    };

    const processedCount = Number(payload.processed_page_count ?? payload.page_count ?? 0);
    const originalCount = Number(payload.original_page_count ?? processedCount);
    const truncated = Boolean(payload.truncated ?? originalCount > processedCount);

    return {
      status: 'ok',
      engine: 'paddleocr-worker',
      extractorVersion: payload.extractor_version ?? 'paddleocr-worker',
      text: payload.text ?? '',
      pageCount: processedCount,
      originalPageCount: originalCount,
      processedPageCount: processedCount,
      truncated,
      pages: Array.isArray(payload.pages)
        ? payload.pages.map((p) => ({
            pageNumber: Number(p.page_number ?? 1),
            method: p.method === 'native' ? 'native' : 'paddleocr',
            text: String(p.text ?? ''),
            confidence: typeof p.mean_ocr_score === 'number' ? p.mean_ocr_score : 0.85,
          }))
        : undefined,
      durationMs: Date.now() - startedAt,
      inputSha256,
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      status: 'source_unavailable',
      engine: 'paddleocr-worker',
      extractorVersion: 'paddleocr-unreachable',
      text: '',
      pageCount: 0,
      durationMs: Date.now() - startedAt,
      inputSha256,
      errorDetail: `PaddleOCR worker inacessível: ${sanitizeNetworkDetail(err)}.`,
    };
  }
}

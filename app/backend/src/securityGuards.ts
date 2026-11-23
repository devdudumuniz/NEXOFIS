import net from 'node:net';

export interface OutboundUrlValidationResult {
  allowed: boolean;
  reason?: string;
  normalizedUrl?: string;
  hostname?: string;
}

export const DEFAULT_ALLOWED_EXTERNAL_HOSTS = [
  'pncp.gov.br',
  'api.pncp.gov.br',
  'brasilapi.com.br',
  'servicodados.ibge.gov.br',
  'apidatalake.tesouro.gov.br',
  'api.portaldatransparencia.gov.br',
  'dadosabertos.camara.leg.br',
  'transparencia.gov.br',
] as const;

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local / cloud metadata 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark 198.18.0.0/15
  if (a >= 224) return true; // multicast & reserved
  return false;
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::1' || lower === '::' || lower === '0:0:0:0:0:0:0:1') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('::ffff:')) {
    const mappedV4 = lower.slice('::ffff:'.length);
    if (net.isIPv4(mappedV4)) {
      return isPrivateOrReservedIpv4(mappedV4);
    }
  }
  return false;
}

export function isBlockedIpAddress(ip: string): boolean {
  const cleaned = ip.trim().replace(/^\[|\]$/g, '');
  const version = net.isIP(cleaned);
  if (version === 4) return isPrivateOrReservedIpv4(cleaned);
  if (version === 6) return isPrivateOrReservedIpv6(cleaned);
  return false;
}

function hostMatchesAllowlist(hostname: string, allowlist: readonly string[]): boolean {
  const lower = hostname.toLowerCase();
  return allowlist.some((allowed) => {
    const target = allowed.toLowerCase().trim();
    return lower === target || lower.endsWith(`.${target}`);
  });
}

/**
 * Validates outbound URLs against SSRF (blocks non-HTTPS, credentials in URL,
 * localhost, private/link-local/metadata IP ranges, and non-allowlisted hosts).
 */
export function validateSafeExternalUrl(
  rawUrl: string,
  options?: {
    allowedHosts?: readonly string[];
    allowHttp?: boolean;
    requireAllowlist?: boolean;
  }
): OutboundUrlValidationResult {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) {
    return { allowed: false, reason: 'URL externa vazia.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { allowed: false, reason: 'URL externa malformada.' };
  }

  const allowHttp = options?.allowHttp === true;
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    return {
      allowed: false,
      reason: `Esquema "${parsed.protocol}" bloqueado (somente HTTPS permitido).`,
    };
  }

  if (parsed.username || parsed.password) {
    return { allowed: false, reason: 'Credenciais embutidas na URL são bloqueadas.' };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'metadata.google.internal'
  ) {
    return {
      allowed: false,
      reason: `Host interno ou reservado bloqueado (${hostname || 'vazio'}).`,
    };
  }

  if (net.isIP(hostname) !== 0) {
    if (isBlockedIpAddress(hostname)) {
      return {
        allowed: false,
        reason: `Endereço IP privado, loopback ou metadata bloqueado (${hostname}).`,
      };
    }
    return {
      allowed: false,
      reason: `Acesso direto a IP literal bloqueado por política SSRF (${hostname}).`,
    };
  }

  const requireAllowlist = options?.requireAllowlist !== false;
  const allowlist = options?.allowedHosts ?? DEFAULT_ALLOWED_EXTERNAL_HOSTS;
  if (requireAllowlist && !hostMatchesAllowlist(hostname, allowlist)) {
    return {
      allowed: false,
      reason: `Domínio "${hostname}" fora da lista explícita de fontes permitidas.`,
    };
  }

  return {
    allowed: true,
    normalizedUrl: parsed.toString(),
    hostname,
  };
}

/**
 * Validates HTTP redirect target before following a 3xx Location header.
 */
export function validateSafeRedirectTarget(
  currentUrl: string,
  locationHeader: string,
  options?: {
    allowedHosts?: readonly string[];
    requireAllowlist?: boolean;
  }
): OutboundUrlValidationResult {
  try {
    const resolved = new URL(locationHeader, currentUrl).toString();
    return validateSafeExternalUrl(resolved, {
      allowedHosts: options?.allowedHosts,
      requireAllowlist: options?.requireAllowlist ?? true,
      allowHttp: false,
    });
  } catch {
    return { allowed: false, reason: 'Cabeçalho Location de redirecionamento inválido.' };
  }
}

/**
 * Fetches an external resource with strict SSRF checks, manual redirect validation,
 * bounded download size, and timeout/AbortSignal cancellation.
 */
export async function safeExternalFetch(
  url: string,
  options?: {
    method?: 'GET' | 'HEAD';
    headers?: Record<string, string>;
    allowedHosts?: readonly string[];
    maxBytes?: number;
    maxRedirects?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  }
): Promise<{
  ok: boolean;
  status: number;
  finalUrl: string;
  contentType: string;
  bodyBytes: Buffer;
  truncated: boolean;
}> {
  const maxBytes = Math.max(1024, Math.min(options?.maxBytes ?? 5 * 1024 * 1024, 25 * 1024 * 1024));
  const maxRedirects = Math.max(0, Math.min(options?.maxRedirects ?? 3, 5));
  const timeoutMs = Math.max(500, Math.min(options?.timeoutMs ?? 8000, 30_000));
  const fetchFn = options?.fetchImpl ?? fetch;

  let currentUrl = url;
  const initialCheck = validateSafeExternalUrl(currentUrl, {
    allowedHosts: options?.allowedHosts,
    requireAllowlist: true,
  });
  if (!initialCheck.allowed || !initialCheck.normalizedUrl) {
    throw new Error(`Bloqueio SSRF: ${initialCheck.reason ?? 'URL não permitida'}`);
  }
  currentUrl = initialCheck.normalizedUrl;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  options?.signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    let redirects = 0;
    while (true) {
      const res = await fetchFn(currentUrl, {
        method: options?.method ?? 'GET',
        headers: options?.headers,
        redirect: 'manual',
        signal: controller.signal,
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) {
          throw new Error(`Redirecionamento HTTP ${res.status} sem cabeçalho Location.`);
        }
        if (redirects >= maxRedirects) {
          throw new Error(`Limite máximo de redirecionamentos (${maxRedirects}) excedido.`);
        }
        const redirectCheck = validateSafeRedirectTarget(currentUrl, location, {
          allowedHosts: options?.allowedHosts,
          requireAllowlist: true,
        });
        if (!redirectCheck.allowed || !redirectCheck.normalizedUrl) {
          throw new Error(
            `Bloqueio SSRF em redirecionamento: ${redirectCheck.reason ?? 'destino bloqueado'}`
          );
        }
        currentUrl = redirectCheck.normalizedUrl;
        redirects += 1;
        continue;
      }

      const contentLength = Number(res.headers.get('content-length') ?? '0');
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error(
          `Tamanho declarado (${contentLength} bytes) excede o limite máximo de download (${maxBytes} bytes).`
        );
      }

      const reader = res.body?.getReader();
      if (!reader) {
        const rawBuf = Buffer.from(await res.arrayBuffer());
        if (rawBuf.length > maxBytes) {
          throw new Error(
            `Download excedeu o limite máximo configurado (${maxBytes} bytes).`
          );
        }
        return {
          ok: res.ok,
          status: res.status,
          finalUrl: currentUrl,
          contentType: res.headers.get('content-type') ?? 'application/octet-stream',
          bodyBytes: rawBuf,
          truncated: false,
        };
      }

      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new Error(
              `Download excedeu o limite máximo configurado (${maxBytes} bytes).`
            );
          }
          chunks.push(Buffer.from(value));
        }
      }

      return {
        ok: res.ok,
        status: res.status,
        finalUrl: currentUrl,
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        bodyBytes: Buffer.concat(chunks),
        truncated: false,
      };
    }
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener('abort', onExternalAbort);
  }
}

const SENSITIVE_KEY_PATTERN = /(token|password|secret|authorization|cookie|cpf|api[_-]?key)/i;
const RAW_CPF_PATTERN = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;

export function sanitizeLogString(input: string, maxLen = 400): string {
  const scrubbed = input
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(RAW_CPF_PATTERN, '[CPF_REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  return scrubbed.length > maxLen ? `${scrubbed.slice(0, maxLen)}…` : scrubbed;
}

/**
 * Removes tokens, passwords, full CPFs, and oversized untrusted payloads from structured logs.
 */
export function sanitizeLogPayload(
  payload: Record<string, unknown>,
  maxDepth = 4
): Record<string, unknown> {
  const walk = (val: unknown, depth: number): unknown => {
    if (depth > maxDepth) return '[TRUNCATED_DEPTH]';
    if (val === null || val === undefined) return val;
    if (typeof val === 'string') return sanitizeLogString(val);
    if (typeof val === 'number' || typeof val === 'boolean') return val;
    if (Array.isArray(val)) {
      return val.slice(0, 20).map((item) => walk(item, depth + 1));
    }
    if (typeof val === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (SENSITIVE_KEY_PATTERN.test(k)) {
          out[k] = '[REDACTED]';
        } else {
          out[k] = walk(v, depth + 1);
        }
      }
      return out;
    }
    return String(val);
  };

  return walk(payload, 0) as Record<string, unknown>;
}

export interface SourceMetricBucket {
  source: string;
  requests: number;
  successes: number;
  errors: number;
  timeouts: number;
  lastStatus: string;
  lastUpdatedAt: string;
  avgLatencyMs: number;
  maxLatencyMs: number;
}

export interface ObservabilityRegistry {
  recordSourceCall: (params: {
    source: string;
    ok: boolean;
    timedOut?: boolean;
    latencyMs: number;
    statusLabel: string;
  }) => void;
  getSnapshot: (meta?: {
    engineVersion?: string;
    schemaVersion?: number;
    queueDepth?: number;
    indexedSuppliers?: number;
    indexedQsa?: number;
  }) => {
    capturedAt: string;
    engineVersion: string;
    schemaVersion: number;
    queueDepth: number;
    coverage: {
      indexedSuppliers: number;
      indexedQsa: number;
      qsaCoveragePct: number | null;
    };
    sources: SourceMetricBucket[];
  };
}

export function createObservabilityRegistry(): ObservabilityRegistry {
  const buckets = new Map<
    string,
    {
      requests: number;
      successes: number;
      errors: number;
      timeouts: number;
      totalLatencyMs: number;
      maxLatencyMs: number;
      lastStatus: string;
      lastUpdatedAt: string;
    }
  >();

  return {
    recordSourceCall(params) {
      const key = params.source.trim().toLowerCase() || 'unknown';
      const current = buckets.get(key) ?? {
        requests: 0,
        successes: 0,
        errors: 0,
        timeouts: 0,
        totalLatencyMs: 0,
        maxLatencyMs: 0,
        lastStatus: 'unknown',
        lastUpdatedAt: new Date().toISOString(),
      };
      current.requests += 1;
      if (params.ok) current.successes += 1;
      else current.errors += 1;
      if (params.timedOut) current.timeouts += 1;
      const lat = Math.max(0, Math.round(params.latencyMs));
      current.totalLatencyMs += lat;
      if (lat > current.maxLatencyMs) current.maxLatencyMs = lat;
      current.lastStatus = sanitizeLogString(params.statusLabel, 80);
      current.lastUpdatedAt = new Date().toISOString();
      buckets.set(key, current);
    },
    getSnapshot(meta) {
      const indexedSuppliers = meta?.indexedSuppliers ?? 0;
      const indexedQsa = meta?.indexedQsa ?? 0;
      const sources: SourceMetricBucket[] = Array.from(buckets.entries())
        .map(([source, b]) => ({
          source,
          requests: b.requests,
          successes: b.successes,
          errors: b.errors,
          timeouts: b.timeouts,
          lastStatus: b.lastStatus,
          lastUpdatedAt: b.lastUpdatedAt,
          avgLatencyMs: b.requests > 0 ? Math.round(b.totalLatencyMs / b.requests) : 0,
          maxLatencyMs: b.maxLatencyMs,
        }))
        .sort((a, b) => a.source.localeCompare(b.source));

      return {
        capturedAt: new Date().toISOString(),
        engineVersion: meta?.engineVersion ?? 'unknown',
        schemaVersion: meta?.schemaVersion ?? 0,
        queueDepth: meta?.queueDepth ?? 0,
        coverage: {
          indexedSuppliers,
          indexedQsa,
          qsaCoveragePct:
            indexedSuppliers > 0
              ? Number(((indexedQsa / indexedSuppliers) * 100).toFixed(1))
              : null,
        },
        sources,
      };
    },
  };
}

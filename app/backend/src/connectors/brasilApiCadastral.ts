import crypto from 'node:crypto';
import { isValidCnpj, normalizeCnpj } from '@nexofis/shared/lib/cnpj';
import { computeCanonicalSha256 } from '@nexofis/shared/lib/forensicInvestigationEngine';
import type { CadastralMinimizedExtract, CadastralQsaMember } from '@nexofis/shared/types/investigation';

export const MAX_BRASILAPI_RESPONSE_BYTES = 512 * 1024; // 512 KiB hard cap

export interface BrasilApiCadastralRequest {
  cnpj: string;
  purpose: string;
  legalBasis: string;
  justification: string;
  acquiredBy: string;
  fetchImpl?: typeof fetch;
}

export interface RawBrasilApiQsa {
  nome_socio?: string;
  qualificacao_socio?: string;
  data_entrada_sociedade?: string;
  cnpj_cpf_do_socio?: string;
  faixa_etaria?: string;
}

export interface RawBrasilApiCnpj {
  cnpj?: string;
  razao_social?: string;
  descricao_situacao_cadastral?: string;
  data_inicio_atividade?: string;
  cnae_fiscal?: number | string;
  cnae_fiscal_descricao?: string;
  municipio?: string;
  uf?: string;
  capital_social?: number;
  qsa?: RawBrasilApiQsa[];
}

function normalizeStartDate(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

/**
 * Minimizes/redacts any CPF/CNPJ document fragment returned by QSA providers.
 * - Full 11-digit CPFs (e.g. "12345678901" or "123.456.789-01") are ALWAYS redacted to "***456789**"
 *   before persistence or API return (LGPD data minimization).
 * - Already masked CPFs (e.g. "***456789**") are preserved in normalized form.
 * - Corporate partner CNPJs (14 digits) are preserved normalized.
 * - All-zero or all-mask placeholders return null.
 */
export function minimizeMaskedDocument(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim().toUpperCase();
  if (!trimmed) return null;

  const digitsOnly = trimmed.replace(/\D/g, '');
  const hasAsterisk = trimmed.includes('*');

  // If provider accidentally returns a full unmasked 11-digit CPF, redact to RFB public mask ***XXXXXX**
  if (!hasAsterisk && digitsOnly.length === 11) {
    if (/^0+$/.test(digitsOnly)) return null;
    return `***${digitsOnly.slice(3, 9)}**`;
  }

  // Corporate partner 14-digit CNPJ
  if (!hasAsterisk && digitsOnly.length === 14) {
    if (/^0+$/.test(digitsOnly)) return null;
    return digitsOnly;
  }

  // Masked document (preserve asterisks and alphanumeric characters)
  const cleaned = trimmed.replace(/[^0-9A-Z*]/g, '');
  const nonMask = cleaned.replace(/\*/g, '');
  if (!nonMask || /^0+$/.test(nonMask)) return null;
  return cleaned;
}

/**
 * Reads a fetch Response body up to `maxBytes` while respecting the active AbortSignal timeout.
 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const contentLengthHeader = response.headers?.get?.('content-length');
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(
        `Resposta da BrasilAPI excede o limite seguro de ${Math.round(maxBytes / 1024)} KiB.`
      );
    }
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            try {
              await reader.cancel();
            } catch {
              // ignore cancel errors
            }
            throw new Error(
              `Resposta da BrasilAPI excedeu o limite seguro de ${Math.round(maxBytes / 1024)} KiB durante a leitura.`
            );
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return merged.toString('utf8');
  }

  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error(
      `Resposta da BrasilAPI excede o limite seguro de ${Math.round(maxBytes / 1024)} KiB.`
    );
  }
  return text;
}

/**
 * Hardened BrasilAPI CNPJ fetcher:
 * - Validates numeric 14-digit CNPJ including Modulo-11 check digits
 * - Disables redirects (`redirect: 'error'`)
 * - Keeps timeout active across BOTH headers and bounded body read (512 KiB max)
 * - Strictly verifies the returned `cnpj` matches the requested `cnpj`
 */
export async function fetchBrasilApiRawCnpj(
  rawCnpj: string,
  options?: { timeoutMs?: number; fetchImpl?: typeof fetch }
): Promise<{ cleanCnpj: string; raw: RawBrasilApiCnpj }> {
  const cleanCnpj = normalizeCnpj(rawCnpj);
  if (!/^\d{14}$/.test(cleanCnpj) || !isValidCnpj(cleanCnpj)) {
    throw new Error(
      'CNPJ numérico de 14 dígitos com dígitos verificadores válidos é obrigatório para consulta na BrasilAPI.'
    );
  }

  const fetchFn = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 12000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let raw: RawBrasilApiCnpj;
  try {
    // Fixed allowlisted HTTPS endpoint with redirects explicitly disabled
    const url = `https://brasilapi.com.br/api/cnpj/v1/${cleanCnpj}`;
    const response = await fetchFn(url, {
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/json', 'User-Agent': 'NEXOFIS-Forensic/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`BrasilAPI retornou HTTP ${response.status} ao consultar CNPJ ${cleanCnpj}.`);
    }
    const bodyText = await readBoundedText(response, MAX_BRASILAPI_RESPONSE_BYTES);
    try {
      raw = JSON.parse(bodyText) as RawBrasilApiCnpj;
    } catch {
      throw new Error('BrasilAPI retornou JSON inválido.');
    }
  } finally {
    clearTimeout(timeout);
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Payload cadastral da BrasilAPI inválido.');
  }

  const returnedCnpj = normalizeCnpj(raw.cnpj);
  if (!returnedCnpj || returnedCnpj !== cleanCnpj) {
    throw new Error(
      `Divergência de integridade cadastral: CNPJ retornado (${returnedCnpj || 'ausente'}) difere do CNPJ consultado (${cleanCnpj}).`
    );
  }

  return { cleanCnpj, raw };
}

/**
 * Queries BrasilAPI (intermediary provider) for a valid 14-digit CNPJ and produces a minimized
 * derived cadastral + QSA extract. QSA members are strictly marked `identityStatus: 'unresolved'`
 * and any unmasked 11-digit CPF is redacted before persistence.
 */
export async function fetchBrasilApiMinimizedExtract(
  req: BrasilApiCadastralRequest
): Promise<CadastralMinimizedExtract> {
  const purpose = req.purpose.trim();
  const legalBasis = req.legalBasis.trim();
  const justification = req.justification.trim();
  if (purpose.length < 5 || legalBasis.length < 4 || justification.length < 8) {
    throw new Error(
      'Finalidade (mín. 5 caracteres), fundamento (mín. 4) e justificativa (mín. 8) são obrigatórios para registrar a consulta cadastral.'
    );
  }

  const { cleanCnpj, raw } = await fetchBrasilApiRawCnpj(req.cnpj, {
    timeoutMs: 12000,
    fetchImpl: req.fetchImpl,
  });

  const qsa: CadastralQsaMember[] = Array.isArray(raw.qsa)
    ? raw.qsa
        .filter((m) => m && typeof m.nome_socio === 'string' && m.nome_socio.trim().length > 0)
        .map((m) => ({
          name: String(m.nome_socio).trim(),
          qualification: String(m.qualificacao_socio ?? 'Não informada').trim(),
          entryDate: normalizeStartDate(m.data_entrada_sociedade),
          maskedDocument: minimizeMaskedDocument(m.cnpj_cpf_do_socio),
          identityStatus: 'unresolved' as const,
        }))
    : [];

  const base = {
    id: `cad-${crypto.randomUUID().slice(0, 12)}`,
    cnpj: cleanCnpj,
    sourceProvider: 'BrasilAPI' as const,
    sourceType: 'provedor_intermediario' as const,
    acquiredAt: new Date().toISOString(),
    acquiredBy: req.acquiredBy,
    purpose,
    legalBasis,
    justification,
    legalName: raw.razao_social ? String(raw.razao_social).trim() : null,
    registrationStatus: raw.descricao_situacao_cadastral
      ? String(raw.descricao_situacao_cadastral).trim()
      : null,
    startActivityDate: normalizeStartDate(raw.data_inicio_atividade),
    primaryCnaeCode:
      raw.cnae_fiscal !== undefined && raw.cnae_fiscal !== null
        ? String(raw.cnae_fiscal).trim()
        : null,
    primaryCnaeDescription: raw.cnae_fiscal_descricao
      ? String(raw.cnae_fiscal_descricao).trim()
      : null,
    municipality: raw.municipio ? String(raw.municipio).trim() : null,
    uf: raw.uf ? String(raw.uf).trim().toUpperCase() : null,
    shareCapital:
      typeof raw.capital_social === 'number' && Number.isFinite(raw.capital_social)
        ? raw.capital_social
        : null,
    qsa,
  };

  return {
    ...base,
    extractSha256: computeCanonicalSha256(base),
  };
}

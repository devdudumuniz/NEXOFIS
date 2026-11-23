import crypto from 'node:crypto';
import { computeCanonicalSha256 } from '../../lib/forensicInvestigationEngine';
import type { CadastralMinimizedExtract, CadastralQsaMember } from '../../types/investigation';

export interface BrasilApiCadastralRequest {
  cnpj: string;
  purpose: string;
  legalBasis: string;
  justification: string;
  acquiredBy: string;
  fetchImpl?: typeof fetch;
}

interface RawBrasilApiQsa {
  nome_socio?: string;
  qualificacao_socio?: string;
  data_entrada_sociedade?: string;
  cnpj_cpf_do_socio?: string;
}

interface RawBrasilApiCnpj {
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
 * Queries BrasilAPI (intermediary provider) for a 14-digit CNPJ and produces a minimized
 * derived cadastral + QSA extract. QSA members are strictly marked `identityStatus: 'unresolved'`
 * to prevent automated homonym conflation (RFB public QSA masks CPF).
 */
export async function fetchBrasilApiMinimizedExtract(
  req: BrasilApiCadastralRequest
): Promise<CadastralMinimizedExtract> {
  const cleanCnpj = req.cnpj.replace(/\D/g, '');
  if (!/^\d{14}$/.test(cleanCnpj)) {
    throw new Error('CNPJ numérico de 14 dígitos é obrigatório para consulta cadastral na BrasilAPI.');
  }
  const purpose = req.purpose.trim();
  const legalBasis = req.legalBasis.trim();
  const justification = req.justification.trim();
  if (purpose.length < 5 || legalBasis.length < 4 || justification.length < 8) {
    throw new Error(
      'Finalidade (mín. 5 caracteres), fundamento (mín. 4) e justificativa (mín. 8) são obrigatórios para registrar a consulta cadastral.'
    );
  }

  const fetchFn = req.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  let raw: RawBrasilApiCnpj;
  try {
    // Fixed allowlisted HTTPS endpoint — no SSRF surface
    const url = `https://brasilapi.com.br/api/cnpj/v1/${cleanCnpj}`;
    const response = await fetchFn(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'NEXOFIS-Forensic/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`BrasilAPI retornou HTTP ${response.status} ao consultar CNPJ ${cleanCnpj}.`);
    }
    raw = (await response.json()) as RawBrasilApiCnpj;
  } finally {
    clearTimeout(timeout);
  }

  const qsa: CadastralQsaMember[] = Array.isArray(raw.qsa)
    ? raw.qsa
        .filter((m) => m && typeof m.nome_socio === 'string' && m.nome_socio.trim().length > 0)
        .map((m) => ({
          name: String(m.nome_socio).trim(),
          qualification: String(m.qualificacao_socio ?? 'Não informada').trim(),
          entryDate: normalizeStartDate(m.data_entrada_sociedade),
          maskedDocument: m.cnpj_cpf_do_socio ? String(m.cnpj_cpf_do_socio).trim() : null,
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
    primaryCnaeCode: raw.cnae_fiscal !== undefined && raw.cnae_fiscal !== null ? String(raw.cnae_fiscal).trim() : null,
    primaryCnaeDescription: raw.cnae_fiscal_descricao ? String(raw.cnae_fiscal_descricao).trim() : null,
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

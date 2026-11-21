import crypto from 'node:crypto';
import type { ContractRecord } from '../types/audit';

export interface PncpSearchItem {
  id?: string;
  numero_controle_pncp?: string;
  title?: string;
  description?: string;
  item_url?: string;
  document_type?: string;
  ano?: string | number;
  numero?: string | number;
  numero_sequencial?: string | number;
  orgao_cnpj?: string;
  orgao_nome?: string;
  unidade_codigo?: string;
  unidade_nome?: string;
  municipio_nome?: string;
  uf?: string;
  codigo_ibge?: string;
  fornecedor_ni?: string;
  fornecedor_nome?: string;
  fornecedor_subcontratado_ni?: string;
  fornecedor_subcontratado_nome?: string;
  valor_global?: number | string;
  data_assinatura?: string;
  data_inicio_vigencia?: string;
  data_fim_vigencia?: string;
  data_publicacao_pncp?: string;
  modalidade_licitacao_nome?: string;
  amparo_legal_nome?: string[] | string;
  situacao_nome?: string;
}

export interface PncpCnpjSearchResult {
  cnpj: string;
  status: 'complete' | 'partial' | 'rate_limited' | 'unavailable';
  pncpTotalDeclared: number;
  pncpFetchedCount: number;
  pagesFetched: number;
  partialCoverage: boolean;
  byRole: {
    fornecedor: number;
    orgao_contratante: number;
    subcontratado: number;
  };
  records: ContractRecord[];
  message: string;
  retrievedAt: string;
}

function onlyDigits(val?: string | null): string {
  return (val ?? '').replace(/\D/g, '');
}

/**
 * Given a 14-digit branch (filial) CNPJ (branch digits != '0001'),
 * deterministically computes the corresponding Matriz ('0001') CNPJ with valid Modulo-11 check digits.
 * Returns null if the input is invalid or is already a Matriz ('0001').
 */
export function deriveMatrizCnpj(rawCnpj?: string | null): string | null {
  const digits = onlyDigits(rawCnpj);
  if (!/^\d{14}$/.test(digits)) return null;
  if (digits.slice(8, 12) === '0001') return null;

  const base12 = `${digits.slice(0, 8)}0001`;
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const sum1 = w1.reduce((acc, w, idx) => acc + Number(base12[idx]) * w, 0);
  const rem1 = sum1 % 11;
  const d1 = rem1 < 2 ? 0 : 11 - rem1;

  const base13 = `${base12}${d1}`;
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const sum2 = w2.reduce((acc, w, idx) => acc + Number(base13[idx]) * w, 0);
  const rem2 = sum2 % 11;
  const d2 = rem2 < 2 ? 0 : 11 - rem2;

  return `${base13}${d2}`;
}

function mapModalityFromText(raw?: string): ContractRecord['modality'] {
  const txt = (raw ?? '').toLowerCase();
  if (txt.includes('dispensa')) return 'Dispensa de Licitação';
  if (txt.includes('inexig') || txt.includes('credenc')) return 'Inexigibilidade';
  if (txt.includes('concorr')) return 'Concorrência';
  return 'Pregão Eletrônico';
}

function parseIsoDate(raw?: string, fallback?: string): string {
  if (raw && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.slice(0, 10);
  }
  return fallback ?? '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(
  url: string,
  retries = 4,
  timeoutMs = 8000
): Promise<{ status: number; ok: boolean; body?: { items?: PncpSearchItem[]; total?: number }; networkError?: string }> {
  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Nexofis/0.1.0 (https://github.com/devdudumuniz/NEXOFIS)',
          Connection: 'close',
        },
      });
      clearTimeout(timer);
      if (res.status === 429) {
        return { status: 429, ok: false };
      }
      if (!res.ok) {
        if (res.status >= 500 && attempt < retries) {
          await sleep(450 * (attempt + 1));
          continue;
        }
        return { status: res.status, ok: false };
      }
      const body = (await res.json()) as { items?: PncpSearchItem[]; total?: number };
      return { status: res.status, ok: true, body };
    } catch (err) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err.message : 'Falha de rede';
      if (attempt < retries) {
        await sleep(450 * (attempt + 1));
      }
    }
  }
  return { status: 0, ok: false, networkError: lastError };
}

export function classifyCnpjRoleInPncpItem(
  cnpj: string,
  item: PncpSearchItem
): 'fornecedor' | 'orgao_contratante' | 'subcontratado' | null {
  const fornecedorDigits = onlyDigits(item.fornecedor_ni);
  const orgaoDigits = onlyDigits(item.orgao_cnpj);
  const subDigits = onlyDigits(item.fornecedor_subcontratado_ni);

  if (fornecedorDigits === cnpj) return 'fornecedor';
  if (orgaoDigits === cnpj) return 'orgao_contratante';
  if (subDigits === cnpj) return 'subcontratado';
  return null;
}

export function mapPncpSearchItemToContract(
  item: PncpSearchItem,
  role: 'fornecedor' | 'orgao_contratante' | 'subcontratado',
  retrievedAt: string
): ContractRecord {
  const orgaoCnpj = onlyDigits(item.orgao_cnpj) || '00000000000000';
  const fornecedorCnpj = onlyDigits(item.fornecedor_ni) || '00000000000000';
  const year = Number(item.ano) || Number((item.data_assinatura ?? item.data_publicacao_pncp ?? '2026').slice(0, 4)) || 2026;
  const controlNumber =
    item.numero_controle_pncp?.trim() ||
    `${orgaoCnpj}-2-${String(item.numero_sequencial ?? item.numero ?? '000001').padStart(6, '0')}/${year}`;
  const rawNum = String(item.numero ?? item.numero_sequencial ?? '').trim();
  const contractNumber = rawNum
    ? rawNum.includes('/')
      ? rawNum
      : `${rawNum}/${year}`
    : item.title?.trim() || controlNumber;

  const valorGlobal = Number(item.valor_global ?? 0);
  const safeValue = Number.isFinite(valorGlobal) && valorGlobal >= 0 ? valorGlobal : 0;

  const signatureDate = parseIsoDate(
    item.data_assinatura ?? item.data_inicio_vigencia ?? item.data_publicacao_pncp,
    `${year}-01-01`
  );
  const startDate = parseIsoDate(item.data_inicio_vigencia, signatureDate);
  const endDate = parseIsoDate(item.data_fim_vigencia, `${year}-12-31`);

  const amparo = Array.isArray(item.amparo_legal_nome)
    ? item.amparo_legal_nome.filter(Boolean).join('; ')
    : item.amparo_legal_nome ?? '';

  const modality = mapModalityFromText(
    item.modalidade_licitacao_nome || amparo || item.title
  );

  const ibgeCode =
    item.codigo_ibge && /^\d{7}$/.test(String(item.codigo_ibge))
      ? String(item.codigo_ibge)
      : '0000000';
  const municipalityName = item.municipio_nome?.trim() || 'Município não informado no PNCP';
  const uf = item.uf?.trim().toUpperCase() || 'BR';
  const entityName =
    item.unidade_nome?.trim() || item.orgao_nome?.trim() || `Órgão CNPJ ${orgaoCnpj}`;

  const rawPayloadHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(item))
    .digest('hex');

  const safeId = `PNCP-CTR-${controlNumber.replace(/[^A-Za-z0-9]/g, '-')}`;
  const sourceUrl = item.item_url
    ? `https://pncp.gov.br/app${item.item_url.startsWith('/') ? '' : '/'}${item.item_url}`
    : `https://pncp.gov.br/app/contratos`;

  const roleLabel =
    role === 'fornecedor'
      ? 'Fornecedor contratado'
      : role === 'orgao_contratante'
        ? 'Órgão contratante'
        : 'Subcontratado';

  return {
    id: safeId,
    pncpControlNumber: controlNumber,
    contractNumber,
    year,
    municipalityIbge: ibgeCode,
    municipalityName,
    uf,
    entityId: `pncp-org-${orgaoCnpj}-${item.unidade_codigo ?? '01'}`,
    entityName,
    modality,
    biddersCount: modality === 'Dispensa de Licitação' || modality === 'Inexigibilidade' ? 1 : 3,
    object: item.description?.trim() || item.title?.trim() || 'Contrato público registrado no PNCP',
    objectCategory: amparo ? `${modality} (${amparo})` : `${modality} · PNCP`,
    expectedCnaePrefixes: [],
    signatureDate,
    startDate,
    endDate,
    originalValue: safeValue,
    updatedValue: safeValue,
    status: 'Vigente',
    cnpjRole: role,
    supplier: {
      cnpj: fornecedorCnpj,
      legalName: item.fornecedor_nome?.trim() || `Fornecedor CNPJ ${fornecedorCnpj}`,
      openingDate: '2020-01-01',
      registrationStatus: 'ATIVA',
      primaryCnaeCode: '0000-0/00',
      primaryCnaeDescription: 'Dados contratuais PNCP (consulte enriquecimento CNPJ no dossiê)',
      secondaryCnaes: [],
      shareCapital: 0,
      municipality: municipalityName,
      uf,
      shareholders: [],
      sanctions: [],
      priorMunicipalContracts: 0,
      simultaneousActiveContracts: 1,
      dataProvenance: 'PNCP API Oficial de Busca (/api/search)',
    },
    items: [],
    amendments: [],
    payments: [],
    sourceRecords: [
      {
        id: `SRC-PNCP-SEARCH-${rawPayloadHash.slice(0, 12)}`,
        sourceSystem: 'PNCP',
        externalId: controlNumber,
        retrievedAt,
        effectiveAt: item.data_publicacao_pncp ?? signatureDate,
        rawPayloadHash,
        parserVersion: 'pncp-search-client-1.0',
        reportedOriginalValue: safeValue,
        reportedUpdatedValue: safeValue,
        reportedSupplierCnpj: fornecedorCnpj,
        reportedStatus: item.situacao_nome?.trim() || 'Publicado no PNCP',
        reportedEndDate: endDate,
        sourceUrl,
        notes: `Papel do CNPJ pesquisado: ${roleLabel} · Órgão CNPJ ${orgaoCnpj}${amparo ? ` · Amparo: ${amparo}` : ''}`,
      },
    ],
    documents: [],
    dataSourceOrigin: 'PNCP API Oficial',
  };
}

/**
 * Queries PNCP national search API for ALL public contracts referencing a 14-digit CNPJ
 * across Brazil, paginating cleanly and strictly classifying role (fornecedor vs orgao_contratante vs subcontratado).
 * Never converts rate limits (429) or network errors into "0 contracts exist".
 */
export async function fetchPncpContractsByCnpj(
  rawCnpj: string,
  options?: { maxPages?: number; pageSize?: number }
): Promise<PncpCnpjSearchResult> {
  const cnpj = onlyDigits(rawCnpj);
  const retrievedAt = new Date().toISOString();
  const maxPages = Math.min(Math.max(options?.maxPages ?? 5, 1), 10);
  const pageSize = Math.min(Math.max(options?.pageSize ?? 50, 10), 100);

  if (!/^\d{14}$/.test(cnpj)) {
    return {
      cnpj,
      status: 'unavailable',
      pncpTotalDeclared: 0,
      pncpFetchedCount: 0,
      pagesFetched: 0,
      partialCoverage: true,
      byRole: { fornecedor: 0, orgao_contratante: 0, subcontratado: 0 },
      records: [],
      message: 'CNPJ inválido para consulta no PNCP.',
      retrievedAt,
    };
  }

  const seenControls = new Set<string>();
  const records: ContractRecord[] = [];
  const byRole = { fornecedor: 0, orgao_contratante: 0, subcontratado: 0 };

  let pncpTotalDeclared = 0;
  let pagesFetched = 0;
  let status: PncpCnpjSearchResult['status'] = 'complete';
  let errorDetail = '';

  for (let page = 1; page <= maxPages; page++) {
    const url = new URL('https://pncp.gov.br/api/search/');
    url.searchParams.set('q', cnpj);
    url.searchParams.set('tipos_documento', 'contrato');
    url.searchParams.set('pagina', String(page));
    url.searchParams.set('tam_pagina', String(pageSize));

    const res = await fetchJsonWithRetry(url.toString());
    if (res.status === 429) {
      status = pagesFetched > 0 ? 'partial' : 'rate_limited';
      errorDetail = 'A API pública do PNCP retornou HTTP 429 (limite de taxa).';
      break;
    }
    if (!res.ok || !res.body) {
      status = pagesFetched > 0 ? 'partial' : 'unavailable';
      errorDetail = res.networkError
        ? `Falha de comunicação com a API do PNCP (${res.networkError}).`
        : `A API do PNCP retornou HTTP ${res.status}.`;
      break;
    }

    pagesFetched += 1;
    const total = Number(res.body.total ?? 0);
    if (page === 1 && Number.isFinite(total)) {
      pncpTotalDeclared = total;
    }

    const items = Array.isArray(res.body.items) ? res.body.items : [];
    if (items.length === 0) break;

    for (const item of items) {
      const role = classifyCnpjRoleInPncpItem(cnpj, item);
      if (!role) continue; // Ignore loose full-text mentions that are neither fornecedor, orgao nor subcontratado

      const record = mapPncpSearchItemToContract(item, role, retrievedAt);
      if (seenControls.has(record.pncpControlNumber)) continue;
      seenControls.add(record.pncpControlNumber);
      byRole[role] += 1;
      records.push(record);
    }

    if (page * pageSize >= pncpTotalDeclared || items.length < pageSize) {
      break;
    }
  }

  const reachedPageCap =
    status === 'complete' && pncpTotalDeclared > pagesFetched * pageSize;
  if (reachedPageCap) {
    status = 'partial';
  }

  const partialCoverage = status !== 'complete';

  let message: string;
  if (status === 'rate_limited') {
    message = `${errorDetail} Não é possível afirmar ausência de contratos no PNCP.`;
  } else if (status === 'unavailable') {
    message = `${errorDetail} Não é possível afirmar ausência de contratos no PNCP; exibindo apenas índice local persistido.`;
  } else if (status === 'partial') {
    message = `Consulta parcial ao PNCP: ${records.length} contrato(s) vinculado(s) ao CNPJ capturado(s) em ${pagesFetched} página(s) (total declarado no PNCP: ${pncpTotalDeclared}).${errorDetail ? ` ${errorDetail}` : ' Limite de paginação atingido.'}`;
  } else if (records.length > 0) {
    message = `PNCP consultado em abrangência nacional: ${records.length} contrato(s) localizado(s) para o CNPJ (${byRole.fornecedor} como fornecedor, ${byRole.orgao_contratante} como órgão contratante${byRole.subcontratado > 0 ? `, ${byRole.subcontratado} como subcontratado` : ''}). Contratos não publicados no PNCP (ex.: portais/diários locais) constam apenas se indexados localmente.`;
  } else {
    message = `PNCP consultado em abrangência nacional sem contratos vinculados diretamente a este CNPJ (total declarado: ${pncpTotalDeclared}). Contratos municipais não publicados no PNCP podem existir em diários oficiais ou portais locais.`;
  }

  return {
    cnpj,
    status,
    pncpTotalDeclared,
    pncpFetchedCount: records.length,
    pagesFetched,
    partialCoverage,
    byRole,
    records,
    message,
    retrievedAt,
  };
}

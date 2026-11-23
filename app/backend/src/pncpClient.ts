import crypto from 'node:crypto';
import {
  deriveMatrizCnpj as deriveMatrizCnpjShared,
  isCnpjFormat,
  normalizeCnpj,
} from '@nexofis/shared/lib/cnpj';
import type { ContractRecord } from '@nexofis/shared/types/audit';

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
  numero_contrato_empenho?: string;
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

/**
 * Derives the Matriz ('0001') CNPJ with valid Modulo-11 check digits for a branch (filial) CNPJ.
 * Supports both legacy numeric and RFB 2026 alphanumeric CNPJs.
 * Returns null if the input is invalid or is already a Matriz ('0001').
 */
export function deriveMatrizCnpj(rawCnpj?: string | null): string | null {
  const clean = normalizeCnpj(rawCnpj);
  if (!isCnpjFormat(clean)) return null;
  if (clean.slice(8, 12) === '0001') return null;
  return deriveMatrizCnpjShared(clean);
}

function mapModalityFromText(raw?: string): { modality: ContractRecord['modality']; inferred: boolean } {
  const txt = (raw ?? '').trim().toLowerCase();
  if (!txt) return { modality: 'Não informada', inferred: false };
  if (txt.includes('dispensa')) return { modality: 'Dispensa de Licitação', inferred: true };
  if (txt.includes('inexig') || txt.includes('credenc')) return { modality: 'Inexigibilidade', inferred: true };
  if (txt.includes('concorr')) return { modality: 'Concorrência', inferred: true };
  if (txt.includes('preg')) return { modality: 'Pregão Eletrônico', inferred: true };
  return { modality: 'Não informada', inferred: false };
}

function parseIsoDateStrict(raw?: string): string {
  if (raw && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.slice(0, 10);
  }
  return '';
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
  const target = normalizeCnpj(cnpj);
  if (!target) return null;
  const fornecedorClean = normalizeCnpj(item.fornecedor_ni);
  const orgaoClean = normalizeCnpj(item.orgao_cnpj);
  const subClean = normalizeCnpj(item.fornecedor_subcontratado_ni);

  if (fornecedorClean === target) return 'fornecedor';
  if (orgaoClean === target) return 'orgao_contratante';
  if (subClean === target) return 'subcontratado';
  return null;
}

/**
 * Maps a PNCP /api/search item to ContractRecord WITHOUT fabricating unknown fields (A02/A13):
 * - Missing dates stay '' (never invented as YYYY-01-01 / YYYY-12-31)
 * - Missing modality stays 'Não informada' (never defaulted to 'Pregão Eletrônico')
 * - Missing biddersCount stays null (never guessed as 1 or 3)
 * - Missing supplier openingDate/status/CNAE stay '' / 'DESCONHECIDA' (never '2020-01-01' / 'ATIVA')
 */
export function mapPncpSearchItemToContract(
  item: PncpSearchItem,
  role: 'fornecedor' | 'orgao_contratante' | 'subcontratado',
  retrievedAt: string
): ContractRecord {
  const orgaoCnpj = normalizeCnpj(item.orgao_cnpj) || '';
  const fornecedorCnpj = normalizeCnpj(item.fornecedor_ni) || '';

  const parsedYearFromField = Number(item.ano);
  const parsedYearFromDate = Number(
    (item.data_assinatura ?? item.data_inicio_vigencia ?? item.data_publicacao_pncp ?? '').slice(0, 4)
  );
  const year =
    Number.isInteger(parsedYearFromField) && parsedYearFromField >= 2000 && parsedYearFromField <= 2100
      ? parsedYearFromField
      : Number.isInteger(parsedYearFromDate) && parsedYearFromDate >= 2000 && parsedYearFromDate <= 2100
        ? parsedYearFromDate
        : Number(retrievedAt.slice(0, 4)) || new Date().getUTCFullYear();

  const controlNumber =
    item.numero_controle_pncp?.trim() ||
    `${orgaoCnpj || 'SEM-CNPJ'}-2-${String(item.numero_sequencial ?? item.numero ?? '000001').padStart(6, '0')}/${year}`;
  const rawEmpenhoNum = item.numero_contrato_empenho?.trim() || '';
  const rawNum = rawEmpenhoNum || String(item.numero ?? item.numero_sequencial ?? '').trim();
  const contractNumber = rawNum
    ? rawNum.includes('/')
      ? rawNum
      : `${rawNum}/${year}`
    : item.title?.trim() || controlNumber;

  const valorGlobal = Number(item.valor_global);
  const hasValorGlobal = item.valor_global !== undefined && item.valor_global !== null && Number.isFinite(valorGlobal) && valorGlobal >= 0;
  const safeValue = hasValorGlobal ? valorGlobal : 0;

  // Preserve exact upstream dates — NEVER invent YYYY-01-01 or YYYY-12-31
  const signatureDate = parseIsoDateStrict(item.data_assinatura);
  const startDate = parseIsoDateStrict(item.data_inicio_vigencia) || signatureDate;
  const endDate = parseIsoDateStrict(item.data_fim_vigencia);

  const amparo = Array.isArray(item.amparo_legal_nome)
    ? item.amparo_legal_nome.filter(Boolean).join('; ')
    : item.amparo_legal_nome ?? '';

  const modalityMapped = mapModalityFromText(
    item.modalidade_licitacao_nome || amparo
  );

  const ibgeCode =
    item.codigo_ibge && /^\d{7}$/.test(String(item.codigo_ibge))
      ? String(item.codigo_ibge)
      : '';
  const municipalityName = item.municipio_nome?.trim() || 'Município não informado no PNCP';
  const uf = item.uf?.trim().toUpperCase() || '';
  const entityName =
    item.unidade_nome?.trim() ||
    item.orgao_nome?.trim() ||
    (orgaoCnpj ? `Órgão CNPJ ${orgaoCnpj}` : 'Órgão não informado no PNCP');

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

  const rawSituacao = (item.situacao_nome ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const todayIso = retrievedAt.slice(0, 10);
  let mappedStatus: ContractRecord['status'] = 'Vigente';
  if (
    rawSituacao.includes('suspens') ||
    rawSituacao.includes('rescind') ||
    rawSituacao.includes('anulad') ||
    rawSituacao.includes('cancel')
  ) {
    mappedStatus = 'Suspenso';
  } else if (
    rawSituacao.includes('encerrad') ||
    rawSituacao.includes('concluid') ||
    rawSituacao.includes('finaliz') ||
    (Boolean(endDate) && /^\d{4}-\d{2}-\d{2}$/.test(endDate) && endDate < todayIso)
  ) {
    mappedStatus = 'Encerrado';
  }

  const fieldProvenance: Record<string, string> = {
    signatureDate: signatureDate ? 'pncp:data_assinatura' : 'unknown',
    startDate: item.data_inicio_vigencia ? 'pncp:data_inicio_vigencia' : signatureDate ? 'pncp:data_assinatura' : 'unknown',
    endDate: endDate ? 'pncp:data_fim_vigencia' : 'unknown',
    modality: modalityMapped.inferred ? 'pncp:modalidade_ou_amparo' : 'unknown',
    biddersCount: 'unknown',
    supplierRegistrationStatus: 'unknown',
    supplierOpeningDate: 'unknown',
    originalValue: hasValorGlobal ? 'pncp:valor_global' : 'unknown',
  };

  return {
    id: safeId,
    pncpControlNumber: controlNumber,
    contractNumber,
    year,
    municipalityIbge: ibgeCode,
    municipalityName,
    uf,
    entityId: `ENT-${orgaoCnpj || ibgeCode || 'SEM-CNPJ'}-${item.unidade_codigo ?? '1'}`,
    entityName,
    modality: modalityMapped.modality,
    biddersCount: null,
    object: item.description?.trim() || item.title?.trim() || 'Contrato público registrado no PNCP',
    objectCategory: amparo ? `${modalityMapped.modality} (${amparo})` : `${modalityMapped.modality} · PNCP`,
    expectedCnaePrefixes: [],
    signatureDate,
    startDate,
    endDate,
    originalValue: safeValue,
    updatedValue: safeValue,
    status: mappedStatus,
    cnpjRole: role,
    fieldProvenance,
    pncpVerification: {
      queried: true,
      status: 'completed_match',
      queriedAt: retrievedAt,
      querySummary: `PNCP /api/search (${controlNumber})`,
    },
    supplier: {
      cnpj: fornecedorCnpj,
      legalName:
        item.fornecedor_nome?.trim() ||
        (fornecedorCnpj ? `Fornecedor CNPJ ${fornecedorCnpj}` : 'Fornecedor não informado no PNCP'),
      openingDate: '',
      registrationStatus: 'DESCONHECIDA',
      primaryCnaeCode: '',
      primaryCnaeDescription: 'Não informado pelo endpoint de busca do PNCP',
      secondaryCnaes: [],
      shareCapital: 0,
      municipality: '',
      uf: '',
      shareholders: [],
      sanctions: [],
      priorMunicipalContracts: 0,
      simultaneousActiveContracts: 0,
      dataProvenance: 'PNCP API Oficial de Busca (/api/search — dados cadastrais RFB não consultados)',
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
        effectiveAt: parseIsoDateStrict(item.data_publicacao_pncp) || signatureDate || undefined,
        rawPayloadHash,
        parserVersion: 'pncp-search-client-2.0',
        reportedOriginalValue: safeValue,
        reportedUpdatedValue: safeValue,
        reportedSupplierCnpj: fornecedorCnpj,
        reportedStatus: item.situacao_nome?.trim() || 'Publicado no PNCP',
        reportedEndDate: endDate,
        sourceUrl,
        notes: `Papel do CNPJ pesquisado: ${roleLabel} · Órgão CNPJ ${orgaoCnpj || 'não informado'}${amparo ? ` · Amparo: ${amparo}` : ''}`,
      },
    ],
    documents: [],
    dataSourceOrigin: 'PNCP API Oficial',
  };
}

/**
 * Queries PNCP national search API for ALL public contracts referencing a 14-char numeric or RFB 2026 alphanumeric CNPJ
 * across Brazil, paginating cleanly and strictly classifying role (fornecedor vs orgao_contratante vs subcontratado).
 * Never converts rate limits (429) or network errors into "0 contracts exist".
 */
export async function fetchPncpContractsByCnpj(
  rawCnpj: string,
  options?: { maxPages?: number; pageSize?: number }
): Promise<PncpCnpjSearchResult> {
  const cnpj = normalizeCnpj(rawCnpj);
  const retrievedAt = new Date().toISOString();
  const maxPages = Math.min(Math.max(options?.maxPages ?? 5, 1), 10);
  const pageSize = Math.min(Math.max(options?.pageSize ?? 50, 10), 100);

  if (!isCnpjFormat(cnpj)) {
    return {
      cnpj,
      status: 'unavailable',
      pncpTotalDeclared: 0,
      pncpFetchedCount: 0,
      pagesFetched: 0,
      partialCoverage: true,
      byRole: { fornecedor: 0, orgao_contratante: 0, subcontratado: 0 },
      records: [],
      message: 'CNPJ inválido para consulta no PNCP (aceita 14 dígitos numéricos ou CNPJ alfanumérico RFB 2026).',
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
      if (!role) continue;

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

export interface PncpWinningSupplierResult {
  supplierCnpj: string;
  supplierName: string;
  awardedValue: number;
  awardDate: string;
}

/**
 * Queries PNCP item results endpoint for a homologated compra to recover the winning supplier's
 * real legal name, CNPJ, and homologated value when published by the municipality.
 */
export async function fetchPncpItemWinningSupplier(
  orgaoCnpj: string,
  anoCompra: number,
  sequencialCompra: number,
  timeoutMs = 3500
): Promise<PncpWinningSupplierResult | null> {
  const cleanOrgao = normalizeCnpj(orgaoCnpj);
  if (!cleanOrgao || !Number.isInteger(anoCompra) || !Number.isInteger(sequencialCompra)) {
    return null;
  }

  const headers = {
    Accept: 'application/json',
    'User-Agent': 'Nexofis/0.1.0 (https://github.com/devdudumuniz/NEXOFIS)',
    Connection: 'close',
  };

  const fetchItemResult = async (
    itemNumber: number,
    signal: AbortSignal
  ): Promise<PncpWinningSupplierResult | null> => {
    const url = `https://pncp.gov.br/api/pncp/v1/orgaos/${encodeURIComponent(
      cleanOrgao
    )}/compras/${anoCompra}/${sequencialCompra}/itens/${itemNumber}/resultados`;
    const res = await fetch(url, { signal, headers });
    if (!res.ok || res.status === 204) return null;
    const raw = (await res.json()) as Array<{
      niFornecedor?: string;
      nomeRazaoSocialFornecedor?: string;
      valorTotalHomologado?: number;
      dataResultado?: string;
      situacaoCompraItemResultadoNome?: string;
    }>;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const winner =
      raw.find((item) => item.nomeRazaoSocialFornecedor && item.niFornecedor) ?? raw[0];
    const supplierName = String(winner.nomeRazaoSocialFornecedor ?? '').trim();
    const supplierCnpj = normalizeCnpj(winner.niFornecedor) || '';
    if (!supplierName && !supplierCnpj) return null;
    const awardedValue =
      typeof winner.valorTotalHomologado === 'number' && Number.isFinite(winner.valorTotalHomologado)
        ? winner.valorTotalHomologado
        : 0;
    const awardDate = parseIsoDateStrict(winner.dataResultado);
    return {
      supplierCnpj,
      supplierName: supplierName || `Fornecedor CNPJ ${supplierCnpj}`,
      awardedValue,
      awardDate,
    };
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Fast path: check item 1 results directly
    const item1Winner = await fetchItemResult(1, controller.signal);
    if (item1Winner) return item1Winner;

    // Fallback: inspect up to 5 items of the compra to find an item with temResultado=true
    const itemsUrl = `https://pncp.gov.br/api/pncp/v1/orgaos/${encodeURIComponent(
      cleanOrgao
    )}/compras/${anoCompra}/${sequencialCompra}/itens?pagina=1&tamanhoPagina=5`;
    const itemsRes = await fetch(itemsUrl, { signal: controller.signal, headers });
    if (!itemsRes.ok || itemsRes.status === 204) return null;
    const itemsList = (await itemsRes.json()) as Array<{
      numeroItem?: number;
      temResultado?: boolean;
    }>;
    if (!Array.isArray(itemsList) || itemsList.length === 0) return null;

    const candidateItem = itemsList.find(
      (it) => it.temResultado && Number.isInteger(it.numeroItem) && it.numeroItem !== 1
    );
    if (!candidateItem?.numeroItem) return null;
    return await fetchItemResult(candidateItem.numeroItem, controller.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}


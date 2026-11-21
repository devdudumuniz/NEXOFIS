import type {
  EvaluatedContract,
  FindingReviewRecord,
  GovernmentEntity,
  Municipality,
  SavedDossierSummary,
} from '../types/audit';
import type { ExtractedDocumentFields } from './documentParser';
import type { RiskDashboardSummary } from './dashboardAggregator';
import type { ParsedContractCode } from './pncpQueryParser';

export interface RiskDashboardResponse {
  storageEngine: string;
  totalStoredInSqlite: number;
  summary: RiskDashboardSummary;
  contracts: EvaluatedContract[];
}

export interface MunicipalityContextResponse {
  municipality: Municipality;
  entities: GovernmentEntity[];
  contracts: EvaluatedContract[];
  summary: {
    contractCount: number;
    entityCount: number;
    totalValue: number;
    highRiskCount: number;
    livePncpUsed: boolean;
  };
}

export interface CnpjCoverageInfo {
  cnpj: string;
  relatedMatrizCnpj?: string | null;
  filialPncpFetchedCount?: number;
  matrizPncpFetchedCount?: number;
  legalName: string | null;
  profileSource: string | null;
  registrationStatus: string | null;
  primaryCnae: string | null;
  pncpStatus: 'complete' | 'partial' | 'rate_limited' | 'unavailable';
  pncpTotalDeclared: number;
  pncpFetchedCount: number;
  localOnlyCount: number;
  partialCoverage: boolean;
  byRole: {
    fornecedor: number;
    orgao_contratante: number;
    subcontratado: number;
  };
  message: string;
}

export interface DocumentUploadResponse {
  sha256: string;
  idempotentDuplicate?: boolean;
  matchedPncp: boolean;
  matchStatus?: 'matched' | 'ambiguous' | 'unmatched';
  ambiguousCandidates?: Array<{
    id: string;
    contractNumber: string;
    pncpControlNumber: string;
    municipalityIbge: string;
    municipalityName: string;
    supplierCnpj: string;
    supplierName: string;
  }>;
  extraction: ExtractedDocumentFields;
  pipelineSteps: Array<{
    stage: string;
    status: 'ok' | 'fallback';
    detail: string;
  }>;
  contract: EvaluatedContract;
  batchContracts?: EvaluatedContract[];
}

export async function searchMunicipalities(query: string): Promise<{
  results: Municipality[];
  totalIndexed: number;
}> {
  const res = await fetch(`/api/municipalities/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Falha ao consultar municípios IBGE.' }));
    throw new Error(err.error || 'Falha ao consultar municípios IBGE.');
  }
  return res.json();
}

export async function fetchRiskDashboardSummary(period?: {
  startDate?: string;
  endDate?: string;
}): Promise<RiskDashboardResponse> {
  const qs = new URLSearchParams();
  if (period?.startDate) qs.set('startDate', period.startDate);
  if (period?.endDate) qs.set('endDate', period.endDate);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await fetch(`/api/dashboard/risk-summary${suffix}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Falha ao carregar painel de riscos.' }));
    throw new Error(err.error || 'Falha ao carregar painel de riscos.');
  }
  return res.json();
}

export async function fetchMunicipalityContext(
  ibgeCode: string,
  period?: { startDate?: string; endDate?: string }
): Promise<MunicipalityContextResponse> {
  const qs = new URLSearchParams();
  if (period?.startDate) qs.set('startDate', period.startDate);
  if (period?.endDate) qs.set('endDate', period.endDate);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await fetch(`/api/municipalities/${encodeURIComponent(ibgeCode)}/context${suffix}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Falha ao carregar contexto municipal.' }));
    throw new Error(err.error || 'Falha ao carregar contexto municipal.');
  }
  return res.json();
}

export async function searchContracts(params: {
  q?: string;
  ibge?: string;
  year?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  minRisk?: number;
}): Promise<{
  results: EvaluatedContract[];
  relatedResults?: EvaluatedContract[];
  total: number;
  disambiguationRequired: boolean;
  parsedReference?: {
    orgaoCnpj?: string;
    year?: string;
    sequential?: string;
    sourceHost?: string;
  } | null;
  parsedContractCode?: ParsedContractCode | null;
  resolvedMunicipality?: Municipality | null;
  livePncpStatus?: {
    queried: boolean;
    municipalityLabel?: string;
    totalLiveRecords: number;
    inexigibilidadeCount: number;
    message: string;
  } | null;
  cnpjCoverage?: CnpjCoverageInfo | null;
}> {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.ibge) qs.set('ibge', params.ibge);
  if (params.year) qs.set('year', params.year);
  if (params.status) qs.set('status', params.status);
  if (params.startDate) qs.set('startDate', params.startDate);
  if (params.endDate) qs.set('endDate', params.endDate);
  if (params.minRisk) qs.set('minRisk', String(params.minRisk));
  const res = await fetch(`/api/contracts/search?${qs.toString()}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Falha ao buscar contratos.' }));
    throw new Error(err.error || 'Falha ao buscar contratos.');
  }
  return res.json();
}

export async function fetchSupplierMirrorContracts(cnpj: string): Promise<{
  cnpj: string;
  total: number;
  indexSource: string;
  contracts: EvaluatedContract[];
}> {
  const res = await fetch(`/api/suppliers/${encodeURIComponent(cnpj)}/contracts`);
  if (!res.ok) throw new Error('Falha ao consultar contratos horizontais do fornecedor.');
  return res.json();
}

export async function fetchContractById(id: string): Promise<EvaluatedContract> {
  const res = await fetch(`/api/contracts/${encodeURIComponent(id)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Contrato não encontrado.' }));
    throw new Error(err.error || 'Contrato não encontrado.');
  }
  return res.json();
}

export async function fetchFindingReviews(contractId: string): Promise<FindingReviewRecord[]> {
  const res = await fetch(`/api/contracts/${encodeURIComponent(contractId)}/reviews`);
  if (!res.ok) return [];
  const data = (await res.json()) as { reviews: FindingReviewRecord[] };
  return Array.isArray(data.reviews) ? data.reviews : [];
}

export async function submitFindingReview(
  contractId: string,
  findingId: string,
  payload: {
    action: 'dismiss' | 'restore';
    rationale: string;
    author?: string;
    ruleVersion?: string;
  }
): Promise<{ review: FindingReviewRecord; reviews: FindingReviewRecord[] }> {
  const res = await fetch(
    `/api/contracts/${encodeURIComponent(contractId)}/findings/${encodeURIComponent(findingId)}/review`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
  const data = await res.json().catch(() => ({ error: 'Falha ao registrar revisão humana.' }));
  if (!res.ok) {
    throw new Error(data.error || 'Falha ao registrar revisão humana.');
  }
  return data as { review: FindingReviewRecord; reviews: FindingReviewRecord[] };
}

export async function checkLiveSupplierCnpj(cnpj: string): Promise<{
  enriched: boolean;
  source?: string;
  message?: string;
  data?: {
    legalName?: string;
    openingDate?: string;
    primaryCnaeCode?: string;
    primaryCnaeDescription?: string;
    shareCapital?: number;
    registrationStatus?: string;
    shareholders?: Array<{ name: string; role: string; entryDate: string }>;
  };
}> {
  const res = await fetch(`/api/suppliers/${encodeURIComponent(cnpj)}/live-check`);
  if (!res.ok) throw new Error('Falha ao consultar CNPJ na base externa.');
  return res.json();
}

export async function uploadContractDocument(
  file: File,
  forceOcr = false
): Promise<DocumentUploadResponse> {
  const form = new FormData();
  form.append('file', file);
  form.append('forceOcr', String(forceOcr));

  const res = await fetch('/api/documents/upload', {
    method: 'POST',
    body: form,
  });
  const payload = await res.json().catch(() => ({ error: 'Erro ao processar resposta do servidor.' }));
  if (!res.ok) {
    throw new Error(payload.error || 'Não foi possível processar o documento enviado.');
  }
  return payload as DocumentUploadResponse;
}

export async function ingestSampleDocument(
  sampleType: 'fsa-123-scan' | 'fsa-087-native' | 'bdc-fms-list'
): Promise<DocumentUploadResponse> {
  const res = await fetch('/api/documents/ingest-sample', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sampleType }),
  });
  const payload = await res.json().catch(() => ({ error: 'Falha ao processar documento de demonstração.' }));
  if (!res.ok) {
    throw new Error(payload.error || 'Falha ao processar documento de demonstração.');
  }
  return payload as DocumentUploadResponse;
}

export async function fetchSavedDossiers(): Promise<SavedDossierSummary[]> {
  const res = await fetch('/api/dossiers');
  if (!res.ok) return [];
  const data = (await res.json()) as { dossiers: SavedDossierSummary[] };
  return data.dossiers;
}

export async function saveDossier(
  contractId: string,
  analystNote: string
): Promise<{ dossier: SavedDossierSummary; dossiers: SavedDossierSummary[] }> {
  const res = await fetch('/api/dossiers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contractId, analystNote }),
  });
  if (!res.ok) throw new Error('Falha ao salvar dossiê.');
  return res.json();
}

export async function deleteSavedDossier(id: string): Promise<SavedDossierSummary[]> {
  const res = await fetch(`/api/dossiers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Falha ao remover dossiê.');
  const data = (await res.json()) as { dossiers: SavedDossierSummary[] };
  return data.dossiers;
}


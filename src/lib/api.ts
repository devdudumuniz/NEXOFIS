import type {
  EvaluatedContract,
  FindingReviewRecord,
  GovernmentEntity,
  Municipality,
  SavedDossierSnapshot,
  SavedDossierSummary,
} from '../types/audit';
import type { ExtractedDocumentFields } from './documentParser';
import type { RiskDashboardSummary } from './dashboardAggregator';
import type { ParsedContractCode } from './pncpQueryParser';
import type { InvestigationDataset, InvestigationResponse } from '../types/investigation';

// In-memory session token ONLY (never persisted to localStorage — SecureCoder / A09)
let inMemoryAuthToken: string | null = null;

export function setAuthToken(token: string | null): void {
  inMemoryAuthToken = token && token.trim() ? token.trim() : null;
}

export function getAuthToken(): string | null {
  return inMemoryAuthToken;
}

export function clearAuthToken(): void {
  inMemoryAuthToken = null;
}

function investigationPath(contractId: string, suffix = ''): string {
  return `/api/contracts/${encodeURIComponent(contractId)}/investigation${suffix}`;
}

export async function fetchInvestigation(contractId: string): Promise<InvestigationResponse> {
  return readJson(await fetch(investigationPath(contractId), {
    headers: buildAuthHeaders(), cache: 'no-store',
  }), 'Não foi possível carregar a investigação.');
}

export async function importInvestigationDataset(
  contractId: string,
  dataset: InvestigationDataset,
  rationale: string,
  expectedRevisionDigest: string | null,
): Promise<InvestigationResponse> {
  return readJson(await fetch(investigationPath(contractId, '/dataset'), {
    method: 'POST', headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ dataset, rationale, expectedRevisionDigest }),
  }), 'Não foi possível registrar esta revisão da investigação.');
}

export async function reviewInvestigationFinding(
  contractId: string,
  payload: { findingId: string; findingInputDigest: string; action: 'dismiss' | 'restore'; rationale: string },
): Promise<InvestigationResponse> {
  return readJson(await fetch(investigationPath(contractId, '/reviews'), {
    method: 'POST', headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  }), 'Não foi possível registrar a revisão do apontamento.');
}

export async function refreshInvestigationRegistry(
  contractId: string,
  payload: { purpose: string; legalBasis: string; rationale: string; expectedRevisionDigest: string | null },
): Promise<InvestigationResponse & { registryMessage?: string }> {
  return readJson(await fetch(investigationPath(contractId, '/refresh-registry'), {
    method: 'POST', headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  }), 'Não foi possível consultar o cadastro empresarial.');
}

export async function exportInvestigation(contractId: string): Promise<Record<string, unknown>> {
  return readJson(await fetch(investigationPath(contractId, '/export'), {
    headers: buildAuthHeaders(), cache: 'no-store',
  }), 'Não foi possível exportar a investigação.');
}

export interface InvestigationArtifactReceipt {
  artifactSha256: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export async function uploadInvestigationArtifact(
  contractId: string, file: File,
): Promise<InvestigationArtifactReceipt> {
  if (file.size > 1024 * 1024) throw new Error('O limite por evidência é 1 MiB.');
  const contentBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo selecionado.'));
    reader.readAsDataURL(file);
  });
  return readJson(await fetch(investigationPath(contractId, '/artifacts'), {
    method: 'POST', headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ filename: file.name, mimeType: file.type || 'application/octet-stream', contentBase64 }),
  }), 'Não foi possível preservar o arquivo de evidência.');
}

export async function downloadInvestigationArtifact(contractId: string, sha256: string): Promise<Blob> {
  const res = await fetch(investigationPath(contractId, `/artifacts/${encodeURIComponent(sha256)}`), {
    headers: buildAuthHeaders(), cache: 'no-store',
  });
  if (!res.ok) throw await parseErrorResponse(res, 'Não foi possível verificar e baixar a evidência.');
  return res.blob();
}

export class ApiError extends Error {
  readonly status: number;
  readonly body?: Record<string, unknown>;

  constructor(message: string, status: number, body?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function buildAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (inMemoryAuthToken) {
    headers.Authorization = `Bearer ${inMemoryAuthToken}`;
  }
  return headers;
}

async function parseErrorResponse(res: Response, fallbackMessage: string): Promise<ApiError> {
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json')
    ? ((await res.json().catch(() => null)) as Record<string, unknown> | null)
    : null;
  const msg =
    body && typeof body.error === 'string' && body.error.trim()
      ? body.error
      : `${fallbackMessage} (HTTP ${res.status})`;
  return new ApiError(msg, res.status, body ?? undefined);
}

async function readJson<T>(res: Response, fallbackMessage: string): Promise<T> {
  if (!res.ok) {
    throw await parseErrorResponse(res, fallbackMessage);
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    throw new ApiError(
      `${fallbackMessage} (resposta inesperada do servidor; verifique se a API está ativa)`,
      res.status || 502
    );
  }
  return (await res.json()) as T;
}

export interface AuthPrincipalInfo {
  userId: string;
  email?: string;
  displayName?: string;
  role: 'admin' | 'analyst' | 'viewer';
  authEnabled: boolean;
}

export interface AuthStatusResponse {
  authEnabled: boolean;
  needsBootstrap: boolean;
  userCount: number;
  principal: AuthPrincipalInfo | null;
}

export interface OcrStatusResponse {
  tier0NativeReady: boolean;
  doclingServe: { configured: boolean; reachable: boolean; detail: string };
  paddleOcr: { configured: boolean; reachable: boolean; detail: string };
  multimodalFallbackConfigured: boolean;
  fullOcrReady: boolean;
  supportedFormats: string[];
  note: string;
  checkedAt: string;
}

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
    pncpMessage?: string;
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
  jobId?: string;
  sha256: string;
  idempotentDuplicate?: boolean;
  originalObjectStored?: boolean;
  originalDownloadUrl?: string;
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
  ocrTelemetry?: {
    engineUsed: string;
    extractorVersion: string;
    durationMs: number;
    totalPages: number;
    originalPageCount: number;
    processedPageCount: number;
    truncated: boolean;
    budgetExceeded: boolean;
    budgetReason?: string;
    pagesSkippedOcr: number;
    pagesOcrProcessed: number;
    qualityScore: number;
    ocrCorrectionsApplied: number;
    fromCache: boolean;
  };
  pipelineSteps: Array<{
    stage: string;
    status: 'ok' | 'fallback';
    detail: string;
  }>;
  contract: EvaluatedContract;
  batchContracts?: EvaluatedContract[];
}

export async function fetchAuthStatus(): Promise<AuthStatusResponse> {
  const res = await fetch('/api/auth/status', { headers: buildAuthHeaders() });
  return readJson<AuthStatusResponse>(res, 'Falha ao consultar estado de autenticação.');
}

export async function bootstrapAdmin(payload: {
  email: string;
  displayName: string;
  password: string;
}): Promise<{ token: string; principal: AuthPrincipalInfo }> {
  const res = await fetch('/api/auth/bootstrap-admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await readJson<{ token: string; principal: AuthPrincipalInfo }>(
    res,
    'Falha ao criar administrador inicial.'
  );
  setAuthToken(data.token);
  return data;
}

export async function loginAuth(payload: {
  email: string;
  password: string;
}): Promise<{ token: string; principal: AuthPrincipalInfo }> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await readJson<{ token: string; principal: AuthPrincipalInfo }>(
    res,
    'Falha ao autenticar usuário.'
  );
  setAuthToken(data.token);
  return data;
}

export async function fetchOcrStatus(): Promise<OcrStatusResponse> {
  const res = await fetch('/api/ocr/status', { headers: buildAuthHeaders() });
  return readJson<OcrStatusResponse>(res, 'Falha ao consultar status do motor OCR.');
}

export async function searchMunicipalities(query: string): Promise<{
  results: Municipality[];
  totalIndexed: number;
}> {
  const res = await fetch(`/api/municipalities/search?q=${encodeURIComponent(query)}`, {
    headers: buildAuthHeaders(),
  });
  return readJson<{ results: Municipality[]; totalIndexed: number }>(
    res,
    'Falha ao consultar municípios IBGE.'
  );
}

export async function fetchRiskDashboardSummary(period?: {
  startDate?: string;
  endDate?: string;
}): Promise<RiskDashboardResponse> {
  const qs = new URLSearchParams();
  if (period?.startDate) qs.set('startDate', period.startDate);
  if (period?.endDate) qs.set('endDate', period.endDate);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await fetch(`/api/dashboard/risk-summary${suffix}`, {
    headers: buildAuthHeaders(),
  });
  return readJson<RiskDashboardResponse>(res, 'Falha ao carregar painel de riscos.');
}

export async function fetchMunicipalityContext(
  ibgeCode: string,
  period?: { startDate?: string; endDate?: string }
): Promise<MunicipalityContextResponse> {
  const qs = new URLSearchParams();
  if (period?.startDate) qs.set('startDate', period.startDate);
  if (period?.endDate) qs.set('endDate', period.endDate);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await fetch(`/api/municipalities/${encodeURIComponent(ibgeCode)}/context${suffix}`, {
    headers: buildAuthHeaders(),
  });
  return readJson<MunicipalityContextResponse>(res, 'Falha ao carregar contexto municipal.');
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
  const res = await fetch(`/api/contracts/search?${qs.toString()}`, {
    headers: buildAuthHeaders(),
  });
  return readJson(res, 'Falha ao buscar contratos.');
}

export async function fetchSupplierMirrorContracts(cnpj: string): Promise<{
  cnpj: string;
  total: number;
  indexSource: string;
  contracts: EvaluatedContract[];
  pncpCnpjSync?: { message: string; status: 'complete' | 'partial' | 'rate_limited' | 'unavailable' };
}> {
  const res = await fetch(`/api/suppliers/${encodeURIComponent(cnpj)}/contracts`, {
    headers: buildAuthHeaders(),
  });
  return readJson(res, 'Falha ao consultar contratos horizontais do fornecedor.');
}

export async function fetchContractById(id: string): Promise<EvaluatedContract> {
  const res = await fetch(`/api/contracts/${encodeURIComponent(id)}`, {
    headers: buildAuthHeaders(),
  });
  return readJson<EvaluatedContract>(res, 'Contrato não encontrado.');
}

/**
 * UI-02: Never swallow HTTP errors into an empty array. Always throw ApiError so UI can preserve
 * last known state and display an explicit retry banner.
 */
export async function fetchFindingReviews(contractId: string): Promise<FindingReviewRecord[]> {
  const res = await fetch(`/api/contracts/${encodeURIComponent(contractId)}/reviews`, {
    headers: buildAuthHeaders(),
  });
  const data = await readJson<{ reviews: FindingReviewRecord[] }>(
    res,
    'Falha ao carregar histórico de revisões do auditor.'
  );
  return Array.isArray(data.reviews) ? data.reviews : [];
}

export async function submitFindingReview(
  contractId: string,
  findingId: string,
  payload: {
    action: 'dismiss' | 'restore';
    rationale: string;
  }
): Promise<{ review: FindingReviewRecord; reviews: FindingReviewRecord[] }> {
  const res = await fetch(
    `/api/contracts/${encodeURIComponent(contractId)}/findings/${encodeURIComponent(findingId)}/review`,
    {
      method: 'POST',
      headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    }
  );
  return readJson(res, 'Falha ao registrar revisão humana.');
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
  const res = await fetch(`/api/suppliers/${encodeURIComponent(cnpj)}/live-check`, {
    headers: buildAuthHeaders(),
  });
  return readJson(res, 'Falha ao consultar CNPJ na base externa.');
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
    headers: buildAuthHeaders(),
    body: form,
  });
  return readJson<DocumentUploadResponse>(res, 'Não foi possível processar o documento enviado.');
}

/**
 * UI-02: Never swallow HTTP errors into an empty array.
 */
export async function fetchSavedDossiers(): Promise<SavedDossierSummary[]> {
  const res = await fetch('/api/dossiers', { headers: buildAuthHeaders() });
  const data = await readJson<{ dossiers: SavedDossierSummary[] }>(
    res,
    'Falha ao carregar dossiês arquivados.'
  );
  return Array.isArray(data.dossiers) ? data.dossiers : [];
}

export async function fetchDossierSnapshot(id: string): Promise<SavedDossierSnapshot> {
  const res = await fetch(`/api/dossiers/${encodeURIComponent(id)}`, {
    headers: buildAuthHeaders(),
  });
  const data = await readJson<{ dossier: SavedDossierSnapshot }>(
    res,
    'Falha ao carregar snapshot do dossiê arquivado.'
  );
  return data.dossier;
}

export async function saveDossier(
  contractId: string,
  analystNote: string
): Promise<{ dossier: SavedDossierSummary; dossiers: SavedDossierSummary[] }> {
  const res = await fetch('/api/dossiers', {
    method: 'POST',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ contractId, analystNote }),
  });
  return readJson(res, 'Falha ao salvar dossiê.');
}

export async function deleteSavedDossier(id: string): Promise<SavedDossierSummary[]> {
  const res = await fetch(`/api/dossiers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: buildAuthHeaders(),
  });
  const data = await readJson<{ dossiers: SavedDossierSummary[] }>(
    res,
    'Falha ao remover dossiê.'
  );
  return data.dossiers;
}

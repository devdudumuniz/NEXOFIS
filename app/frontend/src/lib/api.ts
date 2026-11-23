import type {
  EvaluatedContract,
  FindingReviewRecord,
  GovernmentEntity,
  Municipality,
  SavedDossierSnapshot,
  SavedDossierSummary,
} from '@nexofis/shared/types/audit';
import type { ExtractedDocumentFields } from '@nexofis/shared/lib/documentParser';
import type { RiskDashboardSummary } from '@nexofis/shared/lib/dashboardAggregator';
import type { ParsedContractCode } from '@nexofis/shared/lib/pncpQueryParser';
import type {
  CadastralMinimizedExtract,
  InvestigationCasePayload,
  InvestigationExportPackage,
  InvestigationFactSet,
  InvestigationReviewAction,
  InvestigationReviewRecord,
  ObservedHistorySnapshot,
  PrivateEvidenceRecord,
} from '@nexofis/shared/types/investigation';
import type {
  PartnerNetworkPayload,
  PartnerNetworkQueryMode,
  PartnerNetworkSuggestionsPayload,
} from '@nexofis/shared/lib/partnerNetworkGraph';
import type { EditalChannelAuditResult } from '@nexofis/shared/lib/participationChannelEvaluator';

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
    totalMunicipalityContracts?: number;
    selectedSecretaria?: string | null;
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
  editalChannelAudit?: EditalChannelAuditResult;
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
  options?: { startDate?: string; endDate?: string; secretaria?: string }
): Promise<MunicipalityContextResponse> {
  const qs = new URLSearchParams();
  if (options?.startDate) qs.set('startDate', options.startDate);
  if (options?.endDate) qs.set('endDate', options.endDate);
  if (options?.secretaria && options.secretaria !== 'ALL') {
    qs.set('secretaria', options.secretaria);
  }
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

// ==========================================
// FORENSIC INVESTIGATION MODULE API (STRICT AUTH)
// ==========================================

export class InvestigationConflictApiError extends Error {
  readonly expectedVersion: number;
  readonly currentVersion: number;

  constructor(message: string, expectedVersion: number, currentVersion: number) {
    super(message);
    this.name = 'InvestigationConflictApiError';
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
}

export async function fetchInvestigationCase(contractId: string): Promise<InvestigationCasePayload> {
  const res = await fetch(`/api/contracts/${encodeURIComponent(contractId)}/investigation`, {
    headers: buildAuthHeaders(),
  });
  return readJson<InvestigationCasePayload>(
    res,
    'Falha ao carregar o caso de investigação forense.'
  );
}

export async function runInvestigationCadastralQuery(
  contractId: string,
  payload: { purpose: string; legalBasis: string; justification: string }
): Promise<{ extract: CadastralMinimizedExtract; investigation: InvestigationCasePayload }> {
  const res = await fetch(
    `/api/contracts/${encodeURIComponent(contractId)}/investigation/cadastral-query`,
    {
      method: 'POST',
      headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    }
  );
  return readJson(res, 'Falha ao consultar dados cadastrais/QSA.');
}

export async function syncInvestigationPncpHistory(
  contractId: string
): Promise<{ observedHistory: ObservedHistorySnapshot; investigation: InvestigationCasePayload }> {
  const res = await fetch(
    `/api/contracts/${encodeURIComponent(contractId)}/investigation/pncp-history`,
    {
      method: 'POST',
      headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    }
  );
  return readJson(res, 'Falha ao sincronizar histórico contratual observado.');
}

export async function uploadPrivateEvidence(
  contractId: string,
  input: {
    file: File;
    sourceLabel: string;
    description: string;
    acquiredAt?: string;
  }
): Promise<{ evidence: PrivateEvidenceRecord; investigation: InvestigationCasePayload }> {
  const form = new FormData();
  form.append('file', input.file);
  form.append('sourceLabel', input.sourceLabel);
  form.append('description', input.description);
  if (input.acquiredAt) {
    form.append('acquiredAt', input.acquiredAt);
  }
  const res = await fetch(
    `/api/contracts/${encodeURIComponent(contractId)}/investigation/evidence`,
    {
      method: 'POST',
      headers: buildAuthHeaders(),
      body: form,
    }
  );
  return readJson(res, 'Falha ao anexar evidência privada.');
}

export async function downloadPrivateEvidenceFile(
  contractId: string,
  evidenceId: string,
  fallbackFilename: string
): Promise<void> {
  const res = await fetch(
    `/api/contracts/${encodeURIComponent(contractId)}/investigation/evidence/${encodeURIComponent(evidenceId)}/download`,
    {
      headers: buildAuthHeaders(),
    }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    let msg = `Falha ao baixar evidência privada (HTTP ${res.status}).`;
    try {
      const parsed = JSON.parse(errText) as { error?: string };
      if (parsed.error) msg = parsed.error;
    } catch {
      // keep fallback
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fallbackFilename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function updateInvestigationFacts(
  contractId: string,
  expectedVersion: number,
  facts: Omit<InvestigationFactSet, 'version' | 'updatedAt' | 'updatedBy'>
): Promise<InvestigationCasePayload> {
  const res = await fetch(`/api/contracts/${encodeURIComponent(contractId)}/investigation/facts`, {
    method: 'PUT',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expectedVersion, facts }),
  });

  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      expectedVersion?: number;
      currentVersion?: number;
    };
    throw new InvestigationConflictApiError(
      body.error ?? 'Conflito de versão nos fatos da investigação.',
      body.expectedVersion ?? expectedVersion,
      body.currentVersion ?? expectedVersion
    );
  }

  return readJson<InvestigationCasePayload>(res, 'Falha ao salvar fatos da investigação.');
}

export async function submitInvestigationReview(
  contractId: string,
  payload: {
    findingId: string;
    action: InvestigationReviewAction;
    rationale: string;
    expectedFindingInputsDigest?: string;
    expectedFactsVersion?: number;
  }
): Promise<{ review: InvestigationReviewRecord; investigation: InvestigationCasePayload }> {
  const res = await fetch(`/api/contracts/${encodeURIComponent(contractId)}/investigation/reviews`, {
    method: 'POST',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  return readJson(res, 'Falha ao registrar revisão humana do apontamento.');
}

export async function exportInvestigationPackage(
  contractId: string
): Promise<InvestigationExportPackage> {
  const res = await fetch(`/api/contracts/${encodeURIComponent(contractId)}/investigation/export`, {
    headers: buildAuthHeaders(),
  });
  return readJson<InvestigationExportPackage>(
    res,
    'Falha ao exportar pacote verificável de investigação.'
  );
}

// ==========================================
// PARTNER & CORPORATE RELATIONSHIP NETWORK API
// ==========================================

export async function fetchPartnerNetwork(
  query: string,
  mode: PartnerNetworkQueryMode = 'auto',
  signal?: AbortSignal
): Promise<PartnerNetworkPayload> {
  const qs = new URLSearchParams();
  qs.set('q', query.trim());
  qs.set('mode', mode);
  const res = await fetch(`/api/network/partners?${qs.toString()}`, {
    headers: buildAuthHeaders(),
    signal,
  });
  return readJson<PartnerNetworkPayload>(
    res,
    'Falha ao mapear vínculos societários e contratos.'
  );
}

export async function syncPartnerNetwork(
  payload: {
    query: string;
    mode: PartnerNetworkQueryMode;
    syncPncp?: boolean;
    syncSecondaryCompanies?: boolean;
    maxDepth?: number;
    maxCompanies?: number;
    maxRequests?: number;
    maxDurationMs?: number;
    page?: number;
    pageSize?: number;
  },
  signal?: AbortSignal
): Promise<PartnerNetworkPayload> {
  const res = await fetch('/api/network/partners/sync', {
    method: 'POST',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      query: payload.query.trim(),
      mode: payload.mode,
      syncPncp: payload.syncPncp ?? true,
      syncSecondaryCompanies: payload.syncSecondaryCompanies ?? true,
      ...(payload.maxDepth !== undefined ? { maxDepth: payload.maxDepth } : {}),
      ...(payload.maxCompanies !== undefined ? { maxCompanies: payload.maxCompanies } : {}),
      ...(payload.maxRequests !== undefined ? { maxRequests: payload.maxRequests } : {}),
      ...(payload.maxDurationMs !== undefined ? { maxDurationMs: payload.maxDurationMs } : {}),
      ...(payload.page !== undefined ? { page: payload.page } : {}),
      ...(payload.pageSize !== undefined ? { pageSize: payload.pageSize } : {}),
    }),
    signal,
  });
  return readJson<PartnerNetworkPayload>(
    res,
    'Falha ao sincronizar QSA e contratos da rede societária.'
  );
}

export async function fetchPartnerNetworkSuggestions(
  signal?: AbortSignal
): Promise<PartnerNetworkSuggestionsPayload> {
  const res = await fetch('/api/network/partners/suggestions', {
    headers: buildAuthHeaders(),
    signal,
  });
  return readJson<PartnerNetworkSuggestionsPayload>(
    res,
    'Falha ao consultar cobertura do índice societário (QSA).'
  );
}

export async function enrichPartnerNetworkIndex(limit = 10): Promise<{
  attempted: number;
  enriched: number;
  failed: number;
  enrichedCnpjs: string[];
  suggestions: PartnerNetworkSuggestionsPayload;
}> {
  const res = await fetch('/api/network/partners/enrich-index', {
    method: 'POST',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ limit }),
  });
  return readJson(res, 'Falha ao indexar quadros societários (BrasilAPI).');
}

export interface ForensicCypherProjectionResponse {
  storageArchitectureNote: string;
  counts: {
    people: number;
    companies: number;
    agencies: number;
    offices: number;
    contracts: number;
  };
  constraints: string;
  queries: {
    kinshipOfficeContractOverlap: string;
    hiddenMultiHopCorporateNetwork: string;
  };
  cypherScript: string;
  inProcessResults: {
    kinshipOfficeContractOverlap: unknown[];
    hiddenMultiHopCorporateNetwork: unknown[];
  };
}

export async function fetchForensicCypherProjection(
  payload: { targetCnpj?: string; onlyDocumented?: boolean } = {}
): Promise<ForensicCypherProjectionResponse> {
  const res = await fetch('/api/investigative/graph/cypher', {
    method: 'POST',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  return readJson<ForensicCypherProjectionResponse>(
    res,
    'Falha ao gerar projeção Cypher (Neo4j) do grafo forense.'
  );
}



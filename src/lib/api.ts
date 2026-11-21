import type {
  EvaluatedContract,
  GovernmentEntity,
  Municipality,
  SavedDossierSummary,
} from '../types/audit';
import type { ExtractedDocumentFields } from './documentParser';
import type { ParsedContractCode } from './pncpQueryParser';

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

export interface DocumentUploadResponse {
  sha256: string;
  matchedPncp: boolean;
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

export async function fetchMunicipalityContext(
  ibgeCode: string
): Promise<MunicipalityContextResponse> {
  const res = await fetch(`/api/municipalities/${encodeURIComponent(ibgeCode)}/context`);
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
}> {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.ibge) qs.set('ibge', params.ibge);
  if (params.year) qs.set('year', params.year);
  if (params.minRisk) qs.set('minRisk', String(params.minRisk));
  const res = await fetch(`/api/contracts/search?${qs.toString()}`);
  if (!res.ok) throw new Error('Falha ao buscar contratos.');
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
  if (!res.ok) throw new Error('Falha ao consultar CNPJ na Receita Federal.');
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

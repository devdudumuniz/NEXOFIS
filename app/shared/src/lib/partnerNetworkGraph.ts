import type { ContractRecord, EvaluatedContract, RiskAssessment } from '../types/audit';
import { formatCnpjValue, isCnpjFormat, isValidCnpj, normalizeCnpj } from './cnpj';

export type PartnerNetworkQueryMode = 'auto' | 'company' | 'partner';
export type PartnerMatchConfidence =
  | 'candidate_masked_cpf_match'
  | 'candidate_nominal_match'
  | 'single_company';
export type PartnerNetworkNodeType = 'partner' | 'company' | 'contract' | 'organ';
export type PartnerNetworkEdgeRelation = 'SOCIO_DE' | 'CONTRATO_EMPRESA' | 'CONTRATADO_POR';
export type PartnerContractTenureOverlap =
  | 'during_observed_tenure'
  | 'before_entry_date'
  | 'unknown_period';

export interface SupplierQsaShareholder {
  name: string;
  role: string;
  entryDate: string;
  maskedDocument?: string;
  ageRange?: string;
}

export interface SupplierQsaRecord {
  cnpj: string;
  legalName: string;
  registrationStatus: string;
  openingDate: string;
  primaryCnaeCode: string;
  primaryCnaeDescription: string;
  municipality: string;
  uf: string;
  shareCapital: number;
  shareholders: SupplierQsaShareholder[];
  sourceProvider: string;
  fetchedAt: string;
}

export interface PartnerNetworkNode {
  id: string;
  type: PartnerNetworkNodeType;
  label: string;
  subtitle: string;
  x: number;
  y: number;
  isSeed: boolean;
  cnpj?: string;
  contractId?: string;
  riskScore?: number;
  value?: number;
  confidence?: PartnerMatchConfidence;
  companyCount?: number;
  contractCount?: number;
  isSharedOrgan?: boolean;
  metadata: Record<string, string | number | boolean | null | undefined>;
}

export interface PartnerNetworkEdge {
  id: string;
  source: string;
  target: string;
  relation: PartnerNetworkEdgeRelation;
  label: string;
  confidence?: PartnerMatchConfidence;
  dashed?: boolean;
}

export interface PartnerNetworkCompanySummary {
  cnpj: string;
  formattedCnpj: string;
  legalName: string;
  registrationStatus: string;
  openingDate: string;
  municipality: string;
  uf: string;
  primaryCnaeCode: string;
  primaryCnaeDescription: string;
  shareCapital: number;
  isSeed: boolean;
  viaPartners: string[];
  partnerCount: number;
  contractCount: number;
  totalContractValue: number;
  maxRiskScore: number | null;
  distinctOrgans: string[];
  qsaSource: 'qsa_cache' | 'contract_record' | 'none';
}

export interface PartnerNetworkPartnerSummary {
  id: string;
  displayName: string;
  normalizedName: string;
  maskedDocument: string | null;
  confidence: PartnerMatchConfidence;
  identityVerified: boolean;
  identityQualificationNote: string;
  isSeed: boolean;
  roles: Array<{
    cnpj: string;
    companyName: string;
    role: string;
    entryDate: string;
    maskedDocument?: string;
  }>;
  companyCnpjs: string[];
  companyCount: number;
  contractCount: number;
  totalContractValue: number;
  contractsDuringTenureCount: number;
  contractsDuringTenureValue: number;
  contractsBeforeEntryCount: number;
  contractsUnknownPeriodCount: number;
  hasHomonymWarning: boolean;
}

export interface PartnerNetworkContractSummary {
  contractId: string;
  contractNumber: string;
  pncpControlNumber: string;
  companyCnpj: string;
  formattedCompanyCnpj: string;
  companyName: string;
  entityId: string;
  entityName: string;
  municipalityName: string;
  municipalityIbge: string;
  signatureDate: string;
  updatedValue: number;
  duplicateMirrorCount: number;
  hasValueDivergence: boolean;
  riskScore: number | null;
  riskLabel: string | null;
  coverageStatus: string | null;
  objectSummary: string;
}

export interface PartnerNetworkSharedOrganAlert {
  organKey: string;
  organKeyIsNominalFallback: boolean;
  organName: string;
  municipalityName: string;
  companyCnpjs: string[];
  companyNames: string[];
  sharedPartners: string[];
  unverifiedIdentityOnly: boolean;
  contractCount: number;
  totalValue: number;
}

export interface PartnerNetworkSourceCoverageItem {
  cnpj: string;
  qsaStatus: 'cached' | 'live_ok' | 'unavailable' | 'skipped';
  pncpStatus: 'complete' | 'partial' | 'rate_limited' | 'unavailable' | 'not_queried';
  pagesFetched: number;
  totalDeclared: number;
  errorDetail?: string;
}

export interface PartnerNetworkIndexCoverage {
  totalUniqueSuppliers: number;
  indexedQsaCount: number;
  totalPartnersIndexed: number;
  liveEnrichedCnpjs: string[];
  sourceCoverage?: PartnerNetworkSourceCoverageItem[];
}

export interface PartnerNetworkPayload {
  query: string;
  normalizedQuery: string;
  requestedMode: PartnerNetworkQueryMode;
  resolvedMode: 'company' | 'partner';
  seedLabel: string | null;
  seedType: 'company' | 'partner' | null;
  summary: {
    companyCount: number;
    partnerCount: number;
    multiCompanyPartnerCount: number;
    candidateMultiCompanyPartnerCount: number;
    contractCount: number;
    totalContractValue: number;
    distinctOrganCount: number;
    sharedOrganCount: number;
    unverifiedSharedOrganCount: number;
    homonymRiskPartnerCount: number;
    duplicateMirrorCount: number;
    valueDivergenceCount: number;
    totalMatchingCompanies: number;
    totalMatchingPartners: number;
    visualPartnersTruncated: boolean;
    visualCompaniesTruncated: boolean;
    visualContractsTruncated: boolean;
    visualOrgansTruncated: boolean;
  };
  nodes: PartnerNetworkNode[];
  edges: PartnerNetworkEdge[];
  layout: {
    width: number;
    height: number;
  };
  companies: PartnerNetworkCompanySummary[];
  partners: PartnerNetworkPartnerSummary[];
  contracts: PartnerNetworkContractSummary[];
  sharedOrgans: PartnerNetworkSharedOrganAlert[];
  evaluatedContracts?: EvaluatedContract[];
  indexCoverage?: PartnerNetworkIndexCoverage;
  methodologicalNotice: string;
}

export interface PartnerNetworkSuggestionItem {
  label: string;
  query: string;
  mode: 'company' | 'partner';
  detail: string;
  companyCount: number;
  contractCount: number;
  confidence?: PartnerMatchConfidence;
}

export interface PartnerNetworkSuggestionsPayload {
  totalUniqueSuppliers: number;
  indexedQsaCount: number;
  pendingQsaCount: number;
  totalPartnersIndexed: number;
  multiCompanyPartners: PartnerNetworkSuggestionItem[];
  topCompanies: PartnerNetworkSuggestionItem[];
}

export const PARTNER_NETWORK_METHODOLOGICAL_NOTICE =
  'A base pública de QSA da Receita Federal (via BrasilAPI) mascara os dígitos do CPF dos sócios (ex.: ***123456**). Nem coincidências nominais nem coincidências de CPF mascarado provam identidade única; toda ligação multiempresa é tratada como candidata e exige conferência documental (contrato social, junta comercial ou CPF completo em processo administrativo) antes de qualquer conclusão.';

export function normalizePersonName(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeMaskedDocument(raw: string | null | undefined): string {
  if (!raw) return '';
  const cleaned = raw.trim().toUpperCase().replace(/[^0-9A-Z*]/g, '');
  if (!cleaned) return '';
  // Ignore all-mask or all-zero placeholders like "******" or "00000000000"
  const nonMaskChars = cleaned.replace(/\*/g, '');
  if (!nonMaskChars || /^0+$/.test(nonMaskChars)) return '';
  // Redact unmasked 11-digit CPFs to masked middle digits (***456789**)
  if (/^\d{11}$/.test(cleaned)) {
    return `***${cleaned.slice(3, 9)}**`;
  }
  return cleaned;
}

function parseFiniteNonNegativeMoney(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function resolveContractMoney(contract: ContractRecord): number {
  const updated = parseFiniteNonNegativeMoney(contract.updatedValue);
  if (updated > 0) return updated;
  return parseFiniteNonNegativeMoney(contract.originalValue);
}

function parseIsoCalendarDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const [y, m, d] = trimmed.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return trimmed;
}

export function classifyContractTenureOverlap(
  entryDate: string | null | undefined,
  signatureDate: string | null | undefined
): PartnerContractTenureOverlap {
  const entry = parseIsoCalendarDate(entryDate);
  const sig = parseIsoCalendarDate(signatureDate);
  if (!entry || !sig) return 'unknown_period';
  return sig >= entry ? 'during_observed_tenure' : 'before_entry_date';
}

function resolveCanonicalOrganKey(input: {
  entityId?: string;
  entityName?: string;
  municipalityIbge?: string;
}): { organKey: string; isNominalFallback: boolean } {
  const rawId = (input.entityId ?? '').trim();
  const rawName = (input.entityName ?? '').trim();
  if (rawId && rawId !== rawName) {
    return { organKey: rawId.toUpperCase(), isNominalFallback: false };
  }
  const fallback = normalizePersonName(`${rawName} ${input.municipalityIbge ?? ''}`);
  return { organKey: fallback, isNominalFallback: true };
}

interface UnifiedContractSlot {
  dedupeKey: string;
  contract: ContractRecord;
  assessment?: RiskAssessment;
  duplicateMirrorCount: number;
  hasValueDivergence: boolean;
}

interface UnifiedCompanyEntry {
  cnpj: string;
  legalName: string;
  registrationStatus: string;
  openingDate: string;
  primaryCnaeCode: string;
  primaryCnaeDescription: string;
  municipality: string;
  uf: string;
  shareCapital: number;
  shareholders: SupplierQsaShareholder[];
  qsaSource: 'qsa_cache' | 'contract_record' | 'none';
  contracts: UnifiedContractSlot[];
  contractsByDedupeKey: Map<string, UnifiedContractSlot>;
}

interface PartnerCluster {
  id: string;
  displayName: string;
  normalizedName: string;
  maskedDocument: string | null;
  confidence: PartnerMatchConfidence;
  identityVerified: boolean;
  identityQualificationNote: string;
  roles: Array<{
    cnpj: string;
    companyName: string;
    role: string;
    entryDate: string;
    maskedDocument?: string;
  }>;
  companyCnpjs: string[];
  hasHomonymWarning: boolean;
}

function buildUnifiedIndex(
  contracts: Array<ContractRecord | EvaluatedContract>,
  qsaRecords: SupplierQsaRecord[]
): {
  companiesByCnpj: Map<string, UnifiedCompanyEntry>;
  partnerClusters: PartnerCluster[];
  partnersByCnpj: Map<string, PartnerCluster[]>;
} {
  const companiesByCnpj = new Map<string, UnifiedCompanyEntry>();

  // 1. Seed companies from cached QSA records first (richer cadastral + QSA data)
  for (const qsa of qsaRecords) {
    const cnpj = normalizeCnpj(qsa.cnpj);
    if (!isCnpjFormat(cnpj) || !isValidCnpj(cnpj)) continue;
    companiesByCnpj.set(cnpj, {
      cnpj,
      legalName: qsa.legalName || `CNPJ ${formatCnpjValue(cnpj)}`,
      registrationStatus: qsa.registrationStatus || 'DESCONHECIDA',
      openingDate: qsa.openingDate || '',
      primaryCnaeCode: qsa.primaryCnaeCode || '',
      primaryCnaeDescription: qsa.primaryCnaeDescription || '',
      municipality: qsa.municipality || '',
      uf: qsa.uf || '',
      shareCapital: Number(qsa.shareCapital || 0),
      shareholders: (qsa.shareholders ?? [])
        .filter((s) => normalizePersonName(s.name).length >= 2)
        .map((s) => ({
          name: s.name.trim(),
          role: s.role?.trim() || 'Sócio',
          entryDate: s.entryDate?.trim() || '',
          maskedDocument: normalizeMaskedDocument(s.maskedDocument) || undefined,
          ageRange: s.ageRange,
        })),
      qsaSource: 'qsa_cache',
      contracts: [],
      contractsByDedupeKey: new Map(),
    });
  }

  // 2. Merge all contracts & any shareholders stored directly on contract records
  for (const rawContract of contracts) {
    const cnpj = normalizeCnpj(rawContract.supplier?.cnpj ?? '');
    if (!isCnpjFormat(cnpj) || !isValidCnpj(cnpj)) continue;
    const assessment = 'assessment' in rawContract ? rawContract.assessment : undefined;

    let entry = companiesByCnpj.get(cnpj);
    if (!entry) {
      const contractShareholders = (rawContract.supplier.shareholders ?? [])
        .filter((s) => normalizePersonName(s.name).length >= 2)
        .map((s) => ({
          name: s.name.trim(),
          role: s.role?.trim() || 'Sócio',
          entryDate: s.entryDate?.trim() || '',
          maskedDocument: normalizeMaskedDocument(s.maskedCpfCnpj) || undefined,
        }));

      entry = {
        cnpj,
        legalName: rawContract.supplier.legalName || `CNPJ ${formatCnpjValue(cnpj)}`,
        registrationStatus: rawContract.supplier.registrationStatus || 'DESCONHECIDA',
        openingDate: rawContract.supplier.openingDate || '',
        primaryCnaeCode: rawContract.supplier.primaryCnaeCode || '',
        primaryCnaeDescription: rawContract.supplier.primaryCnaeDescription || '',
        municipality: rawContract.supplier.municipality || '',
        uf: rawContract.supplier.uf || '',
        shareCapital: parseFiniteNonNegativeMoney(rawContract.supplier.shareCapital),
        shareholders: contractShareholders,
        qsaSource: contractShareholders.length > 0 ? 'contract_record' : 'none',
        contracts: [],
        contractsByDedupeKey: new Map(),
      };
      companiesByCnpj.set(cnpj, entry);
    } else {
      if (!entry.legalName && rawContract.supplier.legalName) {
        entry.legalName = rawContract.supplier.legalName;
      }
      // Merge any shareholders from contract record not already present
      const existingNames = new Set(entry.shareholders.map((s) => normalizePersonName(s.name)));
      for (const s of rawContract.supplier.shareholders ?? []) {
        const norm = normalizePersonName(s.name);
        if (norm.length >= 2 && !existingNames.has(norm)) {
          entry.shareholders.push({
            name: s.name.trim(),
            role: s.role?.trim() || 'Sócio',
            entryDate: s.entryDate?.trim() || '',
            maskedDocument: normalizeMaskedDocument(s.maskedCpfCnpj) || undefined,
          });
          existingNames.add(norm);
          if (entry.qsaSource === 'none') {
            entry.qsaSource = 'contract_record';
          }
        }
      }
    }

    // M03: Canonical contract deduplication by pncpControlNumber (fallback to contract.id)
    const normPncp = (rawContract.pncpControlNumber ?? '').trim().toUpperCase();
    const dedupeKey = normPncp ? `pncp:${normPncp}` : `id:${rawContract.id}`;
    const existingSlot = entry.contractsByDedupeKey.get(dedupeKey);
    if (!existingSlot) {
      const slot: UnifiedContractSlot = {
        dedupeKey,
        contract: rawContract,
        assessment,
        duplicateMirrorCount: 0,
        hasValueDivergence: false,
      };
      entry.contractsByDedupeKey.set(dedupeKey, slot);
      entry.contracts.push(slot);
    } else if (existingSlot.contract.id !== rawContract.id) {
      existingSlot.duplicateMirrorCount += 1;
      const existingVal = resolveContractMoney(existingSlot.contract);
      const incomingVal = resolveContractMoney(rawContract);
      if (existingVal > 0 && incomingVal > 0 && Math.abs(existingVal - incomingVal) > 0.01) {
        existingSlot.hasValueDivergence = true;
      }
      // Prefer the richer signed mirror when replacing
      const existingRich = Boolean(existingSlot.contract.signatureDate) ? 1 : 0;
      const incomingRich = Boolean(rawContract.signatureDate) ? 1 : 0;
      if (incomingRich > existingRich || (incomingVal > 0 && existingVal === 0)) {
        existingSlot.contract = rawContract;
        existingSlot.assessment = assessment;
      }
    }
  }

  // 3. Build identity-safe Partner Clusters (strict homonym safeguard)
  interface RawMention {
    cnpj: string;
    companyName: string;
    displayName: string;
    normalizedName: string;
    role: string;
    entryDate: string;
    maskedDocument: string;
  }

  const mentionsByName = new Map<string, RawMention[]>();
  for (const company of companiesByCnpj.values()) {
    // Deduplicate same partner listed twice in the exact same company
    const seenInCompany = new Set<string>();
    for (const sh of company.shareholders) {
      const normName = normalizePersonName(sh.name);
      if (normName.length < 2) continue;
      const doc = normalizeMaskedDocument(sh.maskedDocument);
      const dedupeKey = `${normName}::${doc}`;
      if (seenInCompany.has(dedupeKey)) continue;
      seenInCompany.add(dedupeKey);

      const list = mentionsByName.get(normName) ?? [];
      list.push({
        cnpj: company.cnpj,
        companyName: company.legalName,
        displayName: sh.name.trim(),
        normalizedName: normName,
        role: sh.role || 'Sócio',
        entryDate: sh.entryDate || '',
        maskedDocument: doc,
      });
      mentionsByName.set(normName, list);
    }
  }

  const partnerClusters: PartnerCluster[] = [];
  const partnersByCnpj = new Map<string, PartnerCluster[]>();

  const registerCluster = (cluster: PartnerCluster) => {
    partnerClusters.push(cluster);
    for (const cnpj of cluster.companyCnpjs) {
      const list = partnersByCnpj.get(cnpj) ?? [];
      list.push(cluster);
      partnersByCnpj.set(cnpj, list);
    }
  };

  const describeQualification = (
    confidence: PartnerMatchConfidence,
    maskedDocument: string | null
  ): string => {
    if (confidence === 'candidate_masked_cpf_match') {
      return `Vínculo candidato por nome + CPF mascarado (${maskedDocument ?? 'parcial'}). CPF mascarado não comprova identidade única — confirmar por documento oficial.`;
    }
    if (confidence === 'candidate_nominal_match') {
      return 'Vínculo candidato por coincidência nominal sem CPF mascarado completo. Alto risco de homonímia — conferir contrato social antes de concluir.';
    }
    return 'Sócio observado em empresa única no índice local (identidade pública QSA não verificada por CPF integral).';
  };

  for (const [normName, mentions] of mentionsByName.entries()) {
    const distinctDocs = Array.from(
      new Set(mentions.map((m) => m.maskedDocument).filter((d) => d.length > 0))
    ).sort();

    if (distinctDocs.length <= 1) {
      // Zero or one distinct masked document across all companies for this name
      const doc = distinctDocs[0] ?? null;
      const companyCnpjs = Array.from(new Set(mentions.map((m) => m.cnpj))).sort();
      const allHaveDoc = doc !== null && mentions.every((m) => m.maskedDocument === doc);
      let confidence: PartnerMatchConfidence = 'single_company';
      if (companyCnpjs.length >= 2) {
        confidence = allHaveDoc ? 'candidate_masked_cpf_match' : 'candidate_nominal_match';
      }

      registerCluster({
        id: `partner:${normName}${doc ? `:${doc}` : ''}`,
        displayName: mentions[0].displayName,
        normalizedName: normName,
        maskedDocument: doc,
        confidence,
        identityVerified: false,
        identityQualificationNote: describeQualification(confidence, doc),
        roles: mentions.map((m) => ({
          cnpj: m.cnpj,
          companyName: m.companyName,
          role: m.role,
          entryDate: m.entryDate,
          maskedDocument: m.maskedDocument || undefined,
        })),
        companyCnpjs,
        hasHomonymWarning: companyCnpjs.length >= 2,
      });
    } else {
      // Conflicting masked CPFs exist for the same name -> MUST NOT merge different people!
      for (const doc of distinctDocs) {
        const sub = mentions.filter((m) => m.maskedDocument === doc);
        const companyCnpjs = Array.from(new Set(sub.map((m) => m.cnpj))).sort();
        const confidence: PartnerMatchConfidence =
          companyCnpjs.length >= 2 ? 'candidate_masked_cpf_match' : 'single_company';

        registerCluster({
          id: `partner:${normName}:${doc}`,
          displayName: sub[0].displayName,
          normalizedName: normName,
          maskedDocument: doc,
          confidence,
          identityVerified: false,
          identityQualificationNote: describeQualification(confidence, doc),
          roles: sub.map((m) => ({
            cnpj: m.cnpj,
            companyName: m.companyName,
            role: m.role,
            entryDate: m.entryDate,
            maskedDocument: m.maskedDocument,
          })),
          companyCnpjs,
          hasHomonymWarning: companyCnpjs.length >= 2,
        });
      }

      // Any mentions WITHOUT a masked document cannot safely merge into either conflicting CPF cluster
      const undocumented = mentions.filter((m) => !m.maskedDocument);
      if (undocumented.length > 0) {
        const companyCnpjs = Array.from(new Set(undocumented.map((m) => m.cnpj))).sort();
        const confidence: PartnerMatchConfidence =
          companyCnpjs.length >= 2 ? 'candidate_nominal_match' : 'single_company';
        registerCluster({
          id: `partner:${normName}:UNVERIFIED`,
          displayName: undocumented[0].displayName,
          normalizedName: normName,
          maskedDocument: null,
          confidence,
          identityVerified: false,
          identityQualificationNote: describeQualification(confidence, null),
          roles: undocumented.map((m) => ({
            cnpj: m.cnpj,
            companyName: m.companyName,
            role: m.role,
            entryDate: m.entryDate,
          })),
          companyCnpjs,
          hasHomonymWarning: true,
        });
      }
    }
  }

  return { companiesByCnpj, partnerClusters, partnersByCnpj };
}

function matchesAllTokens(haystack: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  return tokens.every((tok) => haystack.includes(tok));
}

function truncateLabel(text: string, maxLen: number): string {
  const clean = text.trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1).trimEnd()}…`;
}

export function buildPartnerNetworkGraph(params: {
  query: string;
  mode?: PartnerNetworkQueryMode;
  contracts: Array<ContractRecord | EvaluatedContract>;
  qsaRecords: SupplierQsaRecord[];
  maxVisualPartners?: number;
  maxVisualCompanies?: number;
  maxVisualContracts?: number;
}): PartnerNetworkPayload {
  const rawQuery = (params.query ?? '').trim();
  const requestedMode: PartnerNetworkQueryMode = params.mode ?? 'auto';
  const maxVisualPartners = params.maxVisualPartners ?? 8;
  const maxVisualCompanies = params.maxVisualCompanies ?? 8;
  const maxVisualContracts = params.maxVisualContracts ?? 8;
  const normalizedCnpjQuery = normalizeCnpj(rawQuery);
  const isCnpjQuery = isCnpjFormat(normalizedCnpjQuery);
  const normalizedTextQuery = normalizePersonName(rawQuery);
  const queryTokens = normalizedTextQuery.split(' ').filter((t) => t.length >= 2);

  const { companiesByCnpj, partnerClusters, partnersByCnpj } = buildUnifiedIndex(
    params.contracts,
    params.qsaRecords
  );

  // Match candidates in both dimensions
  const matchedCompanyEntries: UnifiedCompanyEntry[] = [];
  if (isCnpjQuery) {
    const exact = companiesByCnpj.get(normalizedCnpjQuery);
    if (exact) matchedCompanyEntries.push(exact);
  } else if (queryTokens.length > 0) {
    for (const company of companiesByCnpj.values()) {
      const hay = normalizePersonName(`${company.legalName} ${company.cnpj}`);
      if (matchesAllTokens(hay, queryTokens)) {
        matchedCompanyEntries.push(company);
      }
    }
  }

  const matchedPartnerClusters: PartnerCluster[] = [];
  if (!isCnpjQuery && queryTokens.length > 0) {
    for (const cluster of partnerClusters) {
      if (matchesAllTokens(cluster.normalizedName, queryTokens)) {
        matchedPartnerClusters.push(cluster);
      }
    }
  }

  // Decide resolved mode
  let resolvedMode: 'company' | 'partner' = 'company';
  if (requestedMode === 'company') {
    resolvedMode = 'company';
  } else if (requestedMode === 'partner') {
    resolvedMode = 'partner';
  } else {
    // Auto mode
    if (isCnpjQuery) {
      resolvedMode = 'company';
    } else if (matchedPartnerClusters.length > 0 && matchedCompanyEntries.length === 0) {
      resolvedMode = 'partner';
    } else if (matchedCompanyEntries.length > 0 && matchedPartnerClusters.length === 0) {
      resolvedMode = 'company';
    } else if (matchedPartnerClusters.length > 0 && matchedCompanyEntries.length > 0) {
      // Prefer exact partner match if partner name matches query exactly
      const exactPartner = matchedPartnerClusters.some(
        (p) => p.normalizedName === normalizedTextQuery
      );
      const exactCompany = matchedCompanyEntries.some(
        (c) => normalizePersonName(c.legalName) === normalizedTextQuery
      );
      if (exactPartner && !exactCompany) {
        resolvedMode = 'partner';
      } else if (exactCompany && !exactPartner) {
        resolvedMode = 'company';
      } else {
        // Default to partner if partner spans multiple companies and company does not
        const partnerSpansMultiple = matchedPartnerClusters.some((p) => p.companyCnpjs.length >= 2);
        resolvedMode = partnerSpansMultiple ? 'partner' : 'company';
      }
    }
  }

  const seedCompanyCnpjs = new Set<string>();
  const seedPartnerIds = new Set<string>();
  const includedCompanyCnpjs = new Set<string>();
  const includedPartnerIds = new Set<string>();
  const viaPartnersByCnpj = new Map<string, Set<string>>();

  if (resolvedMode === 'company') {
    // Limit seed companies to top 5 most relevant if a broad company name was searched
    const sortedSeedCompanies = [...matchedCompanyEntries].sort((a, b) => {
      const aExact = normalizePersonName(a.legalName) === normalizedTextQuery ? 1 : 0;
      const bExact = normalizePersonName(b.legalName) === normalizedTextQuery ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      return b.contracts.length - a.contracts.length;
    });

    for (const seed of sortedSeedCompanies.slice(0, 5)) {
      seedCompanyCnpjs.add(seed.cnpj);
      includedCompanyCnpjs.add(seed.cnpj);

      const seedPartners = partnersByCnpj.get(seed.cnpj) ?? [];
      for (const partner of seedPartners) {
        includedPartnerIds.add(partner.id);
        // Traverse 2nd hop: all other companies where this same partner participates
        for (const otherCnpj of partner.companyCnpjs) {
          includedCompanyCnpjs.add(otherCnpj);
          if (!seedCompanyCnpjs.has(otherCnpj)) {
            const via = viaPartnersByCnpj.get(otherCnpj) ?? new Set<string>();
            via.add(partner.displayName);
            viaPartnersByCnpj.set(otherCnpj, via);
          }
        }
      }
    }
  } else {
    // Partner mode: find all matched partner clusters -> all their companies -> all contracts
    const sortedSeedPartners = [...matchedPartnerClusters].sort((a, b) => {
      const aExact = a.normalizedName === normalizedTextQuery ? 1 : 0;
      const bExact = b.normalizedName === normalizedTextQuery ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      return b.companyCnpjs.length - a.companyCnpjs.length;
    });

    for (const partner of sortedSeedPartners.slice(0, 8)) {
      seedPartnerIds.add(partner.id);
      includedPartnerIds.add(partner.id);
      for (const cnpj of partner.companyCnpjs) {
        includedCompanyCnpjs.add(cnpj);
        const via = viaPartnersByCnpj.get(cnpj) ?? new Set<string>();
        via.add(partner.displayName);
        viaPartnersByCnpj.set(cnpj, via);
      }
    }

    // Also include co-partners that link >= 2 of the discovered companies together
    for (const cluster of partnerClusters) {
      if (includedPartnerIds.has(cluster.id)) continue;
      const overlapCount = cluster.companyCnpjs.filter((c) => includedCompanyCnpjs.has(c)).length;
      if (overlapCount >= 2) {
        includedPartnerIds.add(cluster.id);
      }
    }
  }

  const selectedCompanies = Array.from(includedCompanyCnpjs)
    .map((cnpj) => companiesByCnpj.get(cnpj))
    .filter((c): c is UnifiedCompanyEntry => Boolean(c));

  const selectedPartners = partnerClusters.filter((p) => includedPartnerIds.has(p.id));

  // Build contract summaries across every company in the network (deduplicated per M03)
  const allContractSummaries: PartnerNetworkContractSummary[] = [];
  const contractsByCompany = new Map<string, PartnerNetworkContractSummary[]>();
  let totalDuplicateMirrors = 0;
  let totalValueDivergences = 0;

  for (const company of selectedCompanies) {
    const companyList: PartnerNetworkContractSummary[] = [];
    for (const slot of company.contracts) {
      const { contract, assessment, duplicateMirrorCount, hasValueDivergence } = slot;
      const value = resolveContractMoney(contract);
      totalDuplicateMirrors += duplicateMirrorCount;
      if (hasValueDivergence) totalValueDivergences += 1;
      const summary: PartnerNetworkContractSummary = {
        contractId: contract.id,
        contractNumber: contract.contractNumber,
        pncpControlNumber: contract.pncpControlNumber,
        companyCnpj: company.cnpj,
        formattedCompanyCnpj: formatCnpjValue(company.cnpj),
        companyName: company.legalName,
        entityId: (contract.entityId ?? '').trim(),
        entityName: contract.entityName || 'Órgão não identificado',
        municipalityName: contract.municipalityName || '',
        municipalityIbge: contract.municipalityIbge || '',
        signatureDate: contract.signatureDate || contract.startDate || '',
        updatedValue: value,
        duplicateMirrorCount,
        hasValueDivergence,
        riskScore:
          assessment && assessment.coverageStatus !== 'INSUFFICIENT' ? assessment.score : null,
        riskLabel: assessment ? assessment.classification : null,
        coverageStatus: assessment?.coverageStatus ?? null,
        objectSummary: truncateLabel(contract.object || 'Objeto não informado', 140),
      };
      allContractSummaries.push(summary);
      companyList.push(summary);
    }
    contractsByCompany.set(company.cnpj, companyList);
  }

  allContractSummaries.sort((a, b) => {
    const riskDiff = (b.riskScore ?? -1) - (a.riskScore ?? -1);
    if (riskDiff !== 0) return riskDiff;
    return b.updatedValue - a.updatedValue;
  });

  // Build company summaries
  const companySummaries: PartnerNetworkCompanySummary[] = selectedCompanies
    .map((company) => {
      const cList = contractsByCompany.get(company.cnpj) ?? [];
      const totalContractValue = cList.reduce((acc, c) => acc + c.updatedValue, 0);
      const scores = cList.map((c) => c.riskScore).filter((s): s is number => s !== null);
      const distinctOrgans = Array.from(new Set(cList.map((c) => c.entityName).filter(Boolean)));
      return {
        cnpj: company.cnpj,
        formattedCnpj: formatCnpjValue(company.cnpj),
        legalName: company.legalName,
        registrationStatus: company.registrationStatus,
        openingDate: company.openingDate,
        municipality: company.municipality,
        uf: company.uf,
        primaryCnaeCode: company.primaryCnaeCode,
        primaryCnaeDescription: company.primaryCnaeDescription,
        shareCapital: company.shareCapital,
        isSeed: seedCompanyCnpjs.has(company.cnpj),
        viaPartners: Array.from(viaPartnersByCnpj.get(company.cnpj) ?? []),
        partnerCount: (partnersByCnpj.get(company.cnpj) ?? []).length,
        contractCount: cList.length,
        totalContractValue,
        maxRiskScore: scores.length > 0 ? Math.max(...scores) : null,
        distinctOrgans,
        qsaSource: company.qsaSource,
      };
    })
    .sort((a, b) => {
      if (a.isSeed !== b.isSeed) return a.isSeed ? -1 : 1;
      if (b.contractCount !== a.contractCount) return b.contractCount - a.contractCount;
      return b.totalContractValue - a.totalContractValue;
    });

  // Build partner summaries with M04 temporal tenure breakdown
  const partnerSummaries: PartnerNetworkPartnerSummary[] = selectedPartners
    .map((cluster) => {
      const relevantCnpjs = cluster.companyCnpjs.filter((c) => includedCompanyCnpjs.has(c));
      const relevantRoles = cluster.roles.filter((r) => includedCompanyCnpjs.has(r.cnpj));
      let contractCount = 0;
      let totalContractValue = 0;
      let contractsDuringTenureCount = 0;
      let contractsDuringTenureValue = 0;
      let contractsBeforeEntryCount = 0;
      let contractsUnknownPeriodCount = 0;

      for (const cnpj of relevantCnpjs) {
        const cList = contractsByCompany.get(cnpj) ?? [];
        const roleForCompany = relevantRoles.find((r) => r.cnpj === cnpj);
        const entryDate = roleForCompany?.entryDate ?? '';

        for (const ct of cList) {
          contractCount += 1;
          totalContractValue += ct.updatedValue;
          const overlap = classifyContractTenureOverlap(entryDate, ct.signatureDate);
          if (overlap === 'during_observed_tenure') {
            contractsDuringTenureCount += 1;
            contractsDuringTenureValue += ct.updatedValue;
          } else if (overlap === 'before_entry_date') {
            contractsBeforeEntryCount += 1;
          } else {
            contractsUnknownPeriodCount += 1;
          }
        }
      }

      return {
        id: cluster.id,
        displayName: cluster.displayName,
        normalizedName: cluster.normalizedName,
        maskedDocument: cluster.maskedDocument,
        confidence: cluster.confidence,
        identityVerified: cluster.identityVerified,
        identityQualificationNote: cluster.identityQualificationNote,
        isSeed: seedPartnerIds.has(cluster.id),
        roles: relevantRoles,
        companyCnpjs: relevantCnpjs,
        companyCount: relevantCnpjs.length,
        contractCount,
        totalContractValue,
        contractsDuringTenureCount,
        contractsDuringTenureValue,
        contractsBeforeEntryCount,
        contractsUnknownPeriodCount,
        hasHomonymWarning: cluster.hasHomonymWarning,
      };
    })
    .sort((a, b) => {
      if (a.isSeed !== b.isSeed) return a.isSeed ? -1 : 1;
      if (b.companyCount !== a.companyCount) return b.companyCount - a.companyCount;
      return b.totalContractValue - a.totalContractValue;
    });

  // Detect shared organs across >= 2 linked companies (M06: canonical entityId keying)
  const organBuckets = new Map<
    string,
    {
      organKey: string;
      organKeyIsNominalFallback: boolean;
      organName: string;
      municipalityName: string;
      companyCnpjs: Set<string>;
      companyNames: Map<string, string>;
      contractCount: number;
      totalValue: number;
    }
  >();

  for (const c of allContractSummaries) {
    const { organKey, isNominalFallback } = resolveCanonicalOrganKey(c);
    if (!organKey) continue;
    const bucket = organBuckets.get(organKey) ?? {
      organKey,
      organKeyIsNominalFallback: isNominalFallback,
      organName: c.entityName,
      municipalityName: c.municipalityName,
      companyCnpjs: new Set<string>(),
      companyNames: new Map<string, string>(),
      contractCount: 0,
      totalValue: 0,
    };
    bucket.companyCnpjs.add(c.companyCnpj);
    bucket.companyNames.set(c.companyCnpj, c.companyName);
    bucket.contractCount += 1;
    bucket.totalValue += c.updatedValue;
    organBuckets.set(organKey, bucket);
  }

  const sharedOrgans: PartnerNetworkSharedOrganAlert[] = [];
  for (const bucket of organBuckets.values()) {
    if (bucket.companyCnpjs.size >= 2) {
      const cnpjs = Array.from(bucket.companyCnpjs);
      const linkingPartners = partnerSummaries.filter(
        (p) => p.companyCnpjs.filter((c) => bucket.companyCnpjs.has(c)).length >= 2
      );
      const sharedPartnerNames = linkingPartners.map((p) => p.displayName);
      const unverifiedIdentityOnly =
        linkingPartners.length === 0 || linkingPartners.every((p) => !p.identityVerified);
      sharedOrgans.push({
        organKey: bucket.organKey,
        organKeyIsNominalFallback: bucket.organKeyIsNominalFallback,
        organName: bucket.organName,
        municipalityName: bucket.municipalityName,
        companyCnpjs: cnpjs,
        companyNames: cnpjs.map((cnpj) => bucket.companyNames.get(cnpj) ?? cnpj),
        sharedPartners: sharedPartnerNames,
        unverifiedIdentityOnly,
        contractCount: bucket.contractCount,
        totalValue: bucket.totalValue,
      });
    }
  }
  sharedOrgans.sort((a, b) => b.totalValue - a.totalValue);

  // =========================================================
  // DETERMINISTIC LAYERED SVG LAYOUT (ZERO OVERLAP & LEGIBLE SCALE)
  // Columns: Partners (x=150) -> Companies (x=465) -> Contracts (x=790) -> Organs (x=1100)
  // =========================================================
  const visualPartners = partnerSummaries.slice(0, maxVisualPartners);
  const visualPartnersTruncated = partnerSummaries.length > visualPartners.length;

  const visualCompanies = companySummaries.slice(0, maxVisualCompanies);
  const visualCompaniesTruncated = companySummaries.length > visualCompanies.length;
  const visualCompanySet = new Set(visualCompanies.map((c) => c.cnpj));

  const visualContracts = allContractSummaries
    .filter((c) => visualCompanySet.has(c.companyCnpj))
    .slice(0, maxVisualContracts);
  const visualContractsTruncated = allContractSummaries.length > visualContracts.length;

  const matchingOrganBuckets = Array.from(organBuckets.values())
    .filter((b) =>
      visualContracts.some((vc) => resolveCanonicalOrganKey(vc).organKey === b.organKey)
    )
    .sort((a, b) => {
      if (b.companyCnpjs.size !== a.companyCnpjs.size) {
        return b.companyCnpjs.size - a.companyCnpjs.size;
      }
      return b.totalValue - a.totalValue;
    });
  const visualOrganEntries = matchingOrganBuckets.slice(0, 8);
  const visualOrgansTruncated = organBuckets.size > visualOrganEntries.length;

  const maxRows = Math.max(
    visualPartners.length,
    visualCompanies.length,
    visualContracts.length,
    visualOrganEntries.length,
    1
  );
  const rowPitch = 74;
  const verticalPadding = 60;
  const layoutWidth = 1240;
  const layoutHeight = Math.max(460, maxRows * rowPitch + verticalPadding * 2);

  const computeColumnY = (index: number, count: number): number => {
    if (count <= 1) return Math.round(layoutHeight / 2);
    const span = (count - 1) * rowPitch;
    const startY = (layoutHeight - span) / 2;
    return Math.round(startY + index * rowPitch);
  };

  const nodes: PartnerNetworkNode[] = [];
  const edges: PartnerNetworkEdge[] = [];

  // Column 0: Partners
  visualPartners.forEach((p, idx) => {
    nodes.push({
      id: p.id,
      type: 'partner',
      label: truncateLabel(p.displayName, 26),
      subtitle:
        p.companyCount >= 2
          ? `${p.companyCount} empresas · ${
              p.confidence === 'candidate_masked_cpf_match'
                ? 'Candidato (CPF masc.)'
                : 'Candidato nominal'
            }`
          : `${p.roles[0]?.role ?? 'Sócio'}${p.maskedDocument ? ` · ${p.maskedDocument}` : ''}`,
      x: 150,
      y: computeColumnY(idx, visualPartners.length),
      isSeed: p.isSeed,
      confidence: p.confidence,
      companyCount: p.companyCount,
      contractCount: p.contractCount,
      value: p.totalContractValue,
      metadata: {
        fullName: p.displayName,
        maskedDocument: p.maskedDocument,
        identityVerified: p.identityVerified,
        hasHomonymWarning: p.hasHomonymWarning,
        confidence: p.confidence,
        companyCount: p.companyCount,
        contractCount: p.contractCount,
      },
    });
  });

  // Column 1: Companies
  visualCompanies.forEach((c, idx) => {
    nodes.push({
      id: `company:${c.cnpj}`,
      type: 'company',
      label: truncateLabel(c.legalName, 28),
      subtitle: `${c.formattedCnpj} · ${c.contractCount} contrato(s)`,
      x: 465,
      y: computeColumnY(idx, visualCompanies.length),
      isSeed: c.isSeed,
      cnpj: c.cnpj,
      contractCount: c.contractCount,
      value: c.totalContractValue,
      riskScore: c.maxRiskScore ?? undefined,
      metadata: {
        legalName: c.legalName,
        formattedCnpj: c.formattedCnpj,
        registrationStatus: c.registrationStatus,
        openingDate: c.openingDate,
        municipality: c.municipality,
        uf: c.uf,
        qsaSource: c.qsaSource,
        viaPartners: c.viaPartners.join(', '),
      },
    });
  });

  // Column 2: Contracts
  visualContracts.forEach((ct, idx) => {
    nodes.push({
      id: `contract:${ct.contractId}`,
      type: 'contract',
      label: truncateLabel(`Contrato ${ct.contractNumber}`, 26),
      subtitle: `${truncateLabel(ct.entityName, 24)}`,
      x: 790,
      y: computeColumnY(idx, visualContracts.length),
      isSeed: false,
      contractId: ct.contractId,
      cnpj: ct.companyCnpj,
      value: ct.updatedValue,
      riskScore: ct.riskScore ?? undefined,
      metadata: {
        contractNumber: ct.contractNumber,
        pncpControlNumber: ct.pncpControlNumber,
        companyName: ct.companyName,
        entityName: ct.entityName,
        municipalityName: ct.municipalityName,
        signatureDate: ct.signatureDate,
        objectSummary: ct.objectSummary,
        riskLabel: ct.riskLabel,
        hasValueDivergence: ct.hasValueDivergence,
      },
    });
  });

  // Column 3: Public Organs
  visualOrganEntries.forEach((org, idx) => {
    const isShared = org.companyCnpjs.size >= 2;
    nodes.push({
      id: `organ:${org.organKey}`,
      type: 'organ',
      label: truncateLabel(org.organName, 26),
      subtitle: isShared
        ? `${org.companyCnpjs.size} empresas da rede · ${org.contractCount} contrato(s)`
        : `${org.municipalityName || 'Órgão público'} · ${org.contractCount} contrato(s)`,
      x: 1100,
      y: computeColumnY(idx, visualOrganEntries.length),
      isSeed: false,
      companyCount: org.companyCnpjs.size,
      contractCount: org.contractCount,
      value: org.totalValue,
      isSharedOrgan: isShared,
      metadata: {
        organName: org.organName,
        municipalityName: org.municipalityName,
        companyCount: org.companyCnpjs.size,
        contractCount: org.contractCount,
        isSharedOrgan: isShared,
        organKeyIsNominalFallback: org.organKeyIsNominalFallback,
      },
    });
  });

  // Edges: Partner -> Company (only for visible partner/company nodes)
  const visualOrganIds = new Set(visualOrganEntries.map((o) => `organ:${o.organKey}`));
  for (const p of visualPartners) {
    for (const cnpj of p.companyCnpjs) {
      if (!visualCompanySet.has(cnpj)) continue;
      const roleEntry = p.roles.find((r) => r.cnpj === cnpj);
      edges.push({
        id: `edge:${p.id}->company:${cnpj}`,
        source: p.id,
        target: `company:${cnpj}`,
        relation: 'SOCIO_DE',
        label: roleEntry?.role || 'Sócio',
        confidence: p.confidence,
        dashed: p.confidence === 'candidate_nominal_match',
      });
    }
  }

  // Edges: Company -> Contract and Contract -> Organ
  const seenOrganEdges = new Set<string>();
  for (const ct of visualContracts) {
    edges.push({
      id: `edge:company:${ct.companyCnpj}->contract:${ct.contractId}`,
      source: `company:${ct.companyCnpj}`,
      target: `contract:${ct.contractId}`,
      relation: 'CONTRATO_EMPRESA',
      label: 'Fornecedor',
    });

    const { organKey } = resolveCanonicalOrganKey(ct);
    const organNodeId = `organ:${organKey}`;
    if (
      organKey &&
      visualOrganIds.has(organNodeId) &&
      !seenOrganEdges.has(`${ct.contractId}->${organNodeId}`)
    ) {
      seenOrganEdges.add(`${ct.contractId}->${organNodeId}`);
      edges.push({
        id: `edge:contract:${ct.contractId}->${organNodeId}`,
        source: `contract:${ct.contractId}`,
        target: organNodeId,
        relation: 'CONTRATADO_POR',
        label: 'Contratante',
      });
    }
  }

  // Seed label
  let seedLabel: string | null = null;
  let seedType: 'company' | 'partner' | null = null;
  if (resolvedMode === 'company' && companySummaries.some((c) => c.isSeed)) {
    const firstSeed = companySummaries.find((c) => c.isSeed)!;
    seedLabel = `${firstSeed.legalName} (${firstSeed.formattedCnpj})`;
    seedType = 'company';
  } else if (resolvedMode === 'partner' && partnerSummaries.some((p) => p.isSeed)) {
    const firstSeed = partnerSummaries.find((p) => p.isSeed)!;
    seedLabel = firstSeed.displayName;
    seedType = 'partner';
  }

  const totalContractValue = allContractSummaries.reduce((acc, c) => acc + c.updatedValue, 0);
  const candidateMultiCount = partnerSummaries.filter((p) => p.companyCount >= 2).length;

  return {
    query: rawQuery,
    normalizedQuery: isCnpjQuery ? normalizedCnpjQuery : normalizedTextQuery,
    requestedMode,
    resolvedMode,
    seedLabel,
    seedType,
    summary: {
      companyCount: companySummaries.length,
      partnerCount: partnerSummaries.length,
      multiCompanyPartnerCount: candidateMultiCount,
      candidateMultiCompanyPartnerCount: candidateMultiCount,
      contractCount: allContractSummaries.length,
      totalContractValue,
      distinctOrganCount: organBuckets.size,
      sharedOrganCount: sharedOrgans.length,
      unverifiedSharedOrganCount: sharedOrgans.filter((s) => s.unverifiedIdentityOnly).length,
      homonymRiskPartnerCount: partnerSummaries.filter((p) => p.hasHomonymWarning).length,
      duplicateMirrorCount: totalDuplicateMirrors,
      valueDivergenceCount: totalValueDivergences,
      totalMatchingCompanies: matchedCompanyEntries.length,
      totalMatchingPartners: matchedPartnerClusters.length,
      visualPartnersTruncated,
      visualCompaniesTruncated,
      visualContractsTruncated,
      visualOrgansTruncated,
    },
    nodes,
    edges,
    layout: {
      width: layoutWidth,
      height: layoutHeight,
    },
    companies: companySummaries,
    partners: partnerSummaries,
    contracts: allContractSummaries,
    sharedOrgans,
    methodologicalNotice: PARTNER_NETWORK_METHODOLOGICAL_NOTICE,
  };
}

export function buildPartnerNetworkSuggestions(params: {
  contracts: Array<ContractRecord | EvaluatedContract>;
  qsaRecords: SupplierQsaRecord[];
}): PartnerNetworkSuggestionsPayload {
  const { companiesByCnpj, partnerClusters } = buildUnifiedIndex(
    params.contracts,
    params.qsaRecords
  );

  const uniqueSupplierCnpjs = new Set<string>();
  for (const c of params.contracts) {
    const cnpj = normalizeCnpj(c.supplier?.cnpj ?? '');
    if (isCnpjFormat(cnpj) && isValidCnpj(cnpj)) uniqueSupplierCnpjs.add(cnpj);
  }
  const indexedQsaCnpjs = new Set<string>();
  for (const q of params.qsaRecords) {
    const cnpj = normalizeCnpj(q.cnpj);
    if (isCnpjFormat(cnpj) && isValidCnpj(cnpj)) indexedQsaCnpjs.add(cnpj);
  }
  let indexedFromStoredSuppliers = 0;
  for (const cnpj of uniqueSupplierCnpjs) {
    if (indexedQsaCnpjs.has(cnpj)) indexedFromStoredSuppliers += 1;
  }

  const multiCompanyPartners: PartnerNetworkSuggestionItem[] = partnerClusters
    .filter((p) => p.companyCnpjs.length >= 2)
    .map((p) => {
      const contractCount = p.companyCnpjs.reduce(
        (acc, cnpj) => acc + (companiesByCnpj.get(cnpj)?.contracts.length ?? 0),
        0
      );
      return {
        label: p.displayName,
        query: p.displayName,
        mode: 'partner' as const,
        detail: `${p.companyCnpjs.length} empresas · ${contractCount} contrato(s)${
          p.confidence === 'candidate_nominal_match'
            ? ' · candidato nominal (conferir homonímia)'
            : ' · candidato (CPF mascarado)'
        }`,
        companyCount: p.companyCnpjs.length,
        contractCount,
        confidence: p.confidence,
      };
    })
    .sort((a, b) => b.companyCount - a.companyCount || b.contractCount - a.contractCount)
    .slice(0, 8);

  const topCompanies: PartnerNetworkSuggestionItem[] = Array.from(companiesByCnpj.values())
    .filter((c) => c.contracts.length > 0 || c.shareholders.length > 0)
    .map((c) => ({
      label: c.legalName,
      query: c.cnpj,
      mode: 'company' as const,
      detail: `${formatCnpjValue(c.cnpj)} · ${c.shareholders.length} sócio(s) · ${c.contracts.length} contrato(s)`,
      companyCount: 1,
      contractCount: c.contracts.length,
    }))
    .sort((a, b) => {
      const aHasQsa = a.detail.includes('0 sócio(s)') ? 0 : 1;
      const bHasQsa = b.detail.includes('0 sócio(s)') ? 0 : 1;
      if (aHasQsa !== bHasQsa) return bHasQsa - aHasQsa;
      return b.contractCount - a.contractCount;
    })
    .slice(0, 8);

  return {
    totalUniqueSuppliers: uniqueSupplierCnpjs.size,
    indexedQsaCount: indexedQsaCnpjs.size,
    pendingQsaCount: Math.max(0, uniqueSupplierCnpjs.size - indexedFromStoredSuppliers),
    totalPartnersIndexed: partnerClusters.length,
    multiCompanyPartners,
    topCompanies,
  };
}

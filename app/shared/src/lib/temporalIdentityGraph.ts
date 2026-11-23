import type { ContractRecord } from '../types/audit';
import { isCnpjFormat, isValidCnpj, normalizeCnpj, resolveCorporatePartnerCnpj } from './cnpj';
import {
  normalizePersonName,
  type PartnerNetworkPayload,
  type SupplierQsaRecord,
} from './partnerNetworkGraph';

export type DatePrecision = 'day' | 'month' | 'year' | 'unknown';
export type EndDateSemantics =
  | 'confirmed_end'
  | 'unknown_end'
  | 'ongoing_undocumented';
export type AssertionState = 'documented' | 'candidate' | 'contested' | 'dismissed';
export type ResolutionMethod =
  | 'exact_cnpj'
  | 'documented_identity_proof'
  | 'candidate_masked_cpf_and_name'
  | 'candidate_nominal_only'
  | 'unresolved';

export interface SourceRecordRef {
  id: string;
  sourceSystem: string;
  externalId: string;
  snapshotDate: string;
  retrievedAt: string;
  sha256?: string;
  excerptRef?: string;
}

export interface PersonMention {
  mentionId: string;
  sourceRecordId: string;
  rawName: string;
  normalizedName: string;
  maskedDocument: string | null;
  roleOrQualification: string;
  companyCnpj?: string;
  observedAt: string;
  /** QSA qualification never implies educational level or resolved global identity */
  identityResolved: false;
}

export interface ResolvedEntity {
  entityId: string;
  entityType: 'company' | 'person' | 'public_organ';
  canonicalName: string;
  /** Only CNPJ or verified documentary ID is a global conclusive key; never name/address/partial CPF */
  conclusiveKey: string | null;
  identityStatus: 'resolved_documentary' | 'unresolved_candidate';
  resolutionMethod: ResolutionMethod;
  sourceRecordIds: string[];
}

export interface CandidateMatch {
  candidateId: string;
  query: string;
  displayName: string;
  normalizedName: string;
  maskedDocuments: string[];
  relatedCompanyCnpjs: string[];
  relatedCompanyNames: string[];
  matchConfidence: 'candidate_masked_cpf_and_name' | 'candidate_nominal_only';
  requiresDisambiguation: boolean;
  disambiguationReason: string;
  snapshotDates: string[];
}

export interface EvidenceLink {
  evidenceId: string;
  sourceRecordId: string;
  sourceSystem: string;
  externalId: string;
  excerptRef: string;
  observedAt: string;
  sha256?: string;
}

export interface AssertionReview {
  reviewId: string;
  assertionId: string;
  version: number;
  stateAfterReview: AssertionState;
  rationale: string;
  actorName: string;
  reviewedAt: string;
}

export interface TemporalBoundary {
  startDate: string | null;
  startPrecision: DatePrecision;
  endDate: string | null;
  endPrecision: DatePrecision;
  endSemantics: EndDateSemantics;
  /** True only when documentary historical records prove past tenure; current QSA is never back-projected */
  isProvenHistorical: boolean;
}

export interface RelationshipAssertion {
  assertionId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType:
    | 'SOCIO_PF_EMPRESA'
    | 'SOCIO_PJ_EMPRESA'
    | 'REPRESENTANTE_LEGAL'
    | 'CONTRATO_EMPRESA'
    | 'CONTRATADO_POR';
  sourceSystem: string;
  externalIds: string[];
  evidences: EvidenceLink[];
  temporal: TemporalBoundary;
  observedAt: string;
  state: AssertionState;
  resolutionMethod: ResolutionMethod;
  version: number;
  reviews: AssertionReview[];
  identityResolvedBothSides: boolean;
  notes: string[];
}

export interface ReverseParticipationEntry {
  normalizedName: string;
  displayName: string;
  maskedDocument: string | null;
  cnpj: string;
  companyName: string;
  role: string;
  entryDate: string | null;
  endSemantics: EndDateSemantics;
  sourceProvider: string;
  snapshotDate: string;
  isCorporatePartner: boolean;
  partnerCnpj?: string;
}

export interface ReverseParticipationIndex {
  builtAt: string;
  totalQsaSnapshots: number;
  earliestSnapshotDate: string | null;
  latestSnapshotDate: string | null;
  coverageDeclaration: string;
  entriesByNormalizedName: Map<string, ReverseParticipationEntry[]>;
  entriesByCorporateCnpj: Map<string, ReverseParticipationEntry[]>;
  allEntries: ReverseParticipationEntry[];
}

export interface DisambiguationResponse {
  query: string;
  normalizedQuery: string;
  requiresDisambiguation: boolean;
  candidateCount: number;
  candidates: CandidateMatch[];
  snapshotCoverage: {
    totalQsaSnapshots: number;
    earliestSnapshotDate: string | null;
    latestSnapshotDate: string | null;
    declaration: string;
  };
  guardrails: string[];
}

export interface IncrementalExpansionLimits {
  maxDepth: number;
  maxNodes: number;
  maxEdges: number;
  maxDurationMs: number;
  maxRequests: number;
  page: number;
  pageSize: number;
}

export interface IncrementalExpansionResult {
  seedQuery: string;
  nodes: ResolvedEntity[];
  assertions: RelationshipAssertion[];
  page: number;
  pageSize: number;
  totalNodesAvailable: number;
  totalAssertionsAvailable: number;
  hasMore: boolean;
  truncated: boolean;
  truncationReasons: string[];
  cancelled: boolean;
  cycleCountDetected: number;
  elapsedMs: number;
  limitsApplied: IncrementalExpansionLimits;
  financialAttribution: {
    /** Explicitly scoped as contracts of related companies — NEVER personal income or shareholder equity */
    contractsOfRelatedCompaniesTotal: number;
    label: string;
    legalConclusionAllowed: boolean;
    personalTotalAttributionBlocked: boolean;
    blockingReasons: string[];
  };
  snapshotCoverage: {
    totalQsaSnapshots: number;
    earliestSnapshotDate: string | null;
    latestSnapshotDate: string | null;
    declaration: string;
  };
}

export function inferDatePrecision(rawDate: string | null | undefined): DatePrecision {
  if (!rawDate) return 'unknown';
  const trimmed = rawDate.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return 'day';
  if (/^\d{4}-\d{2}$/.test(trimmed)) return 'month';
  if (/^\d{4}$/.test(trimmed)) return 'year';
  return 'unknown';
}

/**
 * Normalizes masked CPF values strictly without ever attempting to reconstruct missing digits.
 * Returns null if invalid or empty.
 */
export function preserveMaskedCpfWithoutReconstruction(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Never fabricate unmasked digits; keep only canonical masked pattern or null
  const compact = trimmed.replace(/\s+/g, '');
  if (compact.includes('*')) {
    return compact;
  }
  const digits = compact.replace(/\D/g, '');
  if (digits.length === 6) {
    return `***${digits}**`;
  }
  // If a full 11-digit CPF ever appears in a raw feed, mask it immediately for minimization
  if (digits.length === 11) {
    return `***${digits.slice(3, 9)}**`;
  }
  return null;
}

/**
 * Builds an in-memory reverse participation index across ingested QSA snapshots.
 * Declares explicit snapshot coverage and dates; never back-projects current QSA as historical fact.
 */
export function buildReverseParticipationIndex(
  qsaRecords: ReadonlyArray<SupplierQsaRecord>
): ReverseParticipationIndex {
  const entriesByNormalizedName = new Map<string, ReverseParticipationEntry[]>();
  const entriesByCorporateCnpj = new Map<string, ReverseParticipationEntry[]>();
  const allEntries: ReverseParticipationEntry[] = [];

  let earliest: string | null = null;
  let latest: string | null = null;

  for (const qsa of qsaRecords) {
    const cleanCnpj = normalizeCnpj(qsa.cnpj);
    if (!isCnpjFormat(cleanCnpj)) continue;
    const snapDate = (qsa.fetchedAt || '').slice(0, 10) || 'data-desconhecida';
    if (snapDate !== 'data-desconhecida') {
      if (!earliest || snapDate < earliest) earliest = snapDate;
      if (!latest || snapDate > latest) latest = snapDate;
    }

    for (const sh of qsa.shareholders ?? []) {
      const normalized = normalizePersonName(sh.name || '');
      if (!normalized) continue;
      const corpCnpj = resolveCorporatePartnerCnpj({
        partnerCnpj: sh.partnerCnpj,
        maskedDocument: sh.maskedDocument,
        partnerType: sh.partnerType,
      });
      const isCorporatePartner = Boolean(corpCnpj) || sh.partnerType === 'PJ';
      const entry: ReverseParticipationEntry = {
        normalizedName: normalized,
        displayName: sh.name.trim(),
        maskedDocument: isCorporatePartner
          ? corpCnpj ?? null
          : preserveMaskedCpfWithoutReconstruction(sh.maskedDocument),
        cnpj: cleanCnpj,
        companyName: qsa.legalName || `CNPJ ${cleanCnpj}`,
        role: sh.role || 'Sócio (qualificação QSA — não indica escolaridade)',
        entryDate: sh.entryDate && /^\d{4}-\d{2}-\d{2}/.test(sh.entryDate) ? sh.entryDate.slice(0, 10) : null,
        // Current QSA does not document an end date: distinguish ongoing/undocumented end from confirmed end
        endSemantics: 'ongoing_undocumented',
        sourceProvider: qsa.sourceProvider || 'QSA indexado',
        snapshotDate: snapDate,
        isCorporatePartner,
        partnerCnpj: corpCnpj ?? undefined,
      };
      allEntries.push(entry);

      const list = entriesByNormalizedName.get(normalized) ?? [];
      list.push(entry);
      entriesByNormalizedName.set(normalized, list);

      if (corpCnpj) {
        const corpList = entriesByCorporateCnpj.get(corpCnpj) ?? [];
        corpList.push(entry);
        entriesByCorporateCnpj.set(corpCnpj, corpList);
      }
    }
  }

  const coverageDeclaration =
    qsaRecords.length === 0
      ? 'Nenhum snapshot de QSA ingerido no índice reverso local.'
      : `Índice reverso construído estritamente sobre ${qsaRecords.length} snapshot(s) de QSA ingeridos (período de coleta: ${earliest ?? 'N/D'} a ${latest ?? 'N/D'}). Não representa histórico retroativo completo nem universo nacional da RFB.`;

  return {
    builtAt: new Date().toISOString(),
    totalQsaSnapshots: qsaRecords.length,
    earliestSnapshotDate: earliest,
    latestSnapshotDate: latest,
    coverageDeclaration,
    entriesByNormalizedName,
    entriesByCorporateCnpj,
    allEntries,
  };
}

/**
 * Queries the reverse participation index by person name, returning distinct candidates
 * and enforcing disambiguation whenever homonyms or differing masked CPFs appear.
 * Never merges individuals globally by name, surname, address, or partial CPF.
 */
export function disambiguatePersonQuery(
  query: string,
  index: ReverseParticipationIndex
): DisambiguationResponse {
  const normalizedQuery = normalizePersonName(query);
  const tokens = normalizedQuery.split(' ').filter((t) => t.length >= 2);
  const grouped = new Map<
    string,
    {
      displayName: string;
      normalizedName: string;
      maskedDoc: string | null;
      cnpjs: Set<string>;
      companyNames: Map<string, string>;
      snapshots: Set<string>;
    }
  >();

  if (tokens.length > 0) {
    for (const entry of index.allEntries) {
      if (entry.isCorporatePartner) continue;
      if (!tokens.every((t) => entry.normalizedName.includes(t))) continue;

      // Group strictly by (normalizedName + maskedDocument) so distinct masked CPFs or missing CPFs stay separated
      const bucketKey = `${entry.normalizedName}::${entry.maskedDocument ?? `unmasked@${entry.cnpj}`}`;
      const existing = grouped.get(bucketKey) ?? {
        displayName: entry.displayName,
        normalizedName: entry.normalizedName,
        maskedDoc: entry.maskedDocument,
        cnpjs: new Set<string>(),
        companyNames: new Map<string, string>(),
        snapshots: new Set<string>(),
      };
      existing.cnpjs.add(entry.cnpj);
      existing.companyNames.set(entry.cnpj, entry.companyName);
      existing.snapshots.add(entry.snapshotDate);
      grouped.set(bucketKey, existing);
    }
  }

  const candidates: CandidateMatch[] = Array.from(grouped.entries()).map(([key, g], idx) => {
    const hasMasked = Boolean(g.maskedDoc);
    return {
      candidateId: `cand_${idx + 1}_${key.replace(/[^a-z0-9]/gi, '_').slice(0, 32)}`,
      query,
      displayName: g.displayName,
      normalizedName: g.normalizedName,
      maskedDocuments: g.maskedDoc ? [g.maskedDoc] : [],
      relatedCompanyCnpjs: Array.from(g.cnpjs),
      relatedCompanyNames: Array.from(g.companyNames.values()),
      matchConfidence: hasMasked ? 'candidate_masked_cpf_and_name' : 'candidate_nominal_only',
      requiresDisambiguation: true,
      disambiguationReason: hasMasked
        ? 'Nome + CPF parcial mascarado não constituem chave global conclusiva (possibilidade de homônimos ou colisões parciais); requer confirmação documental.'
        : 'Correspondência apenas nominal sem CPF mascarado; vedada unificação automática entre empresas.',
      snapshotDates: Array.from(g.snapshots).sort(),
    };
  });

  // Sort by exact normalized match first, then number of companies
  candidates.sort((a, b) => {
    const aExact = a.normalizedName === normalizedQuery ? 1 : 0;
    const bExact = b.normalizedName === normalizedQuery ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    return b.relatedCompanyCnpjs.length - a.relatedCompanyCnpjs.length;
  });

  const distinctNames = new Set(candidates.map((c) => c.normalizedName));
  const distinctMaskedDocs = new Set(
    candidates.flatMap((c) => (c.maskedDocuments.length > 0 ? c.maskedDocuments : ['__none__']))
  );
  const requiresDisambiguation =
    candidates.length > 1 || distinctNames.size > 1 || distinctMaskedDocs.size > 1 || candidates.some((c) => c.matchConfidence === 'candidate_nominal_only');

  return {
    query,
    normalizedQuery,
    requiresDisambiguation,
    candidateCount: candidates.length,
    candidates,
    snapshotCoverage: {
      totalQsaSnapshots: index.totalQsaSnapshots,
      earliestSnapshotDate: index.earliestSnapshotDate,
      latestSnapshotDate: index.latestSnapshotDate,
      declaration: index.coverageDeclaration,
    },
    guardrails: [
      'Nome, sobrenome, endereço e CPF parcial mascarado nunca são usados como chave global conclusiva.',
      'CPFs mascarados nunca são reconstruídos.',
      'Qualificação societária no QSA (ex.: Sócio-Administrador) não é convertida em escolaridade.',
      'QSA atual não é retroprojetado como histórico societário comprovado.',
    ],
  };
}

/**
 * Evaluates whether a temporal relationship assertion overlaps a reference date,
 * explicitly differentiating confirmed end date, unknown end date, and ongoing undocumented end.
 */
export function assessTemporalAssertionOverlap(params: {
  temporal: TemporalBoundary;
  referenceDate: string | null | undefined;
}): {
  status:
    | 'within_documented_period'
    | 'before_start_date'
    | 'after_confirmed_end'
    | 'unknown_end_requires_verification'
    | 'ongoing_observed_not_retroprojected'
    | 'insufficient_dates';
  canSupportPeriodConclusion: boolean;
  explanation: string;
} {
  const ref = params.referenceDate?.slice(0, 10) ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ref)) {
    return {
      status: 'insufficient_dates',
      canSupportPeriodConclusion: false,
      explanation: 'Data de referência ausente ou sem precisão diária para confronto temporal.',
    };
  }

  const { startDate, endDate, endSemantics, isProvenHistorical } = params.temporal;
  if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate) && ref < startDate) {
    return {
      status: 'before_start_date',
      canSupportPeriodConclusion: true,
      explanation: `Data de referência (${ref}) é anterior ao início registrado do vínculo (${startDate}).`,
    };
  }

  if (endSemantics === 'confirmed_end' && endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    if (ref > endDate) {
      return {
        status: 'after_confirmed_end',
        canSupportPeriodConclusion: true,
        explanation: `Data de referência (${ref}) é posterior ao encerramento documentado do vínculo (${endDate}).`,
      };
    }
    return {
      status: 'within_documented_period',
      canSupportPeriodConclusion: true,
      explanation: `Data de referência (${ref}) ocorre dentro do intervalo documentado (${startDate ?? 'início N/D'} a ${endDate}).`,
    };
  }

  if (endSemantics === 'unknown_end') {
    return {
      status: 'unknown_end_requires_verification',
      canSupportPeriodConclusion: false,
      explanation: `Vínculo com data de término desconhecida (fim não documentado ≠ vínculo seguramente ativo na data ${ref}); exige conferência em certidão/histórico oficial.`,
    };
  }

  if (!isProvenHistorical && !startDate) {
    return {
      status: 'ongoing_observed_not_retroprojected',
      canSupportPeriodConclusion: false,
      explanation:
        'Vínculo observado em QSA atual sem data de entrada ou histórico documentado; não pode ser retroprojetado para períodos anteriores.',
    };
  }

  return {
    status: 'ongoing_observed_not_retroprojected',
    canSupportPeriodConclusion: isProvenHistorical,
    explanation: isProvenHistorical
      ? `Vínculo sem termo final documentado, com início comprovado em ${startDate} e histórico verificado.`
      : `Vínculo sem termo final documentado observado em snapshot atual (entrada declarada: ${startDate ?? 'N/D'}); não comprova permanência ininterrupta sem certidão simplificada/histórica.`,
  };
}

/**
 * Performs bounded, cycle-safe, cancellable, paginated incremental graph expansion
 * producing typed ResolvedEntity and RelationshipAssertion structures with strict guardrails.
 */
export function expandTemporalNetworkGraph(params: {
  seedCnpjOrName: string;
  qsaRecords: ReadonlyArray<SupplierQsaRecord>;
  contracts: ReadonlyArray<ContractRecord>;
  limits?: Partial<IncrementalExpansionLimits>;
  isCancelled?: () => boolean;
  contestedAssertionIds?: ReadonlySet<string>;
  documentedAssertionIds?: ReadonlySet<string>;
}): IncrementalExpansionResult {
  const startedAt = Date.now();
  const limits: IncrementalExpansionLimits = {
    maxDepth: Math.max(1, Math.min(params.limits?.maxDepth ?? 4, 6)),
    maxNodes: Math.max(5, Math.min(params.limits?.maxNodes ?? 40, 200)),
    maxEdges: Math.max(5, Math.min(params.limits?.maxEdges ?? 80, 400)),
    maxDurationMs: Math.max(50, Math.min(params.limits?.maxDurationMs ?? 8000, 25000)),
    maxRequests: Math.max(1, Math.min(params.limits?.maxRequests ?? 16, 64)),
    page: Math.max(1, Math.floor(params.limits?.page ?? 1)),
    pageSize: Math.max(1, Math.min(Math.floor(params.limits?.pageSize ?? 25), 100)),
  };

  const index = buildReverseParticipationIndex(params.qsaRecords);
  const qsaByCnpj = new Map<string, SupplierQsaRecord>();
  for (const qsa of params.qsaRecords) {
    const clean = normalizeCnpj(qsa.cnpj);
    if (isCnpjFormat(clean)) qsaByCnpj.set(clean, qsa);
  }

  const truncationReasons: string[] = [];
  let cancelled = false;
  let cycleCountDetected = 0;

  const nodesMap = new Map<string, ResolvedEntity>();
  const assertionsMap = new Map<string, RelationshipAssertion>();
  const visitedCompanies = new Set<string>();
  const queue: Array<{ cnpj: string; depth: number }> = [];

  const cleanSeedCnpj = normalizeCnpj(params.seedCnpjOrName);
  if (isCnpjFormat(cleanSeedCnpj) && isValidCnpj(cleanSeedCnpj)) {
    queue.push({ cnpj: cleanSeedCnpj, depth: 0 });
  } else {
    const disamb = disambiguatePersonQuery(params.seedCnpjOrName, index);
    for (const cand of disamb.candidates.slice(0, 5)) {
      for (const cnpj of cand.relatedCompanyCnpjs) {
        queue.push({ cnpj, depth: 0 });
      }
    }
  }

  const addNode = (entity: ResolvedEntity): boolean => {
    if (nodesMap.has(entity.entityId)) return true;
    if (nodesMap.size >= limits.maxNodes) {
      if (!truncationReasons.includes(`Limite de nós atingido (${limits.maxNodes}).`)) {
        truncationReasons.push(`Limite de nós atingido (${limits.maxNodes}).`);
      }
      return false;
    }
    nodesMap.set(entity.entityId, entity);
    return true;
  };

  const addAssertion = (assertion: RelationshipAssertion): boolean => {
    if (assertionsMap.has(assertion.assertionId)) return true;
    if (assertionsMap.size >= limits.maxEdges) {
      if (!truncationReasons.includes(`Limite de arestas atingido (${limits.maxEdges}).`)) {
        truncationReasons.push(`Limite de arestas atingido (${limits.maxEdges}).`);
      }
      return false;
    }
    assertionsMap.set(assertion.assertionId, assertion);
    return true;
  };

  while (queue.length > 0) {
    if (params.isCancelled?.()) {
      cancelled = true;
      truncationReasons.push('Expansão interrompida por solicitação de cancelamento.');
      break;
    }
    if (Date.now() - startedAt > limits.maxDurationMs) {
      truncationReasons.push(`Limite de tempo atingido (${limits.maxDurationMs} ms).`);
      break;
    }

    const current = queue.shift()!;
    if (visitedCompanies.has(current.cnpj)) {
      cycleCountDetected += 1;
      continue;
    }
    if (current.depth > limits.maxDepth) {
      if (!truncationReasons.includes(`Limite de profundidade atingido (${limits.maxDepth}).`)) {
        truncationReasons.push(`Limite de profundidade atingido (${limits.maxDepth}).`);
      }
      continue;
    }
    visitedCompanies.add(current.cnpj);

    const qsa = qsaByCnpj.get(current.cnpj);
    const companyEntityId = `company:${current.cnpj}`;
    const companyAdded = addNode({
      entityId: companyEntityId,
      entityType: 'company',
      canonicalName: qsa?.legalName || `CNPJ ${current.cnpj}`,
      conclusiveKey: current.cnpj,
      identityStatus: 'resolved_documentary',
      resolutionMethod: 'exact_cnpj',
      sourceRecordIds: qsa ? [`qsa:${current.cnpj}:${qsa.fetchedAt}`] : [],
    });
    if (!companyAdded) break;

    if (qsa) {
      for (const sh of qsa.shareholders ?? []) {
        const corpCnpj = resolveCorporatePartnerCnpj({
          partnerCnpj: sh.partnerCnpj,
          maskedDocument: sh.maskedDocument,
          partnerType: sh.partnerType,
        });

        if (corpCnpj) {
          const parentEntityId = `company:${corpCnpj}`;
          if (!addNode({
            entityId: parentEntityId,
            entityType: 'company',
            canonicalName: sh.name || `CNPJ ${corpCnpj}`,
            conclusiveKey: corpCnpj,
            identityStatus: 'resolved_documentary',
            resolutionMethod: 'exact_cnpj',
            sourceRecordIds: [`qsa:${current.cnpj}:${qsa.fetchedAt}`],
          })) {
            continue;
          }

          const assertionId = `rel:pj:${corpCnpj}->${current.cnpj}`;
          const state: AssertionState = params.contestedAssertionIds?.has(assertionId)
            ? 'contested'
            : 'documented';
          addAssertion({
            assertionId,
            sourceEntityId: parentEntityId,
            targetEntityId: companyEntityId,
            relationType: 'SOCIO_PJ_EMPRESA',
            sourceSystem: qsa.sourceProvider || 'BrasilAPI/RFB',
            externalIds: [corpCnpj, current.cnpj],
            evidences: [
              {
                evidenceId: `ev:${assertionId}`,
                sourceRecordId: `qsa:${current.cnpj}`,
                sourceSystem: qsa.sourceProvider || 'BrasilAPI/RFB',
                externalId: current.cnpj,
                excerptRef: `QSA ${current.cnpj} · sócio PJ ${sh.name} (${sh.role})`,
                observedAt: qsa.fetchedAt,
              },
            ],
            temporal: {
              startDate: sh.entryDate || null,
              startPrecision: inferDatePrecision(sh.entryDate),
              endDate: null,
              endPrecision: 'unknown',
              endSemantics: 'ongoing_undocumented',
              isProvenHistorical: false,
            },
            observedAt: qsa.fetchedAt,
            state,
            resolutionMethod: 'exact_cnpj',
            version: 1,
            reviews: [],
            identityResolvedBothSides: true,
            notes: [
              'Vínculo societário PJ identificado por CNPJ no QSA vigente; sem retroprojeção histórica automática.',
            ],
          });

          if (visitedCompanies.has(corpCnpj)) {
            cycleCountDetected += 1;
          } else if (current.depth + 1 <= limits.maxDepth) {
            queue.push({ cnpj: corpCnpj, depth: current.depth + 1 });
          } else if (!truncationReasons.includes(`Limite de profundidade atingido (${limits.maxDepth}).`)) {
            truncationReasons.push(`Limite de profundidade atingido (${limits.maxDepth}).`);
          }
        } else {
          const normName = normalizePersonName(sh.name || '');
          const maskedDoc = preserveMaskedCpfWithoutReconstruction(sh.maskedDocument);
          const personEntityId = `person:${normName}::${maskedDoc ?? current.cnpj}`;
          if (!addNode({
            entityId: personEntityId,
            entityType: 'person',
            canonicalName: sh.name.trim(),
            // Never use name or partial CPF as global conclusive key
            conclusiveKey: null,
            identityStatus: 'unresolved_candidate',
            resolutionMethod: maskedDoc ? 'candidate_masked_cpf_and_name' : 'candidate_nominal_only',
            sourceRecordIds: [`qsa:${current.cnpj}:${qsa.fetchedAt}`],
          })) {
            continue;
          }

          const assertionId = `rel:pf:${personEntityId}->${current.cnpj}`;
          const state: AssertionState = params.contestedAssertionIds?.has(assertionId)
            ? 'contested'
            : params.documentedAssertionIds?.has(assertionId)
              ? 'documented'
              : 'candidate';
          addAssertion({
            assertionId,
            sourceEntityId: personEntityId,
            targetEntityId: companyEntityId,
            relationType: 'SOCIO_PF_EMPRESA',
            sourceSystem: qsa.sourceProvider || 'BrasilAPI/RFB',
            externalIds: [current.cnpj],
            evidences: [
              {
                evidenceId: `ev:${assertionId}`,
                sourceRecordId: `qsa:${current.cnpj}`,
                sourceSystem: qsa.sourceProvider || 'BrasilAPI/RFB',
                externalId: current.cnpj,
                excerptRef: `QSA ${current.cnpj} · ${sh.name} (${sh.role}${maskedDoc ? `, ${maskedDoc}` : ''})`,
                observedAt: qsa.fetchedAt,
              },
            ],
            temporal: {
              startDate: sh.entryDate || null,
              startPrecision: inferDatePrecision(sh.entryDate),
              endDate: null,
              endPrecision: 'unknown',
              endSemantics: 'ongoing_undocumented',
              isProvenHistorical: false,
            },
            observedAt: qsa.fetchedAt,
            state,
            resolutionMethod: maskedDoc ? 'candidate_masked_cpf_and_name' : 'candidate_nominal_only',
            version: 1,
            reviews: [],
            identityResolvedBothSides: state === 'documented',
            notes: [
              'Identidade PF em QSA público é candidata (CPF mascarado/nome não é chave global conclusiva).',
              'Qualificação societária não equivale a escolaridade.',
            ],
          });

          // Reverse index hop for candidate shared companies (strictly bounded by depth)
          if (current.depth + 1 <= limits.maxDepth) {
            const peerEntries = index.entriesByNormalizedName.get(normName) ?? [];
            for (const peer of peerEntries) {
              if (peer.cnpj === current.cnpj) continue;
              // Require compatible masked CPF when both sides expose one; never merge conflicting masked CPFs
              if (maskedDoc && peer.maskedDocument && maskedDoc !== peer.maskedDocument) {
                continue;
              }
              if (!visitedCompanies.has(peer.cnpj)) {
                queue.push({ cnpj: peer.cnpj, depth: current.depth + 1 });
              }
            }
          }
        }
      }

      // Also check downward subsidiaries (companies where current.cnpj is a corporate shareholder)
      const subs = index.entriesByCorporateCnpj.get(current.cnpj) ?? [];
      for (const sub of subs) {
        if (visitedCompanies.has(sub.cnpj)) {
          cycleCountDetected += 1;
        } else if (current.depth + 1 <= limits.maxDepth) {
          queue.push({ cnpj: sub.cnpj, depth: current.depth + 1 });
        }
      }
    }
  }

  // Compute related company contract totals with explicit non-personal attribution guard
  const visitedCnpjs = visitedCompanies;
  let contractsOfRelatedCompaniesTotal = 0;
  for (const contract of params.contracts) {
    const supCnpj = normalizeCnpj(contract.supplier?.cnpj ?? '');
    if (supCnpj && visitedCnpjs.has(supCnpj)) {
      const val = Number(contract.updatedValue || contract.originalValue || 0);
      if (Number.isFinite(val) && val > 0) {
        contractsOfRelatedCompaniesTotal += val;
      }
    }
  }

  const allNodes = Array.from(nodesMap.values());
  const allAssertions = Array.from(assertionsMap.values());
  const hasUnresolvedIdentityPath = allAssertions.some((a) => !a.identityResolvedBothSides);

  const startIdx = (limits.page - 1) * limits.pageSize;
  const pagedNodes = allNodes.slice(startIdx, startIdx + limits.pageSize);
  const pagedNodeIds = new Set(pagedNodes.map((n) => n.entityId));
  const pagedAssertions = allAssertions.filter(
    (a) => pagedNodeIds.has(a.sourceEntityId) || pagedNodeIds.has(a.targetEntityId)
  );
  const hasMore = startIdx + limits.pageSize < allNodes.length;

  const blockingReasons: string[] = [
    'Valores consolidados representam contratos das empresas relacionadas no universo observado — nunca equivalem a renda pessoal ou cota patrimonial de sócio.',
  ];
  if (hasUnresolvedIdentityPath) {
    blockingReasons.push(
      'O caminho contém vínculos com identidade pessoal não resolvida (candidatos por nome/CPF mascarado); conclusões jurídicas e atribuição pessoal de totais ficam bloqueadas.'
    );
  }

  return {
    seedQuery: params.seedCnpjOrName,
    nodes: pagedNodes,
    assertions: pagedAssertions,
    page: limits.page,
    pageSize: limits.pageSize,
    totalNodesAvailable: allNodes.length,
    totalAssertionsAvailable: allAssertions.length,
    hasMore,
    truncated: truncationReasons.length > 0,
    truncationReasons,
    cancelled,
    cycleCountDetected,
    elapsedMs: Date.now() - startedAt,
    limitsApplied: limits,
    financialAttribution: {
      contractsOfRelatedCompaniesTotal: Number(contractsOfRelatedCompaniesTotal.toFixed(2)),
      label: 'Total de contratos públicos das empresas relacionadas (não equivale a renda ou participação pessoal)',
      legalConclusionAllowed: !hasUnresolvedIdentityPath && allAssertions.length > 0,
      personalTotalAttributionBlocked: true,
      blockingReasons,
    },
    snapshotCoverage: {
      totalQsaSnapshots: index.totalQsaSnapshots,
      earliestSnapshotDate: index.earliestSnapshotDate,
      latestSnapshotDate: index.latestSnapshotDate,
      declaration: index.coverageDeclaration,
    },
  };
}

/**
 * Helper to annotate existing PartnerNetworkPayload nodes/edges with explicit
 * assertion states (`documented` vs `candidate` vs `contested`) for visual distinction.
 */
export function classifyPartnerGraphAssertionState(edge: {
  relation: PartnerNetworkPayload['edges'][number]['relation'];
  confidence?: PartnerNetworkPayload['edges'][number]['confidence'];
  dashed?: boolean;
  contested?: boolean;
}): AssertionState {
  if (edge.contested) return 'contested';
  if (
    edge.relation === 'SOCIO_PJ_DE' ||
    edge.relation === 'CONTRATO_EMPRESA' ||
    edge.relation === 'CONTRATADO_POR'
  ) {
    return 'documented';
  }
  if (edge.dashed || edge.confidence === 'candidate_nominal_match' || edge.confidence === 'candidate_masked_cpf_match') {
    return 'candidate';
  }
  return 'documented';
}

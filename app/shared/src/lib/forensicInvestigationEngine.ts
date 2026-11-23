import { sha256Hex } from './hash';
import type {
  CadastralEventType,
  CadastralMinimizedExtract,
  ChronologyDeltaItem,
  InvestigationEvaluation,
  InvestigationEventRecord,
  InvestigationExportPackage,
  InvestigationFactSet,
  InvestigationFinding,
  InvestigationReviewRecord,
  ObservedContractMetrics,
  ObservedContractRecord,
  ObservedHistorySnapshot,
  PrivateEvidenceRecord,
} from '../types/investigation';

export const INVESTIGATION_ENGINE_VERSION = 'investigation-engine-2026.11';
export const MAX_PRIVATE_EVIDENCE_BYTES = 1024 * 1024; // 1 MiB
export const MAX_CROSSREF_BUDGET = 2500;

export interface InvestigationContractInput {
  id: string;
  contractNumber: string;
  pncpControlNumber: string;
  municipalityName: string;
  municipalityIbge: string;
  uf: string;
  entityName: string;
  signatureDate: string;
  originalValue: number;
  updatedValue: number;
  supplierCnpj: string;
  supplierName: string;
  supplierOpeningDate?: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeCnpjDigits(value: string | undefined | null): string {
  return String(value ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

export function normalizeOrganKey(value: string | undefined | null): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function parseIsoDateUtcMs(value: string | null | undefined): number | null {
  if (!value || !ISO_DATE_RE.test(value.trim())) return null;
  const [y, m, d] = value.trim().split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return dt.getTime();
}

export function diffDaysIso(laterIso: string, earlierIso: string): number | null {
  const later = parseIsoDateUtcMs(laterIso);
  const earlier = parseIsoDateUtcMs(earlierIso);
  if (later === null || earlier === null) return null;
  return Math.round((later - earlier) / 86_400_000);
}

export function isDateWithinInterval(
  targetIso: string | null | undefined,
  fromIso: string | null | undefined,
  untilIso: string | null | undefined
): 'within' | 'outside' | 'unknown' {
  const target = parseIsoDateUtcMs(targetIso);
  if (target === null) return 'unknown';
  const hasFromInput = typeof fromIso === 'string' && fromIso.trim().length > 0;
  const hasUntilInput = typeof untilIso === 'string' && untilIso.trim().length > 0;
  const from = parseIsoDateUtcMs(fromIso);
  const until = parseIsoDateUtcMs(untilIso);
  // F03: Malformed/unparseable interval boundary MUST return 'unknown', never silently treated as open-ended
  if (hasFromInput && from === null) return 'unknown';
  if (hasUntilInput && until === null) return 'unknown';
  if (from === null && until === null) return 'unknown';
  if (from !== null && until !== null && from > until) return 'unknown';
  if (from !== null && target < from) return 'outside';
  if (until !== null && target > until) return 'outside';
  return 'within';
}

/**
 * Deterministic canonical JSON serialization with sorted object keys for reproducible SHA-256 digests.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`);
  return `{${entries.join(',')}}`;
}

export function computeCanonicalSha256(value: unknown): string {
  return sha256Hex(canonicalStringify(value));
}

export function computeEventChainHash(input: {
  id: string;
  contractId: string;
  eventType: string;
  actorId: string;
  actorName: string;
  actorRole: string;
  factsVersion: number;
  payloadJson: string;
  prevHash: string;
  createdAt: string;
}): string {
  return computeCanonicalSha256({
    id: input.id,
    contractId: input.contractId,
    eventType: input.eventType,
    actorId: input.actorId,
    actorName: input.actorName,
    actorRole: input.actorRole,
    factsVersion: input.factsVersion,
    payloadJson: input.payloadJson,
    prevHash: input.prevHash,
    createdAt: input.createdAt,
  });
}

export function verifyEventChain(events: ReadonlyArray<InvestigationEventRecord>): {
  valid: boolean;
  eventCount: number;
  brokenAtSeq: number | null;
} {
  let expectedPrevHash = 'GENESIS';
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    if (i > 0 && ev.seq <= events[i - 1].seq) {
      return { valid: false, eventCount: events.length, brokenAtSeq: ev.seq };
    }
    if (ev.prevHash !== expectedPrevHash) {
      return { valid: false, eventCount: events.length, brokenAtSeq: ev.seq };
    }
    const recomputed = computeEventChainHash({
      id: ev.id,
      contractId: ev.contractId,
      eventType: ev.eventType,
      actorId: ev.actorId,
      actorName: ev.actorName,
      actorRole: ev.actorRole,
      factsVersion: ev.factsVersion,
      payloadJson: ev.payloadJson,
      prevHash: ev.prevHash,
      createdAt: ev.createdAt,
    });
    if (recomputed !== ev.eventHash) {
      return { valid: false, eventCount: events.length, brokenAtSeq: ev.seq };
    }
    expectedPrevHash = ev.eventHash;
  }
  return { valid: true, eventCount: events.length, brokenAtSeq: null };
}

/**
 * F01: Canonical SHA-256 digest of a full InvestigationFactSet for cryptographic binding
 * between investigation_cases.facts_json and the append-only investigation_events ledger.
 */
export function computeFactSetDigest(factSet: InvestigationFactSet): string {
  return computeCanonicalSha256(factSet);
}

/**
 * F01: Verifies both the event hash chain AND that the current InvestigationFactSet
 * matches the latest CASE_INITIALIZED / FACTS_UPDATED ledger event digest & version.
 */
export function verifyCaseLedgerIntegrity(params: {
  factSet: InvestigationFactSet;
  events: ReadonlyArray<InvestigationEventRecord>;
}): {
  valid: boolean;
  eventCount: number;
  brokenAtSeq: number | null;
  factsDigestMatchesLedger: boolean;
  integrityReason: string | null;
} {
  const chain = verifyEventChain(params.events);
  if (!chain.valid) {
    return {
      ...chain,
      factsDigestMatchesLedger: false,
      integrityReason: `Cadeia de eventos corrompida na sequência #${chain.brokenAtSeq}.`,
    };
  }

  let latestFactsDigest: string | null = null;
  let latestFactsVersion: number | null = null;
  for (const ev of params.events) {
    if (ev.eventType === 'CASE_INITIALIZED' || ev.eventType === 'FACTS_UPDATED') {
      try {
        const parsed = JSON.parse(ev.payloadJson || '{}') as { factsSnapshotDigest?: unknown };
        if (typeof parsed.factsSnapshotDigest === 'string' && parsed.factsSnapshotDigest.length === 64) {
          latestFactsDigest = parsed.factsSnapshotDigest;
          latestFactsVersion = ev.factsVersion;
        }
      } catch {
        // Ignore unparseable legacy payload
      }
    }
  }

  if (latestFactsDigest !== null) {
    const actualDigest = computeFactSetDigest(params.factSet);
    if (params.factSet.version !== latestFactsVersion || actualDigest !== latestFactsDigest) {
      return {
        valid: false,
        eventCount: chain.eventCount,
        brokenAtSeq: null,
        factsDigestMatchesLedger: false,
        integrityReason: `Digest SHA-256 do conjunto de fatos atual (v${params.factSet.version}, ${actualDigest.slice(0, 12)}…) diverge do último evento registrado no livro-razão (v${latestFactsVersion}, ${latestFactsDigest.slice(0, 12)}…).`,
      };
    }
  }

  return {
    valid: true,
    eventCount: chain.eventCount,
    brokenAtSeq: null,
    factsDigestMatchesLedger: true,
    integrityReason: null,
  };
}

export function createEmptyFactSet(actorName = 'Sistema'): InvestigationFactSet {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: actorName,
    corporateDates: [],
    corporateChanges: [],
    people: [],
    corporateLinks: [],
    publicFunctions: [],
    kinshipRelations: [],
    lotParticipants: [],
  };
}

export function validateFactSetPayload(raw: unknown): {
  valid: boolean;
  error?: string;
  sanitized?: Omit<InvestigationFactSet, 'version' | 'updatedAt' | 'updatedBy'>;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, error: 'O conjunto de fatos deve ser um objeto JSON válido.' };
  }
  const obj = raw as Record<string, unknown>;
  const arrayFields = [
    'corporateDates',
    'corporateChanges',
    'people',
    'corporateLinks',
    'publicFunctions',
    'kinshipRelations',
    'lotParticipants',
  ] as const;

  for (const field of arrayFields) {
    if (obj[field] !== undefined && !Array.isArray(obj[field])) {
      return { valid: false, error: `O campo "${field}" deve ser um array.` };
    }
  }

  const assertUniqueIds = (field: string, items: Array<{ id: string }>): void => {
    const seen = new Set<string>();
    for (let i = 0; i < items.length; i += 1) {
      const id = items[i].id;
      if (!id) {
        throw new Error(`${field}[${i}].id não pode ser vazio.`);
      }
      if (seen.has(id)) {
        throw new Error(`ID duplicado em ${field}: "${id}". Cada registro deve possuir um identificador único.`);
      }
      seen.add(id);
    }
  };

  const validateOptionalIsoDate = (field: string, idx: number, key: string, rawVal: unknown): string | null => {
    if (rawVal === null || rawVal === undefined || String(rawVal).trim() === '') return null;
    const trimmed = String(rawVal).trim();
    if (parseIsoDateUtcMs(trimmed) === null) {
      throw new Error(`${field}[${idx}].${key} inválido: "${trimmed}" (esperado YYYY-MM-DD ou null).`);
    }
    return trimmed;
  };

  try {
    const validEventTypes = new Set<CadastralEventType>([
      'constituicao',
      'inscricao_cnpj',
      'inicio_atividade',
    ]);
    const corporateDates = ((obj.corporateDates as unknown[]) ?? []).map((item, idx) => {
      const row = item as Record<string, unknown>;
      const eventType = String(row?.eventType ?? '') as CadastralEventType;
      const date = String(row?.date ?? '').trim();
      if (!validEventTypes.has(eventType)) {
        throw new Error(`corporateDates[${idx}].eventType inválido: "${eventType}".`);
      }
      if (!parseIsoDateUtcMs(date)) {
        throw new Error(`corporateDates[${idx}].date deve estar no formato YYYY-MM-DD.`);
      }
      return {
        eventType,
        date,
        sourceLabel: String(row?.sourceLabel ?? 'Documento informado').trim(),
        evidenceRefs: Array.isArray(row?.evidenceRefs) ? row.evidenceRefs.map(String) : [],
      };
    });

    const validChangeTypes = new Set(['societario', 'cnae', 'endereco', 'capital']);
    const corporateChanges = ((obj.corporateChanges as unknown[]) ?? []).map((item, idx) => {
      const row = item as Record<string, unknown>;
      const changeType = String(row?.changeType ?? '');
      const date = String(row?.date ?? '').trim();
      if (!validChangeTypes.has(changeType)) {
        throw new Error(`corporateChanges[${idx}].changeType inválido: "${changeType}".`);
      }
      if (!parseIsoDateUtcMs(date)) {
        throw new Error(`corporateChanges[${idx}].date deve estar no formato YYYY-MM-DD.`);
      }
      return {
        id: String(row?.id ?? `chg-${idx + 1}`).trim(),
        changeType: changeType as 'societario' | 'cnae' | 'endereco' | 'capital',
        date,
        description: String(row?.description ?? '').trim(),
        isHistoricalDocumented: Boolean(row?.isHistoricalDocumented),
        evidenceRefs: Array.isArray(row?.evidenceRefs) ? row.evidenceRefs.map(String) : [],
      };
    });
    assertUniqueIds('corporateChanges', corporateChanges);

    const people = ((obj.people as unknown[]) ?? []).map((item, idx) => {
      const row = item as Record<string, unknown>;
      const id = String(row?.id ?? '').trim();
      const fullName = String(row?.fullName ?? '').trim();
      if (!id || !fullName) {
        throw new Error(`people[${idx}] requer "id" e "fullName".`);
      }
      const identityStatus =
        row?.identityStatus === 'documented' ? 'documented' : 'unresolved';
      return {
        id,
        fullName,
        identityStatus: identityStatus as 'documented' | 'unresolved',
        documentBasis: row?.documentBasis ? String(row.documentBasis).trim() : undefined,
        evidenceRefs: Array.isArray(row?.evidenceRefs) ? row.evidenceRefs.map(String) : [],
      };
    });
    assertUniqueIds('people', people);

    const validRoles = new Set(['socio', 'administrador', 'representante_legal']);
    const corporateLinks = ((obj.corporateLinks as unknown[]) ?? []).map((item, idx) => {
      const row = item as Record<string, unknown>;
      const role = String(row?.role ?? '');
      if (!validRoles.has(role)) {
        throw new Error(`corporateLinks[${idx}].role inválido: "${role}".`);
      }
      return {
        id: String(row?.id ?? `clink-${idx + 1}`).trim(),
        personId: String(row?.personId ?? '').trim(),
        supplierCnpj: normalizeCnpjDigits(String(row?.supplierCnpj ?? '')),
        role: role as 'socio' | 'administrador' | 'representante_legal',
        validFrom: validateOptionalIsoDate('corporateLinks', idx, 'validFrom', row?.validFrom),
        validUntil: validateOptionalIsoDate('corporateLinks', idx, 'validUntil', row?.validUntil),
        evidenceRefs: Array.isArray(row?.evidenceRefs) ? row.evidenceRefs.map(String) : [],
      };
    });
    assertUniqueIds('corporateLinks', corporateLinks);

    const publicFunctions = ((obj.publicFunctions as unknown[]) ?? []).map((item, idx) => {
      const row = item as Record<string, unknown>;
      return {
        id: String(row?.id ?? `pfunc-${idx + 1}`).trim(),
        personId: String(row?.personId ?? '').trim(),
        roleTitle: String(row?.roleTitle ?? '').trim(),
        organName: String(row?.organName ?? '').trim(),
        organKey: row?.organKey ? String(row.organKey).trim() : undefined,
        pertinentToContract: Boolean(row?.pertinentToContract),
        validFrom: validateOptionalIsoDate('publicFunctions', idx, 'validFrom', row?.validFrom),
        validUntil: validateOptionalIsoDate('publicFunctions', idx, 'validUntil', row?.validUntil),
        evidenceRefs: Array.isArray(row?.evidenceRefs) ? row.evidenceRefs.map(String) : [],
      };
    });
    assertUniqueIds('publicFunctions', publicFunctions);

    const validKinship = new Set(['conjuge', 'companheiro', 'consanguinidade', 'afinidade']);
    const kinshipRelations = ((obj.kinshipRelations as unknown[]) ?? []).map((item, idx) => {
      const row = item as Record<string, unknown>;
      const relationType = String(row?.relationType ?? '');
      if (!validKinship.has(relationType)) {
        throw new Error(`kinshipRelations[${idx}].relationType inválido: "${relationType}".`);
      }
      const degree =
        typeof row?.degree === 'number' && Number.isFinite(row.degree) ? row.degree : null;
      return {
        id: String(row?.id ?? `kin-${idx + 1}`).trim(),
        personAId: String(row?.personAId ?? '').trim(),
        personBId: String(row?.personBId ?? '').trim(),
        relationType: relationType as 'conjuge' | 'companheiro' | 'consanguinidade' | 'afinidade',
        degree,
        validFrom: validateOptionalIsoDate('kinshipRelations', idx, 'validFrom', row?.validFrom),
        validUntil: validateOptionalIsoDate('kinshipRelations', idx, 'validUntil', row?.validUntil),
        evidenceRefs: Array.isArray(row?.evidenceRefs) ? row.evidenceRefs.map(String) : [],
      };
    });
    assertUniqueIds('kinshipRelations', kinshipRelations);

    const lotParticipants = ((obj.lotParticipants as unknown[]) ?? []).map((item, idx) => {
      const row = item as Record<string, unknown>;
      const biddingDate = String(row?.biddingDate ?? '').trim();
      if (!parseIsoDateUtcMs(biddingDate)) {
        throw new Error(`lotParticipants[${idx}].biddingDate deve estar no formato YYYY-MM-DD.`);
      }
      return {
        id: String(row?.id ?? `lot-${idx + 1}`).trim(),
        lotId: String(row?.lotId ?? '').trim(),
        biddingDate,
        participantCnpj: normalizeCnpjDigits(String(row?.participantCnpj ?? '')),
        participantName: String(row?.participantName ?? '').trim(),
        linkedPersonIds: Array.isArray(row?.linkedPersonIds) ? row.linkedPersonIds.map(String) : [],
        evidenceRefs: Array.isArray(row?.evidenceRefs) ? row.evidenceRefs.map(String) : [],
      };
    });
    assertUniqueIds('lotParticipants', lotParticipants);

    return {
      valid: true,
      sanitized: {
        corporateDates,
        corporateChanges,
        people,
        corporateLinks,
        publicFunctions,
        kinshipRelations,
        lotParticipants,
      },
    };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : 'Conjunto de fatos inválido.',
    };
  }
}

function dedupeObservedContracts(
  records: ReadonlyArray<ObservedContractRecord>
): ObservedContractRecord[] {
  const seen = new Map<string, ObservedContractRecord>();
  for (const rec of records) {
    const key =
      (rec.pncpControlNumber && rec.pncpControlNumber.trim()) ||
      `${normalizeOrganKey(rec.buyerName)}|${rec.contractNumber.trim().toLowerCase()}|${rec.signatureDate ?? ''}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...rec });
    } else if (
      existing.contractValue !== null &&
      rec.contractValue !== null &&
      Math.abs(existing.contractValue - rec.contractValue) > 0.01
    ) {
      existing.hasValueDivergence = true;
    }
  }
  return Array.from(seen.values());
}

function attachReviewState(
  finding: Omit<InvestigationFinding, 'activeReview' | 'reviewIsCurrent' | 'reviewStaleReason'>,
  latestReviewByFinding: Map<string, InvestigationReviewRecord>
): InvestigationFinding {
  const rev = latestReviewByFinding.get(finding.findingId) ?? null;
  if (!rev) {
    return {
      ...finding,
      activeReview: null,
      reviewIsCurrent: false,
      reviewStaleReason: null,
    };
  }
  const versionMatches = rev.factsVersion === finding.factsVersion;
  const digestMatches = rev.findingInputsDigest === finding.inputsDigest;
  const reviewIsCurrent = versionMatches && digestMatches;
  let reviewStaleReason: string | null = null;
  if (!versionMatches || !digestMatches) {
    reviewStaleReason = `Revisão anterior registrada na versão de fatos v${rev.factsVersion} (${rev.findingInputsDigest.slice(0, 10)}…); fatos atuais em v${finding.factsVersion} exigem nova conferência.`;
  }
  return {
    ...finding,
    activeReview: rev,
    reviewIsCurrent,
    reviewStaleReason,
  };
}

/**
 * Pure deterministic Forensic Investigation Engine.
 * Evaluates all 8 trails, chronology deltas, observed contract metrics, and fact-bound reviews.
 */
export function evaluateForensicInvestigation(params: {
  contract: InvestigationContractInput;
  factSet: InvestigationFactSet;
  cadastralExtracts: ReadonlyArray<CadastralMinimizedExtract>;
  observedHistory: ObservedHistorySnapshot | null;
  privateEvidence: ReadonlyArray<PrivateEvidenceRecord>;
  reviews: ReadonlyArray<InvestigationReviewRecord>;
  evaluatedAt?: string;
}): InvestigationEvaluation {
  const {
    contract,
    factSet,
    cadastralExtracts,
    observedHistory,
    privateEvidence,
    reviews,
  } = params;
  const evaluatedAt = params.evaluatedAt ?? new Date().toISOString();
  const referenceDateIso = evaluatedAt.slice(0, 10);
  const referenceDateMs = parseIsoDateUtcMs(referenceDateIso);
  const supplierCnpj = normalizeCnpjDigits(contract.supplierCnpj);
  const investigatedBuyerKey = normalizeOrganKey(contract.entityName);

  // F02: Referential integrity — build set of REAL evidence IDs present in this case
  const validEvidenceIds = new Set<string>([
    ...privateEvidence.map((e) => e.id),
    ...cadastralExtracts.map((c) => c.id),
  ]);
  const resolveValidEvidenceRefs = (refs: ReadonlyArray<string> | undefined): string[] =>
    Array.from(
      new Set((refs ?? []).map((r) => String(r).trim()).filter((r) => r.length > 0 && validEvidenceIds.has(r)))
    );

  const latestReviewByFinding = new Map<string, InvestigationReviewRecord>();
  for (const rev of reviews) {
    latestReviewByFinding.set(rev.findingId, rev);
  }

  const findingsRaw: Array<
    Omit<InvestigationFinding, 'activeReview' | 'reviewIsCurrent' | 'reviewStaleReason'>
  > = [];

  // Collect distinct corporate dates (keeping constituicao, inscricao_cnpj, inicio_atividade strictly separated)
  const corporateDates: Array<{
    eventType: CadastralEventType;
    date: string;
    sourceLabel: string;
    evidenceRefs: string[];
  }> = [...factSet.corporateDates];

  for (const ext of cadastralExtracts) {
    if (ext.startActivityDate && parseIsoDateUtcMs(ext.startActivityDate)) {
      const exists = corporateDates.some(
        (d) => d.eventType === 'inicio_atividade' && d.date === ext.startActivityDate
      );
      if (!exists) {
        corporateDates.push({
          eventType: 'inicio_atividade',
          date: ext.startActivityDate,
          sourceLabel: `${ext.sourceProvider} (${ext.sourceType})`,
          evidenceRefs: [ext.id],
        });
      }
    }
  }

  if (
    corporateDates.length === 0 &&
    contract.supplierOpeningDate &&
    parseIsoDateUtcMs(contract.supplierOpeningDate)
  ) {
    corporateDates.push({
      eventType: 'inicio_atividade',
      date: contract.supplierOpeningDate,
      sourceLabel: 'Cadastro do fornecedor no contrato',
      evidenceRefs: [],
    });
  }

  // Build chronology deltas: Δd = d_assinatura - d_evento_cadastral
  // F03: Detect future/impossible dates (> evaluatedAt date) as chronological inconsistencies, NEVER as "recent company"
  const chronology: ChronologyDeltaItem[] = [];
  const futureDateAnomalies: Array<{
    field: 'signatureDate' | CadastralEventType;
    date: string;
    sourceLabel: string;
  }> = [];

  const sigMs = parseIsoDateUtcMs(contract.signatureDate);
  if (sigMs !== null && referenceDateMs !== null && sigMs > referenceDateMs) {
    futureDateAnomalies.push({
      field: 'signatureDate',
      date: contract.signatureDate,
      sourceLabel: 'Data de assinatura do contrato',
    });
  }

  for (const cd of corporateDates) {
    const cdMs = parseIsoDateUtcMs(cd.date);
    const isFutureCorporateDate =
      cdMs !== null && referenceDateMs !== null && cdMs > referenceDateMs;
    if (isFutureCorporateDate) {
      futureDateAnomalies.push({
        field: cd.eventType,
        date: cd.date,
        sourceLabel: cd.sourceLabel,
      });
    }
    const delta = diffDaysIso(contract.signatureDate, cd.date);
    if (delta === null) continue;
    const isFuturePair =
      isFutureCorporateDate || (sigMs !== null && referenceDateMs !== null && sigMs > referenceDateMs);
    const band: ChronologyDeltaItem['band'] =
      delta < 0 || isFuturePair
        ? 'incompativel'
        : delta <= 1
          ? '0-1'
          : delta <= 30
            ? '2-30'
            : delta <= 90
              ? '31-90'
              : '>90';
    chronology.push({
      eventType: cd.eventType,
      eventDate: cd.date,
      signatureDate: contract.signatureDate,
      deltaDays: delta,
      band,
      sourceLabel: cd.sourceLabel,
    });
  }

  // TRAIL 1: Cronologia incompatível (signatureDate < corporate event date OR future/impossible dates)
  const incompatibleDates = chronology.filter((c) => c.deltaDays < 0 || c.band === 'incompativel');
  {
    const inputs = {
      signatureDate: contract.signatureDate,
      incompatibleDates,
      futureDateAnomalies,
    };
    const digest = computeCanonicalSha256(inputs);
    if (incompatibleDates.length > 0 || futureDateAnomalies.length > 0) {
      const worst =
        incompatibleDates.length > 0
          ? incompatibleDates.reduce((a, b) => (a.deltaDays < b.deltaDays ? a : b))
          : null;
      const summaryText =
        worst && worst.deltaDays < 0
          ? `A data de assinatura (${contract.signatureDate}) antecede em ${Math.abs(worst.deltaDays)} dia(s) o evento "${worst.eventType}" (${worst.eventDate}, fonte: ${worst.sourceLabel}).`
          : `Detectada data futura ou cronologicamente inconsistente em relação à data de referência (${referenceDateIso}): ${futureDateAnomalies
              .map((a) => `${a.field}=${a.date}`)
              .join(', ')}.`;
      findingsRaw.push({
        findingId: `${contract.id}:INV_CHRONOLOGY_INCOMPATIBLE`,
        trailCode: 'INV_CHRONOLOGY_INCOMPATIBLE',
        title: 'Cronologia incompatível entre assinatura e data empresarial',
        severity: 'CRÍTICA',
        status: 'INCONSISTENCIA',
        summary: summaryText,
        metrics: {
          deltaDays: worst ? worst.deltaDays : null,
          eventType: worst ? worst.eventType : futureDateAnomalies[0]?.field ?? null,
          eventDate: worst ? worst.eventDate : futureDateAnomalies[0]?.date ?? null,
          signatureDate: contract.signatureDate,
          futureAnomaliesCount: futureDateAnomalies.length,
        },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: worst
          ? resolveValidEvidenceRefs(
              corporateDates
                .filter((d) => d.date === worst.eventDate)
                .flatMap((d) => d.evidenceRefs)
            )
          : [],
        limitations: [
          'Inconsistência cronológica ou data futura não comprova fraude por si só; pode decorrer de erro de digitação, data de filial/estabelecimento ou sucessão empresarial.',
        ],
        suggestedDiligences: [
          'Conferir a íntegra do contrato assinado e publicação oficial da data de assinatura.',
          'Verificar se o CNPJ contratado corresponde a filial aberta após matriz ou a sucessão/incorporação empresarial.',
          'Confirmar o significado jurídico da data cadastral (constituição vs. inscrição no CNPJ vs. início de atividade).',
        ],
      });
    } else {
      findingsRaw.push({
        findingId: `${contract.id}:INV_CHRONOLOGY_INCOMPATIBLE`,
        trailCode: 'INV_CHRONOLOGY_INCOMPATIBLE',
        title: 'Cronologia incompatível entre assinatura e data empresarial',
        severity: 'BAIXA',
        status: chronology.length === 0 ? 'INCOMPLETO' : 'SEM_SINAL',
        summary:
          chronology.length === 0
            ? 'Sem data de assinatura ou data empresarial válida para verificação cronológica.'
            : 'Nenhuma data empresarial registrada é posterior à assinatura contratual ou futura.',
        metrics: { evaluatedDatesCount: chronology.length },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: [],
        limitations: [
          'Depende da completude das datas cadastrais informadas (constituição, inscrição CNPJ e início de atividade).',
        ],
        suggestedDiligences:
          chronology.length === 0
            ? ['Consultar cadastro CNPJ/QSA ou anexar contrato social para registrar as datas empresariais.']
            : [],
      });
    }
  }

  // TRAIL 2: Empresa recente (faixas 0–1, 2–30 e 31–90 dias; excludes incompatible/future dates!)
  const recentDates = chronology
    .filter((c) => c.band !== 'incompativel' && c.deltaDays >= 0 && c.deltaDays <= 90)
    .sort((a, b) => a.deltaDays - b.deltaDays);
  {
    const inputs = {
      signatureDate: contract.signatureDate,
      recentDates,
    };
    const digest = computeCanonicalSha256(inputs);
    if (recentDates.length > 0) {
      const closest = recentDates[0];
      const severity =
        closest.band === '0-1' ? 'CRÍTICA' : closest.band === '2-30' ? 'ALTA' : 'MÉDIA';
      findingsRaw.push({
        findingId: `${contract.id}:INV_RECENT_COMPANY`,
        trailCode: 'INV_RECENT_COMPANY',
        title: `Empresa recente na assinatura (faixa ${closest.band} dias)`,
        severity,
        status: 'APONTAMENTO',
        summary: `Intervalo Δd = ${closest.deltaDays} dia(s) entre ${closest.eventType} (${closest.eventDate}) e a assinatura (${closest.signatureDate}), enquadrado na faixa ${closest.band} dias.`,
        metrics: {
          deltaDays: closest.deltaDays,
          band: closest.band,
          eventType: closest.eventType,
          eventDate: closest.eventDate,
        },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: corporateDates
          .filter((d) => d.date === closest.eventDate && d.eventType === closest.eventType)
          .flatMap((d) => d.evidenceRefs),
        limitations: [
          'A Lei nº 14.133/2021 prevê regras de habilitação para empresas recém-constituídas; intervalo curto prioriza apuração, mas não caracteriza ilegalidade automática.',
          'Constituição, inscrição no CNPJ e início de atividade permanecem registrados separadamente.',
        ],
        suggestedDiligences: [
          'Requisitar ato constitutivo registrado na Junta Comercial, comprovantes de capacidade técnica e estrutura operacional compatível.',
          'Verificar se os sócios já atuavam no ramo por meio de outras empresas ou sucessão legítima.',
        ],
      });
    } else {
      findingsRaw.push({
        findingId: `${contract.id}:INV_RECENT_COMPANY`,
        trailCode: 'INV_RECENT_COMPANY',
        title: 'Empresa recente na assinatura (0–1, 2–30 e 31–90 dias)',
        severity: 'BAIXA',
        status: chronology.length === 0 ? 'INCOMPLETO' : 'SEM_SINAL',
        summary:
          chronology.length === 0
            ? 'Sem datas empresariais suficientes para calcular Δd = d_assinatura − d_evento_cadastral.'
            : 'Os eventos empresariais avaliados superam 90 dias antes da assinatura contratual.',
        metrics: { evaluatedDatesCount: chronology.length },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: [],
        limitations: ['Avalia exclusivamente eventos empresariais presentes nas fontes e fatos versionados.'],
        suggestedDiligences: [],
      });
    }
  }

  // TRAIL 3: Alterações próximas à contratação (<= 30 dias antes da assinatura, exigindo documentação histórica real)
  {
    const changesEvaluated = factSet.corporateChanges.map((chg) => ({
      ...chg,
      validEvidenceRefs: resolveValidEvidenceRefs(chg.evidenceRefs),
      deltaDays: diffDaysIso(contract.signatureDate, chg.date),
    }));
    const documentedWithin30 = changesEvaluated.filter(
      (c) =>
        c.isHistoricalDocumented &&
        c.validEvidenceRefs.length > 0 &&
        c.deltaDays !== null &&
        c.deltaDays >= 0 &&
        c.deltaDays <= 30
    );
    const undocumentedWithin30 = changesEvaluated.filter(
      (c) =>
        (!c.isHistoricalDocumented || c.validEvidenceRefs.length === 0) &&
        c.deltaDays !== null &&
        c.deltaDays >= 0 &&
        c.deltaDays <= 30
    );
    const inputs = { signatureDate: contract.signatureDate, changesEvaluated };
    const digest = computeCanonicalSha256(inputs);

    if (documentedWithin30.length > 0) {
      const types = Array.from(new Set(documentedWithin30.map((c) => c.changeType))).join(', ');
      findingsRaw.push({
        findingId: `${contract.id}:INV_RECENT_CORPORATE_CHANGE`,
        trailCode: 'INV_RECENT_CORPORATE_CHANGE',
        title: 'Alterações societárias/cadastrais documentadas nos 30 dias anteriores',
        severity: 'ALTA',
        status: 'APONTAMENTO',
        summary: `Foram documentadas ${documentedWithin30.length} alteração(ões) (${types}) nos 30 dias anteriores à assinatura (${contract.signatureDate}).`,
        metrics: {
          documentedChangesCount: documentedWithin30.length,
          changeTypes: types,
          minDeltaDays: Math.min(...documentedWithin30.map((c) => c.deltaDays ?? 30)),
        },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: documentedWithin30.flatMap((c) => c.validEvidenceRefs),
        limitations: [
          'Uma consulta cadastral atual (como BrasilAPI/Receita) não comprova retroativamente a data exata de alterações; somente alterações respaldadas por documentação histórica são acionadas.',
        ],
        suggestedDiligences: [
          'Conferir as alterações contratuais arquivadas na Junta Comercial e certidão simplificada histórica.',
          'Verificar compatibilidade entre a alteração de CNAE/capital/quadro societário e as exigências do edital.',
        ],
      });
    } else if (undocumentedWithin30.length > 0 || factSet.corporateChanges.length === 0) {
      findingsRaw.push({
        findingId: `${contract.id}:INV_RECENT_CORPORATE_CHANGE`,
        trailCode: 'INV_RECENT_CORPORATE_CHANGE',
        title: 'Alterações próximas à contratação (30 dias anteriores)',
        severity: 'BAIXA',
        status: 'INCOMPLETO',
        summary:
          undocumentedWithin30.length > 0
            ? `Há ${undocumentedWithin30.length} alteração(ões) informada(s) sem documentação histórica anexada; trilha bloqueada contra falso positivo.`
            : 'Nenhum histórico documental de alterações societárias, CNAE, endereço ou capital foi registrado nesta investigação.',
        metrics: {
          documentedChangesCount: 0,
          undocumentedChangesCount: undocumentedWithin30.length,
        },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: [],
        limitations: [
          'Consulta cadastral pontual não substitui certidão histórica da Junta Comercial.',
        ],
        suggestedDiligences: [
          'Anexar ficha cadastral completa / histórico da Junta Comercial no acervo privado e registrar as datas das alterações no conjunto de fatos.',
        ],
      });
    } else {
      findingsRaw.push({
        findingId: `${contract.id}:INV_RECENT_CORPORATE_CHANGE`,
        trailCode: 'INV_RECENT_CORPORATE_CHANGE',
        title: 'Alterações próximas à contratação (30 dias anteriores)',
        severity: 'BAIXA',
        status: 'SEM_SINAL',
        summary: 'As alterações históricas documentadas ocorreram fora da janela de 30 dias anteriores à assinatura.',
        metrics: { documentedChangesCount: 0, evaluatedChangesCount: changesEvaluated.length },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: [],
        limitations: ['Restrito às alterações registradas no conjunto versionado de fatos.'],
        suggestedDiligences: [],
      });
    }
  }

  // Compute Observed Contract History Metrics (for Trails 4 & 5)
  const rawObserved: ObservedContractRecord[] = observedHistory?.contracts
    ? [...observedHistory.contracts]
    : [
        {
          id: contract.id,
          pncpControlNumber: contract.pncpControlNumber,
          contractNumber: contract.contractNumber,
          buyerKey: investigatedBuyerKey,
          buyerName: contract.entityName,
          municipalityIbge: contract.municipalityIbge,
          signatureDate: contract.signatureDate || null,
          contractValue:
            contract.updatedValue > 0
              ? contract.updatedValue
              : contract.originalValue > 0
                ? contract.originalValue
                : null,
          sourceSystem: 'Contrato Atual',
        },
      ];

  const dedupedObserved = dedupeObservedContracts(rawObserved);
  const currentSigMs = parseIsoDateUtcMs(contract.signatureDate);
  let priorObserved: number | null = null;
  if (currentSigMs !== null) {
    let comparableCount = 0;
    let priorCount = 0;
    for (const rec of dedupedObserved) {
      if (rec.id === contract.id) continue;
      const ms = parseIsoDateUtcMs(rec.signatureDate);
      if (ms !== null) {
        comparableCount += 1;
        if (ms < currentSigMs) priorCount += 1;
      }
    }
    priorObserved = comparableCount > 0 || dedupedObserved.length === 1 ? priorCount : null;
  }

  const distinctBuyers = new Set(
    dedupedObserved.map((c) => c.buyerKey || normalizeOrganKey(c.buyerName)).filter(Boolean)
  );
  const investigatedBuyerContracts = dedupedObserved.filter(
    (c) => (c.buyerKey || normalizeOrganKey(c.buyerName)) === investigatedBuyerKey
  );

  const hasInvalidValues = dedupedObserved.some(
    (c) => c.contractValue === null || !Number.isFinite(c.contractValue) || c.contractValue <= 0
  );
  const hasDivergences = dedupedObserved.some((c) => Boolean(c.hasValueDivergence));

  let concentrationComputable = false;
  let concentrationHaltReason: string | null = null;
  let totalObservedValue: number | null = null;
  let investigatedBuyerSharePct: number | null = null;

  if (dedupedObserved.length < 3) {
    concentrationHaltReason = `Amostra insuficiente (${dedupedObserved.length} contrato(s) observado(s); mínimo de 3 contratos comparáveis).`;
  } else if (hasDivergences) {
    concentrationHaltReason = 'Cálculo interrompido por divergência de valores entre registros deduplicados.';
  } else if (hasInvalidValues) {
    concentrationHaltReason = 'Cálculo interrompido por ausência de valor contratual válido em um ou mais registros observados.';
  } else {
    totalObservedValue = dedupedObserved.reduce((acc, c) => acc + (c.contractValue ?? 0), 0);
    const buyerTotal = investigatedBuyerContracts.reduce(
      (acc, c) => acc + (c.contractValue ?? 0),
      0
    );
    if (totalObservedValue > 0) {
      concentrationComputable = true;
      investigatedBuyerSharePct = Number(((buyerTotal / totalObservedValue) * 100).toFixed(2));
    } else {
      concentrationHaltReason = 'Total contratual observado igual a zero.';
    }
  }

  const sourcesCoverageNote = observedHistory
    ? `${observedHistory.coverageNote} (fontes: ${observedHistory.sourcesChecked.join(', ')}; status PNCP: ${observedHistory.pncpStatus})`
    : 'Apenas o contrato em análise foi observado até o momento (histórico PNCP ainda não sincronizado).';

  const observedMetrics: ObservedContractMetrics = {
    totalObservedContracts: dedupedObserved.length,
    priorObservedContracts: priorObserved,
    distinctBuyersCount: distinctBuyers.size,
    investigatedBuyerContractsCount: investigatedBuyerContracts.length,
    investigatedBuyerSharePct,
    concentrationComputable,
    concentrationHaltReason,
    totalObservedContractualValue: totalObservedValue,
    sourcesCoverageNote,
  };

  // TRAIL 4: Contrato único observado
  {
    const inputs = {
      totalObservedContracts: observedMetrics.totalObservedContracts,
      priorObservedContracts: observedMetrics.priorObservedContracts,
      pncpStatus: observedHistory?.pncpStatus ?? 'local_only',
    };
    const digest = computeCanonicalSha256(inputs);

    if (!observedHistory) {
      findingsRaw.push({
        findingId: `${contract.id}:INV_SINGLE_OBSERVED_CONTRACT`,
        trailCode: 'INV_SINGLE_OBSERVED_CONTRACT',
        title: 'Contrato único observado no universo consultado',
        severity: 'BAIXA',
        status: 'INCOMPLETO',
        summary: 'O histórico observado no PNCP ainda não foi sincronizado para este fornecedor.',
        metrics: { totalObservedContracts: observedMetrics.totalObservedContracts },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: [],
        limitations: [
          'Não se pode inferir exclusividade sem sincronizar o histórico disponível nas fontes públicas.',
        ],
        suggestedDiligences: ['Executar "Atualizar histórico no PNCP" nesta aba.'],
      });
    } else if (observedMetrics.totalObservedContracts === 1) {
      findingsRaw.push({
        findingId: `${contract.id}:INV_SINGLE_OBSERVED_CONTRACT`,
        trailCode: 'INV_SINGLE_OBSERVED_CONTRACT',
        title: 'Contrato único observado no universo disponível',
        severity: 'MÉDIA',
        status: 'APONTAMENTO',
        summary: `Apenas 1 contrato foi localizado para o CNPJ ${supplierCnpj} no universo observado (${observedHistory.sourcesChecked.join(', ')}).`,
        metrics: {
          totalObservedContracts: 1,
          priorObservedContracts: observedMetrics.priorObservedContracts,
          pncpStatus: observedHistory.pncpStatus,
        },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: [],
        limitations: [
          '“Apenas um contrato localizado” refere-se estritamente ao universo das fontes consultadas e não comprova inexistência de outros contratos em portais locais ou setor privado.',
          'Valores observados são contratuais e não representam faturamento nem pagamentos recebidos.',
        ],
        suggestedDiligences: [
          'Verificar contratos em diários oficiais estaduais/municipais não integrados ao PNCP e consultar notas fiscais/execução financeira.',
        ],
      });
    } else {
      findingsRaw.push({
        findingId: `${contract.id}:INV_SINGLE_OBSERVED_CONTRACT`,
        trailCode: 'INV_SINGLE_OBSERVED_CONTRACT',
        title: 'Contrato único observado no universo disponível',
        severity: 'BAIXA',
        status: 'SEM_SINAL',
        summary: `Foram localizados ${observedMetrics.totalObservedContracts} contrato(s) observado(s) entre ${observedMetrics.distinctBuyersCount} comprador(es) distinto(s).`,
        metrics: {
          totalObservedContracts: observedMetrics.totalObservedContracts,
          priorObservedContracts: observedMetrics.priorObservedContracts,
          distinctBuyersCount: observedMetrics.distinctBuyersCount,
        },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: [],
        limitations: [sourcesCoverageNote],
        suggestedDiligences: [],
      });
    }
  }

  // TRAIL 5: Concentração por comprador (>= 80% do valor contratual observado com >= 3 contratos)
  {
    const inputs = {
      totalObservedContracts: observedMetrics.totalObservedContracts,
      concentrationComputable: observedMetrics.concentrationComputable,
      investigatedBuyerSharePct: observedMetrics.investigatedBuyerSharePct,
      concentrationHaltReason: observedMetrics.concentrationHaltReason,
    };
    const digest = computeCanonicalSha256(inputs);

    if (!concentrationComputable) {
      findingsRaw.push({
        findingId: `${contract.id}:INV_BUYER_CONCENTRATION`,
        trailCode: 'INV_BUYER_CONCENTRATION',
        title: 'Concentração de valor contratual por comprador (>= 80%)',
        severity: 'BAIXA',
        status: 'INCOMPLETO',
        summary: concentrationHaltReason ?? 'Cálculo de concentração indisponível.',
        metrics: {
          totalObservedContracts: observedMetrics.totalObservedContracts,
          distinctBuyersCount: observedMetrics.distinctBuyersCount,
        },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: [],
        limitations: [
          'O cálculo exige ao menos 3 contratos comparáveis deduplicados com valores válidos e sem divergências.',
        ],
        suggestedDiligences: [
          'Conciliar divergências ou complementar valores ausentes no histórico contratual observado.',
        ],
      });
    } else if ((investigatedBuyerSharePct ?? 0) >= 80) {
      findingsRaw.push({
        findingId: `${contract.id}:INV_BUYER_CONCENTRATION`,
        trailCode: 'INV_BUYER_CONCENTRATION',
        title: `Alta concentração contratual no órgão (${investigatedBuyerSharePct}%)`,
        severity: 'ALTA',
        status: 'APONTAMENTO',
        summary: `O órgão "${contract.entityName}" concentra ${investigatedBuyerSharePct}% do valor contratual observado (${investigatedBuyerContracts.length} de ${dedupedObserved.length} contratos comparáveis).`,
        metrics: {
          investigatedBuyerSharePct,
          investigatedBuyerContractsCount: investigatedBuyerContracts.length,
          totalObservedContracts: dedupedObserved.length,
          distinctBuyersCount: distinctBuyers.size,
        },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: [],
        limitations: [
          'Baseado exclusivamente nos valores contratuais observados nas fontes consultadas; não mede faturamento privado nem pagamentos efetivados.',
        ],
        suggestedDiligences: [
          'Analisar competitividade, recorrência de dispensas/inexigibilidades e aditivos nos contratos do fornecedor com este órgão.',
        ],
      });
    } else {
      findingsRaw.push({
        findingId: `${contract.id}:INV_BUYER_CONCENTRATION`,
        trailCode: 'INV_BUYER_CONCENTRATION',
        title: 'Concentração de valor contratual por comprador (>= 80%)',
        severity: 'BAIXA',
        status: 'SEM_SINAL',
        summary: `A participação do órgão investigado é de ${investigatedBuyerSharePct}% do valor contratual observado (abaixo do limiar de 80%).`,
        metrics: {
          investigatedBuyerSharePct,
          totalObservedContracts: dedupedObserved.length,
          distinctBuyersCount: distinctBuyers.size,
        },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: [],
        limitations: [sourcesCoverageNote],
        suggestedDiligences: [],
      });
    }
  }

  // People index + unresolved identities count (includes QSA unresolved members + unresolved people)
  const peopleById = new Map(factSet.people.map((p) => [p.id, p]));
  const unresolvedPeopleInFacts = factSet.people.filter((p) => p.identityStatus !== 'documented').length;
  const unresolvedQsaCount = cadastralExtracts.reduce((acc, ext) => acc + ext.qsa.length, 0);
  const unresolvedIdentitiesCount = unresolvedPeopleInFacts + unresolvedQsaCount;

  // Cross-reference budget tracking
  let crossRefOps = 0;
  let budgetExceeded = false;
  const consumeBudget = (ops = 1): boolean => {
    crossRefOps += ops;
    if (crossRefOps > MAX_CROSSREF_BUDGET) {
      budgetExceeded = true;
      return false;
    }
    return true;
  };

  // TRAIL 6: Vínculo empresarial e função pública pertinente
  {
    const supplierLinks = factSet.corporateLinks.filter(
      (link) => !supplierCnpj || normalizeCnpjDigits(link.supplierCnpj) === supplierCnpj
    );
    const matchedPairs: Array<{
      personId: string;
      personName: string;
      corporateRole: string;
      publicRole: string;
      organName: string;
      evidenceRefs: string[];
    }> = [];
    let incompleteMatches = 0;

    for (const link of supplierLinks) {
      const person = peopleById.get(link.personId);
      for (const fn of factSet.publicFunctions) {
        if (!consumeBudget(1)) break;
        if (fn.personId !== link.personId) continue;

        // F03: Respect explicit pertinentToContract === false — never override with organ name match
        if (fn.pertinentToContract === false) continue;

        const organRelevant =
          fn.pertinentToContract === true &&
          (Boolean(fn.organName.trim()) ||
            (fn.organKey && normalizeOrganKey(fn.organKey) === investigatedBuyerKey) ||
            normalizeOrganKey(fn.organName) === investigatedBuyerKey);

        if (!organRelevant) continue;

        const personEvidenceRefs = resolveValidEvidenceRefs(person?.evidenceRefs);
        const linkEvidenceRefs = resolveValidEvidenceRefs(link.evidenceRefs);
        const fnEvidenceRefs = resolveValidEvidenceRefs(fn.evidenceRefs);
        const identityOk = Boolean(
          person && person.identityStatus === 'documented' && personEvidenceRefs.length > 0
        );
        const linkPeriod = isDateWithinInterval(
          contract.signatureDate,
          link.validFrom,
          link.validUntil
        );
        const fnPeriod = isDateWithinInterval(contract.signatureDate, fn.validFrom, fn.validUntil);
        const hasEvidence = linkEvidenceRefs.length > 0 && fnEvidenceRefs.length > 0;

        if (linkPeriod === 'outside' || fnPeriod === 'outside') continue;

        if (identityOk && linkPeriod === 'within' && fnPeriod === 'within' && hasEvidence) {
          matchedPairs.push({
            personId: person!.id,
            personName: person!.fullName,
            corporateRole: link.role,
            publicRole: fn.roleTitle,
            organName: fn.organName,
            evidenceRefs: Array.from(
              new Set([...personEvidenceRefs, ...linkEvidenceRefs, ...fnEvidenceRefs])
            ),
          });
        } else {
          incompleteMatches += 1;
        }
      }
      if (budgetExceeded) break;
    }

    const digest = computeCanonicalSha256({
      signatureDate: contract.signatureDate,
      supplierCnpj,
      matchedPairs,
      incompleteMatches,
      budgetExceeded,
    });

    if (budgetExceeded) {
      findingsRaw.push({
        findingId: `${contract.id}:INV_CORPORATE_PUBLIC_FUNCTION_LINK`,
        trailCode: 'INV_CORPORATE_PUBLIC_FUNCTION_LINK',
        title: 'Vínculo empresarial e função pública pertinente',
        severity: 'MÉDIA',
        status: 'ORCAMENTO_EXCEDIDO',
        summary: `Cruzamento interrompido por atingir o orçamento explícito (${MAX_CROSSREF_BUDGET} operações); resultado não amostrado.`,
        metrics: { maxBudget: MAX_CROSSREF_BUDGET },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: [],
        limitations: ['O motor recusa apresentar amostra parcial como verificação completa.'],
        suggestedDiligences: ['Segmentar o conjunto de fatos por contratação ou lote específico.'],
      });
    } else if (matchedPairs.length > 0) {
      const top = matchedPairs[0];
      findingsRaw.push({
        findingId: `${contract.id}:INV_CORPORATE_PUBLIC_FUNCTION_LINK`,
        trailCode: 'INV_CORPORATE_PUBLIC_FUNCTION_LINK',
        title: 'Pessoa documentada acumula vínculo empresarial e função pública pertinente',
        severity: 'CRÍTICA',
        status: 'APONTAMENTO',
        summary: `${top.personName} possui vínculo empresarial documentado (${top.corporateRole}) no fornecedor e função pública pertinente (${top.publicRole} — ${top.organName}) vigentes na assinatura (${contract.signatureDate}).`,
        metrics: {
          confirmedMatchesCount: matchedPairs.length,
          incompleteMatchesCount: incompleteMatches,
        },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: matchedPairs.flatMap((m) => m.evidenceRefs),
        limitations: [
          'Exige validação jurídica do enquadramento concreto (art. 9º e art. 14 da Lei nº 14.133/2021) e conferência dos originais.',
        ],
        suggestedDiligences: [
          'Conferir portaria de nomeação/exoneração e ato societário vigente na data da licitação e assinatura.',
        ],
      });
    } else if (incompleteMatches > 0 || (supplierLinks.length === 0 && factSet.publicFunctions.length === 0)) {
      findingsRaw.push({
        findingId: `${contract.id}:INV_CORPORATE_PUBLIC_FUNCTION_LINK`,
        trailCode: 'INV_CORPORATE_PUBLIC_FUNCTION_LINK',
        title: 'Vínculo empresarial e função pública pertinente',
        severity: 'BAIXA',
        status: 'INCOMPLETO',
        summary:
          incompleteMatches > 0
            ? `${incompleteMatches} possível(is) interseção(ões) bloqueada(s) por identidade não resolvida, período sem vigência comprovada ou ausência de referência documental.`
            : 'Nenhum vínculo empresarial e função pública documentados foram fornecidos para cruzamento.',
        metrics: { incompleteMatchesCount: incompleteMatches, unresolvedIdentitiesCount },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: [],
        limitations: [
          'Homônimos e nomes isolados de QSA nunca são fundidos automaticamente sem documentação de identidade.',
        ],
        suggestedDiligences: [
          'Anexar documentos comprobatórios de identidade, vínculo societário e período de exercício de função pública.',
        ],
      });
    } else {
      findingsRaw.push({
        findingId: `${contract.id}:INV_CORPORATE_PUBLIC_FUNCTION_LINK`,
        trailCode: 'INV_CORPORATE_PUBLIC_FUNCTION_LINK',
        title: 'Vínculo empresarial e função pública pertinente',
        severity: 'BAIXA',
        status: 'SEM_SINAL',
        summary:
          'Nenhuma identidade documentada apresentou sobreposição vigente entre vínculo empresarial e função pública pertinente.',
        metrics: { evaluatedLinks: supplierLinks.length, evaluatedPublicFunctions: factSet.publicFunctions.length },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: [],
        limitations: ['Limitado aos registros documentados no conjunto versionado de fatos.'],
        suggestedDiligences: [],
      });
    }
  }

  // TRAIL 7: Parentesco documentado com nexo contratual (art. 14, IV, Lei 14.133/2021)
  {
    const supplierLinks = factSet.corporateLinks.filter(
      (link) => !supplierCnpj || normalizeCnpjDigits(link.supplierCnpj) === supplierCnpj
    );
    const kinshipHits: Array<{
      relationId: string;
      supplierPerson: string;
      publicAgent: string;
      relationType: string;
      degree: number | null;
      publicRole: string;
      evidenceRefs: string[];
    }> = [];
    let incompleteKinship = 0;

    for (const kin of factSet.kinshipRelations) {
      const pA = peopleById.get(kin.personAId);
      const pB = peopleById.get(kin.personBId);
      const candidates: Array<[typeof pA, typeof pB]> = [
        [pA, pB],
        [pB, pA],
      ];

      for (const [supplierP, agentP] of candidates) {
        if (!supplierP || !agentP) continue;
        const sLinks = supplierLinks.filter((l) => l.personId === supplierP.id);
        const aFuncs = factSet.publicFunctions.filter((f) => f.personId === agentP.id);

        for (const sLink of sLinks) {
          for (const aFunc of aFuncs) {
            if (!consumeBudget(1)) break;

            // F03: Respect explicit pertinentToContract === false
            if (aFunc.pertinentToContract === false) continue;

            const organRelevant =
              aFunc.pertinentToContract === true &&
              (Boolean(aFunc.organName.trim()) ||
                (aFunc.organKey && normalizeOrganKey(aFunc.organKey) === investigatedBuyerKey) ||
                normalizeOrganKey(aFunc.organName) === investigatedBuyerKey);
            if (!organRelevant) continue;

            const sPeriod = isDateWithinInterval(
              contract.signatureDate,
              sLink.validFrom,
              sLink.validUntil
            );
            const aPeriod = isDateWithinInterval(
              contract.signatureDate,
              aFunc.validFrom,
              aFunc.validUntil
            );
            const kPeriod = isDateWithinInterval(
              contract.signatureDate,
              kin.validFrom,
              kin.validUntil
            );
            if (sPeriod === 'outside' || aPeriod === 'outside' || kPeriod === 'outside') {
              continue;
            }

            const degreeValid =
              kin.relationType === 'conjuge' ||
              kin.relationType === 'companheiro' ||
              (typeof kin.degree === 'number' && kin.degree >= 1 && kin.degree <= 3);

            const supplierPEv = resolveValidEvidenceRefs(supplierP.evidenceRefs);
            const agentPEv = resolveValidEvidenceRefs(agentP.evidenceRefs);
            const kinEv = resolveValidEvidenceRefs(kin.evidenceRefs);
            const sLinkEv = resolveValidEvidenceRefs(sLink.evidenceRefs);
            const aFuncEv = resolveValidEvidenceRefs(aFunc.evidenceRefs);

            const allDocumented =
              supplierP.identityStatus === 'documented' &&
              agentP.identityStatus === 'documented' &&
              supplierPEv.length > 0 &&
              agentPEv.length > 0 &&
              kinEv.length > 0 &&
              sLinkEv.length > 0 &&
              aFuncEv.length > 0 &&
              sPeriod === 'within' &&
              aPeriod === 'within' &&
              (kPeriod === 'within' || kin.relationType === 'consanguinidade') &&
              degreeValid;

            if (allDocumented) {
              kinshipHits.push({
                relationId: kin.id,
                supplierPerson: supplierP.fullName,
                publicAgent: agentP.fullName,
                relationType: kin.relationType,
                degree: kin.degree,
                publicRole: `${aFunc.roleTitle} (${aFunc.organName})`,
                evidenceRefs: Array.from(
                  new Set([...supplierPEv, ...agentPEv, ...kinEv, ...sLinkEv, ...aFuncEv])
                ),
              });
            } else {
              incompleteKinship += 1;
            }
          }
          if (budgetExceeded) break;
        }
        if (budgetExceeded) break;
      }
      if (budgetExceeded) break;
    }

    const digest = computeCanonicalSha256({
      signatureDate: contract.signatureDate,
      kinshipHits,
      incompleteKinship,
      budgetExceeded,
    });

    if (budgetExceeded) {
      findingsRaw.push({
        findingId: `${contract.id}:INV_DOCUMENTED_KINSHIP_NEXUS`,
        trailCode: 'INV_DOCUMENTED_KINSHIP_NEXUS',
        title: 'Parentesco documentado com nexo contratual',
        severity: 'MÉDIA',
        status: 'ORCAMENTO_EXCEDIDO',
        summary: `Cruzamento interrompido por orçamento explícito (${MAX_CROSSREF_BUDGET} operações).`,
        metrics: { maxBudget: MAX_CROSSREF_BUDGET },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: [],
        limitations: ['O motor não apresenta amostras parciais quando o orçamento é excedido.'],
        suggestedDiligences: ['Reduzir o escopo do conjunto de fatos para o contrato específico.'],
      });
    } else if (kinshipHits.length > 0) {
      const hit = kinshipHits[0];
      const degreeLabel = hit.degree ? ` (${hit.degree}º grau)` : '';
      findingsRaw.push({
        findingId: `${contract.id}:INV_DOCUMENTED_KINSHIP_NEXUS`,
        trailCode: 'INV_DOCUMENTED_KINSHIP_NEXUS',
        title: 'Relação familiar documentada entre fornecedor e agente público pertinente',
        severity: 'CRÍTICA',
        status: 'APONTAMENTO',
        summary: `Vínculo familiar documentado (${hit.relationType}${degreeLabel}) entre ${hit.supplierPerson} (fornecedor) e ${hit.publicAgent} (${hit.publicRole}) com vigência compatível à assinatura (${contract.signatureDate}).`,
        metrics: {
          confirmedKinshipCount: kinshipHits.length,
          incompleteKinshipCount: incompleteKinship,
          relationType: hit.relationType,
          degree: hit.degree,
        },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: kinshipHits.flatMap((h) => h.evidenceRefs),
        limitations: [
          'Parentesco isolado não encerra a análise; requer confirmação de atuação ou vínculo do agente com a licitação/contrato (art. 14, IV, Lei nº 14.133/2021).',
          'Não existe base nacional pública automática de parentesco; somente relações sustentadas por documentos anexados entram neste cruzamento.',
        ],
        suggestedDiligences: [
          'Verificar nos autos do processo licitatório se o agente público atuou na fase interna, comissão, homologação ou fiscalização do contrato.',
          'Conferir certidões civis/documentos que comprovem o vínculo familiar e sua vigência.',
        ],
      });
    } else if (incompleteKinship > 0 || factSet.kinshipRelations.length === 0) {
      findingsRaw.push({
        findingId: `${contract.id}:INV_DOCUMENTED_KINSHIP_NEXUS`,
        trailCode: 'INV_DOCUMENTED_KINSHIP_NEXUS',
        title: 'Parentesco documentado com nexo contratual',
        severity: 'BAIXA',
        status: 'INCOMPLETO',
        summary:
          incompleteKinship > 0
            ? `${incompleteKinship} relação(ões) familiar(es) sem requisitos completos (evidência documental, grau, vigência ou identidade documentada).`
            : 'Nenhuma relação familiar documentada foi registrada nesta investigação.',
        metrics: { incompleteKinshipCount: incompleteKinship },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: [],
        limitations: [
          'O NEXOFIS não possui base nacional de parentesco e nunca infere parentesco apenas por sobrenome.',
        ],
        suggestedDiligences: [
          'Registrar apenas relações familiares comprovadas por documento (certidões, declarações oficiais) com grau e vigência.',
        ],
      });
    } else {
      findingsRaw.push({
        findingId: `${contract.id}:INV_DOCUMENTED_KINSHIP_NEXUS`,
        trailCode: 'INV_DOCUMENTED_KINSHIP_NEXUS',
        title: 'Parentesco documentado com nexo contratual',
        severity: 'BAIXA',
        status: 'SEM_SINAL',
        summary:
          'Nenhuma relação familiar documentada apresentou nexo vigente com o órgão/contrato investigado.',
        metrics: { evaluatedKinshipCount: factSet.kinshipRelations.length },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: [],
        limitations: ['Restrito às relações documentadas no conjunto versionado de fatos.'],
        suggestedDiligences: [],
      });
    }
  }

  // TRAIL 8: Relações entre participantes do mesmo lote
  {
    const byLotAndDate = new Map<string, typeof factSet.lotParticipants>();
    for (const part of factSet.lotParticipants) {
      const key = `${part.lotId.trim().toLowerCase()}|${part.biddingDate}`;
      const list = byLotAndDate.get(key) ?? [];
      list.push(part);
      byLotAndDate.set(key, list);
    }

    const sharedHits: Array<{
      lotId: string;
      biddingDate: string;
      personId: string;
      personName: string;
      participants: string[];
      evidenceRefs: string[];
    }> = [];
    let incompleteLotLinks = 0;

    for (const group of byLotAndDate.values()) {
      if (group.length < 2) continue;
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          if (!consumeBudget(1)) break;
          const a = group[i];
          const b = group[j];
          if (a.participantCnpj === b.participantCnpj) continue;

          // F09: Require actual documented corporateLinks valid on a.biddingDate for BOTH participant companies
          const candidatePersonIds = Array.from(
            new Set([
              ...a.linkedPersonIds.filter((pid) => b.linkedPersonIds.includes(pid)),
              ...factSet.corporateLinks
                .filter((l) => normalizeCnpjDigits(l.supplierCnpj) === a.participantCnpj)
                .map((l) => l.personId)
                .filter((pid) =>
                  factSet.corporateLinks.some(
                    (l2) =>
                      l2.personId === pid &&
                      normalizeCnpjDigits(l2.supplierCnpj) === b.participantCnpj
                  )
                ),
            ])
          );

          for (const pid of candidatePersonIds) {
            const person = peopleById.get(pid);
            const personEv = resolveValidEvidenceRefs(person?.evidenceRefs);
            const aPartEv = resolveValidEvidenceRefs(a.evidenceRefs);
            const bPartEv = resolveValidEvidenceRefs(b.evidenceRefs);

            const linkA = factSet.corporateLinks.find(
              (l) =>
                l.personId === pid &&
                normalizeCnpjDigits(l.supplierCnpj) === a.participantCnpj &&
                isDateWithinInterval(a.biddingDate, l.validFrom, l.validUntil) === 'within' &&
                resolveValidEvidenceRefs(l.evidenceRefs).length > 0
            );
            const linkB = factSet.corporateLinks.find(
              (l) =>
                l.personId === pid &&
                normalizeCnpjDigits(l.supplierCnpj) === b.participantCnpj &&
                isDateWithinInterval(b.biddingDate, l.validFrom, l.validUntil) === 'within' &&
                resolveValidEvidenceRefs(l.evidenceRefs).length > 0
            );

            const hasValidCorporateLinks = Boolean(linkA && linkB);
            const hasEvidence = aPartEv.length > 0 && bPartEv.length > 0;
            if (
              person &&
              person.identityStatus === 'documented' &&
              personEv.length > 0 &&
              hasEvidence &&
              hasValidCorporateLinks
            ) {
              sharedHits.push({
                lotId: a.lotId,
                biddingDate: a.biddingDate,
                personId: pid,
                personName: person.fullName,
                participants: [
                  `${a.participantName} (${a.participantCnpj})`,
                  `${b.participantName} (${b.participantCnpj})`,
                ],
                evidenceRefs: Array.from(
                  new Set([
                    ...personEv,
                    ...aPartEv,
                    ...bPartEv,
                    ...resolveValidEvidenceRefs(linkA!.evidenceRefs),
                    ...resolveValidEvidenceRefs(linkB!.evidenceRefs),
                  ])
                ),
              });
            } else {
              incompleteLotLinks += 1;
            }
          }
        }
        if (budgetExceeded) break;
      }
      if (budgetExceeded) break;
    }

    const digest = computeCanonicalSha256({
      sharedHits,
      incompleteLotLinks,
      budgetExceeded,
    });

    if (budgetExceeded) {
      findingsRaw.push({
        findingId: `${contract.id}:INV_LOT_PARTICIPANT_SHARED_LINK`,
        trailCode: 'INV_LOT_PARTICIPANT_SHARED_LINK',
        title: 'Relações entre participantes do mesmo lote',
        severity: 'MÉDIA',
        status: 'ORCAMENTO_EXCEDIDO',
        summary: `Cruzamento de participantes interrompido por atingir orçamento máximo (${MAX_CROSSREF_BUDGET} operações).`,
        metrics: { maxBudget: MAX_CROSSREF_BUDGET },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: [],
        limitations: ['O motor evita resultados parciais quando o orçamento de cruzamento é excedido.'],
        suggestedDiligences: ['Avaliar cada lote separadamente.'],
      });
    } else if (sharedHits.length > 0) {
      const hit = sharedHits[0];
      findingsRaw.push({
        findingId: `${contract.id}:INV_LOT_PARTICIPANT_SHARED_LINK`,
        trailCode: 'INV_LOT_PARTICIPANT_SHARED_LINK',
        title: 'Participantes do mesmo lote compartilham identidade empresarial documentada',
        severity: 'ALTA',
        status: 'APONTAMENTO',
        summary: `No lote "${hit.lotId}" (${hit.biddingDate}), ${hit.personName} aparece vinculada simultaneamente a ${hit.participants.join(' e ')}.`,
        metrics: {
          sharedPairsCount: sharedHits.length,
          lotId: hit.lotId,
          biddingDate: hit.biddingDate,
        },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: sharedHits.flatMap((h) => h.evidenceRefs),
        limitations: [
          'Compartilhamento societário entre licitantes não declara conluio automaticamente; a apuração requer análise das propostas, lances, atas e eventual frustração do caráter competitivo.',
        ],
        suggestedDiligences: [
          'Examinar ata da sessão, propostas de preço, metadados de envio/IP e lances no lote indicado.',
        ],
      });
    } else if (incompleteLotLinks > 0 || factSet.lotParticipants.length === 0) {
      findingsRaw.push({
        findingId: `${contract.id}:INV_LOT_PARTICIPANT_SHARED_LINK`,
        trailCode: 'INV_LOT_PARTICIPANT_SHARED_LINK',
        title: 'Relações entre participantes do mesmo lote',
        severity: 'BAIXA',
        status: 'INCOMPLETO',
        summary:
          incompleteLotLinks > 0
            ? `${incompleteLotLinks} compartilhamento(s) potencial(is) sem identidade documentada ou referência probatória completa.`
            : 'Nenhum registro de participantes por lote foi incluído no conjunto de fatos.',
        metrics: { incompleteLotLinksCount: incompleteLotLinks },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: [],
        limitations: ['Depende dos participantes de lote informados com base na ata da licitação.'],
        suggestedDiligences: ['Importar a ata do pregão/licitação e registrar os participantes por lote.'],
      });
    } else {
      findingsRaw.push({
        findingId: `${contract.id}:INV_LOT_PARTICIPANT_SHARED_LINK`,
        trailCode: 'INV_LOT_PARTICIPANT_SHARED_LINK',
        title: 'Relações entre participantes do mesmo lote',
        severity: 'BAIXA',
        status: 'SEM_SINAL',
        summary:
          'Os participantes registrados no mesmo lote não compartilharam identidades empresariais documentadas.',
        metrics: { evaluatedParticipants: factSet.lotParticipants.length },
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        factsVersion: factSet.version,
        inputsDigest: digest,
        evidenceRefs: [],
        limitations: ['Restrito aos participantes e vínculos documentados no conjunto de fatos.'],
        suggestedDiligences: [],
      });
    }
  }

  const findings = findingsRaw.map((f) => attachReviewState(f, latestReviewByFinding));

  return {
    engineVersion: INVESTIGATION_ENGINE_VERSION,
    evaluatedAt,
    factsVersion: factSet.version,
    chronology,
    observedMetrics,
    findings,
    unresolvedIdentitiesCount,
    budgetExceeded,
    generalLimitations: [
      'Todos os apontamentos orientam diligências humanas e não constituem prova automática de ilegalidade ou fraude.',
      'Hash SHA-256 e reprodução determinística garantem integridade técnica, mas não substituem cadeia de custódia legal (CPP) nem assinatura digital institucional.',
      'Consultas cadastrais (BrasilAPI) operam como provedor intermediário com extrato derivado minimizado e nomes de QSA mantidos como identidades não resolvidas.',
    ],
  };
}

export function buildInvestigationExportPackage(input: {
  contractSnapshot: InvestigationExportPackage['contractSnapshot'];
  factSet: InvestigationFactSet;
  cadastralExtracts: CadastralMinimizedExtract[];
  observedHistory: ObservedHistorySnapshot | null;
  privateEvidence: PrivateEvidenceRecord[];
  reviews: InvestigationReviewRecord[];
  events: InvestigationEventRecord[];
  evaluation: InvestigationEvaluation;
  exportedAt?: string;
}): InvestigationExportPackage {
  const base = {
    schemaVersion: 'nexofis-investigation-pkg/1.0' as const,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    engineVersion: INVESTIGATION_ENGINE_VERSION,
    contractSnapshot: input.contractSnapshot,
    factSet: input.factSet,
    cadastralExtracts: input.cadastralExtracts,
    observedHistory: input.observedHistory,
    privateEvidence: input.privateEvidence,
    reviews: input.reviews,
    events: input.events,
    evaluation: input.evaluation,
  };
  return {
    ...base,
    packageDigestSha256: computeCanonicalSha256(base),
  };
}

export interface PackageVerificationResult {
  /** 0 = valid within declared scope, 1 = invalid or tampered/divergent, 2 = incomplete (missing originals or engine version mismatch) */
  exitCode: 0 | 1 | 2;
  status: 'VALID' | 'INVALID' | 'INCOMPLETE';
  checks: {
    schemaValid: boolean;
    packageDigestValid: boolean;
    eventChainValid: boolean;
    factsDigestMatchesLedger: boolean;
    engineVersionMatches: boolean;
    reproductionMatches: boolean;
    originalsChecked: number;
    originalsMissing: number;
    originalsMismatched: number;
  };
  errors: string[];
  warnings: string[];
}

/**
 * Pure offline verification of an exported InvestigationExportPackage.
 * Optionally validates binary original files when `readOriginalBytes` callback is supplied.
 */
export function verifyInvestigationPackage(
  pkg: unknown,
  options?: {
    readOriginalBytes?: (ev: PrivateEvidenceRecord) => Buffer | null;
  }
): PackageVerificationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return {
      exitCode: 1,
      status: 'INVALID',
      checks: {
        schemaValid: false,
        packageDigestValid: false,
        eventChainValid: false,
        factsDigestMatchesLedger: false,
        engineVersionMatches: false,
        reproductionMatches: false,
        originalsChecked: 0,
        originalsMissing: 0,
        originalsMismatched: 0,
      },
      errors: ['Pacote JSON inválido ou malformado.'],
      warnings,
    };
  }

  const p = pkg as Partial<InvestigationExportPackage>;
  const schemaValid =
    p.schemaVersion === 'nexofis-investigation-pkg/1.0' &&
    Boolean(p.contractSnapshot) &&
    Boolean(p.factSet) &&
    Array.isArray(p.cadastralExtracts) &&
    Array.isArray(p.privateEvidence) &&
    Array.isArray(p.reviews) &&
    Array.isArray(p.events) &&
    Boolean(p.evaluation) &&
    typeof p.packageDigestSha256 === 'string';

  if (!schemaValid) {
    errors.push('Estrutura do pacote não corresponde ao schema nexofis-investigation-pkg/1.0.');
    return {
      exitCode: 1,
      status: 'INVALID',
      checks: {
        schemaValid: false,
        packageDigestValid: false,
        eventChainValid: false,
        factsDigestMatchesLedger: false,
        engineVersionMatches: false,
        reproductionMatches: false,
        originalsChecked: 0,
        originalsMissing: 0,
        originalsMismatched: 0,
      },
      errors,
      warnings,
    };
  }

  const { packageDigestSha256, ...withoutDigest } = p as InvestigationExportPackage;
  const expectedDigest = computeCanonicalSha256(withoutDigest);
  const packageDigestValid = expectedDigest === packageDigestSha256;
  if (!packageDigestValid) {
    errors.push(
      `Digest SHA-256 do pacote divergente (esperado ${expectedDigest.slice(0, 16)}…, encontrado ${packageDigestSha256.slice(0, 16)}…).`
    );
  }

  // F01: Verify BOTH event hash chain AND facts_json snapshot digest binding
  const ledger = verifyCaseLedgerIntegrity({
    factSet: p.factSet!,
    events: p.events!,
  });
  const chainValid = ledger.brokenAtSeq === null && (ledger.valid || !ledger.factsDigestMatchesLedger);
  if (ledger.brokenAtSeq !== null) {
    errors.push(`Cadeia de eventos corrompida na sequência #${ledger.brokenAtSeq}.`);
  }
  if (!ledger.factsDigestMatchesLedger) {
    errors.push(
      ledger.integrityReason ??
        'Conjunto de fatos (factSet) diverge do digest registrado no livro-razão append-only.'
    );
  }

  // Verify cadastral extract hashes
  for (const ext of p.cadastralExtracts!) {
    const { extractSha256, ...rest } = ext;
    const recomputedExt = computeCanonicalSha256(rest);
    if (recomputedExt !== extractSha256) {
      errors.push(`Hash SHA-256 divergente no extrato cadastral ${ext.id}.`);
    }
  }

  const engineVersionMatches = p.engineVersion === INVESTIGATION_ENGINE_VERSION;
  if (!engineVersionMatches) {
    warnings.push(
      `Versão do motor divergente: pacote=${p.engineVersion}, verificador=${INVESTIGATION_ENGINE_VERSION}.`
    );
  }

  const reproducedContractId =
    p.events?.[0]?.contractId ||
    p.reviews?.[0]?.contractId ||
    p.privateEvidence?.[0]?.contractId ||
    p.contractSnapshot!.pncpControlNumber ||
    p.contractSnapshot!.contractNumber;

  const reproduced = evaluateForensicInvestigation({
    contract: {
      id: reproducedContractId,
      ...p.contractSnapshot!,
    },
    factSet: p.factSet!,
    cadastralExtracts: p.cadastralExtracts!,
    observedHistory: p.observedHistory ?? null,
    privateEvidence: p.privateEvidence!,
    reviews: p.reviews!,
    evaluatedAt: p.evaluation!.evaluatedAt,
  });

  // F04: Deep canonical replay comparison over FULL evaluation (summaries, titles, metrics, chronology, evidenceRefs, reviews)
  const normalizeEvaluationForReplay = (ev: InvestigationEvaluation) => ({
    engineVersion: ev.engineVersion,
    factsVersion: ev.factsVersion,
    chronology: ev.chronology,
    observedMetrics: ev.observedMetrics,
    unresolvedIdentitiesCount: ev.unresolvedIdentitiesCount,
    budgetExceeded: ev.budgetExceeded,
    findings: ev.findings.map((f) => ({
      trailCode: f.trailCode,
      title: f.title,
      severity: f.severity,
      status: f.status,
      summary: f.summary,
      metrics: f.metrics,
      ruleVersion: f.ruleVersion,
      factsVersion: f.factsVersion,
      inputsDigest: f.inputsDigest,
      evidenceRefs: f.evidenceRefs,
      reviewIsCurrent: f.reviewIsCurrent,
      reviewStaleReason: f.reviewStaleReason,
      activeReviewId: f.activeReview?.id ?? null,
      activeReviewAction: f.activeReview?.action ?? null,
    })),
  });

  const reproductionMatches =
    canonicalStringify(normalizeEvaluationForReplay(p.evaluation!)) ===
    canonicalStringify(normalizeEvaluationForReplay(reproduced));

  if (!reproductionMatches && engineVersionMatches) {
    errors.push(
      'Reprodução determinística integral (achados, resumos, cronologia, métricas e revisões) divergiu da avaliação exportada.'
    );
  }

  // Verify private evidence original bytes if provided
  let originalsChecked = 0;
  let originalsMissing = 0;
  let originalsMismatched = 0;

  if (p.privateEvidence!.length > 0) {
    if (!options?.readOriginalBytes) {
      originalsMissing = p.privateEvidence!.length;
      warnings.push(
        `Diretório de originais não fornecido para conferir ${originalsMissing} arquivo(s) privado(s).`
      );
    } else {
      for (const ev of p.privateEvidence!) {
        const bytes = options.readOriginalBytes(ev);
        if (!bytes) {
          originalsMissing += 1;
          warnings.push(`Original ausente para conferência: ${ev.exportFilename} (${ev.sha256.slice(0, 12)}…).`);
        } else {
          originalsChecked += 1;
          const actualHash = sha256Hex(bytes);
          if (actualHash !== ev.sha256.toLowerCase() || bytes.length !== ev.sizeBytes) {
            originalsMismatched += 1;
            errors.push(
              `Integridade violada no original ${ev.exportFilename}: SHA-256 ou tamanho divergente.`
            );
          }
        }
      }
    }
  }

  const hasFatal = errors.length > 0;
  const isIncomplete = !hasFatal && (!engineVersionMatches || originalsMissing > 0);
  const exitCode: 0 | 1 | 2 = hasFatal ? 1 : isIncomplete ? 2 : 0;
  const status: PackageVerificationResult['status'] =
    exitCode === 0 ? 'VALID' : exitCode === 1 ? 'INVALID' : 'INCOMPLETE';

  return {
    exitCode,
    status,
    checks: {
      schemaValid,
      packageDigestValid,
      eventChainValid: chainValid,
      factsDigestMatchesLedger: ledger.factsDigestMatchesLedger,
      engineVersionMatches,
      reproductionMatches,
      originalsChecked,
      originalsMissing,
      originalsMismatched,
    },
    errors,
    warnings,
  };
}

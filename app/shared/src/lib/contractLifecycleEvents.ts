import type {
  ContractLifecycleEvent,
  ContractRecord,
  EvaluatedContract,
  FindingReviewRecord,
} from '../types/audit';
import { validateIsoDate } from './competenciaValidator';
import { computeCanonicalSha256 } from './forensicInvestigationEngine';

export interface BuildContractLifecycleEventsInput {
  sourceSystem: string;
  publicationDate?: string | null;
  publicationSourceField?: string;
  publicationChannelName?: string | null;
  publicationChannelUrl?: string | null;
  submissionDate?: string | null;
  submissionSourceField?: string;
  submissionWindowStart?: string | null;
  submissionWindowEnd?: string | null;
  submissionChannelName?: string | null;
  submissionChannelUrl?: string | null;
  signatureDate?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  timezone?: string;
}

export interface DistinctContractDatesSummary {
  publicationDate: string | null;
  submissionDate: string | null;
  submissionWindowStart: string | null;
  submissionWindowEnd: string | null;
  signatureDate: string | null;
  executionStartDate: string | null;
  executionEndDate: string | null;
  publicationEvent: ContractLifecycleEvent | null;
  submissionEvent: ContractLifecycleEvent | null;
  submissionOpenEvent: ContractLifecycleEvent | null;
  submissionCloseEvent: ContractLifecycleEvent | null;
  signatureEvent: ContractLifecycleEvent | null;
  executionStartEvent: ContractLifecycleEvent | null;
  executionEndEvent: ContractLifecycleEvent | null;
  events: ContractLifecycleEvent[];
  chronologyStatus:
    | 'consistent'
    | 'inconsistent_submission_before_publication'
    | 'inconsistent_submission_window'
    | 'incomplete';
  chronologyIssues: string[];
}

/**
 * Strictly validates an ISO-8601 date (YYYY-MM-DD) or full ISO timestamp (YYYY-MM-DDTHH:mm...).
 * Rejects impossible calendar dates (e.g. 2026-02-30) and returns null for empty/invalid inputs.
 */
export function normalizeLifecycleDate(raw?: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const datePart = trimmed.slice(0, 10);
  if (!validateIsoDate(datePart).valid) return null;
  // Preserve full timestamp if valid ISO datetime, otherwise YYYY-MM-DD
  if (trimmed.length > 10 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) {
    const parsedMs = Date.parse(trimmed);
    if (!Number.isFinite(parsedMs)) return null;
    return trimmed;
  }
  return datePart;
}

function toDateOnly(iso: string | null): string | null {
  return iso ? iso.slice(0, 10) : null;
}

/**
 * Builds distinct structured lifecycle events for a contract/procurement record (Defect 1.8).
 * Guarantees that:
 *  - Publication date NEVER silently populates submissionDate or execution startDate.
 *  - Proposal submission date/window is modeled strictly as a separate event from publication.
 *  - Invalid calendar dates are dropped instead of stored silently.
 */
export function buildContractLifecycleEvents(
  input: BuildContractLifecycleEventsInput
): ContractLifecycleEvent[] {
  const events: ContractLifecycleEvent[] = [];
  const tz = input.timezone ?? 'America/Sao_Paulo';

  const pub = normalizeLifecycleDate(input.publicationDate);
  if (pub) {
    events.push({
      type: 'publication',
      date: pub,
      sourceSystem: input.sourceSystem,
      sourceField: input.publicationSourceField ?? 'publicationDate',
      channelName: input.publicationChannelName ?? null,
      channelUrl: input.publicationChannelUrl ?? null,
      timezone: tz,
      notes: 'Evento de divulgação/publicação oficial (distinto da submissão de propostas e vigência).',
    });
  }

  const subOpen = normalizeLifecycleDate(input.submissionWindowStart);
  if (subOpen) {
    events.push({
      type: 'proposal_submission_open',
      date: subOpen,
      sourceSystem: input.sourceSystem,
      sourceField: 'submissionWindowStart',
      channelName: input.submissionChannelName ?? null,
      channelUrl: input.submissionChannelUrl ?? null,
      timezone: tz,
      notes: 'Abertura da janela de envio/submissão de propostas.',
    });
  }

  const subExplicit = normalizeLifecycleDate(input.submissionDate);
  const subClose = normalizeLifecycleDate(input.submissionWindowEnd);

  if (subExplicit && subExplicit !== subOpen && subExplicit !== subClose) {
    events.push({
      type: 'proposal_submission',
      date: subExplicit,
      sourceSystem: input.sourceSystem,
      sourceField: input.submissionSourceField ?? 'submissionDate',
      channelName: input.submissionChannelName ?? null,
      channelUrl: input.submissionChannelUrl ?? null,
      timezone: tz,
      notes: 'Evento de submissão de proposta (distinto da data de publicação oficial).',
    });
  }

  if (subClose) {
    events.push({
      type: 'proposal_submission_close',
      date: subClose,
      sourceSystem: input.sourceSystem,
      sourceField: 'submissionWindowEnd',
      channelName: input.submissionChannelName ?? null,
      channelUrl: input.submissionChannelUrl ?? null,
      timezone: tz,
      notes: 'Encerramento do prazo de envio/submissão de propostas.',
    });
  } else if (subExplicit && subExplicit === subOpen) {
    events.push({
      type: 'proposal_submission',
      date: subExplicit,
      sourceSystem: input.sourceSystem,
      sourceField: input.submissionSourceField ?? 'submissionDate',
      channelName: input.submissionChannelName ?? null,
      channelUrl: input.submissionChannelUrl ?? null,
      timezone: tz,
      notes: 'Evento de submissão de proposta (distinto da data de publicação oficial).',
    });
  }

  const sig = normalizeLifecycleDate(input.signatureDate);
  if (sig) {
    events.push({
      type: 'signature',
      date: sig,
      sourceSystem: input.sourceSystem,
      sourceField: 'signatureDate',
      timezone: tz,
    });
  }

  const execStart = normalizeLifecycleDate(input.startDate);
  if (execStart) {
    events.push({
      type: 'execution_start',
      date: execStart,
      sourceSystem: input.sourceSystem,
      sourceField: 'startDate',
      timezone: tz,
    });
  }

  const execEnd = normalizeLifecycleDate(input.endDate);
  if (execEnd) {
    events.push({
      type: 'execution_end',
      date: execEnd,
      sourceSystem: input.sourceSystem,
      sourceField: 'endDate',
      timezone: tz,
    });
  }

  return events;
}

/**
 * Extracts explicit publication, proposal submission, signature, and execution dates/events
 * from a ContractRecord and checks chronological consistency between publication and submission (Defect 1.8).
 * Never infers or copies publicationDate into submissionDate or vice-versa.
 */
export function extractDistinctContractDates(
  contract: Pick<
    ContractRecord,
    | 'publicationDate'
    | 'submissionDate'
    | 'submissionWindowStart'
    | 'submissionWindowEnd'
    | 'signatureDate'
    | 'startDate'
    | 'endDate'
    | 'lifecycleEvents'
    | 'dataSourceOrigin'
  >
): DistinctContractDatesSummary {
  const existingEvents = Array.isArray(contract.lifecycleEvents) ? contract.lifecycleEvents : [];
  const findEvent = (type: ContractLifecycleEvent['type']) =>
    existingEvents.find((e) => e.type === type && Boolean(normalizeLifecycleDate(e.date))) ?? null;

  const pubEventExisting = findEvent('publication');
  const subOpenExisting = findEvent('proposal_submission_open');
  const subEventExisting = findEvent('proposal_submission');
  const subCloseExisting = findEvent('proposal_submission_close');
  const sigEventExisting = findEvent('signature');
  const startEventExisting = findEvent('execution_start');
  const endEventExisting = findEvent('execution_end');

  const publicationDate =
    normalizeLifecycleDate(contract.publicationDate) ??
    normalizeLifecycleDate(pubEventExisting?.date) ??
    null;

  const submissionWindowStart =
    normalizeLifecycleDate(contract.submissionWindowStart) ??
    normalizeLifecycleDate(subOpenExisting?.date) ??
    null;

  const submissionWindowEnd =
    normalizeLifecycleDate(contract.submissionWindowEnd) ??
    normalizeLifecycleDate(subCloseExisting?.date) ??
    null;

  const submissionDate =
    normalizeLifecycleDate(contract.submissionDate) ??
    normalizeLifecycleDate(subEventExisting?.date) ??
    submissionWindowEnd ??
    submissionWindowStart ??
    null;

  const signatureDate =
    normalizeLifecycleDate(contract.signatureDate) ??
    normalizeLifecycleDate(sigEventExisting?.date) ??
    null;

  const executionStartDate =
    normalizeLifecycleDate(contract.startDate) ??
    normalizeLifecycleDate(startEventExisting?.date) ??
    null;

  const executionEndDate =
    normalizeLifecycleDate(contract.endDate) ??
    normalizeLifecycleDate(endEventExisting?.date) ??
    null;

  const events =
    existingEvents.length > 0
      ? existingEvents
      : buildContractLifecycleEvents({
          sourceSystem: contract.dataSourceOrigin || 'Registro Contratual',
          publicationDate,
          submissionDate,
          submissionWindowStart,
          submissionWindowEnd,
          signatureDate,
          startDate: executionStartDate,
          endDate: executionEndDate,
        });

  const pickEvent = (type: ContractLifecycleEvent['type']) =>
    events.find((e) => e.type === type) ?? null;

  const chronologyIssues: string[] = [];
  let chronologyStatus: DistinctContractDatesSummary['chronologyStatus'] = 'incomplete';

  const pubDay = toDateOnly(publicationDate);
  const subDay = toDateOnly(submissionDate);
  const subOpenDay = toDateOnly(submissionWindowStart);
  const subCloseDay = toDateOnly(submissionWindowEnd);

  if (subOpenDay && subCloseDay && subCloseDay < subOpenDay) {
    chronologyStatus = 'inconsistent_submission_window';
    chronologyIssues.push(
      `Encerramento da submissão (${submissionWindowEnd}) anterior à abertura (${submissionWindowStart}).`
    );
  }

  const earliestSubmissionDay = [subOpenDay, subDay, subCloseDay]
    .filter((d): d is string => Boolean(d))
    .sort()[0];

  if (pubDay && earliestSubmissionDay) {
    if (earliestSubmissionDay < pubDay) {
      chronologyStatus = 'inconsistent_submission_before_publication';
      chronologyIssues.push(
        `Evento de submissão de propostas (${earliestSubmissionDay}) anterior à data de publicação oficial (${pubDay}).`
      );
    } else if (chronologyIssues.length === 0) {
      chronologyStatus = 'consistent';
    }
  }

  return {
    publicationDate,
    submissionDate,
    submissionWindowStart,
    submissionWindowEnd,
    signatureDate,
    executionStartDate,
    executionEndDate,
    publicationEvent: pickEvent('publication'),
    submissionEvent: pickEvent('proposal_submission') ?? pickEvent('proposal_submission_close') ?? pickEvent('proposal_submission_open'),
    submissionOpenEvent: pickEvent('proposal_submission_open'),
    submissionCloseEvent: pickEvent('proposal_submission_close'),
    signatureEvent: pickEvent('signature'),
    executionStartEvent: pickEvent('execution_start'),
    executionEndEvent: pickEvent('execution_end'),
    events,
    chronologyStatus,
    chronologyIssues,
  };
}

/**
 * Computes a deterministic, content-addressed canonical SHA-256 hash for a dossier snapshot (Defect 1.2).
 *
 * Strips volatile runtime timestamps (`assessment.evaluatedAt`, `savedAt`, snapshot `id`) and sorts all
 * object keys canonically so that two archive attempts with identical semantic dossier content ALWAYS
 * yield the exact same 64-character SHA-256 digest — preventing duplicate rows in SQLite/PostgreSQL.
 */
export function computeCanonicalDossierSnapshotHash(input: {
  contractId: string;
  contract: EvaluatedContract;
  reviews: readonly FindingReviewRecord[];
  analystNote: string;
}): string {
  const { assessment, reviews: _embeddedReviews, ...contractBase } = input.contract;
  const { evaluatedAt: _volatileEvaluatedAt, ...stableAssessment } = assessment;

  const normalizedReviews = [...input.reviews]
    .map((r) => ({
      id: r.id,
      contractId: r.contractId,
      findingId: r.findingId,
      action: r.action,
      author: r.author,
      actorId: r.actorId ?? null,
      actorRole: r.actorRole ?? null,
      rationale: r.rationale,
      ruleVersion: r.ruleVersion,
      findingInputsDigest: r.findingInputsDigest ?? null,
      createdAt: r.createdAt,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  return computeCanonicalSha256({
    schema: 'nexofis-dossier-snapshot-v2',
    contractId: input.contractId.trim(),
    analystNote: input.analystNote.trim(),
    engineVersion: stableAssessment.engineVersion,
    contract: contractBase,
    assessment: stableAssessment,
    reviews: normalizedReviews,
  });
}

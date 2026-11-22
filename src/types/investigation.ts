import type { ContractRecord } from "./audit";

/** Documentary intelligence is kept outside public contract payloads. */
export interface InvestigationEvidence {
  id: string;
  sourceName: string;
  sourceKind: "official" | "intermediary" | "analyst_document";
  sourceUrl: string | null;
  retrievedAt: string;
  artifactSha256: string | null;
  locator: string;
}

export interface CompanyEvent {
  id: string;
  cnpj: string;
  kind:
    | "constitution"
    | "cnpj_registration"
    | "activity_start"
    | "shareholder_change"
    | "address_change"
    | "cnae_change"
    | "capital_change";
  date: string;
  evidenceIds: string[];
}

export interface InvestigationPerson {
  id: string;
  name: string;
  /** Opaque public-record reference; never a CPF or a hash derived from a CPF. */
  publicRecordId: string;
  identityStatus: "unresolved" | "documented";
  identityEvidenceIds: string[];
}

export interface DocumentedInterval {
  /** An unknown bound is null; it must never be treated as an infinite interval. */
  validFrom: string | null;
  validThrough: string | null;
  evidenceIds: string[];
}

export interface CorporateLink extends DocumentedInterval {
  id: string;
  personId: string;
  companyCnpj: string;
  role: "shareholder" | "administrator" | "legal_representative";
}

export interface PublicRoleLink extends DocumentedInterval {
  id: string;
  personId: string;
  entityId: string;
  contractId: string | null;
  role:
    | "director"
    | "procurement_agent"
    | "contract_manager"
    | "contract_inspector"
    | "elected_other";
}

export interface FamilyLink extends DocumentedInterval {
  id: string;
  personAId: string;
  personBId: string;
  relationship: "spouse" | "partner" | "consanguinity" | "affinity";
  degree: 1 | 2 | 3 | null;
  verification: "documented" | "unverified";
}

export interface CompetitionRecord {
  id: string;
  contractId: string;
  lotId: string;
  eventDate: string;
  bidderCnpjs: string[];
  evidenceIds: string[];
}

/** Versioned, analyst-supplied structured facts. Unknown fields must be rejected. */
export interface InvestigationDataset {
  schemaVersion: "1.0";
  purpose: string;
  legalBasis: string;
  evidence: InvestigationEvidence[];
  companyEvents: CompanyEvent[];
  people: InvestigationPerson[];
  corporateLinks: CorporateLink[];
  publicRoles: PublicRoleLink[];
  familyLinks: FamilyLink[];
  competitions: CompetitionRecord[];
}

export interface InvestigationCoverage {
  source: string;
  status: "complete_in_source" | "partial" | "unavailable" | "not_queried";
  queriedAt: string | null;
  periodFrom: string | null;
  periodThrough: string | null;
  description: string;
}

export interface InvestigationEngineInput {
  subject: ContractRecord;
  portfolio: ContractRecord[];
  dataset: InvestigationDataset | null;
  coverage: InvestigationCoverage[];
  /** Supplied only by the server after reading and re-hashing original bytes. */
  verifiedArtifactHashes: string[];
  evaluatedAt: string;
}

export interface InvestigationFinding {
  id: string;
  ruleCode: string;
  ruleVersion: string;
  state: "OBSERVATION" | "NOT_VERIFIABLE" | "NOT_APPLICABLE";
  priority: "high" | "medium" | "context";
  title: string;
  statement: string;
  calculation: string;
  evidenceIds: string[];
  alternativeHypotheses: string[];
  nextSteps: string[];
  limitation: string;
  inputDigest: string;
  targetIds: string[];
}

export interface InvestigationReport {
  schemaVersion: "1.0";
  engineVersion: string;
  contractId: string;
  supplierCnpj: string;
  evaluatedAt: string;
  inputDigest: string;
  metrics: {
    observedContractCount: number;
    observedPriorContractCount: number | null;
    observedBuyerCount: number;
    sameBuyerValueSharePct: number | null;
    portfolioExcludedCount: number;
    daysFromActivityStart: number | null;
  };
  coverage: InvestigationCoverage[];
  findings: InvestigationFinding[];
  timeline: Array<{
    id: string;
    date: string;
    label: string;
    evidenceIds: string[];
  }>;
  graph: {
    nodes: Array<{
      id: string;
      kind: "company" | "person" | "public_body" | "contract";
      label: string;
    }>;
    edges: Array<{
      id: string;
      from: string;
      to: string;
      kind: string;
      status: "documented" | "unresolved";
      evidenceIds: string[];
    }>;
  };
  evidence: InvestigationEvidence[];
  limitations: string[];
}

export interface InvestigationRevision {
  id: string;
  contractId: string;
  sequence: number;
  datasetDigest: string;
  previousEventHash: string | null;
  eventHash: string;
  actorId: string;
  actorRole: string;
  createdAt: string;
  rationale: string;
  dataset: InvestigationDataset;
}

export interface InvestigationReview {
  id: string;
  contractId: string;
  findingId: string;
  findingInputDigest: string;
  action: "dismiss" | "restore";
  rationale: string;
  actorId: string;
  actorRole: string;
  createdAt: string;
  sequence: number;
  previousEventHash: string | null;
  eventHash: string;
}

export interface InvestigationResponse {
  report: InvestigationReport;
  dataset: InvestigationDataset | null;
  currentRevision: Pick<
    InvestigationRevision,
    "id" | "sequence" | "datasetDigest" | "eventHash" | "createdAt"
  > | null;
  reviews: InvestigationReview[];
  integrity: { valid: boolean; eventCount: number; headHash: string | null };
}

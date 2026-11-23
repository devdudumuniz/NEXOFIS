export type CadastralEventType = 'constituicao' | 'inscricao_cnpj' | 'inicio_atividade';

export type CorporateChangeType = 'societario' | 'cnae' | 'endereco' | 'capital';

export type CorporateLinkRole = 'socio' | 'administrador' | 'representante_legal';

export type KinshipType = 'conjuge' | 'companheiro' | 'consanguinidade' | 'afinidade';

export type InvestigationTrailCode =
  | 'INV_CHRONOLOGY_INCOMPATIBLE'
  | 'INV_RECENT_COMPANY'
  | 'INV_RECENT_CORPORATE_CHANGE'
  | 'INV_SINGLE_OBSERVED_CONTRACT'
  | 'INV_BUYER_CONCENTRATION'
  | 'INV_CORPORATE_PUBLIC_FUNCTION_LINK'
  | 'INV_DOCUMENTED_KINSHIP_NEXUS'
  | 'INV_LOT_PARTICIPANT_SHARED_LINK';

export type InvestigationFindingStatus =
  | 'APONTAMENTO'
  | 'INCONSISTENCIA'
  | 'INCOMPLETO'
  | 'SEM_SINAL'
  | 'ORCAMENTO_EXCEDIDO';

export type InvestigationSeverity = 'CRÍTICA' | 'ALTA' | 'MÉDIA' | 'BAIXA';

export type InvestigationReviewAction = 'dismiss' | 'confirm' | 'restore';

export interface CadastralQsaMember {
  name: string;
  qualification: string;
  entryDate?: string | null;
  maskedDocument?: string | null;
  /** Public QSA data never resolves homonyms automatically */
  identityStatus: 'unresolved';
}

export interface CadastralMinimizedExtract {
  id: string;
  cnpj: string;
  sourceProvider: 'BrasilAPI';
  sourceType: 'provedor_intermediario';
  acquiredAt: string;
  acquiredBy: string;
  purpose: string;
  legalBasis: string;
  justification: string;
  legalName: string | null;
  registrationStatus: string | null;
  startActivityDate: string | null;
  primaryCnaeCode: string | null;
  primaryCnaeDescription: string | null;
  municipality: string | null;
  uf: string | null;
  shareCapital: number | null;
  qsa: CadastralQsaMember[];
  extractSha256: string;
}

export interface ObservedContractRecord {
  id: string;
  pncpControlNumber?: string | null;
  contractNumber: string;
  buyerKey: string;
  buyerName: string;
  municipalityIbge?: string | null;
  signatureDate: string | null;
  contractValue: number | null;
  hasValueDivergence?: boolean;
  sourceSystem: string;
}

export interface ObservedHistorySnapshot {
  updatedAt: string;
  updatedBy: string;
  supplierCnpj: string;
  sourcesChecked: string[];
  pncpStatus: 'complete' | 'partial' | 'rate_limited' | 'unavailable' | 'local_only';
  coverageNote: string;
  contracts: ObservedContractRecord[];
}

export interface CorporateDateFact {
  eventType: CadastralEventType;
  date: string;
  sourceLabel: string;
  evidenceRefs: string[];
}

export interface CorporateChangeEventFact {
  id: string;
  changeType: CorporateChangeType;
  date: string;
  description: string;
  isHistoricalDocumented: boolean;
  evidenceRefs: string[];
}

export interface DocumentedPerson {
  id: string;
  fullName: string;
  identityStatus: 'documented' | 'unresolved';
  documentBasis?: string;
  evidenceRefs: string[];
}

export interface CorporateLinkFact {
  id: string;
  personId: string;
  supplierCnpj: string;
  role: CorporateLinkRole;
  validFrom: string | null;
  validUntil: string | null;
  evidenceRefs: string[];
}

export interface PublicFunctionFact {
  id: string;
  personId: string;
  roleTitle: string;
  organName: string;
  organKey?: string;
  pertinentToContract: boolean;
  validFrom: string | null;
  validUntil: string | null;
  evidenceRefs: string[];
}

export interface KinshipRelationFact {
  id: string;
  personAId: string;
  personBId: string;
  relationType: KinshipType;
  degree: number | null;
  validFrom: string | null;
  validUntil: string | null;
  evidenceRefs: string[];
}

export interface LotParticipantFact {
  id: string;
  lotId: string;
  biddingDate: string;
  participantCnpj: string;
  participantName: string;
  linkedPersonIds: string[];
  evidenceRefs: string[];
}

export interface InvestigationFactSet {
  version: number;
  updatedAt: string;
  updatedBy: string;
  corporateDates: CorporateDateFact[];
  corporateChanges: CorporateChangeEventFact[];
  people: DocumentedPerson[];
  corporateLinks: CorporateLinkFact[];
  publicFunctions: PublicFunctionFact[];
  kinshipRelations: KinshipRelationFact[];
  lotParticipants: LotParticipantFact[];
}

export interface PrivateEvidenceRecord {
  id: string;
  contractId: string;
  sha256: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sourceLabel: string;
  description: string;
  acquiredAt: string;
  uploadedBy: string;
  exportFilename: string;
}

export interface InvestigationReviewRecord {
  id: string;
  contractId: string;
  findingId: string;
  action: InvestigationReviewAction;
  rationale: string;
  factsVersion: number;
  findingInputsDigest: string;
  actorId: string;
  actorName: string;
  actorRole: 'admin' | 'analyst' | 'viewer';
  createdAt: string;
}

export interface InvestigationEventRecord {
  seq: number;
  id: string;
  contractId: string;
  eventType:
    | 'CASE_INITIALIZED'
    | 'CADASTRAL_QUERY_RECORDED'
    | 'PNCP_HISTORY_SYNCED'
    | 'PRIVATE_EVIDENCE_UPLOADED'
    | 'FACTS_UPDATED'
    | 'FINDING_REVIEWED';
  actorId: string;
  actorName: string;
  actorRole: 'admin' | 'analyst' | 'viewer';
  factsVersion: number;
  payloadJson: string;
  prevHash: string;
  eventHash: string;
  createdAt: string;
}

export interface ChronologyDeltaItem {
  eventType: CadastralEventType;
  eventDate: string;
  signatureDate: string;
  deltaDays: number;
  band: 'incompativel' | '0-1' | '2-30' | '31-90' | '>90';
  sourceLabel: string;
}

export interface ObservedContractMetrics {
  totalObservedContracts: number;
  priorObservedContracts: number | null;
  distinctBuyersCount: number;
  investigatedBuyerContractsCount: number;
  investigatedBuyerSharePct: number | null;
  concentrationComputable: boolean;
  concentrationHaltReason: string | null;
  totalObservedContractualValue: number | null;
  sourcesCoverageNote: string;
}

export interface InvestigationFinding {
  findingId: string;
  trailCode: InvestigationTrailCode;
  title: string;
  severity: InvestigationSeverity;
  status: InvestigationFindingStatus;
  summary: string;
  metrics: Record<string, string | number | boolean | null>;
  ruleVersion: string;
  factsVersion: number;
  inputsDigest: string;
  evidenceRefs: string[];
  limitations: string[];
  suggestedDiligences: string[];
  activeReview: InvestigationReviewRecord | null;
  reviewIsCurrent: boolean;
  reviewStaleReason: string | null;
}

export interface InvestigationEvaluation {
  engineVersion: string;
  evaluatedAt: string;
  factsVersion: number;
  chronology: ChronologyDeltaItem[];
  observedMetrics: ObservedContractMetrics;
  findings: InvestigationFinding[];
  unresolvedIdentitiesCount: number;
  budgetExceeded: boolean;
  generalLimitations: string[];
}

export interface InvestigationCasePayload {
  contractId: string;
  contractSummary: {
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
  };
  factSet: InvestigationFactSet;
  cadastralExtracts: CadastralMinimizedExtract[];
  observedHistory: ObservedHistorySnapshot | null;
  privateEvidence: PrivateEvidenceRecord[];
  reviews: InvestigationReviewRecord[];
  events: InvestigationEventRecord[];
  chainVerification: {
    valid: boolean;
    eventCount: number;
    brokenAtSeq: number | null;
  };
  evaluation: InvestigationEvaluation;
}

export interface InvestigationExportPackage {
  schemaVersion: 'nexofis-investigation-pkg/1.0';
  exportedAt: string;
  engineVersion: string;
  contractSnapshot: InvestigationCasePayload['contractSummary'];
  factSet: InvestigationFactSet;
  cadastralExtracts: CadastralMinimizedExtract[];
  observedHistory: ObservedHistorySnapshot | null;
  privateEvidence: PrivateEvidenceRecord[];
  reviews: InvestigationReviewRecord[];
  events: InvestigationEventRecord[];
  evaluation: InvestigationEvaluation;
  packageDigestSha256: string;
}

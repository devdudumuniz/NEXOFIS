export type RiskSeverity = 'CRÍTICA' | 'ALTA' | 'MÉDIA' | 'BAIXA';

export type ExtractionMethod = 'native' | 'docling' | 'paddleocr';

export type FindingState =
  | 'CONFIRMED_DATA'
  | 'OBSERVATION'
  | 'INSUFFICIENT_EVIDENCE'
  | 'NOT_VERIFIABLE'
  | 'SOURCE_UNAVAILABLE'
  | 'NOT_APPLICABLE'
  | 'DISMISSED';

export type EvidenceLevel = 'A' | 'B' | 'C';

export interface TemporalLegalRule {
  ruleId: string;
  jurisdiction: string;
  legalBasis: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  applicabilityExpression: string;
  requiredEvidence: string[];
  severityIfConfirmed: RiskSeverity;
  severityIfUnverified: RiskSeverity;
  sourceVersionHash: string;
  supersedesRuleId: string | null;
  thresholds?: {
    dispensaObrasArt75I: number;
    dispensaServicosArt75II: number;
    dispensaVeiculosArt75P7: number;
    pequenasComprasArt95P2: number;
    grandeVulto: number;
  };
}

export interface Municipality {
  ibgeCode: string;
  name: string;
  uf: string;
  stateName: string;
  population?: number;
  populationYear?: number;
  populationByYear?: Record<number, { value: number; referenceDate: string }>;
  region?: string;
  source: 'IBGE API Oficial' | 'Base Oficial IBGE (Cache)';
}

export interface GovernmentEntity {
  id: string;
  ibgeCode: string;
  cnpj: string;
  name: string;
  shortName: string;
  entityType: 'Prefeitura' | 'Secretaria' | 'Fundo Municipal' | 'Autarquia';
  pncpOrgaoCode: string;
  pncpUnidadeCode: string;
  contractCount: number;
  totalValue: number;
  highRiskCount: number;
}

export interface Shareholder {
  name: string;
  role: string;
  maskedCpfCnpj: string;
  entryDate: string;
  isPublicServantOverlap?: boolean;
  overlapDetail?: string;
  localNepotismRuleVerified?: boolean;
}

export interface SanctionRecord {
  id: string;
  registry: 'CEIS' | 'CNEP' | 'CEPIM' | 'CEAF' | 'TCU-Inidôneos';
  sourceSystem: string;
  status: 'Ativa' | 'Encerrada';
  scope: 'Nacional' | 'Estadual' | 'Órgão Sancionador';
  scopeUf?: string;
  reason: string;
  sanctioningOrgan: string;
  startDate: string;
  endDate: string;
  sourceUrl: string;
}

export interface Supplier {
  cnpj: string;
  legalName: string;
  tradeName?: string;
  openingDate: string;
  registrationStatus: 'ATIVA' | 'INAPTA' | 'SUSPENSA' | 'BAIXADA';
  primaryCnaeCode: string;
  primaryCnaeDescription: string;
  secondaryCnaes: Array<{ code: string; description: string }>;
  shareCapital: number;
  municipality: string;
  uf: string;
  shareholders: Shareholder[];
  sanctions: SanctionRecord[];
  priorMunicipalContracts: number;
  simultaneousActiveContracts: number;
  dataProvenance: string;
}

export interface ContractItem {
  id: string;
  itemNumber: number;
  description: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  referencePrice: number;
  referenceSource: 'Painel de Preços' | 'SINAPI' | 'BPS Saúde' | 'Compras.gov' | 'Contrato Anterior' | 'Sem Referência';
  referenceDate: string;
  serviceClass?: string;
}

export interface ContractAmendment {
  id: string;
  number: string;
  date: string;
  type: 'Valor' | 'Prazo' | 'Valor e Prazo' | 'Supressão';
  addedValue: number;
  justification: string;
  documentId?: string;
  pageNumber?: number;
}

export interface PaymentRecord {
  id: string;
  documentNumber: string;
  date: string;
  type: 'Empenho' | 'Liquidação' | 'Pagamento' | 'Instrumento de Cobrança' | 'Entrega / Medição';
  amount: number;
  sourceSystem: string;
  fundingSource?: string;
  chronologicalPosition?: number;
  paidOutOfOrder?: boolean;
  outOfOrderJustification?: string;
  justificationPublished?: boolean;
}

export interface SourceRecord {
  id: string;
  sourceSystem:
    | 'PNCP'
    | 'Portal da Transparência Municipal'
    | 'TCE-BA'
    | 'TCE-SP'
    | 'TCE-PR'
    | 'TCE-RS'
    | 'SICONFI'
    | 'Transferegov'
    | 'Diário Oficial Municipal'
    | 'PDF Importado';
  externalId: string;
  retrievedAt: string;
  effectiveAt?: string;
  rawPayloadHash?: string;
  parserVersion?: string;
  reportedOriginalValue: number;
  reportedUpdatedValue: number;
  reportedSupplierCnpj: string;
  reportedStatus: string;
  reportedEndDate: string;
  sourceUrl: string;
  notes?: string;
}

export interface DocumentPage {
  pageNumber: number;
  extractionMethod: ExtractionMethod;
  text: string;
  confidence: number;
  highlights: Array<{
    field: string;
    excerpt: string;
    normalizedValue: string;
    coordinates?: string;
  }>;
}

export interface DocumentRecord {
  id: string;
  title: string;
  documentType: 'Contrato Original' | 'Termo Aditivo' | 'Edital / TR' | 'Nota de Empenho' | 'Extrato Oficial' | 'Documento Importado';
  sourceUrl: string;
  sourceSystem: string;
  retrievedAt: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  extractionSummary: {
    totalPages: number;
    nativePages: number;
    doclingPages: number;
    ocrPages: number;
    extractorVersion: string;
  };
  pages: DocumentPage[];
}

export interface ProductivityMetric {
  domain: 'Merenda Escolar' | 'Pavimentação' | 'Transporte Escolar' | 'Medicamentos' | 'Saúde' | 'Coleta de Lixo' | 'Obras' | 'Software Público';
  unitLabel: string;
  deliveredOutput: number;
  contractedOutput: number;
  actualUnitCost: number;
  benchmarkUnitCost: number;
  benchmarkSource: string;
  physicalProgressPct?: number;
  financialProgressPct?: number;
  populationInContractYear?: number;
  populationYear?: number;
}

export interface BenchmarkPeer {
  id: string;
  municipalityName: string;
  uf: string;
  contractNumber: string;
  contractYear: number;
  sameSupplier: boolean;
  serviceClass: string;
  unitLabel: string;
  nominalUnitPrice: number;
  inflationAdjustedPrice: number;
  scopeDistance: number;
  slaComparable: boolean;
  licensingComparable: boolean;
  included: boolean;
  exclusionReason?: string;
}

export interface HorizontalBenchmarkResult {
  ruleId: string;
  state: FindingState;
  evidenceLevel: EvidenceLevel;
  confidence: number;
  serviceClass: string;
  unitLabel: string;
  subjectNominalPrice: number;
  subjectAdjustedPrice: number;
  inflationIndexApplied: string;
  peerCount: number;
  excludedPeerCount: number;
  peerMedian: number | null;
  mad: number | null;
  robustZ: number | null;
  peerRatio: number | null;
  statement: string;
  notAConclusion: string;
  controls: {
    inflation: string;
    scope: string;
    sla: string;
    licensing: string;
  };
  peers: BenchmarkPeer[];
}

export interface EvidenceItem {
  id: string;
  indicatorCode: string;
  ruleVersion: string;
  legalRulesetVersion: string;
  sourceSystem: string;
  documentId: string;
  documentTitle: string;
  pageNumber: number;
  excerpt: string;
  coordinates?: string;
  normalizedValue: string;
  calculation: string;
  sha256: string;
  retrievedAt: string;
}

export interface RiskIndicator {
  findingId: string;
  code: string;
  ruleVersion: string;
  legalRulesetVersion: string;
  framework:
    | 'Estatístico (Mediana/MAD)'
    | 'Regra Jurídica Temporal'
    | 'Execução Financeira'
    | 'Produtividade'
    | 'Integridade / Sanções';
  state: FindingState;
  evidenceLevel: EvidenceLevel;
  confidence: number;
  title: string;
  severity: RiskSeverity;
  weightPoints: number;
  summary: string;
  notAConclusion: string;
  alternativeHypotheses: string[];
  dataUsed: string;
  source: string;
  calculation: string;
  legalReference?: string;
  evidenceIds: string[];
}

export interface SourceDivergence {
  field: string;
  sources: Array<{ sourceSystem: string; value: string }>;
  severity: RiskSeverity;
  deltaDescription: string;
}

export interface ExecutionChainSummary {
  contractedObligation: number;
  estimatedMonthlyContractValue: number;
  contractDurationMonths: number;
  committedTotal: number;
  liquidatedTotal: number;
  paidTotal: number;
  billedTotal: number;
  deliveredVerifiedTotal: number;
  provenExecutionAvailable: boolean;
  chronologicalOrderStatus: 'valid_sequence' | 'justified_exception' | 'unexplained_break' | 'not_verifiable';
}

export interface RiskAssessment {
  score: number;
  classification:
    | 'Revisão humana prioritária'
    | 'Revisão humana recomendada'
    | 'Atenção moderada'
    | 'Conformidade preliminar';
  headline: string;
  variationPct: number;
  amendmentTotalPct: number;
  weightedPriceDeviationPct: number;
  appliedLegalRuleset: TemporalLegalRule;
  executionChain: ExecutionChainSummary;
  horizontalBenchmark?: HorizontalBenchmarkResult;
  indicators: RiskIndicator[];
  nonApplicableChecks: Array<{
    code: string;
    title: string;
    state: FindingState;
    rationale: string;
  }>;
  evidences: EvidenceItem[];
  divergences: SourceDivergence[];
  evaluatedAt: string;
  engineVersion: string;
}

export interface ContractRecord {
  id: string;
  pncpControlNumber: string;
  contractNumber: string;
  year: number;
  municipalityIbge: string;
  municipalityName: string;
  uf: string;
  entityId: string;
  entityName: string;
  modality: 'Pregão Eletrônico' | 'Dispensa de Licitação' | 'Inexigibilidade' | 'Concorrência';
  executionRegime?: 'Empreitada por Preço Unitário' | 'Empreitada Global' | 'Integrado' | 'Semi-integrado' | 'Fornecimento Contínuo';
  dispensationArticle?: 'art75_I' | 'art75_II' | 'art75_p7' | 'art95_p2';
  branchClassificationRule?: string;
  branchClassificationUncertain?: boolean;
  riskMatrixPresent?: boolean;
  performanceBondPresent?: boolean;
  biddersCount: number;
  object: string;
  objectCategory: string;
  expectedCnaePrefixes: string[];
  signatureDate: string;
  startDate: string;
  endDate: string;
  originalValue: number;
  updatedValue: number;
  status: 'Vigente' | 'Encerrado' | 'Suspenso' | 'Em Execução';
  legalDispensationLimit?: number;
  relatedSameObjectCount12m?: number;
  relatedSameObjectTotal12m?: number;
  relatedSameObjectSameFiscalYear?: boolean;
  relatedSameBranch?: boolean;
  supplier: Supplier;
  items: ContractItem[];
  amendments: ContractAmendment[];
  payments: PaymentRecord[];
  sourceRecords: SourceRecord[];
  documents: DocumentRecord[];
  productivity?: ProductivityMetric;
  benchmarkPeers?: {
    serviceClass: string;
    unitLabel: string;
    subjectNominalPrice: number;
    inflationIndexLabel: string;
    peers: BenchmarkPeer[];
  };
  dataSourceOrigin: 'PNCP API Oficial' | 'Espelho Municipal Licitarium' | 'Upload Documental';
}

export interface EvaluatedContract extends ContractRecord {
  assessment: RiskAssessment;
}

export interface OCDSRelease {
  ocid: string;
  id: string;
  date: string;
  tag: string[];
  initiationType: 'tender';
  buyer: {
    id: string;
    name: string;
  };
  planning: {
    budget: {
      amount: { amount: number; currency: 'BRL' };
      project: string;
    };
  };
  tender: {
    id: string;
    title: string;
    procurementMethodDetails: string;
    numberOfTenderers: number;
    value: { amount: number; currency: 'BRL' };
  };
  awards: Array<{
    id: string;
    status: string;
    date: string;
    value: { amount: number; currency: 'BRL' };
    suppliers: Array<{ id: string; name: string }>;
  }>;
  contracts: Array<{
    id: string;
    awardID: string;
    title: string;
    status: string;
    period: { startDate: string; endDate: string };
    value: { amount: number; currency: 'BRL' };
    amendments: Array<{
      id: string;
      date: string;
      rationale: string;
      description: string;
    }>;
  }>;
  implementation: {
    transactions: Array<{
      id: string;
      date: string;
      value: { amount: number; currency: 'BRL' };
      payer: { name: string };
      payee: { name: string };
    }>;
  };
}

export interface SavedDossierSummary {
  id: string;
  contractId: string;
  contractNumber: string;
  municipalityName: string;
  municipalityIbge: string;
  entityName: string;
  supplierName: string;
  riskScore: number;
  savedAt: string;
  analystNote: string;
  sha256Digest: string;
}

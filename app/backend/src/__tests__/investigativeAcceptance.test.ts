import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildInvestigationExportPackage,
  createEmptyFactSet,
  evaluateForensicInvestigation,
  verifyCaseLedgerIntegrity,
  verifyInvestigationPackage,
} from '@nexofis/shared/lib/forensicInvestigationEngine';
import {
  assessTemporalAssertionOverlap,
  buildReverseParticipationIndex,
  disambiguatePersonQuery,
  expandTemporalNetworkGraph,
  preserveMaskedCpfWithoutReconstruction,
} from '@nexofis/shared/lib/temporalIdentityGraph';
import {
  evaluateAppointmentNepotismTrail,
  evaluateContractConflictTrail,
  evaluateDocumentedKinshipTrail,
  evaluateRoleLegalRequirementsTrail,
  parseCamaraDailyPersonnelSnapshot,
} from '@nexofis/shared/lib/publicIntegrityTrails';
import {
  computePairedDidEffect,
  evaluateOutcomeClaim,
  importInepPublicExport,
  importSiapsPublicExport,
  reconcileSiconfiExecution,
  validateDidDesign,
  type IndicatorDefinition,
  type IndicatorObservation,
  type OutcomeClaim,
} from '@nexofis/shared/lib/outcomesEvaluationEngine';
import {
  evaluateInvestigativePriceComparison,
  type ComparablePricePeerInput,
  type PriceComparabilityProfile,
} from '@nexofis/shared/lib/benchmarkEngine';
import {
  auditEditalCommunicationChannels,
  evaluateParticipationChannels,
} from '@nexofis/shared/lib/participationChannelEvaluator';
import {
  executeKinshipOfficeContractQuery,
  executeMultiHopCorporateNetworkQuery,
  generateForensicCypherScript,
  type ForensicGraphSnapshot,
} from '@nexofis/shared/lib/forensicGraphCypher';
import { importSinapiOfficialFile } from '@nexofis/backend/connectors/sinapiImporter';
import { selectActivePncpItemWinningSupplier } from '@nexofis/backend/pncpClient';
import {
  createObservabilityRegistry,
  sanitizeLogPayload,
  validateSafeExternalUrl,
  validateSafeRedirectTarget,
} from '@nexofis/backend/securityGuards';
import { createNexofisStore } from '@nexofis/backend/storage';
import type { SupplierQsaRecord } from '@nexofis/shared/lib/partnerNetworkGraph';

const SYNTH_CNPJ_A = '11222333000181';
const SYNTH_CNPJ_B = '11444777000161';
const SYNTH_CNPJ_HOLDING = '34028316000103';

function makeQsa(
  cnpj: string,
  legalName: string,
  shareholders: SupplierQsaRecord['shareholders'],
  fetchedAt = '2026-06-15T10:00:00.000Z'
): SupplierQsaRecord {
  return {
    cnpj,
    legalName,
    registrationStatus: 'ATIVA',
    openingDate: '2020-01-10',
    primaryCnaeCode: '6201-5/01',
    primaryCnaeDescription: 'Desenvolvimento de software',
    municipality: 'SALVADOR',
    uf: 'BA',
    shareCapital: 100000,
    shareholders,
    sourceProvider: 'BrasilAPI CNPJ (sintético)',
    fetchedAt,
  };
}

test('1. Homônimos e colisões parciais de CPF nunca são fundidos como chave conclusiva e exigem desambiguação', () => {
  const qsaList: SupplierQsaRecord[] = [
    makeQsa(SYNTH_CNPJ_A, 'ALFA SERVICOS LTDA', [
      {
        name: 'JOAO CARLOS SILVA',
        role: 'Sócio-Administrador',
        entryDate: '2021-03-01',
        maskedDocument: '***123456**',
        partnerType: 'PF',
      },
    ]),
    makeQsa(SYNTH_CNPJ_B, 'BETA GESTAO LTDA', [
      {
        name: 'JOAO CARLOS SILVA',
        role: 'Sócio',
        entryDate: '2022-04-10',
        maskedDocument: '***987654**',
        partnerType: 'PF',
      },
    ]),
  ];

  const revIndex = buildReverseParticipationIndex(qsaList);
  const dis = disambiguatePersonQuery('Joao Carlos Silva', revIndex);

  assert.equal(dis.requiresDisambiguation, true);
  assert.equal(dis.candidateCount, 2, 'Homônimos com CPFs parciais distintos devem permanecer separados');
  assert.equal(preserveMaskedCpfWithoutReconstruction('***123456**'), '***123456**');
  // Never reconstruct or expose full 11-digit CPF
  assert.equal(preserveMaskedCpfWithoutReconstruction('123.456.789-01'), '***456789**');
});

test('2. Coincidência de endereço ou sobrenome não cria parentesco confirmado', () => {
  const res = evaluateDocumentedKinshipTrail([
    {
      id: 'k1',
      personA: { personId: 'p1', fullName: 'MARIA OLIVEIRA', identityStatus: 'resolved_documentary' },
      personB: { personId: 'p2', fullName: 'CARLOS OLIVEIRA', identityStatus: 'resolved_documentary' },
      relationType: 'coincidencia_nome_endereco',
      degree: null,
      explicitDocumentarySource: 'Mesmo sobrenome e endereço comercial',
      evidenceRefs: ['ev-1'],
      basedOnlyOnNameOrAddress: true,
    },
  ]);

  assert.equal(res.status, 'SEM_PARENTESCO_COMPROVADO');
  assert.equal(res.conclusiveFraudAssertion, false);
  assert.equal(res.findings[0].code, 'KINSHIP_NAME_ADDRESS_REJECTED');
});

test('3. Vínculo fora do período contratual ou de nomeação retorna FORA_DO_PERIODO', () => {
  const res = evaluateContractConflictTrail([
    {
      contractId: 'CTR-2025-01',
      contractSignatureDate: '2025-06-15',
      contractOrganKey: 'prefeitura-exemplo',
      contractJurisdiction: 'Município Exemplo/BA',
      supplierCnpj: SYNTH_CNPJ_A,
      corporateLink: {
        person: { personId: 'p1', fullName: 'ANA PEREIRA', identityStatus: 'resolved_documentary' },
        role: 'Sócio-Administrador',
        startDate: '2020-01-01',
        endDate: '2023-12-31',
        endSemantics: 'confirmed_end',
        evidenceRefs: ['junta-alteracao-2024'],
      },
      appointment: {
        id: 'app-1',
        person: { personId: 'p1', fullName: 'ANA PEREIRA', identityStatus: 'resolved_documentary' },
        actReference: 'Portaria 10/2025',
        appointingAuthority: { personId: 'auth-1', fullName: 'PREFEITO X', identityStatus: 'resolved_documentary' },
        roleTitle: 'Secretária de Saúde',
        bondNature: 'comissionado',
        lotacao: 'SMS',
        organKey: 'prefeitura-exemplo',
        jurisdiction: 'Município Exemplo/BA',
        startDate: '2025-01-01',
        endDate: null,
        endSemantics: 'ongoing_undocumented',
        sourceLabel: 'DOM',
        evidenceRefs: ['dom-2025-01'],
      },
      pertinentToContract: true,
    },
  ]);

  assert.equal(res.status, 'FORA_DO_PERIODO');
  assert.equal(res.findings[0].code, 'CONFLICT_OUTSIDE_PERIOD');
});

test('4. Data de término desconhecida é diferenciada de vínculo sem termo final e bloqueia conclusão temporal', () => {
  const unknownEndCheck = assessTemporalAssertionOverlap({
    temporal: {
      startDate: '2022-01-10',
      startPrecision: 'day',
      endDate: null,
      endPrecision: 'unknown',
      endSemantics: 'unknown_end',
      isProvenHistorical: false,
    },
    referenceDate: '2025-08-20',
  });

  const ongoingCheck = assessTemporalAssertionOverlap({
    temporal: {
      startDate: '2022-01-10',
      startPrecision: 'day',
      endDate: null,
      endPrecision: 'unknown',
      endSemantics: 'ongoing_undocumented',
      isProvenHistorical: false,
    },
    referenceDate: '2025-08-20',
  });

  assert.equal(unknownEndCheck.status, 'unknown_end_requires_verification');
  assert.equal(unknownEndCheck.canSupportPeriodConclusion, false);
  assert.equal(ongoingCheck.status, 'ongoing_observed_not_retroprojected');
  assert.equal(ongoingCheck.canSupportPeriodConclusion, false);
});

test('5. Cargo sem exigência legal de graduação retorna CONFORME_NO_ESCOPO sem acusação indevida', () => {
  const res = evaluateRoleLegalRequirementsTrail({
    appointment: {
      id: 'app-2',
      person: { personId: 'p2', fullName: 'ROBERTO LIMA', identityStatus: 'resolved_documentary' },
      actReference: 'Decreto 45/2025',
      appointingAuthority: { personId: 'auth-1', fullName: 'PREFEITO X', identityStatus: 'resolved_documentary' },
      roleTitle: 'Assessor Especial',
      bondNature: 'comissionado',
      lotacao: 'Gabinete',
      organKey: 'gabinete',
      jurisdiction: 'Município Exemplo/BA',
      startDate: '2025-02-01',
      endDate: null,
      endSemantics: 'ongoing_undocumented',
      sourceLabel: 'DOM',
      evidenceRefs: ['dom-45'],
    },
    applicableLaw: {
      lawReference: 'Lei Municipal 1.234/2021',
      amendmentsApplied: [],
      jurisdiction: 'Município Exemplo/BA',
      effectiveFrom: '2021-01-01',
      effectiveUntil: null,
      roleTitle: 'Assessor Especial',
      requiresGraduation: false,
      expressRequirements: [],
    },
    evidences: [],
  });

  assert.equal(res.status, 'CONFORME_NO_ESCOPO');
  assert.equal(res.findings[0].code, 'ROLE_NO_GRADUATION_REQUIRED');
});

test('6. Documentação de formação ausente é tratada como DESCONHECIDO e distinta de incompatibilidade documentada', () => {
  const baseLaw = {
    lawReference: 'Lei Municipal 2.000/2022',
    amendmentsApplied: ['Lei 2.050/2024'],
    jurisdiction: 'Município Exemplo/BA',
    effectiveFrom: '2022-01-01',
    effectiveUntil: null,
    roleTitle: 'Diretor Técnico de Engenharia',
    requiresGraduation: true,
    expressRequirements: ['Graduação em Engenharia Civil com registro ativo no CREA'],
  };
  const appt = {
    id: 'app-3',
    person: { personId: 'p3', fullName: 'LUCAS MELO', identityStatus: 'resolved_documentary' as const },
    actReference: 'Portaria 88/2025',
    appointingAuthority: { personId: 'auth-1', fullName: 'PREFEITO X', identityStatus: 'resolved_documentary' as const },
    roleTitle: 'Diretor Técnico de Engenharia',
    bondNature: 'comissionado' as const,
    lotacao: 'SEINFRA',
    organKey: 'seinfra',
    jurisdiction: 'Município Exemplo/BA',
    startDate: '2025-03-01',
    endDate: null,
    endSemantics: 'ongoing_undocumented' as const,
    sourceLabel: 'DOM',
    evidenceRefs: ['dom-88'],
  };

  const missingDocRes = evaluateRoleLegalRequirementsTrail({
    appointment: appt,
    applicableLaw: baseLaw,
    evidences: [
      {
        requirementLabel: 'Graduação em Engenharia Civil com registro ativo no CREA',
        evidenceStatus: 'missing_document',
      },
    ],
  });
  assert.equal(missingDocRes.status, 'DESCONHECIDO_DOCUMENTO_AUSENTE');

  const incompatibleRes = evaluateRoleLegalRequirementsTrail({
    appointment: appt,
    applicableLaw: baseLaw,
    evidences: [
      {
        requirementLabel: 'Graduação em Engenharia Civil com registro ativo no CREA',
        evidenceStatus: 'documented_not_met',
        documentRef: 'certidao-crea-negativa.pdf',
        notes: 'Registro inexistente no conselho de classe conforme certidão oficial',
      },
    ],
  });
  assert.equal(incompatibleRes.status, 'INCOMPATIBILIDADE_DOCUMENTADA');
  assert.equal(incompatibleRes.requiresLegalReview, true);
});

test('7. Indicador não publicado nunca é convertido em zero', () => {
  const siaps = importSiapsPublicExport({
    filename: 'siaps-2026-q1.csv',
    defaultMethodologyVersion: 'siaps-2025.v2',
    rawCsv: [
      'ibge;indicador;competencia;numerador;denominador;resultado;publicacao',
      '2902906;SIAPS_PRE_NATAL;2026-Q1;;;Nao Publicado;',
    ].join('\n'),
  });

  assert.equal(siaps.rowCount, 1);
  assert.equal(siaps.unpublishedCount, 1);
  assert.equal(siaps.observations[0].value, null);
  assert.equal(siaps.observations[0].isPublished, false);

  const def: IndicatorDefinition = {
    indicatorId: 'SIAPS_PRE_NATAL',
    name: 'Proporção de gestantes com 6+ consultas',
    domain: 'saude',
    sourceSystem: 'SIAPS',
    methodologyVersion: 'siaps-2025.v2',
    unit: '%',
    population: 'Gestantes SUS',
    territoryCode: '2902906',
    periodicity: 'quadrimestral',
    improvementDirection: 'higher_is_better',
  };

  const claim: OutcomeClaim = {
    claimId: 'claim-1',
    contractId: 'CTR-SAUDE-01',
    sourceExcerptRef: 'Cláusula 3.1',
    promisedDeliverableOrOutcome: 'Apoio à atenção primária',
    indicatorId: 'SIAPS_PRE_NATAL',
    expectedMethodologyVersion: 'siaps-2025.v2',
    unit: '%',
    population: 'Gestantes SUS',
    territoryCode: '2902906',
    baselineValue: 48,
    baselineCompetencia: '2025-Q2',
    targetValue: 65,
    targetDeadlineDate: '2026-12-31',
    contractSignatureDate: '2025-11-23',
    effectiveServiceStartDate: '2026-01-02',
    improvementDirection: 'higher_is_better',
    sourceSystem: 'SIAPS',
    evidenceRefs: ['termo-ref'],
  };

  const run = evaluateOutcomeClaim({
    claim,
    definition: def,
    observations: siaps.observations,
    evaluationDate: '2026-05-10',
  });

  assert.equal(run.status, 'NAO_PUBLICADO');
  assert.equal(run.dimensions.B_targetAttainment.latestObservedValue, null);
  assert.equal(run.serviceClassifiedAsFictitious, false);
});

test('8. Metodologia alterada bloqueia comparação automática de séries incompatíveis', () => {
  const def: IndicatorDefinition = {
    indicatorId: 'SIAPS_CITOPATOLOGICO',
    name: 'Cobertura citopatológico',
    domain: 'saude',
    sourceSystem: 'SIAPS',
    methodologyVersion: 'siaps-2026.v3',
    unit: '%',
    population: 'Mulheres 25-64',
    territoryCode: '2902906',
    periodicity: 'quadrimestral',
    improvementDirection: 'higher_is_better',
  };
  const claim: OutcomeClaim = {
    claimId: 'claim-met',
    contractId: 'CTR-SAUDE-02',
    sourceExcerptRef: 'Anexo I',
    promisedDeliverableOrOutcome: 'Ampliação cobertura preventiva',
    indicatorId: 'SIAPS_CITOPATOLOGICO',
    expectedMethodologyVersion: 'previne-2024.v1',
    unit: '%',
    population: 'Mulheres 25-64',
    territoryCode: '2902906',
    baselineValue: 40,
    baselineCompetencia: '2024-Q3',
    targetValue: 60,
    targetDeadlineDate: '2026-12-31',
    contractSignatureDate: '2025-11-23',
    effectiveServiceStartDate: '2026-01-01',
    improvementDirection: 'higher_is_better',
    sourceSystem: 'SIAPS',
    evidenceRefs: ['ev-1'],
  };
  const obs: IndicatorObservation[] = [
    {
      observationId: 'obs-1',
      indicatorId: 'SIAPS_CITOPATOLOGICO',
      methodologyVersion: 'siaps-2026.v3',
      territoryCode: '2902906',
      competencia: '2026-Q1',
      periodEndDate: '2026-04-30',
      publishedAt: '2026-06-01',
      collectedAt: '2026-06-15',
      revision: 'original',
      numerator: 600,
      denominator: 1000,
      value: 60,
      isPublished: true,
    },
  ];

  const run = evaluateOutcomeClaim({
    claim,
    definition: def,
    observations: obs,
    evaluationDate: '2026-11-23',
  });

  assert.equal(run.status, 'METODOLOGIA_ALTERADA');
  assert.equal(run.dimensions.B_targetAttainment.status, 'METODOLOGIA_INCOMPATIVEL');
});

test('9. Janela pós-contrato incompleta (assinatura 23/11/2025 e avaliação 23/11/2026) declara avaliação interina', () => {
  const def: IndicatorDefinition = {
    indicatorId: 'SIAPS_HIPERTENSAO',
    name: 'Acompanhamento hipertensão',
    domain: 'saude',
    sourceSystem: 'SIAPS',
    methodologyVersion: 'siaps-2025.v2',
    unit: '%',
    population: 'Hipertensos cadastrados',
    territoryCode: '2902906',
    periodicity: 'quadrimestral',
    improvementDirection: 'higher_is_better',
  };
  const claim: OutcomeClaim = {
    claimId: 'claim-interim',
    contractId: 'CTR-2025-11-23',
    sourceExcerptRef: 'Cláusula 4',
    promisedDeliverableOrOutcome: 'Apoio operacional à APS',
    indicatorId: 'SIAPS_HIPERTENSAO',
    expectedMethodologyVersion: 'siaps-2025.v2',
    unit: '%',
    population: 'Hipertensos cadastrados',
    territoryCode: '2902906',
    baselineValue: 45,
    baselineCompetencia: '2025-Q2',
    targetValue: 60,
    targetDeadlineDate: '2026-12-31',
    contractSignatureDate: '2025-11-23',
    effectiveServiceStartDate: '2026-01-05',
    improvementDirection: 'higher_is_better',
    sourceSystem: 'SIAPS',
    evidenceRefs: ['contrato-pdf'],
    validatedDeliveriesCount: 8,
    promisedDeliveriesCount: 10,
    validatedPaymentsAmount: 160000,
  };
  const obs: IndicatorObservation[] = [
    {
      observationId: 'obs-q1',
      indicatorId: 'SIAPS_HIPERTENSAO',
      methodologyVersion: 'siaps-2025.v2',
      territoryCode: '2902906',
      competencia: '2026-Q1',
      periodEndDate: '2026-04-30',
      publishedAt: '2026-06-15',
      collectedAt: '2026-11-23',
      revision: 'original',
      numerator: 520,
      denominator: 1000,
      value: 52,
      isPublished: true,
    },
    {
      observationId: 'obs-q2',
      indicatorId: 'SIAPS_HIPERTENSAO',
      methodologyVersion: 'siaps-2025.v2',
      territoryCode: '2902906',
      competencia: '2026-Q2',
      periodEndDate: '2026-08-31',
      publishedAt: '2026-10-15',
      collectedAt: '2026-11-23',
      revision: 'original',
      numerator: 560,
      denominator: 1000,
      value: 56,
      isPublished: true,
    },
  ];

  const run = evaluateOutcomeClaim({
    claim,
    definition: def,
    observations: obs,
    evaluationDate: '2026-11-23',
  });

  assert.equal(run.status, 'AVALIACAO_INTERINA');
  assert.equal(run.isInterimEvaluation, true);
  assert.equal(run.latestPublishedCompetencia, '2026-Q2');
  assert.equal(run.effectiveInterventionStartDate, '2026-01-05');
  assert.equal(run.dimensions.D_costPerValidatedDelivery.costPerUnit, 20000);
});

test('10. Melhora observada sem atribuição causal e bloqueio de controle sintético simulado por média de vizinhos', () => {
  const def: IndicatorDefinition = {
    indicatorId: 'IDEB_ANOS_INICIAIS',
    name: 'IDEB Anos Iniciais',
    domain: 'educacao',
    sourceSystem: 'INEP',
    methodologyVersion: 'inep-2025',
    unit: 'pontos',
    population: 'Rede municipal',
    territoryCode: '2902906',
    periodicity: 'bienal',
    improvementDirection: 'higher_is_better',
  };
  const claim: OutcomeClaim = {
    claimId: 'claim-edu',
    contractId: 'CTR-EDU-01',
    sourceExcerptRef: 'Cláusula 2',
    promisedDeliverableOrOutcome: 'Formação docente',
    indicatorId: 'IDEB_ANOS_INICIAIS',
    expectedMethodologyVersion: 'inep-2025',
    unit: 'pontos',
    population: 'Rede municipal',
    territoryCode: '2902906',
    baselineValue: 4.8,
    baselineCompetencia: '2023',
    targetValue: 5.2,
    targetDeadlineDate: '2025-12-31',
    contractSignatureDate: '2024-01-10',
    effectiveServiceStartDate: '2024-02-01',
    improvementDirection: 'higher_is_better',
    sourceSystem: 'INEP',
    evidenceRefs: ['edital-edu'],
  };
  const obs: IndicatorObservation[] = [
    {
      observationId: 'obs-2025',
      indicatorId: 'IDEB_ANOS_INICIAIS',
      methodologyVersion: 'inep-2025',
      territoryCode: '2902906',
      competencia: '2025',
      periodEndDate: '2025-12-31',
      publishedAt: '2026-08-15',
      collectedAt: '2026-09-01',
      revision: 'original',
      numerator: null,
      denominator: null,
      value: 5.4,
      isPublished: true,
    },
  ];

  const descriptiveRun = evaluateOutcomeClaim({
    claim,
    definition: def,
    observations: obs,
    evaluationDate: '2026-09-01',
  });
  assert.equal(descriptiveRun.dimensions.C_attributableEffect.status, 'MELHORA_OBSERVADA_SEM_ATRIBUICAO_CAUSAL');
  assert.equal(descriptiveRun.dimensions.C_attributableEffect.causalAttributionClaimed, false);

  const fakeSynth = validateDidDesign({
    comparisonGroupJustification: 'Média simples de 3 municípios vizinhos',
    prePeriodTreatedCount: 4,
    prePeriodControlCount: 4,
    postPeriodTreatedCount: 1,
    postPeriodControlCount: 1,
    preTrendsTested: true,
    preTrendsParallel: true,
    explicitAssumptions: ['tendências paralelas'],
    uncertaintyReported: true,
    requestedMethod: 'synthetic_control',
    usesSimpleNeighborAverageAsSyntheticControl: true,
  });
  assert.equal(fakeSynth.eligible, false);
});

test('11 & 12. Comparação de preços exclui unidade incompatível e frete/serviço embutido não comparável + importador SINAPI real', () => {
  const sinapi = importSinapiOfficialFile({
    filename: 'SINAPI_Ref_Insumos_BA_202604_NaoDesonerado.csv',
    uf: 'BA',
    competencia: '2026-04',
    edition: '2026-04',
    taxRegime: 'nao_desonerado',
    defaultKind: 'insumo',
    rawBuffer: [
      'CODIGO;DESCRICAO;UNIDADE;PRECO MEDIANO',
      '00001379;CIMENTO PORTLAND CP II-32;KG;0,82',
      '00000370;AREIA MEDIA POSTO JAZIDA;M3;95,50',
    ].join('\n'),
  });
  assert.equal(sinapi.itemCount, 2);
  assert.equal(sinapi.originalFileSha256.length, 64);

  const subjectProfile: PriceComparabilityProfile = {
    specification: 'Cimento Portland CP II-32 saco 50kg',
    unitLabel: 'KG',
    quantity: 1000,
    uf: 'BA',
    competencia: '2026-04',
    deliveryCondition: 'Posto obra sede',
    includesFreight: false,
    includesInstallationOrService: false,
    includesTaxesAndCharges: true,
    itemKind: 'insumo',
    referenceSource: 'Contrato analisado',
    referenceVersion: '2026-04',
  };

  const makePeer = (
    idx: number,
    overrides?: Partial<ComparablePricePeerInput> & { profileOverrides?: Partial<PriceComparabilityProfile> }
  ): ComparablePricePeerInput => {
    const { profileOverrides, ...peerOverrides } = overrides ?? {};
    return {
      id: peerOverrides.id ?? `peer-${idx}`,
      municipalityName: `Município ${idx}`,
      uf: 'BA',
      contractNumber: `CTR-${idx}/2026`,
      contractYear: 2026,
      serviceClass: 'INSUMO_OBRA',
      unitLabel: profileOverrides?.unitLabel ?? 'KG',
      nominalUnitPrice: peerOverrides.nominalUnitPrice ?? 0.85,
      inflationAdjustedPrice: peerOverrides.nominalUnitPrice ?? 0.85,
      scopeDistance: 0.05,
      slaComparable: true,
      licensingComparable: true,
      sameSupplier: false,
      included: true,
      ...peerOverrides,
      profile: {
        ...subjectProfile,
        referenceSource: 'SINAPI',
        referenceVersion: '2026-04-BA',
        ...(profileOverrides ?? {}),
      },
    };
  };

  const comparison = evaluateInvestigativePriceComparison({
    serviceClass: 'INSUMO_OBRA',
    subjectNominalPrice: 1.95,
    subjectYear: 2026,
    subjectProfile,
    inflationIndexLabel: 'IPCA-2026',
    peers: [
      makePeer(1, { profileOverrides: { unitLabel: 'SACO_50KG' } }), // incompatible unit without conversion
      makePeer(2, { profileOverrides: { includesFreight: true } }), // bundled freight
      makePeer(3, { profileOverrides: { includesInstallationOrService: true } }), // bundled service
      makePeer(4, { profileOverrides: { itemKind: 'composicao' } }), // insumo vs composicao
      makePeer(5, { nominalUnitPrice: 0.82 }),
      makePeer(6, { nominalUnitPrice: 0.84 }),
      makePeer(7, { nominalUnitPrice: 0.86 }),
      makePeer(8, { nominalUnitPrice: 0.88 }),
    ],
  });

  assert.equal(comparison.includedPeers.length, 4);
  assert.equal(comparison.excludedPeers.length, 4);
  assert.equal(comparison.damageQuantificationAutomatic, false);
  assert.ok(
    comparison.excludedPeers.some((e) => e.reasons.some((r) => r.includes('Unidade incompatível'))),
    'Peer com unidade incompatível deve ser excluído antes da razão'
  );
  assert.ok(
    comparison.excludedPeers.some((e) => e.reasons.some((r) => r.includes('frete'))),
    'Peer com frete embutido deve ser excluído'
  );
  assert.ok(
    comparison.excludedPeers.some((e) => e.reasons.some((r) => r.includes('serviço/instalação'))),
    'Peer com serviço embutido deve ser excluído'
  );
});

test('13, 14 & 15. Canais de participação: sem e-mail com portal eletrônico válido, OCR insuficiente e indisponibilidade pós-prazo', () => {
  // 13. Missing email with valid electronic system -> CANAL_VALIDO_SEM_EMAIL
  const validPortalNoEmail = evaluateParticipationChannels({
    procurementId: 'PE-010/2026',
    applicableLegalRule: 'Lei 14.133/2021',
    jurisdiction: 'Município Exemplo/BA',
    proposalSubmissionChannel: {
      hasValidElectronicPortal: true,
      portalName: 'LICITANET',
      portalUrl: 'https://licitanet.com.br',
      portalAccessDuringWindow: 'ok',
      portalAccessCapturedAt: '2026-04-05T14:00:00-03:00',
      emailSpecifiedForProposals: null,
      physicalDeliveryAllowed: false,
    },
    institutionalChannels: {
      contactEmail: null,
      clarificationChannel: 'Portal LICITANET',
      ombudsmanChannel: 'https://ouvidoria.exemplo.ba.gov.br',
    },
    schedule: {
      submissionDeadlineIso: '2026-04-10T09:00:00-03:00',
      openingDateTimeIso: '2026-04-10T09:30:00-03:00',
      timezone: 'America/Sao_Paulo',
    },
    documents: [
      {
        documentType: 'edital',
        title: 'Edital PE 010/2026',
        url: 'https://pncp.gov.br/app/editais/1',
        externalId: 'PNCP-1',
        publishedAt: '2026-03-28',
        amendmentDates: [],
        capturedAt: '2026-04-05T14:00:00-03:00',
        accessResult: 'ok',
        ocrQualityScore: 0.94,
      },
    ],
  });
  assert.equal(validPortalNoEmail.status, 'CANAL_VALIDO_SEM_EMAIL');
  assert.equal(validPortalNoEmail.legalNonComplianceConclusion.automaticIrregularityDeclared, false);
  assert.equal(validPortalNoEmail.activeProbingProhibited, true);

  // 14. Insufficient OCR quality
  const poorOcr = evaluateParticipationChannels({
    procurementId: 'PE-011/2026',
    applicableLegalRule: 'Lei 14.133/2021',
    jurisdiction: 'Município Exemplo/BA',
    proposalSubmissionChannel: {
      hasValidElectronicPortal: false,
      portalName: null,
      portalUrl: null,
      portalAccessDuringWindow: 'not_observed_during_window',
      portalAccessCapturedAt: null,
      emailSpecifiedForProposals: null,
      physicalDeliveryAllowed: null,
    },
    institutionalChannels: {
      contactEmail: null,
      clarificationChannel: null,
      ombudsmanChannel: null,
    },
    schedule: {
      submissionDeadlineIso: '2026-04-10T09:00:00-03:00',
      openingDateTimeIso: '2026-04-10T09:30:00-03:00',
      timezone: 'America/Sao_Paulo',
    },
    documents: [
      {
        documentType: 'edital',
        title: 'Edital digitalizado baixa resolução',
        url: 'https://pncp.gov.br/app/editais/2',
        externalId: 'PNCP-2',
        publishedAt: '2026-03-28',
        amendmentDates: [],
        capturedAt: '2026-04-05T14:00:00-03:00',
        accessResult: 'ok',
        ocrQualityScore: 0.31,
      },
    ],
  });
  assert.equal(poorOcr.status, 'OCR_INSUFICIENTE');
  assert.equal(poorOcr.ocrDiagnostics.isInsufficientOcr, true);

  // 15. Unavailability observed only AFTER submission deadline
  const postDeadline = evaluateParticipationChannels({
    procurementId: 'PE-012/2026',
    applicableLegalRule: 'Lei 14.133/2021',
    jurisdiction: 'Município Exemplo/BA',
    proposalSubmissionChannel: {
      hasValidElectronicPortal: true,
      portalName: 'Portal Municipal',
      portalUrl: 'https://compras.exemplo.ba.gov.br',
      portalAccessDuringWindow: 'origin_error',
      portalAccessCapturedAt: '2026-06-01T10:00:00-03:00',
      emailSpecifiedForProposals: null,
      physicalDeliveryAllowed: false,
    },
    institutionalChannels: {
      contactEmail: 'licitacao@exemplo.ba.gov.br',
      clarificationChannel: 'Portal Municipal',
      ombudsmanChannel: null,
    },
    schedule: {
      submissionDeadlineIso: '2026-04-10T09:00:00-03:00',
      openingDateTimeIso: '2026-04-10T09:30:00-03:00',
      timezone: 'America/Sao_Paulo',
    },
    documents: [],
  });
  assert.equal(postDeadline.status, 'INDISPONIBILIDADE_POS_PRAZO');
  assert.equal(postDeadline.accessDiagnostics[0].provesHistoricalUnavailability, false);
});

test('16 & 17. Paginação, cancelamento, limites de expansão, ciclos e bloqueio de conclusão jurídica com identidade não resolvida', () => {
  // Cyclic corporate structure A -> Holding -> A + PF unresolved
  const qsaList: SupplierQsaRecord[] = [
    makeQsa(SYNTH_CNPJ_A, 'EMPRESA ALFA', [
      { name: 'HOLDING CONTROLADORA', role: 'Sócio PJ', entryDate: '2020-01-01', partnerType: 'PJ', partnerCnpj: SYNTH_CNPJ_HOLDING },
      { name: 'MARIA SOUZA', role: 'Sócio-Administrador', entryDate: '2020-01-01', maskedDocument: '***111222**', partnerType: 'PF' },
    ]),
    makeQsa(SYNTH_CNPJ_HOLDING, 'HOLDING CONTROLADORA', [
      { name: 'EMPRESA ALFA', role: 'Sócio PJ (ciclo)', entryDate: '2020-01-01', partnerType: 'PJ', partnerCnpj: SYNTH_CNPJ_A },
      { name: 'EMPRESA BETA', role: 'Sócio PJ', entryDate: '2021-01-01', partnerType: 'PJ', partnerCnpj: SYNTH_CNPJ_B },
    ]),
    makeQsa(SYNTH_CNPJ_B, 'EMPRESA BETA', [
      { name: 'MARIA SOUZA', role: 'Sócia', entryDate: '2021-05-01', maskedDocument: '***111222**', partnerType: 'PF' },
    ]),
  ];

  // Test limits & pagination + cycle protection
  const limited = expandTemporalNetworkGraph({
    seedCnpjOrName: SYNTH_CNPJ_A,
    qsaRecords: qsaList,
    contracts: [],
    limits: { maxDepth: 2, maxNodes: 6, maxEdges: 10, page: 1, pageSize: 2 },
  });
  assert.ok(limited.cycleCountDetected >= 1, 'Ciclo societário deve ser detectado sem loop infinito');
  assert.equal(limited.nodes.length, 2, 'Paginação deve respeitar pageSize');
  assert.equal(limited.hasMore, true);
  assert.equal(limited.financialAttribution.personalTotalAttributionBlocked, true);
  assert.equal(limited.financialAttribution.legalConclusionAllowed, false);

  // Test immediate cancellation
  const cancelled = expandTemporalNetworkGraph({
    seedCnpjOrName: SYNTH_CNPJ_A,
    qsaRecords: qsaList,
    contracts: [],
    isCancelled: () => true,
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.truncated, true);
});

test('18. Integridade forense: hash ausente gera estado INSUFFICIENT/INCOMPLETE (nunca VALID), PNCP exclui resultado cancelado e protege valor multi-itens', () => {
  // Missing digest in events must return integrityStatus = 'insufficient' and valid = false
  const emptyFacts = createEmptyFactSet('Auditor Teste');
  const missingDigestIntegrity = verifyCaseLedgerIntegrity({
    factSet: emptyFacts,
    events: [],
  });
  assert.equal(missingDigestIntegrity.valid, false);
  assert.equal(missingDigestIntegrity.integrityStatus, 'insufficient');

  // Export package missing packageDigestSha256 must return INCOMPLETE (exitCode = 2), NEVER VALID
  const contractInput = {
    id: 'CTR-TEST-18',
    contractNumber: '001/2026',
    pncpControlNumber: '11222333000181-2-000001/2026',
    municipalityName: 'Exemplo',
    municipalityIbge: '2902906',
    uf: 'BA',
    entityName: 'Prefeitura Exemplo',
    signatureDate: '2026-02-01',
    originalValue: 50000,
    updatedValue: 50000,
    supplierCnpj: SYNTH_CNPJ_A,
    supplierName: 'ALFA SERVICOS LTDA',
  };
  const evalResult = evaluateForensicInvestigation({
    contract: contractInput,
    factSet: emptyFacts,
    cadastralExtracts: [],
    observedHistory: null,
    privateEvidence: [],
    reviews: [],
  });
  const exported = buildInvestigationExportPackage({
    contractSnapshot: {
      contractNumber: contractInput.contractNumber,
      pncpControlNumber: contractInput.pncpControlNumber,
      municipalityName: contractInput.municipalityName,
      municipalityIbge: contractInput.municipalityIbge,
      uf: contractInput.uf,
      entityName: contractInput.entityName,
      signatureDate: contractInput.signatureDate,
      originalValue: contractInput.originalValue,
      updatedValue: contractInput.updatedValue,
      supplierCnpj: contractInput.supplierCnpj,
      supplierName: contractInput.supplierName,
    },
    factSet: emptyFacts,
    cadastralExtracts: [],
    observedHistory: null,
    privateEvidence: [],
    reviews: [],
    events: [],
    evaluation: evalResult,
  });

  assert.ok(exported.reproducibilityContext, 'Exportação deve incluir contexto de reprodução e limitações');
  assert.equal(exported.reproducibilityContext?.integrityStatus, 'insufficient');

  const missingHashPkg = { ...exported, packageDigestSha256: '' };
  const verifiedMissingHash = verifyInvestigationPackage(missingHashPkg);
  assert.equal(verifiedMissingHash.status, 'INCOMPLETE');
  assert.equal(verifiedMissingHash.exitCode, 2);

  // PNCP canceled item results MUST NOT be selected as active winners
  const onlyCanceled = selectActivePncpItemWinningSupplier([
    {
      niFornecedor: SYNTH_CNPJ_A,
      nomeRazaoSocialFornecedor: 'EMPRESA CANCELADA LTDA',
      valorTotalHomologado: 900000,
      situacaoCompraItemResultadoId: 2,
      situacaoCompraItemResultadoNome: 'Cancelado',
    },
  ]);
  assert.equal(onlyCanceled, null, 'Resultado cancelado jamais pode ser tratado como vencedor ativo');

  const canceledPlusActive = selectActivePncpItemWinningSupplier(
    [
      {
        niFornecedor: SYNTH_CNPJ_A,
        nomeRazaoSocialFornecedor: 'EMPRESA CANCELADA LTDA',
        valorTotalHomologado: 900000,
        situacaoCompraItemResultadoId: 2,
        situacaoCompraItemResultadoNome: 'Cancelado',
      },
      {
        niFornecedor: SYNTH_CNPJ_B,
        nomeRazaoSocialFornecedor: 'EMPRESA ATIVA LTDA',
        valorTotalHomologado: 12000,
        situacaoCompraItemResultadoId: 1,
        situacaoCompraItemResultadoNome: 'Informado',
      },
    ],
    { itemNumber: 1, totalCompraItems: 5 }
  );
  assert.ok(canceledPlusActive);
  assert.equal(canceledPlusActive?.supplierCnpj, SYNTH_CNPJ_B);
  assert.equal(canceledPlusActive?.excludedCanceledCount, 1);
  assert.equal(
    canceledPlusActive?.attributionScope,
    'single_item_only',
    'Compra com 5 itens deve marcar escopo single_item_only para impedir atribuição do valor total da compra'
  );
});

test('Regressões adicionais: SICONFI não soma estágios, Câmara diário sem histórico inventado, SSRF bloqueia IPs internos e SQLite v5 persiste snapshots', () => {
  // SICONFI stage reconciliation never sums empenho + liquidacao + pagamento
  const siconfi = reconcileSiconfiExecution({
    exercicio: 2025,
    conta: '3.3.90.39 - Outros Servicos Terceiros PJ',
    records: [
      { exercicio: 2025, periodo: '2025-B1', conta: '3.3.90.39 - Outros Servicos Terceiros PJ', estagio: 'empenho', valor: 100000, isRetificacao: false, isSaldoAcumulado: true },
      { exercicio: 2025, periodo: '2025-B2', conta: '3.3.90.39 - Outros Servicos Terceiros PJ', estagio: 'empenho', valor: 150000, isRetificacao: false, isSaldoAcumulado: true },
      { exercicio: 2025, periodo: '2025-B2', conta: '3.3.90.39 - Outros Servicos Terceiros PJ', estagio: 'empenho', valor: 145000, isRetificacao: true, isSaldoAcumulado: true },
      { exercicio: 2025, periodo: '2025-B2', conta: '3.3.90.39 - Outros Servicos Terceiros PJ', estagio: 'liquidacao', valor: 120000, isRetificacao: false, isSaldoAcumulado: true },
      { exercicio: 2025, periodo: '2025-B2', conta: '3.3.90.39 - Outros Servicos Terceiros PJ', estagio: 'pagamento', valor: 110000, isRetificacao: false, isSaldoAcumulado: true },
    ],
  });
  assert.equal(siconfi.sumAcrossStagesProhibited, true);
  assert.equal(siconfi.byStage.empenho, 145000, 'Deve usar saldo acumulado retificado mais recente');
  assert.equal(siconfi.byStage.liquidacao, 120000);
  assert.equal(siconfi.byStage.pagamento, 110000);

  // Câmara daily personnel snapshot declares no history and federal scope only
  const camara = parseCamaraDailyPersonnelSnapshot({
    snapshotDate: '2026-11-23',
    rawCsv: 'nome;cargo;lotacao;vinculo\nFULANO SINTETICO;Secretario Parlamentar;Gabinete 999;CNE',
  });
  assert.equal(camara.hasHistoricalChanges, false);
  assert.equal(camara.coverageScope, 'camara_federal_diario');
  assert.equal(camara.recordCount, 1);

  // Reciprocity representation does not presume collusion
  const recip = evaluateAppointmentNepotismTrail({
    appointments: [],
    documentedKinships: [],
    reciprocityHypotheses: [
      {
        id: 'rec-1',
        appointmentA: {
          id: 'a1',
          person: { personId: 'p1', fullName: 'PESSOA A', identityStatus: 'resolved_documentary' },
          actReference: 'Ato 1/2025',
          appointingAuthority: { personId: 'auth-a', fullName: 'AUTORIDADE A', identityStatus: 'resolved_documentary' },
          roleTitle: 'Assessor',
          bondNature: 'comissionado',
          lotacao: 'Orgao A',
          organKey: 'org-a',
          jurisdiction: 'Ente A',
          startDate: '2025-02-01',
          endDate: null,
          endSemantics: 'ongoing_undocumented',
          sourceLabel: 'DO',
          evidenceRefs: ['ev-a'],
        },
        appointmentB: {
          id: 'a2',
          person: { personId: 'p2', fullName: 'PESSOA B', identityStatus: 'resolved_documentary' },
          actReference: 'Ato 2/2025',
          appointingAuthority: { personId: 'auth-b', fullName: 'AUTORIDADE B', identityStatus: 'resolved_documentary' },
          roleTitle: 'Assessor',
          bondNature: 'comissionado',
          lotacao: 'Orgao B',
          organKey: 'org-b',
          jurisdiction: 'Ente B',
          startDate: '2025-02-15',
          endDate: null,
          endSemantics: 'ongoing_undocumented',
          sourceLabel: 'DO',
          evidenceRefs: ['ev-b'],
        },
        contextNotes: 'Nomeações em órgãos distintos sob análise',
      },
    ],
  });
  assert.equal(recip.status, 'REVISAO_JURIDICA_NECESSARIA');
  assert.equal(recip.conclusiveFraudAssertion, false);

  // SSRF protection blocks metadata, localhost, private IPs, and unsafe redirects
  assert.equal(validateSafeExternalUrl('http://169.254.169.254/latest/meta-data/').allowed, false);
  assert.equal(validateSafeExternalUrl('https://127.0.0.1/admin').allowed, false);
  assert.equal(validateSafeExternalUrl('https://localhost:3000/api/auth/status').allowed, false);
  assert.equal(validateSafeExternalUrl('https://10.0.0.5/internal').allowed, false);
  assert.equal(validateSafeExternalUrl('https://evil.example.com/hook').allowed, false);
  assert.equal(validateSafeExternalUrl('https://pncp.gov.br/api/search/?q=123').allowed, true);
  assert.equal(
    validateSafeRedirectTarget('https://pncp.gov.br/api/x', 'http://169.254.169.254/latest').allowed,
    false
  );

  // Log sanitizer removes tokens & full CPFs
  const sanitized = sanitizeLogPayload({
    authorization: 'Bearer secret-token-123',
    note: 'CPF 123.456.789-01 com Bearer abcdef123456',
  });
  assert.equal(sanitized.authorization, '[REDACTED]');
  assert.ok(!String(sanitized.note).includes('123.456.789-01'));
  assert.ok(!String(sanitized.note).includes('abcdef123456'));

  // Observability registry tracks latencies & coverage
  const obsReg = createObservabilityRegistry();
  obsReg.recordSourceCall({ source: 'pncp_search', ok: true, latencyMs: 120, statusLabel: 'complete' });
  const snap = obsReg.getSnapshot({ schemaVersion: 5, indexedSuppliers: 10, indexedQsa: 5 });
  assert.equal(snap.schemaVersion, 5);
  assert.equal(snap.coverage.qsaCoveragePct, 50);

  // SQLite v5 migration & idempotent official snapshot persistence
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexofis-v5-'));
  try {
    const store = createNexofisStore(path.join(tmpDir, 'test.db'));
    assert.equal(store.getSchemaVersion(), 5);
    const first = store.saveOfficialSnapshot({
      id: 'snap-1',
      sourceKind: 'sinapi',
      filename: 'sinapi.csv',
      sha256: 'a'.repeat(64),
      competencia: '2026-04',
      uf: 'BA',
      metadataJson: '{}',
      payloadJson: '[]',
      importedBy: 'teste',
    });
    const dup = store.saveOfficialSnapshot({
      id: 'snap-2',
      sourceKind: 'sinapi',
      filename: 'sinapi.csv',
      sha256: 'a'.repeat(64),
      competencia: '2026-04',
      uf: 'BA',
      metadataJson: '{}',
      payloadJson: '[]',
      importedBy: 'teste',
    });
    assert.equal(first.alreadyExisted, false);
    assert.equal(dup.alreadyExisted, true);
    assert.equal(store.listOfficialSnapshots('sinapi').length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('19. Diferença-em-Diferenças pareada (Saúde/Educação) + importador INEP preserva salvaguarda de não classificação automática de serviço fictício', () => {
  const inep = importInepPublicExport({
    filename: 'INEP_IDEB_2023_2025.csv',
    rawCsv: [
      'CO_MUNICIPIO;INDICADOR;ANO;VALOR',
      '2902906;IDEB;2023;4,8',
      '2902906;IDEB;2025;-',
    ].join('\n'),
  });
  assert.equal(inep.rowCount, 2);
  assert.equal(inep.unpublishedCount, 1);
  assert.equal(inep.observations[0].value, 4.8);
  assert.equal(inep.observations[1].value, null);
  assert.equal(inep.observations[1].isPublished, false);

  const did = computePairedDidEffect({
    contractId: 'CTR-SAUDE-DID-1',
    indicatorId: 'SISAB_PRENATAL_6',
    indicatorName: 'Proporção de gestantes com 6+ consultas de pré-natal',
    domain: 'saude',
    sourceSystem: 'SISAB / SIAPS',
    contractSignatureDate: '2025-01-10',
    preWindowMonths: 12,
    postWindowMonths: 12,
    improvementDirection: 'higher_is_better',
    treatedMunicipalityCode: '2902906',
    treatedMunicipalityName: 'Município Tratado Sintético',
    treatedPreValue: 52.0,
    treatedPostValue: 53.0,
    installmentsPaidPct: 100,
    controlMunicipalities: [
      {
        municipalityCode: '2900001',
        municipalityName: 'Vizinho A',
        microregion: 'Sudoeste',
        populationBand: '20k-50k',
        hadSimilarConsultancy: false,
        preValue: 50.0,
        postValue: 55.0,
      },
      {
        municipalityCode: '2900002',
        municipalityName: 'Vizinho B',
        microregion: 'Sudoeste',
        populationBand: '20k-50k',
        hadSimilarConsultancy: false,
        preValue: 51.0,
        postValue: 56.0,
      },
      {
        municipalityCode: '2900003',
        municipalityName: 'Vizinho C',
        microregion: 'Sudoeste',
        populationBand: '20k-50k',
        hadSimilarConsultancy: false,
        preValue: 49.0,
        postValue: 54.0,
      },
      {
        municipalityCode: '2900004',
        municipalityName: 'Vizinho Contaminado',
        microregion: 'Sudoeste',
        populationBand: '20k-50k',
        hadSimilarConsultancy: true,
        preValue: 50.0,
        postValue: 40.0,
      },
    ],
  });

  assert.equal(did.validControlCount, 3);
  assert.equal(did.excludedControlCount, 1);
  assert.equal(did.deltaTreated, 1);
  assert.equal(did.deltaControlMean, 5);
  assert.equal(did.netEffectOriented, -4);
  assert.equal(did.alertLevel, 'ALERTA_VERMELHO_INEFETIVIDADE');
  assert.equal(did.serviceClassifiedAsFictitious, false);
});

test('20. Auditoria automatizada de canais de contato em editais filtra e-mails de ferramenta e exige revisão jurídica', () => {
  const editalSemCanais = `
    AVISO DE DISPENSA ELETRÔNICA Nº 014/2026
    Objeto: Contratação de consultoria de gestão.
    Documento gerado em PDF por suporte@adobe.com e office@microsoft.com.
    Demais disposições conforme processo administrativo interno.
  `;
  const auditBlocked = auditEditalCommunicationChannels(editalSemCanais, {
    procurementId: 'DISP-014/2026',
    ocrQualityScore: 0.92,
  });
  assert.equal(auditBlocked.emailsFound.length, 0);
  assert.equal(auditBlocked.filteredOutSystemEmails.length, 2);
  assert.equal(auditBlocked.phonesFound.length, 0);
  assert.equal(auditBlocked.platformsFound.length, 0);
  assert.equal(auditBlocked.status, 'SINAL_IRREGULARIDADE_REVISAO_JURIDICA');
  assert.ok(auditBlocked.alerts.some((a) => a.code === 'SINAL_CRITICO_COMPETITIVIDADE'));
  assert.equal(auditBlocked.channelEvaluation.legalNonComplianceConclusion.automaticIrregularityDeclared, false);

  const editalOcrRuim = auditEditalCommunicationChannels(editalSemCanais, {
    procurementId: 'DISP-014/2026',
    ocrQualityScore: 0.41,
  });
  assert.equal(editalOcrRuim.status, 'OCR_INSUFICIENTE');

  const editalConforme = auditEditalCommunicationChannels(
    `PREGÃO ELETRÔNICO 02/2026. Sessão em https://www.gov.br/comprasnet/sessao. Contato: licitacao@prefeitura-exemplo.ba.gov.br e telefone (77) 3436-1020.`,
    { procurementId: 'PE-02/2026', ocrQualityScore: 0.98 }
  );
  assert.equal(editalConforme.status, 'CONFORME');
  assert.equal(editalConforme.emailsFound[0], 'licitacao@prefeitura-exemplo.ba.gov.br');
  assert.equal(editalConforme.phonesFound.length, 1);
  assert.equal(editalConforme.platformsFound.length, 1);
});

test('21. Projeção Cypher (Neo4j) e consultas forenses em processo (Parentesco+Cargo+Contrato e Rede Multi-Hop)', () => {
  const snapshot: ForensicGraphSnapshot = {
    people: [
      {
        personId: 'p_dep_a',
        nome: 'Deputado X Sintético',
        cpfMascarado: '***111222**',
        cargoPolitico: 'Deputado Estadual',
        identityResolved: true,
      },
      {
        personId: 'p_irma',
        nome: 'Maria Silva Sintética',
        cpfMascarado: '***333444**',
        escolaridadeDocumentada: 'Ensino Médio',
        identityResolved: true,
      },
      {
        personId: 'p_homonimo',
        nome: 'Maria Silva Homonima',
        cpfMascarado: '***999888**',
        identityResolved: false,
      },
    ],
    companies: [
      { cnpj: SYNTH_CNPJ_A, razaoSocial: 'TECH SOLUCOES SINTETICAS LTDA', capitalSocial: 50000 },
      { cnpj: SYNTH_CNPJ_B, razaoSocial: 'SATELITE GESTAO SINTETICA LTDA', capitalSocial: 80000 },
    ],
    agencies: [{ orgaoId: 'org_pref_4', nome: 'Prefeitura Municipal Sintética 4', ibge: '3100001' }],
    offices: [
      {
        cargoId: 'cargo_gab_1',
        titulo: 'Chefe de Gabinete',
        tipo: 'Comissionado',
        salario: 14500,
        orgaoId: 'org_pref_4',
      },
    ],
    contracts: [
      {
        contratoId: 'ctr_206',
        numero: '206/2026',
        objeto: 'Licença de Software de Gestão',
        valorTotal: 300000,
        valorMensal: 25000,
        ano: 2026,
        cnpjFornecedor: SYNTH_CNPJ_A,
        orgaoId: 'org_pref_4',
      },
      {
        contratoId: 'ctr_207',
        numero: '207/2026',
        objeto: 'Consultoria Complementar',
        valorTotal: 180000,
        valorMensal: 15000,
        ano: 2026,
        cnpjFornecedor: SYNTH_CNPJ_B,
        orgaoId: 'org_pref_4',
      },
    ],
    kinshipEdges: [
      {
        fromPersonId: 'p_irma',
        toPersonId: 'p_dep_a',
        relationType: 'PARENTESCO_COM',
        grau: 'Irmã',
        tipo: 'Colateral 2º Grau',
        assertionState: 'documented',
        evidenceRef: 'CERTIDAO-SINTETICA-01',
      },
      {
        fromPersonId: 'p_homonimo',
        toPersonId: 'p_dep_a',
        relationType: 'PARENTESCO_COM',
        grau: 'Possível parente',
        assertionState: 'candidate',
        evidenceRef: 'COINCIDENCIA-SOBRENOME',
      },
    ],
    shareholderEdges: [
      {
        personId: 'p_irma',
        cnpj: SYNTH_CNPJ_A,
        qualificacao: 'Sócio-Administrador',
        participacaoPct: 50,
        assertionState: 'documented',
        evidenceRef: 'QSA-RFB-A',
      },
      {
        personId: 'p_irma',
        cnpj: SYNTH_CNPJ_B,
        qualificacao: 'Sócio',
        participacaoPct: 50,
        assertionState: 'documented',
        evidenceRef: 'QSA-RFB-B',
      },
      {
        personId: 'p_homonimo',
        cnpj: SYNTH_CNPJ_A,
        qualificacao: 'Sócio',
        assertionState: 'candidate',
        evidenceRef: 'QSA-CAND',
      },
    ],
    officeHoldingEdges: [
      {
        personId: 'p_irma',
        cargoId: 'cargo_gab_1',
        atoNomeacaoRef: 'Portaria 10/2026',
        startDate: '2026-01-05',
        assertionState: 'documented',
        evidenceRef: 'DOM-2026-01-05',
      },
      {
        personId: 'p_homonimo',
        cargoId: 'cargo_gab_1',
        assertionState: 'candidate',
        evidenceRef: 'HOMONIMO-FOLHA',
      },
    ],
  };

  const cypher = generateForensicCypherScript(snapshot);
  assert.ok(cypher.includes('MERGE (p:Pessoa'));
  assert.ok(cypher.includes('PARENTESCO_COM'));
  assert.ok(cypher.includes('OCUPA_CARGO'));
  assert.ok(cypher.includes('SOCIO_DE'));
  assert.ok(cypher.includes('FORNECE_PARA'));

  // Consulta 1 com onlyDocumented=true deve retornar apenas o vínculo documentado (excluindo homônimo candidato)
  const q1Documented = executeKinshipOfficeContractQuery(snapshot, { onlyDocumented: true });
  assert.equal(q1Documented.length, 2); // 2 contratos da empresa A e B no mesmo ente
  assert.ok(q1Documented.every((m) => m.parenteContratado === 'Maria Silva Sintética'));
  assert.ok(q1Documented.every((m) => m.includesUnresolvedOrCandidatePath === false));

  // Consulta 2: a partir da empresa A, descobre a empresa satélite B (sem self-loop na empresa A)
  const q2 = executeMultiHopCorporateNetworkQuery(snapshot, SYNTH_CNPJ_A, { onlyDocumented: true });
  assert.equal(q2.length, 1);
  assert.equal(q2[0].empresaSateliteCnpj, SYNTH_CNPJ_B);
  assert.equal(q2[0].numeroContrato, '207/2026');
});


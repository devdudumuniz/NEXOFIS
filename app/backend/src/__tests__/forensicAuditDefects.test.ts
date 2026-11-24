import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNexofisStore } from '../storage';
import { importSinapiOfficialFile } from '../connectors/sinapiImporter';
import {
  buildInvestigationExportPackage,
  computeCanonicalSha256,
  createEmptyFactSet,
  evaluateForensicInvestigation,
  verifyInvestigationPackage,
} from '@nexofis/shared/lib/forensicInvestigationEngine';
import {
  executeKinshipOfficeContractQuery,
  executeMultiHopCorporateNetworkQuery,
  type ForensicGraphSnapshot,
} from '@nexofis/shared/lib/forensicGraphCypher';
import {
  evaluateContractConflictTrail,
  evaluateRoleLegalRequirementsTrail,
} from '@nexofis/shared/lib/publicIntegrityTrails';
import {
  computePairedDidEffect,
  evaluateOutcomeClaim,
  importInepPublicExport,
  importSiapsPublicExport,
} from '@nexofis/shared/lib/outcomesEvaluationEngine';
import { evaluateInvestigativePriceComparison } from '@nexofis/shared/lib/benchmarkEngine';
import { auditEditalCommunicationChannels } from '@nexofis/shared/lib/participationChannelEvaluator';
import {
  parseBrazilianNumber,
  parseCsvRows,
  parseCsvTable,
} from '@nexofis/shared/lib/csvParser';
import {
  competenciaDistanceMonths,
  validateCompetencia,
  validateIsoDate,
} from '@nexofis/shared/lib/competenciaValidator';

test('Defeito 1.1: SQLite v6 persiste snapshot INEP com CHECK atualizado, changes===1 e releitura confirmada', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexofis-defect-1-1-'));
  try {
    const store = createNexofisStore(path.join(tmpDir, 'test.db'));
    assert.equal(store.getSchemaVersion(), 6);

    const saved = store.saveOfficialSnapshot({
      id: 'snap_inep_1',
      sourceKind: 'inep',
      filename: 'INEP_IDEB_2025.csv',
      sha256: 'b'.repeat(64),
      competencia: '2025',
      uf: null,
      metadataJson: JSON.stringify({ rowCount: 4 }),
      payloadJson: '[]',
      importedBy: 'auditor-teste',
    });

    assert.equal(saved.alreadyExisted, false);
    assert.equal(saved.id, 'snap_inep_1');

    const listed = store.listOfficialSnapshots('inep');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].sourceKind, 'inep');
    assert.equal(listed[0].filename, 'INEP_IDEB_2025.csv');
    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Defeito 1.2: Idempotência composta de snapshots permite mesmos bytes em datas/competências diferentes e bloqueia duplicata exata', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexofis-defect-1-2-'));
  try {
    const store = createNexofisStore(path.join(tmpDir, 'test.db'));
    const sameSha = 'c'.repeat(64);

    // Day 1 collection
    const day1 = store.saveOfficialSnapshot({
      id: 'snap_camara_shared',
      sourceKind: 'camara_personnel',
      filename: 'camara-2026-05-10.csv',
      sha256: sameSha,
      competencia: '2026-05-10',
      uf: 'DF',
      metadataJson: '{}',
      payloadJson: '[]',
      importedBy: 'auditor',
    });
    assert.equal(day1.alreadyExisted, false);

    // Same bytes on SAME day -> idempotent
    const day1Dup = store.saveOfficialSnapshot({
      id: 'snap_camara_shared',
      sourceKind: 'camara_personnel',
      filename: 'camara-2026-05-10.csv',
      sha256: sameSha,
      competencia: '2026-05-10',
      uf: 'DF',
      metadataJson: '{}',
      payloadJson: '[]',
      importedBy: 'auditor',
    });
    assert.equal(day1Dup.alreadyExisted, true);
    assert.equal(day1Dup.id, day1.id);

    // Same bytes on DIFFERENT day -> MUST persist as a distinct daily snapshot
    const day2 = store.saveOfficialSnapshot({
      id: 'snap_camara_shared',
      sourceKind: 'camara_personnel',
      filename: 'camara-2026-05-11.csv',
      sha256: sameSha,
      competencia: '2026-05-11',
      uf: 'DF',
      metadataJson: '{}',
      payloadJson: '[]',
      importedBy: 'auditor',
    });
    assert.equal(day2.alreadyExisted, false);
    assert.notEqual(day2.id, day1.id);

    const allCamara = store.listOfficialSnapshots('camara_personnel');
    assert.equal(allCamara.length, 2);
    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Defeito 1.3a: Aresta dismissed no grafo nunca reaparece como documented e é excluída quando onlyDocumented=true', () => {
  const snapshot: ForensicGraphSnapshot = {
    people: [
      { personId: 'p1', nome: 'Agente Público', cpfMascarado: '***111222**', identityResolved: true },
      { personId: 'p2', nome: 'Sócio Descartado', cpfMascarado: '***333444**', identityResolved: true },
    ],
    companies: [
      { cnpj: '11222333000181', razaoSocial: 'EMPRESA A LTDA' },
      { cnpj: '22333444000192', razaoSocial: 'EMPRESA B LTDA' },
    ],
    agencies: [{ orgaoId: 'org1', nome: 'Prefeitura Exemplo' }],
    offices: [{ cargoId: 'c1', titulo: 'Secretário', tipo: 'Comissionado', orgaoId: 'org1' }],
    contracts: [
      {
        contratoId: 'ctr1',
        numero: '001/2026',
        objeto: 'Serviços',
        valorTotal: 100000,
        ano: 2026,
        cnpjFornecedor: '11222333000181',
        orgaoId: 'org1',
      },
      {
        contratoId: 'ctr2',
        numero: '002/2026',
        objeto: 'Obras',
        valorTotal: 200000,
        ano: 2026,
        cnpjFornecedor: '22333444000192',
        orgaoId: 'org1',
      },
    ],
    kinshipEdges: [
      {
        fromPersonId: 'p1',
        toPersonId: 'p2',
        relationType: 'PARENTESCO_COM',
        grau: 'Irmão',
        assertionState: 'dismissed',
        evidenceRef: 'REVISAO_HUMANA_DESCARTADO',
      },
    ],
    shareholderEdges: [
      {
        personId: 'p2',
        cnpj: '11222333000181',
        qualificacao: 'Sócio',
        assertionState: 'documented',
        evidenceRef: 'QSA_1',
      },
      {
        personId: 'p2',
        cnpj: '22333444000192',
        qualificacao: 'Sócio',
        assertionState: 'dismissed',
        evidenceRef: 'QSA_DESCARTADO',
      },
    ],
    officeHoldingEdges: [
      {
        personId: 'p1',
        cargoId: 'c1',
        assertionState: 'documented',
        evidenceRef: 'DOU_1',
      },
    ],
  };

  // Default (onlyDocumented=true): dismissed kinship MUST NOT appear
  const kinshipDoc = executeKinshipOfficeContractQuery(snapshot, { onlyDocumented: true });
  assert.equal(kinshipDoc.length, 0);

  // Even when onlyDocumented=false (default includeDismissed=false): dismissed edge MUST NOT appear as documented
  const kinshipAll = executeKinshipOfficeContractQuery(snapshot, { onlyDocumented: false });
  assert.equal(kinshipAll.length, 0);

  // Multi-hop corporate network: dismissed edge to EMPRESA B must NOT reappear
  const multiHop = executeMultiHopCorporateNetworkQuery(snapshot, '11222333000181', {
    onlyDocumented: false,
  });
  assert.equal(multiHop.length, 0);
});

test('Defeito 1.3b: Conflito contratual exige personId idêntico — vínculo de person-A jamais atribuído a person-B', () => {
  const result = evaluateContractConflictTrail([
    {
      contractId: 'CTR-CONF-1',
      contractSignatureDate: '2025-06-15',
      contractOrganKey: 'SMS-EXEMPLO',
      contractJurisdiction: 'Município Exemplo',
      supplierCnpj: '11222333000181',
      corporateLink: {
        person: {
          personId: 'person_A',
          fullName: 'João Silva',
          identityStatus: 'resolved_documentary',
        },
        role: 'Sócio-Administrador',
        startDate: '2020-01-01',
        endDate: null,
        endSemantics: 'ongoing_undocumented',
        evidenceRefs: ['QSA_A'],
      },
      appointment: {
        id: 'appt_B',
        person: {
          personId: 'person_B',
          fullName: 'João Silva',
          identityStatus: 'resolved_documentary',
        },
        actReference: 'Portaria 10/2025',
        appointingAuthority: {
          personId: 'auth_1',
          fullName: 'Prefeito Exemplo',
          identityStatus: 'resolved_documentary',
        },
        roleTitle: 'Ordenador de Despesas',
        bondNature: 'comissionado',
        lotacao: 'Gabinete',
        organKey: 'SMS-EXEMPLO',
        jurisdiction: 'Município Exemplo',
        startDate: '2025-01-01',
        endDate: null,
        endSemantics: 'ongoing_undocumented',
        sourceLabel: 'DOM',
        evidenceRefs: ['DOM_B'],
      },
      pertinentToContract: true,
    },
  ]);

  assert.equal(result.requiresLegalReview, false);
  assert.equal(result.findings[0].code, 'CONFLICT_DISTINCT_IDENTITIES');
  assert.equal(result.findings[0].status, 'CONFORME_NO_ESCOPO');
});

test('Defeito 1.4: DiD bloqueia alerta vermelho quando didDesign reprova elegibilidade ou está ausente', () => {
  const baseInput = {
    contractId: 'CTR-DID-GATE',
    indicatorId: 'SISAB_PRENATAL',
    indicatorName: 'Pré-natal 6+ consultas',
    domain: 'saude' as const,
    sourceSystem: 'SISAB',
    contractSignatureDate: '2025-01-01',
    improvementDirection: 'higher_is_better' as const,
    treatedMunicipalityCode: '2902906',
    treatedMunicipalityName: 'Município A',
    treatedPreValue: 50,
    treatedPostValue: 50,
    installmentsPaidPct: 100,
    controlMunicipalities: [
      { municipalityCode: '1', municipalityName: 'C1', microregion: 'M', populationBand: '20k', hadSimilarConsultancy: false, preValue: 50, postValue: 56 },
      { municipalityCode: '2', municipalityName: 'C2', microregion: 'M', populationBand: '20k', hadSimilarConsultancy: false, preValue: 50, postValue: 55 },
      { municipalityCode: '3', municipalityName: 'C3', microregion: 'M', populationBand: '20k', hadSimilarConsultancy: false, preValue: 50, postValue: 57 },
    ],
  };

  // Without didDesign -> CONTRASTE_DESCRITIVO_SEM_INFERENCIA (never red alert)
  const noDesign = computePairedDidEffect(baseInput);
  assert.equal(noDesign.alertLevel, 'CONTRASTE_DESCRITIVO_SEM_INFERENCIA');

  // With ineligible didDesign -> METODOLOGIA_REPROVADA (never red alert)
  const failedDesign = computePairedDidEffect({
    ...baseInput,
    didDesign: {
      requestedMethod: 'did',
      usesSimpleNeighborAverageAsSyntheticControl: false,
      comparisonGroupJustification: '',
      prePeriodTreatedCount: 1,
      prePeriodControlCount: 1,
      postPeriodTreatedCount: 1,
      postPeriodControlCount: 1,
      preTrendsTested: false,
      preTrendsParallel: false,
      explicitAssumptions: [],
      uncertaintyReported: false,
    },
  });
  assert.equal(failedDesign.alertLevel, 'METODOLOGIA_REPROVADA');
  assert.equal(failedDesign.didValidation?.eligible, false);
});

test('Defeito 1.5 + Conversão de Unidade (1000kg vs 20 sacos 50kg) + Proveniência Canônica por peerId', () => {
  const baseProfile = {
    specification: 'Cimento Portland CP II-E-32',
    unitLabel: 'kg',
    quantity: 1000,
    uf: 'PE',
    competencia: '2026-03',
    deliveryCondition: 'posto_obra',
    includesFreight: false,
    includesInstallationOrService: false,
    includesTaxesAndCharges: true,
    itemKind: 'insumo' as const,
    referenceSource: 'Contrato Analisado',
    referenceVersion: '2026-03',
  };

  const evalRes = evaluateInvestigativePriceComparison({
    serviceClass: 'Insumo Construção',
    subjectNominalPrice: 0.85,
    subjectYear: 2026,
    subjectProfile: baseProfile,
    inflationIndexLabel: 'IPCA-2026',
    peers: [
      // 4 valid peers including unit conversion: 20 sacos de 50kg (conversionFactor = 0.02 -> 1000kg, R$ 0.80/kg)
      {
        id: 'peer_saco_1',
        municipalityName: 'Recife',
        uf: 'PE',
        contractNumber: 'CT-01/2026',
        contractYear: 2026,
        serviceClass: 'Insumo Construção',
        unitLabel: 'saco 50kg',
        nominalUnitPrice: 40.0,
        inflationAdjustedPrice: 40.0,
        conversionFactor: 0.02,
        scopeDistance: 0.05,
        slaComparable: true,
        licensingComparable: true,
        sameSupplier: false,
        included: true,
        profile: {
          ...baseProfile,
          unitLabel: 'saco 50kg',
          quantity: 20, // 20 sacos * 50kg = 1000kg -> qtyRatio = 1.0!
          referenceSource: 'SINAPI',
          referenceVersion: '2026-03-PE',
        },
      },
      // Duplicate contractNumber in DIFFERENT municipality to verify canonical peerId provenance
      {
        id: 'peer_kg_2',
        municipalityName: 'Olinda',
        uf: 'PE',
        contractNumber: 'CT-01/2026',
        contractYear: 2026,
        serviceClass: 'Insumo Construção',
        unitLabel: 'kg',
        nominalUnitPrice: 0.82,
        inflationAdjustedPrice: 0.82,
        scopeDistance: 0.05,
        slaComparable: true,
        licensingComparable: true,
        sameSupplier: false,
        included: true,
        profile: {
          ...baseProfile,
          referenceSource: 'PNCP-Olinda',
          referenceVersion: '2026-03',
        },
      },
      {
        id: 'peer_kg_3',
        municipalityName: 'Caruaru',
        uf: 'PE',
        contractNumber: 'CT-03/2026',
        contractYear: 2026,
        serviceClass: 'Insumo Construção',
        unitLabel: 'kg',
        nominalUnitPrice: 0.84,
        inflationAdjustedPrice: 0.84,
        scopeDistance: 0.05,
        slaComparable: true,
        licensingComparable: true,
        sameSupplier: false,
        included: true,
        profile: { ...baseProfile, referenceSource: 'PNCP-Caruaru', referenceVersion: '2026-03' },
      },
      {
        id: 'peer_kg_4',
        municipalityName: 'Petrolina',
        uf: 'PE',
        contractNumber: 'CT-04/2026',
        contractYear: 2026,
        serviceClass: 'Insumo Construção',
        unitLabel: 'kg',
        nominalUnitPrice: 0.86,
        inflationAdjustedPrice: 0.86,
        scopeDistance: 0.05,
        slaComparable: true,
        licensingComparable: true,
        sameSupplier: false,
        included: true,
        profile: { ...baseProfile, referenceSource: 'PNCP-Petrolina', referenceVersion: '2026-03' },
      },
      // Incompatible material: Areia vs Cimento -> MUST BE EXCLUDED
      {
        id: 'peer_areia_5',
        municipalityName: 'Jaboatão',
        uf: 'PE',
        contractNumber: 'CT-05/2026',
        contractYear: 2026,
        serviceClass: 'Insumo Construção',
        unitLabel: 'kg',
        nominalUnitPrice: 0.12,
        inflationAdjustedPrice: 0.12,
        scopeDistance: 0.05,
        slaComparable: true,
        licensingComparable: true,
        sameSupplier: false,
        included: true,
        profile: {
          ...baseProfile,
          specification: 'Areia média lavada para construção',
          referenceSource: 'SINAPI',
          referenceVersion: '2026-03-PE',
        },
      },
      // Cross-UF without allowCrossUf -> MUST BE EXCLUDED
      {
        id: 'peer_cross_uf_6',
        municipalityName: 'São Paulo',
        uf: 'SP',
        contractNumber: 'CT-06/2026',
        contractYear: 2026,
        serviceClass: 'Insumo Construção',
        unitLabel: 'kg',
        nominalUnitPrice: 0.83,
        inflationAdjustedPrice: 0.83,
        scopeDistance: 0.05,
        slaComparable: true,
        licensingComparable: true,
        sameSupplier: false,
        included: true,
        profile: {
          ...baseProfile,
          uf: 'SP',
          referenceSource: 'SINAPI',
          referenceVersion: '2026-03-SP',
        },
      },
      // Invalid competência 2026-13 -> MUST BE EXCLUDED
      {
        id: 'peer_bad_comp_7',
        municipalityName: 'Paulista',
        uf: 'PE',
        contractNumber: 'CT-07/2026',
        contractYear: 2026,
        serviceClass: 'Insumo Construção',
        unitLabel: 'kg',
        nominalUnitPrice: 0.83,
        inflationAdjustedPrice: 0.83,
        scopeDistance: 0.05,
        slaComparable: true,
        licensingComparable: true,
        sameSupplier: false,
        included: true,
        profile: {
          ...baseProfile,
          competencia: '2026-13',
          referenceSource: 'SINAPI',
          referenceVersion: '2026-13-PE',
        },
      },
    ],
  });

  // 4 peers included (including converted 20 sacos de 50kg!), 3 excluded (Areia, SP, 2026-13)
  assert.equal(evalRes.includedPeers.length, 4);
  assert.equal(evalRes.excludedPeers.length, 3);

  // Verify converted saco peer
  const sacoPeer = evalRes.includedPeers.find((p) => p.peerId === 'peer_saco_1');
  assert.ok(sacoPeer);
  assert.equal(sacoPeer.unitPrice, 0.8);
  assert.equal(sacoPeer.conversionApplied?.convertedQuantity, 1000);
  assert.equal(sacoPeer.referenceSource, 'SINAPI');

  // Verify canonical provenance on duplicate contractNumber
  const olindaPeer = evalRes.includedPeers.find((p) => p.peerId === 'peer_kg_2');
  assert.ok(olindaPeer);
  assert.equal(olindaPeer.referenceSource, 'PNCP-Olinda');
  assert.equal(olindaPeer.contractNumber, 'CT-01/2026');

  // Verify exclusions
  assert.ok(evalRes.excludedPeers.some((e) => e.peerId === 'peer_areia_5' && e.reasons.some((r) => /Especificação técnica incompatível/i.test(r))));
  assert.ok(evalRes.excludedPeers.some((e) => e.peerId === 'peer_cross_uf_6' && e.reasons.some((r) => /Localidade \(UF\) divergente/i.test(r))));
  assert.ok(evalRes.excludedPeers.some((e) => e.peerId === 'peer_bad_comp_7' && e.reasons.some((r) => /Competência do comparável inválida/i.test(r))));
});

test('Defeito 1.6: Reprodução forense falha se generalLimitations, limitations ou suggestedDiligences forem adulterados', () => {
  const factSet = createEmptyFactSet('auditor-teste');
  const contractInput = {
    id: 'CTR-REPLAY-1',
    contractNumber: '10/2026',
    pncpControlNumber: 'PNCP-10',
    entityName: 'Prefeitura Teste',
    municipalityName: 'Recife',
    municipalityIbge: '2611606',
    uf: 'PE',
    supplierCnpj: '11222333000181',
    supplierName: 'FORNECEDOR EXEMPLO LTDA',
    signatureDate: '2026-01-10',
    originalValue: 50000,
    updatedValue: 50000,
    object: 'Fornecimento de insumos',
    modality: 'Pregão Eletrônico',
  };

  const evaluation = evaluateForensicInvestigation({
    contract: contractInput,
    factSet,
    cadastralExtracts: [],
    observedHistory: null,
    privateEvidence: [],
    reviews: [],
  });

  const pkg = buildInvestigationExportPackage({
    contractSnapshot: {
      contractNumber: contractInput.contractNumber,
      pncpControlNumber: contractInput.pncpControlNumber,
      entityName: contractInput.entityName,
      municipalityName: contractInput.municipalityName,
      municipalityIbge: contractInput.municipalityIbge,
      uf: contractInput.uf,
      supplierCnpj: contractInput.supplierCnpj,
      supplierName: contractInput.supplierName,
      signatureDate: contractInput.signatureDate,
      originalValue: contractInput.originalValue,
      updatedValue: contractInput.updatedValue,
    },
    factSet,
    cadastralExtracts: [],
    observedHistory: null,
    privateEvidence: [],
    reviews: [],
    events: [],
    evaluation,
    exportedAt: '2026-03-01T12:00:00.000Z',
  });

  // Untampered package passes reproduction check
  const baselineCheck = verifyInvestigationPackage(pkg);
  assert.equal(baselineCheck.checks.reproductionMatches, true);

  // Tamper generalLimitations AND recompute outer packageDigestSha256 (attacker tries to forge digest while hiding limitations)
  const tamperedBase = {
    ...pkg,
    evaluation: {
      ...pkg.evaluation,
      generalLimitations: ['Limitação adulterada para parecer conclusivo'],
    },
  };
  const { packageDigestSha256: _ignored, ...withoutDigest } = tamperedBase;
  const tamperedPkg = {
    ...withoutDigest,
    packageDigestSha256: computeCanonicalSha256(withoutDigest),
  };

  const tamperedCheck = verifyInvestigationPackage(tamperedPkg);
  assert.equal(tamperedCheck.checks.reproductionMatches, false);
  assert.equal(tamperedCheck.status, 'INVALID');
});

test('Defeito 1.7 + Competência: Parser CSV RFC 4180 preserva decimais entre aspas ("75,5") e validador rejeita 2026-13 / 2026-02-30', () => {
  // RFC 4180 quoted decimal, escaped quotes, multiline cell
  const raw = 'col1,col2,valor\n"Prefeitura ""Sul""","Linha 1\nLinha 2","75,5"\n';
  const parsed = parseCsvRows(raw, ',');
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[1][0], 'Prefeitura "Sul"');
  assert.equal(parsed.records[1][1], 'Linha 1\nLinha 2');
  assert.equal(parsed.records[1][2], '75,5');
  assert.equal(parseBrazilianNumber(parsed.records[1][2]), 75.5);
  assert.equal(parseBrazilianNumber('R$ 1.234,56'), 1234.56);
  assert.equal(parseBrazilianNumber('-'), null);

  const tbl = parseCsvTable('codigo,descricao,unidade,valor\n001,"Cimento, saco 50kg",UN,"75,5"\n');
  assert.equal(tbl.rows.length, 1);
  assert.equal(tbl.rows[0][3], '75,5');

  // SIAPS quoted decimal + invalid competência rejected
  const siaps = importSiapsPublicExport({
    filename: 'siaps.csv',
    defaultMethodologyVersion: 'v1',
    rawCsv: 'ibge,indicador,competencia,valor\n2611606,PRENATAL,2025-Q3,"75,5"\n2611606,PRENATAL,2026-13,"80,0"\n',
  });
  assert.equal(siaps.rowCount, 1);
  assert.equal(siaps.observations[0].value, 75.5);
  assert.ok(siaps.warnings.some((w) => w.includes('2026-13')));

  // Competência & ISO date validator
  assert.equal(validateCompetencia('2026-13').valid, false);
  assert.equal(validateCompetencia('2026-00').valid, false);
  assert.equal(validateCompetencia('2026-Q4').valid, false);
  assert.equal(validateCompetencia('2026-02-30').valid, false);
  assert.equal(validateCompetencia('2026-03').valid, true);
  assert.equal(validateCompetencia('2025-Q3').valid, true);
  assert.equal(validateIsoDate('2026-02-30').valid, false);
  assert.equal(validateIsoDate('2026-02-28').valid, true);
  assert.equal(competenciaDistanceMonths('2026-03', '2025-03'), 12);

  // SINAPI rejects invalid competência 2026-13 and parses quoted Brazilian decimal "75,5"
  assert.throws(
    () =>
      importSinapiOfficialFile({
        rawBuffer: 'codigo,descricao,unidade,preco\n1,"Item A",UN,"75,5"\n',
        filename: 'sinapi.csv',
        uf: 'PE',
        competencia: '2026-13',
        edition: '2026-13',
        taxRegime: 'nao_desonerado',
        defaultKind: 'insumo',
      }),
    /inválid/i
  );

  const sinapiOk = importSinapiOfficialFile({
    rawBuffer: 'codigo,descricao,unidade,preco\n001,"Cimento, tipo CP II",KG,"75,5"\n',
    filename: 'sinapi.csv',
    uf: 'PE',
    competencia: '2026-03',
    edition: '2026-03',
    taxRegime: 'nao_desonerado',
    defaultKind: 'insumo',
  });
  assert.equal(sinapiOk.itemCount, 1);
  assert.equal(sinapiOk.items[0].unitPrice, 75.5);
});

test('Requisito de Graduação: requiresGraduation=true sem expressRequirements e sem diploma retorna DESCONHECIDO_DOCUMENTO_AUSENTE', () => {
  const trail = evaluateRoleLegalRequirementsTrail({
    appointment: {
      id: 'appt_grad_1',
      person: {
        personId: 'p_grad',
        fullName: 'Servidor Exemplo',
        identityStatus: 'resolved_documentary',
      },
      actReference: 'Portaria 42/2025',
      appointingAuthority: {
        personId: 'auth_1',
        fullName: 'Prefeito Exemplo',
        identityStatus: 'resolved_documentary',
      },
      roleTitle: 'Controlador-Geral',
      bondNature: 'comissionado',
      lotacao: 'Controladoria',
      organKey: 'CGM-EXEMPLO',
      jurisdiction: 'Município Exemplo',
      startDate: '2025-02-01',
      endDate: null,
      endSemantics: 'ongoing_undocumented',
      sourceLabel: 'DOM',
      evidenceRefs: ['DOM_2025'],
    },
    applicableLaw: {
      lawReference: 'Lei Municipal 123/2020',
      amendmentsApplied: [],
      jurisdiction: 'Município Exemplo',
      effectiveFrom: '2020-01-01',
      effectiveUntil: null,
      roleTitle: 'Controlador-Geral',
      requiresGraduation: true,
      expressRequirements: [],
    },
    evidences: [],
  });

  assert.equal(trail.status, 'DESCONHECIDO_DOCUMENTO_AUSENTE');
  assert.ok(trail.findings.some((f) => f.status === 'DESCONHECIDO_DOCUMENTO_AUSENTE'));
});

test('Defeito 1.8: Edital contendo apenas portal de publicação (PNCP) não conta como plataforma de envio eletrônico de propostas', () => {
  const editalSomentePncp = `
    AVISO DE LICITAÇÃO — PREGÃO ELETRÔNICO Nº 09/2026.
    Divulgação oficial disponível em https://pncp.gov.br/app/editais/12345678000199/2026/9
    e no Diário Oficial em https://www.in.gov.br/web/dou.
    Demais regras constam nos autos físicos do setor.
  `;

  const audit = auditEditalCommunicationChannels(editalSomentePncp, {
    procurementId: 'PE-09/2026',
    ocrQualityScore: 0.95,
  });

  assert.ok(audit.publicationPortalsFound.some((u) => u.includes('pncp.gov.br')));
  assert.equal(audit.platformsFound.length, 0);
  assert.equal(audit.status, 'SINAL_IRREGULARIDADE_REVISAO_JURIDICA');
  assert.ok(audit.alerts.some((a) => a.code === 'SINAL_CRITICO_COMPETITIVIDADE'));

  const editalCompleto = auditEditalCommunicationChannels(
    `Publicação em https://pncp.gov.br/app/editais/1. Propostas via https://www.compras.gov.br/sessao. Contato: cpl@prefeitura.pe.gov.br, tel (81) 3333-4444.`,
    { procurementId: 'PE-10/2026', ocrQualityScore: 0.96 }
  );
  assert.equal(editalCompleto.status, 'CONFORME');
  assert.equal(editalCompleto.publicationPortalsFound.length, 1);
  assert.equal(editalCompleto.platformsFound.length, 1);
});

test('Corte Temporal: evaluateOutcomeClaim exclui observações publicadas após evaluationDate', () => {
  const run = evaluateOutcomeClaim({
    claim: {
      claimId: 'clm_cutoff_1',
      contractId: 'CTR-CUTOFF',
      sourceExcerptRef: 'Cláusula 2.1 do Termo de Referência',
      promisedDeliverableOrOutcome: 'Elevar IDEB Anos Iniciais',
      indicatorId: 'IDEB',
      expectedMethodologyVersion: 'inep-v1',
      unit: 'pontos',
      population: 'Rede Municipal Anos Iniciais',
      territoryCode: '2611606',
      baselineValue: 4.5,
      baselineCompetencia: '2023',
      targetValue: 5.2,
      targetDeadlineDate: '2025-12-31',
      contractSignatureDate: '2024-01-10',
      effectiveServiceStartDate: '2024-01-15',
      improvementDirection: 'higher_is_better',
      sourceSystem: 'INEP',
      evidenceRefs: ['TR-2024'],
      validatedDeliveriesCount: 4,
      validatedPaymentsAmount: 100000,
    },
    definition: {
      indicatorId: 'IDEB',
      name: 'IDEB Anos Iniciais',
      domain: 'educacao',
      sourceSystem: 'INEP',
      methodologyVersion: 'inep-v1',
      unit: 'pontos',
      population: 'Rede Municipal Anos Iniciais',
      territoryCode: '2611606',
      periodicity: 'bienal',
      improvementDirection: 'higher_is_better',
    },
    observations: [
      {
        observationId: 'obs_before',
        indicatorId: 'IDEB',
        methodologyVersion: 'inep-v1',
        territoryCode: '2611606',
        competencia: '2024',
        periodEndDate: '2024-12-31',
        publishedAt: '2025-05-01',
        collectedAt: '2025-06-01',
        revision: 'original',
        numerator: null,
        denominator: null,
        value: 4.9,
        isPublished: true,
        sourceFileSha256: 'd'.repeat(64),
      },
      {
        observationId: 'obs_after_cutoff',
        indicatorId: 'IDEB',
        methodologyVersion: 'inep-v1',
        territoryCode: '2611606',
        competencia: '2025',
        periodEndDate: '2025-12-31',
        publishedAt: '2026-08-01', // AFTER evaluationDate 2026-01-15!
        collectedAt: '2026-08-02',
        revision: 'original',
        numerator: null,
        denominator: null,
        value: 5.8,
        isPublished: true,
        sourceFileSha256: 'e'.repeat(64),
      },
    ],
    evaluationDate: '2026-01-15',
  });

  // Must use 2024 (4.9), NOT 2025 (5.8 published in Aug 2026)
  assert.equal(run.latestPublishedCompetencia, '2024');
  assert.equal(run.dimensions.B_targetAttainment.latestObservedValue, 4.9);
  assert.ok(run.limitations.some((l) => /corte temporal/i.test(l)));

  // Also test INEP import with quoted Brazilian decimal
  const inep = importInepPublicExport({
    filename: 'inep.csv',
    rawCsv: 'CO_MUNICIPIO,INDICADOR,ANO,VALOR\n2611606,IDEB,2024,"4,9"\n2611606,IDEB,2026-13,"5,1"\n',
  });
  assert.equal(inep.rowCount, 1);
  assert.equal(inep.observations[0].value, 4.9);
});

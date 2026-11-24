import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  FIXTURE_COMPLIANT,
  FIXTURE_HIGH_RISK,
  TEST_FIXTURE_CONTRACTS,
} from '@nexofis/shared/lib/__fixtures__/testContracts';
import type { BenchmarkPeer, ContractRecord } from '@nexofis/shared/types/audit';
import { evaluateHorizontalBenchmark } from '@nexofis/shared/lib/benchmarkEngine';
import {
  isSafePublicUrl,
  resolveDocumentContractMatch,
  validateUploadedFileMagic,
} from '@nexofis/shared/lib/documentParser';
import { getDispensationLimitForContract, resolveLegalRulesetStrict } from '@nexofis/shared/lib/legalRules';
import { analyzeExecutionChain, evaluateContractRisk } from '@nexofis/shared/lib/riskEngine';
import { extractNativePdfText } from '../pdfExtractor';
import { classifyCnpjRoleInPncpItem } from '../pncpClient';
import { createNexofisStore } from '../storage';

function makePeer(id: string, price: number, overrides: Partial<BenchmarkPeer> = {}): BenchmarkPeer {
  return {
    id,
    municipalityName: `Município ${id}`,
    uf: 'BA',
    contractNumber: `00${id}/2026`,
    contractYear: 2026,
    sameSupplier: true,
    serviceClass: 'Software',
    unitLabel: 'mês',
    nominalUnitPrice: price,
    inflationAdjustedPrice: price,
    scopeDistance: 0.1,
    slaComparable: true,
    licensingComparable: true,
    included: true,
    ...overrides,
  };
}

test('Benchmark engine deduplicates repeated peer contracts and excludes different suppliers in same_supplier mode', () => {
  const peers: BenchmarkPeer[] = [
    makePeer('1', 10000, { municipalityName: 'Itabuna', contractNumber: '01/2026', sameSupplier: true }),
    makePeer('2', 10000, { municipalityName: 'Itabuna', contractNumber: '01/2026', sameSupplier: true }), // duplicate
    makePeer('3', 10500, { municipalityName: 'Ilhéus', contractNumber: '02/2026', sameSupplier: true }),
    makePeer('4', 11000, { municipalityName: 'Jequié', contractNumber: '03/2026', sameSupplier: false }), // excluded in same_supplier mode
    makePeer('5', 9800, { municipalityName: 'Vitória da Conquista', contractNumber: '04/2026', sameSupplier: true }),
    makePeer('6', 10200, { municipalityName: 'Alagoinhas', contractNumber: '05/2026', sameSupplier: true }),
  ];

  const res = evaluateHorizontalBenchmark({
    mode: 'same_supplier',
    serviceClass: 'Software',
    unitLabel: 'mês',
    subjectNominalPrice: 26000,
    subjectYear: 2026,
    inflationIndexLabel: 'IPCA (IBGE)',
    peers,
  });

  assert.equal(res.deduplicatedPeerCount, 1);
  assert.equal(res.peerCount, 4);
  assert.equal(res.state, 'OBSERVATION');
  assert.ok(res.peers.some((p) => p.id === '4' && !p.included));
});

test('Benchmark engine rejects unit mismatch without conversionFactor, accepts with conversionFactor, and handles MAD=0 & NaN safely', () => {
  const identicalPeers = [
    makePeer('1', 1000, { serviceClass: 'Serviço', unitLabel: 'mês' }),
    makePeer('2', 1000, { serviceClass: 'Serviço', unitLabel: 'mês' }),
    makePeer('3', 1000, { serviceClass: 'Serviço', unitLabel: 'mês' }),
    makePeer('4', 1000, { serviceClass: 'Serviço', unitLabel: 'mês' }),
    makePeer('5', 12000, { serviceClass: 'Serviço', unitLabel: 'ano' }), // incompatible unit, no factor
    makePeer('6', 12000, { serviceClass: 'Serviço', unitLabel: 'ano', conversionFactor: 1 / 12 }), // converted to 1000/mês
    makePeer('7', Number.NaN, { serviceClass: 'Serviço', unitLabel: 'mês' }), // invalid price
  ];

  const res = evaluateHorizontalBenchmark({
    mode: 'market',
    serviceClass: 'Serviço',
    unitLabel: 'mês',
    subjectNominalPrice: 2500,
    subjectYear: 2026,
    inflationIndexLabel: 'IPCA (IBGE)',
    peers: identicalPeers,
  });

  assert.equal(res.peerCount, 5);
  assert.equal(res.mad, 0);
  assert.equal(res.madZero, true);
  assert.equal(res.robustZ, null);
  assert.equal(res.peerRatio, 2.5);
  assert.equal(res.state, 'OBSERVATION');
});

test('Benchmark engine uses explicit nominal comparison when inflation series lacks year', () => {
  const peers = [
    makePeer('1', 100, { serviceClass: 'Insumos', unitLabel: 'unid', contractYear: 2019 }),
    makePeer('2', 110, { serviceClass: 'Insumos', unitLabel: 'unid', contractYear: 2019 }),
    makePeer('3', 120, { serviceClass: 'Insumos', unitLabel: 'unid', contractYear: 2019 }),
    makePeer('4', 105, { serviceClass: 'Insumos', unitLabel: 'unid', contractYear: 2019 }),
  ];
  const res = evaluateHorizontalBenchmark({
    mode: 'market',
    serviceClass: 'Insumos',
    unitLabel: 'unid',
    subjectNominalPrice: 200,
    subjectYear: 2019,
    inflationIndexLabel: 'IPCA',
    peers,
  });

  assert.equal(res.peerCount, 4);
  assert.equal(res.inflationApplied, false);
  assert.ok(res.controls.inflation.toLowerCase().includes('nominal'));
});

test('Legal ruleset returns inconclusive (never silent fallback) for missing, invalid, or out-of-coverage dates', () => {
  for (const badDate of ['', undefined, '2026-02-31', '2023-05-10', '2027-01-15']) {
    const res = resolveLegalRulesetStrict(badDate);
    assert.equal(res.status, 'inconclusive');
    assert.equal(res.ruleset.ruleId, 'BR-LEGAL-INCONCLUSIVE');
    assert.equal(getDispensationLimitForContract(res.ruleset, 'art75_II'), null);
  }
});

test('Risk engine refuses Conformidade preliminar when contract has zero sources and zero documents', () => {
  const base = FIXTURE_COMPLIANT;
  const emptyContract: ContractRecord = {
    ...base,
    id: 'EMPTY-TEST-01',
    sourceRecords: [],
    documents: [],
    payments: [],
    items: [],
    amendments: [],
    biddersCount: 4,
    supplier: { ...base.supplier, sanctions: [] },
  };
  const assessment = evaluateContractRisk(emptyContract);

  assert.equal(assessment.coverageStatus, 'INSUFFICIENT');
  assert.equal(assessment.classification, 'Cobertura insuficiente');
  assert.ok(assessment.headline.toLowerCase().includes('cobertura insuficiente'));
});

test('Risk engine marks mandatory risk matrix with undefined presence as NOT_VERIFIABLE (not NOT_APPLICABLE)', () => {
  const base = FIXTURE_COMPLIANT;
  const integratedUnknown: ContractRecord = {
    ...base,
    executionRegime: 'Integrado',
    riskMatrixPresent: undefined,
  };
  const assessment = evaluateContractRisk(integratedUnknown);
  const check = assessment.nonApplicableChecks.find((c) => c.code === 'BR-RISKMAT-001');

  assert.ok(check);
  assert.equal(check?.state, 'NOT_VERIFIABLE');
});

test('Risk engine deduplicates duplicate payments and keeps Empenho+Liquidação+Pagamento separate without summing to 300', () => {
  const base = FIXTURE_COMPLIANT;
  const contract: ContractRecord = {
    ...base,
    payments: [
      { id: 'p1', documentNumber: 'NE-1', date: '2026-03-01', type: 'Empenho', amount: 100, sourceSystem: 'Portal A' },
      { id: 'p2', documentNumber: 'NL-1', date: '2026-03-05', type: 'Liquidação', amount: 100, sourceSystem: 'Portal A' },
      { id: 'p3', documentNumber: 'OB-1', date: '2026-03-10', type: 'Pagamento', amount: 100, sourceSystem: 'Portal A' },
      { id: 'p4', documentNumber: 'OB-1', date: '2026-03-10', type: 'Pagamento', amount: 100, sourceSystem: 'Portal B (espelho)' },
    ],
  };

  const chain = analyzeExecutionChain(contract);
  assert.equal(chain.committedTotal, 100);
  assert.equal(chain.liquidatedTotal, 100);
  assert.equal(chain.paidTotal, 100);
  // No chronologicalPosition provided -> must be not_verifiable (never valid_sequence!)
  assert.equal(chain.chronologicalOrderStatus, 'not_verifiable');
});

test('Risk engine treats active Estadual sanction without scopeUf as NOT_VERIFIABLE instead of confirmed impediment', () => {
  const base = FIXTURE_COMPLIANT;
  const contract: ContractRecord = {
    ...base,
    supplier: {
      ...base.supplier,
      sanctions: [
        {
          id: 'SANC-AMB',
          registry: 'CEIS',
          sourceSystem: 'CGU',
          status: 'Ativa',
          scope: 'Estadual',
          scopeUf: undefined,
          reason: 'Suspensão estadual sem UF declarada',
          sanctioningOrgan: 'Secretaria Estadual',
          startDate: '2025-01-01',
          endDate: '2027-01-01',
          sourceUrl: 'https://portaldatransparencia.gov.br',
        },
      ],
    },
  };

  const assessment = evaluateContractRisk(contract);
  assert.equal(
    assessment.indicators.some((i) => i.code === 'BR-SANC-001'),
    false
  );
  const check = assessment.nonApplicableChecks.find((c) => c.code === 'BR-SANC-001');
  assert.equal(check?.state, 'NOT_VERIFIABLE');
});

test('Risk engine refuses productivity calculation when deliveredOutput or benchmarkUnitCost is 0', () => {
  const base = FIXTURE_COMPLIANT;
  const contract: ContractRecord = {
    ...base,
    productivity: {
      domain: 'Merenda Escolar',
      unitLabel: 'refeição',
      deliveredOutput: 0,
      contractedOutput: 1000,
      actualUnitCost: 15,
      benchmarkUnitCost: 10,
      benchmarkSource: 'FNDE',
    },
  };
  const assessment = evaluateContractRisk(contract);
  assert.equal(
    assessment.indicators.some((i) => i.code === 'BR-EFIC-001'),
    false
  );
  const check = assessment.nonApplicableChecks.find((c) => c.code === 'BR-EFIC-001');
  assert.equal(check?.state, 'NOT_VERIFIABLE');
});

test('Document magic-byte validation and public URL SSRF guard block spoofed files and internal hosts', () => {
  assert.equal(validateUploadedFileMagic(Buffer.from('%PDF-1.7\n'), 'application/pdf').valid, true);
  assert.equal(validateUploadedFileMagic(Buffer.from('<html>not a pdf</html>'), 'application/pdf').valid, false);
  assert.equal(validateUploadedFileMagic(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png').valid, true);
  assert.equal(validateUploadedFileMagic(Buffer.from('fake png'), 'image/png').valid, false);
  assert.equal(validateUploadedFileMagic(Buffer.from([0x41, 0x00, 0x42]), 'text/plain').valid, false);

  assert.equal(isSafePublicUrl('https://pncp.gov.br/api/search/'), true);
  assert.equal(isSafePublicUrl('http://127.0.0.1:3000/api'), false);
  assert.equal(isSafePublicUrl('http://169.254.169.254/latest/meta-data/'), false);
  assert.equal(isSafePublicUrl('http://localhost:8080/'), false);
  assert.equal(isSafePublicUrl('file:///etc/passwd'), false);
});

test('Strict document matching blocks CNPJ-only and ambiguous number-only auto-attachment', () => {
  // CNPJ alone must NEVER auto-attach
  const cnpjOnly = resolveDocumentContractMatch(
    { contractNumber: null, cnpj: '27841920000163', ibgeCode: null, municipalityName: null },
    TEST_FIXTURE_CONTRACTS
  );
  assert.equal(cnpjOnly.status, 'ambiguous');

  // Contract number 123/2026 exists in multiple municipalities -> ambiguous without IBGE/CNPJ
  const numberOnly = resolveDocumentContractMatch(
    { contractNumber: '123/2026', cnpj: null, ibgeCode: null, municipalityName: null },
    TEST_FIXTURE_CONTRACTS
  );
  assert.equal(numberOnly.status, 'ambiguous');
  if (numberOnly.status === 'ambiguous') {
    assert.ok(numberOnly.candidates.length >= 2);
  }

  // Composite key (contractNumber + ibgeCode) resolves deterministically
  const composite = resolveDocumentContractMatch(
    { contractNumber: '123/2026', cnpj: null, ibgeCode: '2910800', municipalityName: null },
    TEST_FIXTURE_CONTRACTS
  );
  assert.equal(composite.status, 'matched');
  if (composite.status === 'matched') {
    assert.equal(composite.contract.id, FIXTURE_HIGH_RISK.id);
  }
});

test('Native PDF FlateDecode extractor decodes compressed text streams and counts real pages', () => {
  const streamContent = 'BT (CONTRATO ADMINISTRATIVO 999/2026 CNPJ 08.562.959/0001-22 R$ 150.000,00) Tj ET';
  const compressed = zlib.deflateSync(Buffer.from(streamContent, 'latin1'));
  const pdfBuffer = Buffer.concat([
    Buffer.from(
      '%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Filter /FlateDecode >>\nstream\n',
      'latin1'
    ),
    compressed,
    Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
  ]);

  const extracted = extractNativePdfText(pdfBuffer);
  assert.equal(extracted.pageCount, 2);
  assert.equal(extracted.isLikelyScanned, false);
  assert.ok(extracted.text.includes('999/2026'));
  assert.ok(extracted.text.includes('08.562.959/0001-22'));
});

test('PNCP CNPJ role classifier strictly distinguishes fornecedor, orgao_contratante, subcontratado, and noise', () => {
  assert.equal(
    classifyCnpjRoleInPncpItem('08562959000122', {
      fornecedor_ni: '08562959000122',
      orgao_cnpj: '13856372000166',
    }),
    'fornecedor'
  );
  assert.equal(
    classifyCnpjRoleInPncpItem('13856372000166', {
      fornecedor_ni: '08562959000122',
      orgao_cnpj: '13856372000166',
    }),
    'orgao_contratante'
  );
  assert.equal(
    classifyCnpjRoleInPncpItem('11111111000191', {
      fornecedor_ni: '08562959000122',
      orgao_cnpj: '13856372000166',
      fornecedor_subcontratado_ni: '11111111000191',
    }),
    'subcontratado'
  );
  assert.equal(
    classifyCnpjRoleInPncpItem('99999999000199', {
      fornecedor_ni: '08562959000122',
      orgao_cnpj: '13856372000166',
    }),
    null
  );
});

test('SQLite store persists contracts, dossiers, and append-only finding reviews across database close and reopen', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexofis-db-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  try {
    const store1 = createNexofisStore(dbPath);
    assert.equal(store1.getSchemaVersion(), 6);

    const sample = FIXTURE_HIGH_RISK;
    store1.upsertContract(sample);
    store1.saveDossier({
      id: 'DOS-TEST-1',
      contractId: sample.id,
      contractNumber: sample.contractNumber,
      municipalityName: sample.municipalityName,
      municipalityIbge: sample.municipalityIbge,
      entityName: sample.entityName,
      supplierName: sample.supplier.legalName,
      riskScore: 82,
      savedAt: '2026-11-21T12:00:00.000Z',
      analystNote: 'Nota técnica persistida em SQLite.',
      sha256Digest: 'abc123def456',
    });
    store1.addFindingReview({
      id: 'REV-1',
      contractId: sample.id,
      findingId: 'FND-2026-0001',
      action: 'dismiss',
      author: 'Auditor Teste',
      rationale: 'Liminares judiciais verificadas nos autos.',
      ruleVersion: '2.1.0',
      createdAt: '2026-11-21T12:01:00.000Z',
    });
    store1.addFindingReview({
      id: 'REV-2',
      contractId: sample.id,
      findingId: 'FND-2026-0001',
      action: 'restore',
      author: 'Auditor Revisor',
      rationale: 'Reativado após revogação da liminar.',
      ruleVersion: '2.1.0',
      createdAt: '2026-11-21T12:02:00.000Z',
    });
    store1.close();

    // Reopen fresh instance simulating full process restart
    const store2 = createNexofisStore(dbPath);
    const restoredContract = store2.getStoredContractById(sample.id);
    const restoredDossiers = store2.listDossiers();
    const restoredReviews = store2.listFindingReviews(sample.id);
    store2.close();

    assert.ok(restoredContract);
    assert.equal(restoredContract?.id, sample.id);
    assert.equal(restoredDossiers.length, 1);
    assert.equal(restoredDossiers[0].analystNote, 'Nota técnica persistida em SQLite.');
    assert.equal(restoredReviews.length, 2);
    assert.equal(restoredReviews[0].action, 'dismiss');
    assert.equal(restoredReviews[1].action, 'restore');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

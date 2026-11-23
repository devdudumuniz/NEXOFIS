import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import type { NextFunction, Response } from 'express';
import type { BenchmarkPeer, ContractRecord } from '@nexofis/shared/types/audit';
import { FIXTURE_COMPLIANT } from '@nexofis/shared/lib/__fixtures__/testContracts';
import { evaluateHorizontalBenchmark } from '@nexofis/shared/lib/benchmarkEngine';
import {
  computeCnpjCheckDigits,
  formatCnpjValue,
  isAlphanumericCnpj,
  isValidCnpj,
  normalizeCnpj,
} from '@nexofis/shared/lib/cnpj';
import { aggregateRiskDashboard, classifyRiskTier } from '@nexofis/shared/lib/dashboardAggregator';
import { mapContractToOCDS } from '@nexofis/shared/lib/ocdsMapper';
import {
  analyzeExecutionChain,
  calculateWeightedPriceDeviation,
  evaluateContractRisk,
} from '@nexofis/shared/lib/riskEngine';
import { mapPncpSearchItemToContract } from '../pncpClient';
import { extractNativePdfText } from '../pdfExtractor';
import {
  createAuthMiddleware,
  isAuthEnforced,
  signNexofisToken,
  validateProductionAuthConfig,
  type AuthenticatedRequest,
} from '../authMiddleware';

function cloneCompliant(): ContractRecord {
  return JSON.parse(JSON.stringify(FIXTURE_COMPLIANT)) as ContractRecord;
}

// 1. Minimal PNCP payload -> zero invented dates, bidders, ATIVA, 2020 openingDate, or awards; BR-LEGAL-INCONCLUSIVE
test('A02/1: minimal PNCP payload never invents dates, biddersCount, ATIVA, openingDate, or OCDS awards', () => {
  const mapped = mapPncpSearchItemToContract(
    {
      numero_controle_pncp: '14043574000151-2-000999/2026',
      numero: '999/2026',
      orgao_cnpj: '14043574000151',
      fornecedor_ni: '27841920000163',
      description: 'Objeto mínimo publicado sem metadados completos',
    },
    'fornecedor',
    '2026-11-21T12:00:00.000Z'
  );

  assert.equal(mapped.signatureDate, '');
  assert.equal(mapped.startDate, '');
  assert.equal(mapped.endDate, '');
  assert.equal(mapped.biddersCount, null);
  assert.equal(mapped.modality, 'Não informada');
  assert.equal(mapped.supplier.registrationStatus, 'DESCONHECIDA');
  assert.equal(mapped.supplier.openingDate, '');

  const assessment = evaluateContractRisk(mapped);
  assert.equal(assessment.appliedLegalRuleset.ruleId, 'BR-LEGAL-INCONCLUSIVE');
  assert.equal(
    assessment.indicators.some((i) => i.code === 'COMP-001'),
    false,
    'Unknown biddersCount must NOT fabricate COMP-001 single bidder alert'
  );
  assert.ok(
    assessment.nonApplicableChecks.some(
      (c) => c.code === 'COMP-001' && c.state === 'NOT_VERIFIABLE'
    )
  );

  const ocds = mapContractToOCDS({ ...mapped, assessment });
  assert.equal(ocds.tender.numberOfTenderers, undefined);
  assert.equal(ocds.awards, undefined);
});

// 2. PNCP-only contract never gets unqualified compliance; INSUFFICIENT never enters distribution.low
test('A02/2: PNCP-only contract has PARTIAL coverage and INSUFFICIENT contracts route to unverifiable, never low', () => {
  const pncpOnly = mapPncpSearchItemToContract(
    {
      numero_controle_pncp: '14043574000151-2-000555/2026',
      numero: '555/2026',
      orgao_cnpj: '14043574000151',
      fornecedor_ni: '11222333000181',
      fornecedor_nome: 'Empresa Teste',
      data_assinatura: '2026-04-01',
      valor_global: 120000,
      modalidade_licitacao_nome: 'Pregão Eletrônico',
      description: 'Serviço regular com apenas registro PNCP',
    },
    'fornecedor',
    '2026-11-21T12:00:00.000Z'
  );
  const partialAssessment = evaluateContractRisk(pncpOnly);
  assert.equal(partialAssessment.coverageStatus, 'PARTIAL');
  assert.notEqual(partialAssessment.classification, 'Conformidade preliminar');

  const emptyContract: ContractRecord = {
    ...cloneCompliant(),
    id: 'INSUF-01',
    sourceRecords: [],
    documents: [],
    payments: [],
    items: [],
    amendments: [],
  };
  const insufAssessment = evaluateContractRisk(emptyContract);
  assert.equal(insufAssessment.coverageStatus, 'INSUFFICIENT');
  assert.equal(classifyRiskTier(insufAssessment.score, insufAssessment.coverageStatus), 'unverifiable');

  const dash = aggregateRiskDashboard([{ ...emptyContract, assessment: insufAssessment }]);
  assert.equal(dash.distribution.low, 0);
  assert.equal(dash.distribution.unverifiable, 1);
});

// 3. Imported PDF without PNCP network query -> no BR-TRANSP-001 fabricated absence or placeholder hashes
test('A02/3 & A06: imported PDF without verified PNCP query never fabricates BR-TRANSP-001 or placeholder SHA-256', () => {
  const pdfOnly: ContractRecord = {
    ...cloneCompliant(),
    id: 'PDF-ONLY-01',
    pncpControlNumber: '',
    originalValue: 0,
    updatedValue: 0,
    sourceRecords: [
      {
        id: 'SRC-PDF-1',
        sourceSystem: 'PDF Importado',
        externalId: 'doc-hash-123',
        reportedOriginalValue: 50000,
        reportedUpdatedValue: 50000,
        reportedSupplierCnpj: '11222333000181',
        reportedStatus: 'Vigente',
        reportedEndDate: '',
        retrievedAt: '2026-11-21T12:00:00.000Z',
        rawPayloadHash: '9'.repeat(64),
        parserVersion: 'test-v1',
        sourceUrl: '',
      },
    ],
    pncpVerification: {
      queried: false,
      status: 'not_queried',
    },
  };

  const assessment = evaluateContractRisk(pdfOnly);
  assert.equal(
    assessment.indicators.some((i) => i.code === 'BR-TRANSP-001'),
    false,
    'BR-TRANSP-001 must NOT trigger when PNCP was not queried'
  );
  assert.ok(
    assessment.nonApplicableChecks.some(
      (c) => c.code === 'BR-TRANSP-001' && c.state === 'NOT_VERIFIABLE'
    )
  );
  for (const ev of assessment.evidences) {
    assert.ok(!/^0{64}$/.test(ev.sha256), 'Must never emit all-zero placeholder SHA-256');
    assert.ok(!ev.sha256.includes('placeholder'), 'Must never emit placeholder SHA-256');
  }

  // Now verify BR-TRANSP-001 DOES trigger when PNCP was genuinely queried and confirmed no match
  const pncpQueriedNoMatch: ContractRecord = {
    ...pdfOnly,
    pncpVerification: {
      queried: true,
      queriedAt: '2026-11-21T12:01:00.000Z',
      status: 'completed_no_match',
    },
  };
  const queriedAssessment = evaluateContractRisk(pncpQueriedNoMatch);
  assert.ok(queriedAssessment.indicators.some((i) => i.code === 'BR-TRANSP-001'));
});

// 4. Payments with empty documentNumber do not collapse + OCDS IDs non-empty + single chronologicalPosition=99 -> not_verifiable
test('A05/4: distinct payments with empty documentNumber are preserved and single position=99 stays not_verifiable', () => {
  const c = cloneCompliant();
  c.payments = [
    {
      id: 'PAYMENT-A',
      documentNumber: '',
      date: '2026-04-10',
      type: 'Pagamento',
      amount: 100,
      sourceSystem: 'Portal Municipal',
      chronologicalPosition: 99,
    },
    {
      id: 'PAYMENT-B',
      documentNumber: '',
      date: '2026-04-10',
      type: 'Pagamento',
      amount: 100,
      sourceSystem: 'Portal Municipal',
    },
  ];

  const chain = analyzeExecutionChain(c);
  assert.equal(chain.paidTotal, 200);
  assert.equal(chain.chronologicalOrderStatus, 'not_verifiable');

  const assessment = evaluateContractRisk(c);
  const ocds = mapContractToOCDS({ ...c, assessment });
  assert.equal(ocds.contracts[0].implementation.transactions.length, 2);
  const ids = ocds.contracts[0].implementation.transactions.map((t) => t.id);
  assert.ok(ids.every((id) => typeof id === 'string' && id.trim().length > 0));
  assert.equal(new Set(ids).size, 2, 'OCDS transaction IDs must be distinct');
});

// 5. Partial price reference (R$100/R$100 + R$900/no-ref) -> 0% deviation, no 900% alert, explicit priceReferenceCoverage
test('A05/5: partial price reference excludes unreferenced items from weighted deviation and reports coverage', () => {
  const c = cloneCompliant();
  c.items = [
    {
      id: 'IT-REF',
      itemNumber: 1,
      description: 'Item com referência',
      unit: 'un',
      quantity: 1,
      unitPrice: 100,
      totalPrice: 100,
      referencePrice: 100,
      referenceSource: 'Painel de Preços',
      referenceDate: '2026-02-01',
    },
    {
      id: 'IT-NOREF',
      itemNumber: 2,
      description: 'Item sem referência oficial',
      unit: 'un',
      quantity: 1,
      unitPrice: 900,
      totalPrice: 900,
      referencePrice: 0,
      referenceSource: 'Sem Referência',
      referenceDate: '2026-02-01',
    },
  ];

  const stats = calculateWeightedPriceDeviation(c);
  assert.equal(stats.deviationPct, 0);
  assert.equal(stats.comparableItemCount, 1);
  assert.equal(stats.totalItemCount, 2);
  assert.equal(stats.comparableValueSharePct, 10);

  const assessment = evaluateContractRisk(c);
  assert.equal(assessment.weightedPriceDeviationPct, 0);
  assert.equal(
    assessment.indicators.some((i) => i.code === 'BR-PRICE-001'),
    false
  );
  assert.ok(assessment.priceReferenceCoverage);
  assert.equal(assessment.priceReferenceCoverage?.comparableItemCount, 1);
  assert.equal(assessment.priceReferenceCoverage?.totalItemCount, 2);
});

// 6. Mixed inflation (R$140/2021 vs 8 peers R$100/2020) -> pure nominal 1.40 (never 1.84)
test('A04/6: benchmark engine falls back to pure nominal comparison when any year lacks inflation factor', () => {
  const peers: BenchmarkPeer[] = Array.from({ length: 8 }, (_, idx) => ({
    id: `MIX-${idx}`,
    municipalityName: `Município ${idx}`,
    uf: 'BA',
    contractNumber: `10${idx}/2020`,
    contractYear: 2020,
    sameSupplier: true,
    serviceClass: 'SERVICO-MIX',
    unitLabel: 'un',
    nominalUnitPrice: 100,
    inflationAdjustedPrice: 100,
    scopeDistance: 0.05,
    slaComparable: true,
    licensingComparable: true,
    included: true,
  }));

  const res = evaluateHorizontalBenchmark({
    mode: 'market',
    serviceClass: 'SERVICO-MIX',
    unitLabel: 'un',
    subjectNominalPrice: 140,
    subjectYear: 2021,
    inflationIndexLabel: 'IPCA',
    peers,
  });

  assert.equal(res.inflationApplied, false);
  assert.equal(res.peerRatio, 1.4);
  assert.equal(res.subjectAdjustedPrice, 140);
  assert.equal(res.peerMedian, 100);
});

// 7. MAD=0 (8 peers R$100 vs R$300) -> robustZ: null, peerRatio: 3, finding emitted in evaluateContractRisk
test('A04/7: MAD=0 extreme outlier sets robustZ=null, peerRatio=3, and emits benchmark finding in evaluateContractRisk', () => {
  const c = cloneCompliant();
  c.benchmarkPeers = {
    mode: 'same_supplier',
    serviceClass: 'SERVICO-UNIFORME',
    unitLabel: 'hora',
    subjectNominalPrice: 300,
    inflationIndexLabel: 'IPCA-2026',
    peers: Array.from({ length: 8 }, (_, idx) => ({
      id: `MAD0-${idx}`,
      municipalityName: `Cidade ${idx}`,
      uf: 'BA',
      contractNumber: `20${idx}/2026`,
      contractYear: 2026,
      sameSupplier: true,
      serviceClass: 'SERVICO-UNIFORME',
      unitLabel: 'hora',
      nominalUnitPrice: 100,
      inflationAdjustedPrice: 100,
      scopeDistance: 0.05,
      slaComparable: true,
      licensingComparable: true,
      included: true,
    })),
  };

  const assessment = evaluateContractRisk(c);
  assert.ok(assessment.horizontalBenchmark);
  assert.equal(assessment.horizontalBenchmark?.mad, 0);
  assert.equal(assessment.horizontalBenchmark?.madZero, true);
  assert.equal(assessment.horizontalBenchmark?.robustZ, null);
  assert.equal(assessment.horizontalBenchmark?.peerRatio, 3);
  assert.ok(
    assessment.indicators.some((i) => i.code === 'BENCH_HORIZONTAL_SUPPLIER_V1'),
    'MAD=0 with peerRatio=3 must emit BENCH_HORIZONTAL_SUPPLIER_V1 finding'
  );
});

// 8. Alphanumeric CNPJ (RFB 2026) + legacy numeric + invalid DV rejected
test('A13/8: alphanumeric CNPJ (00.000.000/E08G-12) and legacy numeric validate accurately while bad DV is rejected', () => {
  assert.equal(computeCnpjCheckDigits('00000000E08G'), '12');
  assert.equal(isValidCnpj('00.000.000/E08G-12'), true);
  assert.equal(isAlphanumericCnpj('00.000.000/E08G-12'), true);
  assert.equal(formatCnpjValue('00000000E08G12'), '00.000.000/E08G-12');
  assert.equal(normalizeCnpj('00.000.000/e08g-12'), '00000000E08G12');

  // Invalid check digits rejected
  assert.equal(isValidCnpj('00.000.000/E08G-99'), false);
  assert.equal(isValidCnpj('10.562.589/0001-75'), true);
  assert.equal(isValidCnpj('10.562.589/0001-00'), false);
  assert.equal(isValidCnpj('00.000.000/0000-00'), false);
});

// 9. CNEP fine_only -> no BR-SANC-001; active impediment triggers; expired/unknown scope handled properly
test('A03/9: CNEP fine_only does not trigger BR-SANC-001 impediment, while active national impediment does', () => {
  const fineOnly = cloneCompliant();
  fineOnly.supplier.sanctions = [
    {
      id: 'CNEP-FINE-1',
      registry: 'CNEP',
      sourceSystem: 'Portal da Transparência (CGU)',
      status: 'Ativa',
      scope: 'Nacional',
      sanctionEffect: 'fine_only',
      reason: 'Multa pecuniária administrativa (Lei Anticorrupção, art. 6º, I)',
      sanctioningOrgan: 'CGU',
      startDate: '2025-01-01',
      endDate: '2027-12-31',
      sourceUrl: 'https://portaldatransparencia.gov.br',
    },
  ];
  const fineRes = evaluateContractRisk(fineOnly);
  assert.equal(
    fineRes.indicators.some((i) => i.code === 'BR-SANC-001'),
    false,
    'CNEP fine_only must NOT trigger BR-SANC-001 contracting impediment'
  );
  assert.ok(
    fineRes.nonApplicableChecks.some(
      (c) => c.code === 'BR-SANC-CNEP-MULTA' && c.state === 'NOT_APPLICABLE'
    )
  );

  const impediment = cloneCompliant();
  impediment.supplier.sanctions = [
    {
      ...fineOnly.supplier.sanctions[0],
      id: 'CEIS-IMP-1',
      registry: 'CEIS',
      sanctionEffect: 'impediment',
      reason: 'Impedimento de licitar e contratar',
    },
  ];
  const impRes = evaluateContractRisk(impediment);
  assert.ok(impRes.indicators.some((i) => i.code === 'BR-SANC-001'));
});

// 10. Dismissing COMP-001 then adding BR-PRICE-001 keeps findingId unchanged
test('A06/10: semantic findingId for COMP-001 stays invariant when earlier findings like BR-PRICE-001 are added', () => {
  const before = cloneCompliant();
  before.biddersCount = 1;
  const resBefore = evaluateContractRisk(before);
  const compBefore = resBefore.indicators.find((i) => i.code === 'COMP-001');
  assert.ok(compBefore, 'COMP-001 must trigger');

  const after = cloneCompliant();
  after.biddersCount = 1;
  after.items = [
    {
      id: 'IT-OVER',
      itemNumber: 1,
      description: 'Item superfaturado',
      unit: 'un',
      quantity: 1000,
      unitPrice: 150,
      totalPrice: 150_000,
      referencePrice: 100,
      referenceSource: 'Painel de Preços',
      referenceDate: '2026-02-01',
    },
  ];
  const resAfter = evaluateContractRisk(after);
  const compAfter = resAfter.indicators.find((i) => i.code === 'COMP-001');
  assert.ok(resAfter.indicators.some((i) => i.code === 'BR-PRICE-001'));
  assert.ok(compAfter);
  assert.equal(
    compAfter.findingId,
    compBefore.findingId,
    'COMP-001 findingId must remain identical regardless of array order/position'
  );
});

// 11. PDF decompression bomb (small compressed payload expanding > 1 MiB) -> bounded rejection without OOM
test('A11/11: PDF FlateDecode zip-bomb is safely rejected with budgetExceeded=true without OOM', () => {
  // 2 MiB of zeros compresses to ~2 KiB
  const hugeRaw = Buffer.alloc(2 * 1024 * 1024, 0x41);
  const compressed = zlib.deflateSync(hugeRaw);
  assert.ok(compressed.length < 10_000, 'Compressed bomb payload must be tiny');

  const pdfBomb = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Filter /FlateDecode >>\nstream\n', 'latin1'),
    compressed,
    Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
  ]);

  const extracted = extractNativePdfText(pdfBomb);
  assert.equal(extracted.budgetExceeded, true);
  assert.equal(extracted.truncated, true);
});

// 12. Production auth fail-closed (NODE_ENV=production without opt-in -> 401; valid token -> 200; viewer -> 403)
test('A09/12: production mode enforces fail-closed authentication and validates session secret length', () => {
  assert.equal(isAuthEnforced({ NODE_ENV: 'production' }), true);
  assert.equal(
    isAuthEnforced({ NODE_ENV: 'production', NEXOFIS_ALLOW_INSECURE_LOCAL: 'true' }),
    false
  );
  assert.equal(isAuthEnforced({ NODE_ENV: 'development' }), false);

  assert.throws(
    () => validateProductionAuthConfig({ NODE_ENV: 'production', NEXOFIS_SESSION_SECRET: 'short' }),
    /NEXOFIS_SESSION_SECRET/
  );
  assert.doesNotThrow(() =>
    validateProductionAuthConfig({
      NODE_ENV: 'production',
      NEXOFIS_SESSION_SECRET: 'a-very-strong-production-secret-key-0123456789',
    })
  );

  const secret = 'production-test-secret-with-more-than-32-chars-0123456';
  const mw = createAuthMiddleware({
    allowedRoles: ['admin', 'analyst'],
    enforceOverride: true,
    secret,
  });

  const makeMockRes = () => {
    let status = 200;
    let body: unknown = null;
    const res = {
      status(code: number) {
        status = code;
        return res;
      },
      json(payload: unknown) {
        body = payload;
        return res;
      },
    } as unknown as Response;
    return { res, getStatus: () => status, getBody: () => body };
  };

  // Unauthenticated -> 401
  const r401 = makeMockRes();
  mw({ headers: {} } as AuthenticatedRequest, r401.res, (() => {
    assert.fail('Should reject missing Bearer token');
  }) as NextFunction);
  assert.equal(r401.getStatus(), 401);

  // Viewer -> 403
  const viewerTok = signNexofisToken({ sub: 'u-v', role: 'viewer' }, { secret, ttlSeconds: 300 });
  const r403 = makeMockRes();
  mw(
    { headers: { authorization: `Bearer ${viewerTok}` } } as AuthenticatedRequest,
    r403.res,
    (() => {
      assert.fail('Should reject viewer role');
    }) as NextFunction
  );
  assert.equal(r403.getStatus(), 403);

  // Analyst -> 200 (next called)
  const analystTok = signNexofisToken(
    { sub: 'u-a', email: 'auditor@nexofis.org', displayName: 'Auditor Oficial', role: 'analyst' },
    { secret, ttlSeconds: 300 }
  );
  let passed = false;
  const reqOk = { headers: { authorization: `Bearer ${analystTok}` } } as AuthenticatedRequest;
  mw(reqOk, makeMockRes().res, (() => {
    passed = true;
  }) as NextFunction);
  assert.equal(passed, true);
  assert.equal(reqOk.nexofisPrincipal?.userId, 'u-a');
  assert.equal(reqOk.nexofisPrincipal?.displayName, 'Auditor Oficial');
});

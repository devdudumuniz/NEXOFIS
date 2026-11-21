import test from 'node:test';
import assert from 'node:assert/strict';
import { SEED_CONTRACTS } from '../data/brazilianSeedData';
import type { BenchmarkPeer, ContractRecord } from '../types/audit';
import { evaluateHorizontalBenchmark } from './benchmarkEngine';
import {
  getDispensationLimitForContract,
  isRiskMatrixMandatory,
  resolveLegalRulesetForDate,
} from './legalRules';
import { evaluateContractRisk } from './riskEngine';

function cloneBaseContract(): ContractRecord {
  const base = SEED_CONTRACTS.find((c) => c.id === 'FSA-2026-041')!;
  return JSON.parse(JSON.stringify(base)) as ContractRecord;
}

// 1. BENCHMARK REGRESSION SUITE (true_outlier, scope_mismatch, sample_too_small)
test('benchmark/true_outlier: flags high Median/MAD outlier when n >= 8 and peer_ratio >= 2.0', () => {
  const peers: BenchmarkPeer[] = Array.from({ length: 8 }, (_, idx) => ({
    id: `P-${idx}`,
    municipalityName: `Município ${idx}`,
    uf: 'BA',
    contractNumber: `00${idx}/2026`,
    contractYear: 2026,
    sameSupplier: true,
    serviceClass: 'SOFTWARE-ERP',
    unitLabel: 'usuário/mês',
    nominalUnitPrice: 8.0 + (idx % 3) * 0.4,
    inflationAdjustedPrice: 8.0 + (idx % 3) * 0.4,
    scopeDistance: 0.08,
    slaComparable: true,
    licensingComparable: true,
    included: true,
  }));

  const res = evaluateHorizontalBenchmark({
    serviceClass: 'SOFTWARE-ERP',
    unitLabel: 'usuário/mês',
    subjectNominalPrice: 17.5,
    subjectYear: 2026,
    inflationIndexLabel: 'IPCA-2026',
    peers,
  });

  assert.equal(res.state, 'OBSERVATION');
  assert.equal(res.evidenceLevel, 'B');
  assert.equal(res.peerCount, 8);
  assert.ok((res.peerRatio ?? 0) >= 2.0);
  assert.ok((res.robustZ ?? 0) >= 3.0);
});

test('benchmark/scope_mismatch: excludes peers whose scopeDistance > 0.20 and records exclusion reason', () => {
  const peers: BenchmarkPeer[] = [
    { id: 'A', municipalityName: 'A', uf: 'BA', contractNumber: '1/2026', contractYear: 2026, sameSupplier: true, serviceClass: 'ERP', unitLabel: 'usuário', nominalUnitPrice: 10, inflationAdjustedPrice: 10, scopeDistance: 0.45, slaComparable: true, licensingComparable: true, included: true },
    { id: 'B', municipalityName: 'B', uf: 'BA', contractNumber: '2/2026', contractYear: 2026, sameSupplier: true, serviceClass: 'ERP', unitLabel: 'usuário', nominalUnitPrice: 11, inflationAdjustedPrice: 11, scopeDistance: 0.05, slaComparable: false, licensingComparable: true, included: true },
  ];

  const res = evaluateHorizontalBenchmark({
    serviceClass: 'ERP',
    unitLabel: 'usuário',
    subjectNominalPrice: 25,
    subjectYear: 2026,
    inflationIndexLabel: 'IPCA-2026',
    peers,
  });

  assert.equal(res.peerCount, 0);
  assert.equal(res.excludedPeerCount, 2);
  assert.equal(res.state, 'NOT_VERIFIABLE');
  assert.ok(res.peers[0].exclusionReason?.includes('Distância de escopo'));
  assert.ok(res.peers[1].exclusionReason?.includes('SLA'));
});

test('benchmark/sample_too_small: refuses statistical inference when n < 4 (NOT_VERIFIABLE)', () => {
  const peers: BenchmarkPeer[] = [10, 11, 12].map((price, idx) => ({
    id: `S-${idx}`,
    municipalityName: `M-${idx}`,
    uf: 'BA',
    contractNumber: `${idx}/2026`,
    contractYear: 2026,
    sameSupplier: true,
    serviceClass: 'MERENDA',
    unitLabel: 'refeição',
    nominalUnitPrice: price,
    inflationAdjustedPrice: price,
    scopeDistance: 0.05,
    slaComparable: true,
    licensingComparable: true,
    included: true,
  }));

  const res = evaluateHorizontalBenchmark({
    serviceClass: 'MERENDA',
    unitLabel: 'refeição',
    subjectNominalPrice: 40,
    subjectYear: 2026,
    inflationIndexLabel: 'IPCA-2026',
    peers,
  });

  assert.equal(res.state, 'NOT_VERIFIABLE');
  assert.equal(res.robustZ, null);
  assert.equal(res.peerRatio, null);
});

// 2. LEGAL TEMPORALITY REGRESSION SUITE (2024 vs 2025 vs 2026 Decrees + Conditional Risk Matrix)
test('legal_temporality: resolves Decreto 11.871/2023 (2024), Decreto 12.343/2024 (2025), and Decreto 12.807/2025 (2026)', () => {
  const r2024 = resolveLegalRulesetForDate('2024-06-15');
  const r2025 = resolveLegalRulesetForDate('2025-08-20');
  const r2026 = resolveLegalRulesetForDate('2026-01-01');

  assert.equal(r2024.ruleId, 'BR-L14133-DEC11871-2024');
  assert.equal(getDispensationLimitForContract(r2024, 'art75_I'), 119812.02);

  assert.equal(r2025.ruleId, 'BR-L14133-DEC12343-2025');
  assert.equal(getDispensationLimitForContract(r2025, 'art75_I'), 125451.15);

  assert.equal(r2026.ruleId, 'BR-L14133-DEC12807-2026');
  assert.equal(getDispensationLimitForContract(r2026, 'art75_I'), 130984.2);
  assert.equal(getDispensationLimitForContract(r2026, 'art75_II'), 65492.11);
  assert.equal(getDispensationLimitForContract(r2026, 'art75_p7'), 10478.74);
  assert.equal(getDispensationLimitForContract(r2026, 'art95_p2'), 13098.41);
  assert.equal(r2026.thresholds?.grandeVulto, 261968421.04);
});

test('legal_temporality/risk_matrix: only mandatory for grande vulto or integrado/semi-integrado', () => {
  const r2026 = resolveLegalRulesetForDate('2026-05-01');

  assert.equal(
    isRiskMatrixMandatory({ updatedValue: 5_000_000, executionRegime: 'Fornecimento Contínuo', ruleset: r2026 }).mandatory,
    false
  );
  assert.equal(
    isRiskMatrixMandatory({ updatedValue: 5_000_000, executionRegime: 'Integrado', ruleset: r2026 }).mandatory,
    true
  );
  assert.equal(
    isRiskMatrixMandatory({ updatedValue: 270_000_000, executionRegime: 'Empreitada Global', ruleset: r2026 }).mandatory,
    true
  );
});

// 3. SPLIT PURCHASE REGRESSION SUITE
test('split_purchase: under_limit, different_branch, different_fiscal_year, and uncertain classification', () => {
  // Under 2026 art 75 II limit (65.492,11) -> no split finding
  const underLimit = cloneBaseContract();
  underLimit.modality = 'Dispensa de Licitação';
  underLimit.dispensationArticle = 'art75_II';
  underLimit.originalValue = 30000;
  underLimit.updatedValue = 30000;
  underLimit.relatedSameObjectCount12m = 2;
  underLimit.relatedSameObjectTotal12m = 60000;
  underLimit.relatedSameObjectSameFiscalYear = true;
  underLimit.relatedSameBranch = true;
  assert.ok(!evaluateContractRisk(underLimit).indicators.some((i) => i.code === 'BR-FRAC-001'));

  // Different fiscal year -> no split finding
  const diffYear = cloneBaseContract();
  diffYear.modality = 'Dispensa de Licitação';
  diffYear.dispensationArticle = 'art75_II';
  diffYear.relatedSameObjectCount12m = 3;
  diffYear.relatedSameObjectTotal12m = 120000;
  diffYear.relatedSameObjectSameFiscalYear = false;
  diffYear.relatedSameBranch = true;
  assert.ok(!evaluateContractRisk(diffYear).indicators.some((i) => i.code === 'BR-FRAC-001'));

  // Uncertain branch classification -> NOT_VERIFIABLE (no violation)
  const uncertain = cloneBaseContract();
  uncertain.modality = 'Dispensa de Licitação';
  uncertain.branchClassificationUncertain = true;
  uncertain.relatedSameObjectCount12m = 4;
  uncertain.relatedSameObjectTotal12m = 200000;
  const uncertainRes = evaluateContractRisk(uncertain);
  assert.ok(!uncertainRes.indicators.some((i) => i.code === 'BR-FRAC-001'));
  assert.ok(uncertainRes.nonApplicableChecks.some((c) => c.code === 'BR-FRAC-001' && c.state === 'NOT_VERIFIABLE'));
});

// 4. SANCTIONS REGRESSION SUITE (active, expired, different_entity)
test('sanctions: expired or different-entity sanctions do NOT trigger BR-SANC-001', () => {
  // Expired sanction before signatureDate
  const expired = cloneBaseContract();
  expired.signatureDate = '2026-04-10';
  expired.supplier.sanctions = [
    {
      id: 'S-EXP',
      registry: 'CEIS',
      sourceSystem: 'CGU',
      status: 'Encerrada',
      scope: 'Nacional',
      reason: 'Sanção expirada em 2025',
      sanctioningOrgan: 'União',
      startDate: '2023-01-01',
      endDate: '2025-12-31',
      sourceUrl: 'https://portaldatransparencia.gov.br',
    },
  ];
  const expRes = evaluateContractRisk(expired);
  assert.ok(!expRes.indicators.some((i) => i.code === 'BR-SANC-001'));
  assert.ok(expRes.nonApplicableChecks.some((c) => c.code === 'BR-SANC-001' && c.state === 'NOT_APPLICABLE'));

  // Different-entity local sanction (scoped only to another municipality)
  const diffEnt = cloneBaseContract();
  diffEnt.signatureDate = '2026-04-10';
  diffEnt.municipalityName = 'Feira de Santana';
  diffEnt.uf = 'BA';
  diffEnt.supplier.sanctions = [
    {
      id: 'S-ENT',
      registry: 'CEIS',
      sourceSystem: 'CGU',
      status: 'Ativa',
      scope: 'Órgão Sancionador',
      reason: 'Suspensão restrita ao órgão sancionador em outro município',
      sanctioningOrgan: 'Prefeitura Municipal de Campinas',
      startDate: '2025-01-01',
      endDate: '2027-01-01',
      sourceUrl: 'https://portaldatransparencia.gov.br',
    },
  ];
  assert.ok(!evaluateContractRisk(diffEnt).indicators.some((i) => i.code === 'BR-SANC-001'));
});

// 5. PAYMENT CHRONOLOGICAL ORDER REGRESSION SUITE (valid_sequence, justified_exception, unexplained_break)
test('payment_order: distinguishes valid_sequence, justified_exception, and unexplained_break', () => {
  // Valid sequence
  const valid = cloneBaseContract();
  assert.equal(evaluateContractRisk(valid).executionChain.chronologicalOrderStatus, 'valid_sequence');

  // Justified published exception -> NOT flagged as irregularity
  const justified = cloneBaseContract();
  justified.payments.push({
    id: 'P-JUST',
    documentNumber: 'OB-999',
    date: '2026-07-10',
    type: 'Pagamento',
    amount: 50000,
    sourceSystem: 'Portal Municipal',
    fundingSource: 'SUS',
    paidOutOfOrder: true,
    outOfOrderJustification: 'Calamidade pública declarada art. 141 §1º',
    justificationPublished: true,
  });
  const justRes = evaluateContractRisk(justified);
  assert.equal(justRes.executionChain.chronologicalOrderStatus, 'justified_exception');
  assert.ok(!justRes.indicators.some((i) => i.code === 'BR-PAYORD-001'));

  // Unexplained break -> triggers BR-PAYORD-001
  const broken = cloneBaseContract();
  broken.payments.push({
    id: 'P-BRK',
    documentNumber: 'OB-998',
    date: '2026-07-12',
    type: 'Pagamento',
    amount: 50000,
    sourceSystem: 'Portal Municipal',
    fundingSource: 'SUS',
    paidOutOfOrder: true,
    justificationPublished: false,
  });
  const brkRes = evaluateContractRisk(broken);
  assert.equal(brkRes.executionChain.chronologicalOrderStatus, 'unexplained_break');
  assert.ok(brkRes.indicators.some((i) => i.code === 'BR-PAYORD-001'));
});

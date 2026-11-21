import test from 'node:test';
import assert from 'node:assert/strict';
import { SEED_CONTRACTS } from '../data/brazilianSeedData';
import {
  calculateWeightedPriceDeviation,
  detectSourceDivergences,
  evaluateContractRisk,
} from './riskEngine';
import { extractFieldsFromNativeText, parseBrazilianMoney } from './documentParser';

test('Feira de Santana Contrato 123/2026 reproduces exact benchmark risk score 82/100 and +30.48% variation', () => {
  const fsa123 = SEED_CONTRACTS.find((c) => c.id === 'FSA-2026-123');
  assert.ok(fsa123, 'Flagship contract FSA-2026-123 must exist in seed dataset');

  const result = evaluateContractRisk(fsa123);

  assert.equal(result.score, 82);
  assert.equal(result.variationPct, 30.48);
  assert.equal(result.headline, 'RISCO 82/100 — revisão humana recomendada');
  assert.equal(result.appliedLegalRuleset.ruleId, 'BR-L14133-DEC12807-2026');
  assert.ok(result.indicators.some((i) => i.code === 'BR-SANC-001' && i.severity === 'CRÍTICA'));
  assert.ok(result.indicators.some((i) => i.code === 'BR-PRICE-001' && i.severity === 'ALTA'));
  assert.ok(result.indicators.some((i) => i.code === 'BENCH_HORIZONTAL_SUPPLIER_V1' && i.state === 'OBSERVATION'));
  assert.ok(result.indicators.some((i) => i.code === 'COMP-001' && i.severity === 'MÉDIA'));
  assert.ok(result.indicators.some((i) => i.code === 'BR-ADIT-001' && i.severity === 'ALTA'));
  assert.ok(result.indicators.some((i) => i.code === 'BR-CNAE-001' && i.severity === 'MÉDIA'));
  assert.equal(result.evidences.length, result.indicators.length);
  // Never assert "fraude detectada" in headline
  assert.ok(!result.headline.toLowerCase().includes('fraude'));
});

test('Low-risk compliant contract scores 0 with preliminary conformity', () => {
  const clean = SEED_CONTRACTS.find((c) => c.id === 'FSA-2026-041');
  assert.ok(clean);

  const result = evaluateContractRisk(clean);
  assert.equal(result.score, 0);
  assert.equal(result.indicators.length, 0);
  assert.equal(result.classification, 'Conformidade preliminar');
});

test('Source divergence engine preserves all sources without overwriting and flags value deltas', () => {
  const fsa123 = SEED_CONTRACTS.find((c) => c.id === 'FSA-2026-123')!;
  const divergences = detectSourceDivergences(fsa123);

  assert.ok(divergences.length >= 1);
  assert.equal(divergences[0].field, 'Valor atualizado do contrato');
  assert.equal(divergences[0].sources.length, 3);
});

test('Weighted price deviation computes exact percentage against reference prices', () => {
  const fsa123 = SEED_CONTRACTS.find((c) => c.id === 'FSA-2026-123')!;
  const priceStats = calculateWeightedPriceDeviation(fsa123);

  assert.ok(priceStats.deviationPct > 30 && priceStats.deviationPct < 33);
  assert.ok(priceStats.highestItem);
});

test('Fracionamento rule triggers on Curitiba dispensation near legal threshold', () => {
  const cwb123 = SEED_CONTRACTS.find((c) => c.id === 'CWB-2026-123')!;
  const result = evaluateContractRisk(cwb123);

  assert.ok(result.indicators.some((i) => i.code === 'BR-FRAC-001'));
  assert.ok(result.indicators.some((i) => i.code === 'COMP-001'));
});

test('Spend vs Output productivity rule catches physical-financial gap on paving contract', () => {
  const obra = SEED_CONTRACTS.find((c) => c.id === 'FSA-2026-204')!;
  const result = evaluateContractRisk(obra);

  assert.ok(result.indicators.some((i) => i.code === 'BR-EFIC-001'));
});

test('Native document parser extracts contract number, CNPJ, IBGE and Brazilian monetary values', () => {
  assert.equal(parseBrazilianMoney('R$ 4.200.000,00'), 4200000);

  const sampleText = `
    CONTRATO ADMINISTRATIVO Nº 123/2026
    CONTRATANTE: Secretaria Municipal de Saúde de Feira de Santana (IBGE 2910800)
    CONTRATADA: Vértice Logística e Eventos Corporativos Ltda, CNPJ 27.841.920/0001-63
    OBJETO: Fornecimento contínuo de medicamentos essenciais e insumos hospitalares
    Valor global inicial: R$ 4.200.000,00. Valor atualizado: R$ 5.480.000,00.
    Assinado em 18/01/2026.
  `;

  const extracted = extractFieldsFromNativeText(sampleText, 'docling');
  assert.equal(extracted.contractNumber, '123/2026');
  assert.equal(extracted.cnpj, '27841920000163');
  assert.equal(extracted.ibgeCode, '2910800');
  assert.equal(extracted.originalValue, 4200000);
  assert.equal(extracted.updatedValue, 5480000);
  assert.equal(extracted.signatureDate, '2026-01-18');
  assert.ok(extracted.excerpts.length >= 4);
});

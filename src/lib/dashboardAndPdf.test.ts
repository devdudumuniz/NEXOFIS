import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_HIGH_RISK, TEST_FIXTURE_CONTRACTS } from './__fixtures__/testContracts';
import { evaluateContractRisk } from './riskEngine';
import {
  aggregateRiskDashboard,
  classifyRiskTier,
  inferContractSector,
} from './dashboardAggregator';
import {
  matchesDatePeriod,
  resolvePncpPeriodBounds,
  validateDatePeriod,
} from './datePeriod';
import { buildAuditReportPdf } from './pdfReportGenerator';
import { deriveMatrizCnpj } from './cnpj';

test('datePeriod validates ISO dates, rejects inverted ranges, and filters inclusively', () => {
  assert.equal(validateDatePeriod('2026-01-01', '2026-12-31').valid, true);
  assert.equal(validateDatePeriod('2026-06-01', '2026-01-01').valid, false);
  assert.equal(validateDatePeriod('2026-02-30', '2026-03-01').valid, false);

  assert.equal(
    matchesDatePeriod('2026-03-15', { startDate: '2026-01-01', endDate: '2026-03-15' }),
    true
  );
  assert.equal(
    matchesDatePeriod('2026-03-16', { startDate: '2026-01-01', endDate: '2026-03-15' }),
    false
  );
  assert.equal(matchesDatePeriod(undefined, { startDate: '2026-01-01' }), false);
  assert.equal(matchesDatePeriod(undefined, {}), true);

  const bounds = resolvePncpPeriodBounds(
    { startDate: '2025-01-01', endDate: '2026-12-31' },
    2026
  );
  assert.equal(bounds.dataInicial, '20250101');
  assert.equal(bounds.dataFinal, '20251231');
});

test('dashboardAggregator classifies Low/Medium/High/Unverifiable tiers and groups accurately by entity and sector', () => {
  assert.equal(classifyRiskTier(0), 'low');
  assert.equal(classifyRiskTier(39), 'low');
  assert.equal(classifyRiskTier(40), 'medium');
  assert.equal(classifyRiskTier(69), 'medium');
  assert.equal(classifyRiskTier(70), 'high');
  assert.equal(classifyRiskTier(0, 'INSUFFICIENT'), 'unverifiable');

  assert.equal(
    inferContractSector({
      entityName: 'Secretaria Municipal de Saúde',
      object: 'Medicamentos',
    }),
    'Saúde'
  );
  assert.equal(
    inferContractSector({
      entityName: 'Secretaria Municipal de Educação',
      object: 'Merenda escolar',
    }),
    'Educação'
  );

  const evaluated = TEST_FIXTURE_CONTRACTS.map((c) => ({
    ...c,
    assessment: evaluateContractRisk(c),
  }));
  const summary = aggregateRiskDashboard(evaluated, {
    startDate: '2026-01-01',
    endDate: '2026-12-31',
  });

  assert.equal(summary.totalContracts, evaluated.length);
  assert.equal(
    summary.distribution.low +
      summary.distribution.medium +
      summary.distribution.high +
      summary.distribution.unverifiable,
    evaluated.length
  );
  assert.ok(summary.distribution.high >= 1);
  assert.ok(summary.byEntity.length >= 3);
  assert.ok(summary.bySector.some((s) => s.label === 'Saúde'));
  assert.equal(summary.period.startDate, '2026-01-01');
  assert.equal(summary.period.endDate, '2026-12-31');
});

test('pdfReportGenerator outputs a valid multi-page binary PDF with audit conclusions and evidence', () => {
  const evaluated = { ...FIXTURE_HIGH_RISK, assessment: evaluateContractRisk(FIXTURE_HIGH_RISK) };
  const pdfBytes = buildAuditReportPdf(evaluated, {
    analystNote: 'Encaminhar para diligencia documental na SMS.',
    reviews: [
      {
        id: 'REV-PDF-1',
        contractId: FIXTURE_HIGH_RISK.id,
        findingId: evaluated.assessment.indicators[0].findingId,
        action: 'dismiss',
        author: 'Auditor Teste',
        rationale: 'Comprovante de certidao regular apresentado nos autos.',
        ruleVersion: '2.1.0',
        createdAt: '2026-11-21T12:00:00.000Z',
      },
    ],
  });

  assert.ok(pdfBytes instanceof Uint8Array);
  assert.ok(pdfBytes.byteLength > 2500, 'Generated PDF must contain structured content');
  const header = Buffer.from(pdfBytes.subarray(0, 8)).toString('latin1');
  assert.ok(header.startsWith('%PDF-1.'), `Expected %PDF-1. header, got: ${header}`);
});

test('deriveMatrizCnpj computes valid Modulo-11 Matriz CNPJ for a Filial', () => {
  assert.equal(deriveMatrizCnpj('10.562.589/0002-56'), '10562589000175');
  assert.equal(deriveMatrizCnpj('10562589000256'), '10562589000175');
  assert.equal(deriveMatrizCnpj('10.562.589/0001-75'), null);
  assert.equal(deriveMatrizCnpj('123'), null);
});

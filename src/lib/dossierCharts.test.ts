import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_HIGH_RISK, FIXTURE_COMPLIANT } from './__fixtures__/testContracts';
import { evaluateContractRisk } from './riskEngine';
import {
  buildFinancialComparisonChartData,
  buildIndicatorWeightChartData,
  buildSeverityDistributionChartData,
} from './dossierCharts';
import { buildAuditReportPdf } from './pdfReportGenerator';
import type { EvaluatedContract } from '../types/audit';

// Minimal valid 1x1 red PNG as base64 for testing jsPDF image embedding in Node
const SAMPLE_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('buildIndicatorWeightChartData and buildSeverityDistributionChartData respect dismissed findings', () => {
  const evaluated: EvaluatedContract = {
    ...FIXTURE_HIGH_RISK,
    assessment: evaluateContractRisk(FIXTURE_HIGH_RISK),
  };

  const fullWeights = buildIndicatorWeightChartData(evaluated);
  assert.equal(fullWeights.length, evaluated.assessment.indicators.length);
  assert.ok(fullWeights[0].effectivePoints >= fullWeights[fullWeights.length - 1].effectivePoints);

  const dismissedId = evaluated.assessment.indicators[0].findingId;
  const dismissedSet = new Set<string>([dismissedId]);

  const adjustedWeights = buildIndicatorWeightChartData(evaluated, dismissedSet);
  const dismissedRow = adjustedWeights.find((row) => row.findingId === dismissedId);
  assert.ok(dismissedRow);
  assert.equal(dismissedRow.dismissed, true);
  assert.equal(dismissedRow.effectivePoints, 0);

  const fullDist = buildSeverityDistributionChartData(evaluated);
  const adjustedDist = buildSeverityDistributionChartData(evaluated, dismissedSet);
  const totalFullCount = fullDist.reduce((acc, item) => acc + item.count, 0);
  const totalAdjustedCount = adjustedDist.reduce((acc, item) => acc + item.count, 0);
  assert.equal(totalAdjustedCount, totalFullCount - 1);
});

test('buildFinancialComparisonChartData never fabricates Level 2 execution bars when payments are empty', () => {
  const withPayments: EvaluatedContract = {
    ...FIXTURE_HIGH_RISK,
    assessment: evaluateContractRisk(FIXTURE_HIGH_RISK),
  };
  const withoutPayments: EvaluatedContract = {
    ...FIXTURE_COMPLIANT,
    payments: [],
    assessment: evaluateContractRisk({ ...FIXTURE_COMPLIANT, payments: [] }),
  };

  const fullChart = buildFinancialComparisonChartData(withPayments);
  assert.equal(fullChart.hasContractValue, true);
  assert.equal(fullChart.hasFinancialExecution, true);
  assert.equal(fullChart.bars.length, 5);

  const noExecChart = buildFinancialComparisonChartData(withoutPayments);
  assert.equal(noExecChart.hasContractValue, true);
  assert.equal(noExecChart.hasFinancialExecution, false);
  assert.equal(noExecChart.bars.length, 2);
  assert.deepEqual(
    noExecChart.bars.map((b) => b.stage),
    ['Original', 'Atualizado']
  );
});

test('buildAuditReportPdf embeds Recharts PNG chart images into consolidated PDF cleanly', () => {
  const evaluated: EvaluatedContract = {
    ...FIXTURE_HIGH_RISK,
    assessment: evaluateContractRisk(FIXTURE_HIGH_RISK),
  };

  const pdfWithoutCharts = buildAuditReportPdf(evaluated);
  const pdfWithCharts = buildAuditReportPdf(evaluated, {
    analystNote: 'Relatorio consolidado com graficos Recharts para apresentacao oficial.',
    chartImages: [
      {
        title: 'Contribuicao de Risco por Indicador Forense (Pontos)',
        subtitle: 'Peso efetivo de cada regra acionada',
        dataUrl: SAMPLE_PNG_DATA_URL,
        aspectRatio: 2.2,
      },
      {
        title: 'Distribuicao de Achados Ativos por Severidade',
        dataUrl: SAMPLE_PNG_DATA_URL,
        aspectRatio: 1.5,
      },
    ],
  });

  assert.ok(pdfWithCharts instanceof Uint8Array);
  const header = Buffer.from(pdfWithCharts.subarray(0, 8)).toString('latin1');
  assert.ok(header.startsWith('%PDF-1.'), `Expected %PDF-1. header, got: ${header}`);
  assert.ok(
    pdfWithCharts.byteLength > pdfWithoutCharts.byteLength,
    'Consolidated PDF with embedded chart PNGs should be larger than chartless PDF'
  );
});

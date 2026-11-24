import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePairedDidEffect,
  validateDidDesign,
  type DidDesignInput,
  type PairedDidInput,
} from '@nexofis/shared/lib/outcomesEvaluationEngine';

/**
 * Defeito 1.4 — Indicadores: metodo reprova analise, mas resultado continua vermelho.
 * Correcao: eligible=false retorna METODOLOGIA_REPROVADA; didDesign ausente retorna CONTRASTE_DESCRITIVO.
 */
test('1.4a DiD with eligible=false produces METODOLOGIA_REPROVADA, not ALERTA_VERMELHO', () => {
  const didDesign: DidDesignInput = {
    comparisonGroupJustification: null,
    prePeriodTreatedCount: 12,
    prePeriodControlCount: 12,
    postPeriodTreatedCount: 12,
    postPeriodControlCount: 12,
    preTrendsTested: false,
    preTrendsParallel: null,
    explicitAssumptions: [],
    uncertaintyReported: false,
  };

  const validation = validateDidDesign(didDesign);
  assert.equal(validation.eligible, false);
  assert.ok(validation.blockingReasons.length >= 3, 'Must have multiple blocking reasons');

  const input: PairedDidInput = {
    contractId: 'CTR-DID-FAIL',
    indicatorId: 'TEST_IND',
    indicatorName: 'Test Indicator',
    domain: 'saude',
    sourceSystem: 'TEST',
    contractSignatureDate: '2025-01-10',
    preWindowMonths: 12,
    postWindowMonths: 12,
    improvementDirection: 'higher_is_better',
    treatedMunicipalityCode: '2902906',
    treatedMunicipalityName: 'Tratado',
    treatedPreValue: 50,
    treatedPostValue: 51,
    installmentsPaidPct: 100,
    controlMunicipalities: [
      { municipalityCode: '001', municipalityName: 'A', microregion: 'X', populationBand: '20k', hadSimilarConsultancy: false, preValue: 50, postValue: 55 },
      { municipalityCode: '002', municipalityName: 'B', microregion: 'X', populationBand: '20k', hadSimilarConsultancy: false, preValue: 50, postValue: 55 },
      { municipalityCode: '003', municipalityName: 'C', microregion: 'X', populationBand: '20k', hadSimilarConsultancy: false, preValue: 50, postValue: 55 },
    ],
    didDesign,
  };

  const result = computePairedDidEffect(input);

  assert.equal(result.alertLevel, 'METODOLOGIA_REPROVADA', 'Must NOT produce ALERTA_VERMELHO when eligible=false');
  assert.notEqual(result.alertLevel, 'ALERTA_VERMELHO_INEFETIVIDADE');
  assert.equal(result.serviceClassifiedAsFictitious, false);
  assert.ok(result.limitations.some((l) => l.includes('Inferencia causal bloqueada')));
  assert.ok(result.didValidation);
  assert.equal(result.didValidation?.eligible, false);
});

test('1.4b DiD without didDesign produces CONTRASTE_DESCRITIVO, not ALERTA_VERMELHO', () => {
  const input: PairedDidInput = {
    contractId: 'CTR-DID-NODESIGN',
    indicatorId: 'TEST_IND',
    indicatorName: 'Test Indicator',
    domain: 'saude',
    sourceSystem: 'TEST',
    contractSignatureDate: '2025-01-10',
    preWindowMonths: 12,
    postWindowMonths: 12,
    improvementDirection: 'higher_is_better',
    treatedMunicipalityCode: '2902906',
    treatedMunicipalityName: 'Tratado',
    treatedPreValue: 50,
    treatedPostValue: 50,
    installmentsPaidPct: 100,
    controlMunicipalities: [
      { municipalityCode: '001', municipalityName: 'A', microregion: 'X', populationBand: '20k', hadSimilarConsultancy: false, preValue: 50, postValue: 55 },
      { municipalityCode: '002', municipalityName: 'B', microregion: 'X', populationBand: '20k', hadSimilarConsultancy: false, preValue: 50, postValue: 55 },
      { municipalityCode: '003', municipalityName: 'C', microregion: 'X', populationBand: '20k', hadSimilarConsultancy: false, preValue: 50, postValue: 55 },
    ],
  };

  const result = computePairedDidEffect(input);

  assert.equal(result.alertLevel, 'CONTRASTE_DESCRITIVO_SEM_INFERENCIA', 'Without didDesign, must produce descriptive contrast, not causal alert');
  assert.notEqual(result.alertLevel, 'ALERTA_VERMELHO_INEFETIVIDADE');
  assert.equal(result.serviceClassifiedAsFictitious, false);
  assert.ok(result.limitations.some((l) => l.includes('didDesign ausente')));
});

test('1.4c DiD with eligible didDesign and negative effect produces ALERTA_VERMELHO (no false negative)', () => {
  const didDesign: DidDesignInput = {
    comparisonGroupJustification: 'Municipios pareados por microrregiao e faixa populacional, sem consultoria equivalente.',
    prePeriodTreatedCount: 12,
    prePeriodControlCount: 12,
    postPeriodTreatedCount: 12,
    postPeriodControlCount: 12,
    preTrendsTested: true,
    preTrendsParallel: true,
    explicitAssumptions: ['parallel-trends-assumption'],
    uncertaintyReported: true,
  };

  const validation = validateDidDesign(didDesign);
  assert.equal(validation.eligible, true, 'Fully justified didDesign must be eligible');

  const input: PairedDidInput = {
    contractId: 'CTR-DID-OK',
    indicatorId: 'TEST_IND',
    indicatorName: 'Test Indicator',
    domain: 'saude',
    sourceSystem: 'TEST',
    contractSignatureDate: '2025-01-10',
    preWindowMonths: 12,
    postWindowMonths: 12,
    improvementDirection: 'higher_is_better',
    treatedMunicipalityCode: '2902906',
    treatedMunicipalityName: 'Tratado',
    treatedPreValue: 52,
    treatedPostValue: 53,
    installmentsPaidPct: 100,
    controlMunicipalities: [
      { municipalityCode: '001', municipalityName: 'A', microregion: 'X', populationBand: '20k', hadSimilarConsultancy: false, preValue: 50, postValue: 55 },
      { municipalityCode: '002', municipalityName: 'B', microregion: 'X', populationBand: '20k', hadSimilarConsultancy: false, preValue: 51, postValue: 56 },
      { municipalityCode: '003', municipalityName: 'C', microregion: 'X', populationBand: '20k', hadSimilarConsultancy: false, preValue: 49, postValue: 54 },
    ],
    didDesign,
  };

  const result = computePairedDidEffect(input);

  assert.equal(result.alertLevel, 'ALERTA_VERMELHO_INEFETIVIDADE', 'Eligible didDesign + negative effect + 100% paid must produce alert');
  assert.equal(result.serviceClassifiedAsFictitious, false, 'Even with alert, service is never classified as fictitious');
});

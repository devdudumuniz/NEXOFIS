import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateInvestigativePriceComparison,
  type PriceComparabilityProfile,
  type ComparablePricePeerInput,
} from '@nexofis/shared/lib/benchmarkEngine';

/**
 * Defeito 1.5 — Precos: cimento e areia entram na mesma comparacao.
 * Correcao: checagem de sobreposicao de tokens de especificacao + UF + competencia.
 */
test('1.5a Cement vs sand: different specifications are excluded even with same itemKind', () => {
  const subject: PriceComparabilityProfile = {
    specification: 'Cimento Portland CP II 32',
    unitLabel: 'kg',
    quantity: 1000,
    uf: 'BA',
    competencia: '2026-01',
    deliveryCondition: 'retirada no deposito',
    includesFreight: false,
    includesInstallationOrService: false,
    includesTaxesAndCharges: true,
    itemKind: 'insumo',
    referenceSource: 'SINAPI',
    referenceVersion: '2026-01',
  };

  const sandPeers: ComparablePricePeerInput[] = Array.from({ length: 8 }, (_, i) => ({
    id: `sand-${i}`,
    municipalityName: `Municipio ${i}`,
    uf: 'BA',
    contractNumber: `00${i}/2026`,
    contractYear: 2026,
    sameSupplier: false,
    serviceClass: 'INSUMO_OBRA',
    unitLabel: 'kg',
    nominalUnitPrice: 0.27,
    inflationAdjustedPrice: 0.27,
    scopeDistance: 0.1,
    slaComparable: true,
    licensingComparable: true,
    included: true,
    profile: {
      specification: 'Areia media para construcao',
      unitLabel: 'kg',
      quantity: 1000,
      uf: 'BA',
      competencia: '2026-01',
      deliveryCondition: 'retirada no deposito',
      includesFreight: false,
      includesInstallationOrService: false,
      includesTaxesAndCharges: true,
      itemKind: 'insumo',
      referenceSource: 'SINAPI',
      referenceVersion: '2026-01',
    },
  }));

  const result = evaluateInvestigativePriceComparison({
    subjectProfile: subject,
    peers: sandPeers,
    serviceClass: 'INSUMO_OBRA',
    subjectNominalPrice: 0.80,
    subjectYear: 2026,
    inflationIndexLabel: 'IPCA-2026',
  });

  assert.equal(result.excludedPeers.length, 8, 'All 8 sand peers must be excluded');
  assert.equal(result.includedPeers.length, 0, 'No sand peer should be included');
  for (const excluded of result.excludedPeers) {
    assert.ok(excluded.reasons.some((r) => r.includes('Especificacao incompativel')), 'Must have specification exclusion reason');
  }
});

test('1.5b Same specification from different UF is excluded', () => {
  const subject: PriceComparabilityProfile = {
    specification: 'Cimento Portland CP II 32',
    unitLabel: 'kg',
    quantity: 1000,
    uf: 'BA',
    competencia: '2026-01',
    deliveryCondition: 'retirada no deposito',
    includesFreight: false,
    includesInstallationOrService: false,
    includesTaxesAndCharges: true,
    itemKind: 'insumo',
    referenceSource: 'SINAPI',
    referenceVersion: '2026-01',
  };

  const peers: ComparablePricePeerInput[] = [
    {
      id: 'p1',
      municipalityName: 'Municipio SP',
      uf: 'SP',
      contractNumber: '001/2026',
      contractYear: 2026,
      sameSupplier: false,
      serviceClass: 'INSUMO_OBRA',
      unitLabel: 'kg',
      nominalUnitPrice: 0.60,
      inflationAdjustedPrice: 0.60,
      scopeDistance: 0.1,
      slaComparable: true,
      licensingComparable: true,
      included: true,
      profile: {
        specification: 'Cimento Portland CP II 32',
        unitLabel: 'kg',
        quantity: 1000,
        uf: 'SP',
        competencia: '2026-01',
        deliveryCondition: 'retirada no deposito',
        includesFreight: false,
        includesInstallationOrService: false,
        includesTaxesAndCharges: true,
        itemKind: 'insumo',
        referenceSource: 'SINAPI',
        referenceVersion: '2026-01',
      },
    },
  ];

  const result = evaluateInvestigativePriceComparison({
    subjectProfile: subject,
    peers,
    serviceClass: 'INSUMO_OBRA',
    subjectNominalPrice: 0.80,
    subjectYear: 2026,
    inflationIndexLabel: 'IPCA-2026',
  });

  assert.equal(result.excludedPeers.length, 1, 'Peer from different UF must be excluded');
  assert.ok(result.excludedPeers[0].reasons.some((r) => r.includes('UF incompativel')), 'Must have UF exclusion reason');
});

test('1.5c Same spec + same UF + same competencia: included (no false negative)', () => {
  const subject: PriceComparabilityProfile = {
    specification: 'Cimento Portland CP II 32',
    unitLabel: 'kg',
    quantity: 1000,
    uf: 'BA',
    competencia: '2026-01',
    deliveryCondition: 'retirada no deposito',
    includesFreight: false,
    includesInstallationOrService: false,
    includesTaxesAndCharges: true,
    itemKind: 'insumo',
    referenceSource: 'SINAPI',
    referenceVersion: '2026-01',
  };

  const peers: ComparablePricePeerInput[] = [
    {
      id: 'p1',
      municipalityName: 'Feira de Santana',
      uf: 'BA',
      contractNumber: '001/2026',
      contractYear: 2026,
      sameSupplier: false,
      serviceClass: 'INSUMO_OBRA',
      unitLabel: 'kg',
      nominalUnitPrice: 0.60,
      inflationAdjustedPrice: 0.60,
      scopeDistance: 0.1,
      slaComparable: true,
      licensingComparable: true,
      included: true,
      profile: {
        specification: 'Cimento Portland CP II 32',
        unitLabel: 'kg',
        quantity: 1000,
        uf: 'BA',
        competencia: '2026-01',
        deliveryCondition: 'retirada no deposito',
        includesFreight: false,
        includesInstallationOrService: false,
        includesTaxesAndCharges: true,
        itemKind: 'insumo',
        referenceSource: 'SINAPI',
        referenceVersion: '2026-01',
      },
    },
    {
      id: 'p2',
      municipalityName: 'Salvador',
      uf: 'BA',
      contractNumber: '002/2026',
      contractYear: 2026,
      sameSupplier: false,
      serviceClass: 'INSUMO_OBRA',
      unitLabel: 'kg',
      nominalUnitPrice: 0.65,
      inflationAdjustedPrice: 0.65,
      scopeDistance: 0.1,
      slaComparable: true,
      licensingComparable: true,
      included: true,
      profile: {
        specification: 'Cimento Portland CP II 32',
        unitLabel: 'kg',
        quantity: 1000,
        uf: 'BA',
        competencia: '2026-01',
        deliveryCondition: 'retirada no deposito',
        includesFreight: false,
        includesInstallationOrService: false,
        includesTaxesAndCharges: true,
        itemKind: 'insumo',
        referenceSource: 'SINAPI',
        referenceVersion: '2026-01',
      },
    },
  ];

  const result = evaluateInvestigativePriceComparison({
    subjectProfile: subject,
    peers,
    serviceClass: 'INSUMO_OBRA',
    subjectNominalPrice: 0.80,
    subjectYear: 2026,
    inflationIndexLabel: 'IPCA-2026',
  });

  assert.equal(result.includedPeers.length, 2, 'Same spec+UF+competencia must be included');
  assert.equal(result.excludedPeers.length, 0);
});

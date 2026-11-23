import type { BenchmarkPeer, HorizontalBenchmarkResult } from '../types/audit';

export const HORIZONTAL_BENCHMARK_RULE_ID = 'BENCH_HORIZONTAL_SUPPLIER_V1';

/**
 * Versioned reference IPCA cumulative factors (IBGE IPCA annual series, base 2026-01).
 * Years outside this table are NOT silently adjusted — comparison is explicitly flagged as nominal.
 */
const IPCA_SERIES_TO_2026: Record<number, number> = {
  2021: 1.312,
  2022: 1.198,
  2023: 1.132,
  2024: 1.084,
  2025: 1.041,
  2026: 1.0,
};

export function adjustPriceTo2026(
  nominalPrice: number,
  contractYear: number
): { value: number; adjusted: boolean } {
  const factor = IPCA_SERIES_TO_2026[contractYear];
  if (factor === undefined) {
    return { value: Number(nominalPrice.toFixed(2)), adjusted: false };
  }
  return { value: Number((nominalPrice * factor).toFixed(2)), adjusted: true };
}

export function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export function computeMAD(values: number[], medianValue?: number): number {
  if (values.length === 0) return 0;
  const med = medianValue ?? computeMedian(values);
  const absDevs = values.map((v) => Math.abs(v - med));
  return computeMedian(absDevs);
}

function normalizeUnit(u: string): string {
  return u
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();
}

function peerIdentityKey(p: BenchmarkPeer): string {
  return [
    p.municipalityName.trim().toLowerCase(),
    p.uf.trim().toUpperCase(),
    p.contractNumber.trim().toLowerCase(),
    String(p.contractYear),
  ].join('|');
}

/**
 * Evaluates a subject contract item against comparable peer contracts using Median & MAD.
 * Enforces strict methodological safeguards:
 *  - Mode 'same_supplier' excludes peers from different suppliers; 'market' declares multi-supplier scope.
 *  - Deduplicates repeated contract records so duplicates count as a single independent observation.
 *  - Excludes incompatible units unless a documented positive conversionFactor is supplied.
 *  - Rejects invalid (NaN, <= 0) prices and explicitly handles MAD = 0 without inflating z-scores.
 *  - Refuses statistical inference when n < 4 (NOT_VERIFIABLE).
 */
export function evaluateHorizontalBenchmark(params: {
  serviceClass: string;
  unitLabel: string;
  subjectNominalPrice: number;
  subjectYear: number;
  inflationIndexLabel: string;
  peers: BenchmarkPeer[];
  maxScopeDistance?: number;
  mode?: 'same_supplier' | 'market';
  subjectContractKey?: string;
}): HorizontalBenchmarkResult {
  const maxScope = params.maxScopeDistance ?? 0.2;
  const mode = params.mode ?? 'market';
  const normalizedSubjectUnit = normalizeUnit(params.unitLabel);

  // Reject invalid subject prices immediately
  if (!Number.isFinite(params.subjectNominalPrice) || params.subjectNominalPrice <= 0) {
    return {
      ruleId: HORIZONTAL_BENCHMARK_RULE_ID,
      mode,
      state: 'NOT_VERIFIABLE',
      evidenceLevel: 'C',
      confidence: 0,
      serviceClass: params.serviceClass,
      unitLabel: params.unitLabel,
      subjectNominalPrice: params.subjectNominalPrice,
      subjectAdjustedPrice: 0,
      inflationIndexApplied: 'Não aplicado (preço inválido)',
      inflationApplied: false,
      peerCount: 0,
      excludedPeerCount: params.peers.length,
      deduplicatedPeerCount: 0,
      peerMedian: null,
      mad: null,
      madZero: false,
      robustZ: null,
      peerRatio: null,
      statement: 'Preço unitário do contrato analisado ausente, negativo ou inválido (NaN). Benchmark recusado.',
      notAConclusion: 'Sem preço válido do item analisado não é possível calcular referência comparativa.',
      controls: {
        inflation: 'não aplicado',
        scope: `distância ≤ ${(maxScope * 100).toFixed(0)}%`,
        sla: 'filtrado',
        licensing: 'filtrado',
        supplierMode: mode === 'same_supplier' ? 'mesmo fornecedor obrigatório' : 'mercado (fornecedores variados)',
      },
      peers: params.peers.map((p) => ({ ...p, included: false, exclusionReason: 'Preço do contrato-objeto inválido.' })),
    };
  }

  const subjectAdj = adjustPriceTo2026(params.subjectNominalPrice, params.subjectYear);
  let allInflationResolved = subjectAdj.adjusted;
  const seenKeys = new Set<string>();
  let duplicateExclusions = 0;

  const stagedPeers: Array<{
    peer: BenchmarkPeer;
    comparableNominal: number;
    adjustedPrice: number;
  }> = params.peers.map((p) => {
    const key = peerIdentityKey(p);
    let included = p.included;
    let exclusionReason = p.exclusionReason;
    let comparableNominal = p.nominalUnitPrice;

    if (!Number.isFinite(p.nominalUnitPrice) || p.nominalUnitPrice <= 0) {
      included = false;
      exclusionReason = 'Valor unitário ausente, negativo ou inválido (NaN).';
    } else if (params.subjectContractKey && key === params.subjectContractKey) {
      included = false;
      exclusionReason = 'Próprio contrato excluído da amostra de referência.';
    } else if (seenKeys.has(key)) {
      included = false;
      duplicateExclusions += 1;
      exclusionReason = `Registro duplicado (${p.municipalityName}/${p.uf} · ${p.contractNumber}) excluído para preservar observações independentes.`;
    } else if (mode === 'same_supplier' && !p.sameSupplier) {
      included = false;
      exclusionReason = 'Fornecedor divergente excluído no modo mesmo fornecedor.';
    } else if (p.serviceClass !== params.serviceClass) {
      included = false;
      exclusionReason = `Classe de serviço divergente (${p.serviceClass} ≠ ${params.serviceClass}).`;
    } else if (normalizeUnit(p.unitLabel) !== normalizedSubjectUnit) {
      if (typeof p.conversionFactor === 'number' && Number.isFinite(p.conversionFactor) && p.conversionFactor > 0) {
        comparableNominal = p.nominalUnitPrice * p.conversionFactor;
      } else {
        included = false;
        exclusionReason = `Unidade incompatível (${p.unitLabel} ≠ ${params.unitLabel}) sem fator de conversão documentado.`;
      }
    }

    if (included && p.scopeDistance > maxScope) {
      included = false;
      exclusionReason = `Distância de escopo ${(p.scopeDistance * 100).toFixed(0)}% excede o limite de ${(maxScope * 100).toFixed(0)}%.`;
    } else if (included && !p.slaComparable) {
      included = false;
      exclusionReason = 'SLA ou regime de atendimento não comparável.';
    } else if (included && !p.licensingComparable) {
      included = false;
      exclusionReason = 'Modelo de licenciamento/implantação incompatível.';
    }

    if (included) {
      seenKeys.add(key);
    }

    const adj = adjustPriceTo2026(comparableNominal, p.contractYear);
    if (included && !adj.adjusted) {
      allInflationResolved = false;
    }

    return {
      peer: {
        ...p,
        included,
        exclusionReason,
      },
      comparableNominal: Number(comparableNominal.toFixed(2)),
      adjustedPrice: adj.value,
    };
  });

  // CRITICAL (A04/R5): If ANY included observation or the subject lacks an IPCA factor,
  // compare strictly in NOMINAL terms across BOTH subject and ALL peers (never mix adjusted + nominal).
  const effectiveSubjectPrice = allInflationResolved
    ? subjectAdj.value
    : Number(params.subjectNominalPrice.toFixed(2));

  const normalizedPeers: BenchmarkPeer[] = stagedPeers.map((entry) => {
    const effectivePrice = allInflationResolved ? entry.adjustedPrice : entry.comparableNominal;
    return {
      ...entry.peer,
      inflationAdjustedPrice:
        entry.peer.included && Number.isFinite(effectivePrice)
          ? effectivePrice
          : entry.peer.inflationAdjustedPrice,
    };
  });

  const eligible = normalizedPeers.filter((p) => p.included);
  const excludedCount = normalizedPeers.length - eligible.length;
  const inflationSummary = allInflationResolved
    ? `série versionada (${params.inflationIndexLabel})`
    : 'comparação nominal pura (série IPCA indisponível para parte dos anos; nenhuma deflação aplicada)';
  const supplierModeSummary =
    mode === 'same_supplier'
      ? 'mesmo fornecedor (identidade exigida)'
      : 'mercado (fornecedores variados declarados)';

  if (eligible.length < 4) {
    return {
      ruleId: HORIZONTAL_BENCHMARK_RULE_ID,
      mode,
      state: 'NOT_VERIFIABLE',
      evidenceLevel: 'C',
      confidence: 0,
      serviceClass: params.serviceClass,
      unitLabel: params.unitLabel,
      subjectNominalPrice: params.subjectNominalPrice,
      subjectAdjustedPrice: effectiveSubjectPrice,
      inflationIndexApplied: allInflationResolved ? params.inflationIndexLabel : 'Nominal (sem deflação)',
      inflationApplied: allInflationResolved,
      peerCount: eligible.length,
      excludedPeerCount: excludedCount,
      deduplicatedPeerCount: duplicateExclusions,
      peerMedian:
        eligible.length > 0
          ? Number(computeMedian(eligible.map((e) => e.inflationAdjustedPrice)).toFixed(2))
          : null,
      mad: null,
      madZero: false,
      robustZ: null,
      peerRatio: null,
      statement: `Amostra comparável independente insuficiente (n = ${eligible.length} < 4; ${excludedCount} excluído(s)). Inferência estatística recusada.`,
      notAConclusion: 'Amostra insuficiente impede qualquer conclusão sobre desvio de preço.',
      controls: {
        inflation: inflationSummary,
        scope: `distância ≤ ${(maxScope * 100).toFixed(0)}%`,
        sla: 'filtrado',
        licensing: 'filtrado',
        supplierMode: supplierModeSummary,
      },
      peers: normalizedPeers,
    };
  }

  const peerPrices = eligible.map((e) => e.inflationAdjustedPrice);
  const peerMedian = Number(computeMedian(peerPrices).toFixed(2));
  const rawMad = computeMAD(peerPrices, peerMedian);
  const madZero = rawMad === 0;
  const peerRatio = peerMedian > 0 ? Number((effectiveSubjectPrice / peerMedian).toFixed(2)) : null;

  // When MAD === 0 (all comparable peers share the exact median), robust z-score is undefined (null)
  // rather than artificially inflated via an arbitrary epsilon floor.
  const robustZ = madZero
    ? null
    : Number(((0.6745 * (effectiveSubjectPrice - peerMedian)) / rawMad).toFixed(2));

  const isRobustSample = eligible.length >= 8;
  const isHighOutlier =
    (peerRatio ?? 0) >= 2.0 && (madZero ? true : Math.abs(robustZ ?? 0) >= 3.0) && isRobustSample;
  const isMediumOutlier =
    (peerRatio ?? 0) >= 1.5 && (madZero ? true : Math.abs(robustZ ?? 0) >= 2.0);

  let statement: string;
  let state: HorizontalBenchmarkResult['state'];
  let evidenceLevel: HorizontalBenchmarkResult['evidenceLevel'];

  // Transparent coverage-based score (ratio of sample adequacy, NOT legal certainty)
  const sampleAdequacy = Number(Math.min(0.9, eligible.length / 10).toFixed(2));

  if (isHighOutlier) {
    state = 'OBSERVATION';
    evidenceLevel = 'B';
    statement = madZero
      ? `Preço ${allInflationResolved ? 'normalizado' : 'nominal'} (${peerRatio?.toFixed(2)}× a mediana; MAD = 0 — todos os ${eligible.length} comparáveis idênticos) acima do grupo comparável (regra de triagem, não prova de sobrepreço).`
      : `Preço ${allInflationResolved ? 'normalizado' : 'nominal'} (${peerRatio?.toFixed(2)}× a mediana dos peers, z robusto = ${robustZ?.toFixed(2)}) acima do grupo comparável (n = ${eligible.length} observações independentes).`;
  } else if (isMediumOutlier) {
    state = 'OBSERVATION';
    evidenceLevel = isRobustSample ? 'B' : 'C';
    statement = isRobustSample
      ? `Preço ${allInflationResolved ? 'normalizado' : 'nominal'} ${peerRatio?.toFixed(2)}× acima da mediana comparável (${madZero ? 'MAD = 0' : `z robusto = ${robustZ?.toFixed(2)}`}, n = ${eligible.length}).`
      : `Sinal preliminar com amostra reduzida (4 ≤ n = ${eligible.length} < 8): preço ${peerRatio?.toFixed(2)}× acima da mediana comparável.`;
  } else {
    state = 'CONFIRMED_DATA';
    evidenceLevel = isRobustSample ? 'B' : 'C';
    statement = `Preço ${allInflationResolved ? 'normalizado' : 'nominal'} dentro da faixa estatística observada frente à mediana comparável (razão ${peerRatio?.toFixed(2)}×, ${madZero ? 'MAD = 0' : `z robusto = ${robustZ?.toFixed(2)}`}, n = ${eligible.length}).`;
  }

  return {
    ruleId: HORIZONTAL_BENCHMARK_RULE_ID,
    mode,
    state,
    evidenceLevel,
    confidence: sampleAdequacy,
    serviceClass: params.serviceClass,
    unitLabel: params.unitLabel,
    subjectNominalPrice: params.subjectNominalPrice,
    subjectAdjustedPrice: effectiveSubjectPrice,
    inflationIndexApplied: allInflationResolved ? params.inflationIndexLabel : 'Nominal (sem deflação)',
    inflationApplied: allInflationResolved,
    peerCount: eligible.length,
    excludedPeerCount: excludedCount,
    deduplicatedPeerCount: duplicateExclusions,
    peerMedian,
    mad: Number(rawMad.toFixed(2)),
    madZero,
    robustZ,
    peerRatio,
    statement,
    notAConclusion:
      'Regra de triagem estatística; não constitui prova de sobrepreço ou fraude. Verificar escopo, logística local, implantação e SLA.',
    controls: {
      inflation: inflationSummary,
      scope: `distância ≤ ${(maxScope * 100).toFixed(0)}%`,
      sla: 'compatível',
      licensing: 'compatível',
      supplierMode: supplierModeSummary,
    },
    peers: normalizedPeers,
  };
}

export type PriceItemKind = 'insumo' | 'composicao' | 'servico' | 'produto';

export interface PriceComparabilityProfile {
  specification: string;
  unitLabel: string;
  quantity: number;
  uf: string;
  municipality?: string;
  competencia: string; // YYYY-MM or YYYY
  deliveryCondition: string;
  includesFreight: boolean;
  includesInstallationOrService: boolean;
  includesTaxesAndCharges: boolean;
  itemKind: PriceItemKind;
  referenceSource: string;
  referenceVersion: string;
}

export interface ComparablePricePeerInput extends BenchmarkPeer {
  profile: PriceComparabilityProfile;
}

export interface PriceComparabilityEvaluation {
  benchmark: HorizontalBenchmarkResult;
  /** Strictly separates 3 tiers: never auto-quantifies legal damage */
  priceClassification:
    | 'nao_comparavel_ou_amostra_insuficiente'
    | 'dentro_da_faixa_observada'
    | 'divergencia_de_preco'
    | 'hipotese_de_sobrepreco_requer_diligencia';
  damageQuantificationAutomatic: false;
  damageQuantificationNote: string;
  includedPeers: Array<{ contractNumber: string; source: string; unitPrice: number }>;
  excludedPeers: Array<{ contractNumber: string; source: string; reasons: string[] }>;
  sensitivityAnalysis: {
    leaveOneOutMinMedian: number | null;
    leaveOneOutMaxMedian: number | null;
    leaveOneOutMinRatio: number | null;
    leaveOneOutMaxRatio: number | null;
  };
  validationChecksApplied: string[];
}

function normComp(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Reuses the existing evaluateHorizontalBenchmark engine after enforcing strict pre-calculation
 * comparability checks: specification, unit & conversion, quantity/scale, location & competência,
 * delivery conditions, freight/service/taxes bundling, insumo vs composição, and reference/version.
 * Blocks misleading ratios on missing/zero/incompatible units and never auto-quantifies damage.
 */
export function evaluateInvestigativePriceComparison(params: {
  serviceClass: string;
  subjectNominalPrice: number;
  subjectYear: number;
  subjectProfile: PriceComparabilityProfile;
  inflationIndexLabel: string;
  peers: ComparablePricePeerInput[];
  mode?: 'same_supplier' | 'market';
  maxScopeDistance?: number;
  maxQuantityRatio?: number;
  subjectContractKey?: string;
}): PriceComparabilityEvaluation {
  const maxQuantityRatio = params.maxQuantityRatio ?? 5.0;
  const subj = params.subjectProfile;
  const subjUnit = normalizeUnit(subj.unitLabel);
  const includedPeers: PriceComparabilityEvaluation['includedPeers'] = [];
  const excludedPeers: PriceComparabilityEvaluation['excludedPeers'] = [];

  const filteredBenchmarkPeers: BenchmarkPeer[] = params.peers.map((peer) => {
    const reasons: string[] = [];
    const p = peer.profile;

    if (!Number.isFinite(peer.nominalUnitPrice) || peer.nominalUnitPrice <= 0) {
      reasons.push('Preço unitário ausente, zero ou inválido (razão bloqueada).');
    }
    if (!subjUnit || !normalizeUnit(p.unitLabel)) {
      reasons.push('Unidade de medida ausente no item analisado ou no comparável.');
    } else if (
      normalizeUnit(p.unitLabel) !== subjUnit &&
      !(typeof peer.conversionFactor === 'number' && Number.isFinite(peer.conversionFactor) && peer.conversionFactor > 0)
    ) {
      reasons.push(
        `Unidade incompatível (${p.unitLabel} ≠ ${subj.unitLabel}) sem fator de conversão documentado.`
      );
    }
    if (p.itemKind !== subj.itemKind) {
      reasons.push(
        `Natureza incompatível (${p.itemKind} ≠ ${subj.itemKind}; vedada comparação direta insumo vs composição).`
      );
    }
    if (p.includesFreight !== subj.includesFreight) {
      reasons.push(
        'Condição de frete incompatível (item com frete embutido não pode ser comparado diretamente com preço sem frete).'
      );
    }
    if (p.includesInstallationOrService !== subj.includesInstallationOrService) {
      reasons.push(
        'Condição de serviço/instalação embutida incompatível (escopo agregado vs fornecimento puro).'
      );
    }
    if (p.includesTaxesAndCharges !== subj.includesTaxesAndCharges) {
      reasons.push('Regime de encargos/tributos (desonerado vs não desonerado/BDI) incompatível.');
    }
    if (normComp(p.deliveryCondition) !== normComp(subj.deliveryCondition)) {
      reasons.push(
        `Condição de entrega divergente ("${p.deliveryCondition}" ≠ "${subj.deliveryCondition}").`
      );
    }
    if (
      Number.isFinite(subj.quantity) &&
      subj.quantity > 0 &&
      Number.isFinite(p.quantity) &&
      p.quantity > 0
    ) {
      const qtyRatio = Math.max(subj.quantity / p.quantity, p.quantity / subj.quantity);
      if (qtyRatio > maxQuantityRatio) {
        reasons.push(
          `Escala de quantidade não comparável (razão ${qtyRatio.toFixed(1)}× excede limite de ${maxQuantityRatio}×).`
        );
      }
    }
    if (!p.referenceSource.trim() || !p.referenceVersion.trim()) {
      reasons.push('Fonte de referência ou versão/competência da tabela ausente.');
    }

    if (reasons.length > 0) {
      excludedPeers.push({
        contractNumber: peer.contractNumber,
        source: `${p.referenceSource} (${p.referenceVersion})`,
        reasons,
      });
      return {
        ...peer,
        included: false,
        exclusionReason: reasons.join(' '),
      };
    }

    return peer;
  });

  const benchmark = evaluateHorizontalBenchmark({
    serviceClass: params.serviceClass,
    unitLabel: subj.unitLabel,
    subjectNominalPrice: params.subjectNominalPrice,
    subjectYear: params.subjectYear,
    inflationIndexLabel: params.inflationIndexLabel,
    peers: filteredBenchmarkPeers,
    maxScopeDistance: params.maxScopeDistance,
    mode: params.mode,
    subjectContractKey: params.subjectContractKey,
  });

  // Collect final included vs excluded peers (combining pre-validation + benchmarkEngine exclusions)
  const excludedSet = new Set(excludedPeers.map((e) => e.contractNumber));
  for (const p of benchmark.peers) {
    const matchInput = params.peers.find((orig) => orig.contractNumber === p.contractNumber);
    const sourceLabel = matchInput
      ? `${matchInput.profile.referenceSource} (${matchInput.profile.referenceVersion})`
      : 'Peer';
    if (p.included) {
      includedPeers.push({
        contractNumber: p.contractNumber,
        source: sourceLabel,
        unitPrice: p.inflationAdjustedPrice,
      });
    } else if (!excludedSet.has(p.contractNumber)) {
      excludedPeers.push({
        contractNumber: p.contractNumber,
        source: sourceLabel,
        reasons: [p.exclusionReason || 'Excluído por critérios de comparabilidade do motor de benchmark.'],
      });
    }
  }

  // Leave-one-out sensitivity analysis over included prices
  let leaveOneOutMinMedian: number | null = null;
  let leaveOneOutMaxMedian: number | null = null;
  let leaveOneOutMinRatio: number | null = null;
  let leaveOneOutMaxRatio: number | null = null;
  const incPrices = includedPeers.map((p) => p.unitPrice);
  if (incPrices.length >= 4 && benchmark.subjectAdjustedPrice > 0) {
    const looMedians: number[] = [];
    for (let i = 0; i < incPrices.length; i++) {
      const subset = incPrices.filter((_, idx) => idx !== i);
      looMedians.push(Number(computeMedian(subset).toFixed(2)));
    }
    leaveOneOutMinMedian = Math.min(...looMedians);
    leaveOneOutMaxMedian = Math.max(...looMedians);
    if (leaveOneOutMaxMedian > 0 && leaveOneOutMinMedian > 0) {
      leaveOneOutMinRatio = Number((benchmark.subjectAdjustedPrice / leaveOneOutMaxMedian).toFixed(2));
      leaveOneOutMaxRatio = Number((benchmark.subjectAdjustedPrice / leaveOneOutMinMedian).toFixed(2));
    }
  }

  let priceClassification: PriceComparabilityEvaluation['priceClassification'];
  if (benchmark.state === 'NOT_VERIFIABLE' || benchmark.peerRatio === null) {
    priceClassification = 'nao_comparavel_ou_amostra_insuficiente';
  } else if (benchmark.peerRatio >= 2.0 && (benchmark.madZero || Math.abs(benchmark.robustZ ?? 0) >= 3.0)) {
    priceClassification = 'hipotese_de_sobrepreco_requer_diligencia';
  } else if (benchmark.peerRatio >= 1.5 && (benchmark.madZero || Math.abs(benchmark.robustZ ?? 0) >= 2.0)) {
    priceClassification = 'divergencia_de_preco';
  } else {
    priceClassification = 'dentro_da_faixa_observada';
  }

  return {
    benchmark,
    priceClassification,
    damageQuantificationAutomatic: false,
    damageQuantificationNote:
      'Divergência de preço e hipótese de sobrepreço são triagens estatísticas distintas da quantificação de dano ao erário, que exige contraditório, perícia técnica de composição de custos/BDI e prova de pagamento efetivo.',
    includedPeers,
    excludedPeers,
    sensitivityAnalysis: {
      leaveOneOutMinMedian,
      leaveOneOutMaxMedian,
      leaveOneOutMinRatio,
      leaveOneOutMaxRatio,
    },
    validationChecksApplied: [
      'especificação e classe de serviço',
      'unidade e fator de conversão documentado',
      'quantidade e escala comparável',
      'localidade (UF) e competência',
      'condições de entrega, frete, serviço embutido e tributos/encargos',
      'separação insumo vs composição',
      'fonte de referência e versão da tabela',
    ],
  };
}


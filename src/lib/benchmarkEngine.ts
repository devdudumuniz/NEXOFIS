import type { BenchmarkPeer, HorizontalBenchmarkResult } from '../types/audit';

export const HORIZONTAL_BENCHMARK_RULE_ID = 'BENCH_HORIZONTAL_SUPPLIER_V1';

/**
 * Cumulative IPCA-like price deflator multipliers bringing past years to 2026 BRL baseline
 * so nominal 2021-2025 contracts are never compared raw against 2026 prices.
 */
const INFLATION_TO_2026_FACTOR: Record<number, number> = {
  2021: 1.312,
  2022: 1.198,
  2023: 1.132,
  2024: 1.084,
  2025: 1.041,
  2026: 1.0,
};

export function adjustPriceTo2026(nominalPrice: number, contractYear: number): number {
  const factor = INFLATION_TO_2026_FACTOR[contractYear] ?? 1.0;
  return Number((nominalPrice * factor).toFixed(2));
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

/**
 * Evaluates a subject contract item against comparable peer contracts using Median & MAD.
 * Enforces sample-size policy:
 *  - n < 4  -> NOT_VERIFIABLE (refuses statistical inference; descriptive only)
 *  - 4 <= n < 8 -> low-evidence observation (level C)
 *  - n >= 8 -> robust statistical comparison (level B)
 */
export function evaluateHorizontalBenchmark(params: {
  serviceClass: string;
  unitLabel: string;
  subjectNominalPrice: number;
  subjectYear: number;
  inflationIndexLabel: string;
  peers: BenchmarkPeer[];
  maxScopeDistance?: number;
}): HorizontalBenchmarkResult {
  const maxScope = params.maxScopeDistance ?? 0.2;
  const subjectAdjusted = adjustPriceTo2026(params.subjectNominalPrice, params.subjectYear);

  const normalizedPeers: BenchmarkPeer[] = params.peers.map((p) => {
    const adjusted = adjustPriceTo2026(p.nominalUnitPrice, p.contractYear);
    let included = p.included;
    let exclusionReason = p.exclusionReason;

    if (p.serviceClass !== params.serviceClass) {
      included = false;
      exclusionReason = `Classe de serviço divergente (${p.serviceClass} ≠ ${params.serviceClass}).`;
    } else if (p.scopeDistance > maxScope) {
      included = false;
      exclusionReason = `Distância de escopo ${(p.scopeDistance * 100).toFixed(0)}% excede o limite de ${(maxScope * 100).toFixed(0)}%.`;
    } else if (!p.slaComparable) {
      included = false;
      exclusionReason = 'SLA ou regime de atendimento não comparável.';
    } else if (!p.licensingComparable) {
      included = false;
      exclusionReason = 'Modelo de licenciamento/implantação incompatível.';
    }

    return {
      ...p,
      inflationAdjustedPrice: adjusted,
      included,
      exclusionReason,
    };
  });

  const eligible = normalizedPeers.filter((p) => p.included);
  const excludedCount = normalizedPeers.length - eligible.length;

  if (eligible.length < 4) {
    return {
      ruleId: HORIZONTAL_BENCHMARK_RULE_ID,
      state: 'NOT_VERIFIABLE',
      evidenceLevel: 'C',
      confidence: 0.35,
      serviceClass: params.serviceClass,
      unitLabel: params.unitLabel,
      subjectNominalPrice: params.subjectNominalPrice,
      subjectAdjustedPrice: subjectAdjusted,
      inflationIndexApplied: params.inflationIndexLabel,
      peerCount: eligible.length,
      excludedPeerCount: excludedCount,
      peerMedian: eligible.length > 0 ? Number(computeMedian(eligible.map((e) => e.inflationAdjustedPrice)).toFixed(2)) : null,
      mad: null,
      robustZ: null,
      peerRatio: null,
      statement: `Amostra comparável insuficiente (n = ${eligible.length} < 4). Inferência estatística recusada; exibir apenas como referência descritiva.`,
      notAConclusion: 'Amostra insuficiente impede qualquer conclusão sobre desvio de preço.',
      controls: {
        inflation: `aplicado (${params.inflationIndexLabel})`,
        scope: `distância ≤ ${(maxScope * 100).toFixed(0)}%`,
        sla: 'filtrado',
        licensing: 'filtrado',
      },
      peers: normalizedPeers,
    };
  }

  const peerPrices = eligible.map((e) => e.inflationAdjustedPrice);
  const peerMedian = Number(computeMedian(peerPrices).toFixed(2));
  const rawMad = computeMAD(peerPrices, peerMedian);
  // Protect against zero MAD when peers have identical prices by using 1% of median floor
  const effectiveMad = rawMad > 0 ? rawMad : Math.max(0.01, peerMedian * 0.01);
  const robustZ = Number(((0.6745 * (subjectAdjusted - peerMedian)) / effectiveMad).toFixed(2));
  const peerRatio = peerMedian > 0 ? Number((subjectAdjusted / peerMedian).toFixed(2)) : null;

  const isRobustSample = eligible.length >= 8;
  const isHighOutlier = (peerRatio ?? 0) >= 2.0 && Math.abs(robustZ) >= 3.0 && isRobustSample;
  const isMediumOutlier = (peerRatio ?? 0) >= 1.5 && Math.abs(robustZ) >= 2.0;

  let statement: string;
  let state: HorizontalBenchmarkResult['state'];
  let evidenceLevel: HorizontalBenchmarkResult['evidenceLevel'];
  let confidence: number;

  if (isHighOutlier) {
    state = 'OBSERVATION';
    evidenceLevel = 'B';
    confidence = 0.91;
    statement = `Preço normalizado (${peerRatio?.toFixed(2)}× a mediana dos peers, z robusto = ${robustZ.toFixed(2)}) significativamente superior ao grupo comparável (n = ${eligible.length}).`;
  } else if (isMediumOutlier) {
    state = 'OBSERVATION';
    evidenceLevel = isRobustSample ? 'B' : 'C';
    confidence = isRobustSample ? 0.82 : 0.64;
    statement = isRobustSample
      ? `Preço normalizado ${peerRatio?.toFixed(2)}× acima da mediana dos peers comparáveis (z robusto = ${robustZ.toFixed(2)}, n = ${eligible.length}).`
      : `Sinal de baixa evidência (4 ≤ n = ${eligible.length} < 8): preço ${peerRatio?.toFixed(2)}× acima da mediana comparável.`;
  } else {
    state = 'CONFIRMED_DATA';
    evidenceLevel = isRobustSample ? 'B' : 'C';
    confidence = isRobustSample ? 0.88 : 0.68;
    statement = `Preço normalizado dentro da faixa estatística esperada frente à mediana dos peers (razão ${peerRatio?.toFixed(2)}×, z robusto = ${robustZ.toFixed(2)}, n = ${eligible.length}).`;
  }

  return {
    ruleId: HORIZONTAL_BENCHMARK_RULE_ID,
    state,
    evidenceLevel,
    confidence,
    serviceClass: params.serviceClass,
    unitLabel: params.unitLabel,
    subjectNominalPrice: params.subjectNominalPrice,
    subjectAdjustedPrice: subjectAdjusted,
    inflationIndexApplied: params.inflationIndexLabel,
    peerCount: eligible.length,
    excludedPeerCount: excludedCount,
    peerMedian,
    mad: Number(rawMad.toFixed(2)),
    robustZ,
    peerRatio,
    statement,
    notAConclusion: 'Não constitui prova de sobrepreço ou fraude; verificar escopo contratual, logística local e SLA específico.',
    controls: {
      inflation: `aplicado (${params.inflationIndexLabel})`,
      scope: `distância ≤ ${(maxScope * 100).toFixed(0)}%`,
      sla: 'compatível',
      licensing: 'compatível',
    },
    peers: normalizedPeers,
  };
}

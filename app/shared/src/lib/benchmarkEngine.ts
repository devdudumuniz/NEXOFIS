import type { BenchmarkPeer, HorizontalBenchmarkResult } from '../types/audit';
import { competenciaDistanceMonths, validateCompetencia } from './competenciaValidator';

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
  /** Optional explicit multiplier to convert peer quantity into subject unit (defaults to 1 / conversionFactor when units differ). */
  quantityConversionFactor?: number;
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
  includedPeers: Array<{
    peerId: string;
    contractNumber: string;
    source: string;
    referenceSource: string;
    referenceVersion: string;
    uf: string;
    competencia: string;
    unitPrice: number;
    conversionApplied?: {
      fromUnit: string;
      toUnit: string;
      priceFactor: number;
      convertedQuantity: number;
    };
  }>;
  excludedPeers: Array<{
    peerId: string;
    contractNumber: string;
    source: string;
    referenceSource: string;
    referenceVersion: string;
    uf: string;
    competencia: string;
    reasons: string[];
  }>;
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

const SPEC_STOPWORDS = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'para',
  'com',
  'sem',
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'por',
  'tipo',
  'classe',
  'uso',
  'padrao',
  'fornecimento',
  'aquisicao',
  'item',
  'material',
  'unidade',
  'unid',
  'und',
  'saco',
  'sacos',
  'caixa',
  'caixas',
  'litro',
  'litros',
  'metro',
  'metros',
  'kg',
  'ton',
]);

function extractSpecificationTokens(spec: string): string[] {
  const cleaned = normComp(spec).replace(/[^a-z0-9]+/g, ' ');
  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !SPEC_STOPWORDS.has(t) && !/^\d+$/.test(t));
  return Array.from(new Set(tokens));
}

function specificationsAreComparable(
  subjectSpec: string,
  peerSpec: string
): { comparable: boolean; overlapCount: number; minRatio: number } {
  const subjTokens = extractSpecificationTokens(subjectSpec);
  const peerTokens = extractSpecificationTokens(peerSpec);
  if (subjTokens.length === 0 || peerTokens.length === 0) {
    return { comparable: false, overlapCount: 0, minRatio: 0 };
  }
  const peerSet = new Set(peerTokens);
  let overlapCount = 0;
  for (const token of subjTokens) {
    if (peerSet.has(token)) {
      overlapCount += 1;
    }
  }
  const denom = Math.min(subjTokens.length, peerTokens.length);
  const minRatio = denom > 0 ? overlapCount / denom : 0;
  return {
    comparable: overlapCount >= 1 && minRatio >= 0.34,
    overlapCount,
    minRatio: Number(minRatio.toFixed(2)),
  };
}

/**
 * Reuses the existing evaluateHorizontalBenchmark engine after enforcing strict pre-calculation
 * comparability checks: specification token overlap, unit & conversion (both price and quantity scale),
 * location (UF) & competência window, delivery conditions, freight/service/taxes bundling,
 * insumo vs composição, and canonical peerId provenance.
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
  allowCrossUf?: boolean;
  maxCompetenciaDistanceMonths?: number;
  subjectContractKey?: string;
}): PriceComparabilityEvaluation {
  const maxQuantityRatio = params.maxQuantityRatio ?? 5.0;
  const allowCrossUf = params.allowCrossUf ?? false;
  const maxCompetenciaDistanceMonths = params.maxCompetenciaDistanceMonths ?? 12;
  const subj = params.subjectProfile;
  const subjUnit = normalizeUnit(subj.unitLabel);
  const subjUf = subj.uf.trim().toUpperCase();
  const subjCompCheck = validateCompetencia(subj.competencia);

  const includedPeers: PriceComparabilityEvaluation['includedPeers'] = [];
  const excludedPeers: PriceComparabilityEvaluation['excludedPeers'] = [];
  const peerInputById = new Map<string, ComparablePricePeerInput>();
  const conversionMetaById = new Map<
    string,
    { fromUnit: string; toUnit: string; priceFactor: number; convertedQuantity: number }
  >();

  const filteredBenchmarkPeers: BenchmarkPeer[] = params.peers.map((peer, idx) => {
    const canonicalPeerId = peer.id?.trim() || `peer_${idx + 1}_${peer.contractNumber}`;
    const normalizedPeer: ComparablePricePeerInput =
      peer.id === canonicalPeerId ? peer : { ...peer, id: canonicalPeerId };
    peerInputById.set(canonicalPeerId, normalizedPeer);

    const reasons: string[] = [];
    const p = normalizedPeer.profile;
    const peerUnit = normalizeUnit(p.unitLabel);
    const peerUf = p.uf.trim().toUpperCase();

    if (!Number.isFinite(normalizedPeer.nominalUnitPrice) || normalizedPeer.nominalUnitPrice <= 0) {
      reasons.push('Preço unitário ausente, zero ou inválido (razão bloqueada).');
    }

    // Specification token overlap check (prevents comparing e.g. Cimento vs Areia)
    if (!subj.specification.trim() || !p.specification.trim()) {
      reasons.push('Especificação técnica ausente no item analisado ou no comparável.');
    } else {
      const specCheck = specificationsAreComparable(subj.specification, p.specification);
      if (!specCheck.comparable) {
        reasons.push(
          `Especificação técnica incompatível ("${p.specification}" vs "${subj.specification}"; sobreposição insuficiente).`
        );
      }
    }

    // UF compatibility check
    if (!allowCrossUf && subjUf && peerUf && subjUf !== peerUf) {
      reasons.push(
        `Localidade (UF) divergente (${peerUf} ≠ ${subjUf}) sem ajuste regional autorizado.`
      );
    }

    // Competência validity and temporal distance check
    const peerCompCheck = validateCompetencia(p.competencia);
    if (!subjCompCheck.valid) {
      reasons.push(`Competência do item analisado inválida ("${subj.competencia}").`);
    } else if (!peerCompCheck.valid) {
      reasons.push(`Competência do comparável inválida ("${p.competencia}").`);
    } else {
      const monthsApart = competenciaDistanceMonths(subj.competencia, p.competencia);
      if (monthsApart !== null && monthsApart > maxCompetenciaDistanceMonths) {
        reasons.push(
          `Competência fora da janela comparável (${p.competencia} vs ${subj.competencia}: ${monthsApart} meses > limite de ${maxCompetenciaDistanceMonths} meses).`
        );
      }
    }

    // Unit & conversion check (converts BOTH unit price and quantity scale)
    let effectivePeerQuantity = p.quantity;
    if (!subjUnit || !peerUnit) {
      reasons.push('Unidade de medida ausente no item analisado ou no comparável.');
    } else if (peerUnit !== subjUnit) {
      if (
        typeof normalizedPeer.conversionFactor === 'number' &&
        Number.isFinite(normalizedPeer.conversionFactor) &&
        normalizedPeer.conversionFactor > 0
      ) {
        const qtyFactor =
          typeof normalizedPeer.quantityConversionFactor === 'number' &&
          Number.isFinite(normalizedPeer.quantityConversionFactor) &&
          normalizedPeer.quantityConversionFactor > 0
            ? normalizedPeer.quantityConversionFactor
            : 1 / normalizedPeer.conversionFactor;
        effectivePeerQuantity = Number((p.quantity * qtyFactor).toFixed(4));
        conversionMetaById.set(canonicalPeerId, {
          fromUnit: p.unitLabel,
          toUnit: subj.unitLabel,
          priceFactor: normalizedPeer.conversionFactor,
          convertedQuantity: effectivePeerQuantity,
        });
      } else {
        reasons.push(
          `Unidade incompatível (${p.unitLabel} ≠ ${subj.unitLabel}) sem fator de conversão documentado.`
        );
      }
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
      Number.isFinite(effectivePeerQuantity) &&
      effectivePeerQuantity > 0
    ) {
      const qtyRatio = Math.max(
        subj.quantity / effectivePeerQuantity,
        effectivePeerQuantity / subj.quantity
      );
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
        peerId: canonicalPeerId,
        contractNumber: normalizedPeer.contractNumber,
        source: `${p.referenceSource} (${p.referenceVersion})`,
        referenceSource: p.referenceSource,
        referenceVersion: p.referenceVersion,
        uf: peerUf,
        competencia: p.competencia,
        reasons,
      });
      return {
        ...normalizedPeer,
        included: false,
        exclusionReason: reasons.join(' '),
      };
    }

    return normalizedPeer;
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

  // Collect final included vs excluded peers keyed strictly by canonical peerId
  const excludedPeerIds = new Set(excludedPeers.map((e) => e.peerId));
  for (const p of benchmark.peers) {
    const matchInput = peerInputById.get(p.id);
    const refSource = matchInput?.profile.referenceSource ?? 'Peer';
    const refVersion = matchInput?.profile.referenceVersion ?? '';
    const sourceLabel = matchInput ? `${refSource} (${refVersion})` : 'Peer';
    const peerUf = matchInput?.profile.uf.trim().toUpperCase() ?? p.uf.trim().toUpperCase();
    const peerComp = matchInput?.profile.competencia ?? String(p.contractYear);
    if (p.included) {
      includedPeers.push({
        peerId: p.id,
        contractNumber: p.contractNumber,
        source: sourceLabel,
        referenceSource: refSource,
        referenceVersion: refVersion,
        uf: peerUf,
        competencia: peerComp,
        unitPrice: p.inflationAdjustedPrice,
        conversionApplied: conversionMetaById.get(p.id),
      });
    } else if (!excludedPeerIds.has(p.id)) {
      excludedPeers.push({
        peerId: p.id,
        contractNumber: p.contractNumber,
        source: sourceLabel,
        referenceSource: refSource,
        referenceVersion: refVersion,
        uf: peerUf,
        competencia: peerComp,
        reasons: [
          p.exclusionReason || 'Excluído por critérios de comparabilidade do motor de benchmark.',
        ],
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
      'especificação técnica (sobreposição de tokens) e classe de serviço',
      'unidade e fator de conversão documentado (preço e escala de quantidade)',
      'quantidade e escala comparável',
      'localidade (UF) e janela de competência validada',
      'condições de entrega, frete, serviço embutido e tributos/encargos',
      'separação insumo vs composição',
      'fonte de referência, versão da tabela e proveniência canônica por peerId',
    ],
  };
}


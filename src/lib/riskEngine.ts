import type {
  ContractRecord,
  DocumentRecord,
  EvidenceItem,
  ExecutionChainSummary,
  HorizontalBenchmarkResult,
  RiskAssessment,
  RiskIndicator,
  SourceDivergence,
} from '../types/audit';
import { evaluateHorizontalBenchmark } from './benchmarkEngine';
import { formatCurrencyBRL, formatDateBR, formatPercentageBR } from './formatters';
import {
  getDispensationLimitForContract,
  isRiskMatrixMandatory,
  resolveLegalRulesetStrict,
} from './legalRules';

export const RISK_ENGINE_VERSION = 'forensic-engine-2026.12';

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA).getTime();
  const b = new Date(dateB).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 9999;
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function monthsBetween(dateA: string, dateB: string): number {
  const days = Math.abs(daysBetween(dateA, dateB));
  return Math.max(1, Math.round(days / 30));
}

function findBestDocument(
  docs: DocumentRecord[],
  preferredTypes: DocumentRecord['documentType'][]
): DocumentRecord | undefined {
  for (const type of preferredTypes) {
    const match = docs.find((d) => d.documentType === type);
    if (match) return match;
  }
  return docs[0];
}

export function calculateWeightedPriceDeviation(contract: ContractRecord): {
  deviationPct: number;
  contractedTotal: number;
  referenceTotal: number;
  highestItem?: {
    description: string;
    deviationPct: number;
    unitPrice: number;
    referencePrice: number;
    referenceSource: string;
  };
} {
  if (!contract.items.length) {
    return { deviationPct: 0, contractedTotal: 0, referenceTotal: 0 };
  }

  let contractedTotal = 0;
  let referenceTotal = 0;
  let highestItem:
    | {
        description: string;
        deviationPct: number;
        unitPrice: number;
        referencePrice: number;
        referenceSource: string;
      }
    | undefined;

  for (const item of contract.items) {
    const itemContracted = item.quantity * item.unitPrice;
    const itemReference = item.quantity * item.referencePrice;
    contractedTotal += itemContracted;
    referenceTotal += itemReference;

    if (item.referencePrice > 0) {
      const itemDev = ((item.unitPrice - item.referencePrice) / item.referencePrice) * 100;
      if (!highestItem || itemDev > highestItem.deviationPct) {
        highestItem = {
          description: item.description,
          deviationPct: itemDev,
          unitPrice: item.unitPrice,
          referencePrice: item.referencePrice,
          referenceSource: item.referenceSource,
        };
      }
    }
  }

  const deviationPct =
    referenceTotal > 0 ? ((contractedTotal - referenceTotal) / referenceTotal) * 100 : 0;

  return {
    deviationPct: Number(deviationPct.toFixed(2)),
    contractedTotal,
    referenceTotal,
    highestItem,
  };
}

export function detectSourceDivergences(contract: ContractRecord): SourceDivergence[] {
  const divergences: SourceDivergence[] = [];
  if (contract.sourceRecords.length < 2) return divergences;

  const updatedValues = contract.sourceRecords.map((r) => ({
    sourceSystem: r.sourceSystem,
    raw: r.reportedUpdatedValue,
    value: formatCurrencyBRL(r.reportedUpdatedValue),
  }));
  const maxVal = Math.max(...updatedValues.map((u) => u.raw));
  const minVal = Math.min(...updatedValues.map((u) => u.raw));
  const diffVal = maxVal - minVal;

  if (diffVal > 1) {
    const pct = minVal > 0 ? (diffVal / minVal) * 100 : 100;
    divergences.push({
      field: 'Valor atualizado do contrato',
      sources: updatedValues.map(({ sourceSystem, value }) => ({ sourceSystem, value })),
      severity: pct >= 10 ? 'ALTA' : 'MÉDIA',
      deltaDescription: `Diferença de ${formatCurrencyBRL(diffVal)} (${formatPercentageBR(pct)}) entre fontes oficiais preservadas sem sobrescrita.`,
    });
  }

  const uniqueStatuses = new Set(contract.sourceRecords.map((r) => r.reportedStatus.trim().toLowerCase()));
  if (uniqueStatuses.size > 1) {
    divergences.push({
      field: 'Situação contratual',
      sources: contract.sourceRecords.map((r) => ({
        sourceSystem: r.sourceSystem,
        value: r.reportedStatus,
      })),
      severity: 'MÉDIA',
      deltaDescription: 'Situação cadastral diverge entre PNCP, portal local ou Tribunal de Contas.',
    });
  }

  const uniqueEndDates = new Set(contract.sourceRecords.map((r) => r.reportedEndDate));
  if (uniqueEndDates.size > 1) {
    divergences.push({
      field: 'Data de término da vigência',
      sources: contract.sourceRecords.map((r) => ({
        sourceSystem: r.sourceSystem,
        value: formatDateBR(r.reportedEndDate),
      })),
      severity: 'BAIXA',
      deltaDescription: 'Vigência final registrada com datas distintas entre as bases consultadas.',
    });
  }

  return divergences;
}

export function analyzeExecutionChain(contract: ContractRecord): ExecutionChainSummary {
  const durationMonths = monthsBetween(contract.startDate, contract.endDate);
  const estimatedMonthlyContractValue = Number(
    (contract.updatedValue / Math.max(1, durationMonths)).toFixed(2)
  );

  // Deduplicate identical financial events reported across multiple transparency portals
  const seenKeys = new Set<string>();
  const uniquePayments = contract.payments.filter((p) => {
    if (!Number.isFinite(p.amount) || p.amount < 0) return false;
    const key = [
      p.type,
      (p.documentNumber || '').trim().toLowerCase(),
      (p.date || '').slice(0, 10),
      Math.round(p.amount * 100),
    ].join('|');
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  const committedTotal = uniquePayments
    .filter((p) => p.type === 'Empenho')
    .reduce((s, p) => s + p.amount, 0);
  const liquidatedTotal = uniquePayments
    .filter((p) => p.type === 'Liquidação')
    .reduce((s, p) => s + p.amount, 0);
  const paidTotal = uniquePayments
    .filter((p) => p.type === 'Pagamento')
    .reduce((s, p) => s + p.amount, 0);
  const billedTotal = uniquePayments
    .filter((p) => p.type === 'Instrumento de Cobrança')
    .reduce((s, p) => s + p.amount, 0);
  const deliveredVerifiedTotal = uniquePayments
    .filter((p) => p.type === 'Entrega / Medição')
    .reduce((s, p) => s + p.amount, 0);

  const provenExecutionAvailable =
    committedTotal > 0 || liquidatedTotal > 0 || paidTotal > 0 || billedTotal > 0;

  const outOfOrder = uniquePayments.filter((p) => p.paidOutOfOrder);
  const hasKnownQueueOrder = uniquePayments.some(
    (p) =>
      (p.type === 'Pagamento' || p.type === 'Liquidação') &&
      typeof p.chronologicalPosition === 'number' &&
      Number.isFinite(p.chronologicalPosition)
  );

  let chronologicalOrderStatus: ExecutionChainSummary['chronologicalOrderStatus'] = 'not_verifiable';
  if (outOfOrder.length > 0) {
    if (outOfOrder.some((p) => !p.outOfOrderJustification || !p.justificationPublished)) {
      chronologicalOrderStatus = 'unexplained_break';
    } else {
      chronologicalOrderStatus = 'justified_exception';
    }
  } else if (hasKnownQueueOrder) {
    chronologicalOrderStatus = 'valid_sequence';
  }

  return {
    contractedObligation: contract.updatedValue,
    estimatedMonthlyContractValue,
    contractDurationMonths: durationMonths,
    committedTotal,
    liquidatedTotal,
    paidTotal,
    billedTotal,
    deliveredVerifiedTotal,
    provenExecutionAvailable,
    chronologicalOrderStatus,
  };
}

export function evaluateContractRisk(contract: ContractRecord): RiskAssessment {
  const indicators: RiskIndicator[] = [];
  const nonApplicableChecks: RiskAssessment['nonApplicableChecks'] = [];
  const evidences: EvidenceItem[] = [];
  const evaluatedAt = new Date().toISOString();

  // Legal Time Travel: strict temporal resolution without silent fallback
  const legalResolution = resolveLegalRulesetStrict(contract.signatureDate);
  const appliedLegalRuleset = legalResolution.ruleset;
  const rulesetVersion = appliedLegalRuleset.ruleId;
  if (legalResolution.status === 'inconclusive') {
    nonApplicableChecks.push({
      code: 'BR-LEGAL-TEMPORAL',
      title: 'Resolução normativa temporal (Lei 14.133/2021)',
      state: 'NOT_VERIFIABLE',
      rationale: legalResolution.reason,
    });
  }

  const variationPct =
    contract.originalValue > 0
      ? Number((((contract.updatedValue - contract.originalValue) / contract.originalValue) * 100).toFixed(2))
      : 0;

  const totalAmendedValue = contract.amendments.reduce((acc, a) => acc + a.addedValue, 0);
  const amendmentTotalPct =
    contract.originalValue > 0
      ? Number(((totalAmendedValue / contract.originalValue) * 100).toFixed(2))
      : 0;

  const priceAnalysis = calculateWeightedPriceDeviation(contract);
  const divergences = detectSourceDivergences(contract);
  const executionChain = analyzeExecutionChain(contract);

  let horizontalBenchmark: HorizontalBenchmarkResult | undefined;
  if (contract.benchmarkPeers) {
    horizontalBenchmark = evaluateHorizontalBenchmark({
      serviceClass: contract.benchmarkPeers.serviceClass,
      unitLabel: contract.benchmarkPeers.unitLabel,
      subjectNominalPrice: contract.benchmarkPeers.subjectNominalPrice,
      subjectYear: contract.year,
      inflationIndexLabel: contract.benchmarkPeers.inflationIndexLabel,
      peers: contract.benchmarkPeers.peers,
    });
  }

  const primaryDoc = findBestDocument(contract.documents, ['Contrato Original', 'Documento Importado', 'Edital / TR']);
  const amendmentDoc = findBestDocument(contract.documents, ['Termo Aditivo', 'Contrato Original']);
  const editalDoc = findBestDocument(contract.documents, ['Edital / TR', 'Contrato Original']);

  let evidenceCounter = 1;
  let findingCounter = 1;
  const nextFindingId = () => `FND-${contract.year}-${String(findingCounter++).padStart(4, '0')}`;

  const pushEvidence = (params: Omit<EvidenceItem, 'id' | 'legalRulesetVersion'>): string => {
    const id = `EV-${String(evidenceCounter++).padStart(3, '0')}`;
    evidences.push({ id, legalRulesetVersion: rulesetVersion, ...params });
    return id;
  };

  // 1. BR-SANC-001: Sanctions with temporal validity & strict entity/sphere scope verification
  const activeSanctionsOnDate = contract.supplier.sanctions.filter(
    (s) =>
      Boolean(contract.signatureDate) &&
      s.startDate <= contract.signatureDate &&
      contract.signatureDate <= s.endDate
  );

  const ambiguousSanctions = activeSanctionsOnDate.filter(
    (s) =>
      (s.scope === 'Estadual' && !s.scopeUf?.trim()) ||
      (s.scope === 'Órgão Sancionador' && !s.sanctioningOrgan?.trim())
  );

  const effectiveSanctions = activeSanctionsOnDate.filter((s) => {
    if (s.scope === 'Nacional') return true;
    if (s.scope === 'Estadual') {
      return Boolean(s.scopeUf?.trim()) && s.scopeUf!.trim().toUpperCase() === contract.uf.toUpperCase();
    }
    // Órgão Sancionador only restricts the sanctioning organ itself
    const organ = s.sanctioningOrgan?.trim().toLowerCase() ?? '';
    if (!organ) return false;
    return (
      organ.includes(contract.municipalityName.toLowerCase()) ||
      organ.includes(contract.entityName.toLowerCase())
    );
  });

  if (effectiveSanctions.length > 0) {
    const first = effectiveSanctions[0];
    const evId = pushEvidence({
      indicatorCode: 'BR-SANC-001',
      ruleVersion: '2.1.0',
      sourceSystem: first.sourceSystem,
      documentId: primaryDoc?.id ?? 'REG-CGU',
      documentTitle: `${first.registry} — ${first.sanctioningOrgan}`,
      pageNumber: 1,
      excerpt: `Sanção vigente na data da assinatura (${formatDateBR(contract.signatureDate)}): ${first.registry} (${first.scope}) — ${first.reason}. Vigência ${formatDateBR(first.startDate)} a ${formatDateBR(first.endDate)}.`,
      normalizedValue: `${effectiveSanctions.length} sanção(ões) vigente(s) no escopo`,
      calculation: `CNPJ ${contract.supplier.cnpj} · ${first.startDate} ≤ assinatura (${contract.signatureDate}) ≤ ${first.endDate} · abrangência=${first.scope}`,
      sha256: primaryDoc?.sha256 ?? 'cgu-registry-verified',
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      findingId: nextFindingId(),
      code: 'BR-SANC-001',
      ruleVersion: '2.1.0',
      legalRulesetVersion: rulesetVersion,
      framework: 'Integridade / Sanções',
      state: 'CONFIRMED_DATA',
      evidenceLevel: 'A',
      confidence: 0.98,
      title: 'Fornecedor sancionado na data da assinatura',
      severity: 'CRÍTICA',
      weightPoints: 30,
      summary: `${effectiveSanctions.length} registro(s) de impedimento vigente(s) em ${formatDateBR(contract.signatureDate)} com abrangência aplicável (${effectiveSanctions.map((s) => `${s.registry}/${s.scope}`).join(', ')}).`,
      notAConclusion: 'Verificar eventual efeito suspensivo judicial ou liminar vigente não refletida no cadastro administrativo.',
      alternativeHypotheses: [
        'Decisão judicial liminar suspendendo os efeitos da penalidade na data da contratação.',
        'Divergência de abrangência federativa quando a sanção limita-se ao ente sancionador.',
      ],
      dataUsed: `CNPJ ${contract.supplier.cnpj} · Assinatura ${formatDateBR(contract.signatureDate)} · ${effectiveSanctions.map((s) => `${s.registry} (${s.scope})`).join(', ')}`,
      source: effectiveSanctions.map((s) => s.sourceSystem).join(' / '),
      calculation: `Identidade (CNPJ) + vigência (${first.startDate}..${first.endDate}) + abrangência (${first.scope}) verificadas simultaneamente.`,
      legalReference: 'Lei nº 14.133/2021, art. 14, III e art. 156',
      evidenceIds: [evId],
    });
  } else if (ambiguousSanctions.length > 0) {
    nonApplicableChecks.push({
      code: 'BR-SANC-001',
      title: 'Sanção vigente com abrangência incompleta no cadastro',
      state: 'NOT_VERIFIABLE',
      rationale: `Há ${ambiguousSanctions.length} sanção(ões) vigente(s) em ${formatDateBR(contract.signatureDate)}, porém sem UF de abrangência estadual ou órgão sancionador especificado — impossível confirmar impedimento aplicável ao ente contratante sem diligência.`,
    });
  } else if (contract.supplier.sanctions.length > 0) {
    nonApplicableChecks.push({
      code: 'BR-SANC-001',
      title: 'Sanção histórica fora de vigência ou fora de abrangência',
      state: 'NOT_APPLICABLE',
      rationale: `Registro(s) em ${contract.supplier.sanctions.map((s) => s.registry).join(', ')} não estavam vigentes em ${formatDateBR(contract.signatureDate)} ou restringem-se a outro órgão sancionador.`,
    });
  }

  // 2. BR-PRICE-001: Price deviation above reference (Painel de Preços / SINAPI / BPS)
  if (priceAnalysis.deviationPct >= 15) {
    const roundedDev = Math.round(priceAnalysis.deviationPct);
    const isCritical = priceAnalysis.deviationPct >= 40;
    const refSources = Array.from(new Set(contract.items.map((i) => i.referenceSource))).join(' / ');
    const evId = pushEvidence({
      indicatorCode: 'BR-PRICE-001',
      ruleVersion: '2.0.0',
      sourceSystem: refSources || 'Painel de Preços',
      documentId: primaryDoc?.id ?? 'PLANILHA-ITENS',
      documentTitle: primaryDoc?.title ?? 'Planilha Orçamentária do Contrato',
      pageNumber: primaryDoc?.pages.find((p) => p.highlights.some((h) => h.field === 'valor'))?.pageNumber ?? 2,
      excerpt: priceAnalysis.highestItem
        ? `Item "${priceAnalysis.highestItem.description}": contratado a ${formatCurrencyBRL(priceAnalysis.highestItem.unitPrice)} vs referência ${formatCurrencyBRL(priceAnalysis.highestItem.referencePrice)} (${priceAnalysis.highestItem.referenceSource}).`
        : `Total contratado dos itens ${formatCurrencyBRL(priceAnalysis.contractedTotal)} vs referência ${formatCurrencyBRL(priceAnalysis.referenceTotal)}.`,
      normalizedValue: `+${priceAnalysis.deviationPct.toFixed(2)}%`,
      calculation: `((${priceAnalysis.contractedTotal.toFixed(2)} − ${priceAnalysis.referenceTotal.toFixed(2)}) ÷ ${priceAnalysis.referenceTotal.toFixed(2)}) × 100 = +${priceAnalysis.deviationPct.toFixed(2)}%`,
      sha256: primaryDoc?.sha256 ?? 'price-benchmark-hash',
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      findingId: nextFindingId(),
      code: 'BR-PRICE-001',
      ruleVersion: '2.0.0',
      legalRulesetVersion: rulesetVersion,
      framework: 'Estatístico (Mediana/MAD)',
      state: 'OBSERVATION',
      evidenceLevel: 'B',
      confidence: 0.89,
      title: `Preço ${roundedDev}% acima referência`,
      severity: isCritical ? 'CRÍTICA' : 'ALTA',
      weightPoints: isCritical ? 26 : 22,
      summary: `Cesta de itens contratados apresenta desvio ponderado de ${formatPercentageBR(priceAnalysis.deviationPct, true)} frente às referências oficiais (${refSources}).`,
      notAConclusion: 'Não constitui prova de sobrepreço ou fraude; diferenças de especificação técnica, logística ou prazo podem justificar parte da variação.',
      alternativeHypotheses: [
        'Exigência de entrega fracionada de urgência ou logística regional diferenciada.',
        'Especificação técnica superior no Termo de Referência em relação ao item genérico do banco de preços.',
      ],
      dataUsed: `${contract.items.length} itens contratados (${formatCurrencyBRL(priceAnalysis.contractedTotal)}) vs referência (${formatCurrencyBRL(priceAnalysis.referenceTotal)})`,
      source: `${refSources} × PNCP`,
      calculation: `(Contratado − Referência) ÷ Referência = +${priceAnalysis.deviationPct.toFixed(2)}%`,
      legalReference: 'Lei nº 14.133/2021, art. 23 (pesquisa de preços)',
      evidenceIds: [evId],
    });
  }

  // 2b. BENCH_HORIZONTAL_SUPPLIER_V1: Median/MAD Horizontal Benchmark across comparable peers
  if (horizontalBenchmark) {
    if (horizontalBenchmark.state === 'NOT_VERIFIABLE') {
      nonApplicableChecks.push({
        code: horizontalBenchmark.ruleId,
        title: `Benchmarking horizontal (${horizontalBenchmark.serviceClass})`,
        state: 'NOT_VERIFIABLE',
        rationale: horizontalBenchmark.statement,
      });
    } else if (
      horizontalBenchmark.state === 'OBSERVATION' &&
      horizontalBenchmark.peerRatio !== null &&
      horizontalBenchmark.robustZ !== null
    ) {
      const isHigh =
        horizontalBenchmark.peerRatio >= 2.0 &&
        Math.abs(horizontalBenchmark.robustZ) >= 3.0 &&
        horizontalBenchmark.peerCount >= 8;
      // Add subtle non-redundant weight only when BR-PRICE-001 did not already score it, or keep forensic clarity
      const alreadyHasPrice = indicators.some((i) => i.code === 'BR-PRICE-001');
      const evId = pushEvidence({
        indicatorCode: horizontalBenchmark.ruleId,
        ruleVersion: '1.0.0',
        sourceSystem: 'Espelho PNCP Local (Peers Comparáveis)',
        documentId: primaryDoc?.id ?? 'BENCH-PEERS',
        documentTitle: `Grupo Comparável — ${horizontalBenchmark.serviceClass}`,
        pageNumber: 1,
        excerpt: `${horizontalBenchmark.statement} Mediana peers = ${formatCurrencyBRL(horizontalBenchmark.peerMedian ?? 0)}/${horizontalBenchmark.unitLabel}; MAD = ${formatCurrencyBRL(horizontalBenchmark.mad ?? 0)}.`,
        normalizedValue: `${horizontalBenchmark.peerRatio.toFixed(2)}× mediana (z=${horizontalBenchmark.robustZ.toFixed(2)})`,
        calculation: `z_robusto = 0,6745 × (${horizontalBenchmark.subjectAdjustedPrice.toFixed(2)} − ${(horizontalBenchmark.peerMedian ?? 0).toFixed(2)}) ÷ ${(horizontalBenchmark.mad ?? 0).toFixed(2)} = ${horizontalBenchmark.robustZ.toFixed(2)} · n=${horizontalBenchmark.peerCount}`,
        sha256: primaryDoc?.sha256 ?? 'bench-median-mad-hash',
        retrievedAt: evaluatedAt,
      });

      indicators.push({
        findingId: nextFindingId(),
        code: horizontalBenchmark.ruleId,
        ruleVersion: '1.0.0',
        legalRulesetVersion: rulesetVersion,
        framework: 'Estatístico (Mediana/MAD)',
        state: 'OBSERVATION',
        evidenceLevel: horizontalBenchmark.evidenceLevel,
        confidence: horizontalBenchmark.confidence,
        title: `Benchmarking horizontal ${horizontalBenchmark.peerRatio.toFixed(2)}× acima da mediana`,
        severity: isHigh ? 'ALTA' : 'MÉDIA',
        weightPoints: alreadyHasPrice ? 0 : isHigh ? 18 : 10,
        summary: horizontalBenchmark.statement,
        notAConclusion: horizontalBenchmark.notAConclusion,
        alternativeHypotheses: [
          'Pacote inclui implantação, migração ou horas presenciais não detalhadas nos peers.',
          'Escala municipal ou SLA de suporte 24×7 distinto dos contratos comparados.',
        ],
        dataUsed: `n = ${horizontalBenchmark.peerCount} peers elegíveis (${horizontalBenchmark.excludedPeerCount} excluídos) · Unidade: ${horizontalBenchmark.unitLabel}`,
        source: `Espelho PNCP (${horizontalBenchmark.inflationIndexApplied})`,
        calculation: `Razão = ${horizontalBenchmark.subjectAdjustedPrice.toFixed(2)} ÷ ${(horizontalBenchmark.peerMedian ?? 1).toFixed(2)} = ${horizontalBenchmark.peerRatio.toFixed(2)}× · z_robusto = ${horizontalBenchmark.robustZ.toFixed(2)}`,
        evidenceIds: [evId],
      });
    }
  }

  // 3. COMP-001: Single bidder / low competition
  if (contract.biddersCount <= 1) {
    const evId = pushEvidence({
      indicatorCode: 'COMP-001',
      ruleVersion: '2.0.0',
      sourceSystem: 'PNCP / Ata do Certame',
      documentId: editalDoc?.id ?? primaryDoc?.id ?? 'ATA-CERTAME',
      documentTitle: editalDoc?.title ?? 'Ata de Realização da Licitação',
      pageNumber: 1,
      excerpt: `Modalidade: ${contract.modality}. Número de proponentes habilitados registrados no certame: ${contract.biddersCount}.`,
      normalizedValue: `${contract.biddersCount} participante`,
      calculation: `numberOfTenderers == ${contract.biddersCount} (limiar de baixa competição <= 1)`,
      sha256: editalDoc?.sha256 ?? primaryDoc?.sha256 ?? 'comp-001-hash',
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      findingId: nextFindingId(),
      code: 'COMP-001',
      ruleVersion: '2.0.0',
      legalRulesetVersion: rulesetVersion,
      framework: 'Estatístico (Mediana/MAD)',
      state: 'OBSERVATION',
      evidenceLevel: 'B',
      confidence: 0.94,
      title: `${contract.biddersCount} participante`,
      severity: 'MÉDIA',
      weightPoints: 10,
      summary: `Certame conduzido sob ${contract.modality} com apenas ${contract.biddersCount} participante efetivo, reduzindo pressão competitiva.`,
      notAConclusion: 'Licitação com proponente único não é ilegal por si só; avaliar cláusulas restritivas no edital e divulgação prévia.',
      alternativeHypotheses: [
        'Mercado local restrito para o objeto especializado na data da sessão.',
        'Dispensa legalmente enquadrada no art. 75 com justificativa de preço.',
      ],
      dataUsed: `Proponentes habilitados = ${contract.biddersCount} · Modalidade: ${contract.modality}`,
      source: 'PNCP (Ata / Homologação)',
      calculation: `Sinal de concentração competitiva acionado quando proponentes <= 1.`,
      legalReference: 'Lei nº 14.133/2021, art. 5º e art. 11 (competitividade)',
      evidenceIds: [evId],
    });
  }

  // 4. BR-ADIT-001: Excessive or rapid contract amendments
  if (contract.amendments.length >= 2 || amendmentTotalPct > 25 || variationPct > 25) {
    const sortedDates = contract.amendments.map((a) => a.date).sort();
    const spanMonths =
      sortedDates.length >= 2
        ? monthsBetween(contract.signatureDate, sortedDates[sortedDates.length - 1])
        : monthsBetween(contract.signatureDate, sortedDates[0] ?? contract.endDate);
    const exceedsCap = variationPct > 25 || amendmentTotalPct > 25;
    const effectivePct = Math.max(variationPct, amendmentTotalPct);

    const evId = pushEvidence({
      indicatorCode: 'BR-ADIT-001',
      ruleVersion: '2.0.0',
      sourceSystem: 'PNCP / Termos Aditivos',
      documentId: amendmentDoc?.id ?? primaryDoc?.id ?? 'ADITIVOS',
      documentTitle: amendmentDoc?.title ?? 'Termos Aditivos Consolidados',
      pageNumber: contract.amendments[contract.amendments.length - 1]?.pageNumber ?? 1,
      excerpt: `${contract.amendments.length} termos aditivos acumulam acréscimo de ${formatCurrencyBRL(totalAmendedValue)} (${formatPercentageBR(effectivePct, true)}), elevando o contrato para ${formatCurrencyBRL(contract.updatedValue)}.`,
      normalizedValue: `${contract.amendments.length} aditivos (${formatPercentageBR(effectivePct, true)})`,
      calculation: `Valor original ${formatCurrencyBRL(contract.originalValue)} → atualizado ${formatCurrencyBRL(contract.updatedValue)} (+${effectivePct.toFixed(2)}% em ${spanMonths} meses; limite ordinário 25%)`,
      sha256: amendmentDoc?.sha256 ?? primaryDoc?.sha256 ?? 'amendment-hash',
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      findingId: nextFindingId(),
      code: 'BR-ADIT-001',
      ruleVersion: '2.0.0',
      legalRulesetVersion: rulesetVersion,
      framework: 'Regra Jurídica Temporal',
      state: 'OBSERVATION',
      evidenceLevel: 'A',
      confidence: 0.96,
      title: `${contract.amendments.length} aditivos em ${spanMonths} meses`,
      severity: exceedsCap ? 'ALTA' : 'MÉDIA',
      weightPoints: exceedsCap ? 12 : 8,
      summary: exceedsCap
        ? `Acréscimo acumulado de ${formatPercentageBR(effectivePct, true)} ultrapassa o teto ordinário de 25% em ${spanMonths} meses de execução.`
        : `Concentração de ${contract.amendments.length} termos aditivos em intervalo curto (${spanMonths} meses).`,
      notAConclusion: 'Reequilíbrio econômico-financeiro (art. 124, II, d) ou reformas até 50% possuem hipóteses legais próprias; conferir parecer jurídico.',
      alternativeHypotheses: [
        'Parcela do acréscimo refere-se a reajuste/reequilíbrio econômico-financeiro não computado no limite quantitativo de 25%.',
        'Aumento emergencial de demanda documentado em nota técnica da secretaria.',
      ],
      dataUsed: `${contract.amendments.length} aditivos · Original ${formatCurrencyBRL(contract.originalValue)} → Atualizado ${formatCurrencyBRL(contract.updatedValue)}`,
      source: 'PNCP / Diário Oficial Municipal',
      calculation: `(${formatCurrencyBRL(contract.updatedValue)} − ${formatCurrencyBRL(contract.originalValue)}) ÷ ${formatCurrencyBRL(contract.originalValue)} = +${effectivePct.toFixed(2)}%`,
      legalReference: 'Lei nº 14.133/2021, art. 125 (limite de 25% para acréscimos)',
      evidenceIds: [evId],
    });
  }

  // 5. BR-CNAE-001: Object vs Supplier CNAE compatibility (signal only, never automatic illegality)
  if (contract.expectedCnaePrefixes.length > 0) {
    const supplierCnaes = [
      contract.supplier.primaryCnaeCode,
      ...contract.supplier.secondaryCnaes.map((c) => c.code),
    ];
    const hasMatch = supplierCnaes.some((code) =>
      contract.expectedCnaePrefixes.some((prefix) => code.replace(/\D/g, '').startsWith(prefix.replace(/\D/g, '')))
    );

    if (!hasMatch) {
      const evId = pushEvidence({
        indicatorCode: 'BR-CNAE-001',
        ruleVersion: '2.0.0',
        sourceSystem: contract.supplier.dataProvenance,
        documentId: primaryDoc?.id ?? 'RECEITA-CNPJ',
        documentTitle: 'Comprovante de Inscrição e Situação Cadastral (CNPJ)',
        pageNumber: 1,
        excerpt: `CNAE principal "${contract.supplier.primaryCnaeCode} — ${contract.supplier.primaryCnaeDescription}" não pertence aos grupos esperados (${contract.expectedCnaePrefixes.join(', ')}) para o objeto "${contract.objectCategory}".`,
        normalizedValue: `CNAE ${contract.supplier.primaryCnaeCode}`,
        calculation: `Interseção({${supplierCnaes.join(', ')}} ∩ prefixos {${contract.expectedCnaePrefixes.join(', ')}}) = ∅`,
        sha256: primaryDoc?.sha256 ?? 'cnae-check-hash',
        retrievedAt: evaluatedAt,
      });

      indicators.push({
        findingId: nextFindingId(),
        code: 'BR-CNAE-001',
        ruleVersion: '2.0.0',
        legalRulesetVersion: rulesetVersion,
        framework: 'Integridade / Sanções',
        state: 'OBSERVATION',
        evidenceLevel: 'B',
        confidence: 0.85,
        title: 'Objeto/CNAE divergente',
        severity: 'MÉDIA',
        weightPoints: 8,
        summary: `CNAE principal (${contract.supplier.primaryCnaeCode} — ${contract.supplier.primaryCnaeDescription}) diverge do objeto contratado (${contract.objectCategory}).`,
        notAConclusion: 'CNAE é sinal de classificação e não gera impedimento automático; verificar contrato social e atestados de capacidade técnica.',
        alternativeHypotheses: [
          'Objeto social registrado na Junta Comercial contempla a atividade apesar de CNAE desatualizado na Receita.',
          'Subcontratação parcial autorizada no edital para parcela acessória.',
        ],
        dataUsed: `CNAE ${contract.supplier.primaryCnaeCode} vs grupos esperados [${contract.expectedCnaePrefixes.join(', ')}]`,
        source: 'Receita Federal (CNPJ) × PNCP',
        calculation: `Nenhum CNAE principal ou secundário corresponde aos prefixos compatíveis com ${contract.objectCategory}.`,
        legalReference: 'Acórdão TCU nº 1.203/2011 — Pertinência do ramo de atividade',
        evidenceIds: [evId],
      });
    }
  }

  // 6. BR-RECEM-001: Newly opened company awarded high-value contract
  const companyAgeDays = daysBetween(contract.supplier.openingDate, contract.signatureDate);
  if (companyAgeDays >= 0 && companyAgeDays < 180 && contract.originalValue >= 300_000) {
    const evId = pushEvidence({
      indicatorCode: 'BR-RECEM-001',
      ruleVersion: '1.1.0',
      sourceSystem: contract.supplier.dataProvenance,
      documentId: primaryDoc?.id ?? 'RECEITA-ABERTURA',
      documentTitle: 'Cadastro Nacional da Pessoa Jurídica (Receita Federal)',
      pageNumber: 1,
      excerpt: `Empresa constituída em ${formatDateBR(contract.supplier.openingDate)}, apenas ${companyAgeDays} dias antes da assinatura do contrato de ${formatCurrencyBRL(contract.originalValue)}.`,
      normalizedValue: `${companyAgeDays} dias de abertura`,
      calculation: `signatureDate (${contract.signatureDate}) − openingDate (${contract.supplier.openingDate}) = ${companyAgeDays} dias (< 180 dias) com valor >= R$ 300.000`,
      sha256: primaryDoc?.sha256 ?? 'recem-aberta-hash',
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      findingId: nextFindingId(),
      code: 'BR-RECEM-001',
      ruleVersion: '1.1.0',
      legalRulesetVersion: rulesetVersion,
      framework: 'Integridade / Sanções',
      state: 'OBSERVATION',
      evidenceLevel: 'B',
      confidence: 0.92,
      title: `Fornecedor recém-aberto (${companyAgeDays} dias)`,
      severity: 'ALTA',
      weightPoints: 14,
      summary: `Contratada constituída há ${companyAgeDays} dias antes da assinatura para contrato de ${formatCurrencyBRL(contract.originalValue)}.`,
      notAConclusion: 'Empresa recém-constituída pode participar legalmente; verificar atestados de qualificação técnico-operacional e capital integralizado.',
      alternativeHypotheses: [
        'Sociedade de propósito específico (SPE) ou filial recém-aberta de grupo empresarial consolidado.',
        'Reorganização societária com transferência de acervo técnico comprovado.',
      ],
      dataUsed: `Abertura ${formatDateBR(contract.supplier.openingDate)} · Assinatura ${formatDateBR(contract.signatureDate)}`,
      source: 'Receita Federal (CNPJ)',
      calculation: `${companyAgeDays} dias entre constituição e assinatura (limiar de triagem < 180 dias).`,
      evidenceIds: [evId],
    });
  }

  // 7. BR-CONFLICT-001: Potential conflict of interest (STF Tema 1001 — requires checking municipal statute)
  const overlappingShareholders = contract.supplier.shareholders.filter((s) => s.isPublicServantOverlap);
  if (overlappingShareholders.length > 0) {
    const sh = overlappingShareholders[0];
    const evId = pushEvidence({
      indicatorCode: 'BR-CONFLICT-001',
      ruleVersion: '2.0.0',
      sourceSystem: 'QSA Receita Federal × Folha/Agentes Públicos',
      documentId: primaryDoc?.id ?? 'QSA-CRUZAMENTO',
      documentTitle: 'Quadro de Sócios e Administradores (QSA)',
      pageNumber: 1,
      excerpt: `Sócio "${sh.name}" (${sh.role}) apresenta potencial conflito de interesses: ${sh.overlapDetail ?? 'sobreposição identificada em base pública'}.`,
      normalizedValue: sh.name,
      calculation: `Match QSA × cadastro de agentes públicos; requer verificação da Lei Orgânica / norma municipal (STF Tema 1001).`,
      sha256: primaryDoc?.sha256 ?? 'qsa-overlap-hash',
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      findingId: nextFindingId(),
      code: 'BR-CONFLICT-001',
      ruleVersion: '2.0.0',
      legalRulesetVersion: rulesetVersion,
      framework: 'Regra Jurídica Temporal',
      state: 'OBSERVATION',
      evidenceLevel: sh.localNepotismRuleVerified ? 'A' : 'B',
      confidence: 0.79,
      title: 'Potencial conflito de interesses (sócio × agente público)',
      severity: 'CRÍTICA',
      weightPoints: 24,
      summary: `Integrante do QSA (${sh.name}) apresenta indício de vínculo com a administração contratante (potential_conflict_of_interest).`,
      notAConclusion: 'STF Tema 1001 exige conferir a legislação municipal vigente e o efetivo vínculo/exoneração antes de afirmar impedimento legal.',
      alternativeHypotheses: [
        'Homonímia parcial sem coincidência integral de CPF.',
        'Agente exonerado antes do início da fase preparatória da licitação, fora do período de impedimento local.',
      ],
      dataUsed: `QSA: ${sh.name} (${sh.maskedCpfCnpj})`,
      source: 'Receita Federal (QSA) × Portal de Pessoal',
      calculation: `Verificação de potencial conflito retornou ${overlappingShareholders.length} sobreposição(ões); legislação municipal pendente de confirmação.`,
      legalReference: 'Lei nº 14.133/2021, art. 14, IV · STF Tema 1001',
      evidenceIds: [evId],
    });
  }

  // 8. BR-FRAC-001: Temporal contract splitting (jurisdiction + spending_unit + fiscal_year + temporal decree limit)
  if (contract.modality === 'Dispensa de Licitação') {
    const temporalLimit =
      contract.legalDispensationLimit ??
      getDispensationLimitForContract(appliedLegalRuleset, contract.dispensationArticle ?? 'art75_II');

    if (temporalLimit === null) {
      nonApplicableChecks.push({
        code: 'BR-FRAC-001',
        title: 'Fracionamento de despesa (limite normativo indisponível para a data)',
        state: 'NOT_VERIFIABLE',
        rationale:
          'Sem decreto temporal válido para a data da assinatura; o motor recusa inferir limite monetário de dispensa por fallback.',
      });
    } else if (contract.branchClassificationUncertain) {
      nonApplicableChecks.push({
        code: 'BR-FRAC-001',
        title: 'Fracionamento de despesa (ramo de atividade incerto)',
        state: 'NOT_VERIFIABLE',
        rationale: `Classificação do ramo de atividade (${contract.branchClassificationRule ?? 'regulamentação local'}) incerta; motor recusa apontar fracionamento sem enquadramento inequívoco.`,
      });
    } else {
      const sameYear = contract.relatedSameObjectSameFiscalYear ?? true;
      const sameBranch = contract.relatedSameBranch ?? true;
      const accumulatedTotal = contract.relatedSameObjectTotal12m ?? contract.originalValue;
      const relatedCount = contract.relatedSameObjectCount12m ?? 1;

      if (sameYear && sameBranch && relatedCount >= 2 && accumulatedTotal > temporalLimit) {
        const ratio = (accumulatedTotal / temporalLimit) * 100;
        const evId = pushEvidence({
          indicatorCode: 'BR-FRAC-001',
          ruleVersion: '2.0.0',
          sourceSystem: 'PNCP / Série da Unidade Gestora',
          documentId: primaryDoc?.id ?? 'FRACIONAMENTO',
          documentTitle: `Série de Dispensas — Exercício ${contract.year}`,
          pageNumber: 1,
          excerpt: `Somatório no exercício ${contract.year} na unidade gestora (${formatCurrencyBRL(accumulatedTotal)} em ${relatedCount} dispensas do mesmo ramo) excede o limite vigente na data (${formatCurrencyBRL(temporalLimit)} — ${appliedLegalRuleset.legalBasis}).`,
          normalizedValue: `${formatPercentageBR(ratio)} do limite vigente em ${contract.year}`,
          calculation: `${formatCurrencyBRL(accumulatedTotal)} ÷ ${formatCurrencyBRL(temporalLimit)} (${appliedLegalRuleset.ruleId}) = ${ratio.toFixed(2)}%`,
          sha256: primaryDoc?.sha256 ?? 'frac-hash',
          retrievedAt: evaluatedAt,
        });

        indicators.push({
          findingId: nextFindingId(),
          code: 'BR-FRAC-001',
          ruleVersion: '2.0.0',
          legalRulesetVersion: rulesetVersion,
          framework: 'Regra Jurídica Temporal',
          state: 'OBSERVATION',
          evidenceLevel: 'B',
          confidence: 0.88,
          title: 'Indício de fracionamento no exercício',
          severity: 'ALTA',
          weightPoints: 16,
          summary: `Somatório de ${relatedCount} dispensas no mesmo exercício (${contract.year}) e unidade gestora (${formatCurrencyBRL(accumulatedTotal)}) ultrapassa o limite vigente na data (${formatCurrencyBRL(temporalLimit)}).`,
          notAConclusion: 'Confirmar se a regulamentação local adota linha de fornecimento, subelemento ou outro critério de ramo de atividade (art. 75, § 1º).',
          alternativeHypotheses: [
            'Contrastações pertencem a unidades gestoras distintas com autonomia orçamentária própria.',
            'Regulamentação municipal de ramo de atividade classifica os objetos em linhas distintas.',
          ],
          dataUsed: `Acumulado ${contract.year}: ${formatCurrencyBRL(accumulatedTotal)} · Limite ${appliedLegalRuleset.ruleId}: ${formatCurrencyBRL(temporalLimit)} · Regra ramo: ${contract.branchClassificationRule ?? 'Linha de fornecimento / PDM'}`,
          source: 'PNCP (Unidade Gestora × Exercício)',
          calculation: `${formatCurrencyBRL(accumulatedTotal)} > ${formatCurrencyBRL(temporalLimit)} (${ratio.toFixed(1)}% do teto vigente em ${contract.signatureDate.slice(0, 4)})`,
          legalReference: `${appliedLegalRuleset.legalBasis}, art. 75, § 1º`,
          evidenceIds: [evId],
        });
      }
    }
  }

  // 9. BR-RISKMAT-001: Conditional Risk Matrix check (ONLY mandatory for grande vulto or integrado/semi-integrado)
  const riskMatrixReq = isRiskMatrixMandatory({
    updatedValue: contract.updatedValue,
    executionRegime: contract.executionRegime,
    ruleset: appliedLegalRuleset,
  });

  if (!riskMatrixReq.verifiable) {
    nonApplicableChecks.push({
      code: 'BR-RISKMAT-001',
      title: 'Matriz de riscos obrigatória (art. 22, § 3º)',
      state: 'NOT_VERIFIABLE',
      rationale: riskMatrixReq.reason,
    });
  } else if (riskMatrixReq.mandatory && contract.riskMatrixPresent === false) {
    const evId = pushEvidence({
      indicatorCode: 'BR-RISKMAT-001',
      ruleVersion: '1.1.0',
      sourceSystem: 'PNCP / Edital e Anexos',
      documentId: editalDoc?.id ?? primaryDoc?.id ?? 'EDITAL-MR',
      documentTitle: editalDoc?.title ?? 'Edital / Contrato',
      pageNumber: 1,
      excerpt: `${riskMatrixReq.reason} Matriz de alocação de riscos não localizada nos anexos publicados.`,
      normalizedValue: 'missing_required_risk_matrix',
      calculation: `Obrigatória=true (${contract.executionRegime ?? 'Grande Vulto'}) ∧ riskMatrixPresent=false`,
      sha256: primaryDoc?.sha256 ?? 'riskmat-hash',
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      findingId: nextFindingId(),
      code: 'BR-RISKMAT-001',
      ruleVersion: '1.1.0',
      legalRulesetVersion: rulesetVersion,
      framework: 'Regra Jurídica Temporal',
      state: 'INSUFFICIENT_EVIDENCE',
      evidenceLevel: 'B',
      confidence: 0.84,
      title: 'Matriz de riscos obrigatória não localizada',
      severity: 'ALTA',
      weightPoints: 14,
      summary: `${riskMatrixReq.reason} O anexo correspondente não foi localizado na coleta automatizada.`,
      notAConclusion: 'Ausência no documento extraído pode decorrer de anexo não publicado no PNCP ou de OCR parcial; verificar processo administrativo integral.',
      alternativeHypotheses: [
        'Matriz de riscos consta em anexo técnico separado do edital não indexado na API.',
      ],
      dataUsed: `Regime: ${contract.executionRegime ?? 'Ordinário'} · Valor: ${formatCurrencyBRL(contract.updatedValue)} · Teto Grande Vulto: ${formatCurrencyBRL(appliedLegalRuleset.thresholds?.grandeVulto ?? 261968421.04)}`,
      source: 'PNCP / Documentos do Processo',
      calculation: riskMatrixReq.reason,
      legalReference: 'Lei nº 14.133/2021, art. 22, § 3º',
      evidenceIds: [evId],
    });
  } else if (riskMatrixReq.mandatory && contract.riskMatrixPresent === undefined) {
    nonApplicableChecks.push({
      code: 'BR-RISKMAT-001',
      title: 'Matriz de riscos obrigatória (presença não verificada)',
      state: 'NOT_VERIFIABLE',
      rationale: `${riskMatrixReq.reason} Presença do anexo não foi verificada nos documentos coletados (riskMatrixPresent desconhecido).`,
    });
  } else if (riskMatrixReq.mandatory && contract.riskMatrixPresent === true) {
    nonApplicableChecks.push({
      code: 'BR-RISKMAT-001',
      title: 'Matriz de riscos obrigatória (art. 22, § 3º)',
      state: 'CONFIRMED_DATA',
      rationale: `${riskMatrixReq.reason} Matriz de riscos confirmada nos anexos do processo.`,
    });
  } else {
    nonApplicableChecks.push({
      code: 'BR-RISKMAT-001',
      title: 'Matriz de riscos obrigatória (art. 22, § 3º)',
      state: 'NOT_APPLICABLE',
      rationale: riskMatrixReq.reason,
    });
  }

  // Seguro-garantia (art. 99/102) is permissive — explicitly recorded as NOT_APPLICABLE, never an irregularity
  nonApplicableChecks.push({
    code: 'BR-GARANT-001',
    title: 'Seguro-garantia com cláusula de retomada (até 30%)',
    state: 'NOT_APPLICABLE',
    rationale: 'Lei nº 14.133/2021 adota redação facultativa (“poderá ser exigida” em obras de grande vulto); ausência não configura irregularidade.',
  });

  // 10. BR-PAYORD-001: Chronological payment order (Lei 14.133 art. 141)
  if (executionChain.chronologicalOrderStatus === 'unexplained_break') {
    const broken = contract.payments.find(
      (p) => p.paidOutOfOrder && (!p.outOfOrderJustification || !p.justificationPublished)
    )!;
    const evId = pushEvidence({
      indicatorCode: 'BR-PAYORD-001',
      ruleVersion: '1.0.0',
      sourceSystem: broken.sourceSystem,
      documentId: primaryDoc?.id ?? 'EXEC-FIN',
      documentTitle: `Pagamento ${broken.documentNumber}`,
      pageNumber: 1,
      excerpt: `Pagamento ${broken.documentNumber} (${formatCurrencyBRL(broken.amount)}, fonte ${broken.fundingSource ?? 'Ordinária'}) liquidado fora da ordem cronológica sem justificativa publicada verificável.`,
      normalizedValue: 'unexplained_break',
      calculation: `paidOutOfOrder=true ∧ justificationPublished=${Boolean(broken.justificationPublished)}`,
      sha256: primaryDoc?.sha256 ?? 'payord-hash',
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      findingId: nextFindingId(),
      code: 'BR-PAYORD-001',
      ruleVersion: '1.0.0',
      legalRulesetVersion: rulesetVersion,
      framework: 'Execução Financeira',
      state: 'OBSERVATION',
      evidenceLevel: 'B',
      confidence: 0.87,
      title: 'Quebra da ordem cronológica sem justificativa verificável',
      severity: 'ALTA',
      weightPoints: 14,
      summary: `Pagamento ${broken.documentNumber} ocorreu fora da ordem cronológica da fonte de recursos sem publicação da justificativa exigida pelo art. 141, § 1º.`,
      notAConclusion: 'A alteração da ordem cronológica é admitida em hipóteses legais (grave perturbação, calamidade, pequeno valor) mediante justificativa publicada.',
      alternativeHypotheses: [
        'Justificativa formal publicada em Diário Oficial local ainda não ingerido no repositório.',
        'Recursos oriundos de fonte diferenciada ou convênio federal específico.',
      ],
      dataUsed: `Doc ${broken.documentNumber} · Fonte: ${broken.fundingSource ?? 'Não informada'} · Justificativa publicada: Não`,
      source: broken.sourceSystem,
      calculation: `Art. 141, § 1º exige justificativa prévia, comunicação aos controles e publicidade para alteração da ordem cronológica.`,
      legalReference: 'Lei nº 14.133/2021, art. 141, § 1º e § 2º',
      evidenceIds: [evId],
    });
  } else if (executionChain.chronologicalOrderStatus === 'justified_exception') {
    nonApplicableChecks.push({
      code: 'BR-PAYORD-001',
      title: 'Ordem cronológica de pagamentos (art. 141)',
      state: 'CONFIRMED_DATA',
      rationale: 'Alteração pontual na ordem cronológica acompanhada de justificativa formal publicada na transparência.',
    });
  }

  // 11. BR-DIVERG-001: Proven execution exceeding contracted obligation or cross-source divergence
  const totalOutflow = executionChain.paidTotal > 0 ? executionChain.paidTotal : executionChain.billedTotal;
  if (contract.updatedValue > 0 && totalOutflow > contract.updatedValue * 1.02) {
    const excess = totalOutflow - contract.updatedValue;
    const evId = pushEvidence({
      indicatorCode: 'BR-DIVERG-001',
      ruleVersion: '2.0.0',
      sourceSystem: 'PNCP Instrumentos de Cobrança × SICONFI/Tesouro',
      documentId: primaryDoc?.id ?? 'COBRANCAS',
      documentTitle: 'Relatório de Execução Financeira (Empenhos, Pagamentos e Cobranças)',
      pageNumber: 1,
      excerpt: `Total comprovado de cobranças/pagamentos (${formatCurrencyBRL(totalOutflow)}) excede a obrigação contratual atualizada (${formatCurrencyBRL(contract.updatedValue)}) em ${formatCurrencyBRL(excess)}.`,
      normalizedValue: `+${formatCurrencyBRL(excess)}`,
      calculation: `Execução (${formatCurrencyBRL(totalOutflow)}) − Obrigação Atualizada (${formatCurrencyBRL(contract.updatedValue)}) = +${formatCurrencyBRL(excess)}`,
      sha256: primaryDoc?.sha256 ?? 'payment-divergence-hash',
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      findingId: nextFindingId(),
      code: 'BR-DIVERG-001',
      ruleVersion: '2.0.0',
      legalRulesetVersion: rulesetVersion,
      framework: 'Execução Financeira',
      state: 'CONFIRMED_DATA',
      evidenceLevel: 'A',
      confidence: 0.95,
      title: 'Execução financeira acima da obrigação contratada',
      severity: 'ALTA',
      weightPoints: 15,
      summary: `Pagamentos/cobranças comprovados somam ${formatCurrencyBRL(totalOutflow)}, superando o valor contratual atualizado em ${formatCurrencyBRL(excess)}.`,
      notAConclusion: 'Verificar se há apostilamento de reajuste ou termo aditivo assinado ainda não publicado no PNCP.',
      alternativeHypotheses: [
        'Apostilamento de reajuste anual ainda não sincronizado na base do PNCP.',
        'Duplicidade de lançamento entre nota de liquidação e instrumento de cobrança no portal municipal.',
      ],
      dataUsed: `Execução ${formatCurrencyBRL(totalOutflow)} vs Obrigação ${formatCurrencyBRL(contract.updatedValue)}`,
      source: 'PNCP × Portal Municipal',
      calculation: `${formatCurrencyBRL(totalOutflow)} > ${formatCurrencyBRL(contract.updatedValue)} (+${((excess / contract.updatedValue) * 100).toFixed(2)}%)`,
      evidenceIds: [evId],
    });
  } else if (divergences.some((d) => d.severity === 'ALTA')) {
    const highDiv = divergences.find((d) => d.severity === 'ALTA')!;
    const evId = pushEvidence({
      indicatorCode: 'BR-DIVERG-002',
      ruleVersion: '2.0.0',
      sourceSystem: highDiv.sources.map((s) => s.sourceSystem).join(' × '),
      documentId: primaryDoc?.id ?? 'RECONCILIACAO',
      documentTitle: 'Matriz de Reconciliação Multifonte',
      pageNumber: 1,
      excerpt: `${highDiv.field}: ${highDiv.sources.map((s) => `${s.sourceSystem} = ${s.value}`).join(' | ')}.`,
      normalizedValue: highDiv.deltaDescription,
      calculation: `Comparação direta entre registros preservados com proveniência independente.`,
      sha256: primaryDoc?.sha256 ?? 'source-divergence-hash',
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      findingId: nextFindingId(),
      code: 'BR-DIVERG-002',
      ruleVersion: '2.0.0',
      legalRulesetVersion: rulesetVersion,
      framework: 'Execução Financeira',
      state: 'OBSERVATION',
      evidenceLevel: 'B',
      confidence: 0.9,
      title: 'Divergência de valor entre fontes oficiais',
      severity: 'MÉDIA',
      weightPoints: 8,
      summary: highDiv.deltaDescription,
      notAConclusion: 'Defasagem de envio entre PNCP e sistemas de Tribunais de Contas (Audesp/SIGA/SIM-AM) pode explicar divergências temporárias.',
      alternativeHypotheses: [
        'Lote mensal do TCE estadual ainda não recebeu o aditivo recém-publicado no PNCP.',
      ],
      dataUsed: highDiv.sources.map((s) => `${s.sourceSystem}: ${s.value}`).join(' · '),
      source: highDiv.sources.map((s) => s.sourceSystem).join(' × '),
      calculation: highDiv.deltaDescription,
      evidenceIds: [evId],
    });
  }

  // 11b. BR-TRANSP-001: Contract listed in local municipal transparency without PNCP publication or disclosed value
  const hasPncpSource = contract.sourceRecords.some((s) => s.sourceSystem === 'PNCP');
  if (!hasPncpSource && contract.originalValue === 0 && contract.updatedValue === 0) {
    const evId = pushEvidence({
      indicatorCode: 'BR-TRANSP-001',
      ruleVersion: '1.0.0',
      sourceSystem: contract.sourceRecords[0]?.sourceSystem ?? 'Portal da Transparência Municipal',
      documentId: primaryDoc?.id ?? 'TRANSPARENCIA-LOCAL',
      documentTitle: primaryDoc?.title ?? 'Relação de Contratos — Portal da Transparência Municipal',
      pageNumber: 1,
      excerpt: `Contrato ${contract.contractNumber} listado na transparência municipal sem valor global divulgado e sem registro correspondente localizado na API pública do PNCP.`,
      normalizedValue: 'ausente_pncp_valor_omitido',
      calculation: `PNCP=ausente ∧ valorGlobal=não_divulgado (verificar art. 94 da Lei 14.133/2021)`,
      sha256: primaryDoc?.sha256 ?? 'transp-omission-hash',
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      findingId: nextFindingId(),
      code: 'BR-TRANSP-001',
      ruleVersion: '1.0.0',
      legalRulesetVersion: rulesetVersion,
      framework: 'Regra Jurídica Temporal',
      state: 'OBSERVATION',
      evidenceLevel: 'B',
      confidence: 0.9,
      title: 'Ausência no PNCP e valor omitido na relação municipal',
      severity: 'MÉDIA',
      weightPoints: 10,
      summary: `O contrato ${contract.contractNumber} consta na relação municipal de fiscais de contrato, mas não retornou publicação correspondente na API oficial do PNCP nem divulga o valor global no extrato.`,
      notAConclusion: 'A ausência no PNCP pode decorrer de atraso na integração do software municipal, exceção legal de município < 20 mil habitantes (art. 176) ou publicação sob outro identificador.',
      alternativeHypotheses: [
        'Integração entre o portal local (ex.: Acesso à Informação / Diário Oficial) e o PNCP ainda não transmitiu o termo.',
        'Valor global consta apenas no extrato do Diário Oficial ou nas notas de empenho no TCM/TCE estadual.',
      ],
      dataUsed: `Contrato ${contract.contractNumber} · Origem: ${contract.sourceRecords[0]?.sourceSystem ?? 'Portal Municipal'} · PNCP: não localizado · Valor: não divulgado`,
      source: 'Portal da Transparência Municipal × PNCP API Oficial',
      calculation: `hasPncpRecord=false ∧ disclosedValue=0 → diligência documental recomendada`,
      legalReference: 'Lei nº 14.133/2021, art. 94 e art. 174 (divulgação no PNCP como condição de eficácia)',
      evidenceIds: [evId],
    });

    nonApplicableChecks.push({
      code: 'BENCH_HORIZONTAL_SUPPLIER_V1',
      title: 'Benchmarking horizontal e comparação de preços',
      state: 'NOT_VERIFIABLE',
      rationale: 'Valor global e itens unitários não foram divulgados na Relação de Fiscais nem no PNCP; inferência de preço recusada até obtenção do contrato integral ou notas de empenho.',
    });
  }

  // 12. BR-EFIC-001: Spend vs Output efficiency (Produtividade com denominador operacional)
  if (contract.productivity) {
    const prod = contract.productivity;
    const validProductivityInputs =
      Number.isFinite(prod.deliveredOutput) &&
      prod.deliveredOutput > 0 &&
      Number.isFinite(prod.contractedOutput) &&
      prod.contractedOutput > 0 &&
      Number.isFinite(prod.actualUnitCost) &&
      prod.actualUnitCost > 0 &&
      Number.isFinite(prod.benchmarkUnitCost) &&
      prod.benchmarkUnitCost > 0;

    if (!validProductivityInputs) {
      nonApplicableChecks.push({
        code: 'BR-EFIC-001',
        title: `Produtividade operacional (${prod.domain})`,
        state: 'NOT_VERIFIABLE',
        rationale:
          'Entregas medidas, quantidade contratada ou custo unitário de referência zerados/inválidos; cálculo de eficiência recusado.',
      });
    } else {
      const costDeviationPct =
        ((prod.actualUnitCost - prod.benchmarkUnitCost) / prod.benchmarkUnitCost) * 100;
      const physicalGap =
        prod.financialProgressPct !== undefined && prod.physicalProgressPct !== undefined
          ? prod.financialProgressPct - prod.physicalProgressPct
          : 0;

      if (costDeviationPct >= 20 || physicalGap >= 20) {
        const evId = pushEvidence({
          indicatorCode: 'BR-EFIC-001',
          ruleVersion: '2.1.0',
          sourceSystem: prod.benchmarkSource,
          documentId: primaryDoc?.id ?? 'PRODUTIVIDADE',
          documentTitle: `Indicador de Produtividade — ${prod.domain}`,
          pageNumber: 1,
          excerpt:
            physicalGap >= 20
              ? `Avanço financeiro de ${prod.financialProgressPct}% frente a avanço físico medido de ${prod.physicalProgressPct}% (descompasso de ${physicalGap} p.p.).`
              : `Custo operacional efetivo de ${formatCurrencyBRL(prod.actualUnitCost)}/${prod.unitLabel} frente à referência ${formatCurrencyBRL(prod.benchmarkUnitCost)}/${prod.unitLabel} (+${costDeviationPct.toFixed(1)}%).`,
          normalizedValue: `${formatCurrencyBRL(prod.actualUnitCost)}/${prod.unitLabel}`,
          calculation:
            physicalGap >= 20
              ? `Avanço Financeiro (${prod.financialProgressPct}%) − Avanço Físico (${prod.physicalProgressPct}%) = ${physicalGap} p.p.`
              : `(${prod.actualUnitCost.toFixed(2)} − ${prod.benchmarkUnitCost.toFixed(2)}) ÷ ${prod.benchmarkUnitCost.toFixed(2)} = +${costDeviationPct.toFixed(2)}%`,
          sha256: primaryDoc?.sha256 ?? 'efficiency-hash',
          retrievedAt: evaluatedAt,
        });

        indicators.push({
          findingId: nextFindingId(),
          code: 'BR-EFIC-001',
          ruleVersion: '2.1.0',
          legalRulesetVersion: rulesetVersion,
          framework: 'Produtividade',
          state: 'OBSERVATION',
          evidenceLevel: 'B',
          confidence: 0.86,
          title:
            physicalGap >= 20
              ? `Descompasso físico-financeiro (${physicalGap} p.p.)`
              : `Custo por entrega ${Math.round(costDeviationPct)}% acima do parâmetro`,
          severity: costDeviationPct >= 35 || physicalGap >= 30 ? 'ALTA' : 'MÉDIA',
          weightPoints: costDeviationPct >= 35 || physicalGap >= 30 ? 12 : 8,
          summary:
            physicalGap >= 20
              ? `Execução financeira (${prod.financialProgressPct}%) supera o avanço físico entregue (${prod.physicalProgressPct}%).`
              : `Custo efetivo por output mensurável (${formatCurrencyBRL(prod.actualUnitCost)}/${prod.unitLabel}) excede o parâmetro (${formatCurrencyBRL(prod.benchmarkUnitCost)}/${prod.unitLabel}).`,
          notAConclusion: 'Avaliar boletins de medição pendentes de lançamento ou custos de mobilização inicial previstos em cronograma.',
          alternativeHypotheses: [
            'Adiantamento contratual de mobilização ou aquisição de insumos em estoque já medidos fisicamente mas pendentes de lançamento no portal.',
          ],
          dataUsed: `${prod.domain} · Entregue: ${prod.deliveredOutput.toLocaleString('pt-BR')} / ${prod.contractedOutput.toLocaleString('pt-BR')} ${prod.unitLabel}`,
          source: prod.benchmarkSource,
          calculation: `Eficiência = output público mensurável ÷ despesa real (${formatCurrencyBRL(prod.actualUnitCost)}/${prod.unitLabel})`,
          evidenceIds: [evId],
        });
      }
    }
  }

  // Sort indicators by severity order then weight
  const severityRank: Record<RiskIndicator['severity'], number> = {
    CRÍTICA: 0,
    ALTA: 1,
    MÉDIA: 2,
    BAIXA: 3,
  };
  indicators.sort(
    (a, b) => severityRank[a.severity] - severityRank[b.severity] || b.weightPoints - a.weightPoints
  );

  const rawScore = indicators.reduce((sum, ind) => sum + ind.weightPoints, 0);
  const score = Math.min(100, Math.max(0, rawScore));

  // Declared evidentiary coverage: refuse "Conformidade preliminar" when no source or document exists
  const hasSources = contract.sourceRecords.length > 0;
  const hasDocs = contract.documents.length > 0;
  const hasMonetaryData = contract.originalValue > 0 || contract.updatedValue > 0;
  const hasItemsOrBench = contract.items.length > 0 || Boolean(contract.benchmarkPeers);
  const hasPayments = contract.payments.length > 0;

  let coverageStatus: NonNullable<RiskAssessment['coverageStatus']> = 'ADEQUATE';
  if (!hasSources && !hasDocs) {
    coverageStatus = 'INSUFFICIENT';
  } else if (!hasMonetaryData || (!hasItemsOrBench && !hasPayments)) {
    coverageStatus = 'PARTIAL';
  }

  let classification: RiskAssessment['classification'];
  let headline: string;
  if (score >= 70) {
    classification = 'Revisão humana recomendada';
    headline = `RISCO ${score}/100 — revisão humana recomendada`;
  } else if (score >= 45) {
    classification = 'Revisão humana prioritária';
    headline = `RISCO ${score}/100 — revisão técnica recomendada`;
  } else if (score >= 20) {
    classification = 'Atenção moderada';
    headline = `RISCO ${score}/100 — atenção moderada`;
  } else if (coverageStatus === 'INSUFFICIENT') {
    classification = 'Cobertura insuficiente';
    headline = `RISCO ${score}/100 — cobertura insuficiente para conformidade`;
  } else {
    classification = 'Conformidade preliminar';
    headline = `RISCO ${score}/100 — sem indícios críticos detectados`;
  }

  return {
    score,
    classification,
    coverageStatus,
    headline,
    variationPct,
    amendmentTotalPct,
    weightedPriceDeviationPct: priceAnalysis.deviationPct,
    appliedLegalRuleset,
    executionChain,
    horizontalBenchmark,
    indicators,
    nonApplicableChecks,
    evidences,
    divergences,
    evaluatedAt,
    engineVersion: RISK_ENGINE_VERSION,
  };
}

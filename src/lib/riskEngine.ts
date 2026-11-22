import type {
  ContractRecord,
  DocumentRecord,
  EvidenceItem,
  ExecutionChainSummary,
  HorizontalBenchmarkResult,
  RiskAssessment,
  RiskIndicator,
  SanctionEffect,
  SanctionRecord,
  SourceDivergence,
} from '../types/audit';
import { evaluateHorizontalBenchmark } from './benchmarkEngine';
import { formatCurrencyBRL, formatDateBR, formatPercentageBR } from './formatters';
import { sha256HexSync } from './hash';
import {
  getDispensationLimitForContract,
  isRiskMatrixMandatory,
  resolveLegalRulesetStrict,
} from './legalRules';

export const RISK_ENGINE_VERSION = 'forensic-engine-2026.13';

function daysBetween(dateA: string, dateB: string): number {
  if (!dateA || !dateB) return Number.NaN;
  const a = new Date(dateA).getTime();
  const b = new Date(dateB).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function monthsBetween(dateA: string, dateB: string): number {
  const days = daysBetween(dateA, dateB);
  if (!Number.isFinite(days)) return 1;
  return Math.max(1, Math.round(Math.abs(days) / 30));
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

/**
 * Deterministic semantic finding ID independent of array ordering (A06/R8).
 * Enriching a contract with new findings NEVER shifts existing finding IDs.
 */
export function buildSemanticFindingId(
  contractId: string,
  ruleCode: string,
  semanticTarget = 'contract'
): { findingId: string; semanticKey: string } {
  const semanticKey = `${contractId.trim().toLowerCase()}|${ruleCode.trim().toUpperCase()}|${semanticTarget.trim().toLowerCase()}`;
  const shortHash = sha256HexSync(semanticKey).slice(0, 10);
  const cleanCode = ruleCode.replace(/[^A-Z0-9-]/gi, '').toUpperCase();
  return {
    findingId: `FND-${cleanCode}-${shortHash}`,
    semanticKey,
  };
}

function computeEvidenceDigest(
  docSha256: string | undefined,
  canonicalPayload: Record<string, unknown>
): string {
  if (docSha256 && /^[a-f0-9]{64}$/i.test(docSha256)) {
    return docSha256.toLowerCase();
  }
  return sha256HexSync(JSON.stringify(canonicalPayload));
}

/**
 * Classifies whether a sanction legally imposes an impediment to contract
 * versus a pecuniary fine without contracting prohibition (e.g. CNEP art. 6º I, Lei 12.846/2013).
 */
export function classifySanctionEffect(sanction: SanctionRecord): SanctionEffect {
  if (sanction.sanctionEffect) {
    return sanction.sanctionEffect;
  }
  const reasonNorm = (sanction.reason ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const mentionsImpediment =
    /\b(impedimento|inidone|suspensao|proibicao de contratar|proibicao de licitar|declaracao de inidoneidade)\b/.test(
      reasonNorm
    );
  const explicitlyWithoutImpediment =
    /\b(sem impedimento|apenas multa|somente multa|publicacao extraordinaria)\b/.test(reasonNorm);
  const mentionsFine = /\b(multa|pecuniari|art\.?\s*6[º°]?,?\s*i\b)\b/.test(reasonNorm);

  if (sanction.registry === 'CNEP') {
    if (explicitlyWithoutImpediment || (mentionsFine && !mentionsImpediment)) {
      return 'fine_only';
    }
    return mentionsImpediment ? 'impediment' : 'unknown';
  }

  if (explicitlyWithoutImpediment) {
    return 'fine_only';
  }

  if (sanction.registry === 'CEIS' || sanction.registry === 'TCU-Inidôneos' || sanction.registry === 'CEPIM') {
    return 'impediment';
  }

  return mentionsImpediment ? 'impediment' : 'unknown';
}

export interface PriceDeviationAnalysis {
  deviationPct: number;
  contractedTotal: number;
  referenceTotal: number;
  comparableItemCount: number;
  totalItemCount: number;
  unreferencedContractedTotal: number;
  comparableValueSharePct: number;
  comparableSources: string[];
  highestItem?: {
    description: string;
    deviationPct: number;
    unitPrice: number;
    referencePrice: number;
    referenceSource: string;
  };
}

/**
 * Computes weighted price deviation strictly over COMPARABLE items (A04/R4).
 * Items without a valid reference price ('Sem Referência' or referencePrice <= 0) are NEVER
 * added to the numerator while omitted from the denominator.
 */
export function calculateWeightedPriceDeviation(contract: ContractRecord): PriceDeviationAnalysis {
  if (!contract.items.length) {
    return {
      deviationPct: 0,
      contractedTotal: 0,
      referenceTotal: 0,
      comparableItemCount: 0,
      totalItemCount: 0,
      unreferencedContractedTotal: 0,
      comparableValueSharePct: 0,
      comparableSources: [],
    };
  }

  let comparableContractedTotal = 0;
  let comparableReferenceTotal = 0;
  let unreferencedContractedTotal = 0;
  let comparableItemCount = 0;
  const comparableSourcesSet = new Set<string>();

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
    const qty = Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : 0;
    const unitPrice = Number.isFinite(item.unitPrice) && item.unitPrice > 0 ? item.unitPrice : 0;
    const refPrice = Number.isFinite(item.referencePrice) && item.referencePrice > 0 ? item.referencePrice : 0;
    const itemContracted = qty * unitPrice;

    const isComparable =
      qty > 0 &&
      unitPrice > 0 &&
      refPrice > 0 &&
      item.referenceSource !== 'Sem Referência';

    if (!isComparable) {
      unreferencedContractedTotal += itemContracted;
      continue;
    }

    const itemReference = qty * refPrice;
    comparableContractedTotal += itemContracted;
    comparableReferenceTotal += itemReference;
    comparableItemCount += 1;
    comparableSourcesSet.add(item.referenceSource);

    const itemDev = ((unitPrice - refPrice) / refPrice) * 100;
    if (!highestItem || itemDev > highestItem.deviationPct) {
      highestItem = {
        description: item.description,
        deviationPct: itemDev,
        unitPrice,
        referencePrice: refPrice,
        referenceSource: item.referenceSource,
      };
    }
  }

  const allItemsContracted = comparableContractedTotal + unreferencedContractedTotal;
  const comparableValueSharePct =
    allItemsContracted > 0
      ? Number(((comparableContractedTotal / allItemsContracted) * 100).toFixed(2))
      : 0;

  const deviationPct =
    comparableReferenceTotal > 0
      ? ((comparableContractedTotal - comparableReferenceTotal) / comparableReferenceTotal) * 100
      : 0;

  return {
    deviationPct: Number(deviationPct.toFixed(2)),
    contractedTotal: Number(comparableContractedTotal.toFixed(2)),
    referenceTotal: Number(comparableReferenceTotal.toFixed(2)),
    comparableItemCount,
    totalItemCount: contract.items.length,
    unreferencedContractedTotal: Number(unreferencedContractedTotal.toFixed(2)),
    comparableValueSharePct,
    comparableSources: Array.from(comparableSourcesSet),
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

  const nonEmptyEndDates = contract.sourceRecords.filter((r) => Boolean(r.reportedEndDate?.trim()));
  const uniqueEndDates = new Set(nonEmptyEndDates.map((r) => r.reportedEndDate.trim()));
  if (uniqueEndDates.size > 1) {
    divergences.push({
      field: 'Data de término da vigência',
      sources: nonEmptyEndDates.map((r) => ({
        sourceSystem: r.sourceSystem,
        value: formatDateBR(r.reportedEndDate),
      })),
      severity: 'BAIXA',
      deltaDescription: 'Vigência final registrada com datas distintas entre as bases consultadas.',
    });
  }

  return divergences;
}

/**
 * Analyzes financial execution chain (A05/R3):
 * - Preserves distinct events even when documentNumber is empty and date/amount match
 *   (keys by explicit mirrorOfEventId or sourceSystem+id when documentNumber is absent).
 * - Models negative reversals / estornos explicitly instead of dropping them silently.
 * - Refuses to assert 'valid_sequence' from a single isolated chronologicalPosition without queue coverage.
 */
export function analyzeExecutionChain(contract: ContractRecord): ExecutionChainSummary {
  const durationMonths =
    contract.startDate && contract.endDate ? monthsBetween(contract.startDate, contract.endDate) : 1;
  const estimatedMonthlyContractValue =
    contract.updatedValue > 0 && contract.startDate && contract.endDate
      ? Number((contract.updatedValue / Math.max(1, durationMonths)).toFixed(2))
      : 0;

  const seenCanonicalKeys = new Set<string>();
  const seenMirrorRoots = new Set<string>();

  const uniqueEvents = contract.payments.filter((p) => {
    if (!Number.isFinite(p.amount) || p.amount === 0) return false;

    // Explicit cross-portal mirror reconciliation
    if (p.mirrorOfEventId) {
      if (seenMirrorRoots.has(p.mirrorOfEventId)) return false;
      seenMirrorRoots.add(p.mirrorOfEventId);
    } else if (p.id) {
      seenMirrorRoots.add(p.id);
    }

    const docNum = (p.documentNumber || '').trim().toLowerCase();
    const dateKey = (p.date || '').slice(0, 10);
    const amountCents = Math.round(p.amount * 100);

    // When documentNumber is present, deduplicate exact cross-source mirrors by (type, docNum, date, cents, fundingSource).
    // When documentNumber is absent, NEVER collapse independent events with different IDs/sources/fundingSources!
    const canonicalKey = docNum
      ? `${p.type}|doc:${docNum}|${dateKey}|${amountCents}|${(p.fundingSource ?? '').trim().toLowerCase()}`
      : `${p.type}|src:${(p.sourceSystem || '').trim().toLowerCase()}|id:${(p.id || '').trim().toLowerCase()}|${dateKey}|${amountCents}|${(p.fundingSource ?? '').trim().toLowerCase()}`;

    if (seenCanonicalKeys.has(canonicalKey)) return false;
    seenCanonicalKeys.add(canonicalKey);
    return true;
  });

  const committedTotal = Number(
    uniqueEvents
      .filter((p) => p.type === 'Empenho' && p.amount > 0 && !p.isReversal)
      .reduce((s, p) => s + p.amount, 0)
      .toFixed(2)
  );
  const liquidatedTotal = Number(
    uniqueEvents
      .filter((p) => p.type === 'Liquidação' && p.amount > 0 && !p.isReversal)
      .reduce((s, p) => s + p.amount, 0)
      .toFixed(2)
  );

  const grossPaidTotal = Number(
    uniqueEvents
      .filter((p) => p.type === 'Pagamento' && p.amount > 0 && !p.isReversal)
      .reduce((s, p) => s + p.amount, 0)
      .toFixed(2)
  );
  const reversalsTotal = Number(
    uniqueEvents
      .filter((p) => p.type === 'Pagamento' && (p.amount < 0 || p.isReversal))
      .reduce((s, p) => s + Math.abs(p.amount), 0)
      .toFixed(2)
  );
  const netPaidTotal = Number(Math.max(0, grossPaidTotal - reversalsTotal).toFixed(2));
  const paidTotal = reversalsTotal > 0 ? netPaidTotal : grossPaidTotal;

  const billedTotal = Number(
    uniqueEvents
      .filter((p) => p.type === 'Instrumento de Cobrança' && p.amount > 0 && !p.isReversal)
      .reduce((s, p) => s + p.amount, 0)
      .toFixed(2)
  );
  const deliveredVerifiedTotal = Number(
    uniqueEvents
      .filter((p) => p.type === 'Entrega / Medição' && p.amount > 0 && !p.isReversal)
      .reduce((s, p) => s + p.amount, 0)
      .toFixed(2)
  );

  const provenExecutionAvailable =
    committedTotal > 0 || liquidatedTotal > 0 || grossPaidTotal > 0 || billedTotal > 0;

  const outOfOrder = uniqueEvents.filter((p) => p.paidOutOfOrder);
  const positionedQueueEntries = uniqueEvents.filter(
    (p) =>
      (p.type === 'Pagamento' || p.type === 'Liquidação') &&
      typeof p.chronologicalPosition === 'number' &&
      Number.isFinite(p.chronologicalPosition)
  );
  const hasVerifiedQueueCoverage =
    positionedQueueEntries.length >= 2 ||
    positionedQueueEntries.some((p) => p.queueCoverageVerified === true);

  let chronologicalOrderStatus: ExecutionChainSummary['chronologicalOrderStatus'] = 'not_verifiable';
  if (outOfOrder.length > 0) {
    if (outOfOrder.some((p) => !p.outOfOrderJustification || !p.justificationPublished)) {
      chronologicalOrderStatus = 'unexplained_break';
    } else {
      chronologicalOrderStatus = 'justified_exception';
    }
  } else if (hasVerifiedQueueCoverage) {
    chronologicalOrderStatus = 'valid_sequence';
  }

  return {
    contractedObligation: contract.updatedValue,
    estimatedMonthlyContractValue,
    contractDurationMonths: durationMonths,
    committedTotal,
    liquidatedTotal,
    paidTotal,
    reversalsTotal,
    netPaidTotal,
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
    const subjectContractKey = [
      contract.municipalityName.trim().toLowerCase(),
      contract.uf.trim().toUpperCase(),
      contract.contractNumber.trim().toLowerCase(),
      String(contract.year),
    ].join('|');

    horizontalBenchmark = evaluateHorizontalBenchmark({
      serviceClass: contract.benchmarkPeers.serviceClass,
      unitLabel: contract.benchmarkPeers.unitLabel,
      subjectNominalPrice: contract.benchmarkPeers.subjectNominalPrice,
      subjectYear: contract.year,
      inflationIndexLabel: contract.benchmarkPeers.inflationIndexLabel,
      peers: contract.benchmarkPeers.peers,
      mode: contract.benchmarkPeers.mode ?? 'market',
      subjectContractKey,
    });
  }

  const primaryDoc = findBestDocument(contract.documents, ['Contrato Original', 'Documento Importado', 'Edital / TR']);
  const amendmentDoc = findBestDocument(contract.documents, ['Termo Aditivo', 'Contrato Original']);
  const editalDoc = findBestDocument(contract.documents, ['Edital / TR', 'Contrato Original']);

  let evidenceCounter = 1;
  const pushEvidence = (params: Omit<EvidenceItem, 'id' | 'legalRulesetVersion'>): string => {
    const id = `EV-${String(evidenceCounter++).padStart(3, '0')}`;
    evidences.push({ id, legalRulesetVersion: rulesetVersion, ...params });
    return id;
  };

  const makeFindingMeta = (code: string, target: string, inputs: Record<string, unknown>) => {
    const { findingId, semanticKey } = buildSemanticFindingId(contract.id, code, target);
    const inputsDigest = sha256HexSync(JSON.stringify({ code, rulesetVersion, inputs }));
    return { findingId, semanticKey, inputsDigest };
  };

  // 1. BR-SANC-001: Sanctions with temporal validity, scope, AND legal effect distinction (A14)
  const activeSanctionsOnDate = contract.supplier.sanctions.filter(
    (s) =>
      Boolean(contract.signatureDate) &&
      Boolean(s.startDate) &&
      Boolean(s.endDate) &&
      s.startDate <= contract.signatureDate &&
      contract.signatureDate <= s.endDate
  );

  const fineOnlySanctions = activeSanctionsOnDate.filter(
    (s) => classifySanctionEffect(s) === 'fine_only'
  );
  const unknownEffectSanctions = activeSanctionsOnDate.filter(
    (s) => classifySanctionEffect(s) === 'unknown'
  );
  const impedimentCandidates = activeSanctionsOnDate.filter(
    (s) => classifySanctionEffect(s) === 'impediment'
  );

  const ambiguousSanctions = impedimentCandidates.filter(
    (s) =>
      (s.scope === 'Estadual' && !s.scopeUf?.trim()) ||
      (s.scope === 'Órgão Sancionador' && !s.sanctioningOrgan?.trim())
  );

  const effectiveImpediments = impedimentCandidates.filter((s) => {
    if (s.scope === 'Nacional') return true;
    if (s.scope === 'Estadual') {
      return Boolean(s.scopeUf?.trim()) && s.scopeUf!.trim().toUpperCase() === contract.uf.toUpperCase();
    }
    const organ = s.sanctioningOrgan?.trim().toLowerCase() ?? '';
    if (!organ) return false;
    return (
      organ.includes(contract.municipalityName.toLowerCase()) ||
      organ.includes(contract.entityName.toLowerCase())
    );
  });

  if (effectiveImpediments.length > 0) {
    const first = effectiveImpediments[0];
    const meta = makeFindingMeta('BR-SANC-001', `${contract.supplier.cnpj}:${first.registry}`, {
      cnpj: contract.supplier.cnpj,
      signatureDate: contract.signatureDate,
      sanctions: effectiveImpediments.map((s) => ({
        id: s.id,
        registry: s.registry,
        scope: s.scope,
        startDate: s.startDate,
        endDate: s.endDate,
      })),
    });

    const evId = pushEvidence({
      indicatorCode: 'BR-SANC-001',
      ruleVersion: '2.2.0',
      sourceSystem: first.sourceSystem,
      documentId: primaryDoc?.id ?? `REG-${first.registry}-${first.id}`,
      documentTitle: `${first.registry} — ${first.sanctioningOrgan}`,
      pageNumber: 1,
      excerpt: `Impedimento vigente na data da assinatura (${formatDateBR(contract.signatureDate)}): ${first.registry} (${first.scope}) — ${first.reason}. Vigência ${formatDateBR(first.startDate)} a ${formatDateBR(first.endDate)}.`,
      normalizedValue: `${effectiveImpediments.length} impedimento(s) vigente(s) no escopo`,
      calculation: `CNPJ ${contract.supplier.cnpj} · ${first.startDate} ≤ assinatura (${contract.signatureDate}) ≤ ${first.endDate} · abrangência=${first.scope} · efeito=impedimento`,
      sha256: computeEvidenceDigest(primaryDoc?.sha256, {
        rule: 'BR-SANC-001',
        contractId: contract.id,
        sanctionId: first.id,
        cnpj: contract.supplier.cnpj,
        startDate: first.startDate,
        endDate: first.endDate,
      }),
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      ...meta,
      code: 'BR-SANC-001',
      ruleVersion: '2.2.0',
      legalRulesetVersion: rulesetVersion,
      framework: 'Integridade / Sanções',
      state: 'CONFIRMED_DATA',
      evidenceLevel: 'A',
      confidence: 0.98,
      title: 'Fornecedor com impedimento vigente na data da assinatura',
      severity: 'CRÍTICA',
      weightPoints: 30,
      summary: `${effectiveImpediments.length} registro(s) de impedimento de licitar/contratar vigente(s) em ${formatDateBR(contract.signatureDate)} com abrangência aplicável (${effectiveImpediments.map((s) => `${s.registry}/${s.scope}`).join(', ')}).`,
      notAConclusion: 'Verificar eventual efeito suspensivo judicial ou liminar vigente não refletida no cadastro administrativo.',
      alternativeHypotheses: [
        'Decisão judicial liminar suspendendo os efeitos da penalidade na data da contratação.',
        'Divergência de abrangência federativa quando a sanção limita-se ao ente sancionador.',
      ],
      dataUsed: `CNPJ ${contract.supplier.cnpj} · Assinatura ${formatDateBR(contract.signatureDate)} · ${effectiveImpediments.map((s) => `${s.registry} (${s.scope})`).join(', ')}`,
      source: effectiveImpediments.map((s) => s.sourceSystem).join(' / '),
      calculation: `Identidade (CNPJ) + vigência (${first.startDate}..${first.endDate}) + abrangência (${first.scope}) + efeito jurídico (impedimento) verificados simultaneamente.`,
      legalReference: 'Lei nº 14.133/2021, art. 14, III e art. 156',
      evidenceIds: [evId],
    });
  } else {
    if (ambiguousSanctions.length > 0) {
      nonApplicableChecks.push({
        code: 'BR-SANC-001',
        title: 'Sanção vigente com abrangência incompleta no cadastro',
        state: 'NOT_VERIFIABLE',
        rationale: `Há ${ambiguousSanctions.length} sanção(ões) vigente(s) em ${formatDateBR(contract.signatureDate)}, porém sem UF de abrangência estadual ou órgão sancionador especificado — impossível confirmar impedimento aplicável ao ente contratante sem diligência.`,
      });
    }
    if (fineOnlySanctions.length > 0) {
      nonApplicableChecks.push({
        code: 'BR-SANC-CNEP-MULTA',
        title: 'Sanção pecuniária (CNEP/Multa) sem impedimento de contratar',
        state: 'NOT_APPLICABLE',
        rationale: `${fineOnlySanctions.length} registro(s) administrativo(s) (${fineOnlySanctions.map((s) => `${s.registry}: ${s.reason}`).join('; ')}) correspondem a sanção pecuniária/publicação extraordinária (Lei 12.846/2013, art. 6º) sem efeito jurídico de proibição de contratar.`,
      });
    }
    if (unknownEffectSanctions.length > 0) {
      nonApplicableChecks.push({
        code: 'BR-SANC-001',
        title: 'Sanção administrativa com efeito jurídico não especificado',
        state: 'NOT_VERIFIABLE',
        rationale: `${unknownEffectSanctions.length} registro(s) em ${unknownEffectSanctions.map((s) => s.registry).join(', ')} não informam se houve imposição de impedimento de licitar/contratar ou apenas penalidade pecuniária; necessária consulta ao inteiro teor da decisão sancionadora.`,
      });
    }
    if (
      contract.supplier.sanctions.length > 0 &&
      ambiguousSanctions.length === 0 &&
      fineOnlySanctions.length === 0 &&
      unknownEffectSanctions.length === 0
    ) {
      nonApplicableChecks.push({
        code: 'BR-SANC-001',
        title: 'Sanção histórica fora de vigência ou fora de abrangência',
        state: 'NOT_APPLICABLE',
        rationale: contract.signatureDate
          ? `Registro(s) em ${contract.supplier.sanctions.map((s) => s.registry).join(', ')} não estavam vigentes em ${formatDateBR(contract.signatureDate)} ou restringem-se a outro órgão sancionador.`
          : 'Data de assinatura ausente; impossível verificar vigência temporal da sanção.',
      });
    }
  }

  // 2. BR-PRICE-001: Price deviation above reference strictly on COMPARABLE items (A04/R4)
  if (priceAnalysis.totalItemCount > 0 && priceAnalysis.comparableItemCount === 0) {
    nonApplicableChecks.push({
      code: 'BR-PRICE-001',
      title: 'Comparação ponderada com referências de preços',
      state: 'NOT_VERIFIABLE',
      rationale: `Nenhum dos ${priceAnalysis.totalItemCount} item(ns) possui preço de referência oficial informado (todos marcados como Sem Referência ou valor de referência zerado).`,
    });
  } else if (priceAnalysis.comparableItemCount > 0 && priceAnalysis.comparableItemCount < priceAnalysis.totalItemCount) {
    nonApplicableChecks.push({
      code: 'BR-PRICE-COVERAGE',
      title: 'Cobertura parcial de referências de preços',
      state: 'INSUFFICIENT_EVIDENCE',
      rationale: `Referência oficial disponível apenas para ${priceAnalysis.comparableItemCount} de ${priceAnalysis.totalItemCount} itens (${priceAnalysis.comparableValueSharePct.toFixed(1)}% do valor contratado; ${formatCurrencyBRL(priceAnalysis.unreferencedContractedTotal)} sem referência excluído do cálculo de desvio).`,
    });
  }

  if (priceAnalysis.comparableItemCount > 0 && priceAnalysis.deviationPct >= 15) {
    const roundedDev = Math.round(priceAnalysis.deviationPct);
    const isCritical = priceAnalysis.deviationPct >= 40;
    const refSources = priceAnalysis.comparableSources.join(' / ');
    const meta = makeFindingMeta('BR-PRICE-001', 'weighted_comparable_items', {
      deviationPct: priceAnalysis.deviationPct,
      comparableContractedTotal: priceAnalysis.contractedTotal,
      comparableReferenceTotal: priceAnalysis.referenceTotal,
      comparableItemCount: priceAnalysis.comparableItemCount,
    });

    const evId = pushEvidence({
      indicatorCode: 'BR-PRICE-001',
      ruleVersion: '2.1.0',
      sourceSystem: refSources || 'Painel de Preços',
      documentId: primaryDoc?.id ?? 'PLANILHA-ITENS',
      documentTitle: primaryDoc?.title ?? 'Planilha Orçamentária do Contrato',
      pageNumber: primaryDoc?.pages.find((p) => p.highlights.some((h) => h.field === 'valor'))?.pageNumber ?? 1,
      excerpt: priceAnalysis.highestItem
        ? `Item comparável "${priceAnalysis.highestItem.description}": contratado a ${formatCurrencyBRL(priceAnalysis.highestItem.unitPrice)} vs referência ${formatCurrencyBRL(priceAnalysis.highestItem.referencePrice)} (${priceAnalysis.highestItem.referenceSource}). Cobertura: ${priceAnalysis.comparableItemCount}/${priceAnalysis.totalItemCount} itens (${priceAnalysis.comparableValueSharePct.toFixed(1)}% do valor).`
        : `Total contratado dos itens comparáveis ${formatCurrencyBRL(priceAnalysis.contractedTotal)} vs referência ${formatCurrencyBRL(priceAnalysis.referenceTotal)}.`,
      normalizedValue: `+${priceAnalysis.deviationPct.toFixed(2)}% (cobertura ${priceAnalysis.comparableValueSharePct.toFixed(1)}%)`,
      calculation: `((${priceAnalysis.contractedTotal.toFixed(2)} − ${priceAnalysis.referenceTotal.toFixed(2)}) ÷ ${priceAnalysis.referenceTotal.toFixed(2)}) × 100 = +${priceAnalysis.deviationPct.toFixed(2)}% (estritamente sobre ${priceAnalysis.comparableItemCount}/${priceAnalysis.totalItemCount} itens com referência)`,
      sha256: computeEvidenceDigest(primaryDoc?.sha256, {
        rule: 'BR-PRICE-001',
        contractId: contract.id,
        comparableContractedTotal: priceAnalysis.contractedTotal,
        comparableReferenceTotal: priceAnalysis.referenceTotal,
      }),
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      ...meta,
      code: 'BR-PRICE-001',
      ruleVersion: '2.1.0',
      legalRulesetVersion: rulesetVersion,
      framework: 'Estatístico (Mediana/MAD)',
      state: 'OBSERVATION',
      evidenceLevel: 'B',
      confidence: Number((0.6 + 0.3 * (priceAnalysis.comparableValueSharePct / 100)).toFixed(2)),
      title: `Preço ${roundedDev}% acima referência`,
      severity: isCritical ? 'CRÍTICA' : 'ALTA',
      weightPoints: isCritical ? 26 : 22,
      summary: `Nos ${priceAnalysis.comparableItemCount} de ${priceAnalysis.totalItemCount} item(ns) com referência oficial (${priceAnalysis.comparableValueSharePct.toFixed(1)}% do valor), o desvio ponderado é de ${formatPercentageBR(priceAnalysis.deviationPct, true)} frente às referências (${refSources}).`,
      notAConclusion: 'Não constitui prova de sobrepreço ou fraude; diferenças de especificação técnica, logística ou prazo podem justificar parte da variação.',
      alternativeHypotheses: [
        'Exigência de entrega fracionada de urgência ou logística regional diferenciada.',
        'Especificação técnica superior no Termo de Referência em relação ao item genérico do banco de preços.',
      ],
      dataUsed: `${priceAnalysis.comparableItemCount}/${priceAnalysis.totalItemCount} itens comparáveis (${formatCurrencyBRL(priceAnalysis.contractedTotal)}) vs referência (${formatCurrencyBRL(priceAnalysis.referenceTotal)})`,
      source: `${refSources} × PNCP`,
      calculation: `(Contratado Comparável − Referência Comparável) ÷ Referência Comparável = +${priceAnalysis.deviationPct.toFixed(2)}%`,
      legalReference: 'Lei nº 14.133/2021, art. 23 (pesquisa de preços)',
      evidenceIds: [evId],
    });
  }

  // 2b. BENCH_HORIZONTAL_SUPPLIER_V1: Median/MAD Horizontal Benchmark across comparable peers (A04/R6: includes MAD=0!)
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
      (horizontalBenchmark.robustZ !== null || horizontalBenchmark.madZero)
    ) {
      const isHigh =
        horizontalBenchmark.peerRatio >= 2.0 &&
        (horizontalBenchmark.madZero ? true : Math.abs(horizontalBenchmark.robustZ ?? 0) >= 3.0) &&
        horizontalBenchmark.peerCount >= 8;
      const alreadyHasPrice = indicators.some((i) => i.code === 'BR-PRICE-001');
      const zDisplay = horizontalBenchmark.madZero
        ? 'MAD=0 (z indefinido)'
        : `z=${(horizontalBenchmark.robustZ ?? 0).toFixed(2)}`;
      const meta = makeFindingMeta(horizontalBenchmark.ruleId, horizontalBenchmark.serviceClass, {
        peerRatio: horizontalBenchmark.peerRatio,
        robustZ: horizontalBenchmark.robustZ,
        madZero: horizontalBenchmark.madZero,
        peerCount: horizontalBenchmark.peerCount,
        inflationApplied: horizontalBenchmark.inflationApplied,
      });

      const evId = pushEvidence({
        indicatorCode: horizontalBenchmark.ruleId,
        ruleVersion: '1.1.0',
        sourceSystem: 'Espelho PNCP Local (Peers Comparáveis)',
        documentId: primaryDoc?.id ?? 'BENCH-PEERS',
        documentTitle: `Grupo Comparável — ${horizontalBenchmark.serviceClass}`,
        pageNumber: 1,
        excerpt: `${horizontalBenchmark.statement} Mediana peers = ${formatCurrencyBRL(horizontalBenchmark.peerMedian ?? 0)}/${horizontalBenchmark.unitLabel}; MAD = ${formatCurrencyBRL(horizontalBenchmark.mad ?? 0)}.`,
        normalizedValue: `${horizontalBenchmark.peerRatio.toFixed(2)}× mediana (${zDisplay})`,
        calculation: horizontalBenchmark.madZero
          ? `Razão = ${horizontalBenchmark.subjectAdjustedPrice.toFixed(2)} ÷ ${(horizontalBenchmark.peerMedian ?? 0).toFixed(2)} = ${horizontalBenchmark.peerRatio.toFixed(2)}× · MAD = 0 (todos os ${horizontalBenchmark.peerCount} peers idênticos; z robusto indefinido)`
          : `z_robusto = 0,6745 × (${horizontalBenchmark.subjectAdjustedPrice.toFixed(2)} − ${(horizontalBenchmark.peerMedian ?? 0).toFixed(2)}) ÷ ${(horizontalBenchmark.mad ?? 0).toFixed(2)} = ${(horizontalBenchmark.robustZ ?? 0).toFixed(2)} · n=${horizontalBenchmark.peerCount}`,
        sha256: computeEvidenceDigest(primaryDoc?.sha256, {
          rule: horizontalBenchmark.ruleId,
          contractId: contract.id,
          peerMedian: horizontalBenchmark.peerMedian,
          peerRatio: horizontalBenchmark.peerRatio,
          peerCount: horizontalBenchmark.peerCount,
        }),
        retrievedAt: evaluatedAt,
      });

      indicators.push({
        ...meta,
        code: horizontalBenchmark.ruleId,
        ruleVersion: '1.1.0',
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
        dataUsed: `n = ${horizontalBenchmark.peerCount} peers elegíveis (${horizontalBenchmark.excludedPeerCount} excluídos) · Unidade: ${horizontalBenchmark.unitLabel} · Base: ${horizontalBenchmark.inflationIndexApplied}`,
        source: `Espelho PNCP (${horizontalBenchmark.inflationIndexApplied})`,
        calculation: `Razão = ${horizontalBenchmark.subjectAdjustedPrice.toFixed(2)} ÷ ${(horizontalBenchmark.peerMedian ?? 1).toFixed(2)} = ${horizontalBenchmark.peerRatio.toFixed(2)}× · ${zDisplay}`,
        evidenceIds: [evId],
      });
    }
  }

  // 3. COMP-001: Single bidder / low competition (A02: null/unknown biddersCount -> NOT_VERIFIABLE)
  if (contract.biddersCount === null || contract.biddersCount === undefined || contract.biddersCount <= 0) {
    nonApplicableChecks.push({
      code: 'COMP-001',
      title: 'Competitividade do certame (número de proponentes)',
      state: 'NOT_VERIFIABLE',
      rationale: 'Número de proponentes/licitantes não foi informado pela fonte de origem; motor recusa assumir competição baixa ou adequada por estimativa.',
    });
  } else if (contract.biddersCount === 1) {
    const meta = makeFindingMeta('COMP-001', 'bidders_count', {
      biddersCount: contract.biddersCount,
      modality: contract.modality,
    });
    const evId = pushEvidence({
      indicatorCode: 'COMP-001',
      ruleVersion: '2.1.0',
      sourceSystem: 'PNCP / Ata do Certame',
      documentId: editalDoc?.id ?? primaryDoc?.id ?? 'ATA-CERTAME',
      documentTitle: editalDoc?.title ?? 'Ata de Realização da Licitação',
      pageNumber: 1,
      excerpt: `Modalidade: ${contract.modality}. Número de proponentes habilitados registrados no certame: ${contract.biddersCount}.`,
      normalizedValue: `${contract.biddersCount} participante`,
      calculation: `numberOfTenderers == ${contract.biddersCount} (limiar de baixa competição == 1)`,
      sha256: computeEvidenceDigest(editalDoc?.sha256 ?? primaryDoc?.sha256, {
        rule: 'COMP-001',
        contractId: contract.id,
        biddersCount: contract.biddersCount,
      }),
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      ...meta,
      code: 'COMP-001',
      ruleVersion: '2.1.0',
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
      calculation: `Sinal de concentração competitiva acionado quando proponentes == 1.`,
      legalReference: 'Lei nº 14.133/2021, art. 5º e art. 11 (competitividade)',
      evidenceIds: [evId],
    });
  }

  // 4. BR-ADIT-001: Excessive or rapid contract amendments
  if (contract.amendments.length >= 2 || amendmentTotalPct > 25 || variationPct > 25) {
    const sortedDates = contract.amendments.map((a) => a.date).filter(Boolean).sort();
    const spanMonths =
      contract.signatureDate && (sortedDates.length > 0 || contract.endDate)
        ? monthsBetween(contract.signatureDate, sortedDates[sortedDates.length - 1] ?? contract.endDate)
        : 1;
    const exceedsCap = variationPct > 25 || amendmentTotalPct > 25;
    const effectivePct = Math.max(variationPct, amendmentTotalPct);
    const meta = makeFindingMeta('BR-ADIT-001', 'amendments_total', {
      amendmentCount: contract.amendments.length,
      effectivePct,
      originalValue: contract.originalValue,
      updatedValue: contract.updatedValue,
    });

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
      sha256: computeEvidenceDigest(amendmentDoc?.sha256 ?? primaryDoc?.sha256, {
        rule: 'BR-ADIT-001',
        contractId: contract.id,
        amendments: contract.amendments.map((a) => ({ id: a.id, addedValue: a.addedValue })),
      }),
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      ...meta,
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

  // 5. BR-CNAE-001: Object vs Supplier CNAE compatibility (signal only, never fires if CNAE is unknown/empty)
  if (contract.expectedCnaePrefixes.length > 0 && contract.supplier.primaryCnaeCode?.trim() && contract.supplier.primaryCnaeCode !== 'Não consultado') {
    const supplierCnaes = [
      contract.supplier.primaryCnaeCode,
      ...contract.supplier.secondaryCnaes.map((c) => c.code),
    ].filter(Boolean);
    const hasMatch = supplierCnaes.some((code) =>
      contract.expectedCnaePrefixes.some((prefix) => code.replace(/\D/g, '').startsWith(prefix.replace(/\D/g, '')))
    );

    if (!hasMatch) {
      const meta = makeFindingMeta('BR-CNAE-001', contract.supplier.primaryCnaeCode, {
        supplierCnaes,
        expectedCnaePrefixes: contract.expectedCnaePrefixes,
      });
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
        sha256: computeEvidenceDigest(primaryDoc?.sha256, {
          rule: 'BR-CNAE-001',
          contractId: contract.id,
          supplierCnaes,
        }),
        retrievedAt: evaluatedAt,
      });

      indicators.push({
        ...meta,
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

  // 6. BR-RECEM-001: Newly opened company awarded high-value contract (only when openingDate & signatureDate exist)
  const companyAgeDays = daysBetween(contract.supplier.openingDate, contract.signatureDate);
  if (Number.isFinite(companyAgeDays) && companyAgeDays >= 0 && companyAgeDays < 180 && contract.originalValue >= 300_000) {
    const meta = makeFindingMeta('BR-RECEM-001', contract.supplier.cnpj, {
      openingDate: contract.supplier.openingDate,
      signatureDate: contract.signatureDate,
      originalValue: contract.originalValue,
    });
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
      sha256: computeEvidenceDigest(primaryDoc?.sha256, {
        rule: 'BR-RECEM-001',
        contractId: contract.id,
        openingDate: contract.supplier.openingDate,
        signatureDate: contract.signatureDate,
      }),
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      ...meta,
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

  // 7. BR-CONFLICT-001: Potential conflict of interest (STF Tema 1001)
  const overlappingShareholders = contract.supplier.shareholders.filter((s) => s.isPublicServantOverlap);
  if (overlappingShareholders.length > 0) {
    const sh = overlappingShareholders[0];
    const meta = makeFindingMeta('BR-CONFLICT-001', sh.maskedCpfCnpj || sh.name, {
      shareholders: overlappingShareholders.map((s) => s.name),
    });
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
      sha256: computeEvidenceDigest(primaryDoc?.sha256, {
        rule: 'BR-CONFLICT-001',
        contractId: contract.id,
        shareholder: sh.name,
      }),
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      ...meta,
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

  // 8. BR-FRAC-001: Temporal contract splitting
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
        const meta = makeFindingMeta('BR-FRAC-001', `${contract.entityId}:${contract.year}`, {
          accumulatedTotal,
          temporalLimit,
          relatedCount,
          rulesetVersion,
        });
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
          sha256: computeEvidenceDigest(primaryDoc?.sha256, {
            rule: 'BR-FRAC-001',
            contractId: contract.id,
            accumulatedTotal,
            temporalLimit,
          }),
          retrievedAt: evaluatedAt,
        });

        indicators.push({
          ...meta,
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
            'Contratações pertencem a unidades gestoras distintas com autonomia orçamentária própria.',
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

  // 9. BR-RISKMAT-001: Conditional Risk Matrix check
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
    const meta = makeFindingMeta('BR-RISKMAT-001', contract.executionRegime ?? 'grande_vulto', {
      executionRegime: contract.executionRegime,
      updatedValue: contract.updatedValue,
      riskMatrixPresent: false,
    });
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
      sha256: computeEvidenceDigest(editalDoc?.sha256 ?? primaryDoc?.sha256, {
        rule: 'BR-RISKMAT-001',
        contractId: contract.id,
        executionRegime: contract.executionRegime,
      }),
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      ...meta,
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

  // Seguro-garantia (art. 99/102) is permissive — explicitly recorded as NOT_APPLICABLE
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
    const brokenRef = broken.documentNumber?.trim() || broken.id;
    const meta = makeFindingMeta('BR-PAYORD-001', brokenRef, {
      paymentId: broken.id,
      documentNumber: broken.documentNumber,
      amount: broken.amount,
      fundingSource: broken.fundingSource,
    });
    const evId = pushEvidence({
      indicatorCode: 'BR-PAYORD-001',
      ruleVersion: '1.1.0',
      sourceSystem: broken.sourceSystem,
      documentId: primaryDoc?.id ?? `EXEC-FIN-${broken.id}`,
      documentTitle: `Pagamento ${brokenRef}`,
      pageNumber: 1,
      excerpt: `Pagamento ${brokenRef} (${formatCurrencyBRL(broken.amount)}, fonte ${broken.fundingSource ?? 'Não informada'}) liquidado fora da ordem cronológica sem justificativa publicada verificável.`,
      normalizedValue: 'unexplained_break',
      calculation: `paidOutOfOrder=true ∧ justificationPublished=${Boolean(broken.justificationPublished)}`,
      sha256: computeEvidenceDigest(primaryDoc?.sha256, {
        rule: 'BR-PAYORD-001',
        contractId: contract.id,
        paymentId: broken.id,
      }),
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      ...meta,
      code: 'BR-PAYORD-001',
      ruleVersion: '1.1.0',
      legalRulesetVersion: rulesetVersion,
      framework: 'Execução Financeira',
      state: 'OBSERVATION',
      evidenceLevel: 'B',
      confidence: 0.87,
      title: 'Quebra da ordem cronológica sem justificativa verificável',
      severity: 'ALTA',
      weightPoints: 14,
      summary: `Pagamento ${brokenRef} ocorreu fora da ordem cronológica da fonte de recursos sem publicação da justificativa exigida pelo art. 141, § 1º.`,
      notAConclusion: 'A alteração da ordem cronológica é admitida em hipóteses legais (grave perturbação, calamidade, pequeno valor) mediante justificativa publicada.',
      alternativeHypotheses: [
        'Justificativa formal publicada em Diário Oficial local ainda não ingerido no repositório.',
        'Recursos oriundos de fonte diferenciada ou convênio federal específico.',
      ],
      dataUsed: `Doc ${brokenRef} · Fonte: ${broken.fundingSource ?? 'Não informada'} · Justificativa publicada: Não`,
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
    const meta = makeFindingMeta('BR-DIVERG-001', 'execution_over_obligation', {
      totalOutflow,
      updatedValue: contract.updatedValue,
    });
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
      sha256: computeEvidenceDigest(primaryDoc?.sha256, {
        rule: 'BR-DIVERG-001',
        contractId: contract.id,
        totalOutflow,
        updatedValue: contract.updatedValue,
      }),
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      ...meta,
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
    const meta = makeFindingMeta('BR-DIVERG-002', highDiv.field, {
      sources: highDiv.sources,
    });
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
      sha256: computeEvidenceDigest(primaryDoc?.sha256, {
        rule: 'BR-DIVERG-002',
        contractId: contract.id,
        sources: highDiv.sources,
      }),
      retrievedAt: evaluatedAt,
    });

    indicators.push({
      ...meta,
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

  // 11b. BR-TRANSP-001 (A03): ONLY assert "não localizado no PNCP" when an explicit completed PNCP query
  // actually ran and returned no match! Never fabricate PNCP absence from an unqueried PDF or local row.
  const hasPncpSource = contract.sourceRecords.some((s) => s.sourceSystem === 'PNCP');
  const pncpExplicitNoMatch =
    contract.pncpVerification?.queried === true &&
    contract.pncpVerification.status === 'completed_no_match';

  if (!hasPncpSource && pncpExplicitNoMatch && contract.originalValue === 0 && contract.updatedValue === 0) {
    const meta = makeFindingMeta('BR-TRANSP-001', 'pncp_no_match_no_value', {
      pncpQuery: contract.pncpVerification?.querySummary ?? contract.contractNumber,
      queriedAt: contract.pncpVerification?.queriedAt ?? null,
    });
    const evId = pushEvidence({
      indicatorCode: 'BR-TRANSP-001',
      ruleVersion: '2.0.0',
      sourceSystem: contract.sourceRecords[0]?.sourceSystem ?? 'Consulta PNCP Verificada',
      documentId: primaryDoc?.id ?? `PNCP-QUERY-${contract.id}`,
      documentTitle: primaryDoc?.title ?? 'Registro de Consulta PNCP sem Correspondência',
      pageNumber: 1,
      excerpt: `Consulta executada na API do PNCP em ${contract.pncpVerification?.queriedAt ?? evaluatedAt} (${contract.pncpVerification?.querySummary ?? contract.contractNumber}) sem correspondência, e valor global não informado na origem.`,
      normalizedValue: 'pncp_verificado_sem_correspondencia',
      calculation: `pncpVerification.status=completed_no_match ∧ originalValue=0 ∧ updatedValue=0`,
      sha256: computeEvidenceDigest(primaryDoc?.sha256, {
        rule: 'BR-TRANSP-001',
        contractId: contract.id,
        pncpVerification: contract.pncpVerification,
      }),
      retrievedAt: contract.pncpVerification?.queriedAt ?? evaluatedAt,
    });

    indicators.push({
      ...meta,
      code: 'BR-TRANSP-001',
      ruleVersion: '2.0.0',
      legalRulesetVersion: rulesetVersion,
      framework: 'Regra Jurídica Temporal',
      state: 'OBSERVATION',
      evidenceLevel: 'B',
      confidence: 0.85,
      title: 'Sem correspondência na consulta PNCP e valor não divulgado',
      severity: 'MÉDIA',
      weightPoints: 10,
      summary: `Após consulta verificada à API do PNCP (${contract.pncpVerification?.querySummary ?? contract.contractNumber}), não houve correspondência para o contrato ${contract.contractNumber} e o valor global não consta na fonte local.`,
      notAConclusion: 'A ausência de retorno na consulta PNCP pode decorrer de atraso na integração, exceção legal de município < 20 mil habitantes (art. 176) ou publicação sob outro identificador.',
      alternativeHypotheses: [
        'Integração entre o portal local e o PNCP ainda não transmitiu o termo.',
        'Valor global consta apenas no extrato do Diário Oficial ou nas notas de empenho no TCM/TCE estadual.',
      ],
      dataUsed: `Contrato ${contract.contractNumber} · Consulta PNCP: ${contract.pncpVerification?.querySummary ?? 'concluída sem retorno'} · Valor: não informado`,
      source: 'Consulta PNCP Verificada × Fonte Local',
      calculation: `pncpVerification.status == completed_no_match ∧ disclosedValue == 0`,
      legalReference: 'Lei nº 14.133/2021, art. 94 e art. 174 (divulgação no PNCP)',
      evidenceIds: [evId],
    });
  } else if (!hasPncpSource && contract.originalValue === 0 && contract.updatedValue === 0) {
    nonApplicableChecks.push({
      code: 'BR-TRANSP-001',
      title: 'Verificação de publicação no PNCP e valor global',
      state: 'NOT_VERIFIABLE',
      rationale:
        'Valor global não extraído/informado e consulta de verificação ao PNCP não foi executada para este registro. O motor recusa afirmar ausência no PNCP sem consulta efetiva registrada.',
    });
  }

  // 12. BR-EFIC-001: Spend vs Output efficiency
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
        const meta = makeFindingMeta('BR-EFIC-001', prod.domain, {
          actualUnitCost: prod.actualUnitCost,
          benchmarkUnitCost: prod.benchmarkUnitCost,
          physicalGap,
        });
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
          sha256: computeEvidenceDigest(primaryDoc?.sha256, {
            rule: 'BR-EFIC-001',
            contractId: contract.id,
            domain: prod.domain,
            actualUnitCost: prod.actualUnitCost,
          }),
          retrievedAt: evaluatedAt,
        });

        indicators.push({
          ...meta,
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

  // Sort indicators by severity order then weight (findingId is ALREADY deterministic & order-independent!)
  const severityRank: Record<RiskIndicator['severity'], number> = {
    CRÍTICA: 0,
    ALTA: 1,
    MÉDIA: 2,
    BAIXA: 3,
  };
  indicators.sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      b.weightPoints - a.weightPoints ||
      a.findingId.localeCompare(b.findingId)
  );

  const rawScore = indicators.reduce((sum, ind) => sum + ind.weightPoints, 0);
  const score = Math.min(100, Math.max(0, rawScore));

  // Declared evidentiary coverage (A02):
  // - INSUFFICIENT: no sources/docs, OR neither monetary data nor items/payments/documents to verify core tracks
  // - PARTIAL: has base record + monetary value, but lacks essential verification tracks (docs, items/bench, payments, or signatureDate)
  // - ADEQUATE: has sources/docs + monetary data + at least one deep track (items/bench or payments) + valid signature date
  const hasSources = contract.sourceRecords.length > 0;
  const hasDocs = contract.documents.length > 0;
  const hasMonetaryData = contract.originalValue > 0 || contract.updatedValue > 0;
  const hasItemsOrBench = priceAnalysis.comparableItemCount > 0 || Boolean(contract.benchmarkPeers);
  const hasPayments = contract.payments.length > 0;
  const hasValidDate = legalResolution.status === 'resolved';

  let coverageStatus: NonNullable<RiskAssessment['coverageStatus']> = 'ADEQUATE';
  if ((!hasSources && !hasDocs) || (!hasMonetaryData && !hasItemsOrBench && !hasPayments)) {
    coverageStatus = 'INSUFFICIENT';
  } else if (!hasMonetaryData || (!hasItemsOrBench && !hasPayments) || !hasValidDate) {
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
    headline = `COBERTURA INSUFICIENTE — dados insuficientes para triagem (${score}/100)`;
  } else if (coverageStatus === 'PARTIAL') {
    classification = 'Cobertura parcial — sem indícios nos itens verificados';
    headline = `COBERTURA PARCIAL — sem indícios nos itens verificados (${score}/100)`;
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
    priceReferenceCoverage:
      priceAnalysis.totalItemCount > 0
        ? {
            comparableItemCount: priceAnalysis.comparableItemCount,
            totalItemCount: priceAnalysis.totalItemCount,
            comparableContractedTotal: priceAnalysis.contractedTotal,
            unreferencedContractedTotal: priceAnalysis.unreferencedContractedTotal,
            comparableValueSharePct: priceAnalysis.comparableValueSharePct,
          }
        : undefined,
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

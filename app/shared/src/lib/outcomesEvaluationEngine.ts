import crypto from 'node:crypto';
import { parseBrazilianNumber, parseCsvTable } from './csvParser';
import { validateCompetencia, validateIsoDate } from './competenciaValidator';

export type IndicatorPeriodicity =
  | 'mensal'
  | 'bimestral'
  | 'quadrimestral'
  | 'semestral'
  | 'anual'
  | 'bienal';

export type ImprovementDirection = 'higher_is_better' | 'lower_is_better';

export interface IndicatorDefinition {
  indicatorId: string;
  name: string;
  domain: 'saude' | 'educacao' | 'financas_publicas' | 'infraestrutura' | 'outro';
  sourceSystem: string;
  methodologyVersion: string;
  unit: string;
  population: string;
  territoryCode: string;
  periodicity: IndicatorPeriodicity;
  improvementDirection: ImprovementDirection;
}

export interface IndicatorObservation {
  observationId: string;
  indicatorId: string;
  methodologyVersion: string;
  territoryCode: string;
  /** Competência format: YYYY-MM, YYYY-Q1..Q3 (quadrimestre), YYYY-S1..S2, or YYYY */
  competencia: string;
  /** End date (YYYY-MM-DD) of the observed competência window */
  periodEndDate: string;
  publishedAt: string | null;
  collectedAt: string;
  revision: string;
  numerator: number | null;
  denominator: number | null;
  /** MUST stay null when unpublished — NEVER coerced to 0 */
  value: number | null;
  isPublished: boolean;
  sourceFileSha256?: string;
}

export interface OutcomeClaim {
  claimId: string;
  contractId: string;
  sourceExcerptRef: string;
  promisedDeliverableOrOutcome: string;
  indicatorId: string;
  expectedMethodologyVersion: string;
  unit: string;
  population: string;
  territoryCode: string;
  baselineValue: number | null;
  baselineCompetencia: string;
  targetValue: number | null;
  targetDeadlineDate: string;
  contractSignatureDate: string;
  effectiveServiceStartDate: string | null;
  improvementDirection: ImprovementDirection;
  sourceSystem: string;
  evidenceRefs: string[];
  /** Dimension A: validated physical/operational deliveries */
  validatedDeliveriesCount?: number | null;
  promisedDeliveriesCount?: number | null;
  /** Paid amount linked exclusively to validated deliveries */
  validatedPaymentsAmount?: number | null;
}

export interface DidDesignInput {
  comparisonGroupJustification: string | null;
  prePeriodTreatedCount: number;
  prePeriodControlCount: number;
  postPeriodTreatedCount: number;
  postPeriodControlCount: number;
  preTrendsTested: boolean;
  preTrendsParallel: boolean | null;
  explicitAssumptions: string[];
  uncertaintyReported: boolean;
  /** Synthetic control is a distinct method; never simulate it with a simple neighbor average */
  requestedMethod?: 'descriptive' | 'did' | 'synthetic_control';
  usesSimpleNeighborAverageAsSyntheticControl?: boolean;
}

export type EvaluationRunStatus =
  | 'CONCLUIDA_DESCRITIVA'
  | 'AVALIACAO_INTERINA'
  | 'NAO_PUBLICADO'
  | 'METODOLOGIA_ALTERADA'
  | 'DADOS_INSUFICIENTES';

export interface EvaluationRun {
  runId: string;
  claimId: string;
  contractId: string;
  evaluatedAt: string;
  status: EvaluationRunStatus;
  isInterimEvaluation: boolean;
  latestPublishedCompetencia: string | null;
  effectiveInterventionStartDate: string;
  /** Strict 4-track separation required by investigative governance */
  dimensions: {
    /** A. Entrega física/operacional do serviço */
    A_serviceDelivery: {
      status: 'ENTREGUE_NO_ESCOPO' | 'ENTREGA_PARCIAL' | 'NAO_COMPROVADA';
      validatedDeliveries: number | null;
      promisedDeliveries: number | null;
      deliveryRatePct: number | null;
      note: string;
    };
    /** B. Cumprimento de metas no indicador */
    B_targetAttainment: {
      status:
        | 'META_ATINGIDA_OBSERVADA'
        | 'MELHORA_PARCIAL_OBSERVADA'
        | 'SEM_MELHORA_OBSERVADA'
        | 'NAO_PUBLICADO'
        | 'METODOLOGIA_INCOMPATIVEL'
        | 'AVALIACAO_INTERINA';
      baselineValue: number | null;
      latestObservedValue: number | null;
      targetValue: number | null;
      absoluteDelta: number | null;
      improvedDirectionally: boolean | null;
      note: string;
    };
    /** C. Efeito atribuível causal */
    C_attributableEffect: {
      status:
        | 'MELHORA_OBSERVADA_SEM_ATRIBUICAO_CAUSAL'
        | 'DID_ELEGIVEL_REQUER_ESTIMACAO_FORMAL'
        | 'CONTROLE_SINTETICO_NAO_SIMULAVEL'
        | 'SEM_ATRIBUICAO_CAUSAL';
      causalAttributionClaimed: false;
      didValidation?: {
        eligible: boolean;
        blockingReasons: string[];
      };
      note: string;
    };
    /** D. Custo por entrega validada */
    D_costPerValidatedDelivery: {
      computable: boolean;
      validatedPaymentsAmount: number | null;
      validatedDeliveriesCount: number | null;
      costPerUnit: number | null;
      note: string;
    };
  };
  /** Never classify a service as fictitious solely because an indicator did not improve */
  serviceClassifiedAsFictitious: false;
  limitations: string[];
  diligences: string[];
}

export interface SiapsImportedRow {
  territoryCode: string;
  municipalityName: string;
  indicatorId: string;
  indicatorName: string;
  methodologyVersion: string;
  competencia: string;
  periodEndDate: string;
  numerator: number | null;
  denominator: number | null;
  value: number | null;
  isPublished: boolean;
  publishedAt: string | null;
  revision: string;
}

export interface SiapsImportResult {
  sourceSystem: 'SIAPS — Exportação Pública CSV/XLSX (sem API inventada)';
  fileSha256: string;
  importedAt: string;
  filename: string;
  rowCount: number;
  unpublishedCount: number;
  observations: IndicatorObservation[];
  warnings: string[];
}

export interface SiconfiStageRecord {
  exercicio: number;
  periodo: string;
  conta: string;
  estagio: 'empenho' | 'liquidacao' | 'pagamento';
  valor: number;
  isRetificacao: boolean;
  isSaldoAcumulado: boolean;
  dataPublicacao?: string;
}

export interface SiconfiReconciliationResult {
  exercicio: number;
  conta: string;
  /** Strictly separated by execution stage — NEVER summed across empenho + liquidacao + pagamento */
  byStage: {
    empenho: number | null;
    liquidacao: number | null;
    pagamento: number | null;
  };
  sumAcrossStagesProhibited: true;
  rectificationsDetected: number;
  cumulativeBalanceDetected: boolean;
  latestPeriodUsed: string | null;
  warnings: string[];
}

function parseNumericOrNull(raw: string | undefined): number | null {
  return parseBrazilianNumber(raw);
}

export function validateDidDesign(design: DidDesignInput): {
  eligible: boolean;
  blockingReasons: string[];
} {
  const blockingReasons: string[] = [];

  if (design.requestedMethod === 'synthetic_control') {
    blockingReasons.push(
      'Controle sintético é método distinto (requer ponderação convexa otimizada de doadores e testes placebo); não pode ser simulado com média simples de municípios vizinhos.'
    );
  }
  if (design.usesSimpleNeighborAverageAsSyntheticControl) {
    blockingReasons.push(
      'Bloqueado: média simples de municípios vizinhos não constitui controle sintético.'
    );
  }
  if (!design.comparisonGroupJustification?.trim()) {
    blockingReasons.push('Grupo de comparação não justificado metodologicamente.');
  }
  if (design.prePeriodTreatedCount < 3 || design.prePeriodControlCount < 3) {
    blockingReasons.push(
      'Dados pré-intervenção insuficientes para exame de tendências paralelas (mínimo recomendado >= 3 períodos pré).'
    );
  }
  if (design.postPeriodTreatedCount < 1 || design.postPeriodControlCount < 1) {
    blockingReasons.push('Dados pós-intervenção insuficientes para tratado ou controle.');
  }
  if (!design.preTrendsTested || design.preTrendsParallel !== true) {
    blockingReasons.push(
      'Exame de pré-tendências paralelas ausente ou não corroborado.'
    );
  }
  if (design.explicitAssumptions.length === 0) {
    blockingReasons.push('Hipóteses identificadoras de Diferenças em Diferenças não explicitadas.');
  }
  if (!design.uncertaintyReported) {
    blockingReasons.push('Incerteza estatística (erro-padrão/intervalo de confiança) não declarada.');
  }

  return {
    eligible: blockingReasons.length === 0,
    blockingReasons,
  };
}

/**
 * Evaluates a contractual OutcomeClaim against published IndicatorObservations.
 * Enforces:
 *  - Methodology version compatibility (blocks automatic comparison across changed versions).
 *  - Unpublished data stays NAO_PUBLICADO (NEVER coerced to 0).
 *  - Interim evaluation when post-intervention window is incomplete (e.g. signature 2025-11-23, eval 2026-11-23).
 *  - Strict separation of A (delivery), B (target), C (attributable effect), D (cost per delivery).
 *  - Never labels a service fictitious because an indicator failed to improve.
 */
export function evaluateOutcomeClaim(params: {
  claim: OutcomeClaim;
  definition: IndicatorDefinition;
  observations: ReadonlyArray<IndicatorObservation>;
  evaluationDate: string;
  didDesign?: DidDesignInput;
}): EvaluationRun {
  const { claim, definition, evaluationDate } = params;
  const effectiveStart = claim.effectiveServiceStartDate || claim.contractSignatureDate;
  const runId = `eval_${claim.claimId}_${evaluationDate}`;
  const limitations: string[] = [
    'Ausência de melhora em indicador agregado jamais classifica automaticamente um serviço como fictício.',
    'Periodicidade oficial do indicador e defasagem de publicação condicionam o alcance da avaliação.',
  ];
  const diligences: string[] = [];

  // Dimension A: Service Delivery (independent from indicator outcome)
  const validatedDel = claim.validatedDeliveriesCount ?? null;
  const promisedDel = claim.promisedDeliveriesCount ?? null;
  const deliveryRatePct =
    validatedDel !== null && promisedDel !== null && promisedDel > 0
      ? Number(((validatedDel / promisedDel) * 100).toFixed(1))
      : null;
  const dimA: EvaluationRun['dimensions']['A_serviceDelivery'] = {
    status:
      validatedDel === null
        ? 'NAO_COMPROVADA'
        : promisedDel !== null && validatedDel >= promisedDel
          ? 'ENTREGUE_NO_ESCOPO'
          : 'ENTREGA_PARCIAL',
    validatedDeliveries: validatedDel,
    promisedDeliveries: promisedDel,
    deliveryRatePct,
    note:
      validatedDel === null
        ? 'Entregas físicas/operacionais ainda não validadas documentalmente (avaliadas separadamente dos indicadores de resultado).'
        : `Entregas validadas: ${validatedDel}${promisedDel !== null ? ` de ${promisedDel} (${deliveryRatePct}%)` : ''}.`,
  };

  // Dimension D: Cost per validated delivery
  const paid = claim.validatedPaymentsAmount ?? null;
  const costComputable = paid !== null && validatedDel !== null && validatedDel > 0;
  const dimD: EvaluationRun['dimensions']['D_costPerValidatedDelivery'] = {
    computable: costComputable,
    validatedPaymentsAmount: paid,
    validatedDeliveriesCount: validatedDel,
    costPerUnit: costComputable ? Number((paid / validatedDel).toFixed(2)) : null,
    note: costComputable
      ? `Custo observado por entrega validada: ${(paid / validatedDel).toFixed(2)} (não inclui empenhos não liquidados nem soma estágios orçamentários).`
      : 'Custo por entrega validada não computável sem pagamentos liquidados/pagos e contagem de entregas validadas > 0.',
  };

  // Filter observations for this indicator & territory
  const matchingObs = params.observations
    .filter((o) => o.indicatorId === claim.indicatorId && o.territoryCode === claim.territoryCode)
    .sort((a, b) => a.periodEndDate.localeCompare(b.periodEndDate));

  // Check for methodology version change across observations or vs expected version
  const distinctVersions = new Set(matchingObs.map((o) => o.methodologyVersion));
  const methodologyMismatch =
    definition.methodologyVersion !== claim.expectedMethodologyVersion ||
    matchingObs.some((o) => o.methodologyVersion !== claim.expectedMethodologyVersion) ||
    distinctVersions.size > 1;

  if (methodologyMismatch) {
    limitations.push(
      `Incompatibilidade metodológica detectada: esperado="${claim.expectedMethodologyVersion}", definição="${definition.methodologyVersion}", observações=[${Array.from(distinctVersions).join(', ')}]. Comparação automática bloqueada.`
    );
    diligences.push(
      'Reconstruir série histórica compatibilizada ou obter nota técnica oficial de equivalência entre versões metodológicas antes de comparar períodos.'
    );
    return {
      runId,
      claimId: claim.claimId,
      contractId: claim.contractId,
      evaluatedAt: evaluationDate,
      status: 'METODOLOGIA_ALTERADA',
      isInterimEvaluation: false,
      latestPublishedCompetencia:
        matchingObs.filter((o) => o.isPublished && o.value !== null).at(-1)?.competencia ?? null,
      effectiveInterventionStartDate: effectiveStart,
      dimensions: {
        A_serviceDelivery: dimA,
        B_targetAttainment: {
          status: 'METODOLOGIA_INCOMPATIVEL',
          baselineValue: claim.baselineValue,
          latestObservedValue: null,
          targetValue: claim.targetValue,
          absoluteDelta: null,
          improvedDirectionally: null,
          note: 'Comparação automática bloqueada por alteração de metodologia/versão do indicador entre baseline e acompanhamento.',
        },
        C_attributableEffect: {
          status: 'SEM_ATRIBUICAO_CAUSAL',
          causalAttributionClaimed: false,
          note: 'Atribuição causal bloqueada pela quebra metodológica da série.',
        },
        D_costPerValidatedDelivery: dimD,
      },
      serviceClassifiedAsFictitious: false,
      limitations,
      diligences,
    };
  }

  // Only published observations with numeric values available ON OR BEFORE evaluationDate
  // (Corte Temporal: future publications publishedAt > evaluationDate are excluded from point-in-time evaluation)
  const postCutoffPublishedObs = matchingObs.filter(
    (o) =>
      o.isPublished &&
      o.value !== null &&
      o.periodEndDate >= effectiveStart &&
      o.periodEndDate <= evaluationDate &&
      typeof o.publishedAt === 'string' &&
      o.publishedAt.trim().length >= 10 &&
      o.publishedAt.trim().slice(0, 10) > evaluationDate
  );
  if (postCutoffPublishedObs.length > 0) {
    limitations.push(
      `Corte temporal aplicado em ${evaluationDate}: ${postCutoffPublishedObs.length} observação(ões) publicada(s) posteriormente (${postCutoffPublishedObs.map((o) => `${o.competencia} pub.${o.publishedAt?.slice(0, 10)}`).join(', ')}) foram excluídas para preservar avaliação point-in-time.`
    );
  }

  const publishedPostObs = matchingObs.filter(
    (o) =>
      o.isPublished &&
      o.value !== null &&
      o.periodEndDate >= effectiveStart &&
      o.periodEndDate <= evaluationDate &&
      (!o.publishedAt || o.publishedAt.trim().slice(0, 10) <= evaluationDate)
  );
  const unpublishedPostObs = matchingObs.filter(
    (o) =>
      (!o.isPublished ||
        o.value === null ||
        (typeof o.publishedAt === 'string' && o.publishedAt.trim().slice(0, 10) > evaluationDate)) &&
      o.periodEndDate >= effectiveStart
  );

  if (publishedPostObs.length === 0) {
    limitations.push(
      `Nenhuma competência pós-início efetivo (${effectiveStart}) publicada até ${evaluationDate}. Dados não publicados permanecem como NAO_PUBLICADO (jamais convertidos em zero).`
    );
    if (unpublishedPostObs.length > 0) {
      limitations.push(
        `${unpublishedPostObs.length} competência(s) localizada(s) ainda sem valor publicado até a data de corte (${unpublishedPostObs.map((u) => u.competencia).join(', ')}).`
      );
    }
    diligences.push(
      `Aguardar publicação oficial da próxima competência (${definition.periodicity}) na fonte ${definition.sourceSystem} e reexecutar a avaliação.`
    );
    return {
      runId,
      claimId: claim.claimId,
      contractId: claim.contractId,
      evaluatedAt: evaluationDate,
      status: 'NAO_PUBLICADO',
      isInterimEvaluation: true,
      latestPublishedCompetencia:
        matchingObs.filter((o) => o.isPublished && o.value !== null).at(-1)?.competencia ?? null,
      effectiveInterventionStartDate: effectiveStart,
      dimensions: {
        A_serviceDelivery: dimA,
        B_targetAttainment: {
          status: 'NAO_PUBLICADO',
          baselineValue: claim.baselineValue,
          latestObservedValue: null,
          targetValue: claim.targetValue,
          absoluteDelta: null,
          improvedDirectionally: null,
          note: 'Indicador pós-intervenção ainda não publicado na fonte oficial (nunca convertido em zero).',
        },
        C_attributableEffect: {
          status: 'SEM_ATRIBUICAO_CAUSAL',
          causalAttributionClaimed: false,
          note: 'Sem observação publicada pós-intervenção para análise.',
        },
        D_costPerValidatedDelivery: dimD,
      },
      serviceClassifiedAsFictitious: false,
      limitations,
      diligences,
    };
  }

  const latestPublished = publishedPostObs[publishedPostObs.length - 1];
  const latestVal = latestPublished.value!;

  // Determine if evaluation window covers a full post-intervention year/deadline or is interim
  // e.g., signature 2025-11-23, evaluation 2026-11-23: annual/quadrimestral publication lags mean
  // latestPublished.periodEndDate < claim.targetDeadlineDate or < evaluationDate -> INTERIM!
  const isInterim =
    latestPublished.periodEndDate < claim.targetDeadlineDate ||
    latestPublished.periodEndDate < evaluationDate;

  if (isInterim) {
    limitations.push(
      `Avaliação INTERINA: última competência publicada (${latestPublished.competencia}, fim em ${latestPublished.periodEndDate}) não cobre integralmente o prazo/janela até ${evaluationDate} (início efetivo do serviço: ${effectiveStart}). Não se assume ano posterior completo.`
    );
  }

  const baseline = claim.baselineValue;
  const delta = baseline !== null ? Number((latestVal - baseline).toFixed(4)) : null;
  const improvedDirectionally =
    delta === null
      ? null
      : claim.improvementDirection === 'higher_is_better'
        ? delta > 0
        : delta < 0;

  const targetMet =
    claim.targetValue !== null
      ? claim.improvementDirection === 'higher_is_better'
        ? latestVal >= claim.targetValue
        : latestVal <= claim.targetValue
      : false;

  const bStatus: EvaluationRun['dimensions']['B_targetAttainment']['status'] = isInterim
    ? 'AVALIACAO_INTERINA'
    : targetMet
      ? 'META_ATINGIDA_OBSERVADA'
      : improvedDirectionally
        ? 'MELHORA_PARCIAL_OBSERVADA'
        : 'SEM_MELHORA_OBSERVADA';

  // Dimension C: Causal Attribution Guard
  const didValidation = params.didDesign ? validateDidDesign(params.didDesign) : undefined;
  let cStatus: EvaluationRun['dimensions']['C_attributableEffect']['status'] =
    improvedDirectionally
      ? 'MELHORA_OBSERVADA_SEM_ATRIBUICAO_CAUSAL'
      : 'SEM_ATRIBUICAO_CAUSAL';
  let cNote =
    improvedDirectionally
      ? 'Comparação descritiva aponta variação favorável no período observado, porém sem desenho quase-experimental validado não há atribuição causal ao contrato.'
      : 'Comparação descritiva reproduzível; não permite atribuir causalidade nem concluir inexecução ou serviço fictício.';

  if (params.didDesign?.requestedMethod === 'synthetic_control' || params.didDesign?.usesSimpleNeighborAverageAsSyntheticControl) {
    cStatus = 'CONTROLE_SINTETICO_NAO_SIMULAVEL';
    cNote =
      'Controle sintético é método distinto e não é simulado por média simples de municípios vizinhos.';
  } else if (didValidation?.eligible) {
    cStatus = 'DID_ELEGIVEL_REQUER_ESTIMACAO_FORMAL';
    cNote =
      'Pré-requisitos de Diferenças em Diferenças verificados (grupo de comparação justificado, pré-tendências testadas, hipóteses e incerteza declaradas); manter interpretação prudente.';
  } else if (didValidation && !didValidation.eligible) {
    limitations.push(
      `Desenho DiD não elegível: ${didValidation.blockingReasons.join(' ')}`
    );
  }

  return {
    runId,
    claimId: claim.claimId,
    contractId: claim.contractId,
    evaluatedAt: evaluationDate,
    status: isInterim ? 'AVALIACAO_INTERINA' : 'CONCLUIDA_DESCRITIVA',
    isInterimEvaluation: isInterim,
    latestPublishedCompetencia: latestPublished.competencia,
    effectiveInterventionStartDate: effectiveStart,
    dimensions: {
      A_serviceDelivery: dimA,
      B_targetAttainment: {
        status: bStatus,
        baselineValue: baseline,
        latestObservedValue: latestVal,
        targetValue: claim.targetValue,
        absoluteDelta: delta,
        improvedDirectionally,
        note: isInterim
          ? `Leitura interina na competência ${latestPublished.competencia} (valor=${latestVal}, baseline=${baseline ?? 'N/D'}, meta=${claim.targetValue ?? 'N/D'}).`
          : `Comparação descritiva na competência ${latestPublished.competencia} (valor=${latestVal}, baseline=${baseline ?? 'N/D'}, Δ=${delta ?? 'N/D'}).`,
      },
      C_attributableEffect: {
        status: cStatus,
        causalAttributionClaimed: false,
        didValidation,
        note: cNote,
      },
      D_costPerValidatedDelivery: dimD,
    },
    serviceClassifiedAsFictitious: false,
    limitations,
    diligences,
  };
}

/**
 * Imports real public SIAPS CSV/TSV export tables (confirming SIAPS public file exports,
 * never inventing an undocumented API). Preserves file SHA-256, methodologyVersion,
 * competência, numerator, denominator, and keeps unpublished entries strictly null.
 */
export function importSiapsPublicExport(params: {
  rawCsv: string;
  filename: string;
  collectedAt?: string;
  defaultMethodologyVersion: string;
}): SiapsImportResult {
  const importedAt = params.collectedAt ?? new Date().toISOString();
  const fileSha256 = crypto.createHash('sha256').update(params.rawCsv, 'utf8').digest('hex');
  const warnings: string[] = [];
  const observations: IndicatorObservation[] = [];
  let unpublishedCount = 0;

  const parsed = parseCsvTable(params.rawCsv);

  if (parsed.headers.length === 0 || parsed.rows.length === 0) {
    warnings.push('Arquivo SIAPS sem linhas de dados.');
    return {
      sourceSystem: 'SIAPS — Exportação Pública CSV/XLSX (sem API inventada)',
      fileSha256,
      importedAt,
      filename: params.filename,
      rowCount: 0,
      unpublishedCount: 0,
      observations: [],
      warnings,
    };
  }

  const headers = parsed.headers.map((h) => h.trim().toLowerCase());
  const col = (names: string[]) => headers.findIndex((h) => names.some((n) => h.includes(n)));

  const idxIbge = col(['ibge', 'municipio_cod', 'territorio']);
  const idxIndicator = col(['indicador', 'indicator', 'codigo_indicador']);
  const idxMethodology = col(['metodologia', 'versao']);
  const idxComp = col(['competencia', 'quadrimestre', 'periodo']);
  const idxPeriodEnd = col(['fim_periodo', 'period_end', 'data_fim']);
  const idxNum = col(['numerador', 'numerator']);
  const idxDen = col(['denominador', 'denominator']);
  const idxVal = col(['resultado', 'valor', 'indicador_valor', 'value']);
  const idxPub = col(['publicacao', 'published', 'data_publicacao']);
  const idxRev = col(['revisao', 'revision']);

  for (let i = 0; i < parsed.rows.length; i++) {
    const parts = parsed.rows[i];
    const territoryCode = (idxIbge >= 0 ? parts[idxIbge] : parts[0])?.replace(/\D/g, '') || '';
    const indicatorId = (idxIndicator >= 0 ? parts[idxIndicator] : parts[1]) || '';
    const rawCompetencia = (idxComp >= 0 ? parts[idxComp] : parts[2]) || '';
    if (!territoryCode || !indicatorId || !rawCompetencia) continue;

    const compValidation = validateCompetencia(rawCompetencia);
    if (!compValidation.valid || !compValidation.normalized) {
      warnings.push(
        `Linha ${i + 2} ignorada por competência inválida ("${rawCompetencia}"): ${compValidation.reason ?? 'formato inválido'}`
      );
      continue;
    }

    const methodologyVersion =
      (idxMethodology >= 0 && parts[idxMethodology]) || params.defaultMethodologyVersion;
    const numerator = idxNum >= 0 ? parseNumericOrNull(parts[idxNum]) : null;
    const denominator = idxDen >= 0 ? parseNumericOrNull(parts[idxDen]) : null;
    let value = idxVal >= 0 ? parseNumericOrNull(parts[idxVal]) : null;
    if (value === null && numerator !== null && denominator !== null && denominator > 0) {
      value = Number(((numerator / denominator) * 100).toFixed(2));
    }

    const rawPublishedAt = idxPub >= 0 && parts[idxPub] ? parts[idxPub].trim() : null;
    const publishedAt =
      rawPublishedAt && validateIsoDate(rawPublishedAt.slice(0, 10)).valid
        ? rawPublishedAt
        : null;
    const isPublished = value !== null;
    if (!isPublished) {
      unpublishedCount += 1;
    }

    const explicitEnd = idxPeriodEnd >= 0 ? validateIsoDate(parts[idxPeriodEnd]) : { valid: false, normalized: null };
    const inferredPeriodEnd =
      (explicitEnd.valid && explicitEnd.normalized) ||
      compValidation.periodEndDate ||
      `${compValidation.normalized.slice(0, 4)}-12-31`;

    observations.push({
      observationId: `siaps_${territoryCode}_${indicatorId}_${compValidation.normalized}_${i + 1}`,
      indicatorId,
      methodologyVersion,
      territoryCode,
      competencia: compValidation.normalized,
      periodEndDate: inferredPeriodEnd,
      publishedAt,
      collectedAt: importedAt,
      revision: (idxRev >= 0 && parts[idxRev]) || 'original',
      numerator,
      denominator,
      value,
      isPublished,
      sourceFileSha256: fileSha256,
    });
  }

  return {
    sourceSystem: 'SIAPS — Exportação Pública CSV/XLSX (sem API inventada)',
    fileSha256,
    importedAt,
    filename: params.filename,
    rowCount: observations.length,
    unpublishedCount,
    observations,
    warnings,
  };
}

function inferPeriodEndFromCompetencia(comp: string): string | null {
  const c = comp.trim().toUpperCase();
  const qMatch = c.match(/^(\d{4})-?Q([123])$/);
  if (qMatch) {
    const year = qMatch[1];
    const q = Number(qMatch[2]);
    if (q === 1) return `${year}-04-30`;
    if (q === 2) return `${year}-08-31`;
    return `${year}-12-31`;
  }
  const mMatch = c.match(/^(\d{4})-(\d{2})$/);
  if (mMatch) {
    const y = Number(mMatch[1]);
    const m = Number(mMatch[2]);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${mMatch[1]}-${mMatch[2]}-${String(lastDay).padStart(2, '0')}`;
  }
  if (/^\d{4}$/.test(c)) return `${c}-12-31`;
  return null;
}

/**
 * Reconciles SICONFI fiscal execution rows by differentiating periods, accounts,
 * rectifications, and cumulative balances. Strictly prohibits summing empenho +
 * liquidação + pagamento as independent expenses.
 */
export function reconcileSiconfiExecution(params: {
  exercicio: number;
  conta: string;
  records: ReadonlyArray<SiconfiStageRecord>;
}): SiconfiReconciliationResult {
  const matching = params.records.filter(
    (r) => r.exercicio === params.exercicio && r.conta.trim().toLowerCase() === params.conta.trim().toLowerCase()
  );

  const warnings: string[] = [
    'Empenho, liquidação e pagamento são estágios sequenciais da mesma despesa e JAMAIS são somados como despesas independentes.',
  ];

  const rectificationsDetected = matching.filter((r) => r.isRetificacao).length;
  const cumulativeBalanceDetected = matching.some((r) => r.isSaldoAcumulado);
  if (cumulativeBalanceDetected) {
    warnings.push(
      'Saldos acumulados detectados: utilizando exclusivamente o último período/retificação por estágio (sem somar bimestres acumulados).'
    );
  }

  const pickStage = (stage: 'empenho' | 'liquidacao' | 'pagamento'): { val: number | null; period: string | null } => {
    const stageRows = matching.filter((r) => r.estagio === stage);
    if (stageRows.length === 0) return { val: null, period: null };

    // Sort by period ascending, then prefer rectification over original, then latest publication date
    const sorted = [...stageRows].sort((a, b) => {
      const pCmp = a.periodo.localeCompare(b.periodo);
      if (pCmp !== 0) return pCmp;
      if (a.isRetificacao !== b.isRetificacao) return a.isRetificacao ? 1 : -1;
      return (a.dataPublicacao ?? '').localeCompare(b.dataPublicacao ?? '');
    });

    if (sorted.some((r) => r.isSaldoAcumulado)) {
      const latest = sorted[sorted.length - 1];
      return { val: Number(latest.valor.toFixed(2)), period: latest.periodo };
    }

    // Non-cumulative periods: deduplicate per period preferring latest rectification
    const byPeriod = new Map<string, SiconfiStageRecord>();
    for (const row of sorted) {
      byPeriod.set(row.periodo, row);
    }
    const total = Array.from(byPeriod.values()).reduce((acc, r) => acc + r.valor, 0);
    const latestPeriod = sorted[sorted.length - 1].periodo;
    return { val: Number(total.toFixed(2)), period: latestPeriod };
  };

  const emp = pickStage('empenho');
  const liq = pickStage('liquidacao');
  const pag = pickStage('pagamento');

  const latestPeriodUsed =
    [emp.period, liq.period, pag.period].filter((p): p is string => Boolean(p)).sort().at(-1) ?? null;

  return {
    exercicio: params.exercicio,
    conta: params.conta,
    byStage: {
      empenho: emp.val,
      liquidacao: liq.val,
      pagamento: pag.val,
    },
    sumAcrossStagesProhibited: true,
    rectificationsDetected,
    cumulativeBalanceDetected,
    latestPeriodUsed,
    warnings,
  };
}

export interface PairedControlMunicipality {
  municipalityCode: string;
  municipalityName: string;
  microregion: string;
  populationBand: string;
  /** Control municipalities MUST NOT have contracted the same consultancy */
  hadSimilarConsultancy: boolean;
  preValue: number;
  postValue: number;
}

export interface PairedDidInput {
  contractId: string;
  indicatorId: string;
  indicatorName: string;
  domain: 'saude' | 'educacao';
  sourceSystem: string;
  contractSignatureDate: string;
  preWindowMonths?: number;
  postWindowMonths?: number;
  improvementDirection: ImprovementDirection;
  treatedMunicipalityCode: string;
  treatedMunicipalityName: string;
  treatedPreValue: number;
  treatedPostValue: number;
  controlMunicipalities: PairedControlMunicipality[];
  /** Percentage (0-100) of contractual installments already disbursed */
  installmentsPaidPct: number;
  validatedDeliveriesCount?: number | null;
  didDesign?: DidDesignInput;
}

export interface PairedDidResult {
  contractId: string;
  indicatorId: string;
  indicatorName: string;
  domain: 'saude' | 'educacao';
  sourceSystem: string;
  contractSignatureDate: string;
  windowSummary: {
    preWindowMonths: number;
    postWindowMonths: number;
  };
  deltaTreated: number;
  deltaControlMean: number;
  /** Raw Δ_Treated - Δ_Control */
  netEffectRaw: number;
  /** Positive means favorable relative to control according to improvementDirection */
  netEffectOriented: number;
  validControlCount: number;
  excludedControlCount: number;
  alertLevel:
    | 'ALERTA_VERMELHO_INEFETIVIDADE'
    | 'ATENCAO_DESEMPENHO_ESTAGNADO'
    | 'VARIACAO_FAVORAVEL_OBSERVADA'
    | 'CONTROLE_INSUFICIENTE'
    | 'METODOLOGIA_REPROVADA'
    | 'CONTRASTE_DESCRITIVO_SEM_INFERENCIA';
  alertTitle: string;
  alertDetail: string;
  /** Forensic safeguard: indicator stagnation triggers audit of physical delivery, never automatic proof of fictitious service */
  serviceClassifiedAsFictitious: false;
  didValidation?: {
    eligible: boolean;
    blockingReasons: string[];
  };
  limitations: string[];
  diligences: string[];
}

/**
 * Computes paired Difference-in-Differences (DiD) between a contracting municipality
 * and 3-5 paired neighboring control municipalities in the same microregion and
 * population band that did NOT hire the consultancy.
 *
 * Emits a red screening alert when oriented net effect <= 0 despite full/high
 * disbursement, while preserving the NEXOFIS forensic safeguard that an unimproved
 * aggregate indicator NEVER proves a fictitious service without delivery auditing.
 */
export function computePairedDidEffect(input: PairedDidInput): PairedDidResult {
  const preWindowMonths = Math.max(12, Math.min(24, input.preWindowMonths ?? 12));
  const postWindowMonths = Math.max(12, Math.min(24, input.postWindowMonths ?? 12));
  const limitations: string[] = [
    'Diferença-em-Diferenças pareada com municípios vizinhos é distinta de Controle Sintético (não há ponderação convexa otimizada de doadores).',
    'Ausência de melhora em indicador agregado dispara diligência de verificação documental de entregas, mas jamais classifica automaticamente o serviço como fictício.',
  ];
  const diligences: string[] = [];

  const validControls = input.controlMunicipalities.filter(
    (c) => !c.hadSimilarConsultancy && Number.isFinite(c.preValue) && Number.isFinite(c.postValue)
  );
  const excludedControlCount = input.controlMunicipalities.length - validControls.length;

  const deltaTreated = Number((input.treatedPostValue - input.treatedPreValue).toFixed(4));
  const didValidation = input.didDesign ? validateDidDesign(input.didDesign) : undefined;

  if (validControls.length === 0) {
    limitations.push(
      'Nenhum município de controle elegível (mesma microrregião, faixa populacional e sem consultoria equivalente).'
    );
    return {
      contractId: input.contractId,
      indicatorId: input.indicatorId,
      indicatorName: input.indicatorName,
      domain: input.domain,
      sourceSystem: input.sourceSystem,
      contractSignatureDate: input.contractSignatureDate,
      windowSummary: { preWindowMonths, postWindowMonths },
      deltaTreated,
      deltaControlMean: 0,
      netEffectRaw: deltaTreated,
      netEffectOriented:
        input.improvementDirection === 'higher_is_better' ? deltaTreated : -deltaTreated,
      validControlCount: 0,
      excludedControlCount,
      alertLevel: 'CONTROLE_INSUFICIENTE',
      alertTitle: 'Grupo de controle insuficiente para Diferença-em-Diferenças',
      alertDetail:
        'Selecione entre 3 e 5 municípios vizinhos da mesma microrregião e faixa populacional sem consultoria equivalente.',
      serviceClassifiedAsFictitious: false,
      didValidation,
      limitations,
      diligences: [
        'Parear 3 a 5 municípios vizinhos sem contrato similar para viabilizar o contraste DiD.',
      ],
    };
  }

  if (validControls.length < 3) {
    limitations.push(
      `Grupo de controle reduzido (${validControls.length} município(s)); recomenda-se entre 3 e 5 municípios pareados.`
    );
  }
  if (excludedControlCount > 0) {
    limitations.push(
      `${excludedControlCount} município(s) excluído(s) do controle por já possuírem consultoria equivalente ou dados inválidos.`
    );
  }
  if (didValidation && !didValidation.eligible) {
    limitations.push(`Restrições do desenho DiD: ${didValidation.blockingReasons.join(' ')}`);
  }

  const controlPreMean =
    validControls.reduce((sum, c) => sum + c.preValue, 0) / validControls.length;
  const controlPostMean =
    validControls.reduce((sum, c) => sum + c.postValue, 0) / validControls.length;
  const deltaControlMean = Number((controlPostMean - controlPreMean).toFixed(4));
  const netEffectRaw = Number((deltaTreated - deltaControlMean).toFixed(4));
  const netEffectOriented =
    input.improvementDirection === 'higher_is_better'
      ? netEffectRaw
      : Number((-netEffectRaw).toFixed(4));

  let alertLevel: PairedDidResult['alertLevel'];
  let alertTitle: string;
  let alertDetail: string;

  // Defect 1.4: NEVER emit red ineffectiveness alert when DiD methodology failed validation
  // or when no formal didDesign was supplied.
  if (didValidation && !didValidation.eligible) {
    alertLevel = 'METODOLOGIA_REPROVADA';
    alertTitle = 'Metodologia DiD Reprovada — Alerta Causal Bloqueado';
    alertDetail = `Desenho de Diferença-em-Diferenças não atendeu aos pré-requisitos metodológicos (${didValidation.blockingReasons.join(' ')}). O contraste numérico observado (Efeito líquido orientado = ${netEffectOriented}, ΔTratado=${deltaTreated}, ΔControle=${deltaControlMean}) não pode sustentar alerta vermelho de inefetividade.`;
    diligences.push(
      'Corrigir desenho quase-experimental (justificar grupo de controle, testar pré-tendências paralelas com >= 3 períodos pré, declarar hipóteses e incerteza estatística) antes de emitir inferência DiD.'
    );
  } else if (!input.didDesign) {
    alertLevel = 'CONTRASTE_DESCRITIVO_SEM_INFERENCIA';
    alertTitle = 'Contraste Descritivo Pareado (Sem Desenho DiD Validado)';
    alertDetail = `Contraste descritivo frente a ${validControls.length} município(s) vizinho(s): ΔTratado=${deltaTreated}, ΔControle=${deltaControlMean}, diferença orientada=${netEffectOriented} (${input.installmentsPaidPct.toFixed(1)}% pago). Como o desenho DiD formal (pré-tendências, hipóteses e incerteza) não foi informado, nenhum alerta vermelho causal é emitido automaticamente.`;
    diligences.push(
      'Informar avaliação formal de pré-tendências e incerteza (didDesign) para qualificar inferência DiD e auditar entregas contratuais independentemente.'
    );
  } else if (netEffectOriented <= 0 && input.installmentsPaidPct >= 80) {
    alertLevel = 'ALERTA_VERMELHO_INEFETIVIDADE';
    alertTitle =
      'Alerta Vermelho de Triagem: Indício de Inefetividade — Auditar Prestação Efetiva do Serviço';
    alertDetail = `Efeito líquido orientado = ${netEffectOriented} (ΔTratado=${deltaTreated}, ΔControle=${deltaControlMean}) com ${input.installmentsPaidPct.toFixed(1)}% das parcelas pagas e desenho DiD validado. O indicador do município contratante evoluiu igual ou abaixo dos ${validControls.length} municípios pareados; exige auditoria física/documental de entregas (Dimensão A) antes de qualquer conclusão jurídica.`;
    diligences.push(
      'Solicitar relatórios técnicos assinados, listas de presença, atas de capacitação, produtos entregues e atestes de fiscalização para cada parcela liquidada/paga.',
      'Conferir no SICONFI (Função 10 Saúde / Função 12 Educação) os estágios separados de empenho, liquidação e pagamento vinculados ao CNPJ da contratada.'
    );
  } else if (netEffectOriented <= 0) {
    alertLevel = 'ATENCAO_DESEMPENHO_ESTAGNADO';
    alertTitle = 'Atenção: Efeito Líquido Não Positivo em Execução Parcial';
    alertDetail = `Efeito líquido orientado = ${netEffectOriented} com ${input.installmentsPaidPct.toFixed(1)}% de execução financeira paga. Acompanhar próximas competências oficiais e entregas contratuais.`;
    diligences.push(
      'Verificar cronograma efetivo de início das atividades e próxima janela de publicação oficial.'
    );
  } else {
    alertLevel = 'VARIACAO_FAVORAVEL_OBSERVADA';
    alertTitle = 'Variação Líquida Favorável Observada (Sem Atribuição Causal Automática)';
    alertDetail = `Efeito líquido orientado = +${netEffectOriented} (ΔTratado=${deltaTreated}, ΔControle=${deltaControlMean}) frente a ${validControls.length} municípios de controle. Variação favorável não substitui verificação de entregas nem prova causalidade isolada.`;
  }

  return {
    contractId: input.contractId,
    indicatorId: input.indicatorId,
    indicatorName: input.indicatorName,
    domain: input.domain,
    sourceSystem: input.sourceSystem,
    contractSignatureDate: input.contractSignatureDate,
    windowSummary: { preWindowMonths, postWindowMonths },
    deltaTreated,
    deltaControlMean,
    netEffectRaw,
    netEffectOriented,
    validControlCount: validControls.length,
    excludedControlCount,
    alertLevel,
    alertTitle,
    alertDetail,
    serviceClassifiedAsFictitious: false,
    didValidation,
    limitations,
    diligences,
  };
}

export interface InepImportResult {
  sourceSystem: 'INEP/MEC — Microdados e Tabelas Públicas (IDEB / SAEB / Rendimento)';
  fileSha256: string;
  importedAt: string;
  filename: string;
  rowCount: number;
  unpublishedCount: number;
  observations: IndicatorObservation[];
  warnings: string[];
}

/**
 * Imports official INEP CSV/TSV exports (IDEB, SAEB Português/Matemática, or school
 * approval/failure/dropout rates). Preserves SHA-256, methodologyVersion, biennial/annual
 * periodicity, and keeps missing/unpublished entries strictly null.
 */
export function importInepPublicExport(params: {
  rawCsv: string;
  filename: string;
  collectedAt?: string;
  defaultMethodologyVersion?: string;
}): InepImportResult {
  const importedAt = params.collectedAt ?? new Date().toISOString();
  const fileSha256 = crypto.createHash('sha256').update(params.rawCsv, 'utf8').digest('hex');
  const warnings: string[] = [
    'IDEB e SAEB possuem periodicidade bienal; respeite a janela oficial de divulgação antes de cruzar com contratos anuais.',
  ];
  const observations: IndicatorObservation[] = [];
  let unpublishedCount = 0;

  const parsed = parseCsvTable(params.rawCsv);

  if (parsed.headers.length === 0 || parsed.rows.length === 0) {
    warnings.push('Arquivo INEP sem linhas de dados.');
    return {
      sourceSystem: 'INEP/MEC — Microdados e Tabelas Públicas (IDEB / SAEB / Rendimento)',
      fileSha256,
      importedAt,
      filename: params.filename,
      rowCount: 0,
      unpublishedCount: 0,
      observations: [],
      warnings,
    };
  }

  const headers = parsed.headers.map((h) => h.trim().toLowerCase());
  const col = (names: string[]) => headers.findIndex((h) => names.some((n) => h.includes(n)));

  const idxIbge = col(['ibge', 'co_municipio', 'municipio_cod', 'territorio']);
  const idxIndicator = col(['indicador', 'metrica', 'tipo_indicador']);
  const idxAno = col(['ano', 'competencia', 'edicao']);
  const idxVal = col(['valor', 'nota', 'ideb', 'saeb', 'taxa', 'resultado']);
  const idxMethod = col(['metodologia', 'versao']);
  const idxPub = col(['publicacao', 'data_publicacao']);

  for (let i = 0; i < parsed.rows.length; i++) {
    const parts = parsed.rows[i];
    const territoryCode = (idxIbge >= 0 ? parts[idxIbge] : parts[0])?.replace(/\D/g, '') || '';
    const indicatorId = (idxIndicator >= 0 ? parts[idxIndicator] : 'IDEB') || 'IDEB';
    const rawComp = (idxAno >= 0 ? parts[idxAno] : parts[2])?.trim() || '';
    if (!territoryCode || !rawComp) continue;

    const compValidation = validateCompetencia(rawComp);
    if (!compValidation.valid || !compValidation.normalized) {
      warnings.push(
        `Linha ${i + 2} ignorada por ano/competência inválida ("${rawComp}"): ${compValidation.reason ?? 'formato inválido'}`
      );
      continue;
    }

    const value = idxVal >= 0 ? parseNumericOrNull(parts[idxVal]) : parseNumericOrNull(parts[3]);
    const isPublished = value !== null;
    if (!isPublished) unpublishedCount += 1;

    const rawPub = idxPub >= 0 && parts[idxPub] ? parts[idxPub].trim() : null;
    const publishedAt =
      rawPub && validateIsoDate(rawPub.slice(0, 10)).valid ? rawPub : null;

    observations.push({
      observationId: `inep_${territoryCode}_${indicatorId}_${compValidation.normalized}_${i + 1}`,
      indicatorId,
      methodologyVersion:
        (idxMethod >= 0 && parts[idxMethod]) || params.defaultMethodologyVersion || 'inep-ideb-v1',
      territoryCode,
      competencia: compValidation.normalized,
      periodEndDate: compValidation.periodEndDate ?? `${compValidation.normalized.slice(0, 4)}-12-31`,
      publishedAt,
      collectedAt: importedAt,
      revision: 'original',
      numerator: null,
      denominator: null,
      value,
      isPublished,
      sourceFileSha256: fileSha256,
    });
  }

  return {
    sourceSystem: 'INEP/MEC — Microdados e Tabelas Públicas (IDEB / SAEB / Rendimento)',
    fileSha256,
    importedAt,
    filename: params.filename,
    rowCount: observations.length,
    unpublishedCount,
    observations,
    warnings,
  };
}


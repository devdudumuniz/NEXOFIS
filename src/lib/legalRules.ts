import type { TemporalLegalRule } from '../types/audit';

/**
 * Temporal catalog of Brazilian public procurement monetary thresholds (Lei 14.133/2021).
 * Enables legal time travel: a 2024 or 2025 contract is ALWAYS evaluated under the decree
 * in force on its signature/effective date, never retroactively under 2026 thresholds.
 */
export const TEMPORAL_LEGAL_RULESETS: TemporalLegalRule[] = [
  {
    ruleId: 'BR-L14133-DEC12807-2026',
    jurisdiction: 'BR-FEDERAL (aplicação nacional Lei 14.133/2021)',
    legalBasis: 'Lei nº 14.133/2021 atualizada pelo Decreto nº 12.807, de 29/12/2025',
    effectiveFrom: '2026-01-01',
    effectiveUntil: null,
    applicabilityExpression: 'contract.signatureDate >= 2026-01-01',
    requiredEvidence: ['data_assinatura', 'modalidade', 'unidade_gestora', 'exercicio_financeiro'],
    severityIfConfirmed: 'ALTA',
    severityIfUnverified: 'MÉDIA',
    sourceVersionHash: 'dec12807-2025-dou-20251230',
    supersedesRuleId: 'BR-L14133-DEC12343-2025',
    thresholds: {
      dispensaObrasArt75I: 130984.2,
      dispensaServicosArt75II: 65492.11,
      dispensaVeiculosArt75P7: 10478.74,
      pequenasComprasArt95P2: 13098.41,
      grandeVulto: 261968421.04,
    },
  },
  {
    ruleId: 'BR-L14133-DEC12343-2025',
    jurisdiction: 'BR-FEDERAL (aplicação nacional Lei 14.133/2021)',
    legalBasis: 'Lei nº 14.133/2021 atualizada pelo Decreto nº 12.343, de 30/12/2024',
    effectiveFrom: '2025-01-01',
    effectiveUntil: '2025-12-31',
    applicabilityExpression: '2025-01-01 <= contract.signatureDate <= 2025-12-31',
    requiredEvidence: ['data_assinatura', 'modalidade', 'unidade_gestora', 'exercicio_financeiro'],
    severityIfConfirmed: 'ALTA',
    severityIfUnverified: 'MÉDIA',
    sourceVersionHash: 'dec12343-2024-dou-20241231',
    supersedesRuleId: 'BR-L14133-DEC11871-2024',
    thresholds: {
      dispensaObrasArt75I: 125451.15,
      dispensaServicosArt75II: 62725.59,
      dispensaVeiculosArt75P7: 10036.1,
      pequenasComprasArt95P2: 12545.11,
      grandeVulto: 250902300.0,
    },
  },
  {
    ruleId: 'BR-L14133-DEC11871-2024',
    jurisdiction: 'BR-FEDERAL (aplicação nacional Lei 14.133/2021)',
    legalBasis: 'Lei nº 14.133/2021 atualizada pelo Decreto nº 11.871, de 29/12/2023',
    effectiveFrom: '2024-01-01',
    effectiveUntil: '2024-12-31',
    applicabilityExpression: '2024-01-01 <= contract.signatureDate <= 2024-12-31',
    requiredEvidence: ['data_assinatura', 'modalidade', 'unidade_gestora', 'exercicio_financeiro'],
    severityIfConfirmed: 'ALTA',
    severityIfUnverified: 'MÉDIA',
    sourceVersionHash: 'dec11871-2023-dou-20231229',
    supersedesRuleId: null,
    thresholds: {
      dispensaObrasArt75I: 119812.02,
      dispensaServicosArt75II: 59906.02,
      dispensaVeiculosArt75P7: 9584.97,
      pequenasComprasArt95P2: 11981.2,
      grandeVulto: 239624058.14,
    },
  },
];

export function resolveLegalRulesetForDate(isoDate: string): TemporalLegalRule {
  const cleanDate = isoDate?.slice(0, 10) || '2026-01-01';
  for (const rule of TEMPORAL_LEGAL_RULESETS) {
    const afterStart = cleanDate >= rule.effectiveFrom;
    const beforeEnd = rule.effectiveUntil === null || cleanDate <= rule.effectiveUntil;
    if (afterStart && beforeEnd) {
      return rule;
    }
  }
  // If contract precedes 2024, default to earliest available Lei 14.133 decree in catalog
  return TEMPORAL_LEGAL_RULESETS[TEMPORAL_LEGAL_RULESETS.length - 1];
}

export function getDispensationLimitForContract(
  ruleset: TemporalLegalRule,
  article: 'art75_I' | 'art75_II' | 'art75_p7' | 'art95_p2' = 'art75_II'
): number {
  const t = ruleset.thresholds!;
  switch (article) {
    case 'art75_I':
      return t.dispensaObrasArt75I;
    case 'art75_p7':
      return t.dispensaVeiculosArt75P7;
    case 'art95_p2':
      return t.pequenasComprasArt95P2;
    case 'art75_II':
    default:
      return t.dispensaServicosArt75II;
  }
}

export function isRiskMatrixMandatory(params: {
  updatedValue: number;
  executionRegime?: string;
  ruleset: TemporalLegalRule;
}): { mandatory: boolean; reason: string } {
  const grandeVultoThreshold = params.ruleset.thresholds?.grandeVulto ?? 261968421.04;
  if (params.executionRegime === 'Integrado' || params.executionRegime === 'Semi-integrado') {
    return {
      mandatory: true,
      reason: `Regime de contratação ${params.executionRegime} exige matriz de riscos obrigatória (Lei 14.133/2021, art. 22, § 3º).`,
    };
  }
  if (params.updatedValue >= grandeVultoThreshold) {
    return {
      mandatory: true,
      reason: `Contratação de grande vulto (>= R$ ${grandeVultoThreshold.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} em ${params.ruleset.effectiveFrom.slice(0, 4)}) exige matriz de riscos obrigatória (art. 22, § 3º).`,
    };
  }
  return {
    mandatory: false,
    reason: 'Contratação ordinária abaixo do limite de grande vulto e fora dos regimes integrado/semi-integrado: matriz de riscos é facultativa (art. 22, caput).',
  };
}

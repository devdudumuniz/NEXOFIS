import type { EvaluatedContract } from '../types/audit';

export type RiskTier = 'low' | 'medium' | 'high';

export interface RiskDistributionCounts {
  low: number;
  medium: number;
  high: number;
  total: number;
  insufficientCoverage: number;
}

export interface RiskGroupBreakdown {
  key: string;
  label: string;
  municipalityLabel?: string;
  sector: string;
  low: number;
  medium: number;
  high: number;
  total: number;
  totalValue: number;
  avgScore: number;
  maxScore: number;
}

export interface RiskDashboardSummary {
  totalContracts: number;
  totalValue: number;
  avgScore: number;
  distribution: RiskDistributionCounts;
  byEntity: RiskGroupBreakdown[];
  bySector: RiskGroupBreakdown[];
  period: {
    startDate: string | null;
    endDate: string | null;
  };
  generatedAt: string;
}

/**
 * Classifies a forensic contract score (0-100) into the 3 dashboard tiers:
 * - Alto: score >= 70
 * - Médio: 40 <= score < 70
 * - Baixo: score < 40
 */
export function classifyRiskTier(score: number): RiskTier {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

export function inferContractSector(contract: {
  entityName: string;
  objectCategory?: string;
  object: string;
}): string {
  const hay = `${contract.entityName} ${contract.objectCategory ?? ''} ${contract.object}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  if (
    /\b(saude|fms|hospital|upa|ubs|medicament|odonto|enferm|clinica|farmac|sus|ambulancia)\b/.test(
      hay
    )
  ) {
    return 'Saúde';
  }
  if (
    /\b(educacao|escola|merenda|ensino|fme|creche|didatic|transporte escolar|universidade)\b/.test(
      hay
    )
  ) {
    return 'Educação';
  }
  if (
    /\b(obras|infraestrutura|pavimentacao|asfalto|drenagem|engenharia|saneamento|urbano|construcao|reforma)\b/.test(
      hay
    )
  ) {
    return 'Obras e Infraestrutura';
  }
  if (
    /\b(financas|fazenda|contabil|tribut|administracao|gestao|planejamento|tecnologia|ti\b|software|consultoria|juridic)\b/.test(
      hay
    )
  ) {
    return 'Administração e Finanças';
  }
  if (/\b(assistencia social|fmas|cras|creas|habitacao|cultura|esporte|meio ambiente)\b/.test(hay)) {
    return 'Assistência e Serviços Urbanos';
  }
  return 'Outros Setores';
}

function finalizeGroups(
  map: Map<
    string,
    {
      key: string;
      label: string;
      municipalityLabel?: string;
      sector: string;
      low: number;
      medium: number;
      high: number;
      total: number;
      totalValue: number;
      scoreSum: number;
      maxScore: number;
    }
  >
): RiskGroupBreakdown[] {
  return Array.from(map.values())
    .map((g) => ({
      key: g.key,
      label: g.label,
      municipalityLabel: g.municipalityLabel,
      sector: g.sector,
      low: g.low,
      medium: g.medium,
      high: g.high,
      total: g.total,
      totalValue: Number(g.totalValue.toFixed(2)),
      avgScore: g.total > 0 ? Math.round(g.scoreSum / g.total) : 0,
      maxScore: g.maxScore,
    }))
    .sort((a, b) => {
      if (b.high !== a.high) return b.high - a.high;
      if (b.medium !== a.medium) return b.medium - a.medium;
      if (b.total !== a.total) return b.total - a.total;
      return b.totalValue - a.totalValue;
    });
}

export function aggregateRiskDashboard(
  contracts: EvaluatedContract[],
  period?: { startDate?: string; endDate?: string }
): RiskDashboardSummary {
  const distribution: RiskDistributionCounts = {
    low: 0,
    medium: 0,
    high: 0,
    total: contracts.length,
    insufficientCoverage: 0,
  };

  let totalValue = 0;
  let scoreSum = 0;

  const entityMap = new Map<
    string,
    {
      key: string;
      label: string;
      municipalityLabel?: string;
      sector: string;
      low: number;
      medium: number;
      high: number;
      total: number;
      totalValue: number;
      scoreSum: number;
      maxScore: number;
    }
  >();

  const sectorMap = new Map<
    string,
    {
      key: string;
      label: string;
      municipalityLabel?: string;
      sector: string;
      low: number;
      medium: number;
      high: number;
      total: number;
      totalValue: number;
      scoreSum: number;
      maxScore: number;
    }
  >();

  for (const contract of contracts) {
    const score = contract.assessment.score;
    const tier = classifyRiskTier(score);
    distribution[tier] += 1;
    if (contract.assessment.coverageStatus === 'INSUFFICIENT') {
      distribution.insufficientCoverage += 1;
    }

    const contractValue = Number.isFinite(contract.updatedValue) ? contract.updatedValue : 0;
    totalValue += contractValue;
    scoreSum += score;

    const sector = inferContractSector(contract);

    // Group by Entity (municipality + normalized entity name so same secretaria in different cities stays distinct)
    const entityNameClean = contract.entityName.trim() || 'Órgão não identificado';
    const entityKey = `${contract.municipalityIbge}::${entityNameClean.toLowerCase()}`;
    const existingEnt = entityMap.get(entityKey) ?? {
      key: entityKey,
      label: entityNameClean,
      municipalityLabel: `${contract.municipalityName}/${contract.uf}`,
      sector,
      low: 0,
      medium: 0,
      high: 0,
      total: 0,
      totalValue: 0,
      scoreSum: 0,
      maxScore: 0,
    };
    existingEnt[tier] += 1;
    existingEnt.total += 1;
    existingEnt.totalValue += contractValue;
    existingEnt.scoreSum += score;
    existingEnt.maxScore = Math.max(existingEnt.maxScore, score);
    entityMap.set(entityKey, existingEnt);

    // Group by Sector
    const existingSec = sectorMap.get(sector) ?? {
      key: sector,
      label: sector,
      sector,
      low: 0,
      medium: 0,
      high: 0,
      total: 0,
      totalValue: 0,
      scoreSum: 0,
      maxScore: 0,
    };
    existingSec[tier] += 1;
    existingSec.total += 1;
    existingSec.totalValue += contractValue;
    existingSec.scoreSum += score;
    existingSec.maxScore = Math.max(existingSec.maxScore, score);
    sectorMap.set(sector, existingSec);
  }

  return {
    totalContracts: contracts.length,
    totalValue: Number(totalValue.toFixed(2)),
    avgScore: contracts.length > 0 ? Math.round(scoreSum / contracts.length) : 0,
    distribution,
    byEntity: finalizeGroups(entityMap),
    bySector: finalizeGroups(sectorMap),
    period: {
      startDate: period?.startDate ?? null,
      endDate: period?.endDate ?? null,
    },
    generatedAt: new Date().toISOString(),
  };
}

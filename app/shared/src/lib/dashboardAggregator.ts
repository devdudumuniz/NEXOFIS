import type { EvaluatedContract } from '../types/audit';

export type RiskTier = 'low' | 'medium' | 'high' | 'unverifiable';

export interface RiskDistributionCounts {
  low: number;
  medium: number;
  high: number;
  unverifiable: number;
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
  unverifiable: number;
  total: number;
  totalValue: number;
  avgScore: number;
  maxScore: number;
}

export interface TopRiskOrganEntry {
  rank: number;
  entityKey: string;
  entityName: string;
  municipalityIbge: string;
  municipalityName: string;
  uf: string;
  sector: string;
  highRiskCount: number;
  mediumRiskCount: number;
  totalContracts: number;
  highRiskValue: number;
  totalValue: number;
  maxScore: number;
  avgScore: number;
  highRiskSharePct: number;
}

export interface TopRiskMunicipalityEntry {
  rank: number;
  municipalityIbge: string;
  municipalityName: string;
  uf: string;
  highRiskCount: number;
  mediumRiskCount: number;
  totalContracts: number;
  highRiskValue: number;
  maxScore: number;
  highRiskSharePct: number;
}

export interface RiskDashboardSummary {
  totalContracts: number;
  totalValue: number;
  avgScore: number;
  distribution: RiskDistributionCounts;
  byEntity: RiskGroupBreakdown[];
  bySector: RiskGroupBreakdown[];
  topHighRiskOrgans: TopRiskOrganEntry[];
  topHighRiskMunicipalities: TopRiskMunicipalityEntry[];
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
export function classifyRiskTier(
  score: number,
  coverageStatus?: 'ADEQUATE' | 'PARTIAL' | 'INSUFFICIENT'
): RiskTier {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  if (coverageStatus === 'INSUFFICIENT') return 'unverifiable';
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

interface InternalGroupAccumulator {
  key: string;
  label: string;
  municipalityIbge?: string;
  municipalityName?: string;
  uf?: string;
  municipalityLabel?: string;
  sector: string;
  low: number;
  medium: number;
  high: number;
  unverifiable: number;
  total: number;
  totalValue: number;
  highRiskValue: number;
  scoreSum: number;
  maxScore: number;
}

function finalizeGroups(map: Map<string, InternalGroupAccumulator>): RiskGroupBreakdown[] {
  return Array.from(map.values())
    .map((g) => ({
      key: g.key,
      label: g.label,
      municipalityLabel: g.municipalityLabel,
      sector: g.sector,
      low: g.low,
      medium: g.medium,
      high: g.high,
      unverifiable: g.unverifiable,
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
    unverifiable: 0,
    total: contracts.length,
    insufficientCoverage: 0,
  };

  let totalValue = 0;
  let scoreSum = 0;

  const entityMap = new Map<string, InternalGroupAccumulator>();
  const sectorMap = new Map<string, InternalGroupAccumulator>();
  const municipalityMap = new Map<
    string,
    {
      municipalityIbge: string;
      municipalityName: string;
      uf: string;
      highRiskCount: number;
      mediumRiskCount: number;
      totalContracts: number;
      highRiskValue: number;
      maxScore: number;
    }
  >();

  for (const contract of contracts) {
    const score = contract.assessment.score;
    const tier = classifyRiskTier(score, contract.assessment.coverageStatus);
    distribution[tier] += 1;
    if (contract.assessment.coverageStatus === 'INSUFFICIENT') {
      distribution.insufficientCoverage += 1;
    }

    const contractValue = Number.isFinite(contract.updatedValue) ? contract.updatedValue : 0;
    totalValue += contractValue;
    scoreSum += score;

    const sector = inferContractSector(contract);
    const highValueContribution = tier === 'high' ? contractValue : 0;

    // Group by Entity (municipality + normalized entity name so same secretaria in different cities stays distinct)
    const entityNameClean = contract.entityName.trim() || 'Órgão não identificado';
    const entityKey = `${contract.municipalityIbge}::${entityNameClean.toLowerCase()}`;
    const existingEnt = entityMap.get(entityKey) ?? {
      key: entityKey,
      label: entityNameClean,
      municipalityIbge: contract.municipalityIbge,
      municipalityName: contract.municipalityName,
      uf: contract.uf,
      municipalityLabel: `${contract.municipalityName}/${contract.uf}`,
      sector,
      low: 0,
      medium: 0,
      high: 0,
      unverifiable: 0,
      total: 0,
      totalValue: 0,
      highRiskValue: 0,
      scoreSum: 0,
      maxScore: 0,
    };
    existingEnt[tier] += 1;
    existingEnt.total += 1;
    existingEnt.totalValue += contractValue;
    existingEnt.highRiskValue += highValueContribution;
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
      unverifiable: 0,
      total: 0,
      totalValue: 0,
      highRiskValue: 0,
      scoreSum: 0,
      maxScore: 0,
    };
    existingSec[tier] += 1;
    existingSec.total += 1;
    existingSec.totalValue += contractValue;
    existingSec.highRiskValue += highValueContribution;
    existingSec.scoreSum += score;
    existingSec.maxScore = Math.max(existingSec.maxScore, score);
    sectorMap.set(sector, existingSec);

    // Group by Municipality (for High-Risk concentration view)
    const munKey = contract.municipalityIbge || `${contract.municipalityName}-${contract.uf}`;
    const existingMun = municipalityMap.get(munKey) ?? {
      municipalityIbge: contract.municipalityIbge,
      municipalityName: contract.municipalityName,
      uf: contract.uf,
      highRiskCount: 0,
      mediumRiskCount: 0,
      totalContracts: 0,
      highRiskValue: 0,
      maxScore: 0,
    };
    if (tier === 'high') existingMun.highRiskCount += 1;
    if (tier === 'medium') existingMun.mediumRiskCount += 1;
    existingMun.totalContracts += 1;
    existingMun.highRiskValue += highValueContribution;
    existingMun.maxScore = Math.max(existingMun.maxScore, score);
    municipalityMap.set(munKey, existingMun);
  }

  const totalHigh = distribution.high;

  const topHighRiskOrgans: TopRiskOrganEntry[] = Array.from(entityMap.values())
    .filter((g) => g.high > 0 || g.medium > 0 || g.maxScore > 0)
    .sort((a, b) => {
      if (b.high !== a.high) return b.high - a.high;
      if (b.highRiskValue !== a.highRiskValue) return b.highRiskValue - a.highRiskValue;
      if (b.medium !== a.medium) return b.medium - a.medium;
      if (b.maxScore !== a.maxScore) return b.maxScore - a.maxScore;
      return b.totalValue - a.totalValue;
    })
    .slice(0, 5)
    .map((g, idx) => ({
      rank: idx + 1,
      entityKey: g.key,
      entityName: g.label,
      municipalityIbge: g.municipalityIbge ?? '0000000',
      municipalityName: g.municipalityName ?? 'Município não informado',
      uf: g.uf ?? 'BR',
      sector: g.sector,
      highRiskCount: g.high,
      mediumRiskCount: g.medium,
      totalContracts: g.total,
      highRiskValue: Number(g.highRiskValue.toFixed(2)),
      totalValue: Number(g.totalValue.toFixed(2)),
      maxScore: g.maxScore,
      avgScore: g.total > 0 ? Math.round(g.scoreSum / g.total) : 0,
      highRiskSharePct: totalHigh > 0 ? Number(((g.high / totalHigh) * 100).toFixed(1)) : 0,
    }));

  const topHighRiskMunicipalities: TopRiskMunicipalityEntry[] = Array.from(municipalityMap.values())
    .filter((m) => (totalHigh > 0 ? m.highRiskCount > 0 : m.mediumRiskCount > 0))
    .sort((a, b) => {
      if (b.highRiskCount !== a.highRiskCount) return b.highRiskCount - a.highRiskCount;
      if (b.highRiskValue !== a.highRiskValue) return b.highRiskValue - a.highRiskValue;
      if (b.mediumRiskCount !== a.mediumRiskCount) return b.mediumRiskCount - a.mediumRiskCount;
      return b.maxScore - a.maxScore;
    })
    .slice(0, 5)
    .map((m, idx) => ({
      rank: idx + 1,
      municipalityIbge: m.municipalityIbge,
      municipalityName: m.municipalityName,
      uf: m.uf,
      highRiskCount: m.highRiskCount,
      mediumRiskCount: m.mediumRiskCount,
      totalContracts: m.totalContracts,
      highRiskValue: Number(m.highRiskValue.toFixed(2)),
      maxScore: m.maxScore,
      highRiskSharePct:
        totalHigh > 0 ? Number(((m.highRiskCount / totalHigh) * 100).toFixed(1)) : 0,
    }));

  return {
    totalContracts: contracts.length,
    totalValue: Number(totalValue.toFixed(2)),
    avgScore: contracts.length > 0 ? Math.round(scoreSum / contracts.length) : 0,
    distribution,
    byEntity: finalizeGroups(entityMap),
    bySector: finalizeGroups(sectorMap),
    topHighRiskOrgans,
    topHighRiskMunicipalities,
    period: {
      startDate: period?.startDate ?? null,
      endDate: period?.endDate ?? null,
    },
    generatedAt: new Date().toISOString(),
  };
}

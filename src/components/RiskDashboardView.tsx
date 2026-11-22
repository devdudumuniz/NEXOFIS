import { useEffect, useState } from 'react';
import { ArrowRight, RefreshCw } from 'lucide-react';
import type { EvaluatedContract } from '../types/audit';
import { fetchRiskDashboardSummary, type RiskDashboardResponse } from '../lib/api';
import {
  classifyRiskTier,
  inferContractSector,
  type RiskGroupBreakdown,
  type RiskTier,
  type TopRiskMunicipalityEntry,
  type TopRiskOrganEntry,
} from '../lib/dashboardAggregator';
import { validateDatePeriod } from '../lib/datePeriod';
import {
  formatCnpj,
  formatCurrencyBRL,
  formatCurrencyCompactBRL,
  formatDateBR,
} from '../lib/formatters';
import { DatePeriodControls } from './DatePeriodControls';
import { RiskScoreInline } from './RiskText';

interface RiskDashboardViewProps {
  startDate: string;
  endDate: string;
  onPeriodChange: (next: { startDate: string; endDate: string }) => void;
  onSelectContract: (contract: EvaluatedContract) => void;
}

const TIER_META: Record<
  RiskTier,
  { label: string; range: string; colorHex: string; textClass: string; barClass: string }
> = {
  high: {
    label: 'Alto',
    range: '≥ 70/100',
    colorHex: '#DC2626',
    textClass: 'text-red-700 dark:text-red-400',
    barClass: 'bg-red-600',
  },
  medium: {
    label: 'Médio',
    range: '40–69/100',
    colorHex: '#D97706',
    textClass: 'text-amber-700 dark:text-amber-400',
    barClass: 'bg-amber-500',
  },
  low: {
    label: 'Baixo',
    range: '< 40/100',
    colorHex: '#16A34A',
    textClass: 'text-emerald-700 dark:text-emerald-400',
    barClass: 'bg-emerald-600',
  },
  unverifiable: {
    label: 'Cobertura insuficiente',
    range: 'Não verificável',
    colorHex: '#64748B',
    textClass: 'text-slate-600 dark:text-slate-400',
    barClass: 'bg-slate-500',
  },
};

function RiskPieChart({
  low,
  medium,
  high,
  unverifiable,
  activeTier,
  onSelectTier,
}: {
  low: number;
  medium: number;
  high: number;
  unverifiable: number;
  activeTier: RiskTier | 'ALL';
  onSelectTier: (tier: RiskTier | 'ALL') => void;
}) {
  const total = low + medium + high + unverifiable;
  const radius = 64;
  const strokeWidth = 22;
  const circumference = 2 * Math.PI * radius;

  const segments: Array<{ tier: RiskTier; count: number; pct: number; length: number; offset: number }> = [];
  const ordered: Array<{ tier: RiskTier; count: number }> = [
    { tier: 'high', count: high },
    { tier: 'medium', count: medium },
    { tier: 'low', count: low },
    { tier: 'unverifiable', count: unverifiable },
  ];

  let cumulative = 0;
  for (const item of ordered) {
    const fraction = total > 0 ? item.count / total : 0;
    const length = fraction * circumference;
    segments.push({
      tier: item.tier,
      count: item.count,
      pct: total > 0 ? (item.count / total) * 100 : 0,
      length,
      offset: cumulative,
    });
    cumulative += length;
  }

  return (
    <div className="flex flex-col sm:flex-row items-center gap-6">
      <div className="relative w-44 h-44 shrink-0" data-testid="risk-pie-chart">
        <svg
          viewBox="0 0 180 180"
          className="w-full h-full -rotate-90"
          role="img"
          aria-label={`Distribuição de risco: ${high} alto, ${medium} médio, ${low} baixo, ${unverifiable} cobertura insuficiente`}
        >
          <circle
            cx="90"
            cy="90"
            r={radius}
            fill="none"
            stroke="#334155"
            strokeOpacity="0.2"
            strokeWidth={strokeWidth}
          />
          {segments.map((seg) => {
            if (seg.count === 0) return null;
            const isDimmed = activeTier !== 'ALL' && activeTier !== seg.tier;
            return (
              <circle
                key={seg.tier}
                cx="90"
                cy="90"
                r={radius}
                fill="none"
                stroke={TIER_META[seg.tier].colorHex}
                strokeWidth={activeTier === seg.tier ? strokeWidth + 3 : strokeWidth}
                strokeDasharray={`${seg.length} ${Math.max(0, circumference - seg.length)}`}
                strokeDashoffset={-seg.offset}
                className="cursor-pointer transition-opacity"
                style={{ opacity: isDimmed ? 0.3 : 1 }}
                onClick={() => onSelectTier(activeTier === seg.tier ? 'ALL' : seg.tier)}
              >
                <title>
                  {`${TIER_META[seg.tier].label}: ${seg.count} contrato(s) (${seg.pct.toFixed(1)}%)`}
                </title>
              </circle>
            );
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center">
          <span className="font-mono tabular-nums text-2xl font-bold text-[#0B2540] dark:text-[#FAF9F5]">
            {total}
          </span>
          <span className="text-[11px] text-slate-500 dark:text-slate-400">contrato(s)</span>
        </div>
      </div>

      <div className="flex-1 w-full space-y-2">
        {segments.map((seg) => {
          const meta = TIER_META[seg.tier];
          const isSelected = activeTier === seg.tier;
          return (
            <button
              key={seg.tier}
              type="button"
              onClick={() => onSelectTier(isSelected ? 'ALL' : seg.tier)}
              aria-pressed={isSelected}
              className={`w-full text-left px-3 py-2 rounded-md border transition-colors flex items-center justify-between gap-3 ${
                isSelected
                  ? 'bg-[#E8F1F6] dark:bg-[#102843] border-[#D95B35]'
                  : 'bg-white dark:bg-[#061321] border-slate-200 dark:border-[#1D3A57] hover:bg-slate-50 dark:hover:bg-[#102843]/60'
              }`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <span
                  className="w-3 h-3 rounded-xs shrink-0"
                  style={{ backgroundColor: meta.colorHex }}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                    {seg.tier === 'unverifiable' ? meta.label : `Risco ${meta.label}`}{' '}
                    <span className="font-mono font-normal text-slate-500 dark:text-slate-400">
                      ({meta.range})
                    </span>
                  </div>
                </div>
              </div>
              <div className="text-right shrink-0 font-mono tabular-nums text-xs">
                <span className="font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                  {seg.count}
                </span>
                <span className="text-slate-500 dark:text-slate-400 ml-1.5">
                  ({seg.pct.toFixed(1)}%)
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RiskStackedBarChart({
  groups,
  selectedGroupKey,
  onSelectGroup,
}: {
  groups: RiskGroupBreakdown[];
  selectedGroupKey: string | null;
  onSelectGroup: (key: string | null) => void;
}) {
  if (groups.length === 0) {
    return (
      <div className="py-10 text-center text-xs text-slate-500 dark:text-slate-400">
        Nenhum grupo de entidade ou setor encontrado no período selecionado.
      </div>
    );
  }

  const maxTotal = Math.max(1, ...groups.map((g) => g.total));

  return (
    <div className="space-y-3" data-testid="risk-bar-chart">
      {groups.slice(0, 10).map((group) => {
        const isSelected = selectedGroupKey === group.key;
        const barWidthPct = Math.max(8, Math.round((group.total / maxTotal) * 100));
        const highPct = (group.high / group.total) * 100;
        const medPct = (group.medium / group.total) * 100;
        const lowPct = (group.low / group.total) * 100;
        const unvPct = (group.unverifiable / group.total) * 100;

        return (
          <button
            key={group.key}
            type="button"
            onClick={() => onSelectGroup(isSelected ? null : group.key)}
            aria-pressed={isSelected}
            className={`w-full text-left p-3 rounded-md border transition-colors space-y-2 ${
              isSelected
                ? 'bg-[#E8F1F6] dark:bg-[#102843] border-[#D95B35]'
                : 'bg-white dark:bg-[#061321] border-slate-200 dark:border-[#1D3A57] hover:bg-slate-50 dark:hover:bg-[#102843]/60'
            }`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-[#0B2540] dark:text-[#FAF9F5] truncate">
                  {group.label}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-x-2 mt-0.5">
                  {group.municipalityLabel && <span>{group.municipalityLabel}</span>}
                  {group.municipalityLabel && <span aria-hidden="true">·</span>}
                  <span>Setor: {group.sector}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    {group.totalValue > 0
                      ? formatCurrencyCompactBRL(group.totalValue)
                      : 'Valor não divulgado'}
                  </span>
                </div>
              </div>
              <div className="shrink-0 text-right font-mono tabular-nums text-xs">
                <span className="font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                  {group.total}
                </span>
                <span className="text-slate-500 dark:text-slate-400 ml-1">contrato(s)</span>
              </div>
            </div>

            <div className="w-full h-3 bg-slate-100 dark:bg-[#102843] rounded-xs overflow-hidden">
              <div
                className="h-full flex overflow-hidden rounded-xs"
                style={{ width: `${barWidthPct}%` }}
              >
                {group.high > 0 && (
                  <div
                    className="h-full bg-red-600"
                    style={{ width: `${highPct}%` }}
                    title={`Alto: ${group.high}`}
                  />
                )}
                {group.medium > 0 && (
                  <div
                    className="h-full bg-amber-500"
                    style={{ width: `${medPct}%` }}
                    title={`Médio: ${group.medium}`}
                  />
                )}
                {group.low > 0 && (
                  <div
                    className="h-full bg-emerald-600"
                    style={{ width: `${lowPct}%` }}
                    title={`Baixo: ${group.low}`}
                  />
                )}
                {group.unverifiable > 0 && (
                  <div
                    className="h-full bg-slate-500"
                    style={{ width: `${unvPct}%` }}
                    title={`Cobertura insuficiente: ${group.unverifiable}`}
                  />
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono tabular-nums">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-red-700 dark:text-red-400">Alto: {group.high}</span>
                <span className="text-amber-700 dark:text-amber-400">Médio: {group.medium}</span>
                <span className="text-emerald-700 dark:text-emerald-400">Baixo: {group.low}</span>
                <span className="text-slate-500 dark:text-slate-400">
                  Insuf.: {group.unverifiable}
                </span>
              </div>
              <span className="text-slate-500 dark:text-slate-400">
                Média {group.avgScore}/100 · Máx {group.maxScore}/100
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function TopHighRiskOrgansSection({
  organs,
  municipalities,
  selectedEntityKey,
  selectedMunicipalityIbge,
  onSelectOrgan,
  onSelectMunicipality,
}: {
  organs: TopRiskOrganEntry[];
  municipalities: TopRiskMunicipalityEntry[];
  selectedEntityKey: string | null;
  selectedMunicipalityIbge: string | null;
  onSelectOrgan: (organ: TopRiskOrganEntry) => void;
  onSelectMunicipality: (municipalityIbge: string) => void;
}) {
  const maxOrganHigh = Math.max(1, ...organs.map((o) => o.highRiskCount));
  const maxMunHigh = Math.max(
    1,
    ...municipalities.map((m) => Math.max(m.highRiskCount, m.mediumRiskCount))
  );

  return (
    <section
      data-testid="top-risk-organs"
      className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6 space-y-5"
    >
      <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2 pb-4 border-b border-slate-200 dark:border-[#1D3A57]">
        <div>
          <h2 className="text-base font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
            Top 5 Órgãos com Maior Risco
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Órgãos e municípios que concentram contratos classificados como Alto Risco (≥ 70/100)
            na base SQLite.
          </p>
        </div>
        <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
          Ordenado por volume de Alto Risco
        </span>
      </div>

      {organs.length === 0 ? (
        <div className="py-8 text-center text-xs text-slate-500 dark:text-slate-400">
          Nenhum órgão com contratos em faixa de risco elevado no período selecionado.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 space-y-2.5">
            <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Ranking de Órgãos / Secretarias (Top 5)
            </div>
            {organs.map((organ) => {
              const isSelected = selectedEntityKey === organ.entityKey;
              const barPct =
                organ.highRiskCount > 0
                  ? Math.max(18, Math.round((organ.highRiskCount / maxOrganHigh) * 100))
                  : Math.max(10, Math.round((organ.maxScore / 100) * 55));

              return (
                <button
                  key={organ.entityKey}
                  type="button"
                  onClick={() => onSelectOrgan(organ)}
                  aria-pressed={isSelected}
                  className={`w-full text-left p-3.5 rounded-md border transition-colors space-y-2 ${
                    isSelected
                      ? 'bg-red-50/70 dark:bg-red-950/30 border-red-600'
                      : 'bg-white dark:bg-[#061321] border-slate-200 dark:border-[#1D3A57] hover:bg-slate-50 dark:hover:bg-[#102843]/60'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <span className="font-mono tabular-nums text-xs font-bold text-slate-500 dark:text-slate-400 mt-0.5 shrink-0">
                        #{organ.rank}
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-[#0B2540] dark:text-[#FAF9F5] truncate">
                          {organ.entityName}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-x-2 mt-0.5">
                          <span className="font-medium text-slate-700 dark:text-slate-300">
                            {organ.municipalityName}
                            {organ.uf ? `/${organ.uf}` : ''}
                          </span>
                          {organ.municipalityIbge && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums">
                                IBGE {organ.municipalityIbge}
                              </span>
                            </>
                          )}
                          <span aria-hidden="true">·</span>
                          <span>{organ.sector}</span>
                        </div>
                      </div>
                    </div>

                    <div className="text-right shrink-0 font-mono tabular-nums">
                      <div
                        className={`text-xs font-bold ${
                          organ.highRiskCount > 0
                            ? 'text-red-700 dark:text-red-400'
                            : 'text-amber-700 dark:text-amber-400'
                        }`}
                      >
                        {organ.highRiskCount} Alto Risco
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                        {organ.highRiskValue > 0
                          ? formatCurrencyCompactBRL(organ.highRiskValue)
                          : formatCurrencyCompactBRL(organ.totalValue)}
                      </div>
                    </div>
                  </div>

                  <div className="w-full h-2 bg-slate-100 dark:bg-[#102843] rounded-xs overflow-hidden">
                    <div
                      className={`h-full rounded-xs ${
                        organ.highRiskCount > 0 ? 'bg-red-600' : 'bg-amber-500'
                      }`}
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                </button>
              );
            })}
          </div>

          <div className="lg:col-span-5 space-y-2.5 lg:border-l lg:border-slate-200 dark:lg:border-[#1D3A57] lg:pl-6">
            <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Municípios com Maior Concentração de Alto Risco
            </div>
            {municipalities.map((mun) => {
              const isSelected = selectedMunicipalityIbge === mun.municipalityIbge;
              const barPct =
                mun.highRiskCount > 0
                  ? Math.max(16, Math.round((mun.highRiskCount / maxMunHigh) * 100))
                  : Math.max(8, Math.round((mun.mediumRiskCount / maxMunHigh) * 100));

              return (
                <button
                  key={mun.municipalityIbge || mun.municipalityName}
                  type="button"
                  onClick={() => onSelectMunicipality(mun.municipalityIbge)}
                  aria-pressed={isSelected}
                  className={`w-full text-left p-3.5 rounded-md border transition-colors space-y-2 ${
                    isSelected
                      ? 'bg-red-50/70 dark:bg-red-950/30 border-red-600'
                      : 'bg-white dark:bg-[#061321] border-slate-200 dark:border-[#1D3A57] hover:bg-slate-50 dark:hover:bg-[#102843]/60'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-[#0B2540] dark:text-[#FAF9F5] truncate">
                        {mun.rank}. {mun.municipalityName}
                        {mun.uf ? ` — ${mun.uf}` : ''}
                      </div>
                      <div className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400 mt-0.5">
                        {mun.municipalityIbge ? `IBGE ${mun.municipalityIbge} · ` : ''}
                        {mun.totalContracts} contrato(s)
                      </div>
                    </div>
                    <div className="text-right shrink-0 font-mono tabular-nums">
                      <span
                        className={`text-xs font-bold ${
                          mun.highRiskCount > 0
                            ? 'text-red-700 dark:text-red-400'
                            : 'text-amber-700 dark:text-amber-400'
                        }`}
                      >
                        {mun.highRiskCount} Alto
                      </span>
                    </div>
                  </div>
                  <div className="w-full h-2 bg-slate-100 dark:bg-[#102843] rounded-xs overflow-hidden">
                    <div
                      className={`h-full rounded-xs ${
                        mun.highRiskCount > 0 ? 'bg-red-600' : 'bg-amber-500'
                      }`}
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

export function RiskDashboardView({
  startDate,
  endDate,
  onPeriodChange,
  onSelectContract,
}: RiskDashboardViewProps) {
  const [data, setData] = useState<RiskDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [groupMode, setGroupMode] = useState<'entity' | 'sector'>('entity');
  const [selectedTier, setSelectedTier] = useState<RiskTier | 'ALL'>('ALL');
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  const [selectedMunicipalityIbge, setSelectedMunicipalityIbge] = useState<string | null>(null);

  const periodValidation = validateDatePeriod(startDate, endDate);

  const loadDashboard = async () => {
    if (!periodValidation.valid) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchRiskDashboardSummary({
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      });
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar painel de riscos.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDashboard();
  }, [startDate, endDate]);

  useEffect(() => {
    setSelectedGroupKey(null);
  }, [groupMode]);

  const activeGroups = data
    ? groupMode === 'entity'
      ? data.summary.byEntity
      : data.summary.bySector
    : [];

  const filteredContracts = (data?.contracts ?? []).filter((contract) => {
    const tier = classifyRiskTier(
      contract.assessment.score,
      contract.assessment.coverageStatus
    );
    if (selectedTier !== 'ALL' && tier !== selectedTier) {
      return false;
    }
    if (selectedMunicipalityIbge && contract.municipalityIbge !== selectedMunicipalityIbge) {
      return false;
    }
    if (selectedGroupKey) {
      if (groupMode === 'entity') {
        const key = `${contract.municipalityIbge}::${(
          contract.entityName.trim() || 'Órgão não identificado'
        ).toLowerCase()}`;
        if (key !== selectedGroupKey) return false;
      } else {
        if (inferContractSector(contract) !== selectedGroupKey) return false;
      }
    }
    return true;
  });

  const handleSelectTopOrgan = (organ: TopRiskOrganEntry) => {
    setSelectedMunicipalityIbge(null);
    setGroupMode('entity');
    if (selectedGroupKey === organ.entityKey) {
      setSelectedGroupKey(null);
      setSelectedTier('ALL');
    } else {
      setSelectedGroupKey(organ.entityKey);
      if (organ.highRiskCount > 0) {
        setSelectedTier('high');
      }
    }
  };

  const handleSelectTopMunicipality = (ibge: string) => {
    setSelectedGroupKey(null);
    setSelectedMunicipalityIbge((prev) => (prev === ibge ? null : ibge));
  };

  const dist = data?.summary.distribution;

  return (
    <div className="space-y-6">
      <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-[#0B2540] dark:text-[#FAF9F5]">
              Dashboard de Riscos dos Contratos (SQLite)
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-300 mt-1 max-w-3xl">
              Visão agregada dos contratos auditados e persistidos no SQLite local, separando
              explicitamente contratos com <strong>Cobertura insuficiente</strong> das faixas
              verificáveis (Baixo, Médio e Alto risco).
            </p>
          </div>
          <button
            type="button"
            onClick={loadDashboard}
            disabled={loading || !periodValidation.valid}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#0B2540] dark:text-[#FAF9F5] bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] hover:bg-[#E8F1F6] dark:hover:bg-[#102843] rounded-md transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            Atualizar Painel
          </button>
        </div>

        <div className="pt-4 border-t border-slate-200 dark:border-[#1D3A57] grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          <div className="lg:col-span-7">
            <DatePeriodControls
              idPrefix="dashboard"
              startDate={startDate}
              endDate={endDate}
              onStartDateChange={(val) => onPeriodChange({ startDate: val, endDate })}
              onEndDateChange={(val) => onPeriodChange({ startDate, endDate: val })}
              showPresets
            />
          </div>
          <div className="lg:col-span-5">
            <label
              htmlFor="dashboard-secretaria-filter"
              className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1"
            >
              Secretaria / Órgão
            </label>
            <select
              id="dashboard-secretaria-filter"
              data-testid="dashboard-secretaria-select"
              value={groupMode === 'entity' ? selectedGroupKey ?? '' : ''}
              onChange={(e) => {
                const nextKey = e.target.value;
                setSelectedMunicipalityIbge(null);
                setGroupMode('entity');
                setSelectedGroupKey(nextKey || null);
              }}
              className="w-full h-10 px-3 text-sm bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md text-[#0B2540] dark:text-[#FAF9F5] focus:outline-none focus:ring-2 focus:ring-[#D95B35]"
            >
              <option value="">
                Todas as secretarias / órgãos ({data?.summary.totalContracts ?? 0})
              </option>
              {[...(data?.summary.byEntity ?? [])]
                .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'))
                .map((ent) => (
                  <option key={ent.key} value={ent.key}>
                    {ent.label}
                    {ent.municipalityLabel ? ` — ${ent.municipalityLabel}` : ''} ({ent.total})
                  </option>
                ))}
            </select>
          </div>
        </div>
      </section>

      {error && (
        <div
          role="alert"
          className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-lg p-4 text-sm text-red-800 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-8 animate-pulse space-y-4">
          <div className="h-5 w-56 bg-slate-200 dark:bg-[#102843] rounded" />
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-6">
            {[1, 2, 3, 4, 5].map((n) => (
              <div key={n} className="space-y-2">
                <div className="h-3 w-24 bg-slate-100 dark:bg-[#102843] rounded" />
                <div className="h-7 w-20 bg-slate-200 dark:bg-[#102843] rounded" />
              </div>
            ))}
          </div>
        </div>
      ) : data && dist ? (
        <>
          {/* 5-column KPI Strip separating Cobertura Insuficiente from Baixo Risco */}
          <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6">
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-6">
              <div>
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Contratos no Período
                </div>
                <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-[#0B2540] dark:text-[#FAF9F5]">
                  {data.summary.totalContracts}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                  SQLite: {data.totalStoredInSqlite} · {formatCurrencyCompactBRL(data.summary.totalValue)}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Risco Alto (≥ 70)
                </div>
                <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-red-700 dark:text-red-400">
                  {dist.high}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Revisão prioritária
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Risco Médio (40–69)
                </div>
                <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-amber-700 dark:text-amber-400">
                  {dist.medium}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Pontos de atenção
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Risco Baixo (&lt; 40)
                </div>
                <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                  {dist.low}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Com cobertura verificável
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Cobertura Insuficiente
                </div>
                <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-slate-600 dark:text-slate-300">
                  {dist.unverifiable}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Sem dados suficientes
                </div>
              </div>
            </div>
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <section className="lg:col-span-5 bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6 space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                    Distribuição Geral de Risco
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Clique em uma fatia ou faixa para filtrar a lista de contratos abaixo.
                  </p>
                </div>
                {selectedTier !== 'ALL' && (
                  <button
                    type="button"
                    onClick={() => setSelectedTier('ALL')}
                    className="text-xs font-medium text-[#D95B35] hover:underline whitespace-nowrap"
                  >
                    Limpar faixa
                  </button>
                )}
              </div>

              <RiskPieChart
                low={dist.low}
                medium={dist.medium}
                high={dist.high}
                unverifiable={dist.unverifiable}
                activeTier={selectedTier}
                onSelectTier={setSelectedTier}
              />
            </section>

            <section className="lg:col-span-7 bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                    Distribuição de Riscos por {groupMode === 'entity' ? 'Entidade' : 'Setor'}
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Barras empilhadas (Alto, Médio, Baixo e Cobertura insuficiente).
                  </p>
                </div>

                <div
                  role="group"
                  aria-label="Agrupamento do gráfico de barras"
                  className="inline-flex items-center gap-1 p-1 bg-slate-100 dark:bg-[#061321] rounded-md self-start"
                >
                  <button
                    type="button"
                    onClick={() => setGroupMode('entity')}
                    className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                      groupMode === 'entity'
                        ? 'bg-white dark:bg-[#102843] text-[#0B2540] dark:text-[#FAF9F5] shadow-xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-[#0B2540] dark:hover:text-white'
                    }`}
                  >
                    Por Entidade
                  </button>
                  <button
                    type="button"
                    onClick={() => setGroupMode('sector')}
                    className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                      groupMode === 'sector'
                        ? 'bg-white dark:bg-[#102843] text-[#0B2540] dark:text-[#FAF9F5] shadow-xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-[#0B2540] dark:hover:text-white'
                    }`}
                  >
                    Por Setor
                  </button>
                </div>
              </div>

              <RiskStackedBarChart
                groups={activeGroups}
                selectedGroupKey={selectedGroupKey}
                onSelectGroup={setSelectedGroupKey}
              />
            </section>
          </div>

          <TopHighRiskOrgansSection
            organs={data.summary.topHighRiskOrgans ?? []}
            municipalities={data.summary.topHighRiskMunicipalities ?? []}
            selectedEntityKey={groupMode === 'entity' ? selectedGroupKey : null}
            selectedMunicipalityIbge={selectedMunicipalityIbge}
            onSelectOrgan={handleSelectTopOrgan}
            onSelectMunicipality={handleSelectTopMunicipality}
          />

          {/* Drilldown Contracts Table */}
          <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 dark:border-[#1D3A57] flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                  Contratos Persistidos no SQLite ({filteredContracts.length})
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {selectedTier !== 'ALL' || selectedGroupKey || selectedMunicipalityIbge
                    ? 'Filtro interativo aplicado pelos gráficos acima.'
                    : 'Todos os contratos auditados no período selecionado.'}
                </p>
              </div>
              {(selectedTier !== 'ALL' || selectedGroupKey || selectedMunicipalityIbge) && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedTier('ALL');
                    setSelectedGroupKey(null);
                    setSelectedMunicipalityIbge(null);
                  }}
                  className="text-xs font-semibold text-[#D95B35] hover:underline whitespace-nowrap"
                >
                  Limpar filtros dos gráficos
                </button>
              )}
            </div>

            {filteredContracts.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                {data.totalStoredInSqlite === 0
                  ? 'Nenhum contrato salvo no SQLite ainda. Consulte um município, pesquise um CNPJ ou envie um documento PDF para popular o painel.'
                  : 'Nenhum contrato localizado para os filtros e período aplicados.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1D3A57] bg-[#FAF9F5] dark:bg-[#061321] text-xs font-medium text-slate-500 dark:text-slate-400">
                      <th className="py-3 px-4 whitespace-nowrap">Contrato / Data</th>
                      <th className="py-3 px-4">Entidade e Setor</th>
                      <th className="py-3 px-4">Fornecedor</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Valor Atualizado</th>
                      <th className="py-3 px-4 whitespace-nowrap">Risco / Cobertura</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Ação</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-[#1D3A57] text-sm">
                    {filteredContracts.map((contract) => {
                      const tier = classifyRiskTier(
                        contract.assessment.score,
                        contract.assessment.coverageStatus
                      );
                      return (
                        <tr
                          key={contract.id}
                          className="hover:bg-[#FAF9F5] dark:hover:bg-[#102843]/50 transition-colors"
                        >
                          <td className="py-3 px-4 align-top whitespace-nowrap">
                            <div className="font-mono font-semibold text-[#0B2540] dark:text-[#FAF9F5] tabular-nums">
                              {contract.contractNumber}
                            </div>
                            <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 mt-0.5">
                              {formatDateBR(contract.signatureDate || contract.startDate)}
                            </div>
                          </td>
                          <td className="py-3 px-4 align-top max-w-md">
                            <div className="text-xs font-semibold text-[#0B2540] dark:text-slate-200">
                              {contract.entityName}
                            </div>
                            <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                              {contract.municipalityName}
                              {contract.uf ? `/${contract.uf}` : ''} · Setor:{' '}
                              {inferContractSector(contract)}
                            </div>
                          </td>
                          <td className="py-3 px-4 align-top">
                            <div className="text-xs font-medium text-[#0B2540] dark:text-[#FAF9F5]">
                              {contract.supplier.legalName}
                            </div>
                            {contract.supplier.cnpj && contract.supplier.cnpj !== '00000000000000' && (
                              <div className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400 mt-0.5">
                                {formatCnpj(contract.supplier.cnpj)}
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-4 align-top text-right whitespace-nowrap font-mono tabular-nums text-xs font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                            {contract.updatedValue > 0
                              ? formatCurrencyBRL(contract.updatedValue)
                              : 'Não divulgado'}
                          </td>
                          <td className="py-3 px-4 align-top whitespace-nowrap">
                            <RiskScoreInline
                              score={contract.assessment.score}
                              coverageStatus={contract.assessment.coverageStatus}
                            />
                            <div className={`text-[11px] font-medium mt-0.5 ${TIER_META[tier].textClass}`}>
                              {tier === 'unverifiable' ? TIER_META[tier].label : `Faixa ${TIER_META[tier].label}`}
                            </div>
                          </td>
                          <td className="py-3 px-4 align-top text-right whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => onSelectContract(contract)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#0B2540] dark:text-[#FAF9F5] bg-[#E8F1F6] dark:bg-[#102843] hover:opacity-90 rounded-md transition-colors whitespace-nowrap"
                            >
                              Abrir Dossiê
                              <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { ArrowRight, RefreshCw } from 'lucide-react';
import type { EvaluatedContract } from '../types/audit';
import { fetchRiskDashboardSummary, type RiskDashboardResponse } from '../lib/api';
import {
  classifyRiskTier,
  inferContractSector,
  type RiskGroupBreakdown,
  type RiskTier,
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
    textClass: 'text-red-700',
    barClass: 'bg-red-600',
  },
  medium: {
    label: 'Médio',
    range: '40–69/100',
    colorHex: '#D97706',
    textClass: 'text-amber-700',
    barClass: 'bg-amber-500',
  },
  low: {
    label: 'Baixo',
    range: '< 40/100',
    colorHex: '#16A34A',
    textClass: 'text-emerald-700',
    barClass: 'bg-emerald-600',
  },
};

function RiskPieChart({
  low,
  medium,
  high,
  activeTier,
  onSelectTier,
}: {
  low: number;
  medium: number;
  high: number;
  activeTier: RiskTier | 'ALL';
  onSelectTier: (tier: RiskTier | 'ALL') => void;
}) {
  const total = low + medium + high;
  const radius = 64;
  const strokeWidth = 22;
  const circumference = 2 * Math.PI * radius;

  const segments: Array<{ tier: RiskTier; count: number; pct: number; length: number; offset: number }> = [];
  const ordered: Array<{ tier: RiskTier; count: number }> = [
    { tier: 'high', count: high },
    { tier: 'medium', count: medium },
    { tier: 'low', count: low },
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
          aria-label={`Distribuição de risco: ${high} alto, ${medium} médio, ${low} baixo`}
        >
          <circle
            cx="90"
            cy="90"
            r={radius}
            fill="none"
            stroke="#E2E8F0"
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
          <span className="font-mono tabular-nums text-2xl font-bold text-slate-900">
            {total}
          </span>
          <span className="text-[11px] text-slate-500">contrato(s)</span>
        </div>
      </div>

      <div className="flex-1 w-full space-y-2.5">
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
                  ? 'bg-slate-100 border-slate-400'
                  : 'bg-white border-slate-200 hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <span
                  className="w-3 h-3 rounded-xs shrink-0"
                  style={{ backgroundColor: meta.colorHex }}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-900">
                    Risco {meta.label}{' '}
                    <span className="font-mono font-normal text-slate-500">({meta.range})</span>
                  </div>
                </div>
              </div>
              <div className="text-right shrink-0 font-mono tabular-nums text-xs">
                <span className="font-semibold text-slate-900">{seg.count}</span>
                <span className="text-slate-500 ml-1.5">({seg.pct.toFixed(1)}%)</span>
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
      <div className="py-10 text-center text-xs text-slate-500">
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

        return (
          <button
            key={group.key}
            type="button"
            onClick={() => onSelectGroup(isSelected ? null : group.key)}
            aria-pressed={isSelected}
            className={`w-full text-left p-3 rounded-md border transition-colors space-y-2 ${
              isSelected
                ? 'bg-blue-50/70 border-blue-600'
                : 'bg-white border-slate-200 hover:bg-slate-50'
            }`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-900 truncate">
                  {group.label}
                </div>
                <div className="text-[11px] text-slate-500 flex flex-wrap items-center gap-x-2 mt-0.5">
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
                <span className="font-semibold text-slate-900">{group.total}</span>
                <span className="text-slate-500 ml-1">contrato(s)</span>
              </div>
            </div>

            {/* Proportional stacked bar */}
            <div className="w-full h-3 bg-slate-100 rounded-xs overflow-hidden">
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
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono tabular-nums">
              <div className="flex items-center gap-3">
                <span className="text-red-700">Alto: {group.high}</span>
                <span className="text-amber-700">Médio: {group.medium}</span>
                <span className="text-emerald-700">Baixo: {group.low}</span>
              </div>
              <span className="text-slate-500">
                Média {group.avgScore}/100 · Máx {group.maxScore}/100
              </span>
            </div>
          </button>
        );
      })}
    </div>
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
    if (selectedTier !== 'ALL' && classifyRiskTier(contract.assessment.score) !== selectedTier) {
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

  const dist = data?.summary.distribution;

  return (
    <div className="space-y-6">
      {/* Header + Always-Visible Period Filter */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              Dashboard de Riscos dos Contratos (SQLite)
            </h1>
            <p className="text-sm text-slate-600 mt-1 max-w-3xl">
              Visão agregada em tempo real de todos os contratos persistidos na base local SQLite
              (espelho municipal, consultas PNCP e documentos enviados), distribuídos por faixa de
              risco (Baixo, Médio e Alto) por entidade contratante ou setor.
            </p>
          </div>
          <button
            type="button"
            onClick={loadDashboard}
            disabled={loading || !periodValidation.valid}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            Atualizar Painel
          </button>
        </div>

        <div className="pt-4 border-t border-slate-200">
          <div className="max-w-xl">
            <DatePeriodControls
              idPrefix="dashboard"
              startDate={startDate}
              endDate={endDate}
              onStartDateChange={(val) => onPeriodChange({ startDate: val, endDate })}
              onEndDateChange={(val) => onPeriodChange({ startDate, endDate: val })}
              showPresets
            />
          </div>
        </div>
      </section>

      {error && (
        <div role="alert" className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="bg-white border border-slate-200 rounded-lg p-8 animate-pulse space-y-4">
          <div className="h-5 w-56 bg-slate-200 rounded" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="space-y-2">
                <div className="h-3 w-24 bg-slate-100 rounded" />
                <div className="h-7 w-20 bg-slate-200 rounded" />
              </div>
            ))}
          </div>
        </div>
      ) : data && dist ? (
        <>
          {/* 4-column KPI Strip */}
          <section className="bg-white border border-slate-200 rounded-lg p-6">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
              <div>
                <div className="text-xs font-medium text-slate-500">Contratos no Período</div>
                <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-slate-900">
                  {data.summary.totalContracts}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 font-mono tabular-nums">
                  Base SQLite: {data.totalStoredInSqlite} contrato(s) ·{' '}
                  {formatCurrencyCompactBRL(data.summary.totalValue)}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-slate-500">Risco Alto (≥ 70)</div>
                <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-red-700">
                  {dist.high}
                </div>
                <div className="mt-0.5 text-xs text-slate-500">
                  Revisão prioritária recomendada
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-slate-500">Risco Médio (40–69)</div>
                <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-amber-700">
                  {dist.medium}
                </div>
                <div className="mt-0.5 text-xs text-slate-500">
                  Pontos de atenção documentais
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-slate-500">Risco Baixo (&lt; 40)</div>
                <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-emerald-700">
                  {dist.low}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 font-mono tabular-nums">
                  Escore médio geral: {data.summary.avgScore}/100
                </div>
              </div>
            </div>
          </section>

          {/* Visual Charts Grid: Pie Chart + Stacked Bar Chart by Entity/Sector */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <section className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-6 space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    Distribuição Geral de Risco
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Clique em uma fatia ou faixa para filtrar a lista de contratos abaixo.
                  </p>
                </div>
                {selectedTier !== 'ALL' && (
                  <button
                    type="button"
                    onClick={() => setSelectedTier('ALL')}
                    className="text-xs font-medium text-blue-700 hover:text-blue-800 whitespace-nowrap"
                  >
                    Limpar faixa
                  </button>
                )}
              </div>

              <RiskPieChart
                low={dist.low}
                medium={dist.medium}
                high={dist.high}
                activeTier={selectedTier}
                onSelectTier={setSelectedTier}
              />

              {dist.insufficientCoverage > 0 && (
                <div className="pt-3 border-t border-slate-100 text-xs text-slate-600">
                  Nota: <strong className="font-mono">{dist.insufficientCoverage}</strong>{' '}
                  contrato(s) apresentam cobertura documental insuficiente e demandam fontes
                  adicionais para validação plena.
                </div>
              )}
            </section>

            <section className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-6 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    Distribuição de Riscos por {groupMode === 'entity' ? 'Entidade' : 'Setor'}
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Barras empilhadas (Alto, Médio e Baixo). Clique em uma barra para detalhar.
                  </p>
                </div>

                <div
                  role="group"
                  aria-label="Agrupamento do gráfico de barras"
                  className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-md self-start"
                >
                  <button
                    type="button"
                    onClick={() => setGroupMode('entity')}
                    className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                      groupMode === 'entity'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Por Entidade
                  </button>
                  <button
                    type="button"
                    onClick={() => setGroupMode('sector')}
                    className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                      groupMode === 'sector'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
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

          {/* Drilldown Contracts Table */}
          <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Contratos Persistidos no SQLite ({filteredContracts.length})
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {selectedTier !== 'ALL' || selectedGroupKey
                    ? 'Filtro interativo aplicado pelos gráficos acima.'
                    : 'Exibindo todos os contratos salvos no período selecionado, ordenados por risco.'}
                </p>
              </div>
              {(selectedTier !== 'ALL' || selectedGroupKey) && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedTier('ALL');
                    setSelectedGroupKey(null);
                  }}
                  className="text-xs font-semibold text-blue-700 hover:text-blue-800 whitespace-nowrap"
                >
                  Limpar filtros dos gráficos
                </button>
              )}
            </div>

            {filteredContracts.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                Nenhum contrato localizado para os filtros e período aplicados.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                      <th className="py-3 px-4 whitespace-nowrap">Contrato / Data</th>
                      <th className="py-3 px-4">Entidade e Setor</th>
                      <th className="py-3 px-4">Fornecedor</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Valor Atualizado</th>
                      <th className="py-3 px-4 whitespace-nowrap">Risco</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Ação</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-sm">
                    {filteredContracts.map((contract) => {
                      const tier = classifyRiskTier(contract.assessment.score);
                      return (
                        <tr key={contract.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="py-3 px-4 align-top whitespace-nowrap">
                            <div className="font-mono font-semibold text-slate-900 tabular-nums">
                              {contract.contractNumber}
                            </div>
                            <div className="text-xs font-mono tabular-nums text-slate-500 mt-0.5">
                              {formatDateBR(contract.signatureDate || contract.startDate)}
                            </div>
                          </td>
                          <td className="py-3 px-4 align-top max-w-md">
                            <div className="text-xs font-semibold text-slate-800">
                              {contract.entityName}
                            </div>
                            <div className="text-xs text-slate-500 mt-0.5">
                              {contract.municipalityName}/{contract.uf} · Setor:{' '}
                              {inferContractSector(contract)}
                            </div>
                          </td>
                          <td className="py-3 px-4 align-top">
                            <div className="text-xs font-medium text-slate-900">
                              {contract.supplier.legalName}
                            </div>
                            <div className="text-[11px] font-mono tabular-nums text-slate-500 mt-0.5">
                              {formatCnpj(contract.supplier.cnpj)}
                            </div>
                          </td>
                          <td className="py-3 px-4 align-top text-right whitespace-nowrap font-mono tabular-nums text-xs font-semibold text-slate-900">
                            {contract.updatedValue > 0
                              ? formatCurrencyBRL(contract.updatedValue)
                              : 'Não divulgado'}
                          </td>
                          <td className="py-3 px-4 align-top whitespace-nowrap">
                            <RiskScoreInline score={contract.assessment.score} />
                            <div className={`text-[11px] font-medium mt-0.5 ${TIER_META[tier].textClass}`}>
                              Faixa {TIER_META[tier].label}
                            </div>
                          </td>
                          <td className="py-3 px-4 align-top text-right whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => onSelectContract(contract)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors whitespace-nowrap"
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

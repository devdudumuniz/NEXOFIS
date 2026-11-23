import { forwardRef, useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BarChart3, PieChart as PieChartIcon, Scale } from 'lucide-react';
import type { EvaluatedContract } from '@nexofis/shared/types/audit';
import {
  buildFinancialComparisonChartData,
  buildIndicatorWeightChartData,
  buildSeverityDistributionChartData,
  type IndicatorWeightDatum,
} from '../lib/dossierCharts';
import { formatCurrencyBRL, formatCurrencyCompactBRL } from '@nexofis/shared/lib/formatters';

interface DossierRiskChartsProps {
  contract: EvaluatedContract;
  dismissedFindings?: Record<string, unknown>;
}

export const DossierRiskCharts = forwardRef<HTMLDivElement, DossierRiskChartsProps>(
  function DossierRiskCharts({ contract, dismissedFindings }, ref) {
    const indicatorData = useMemo(
      () => buildIndicatorWeightChartData(contract, dismissedFindings),
      [contract, dismissedFindings]
    );
    const severityData = useMemo(
      () => buildSeverityDistributionChartData(contract, dismissedFindings),
      [contract, dismissedFindings]
    );
    const financialData = useMemo(
      () => buildFinancialComparisonChartData(contract),
      [contract]
    );

    const activeIndicatorsCount = indicatorData.filter((d) => !d.dismissed).length;
    const totalEffectiveWeight = indicatorData.reduce((acc, d) => acc + d.effectivePoints, 0);

    // If no indicators and no financial values, still render a clean methodological summary card
    const hasCharts = indicatorData.length > 0 || financialData.bars.length > 0;
    if (!hasCharts) {
      return null;
    }

    const indicatorChartHeight = Math.max(210, Math.min(340, indicatorData.length * 42 + 48));

    return (
      <section
        ref={ref}
        data-testid="dossier-risk-charts"
        aria-label="Painel visual de risco do dossiê"
        className="space-y-4"
      >
        <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
              Painel Gráfico de Risco e Execução (Incluído no PDF Consolidado)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Decomposição determinística dos achados acionados e comparativo entre obrigação
              contratada e execução financeira comprovada.
            </p>
          </div>
          <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 shrink-0">
            {activeIndicatorsCount} achado(s) ativo(s) · {Math.min(100, totalEffectiveWeight)}/100
            pts
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Chart 1: Indicator Risk Weight Breakdown */}
          {indicatorData.length > 0 && (
            <div
              data-pdf-chart-card="true"
              data-pdf-chart-title="Contribuicao de Risco por Indicador Forense (Pontos)"
              data-pdf-chart-subtitle="Peso efetivo de cada regra acionada apos eventuais descartes auditados"
              className="lg:col-span-7 bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-5 flex flex-col"
            >
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2 min-w-0">
                  <BarChart3 className="w-4 h-4 text-[#D95B35] shrink-0" aria-hidden="true" />
                  <h3 className="text-xs font-semibold text-[#0B2540] dark:text-[#FAF9F5] truncate">
                    Peso de Risco por Indicador (pts)
                  </h3>
                </div>
                <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 shrink-0">
                  Escala 0–100
                </span>
              </div>

              <div className="w-full text-slate-600 dark:text-slate-300" style={{ height: indicatorChartHeight }}>
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <BarChart
                    data={indicatorData}
                    layout="vertical"
                    margin={{ top: 4, right: 24, left: 4, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#94A3B8" strokeOpacity={0.25} />
                    <XAxis
                      type="number"
                      domain={[0, (dataMax: number) => Math.max(40, Math.ceil(dataMax / 10) * 10)]}
                      tick={{ fontSize: 11, fill: 'currentColor' }}
                      tickLine={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="axisLabel"
                      width={154}
                      tick={{ fontSize: 10.5, fill: 'currentColor' }}
                      tickLine={false}
                    />
                    <Tooltip
                      cursor={{ fill: 'rgba(148, 163, 184, 0.12)' }}
                      contentStyle={{
                        backgroundColor: '#0B2540',
                        borderColor: '#1D3A57',
                        borderRadius: '6px',
                        color: '#FAF9F5',
                        fontSize: '12px',
                      }}
                      itemStyle={{ color: '#FAF9F5' }}
                      formatter={(value, _name, props) => {
                        const row = props?.payload as IndicatorWeightDatum | undefined;
                        if (row?.dismissed) {
                          return [`0 pts (descartado; peso original ${row.weightPoints})`, row.fullTitle];
                        }
                        return [`+${String(value ?? 0)} pts`, row?.fullTitle ?? 'Peso'];
                      }}
                    />
                    <Bar
                      dataKey="effectivePoints"
                      name="Pontos ativos"
                      radius={[0, 4, 4, 0]}
                      barSize={20}
                      isAnimationActive={false}
                    >
                      {indicatorData.map((entry) => (
                        <Cell key={entry.findingId} fill={entry.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Chart 2: Severity Distribution Donut */}
          {severityData.length > 0 && (
            <div
              data-pdf-chart-card="true"
              data-pdf-chart-title="Distribuicao de Achados Ativos por Severidade"
              data-pdf-chart-subtitle="Quantidade e soma de pontos dos indicadores ativos por classe"
              className="lg:col-span-5 bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-5 flex flex-col"
            >
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2 min-w-0">
                  <PieChartIcon className="w-4 h-4 text-[#D95B35] shrink-0" aria-hidden="true" />
                  <h3 className="text-xs font-semibold text-[#0B2540] dark:text-[#FAF9F5] truncate">
                    Distribuição por Severidade
                  </h3>
                </div>
                <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 shrink-0">
                  {activeIndicatorsCount} ativo(s)
                </span>
              </div>

              <div className="w-full h-[180px]">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <PieChart>
                    <Pie
                      data={severityData}
                      dataKey="weightSum"
                      nameKey="label"
                      cx="50%"
                      cy="50%"
                      innerRadius={44}
                      outerRadius={72}
                      paddingAngle={2}
                      isAnimationActive={false}
                    >
                      {severityData.map((entry) => (
                        <Cell key={entry.severity} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#0B2540',
                        borderColor: '#1D3A57',
                        borderRadius: '6px',
                        color: '#FAF9F5',
                        fontSize: '12px',
                      }}
                      itemStyle={{ color: '#FAF9F5' }}
                      formatter={(value, name, props) => {
                        const row = props?.payload as { count?: number } | undefined;
                        return [
                          `${String(value ?? 0)} pts (${row?.count ?? 0} achado${row?.count === 1 ? '' : 's'})`,
                          String(name),
                        ];
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-2 pt-2 border-t border-slate-100 dark:border-[#1D3A57]">
                {severityData.map((entry) => (
                  <div
                    key={entry.severity}
                    className="flex items-center justify-between gap-2 text-xs px-2 py-1 rounded bg-[#FAF9F5] dark:bg-[#061321]"
                  >
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="w-2.5 h-2.5 rounded-xs shrink-0"
                        style={{ backgroundColor: entry.color }}
                        aria-hidden="true"
                      />
                      <span className="font-medium text-slate-700 dark:text-slate-200 truncate">
                        {entry.label}
                      </span>
                    </span>
                    <span className="font-mono tabular-nums text-[11px] text-slate-600 dark:text-slate-300 shrink-0">
                      {entry.count} ({entry.weightSum}p)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Chart 3: Financial Obligation vs Proven Execution Comparison */}
          {financialData.bars.length > 0 && (
            <div
              data-pdf-chart-card="true"
              data-pdf-chart-title="Comparativo Financeiro: Obrigacao Contratada vs. Execucao Comprovada"
              data-pdf-chart-subtitle={
                financialData.hasFinancialExecution
                  ? 'Nivel 1 (Original/Atualizado) separado de Nivel 2 (Empenhado/Liquidado/Pago)'
                  : 'Nivel 1 (Original/Atualizado) — execucao financeira Nivel 2 nao coletada na origem'
              }
              className="lg:col-span-12 bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-5"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <Scale className="w-4 h-4 text-[#D95B35] shrink-0" aria-hidden="true" />
                  <h3 className="text-xs font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                    Comparativo Financeiro (Nível 1 Obrigação × Nível 2 Execução Comprovada)
                  </h3>
                </div>
                {!financialData.hasFinancialExecution && (
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    Execução financeira não coletada — exibindo apenas valores contratuais
                  </span>
                )}
              </div>

              <div className="w-full h-[210px] text-slate-600 dark:text-slate-300">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <BarChart
                    data={financialData.bars}
                    margin={{ top: 8, right: 20, left: 12, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#94A3B8" strokeOpacity={0.25} />
                    <XAxis
                      dataKey="stage"
                      tick={{ fontSize: 11, fill: 'currentColor' }}
                      tickLine={false}
                    />
                    <YAxis
                      tickFormatter={(val) => formatCurrencyCompactBRL(Number(val))}
                      tick={{ fontSize: 10.5, fill: 'currentColor' }}
                      tickLine={false}
                      width={94}
                    />
                    <Tooltip
                      cursor={{ fill: 'rgba(148, 163, 184, 0.12)' }}
                      contentStyle={{
                        backgroundColor: '#0B2540',
                        borderColor: '#1D3A57',
                        borderRadius: '6px',
                        color: '#FAF9F5',
                        fontSize: '12px',
                      }}
                      itemStyle={{ color: '#FAF9F5' }}
                      formatter={(value) => [formatCurrencyBRL(Number(value ?? 0)), 'Valor']}
                    />
                    <Bar
                      dataKey="amount"
                      name="Valor (R$)"
                      radius={[4, 4, 0, 0]}
                      barSize={44}
                      isAnimationActive={false}
                    >
                      {financialData.bars.map((entry) => (
                        <Cell key={entry.stage} fill={entry.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      </section>
    );
  }
);

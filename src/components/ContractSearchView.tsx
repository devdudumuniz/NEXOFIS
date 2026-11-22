import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, FileUp, Info, Search, X } from 'lucide-react';
import type { EvaluatedContract, Municipality } from '../types/audit';
import { searchContracts, searchMunicipalities, type CnpjCoverageInfo } from '../lib/api';
import type { ParsedContractCode } from '../lib/pncpQueryParser';
import {
  CONTRACT_LIFECYCLE_LABELS,
  CONTRACT_LIFECYCLE_OPTIONS,
  resolveContractLifecycleStatus,
  type ContractLifecycleFilter,
} from '../lib/contractStatus';
import { formatCnpj, formatCurrencyBRL } from '../lib/formatters';
import { validateDatePeriod } from '../lib/datePeriod';
import { notificationService } from '../lib/notificationService';
import { DatePeriodControls } from './DatePeriodControls';
import { RiskScoreInline } from './RiskText';

export interface ContractSearchFilterState {
  query: string;
  ibgeFilter: string;
  municipalityInput: string;
  entityFilter?: string;
  yearFilter: string;
  statusFilter: ContractLifecycleFilter;
  startDate: string;
  endDate: string;
  minRisk: number;
}

interface ContractSearchViewProps {
  filterState?: ContractSearchFilterState;
  onFilterStateChange?: (next: ContractSearchFilterState) => void;
  onSelectContract: (contract: EvaluatedContract) => void;
  onNavigateToDocument?: () => void;
}

export function ContractSearchView({
  filterState,
  onFilterStateChange,
  onSelectContract,
  onNavigateToDocument,
}: ContractSearchViewProps) {
  const [query, setQuery] = useState(filterState?.query ?? '');
  const [ibgeFilter, setIbgeFilter] = useState(filterState?.ibgeFilter ?? '');
  const [municipalityInput, setMunicipalityInput] = useState(filterState?.municipalityInput ?? '');
  const [municipalitySuggestions, setMunicipalitySuggestions] = useState<Municipality[]>([]);
  const [showMunicipalityMenu, setShowMunicipalityMenu] = useState(false);
  const [entityFilter, setEntityFilter] = useState(filterState?.entityFilter ?? '');
  const [yearFilter, setYearFilter] = useState(filterState?.yearFilter ?? '');
  const [statusFilter, setStatusFilter] = useState<ContractLifecycleFilter>(
    filterState?.statusFilter ?? ''
  );
  const [startDate, setStartDate] = useState(filterState?.startDate ?? '');
  const [endDate, setEndDate] = useState(filterState?.endDate ?? '');
  const [minRisk, setMinRisk] = useState<number>(filterState?.minRisk ?? 0);

  const [results, setResults] = useState<EvaluatedContract[]>([]);
  const [relatedResults, setRelatedResults] = useState<EvaluatedContract[]>([]);
  const [disambiguationRequired, setDisambiguationRequired] = useState(false);
  const [parsedReference, setParsedReference] = useState<{
    orgaoCnpj?: string;
    year?: string;
    sequential?: string;
    sourceHost?: string;
  } | null>(null);
  const [parsedContractCode, setParsedContractCode] = useState<ParsedContractCode | null>(null);
  const [livePncpStatus, setLivePncpStatus] = useState<{
    queried: boolean;
    municipalityLabel?: string;
    totalLiveRecords: number;
    inexigibilidadeCount: number;
    message: string;
  } | null>(null);
  const [cnpjCoverage, setCnpjCoverage] = useState<CnpjCoverageInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onFilterStateChange?.({
      query,
      ibgeFilter,
      municipalityInput,
      entityFilter,
      yearFilter,
      statusFilter,
      startDate,
      endDate,
      minRisk,
    });
  }, [
    query,
    ibgeFilter,
    municipalityInput,
    entityFilter,
    yearFilter,
    statusFilter,
    startDate,
    endDate,
    minRisk,
  ]);

  // Live IBGE autocomplete for all Brazilian municipalities
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      searchMunicipalities(municipalityInput)
        .then((res) => {
          if (!cancelled) setMunicipalitySuggestions(res.results);
        })
        .catch(() => {});
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [municipalityInput]);

  const runSearch = async (override?: {
    q?: string;
    ibge?: string;
    year?: string;
    status?: ContractLifecycleFilter;
    startDate?: string;
    endDate?: string;
    minRisk?: number;
  }) => {
    const nextStart = override?.startDate !== undefined ? override.startDate : startDate;
    const nextEnd = override?.endDate !== undefined ? override.endDate : endDate;
    const nextStatus = override?.status !== undefined ? override.status : statusFilter;
    const periodCheck = validateDatePeriod(nextStart, nextEnd);
    if (!periodCheck.valid) {
      setError(periodCheck.error ?? 'Período de datas inválido.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await searchContracts({
        q: override?.q ?? query,
        ibge: override?.ibge ?? ibgeFilter,
        year: override?.year ?? yearFilter,
        status: nextStatus || undefined,
        startDate: nextStart || undefined,
        endDate: nextEnd || undefined,
        minRisk: override?.minRisk ?? minRisk,
      });
      setResults(res.results);
      setRelatedResults(res.relatedResults ?? []);
      setDisambiguationRequired(res.disambiguationRequired);
      setParsedReference(res.parsedReference ?? null);
      setParsedContractCode(res.parsedContractCode ?? null);
      setLivePncpStatus(res.livePncpStatus ?? null);
      setCnpjCoverage(res.cnpjCoverage ?? null);
      if (res.results.length > 0) {
        notificationService.notifyHighRiskBatch(res.results, {
          sourceLabel: 'Busca em Lote de Contratos',
          onOpenContract: onSelectContract,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao consultar contratos.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    runSearch();
  }, [ibgeFilter, yearFilter, statusFilter, startDate, endDate, minRisk]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    runSearch();
  };

  const handlePickMunicipality = (m: Municipality) => {
    setIbgeFilter(m.ibgeCode);
    setMunicipalityInput(`${m.name}/${m.uf} (${m.ibgeCode})`);
    setShowMunicipalityMenu(false);
  };

  const handleClearMunicipality = () => {
    setIbgeFilter('');
    setMunicipalityInput('');
    setShowMunicipalityMenu(false);
  };

  const handleResetFilters = () => {
    setQuery('');
    handleClearMunicipality();
    setEntityFilter('');
    setYearFilter('');
    setStatusFilter('');
    setStartDate('');
    setEndDate('');
    setMinRisk(0);
    runSearch({
      q: '',
      ibge: '',
      year: '',
      status: '',
      startDate: '',
      endDate: '',
      minRisk: 0,
    });
  };

  const secretariaOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of [...results, ...relatedResults]) {
      const name = (c.entityName || '').trim();
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    if (entityFilter && !counts.has(entityFilter)) {
      counts.set(entityFilter, 0);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }, [results, relatedResults, entityFilter]);

  const visibleResults = useMemo(
    () =>
      entityFilter
        ? results.filter((c) => (c.entityName || '').trim() === entityFilter)
        : results,
    [results, entityFilter]
  );

  const visibleRelatedResults = useMemo(
    () =>
      entityFilter
        ? relatedResults.filter((c) => (c.entityName || '').trim() === entityFilter)
        : relatedResults,
    [relatedResults, entityFilter]
  );

  const renderContractRow = (contract: EvaluatedContract) => {
    const valueOmitted = contract.originalValue === 0 && contract.updatedValue === 0;
    const lifecycleBucket = resolveContractLifecycleStatus(contract);
    const lifecycleLabel = CONTRACT_LIFECYCLE_LABELS[lifecycleBucket];
    const lifecycleColorClass =
      lifecycleBucket === 'suspenso'
        ? 'text-red-700 dark:text-red-400 font-semibold'
        : lifecycleBucket === 'concluido'
          ? 'text-slate-600 dark:text-slate-400 font-medium'
          : 'text-emerald-700 dark:text-emerald-400 font-medium';
    const roleLabel =
      contract.cnpjRole === 'fornecedor'
        ? 'Papel: Fornecedor'
        : contract.cnpjRole === 'orgao_contratante'
          ? 'Papel: Órgão Contratante'
          : contract.cnpjRole === 'subcontratado'
            ? 'Papel: Subcontratado'
            : null;

    return (
      <div
        key={contract.id}
        className="p-5 hover:bg-[#FAF9F5] dark:hover:bg-[#102843]/50 transition-colors flex flex-col lg:flex-row lg:items-center justify-between gap-4"
      >
        <div className="space-y-1.5 max-w-3xl">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
            <span className="font-mono font-semibold text-[#0B2540] dark:text-[#FAF9F5] text-sm">
              Contrato {contract.contractNumber}
            </span>
            <span className="text-slate-400" aria-hidden="true">·</span>
            <span className={lifecycleColorClass}>{lifecycleLabel}</span>
            <span className="text-slate-400" aria-hidden="true">·</span>
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {contract.municipalityName}
              {contract.uf ? `/${contract.uf}` : ''}
            </span>
            {contract.municipalityIbge && (
              <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">
                (IBGE {contract.municipalityIbge})
              </span>
            )}
            {contract.pncpControlNumber && (
              <>
                <span className="text-slate-400" aria-hidden="true">·</span>
                <span className="font-mono text-slate-500 dark:text-slate-400">
                  {contract.pncpControlNumber}
                </span>
              </>
            )}
          </div>

          <div className="text-xs font-medium text-slate-600 dark:text-slate-300">
            {contract.entityName} · {contract.modality}
            {roleLabel && (
              <>
                {' '}· <span className="font-mono text-[#D95B35]">{roleLabel}</span>
              </>
            )}
          </div>
          <p className="text-sm text-[#0B2540] dark:text-[#FAF9F5]">{contract.object}</p>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Fornecedor:{' '}
            <span className="text-[#0B2540] dark:text-slate-200 font-medium">
              {contract.supplier.legalName}
            </span>{' '}
            {contract.supplier.cnpj && contract.supplier.cnpj !== '00000000000000' && (
              <span className="font-mono tabular-nums">
                ({formatCnpj(contract.supplier.cnpj)}
                {cnpjCoverage?.relatedMatrizCnpj &&
                contract.supplier.cnpj === cnpjCoverage.relatedMatrizCnpj
                  ? ' · Matriz'
                  : cnpjCoverage?.relatedMatrizCnpj &&
                      contract.supplier.cnpj === cnpjCoverage.cnpj
                    ? ' · Filial'
                    : ''}
                )
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-row lg:flex-col items-center lg:items-end justify-between gap-2 shrink-0">
          <div className="text-left lg:text-right">
            <div className="font-mono tabular-nums font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
              {valueOmitted ? (
                <span className="text-amber-800 dark:text-amber-400 text-xs font-semibold">
                  Não divulgado
                </span>
              ) : (
                formatCurrencyBRL(contract.updatedValue)
              )}
            </div>
            <div className="mt-0.5 text-xs">
              <RiskScoreInline
                score={contract.assessment.score}
                coverageStatus={contract.assessment.coverageStatus}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => onSelectContract(contract)}
            aria-label={`Abrir dossiê do contrato ${contract.contractNumber}`}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#0B2540] hover:bg-[#102843] dark:bg-[#D95B35] dark:hover:bg-[#c04c29] rounded-md transition-colors whitespace-nowrap"
          >
            Abrir Dossiê
            <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6">
        <div className="mb-5">
          <h1 className="text-2xl font-bold tracking-tight text-[#0B2540] dark:text-[#FAF9F5]">
            Busca e Desambiguação de Contratos
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 mt-1 max-w-3xl">
            Consulte por número do contrato, URL oficial do PNCP ou CNPJ (formato numérico tradicional
            ou alfanumérico RFB 2026). Combine com município IBGE, período de datas e status de ciclo
            de vida.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-5">
            <label
              htmlFor="contract-q"
              className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1"
            >
              Nº do contrato, URL PNCP ou CNPJ (numérico ou alfanumérico)
            </label>
            <div className="relative">
              <Search
                className="w-4 h-4 text-slate-400 dark:text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                id="contract-q"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Digite número do contrato, URL do PNCP ou CNPJ"
                className="w-full h-10 pl-9 pr-3 text-sm bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] text-[#0B2540] dark:text-[#FAF9F5] placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-md focus:outline-none focus:ring-2 focus:ring-[#D95B35]"
              />
            </div>
          </div>

          <div className="md:col-span-3 relative">
            <label
              htmlFor="contract-ibge"
              className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1"
            >
              Município (IBGE + PNCP ao vivo)
            </label>
            <div className="relative">
              <input
                id="contract-ibge"
                type="text"
                value={municipalityInput}
                onFocus={() => setShowMunicipalityMenu(true)}
                onBlur={() => setTimeout(() => setShowMunicipalityMenu(false), 180)}
                onChange={(e) => {
                  const val = e.target.value;
                  setMunicipalityInput(val);
                  setShowMunicipalityMenu(true);
                  const digits = val.replace(/\D/g, '');
                  if (!val.trim()) {
                    setIbgeFilter('');
                  } else if (/^\d{7}$/.test(digits) && val.trim() === digits) {
                    setIbgeFilter(digits);
                  }
                }}
                placeholder="Todos · digite cidade ou IBGE"
                autoComplete="off"
                className="w-full h-10 px-3 pr-8 text-sm bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] text-[#0B2540] dark:text-[#FAF9F5] placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-md focus:outline-none focus:ring-2 focus:ring-[#D95B35]"
              />
              {(municipalityInput || ibgeFilter) && (
                <button
                  type="button"
                  onClick={handleClearMunicipality}
                  aria-label="Limpar filtro de município"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-[#0B2540] dark:hover:text-white"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              )}
            </div>

            {showMunicipalityMenu && municipalitySuggestions.length > 0 && (
              <ul
                role="listbox"
                aria-label="Municípios brasileiros (IBGE)"
                className="absolute z-20 left-0 right-0 mt-1 bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-md shadow-lg max-h-64 overflow-y-auto divide-y divide-slate-100 dark:divide-[#1D3A57]"
              >
                {municipalitySuggestions.map((m) => (
                  <li key={m.ibgeCode}>
                    <button
                      type="button"
                      onMouseDown={() => handlePickMunicipality(m)}
                      className="w-full text-left px-3 py-2 hover:bg-[#E8F1F6] dark:hover:bg-[#102843] flex items-center justify-between gap-2 text-xs transition-colors"
                    >
                      <span className="font-medium text-[#0B2540] dark:text-[#FAF9F5] truncate">
                        {m.name}{' '}
                        <span className="text-slate-500 dark:text-slate-400 font-normal">
                          / {m.uf}
                        </span>
                      </span>
                      <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400 shrink-0">
                        {m.ibgeCode}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="md:col-span-2">
            <label
              htmlFor="contract-year"
              className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1"
            >
              Exercício
            </label>
            <select
              id="contract-year"
              value={yearFilter}
              onChange={(e) => setYearFilter(e.target.value)}
              className="w-full h-10 px-3 text-sm bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] text-[#0B2540] dark:text-[#FAF9F5] rounded-md focus:outline-none focus:ring-2 focus:ring-[#D95B35]"
            >
              <option value="">Todos</option>
              <option value="2026">2026</option>
              <option value="2025">2025</option>
              <option value="2024">2024</option>
            </select>
          </div>

          <div className="md:col-span-2 flex items-end gap-2">
            <button
              type="submit"
              className="flex-1 h-10 px-4 text-sm font-semibold text-white bg-[#0B2540] hover:bg-[#102843] dark:bg-[#D95B35] dark:hover:bg-[#c04c29] rounded-md transition-colors whitespace-nowrap"
            >
              Pesquisar
            </button>
          </div>

          <div className="md:col-span-12 pt-3 border-t border-slate-100 dark:border-[#1D3A57] grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            <div className="lg:col-span-5">
              <DatePeriodControls
                idPrefix="contract-search"
                startDate={startDate}
                endDate={endDate}
                onStartDateChange={setStartDate}
                onEndDateChange={setEndDate}
                showPresets
              />
            </div>
            <div className="lg:col-span-4">
              <label
                htmlFor="contract-secretaria"
                className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1"
              >
                Secretaria / Órgão
              </label>
              <select
                id="contract-secretaria"
                data-testid="contract-secretaria-select"
                value={entityFilter}
                onChange={(e) => setEntityFilter(e.target.value)}
                className="w-full h-10 px-3 text-sm bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md text-[#0B2540] dark:text-[#FAF9F5] focus:outline-none focus:ring-2 focus:ring-[#D95B35]"
              >
                <option value="">
                  Todas as secretarias / órgãos ({results.length})
                </option>
                {secretariaOptions.map((opt) => (
                  <option key={opt.name} value={opt.name}>
                    {opt.name} ({opt.count})
                  </option>
                ))}
              </select>
            </div>
            <div className="lg:col-span-3 space-y-2">
              <div>
                <label
                  htmlFor="contract-status"
                  className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1"
                >
                  Status do contrato (ciclo de vida)
                </label>
                <select
                  id="contract-status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as ContractLifecycleFilter)}
                  className="w-full h-10 px-3 text-sm bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md text-[#0B2540] dark:text-[#FAF9F5] focus:outline-none focus:ring-2 focus:ring-[#D95B35]"
                >
                  {CONTRACT_LIFECYCLE_OPTIONS.map((opt) => (
                    <option key={opt.value || 'all'} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                <div
                  role="group"
                  aria-label="Filtro rápido de status do contrato"
                  className="flex flex-wrap items-center gap-x-3 gap-y-1"
                >
                  {CONTRACT_LIFECYCLE_OPTIONS.map((opt) => {
                    const active = statusFilter === opt.value;
                    return (
                      <button
                        key={opt.value || 'all-btn'}
                        type="button"
                        onClick={() => setStatusFilter(opt.value)}
                        aria-pressed={active}
                        className={`transition-colors whitespace-nowrap underline-offset-4 ${
                          active
                            ? 'text-[#D95B35] font-semibold underline'
                            : 'text-slate-700 dark:text-slate-300 hover:text-[#D95B35] hover:underline'
                        }`}
                      >
                        {opt.value === '' ? 'Todos' : opt.label}
                      </button>
                    );
                  })}
                </div>
                {(query ||
                  ibgeFilter ||
                  entityFilter ||
                  yearFilter ||
                  statusFilter ||
                  startDate ||
                  endDate) && (
                  <button
                    type="button"
                    onClick={handleResetFilters}
                    className="text-[#D95B35] font-medium hover:underline whitespace-nowrap"
                  >
                    Limpar filtros
                  </button>
                )}
              </div>
            </div>
          </div>
        </form>
      </section>

      {cnpjCoverage && (
        <section
          data-testid="cnpj-national-coverage"
          className={`border rounded-lg p-5 space-y-4 ${
            cnpjCoverage.pncpStatus === 'rate_limited' || cnpjCoverage.pncpStatus === 'unavailable'
              ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800'
              : 'bg-white dark:bg-[#0B1D31] border-slate-200 dark:border-[#1D3A57]'
          }`}
        >
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-3 pb-4 border-b border-slate-200 dark:border-[#1D3A57]">
            <div className="space-y-1">
              <div className="text-xs font-mono text-[#D95B35] font-semibold">
                BUSCA NACIONAL POR CNPJ · {formatCnpj(cnpjCoverage.cnpj)}
                {cnpjCoverage.relatedMatrizCnpj && (
                  <span className="text-slate-600 dark:text-slate-400 font-normal">
                    {' '}
                    + Matriz {formatCnpj(cnpjCoverage.relatedMatrizCnpj)}
                  </span>
                )}
              </div>
              <h2 className="text-base font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                {cnpjCoverage.legalName ?? `CNPJ ${formatCnpj(cnpjCoverage.cnpj)}`}
              </h2>
            </div>
            <div className="font-mono text-xs shrink-0 text-slate-700 dark:text-slate-300">
              PNCP:{' '}
              <strong
                className={
                  cnpjCoverage.pncpStatus === 'complete'
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-amber-800 dark:text-amber-400'
                }
              >
                {cnpjCoverage.pncpStatus.toUpperCase()}
              </strong>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
            <div>
              <div className="text-slate-500 dark:text-slate-400">Declarados no PNCP</div>
              <div className="font-mono tabular-nums text-lg font-semibold text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                {cnpjCoverage.pncpTotalDeclared}
              </div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">Capturados no PNCP</div>
              <div className="font-mono tabular-nums text-lg font-semibold text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                {cnpjCoverage.pncpFetchedCount}
              </div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">Como Fornecedor</div>
              <div className="font-mono tabular-nums text-lg font-semibold text-[#D95B35] mt-0.5">
                {cnpjCoverage.byRole.fornecedor}
              </div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">Como Órgão Contratante</div>
              <div className="font-mono tabular-nums text-lg font-semibold text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                {cnpjCoverage.byRole.orgao_contratante}
              </div>
            </div>
          </div>

          <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed pt-2 border-t border-slate-100 dark:border-[#1D3A57]">
            {cnpjCoverage.message}
          </p>
        </section>
      )}

      {parsedReference && (
        <div
          data-testid="pncp-url-parsed"
          className="bg-[#E8F1F6] dark:bg-[#102843] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-4 text-xs text-[#0B2540] dark:text-[#FAF9F5] leading-relaxed"
        >
          <span className="font-semibold">URL oficial interpretada localmente:</span> host{' '}
          <span className="font-mono">{parsedReference.sourceHost}</span>
          {parsedReference.orgaoCnpj && (
            <>
              {' '}· CNPJ do órgão <span className="font-mono">{parsedReference.orgaoCnpj}</span>
            </>
          )}
          {parsedReference.year && (
            <>
              {' '}· ano <span className="font-mono">{parsedReference.year}</span>
            </>
          )}
          {parsedReference.sequential && (
            <>
              {' '}· sequencial <span className="font-mono">{parsedReference.sequential}</span>
            </>
          )}
          {' '}(extração estática segura sem requisição direta à URL informada).
        </div>
      )}

      {parsedContractCode && (parsedContractCode.prefix || parsedContractCode.unitSuffix) && (
        <div
          data-testid="parsed-contract-code"
          className="bg-[#FAF9F5] dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-4 text-xs text-[#0B2540] dark:text-slate-200 leading-relaxed"
        >
          <span className="font-semibold">Código municipal interpretado:</span>{' '}
          <span className="font-mono font-semibold">{parsedContractCode.raw}</span>
          {parsedContractCode.modalityHint && (
            <>
              {' '}→ Modalidade provável:{' '}
              <span className="font-medium">{parsedContractCode.modalityHint}</span>
            </>
          )}
          {' '}· Sequencial normalizado{' '}
          <span className="font-mono">{parsedContractCode.normalizedNumber}</span>
          {parsedContractCode.unitHint && (
            <>
              {' '}· Unidade:{' '}
              <span className="font-medium">
                {parsedContractCode.unitHint} ({parsedContractCode.unitSuffix})
              </span>
            </>
          )}
        </div>
      )}

      {livePncpStatus && !cnpjCoverage && (
        <div
          data-testid="live-pncp-status"
          className="bg-[#E8F1F6] dark:bg-[#102843] border border-slate-200 dark:border-[#1D3A57] rounded-lg px-4 py-3 text-xs text-[#0B2540] dark:text-slate-200 flex items-start gap-2.5"
        >
          <Info className="w-4 h-4 text-[#D95B35] shrink-0 mt-0.5" aria-hidden="true" />
          <div>{livePncpStatus.message}</div>
        </div>
      )}

      {disambiguationRequired && (
        <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-4 flex items-start gap-3">
          <Info className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="text-xs text-amber-900 dark:text-amber-200 leading-relaxed">
            <span className="font-semibold">Desambiguação necessária:</span> o termo{' '}
            <span className="font-mono font-semibold">{query}</span> ocorre em{' '}
            {new Set(results.map((r) => r.municipalityIbge)).size} municípios distintos. Confirme o
            código IBGE, o órgão contratante e o número de controle PNCP antes de abrir o dossiê.
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-lg p-4 text-sm text-red-800 dark:text-red-300"
        >
          {error}
        </div>
      )}

      <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-[#1D3A57] flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
            Resultados Localizados ({visibleResults.length})
          </h2>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            SQLite local + consulta ao vivo na API do PNCP
          </span>
        </div>

        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
            Consultando repositório local e API oficial do PNCP...
          </div>
        ) : visibleResults.length === 0 ? (
          <div className="p-8 text-center space-y-3">
            <p className="text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
              Nenhum contrato localizado para os critérios informados.
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-300 max-w-xl mx-auto leading-relaxed">
              Informe um CNPJ (14 caracteres numéricos ou alfanuméricos) para consultar a API do
              PNCP em âmbito nacional, selecione um município IBGE ou importe um PDF / extrato na
              aba Documento para iniciar a auditoria.
            </p>
            {onNavigateToDocument && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={onNavigateToDocument}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#0B2540] dark:bg-[#D95B35] hover:opacity-90 rounded-md transition-colors"
                >
                  <FileUp className="w-3.5 h-3.5" aria-hidden="true" />
                  Enviar PDF / Extrato do Portal Municipal
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-[#1D3A57]">
            {visibleResults.map(renderContractRow)}
          </div>
        )}
      </section>

      {visibleResults.length === 0 && visibleRelatedResults.length > 0 && (
        <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-[#1D3A57]">
            <h2 className="text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
              Processos com numeração relacionada ({visibleRelatedResults.length})
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Contratos ou compras do mesmo sequencial/ano em outras modalidades.
            </p>
          </div>
          <div className="divide-y divide-slate-200 dark:divide-[#1D3A57]">
            {visibleRelatedResults.map(renderContractRow)}
          </div>
        </section>
      )}
    </div>
  );
}

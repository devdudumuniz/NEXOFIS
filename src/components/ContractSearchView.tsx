import { useEffect, useState } from 'react';
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
import { DatePeriodControls } from './DatePeriodControls';
import { RiskScoreInline } from './RiskText';

export interface ContractSearchFilterState {
  query: string;
  ibgeFilter: string;
  municipalityInput: string;
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
  const [query, setQuery] = useState(filterState?.query ?? '123/2026');
  const [ibgeFilter, setIbgeFilter] = useState(filterState?.ibgeFilter ?? '');
  const [municipalityInput, setMunicipalityInput] = useState(filterState?.municipalityInput ?? '');
  const [municipalitySuggestions, setMunicipalitySuggestions] = useState<Municipality[]>([]);
  const [showMunicipalityMenu, setShowMunicipalityMenu] = useState(false);
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
      yearFilter,
      statusFilter,
      startDate,
      endDate,
      minRisk,
    });
  }, [query, ibgeFilter, municipalityInput, yearFilter, statusFilter, startDate, endDate, minRisk]);

  // Live IBGE autocomplete for all 5,571 Brazilian municipalities
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

  const renderContractRow = (contract: EvaluatedContract) => {
    const valueOmitted = contract.originalValue === 0 && contract.updatedValue === 0;
    const lifecycleBucket = resolveContractLifecycleStatus(contract);
    const lifecycleLabel = CONTRACT_LIFECYCLE_LABELS[lifecycleBucket];
    const lifecycleColorClass =
      lifecycleBucket === 'suspenso'
        ? 'text-red-700 font-semibold'
        : lifecycleBucket === 'concluido'
          ? 'text-slate-600 font-medium'
          : 'text-emerald-700 font-medium';
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
        className="p-5 hover:bg-slate-50/70 transition-colors flex flex-col lg:flex-row lg:items-center justify-between gap-4"
      >
        <div className="space-y-1.5 max-w-3xl">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
            <span className="font-mono font-semibold text-slate-900 text-sm">
              Contrato {contract.contractNumber}
            </span>
            <span className="text-slate-400" aria-hidden="true">·</span>
            <span className={lifecycleColorClass}>{lifecycleLabel}</span>
            <span className="text-slate-400" aria-hidden="true">·</span>
            <span className="font-medium text-slate-700">
              {contract.municipalityName}/{contract.uf}
            </span>
            <span className="font-mono tabular-nums text-slate-500">
              (IBGE {contract.municipalityIbge})
            </span>
            <span className="text-slate-400" aria-hidden="true">·</span>
            <span className="font-mono text-slate-500">
              {contract.pncpControlNumber}
            </span>
          </div>

          <div className="text-xs font-medium text-slate-600">
            {contract.entityName} · {contract.modality}
            {roleLabel && (
              <>
                {' '}· <span className="font-mono text-blue-700">{roleLabel}</span>
              </>
            )}
          </div>
          <p className="text-sm text-slate-900">{contract.object}</p>
          <div className="text-xs text-slate-500">
            Fornecedor:{' '}
            <span className="text-slate-800 font-medium">{contract.supplier.legalName}</span>{' '}
            {contract.supplier.cnpj !== '00000000000000' && (
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
            <div className="font-mono tabular-nums font-semibold text-slate-900">
              {valueOmitted ? (
                <span className="text-amber-800 text-xs font-semibold">Não divulgado</span>
              ) : (
                formatCurrencyBRL(contract.updatedValue)
              )}
            </div>
            <div className="mt-0.5 text-xs">
              <RiskScoreInline score={contract.assessment.score} />
            </div>
          </div>
          <button
            type="button"
            onClick={() => onSelectContract(contract)}
            aria-label={`Abrir dossiê do contrato ${contract.contractNumber} de ${contract.municipalityName}`}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap"
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
      <section className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="mb-5">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Busca e Desambiguação de Contrato
          </h1>
          <p className="text-sm text-slate-600 mt-1 max-w-3xl">
            Informe o código municipal (ex.: <span className="font-mono text-slate-800">IN012/2026FMS</span>),
            cole uma <span className="font-mono text-slate-800">URL do PNCP / Transparência</span> ou
            busque pelo CNPJ do fornecedor. Selecione qualquer um dos 5.571 municípios do IBGE para
            consultar simultaneamente o espelho local e a API oficial do PNCP em tempo real.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-5">
            <label htmlFor="contract-q" className="block text-xs font-medium text-slate-600 mb-1">
              Nº do contrato, código municipal, URL PNCP ou CNPJ
            </label>
            <div className="relative">
              <Search
                className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                id="contract-q"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Ex.: IN012/2026FMS, 123/2026 ou URL do PNCP"
                className="w-full h-10 pl-9 pr-3 text-sm bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>
          </div>

          <div className="md:col-span-3 relative">
            <label htmlFor="contract-ibge" className="block text-xs font-medium text-slate-600 mb-1">
              Município (5.571 IBGE + PNCP ao vivo)
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
                className="w-full h-10 px-3 pr-8 text-sm bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
              {(municipalityInput || ibgeFilter) && (
                <button
                  type="button"
                  onClick={handleClearMunicipality}
                  aria-label="Limpar filtro de município"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              )}
            </div>

            {showMunicipalityMenu && municipalitySuggestions.length > 0 && (
              <ul
                role="listbox"
                aria-label="Municípios brasileiros (IBGE)"
                className="absolute z-20 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-md shadow-lg max-h-64 overflow-y-auto divide-y divide-slate-100"
              >
                {municipalitySuggestions.map((m) => (
                  <li key={m.ibgeCode}>
                    <button
                      type="button"
                      onMouseDown={() => handlePickMunicipality(m)}
                      className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between gap-2 text-xs transition-colors"
                    >
                      <span className="font-medium text-slate-900 truncate">
                        {m.name} <span className="text-slate-500 font-normal">/ {m.uf}</span>
                      </span>
                      <span className="font-mono tabular-nums text-slate-500 shrink-0">
                        {m.ibgeCode}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="md:col-span-2">
            <label htmlFor="contract-year" className="block text-xs font-medium text-slate-600 mb-1">
              Exercício
            </label>
            <select
              id="contract-year"
              value={yearFilter}
              onChange={(e) => setYearFilter(e.target.value)}
              className="w-full h-10 px-3 text-sm bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              <option value="">Todos</option>
              <option value="2026">2026</option>
              <option value="2025">2025</option>
            </select>
          </div>

          <div className="md:col-span-2 flex items-end">
            <button
              type="submit"
              className="w-full h-10 px-4 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap"
            >
              Pesquisar
            </button>
          </div>

          <div className="md:col-span-12 pt-3 border-t border-slate-100 grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            <div className="lg:col-span-7">
              <DatePeriodControls
                idPrefix="contract-search"
                startDate={startDate}
                endDate={endDate}
                onStartDateChange={setStartDate}
                onEndDateChange={setEndDate}
                showPresets
              />
            </div>
            <div className="lg:col-span-5 space-y-2">
              <div>
                <label
                  htmlFor="contract-status"
                  className="block text-xs font-medium text-slate-600 mb-1"
                >
                  Status do contrato (ciclo de vida)
                </label>
                <select
                  id="contract-status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as ContractLifecycleFilter)}
                  className="w-full h-10 px-3 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {CONTRACT_LIFECYCLE_OPTIONS.map((opt) => (
                    <option key={opt.value || 'all'} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div
                role="group"
                aria-label="Filtro rápido de status do contrato"
                className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500"
              >
                <span>Status rápido:</span>
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
                          ? 'text-blue-700 font-semibold underline'
                          : 'text-slate-700 hover:text-blue-700 hover:underline'
                      }`}
                    >
                      {opt.value === '' ? 'Todos' : opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </form>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500">
          <span>Consultas rápidas:</span>
          <button
            type="button"
            onClick={() => {
              setQuery('10.562.589/0002-56');
              handleClearMunicipality();
              setYearFilter('');
              setStatusFilter('');
              setStartDate('');
              setEndDate('');
              runSearch({
                q: '10.562.589/0002-56',
                ibge: '',
                year: '',
                status: '',
                startDate: '',
                endDate: '',
              });
            }}
            className="text-blue-700 font-semibold hover:text-blue-800 underline underline-offset-4"
          >
            CNPJ Nacional: WM Saúde (10.562.589/0002-56 · Filial + Matriz)
          </button>
          <button
            type="button"
            onClick={() => {
              setQuery('08.562.959/0001-22');
              handleClearMunicipality();
              setYearFilter('');
              setStartDate('');
              setEndDate('');
              runSearch({ q: '08.562.959/0001-22', ibge: '', year: '', startDate: '', endDate: '' });
            }}
            className="text-blue-700 font-medium hover:text-blue-800 underline underline-offset-4"
          >
            CNPJ Nacional: Plenna (08.562.959/0001-22)
          </button>
          <button
            type="button"
            onClick={() => {
              setQuery('13.265.251/0002-20');
              handleClearMunicipality();
              setYearFilter('');
              setStartDate('');
              setEndDate('');
              runSearch({ q: '13.265.251/0002-20', ibge: '', year: '', startDate: '', endDate: '' });
            }}
            className="text-blue-700 font-medium hover:text-blue-800 underline underline-offset-4"
          >
            CNPJ Nacional: Movel Motores (13.265.251/0002-20)
          </button>
          <button
            type="button"
            onClick={() => {
              setQuery('IN012/2026FMS');
              setIbgeFilter('2902906');
              setMunicipalityInput('Barra do Choça/BA (2902906)');
              setYearFilter('2026');
              setStartDate('2026-01-01');
              setEndDate('2026-12-31');
              runSearch({
                q: 'IN012/2026FMS',
                ibge: '2902906',
                year: '2026',
                startDate: '2026-01-01',
                endDate: '2026-12-31',
              });
            }}
            className="text-slate-700 hover:text-blue-700 underline underline-offset-4"
          >
            IN012/2026FMS (Barra do Choça / BA)
          </button>
          <button
            type="button"
            onClick={() => {
              setQuery('123/2026');
              handleClearMunicipality();
              setYearFilter('2026');
              setStartDate('2026-01-01');
              setEndDate('2026-12-31');
              runSearch({
                q: '123/2026',
                ibge: '',
                year: '2026',
                startDate: '2026-01-01',
                endDate: '2026-12-31',
              });
            }}
            className="text-slate-700 hover:text-blue-700 underline underline-offset-4"
          >
            Desambiguar "123/2026"
          </button>
          <button
            type="button"
            onClick={() => {
              setQuery('');
              handleClearMunicipality();
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
            }}
            className="text-slate-700 hover:text-blue-700 underline underline-offset-4"
          >
            Listar toda a base auditada
          </button>
        </div>
      </section>

      {cnpjCoverage && (
        <section
          data-testid="cnpj-national-coverage"
          className={`border rounded-lg p-5 space-y-4 ${
            cnpjCoverage.pncpStatus === 'rate_limited' || cnpjCoverage.pncpStatus === 'unavailable'
              ? 'bg-amber-50 border-amber-200'
              : 'bg-white border-slate-200'
          }`}
        >
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-3 pb-4 border-b border-slate-200">
            <div className="space-y-1">
              <div className="text-xs font-mono text-blue-700 font-semibold">
                BUSCA NACIONAL POR CNPJ · {formatCnpj(cnpjCoverage.cnpj)}
                {cnpjCoverage.relatedMatrizCnpj && (
                  <span className="text-slate-600 font-normal">
                    {' '}
                    + Matriz {formatCnpj(cnpjCoverage.relatedMatrizCnpj)}
                  </span>
                )}
              </div>
              <h2 className="text-base font-bold text-slate-900">
                {cnpjCoverage.legalName ?? `CNPJ ${formatCnpj(cnpjCoverage.cnpj)}`}
              </h2>
              <div className="text-xs text-slate-600 flex flex-wrap gap-x-3 gap-y-1">
                {cnpjCoverage.registrationStatus && (
                  <span>
                    Situação: <strong className="text-slate-900">{cnpjCoverage.registrationStatus}</strong>
                  </span>
                )}
                {cnpjCoverage.primaryCnae && <span>CNAE: {cnpjCoverage.primaryCnae}</span>}
                {cnpjCoverage.relatedMatrizCnpj && (
                  <span className="font-mono text-slate-700">
                    Filial: {cnpjCoverage.filialPncpFetchedCount ?? 0} · Matriz:{' '}
                    {cnpjCoverage.matrizPncpFetchedCount ?? 0}
                  </span>
                )}
                {cnpjCoverage.profileSource && (
                  <span className="text-slate-500">Cadastro via {cnpjCoverage.profileSource}</span>
                )}
              </div>
            </div>
            <div className="font-mono text-xs shrink-0 text-slate-700">
              PNCP:{' '}
              <strong
                className={
                  cnpjCoverage.pncpStatus === 'complete'
                    ? 'text-emerald-700'
                    : 'text-amber-800'
                }
              >
                {cnpjCoverage.pncpStatus.toUpperCase()}
              </strong>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-xs">
            <div>
              <div className="text-slate-500">Declarados no PNCP</div>
              <div className="font-mono tabular-nums text-lg font-semibold text-slate-900 mt-0.5">
                {cnpjCoverage.pncpTotalDeclared}
              </div>
            </div>
            <div>
              <div className="text-slate-500">Capturados no PNCP</div>
              <div className="font-mono tabular-nums text-lg font-semibold text-slate-900 mt-0.5">
                {cnpjCoverage.pncpFetchedCount}
              </div>
            </div>
            <div>
              <div className="text-slate-500">Como Fornecedor</div>
              <div className="font-mono tabular-nums text-lg font-semibold text-blue-700 mt-0.5">
                {cnpjCoverage.byRole.fornecedor}
              </div>
            </div>
            <div>
              <div className="text-slate-500">Como Órgão Contratante</div>
              <div className="font-mono tabular-nums text-lg font-semibold text-slate-900 mt-0.5">
                {cnpjCoverage.byRole.orgao_contratante}
              </div>
            </div>
            <div>
              <div className="text-slate-500">Extras no Índice Local</div>
              <div className="font-mono tabular-nums text-lg font-semibold text-slate-900 mt-0.5">
                {cnpjCoverage.localOnlyCount}
              </div>
            </div>
          </div>

          <p className="text-xs text-slate-700 leading-relaxed pt-2 border-t border-slate-100">
            {cnpjCoverage.message}
          </p>
        </section>
      )}

      {parsedReference && (
        <div
          data-testid="pncp-url-parsed"
          className="bg-blue-50/70 border border-blue-200 rounded-lg p-4 text-xs text-slate-800 leading-relaxed"
        >
          <span className="font-semibold text-blue-900">URL oficial interpretada localmente:</span>{' '}
          host <span className="font-mono">{parsedReference.sourceHost}</span>
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
          className="bg-slate-50 border border-slate-200 rounded-lg p-4 text-xs text-slate-800 leading-relaxed"
        >
          <span className="font-semibold text-slate-900">Código municipal interpretado:</span>{' '}
          <span className="font-mono font-semibold">{parsedContractCode.raw}</span>
          {parsedContractCode.modalityHint && (
            <>
              {' '}→ Modalidade provável:{' '}
              <span className="font-medium text-slate-900">{parsedContractCode.modalityHint}</span>
            </>
          )}
          {' '}· Sequencial normalizado{' '}
          <span className="font-mono">{parsedContractCode.normalizedNumber}</span>
          {parsedContractCode.unitHint && (
            <>
              {' '}· Unidade:{' '}
              <span className="font-medium text-slate-900">
                {parsedContractCode.unitHint} ({parsedContractCode.unitSuffix})
              </span>
            </>
          )}
        </div>
      )}

      {livePncpStatus && !cnpjCoverage && (
        <div
          data-testid="live-pncp-status"
          className="bg-blue-50/50 border border-blue-200 rounded-lg px-4 py-3 text-xs text-slate-800 flex items-start gap-2.5"
        >
          <Info className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" aria-hidden="true" />
          <div>{livePncpStatus.message}</div>
        </div>
      )}

      {disambiguationRequired && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
          <Info className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="text-xs text-amber-900 leading-relaxed">
            <span className="font-semibold">Desambiguação necessária:</span> o número{' '}
            <span className="font-mono font-semibold">{query}</span> ocorre em{' '}
            {new Set(results.map((r) => r.municipalityIbge)).size} municípios distintos. Confirme o
            código IBGE, o órgão contratante e o número de controle PNCP antes de abrir o dossiê.
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-slate-900">
            Resultados Localizados ({results.length})
          </h2>
          <span className="text-xs text-slate-500">
            Espelho auditado + consulta ao vivo na API do PNCP
          </span>
        </div>

        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">
            Consultando espelho municipal e API oficial do PNCP...
          </div>
        ) : results.length === 0 ? (
          <div className="p-8 text-center space-y-3">
            <p className="text-sm font-semibold text-slate-900">
              Contrato não localizado no PNCP nem no repositório local.
            </p>
            <p className="text-xs text-slate-600 max-w-xl mx-auto leading-relaxed">
              Muitos contratos municipais (especialmente inexigibilidades, dispensas e relações
              internas de fiscais) são publicados apenas no Portal da Transparência do município e
              ainda não foram sincronizados ao PNCP (estado{' '}
              <span className="font-mono font-semibold">NOT_VERIFIABLE</span> via PNCP). Você pode
              importar o PDF ou a relação tabular do portal municipal para auditar imediatamente.
            </p>
            {onNavigateToDocument && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={onNavigateToDocument}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors"
                >
                  <FileUp className="w-3.5 h-3.5" aria-hidden="true" />
                  Enviar PDF / Extrato do Portal Municipal
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="divide-y divide-slate-200">{results.map(renderContractRow)}</div>
        )}
      </section>

      {results.length === 0 && relatedResults.length > 0 && (
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Processos com numeração relacionada no mesmo município ({relatedResults.length})
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Contratos ou compras do mesmo sequencial/ano em outras modalidades no PNCP.
              </p>
            </div>
          </div>
          <div className="divide-y divide-slate-200">{relatedResults.map(renderContractRow)}</div>
        </section>
      )}
    </div>
  );
}

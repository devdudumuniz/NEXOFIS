import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Building2,
  CheckCircle2,
  Compass,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import type { EvaluatedContract, Municipality } from '@nexofis/shared/types/audit';
import {
  fetchMunicipalityContext,
  searchMunicipalities,
  type MunicipalityContextResponse,
} from '../lib/api';
import {
  formatCnpj,
  formatCurrencyBRL,
  formatCurrencyCompactBRL,
  formatPercentageBR,
} from '@nexofis/shared/lib/formatters';
import { validateDatePeriod } from '@nexofis/shared/lib/datePeriod';
import { validateMunicipalityInput } from '@nexofis/shared/lib/municipalitySearch';
import { notificationService } from '../lib/notificationService';
import { DatePeriodControls } from './DatePeriodControls';
import { RiskScoreInline } from './RiskText';

interface MunicipalityViewProps {
  initialIbgeCode: string;
  selectedEntityId?: string;
  startDate?: string;
  endDate?: string;
  onPeriodChange?: (next: { startDate: string; endDate: string }) => void;
  onIbgeChange?: (ibgeCode: string) => void;
  onEntityChange?: (entityId: string) => void;
  onSelectContract: (contract: EvaluatedContract) => void;
  onContextChange: (ctx: {
    municipality: Municipality | null;
    entityName: string | null;
  }) => void;
}

export function MunicipalityView({
  initialIbgeCode,
  selectedEntityId: controlledEntityId,
  startDate: controlledStartDate,
  endDate: controlledEndDate,
  onPeriodChange,
  onIbgeChange,
  onEntityChange,
  onSelectContract,
  onContextChange,
}: MunicipalityViewProps) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Municipality[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [totalIndexed, setTotalIndexed] = useState<number>(0);

  const [activeIbge, setActiveIbgeState] = useState<string>(initialIbgeCode);
  const [reloadToken, setReloadToken] = useState<number>(0);
  const [searchingSubmit, setSearchingSubmit] = useState(false);
  const [context, setContext] = useState<MunicipalityContextResponse | null>(null);
  const [internalEntityId, setInternalEntityId] = useState<string>(controlledEntityId ?? 'ALL');
  const [internalStartDate, setInternalStartDate] = useState<string>(controlledStartDate ?? '');
  const [internalEndDate, setInternalEndDate] = useState<string>(controlledEndDate ?? '');
  const [riskFilter, setRiskFilter] = useState<'ALL' | 'HIGH' | 'LOW' | 'UNVERIFIABLE'>('ALL');
  const [tableFilter, setTableFilter] = useState('');

  const [loadingContext, setLoadingContext] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedEntityId = controlledEntityId ?? internalEntityId;
  const startDate = controlledStartDate ?? internalStartDate;
  const endDate = controlledEndDate ?? internalEndDate;

  const setPeriod = (nextStart: string, nextEnd: string) => {
    setInternalStartDate(nextStart);
    setInternalEndDate(nextEnd);
    onPeriodChange?.({ startDate: nextStart, endDate: nextEnd });
  };
  const setSelectedEntityId = (nextId: string) => {
    setInternalEntityId(nextId);
    onEntityChange?.(nextId);
  };
  const setActiveIbge = (nextIbge: string) => {
    setError(null);
    if (nextIbge === activeIbge && /^\d{7}$/.test(nextIbge)) {
      setReloadToken((n) => n + 1);
    } else {
      setActiveIbgeState(nextIbge);
    }
    onIbgeChange?.(nextIbge);
  };

  useEffect(() => {
    setActiveIbgeState(initialIbgeCode);
  }, [initialIbgeCode]);

  // Fetch municipality context ONLY when a valid 7-digit IBGE code is selected
  useEffect(() => {
    if (!/^\d{7}$/.test(activeIbge)) {
      setContext(null);
      setLoadingContext(false);
      onContextChange({ municipality: null, entityName: null });
      return;
    }

    const periodCheck = validateDatePeriod(startDate, endDate);
    if (!periodCheck.valid) {
      setError(periodCheck.error ?? 'Período de datas inválido.');
      return;
    }

    let cancelled = false;
    setLoadingContext(true);
    setError(null);

    fetchMunicipalityContext(activeIbge, {
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    })
      .then((data) => {
        if (cancelled) return;
        setContext(data);
        setQuery((prev) =>
          prev.trim() ? prev : `${data.municipality.name} (${data.municipality.uf})`
        );
        const preservedEnt = data.entities.find((e) => e.id === selectedEntityId);
        if (!preservedEnt && selectedEntityId !== 'ALL') {
          setSelectedEntityId('ALL');
        }
        onContextChange({
          municipality: data.municipality,
          entityName: preservedEnt ? preservedEnt.shortName : null,
        });
        if (data.contracts.length > 0) {
          notificationService.notifyHighRiskBatch(data.contracts, {
            sourceLabel: `Análise Municipal — ${data.municipality.name}/${data.municipality.uf}`,
            onOpenContract: onSelectContract,
          });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Erro ao carregar contexto municipal.');
        setContext(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingContext(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeIbge, startDate, endDate, reloadToken]);

  useEffect(() => {
    if (!context) return;
    const ent = context.entities.find((e) => e.id === selectedEntityId);
    onContextChange({
      municipality: context.municipality,
      entityName: ent ? ent.shortName : null,
    });
  }, [selectedEntityId, context]);

  const inputValidation = useMemo(() => validateMunicipalityInput(query), [query]);
  const isIbgeFormatError = inputValidation.status === 'invalid_ibge';
  const isIbgeFormatValid = inputValidation.status === 'valid_ibge';

  // Live IBGE autocomplete across all 5,571 Brazilian municipalities
  useEffect(() => {
    if (isIbgeFormatError) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchMunicipalities(query)
        .then((res) => {
          if (cancelled) return;
          setSuggestions(res.results);
          setTotalIndexed(res.totalIndexed);
        })
        .catch(() => {});
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, isIbgeFormatError]);

  const handleSubmitSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;

    setShowSuggestions(false);

    const validation = validateMunicipalityInput(trimmed);
    if (validation.status === 'invalid_ibge') {
      setError(
        validation.message ??
          'Código IBGE inválido: informe exatamente 7 dígitos numéricos.'
      );
      return;
    }

    setError(null);

    if (validation.status === 'valid_ibge' && validation.ibgeCode) {
      setActiveIbge(validation.ibgeCode);
      return;
    }

    // If user re-submitted the currently loaded municipality (e.g. "Barra do Choça (BA)"), refresh it directly
    if (
      context?.municipality &&
      trimmed.toLowerCase() ===
        `${context.municipality.name} (${context.municipality.uf})`.toLowerCase()
    ) {
      setActiveIbge(context.municipality.ibgeCode);
      return;
    }

    // Always resolve against the live IBGE search endpoint on submit to avoid 150ms debounce races
    setSearchingSubmit(true);
    try {
      const res = await searchMunicipalities(trimmed);
      setSuggestions(res.results);
      setTotalIndexed(res.totalIndexed);
      if (res.results.length > 0) {
        const picked = res.results[0];
        setActiveIbge(picked.ibgeCode);
        setQuery(`${picked.name} (${picked.uf})`);
      } else {
        setError(
          `Nenhum município localizado para "${trimmed}". Informe o nome do município (com ou sem UF) ou o código IBGE de 7 dígitos.`
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Erro ao consultar o diretório de municípios do IBGE.'
      );
    } finally {
      setSearchingSubmit(false);
    }
  };

  const handlePickMunicipality = (m: Municipality) => {
    setError(null);
    setActiveIbge(m.ibgeCode);
    setQuery(`${m.name} (${m.uf})`);
    setShowSuggestions(false);
  };

  const filteredContracts = (context?.contracts ?? []).filter((c) => {
    if (selectedEntityId !== 'ALL' && c.entityId !== selectedEntityId) return false;
    const isUnverifiable = c.assessment.coverageStatus === 'INSUFFICIENT';
    if (riskFilter === 'UNVERIFIABLE' && !isUnverifiable) return false;
    if (riskFilter === 'HIGH' && (isUnverifiable || c.assessment.score < 50)) return false;
    if (riskFilter === 'LOW' && (isUnverifiable || c.assessment.score >= 50)) return false;
    if (tableFilter.trim()) {
      const needle = tableFilter.toLowerCase();
      const hay =
        `${c.contractNumber} ${c.object} ${c.supplier.legalName} ${c.supplier.cnpj} ${c.entityName}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-8">
      {/* Search & IBGE Resolution Panel */}
      <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6">
        <div className="flex flex-col gap-1.5 mb-5">
          <h1 className="text-2xl font-bold tracking-tight text-[#0B2540] dark:text-[#FAF9F5]">
            Investigação Municipal por Código IBGE
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 max-w-3xl">
            Pesquise qualquer um dos municípios brasileiros pelo nome ou código IBGE de 7 dígitos.
            O NEXOFIS consulta a API oficial do PNCP em tempo real, consolida secretarias e fundos
            e avalia cada contrato com proveniência verificável.
          </p>
        </div>

        <form onSubmit={handleSubmitSearch} noValidate className="relative max-w-2xl">
          <label htmlFor="municipality-search" className="sr-only">
            Buscar município por nome ou código IBGE
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search
                className={`w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none ${
                  isIbgeFormatError
                    ? 'text-red-500 dark:text-red-400'
                    : isIbgeFormatValid
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-slate-400 dark:text-slate-500'
                }`}
                aria-hidden="true"
              />
              <input
                id="municipality-search"
                type="text"
                value={query}
                aria-invalid={isIbgeFormatError}
                aria-describedby={
                  inputValidation.message ? 'municipality-ibge-feedback' : undefined
                }
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 180)}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setError(null);
                  setShowSuggestions(true);
                }}
                placeholder="Digite o nome do município ou código IBGE de 7 dígitos"
                className={`w-full h-11 pl-10 pr-10 text-sm bg-white dark:bg-[#061321] border rounded-md text-[#0B2540] dark:text-[#FAF9F5] placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 transition-colors ${
                  isIbgeFormatError
                    ? 'border-red-500 dark:border-red-500 focus:ring-red-500/30 focus:border-red-600'
                    : isIbgeFormatValid
                      ? 'border-emerald-500 dark:border-emerald-500 focus:ring-emerald-500/30 focus:border-emerald-600'
                      : 'border-slate-300 dark:border-[#1D3A57] focus:ring-[#D95B35] focus:border-[#D95B35]'
                }`}
                autoComplete="off"
              />
              {isIbgeFormatError && (
                <AlertCircle
                  className="w-4 h-4 text-red-500 dark:text-red-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                  aria-hidden="true"
                />
              )}
              {isIbgeFormatValid && (
                <CheckCircle2
                  className="w-4 h-4 text-emerald-600 dark:text-emerald-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                  aria-hidden="true"
                />
              )}

              {showSuggestions && !isIbgeFormatError && suggestions.length > 0 && (
                <ul
                  role="listbox"
                  aria-label="Municípios encontrados no IBGE"
                  className="absolute z-20 left-0 right-0 mt-1 bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-md shadow-lg max-h-72 overflow-y-auto divide-y divide-slate-100 dark:divide-[#1D3A57]"
                >
                  {suggestions.map((m) => (
                    <li key={m.ibgeCode}>
                      <button
                        type="button"
                        onMouseDown={() => handlePickMunicipality(m)}
                        className="w-full text-left px-3.5 py-2.5 hover:bg-[#E8F1F6] dark:hover:bg-[#102843] flex items-center justify-between gap-4 transition-colors"
                      >
                        <span className="text-sm font-medium text-[#0B2540] dark:text-[#FAF9F5]">
                          {m.name}{' '}
                          <span className="text-slate-500 dark:text-slate-400 font-normal">
                            / {m.uf}
                          </span>
                        </span>
                        <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
                          IBGE {m.ibgeCode}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button
              type="submit"
              disabled={searchingSubmit || isIbgeFormatError}
              className="h-11 px-5 text-sm font-semibold text-white bg-[#0B2540] hover:bg-[#102843] dark:bg-[#D95B35] dark:hover:bg-[#c04c29] disabled:opacity-50 disabled:cursor-not-allowed rounded-md transition-colors whitespace-nowrap shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#D95B35] focus-visible:ring-offset-2"
            >
              {searchingSubmit ? 'Consultando...' : 'Consultar Município'}
            </button>
          </div>

          {inputValidation.message && (
            <p
              id="municipality-ibge-feedback"
              role={isIbgeFormatError ? 'alert' : 'status'}
              className={`mt-2 flex items-center gap-1.5 text-xs font-medium ${
                isIbgeFormatError
                  ? 'text-red-700 dark:text-red-400'
                  : 'text-emerald-700 dark:text-emerald-400'
              }`}
            >
              {isIbgeFormatError ? (
                <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              )}
              <span>{inputValidation.message}</span>
            </p>
          )}
        </form>

        <div className="mt-4 pt-4 border-t border-slate-100 dark:border-[#1D3A57] flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div className="flex flex-col md:flex-row md:items-end gap-4 flex-1">
            <div className="max-w-xl flex-1">
              <DatePeriodControls
                idPrefix="municipality-search"
                startDate={startDate}
                endDate={endDate}
                onStartDateChange={(val) => setPeriod(val, endDate)}
                onEndDateChange={(val) => setPeriod(startDate, val)}
                showPresets
              />
            </div>

            {context && context.entities.length > 0 && (
              <div className="min-w-[240px] max-w-xs">
                <label
                  htmlFor="municipality-top-secretaria-filter"
                  className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1"
                >
                  Secretaria / Órgão
                </label>
                <select
                  id="municipality-top-secretaria-filter"
                  data-testid="municipality-top-secretaria-select"
                  value={selectedEntityId}
                  onChange={(e) => setSelectedEntityId(e.target.value)}
                  className="w-full h-9 px-3 text-xs bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] text-[#0B2540] dark:text-[#FAF9F5] rounded-md focus:outline-none focus:ring-2 focus:ring-[#D95B35]"
                >
                  <option value="ALL">
                    Todas as secretarias ({context.summary.contractCount})
                  </option>
                  {context.entities.map((ent) => (
                    <option key={ent.id} value={ent.id}>
                      {ent.shortName} ({ent.contractCount})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {totalIndexed > 0 && (
            <span className="font-mono tabular-nums text-xs text-slate-500 dark:text-slate-400 shrink-0">
              {totalIndexed.toLocaleString('pt-BR')} municípios indexados (IBGE)
            </span>
          )}
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

      {/* Neutral Empty Selection State (zero hardcoded default cities) */}
      {!activeIbge && !loadingContext && (
        <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-10 text-center space-y-3">
          <Compass className="w-8 h-8 text-[#D95B35] mx-auto" aria-hidden="true" />
          <h2 className="text-base font-bold text-[#0B2540] dark:text-[#FAF9F5]">
            Selecione um município para iniciar a investigação
          </h2>
          <p className="text-xs text-slate-600 dark:text-slate-300 max-w-xl mx-auto leading-relaxed">
            Digite o nome de qualquer município brasileiro ou informe diretamente o código IBGE de 7
            dígitos no campo acima. Nenhum município ou conjunto de dados demonstrativo é pré-carregado
            automaticamente — todas as consultas utilizam a base oficial IBGE/PNCP e os registros
            auditados no SQLite local.
          </p>
        </section>
      )}

      {/* Loading Skeleton */}
      {loadingContext && (
        <div className="space-y-6" aria-busy="true" aria-label="Carregando contexto municipal">
          <div className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6 animate-pulse">
            <div className="h-6 w-72 bg-slate-200 dark:bg-[#102843] rounded mb-3" />
            <div className="h-4 w-96 bg-slate-100 dark:bg-[#102843] rounded mb-6" />
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 pt-5 border-t border-slate-100 dark:border-[#1D3A57]">
              {[1, 2, 3, 4].map((n) => (
                <div key={n} className="space-y-2">
                  <div className="h-3 w-24 bg-slate-100 dark:bg-[#102843] rounded" />
                  <div className="h-7 w-28 bg-slate-200 dark:bg-[#102843] rounded" />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Resolved Municipal Context */}
      {!loadingContext && context && (
        <>
          <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6">
            <div className="flex flex-col md:flex-row md:items-baseline justify-between gap-2 pb-5 border-b border-slate-200 dark:border-[#1D3A57]">
              <div>
                <h2 className="text-xl font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                  {context.municipality.name} — {context.municipality.uf}
                </h2>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-mono tabular-nums text-[#0B2540] dark:text-slate-200 font-medium">
                    IBGE {context.municipality.ibgeCode}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{context.municipality.stateName}</span>
                  <span aria-hidden="true">·</span>
                  <span>Fonte territorial: {context.municipality.source}</span>
                  {context.summary.pncpMessage && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{context.summary.pncpMessage}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 pt-5">
              <div>
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Órgãos e Secretarias
                </div>
                <div className="mt-1 text-lg sm:text-2xl font-semibold font-mono tabular-nums text-[#0B2540] dark:text-[#FAF9F5] whitespace-nowrap">
                  {context.summary.entityCount}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Unidades administrativas mapeadas
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Contratos Analisados
                </div>
                <div className="mt-1 text-lg sm:text-2xl font-semibold font-mono tabular-nums text-[#0B2540] dark:text-[#FAF9F5] whitespace-nowrap">
                  {context.summary.contractCount}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Normalizados para OCDS 1.1
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Volume Atualizado
                </div>
                <div className="mt-1 text-lg sm:text-2xl font-semibold font-mono tabular-nums text-[#0B2540] dark:text-[#FAF9F5] whitespace-nowrap">
                  {formatCurrencyCompactBRL(context.summary.totalValue)}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums truncate">
                  {formatCurrencyBRL(context.summary.totalValue)}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Revisão Recomendada
                </div>
                <div
                  className={`mt-1 text-lg sm:text-2xl font-semibold font-mono tabular-nums whitespace-nowrap ${
                    context.summary.highRiskCount > 0
                      ? 'text-red-700 dark:text-red-400'
                      : 'text-emerald-700 dark:text-emerald-400'
                  }`}
                >
                  {context.summary.highRiskCount}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Contratos verificáveis com escore ≥ 50/100
                </div>
              </div>
            </div>
          </section>

          {context.entities.length > 0 && (
            <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
                <div>
                  <h3 className="text-base font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                    Prefeitura, Fundos e Secretarias Detectadas
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Selecione uma secretaria ou unidade para filtrar os contratos abaixo.
                  </p>
                </div>
                {selectedEntityId !== 'ALL' && (
                  <button
                    type="button"
                    onClick={() => setSelectedEntityId('ALL')}
                    className="text-xs font-medium text-[#D95B35] hover:underline whitespace-nowrap"
                  >
                    Exibir todos os órgãos ({context.summary.contractCount})
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {context.entities.map((ent) => {
                  const isActive = selectedEntityId === ent.id;
                  return (
                    <button
                      key={ent.id}
                      type="button"
                      onClick={() => setSelectedEntityId(isActive ? 'ALL' : ent.id)}
                      aria-pressed={isActive}
                      className={`text-left p-4 rounded-md border transition-colors ${
                        isActive
                          ? 'bg-[#E8F1F6] dark:bg-[#102843] border-[#D95B35]'
                          : 'bg-white dark:bg-[#061321] border-slate-200 dark:border-[#1D3A57] hover:bg-slate-50 dark:hover:bg-[#102843]/60'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5] leading-snug">
                          {ent.shortName}
                        </span>
                        <Building2
                          className={`w-4 h-4 shrink-0 mt-0.5 ${
                            isActive ? 'text-[#D95B35]' : 'text-slate-400 dark:text-slate-500'
                          }`}
                          aria-hidden="true"
                        />
                      </div>
                      <div className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                        {ent.entityType} · Unid.{' '}
                        <span className="font-mono tabular-nums">{ent.pncpUnidadeCode}</span>
                      </div>
                      <div className="mt-3 pt-2.5 border-t border-slate-100 dark:border-[#1D3A57] flex items-center justify-between text-xs">
                        <span className="font-mono tabular-nums text-[#0B2540] dark:text-slate-200">
                          {ent.contractCount} contrato(s) ·{' '}
                          {ent.totalValue > 0
                            ? formatCurrencyCompactBRL(ent.totalValue)
                            : 'Valor não divulgado'}
                        </span>
                        {ent.highRiskCount > 0 ? (
                          <span className="font-medium text-red-700 dark:text-red-400">
                            {ent.highRiskCount} alerta(s)
                          </span>
                        ) : (
                          <span className="text-slate-500 dark:text-slate-400">Sem alertas ≥ 50</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* Contracts Data Grid */}
          <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg overflow-hidden">
            <div className="p-5 border-b border-slate-200 dark:border-[#1D3A57] flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                  Contratos Públicos Priorizados por Risco
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Ordenados pelo Motor Forense NEXOFIS (regras jurídicas temporais, benchmarking
                  Mediana/MAD e execução financeira).
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {context.entities.length > 0 && (
                  <div className="flex items-center gap-2">
                    <label
                      htmlFor="municipality-secretaria-filter"
                      className="text-xs font-medium text-slate-600 dark:text-slate-300 whitespace-nowrap"
                    >
                      Secretaria:
                    </label>
                    <select
                      id="municipality-secretaria-filter"
                      data-testid="municipality-secretaria-select"
                      value={selectedEntityId}
                      onChange={(e) => setSelectedEntityId(e.target.value)}
                      className="h-9 px-3 text-xs bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] text-[#0B2540] dark:text-[#FAF9F5] rounded-md max-w-[260px] focus:outline-none focus:ring-2 focus:ring-[#D95B35]"
                    >
                      <option value="ALL">
                        Todas as secretarias ({context.summary.contractCount})
                      </option>
                      {context.entities.map((ent) => (
                        <option key={ent.id} value={ent.id}>
                          {ent.shortName} ({ent.contractCount})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="relative">
                  <SlidersHorizontal
                    className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                    aria-hidden="true"
                  />
                  <label htmlFor="contract-table-filter" className="sr-only">
                    Filtrar contratos na tabela
                  </label>
                  <input
                    id="contract-table-filter"
                    type="text"
                    value={tableFilter}
                    onChange={(e) => setTableFilter(e.target.value)}
                    placeholder="Filtrar nº, fornecedor ou objeto..."
                    className="h-9 pl-8 pr-3 text-xs bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] text-[#0B2540] dark:text-[#FAF9F5] rounded-md w-56 focus:outline-none focus:ring-2 focus:ring-[#D95B35]"
                  />
                </div>

                <div
                  role="group"
                  aria-label="Filtro por faixa de risco"
                  className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-[#061321] rounded-md"
                >
                  {(
                    [
                      { key: 'ALL', label: 'Todos' },
                      { key: 'HIGH', label: 'Revisão (≥50)' },
                      { key: 'LOW', label: 'Abaixo de 50' },
                      { key: 'UNVERIFIABLE', label: 'Não verificáveis' },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setRiskFilter(tab.key)}
                      className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                        riskFilter === tab.key
                          ? 'bg-white dark:bg-[#102843] text-[#0B2540] dark:text-[#FAF9F5] shadow-xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-[#0B2540] dark:hover:text-white'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {filteredContracts.length === 0 ? (
              <div className="p-10 text-center">
                <p className="text-sm font-medium text-[#0B2540] dark:text-[#FAF9F5]">
                  Nenhum contrato encontrado com os filtros aplicados.
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-md mx-auto">
                  {context.contracts.length === 0
                    ? `Não foram retornados contratos recentes no PNCP para ${context.municipality.name} (${context.municipality.ibgeCode}) neste período. Você pode ampliar as datas ou importar um PDF na aba Documento.`
                    : 'Limpe os filtros de secretaria ou faixa de risco para visualizar todos os contratos do município.'}
                </p>
                {context.contracts.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedEntityId('ALL');
                      setRiskFilter('ALL');
                      setTableFilter('');
                    }}
                    className="mt-4 px-4 py-2 text-xs font-semibold text-[#0B2540] dark:text-[#FAF9F5] bg-[#E8F1F6] dark:bg-[#102843] rounded-md"
                  >
                    Limpar filtros
                  </button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1D3A57] bg-[#FAF9F5] dark:bg-[#061321] text-xs font-medium text-slate-500 dark:text-slate-400">
                      <th className="py-3 px-4 whitespace-nowrap">Contrato</th>
                      <th className="py-3 px-4">Órgão e Objeto</th>
                      <th className="py-3 px-4">Fornecedor</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Valor Atualizado</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Variação</th>
                      <th className="py-3 px-4 whitespace-nowrap">Risco / Cobertura</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Ação</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-[#1D3A57] text-sm">
                    {filteredContracts.map((contract) => (
                      <tr
                        key={contract.id}
                        className="hover:bg-[#FAF9F5] dark:hover:bg-[#102843]/50 transition-colors"
                      >
                        <td className="py-3.5 px-4 align-top whitespace-nowrap">
                          <div className="font-mono font-semibold text-[#0B2540] dark:text-[#FAF9F5] tabular-nums">
                            {contract.contractNumber}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            {contract.signatureDate
                              ? `Contrato assinado · ${contract.signatureDate.slice(0, 10)}`
                              : contract.modality}
                          </div>
                        </td>
                        <td className="py-3.5 px-4 align-top max-w-md">
                          <div className="text-xs font-medium text-slate-600 dark:text-slate-300">
                            {contract.entityName}
                          </div>
                          <div className="text-sm text-[#0B2540] dark:text-[#FAF9F5] mt-0.5 line-clamp-2">
                            {contract.object}
                          </div>
                        </td>
                        <td className="py-3.5 px-4 align-top">
                          <div className="text-sm font-medium text-[#0B2540] dark:text-[#FAF9F5]">
                            {contract.supplier.legalName}
                          </div>
                          {contract.supplier.cnpj &&
                          contract.supplier.cnpj !== '00000000000000' ? (
                            <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 mt-0.5">
                              {formatCnpj(contract.supplier.cnpj)}
                            </div>
                          ) : (
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                              Publicação de edital sem contrato vinculado
                            </div>
                          )}
                        </td>
                        <td className="py-3.5 px-4 align-top text-right whitespace-nowrap">
                          {contract.originalValue === 0 && contract.updatedValue === 0 ? (
                            <div className="text-xs font-semibold text-amber-800 dark:text-amber-400">
                              Não divulgado
                            </div>
                          ) : (
                            <>
                              <div className="font-mono tabular-nums font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                                {formatCurrencyBRL(contract.updatedValue)}
                              </div>
                              {contract.updatedValue !== contract.originalValue && (
                                <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 mt-0.5">
                                  Orig. {formatCurrencyCompactBRL(contract.originalValue)}
                                </div>
                              )}
                            </>
                          )}
                        </td>
                        <td className="py-3.5 px-4 align-top text-right whitespace-nowrap font-mono tabular-nums text-xs">
                          {contract.originalValue === 0 && contract.updatedValue === 0 ? (
                            <span className="text-slate-400">—</span>
                          ) : (
                            <span
                              className={
                                contract.assessment.variationPct > 25
                                  ? 'text-red-700 dark:text-red-400 font-semibold'
                                  : contract.assessment.variationPct > 0
                                    ? 'text-amber-700 dark:text-amber-400 font-medium'
                                    : 'text-slate-500 dark:text-slate-400'
                              }
                            >
                              {formatPercentageBR(contract.assessment.variationPct, true)}
                            </span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 align-top whitespace-nowrap">
                          <RiskScoreInline
                            score={contract.assessment.score}
                            coverageStatus={contract.assessment.coverageStatus}
                          />
                          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            {contract.assessment.indicators.length === 0
                              ? 'Sem alertas ativos'
                              : `${contract.assessment.indicators.length} indicador(es)`}
                          </div>
                        </td>
                        <td className="py-3.5 px-4 align-top text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => onSelectContract(contract)}
                            aria-label={`Abrir dossiê do contrato ${contract.contractNumber}`}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#0B2540] dark:text-[#FAF9F5] bg-[#E8F1F6] dark:bg-[#102843] hover:bg-[#dce8f0] dark:hover:bg-[#1D3A57] rounded-md transition-colors whitespace-nowrap"
                          >
                            Abrir Dossiê
                            <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

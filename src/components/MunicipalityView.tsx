import { useEffect, useState } from 'react';
import { ArrowRight, Building2, Search, SlidersHorizontal } from 'lucide-react';
import type { EvaluatedContract, Municipality } from '../types/audit';
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
} from '../lib/formatters';
import { validateDatePeriod } from '../lib/datePeriod';
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

const QUICK_MUNICIPALITIES = [
  { ibgeCode: '2902906', label: 'Barra do Choça (BA) · 2902906' },
  { ibgeCode: '2919959', label: 'Maetinga (BA) · 2919959' },
  { ibgeCode: '2933307', label: 'Vitória da Conquista (BA) · 2933307' },
  { ibgeCode: '2915809', label: 'Itambé (BA) · 2915809' },
  { ibgeCode: '2916401', label: 'Itapetinga (BA) · 2916401' },
  { ibgeCode: '2901205', label: 'Anagé (BA) · 2901205' },
  { ibgeCode: '2925709', label: 'Presidente Jânio Quadros (BA) · 2925709' },
];

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
  const [context, setContext] = useState<MunicipalityContextResponse | null>(null);
  const [internalEntityId, setInternalEntityId] = useState<string>(controlledEntityId ?? 'ALL');
  const [internalStartDate, setInternalStartDate] = useState<string>(controlledStartDate ?? '');
  const [internalEndDate, setInternalEndDate] = useState<string>(controlledEndDate ?? '');
  const [riskFilter, setRiskFilter] = useState<'ALL' | 'HIGH' | 'LOW'>('ALL');
  const [tableFilter, setTableFilter] = useState('');

  const [loadingContext, setLoadingContext] = useState(true);
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
    setActiveIbgeState(nextIbge);
    onIbgeChange?.(nextIbge);
  };

  // Sync if parent resets initialIbgeCode
  useEffect(() => {
    setActiveIbgeState(initialIbgeCode);
  }, [initialIbgeCode]);

  // Fetch municipality context whenever activeIbge or period changes
  useEffect(() => {
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
        const preservedEnt = data.entities.find((e) => e.id === selectedEntityId);
        if (!preservedEnt && selectedEntityId !== 'ALL') {
          setSelectedEntityId('ALL');
        }
        onContextChange({
          municipality: data.municipality,
          entityName: preservedEnt ? preservedEnt.shortName : null,
        });
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
  }, [activeIbge, startDate, endDate]);

  // Update breadcrumb entity name when user clicks an entity
  useEffect(() => {
    if (!context) return;
    const ent = context.entities.find((e) => e.id === selectedEntityId);
    onContextChange({
      municipality: context.municipality,
      entityName: ent ? ent.shortName : null,
    });
  }, [selectedEntityId, context]);

  // Live IBGE autocomplete search
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      searchMunicipalities(query)
        .then((res) => {
          if (cancelled) return;
          setSuggestions(res.results);
          setTotalIndexed(res.totalIndexed);
        })
        .catch(() => {
          // Ignore transient autocomplete errors
        });
    }, 140);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const handleSubmitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;

    const exactDigits = trimmed.replace(/\D/g, '');
    if (/^\d{7}$/.test(exactDigits)) {
      setActiveIbge(exactDigits);
      setShowSuggestions(false);
      return;
    }

    if (suggestions.length > 0) {
      setActiveIbge(suggestions[0].ibgeCode);
      setQuery(`${suggestions[0].name} (${suggestions[0].uf})`);
      setShowSuggestions(false);
    } else {
      setError(`Nenhum município localizado para "${trimmed}". Informe o nome completo ou o código IBGE de 7 dígitos.`);
    }
  };

  const handlePickMunicipality = (m: Municipality) => {
    setActiveIbge(m.ibgeCode);
    setQuery(`${m.name} (${m.uf})`);
    setShowSuggestions(false);
  };

  const filteredContracts = (context?.contracts ?? []).filter((c) => {
    if (selectedEntityId !== 'ALL' && c.entityId !== selectedEntityId) return false;
    if (riskFilter === 'HIGH' && c.assessment.score < 50) return false;
    if (riskFilter === 'LOW' && c.assessment.score >= 50) return false;
    if (tableFilter.trim()) {
      const needle = tableFilter.toLowerCase();
      const hay = `${c.contractNumber} ${c.object} ${c.supplier.legalName} ${c.supplier.cnpj} ${c.entityName}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-8">
      {/* Search & IBGE Resolution Panel */}
      <section className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex flex-col gap-1.5 mb-5">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Investigação Municipal por Código IBGE
          </h1>
          <p className="text-sm text-slate-600 max-w-3xl">
            Informe o nome do município ou o código IBGE de 7 dígitos. A plataforma resolve o ente
            público, identifica secretarias e fundos municipais no PNCP e prioriza contratos com
            evidências reproduzíveis.
          </p>
        </div>

        <form onSubmit={handleSubmitSearch} className="relative max-w-2xl">
          <label htmlFor="municipality-search" className="sr-only">
            Buscar município por nome ou código IBGE
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search
                className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                id="municipality-search"
                type="text"
                value={query}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 180)}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setShowSuggestions(true);
                }}
                placeholder="Ex.: Barra do Choça ou 2902906"
                className="w-full h-11 pl-10 pr-4 text-sm bg-white border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                autoComplete="off"
              />

              {showSuggestions && suggestions.length > 0 && (
                <ul
                  role="listbox"
                  aria-label="Municípios encontrados no IBGE"
                  className="absolute z-20 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-md shadow-lg max-h-72 overflow-y-auto divide-y divide-slate-100"
                >
                  {suggestions.map((m) => (
                    <li key={m.ibgeCode}>
                      <button
                        type="button"
                        onMouseDown={() => handlePickMunicipality(m)}
                        className="w-full text-left px-3.5 py-2.5 hover:bg-slate-50 flex items-center justify-between gap-4 transition-colors"
                      >
                        <span className="text-sm font-medium text-slate-900">
                          {m.name} <span className="text-slate-500 font-normal">/ {m.uf}</span>
                        </span>
                        <span className="font-mono text-xs tabular-nums text-slate-500">
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
              className="h-11 px-5 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              Resolver IBGE
            </button>
          </div>
        </form>

        <div className="mt-4 pt-4 border-t border-slate-100 max-w-xl">
          <DatePeriodControls
            idPrefix="municipality-search"
            startDate={startDate}
            endDate={endDate}
            onStartDateChange={(val) => setPeriod(val, endDate)}
            onEndDateChange={(val) => setPeriod(startDate, val)}
            showPresets
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500">
          <span>Acesso rápido:</span>
          {QUICK_MUNICIPALITIES.map((item) => (
            <button
              key={item.ibgeCode}
              type="button"
              onClick={() => {
                setActiveIbge(item.ibgeCode);
                setQuery('');
              }}
              className={`font-medium transition-colors underline-offset-4 hover:underline whitespace-nowrap ${
                activeIbge === item.ibgeCode
                  ? 'text-blue-700 underline'
                  : 'text-slate-700 hover:text-blue-700'
              }`}
            >
              {item.label}
            </button>
          ))}
          {totalIndexed > 0 && (
            <span className="ml-auto font-mono tabular-nums text-slate-400">
              {totalIndexed.toLocaleString('pt-BR')} municípios indexados
            </span>
          )}
        </div>
      </section>

      {error && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      {/* Loading Skeleton */}
      {loadingContext && (
        <div className="space-y-6" aria-busy="true" aria-label="Carregando contexto municipal">
          <div className="bg-white border border-slate-200 rounded-lg p-6 animate-pulse">
            <div className="h-6 w-72 bg-slate-200 rounded mb-3" />
            <div className="h-4 w-96 bg-slate-100 rounded mb-6" />
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 pt-5 border-t border-slate-100">
              {[1, 2, 3, 4].map((n) => (
                <div key={n} className="space-y-2">
                  <div className="h-3 w-24 bg-slate-100 rounded" />
                  <div className="h-7 w-28 bg-slate-200 rounded" />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Resolved Municipal Context */}
      {!loadingContext && context && (
        <>
          <section className="bg-white border border-slate-200 rounded-lg p-6">
            <div className="flex flex-col md:flex-row md:items-baseline justify-between gap-2 pb-5 border-b border-slate-200">
              <div>
                <h2 className="text-xl font-bold text-slate-900">
                  {context.municipality.name} — {context.municipality.uf}
                </h2>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                  <span className="font-mono tabular-nums text-slate-700 font-medium">
                    IBGE {context.municipality.ibgeCode}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{context.municipality.stateName}</span>
                  <span aria-hidden="true">·</span>
                  <span>Fonte territorial: {context.municipality.source}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Contratações:{' '}
                    {context.summary.livePncpUsed
                      ? 'PNCP API Oficial (tempo real)'
                      : 'Espelho Municipal Licitarium / PNCP'}
                  </span>
                  {context.municipality.population && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        População IBGE ({context.municipality.populationYear ?? 2026}):{' '}
                        {context.municipality.population.toLocaleString('pt-BR')}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* 4-column KPI strip without nested cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 pt-5">
              <div>
                <div className="text-xs font-medium text-slate-500">Órgãos e Secretarias</div>
                <div className="mt-1 text-lg sm:text-2xl font-semibold font-mono tabular-nums text-slate-900 whitespace-nowrap">
                  {context.summary.entityCount}
                </div>
                <div className="mt-0.5 text-xs text-slate-500">Unidades administrativas mapeadas</div>
              </div>
              <div>
                <div className="text-xs font-medium text-slate-500">Contratos Analisados</div>
                <div className="mt-1 text-lg sm:text-2xl font-semibold font-mono tabular-nums text-slate-900 whitespace-nowrap">
                  {context.summary.contractCount}
                </div>
                <div className="mt-0.5 text-xs text-slate-500">Normalizados para OCDS</div>
              </div>
              <div>
                <div className="text-xs font-medium text-slate-500">Volume Atualizado</div>
                <div className="mt-1 text-lg sm:text-2xl font-semibold font-mono tabular-nums text-slate-900 whitespace-nowrap">
                  {formatCurrencyCompactBRL(context.summary.totalValue)}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 font-mono tabular-nums truncate">
                  {formatCurrencyBRL(context.summary.totalValue)}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-slate-500">Revisão Recomendada</div>
                <div
                  className={`mt-1 text-lg sm:text-2xl font-semibold font-mono tabular-nums whitespace-nowrap ${
                    context.summary.highRiskCount > 0 ? 'text-red-700' : 'text-emerald-700'
                  }`}
                >
                  {context.summary.highRiskCount}
                </div>
                <div className="mt-0.5 text-xs text-slate-500">Contratos com escore ≥ 50/100</div>
              </div>
            </div>
          </section>

          {/* Detected Secretarias / Órgãos */}
          {context.entities.length > 0 && (
            <section className="bg-white border border-slate-200 rounded-lg p-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
                <div>
                  <h3 className="text-base font-semibold text-slate-900">
                    Prefeitura, Fundos e Secretarias Detectadas
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Selecione uma secretaria ou unidade para filtrar os contratos abaixo.
                  </p>
                </div>
                {selectedEntityId !== 'ALL' && (
                  <button
                    type="button"
                    onClick={() => setSelectedEntityId('ALL')}
                    className="text-xs font-medium text-blue-700 hover:text-blue-800 whitespace-nowrap"
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
                      onClick={() =>
                        setSelectedEntityId(isActive ? 'ALL' : ent.id)
                      }
                      aria-pressed={isActive}
                      className={`text-left p-4 rounded-md border transition-colors ${
                        isActive
                          ? 'bg-blue-50/70 border-blue-600'
                          : 'bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50/70'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-900 leading-snug">
                          {ent.shortName}
                        </span>
                        <Building2
                          className={`w-4 h-4 shrink-0 mt-0.5 ${
                            isActive ? 'text-blue-700' : 'text-slate-400'
                          }`}
                          aria-hidden="true"
                        />
                      </div>
                      <div className="mt-1.5 text-xs text-slate-500">
                        {ent.entityType} · UASG/Unid.{' '}
                        <span className="font-mono tabular-nums">{ent.pncpUnidadeCode}</span>
                      </div>
                      <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between text-xs">
                        <span className="font-mono tabular-nums text-slate-700">
                          {ent.contractCount} contrato(s) ·{' '}
                          {ent.totalValue > 0
                            ? formatCurrencyCompactBRL(ent.totalValue)
                            : 'Valor não divulgado'}
                        </span>
                        {ent.highRiskCount > 0 ? (
                          <span className="font-medium text-red-700">
                            {ent.highRiskCount} alerta(s)
                          </span>
                        ) : (
                          <span className="text-emerald-700">Regular</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* Contracts Data Grid */}
          <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  Contratos Públicos Priorizados por Risco
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Ordenados pelo Motor Forense Próprio (regras jurídicas temporais, benchmarking
                  Mediana/MAD e execução financeira).
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
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
                    className="h-9 pl-8 pr-3 text-xs bg-white border border-slate-300 rounded-md w-56 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                <div
                  role="group"
                  aria-label="Filtro por faixa de risco"
                  className="flex items-center gap-1 p-1 bg-slate-100 rounded-md"
                >
                  {(
                    [
                      { key: 'ALL', label: 'Todos' },
                      { key: 'HIGH', label: 'Revisão (≥50)' },
                      { key: 'LOW', label: 'Regular (<50)' },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setRiskFilter(tab.key)}
                      className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                        riskFilter === tab.key
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
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
                <p className="text-sm font-medium text-slate-800">
                  Nenhum contrato encontrado com os filtros aplicados.
                </p>
                <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
                  {context.contracts.length === 0
                    ? `Não foram retornados contratos recentes no PNCP para ${context.municipality.name} (${context.municipality.ibgeCode}). Você pode importar um contrato em PDF manualmente na aba Documento.`
                    : 'Limpe os filtros de secretaria ou busca para visualizar todos os contratos do município.'}
                </p>
                {context.contracts.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedEntityId('ALL');
                      setRiskFilter('ALL');
                      setTableFilter('');
                    }}
                    className="mt-4 px-4 py-2 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
                  >
                    Limpar filtros
                  </button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                      <th className="py-3 px-4 whitespace-nowrap">Contrato</th>
                      <th className="py-3 px-4">Órgão e Objeto</th>
                      <th className="py-3 px-4">Fornecedor</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Valor Atualizado</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Variação</th>
                      <th className="py-3 px-4 whitespace-nowrap">Risco / Indícios</th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">Ação</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-sm">
                    {filteredContracts.map((contract) => (
                      <tr
                        key={contract.id}
                        className="hover:bg-slate-50/80 transition-colors"
                      >
                        <td className="py-3.5 px-4 align-top whitespace-nowrap">
                          <div className="font-mono font-semibold text-slate-900 tabular-nums">
                            {contract.contractNumber}
                          </div>
                          <div className="text-xs text-slate-500 mt-0.5">
                            {contract.modality}
                          </div>
                        </td>
                        <td className="py-3.5 px-4 align-top max-w-md">
                          <div className="text-xs font-medium text-slate-600">
                            {contract.entityName}
                          </div>
                          <div className="text-sm text-slate-900 mt-0.5 line-clamp-2">
                            {contract.object}
                          </div>
                        </td>
                        <td className="py-3.5 px-4 align-top">
                          <div className="text-sm font-medium text-slate-900">
                            {contract.supplier.legalName}
                          </div>
                          <div className="text-xs font-mono tabular-nums text-slate-500 mt-0.5">
                            {formatCnpj(contract.supplier.cnpj)}
                          </div>
                        </td>
                        <td className="py-3.5 px-4 align-top text-right whitespace-nowrap">
                          {contract.originalValue === 0 && contract.updatedValue === 0 ? (
                            <div className="text-xs font-semibold text-amber-800">
                              Não divulgado
                            </div>
                          ) : (
                            <>
                              <div className="font-mono tabular-nums font-semibold text-slate-900">
                                {formatCurrencyBRL(contract.updatedValue)}
                              </div>
                              {contract.updatedValue !== contract.originalValue && (
                                <div className="text-xs font-mono tabular-nums text-slate-500 mt-0.5">
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
                                  ? 'text-red-700 font-semibold'
                                  : contract.assessment.variationPct > 0
                                    ? 'text-amber-700 font-medium'
                                    : 'text-slate-500'
                              }
                            >
                              {formatPercentageBR(contract.assessment.variationPct, true)}
                            </span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 align-top whitespace-nowrap">
                          <RiskScoreInline score={contract.assessment.score} />
                          <div className="text-xs text-slate-500 mt-0.5">
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
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors whitespace-nowrap"
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

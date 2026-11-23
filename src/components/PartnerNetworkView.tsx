import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  Database,
  ExternalLink,
  FileText,
  Landmark,
  Network,
  RefreshCw,
  RotateCcw,
  Search,
  User,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { EvaluatedContract } from '../types/audit';
import {
  enrichPartnerNetworkIndex,
  fetchPartnerNetwork,
  fetchPartnerNetworkSuggestions,
} from '../lib/api';
import { formatCurrencyBRL, formatDateBR } from '../lib/formatters';
import type {
  PartnerNetworkNode,
  PartnerNetworkPayload,
  PartnerNetworkQueryMode,
  PartnerNetworkSuggestionsPayload,
} from '../lib/partnerNetworkGraph';

interface PartnerNetworkViewProps {
  initialQuery?: string;
  initialMode?: PartnerNetworkQueryMode;
  onQueryStateChange?: (query: string, mode: PartnerNetworkQueryMode) => void;
  onSelectContract: (contract: EvaluatedContract) => void;
}

type DetailTab = 'companies' | 'partners' | 'contracts';

const NODE_WIDTH = 244;
const NODE_HEIGHT = 54;

function getRiskAccent(score: number | undefined): {
  stroke: string;
  textClass: string;
} {
  if (score === undefined || score === null) {
    return {
      stroke: '#64748B',
      textClass: 'text-slate-600 dark:text-slate-300',
    };
  }
  if (score >= 65) {
    return {
      stroke: '#DC2626',
      textClass: 'text-red-700 dark:text-red-400 font-semibold',
    };
  }
  if (score >= 35) {
    return {
      stroke: '#D97706',
      textClass: 'text-amber-700 dark:text-amber-400 font-semibold',
    };
  }
  return {
    stroke: '#16A34A',
    textClass: 'text-emerald-700 dark:text-emerald-400 font-semibold',
  };
}

function buildCurvedPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(40, Math.abs(x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

export function PartnerNetworkView({
  initialQuery = '',
  initialMode = 'auto',
  onQueryStateChange,
  onSelectContract,
}: PartnerNetworkViewProps) {
  const [queryInput, setQueryInput] = useState(initialQuery);
  const [mode, setMode] = useState<PartnerNetworkQueryMode>(initialMode);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<PartnerNetworkPayload | null>(null);

  const [suggestions, setSuggestions] = useState<PartnerNetworkSuggestionsPayload | null>(null);
  const [suggestionsLoading, setSuggestionsLoading] = useState(true);
  const [enrichingIndex, setEnrichingIndex] = useState(false);
  const [enrichNotice, setEnrichNotice] = useState<string | null>(null);

  // Interactive Graph Canvas State
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [showContractsLayer, setShowContractsLayer] = useState(true);
  const [showOrgansLayer, setShowOrgansLayer] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragOriginRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const lastInitialQueryRef = useRef<string>('');
  const [detailTab, setDetailTab] = useState<DetailTab>('companies');

  const loadSuggestions = useCallback(async () => {
    setSuggestionsLoading(true);
    try {
      const data = await fetchPartnerNetworkSuggestions();
      setSuggestions(data);
    } catch {
      // Non-fatal
    } finally {
      setSuggestionsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSuggestions();
  }, [loadSuggestions]);

  const executeSearch = useCallback(
    async (rawQuery: string, searchMode: PartnerNetworkQueryMode) => {
      const clean = rawQuery.trim();
      if (clean.length < 2) {
        setError('Informe um CNPJ (14 dígitos), razão social ou nome completo/parcial do sócio.');
        return;
      }

      // Prevent URL sync callback from re-triggering the initialQuery effect
      lastInitialQueryRef.current = clean;
      setLoading(true);
      setError(null);
      setSelectedNodeId(null);
      setHoveredNodeId(null);
      setZoom(1);
      setPan({ x: 0, y: 0 });

      try {
        const result = await fetchPartnerNetwork(clean, searchMode, true);
        setPayload(result);
        onQueryStateChange?.(clean, searchMode);

        // Auto-select seed node for immediate inspector context
        const seedNode = result.nodes.find((n) => n.isSeed) ?? result.nodes[0] ?? null;
        setSelectedNodeId(seedNode?.id ?? null);

        // Refresh coverage stats after live QSA enrichment
        if ((result.indexCoverage?.liveEnrichedCnpjs?.length ?? 0) > 0) {
          loadSuggestions();
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Não foi possível construir o mapa de vínculos societários.'
        );
      } finally {
        setLoading(false);
      }
    },
    [loadSuggestions, onQueryStateChange]
  );

  // Hydrate initial deep-linked query (?sec=rede&q=...)
  useEffect(() => {
    const trimmed = initialQuery.trim();
    if (trimmed && trimmed !== lastInitialQueryRef.current) {
      lastInitialQueryRef.current = trimmed;
      setQueryInput(trimmed);
      setMode(initialMode);
      executeSearch(trimmed, initialMode);
    }
  }, [initialQuery, initialMode, executeSearch]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    executeSearch(queryInput, mode);
  };

  const handleQuickQuery = (q: string, nextMode: PartnerNetworkQueryMode) => {
    setQueryInput(q);
    setMode(nextMode);
    executeSearch(q, nextMode);
  };

  const handleEnrichLocalIndex = async () => {
    setEnrichingIndex(true);
    setEnrichNotice(null);
    setError(null);
    try {
      const res = await enrichPartnerNetworkIndex(10);
      setSuggestions(res.suggestions);
      setEnrichNotice(
        res.attempted === 0
          ? 'Todos os fornecedores numéricos da base local já possuem QSA indexado.'
          : `Indexação concluída: ${res.enriched} de ${res.attempted} fornecedores enriquecidos via BrasilAPI (${res.suggestions.totalPartnersIndexed} sócios indexados).`
      );
      // If user already has an active search, re-run without PNCP sync to immediately show new cross-company links
      if (payload?.query) {
        const refreshed = await fetchPartnerNetwork(payload.query, mode, false);
        setPayload(refreshed);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Falha ao indexar quadros societários da base local.'
      );
    } finally {
      setEnrichingIndex(false);
    }
  };

  // Compute visible nodes and edges respecting layer toggles & non-empty columns
  const { visibleNodes, visibleEdges, effectiveWidth, renderContractsCol, renderOrgansCol } =
    useMemo(() => {
      if (!payload) {
        return {
          visibleNodes: [],
          visibleEdges: [],
          effectiveWidth: 1240,
          renderContractsCol: false,
          renderOrgansCol: false,
        };
      }

      const hasAnyContracts = payload.nodes.some((n) => n.type === 'contract');
      const hasAnyOrgans = payload.nodes.some((n) => n.type === 'organ');
      const showContracts = showContractsLayer && hasAnyContracts;
      const showOrgans = showOrgansLayer && hasAnyOrgans;

      const filteredNodes = payload.nodes.filter((n) => {
        if (n.type === 'contract' && !showContracts) return false;
        if (n.type === 'organ' && !showOrgans) return false;
        return true;
      });

      // Reposition organ column closer when contracts layer is hidden so the graph stays compact
      const repositionedNodes = filteredNodes.map((n) => {
        if (n.type === 'organ' && !showContracts) {
          return { ...n, x: 790 };
        }
        return n;
      });

      const nodeIdSet = new Set(repositionedNodes.map((n) => n.id));
      let filteredEdges = payload.edges.filter(
        (e) => nodeIdSet.has(e.source) && nodeIdSet.has(e.target)
      );

      // When contracts are hidden but organs are shown, synthesize direct Company -> Organ edges
      if (!showContracts && showOrgans) {
        const directSeen = new Set<string>();
        const contractToCompany = new Map<string, string>();
        for (const e of payload.edges) {
          if (e.relation === 'CONTRATO_EMPRESA') {
            contractToCompany.set(e.target, e.source);
          }
        }
        for (const e of payload.edges) {
          if (e.relation === 'CONTRATADO_POR' && nodeIdSet.has(e.target)) {
            const companyNodeId = contractToCompany.get(e.source);
            if (companyNodeId && nodeIdSet.has(companyNodeId)) {
              const key = `${companyNodeId}->${e.target}`;
              if (!directSeen.has(key)) {
                directSeen.add(key);
                filteredEdges = [
                  ...filteredEdges,
                  {
                    id: `direct:${key}`,
                    source: companyNodeId,
                    target: e.target,
                    relation: 'CONTRATADO_POR',
                    label: 'Contratou',
                  },
                ];
              }
            }
          }
        }
      }

      const width =
        showContracts && showOrgans
          ? 1260
          : showContracts || showOrgans
            ? 950
            : 640;

      return {
        visibleNodes: repositionedNodes,
        visibleEdges: filteredEdges,
        effectiveWidth: width,
        renderContractsCol: showContracts,
        renderOrgansCol: showOrgans,
      };
    }, [payload, showContractsLayer, showOrgansLayer]);

  const nodeById = useMemo(() => {
    const map = new Map<string, PartnerNetworkNode>();
    for (const n of visibleNodes) {
      map.set(n.id, n);
    }
    return map;
  }, [visibleNodes]);

  // Highlight incident edges for hovered or selected node; dim unrelated nodes only during hover
  const focusNodeId = hoveredNodeId ?? selectedNodeId;
  const { highlightedNodeIds, highlightedEdgeIds } = useMemo(() => {
    const nSet = new Set<string>();
    const eSet = new Set<string>();
    if (!focusNodeId) return { highlightedNodeIds: nSet, highlightedEdgeIds: eSet };

    nSet.add(focusNodeId);
    for (const e of visibleEdges) {
      if (e.source === focusNodeId || e.target === focusNodeId) {
        eSet.add(e.id);
        nSet.add(e.source);
        nSet.add(e.target);
      }
    }
    return { highlightedNodeIds: nSet, highlightedEdgeIds: eSet };
  }, [focusNodeId, visibleEdges]);

  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) ?? null : null;

  const evaluatedContractMap = useMemo(() => {
    const map = new Map<string, EvaluatedContract>();
    for (const ec of payload?.evaluatedContracts ?? []) {
      map.set(ec.id, ec);
    }
    return map;
  }, [payload]);

  const handleOpenContractById = (contractId: string) => {
    const found = evaluatedContractMap.get(contractId);
    if (found) {
      onSelectContract(found);
    }
  };

  // Mouse drag pan handlers on SVG container
  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if ((e.target as HTMLElement).closest('[data-graph-node="true"]')) return;
    setIsDragging(true);
    dragOriginRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!isDragging || !dragOriginRef.current) return;
    const dx = e.clientX - dragOriginRef.current.x;
    const dy = e.clientY - dragOriginRef.current.y;
    setPan({ x: dragOriginRef.current.panX + dx, y: dragOriginRef.current.panY + dy });
  };

  const handlePointerUp = () => {
    setIsDragging(false);
    dragOriginRef.current = null;
  };

  const selectedPartnerDetail = useMemo(() => {
    if (!selectedNode || selectedNode.type !== 'partner' || !payload) return null;
    return payload.partners.find((p) => p.id === selectedNode.id) ?? null;
  }, [selectedNode, payload]);

  const selectedCompanyDetail = useMemo(() => {
    if (!selectedNode || selectedNode.type !== 'company' || !payload) return null;
    return payload.companies.find((c) => c.cnpj === selectedNode.cnpj) ?? null;
  }, [selectedNode, payload]);

  const selectedContractDetail = useMemo(() => {
    if (!selectedNode || selectedNode.type !== 'contract' || !payload) return null;
    return payload.contracts.find((c) => c.contractId === selectedNode.contractId) ?? null;
  }, [selectedNode, payload]);

  return (
    <div className="space-y-6">
      {/* Header + Search Bar */}
      <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-xl font-bold text-[#0B2540] dark:text-[#FAF9F5] tracking-tight">
              Mapa de Vínculos Societários e Contratos
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-300 max-w-3xl">
              Pesquise por <strong className="font-semibold">empresa (CNPJ ou razão social)</strong>{' '}
              ou <strong className="font-semibold">nome de sócio/empresário</strong> para rastrear
              outras empresas ligadas ao mesmo quadro societário e consolidar todos os contratos
              públicos observados na rede.
            </p>
          </div>

          {suggestions && suggestions.pendingQsaCount > 0 && (
            <button
              type="button"
              onClick={handleEnrichLocalIndex}
              disabled={enrichingIndex}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-[#0B2540] dark:text-slate-100 bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] hover:bg-[#E8F1F6] dark:hover:bg-[#102843] rounded-md transition-colors whitespace-nowrap shrink-0 disabled:opacity-60"
            >
              <Database
                className={`w-3.5 h-3.5 text-[#D95B35] ${enrichingIndex ? 'animate-pulse' : ''}`}
                aria-hidden="true"
              />
              {enrichingIndex
                ? 'Indexando QSA via BrasilAPI...'
                : `Indexar QSA da Base Local (${suggestions.pendingQsaCount} pendente${suggestions.pendingQsaCount === 1 ? '' : 's'})`}
            </button>
          )}
        </div>

        <form onSubmit={handleSubmit} className="grid grid-cols-1 lg:grid-cols-12 gap-3">
          <div className="lg:col-span-6 relative">
            <label htmlFor="partner-network-query" className="sr-only">
              CNPJ, razão social da empresa ou nome do sócio
            </label>
            <Search
              className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              id="partner-network-query"
              type="text"
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              placeholder="Ex.: 00.000.000/0001-91, nome da empresa ou nome do sócio"
              className="w-full h-11 pl-10 pr-3.5 text-sm bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md text-[#0B2540] dark:text-[#FAF9F5] placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#D95B35]"
            />
          </div>

          <div
            role="group"
            aria-label="Modo de busca da rede"
            className="lg:col-span-4 inline-flex rounded-md border border-slate-300 dark:border-[#1D3A57] bg-slate-50 dark:bg-[#061321] p-1 h-11"
          >
            {(
              [
                { id: 'auto', label: 'Automático' },
                { id: 'company', label: 'Empresa / CNPJ' },
                { id: 'partner', label: 'Nome do Sócio' },
              ] as const
            ).map((opt) => {
              const active = mode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setMode(opt.id)}
                  className={`flex-1 text-xs font-semibold rounded transition-colors whitespace-nowrap px-2 ${
                    active
                      ? 'bg-[#0B2540] text-white dark:bg-[#D95B35] dark:text-white'
                      : 'text-slate-600 dark:text-slate-300 hover:text-[#0B2540] dark:hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          <div className="lg:col-span-2">
            <button
              type="submit"
              disabled={loading}
              className="w-full h-11 inline-flex items-center justify-center gap-2 px-4 text-sm font-semibold text-white bg-[#0B2540] hover:bg-[#102843] dark:bg-[#D95B35] dark:hover:bg-[#c04c29] disabled:opacity-60 rounded-md transition-colors whitespace-nowrap"
            >
              {loading ? (
                <RefreshCw className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <Network className="w-4 h-4" aria-hidden="true" />
              )}
              {loading ? 'Mapeando...' : 'Mapear Vínculos'}
            </button>
          </div>
        </form>

        {/* Clean Unboxed Coverage Line */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-slate-500 dark:text-slate-400">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {suggestionsLoading ? (
              <span>Verificando índice societário local (SQLite + QSA)...</span>
            ) : suggestions ? (
              <>
                <span className="font-mono tabular-nums text-slate-700 dark:text-slate-200 font-medium">
                  {suggestions.indexedQsaCount}
                </span>
                <span>empresas com QSA indexado</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums text-slate-700 dark:text-slate-200 font-medium">
                  {suggestions.totalUniqueSuppliers}
                </span>
                <span>fornecedores em contratos locais</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums text-slate-700 dark:text-slate-200 font-medium">
                  {suggestions.totalPartnersIndexed}
                </span>
                <span>sócios catalogados</span>
                {suggestions.multiCompanyPartners.length > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums text-[#D95B35] font-semibold">
                      {suggestions.multiCompanyPartners.length} sócio(s) em 2+ empresas
                    </span>
                  </>
                )}
              </>
            ) : null}
          </div>
          <span className="text-[11px] text-slate-400 dark:text-slate-500">
            Fontes: SQLite Local · PNCP · BrasilAPI/RFB (QSA)
          </span>
        </div>

        {enrichNotice && (
          <div className="p-3 rounded-md bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/60 text-xs text-emerald-800 dark:text-emerald-300">
            {enrichNotice}
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="p-3.5 rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/70 text-xs text-red-700 dark:text-red-300 flex items-start gap-2.5"
          >
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
      </section>

      {/* Loading Skeleton */}
      {loading && (
        <section
          aria-busy="true"
          className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6 space-y-4 animate-pulse"
        >
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-14 bg-slate-100 dark:bg-[#102843] rounded" />
            ))}
          </div>
          <div className="h-[420px] bg-slate-100 dark:bg-[#061321] rounded border border-slate-200 dark:border-[#1D3A57]" />
        </section>
      )}

      {/* Initial / Empty Discovery State (Strictly Real Local Index Data — Zero Mock Data) */}
      {!loading && !payload && (
        <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6 space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pb-6 border-b border-slate-200 dark:border-[#1D3A57]">
            <div>
              <div className="text-xs font-mono uppercase tracking-wider text-[#D95B35] font-semibold">
                Etapa 1 · Semente
              </div>
              <h2 className="mt-1 text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                Empresa 1 ou Nome do Sócio
              </h2>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                Ao buscar por um CNPJ, o NEXOFIS consulta o Quadro de Sócios e Administradores (QSA)
                na BrasilAPI e sincroniza os contratos públicos no PNCP.
              </p>
            </div>
            <div>
              <div className="text-xs font-mono uppercase tracking-wider text-[#D95B35] font-semibold">
                Etapa 2 · Expansão Societária
              </div>
              <h2 className="mt-1 text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                Sócio 1 → Empresas 2, 3...
              </h2>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                Cruza cada sócio encontrado contra todas as empresas já indexadas no repositório
                local, respeitando fragmentos de CPF mascarado para evitar fusão indevida de
                homônimos.
              </p>
            </div>
            <div>
              <div className="text-xs font-mono uppercase tracking-wider text-[#D95B35] font-semibold">
                Etapa 3 · Contratos e Órgãos
              </div>
              <h2 className="mt-1 text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                Contratos Consolidados e Sobreposições
              </h2>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                Exibe todos os contratos das empresas vinculadas, destaca órgãos contratados por
                mais de uma empresa da rede e abre o dossiê forense completo em um clique.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Real Multi-Company Partners Discovered in Local DB */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Sócios vinculados a múltiplas empresas (Base Local)
                </h3>
              </div>
              {suggestions && suggestions.multiCompanyPartners.length > 0 ? (
                <div className="divide-y divide-slate-200 dark:divide-[#1D3A57] border border-slate-200 dark:border-[#1D3A57] rounded-md">
                  {suggestions.multiCompanyPartners.map((item) => (
                    <button
                      key={`${item.mode}:${item.query}`}
                      type="button"
                      onClick={() => handleQuickQuery(item.query, 'partner')}
                      className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-[#102843] transition-colors flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5] truncate">
                          {item.label}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5">
                          {item.detail}
                        </div>
                      </div>
                      <span className="text-xs font-semibold text-[#D95B35] shrink-0">
                        Abrir rede →
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="p-4 rounded-md bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] text-xs text-slate-600 dark:text-slate-300 space-y-2">
                  <p>
                    Nenhum sócio compartilhado entre duas ou mais empresas foi detectado ainda no
                    índice local.
                  </p>
                  <p className="text-slate-500 dark:text-slate-400">
                    {suggestions && suggestions.pendingQsaCount > 0
                      ? 'Clique em "Indexar QSA da Base Local" acima para consultar o quadro societário dos fornecedores já armazenados e descobrir vínculos cruzados.'
                      : 'Busque qualquer CNPJ acima ou investigue municípios para ampliar a base de contratos e quadros societários.'}
                  </p>
                </div>
              )}
            </div>

            {/* Real Top Indexed Companies in Local DB */}
            <div className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Fornecedores registrados no repositório local
              </h3>
              {suggestions && suggestions.topCompanies.length > 0 ? (
                <div className="divide-y divide-slate-200 dark:divide-[#1D3A57] border border-slate-200 dark:border-[#1D3A57] rounded-md">
                  {suggestions.topCompanies.map((item) => (
                    <button
                      key={`${item.mode}:${item.query}`}
                      type="button"
                      onClick={() => handleQuickQuery(item.query, 'company')}
                      className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-[#102843] transition-colors flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5] truncate">
                          {item.label}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5">
                          {item.detail}
                        </div>
                      </div>
                      <span className="text-xs font-semibold text-[#0B2540] dark:text-sky-300 shrink-0">
                        Mapear →
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="p-4 rounded-md bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] text-xs text-slate-600 dark:text-slate-300">
                  Nenhum fornecedor armazenado ainda. Digite um CNPJ de 14 dígitos na barra acima
                  para consultar o QSA e os contratos públicos no PNCP em tempo real.
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Results View */}
      {!loading && payload && (
        <>
          {/* Empty Match Notice */}
          {payload.companies.length === 0 && payload.partners.length === 0 ? (
            <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-8 text-center space-y-3">
              <h2 className="text-base font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                Nenhum vínculo localizado para “{payload.query}”
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-300 max-w-xl mx-auto leading-relaxed">
                A busca por nome de sócio ou razão social cruza os contratos e quadros societários
                (QSA) já indexados no repositório local. Para buscar uma empresa que ainda não está
                no banco local, informe o <strong>CNPJ completo (14 dígitos)</strong> ou clique em{' '}
                <strong>Indexar QSA da Base Local</strong> para enriquecer os fornecedores já
                coletados.
              </p>
            </section>
          ) : (
            <>
              {/* KPI Summary Strip — Single Elevation with Hairline Dividers */}
              <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg">
                <div className="px-6 py-4 border-b border-slate-200 dark:border-[#1D3A57] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[11px] font-mono uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      {payload.resolvedMode === 'partner'
                        ? 'Rede centrada em sócio / empresário'
                        : 'Rede centrada em empresa / CNPJ'}
                    </div>
                    <h2 className="text-base font-bold text-[#0B2540] dark:text-[#FAF9F5] truncate">
                      {payload.seedLabel || payload.query}
                    </h2>
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums whitespace-nowrap">
                    {payload.summary.multiCompanyPartnerCount} sócio(s) multiempresa ·{' '}
                    {payload.summary.distinctOrganCount} órgão(s) contratante(s)
                  </div>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-5 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 dark:divide-[#1D3A57]">
                  <div className="p-5">
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Empresas na rede
                    </div>
                    <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-[#0B2540] dark:text-[#FAF9F5]">
                      {payload.summary.companyCount}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      CNPJs vinculados
                    </div>
                  </div>

                  <div className="p-5">
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Sócios mapeados
                    </div>
                    <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-[#0B2540] dark:text-[#FAF9F5]">
                      {payload.summary.partnerCount}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      {payload.summary.homonymRiskPartnerCount > 0
                        ? `${payload.summary.homonymRiskPartnerCount} com alerta de homonímia`
                        : 'QSA consolidado'}
                    </div>
                  </div>

                  <div className="p-5">
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Contratos na rede
                    </div>
                    <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-[#0B2540] dark:text-[#FAF9F5]">
                      {payload.summary.contractCount}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      Somatório de todas as empresas
                    </div>
                  </div>

                  <div className="p-5">
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Valor contratual agregado
                    </div>
                    <div className="mt-1 text-xl font-bold font-mono tabular-nums text-[#0B2540] dark:text-[#FAF9F5] whitespace-nowrap">
                      {formatCurrencyBRL(payload.summary.totalContractValue)}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      Obrigação contratada (não pago)
                    </div>
                  </div>

                  <div className="p-5 col-span-2 lg:col-span-1">
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Órgãos em comum
                    </div>
                    <div
                      className={`mt-1 text-2xl font-bold font-mono tabular-nums ${
                        payload.summary.sharedOrganCount > 0
                          ? 'text-[#D95B35]'
                          : 'text-[#0B2540] dark:text-[#FAF9F5]'
                      }`}
                    >
                      {payload.summary.sharedOrganCount}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      {payload.summary.sharedOrganCount > 0
                        ? 'Contrataram 2+ empresas da rede'
                        : 'Sem sobreposição observada'}
                    </div>
                  </div>
                </div>
              </section>

              {/* Shared Organ Cross-Company Alert (when detected) */}
              {payload.sharedOrgans.length > 0 && (
                <section className="bg-white dark:bg-[#0B1D31] border border-amber-300 dark:border-amber-700/60 rounded-lg p-5 space-y-3">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle
                      className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5"
                      aria-hidden="true"
                    />
                    <div>
                      <h3 className="text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                        Sobreposição de Órgão Contratante Detectada ({payload.sharedOrgans.length})
                      </h3>
                      <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">
                        Mais de uma empresa ligada ao mesmo quadro societário contratou com o mesmo
                        órgão público. Sinal técnico para verificação de fracionamento, concorrência
                        entre coligadas ou direcionamento — não constitui prova automática de
                        irregularidade.
                      </p>
                    </div>
                  </div>

                  <div className="divide-y divide-slate-200 dark:divide-[#1D3A57] border border-slate-200 dark:border-[#1D3A57] rounded-md">
                    {payload.sharedOrgans.map((org) => (
                      <div
                        key={org.organKey}
                        className="px-4 py-3 flex flex-col md:flex-row md:items-center justify-between gap-2 text-xs"
                      >
                        <div className="space-y-0.5">
                          <div className="font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                            {org.organName}
                            {org.municipalityName ? ` · ${org.municipalityName}` : ''}
                          </div>
                          <div className="text-slate-600 dark:text-slate-300">
                            Empresas: {org.companyNames.join(' · ')}
                          </div>
                          {org.sharedPartners.length > 0 && (
                            <div className="text-slate-500 dark:text-slate-400">
                              Sócio(s) em comum: {org.sharedPartners.join(', ')}
                            </div>
                          )}
                        </div>
                        <div className="font-mono tabular-nums text-right shrink-0">
                          <div className="font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                            {formatCurrencyBRL(org.totalValue)}
                          </div>
                          <div className="text-slate-500 dark:text-slate-400">
                            {org.contractCount} contrato(s) · {org.companyCnpjs.length} empresas
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Interactive SVG Graph Workspace + Inspector */}
              <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg overflow-hidden">
                {/* Graph Toolbar */}
                <div className="px-5 py-3.5 border-b border-slate-200 dark:border-[#1D3A57] flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
                    <span className="font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                      Mapa Interativo de Vínculos
                    </span>

                    <label className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={showContractsLayer}
                        onChange={(e) => setShowContractsLayer(e.target.checked)}
                        className="rounded border-slate-300 text-[#D95B35] focus:ring-[#D95B35]"
                      />
                      <span>Contratos ({payload.contracts.length})</span>
                    </label>

                    <label className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={showOrgansLayer}
                        onChange={(e) => setShowOrgansLayer(e.target.checked)}
                        className="rounded border-slate-300 text-[#D95B35] focus:ring-[#D95B35]"
                      />
                      <span>Órgãos ({payload.summary.distinctOrganCount})</span>
                    </label>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setZoom((z) => Math.max(0.55, Number((z - 0.15).toFixed(2))))}
                      aria-label="Reduzir zoom do mapa"
                      title="Reduzir zoom"
                      className="p-1.5 rounded border border-slate-200 dark:border-[#1D3A57] text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-[#102843]"
                    >
                      <ZoomOut className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                    <span className="font-mono text-xs tabular-nums text-slate-600 dark:text-slate-300 w-12 text-center">
                      {Math.round(zoom * 100)}%
                    </span>
                    <button
                      type="button"
                      onClick={() => setZoom((z) => Math.min(1.75, Number((z + 0.15).toFixed(2))))}
                      aria-label="Ampliar zoom do mapa"
                      title="Ampliar zoom"
                      className="p-1.5 rounded border border-slate-200 dark:border-[#1D3A57] text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-[#102843]"
                    >
                      <ZoomIn className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setZoom(1);
                        setPan({ x: 0, y: 0 });
                      }}
                      aria-label="Resetar visualização do mapa"
                      title="Resetar visualização"
                      className="inline-flex items-center gap-1 px-2 py-1.5 text-xs rounded border border-slate-200 dark:border-[#1D3A57] text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-[#102843]"
                    >
                      <RotateCcw className="w-3 h-3" aria-hidden="true" />
                      <span>Resetar</span>
                    </button>
                  </div>
                </div>

                {/* Canvas + Side Inspector */}
                <div className="grid grid-cols-1 xl:grid-cols-12">
                  {/* SVG Graph Viewport */}
                  <div className="xl:col-span-8 relative bg-[#FAF9F5] dark:bg-[#061321] border-b xl:border-b-0 xl:border-r border-slate-200 dark:border-[#1D3A57] overflow-hidden">
                    {/* Column Headers Overlay */}
                    <div className="px-4 py-2 border-b border-slate-200/80 dark:border-[#1D3A57]/80 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="w-2.5 h-2.5 rounded-sm bg-[#D95B35]" />
                          Sócio / Empresário
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                          <span className="w-2.5 h-2.5 rounded-sm bg-[#0B2540] dark:bg-[#38BDF8]" />
                          Empresa (CNPJ)
                        </span>
                        {showContractsLayer && (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="w-2.5 h-2.5 rounded-sm bg-slate-500 dark:bg-slate-400" />
                            Contrato
                          </span>
                        )}
                        {showOrgansLayer && (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="w-2.5 h-2.5 rounded-sm bg-amber-600" />
                            Órgão Contratante
                          </span>
                        )}
                      </div>
                      <span>Clique em qualquer nó para inspecionar · Arraste para mover</span>
                    </div>

                    <div className="w-full h-[580px] overflow-hidden select-none">
                      <svg
                        role="img"
                        aria-label={`Mapa de vínculos societários para ${payload.seedLabel || payload.query}`}
                        viewBox={`0 0 ${effectiveWidth} ${payload.layout.height}`}
                        preserveAspectRatio="xMidYMid meet"
                        onPointerDown={handlePointerDown}
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerUp}
                        onPointerLeave={handlePointerUp}
                        className={`w-full h-full ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
                      >
                        <defs>
                          <pattern
                            id="nexofis-graph-grid"
                            width="28"
                            height="28"
                            patternUnits="userSpaceOnUse"
                          >
                            <circle
                              cx="1"
                              cy="1"
                              r="1"
                              className="fill-slate-300/60 dark:fill-[#1D3A57]/60"
                            />
                          </pattern>
                        </defs>
                        <rect
                          x="0"
                          y="0"
                          width={effectiveWidth}
                          height={payload.layout.height}
                          fill="url(#nexofis-graph-grid)"
                        />

                        <g
                          transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}
                          style={{ transformOrigin: 'center center' }}
                        >
                          {/* Subtle Column Guide Labels */}
                          <text
                            x={150}
                            y={28}
                            textAnchor="middle"
                            className="fill-slate-400 dark:fill-slate-500 text-[12px] font-mono uppercase tracking-wider"
                          >
                            Sócios ({Math.min(payload.partners.length, 8)}
                            {payload.summary.visualPartnersTruncated
                              ? `/${payload.partners.length}`
                              : ''}
                            )
                          </text>
                          <text
                            x={465}
                            y={28}
                            textAnchor="middle"
                            className="fill-slate-400 dark:fill-slate-500 text-[12px] font-mono uppercase tracking-wider"
                          >
                            Empresas ({payload.companies.length})
                          </text>
                          {renderContractsCol && (
                            <text
                              x={790}
                              y={28}
                              textAnchor="middle"
                              className="fill-slate-400 dark:fill-slate-500 text-[12px] font-mono uppercase tracking-wider"
                            >
                              Contratos ({Math.min(payload.contracts.length, 8)}
                              {payload.summary.visualContractsTruncated
                                ? `/${payload.contracts.length}`
                                : ''}
                              )
                            </text>
                          )}
                          {renderOrgansCol && (
                            <text
                              x={renderContractsCol ? 1100 : 790}
                              y={28}
                              textAnchor="middle"
                              className="fill-slate-400 dark:fill-slate-500 text-[12px] font-mono uppercase tracking-wider"
                            >
                              Órgãos ({payload.summary.distinctOrganCount})
                            </text>
                          )}

                          {/* Edges */}
                          {visibleEdges.map((edge) => {
                            const src = nodeById.get(edge.source);
                            const tgt = nodeById.get(edge.target);
                            if (!src || !tgt) return null;

                            const x1 = src.x + NODE_WIDTH / 2;
                            const y1 = src.y;
                            const x2 = tgt.x - NODE_WIDTH / 2;
                            const y2 = tgt.y;
                            const isHoverDimmed =
                              Boolean(hoveredNodeId) && !highlightedEdgeIds.has(edge.id);
                            const isEmphasized =
                              Boolean(focusNodeId) && highlightedEdgeIds.has(edge.id);

                            const strokeColor =
                              edge.relation === 'SOCIO_DE'
                                ? edge.dashed
                                  ? '#D97706'
                                  : '#D95B35'
                                : edge.relation === 'CONTRATADO_POR'
                                  ? '#64748B'
                                  : '#3B82F6';

                            return (
                              <path
                                key={edge.id}
                                d={buildCurvedPath(x1, y1, x2, y2)}
                                fill="none"
                                stroke={strokeColor}
                                strokeWidth={isEmphasized ? 2.2 : 1.4}
                                strokeDasharray={edge.dashed ? '6 4' : undefined}
                                opacity={isHoverDimmed ? 0.16 : isEmphasized ? 0.92 : 0.62}
                                className="transition-opacity duration-150"
                              />
                            );
                          })}

                          {/* Nodes */}
                          {visibleNodes.map((node) => {
                            const isSelected = selectedNodeId === node.id;
                            const isDimmed =
                              Boolean(hoveredNodeId) && !highlightedNodeIds.has(node.id);
                            const left = node.x - NODE_WIDTH / 2;
                            const top = node.y - NODE_HEIGHT / 2;

                            let accentBarColor = '#0B2540';
                            if (node.type === 'partner') {
                              accentBarColor =
                                node.confidence === 'homonym_risk' ? '#D97706' : '#D95B35';
                            } else if (node.type === 'company') {
                              accentBarColor = node.isSeed ? '#D95B35' : '#1D4ED8';
                            } else if (node.type === 'contract') {
                              accentBarColor = getRiskAccent(node.riskScore).stroke;
                            } else if (node.type === 'organ') {
                              accentBarColor = node.isSharedOrgan ? '#D97706' : '#475569';
                            }

                            return (
                              <g
                                key={node.id}
                                data-graph-node="true"
                                transform={`translate(${left}, ${top})`}
                                opacity={isDimmed ? 0.25 : 1}
                                onClick={() => setSelectedNodeId(node.id)}
                                onMouseEnter={() => setHoveredNodeId(node.id)}
                                onMouseLeave={() => setHoveredNodeId(null)}
                                className="cursor-pointer transition-opacity duration-150"
                              >
                                <rect
                                  x="0"
                                  y="0"
                                  width={NODE_WIDTH}
                                  height={NODE_HEIGHT}
                                  rx="6"
                                  className="fill-white dark:fill-[#0B1D31]"
                                  stroke={isSelected ? '#D95B35' : accentBarColor}
                                  strokeWidth={isSelected ? 2.5 : node.isSeed ? 2 : 1.2}
                                />
                                {/* Top hairline category indicator */}
                                <rect
                                  x="1"
                                  y="1"
                                  width={NODE_WIDTH - 2}
                                  height="3.5"
                                  rx="2"
                                  fill={accentBarColor}
                                />
                                <text
                                  x="11"
                                  y="24"
                                  className="fill-[#0B2540] dark:fill-[#FAF9F5] text-[11.5px] font-semibold"
                                >
                                  {node.label}
                                </text>
                                <text
                                  x="11"
                                  y="42"
                                  className="fill-slate-500 dark:fill-slate-400 text-[10px] font-mono"
                                >
                                  {node.subtitle.length > 34
                                    ? `${node.subtitle.slice(0, 33)}…`
                                    : node.subtitle}
                                </text>
                              </g>
                            );
                          })}
                        </g>
                      </svg>
                    </div>

                    {(payload.summary.visualPartnersTruncated ||
                      (payload.summary.visualContractsTruncated && showContractsLayer)) && (
                      <div className="px-4 py-2 border-t border-slate-200 dark:border-[#1D3A57] text-[11px] text-slate-500 dark:text-slate-400">
                        Para manter a legibilidade do diagrama, exibimos os principais nós por
                        coluna (até 8 sócios/contratos). A relação completa de{' '}
                        {payload.partners.length}{' '}
                        {payload.partners.length === 1 ? 'sócio' : 'sócios'} e{' '}
                        {payload.contracts.length}{' '}
                        {payload.contracts.length === 1 ? 'contrato' : 'contratos'} está disponível
                        nas tabelas abaixo.
                      </div>
                    )}
                  </div>

                  {/* Right-Hand Node Detail Inspector */}
                  <aside className="xl:col-span-4 p-5 bg-white dark:bg-[#0B1D31] flex flex-col justify-between gap-4">
                    {!selectedNode ? (
                      <div className="my-auto text-center space-y-2 py-10">
                        <Network
                          className="w-6 h-6 text-slate-400 mx-auto"
                          aria-hidden="true"
                        />
                        <p className="text-sm font-medium text-[#0B2540] dark:text-[#FAF9F5]">
                          Selecione um nó no mapa
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          Clique em um sócio, empresa, contrato ou órgão para inspecionar vínculos,
                          valores e navegar para o dossiê completo.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        <div className="pb-3 border-b border-slate-200 dark:border-[#1D3A57] space-y-1">
                          <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-[#D95B35] font-semibold">
                            {selectedNode.type === 'partner' && (
                              <>
                                <User className="w-3.5 h-3.5" aria-hidden="true" />
                                <span>Sócio / Empresário</span>
                              </>
                            )}
                            {selectedNode.type === 'company' && (
                              <>
                                <Building2 className="w-3.5 h-3.5" aria-hidden="true" />
                                <span>Empresa (Pessoa Jurídica)</span>
                              </>
                            )}
                            {selectedNode.type === 'contract' && (
                              <>
                                <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                                <span>Contrato Público</span>
                              </>
                            )}
                            {selectedNode.type === 'organ' && (
                              <>
                                <Landmark className="w-3.5 h-3.5" aria-hidden="true" />
                                <span>Órgão Contratante</span>
                              </>
                            )}
                          </div>
                          <h3 className="text-sm font-bold text-[#0B2540] dark:text-[#FAF9F5] break-words">
                            {selectedPartnerDetail?.displayName ||
                              selectedCompanyDetail?.legalName ||
                              (selectedContractDetail
                                ? `Contrato ${selectedContractDetail.contractNumber}`
                                : String(selectedNode.metadata.organName || selectedNode.label))}
                          </h3>
                        </div>

                        {/* Partner Inspector Body */}
                        {selectedPartnerDetail && (
                          <div className="space-y-3 text-xs">
                            <dl className="grid grid-cols-2 gap-3">
                              <div>
                                <dt className="text-slate-500 dark:text-slate-400">
                                  Empresas vinculadas
                                </dt>
                                <dd className="font-mono tabular-nums font-semibold text-sm text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                                  {selectedPartnerDetail.companyCount}
                                </dd>
                              </div>
                              <div>
                                <dt className="text-slate-500 dark:text-slate-400">
                                  Contratos na rede
                                </dt>
                                <dd className="font-mono tabular-nums font-semibold text-sm text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                                  {selectedPartnerDetail.contractCount}
                                </dd>
                              </div>
                              <div className="col-span-2">
                                <dt className="text-slate-500 dark:text-slate-400">
                                  Valor contratual agregado das empresas
                                </dt>
                                <dd className="font-mono tabular-nums font-semibold text-sm text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                                  {formatCurrencyBRL(selectedPartnerDetail.totalContractValue)}
                                </dd>
                              </div>
                              <div className="col-span-2">
                                <dt className="text-slate-500 dark:text-slate-400">
                                  Identificação pública (QSA)
                                </dt>
                                <dd className="font-mono text-slate-700 dark:text-slate-200 mt-0.5">
                                  {selectedPartnerDetail.maskedDocument
                                    ? `Doc. mascarado: ${selectedPartnerDetail.maskedDocument}`
                                    : 'Sem fragmento de CPF na fonte'}
                                </dd>
                              </div>
                            </dl>

                            {selectedPartnerDetail.hasHomonymWarning && (
                              <div className="p-3 rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 text-amber-800 dark:text-amber-300">
                                Vínculo baseado em coincidência nominal sem confirmação completa de
                                CPF. Conferir contrato social antes de concluir identidade única.
                              </div>
                            )}

                            <div className="space-y-1.5">
                              <div className="font-semibold text-slate-700 dark:text-slate-200">
                                Participações societárias
                              </div>
                              <ul className="space-y-1.5 max-h-40 overflow-y-auto">
                                {selectedPartnerDetail.roles.map((r, i) => (
                                  <li
                                    key={`${r.cnpj}-${i}`}
                                    className="p-2 rounded bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57]"
                                  >
                                    <div className="font-medium text-[#0B2540] dark:text-[#FAF9F5]">
                                      {r.companyName}
                                    </div>
                                    <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                                      {r.role}
                                      {r.entryDate ? ` · entrada ${formatDateBR(r.entryDate)}` : ''}
                                    </div>
                                  </li>
                                ))}
                              </ul>
                            </div>

                            <button
                              type="button"
                              onClick={() =>
                                handleQuickQuery(selectedPartnerDetail.displayName, 'partner')
                              }
                              className="w-full py-2 px-3 text-xs font-semibold text-white bg-[#0B2540] dark:bg-[#D95B35] hover:opacity-90 rounded-md transition-opacity"
                            >
                              Centralizar mapa neste sócio
                            </button>
                          </div>
                        )}

                        {/* Company Inspector Body */}
                        {selectedCompanyDetail && (
                          <div className="space-y-3 text-xs">
                            <dl className="grid grid-cols-2 gap-3">
                              <div className="col-span-2">
                                <dt className="text-slate-500 dark:text-slate-400">CNPJ</dt>
                                <dd className="font-mono tabular-nums font-semibold text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                                  {selectedCompanyDetail.formattedCnpj}
                                </dd>
                              </div>
                              <div>
                                <dt className="text-slate-500 dark:text-slate-400">Situação</dt>
                                <dd className="font-medium text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                                  {selectedCompanyDetail.registrationStatus}
                                </dd>
                              </div>
                              <div>
                                <dt className="text-slate-500 dark:text-slate-400">Abertura</dt>
                                <dd className="font-mono tabular-nums text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                                  {selectedCompanyDetail.openingDate
                                    ? formatDateBR(selectedCompanyDetail.openingDate)
                                    : '—'}
                                </dd>
                              </div>
                              <div>
                                <dt className="text-slate-500 dark:text-slate-400">Contratos</dt>
                                <dd className="font-mono tabular-nums font-semibold text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                                  {selectedCompanyDetail.contractCount}
                                </dd>
                              </div>
                              <div>
                                <dt className="text-slate-500 dark:text-slate-400">Valor total</dt>
                                <dd className="font-mono tabular-nums font-semibold text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                                  {formatCurrencyBRL(selectedCompanyDetail.totalContractValue)}
                                </dd>
                              </div>
                              {selectedCompanyDetail.viaPartners.length > 0 && (
                                <div className="col-span-2">
                                  <dt className="text-slate-500 dark:text-slate-400">
                                    Vinculada por meio de
                                  </dt>
                                  <dd className="text-[#D95B35] font-medium mt-0.5">
                                    {selectedCompanyDetail.viaPartners.join(', ')}
                                  </dd>
                                </div>
                              )}
                              {selectedCompanyDetail.primaryCnaeDescription && (
                                <div className="col-span-2">
                                  <dt className="text-slate-500 dark:text-slate-400">
                                    CNAE Principal
                                  </dt>
                                  <dd className="text-slate-700 dark:text-slate-200 mt-0.5">
                                    <span className="font-mono">
                                      {selectedCompanyDetail.primaryCnaeCode}
                                    </span>{' '}
                                    — {selectedCompanyDetail.primaryCnaeDescription}
                                  </dd>
                                </div>
                              )}
                            </dl>

                            <button
                              type="button"
                              onClick={() =>
                                handleQuickQuery(selectedCompanyDetail.cnpj, 'company')
                              }
                              className="w-full py-2 px-3 text-xs font-semibold text-white bg-[#0B2540] dark:bg-[#D95B35] hover:opacity-90 rounded-md transition-opacity"
                            >
                              Centralizar mapa e sincronizar PNCP desta empresa
                            </button>
                          </div>
                        )}

                        {/* Contract Inspector Body */}
                        {selectedContractDetail && (
                          <div className="space-y-3 text-xs">
                            <dl className="grid grid-cols-2 gap-3">
                              <div className="col-span-2">
                                <dt className="text-slate-500 dark:text-slate-400">
                                  Órgão contratante
                                </dt>
                                <dd className="font-medium text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                                  {selectedContractDetail.entityName}
                                </dd>
                              </div>
                              <div className="col-span-2">
                                <dt className="text-slate-500 dark:text-slate-400">Fornecedor</dt>
                                <dd className="font-medium text-slate-700 dark:text-slate-200 mt-0.5">
                                  {selectedContractDetail.companyName} (
                                  <span className="font-mono">
                                    {selectedContractDetail.formattedCompanyCnpj}
                                  </span>
                                  )
                                </dd>
                              </div>
                              <div>
                                <dt className="text-slate-500 dark:text-slate-400">
                                  Valor atualizado
                                </dt>
                                <dd className="font-mono tabular-nums font-semibold text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                                  {formatCurrencyBRL(selectedContractDetail.updatedValue)}
                                </dd>
                              </div>
                              <div>
                                <dt className="text-slate-500 dark:text-slate-400">
                                  Score de risco
                                </dt>
                                <dd
                                  className={`font-mono tabular-nums mt-0.5 ${
                                    getRiskAccent(selectedContractDetail.riskScore ?? undefined)
                                      .textClass
                                  }`}
                                >
                                  {selectedContractDetail.riskScore !== null
                                    ? `${selectedContractDetail.riskScore}/100`
                                    : 'Cobertura insuf.'}
                                </dd>
                              </div>
                              <div className="col-span-2">
                                <dt className="text-slate-500 dark:text-slate-400">Objeto</dt>
                                <dd className="text-slate-600 dark:text-slate-300 mt-0.5 leading-relaxed">
                                  {selectedContractDetail.objectSummary}
                                </dd>
                              </div>
                            </dl>

                            {evaluatedContractMap.has(selectedContractDetail.contractId) && (
                              <button
                                type="button"
                                onClick={() =>
                                  handleOpenContractById(selectedContractDetail.contractId)
                                }
                                className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-semibold text-white bg-[#0B2540] dark:bg-[#D95B35] hover:opacity-90 rounded-md transition-opacity"
                              >
                                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                                <span>Abrir Dossiê Completo</span>
                              </button>
                            )}
                          </div>
                        )}

                        {/* Organ Inspector Body */}
                        {selectedNode.type === 'organ' && (
                          <div className="space-y-3 text-xs">
                            <dl className="grid grid-cols-2 gap-3">
                              <div>
                                <dt className="text-slate-500 dark:text-slate-400">
                                  Empresas da rede
                                </dt>
                                <dd className="font-mono tabular-nums font-semibold text-sm text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                                  {selectedNode.companyCount ?? 1}
                                </dd>
                              </div>
                              <div>
                                <dt className="text-slate-500 dark:text-slate-400">Contratos</dt>
                                <dd className="font-mono tabular-nums font-semibold text-sm text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                                  {selectedNode.contractCount ?? 0}
                                </dd>
                              </div>
                              <div className="col-span-2">
                                <dt className="text-slate-500 dark:text-slate-400">
                                  Volume contratado com a rede
                                </dt>
                                <dd className="font-mono tabular-nums font-semibold text-sm text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                                  {formatCurrencyBRL(selectedNode.value ?? 0)}
                                </dd>
                              </div>
                              {selectedNode.metadata.municipalityName && (
                                <div className="col-span-2">
                                  <dt className="text-slate-500 dark:text-slate-400">Município</dt>
                                  <dd className="text-slate-700 dark:text-slate-200 mt-0.5">
                                    {String(selectedNode.metadata.municipalityName)}
                                  </dd>
                                </div>
                              )}
                            </dl>
                            {selectedNode.isSharedOrgan && (
                              <div className="p-3 rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 text-amber-800 dark:text-amber-300">
                                Este órgão contratou com múltiplas empresas vinculadas ao mesmo
                                quadro societário.
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Forensic Safeguard Footer */}
                    <div className="pt-3 border-t border-slate-200 dark:border-[#1D3A57] text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                      {payload.methodologicalNotice}
                    </div>
                  </aside>
                </div>
              </section>

              {/* Tabbed Analytical Tables */}
              <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg overflow-hidden">
                <div className="px-5 pt-4 border-b border-slate-200 dark:border-[#1D3A57] flex items-center gap-6 overflow-x-auto">
                  {(
                    [
                      { id: 'companies', label: `Empresas Vinculadas (${payload.companies.length})` },
                      { id: 'partners', label: `Sócios e Vínculos (${payload.partners.length})` },
                      { id: 'contracts', label: `Contratos da Rede (${payload.contracts.length})` },
                    ] as const
                  ).map((tab) => {
                    const active = detailTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setDetailTab(tab.id)}
                        className={`pb-3 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap ${
                          active
                            ? 'border-[#0B2540] dark:border-[#D95B35] text-[#0B2540] dark:text-[#FAF9F5]'
                            : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-[#0B2540] dark:hover:text-white'
                        }`}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
                </div>

                {/* Tab 1: Linked Companies */}
                {detailTab === 'companies' && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 dark:bg-[#061321] border-b border-slate-200 dark:border-[#1D3A57] text-slate-500 dark:text-slate-400">
                        <tr>
                          <th className="py-3 px-4 font-semibold">Empresa / CNPJ</th>
                          <th className="py-3 px-4 font-semibold">Conexão Societária</th>
                          <th className="py-3 px-4 font-semibold">Situação / Sede</th>
                          <th className="py-3 px-4 font-semibold text-right">Contratos</th>
                          <th className="py-3 px-4 font-semibold text-right">Valor Agregado</th>
                          <th className="py-3 px-4 font-semibold text-right">Ação</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-[#1D3A57]">
                        {payload.companies.map((comp) => (
                          <tr
                            key={comp.cnpj}
                            className="hover:bg-slate-50/70 dark:hover:bg-[#102843]/60"
                          >
                            <td className="py-3 px-4">
                              <div className="font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                                {comp.legalName}
                              </div>
                              <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                                {comp.formattedCnpj}
                                {comp.isSeed ? ' · Empresa consultada' : ''}
                              </div>
                            </td>
                            <td className="py-3 px-4 text-slate-600 dark:text-slate-300">
                              {comp.isSeed
                                ? `${comp.partnerCount} sócio(s) no QSA`
                                : comp.viaPartners.length > 0
                                  ? `Via ${comp.viaPartners.join(', ')}`
                                  : 'Vínculo direto'}
                            </td>
                            <td className="py-3 px-4 text-slate-600 dark:text-slate-300">
                              <div>{comp.registrationStatus}</div>
                              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                                {comp.municipality
                                  ? `${comp.municipality}/${comp.uf}`
                                  : 'Sede não informada'}
                              </div>
                            </td>
                            <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                              {comp.contractCount}
                            </td>
                            <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-[#0B2540] dark:text-[#FAF9F5] whitespace-nowrap">
                              {formatCurrencyBRL(comp.totalContractValue)}
                            </td>
                            <td className="py-3 px-4 text-right">
                              <button
                                type="button"
                                onClick={() => handleQuickQuery(comp.cnpj, 'company')}
                                className="text-xs font-semibold text-[#D95B35] hover:underline whitespace-nowrap"
                              >
                                Centralizar
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Tab 2: Partners */}
                {detailTab === 'partners' && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 dark:bg-[#061321] border-b border-slate-200 dark:border-[#1D3A57] text-slate-500 dark:text-slate-400">
                        <tr>
                          <th className="py-3 px-4 font-semibold">Sócio / Empresário</th>
                          <th className="py-3 px-4 font-semibold">Confiabilidade do Vínculo</th>
                          <th className="py-3 px-4 font-semibold">Empresas e Qualificações</th>
                          <th className="py-3 px-4 font-semibold text-right">Contratos</th>
                          <th className="py-3 px-4 font-semibold text-right">Valor Agregado</th>
                          <th className="py-3 px-4 font-semibold text-right">Ação</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-[#1D3A57]">
                        {payload.partners.map((partner) => (
                          <tr
                            key={partner.id}
                            className="hover:bg-slate-50/70 dark:hover:bg-[#102843]/60"
                          >
                            <td className="py-3 px-4">
                              <div className="font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                                {partner.displayName}
                              </div>
                              <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                                {partner.maskedDocument
                                  ? `Doc. QSA: ${partner.maskedDocument}`
                                  : 'Sem CPF mascarado na fonte'}
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              {partner.confidence === 'name_and_masked_cpf' ? (
                                <span className="font-medium text-emerald-700 dark:text-emerald-400">
                                  Nome + CPF mascarado coincidente
                                </span>
                              ) : partner.confidence === 'homonym_risk' ? (
                                <span className="font-medium text-amber-700 dark:text-amber-400">
                                  Coincidência nominal — conferir homonímia
                                </span>
                              ) : (
                                <span className="text-slate-500 dark:text-slate-400">
                                  Empresa única observada
                                </span>
                              )}
                            </td>
                            <td className="py-3 px-4 text-slate-600 dark:text-slate-300">
                              <div className="space-y-1">
                                {partner.roles.map((r, i) => (
                                  <div key={`${r.cnpj}-${i}`}>
                                    <span className="font-medium text-[#0B2540] dark:text-slate-100">
                                      {r.companyName}
                                    </span>{' '}
                                    · {r.role}
                                  </div>
                                ))}
                              </div>
                            </td>
                            <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                              {partner.contractCount}
                            </td>
                            <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-[#0B2540] dark:text-[#FAF9F5] whitespace-nowrap">
                              {formatCurrencyBRL(partner.totalContractValue)}
                            </td>
                            <td className="py-3 px-4 text-right">
                              <button
                                type="button"
                                onClick={() => handleQuickQuery(partner.displayName, 'partner')}
                                className="text-xs font-semibold text-[#D95B35] hover:underline whitespace-nowrap"
                              >
                                Centralizar
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Tab 3: All Contracts Across Network */}
                {detailTab === 'contracts' && (
                  <div className="overflow-x-auto">
                    {payload.contracts.length === 0 ? (
                      <div className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">
                        Nenhum contrato público localizado no banco local ou PNCP para as empresas
                        desta rede.
                      </div>
                    ) : (
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-50 dark:bg-[#061321] border-b border-slate-200 dark:border-[#1D3A57] text-slate-500 dark:text-slate-400">
                          <tr>
                            <th className="py-3 px-4 font-semibold">Contrato / Data</th>
                            <th className="py-3 px-4 font-semibold">Empresa Fornecedora</th>
                            <th className="py-3 px-4 font-semibold">Órgão Contratante</th>
                            <th className="py-3 px-4 font-semibold text-right">Valor</th>
                            <th className="py-3 px-4 font-semibold text-right">Risco</th>
                            <th className="py-3 px-4 font-semibold text-right">Dossiê</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-[#1D3A57]">
                          {payload.contracts.map((ct) => {
                            const hasEvaluated = evaluatedContractMap.has(ct.contractId);
                            return (
                              <tr
                                key={ct.contractId}
                                className="hover:bg-slate-50/70 dark:hover:bg-[#102843]/60"
                              >
                                <td className="py-3 px-4">
                                  <div className="font-mono font-semibold text-[#0B2540] dark:text-[#FAF9F5] whitespace-nowrap">
                                    {ct.contractNumber}
                                  </div>
                                  <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                                    {ct.signatureDate ? formatDateBR(ct.signatureDate) : '—'}
                                  </div>
                                </td>
                                <td className="py-3 px-4">
                                  <div className="font-medium text-[#0B2540] dark:text-slate-100">
                                    {ct.companyName}
                                  </div>
                                  <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                                    {ct.formattedCompanyCnpj}
                                  </div>
                                </td>
                                <td className="py-3 px-4 text-slate-600 dark:text-slate-300">
                                  <div>{ct.entityName}</div>
                                  {ct.municipalityName && (
                                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                                      {ct.municipalityName}
                                    </div>
                                  )}
                                </td>
                                <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-[#0B2540] dark:text-[#FAF9F5] whitespace-nowrap">
                                  {formatCurrencyBRL(ct.updatedValue)}
                                </td>
                                <td
                                  className={`py-3 px-4 text-right font-mono tabular-nums whitespace-nowrap ${
                                    getRiskAccent(ct.riskScore ?? undefined).textClass
                                  }`}
                                >
                                  {ct.riskScore !== null ? `${ct.riskScore}/100` : 'Insuf.'}
                                </td>
                                <td className="py-3 px-4 text-right">
                                  {hasEvaluated ? (
                                    <button
                                      type="button"
                                      onClick={() => handleOpenContractById(ct.contractId)}
                                      className="inline-flex items-center gap-1 text-xs font-semibold text-[#0B2540] dark:text-sky-300 hover:text-[#D95B35] whitespace-nowrap"
                                    >
                                      <span>Abrir Dossiê</span>
                                      <ExternalLink className="w-3 h-3" aria-hidden="true" />
                                    </button>
                                  ) : (
                                    <span className="text-slate-400">—</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Building2,
  ChevronRight,
  ExternalLink,
  FileSearch,
  FileUp,
  FolderArchive,
  Lock,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Scale,
  Sun,
  UserCheck,
  X,
} from 'lucide-react';
import type {
  EvaluatedContract,
  Municipality,
  SavedDossierSnapshot,
  SavedDossierSummary,
} from './types/audit';
import {
  bootstrapAdmin,
  clearAuthToken,
  deleteSavedDossier,
  fetchAuthStatus,
  fetchContractById,
  fetchDossierSnapshot,
  fetchSavedDossiers,
  loginAuth,
  type AuthPrincipalInfo,
  type AuthStatusResponse,
} from './lib/api';
import {
  applyThemeToDocument,
  getNextTheme,
  readSidebarCollapsed,
  readStoredTheme,
  subscribeToThemeStorage,
  writeSidebarCollapsed,
  type ThemeMode,
} from './lib/theme';
import { NexofisBrandLogo } from './components/NexofisBrandLogo';
import { MunicipalityView } from './components/MunicipalityView';
import { ContractSearchView, type ContractSearchFilterState } from './components/ContractSearchView';
import { DocumentUploadView } from './components/DocumentUploadView';
import { ContractDossierView } from './components/ContractDossierView';
import { SavedDossiersView } from './components/SavedDossiersView';
import { RiskDashboardView } from './components/RiskDashboardView';
import { ToastContainer } from './components/ToastContainer';

type ActiveSection = 'dashboard' | 'municipio' | 'contrato' | 'documento' | 'dossies';

interface UrlState {
  section: ActiveSection;
  ibge: string;
  entityId: string;
  q: string;
  year: string;
  status: '' | 'em_andamento' | 'concluido' | 'suspenso';
  startDate: string;
  endDate: string;
  minRisk: number;
  contractId: string;
  dossierId: string;
}

function readUrlState(): UrlState {
  if (typeof window === 'undefined') {
    return {
      section: 'municipio',
      ibge: '',
      entityId: 'ALL',
      q: '',
      year: '',
      status: '',
      startDate: '',
      endDate: '',
      minRisk: 0,
      contractId: '',
      dossierId: '',
    };
  }
  const params = new URLSearchParams(window.location.search);
  const rawSec = params.get('sec');
  const section: ActiveSection =
    rawSec === 'dashboard' ||
    rawSec === 'contrato' ||
    rawSec === 'documento' ||
    rawSec === 'dossies'
      ? rawSec
      : 'municipio';
  const rawIbge = params.get('ibge') ?? '';
  const ibge = /^\d{7}$/.test(rawIbge) ? rawIbge : '';
  const entityId = params.get('ent') || 'ALL';
  const q = params.get('q') ?? '';
  const year = params.get('year') ?? '';
  const rawStatus = params.get('status') ?? '';
  const status =
    rawStatus === 'em_andamento' || rawStatus === 'concluido' || rawStatus === 'suspenso'
      ? rawStatus
      : '';
  const startDate = params.get('from') ?? '';
  const endDate = params.get('to') ?? '';
  const rawMinRisk = Number(params.get('minRisk') ?? 0);
  const minRisk = Number.isFinite(rawMinRisk) && rawMinRisk > 0 ? rawMinRisk : 0;
  const contractId = params.get('contract') ?? '';
  const dossierId = params.get('dossier') ?? '';

  return {
    section,
    ibge,
    entityId,
    q,
    year,
    status,
    startDate,
    endDate,
    minRisk,
    contractId,
    dossierId,
  };
}

export default function App() {
  const initial = readUrlState();
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme());
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => readSidebarCollapsed());

  const [section, setSection] = useState<ActiveSection>(initial.section);
  const [activeIbge, setActiveIbge] = useState<string>(initial.ibge);
  const [selectedEntityId, setSelectedEntityId] = useState<string>(initial.entityId);
  const [periodFilter, setPeriodFilter] = useState<{ startDate: string; endDate: string }>({
    startDate: initial.startDate,
    endDate: initial.endDate,
  });
  const [searchFilters, setSearchFilters] = useState<ContractSearchFilterState>({
    query: initial.q,
    ibgeFilter: initial.section === 'contrato' ? initial.ibge : '',
    municipalityInput: '',
    yearFilter: initial.year,
    statusFilter: initial.status,
    startDate: initial.startDate,
    endDate: initial.endDate,
    minRisk: initial.minRisk,
  });

  const [activeContract, setActiveContract] = useState<EvaluatedContract | null>(null);
  const [archivedSnapshot, setArchivedSnapshot] = useState<SavedDossierSnapshot | null>(null);
  const [deepLinkLoading, setDeepLinkLoading] = useState<boolean>(
    Boolean(initial.contractId || initial.dossierId)
  );
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);

  const [breadcrumbCtx, setBreadcrumbCtx] = useState<{
    municipality: Municipality | null;
    entityName: string | null;
  }>({ municipality: null, entityName: null });

  const [savedDossiers, setSavedDossiers] = useState<SavedDossierSummary[]>([]);
  const [dossiersError, setDossiersError] = useState<string | null>(null);
  const [dossiersLoading, setDossiersLoading] = useState<boolean>(true);

  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authEmail, setAuthEmail] = useState('');
  const [authName, setAuthName] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [licenseModalOpen, setLicenseModalOpen] = useState(false);

  // Sync theme to <html> class & localStorage + listen for cross-tab changes
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  useEffect(() => {
    return subscribeToThemeStorage((nextTheme) => {
      setTheme(nextTheme);
    });
  }, []);

  const handleToggleTheme = () => {
    setTheme((prev) => getNextTheme(prev));
  };

  const handleToggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      writeSidebarCollapsed(next);
      return next;
    });
  };

  const refreshAuthStatus = useCallback(async () => {
    try {
      const st = await fetchAuthStatus();
      setAuthStatus(st);
    } catch {
      // Non-fatal on boot
    }
  }, []);

  const refreshDossiers = useCallback(async () => {
    setDossiersLoading(true);
    setDossiersError(null);
    try {
      const rows = await fetchSavedDossiers();
      setSavedDossiers(rows);
    } catch (err) {
      setDossiersError(
        err instanceof Error ? err.message : 'Falha ao carregar dossiês arquivados.'
      );
    } finally {
      setDossiersLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshAuthStatus();
    refreshDossiers();
  }, [refreshAuthStatus, refreshDossiers]);

  // Hydrate deep-linked ?contract= or ?dossier= on initial load & popstate (UI-03)
  const hydrateDeepLink = useCallback(async (contractId: string, dossierId: string) => {
    if (!contractId && !dossierId) {
      setActiveContract(null);
      setArchivedSnapshot(null);
      setDeepLinkError(null);
      setDeepLinkLoading(false);
      return;
    }

    setDeepLinkLoading(true);
    setDeepLinkError(null);
    try {
      if (dossierId) {
        const snapshot = await fetchDossierSnapshot(dossierId);
        if (snapshot.snapshotContract) {
          setArchivedSnapshot(snapshot);
          setActiveContract(snapshot.snapshotContract);
        } else {
          const live = await fetchContractById(snapshot.contractId);
          setArchivedSnapshot(snapshot);
          setActiveContract(live);
        }
      } else if (contractId) {
        const evaluated = await fetchContractById(contractId);
        setArchivedSnapshot(null);
        setActiveContract(evaluated);
      }
    } catch (err) {
      setActiveContract(null);
      setArchivedSnapshot(null);
      setDeepLinkError(
        err instanceof Error
          ? err.message
          : 'O contrato ou dossiê referenciado na URL não foi localizado.'
      );
    } finally {
      setDeepLinkLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initial.contractId || initial.dossierId) {
      hydrateDeepLink(initial.contractId, initial.dossierId);
    }
  }, []);

  // Listen to browser Back/Forward (popstate) for full URL hydration
  useEffect(() => {
    const onPopState = () => {
      const next = readUrlState();
      setSection(next.section);
      setActiveIbge(next.ibge);
      setSelectedEntityId(next.entityId);
      setPeriodFilter({ startDate: next.startDate, endDate: next.endDate });
      setSearchFilters((prev) => ({
        ...prev,
        query: next.q,
        ibgeFilter: next.section === 'contrato' ? next.ibge : prev.ibgeFilter,
        yearFilter: next.year,
        statusFilter: next.status,
        startDate: next.startDate,
        endDate: next.endDate,
        minRisk: next.minRisk,
      }));
      hydrateDeepLink(next.contractId, next.dossierId);
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [hydrateDeepLink]);

  // Synchronize URL query parameters cleanly (preserving deep-link state while loading)
  useEffect(() => {
    if (typeof window === 'undefined' || deepLinkLoading) return;
    const params = new URLSearchParams();
    params.set('sec', section);

    if (section === 'dashboard') {
      if (periodFilter.startDate) params.set('from', periodFilter.startDate);
      if (periodFilter.endDate) params.set('to', periodFilter.endDate);
    } else if (section === 'municipio') {
      if (activeIbge) params.set('ibge', activeIbge);
      if (selectedEntityId && selectedEntityId !== 'ALL') {
        params.set('ent', selectedEntityId);
      }
      if (periodFilter.startDate) params.set('from', periodFilter.startDate);
      if (periodFilter.endDate) params.set('to', periodFilter.endDate);
    } else if (section === 'contrato') {
      if (searchFilters.query) params.set('q', searchFilters.query);
      if (searchFilters.ibgeFilter) params.set('ibge', searchFilters.ibgeFilter);
      if (searchFilters.yearFilter) params.set('year', searchFilters.yearFilter);
      if (searchFilters.statusFilter) params.set('status', searchFilters.statusFilter);
      if (searchFilters.startDate) params.set('from', searchFilters.startDate);
      if (searchFilters.endDate) params.set('to', searchFilters.endDate);
      if (searchFilters.minRisk > 0) params.set('minRisk', String(searchFilters.minRisk));
    }

    if (archivedSnapshot) {
      params.set('dossier', archivedSnapshot.id);
    } else if (activeContract) {
      params.set('contract', activeContract.id);
    }

    const qs = params.toString();
    const nextUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    if (nextUrl !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, '', nextUrl);
    }
  }, [
    section,
    activeIbge,
    selectedEntityId,
    periodFilter,
    searchFilters,
    activeContract,
    archivedSnapshot,
    deepLinkLoading,
  ]);

  const handleNavigate = (target: ActiveSection) => {
    setSection(target);
    setActiveContract(null);
    setArchivedSnapshot(null);
    setDeepLinkError(null);
    setMobileMenuOpen(false);
    window.scrollTo(0, 0);
  };

  const handleOpenContract = (contract: EvaluatedContract) => {
    setArchivedSnapshot(null);
    setDeepLinkError(null);
    setActiveContract(contract);
    setMobileMenuOpen(false);
    window.scrollTo(0, 0);
  };

  const handleOpenContractById = async (contractId: string) => {
    setDeepLinkLoading(true);
    setDeepLinkError(null);
    try {
      const evaluated = await fetchContractById(contractId);
      setArchivedSnapshot(null);
      setActiveContract(evaluated);
      window.scrollTo(0, 0);
    } catch (err) {
      setDeepLinkError(
        err instanceof Error ? err.message : 'Contrato não localizado no banco local.'
      );
    } finally {
      setDeepLinkLoading(false);
    }
  };

  const handleOpenArchivedDossier = async (dossierId: string) => {
    setDeepLinkLoading(true);
    setDeepLinkError(null);
    try {
      const snapshot = await fetchDossierSnapshot(dossierId);
      if (snapshot.snapshotContract) {
        setArchivedSnapshot(snapshot);
        setActiveContract(snapshot.snapshotContract);
      } else {
        const live = await fetchContractById(snapshot.contractId);
        setArchivedSnapshot(snapshot);
        setActiveContract(live);
      }
      window.scrollTo(0, 0);
    } catch (err) {
      setDeepLinkError(
        err instanceof Error ? err.message : 'Não foi possível reabrir o snapshot do dossiê.'
      );
    } finally {
      setDeepLinkLoading(false);
    }
  };

  const handleDeleteDossier = async (id: string) => {
    setDossiersError(null);
    try {
      const updated = await deleteSavedDossier(id);
      setSavedDossiers(updated);
    } catch (err) {
      setDossiersError(
        err instanceof Error ? err.message : 'Falha ao remover dossiê arquivado.'
      );
    }
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthSubmitting(true);
    setAuthError(null);
    try {
      if (authStatus?.needsBootstrap) {
        await bootstrapAdmin({
          email: authEmail.trim(),
          displayName: authName.trim(),
          password: authPassword,
        });
      } else {
        await loginAuth({ email: authEmail.trim(), password: authPassword });
      }
      setAuthPassword('');
      setAuthModalOpen(false);
      await refreshAuthStatus();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Falha na autenticação.');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    clearAuthToken();
    await refreshAuthStatus();
  };

  const principal: AuthPrincipalInfo | null = authStatus?.principal ?? null;

  const navItems: Array<{
    id: ActiveSection;
    label: string;
    hint: string;
    icon: typeof Building2;
    count?: number;
  }> = [
    {
      id: 'dashboard',
      label: 'Dashboard',
      hint: 'Riscos agregados (SQLite)',
      icon: BarChart3,
    },
    {
      id: 'municipio',
      label: 'Município',
      hint: 'IBGE → Órgãos → Contratos',
      icon: Building2,
    },
    {
      id: 'contrato',
      label: 'Contrato',
      hint: 'Nº contrato, PNCP ou CNPJ',
      icon: FileSearch,
    },
    {
      id: 'documento',
      label: 'Documento',
      hint: 'Upload PDF/Imagem e OCR',
      icon: FileUp,
    },
    {
      id: 'dossies',
      label: 'Dossiês Salvos',
      hint: 'Snapshots imutáveis (SQLite)',
      icon: FolderArchive,
      count: savedDossiers.length,
    },
  ];

  return (
    <div className="min-h-screen bg-[#FAF9F5] text-[#0B2540] dark:bg-[#061321] dark:text-[#FAF9F5] flex transition-colors">
      {/* Desktop Collapsible Left Sidebar */}
      <aside
        aria-label="Navegação lateral principal"
        className={`hidden lg:flex lg:flex-col lg:shrink-0 bg-white dark:bg-[#0B1D31] border-r border-slate-200 dark:border-[#1D3A57] sticky top-0 h-screen transition-[width] duration-200 ${
          sidebarCollapsed ? 'lg:w-[76px]' : 'lg:w-64'
        }`}
      >
        <div
          className={`h-16 flex items-center border-b border-slate-200 dark:border-[#1D3A57] ${
            sidebarCollapsed ? 'justify-center px-2' : 'justify-between px-4'
          }`}
        >
          <button
            type="button"
            onClick={() => handleNavigate('municipio')}
            aria-label="Ir para página inicial NEXOFIS"
            className="flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[#D95B35] rounded"
          >
            <NexofisBrandLogo
              theme={theme}
              variant={sidebarCollapsed ? 'symbol' : 'horizontal'}
              className={sidebarCollapsed ? 'h-7' : 'h-7'}
            />
          </button>

          {!sidebarCollapsed && (
            <button
              type="button"
              onClick={handleToggleSidebar}
              aria-label="Recolher menu lateral"
              title="Recolher menu lateral"
              className="p-1.5 rounded-md text-slate-500 dark:text-slate-400 hover:text-[#0B2540] dark:hover:text-[#FAF9F5] hover:bg-[#E8F1F6] dark:hover:bg-[#102843] transition-colors"
            >
              <PanelLeftClose className="w-4 h-4" aria-hidden="true" />
            </button>
          )}
        </div>

        <nav aria-label="Entradas de investigação" className="flex-1 p-2.5 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = !activeContract && !deepLinkError && section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavigate(item.id)}
                aria-current={isActive ? 'page' : undefined}
                title={sidebarCollapsed ? `${item.label} — ${item.hint}` : undefined}
                className={`w-full rounded-md transition-colors flex ${
                  sidebarCollapsed
                    ? 'flex-col items-center justify-center py-2.5 px-1'
                    : 'text-left px-3 py-2.5 items-start gap-3'
                } ${
                  isActive
                    ? 'bg-[#E8F1F6] dark:bg-[#102843] text-[#0B2540] dark:text-[#FAF9F5] border-l-2 border-[#D95B35]'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-[#102843]/70 hover:text-[#0B2540] dark:hover:text-[#FAF9F5]'
                }`}
              >
                <Icon
                  className={`w-4 h-4 shrink-0 ${sidebarCollapsed ? '' : 'mt-0.5'} ${
                    isActive ? 'text-[#D95B35]' : 'text-slate-400 dark:text-slate-500'
                  }`}
                  aria-hidden="true"
                />
                {!sidebarCollapsed && (
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold whitespace-nowrap">{item.label}</span>
                      {item.count !== undefined && item.count > 0 && (
                        <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
                          {item.count}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                      {item.hint}
                    </div>
                  </div>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-slate-200 dark:border-[#1D3A57] space-y-2.5">
          {sidebarCollapsed ? (
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={handleToggleSidebar}
                aria-label="Expandir menu lateral"
                title="Expandir menu lateral"
                className="p-2 rounded-md text-slate-500 dark:text-slate-400 hover:bg-[#E8F1F6] dark:hover:bg-[#102843]"
              >
                <PanelLeftOpen className="w-4 h-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setLicenseModalOpen(true)}
                aria-label="Licença AGPL-3.0-only"
                title="AGPL-3.0-only"
                className="p-2 rounded-md text-slate-500 dark:text-slate-400 hover:bg-[#E8F1F6] dark:hover:bg-[#102843]"
              >
                <Scale className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          ) : (
            <>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 space-y-1 px-0.5">
                <div className="font-semibold text-[#0B2540] dark:text-slate-200">
                  Fontes e persistência
                </div>
                <div>IBGE · PNCP Nacional · CGU/SICONFI · SQLite WAL</div>
              </div>

              <div className="pt-2 border-t border-slate-100 dark:border-[#1D3A57] flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400 font-mono">
                <span>NEXOFIS v1.0</span>
                <button
                  type="button"
                  onClick={() => setLicenseModalOpen(true)}
                  className="text-[#D95B35] hover:underline underline-offset-2 font-semibold"
                >
                  AGPL-3.0-only
                </button>
              </div>
            </>
          )}
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-[#061321]/60"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative z-50 w-72 max-w-[82vw] bg-white dark:bg-[#0B1D31] h-full border-r border-slate-200 dark:border-[#1D3A57] flex flex-col">
            <div className="h-16 px-4 flex items-center justify-between border-b border-slate-200 dark:border-[#1D3A57]">
              <NexofisBrandLogo theme={theme} variant="horizontal" className="h-6" />
              <button
                type="button"
                aria-label="Fechar menu de navegação"
                onClick={() => setMobileMenuOpen(false)}
                className="p-2 text-slate-500 dark:text-slate-300 hover:text-[#0B2540] dark:hover:text-white"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>
            <nav aria-label="Menu móvel" className="p-3 space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = !activeContract && section === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleNavigate(item.id)}
                    className={`w-full text-left px-3 py-3 rounded-md flex items-center gap-3 ${
                      isActive
                        ? 'bg-[#E8F1F6] dark:bg-[#102843] text-[#0B2540] dark:text-[#FAF9F5] font-semibold border-l-2 border-[#D95B35]'
                        : 'text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <Icon
                      className={`w-4 h-4 shrink-0 ${isActive ? 'text-[#D95B35]' : ''}`}
                      aria-hidden="true"
                    />
                    <span className="text-sm">{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="mt-auto p-4 border-t border-slate-200 dark:border-[#1D3A57] space-y-3">
              <button
                type="button"
                onClick={handleToggleTheme}
                className="w-full px-3 py-2 rounded-md border border-slate-200 dark:border-[#1D3A57] text-xs font-medium flex items-center justify-between"
              >
                <span className="flex items-center gap-2">
                  {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4" />}
                  {theme === 'dark' ? 'Tema Claro' : 'Tema Escuro'}
                </span>
              </button>
              <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400 font-mono">
                <span>NEXOFIS v1.0</span>
                <button
                  type="button"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    setLicenseModalOpen(true);
                  }}
                  className="text-[#D95B35] underline underline-offset-2"
                >
                  AGPL-3.0-only
                </button>
              </div>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Viewport */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar */}
        <header className="sticky top-0 z-30 h-16 bg-white/95 dark:bg-[#0B1D31]/95 backdrop-blur border-b border-slate-200 dark:border-[#1D3A57] px-4 lg:px-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              aria-label="Abrir menu de navegação"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 -ml-2 text-slate-600 dark:text-slate-300 hover:text-[#0B2540] dark:hover:text-white"
            >
              <Menu className="w-5 h-5" aria-hidden="true" />
            </button>

            <nav
              aria-label="Trilha de navegação"
              className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 min-w-0 overflow-hidden"
            >
              <button
                type="button"
                onClick={() => {
                  setActiveContract(null);
                  setArchivedSnapshot(null);
                  setDeepLinkError(null);
                  setSection(section);
                }}
                className="hover:text-[#0B2540] dark:hover:text-white font-semibold whitespace-nowrap shrink-0"
              >
                {section === 'dashboard'
                  ? 'Dashboard de Riscos'
                  : section === 'municipio'
                    ? 'Municípios'
                    : section === 'contrato'
                      ? 'Contratos'
                      : section === 'documento'
                        ? 'Documentos'
                        : 'Dossiês'}
              </button>

              {section === 'municipio' && breadcrumbCtx.municipality && (
                <>
                  <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
                  <button
                    type="button"
                    onClick={() => {
                      setActiveContract(null);
                      setArchivedSnapshot(null);
                    }}
                    className="hover:text-[#0B2540] dark:hover:text-white truncate"
                  >
                    {breadcrumbCtx.municipality.name} · IBGE {breadcrumbCtx.municipality.ibgeCode}
                  </button>
                </>
              )}

              {section === 'municipio' && breadcrumbCtx.entityName && !activeContract && (
                <>
                  <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
                  <span className="text-[#0B2540] dark:text-slate-200 font-medium truncate">
                    {breadcrumbCtx.entityName}
                  </span>
                </>
              )}

              {activeContract && (
                <>
                  <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
                  <span className="text-[#0B2540] dark:text-[#FAF9F5] font-semibold font-mono whitespace-nowrap shrink-0">
                    {archivedSnapshot ? `Snapshot ${archivedSnapshot.id}` : `Contrato ${activeContract.contractNumber}`}
                  </span>
                </>
              )}
            </nav>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {/* Auth session status button */}
            {authStatus && (
              principal?.authEnabled ? (
                <div className="hidden sm:flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-[#1D3A57] rounded-md px-2.5 py-1.5">
                  <UserCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                  <span className="font-medium truncate max-w-[140px]">
                    {principal.displayName || principal.email}
                  </span>
                  <span className="font-mono text-[10px] uppercase text-slate-400">
                    {principal.role}
                  </span>
                  <button
                    type="button"
                    onClick={handleSignOut}
                    aria-label="Encerrar sessão"
                    title="Encerrar sessão"
                    className="text-slate-400 hover:text-red-600 dark:hover:text-red-400 ml-1"
                  >
                    <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setAuthError(null);
                    setAuthModalOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-[#0B2540] dark:text-slate-200 border border-slate-300 dark:border-[#1D3A57] hover:bg-[#E8F1F6] dark:hover:bg-[#102843] rounded-md transition-colors whitespace-nowrap"
                >
                  <Lock className="w-3.5 h-3.5 text-[#D95B35]" aria-hidden="true" />
                  <span>
                    {authStatus.authEnabled
                      ? authStatus.needsBootstrap
                        ? 'Configurar Admin'
                        : 'Entrar'
                      : 'Sessão Local'}
                  </span>
                </button>
              )
            )}

            <button
              type="button"
              onClick={handleToggleTheme}
              aria-label={theme === 'dark' ? 'Ativar tema claro' : 'Ativar tema escuro'}
              className="p-2 rounded-md border border-slate-200 dark:border-[#1D3A57] text-[#0B2540] dark:text-slate-200 hover:bg-[#E8F1F6] dark:hover:bg-[#102843] transition-colors"
            >
              {theme === 'dark' ? (
                <Sun className="w-4 h-4 text-amber-400" aria-hidden="true" />
              ) : (
                <Moon className="w-4 h-4" aria-hidden="true" />
              )}
            </button>

            <button
              type="button"
              onClick={() =>
                handleNavigate(section === 'documento' && !activeContract ? 'municipio' : 'documento')
              }
              className="px-3.5 py-2 text-xs font-semibold text-white bg-[#0B2540] hover:bg-[#102843] dark:bg-[#D95B35] dark:hover:bg-[#c04c29] rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              {section === 'documento' && !activeContract ? 'Investigar Município' : 'Analisar PDF'}
            </button>
          </div>
        </header>

        <main className="flex-1 w-full max-w-[1220px] mx-auto px-4 lg:px-8 py-6 lg:py-8">
          {deepLinkLoading ? (
            <div
              aria-busy="true"
              className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-8 animate-pulse space-y-4"
            >
              <div className="h-6 w-64 bg-slate-200 dark:bg-[#102843] rounded" />
              <div className="h-4 w-96 bg-slate-100 dark:bg-[#102843] rounded" />
            </div>
          ) : deepLinkError ? (
            <section
              role="alert"
              className="bg-white dark:bg-[#0B1D31] border border-amber-300 dark:border-amber-700/60 rounded-lg p-8 max-w-2xl mx-auto space-y-4"
            >
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
                <div className="space-y-1">
                  <h1 className="text-lg font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                    Registro não localizado
                  </h1>
                  <p className="text-sm text-slate-600 dark:text-slate-300">{deepLinkError}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => handleNavigate('contrato')}
                  className="px-4 py-2 text-xs font-semibold text-white bg-[#0B2540] dark:bg-[#D95B35] rounded-md"
                >
                  Buscar Contratos
                </button>
                <button
                  type="button"
                  onClick={() => handleNavigate('municipio')}
                  className="px-4 py-2 text-xs font-semibold text-[#0B2540] dark:text-slate-200 border border-slate-300 dark:border-[#1D3A57] rounded-md"
                >
                  Voltar à Investigação Municipal
                </button>
              </div>
            </section>
          ) : activeContract ? (
            <ContractDossierView
              contract={activeContract}
              archivedSnapshot={archivedSnapshot}
              onBack={() => {
                setActiveContract(null);
                setArchivedSnapshot(null);
              }}
              onOpenCurrentContract={
                archivedSnapshot ? () => handleOpenContractById(archivedSnapshot.contractId) : undefined
              }
              onDossierSaved={refreshDossiers}
              onSelectContract={handleOpenContract}
              authenticationKey={principal?.authEnabled ? principal.userId : 'anonymous'}
              onRequestAuthentication={() => { setAuthError(null); setAuthModalOpen(true); }}
            />
          ) : section === 'dashboard' ? (
            <RiskDashboardView
              startDate={periodFilter.startDate}
              endDate={periodFilter.endDate}
              onPeriodChange={setPeriodFilter}
              onSelectContract={handleOpenContract}
            />
          ) : section === 'municipio' ? (
            <MunicipalityView
              initialIbgeCode={activeIbge}
              selectedEntityId={selectedEntityId}
              startDate={periodFilter.startDate}
              endDate={periodFilter.endDate}
              onPeriodChange={setPeriodFilter}
              onIbgeChange={(nextIbge) => {
                setActiveIbge(nextIbge);
                setSelectedEntityId('ALL');
              }}
              onEntityChange={setSelectedEntityId}
              onSelectContract={handleOpenContract}
              onContextChange={setBreadcrumbCtx}
            />
          ) : section === 'contrato' ? (
            <ContractSearchView
              filterState={searchFilters}
              onFilterStateChange={setSearchFilters}
              onSelectContract={handleOpenContract}
              onNavigateToDocument={() => handleNavigate('documento')}
            />
          ) : section === 'documento' ? (
            <DocumentUploadView onSelectContract={handleOpenContract} />
          ) : (
            <SavedDossiersView
              dossiers={savedDossiers}
              loading={dossiersLoading}
              error={dossiersError}
              onRetry={refreshDossiers}
              onOpenSnapshot={handleOpenArchivedDossier}
              onOpenContractId={handleOpenContractById}
              onDeleteDossier={handleDeleteDossier}
              onExploreMunicipality={() => {
                setSelectedEntityId('ALL');
                handleNavigate('municipio');
              }}
            />
          )}
        </main>
      </div>

      {/* Auth / First-Run Admin Bootstrap Modal */}
      {authModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="nexofis-auth-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#061321]/60"
        >
          <div className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg max-w-md w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 dark:border-[#1D3A57] pb-3">
              <div className="flex items-center gap-2">
                <Lock className="w-4 h-4 text-[#D95B35]" aria-hidden="true" />
                <h2 id="nexofis-auth-title" className="text-base font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                  {authStatus?.needsBootstrap
                    ? 'Configurar Administrador Inicial'
                    : 'Autenticação de Auditor'}
                </h2>
              </div>
              <button
                type="button"
                aria-label="Fechar janela de autenticação"
                onClick={() => setAuthModalOpen(false)}
                className="p-1 text-slate-400 hover:text-[#0B2540] dark:hover:text-white"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              {authStatus?.needsBootstrap
                ? 'Nenhum usuário cadastrado neste banco SQLite. Crie a conta inicial de administrador para assinar revisões, uploads e dossiês.'
                : authStatus?.authEnabled
                  ? 'Informe suas credenciais NEXOFIS. O token de sessão é mantido exclusivamente em memória nesta aba.'
                  : 'Modo de workspace local ativo. Você ainda pode autenticar-se para registrar seu nome e papel RBAC nas revisões.'}
            </p>

            {authError && (
              <div role="alert" className="p-3 rounded-md bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300">
                {authError}
              </div>
            )}

            <form onSubmit={handleAuthSubmit} className="space-y-3">
              {authStatus?.needsBootstrap && (
                <div>
                  <label htmlFor="auth-name" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Nome completo
                  </label>
                  <input
                    id="auth-name"
                    type="text"
                    required
                    value={authName}
                    onChange={(e) => setAuthName(e.target.value)}
                    placeholder="Ex.: Maria Silva (Controladoria)"
                    className="w-full h-10 px-3 text-sm bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md text-[#0B2540] dark:text-[#FAF9F5] focus:outline-none focus:ring-2 focus:ring-[#D95B35]"
                  />
                </div>
              )}

              <div>
                <label htmlFor="auth-email" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                  E-mail institucional
                </label>
                <input
                  id="auth-email"
                  type="email"
                  required
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  placeholder="auditor@orgao.gov.br"
                  className="w-full h-10 px-3 text-sm bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md text-[#0B2540] dark:text-[#FAF9F5] focus:outline-none focus:ring-2 focus:ring-[#D95B35]"
                />
              </div>

              <div>
                <label htmlFor="auth-password" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                  Senha (mínimo 8 caracteres)
                </label>
                <input
                  id="auth-password"
                  type="password"
                  required
                  minLength={8}
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  className="w-full h-10 px-3 text-sm bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md text-[#0B2540] dark:text-[#FAF9F5] focus:outline-none focus:ring-2 focus:ring-[#D95B35]"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setAuthModalOpen(false)}
                  className="px-3.5 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-[#102843] rounded-md"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={authSubmitting}
                  className="px-4 py-2 text-xs font-semibold text-white bg-[#0B2540] dark:bg-[#D95B35] hover:opacity-90 disabled:opacity-50 rounded-md"
                >
                  {authSubmitting
                    ? 'Processando...'
                    : authStatus?.needsBootstrap
                      ? 'Criar Administrador'
                      : 'Entrar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* AGPL-3.0-only Governance & Source Offer Modal */}
      {licenseModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="nexofis-license-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#061321]/60"
        >
          <div className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg max-w-lg w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 dark:border-[#1D3A57] pb-3">
              <div className="flex items-center gap-2">
                <Scale className="w-4 h-4 text-[#D95B35] shrink-0" aria-hidden="true" />
                <h2
                  id="nexofis-license-title"
                  className="text-base font-bold text-[#0B2540] dark:text-[#FAF9F5]"
                >
                  NEXOFIS · Licença e Código-Fonte
                </h2>
              </div>
              <button
                type="button"
                aria-label="Fechar aviso de licença"
                onClick={() => setLicenseModalOpen(false)}
                className="p-1 text-slate-400 hover:text-[#0B2540] dark:hover:text-white"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <div className="text-xs text-slate-700 dark:text-slate-300 space-y-3 leading-relaxed">
              <p>
                O software <strong>NEXOFIS</strong> (Eduardo Muniz — DM Technology) é distribuído
                sob a licença <span className="font-mono font-semibold">GNU AGPL-3.0-only</span>.
                Qualquer instância executada em rede assegura aos usuários o acesso ao código-fonte
                correspondente (seção 13 da AGPLv3).
              </p>
              <p className="p-3 bg-[#FAF9F5] dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] rounded text-slate-600 dark:text-slate-300">
                <strong>Separação Software × Dados Públicos:</strong> A licença{' '}
                <span className="font-mono">AGPL-3.0-only</span> aplica-se exclusivamente ao
                código-fonte do NEXOFIS. Os contratos, empenhos, cadastros e documentos públicos
                consultados permanecem sob a governança de seus respectivos órgãos e da Lei de
                Acesso à Informação (Lei nº 12.527/2011) e LGPD (Lei nº 13.709/2018).
              </p>
              <div className="flex flex-wrap items-center gap-4 pt-1">
                <a
                  href="https://github.com/devdudumuniz/NEXOFIS"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 font-semibold text-[#D95B35] hover:underline"
                >
                  Código-fonte no GitHub
                  <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                </a>
                <a
                  href="https://www.gnu.org/licenses/agpl-3.0.txt"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 font-medium text-[#0B2540] dark:text-slate-200 hover:underline"
                >
                  Texto integral AGPL-3.0
                  <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                </a>
              </div>
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-100 dark:border-[#1D3A57]">
              <button
                type="button"
                onClick={() => setLicenseModalOpen(false)}
                className="px-4 py-1.5 text-xs font-semibold text-white bg-[#0B2540] dark:bg-[#D95B35] rounded-md"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
      <ToastContainer />
    </div>
  );
}

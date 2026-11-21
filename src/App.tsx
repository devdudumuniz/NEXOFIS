import { useEffect, useState } from 'react';
import {
  BarChart3,
  Building2,
  ChevronRight,
  ExternalLink,
  FileSearch,
  FileUp,
  FolderArchive,
  Menu,
  Scale,
  X,
} from 'lucide-react';
import type { EvaluatedContract, Municipality, SavedDossierSummary } from './types/audit';
import { deleteSavedDossier, fetchContractById, fetchSavedDossiers } from './lib/api';
import { MunicipalityView } from './components/MunicipalityView';
import { ContractSearchView, type ContractSearchFilterState } from './components/ContractSearchView';
import { DocumentUploadView } from './components/DocumentUploadView';
import { ContractDossierView } from './components/ContractDossierView';
import { SavedDossiersView } from './components/SavedDossiersView';
import { RiskDashboardView } from './components/RiskDashboardView';

type ActiveSection = 'dashboard' | 'municipio' | 'contrato' | 'documento' | 'dossies';

function readInitialUrlState(): {
  section: ActiveSection;
  ibge: string;
  entityId: string;
  q: string;
  year: string;
  status: string;
  startDate: string;
  endDate: string;
} {
  if (typeof window === 'undefined') {
    return {
      section: 'municipio',
      ibge: '2902906',
      entityId: 'ALL',
      q: '123/2026',
      year: '',
      status: '',
      startDate: '',
      endDate: '',
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
  const ibge = /^\d{7}$/.test(rawIbge) ? rawIbge : '2902906';
  const entityId = params.get('ent') || 'ALL';
  const q = params.get('q') ?? '123/2026';
  const year = params.get('year') ?? '';
  const status = params.get('status') ?? '';
  const startDate = params.get('from') ?? '';
  const endDate = params.get('to') ?? '';
  return { section, ibge, entityId, q, year, status, startDate, endDate };
}

export default function App() {
  const initial = readInitialUrlState();
  const [section, setSection] = useState<ActiveSection>(initial.section);
  const [activeIbge, setActiveIbge] = useState<string>(initial.ibge);
  const [selectedEntityId, setSelectedEntityId] = useState<string>(initial.entityId);
  const [periodFilter, setPeriodFilter] = useState<{ startDate: string; endDate: string }>({
    startDate: initial.startDate,
    endDate: initial.endDate,
  });
  const [searchFilters, setSearchFilters] = useState<ContractSearchFilterState>({
    query: initial.q,
    ibgeFilter: '',
    municipalityInput: '',
    yearFilter: initial.year,
    statusFilter:
      initial.status === 'em_andamento' ||
      initial.status === 'concluido' ||
      initial.status === 'suspenso'
        ? initial.status
        : '',
    startDate: initial.startDate,
    endDate: initial.endDate,
    minRisk: 0,
  });
  const [activeContract, setActiveContract] = useState<EvaluatedContract | null>(null);
  const [breadcrumbCtx, setBreadcrumbCtx] = useState<{
    municipality: Municipality | null;
    entityName: string | null;
  }>({ municipality: null, entityName: null });
  const [savedDossiers, setSavedDossiers] = useState<SavedDossierSummary[]>([]);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [licenseModalOpen, setLicenseModalOpen] = useState(false);

  const refreshDossiers = () => {
    fetchSavedDossiers()
      .then(setSavedDossiers)
      .catch(() => {});
  };

  useEffect(() => {
    refreshDossiers();
  }, []);

  // Keep navigation state synchronized in URL query parameters so back/reload preserves context
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams();
    params.set('sec', section);
    if (section === 'dashboard') {
      if (periodFilter.startDate) params.set('from', periodFilter.startDate);
      if (periodFilter.endDate) params.set('to', periodFilter.endDate);
    } else if (section === 'municipio') {
      params.set('ibge', activeIbge);
      if (selectedEntityId && selectedEntityId !== 'ALL') {
        params.set('ent', selectedEntityId);
      }
      if (periodFilter.startDate) params.set('from', periodFilter.startDate);
      if (periodFilter.endDate) params.set('to', periodFilter.endDate);
    } else if (section === 'contrato') {
      if (searchFilters.query) params.set('q', searchFilters.query);
      if (searchFilters.yearFilter) params.set('year', searchFilters.yearFilter);
      if (searchFilters.statusFilter) params.set('status', searchFilters.statusFilter);
      if (searchFilters.startDate) params.set('from', searchFilters.startDate);
      if (searchFilters.endDate) params.set('to', searchFilters.endDate);
    }
    if (activeContract) {
      params.set('contract', activeContract.id);
    }
    const qs = params.toString();
    const nextUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, '', nextUrl);
  }, [section, activeIbge, selectedEntityId, periodFilter, searchFilters, activeContract]);

  const handleNavigate = (target: ActiveSection) => {
    setSection(target);
    setActiveContract(null);
    setMobileMenuOpen(false);
    window.scrollTo(0, 0);
  };

  const handleOpenContract = (contract: EvaluatedContract) => {
    setActiveContract(contract);
    setMobileMenuOpen(false);
    window.scrollTo(0, 0);
  };

  const handleOpenContractById = async (contractId: string) => {
    try {
      const evaluated = await fetchContractById(contractId);
      handleOpenContract(evaluated);
    } catch {
      // Contract no longer in session store
    }
  };

  const handleDeleteDossier = async (id: string) => {
    try {
      const updated = await deleteSavedDossier(id);
      setSavedDossiers(updated);
    } catch {
      // Ignore transient error
    }
  };

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
      hint: 'Upload PDF e extração nativa',
      icon: FileUp,
    },
    {
      id: 'dossies',
      label: 'Dossiês Salvos',
      hint: 'Trilhas arquivadas (SQLite)',
      icon: FolderArchive,
      count: savedDossiers.length,
    },
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Desktop Left Sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 bg-white border-r border-slate-200 sticky top-0 h-screen">
        <div className="h-14 px-5 flex items-center border-b border-slate-200">
          <button
            type="button"
            onClick={() => handleNavigate('municipio')}
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap"
          >
            Nexofis
          </button>
        </div>

        <nav aria-label="Entradas de investigação" className="flex-1 p-3 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = !activeContract && section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavigate(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`w-full text-left px-3 py-2.5 rounded-md transition-colors flex items-start gap-3 ${
                  isActive
                    ? 'bg-blue-50 text-blue-800'
                    : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <Icon
                  className={`w-4 h-4 shrink-0 mt-0.5 ${
                    isActive ? 'text-blue-700' : 'text-slate-400'
                  }`}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold whitespace-nowrap">{item.label}</span>
                    {item.count !== undefined && item.count > 0 && (
                      <span className="font-mono text-xs tabular-nums text-slate-500">
                        {item.count}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-500 truncate mt-0.5">{item.hint}</div>
                </div>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 text-[11px] text-slate-500 space-y-2">
          <div className="space-y-1">
            <div className="font-medium text-slate-700">Fontes conectadas</div>
            <div>IBGE · PNCP Nacional · CNPJ (intermediários) · SQLite Local</div>
          </div>
          <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-[10px] text-slate-500 font-mono">
            <span>NEXOFIS v0.1.0</span>
            <button
              type="button"
              onClick={() => setLicenseModalOpen(true)}
              className="text-blue-700 hover:text-blue-800 underline underline-offset-2"
            >
              AGPL-3.0-only
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative z-50 w-72 max-w-[82vw] bg-white h-full border-r border-slate-200 flex flex-col">
            <div className="h-14 px-5 flex items-center justify-between border-b border-slate-200">
              <span className="text-lg font-bold tracking-tight text-slate-900">Nexofis</span>
              <button
                type="button"
                aria-label="Fechar menu de navegação"
                onClick={() => setMobileMenuOpen(false)}
                className="p-2 text-slate-500 hover:text-slate-900"
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
                      isActive ? 'bg-blue-50 text-blue-800 font-semibold' : 'text-slate-700'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span className="text-sm">{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="mt-auto p-4 border-t border-slate-200 flex items-center justify-between text-[10px] text-slate-500 font-mono">
              <span>NEXOFIS v0.1.0</span>
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  setLicenseModalOpen(true);
                }}
                className="text-blue-700 underline underline-offset-2"
              >
                AGPL-3.0-only
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Viewport */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar Contract: Breadcrumbs left, 1 primary action right */}
        <header className="sticky top-0 z-30 h-14 bg-white border-b border-slate-200 px-4 lg:px-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              aria-label="Abrir menu de navegação"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900"
            >
              <Menu className="w-5 h-5" aria-hidden="true" />
            </button>

            <nav aria-label="Trilha de navegação" className="flex items-center gap-1.5 text-xs text-slate-500 min-w-0 overflow-hidden">
              <button
                type="button"
                onClick={() => {
                  setActiveContract(null);
                  setSection(section);
                }}
                className="hover:text-slate-900 font-medium whitespace-nowrap shrink-0"
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
                    onClick={() => setActiveContract(null)}
                    className="hover:text-slate-900 truncate"
                  >
                    {breadcrumbCtx.municipality.name} · IBGE {breadcrumbCtx.municipality.ibgeCode}
                  </button>
                </>
              )}

              {section === 'municipio' && breadcrumbCtx.entityName && !activeContract && (
                <>
                  <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
                  <span className="text-slate-800 font-medium truncate">
                    {breadcrumbCtx.entityName}
                  </span>
                </>
              )}

              {activeContract && (
                <>
                  <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
                  <span className="text-slate-900 font-semibold font-mono whitespace-nowrap shrink-0">
                    Contrato {activeContract.contractNumber}
                  </span>
                </>
              )}
            </nav>
          </div>

          <div className="shrink-0">
            <button
              type="button"
              onClick={() =>
                handleNavigate(section === 'documento' && !activeContract ? 'municipio' : 'documento')
              }
              className="px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              {section === 'documento' && !activeContract ? 'Investigar Município' : 'Analisar PDF'}
            </button>
          </div>
        </header>

        <main className="flex-1 w-full max-w-[1220px] mx-auto px-4 lg:px-8 py-6 lg:py-8">
          {activeContract ? (
            <ContractDossierView
              contract={activeContract}
              onBack={() => setActiveContract(null)}
              onDossierSaved={refreshDossiers}
              onSelectContract={handleOpenContract}
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
              onOpenContractId={handleOpenContractById}
              onDeleteDossier={handleDeleteDossier}
              onExploreMunicipality={() => {
                setActiveIbge('2902906');
                setSelectedEntityId('ALL');
                handleNavigate('municipio');
              }}
            />
          )}
        </main>
      </div>

      {/* AGPL-3.0-only Governance & Source Offer Modal */}
      {licenseModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="nexofis-license-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50"
        >
          <div className="bg-white border border-slate-200 rounded-lg max-w-lg w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2">
                <Scale className="w-4 h-4 text-blue-700 shrink-0" aria-hidden="true" />
                <h2 id="nexofis-license-title" className="text-base font-bold text-slate-900">
                  NEXOFIS · Licença e Código-Fonte
                </h2>
              </div>
              <button
                type="button"
                aria-label="Fechar aviso de licença"
                onClick={() => setLicenseModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <div className="text-xs text-slate-700 space-y-3 leading-relaxed">
              <p>
                O software <strong>NEXOFIS</strong> (Eduardo Muniz — DM Technology) é distribuído
                sob a licença <span className="font-mono font-semibold">GNU AGPL-3.0-only</span>.
                Qualquer instância executada em rede assegura aos usuários o acesso ao código-fonte
                correspondente (seção 13 da AGPLv3).
              </p>
              <p className="p-3 bg-slate-50 border border-slate-200 rounded text-slate-600">
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
                  className="inline-flex items-center gap-1.5 font-semibold text-blue-700 hover:text-blue-800"
                >
                  Código-fonte no GitHub
                  <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                </a>
                <a
                  href="https://www.gnu.org/licenses/agpl-3.0.txt"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 font-medium text-slate-700 hover:text-slate-900"
                >
                  Texto integral AGPL-3.0
                  <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                </a>
              </div>
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setLicenseModalOpen(false)}
                className="px-4 py-1.5 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-900 rounded-md"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


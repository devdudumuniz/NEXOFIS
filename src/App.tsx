import { useEffect, useState } from 'react';
import {
  Building2,
  ChevronRight,
  FileSearch,
  FileUp,
  FolderArchive,
  Menu,
  X,
} from 'lucide-react';
import type { EvaluatedContract, Municipality, SavedDossierSummary } from './types/audit';
import { deleteSavedDossier, fetchContractById, fetchSavedDossiers } from './lib/api';
import { MunicipalityView } from './components/MunicipalityView';
import { ContractSearchView } from './components/ContractSearchView';
import { DocumentUploadView } from './components/DocumentUploadView';
import { ContractDossierView } from './components/ContractDossierView';
import { SavedDossiersView } from './components/SavedDossiersView';

type ActiveSection = 'municipio' | 'contrato' | 'documento' | 'dossies';

export default function App() {
  const [section, setSection] = useState<ActiveSection>('municipio');
  const [activeIbge, setActiveIbge] = useState<string>('2910800');
  const [activeContract, setActiveContract] = useState<EvaluatedContract | null>(null);
  const [breadcrumbCtx, setBreadcrumbCtx] = useState<{
    municipality: Municipality | null;
    entityName: string | null;
  }>({ municipality: null, entityName: null });
  const [savedDossiers, setSavedDossiers] = useState<SavedDossierSummary[]>([]);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const refreshDossiers = () => {
    fetchSavedDossiers()
      .then(setSavedDossiers)
      .catch(() => {});
  };

  useEffect(() => {
    refreshDossiers();
  }, []);

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
      hint: 'Upload PDF e OCR seletivo',
      icon: FileUp,
    },
    {
      id: 'dossies',
      label: 'Dossiês Salvos',
      hint: 'Trilhas arquivadas',
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
            LicitAudit
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

        <div className="p-4 border-t border-slate-200 text-[11px] text-slate-500 space-y-1">
          <div className="font-medium text-slate-700">Fontes conectadas</div>
          <div>IBGE · PNCP · Receita/CNPJ · CGU/TCU · Painel de Preços · SINAPI</div>
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
              <span className="text-lg font-bold tracking-tight text-slate-900">LicitAudit</span>
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
                  setSection('municipio');
                }}
                className="hover:text-slate-900 font-medium whitespace-nowrap shrink-0"
              >
                {section === 'municipio'
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
          ) : section === 'municipio' ? (
            <MunicipalityView
              initialIbgeCode={activeIbge}
              onSelectContract={handleOpenContract}
              onContextChange={setBreadcrumbCtx}
            />
          ) : section === 'contrato' ? (
            <ContractSearchView
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
                setActiveIbge('2910800');
                handleNavigate('municipio');
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}

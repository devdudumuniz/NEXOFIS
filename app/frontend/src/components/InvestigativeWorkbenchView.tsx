import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  Copy,
  Database,
  FileSpreadsheet,
  Lock,
  Radio,
  RefreshCw,
  Scale,
  ShieldAlert,
} from 'lucide-react';
import type { EditalChannelAuditResult } from '@nexofis/shared/lib/participationChannelEvaluator';
import {
  ApiError,
  auditEditalTextChannels,
  evaluateInvestigativePrices,
  evaluatePairedDid,
  evaluatePublicIntegrity,
  fetchForensicCypherProjection,
  fetchOfficialSnapshots,
  getAuthToken,
  importOfficialDataset,
  type AuthPrincipalInfo,
  type ForensicCypherProjectionResponse,
  type OfficialSnapshotSummary,
} from '../lib/api';

type WorkbenchTab = 'indicadores' | 'integridade' | 'precos' | 'canais' | 'grafo';

interface InvestigativeWorkbenchViewProps {
  authPrincipal: AuthPrincipalInfo | null;
  onRequireAuth: () => void;
}

function renderStatusTone(status: string): string {
  const upper = status.toUpperCase();
  if (
    upper.includes('VERMELHO') ||
    upper.includes('IRREGULARIDADE') ||
    upper.includes('CRITICO') ||
    upper.includes('SOBREPRECO') ||
    upper.includes('INCONGRUENCIA')
  ) {
    return 'text-red-700 dark:text-red-300 border-red-200 dark:border-red-800 bg-red-50/70 dark:bg-red-950/30';
  }
  if (
    upper.includes('REPROVADA') ||
    upper.includes('ATENCAO') ||
    upper.includes('DIVERGENCIA') ||
    upper.includes('DESCONHECIDO') ||
    upper.includes('DESCRITIVO')
  ) {
    return 'text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30';
  }
  return 'text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800 bg-emerald-50/70 dark:bg-emerald-950/30';
}

export function InvestigativeWorkbenchView({
  authPrincipal,
  onRequireAuth,
}: InvestigativeWorkbenchViewProps) {
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('indicadores');
  const hasStrictSession = Boolean(getAuthToken());

  // Shared snapshots & Cypher projection state
  const [snapshots, setSnapshots] = useState<OfficialSnapshotSummary[]>([]);
  const [snapshotFilter, setSnapshotFilter] = useState<
    'all' | 'siaps' | 'inep' | 'sinapi' | 'camara_personnel'
  >('all');
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [snapshotsError, setSnapshotsError] = useState<string | null>(null);

  const [cypherTargetCnpj, setCypherTargetCnpj] = useState('');
  const [cypherOnlyDocumented, setCypherOnlyDocumented] = useState(true);
  const [cypherLoading, setCypherLoading] = useState(false);
  const [cypherResult, setCypherResult] = useState<ForensicCypherProjectionResponse | null>(null);
  const [cypherError, setCypherError] = useState<string | null>(null);
  const [copiedCypher, setCopiedCypher] = useState(false);

  // Tab 1: Indicadores & DiD
  const [datasetKind, setDatasetKind] = useState<'siaps' | 'inep'>('siaps');
  const [datasetFilename, setDatasetFilename] = useState('');
  const [datasetCompetencia, setDatasetCompetencia] = useState('');
  const [datasetCsv, setDatasetCsv] = useState('');
  const [datasetImportLoading, setDatasetImportLoading] = useState(false);
  const [datasetImportResult, setDatasetImportResult] = useState<Record<string, unknown> | null>(null);
  const [datasetImportError, setDatasetImportError] = useState<string | null>(null);

  const [didContractId, setDidContractId] = useState('');
  const [didIndicatorId, setDidIndicatorId] = useState('');
  const [didTreatedPre, setDidTreatedPre] = useState('');
  const [didTreatedPost, setDidTreatedPost] = useState('');
  const [didPaidPct, setDidPaidPct] = useState('100');
  const [didEligibleDesign, setDidEligibleDesign] = useState(true);
  const [didControlJson, setDidControlJson] = useState(
    '[\n  {"municipalityCode": "", "municipalityName": "", "microregion": "", "populationBand": "", "hadSimilarConsultancy": false, "preValue": 0, "postValue": 0}\n]'
  );
  const [didLoading, setDidLoading] = useState(false);
  const [didResult, setDidResult] = useState<Record<string, unknown> | null>(null);
  const [didError, setDidError] = useState<string | null>(null);

  // Tab 2: Integridade Pública
  const [camaraDate, setCamaraDate] = useState('');
  const [camaraCsv, setCamaraCsv] = useState('');
  const [camaraLoading, setCamaraLoading] = useState(false);
  const [camaraResult, setCamaraResult] = useState<Record<string, unknown> | null>(null);
  const [camaraError, setCamaraError] = useState<string | null>(null);

  const [integrityRoleName, setIntegrityRoleName] = useState('');
  const [integrityRequiresGrad, setIntegrityRequiresGrad] = useState(true);
  const [integrityLegalBasis, setIntegrityLegalBasis] = useState('');
  const [integrityPayloadJson, setIntegrityPayloadJson] = useState(
    '{\n  "kinships": [],\n  "appointments": [],\n  "contractConflicts": []\n}'
  );
  const [integrityLoading, setIntegrityLoading] = useState(false);
  const [integrityResult, setIntegrityResult] = useState<Record<string, unknown> | null>(null);
  const [integrityError, setIntegrityError] = useState<string | null>(null);

  // Tab 3: Preços & SINAPI
  const [sinapiUf, setSinapiUf] = useState('');
  const [sinapiComp, setSinapiComp] = useState('');
  const [sinapiRegime, setSinapiRegime] = useState<'nao_desonerado' | 'desonerado'>('nao_desonerado');
  const [sinapiKind, setSinapiKind] = useState<'insumo' | 'composicao'>('insumo');
  const [sinapiCsv, setSinapiCsv] = useState('');
  const [sinapiLoading, setSinapiLoading] = useState(false);
  const [sinapiResult, setSinapiResult] = useState<Record<string, unknown> | null>(null);
  const [sinapiError, setSinapiError] = useState<string | null>(null);

  const [priceSpec, setPriceSpec] = useState('');
  const [priceUnit, setPriceUnit] = useState('kg');
  const [priceQty, setPriceQty] = useState('1000');
  const [priceNominal, setPriceNominal] = useState('');
  const [priceUf, setPriceUf] = useState('');
  const [priceComp, setPriceComp] = useState('');
  const [pricePeersJson, setPricePeersJson] = useState('[]');
  const [priceLoading, setPriceLoading] = useState(false);
  const [priceResult, setPriceResult] = useState<Record<string, unknown> | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);

  // Tab 4: Canais de Participação
  const [editalProcurementId, setEditalProcurementId] = useState('');
  const [editalJurisdiction, setEditalJurisdiction] = useState('');
  const [editalText, setEditalText] = useState('');
  const [editalLoading, setEditalLoading] = useState(false);
  const [editalResult, setEditalResult] = useState<EditalChannelAuditResult | null>(null);
  const [editalError, setEditalError] = useState<string | null>(null);

  const loadSnapshots = useCallback(
    async (kind: 'all' | 'siaps' | 'inep' | 'sinapi' | 'camara_personnel' = snapshotFilter) => {
      setSnapshotsLoading(true);
      setSnapshotsError(null);
      try {
        const res = await fetchOfficialSnapshots(kind === 'all' ? undefined : kind);
        setSnapshots(res.snapshots);
      } catch (err) {
        setSnapshotsError(
          err instanceof Error ? err.message : 'Falha ao listar snapshots oficiais.'
        );
      } finally {
        setSnapshotsLoading(false);
      }
    },
    [snapshotFilter]
  );

  const loadCypherProjection = useCallback(async () => {
    setCypherLoading(true);
    setCypherError(null);
    try {
      const res = await fetchForensicCypherProjection({
        targetCnpj: cypherTargetCnpj.trim() || undefined,
        onlyDocumented: cypherOnlyDocumented,
      });
      setCypherResult(res);
    } catch (err) {
      setCypherError(
        err instanceof Error ? err.message : 'Falha ao gerar projeção Cypher.'
      );
    } finally {
      setCypherLoading(false);
    }
  }, [cypherTargetCnpj, cypherOnlyDocumented]);

  useEffect(() => {
    loadSnapshots(snapshotFilter);
  }, [loadSnapshots, snapshotFilter]);

  useEffect(() => {
    if (activeTab === 'grafo' && !cypherResult && !cypherLoading) {
      loadCypherProjection();
    }
  }, [activeTab, cypherResult, cypherLoading, loadCypherProjection]);

  const handleApiError = (err: unknown, setter: (msg: string) => void) => {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      setter(`${err.message} Autentique-se como analista/administrador para executar esta ação.`);
      return;
    }
    setter(err instanceof Error ? err.message : 'Erro inesperado ao consultar a API.');
  };

  const handleDatasetImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setDatasetImportLoading(true);
    setDatasetImportError(null);
    setDatasetImportResult(null);
    try {
      const res = await importOfficialDataset(datasetKind, {
        rawCsv: datasetCsv,
        filename: datasetFilename.trim() || `${datasetKind}-oficial.csv`,
        competencia: datasetCompetencia.trim() || undefined,
      });
      setDatasetImportResult(res);
      await loadSnapshots(snapshotFilter);
    } catch (err) {
      handleApiError(err, setDatasetImportError);
    } finally {
      setDatasetImportLoading(false);
    }
  };

  const handleDidEvaluate = async (e: React.FormEvent) => {
    e.preventDefault();
    setDidLoading(true);
    setDidError(null);
    setDidResult(null);
    try {
      const controls = JSON.parse(didControlJson) as Array<Record<string, unknown>>;
      const preVal = Number(didTreatedPre);
      const postVal = Number(didTreatedPost);
      const paidPct = Number(didPaidPct);
      if (!Number.isFinite(preVal) || !Number.isFinite(postVal)) {
        throw new Error('Informe valores numéricos válidos para o indicador pré e pós contrato.');
      }
      const res = await evaluatePairedDid({
        contractId: didContractId.trim(),
        indicatorId: didIndicatorId.trim(),
        indicatorName: didIndicatorId.trim(),
        domain: didIndicatorId.toUpperCase().includes('IDEB') || didIndicatorId.toUpperCase().includes('SAEB')
          ? 'educacao'
          : 'saude',
        sourceSystem: didIndicatorId.toUpperCase().includes('IDEB') || didIndicatorId.toUpperCase().includes('SAEB')
          ? 'INEP / MEC'
          : 'SISAB / SIAPS',
        contractSignatureDate: new Date().toISOString().slice(0, 10),
        improvementDirection: 'higher_is_better',
        treatedMunicipalityCode: '0000000',
        treatedMunicipalityName: 'Município Analisado',
        treatedPreValue: preVal,
        treatedPostValue: postVal,
        installmentsPaidPct: Number.isFinite(paidPct) ? paidPct : 0,
        controlMunicipalities: controls,
        didDesign: {
          requestedMethod: 'did',
          usesSimpleNeighborAverageAsSyntheticControl: false,
          comparisonGroupJustification: didEligibleDesign
            ? 'Municípios vizinhos da mesma microrregião e faixa populacional sem consultoria equivalente.'
            : '',
          prePeriodTreatedCount: didEligibleDesign ? 3 : 1,
          prePeriodControlCount: didEligibleDesign ? 3 : 1,
          postPeriodTreatedCount: 1,
          postPeriodControlCount: 1,
          preTrendsTested: didEligibleDesign,
          preTrendsParallel: didEligibleDesign,
          explicitAssumptions: didEligibleDesign
            ? ['Tendências paralelas examinadas nos 3 períodos pré-contrato.', 'Sem choque idiossincrático simultâneo.']
            : [],
          uncertaintyReported: didEligibleDesign,
        },
      });
      setDidResult(res);
    } catch (err) {
      handleApiError(err, setDidError);
    } finally {
      setDidLoading(false);
    }
  };

  const handleCamaraImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setCamaraLoading(true);
    setCamaraError(null);
    setCamaraResult(null);
    try {
      const res = await importOfficialDataset('camara-personnel', {
        rawCsv: camaraCsv,
        snapshotDate: camaraDate.trim() || undefined,
      });
      setCamaraResult(res);
      await loadSnapshots(snapshotFilter);
    } catch (err) {
      handleApiError(err, setCamaraError);
    } finally {
      setCamaraLoading(false);
    }
  };

  const handleIntegrityEvaluate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIntegrityLoading(true);
    setIntegrityError(null);
    setIntegrityResult(null);
    try {
      const parsed = JSON.parse(integrityPayloadJson) as Record<string, unknown>;
      const payload: Record<string, unknown> = {
        ...parsed,
        applicableLegalBasis: integrityLegalBasis.trim() || null,
      };
      if (integrityRoleName.trim()) {
        const today = new Date().toISOString().slice(0, 10);
        payload.roleRequirementCheck = {
          appointment: {
            appointmentId: 'appt_workbench_1',
            person: {
              personId: 'person_workbench_1',
              fullName: 'Servidor Analisado',
              identityStatus: 'resolved_documentary',
            },
            organName: 'Órgão Analisado',
            jurisdiction: 'Município/Ente',
            roleTitle: integrityRoleName.trim(),
            lotacao: 'Lotação Oficial',
            isCommissionedOrTrust: true,
            isPoliticalAgent: false,
            subordinateToPersonId: null,
            startDate: today,
            endDate: null,
            endSemantics: 'ongoing_undocumented',
            evidenceRefs: ['Bancada Investigativa'],
          },
          applicableLaw: integrityLegalBasis.trim()
            ? {
                lawReference: integrityLegalBasis.trim(),
                amendmentsApplied: [],
                jurisdiction: 'Município/Ente',
                effectiveFrom: '2000-01-01',
                effectiveUntil: null,
                roleTitle: integrityRoleName.trim(),
                requiresGraduation: integrityRequiresGrad,
                expressRequirements: [],
              }
            : null,
          evidences: [],
        };
      }
      const res = await evaluatePublicIntegrity(payload);
      setIntegrityResult(res);
    } catch (err) {
      handleApiError(err, setIntegrityError);
    } finally {
      setIntegrityLoading(false);
    }
  };

  const handleSinapiImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setSinapiLoading(true);
    setSinapiError(null);
    setSinapiResult(null);
    try {
      const res = await importOfficialDataset('sinapi', {
        rawCsv: sinapiCsv,
        uf: sinapiUf.trim().toUpperCase(),
        competencia: sinapiComp.trim(),
        taxRegime: sinapiRegime,
        defaultKind: sinapiKind,
      });
      setSinapiResult(res);
      await loadSnapshots(snapshotFilter);
    } catch (err) {
      handleApiError(err, setSinapiError);
    } finally {
      setSinapiLoading(false);
    }
  };

  const handlePriceEvaluate = async (e: React.FormEvent) => {
    e.preventDefault();
    setPriceLoading(true);
    setPriceError(null);
    setPriceResult(null);
    try {
      const peers = JSON.parse(pricePeersJson);
      const nominal = Number(priceNominal);
      const quantity = Number(priceQty);
      const year = Number(priceComp.slice(0, 4)) || new Date().getFullYear();
      const res = await evaluateInvestigativePrices({
        serviceClass: priceSpec.trim() || 'Insumo/Serviço',
        subjectNominalPrice: nominal,
        subjectYear: year,
        inflationIndexLabel: 'IPCA-IBGE 2026',
        subjectProfile: {
          specification: priceSpec.trim(),
          unitLabel: priceUnit.trim(),
          quantity,
          uf: priceUf.trim().toUpperCase(),
          competencia: priceComp.trim(),
          deliveryCondition: 'posto_obra',
          includesFreight: false,
          includesInstallationOrService: false,
          includesTaxesAndCharges: true,
          itemKind: 'insumo',
          referenceSource: 'Contrato Analisado',
          referenceVersion: priceComp.trim() || 'v1',
        },
        peers,
      });
      setPriceResult(res);
    } catch (err) {
      handleApiError(err, setPriceError);
    } finally {
      setPriceLoading(false);
    }
  };

  const handleEditalAudit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEditalLoading(true);
    setEditalError(null);
    setEditalResult(null);
    try {
      const res = await auditEditalTextChannels({
        text: editalText,
        procurementId: editalProcurementId.trim() || undefined,
        jurisdiction: editalJurisdiction.trim() || undefined,
      });
      setEditalResult(res);
    } catch (err) {
      handleApiError(err, setEditalError);
    } finally {
      setEditalLoading(false);
    }
  };

  const handleCopyCypher = async () => {
    if (!cypherResult?.cypherScript) return;
    try {
      await navigator.clipboard.writeText(cypherResult.cypherScript);
      setCopiedCypher(true);
      setTimeout(() => setCopiedCypher(false), 1800);
    } catch {
      // Clipboard blocked in non-secure context
    }
  };

  const tabs: Array<{ id: WorkbenchTab; label: string; icon: typeof Activity }> = [
    { id: 'indicadores', label: 'Indicadores & DiD', icon: Activity },
    { id: 'integridade', label: 'Integridade Pública', icon: ShieldAlert },
    { id: 'precos', label: 'Preços & SINAPI', icon: Scale },
    { id: 'canais', label: 'Canais de Participação', icon: Radio },
    { id: 'grafo', label: 'Grafo Cypher & Snapshots', icon: Database },
  ];

  return (
    <div className="space-y-6">
      {/* Header & Strict Auth Notice */}
      <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h1 className="text-2xl font-bold tracking-tight text-[#0B2540] dark:text-[#FAF9F5]">
              Bancada Investigativa
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-300 max-w-3xl">
              Cruzamento técnico de indicadores oficiais (SIAPS/INEP), Diferença-em-Diferenças,
              trilhas de integridade pública, comparabilidade de preços (SINAPI), canais de
              participação em editais e projeção Cypher do banco SQLite.
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <div className="text-right">
              <div className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Snapshots Persistidos
              </div>
              <div className="font-mono tabular-nums text-lg font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                {snapshots.length}
              </div>
            </div>
            {!hasStrictSession && (
              <button
                type="button"
                onClick={onRequireAuth}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#0B2540] dark:bg-[#D95B35] hover:opacity-90 rounded-md whitespace-nowrap"
              >
                <Lock className="w-3.5 h-3.5" aria-hidden="true" />
                Autenticar Auditor
              </button>
            )}
          </div>
        </div>

        {!hasStrictSession && (
          <div className="mt-4 p-3 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-amber-900 dark:text-amber-200">
            <div className="flex items-start gap-2">
              <Lock className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
              <span>
                As rotas de importação oficial e avaliação investigativa exigem sessão autenticada
                ({authPrincipal?.displayName ? `modo atual: ${authPrincipal.displayName}` : 'não autenticado'})
                para registrar autoria e trilha de auditoria. A leitura de snapshots e projeção Cypher
                permanece disponível.
              </span>
            </div>
            <button
              type="button"
              onClick={onRequireAuth}
              className="px-3 py-1.5 font-semibold border border-amber-400 dark:border-amber-700 rounded hover:bg-amber-100 dark:hover:bg-amber-900/40 whitespace-nowrap"
            >
              Entrar agora
            </button>
          </div>
        )}

        {/* Underline Tab Bar (Zero Pills) */}
        <div
          role="tablist"
          aria-label="Módulos da Bancada Investigativa"
          className="mt-5 flex flex-wrap gap-1 border-b border-slate-200 dark:border-[#1D3A57]"
        >
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                role="tab"
                type="button"
                aria-selected={active}
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-2 px-3.5 py-2.5 text-xs font-semibold border-b-2 -mb-px transition-colors whitespace-nowrap ${
                  active
                    ? 'border-[#D95B35] text-[#0B2540] dark:text-[#FAF9F5]'
                    : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-[#0B2540] dark:hover:text-slate-200'
                }`}
              >
                <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </section>

      {/* TAB 1: INDICADORES & DiD */}
      {activeTab === 'indicadores' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <section className="lg:col-span-6 bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 dark:border-[#1D3A57] pb-3">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="w-4 h-4 text-[#D95B35]" aria-hidden="true" />
                <h2 className="text-sm font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                  Importar Exportação Oficial (SIAPS / INEP)
                </h2>
              </div>
              <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                RFC 4180 · SQLite v6
              </span>
            </div>

            <form onSubmit={handleDatasetImport} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label htmlFor="wb-dataset-kind" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Fonte Oficial
                  </label>
                  <select
                    id="wb-dataset-kind"
                    value={datasetKind}
                    onChange={(e) => setDatasetKind(e.target.value as 'siaps' | 'inep')}
                    className="w-full h-9 px-2.5 text-xs bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                  >
                    <option value="siaps">SIAPS / SISAB (Saúde)</option>
                    <option value="inep">INEP / IDEB / SAEB (Educação)</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="wb-dataset-comp" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Competência (opcional)
                  </label>
                  <input
                    id="wb-dataset-comp"
                    type="text"
                    value={datasetCompetencia}
                    onChange={(e) => setDatasetCompetencia(e.target.value)}
                    placeholder="2025-Q3 ou 2025-06"
                    className="w-full h-9 px-2.5 text-xs font-mono bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                  />
                </div>
                <div>
                  <label htmlFor="wb-dataset-file" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Nome do Arquivo
                  </label>
                  <input
                    id="wb-dataset-file"
                    type="text"
                    value={datasetFilename}
                    onChange={(e) => setDatasetFilename(e.target.value)}
                    placeholder="exportacao-oficial.csv"
                    className="w-full h-9 px-2.5 text-xs font-mono bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="wb-dataset-csv" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                  Conteúdo CSV/TSV oficial (suporta decimais entre aspas como &quot;75,5&quot;)
                </label>
                <textarea
                  id="wb-dataset-csv"
                  rows={6}
                  required
                  value={datasetCsv}
                  onChange={(e) => setDatasetCsv(e.target.value)}
                  placeholder="ibge,indicador,competencia,valor,publicado_em"
                  className="w-full p-2.5 text-xs font-mono bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                />
              </div>

              <button
                type="submit"
                disabled={datasetImportLoading}
                className="px-4 py-2 text-xs font-semibold text-white bg-[#0B2540] dark:bg-[#D95B35] hover:opacity-90 disabled:opacity-50 rounded-md"
              >
                {datasetImportLoading ? 'Importando e verificando...' : 'Importar e Persistir Snapshot'}
              </button>
            </form>

            {datasetImportError && (
              <div role="alert" className="p-3 text-xs rounded border border-red-200 dark:border-red-800 bg-red-50/70 dark:bg-red-950/30 text-red-800 dark:text-red-300">
                {datasetImportError}
              </div>
            )}

            {datasetImportResult && (
              <pre className="p-3 text-[11px] font-mono bg-[#FAF9F5] dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] rounded overflow-x-auto max-h-56">
                {JSON.stringify(datasetImportResult, null, 2)}
              </pre>
            )}
          </section>

          <section className="lg:col-span-6 bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 dark:border-[#1D3A57] pb-3">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-[#D95B35]" aria-hidden="true" />
                <h2 className="text-sm font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                  Diferença-em-Diferenças (DiD) Pareado
                </h2>
              </div>
              <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                Gate Metodológico Ativo
              </span>
            </div>

            <form onSubmit={handleDidEvaluate} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="did-contract" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    ID do Contrato
                  </label>
                  <input
                    id="did-contract"
                    type="text"
                    required
                    value={didContractId}
                    onChange={(e) => setDidContractId(e.target.value)}
                    placeholder="CTR-2025-001"
                    className="w-full h-9 px-2.5 text-xs font-mono bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                  />
                </div>
                <div>
                  <label htmlFor="did-indicator" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Código do Indicador
                  </label>
                  <input
                    id="did-indicator"
                    type="text"
                    required
                    value={didIndicatorId}
                    onChange={(e) => setDidIndicatorId(e.target.value)}
                    placeholder="SIAPS_PRENATAL ou INEP_IDEB_AI"
                    className="w-full h-9 px-2.5 text-xs font-mono bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label htmlFor="did-pre" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Tratado Pré
                  </label>
                  <input
                    id="did-pre"
                    type="number"
                    step="any"
                    required
                    value={didTreatedPre}
                    onChange={(e) => setDidTreatedPre(e.target.value)}
                    className="w-full h-9 px-2.5 text-xs font-mono tabular-nums bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                  />
                </div>
                <div>
                  <label htmlFor="did-post" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Tratado Pós
                  </label>
                  <input
                    id="did-post"
                    type="number"
                    step="any"
                    required
                    value={didTreatedPost}
                    onChange={(e) => setDidTreatedPost(e.target.value)}
                    className="w-full h-9 px-2.5 text-xs font-mono tabular-nums bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                  />
                </div>
                <div>
                  <label htmlFor="did-paid" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    % Pago Contrato
                  </label>
                  <input
                    id="did-paid"
                    type="number"
                    min={0}
                    max={100}
                    value={didPaidPct}
                    onChange={(e) => setDidPaidPct(e.target.value)}
                    className="w-full h-9 px-2.5 text-xs font-mono tabular-nums bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="did-controls" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                  Grupo de Controle (JSON: ibgeCode, municipalityName, preValue, postValue)
                </label>
                <textarea
                  id="did-controls"
                  rows={4}
                  value={didControlJson}
                  onChange={(e) => setDidControlJson(e.target.value)}
                  className="w-full p-2.5 text-xs font-mono bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                />
              </div>

              <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={didEligibleDesign}
                  onChange={(e) => setDidEligibleDesign(e.target.checked)}
                  className="rounded border-slate-300 dark:border-[#1D3A57]"
                />
                Desenho metodológico DiD validado (pré-períodos compatíveis e sem quebra de série)
              </label>

              <div>
                <button
                  type="submit"
                  disabled={didLoading}
                  className="px-4 py-2 text-xs font-semibold text-white bg-[#0B2540] dark:bg-[#D95B35] hover:opacity-90 disabled:opacity-50 rounded-md"
                >
                  {didLoading ? 'Calculando DiD...' : 'Executar Cálculo DiD'}
                </button>
              </div>
            </form>

            {didError && (
              <div role="alert" className="p-3 text-xs rounded border border-red-200 dark:border-red-800 bg-red-50/70 dark:bg-red-950/30 text-red-800 dark:text-red-300">
                {didError}
              </div>
            )}

            {didResult && (
              <div className="space-y-2.5">
                {typeof didResult.alertLevel === 'string' && (
                  <div className={`p-3 rounded border text-xs font-mono font-semibold ${renderStatusTone(didResult.alertLevel)}`}>
                    Classificação: {didResult.alertLevel} · Efeito Líquido:{' '}
                    {String(didResult.netEffect ?? '—')}
                  </div>
                )}
                <pre className="p-3 text-[11px] font-mono bg-[#FAF9F5] dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] rounded overflow-x-auto max-h-56">
                  {JSON.stringify(didResult, null, 2)}
                </pre>
              </div>
            )}
          </section>
        </div>
      )}

      {/* TAB 2: INTEGRIDADE PÚBLICA */}
      {activeTab === 'integridade' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <section className="lg:col-span-5 bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-5 space-y-4">
            <div className="border-b border-slate-200 dark:border-[#1D3A57] pb-3">
              <h2 className="text-sm font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                Snapshot Diário de Pessoal (Câmara dos Deputados)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Idempotência por data/competência: o mesmo arquivo em datas distintas preserva a série diária.
              </p>
            </div>

            <form onSubmit={handleCamaraImport} className="space-y-3">
              <div>
                <label htmlFor="camara-date" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                  Data do Snapshot (YYYY-MM-DD)
                </label>
                <input
                  id="camara-date"
                  type="text"
                  value={camaraDate}
                  onChange={(e) => setCamaraDate(e.target.value)}
                  placeholder="2026-05-15"
                  className="w-full h-9 px-2.5 text-xs font-mono bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                />
              </div>
              <div>
                <label htmlFor="camara-csv" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                  CSV Oficial de Funcionários/Gabinetes
                </label>
                <textarea
                  id="camara-csv"
                  rows={6}
                  required
                  value={camaraCsv}
                  onChange={(e) => setCamaraCsv(e.target.value)}
                  placeholder="nome,cargo,lotacao,grupo,data_inicio"
                  className="w-full p-2.5 text-xs font-mono bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                />
              </div>
              <button
                type="submit"
                disabled={camaraLoading}
                className="px-4 py-2 text-xs font-semibold text-white bg-[#0B2540] dark:bg-[#D95B35] hover:opacity-90 disabled:opacity-50 rounded-md"
              >
                {camaraLoading ? 'Importando...' : 'Registrar Snapshot Diário'}
              </button>
            </form>

            {camaraError && (
              <div role="alert" className="p-3 text-xs rounded border border-red-200 dark:border-red-800 bg-red-50/70 dark:bg-red-950/30 text-red-800 dark:text-red-300">
                {camaraError}
              </div>
            )}
            {camaraResult && (
              <pre className="p-3 text-[11px] font-mono bg-[#FAF9F5] dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] rounded overflow-x-auto max-h-56">
                {JSON.stringify(camaraResult, null, 2)}
              </pre>
            )}
          </section>

          <section className="lg:col-span-7 bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-5 space-y-4">
            <div className="border-b border-slate-200 dark:border-[#1D3A57] pb-3">
              <h2 className="text-sm font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                Trilhas de Parentesco, Conflito de Interesse e Requisitos de Cargo
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Exige evidência documental, igualdade de identidade (personId) e não presume conformidade sem diploma/comprovação.
              </p>
            </div>

            <form onSubmit={handleIntegrityEvaluate} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="int-role" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Cargo para verificação de requisito (opcional)
                  </label>
                  <input
                    id="int-role"
                    type="text"
                    value={integrityRoleName}
                    onChange={(e) => setIntegrityRoleName(e.target.value)}
                    placeholder="Ex.: Controlador-Geral Municipal"
                    className="w-full h-9 px-2.5 text-xs bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                  />
                </div>
                <div>
                  <label htmlFor="int-basis" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Norma / Base Legal
                  </label>
                  <input
                    id="int-basis"
                    type="text"
                    value={integrityLegalBasis}
                    onChange={(e) => setIntegrityLegalBasis(e.target.value)}
                    placeholder="Ex.: Súmula Vinculante 13 / Lei Municipal"
                    className="w-full h-9 px-2.5 text-xs bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                  />
                </div>
              </div>

              <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={integrityRequiresGrad}
                  onChange={(e) => setIntegrityRequiresGrad(e.target.checked)}
                  className="rounded border-slate-300 dark:border-[#1D3A57]"
                />
                Cargo exige graduação/nível superior em norma aplicável
              </label>

              <div>
                <label htmlFor="int-json" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                  Payload estruturado (kinships, appointments, contractConflicts)
                </label>
                <textarea
                  id="int-json"
                  rows={5}
                  value={integrityPayloadJson}
                  onChange={(e) => setIntegrityPayloadJson(e.target.value)}
                  className="w-full p-2.5 text-xs font-mono bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                />
              </div>

              <button
                type="submit"
                disabled={integrityLoading}
                className="px-4 py-2 text-xs font-semibold text-white bg-[#0B2540] dark:bg-[#D95B35] hover:opacity-90 disabled:opacity-50 rounded-md"
              >
                {integrityLoading ? 'Avaliando trilhas...' : 'Executar Trilhas de Integridade'}
              </button>
            </form>

            {integrityError && (
              <div role="alert" className="p-3 text-xs rounded border border-red-200 dark:border-red-800 bg-red-50/70 dark:bg-red-950/30 text-red-800 dark:text-red-300">
                {integrityError}
              </div>
            )}
            {integrityResult && (
              <pre className="p-3 text-[11px] font-mono bg-[#FAF9F5] dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] rounded overflow-x-auto max-h-64">
                {JSON.stringify(integrityResult, null, 2)}
              </pre>
            )}
          </section>
        </div>
      )}

      {/* TAB 3: PREÇOS & SINAPI */}
      {activeTab === 'precos' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <section className="lg:col-span-5 bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-5 space-y-4">
            <div className="border-b border-slate-200 dark:border-[#1D3A57] pb-3">
              <h2 className="text-sm font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                Importar Tabela Oficial SINAPI / CAIXA
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Valida competência, preserva regime tributário (desonerado/não desonerado) e separa insumo de composição.
              </p>
            </div>

            <form onSubmit={handleSinapiImport} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="sinapi-uf" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    UF
                  </label>
                  <input
                    id="sinapi-uf"
                    type="text"
                    required
                    maxLength={2}
                    value={sinapiUf}
                    onChange={(e) => setSinapiUf(e.target.value)}
                    placeholder="PE"
                    className="w-full h-9 px-2.5 text-xs font-mono uppercase bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                  />
                </div>
                <div>
                  <label htmlFor="sinapi-comp" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Competência (YYYY-MM)
                  </label>
                  <input
                    id="sinapi-comp"
                    type="text"
                    required
                    value={sinapiComp}
                    onChange={(e) => setSinapiComp(e.target.value)}
                    placeholder="2026-03"
                    className="w-full h-9 px-2.5 text-xs font-mono bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="sinapi-regime" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Regime Tributário
                  </label>
                  <select
                    id="sinapi-regime"
                    value={sinapiRegime}
                    onChange={(e) =>
                      setSinapiRegime(e.target.value as 'nao_desonerado' | 'desonerado')
                    }
                    className="w-full h-9 px-2.5 text-xs bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                  >
                    <option value="nao_desonerado">Não desonerado</option>
                    <option value="desonerado">Desonerado</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="sinapi-kind" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Tipo Padrão
                  </label>
                  <select
                    id="sinapi-kind"
                    value={sinapiKind}
                    onChange={(e) => setSinapiKind(e.target.value as 'insumo' | 'composicao')}
                    className="w-full h-9 px-2.5 text-xs bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                  >
                    <option value="insumo">Insumo</option>
                    <option value="composicao">Composição</option>
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="sinapi-csv" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                  CSV Oficial SINAPI
                </label>
                <textarea
                  id="sinapi-csv"
                  rows={5}
                  required
                  value={sinapiCsv}
                  onChange={(e) => setSinapiCsv(e.target.value)}
                  placeholder={'codigo,descricao,unidade,preco_mediano\n00001379,"Cimento Portland CP II-E-32",KG,"0,82"'}
                  className="w-full p-2.5 text-xs font-mono bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                />
              </div>

              <button
                type="submit"
                disabled={sinapiLoading}
                className="px-4 py-2 text-xs font-semibold text-white bg-[#0B2540] dark:bg-[#D95B35] hover:opacity-90 disabled:opacity-50 rounded-md"
              >
                {sinapiLoading ? 'Importando SINAPI...' : 'Importar Tabela SINAPI'}
              </button>
            </form>

            {sinapiError && (
              <div role="alert" className="p-3 text-xs rounded border border-red-200 dark:border-red-800 bg-red-50/70 dark:bg-red-950/30 text-red-800 dark:text-red-300">
                {sinapiError}
              </div>
            )}
            {sinapiResult && (
              <pre className="p-3 text-[11px] font-mono bg-[#FAF9F5] dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] rounded overflow-x-auto max-h-52">
                {JSON.stringify(sinapiResult, null, 2)}
              </pre>
            )}
          </section>

          <section className="lg:col-span-7 bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-5 space-y-4">
            <div className="border-b border-slate-200 dark:border-[#1D3A57] pb-3">
              <h2 className="text-sm font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                Comparabilidade Técnica de Preços (Mediana, MAD e Proveniência por peerId)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Valida sobreposição de especificação, UF, janela de competência e conversão conjunta de preço e quantidade.
              </p>
            </div>

            <form onSubmit={handlePriceEvaluate} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label htmlFor="pr-spec" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Especificação Técnica do Item
                  </label>
                  <input
                    id="pr-spec"
                    type="text"
                    required
                    value={priceSpec}
                    onChange={(e) => setPriceSpec(e.target.value)}
                    placeholder="Cimento Portland CP II-E-32"
                    className="w-full h-9 px-2.5 text-xs bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                  />
                </div>
                <div>
                  <label htmlFor="pr-nominal" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Preço Unitário (R$)
                  </label>
                  <input
                    id="pr-nominal"
                    type="number"
                    step="any"
                    required
                    value={priceNominal}
                    onChange={(e) => setPriceNominal(e.target.value)}
                    placeholder="1.80"
                    className="w-full h-9 px-2.5 text-xs font-mono tabular-nums bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label htmlFor="pr-unit" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Unidade
                  </label>
                  <input
                    id="pr-unit"
                    type="text"
                    required
                    value={priceUnit}
                    onChange={(e) => setPriceUnit(e.target.value)}
                    className="w-full h-9 px-2.5 text-xs font-mono bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                  />
                </div>
                <div>
                  <label htmlFor="pr-qty" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Quantidade
                  </label>
                  <input
                    id="pr-qty"
                    type="number"
                    step="any"
                    required
                    value={priceQty}
                    onChange={(e) => setPriceQty(e.target.value)}
                    className="w-full h-9 px-2.5 text-xs font-mono tabular-nums bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                  />
                </div>
                <div>
                  <label htmlFor="pr-uf" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    UF
                  </label>
                  <input
                    id="pr-uf"
                    type="text"
                    required
                    maxLength={2}
                    value={priceUf}
                    onChange={(e) => setPriceUf(e.target.value)}
                    placeholder="PE"
                    className="w-full h-9 px-2.5 text-xs font-mono uppercase bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                  />
                </div>
                <div>
                  <label htmlFor="pr-comp" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Competência
                  </label>
                  <input
                    id="pr-comp"
                    type="text"
                    required
                    value={priceComp}
                    onChange={(e) => setPriceComp(e.target.value)}
                    placeholder="2026-03"
                    className="w-full h-9 px-2.5 text-xs font-mono bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="pr-peers" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                  Lista de Comparáveis (JSON ComparablePricePeerInput[])
                </label>
                <textarea
                  id="pr-peers"
                  rows={5}
                  value={pricePeersJson}
                  onChange={(e) => setPricePeersJson(e.target.value)}
                  className="w-full p-2.5 text-xs font-mono bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                />
              </div>

              <button
                type="submit"
                disabled={priceLoading}
                className="px-4 py-2 text-xs font-semibold text-white bg-[#0B2540] dark:bg-[#D95B35] hover:opacity-90 disabled:opacity-50 rounded-md"
              >
                {priceLoading ? 'Avaliando comparabilidade...' : 'Executar Benchmark Investigativo'}
              </button>
            </form>

            {priceError && (
              <div role="alert" className="p-3 text-xs rounded border border-red-200 dark:border-red-800 bg-red-50/70 dark:bg-red-950/30 text-red-800 dark:text-red-300">
                {priceError}
              </div>
            )}
            {priceResult && (
              <pre className="p-3 text-[11px] font-mono bg-[#FAF9F5] dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] rounded overflow-x-auto max-h-64">
                {JSON.stringify(priceResult, null, 2)}
              </pre>
            )}
          </section>
        </div>
      )}

      {/* TAB 4: CANAIS DE PARTICIPAÇÃO */}
      {activeTab === 'canais' && (
        <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6 space-y-4">
          <div className="border-b border-slate-200 dark:border-[#1D3A57] pb-3">
            <h2 className="text-sm font-bold text-[#0B2540] dark:text-[#FAF9F5]">
              Auditoria de Canais Efetivos de Participação em Editais (Art. 5º Lei 14.133/2021 · LAI · PNTP)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Separa rigorosamente portais de divulgação/publicação (PNCP, Diário Oficial, Portal da Transparência) de plataformas efetivas de envio eletrônico de propostas (Compras.gov.br, BLL, BNC, Licitanet).
            </p>
          </div>

          <form onSubmit={handleEditalAudit} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="ed-proc" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                  Identificador do Edital / Processo
                </label>
                <input
                  id="ed-proc"
                  type="text"
                  value={editalProcurementId}
                  onChange={(e) => setEditalProcurementId(e.target.value)}
                  placeholder="PE-014/2026"
                  className="w-full h-9 px-2.5 text-xs font-mono bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                />
              </div>
              <div>
                <label htmlFor="ed-jur" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                  Esfera / Ente
                </label>
                <input
                  id="ed-jur"
                  type="text"
                  value={editalJurisdiction}
                  onChange={(e) => setEditalJurisdiction(e.target.value)}
                  placeholder="Município / Estado / União"
                  className="w-full h-9 px-2.5 text-xs bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                />
              </div>
            </div>

            <div>
              <label htmlFor="ed-text" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                Texto extraído do Edital / Aviso de Licitação
              </label>
              <textarea
                id="ed-text"
                rows={6}
                required
                value={editalText}
                onChange={(e) => setEditalText(e.target.value)}
                placeholder="Cole o texto do edital com cláusulas de envio de proposta, impugnação, esclarecimentos e divulgação..."
                className="w-full p-2.5 text-xs bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
              />
            </div>

            <button
              type="submit"
              disabled={editalLoading}
              className="px-4 py-2 text-xs font-semibold text-white bg-[#0B2540] dark:bg-[#D95B35] hover:opacity-90 disabled:opacity-50 rounded-md"
            >
              {editalLoading ? 'Auditando canais...' : 'Auditar Canais do Edital'}
            </button>
          </form>

          {editalError && (
            <div role="alert" className="p-3 text-xs rounded border border-red-200 dark:border-red-800 bg-red-50/70 dark:bg-red-950/30 text-red-800 dark:text-red-300">
              {editalError}
            </div>
          )}

          {editalResult && (
            <div className="space-y-4 pt-2 border-t border-slate-200 dark:border-[#1D3A57]">
              <div className={`p-3 rounded border text-xs font-mono font-semibold ${renderStatusTone(editalResult.status)}`}>
                Status: {editalResult.status}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                <div className="p-3 rounded border border-slate-200 dark:border-[#1D3A57] bg-[#FAF9F5] dark:bg-[#061321]">
                  <div className="text-slate-500 dark:text-slate-400">Plataformas de Envio de Proposta</div>
                  <div className="font-mono font-semibold text-[#0B2540] dark:text-[#FAF9F5] mt-1 break-all">
                    {editalResult.platformsFound.length > 0
                      ? editalResult.platformsFound.join(', ')
                      : 'Nenhuma identificada'}
                  </div>
                </div>
                <div className="p-3 rounded border border-slate-200 dark:border-[#1D3A57] bg-[#FAF9F5] dark:bg-[#061321]">
                  <div className="text-slate-500 dark:text-slate-400">Portais de Publicação/Divulgação</div>
                  <div className="font-mono font-semibold text-[#0B2540] dark:text-[#FAF9F5] mt-1 break-all">
                    {editalResult.publicationPortalsFound.length > 0
                      ? editalResult.publicationPortalsFound.join(', ')
                      : 'Nenhum identificado'}
                  </div>
                </div>
                <div className="p-3 rounded border border-slate-200 dark:border-[#1D3A57] bg-[#FAF9F5] dark:bg-[#061321]">
                  <div className="text-slate-500 dark:text-slate-400">E-mails Institucionais</div>
                  <div className="font-mono font-semibold text-[#0B2540] dark:text-[#FAF9F5] mt-1 break-all">
                    {editalResult.emailsFound.length > 0
                      ? editalResult.emailsFound.join(', ')
                      : 'Nenhum identificado'}
                  </div>
                </div>
                <div className="p-3 rounded border border-slate-200 dark:border-[#1D3A57] bg-[#FAF9F5] dark:bg-[#061321]">
                  <div className="text-slate-500 dark:text-slate-400">Telefones de Contato</div>
                  <div className="font-mono font-semibold text-[#0B2540] dark:text-[#FAF9F5] mt-1">
                    {editalResult.phonesFound.length > 0
                      ? editalResult.phonesFound.join(', ')
                      : 'Nenhum identificado'}
                  </div>
                </div>
              </div>

              {editalResult.alerts.length > 0 && (
                <ul className="space-y-2">
                  {editalResult.alerts.map((al) => (
                    <li
                      key={al.code}
                      className={`p-3 rounded border text-xs flex items-start gap-2 ${
                        al.severity === 'critico'
                          ? 'bg-red-50/70 dark:bg-red-950/30 border-red-200 dark:border-red-800 text-red-900 dark:text-red-200'
                          : 'bg-amber-50/70 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200'
                      }`}
                    >
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                      <div>
                        <span className="font-mono font-semibold">{al.code}</span> — {al.message}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {/* TAB 5: GRAFO CYPHER & SNAPSHOTS */}
      {activeTab === 'grafo' && (
        <div className="space-y-6">
          <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 dark:border-[#1D3A57] pb-3">
              <div>
                <h2 className="text-sm font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                  Projeção Forense Cypher (Neo4j 5+ sobre SQLite Primário)
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Arestas descartadas (dismissed) dominam a composição e nunca reaparecem como documentadas.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {cypherResult && (
                  <button
                    type="button"
                    onClick={handleCopyCypher}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-300 dark:border-[#1D3A57] rounded-md hover:bg-[#E8F1F6] dark:hover:bg-[#102843]"
                  >
                    {copiedCypher ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedCypher ? 'Copiado' : 'Copiar Cypher'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={loadCypherProjection}
                  disabled={cypherLoading}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-[#0B2540] dark:bg-[#D95B35] rounded-md hover:opacity-90 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${cypherLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
                  Atualizar Projeção
                </button>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-end gap-3">
              <div className="flex-1 max-w-xs">
                <label htmlFor="cypher-cnpj" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                  CNPJ Alvo para Rede Multi-Salto (opcional)
                </label>
                <input
                  id="cypher-cnpj"
                  type="text"
                  value={cypherTargetCnpj}
                  onChange={(e) => setCypherTargetCnpj(e.target.value)}
                  placeholder="00.000.000/0001-00"
                  className="w-full h-9 px-2.5 text-xs font-mono bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                />
              </div>
              <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 h-9 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cypherOnlyDocumented}
                  onChange={(e) => setCypherOnlyDocumented(e.target.checked)}
                  className="rounded border-slate-300 dark:border-[#1D3A57]"
                />
                Somente vínculos documentados (exclui candidatos, contestados e descartados)
              </label>
            </div>

            {cypherError && (
              <div role="alert" className="p-3 text-xs rounded border border-red-200 dark:border-red-800 bg-red-50/70 dark:bg-red-950/30 text-red-800 dark:text-red-300">
                {cypherError}
              </div>
            )}

            {cypherResult && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  {[
                    { label: 'Pessoas', value: cypherResult.counts.people },
                    { label: 'Empresas', value: cypherResult.counts.companies },
                    { label: 'Órgãos', value: cypherResult.counts.agencies },
                    { label: 'Cargos', value: cypherResult.counts.offices },
                    { label: 'Contratos', value: cypherResult.counts.contracts },
                  ].map((stat) => (
                    <div
                      key={stat.label}
                      className="p-3 rounded border border-slate-200 dark:border-[#1D3A57] bg-[#FAF9F5] dark:bg-[#061321]"
                    >
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">{stat.label}</div>
                      <div className="font-mono tabular-nums text-lg font-bold text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                        {stat.value}
                      </div>
                    </div>
                  ))}
                </div>

                <pre className="p-3 text-[11px] font-mono bg-[#FAF9F5] dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] rounded overflow-x-auto max-h-60">
                  {cypherResult.cypherScript || '// Nenhum nó projetado no banco SQLite local ainda.'}
                </pre>
              </div>
            )}
          </section>

          <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-[#1D3A57] flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                  Snapshots Oficiais Persistidos (SQLite v6)
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Chave composta (fonte, SHA-256, competência, UF) com verificação pós-escrita.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  aria-label="Filtrar snapshots por fonte"
                  value={snapshotFilter}
                  onChange={(e) =>
                    setSnapshotFilter(
                      e.target.value as 'all' | 'siaps' | 'inep' | 'sinapi' | 'camara_personnel'
                    )
                  }
                  className="h-8 px-2.5 text-xs bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] rounded-md"
                >
                  <option value="all">Todas as fontes</option>
                  <option value="siaps">SIAPS</option>
                  <option value="inep">INEP</option>
                  <option value="sinapi">SINAPI</option>
                  <option value="camara_personnel">Câmara (Pessoal)</option>
                </select>
                <button
                  type="button"
                  onClick={() => loadSnapshots(snapshotFilter)}
                  disabled={snapshotsLoading}
                  className="p-1.5 border border-slate-300 dark:border-[#1D3A57] rounded-md hover:bg-[#E8F1F6] dark:hover:bg-[#102843]"
                  aria-label="Recarregar lista de snapshots"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${snapshotsLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
                </button>
              </div>
            </div>

            {snapshotsError && (
              <div role="alert" className="m-4 p-3 text-xs rounded border border-red-200 dark:border-red-800 bg-red-50/70 dark:bg-red-950/30 text-red-800 dark:text-red-300">
                {snapshotsError}
              </div>
            )}

            {snapshots.length === 0 ? (
              <div className="px-6 py-8 text-center text-xs text-slate-500 dark:text-slate-400">
                Nenhum snapshot oficial importado para o filtro selecionado. Utilize as abas de importação para registrar bases oficiais com verificação SHA-256.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#FAF9F5] dark:bg-[#061321] border-b border-slate-200 dark:border-[#1D3A57] text-slate-500 dark:text-slate-400">
                    <tr>
                      <th className="px-4 py-2.5 font-semibold">Fonte</th>
                      <th className="px-4 py-2.5 font-semibold">Arquivo</th>
                      <th className="px-4 py-2.5 font-semibold">Competência</th>
                      <th className="px-4 py-2.5 font-semibold">UF</th>
                      <th className="px-4 py-2.5 font-semibold">SHA-256</th>
                      <th className="px-4 py-2.5 font-semibold">Importado por</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-[#1D3A57]">
                    {snapshots.map((snap) => (
                      <tr key={snap.id} className="hover:bg-[#FAF9F5]/60 dark:hover:bg-[#102843]/40">
                        <td className="px-4 py-2.5 font-mono font-semibold uppercase text-[#D95B35]">
                          {snap.sourceKind}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-[#0B2540] dark:text-[#FAF9F5]">
                          {snap.filename}
                        </td>
                        <td className="px-4 py-2.5 font-mono tabular-nums">{snap.competencia}</td>
                        <td className="px-4 py-2.5 font-mono">{snap.uf ?? '—'}</td>
                        <td className="px-4 py-2.5 font-mono text-slate-500 dark:text-slate-400">
                          {snap.sha256.slice(0, 14)}…
                        </td>
                        <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">
                          {snap.importedBy}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

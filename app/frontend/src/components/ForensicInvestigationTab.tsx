import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Clock,
  Download,
  FileJson,
  FileLock2,
  History,
  Lock,
  RefreshCw,
  Scale,
  Search,
  ShieldCheck,
  Terminal,
  Upload,
} from 'lucide-react';
import type { AuthPrincipalInfo } from '../lib/api';
import {
  downloadPrivateEvidenceFile,
  exportInvestigationPackage,
  fetchInvestigationCase,
  InvestigationConflictApiError,
  runInvestigationCadastralQuery,
  submitInvestigationReview,
  syncInvestigationPncpHistory,
  updateInvestigationFacts,
  uploadPrivateEvidence,
} from '../lib/api';
import { formatBytes, formatCnpj, formatCurrencyBRL, formatDateBR } from '@nexofis/shared/lib/formatters';
import type { EvaluatedContract } from '@nexofis/shared/types/audit';
import type {
  CadastralEventType,
  InvestigationCasePayload,
  InvestigationFinding,
  InvestigationFindingStatus,
  InvestigationReviewAction,
} from '@nexofis/shared/types/investigation';

interface ForensicInvestigationTabProps {
  contract: EvaluatedContract;
  authPrincipal: AuthPrincipalInfo | null;
  onRequireAuth: () => void;
}

const EVENT_TYPE_LABELS: Record<CadastralEventType, string> = {
  constituicao: 'Constituição (Junta / Contrato Social)',
  inscricao_cnpj: 'Inscrição no CNPJ (RFB)',
  inicio_atividade: 'Início de atividade cadastral',
};

const BAND_META: Record<
  string,
  { label: string; className: string }
> = {
  incompativel: {
    label: 'Incompatível (Δd < 0)',
    className: 'text-red-700 dark:text-red-400 font-semibold',
  },
  '0-1': {
    label: '0–1 dia',
    className: 'text-red-700 dark:text-red-400 font-semibold',
  },
  '2-30': {
    label: '2–30 dias',
    className: 'text-amber-700 dark:text-amber-400 font-semibold',
  },
  '31-90': {
    label: '31–90 dias',
    className: 'text-amber-700 dark:text-amber-300 font-medium',
  },
  '>90': {
    label: '> 90 dias',
    className: 'text-emerald-700 dark:text-emerald-400 font-medium',
  },
};

function getFindingStatusMeta(status: InvestigationFindingStatus): {
  label: string;
  borderClass: string;
  textClass: string;
} {
  switch (status) {
    case 'APONTAMENTO':
      return {
        label: 'APONTAMENTO',
        borderClass: 'border-l-[#D95B35]',
        textClass: 'text-[#D95B35] dark:text-[#f07a57] font-semibold',
      };
    case 'INCONSISTENCIA':
      return {
        label: 'INCONSISTÊNCIA',
        borderClass: 'border-l-red-600',
        textClass: 'text-red-700 dark:text-red-400 font-semibold',
      };
    case 'ORCAMENTO_EXCEDIDO':
      return {
        label: 'ORÇAMENTO EXCEDIDO',
        borderClass: 'border-l-amber-600',
        textClass: 'text-amber-700 dark:text-amber-400 font-semibold',
      };
    case 'INCOMPLETO':
      return {
        label: 'DADOS INCOMPLETOS',
        borderClass: 'border-l-slate-400 dark:border-l-slate-600',
        textClass: 'text-slate-600 dark:text-slate-400 font-medium',
      };
    case 'SEM_SINAL':
      return {
        label: 'SEM SINAL NO UNIVERSO OBSERVADO',
        borderClass: 'border-l-emerald-600',
        textClass: 'text-emerald-700 dark:text-emerald-400 font-medium',
      };
  }
}

function getReviewActionLabel(action: InvestigationReviewAction): string {
  if (action === 'confirm') return 'Confirmado pelo auditor';
  if (action === 'dismiss') return 'Descartado com justificativa';
  return 'Restaurado para diligência';
}

function serializeEditableFactSet(caseData: InvestigationCasePayload): string {
  const {
    corporateDates,
    corporateChanges,
    people,
    corporateLinks,
    publicFunctions,
    kinshipRelations,
    lotParticipants,
  } = caseData.factSet;
  return JSON.stringify(
    {
      corporateDates,
      corporateChanges,
      people,
      corporateLinks,
      publicFunctions,
      kinshipRelations,
      lotParticipants,
    },
    null,
    2
  );
}

export function ForensicInvestigationTab({
  contract,
  authPrincipal,
  onRequireAuth,
}: ForensicInvestigationTabProps) {
  const canAccess =
    Boolean(authPrincipal?.authEnabled) &&
    (authPrincipal?.role === 'admin' || authPrincipal?.role === 'analyst');

  const [caseData, setCaseData] = useState<InvestigationCasePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);

  // Cadastral query form state
  const [cadPurpose, setCadPurpose] = useState('Verificação de cronologia empresarial e QSA');
  const [cadLegalBasis, setCadLegalBasis] = useState('Lei 14.133/2021 e Lei 12.527/2011 (LAI)');
  const [cadJustification, setCadJustification] = useState(
    'Conferir data de início de atividade e quadro societário declarado para subsidiar diligência documental.'
  );
  const [cadBusy, setCadBusy] = useState(false);

  // PNCP history sync state
  const [pncpBusy, setPncpBusy] = useState(false);

  // Private evidence upload state
  const [evFile, setEvFile] = useState<File | null>(null);
  const [evSourceLabel, setEvSourceLabel] = useState('');
  const [evDescription, setEvDescription] = useState('');
  const [evAcquiredAt, setEvAcquiredAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [evBusy, setEvBusy] = useState(false);
  const [downloadingEvidenceId, setDownloadingEvidenceId] = useState<string | null>(null);

  // Versioned facts JSON editor state (F08: track base version independently from live case version)
  const [factsDraftJson, setFactsDraftJson] = useState('');
  const [editorBaseVersion, setEditorBaseVersion] = useState<number | null>(null);
  const [factsBusy, setFactsBusy] = useState(false);
  const [factsError, setFactsError] = useState<string | null>(null);
  const [versionConflict, setVersionConflict] = useState<{
    expectedVersion: number;
    currentVersion: number;
  } | null>(null);

  // Review inline drawer state
  const [reviewingFindingId, setReviewingFindingId] = useState<string | null>(null);
  const [reviewAction, setReviewAction] = useState<InvestigationReviewAction>('confirm');
  const [reviewRationale, setReviewRationale] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);

  // Export state
  const [exportBusy, setExportBusy] = useState(false);

  // Filter findings by status
  const [onlyTriggered, setOnlyTriggered] = useState(false);

  const loadCase = useCallback(async () => {
    if (!canAccess) return;
    setLoading(true);
    setError(null);
    setVersionConflict(null);
    try {
      const data = await fetchInvestigationCase(contract.id);
      setCaseData(data);
      setFactsDraftJson(serializeEditableFactSet(data));
      setEditorBaseVersion(data.factSet.version);
      setFactsError(null);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Não foi possível carregar o caso de investigação forense.'
      );
    } finally {
      setLoading(false);
    }
  }, [canAccess, contract.id]);

  useEffect(() => {
    if (canAccess) {
      void loadCase();
    } else {
      setCaseData(null);
      setEditorBaseVersion(null);
    }
  }, [canAccess, loadCase]);

  const handleCadastralQuery = async (e: FormEvent) => {
    e.preventDefault();
    setCadBusy(true);
    setError(null);
    setBannerMessage(null);
    try {
      const res = await runInvestigationCadastralQuery(contract.id, {
        purpose: cadPurpose,
        legalBasis: cadLegalBasis,
        justification: cadJustification,
      });
      setCaseData(res.investigation);
      setFactsDraftJson(serializeEditableFactSet(res.investigation));
      setEditorBaseVersion(res.investigation.factSet.version);
      setBannerMessage(
        `Extrato cadastral minimizado (${res.extract.id}) registrado via BrasilAPI com ${res.extract.qsa.length} membro(s) no QSA (identidades marcadas como não resolvidas).`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha na consulta cadastral.');
    } finally {
      setCadBusy(false);
    }
  };

  const handlePncpSync = async () => {
    setPncpBusy(true);
    setError(null);
    setBannerMessage(null);
    try {
      const res = await syncInvestigationPncpHistory(contract.id);
      setCaseData(res.investigation);
      setBannerMessage(
        `Histórico observado atualizado (${res.observedHistory.contracts.length} contrato(s) localizado(s) · status PNCP: ${res.observedHistory.pncpStatus}).`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao sincronizar histórico PNCP.');
    } finally {
      setPncpBusy(false);
    }
  };

  const handleEvidenceUpload = async (e: FormEvent) => {
    e.preventDefault();
    if (!evFile) {
      setError('Selecione um arquivo de até 1 MiB para anexar como evidência privada.');
      return;
    }
    if (evFile.size > 1024 * 1024) {
      setError('O arquivo selecionado ultrapassa o limite de 1 MiB para evidências privadas.');
      return;
    }
    setEvBusy(true);
    setError(null);
    setBannerMessage(null);
    try {
      const res = await uploadPrivateEvidence(contract.id, {
        file: evFile,
        sourceLabel: evSourceLabel,
        description: evDescription,
        acquiredAt: evAcquiredAt,
      });
      setCaseData(res.investigation);
      setEvFile(null);
      setEvSourceLabel('');
      setEvDescription('');
      setBannerMessage(
        `Evidência privada armazenada em repositório isolado (${res.evidence.exportFilename}).`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao anexar evidência privada.');
    } finally {
      setEvBusy(false);
    }
  };

  const handleEvidenceDownload = async (evidenceId: string, exportFilename: string) => {
    setDownloadingEvidenceId(evidenceId);
    setError(null);
    try {
      await downloadPrivateEvidenceFile(contract.id, evidenceId, exportFilename);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao baixar evidência privada.');
    } finally {
      setDownloadingEvidenceId(null);
    }
  };

  const handleSaveFacts = async () => {
    if (!caseData) return;
    setFactsError(null);
    setVersionConflict(null);
    setBannerMessage(null);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(factsDraftJson) as Record<string, unknown>;
    } catch (err) {
      setFactsError(
        `JSON inválido no editor de fatos: ${err instanceof Error ? err.message : 'erro de sintaxe'}`
      );
      return;
    }

    setFactsBusy(true);
    try {
      const expectedVer = editorBaseVersion ?? caseData.factSet.version;
      const updated = await updateInvestigationFacts(
        contract.id,
        expectedVer,
        parsed as unknown as Omit<InvestigationCasePayload['factSet'], 'version' | 'updatedAt' | 'updatedBy'>
      );
      setCaseData(updated);
      setFactsDraftJson(serializeEditableFactSet(updated));
      setEditorBaseVersion(updated.factSet.version);
      setBannerMessage(
        `Conjunto de fatos salvo com sucesso (versão v${updated.factSet.version}) e trilhas reavaliadas.`
      );
    } catch (err) {
      if (err instanceof InvestigationConflictApiError) {
        setVersionConflict({
          expectedVersion: err.expectedVersion,
          currentVersion: err.currentVersion,
        });
        setFactsError(err.message);
      } else {
        setFactsError(err instanceof Error ? err.message : 'Falha ao salvar fatos.');
      }
    } finally {
      setFactsBusy(false);
    }
  };

  const handleFormatJson = () => {
    try {
      const parsed = JSON.parse(factsDraftJson);
      setFactsDraftJson(JSON.stringify(parsed, null, 2));
      setFactsError(null);
    } catch (err) {
      setFactsError(
        `Não foi possível formatar JSON: ${err instanceof Error ? err.message : 'sintaxe inválida'}`
      );
    }
  };

  const handleSubmitReview = async (finding: InvestigationFinding) => {
    setReviewBusy(true);
    setError(null);
    setBannerMessage(null);
    try {
      const res = await submitInvestigationReview(contract.id, {
        findingId: finding.findingId,
        action: reviewAction,
        rationale: reviewRationale,
        expectedFindingInputsDigest: finding.inputsDigest,
        expectedFactsVersion: finding.factsVersion,
      });
      setCaseData(res.investigation);
      setReviewingFindingId(null);
      setReviewRationale('');
      setBannerMessage(
        `Revisão humana registrada para ${finding.trailCode} vinculada à versão de fatos v${res.review.factsVersion}.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao registrar revisão.');
    } finally {
      setReviewBusy(false);
    }
  };

  const handleExportPackage = async () => {
    setExportBusy(true);
    setError(null);
    try {
      const pkg = await exportInvestigationPackage(contract.id);
      const blob = new Blob([JSON.stringify(pkg, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeContractNum = (contract.contractNumber || contract.id).replace(
        /[^a-zA-Z0-9._-]+/g,
        '_'
      );
      a.download = `nexofis-investigacao-${safeContractNum}-v${pkg.factSet.version}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setBannerMessage(
        `Pacote verificável exportado (SHA-256 ${pkg.packageDigestSha256.slice(0, 16)}…).`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao exportar pacote verificável.');
    } finally {
      setExportBusy(false);
    }
  };

  // Strict Auth Gate — always enforced for Investigação Forense
  if (!canAccess) {
    return (
      <section
        data-testid="investigation-auth-gate"
        className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-8 max-w-2xl mx-auto space-y-5"
      >
        <div className="flex items-start gap-3.5">
          <div className="p-2.5 rounded-md bg-[#E8F1F6] dark:bg-[#102843] text-[#0B2540] dark:text-[#D95B35] shrink-0">
            <Lock className="w-5 h-5" aria-hidden="true" />
          </div>
          <div className="space-y-1.5">
            <h2 className="text-lg font-bold text-[#0B2540] dark:text-[#FAF9F5]">
              Autenticação obrigatória para Investigação Forense
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              O módulo de Investigação Forense manipula evidências privadas isoladas, consultas
              cadastrais/QSA com finalidade registrada e um livro-razão append-only encadeado por
              SHA-256. Mesmo em workspace local, o acesso exige sessão autenticada com perfil{' '}
              <span className="font-mono font-semibold text-[#0B2540] dark:text-white">
                analyst
              </span>{' '}
              ou{' '}
              <span className="font-mono font-semibold text-[#0B2540] dark:text-white">
                admin
              </span>
              .
            </p>
            {authPrincipal?.authEnabled && authPrincipal.role === 'viewer' && (
              <p className="text-xs text-red-700 dark:text-red-400 font-medium pt-1">
                Sessão atual autenticada como perfil viewer, sem permissão para investigação forense.
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1 text-xs text-slate-600 dark:text-slate-300">
          <div className="p-3 rounded-md bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57]">
            <div className="font-semibold text-[#0B2540] dark:text-slate-100">8 Trilhas Determinísticas</div>
            <p className="mt-0.5 text-slate-500 dark:text-slate-400">
              Cronologia, alterações recentes, histórico PNCP, vínculos, parentesco e lotes.
            </p>
          </div>
          <div className="p-3 rounded-md bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57]">
            <div className="font-semibold text-[#0B2540] dark:text-slate-100">Evidências Isoladas</div>
            <p className="mt-0.5 text-slate-500 dark:text-slate-400">
              Armazenadas fora da rota pública de documentos, até 1 MiB, com download autenticado.
            </p>
          </div>
          <div className="p-3 rounded-md bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57]">
            <div className="font-semibold text-[#0B2540] dark:text-slate-100">Verificação Offline</div>
            <p className="mt-0.5 text-slate-500 dark:text-slate-400">
              Pacote JSON reproduzível com conferência independente via CLI sem rede.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <button
            type="button"
            data-testid="investigation-open-auth-btn"
            onClick={onRequireAuth}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-[#0B2540] hover:bg-[#102843] dark:bg-[#D95B35] dark:hover:bg-[#c04c29] rounded-md transition-colors"
          >
            <Lock className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Autenticar para Investigação Forense</span>
          </button>
        </div>
      </section>
    );
  }

  if (loading && !caseData) {
    return (
      <div
        aria-busy="true"
        className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-8 animate-pulse space-y-4"
      >
        <div className="h-5 w-64 bg-slate-200 dark:bg-[#102843] rounded" />
        <div className="h-4 w-96 bg-slate-100 dark:bg-[#102843] rounded" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
          <div className="h-28 bg-slate-100 dark:bg-[#102843] rounded" />
          <div className="h-28 bg-slate-100 dark:bg-[#102843] rounded" />
        </div>
      </div>
    );
  }

  const findings = caseData?.evaluation.findings ?? [];
  const displayedFindings = onlyTriggered
    ? findings.filter(
        (f) => f.status === 'APONTAMENTO' || f.status === 'INCONSISTENCIA' || f.status === 'ORCAMENTO_EXCEDIDO'
      )
    : findings;

  const triggeredCount = findings.filter(
    (f) => f.status === 'APONTAMENTO' || f.status === 'INCONSISTENCIA'
  ).length;

  return (
    <div data-testid="forensic-investigation-panel" className="space-y-6">
      {/* Top Status & Action Header */}
      <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span className="font-mono font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                Fatos v{caseData?.factSet.version ?? 1}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">{caseData?.evaluation.engineVersion ?? 'investigation-engine-2026.11'}</span>
              <span aria-hidden="true">·</span>
              {caseData?.chainVerification.valid &&
              caseData.chainVerification.factsDigestMatchesLedger !== false ? (
                <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium">
                  <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                  Cadeia SHA-256 íntegra ({caseData.chainVerification.eventCount} evento
                  {caseData.chainVerification.eventCount === 1 ? '' : 's'})
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-400 font-semibold">
                  <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                  {caseData?.chainVerification.factsDigestMatchesLedger === false
                    ? 'Divergência entre fatos armazenados e livro-razão SHA-256'
                    : `Falha na cadeia no seq #${caseData?.chainVerification.brokenAtSeq}`}
                </span>
              )}
            </div>
            <h2 className="text-base font-bold text-[#0B2540] dark:text-[#FAF9F5]">
              Investigação Forense Documental · {contract.supplier.legalName} ({formatCnpj(contract.supplier.cnpj)})
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Todos os apontamentos orientam diligências humanas com base em documentos, regras
              determinísticas e revisão vinculada à versão dos fatos; nunca declaram fraude ou
              ilegalidade automaticamente.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              data-testid="inv-sync-pncp-btn"
              onClick={handlePncpSync}
              disabled={pncpBusy}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-[#0B2540] dark:text-slate-100 border border-slate-300 dark:border-[#1D3A57] hover:bg-[#E8F1F6] dark:hover:bg-[#102843] rounded-md transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${pncpBusy ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>{pncpBusy ? 'Sincronizando PNCP…' : 'Sincronizar Histórico PNCP'}</span>
            </button>
            <button
              type="button"
              data-testid="inv-export-package-btn"
              onClick={handleExportPackage}
              disabled={exportBusy || !caseData}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-[#0B2540] hover:bg-[#102843] dark:bg-[#D95B35] dark:hover:bg-[#c04c29] rounded-md transition-colors disabled:opacity-50"
            >
              <FileJson className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{exportBusy ? 'Exportando…' : 'Exportar Pacote Verificável'}</span>
            </button>
          </div>
        </div>

        {/* KPI Summary Strip */}
        {caseData && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5 pt-4 border-t border-slate-200 dark:border-[#1D3A57]">
            <div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Trilhas com apontamento</div>
              <div className="mt-0.5 text-lg font-bold font-mono tabular-nums text-[#0B2540] dark:text-[#FAF9F5]">
                {triggeredCount} / {findings.length}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Contratos observados</div>
              <div className="mt-0.5 text-lg font-bold font-mono tabular-nums text-[#0B2540] dark:text-[#FAF9F5]">
                {caseData.evaluation.observedMetrics.totalObservedContracts}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Evidências privadas</div>
              <div className="mt-0.5 text-lg font-bold font-mono tabular-nums text-[#0B2540] dark:text-[#FAF9F5]">
                {caseData.privateEvidence.length}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Identidades não resolvidas</div>
              <div className="mt-0.5 text-lg font-bold font-mono tabular-nums text-amber-700 dark:text-amber-400">
                {caseData.evaluation.unresolvedIdentitiesCount}
              </div>
            </div>
          </div>
        )}

        {bannerMessage && (
          <div
            role="status"
            className="mt-4 px-3.5 py-2.5 rounded-md bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 text-xs text-emerald-800 dark:text-emerald-300 flex items-center gap-2"
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{bannerMessage}</span>
          </div>
        )}

        {caseData &&
          (!caseData.chainVerification.valid ||
            caseData.chainVerification.factsDigestMatchesLedger === false) && (
            <div
              role="alert"
              data-testid="inv-ledger-tamper-alert"
              className="mt-4 px-3.5 py-2.5 rounded-md bg-red-50 dark:bg-red-950/50 border border-red-300 dark:border-red-700 text-xs text-red-800 dark:text-red-300 flex items-start gap-2"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
              <span>
                <strong>Alerta crítico de integridade:</strong>{' '}
                {caseData.chainVerification.integrityReason ??
                  'Os fatos armazenados no banco não correspondem ao livro-razão append-only SHA-256.'}
              </span>
            </div>
          )}

        {error && (
          <div
            role="alert"
            className="mt-4 px-3.5 py-2.5 rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/60 text-xs text-red-800 dark:text-red-300 flex items-center gap-2"
          >
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
      </section>

      {caseData && (
        <>
          {/* Chronology & Observed Metrics Side by Side */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Chronology Table */}
            <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-[#D95B35]" aria-hidden="true" />
                  <h3 className="text-sm font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                    Cronologia Empresarial vs. Assinatura (Δd)
                  </h3>
                </div>
                <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                  Assinatura: {formatDateBR(contract.signatureDate)}
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Fórmula: <span className="font-mono">Δd = d_assinatura − d_evento_cadastral</span>.
                Constituição, inscrição no CNPJ e início de atividade são mantidos separados.
              </p>

              {caseData.evaluation.chronology.length === 0 ? (
                <div className="p-4 rounded-md bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] text-xs text-slate-500 dark:text-slate-400">
                  Nenhuma data empresarial documentada ou extraída até o momento. Execute a consulta
                  cadastral (BrasilAPI) ou registre datas no conjunto de fatos versionado.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-[#1D3A57] text-slate-500 dark:text-slate-400">
                        <th className="py-2 pr-3 font-medium">Evento cadastral</th>
                        <th className="py-2 px-2 font-medium">Data</th>
                        <th className="py-2 px-2 font-medium text-right">Δd</th>
                        <th className="py-2 pl-2 font-medium">Faixa</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-[#1D3A57]">
                      {caseData.evaluation.chronology.map((item, idx) => {
                        const band = BAND_META[item.band] ?? {
                          label: item.band,
                          className: 'text-slate-700 dark:text-slate-200',
                        };
                        return (
                          <tr key={`${item.eventType}-${item.eventDate}-${idx}`}>
                            <td className="py-2 pr-3">
                              <div className="font-medium text-slate-800 dark:text-slate-100">
                                {EVENT_TYPE_LABELS[item.eventType]}
                              </div>
                              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                                {item.sourceLabel}
                              </div>
                            </td>
                            <td className="py-2 px-2 font-mono tabular-nums text-slate-700 dark:text-slate-200 whitespace-nowrap">
                              {formatDateBR(item.eventDate)}
                            </td>
                            <td className="py-2 px-2 font-mono tabular-nums text-right font-semibold text-[#0B2540] dark:text-[#FAF9F5] whitespace-nowrap">
                              {item.deltaDays} d
                            </td>
                            <td className={`py-2 pl-2 whitespace-nowrap ${band.className}`}>
                              {band.label}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Observed Contractual History Card */}
            <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Scale className="w-4 h-4 text-[#D95B35]" aria-hidden="true" />
                  <h3 className="text-sm font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                    Histórico Contratual Observado
                  </h3>
                </div>
                <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                  {caseData.observedHistory
                    ? `PNCP: ${caseData.observedHistory.pncpStatus}`
                    : 'Sem sincronização PNCP'}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                <div className="p-2.5 rounded-md bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57]">
                  <div className="text-slate-500 dark:text-slate-400">Total observado</div>
                  <div className="mt-0.5 text-base font-bold font-mono tabular-nums text-[#0B2540] dark:text-[#FAF9F5]">
                    {caseData.evaluation.observedMetrics.totalObservedContracts}
                  </div>
                </div>
                <div className="p-2.5 rounded-md bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57]">
                  <div className="text-slate-500 dark:text-slate-400">Órgãos distintos</div>
                  <div className="mt-0.5 text-base font-bold font-mono tabular-nums text-[#0B2540] dark:text-[#FAF9F5]">
                    {caseData.evaluation.observedMetrics.distinctBuyersCount}
                  </div>
                </div>
                <div className="p-2.5 rounded-md bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57]">
                  <div className="text-slate-500 dark:text-slate-400">Participação do órgão</div>
                  <div className="mt-0.5 text-base font-bold font-mono tabular-nums text-[#0B2540] dark:text-[#FAF9F5]">
                    {caseData.evaluation.observedMetrics.concentrationComputable &&
                    caseData.evaluation.observedMetrics.investigatedBuyerSharePct !== null
                      ? `${caseData.evaluation.observedMetrics.investigatedBuyerSharePct.toFixed(1)}%`
                      : 'Interrompido'}
                  </div>
                </div>
              </div>

              {caseData.evaluation.observedMetrics.totalObservedContractualValue !== null && (
                <div className="text-xs text-slate-600 dark:text-slate-300">
                  Valor total deduplicado observado:{' '}
                  <span className="font-mono font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                    {formatCurrencyBRL(
                      caseData.evaluation.observedMetrics.totalObservedContractualValue
                    )}
                  </span>
                </div>
              )}

              {caseData.evaluation.observedMetrics.concentrationHaltReason && (
                <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 rounded-md p-2.5">
                  {caseData.evaluation.observedMetrics.concentrationHaltReason}
                </p>
              )}

              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Cobertura: {caseData.evaluation.observedMetrics.sourcesCoverageNote}
              </p>
            </section>
          </div>

          {/* 8 Deterministic Forensic Trails */}
          <section className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h3 className="text-base font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                  Trilhas Determinísticas de Investigação ({displayedFindings.length} de {findings.length})
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Cada trilha registra fatos usados, regra aplicada, limitações e revisão humana
                  vinculada ao digest de entrada.
                </p>
              </div>
              <label className="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={onlyTriggered}
                  onChange={(e) => setOnlyTriggered(e.target.checked)}
                  className="rounded border-slate-300 dark:border-[#1D3A57]"
                />
                <span>Exibir apenas apontamentos/inconsistências</span>
              </label>
            </div>

            <div className="space-y-3">
              {displayedFindings.map((finding) => {
                const statusMeta = getFindingStatusMeta(finding.status);
                const isReviewOpen = reviewingFindingId === finding.findingId;
                return (
                  <article
                    key={finding.findingId}
                    data-testid={`trail-card-${finding.trailCode}`}
                    className={`bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] border-l-4 ${statusMeta.borderClass} rounded-lg p-5 space-y-3`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                      <div className="space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
                          <span className="text-slate-500 dark:text-slate-400">
                            {finding.trailCode}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className={statusMeta.textClass}>{statusMeta.label}</span>
                          <span aria-hidden="true">·</span>
                          <span className="text-slate-500 dark:text-slate-400">
                            Severidade {finding.severity}
                          </span>
                        </div>
                        <h4 className="text-sm font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                          {finding.title}
                        </h4>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                          digest {finding.inputsDigest.slice(0, 10)}…
                        </span>
                        <button
                          type="button"
                          data-testid={`review-btn-${finding.trailCode}`}
                          onClick={() => {
                            if (isReviewOpen) {
                              setReviewingFindingId(null);
                            } else {
                              setReviewingFindingId(finding.findingId);
                              setReviewAction('confirm');
                              setReviewRationale('');
                            }
                          }}
                          className="px-2.5 py-1 text-xs font-medium text-[#0B2540] dark:text-slate-200 border border-slate-300 dark:border-[#1D3A57] hover:bg-[#E8F1F6] dark:hover:bg-[#102843] rounded-md transition-colors"
                        >
                          {isReviewOpen ? 'Fechar revisão' : 'Revisar'}
                        </button>
                      </div>
                    </div>

                    <p className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed">
                      {finding.summary}
                    </p>

                    {/* Metrics Strip */}
                    {Object.keys(finding.metrics).length > 0 && (
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-[#061321] border border-slate-200/80 dark:border-[#1D3A57] rounded px-3 py-2">
                        {Object.entries(finding.metrics).map(([k, v]) => (
                          <span key={k}>
                            <span className="text-slate-400">{k}:</span>{' '}
                            <span className="text-slate-800 dark:text-slate-100">
                              {v === null ? '—' : String(v)}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Limitations & Diligences */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs pt-1">
                      <div>
                        <div className="font-semibold text-slate-700 dark:text-slate-200 mb-1">
                          Limitações e salvaguardas
                        </div>
                        <ul className="list-disc pl-4 space-y-0.5 text-slate-600 dark:text-slate-400">
                          {finding.limitations.map((lim, i) => (
                            <li key={i}>{lim}</li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <div className="font-semibold text-slate-700 dark:text-slate-200 mb-1">
                          Diligências sugeridas
                        </div>
                        <ul className="list-disc pl-4 space-y-0.5 text-slate-600 dark:text-slate-400">
                          {finding.suggestedDiligences.map((dil, i) => (
                            <li key={i}>{dil}</li>
                          ))}
                        </ul>
                      </div>
                    </div>

                    {finding.evidenceRefs.length > 0 && (
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">
                          Referências documentais:
                        </span>{' '}
                        <span className="font-mono">{finding.evidenceRefs.join(', ')}</span>
                      </div>
                    )}

                    {/* Active Review Display */}
                    {finding.activeReview && (
                      <div
                        data-testid={`active-review-${finding.trailCode}`}
                        className={`p-3 rounded-md border text-xs space-y-1 ${
                          finding.reviewIsCurrent
                            ? 'bg-emerald-50/70 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/60'
                            : 'bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-700/60'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold text-slate-900 dark:text-[#FAF9F5]">
                            {getReviewActionLabel(finding.activeReview.action)} ·{' '}
                            {finding.activeReview.actorName} ({finding.activeReview.actorRole})
                          </span>
                          <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                            Fatos v{finding.activeReview.factsVersion} ·{' '}
                            {new Date(finding.activeReview.createdAt).toLocaleString('pt-BR')}
                          </span>
                        </div>
                        <p className="text-slate-700 dark:text-slate-200">
                          {finding.activeReview.rationale}
                        </p>
                        {!finding.reviewIsCurrent && finding.reviewStaleReason && (
                          <div className="text-amber-800 dark:text-amber-300 font-semibold pt-1">
                            Revisão desatualizada: {finding.reviewStaleReason}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Inline Review Form */}
                    {isReviewOpen && (
                      <div className="p-3.5 rounded-md bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] space-y-3">
                        <div className="text-xs font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                          Registrar revisão humana (vinculada a Fatos v{finding.factsVersion} e
                          digest {finding.inputsDigest.slice(0, 12)}…)
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <select
                            aria-label="Decisão da revisão"
                            value={reviewAction}
                            onChange={(e) =>
                              setReviewAction(e.target.value as InvestigationReviewAction)
                            }
                            className="px-2.5 py-2 text-xs rounded-md bg-white dark:bg-[#0B1D31] border border-slate-300 dark:border-[#1D3A57] text-slate-800 dark:text-slate-100"
                          >
                            <option value="confirm">Confirmar apontamento</option>
                            <option value="dismiss">Descartar com justificativa</option>
                            <option value="restore">Restaurar apontamento</option>
                          </select>
                          <input
                            type="text"
                            value={reviewRationale}
                            onChange={(e) => setReviewRationale(e.target.value)}
                            placeholder="Justificativa técnica obrigatória (mín. 5 caracteres)…"
                            className="sm:col-span-2 px-3 py-2 text-xs rounded-md bg-white dark:bg-[#0B1D31] border border-slate-300 dark:border-[#1D3A57] text-slate-800 dark:text-slate-100"
                          />
                        </div>
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setReviewingFindingId(null)}
                            className="px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:underline"
                          >
                            Cancelar
                          </button>
                          <button
                            type="button"
                            data-testid={`submit-review-${finding.trailCode}`}
                            disabled={reviewBusy || reviewRationale.trim().length < 5}
                            onClick={() => handleSubmitReview(finding)}
                            className="px-3.5 py-1.5 text-xs font-semibold text-white bg-[#0B2540] hover:bg-[#102843] dark:bg-[#D95B35] dark:hover:bg-[#c04c29] rounded-md disabled:opacity-50"
                          >
                            {reviewBusy ? 'Salvando…' : 'Gravar Revisão'}
                          </button>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>

          {/* Operational Grid: Cadastral Query + Private Evidence */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* BrasilAPI Minimized Cadastral Query */}
            <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-5 space-y-4">
              <div className="flex items-center gap-2">
                <Building2 className="w-4 h-4 text-[#D95B35]" aria-hidden="true" />
                <h3 className="text-sm font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                  Consulta Cadastral / QSA Minimizada (BrasilAPI)
                </h3>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Armazena extrato derivado minimizado rotulado como{' '}
                <span className="font-mono">provedor_intermediario</span>. Integrantes do QSA são
                sempre mantidos como <span className="font-mono">identityStatus: unresolved</span>{' '}
                para impedir fusão automática de homônimos.
              </p>

              <form onSubmit={handleCadastralQuery} className="space-y-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Finalidade da consulta *
                  </label>
                  <input
                    type="text"
                    required
                    value={cadPurpose}
                    onChange={(e) => setCadPurpose(e.target.value)}
                    className="w-full px-3 py-2 text-xs rounded-md bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Base legal *
                  </label>
                  <input
                    type="text"
                    required
                    value={cadLegalBasis}
                    onChange={(e) => setCadLegalBasis(e.target.value)}
                    className="w-full px-3 py-2 text-xs rounded-md bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Justificativa operacional *
                  </label>
                  <textarea
                    rows={2}
                    required
                    value={cadJustification}
                    onChange={(e) => setCadJustification(e.target.value)}
                    className="w-full px-3 py-2 text-xs rounded-md bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] text-slate-900 dark:text-slate-100"
                  />
                </div>
                <button
                  type="submit"
                  data-testid="inv-cadastral-query-btn"
                  disabled={cadBusy}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#0B2540] hover:bg-[#102843] dark:bg-[#D95B35] dark:hover:bg-[#c04c29] rounded-md disabled:opacity-50"
                >
                  <Search className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{cadBusy ? 'Consultando BrasilAPI…' : 'Registrar Consulta Cadastral'}</span>
                </button>
              </form>

              {caseData.cadastralExtracts.length > 0 && (
                <div className="pt-3 border-t border-slate-200 dark:border-[#1D3A57] space-y-2">
                  <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                    Extratos registrados ({caseData.cadastralExtracts.length})
                  </div>
                  {caseData.cadastralExtracts.map((ext) => (
                    <div
                      key={ext.id}
                      className="p-3 rounded-md bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] text-xs space-y-1"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-1">
                        <span className="font-mono font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                          {ext.id} · {ext.sourceProvider} ({ext.sourceType})
                        </span>
                        <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                          {new Date(ext.acquiredAt).toLocaleString('pt-BR')}
                        </span>
                      </div>
                      <div className="text-slate-600 dark:text-slate-300">
                        Início atividade: <span className="font-mono">{ext.startActivityDate || '—'}</span>{' '}
                        · Situação: {ext.registrationStatus || '—'} · QSA: {ext.qsa.length} (não
                        resolvido)
                      </div>
                      <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                        SHA-256: {ext.extractSha256.slice(0, 20)}…
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Isolated Private Evidence Store */}
            <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-5 space-y-4">
              <div className="flex items-center gap-2">
                <FileLock2 className="w-4 h-4 text-[#D95B35]" aria-hidden="true" />
                <h3 className="text-sm font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                  Evidências Privadas (Armazenamento Isolado · máx. 1 MiB)
                </h3>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Arquivos privados (contratos sociais, certidões, atas, ofícios) ficam em diretório
                privado separado e nunca são servidos em rotas públicas de documentos.
              </p>

              <form onSubmit={handleEvidenceUpload} className="space-y-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Arquivo original (PDF, PNG, JPG, TXT, CSV, JSON — até 1 MiB) *
                  </label>
                  <input
                    type="file"
                    data-testid="inv-evidence-file-input"
                    onChange={(e) => setEvFile(e.target.files?.[0] ?? null)}
                    className="block w-full text-xs text-slate-700 dark:text-slate-200 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-slate-300 dark:file:border-[#1D3A57] file:text-xs file:font-semibold file:bg-slate-50 dark:file:bg-[#102843] file:text-[#0B2540] dark:file:text-slate-100"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">
                      Origem documental *
                    </label>
                    <input
                      type="text"
                      required
                      data-testid="inv-evidence-source-input"
                      placeholder="Ex.: JUCEB / Cartório / Diário Oficial"
                      value={evSourceLabel}
                      onChange={(e) => setEvSourceLabel(e.target.value)}
                      className="w-full px-3 py-2 text-xs rounded-md bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">
                      Data de obtenção
                    </label>
                    <input
                      type="date"
                      value={evAcquiredAt}
                      onChange={(e) => setEvAcquiredAt(e.target.value)}
                      className="w-full px-3 py-2 text-xs rounded-md bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] text-slate-900 dark:text-slate-100"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Descrição probatória *
                  </label>
                  <input
                    type="text"
                    required
                    data-testid="inv-evidence-desc-input"
                    placeholder="Ex.: Contrato social arquivado comprovando alteração societária em 10/01/2025"
                    value={evDescription}
                    onChange={(e) => setEvDescription(e.target.value)}
                    className="w-full px-3 py-2 text-xs rounded-md bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] text-slate-900 dark:text-slate-100"
                  />
                </div>
                <button
                  type="submit"
                  data-testid="inv-evidence-upload-btn"
                  disabled={evBusy || !evFile}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#0B2540] hover:bg-[#102843] dark:bg-[#D95B35] dark:hover:bg-[#c04c29] rounded-md disabled:opacity-50"
                >
                  <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{evBusy ? 'Armazenando…' : 'Anexar Evidência Privada'}</span>
                </button>
              </form>

              {caseData.privateEvidence.length > 0 && (
                <div className="pt-3 border-t border-slate-200 dark:border-[#1D3A57] space-y-2">
                  <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                    Acervo privado deste caso ({caseData.privateEvidence.length})
                  </div>
                  {caseData.privateEvidence.map((ev) => (
                    <div
                      key={ev.id}
                      data-testid={`private-evidence-${ev.id}`}
                      className="p-3 rounded-md bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] flex items-start justify-between gap-3 text-xs"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="font-semibold text-[#0B2540] dark:text-[#FAF9F5] truncate">
                          {ev.filename}
                        </div>
                        <div className="text-slate-600 dark:text-slate-300">
                          {ev.sourceLabel} · {ev.description}
                        </div>
                        <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 break-all">
                          {ev.exportFilename} ({formatBytes(ev.sizeBytes)})
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={downloadingEvidenceId === ev.id}
                        onClick={() => handleEvidenceDownload(ev.id, ev.exportFilename)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[#0B2540] dark:text-slate-100 border border-slate-300 dark:border-[#1D3A57] hover:bg-[#E8F1F6] dark:hover:bg-[#102843] rounded-md shrink-0 disabled:opacity-50"
                      >
                        <Download className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>{downloadingEvidenceId === ev.id ? 'Baixando…' : 'Baixar'}</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          {/* Versioned Fact Set JSON Editor */}
          <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-5 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                  Conjunto Versionado de Fatos Documentados (v{caseData.factSet.version})
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Controle de concorrência otimista ativo: gravações exigem correspondência exata com
                  a versão atual (HTTP 409 em caso de conflito). Alterações reavaliam imediatamente
                  as 8 trilhas e marcam revisões anteriores como desatualizadas quando os insumos
                  mudam.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleFormatJson}
                  className="px-3 py-1.5 text-xs font-medium text-[#0B2540] dark:text-slate-200 border border-slate-300 dark:border-[#1D3A57] hover:bg-[#E8F1F6] dark:hover:bg-[#102843] rounded-md"
                >
                  Formatar JSON
                </button>
                <button
                  type="button"
                  data-testid="inv-save-facts-btn"
                  disabled={factsBusy}
                  onClick={handleSaveFacts}
                  className="px-3.5 py-1.5 text-xs font-semibold text-white bg-[#0B2540] hover:bg-[#102843] dark:bg-[#D95B35] dark:hover:bg-[#c04c29] rounded-md disabled:opacity-50"
                >
                  {factsBusy
                    ? 'Salvando…'
                    : `Salvar Fatos (v${caseData.factSet.version} → v${caseData.factSet.version + 1})`}
                </button>
              </div>
            </div>

            {factsError && (
              <div
                role="alert"
                className="p-3 rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/60 text-xs text-red-800 dark:text-red-300 flex flex-wrap items-center justify-between gap-2"
              >
                <span>{factsError}</span>
                {versionConflict && (
                  <button
                    type="button"
                    onClick={() => void loadCase()}
                    className="px-2.5 py-1 text-xs font-semibold text-white bg-red-700 hover:bg-red-800 rounded"
                  >
                    Recarregar versão v{versionConflict.currentVersion}
                  </button>
                )}
              </div>
            )}

            <textarea
              data-testid="inv-facts-json-editor"
              aria-label="Editor JSON do conjunto de fatos documentados"
              rows={12}
              value={factsDraftJson}
              onChange={(e) => setFactsDraftJson(e.target.value)}
              spellCheck={false}
              className="w-full font-mono text-xs p-3.5 rounded-md bg-slate-50 dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] text-slate-900 dark:text-slate-100 leading-relaxed"
            />
          </section>

          {/* Append-Only Event Ledger + Offline Verifier Instructions */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <section className="lg:col-span-2 bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <History className="w-4 h-4 text-[#D95B35]" aria-hidden="true" />
                  <h3 className="text-sm font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                    Livro-Razão Append-Only (Cadeia SHA-256)
                  </h3>
                </div>
                <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                  {caseData.events.length} registro(s) imutável(is)
                </span>
              </div>

              <div className="overflow-x-auto max-h-72 overflow-y-auto">
                <table className="w-full text-xs text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1D3A57] text-slate-500 dark:text-slate-400">
                      <th className="py-1.5 pr-2 font-medium">#</th>
                      <th className="py-1.5 px-2 font-medium">Evento</th>
                      <th className="py-1.5 px-2 font-medium">Ator</th>
                      <th className="py-1.5 px-2 font-medium">Fatos</th>
                      <th className="py-1.5 pl-2 font-medium">Hash SHA-256</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-[#1D3A57]">
                    {caseData.events.map((ev) => (
                      <tr key={ev.id}>
                        <td className="py-2 pr-2 font-mono text-slate-500 dark:text-slate-400">
                          {ev.seq}
                        </td>
                        <td className="py-2 px-2">
                          <div className="font-mono font-medium text-[#0B2540] dark:text-slate-100">
                            {ev.eventType}
                          </div>
                          <div className="text-[10px] text-slate-500 dark:text-slate-400">
                            {new Date(ev.createdAt).toLocaleString('pt-BR')}
                          </div>
                        </td>
                        <td className="py-2 px-2 text-slate-700 dark:text-slate-200">
                          {ev.actorName}{' '}
                          <span className="font-mono text-[10px] text-slate-400">
                            ({ev.actorRole})
                          </span>
                        </td>
                        <td className="py-2 px-2 font-mono text-slate-600 dark:text-slate-300">
                          v{ev.factsVersion}
                        </td>
                        <td className="py-2 pl-2 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                          {ev.eventHash.slice(0, 14)}…
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-5 space-y-3">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-[#D95B35]" aria-hidden="true" />
                <h3 className="text-sm font-bold text-[#0B2540] dark:text-[#FAF9F5]">
                  Verificação Offline Independente
                </h3>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                O pacote exportado pode ser auditado sem acesso à rede e sem conexão ao servidor:
              </p>
              <pre className="p-3 rounded-md bg-slate-900 text-slate-100 text-[11px] font-mono whitespace-pre-wrap break-all leading-relaxed">
                npx tsx scripts/verify-investigation.ts pacote.json [diretorio-originais]
              </pre>
              <ul className="text-[11px] text-slate-600 dark:text-slate-400 space-y-1">
                <li>
                  <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-400">
                    exit 0
                  </span>{' '}
                  — Pacote, cadeia de eventos, reprodução e originais íntegros.
                </li>
                <li>
                  <span className="font-mono font-semibold text-red-700 dark:text-red-400">
                    exit 1
                  </span>{' '}
                  — Adulteração, hash inválido ou divergência de reprodução.
                </li>
                <li>
                  <span className="font-mono font-semibold text-amber-700 dark:text-amber-400">
                    exit 2
                  </span>{' '}
                  — Verificação incompleta (originais ausentes ou versão do motor distinta).
                </li>
              </ul>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

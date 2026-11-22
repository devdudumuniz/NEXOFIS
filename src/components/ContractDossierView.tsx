import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  BookmarkCheck,
  Check,
  Download,
  ExternalLink,
  FileCode2,
  FileDown,
  FileJson,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import type {
  EvaluatedContract,
  FindingReviewRecord,
  FindingState,
  RiskIndicator,
  SavedDossierSnapshot,
} from '../types/audit';
import {
  checkLiveSupplierCnpj,
  fetchFindingReviews,
  saveDossier,
  submitFindingReview,
} from '../lib/api';
import {
  formatBytes,
  formatCnpj,
  formatCurrencyBRL,
  formatDateBR,
  formatPercentageBR,
} from '../lib/formatters';
import {
  buildDossierJsonFilename,
  buildStructuredDossierJson,
} from '../lib/dossierJsonExporter';
import { buildAuditDossierMarkdown, mapContractToOCDS } from '../lib/ocdsMapper';
import { downloadConsolidatedAuditReportPdf } from '../lib/pdfReportGenerator';
import { DossierRiskCharts } from './DossierRiskCharts';
import { getRiskToneClass, SeverityText } from './RiskText';
import { EntityGraphTab } from './EntityGraphTab';

type DossierTab =
  | 'overview'
  | 'benchmark'
  | 'graph'
  | 'supplier'
  | 'financials'
  | 'sources_docs';

interface ContractDossierViewProps {
  contract: EvaluatedContract;
  onBack: () => void;
  onDossierSaved: () => void;
  onSelectContract?: (contract: EvaluatedContract) => void;
  archivedSnapshot?: SavedDossierSnapshot | null;
  onOpenCurrentContract?: () => void;
}

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function getFindingStateMeta(state: FindingState): { label: string; className: string } {
  switch (state) {
    case 'CONFIRMED_DATA':
      return {
        label: 'CONFIRMED_DATA · Dado oficial',
        className: 'text-red-700 dark:text-red-400 font-semibold',
      };
    case 'OBSERVATION':
      return {
        label: 'OBSERVATION · Sinal técnico',
        className: 'text-amber-700 dark:text-amber-400 font-semibold',
      };
    case 'INSUFFICIENT_EVIDENCE':
      return {
        label: 'INSUFFICIENT_EVIDENCE',
        className: 'text-slate-600 dark:text-slate-400 font-medium',
      };
    case 'NOT_VERIFIABLE':
      return {
        label: 'NOT_VERIFIABLE · Não verificável',
        className: 'text-slate-600 dark:text-slate-400 font-medium',
      };
    case 'SOURCE_UNAVAILABLE':
      return {
        label: 'SOURCE_UNAVAILABLE',
        className: 'text-slate-500 dark:text-slate-400 font-medium',
      };
    case 'NOT_APPLICABLE':
      return {
        label: 'NOT_APPLICABLE · Não aplicável',
        className: 'text-slate-500 dark:text-slate-400 font-medium',
      };
    case 'DISMISSED':
      return {
        label: 'DISMISSED · Descartado pelo auditor',
        className: 'text-slate-500 dark:text-slate-400 line-through',
      };
  }
}

function getChronologicalOrderLabel(
  status: EvaluatedContract['assessment']['executionChain']['chronologicalOrderStatus']
): { text: string; className: string } {
  switch (status) {
    case 'valid_sequence':
      return {
        text: 'Sequência regular (art. 141)',
        className: 'text-emerald-700 dark:text-emerald-400 font-medium',
      };
    case 'justified_exception':
      return {
        text: 'Exceção com justificativa publicada',
        className: 'text-amber-700 dark:text-amber-400 font-medium',
      };
    case 'unexplained_break':
      return {
        text: 'Quebra sem justificativa publicada',
        className: 'text-red-700 dark:text-red-400 font-semibold',
      };
    default:
      return {
        text: 'Não verificável (fila não comprovada)',
        className: 'text-slate-500 dark:text-slate-400',
      };
  }
}

export function ContractDossierView({
  contract,
  onBack,
  onDossierSaved,
  onSelectContract,
  archivedSnapshot,
  onOpenCurrentContract,
}: ContractDossierViewProps) {
  const { assessment } = contract;
  const isSnapshotReadOnly = Boolean(archivedSnapshot);

  const [activeTab, setActiveTab] = useState<DossierTab>('overview');
  const [selectedIndicatorCode, setSelectedIndicatorCode] = useState<string | null>(
    assessment.indicators[0]?.code ?? null
  );

  // Persisted append-only auditor review log
  const [reviewHistory, setReviewHistory] = useState<FindingReviewRecord[]>(
    archivedSnapshot?.snapshotReviews ?? contract.reviews ?? []
  );
  const [reviewsLoadError, setReviewsLoadError] = useState<string | null>(null);
  const [loadingReviews, setLoadingReviews] = useState(false);

  const [dismissingCode, setDismissingCode] = useState<string | null>(null);
  const [dismissRationaleInput, setDismissRationaleInput] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const riskChartsRef = useRef<HTMLDivElement | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);

  // Save dossier state
  const [showSaveBox, setShowSaveBox] = useState(false);
  const [analystNote, setAnalystNote] = useState(archivedSnapshot?.analystNote ?? '');
  const [savingDossier, setSavingDossier] = useState(false);
  const [savedFeedback, setSavedFeedback] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Live CNPJ enrichment state (intermediary provider)
  const [checkingCnpj, setCheckingCnpj] = useState(false);
  const [liveCnpjResult, setLiveCnpjResult] = useState<{
    enriched: boolean;
    source?: string;
    message?: string;
    legalName?: string;
    registrationStatus?: string;
    primaryCnaeDescription?: string;
  } | null>(null);

  const loadReviews = useCallback(async () => {
    if (isSnapshotReadOnly) return;
    setLoadingReviews(true);
    setReviewsLoadError(null);
    try {
      const rows = await fetchFindingReviews(contract.id);
      setReviewHistory(rows);
    } catch (err) {
      setReviewsLoadError(
        err instanceof Error
          ? err.message
          : 'Não foi possível carregar o histórico persistido de revisões.'
      );
    } finally {
      setLoadingReviews(false);
    }
  }, [contract.id, isSnapshotReadOnly]);

  // Reset local selection and reload persisted finding reviews when switching contracts/snapshots
  useEffect(() => {
    setActiveTab('overview');
    setSelectedIndicatorCode(assessment.indicators[0]?.code ?? null);
    setReviewHistory(archivedSnapshot?.snapshotReviews ?? contract.reviews ?? []);
    setReviewsLoadError(null);
    setDismissingCode(null);
    setDismissRationaleInput('');
    setReviewError(null);
    setLiveCnpjResult(null);
    setSavedFeedback(null);
    setSaveError(null);
    setAnalystNote(archivedSnapshot?.analystNote ?? '');

    if (!isSnapshotReadOnly) {
      void loadReviews();
    }
  }, [contract.id, archivedSnapshot?.id, isSnapshotReadOnly, loadReviews]);

  // Derive active dismissed findings from the append-only review history (last action wins)
  const dismissedFindings: Record<
    string,
    {
      rationale: string;
      dismissedAt: string;
      author: string;
      actorRole?: string;
      findingInputsDigest?: string;
    }
  > = {};
  for (const rev of reviewHistory) {
    if (rev.action === 'dismiss') {
      dismissedFindings[rev.findingId] = {
        rationale: rev.rationale,
        dismissedAt: rev.createdAt,
        author: rev.author,
        actorRole: rev.actorRole,
        findingInputsDigest: rev.findingInputsDigest,
      };
    } else if (rev.action === 'restore') {
      delete dismissedFindings[rev.findingId];
    }
  }

  const selectedIndicator: RiskIndicator | undefined =
    assessment.indicators.find((i) => i.code === selectedIndicatorCode) ??
    assessment.indicators[0];

  const linkedEvidences = selectedIndicator
    ? assessment.evidences.filter((e) => selectedIndicator.evidenceIds.includes(e.id))
    : [];

  // Recompute active risk score if the auditor dismissed any findings
  const dismissedCount = Object.keys(dismissedFindings).length;
  const effectiveScore = Math.min(
    100,
    assessment.indicators.reduce(
      (sum, ind) => (dismissedFindings[ind.findingId] ? sum : sum + ind.weightPoints),
      0
    )
  );
  const displayScore = dismissedCount > 0 ? effectiveScore : assessment.score;
  const displayHeadline =
    dismissedCount > 0
      ? `RISCO ${displayScore}/100 — ajustado após ${dismissedCount} descarte(s) auditado(s)`
      : assessment.headline;

  const handleConfirmDismiss = async (indicator: RiskIndicator) => {
    if (isSnapshotReadOnly) return;
    const rationale = dismissRationaleInput.trim();
    if (rationale.length < 8) {
      setReviewError(
        'Informe uma justificativa técnica detalhada (mínimo de 8 caracteres) para registrar o descarte.'
      );
      return;
    }
    setSubmittingReview(true);
    setReviewError(null);
    try {
      const res = await submitFindingReview(contract.id, indicator.findingId, {
        action: 'dismiss',
        rationale,
      });
      setReviewHistory(res.reviews);
      setDismissingCode(null);
      setDismissRationaleInput('');
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Falha ao persistir descarte.');
    } finally {
      setSubmittingReview(false);
    }
  };

  const handleRestoreFinding = async (indicator: RiskIndicator) => {
    if (isSnapshotReadOnly) return;
    setSubmittingReview(true);
    setReviewError(null);
    try {
      const res = await submitFindingReview(contract.id, indicator.findingId, {
        action: 'restore',
        rationale: 'Reativação manual registrada pelo auditor para nova verificação documental.',
      });
      setReviewHistory(res.reviews);
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Falha ao reativar achado.');
    } finally {
      setSubmittingReview(false);
    }
  };

  const handleExportPdfReport = async () => {
    setExportingPdf(true);
    setSaveError(null);
    try {
      const { filename, embeddedChartsCount } = await downloadConsolidatedAuditReportPdf(contract, {
        analystNote,
        reviews: reviewHistory,
        archivedSnapshot,
        chartContainerEl: riskChartsRef.current,
      });
      setSavedFeedback(
        embeddedChartsCount > 0
          ? `Relatório PDF consolidado gerado com ${embeddedChartsCount} gráfico(s) de risco (${filename}).`
          : `Relatório PDF consolidado gerado e baixado (${filename}).`
      );
    } catch {
      setSaveError('Não foi possível gerar o relatório consolidado em PDF neste momento.');
    } finally {
      setExportingPdf(false);
    }
  };

  const handleExportMarkdown = () => {
    const md = buildAuditDossierMarkdown({ ...contract, reviews: reviewHistory }, analystNote);
    downloadTextFile(
      `dossie-${contract.municipalityIbge}-${contract.contractNumber.replace(/[^a-zA-Z0-9_-]/g, '-')}.md`,
      md,
      'text/markdown;charset=utf-8'
    );
  };

  const handleExportOcds = () => {
    const ocds = mapContractToOCDS(contract);
    downloadTextFile(
      `ocds-${contract.municipalityIbge}-${contract.contractNumber.replace(/[^a-zA-Z0-9_-]/g, '-')}.json`,
      JSON.stringify(ocds, null, 2),
      'application/json;charset=utf-8'
    );
  };

  const handleExportDossierJson = () => {
    try {
      const dossierPackage = buildStructuredDossierJson(contract, {
        analystNote,
        reviews: reviewHistory,
        archivedSnapshot,
      });
      const filename = buildDossierJsonFilename(contract);
      downloadTextFile(
        filename,
        JSON.stringify(dossierPackage, null, 2),
        'application/json;charset=utf-8'
      );
      setSaveError(null);
      setSavedFeedback(
        `Dossiê JSON exportado (${filename}) · SHA-256 ${dossierPackage.integrity.contentSha256.slice(0, 12)}…`
      );
    } catch {
      setSaveError('Não foi possível exportar o dossiê em JSON estruturado neste momento.');
    }
  };

  const handleSaveDossier = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSnapshotReadOnly) return;
    setSavingDossier(true);
    setSavedFeedback(null);
    setSaveError(null);
    try {
      const res = await saveDossier(contract.id, analystNote);
      setSavedFeedback(
        `Dossiê arquivado (${res.dossier.id}) · SHA-256 ${res.dossier.sha256Digest.slice(0, 12)}…`
      );
      setShowSaveBox(false);
      onDossierSaved();
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : 'Não foi possível salvar o dossiê neste momento.'
      );
    } finally {
      setSavingDossier(false);
    }
  };

  const handleLiveCnpjCheck = async () => {
    setCheckingCnpj(true);
    try {
      const res = await checkLiveSupplierCnpj(contract.supplier.cnpj);
      setLiveCnpjResult({
        enriched: res.enriched,
        source: res.source,
        message: res.message,
        legalName: res.data?.legalName,
        registrationStatus: res.data?.registrationStatus,
        primaryCnaeDescription: res.data?.primaryCnaeDescription,
      });
    } catch {
      setLiveCnpjResult({
        enriched: false,
        message: 'Falha ao consultar API externa de CNPJ.',
      });
    } finally {
      setCheckingCnpj(false);
    }
  };

  const { executionChain, appliedLegalRuleset, horizontalBenchmark, priceReferenceCoverage } =
    assessment;
  const chronoLabel = getChronologicalOrderLabel(executionChain.chronologicalOrderStatus);
  const hasFinancialExecution = contract.payments.length > 0;

  return (
    <div className="space-y-6">
      {/* Archived Snapshot Banner (Immutable Read-Only Mode) */}
      {archivedSnapshot && (
        <div
          data-testid="archived-snapshot-banner"
          className="bg-[#E8F1F6] dark:bg-[#102843] border border-[#0B2540]/25 dark:border-[#38BDF8]/30 rounded-lg p-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
        >
          <div className="space-y-1 text-xs">
            <div className="flex items-center gap-2 font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
              <Archive className="w-4 h-4 text-[#D95B35] shrink-0" aria-hidden="true" />
              <span>
                Snapshot Arquivado (Imutável) ·{' '}
                <span className="font-mono">{archivedSnapshot.id}</span>
              </span>
            </div>
            <div className="text-slate-700 dark:text-slate-300 font-mono">
              Arquivado em {formatDateBR(archivedSnapshot.savedAt)} · SHA-256{' '}
              {archivedSnapshot.sha256Digest.slice(0, 20)}…
            </div>
            {archivedSnapshot.analystNote && (
              <div className="text-slate-800 dark:text-slate-200">
                Nota do auditor: {archivedSnapshot.analystNote}
              </div>
            )}
          </div>
          {onOpenCurrentContract && (
            <button
              type="button"
              onClick={onOpenCurrentContract}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#0B2540] hover:bg-[#103256] dark:bg-[#D95B35] dark:hover:bg-[#C24C28] rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              Abrir estado atual do contrato
            </button>
          )}
        </div>
      )}

      {/* Reviews Load Error Banner (Never Silently Swallow) */}
      {reviewsLoadError && (
        <div
          role="alert"
          className="bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 rounded-lg px-4 py-3 text-xs text-amber-950 dark:text-amber-200 flex flex-wrap items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0" />
            <span>
              <strong>Erro ao sincronizar revisões:</strong> {reviewsLoadError} (mantendo último
              estado conhecido em tela).
            </span>
          </div>
          <button
            type="button"
            disabled={loadingReviews}
            onClick={() => void loadReviews()}
            className="px-3 py-1 font-semibold bg-white dark:bg-[#0B1D31] border border-amber-400 dark:border-amber-700 rounded hover:bg-amber-100 dark:hover:bg-amber-900/40"
          >
            {loadingReviews ? 'Tentando...' : 'Tentar novamente'}
          </button>
        </div>
      )}

      {/* Back navigation & exports */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
          Voltar à lista de contratos
        </button>

        <div className="flex flex-wrap items-center gap-2">
          {!isSnapshotReadOnly && (
            <button
              type="button"
              onClick={() => setShowSaveBox((prev) => !prev)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-[#0B1D31] border border-slate-300 dark:border-[#1D3A57] hover:bg-slate-50 dark:hover:bg-[#102843] rounded-md transition-colors whitespace-nowrap"
            >
              <BookmarkCheck className="w-3.5 h-3.5" aria-hidden="true" />
              Salvar Dossiê
            </button>
          )}
          <button
            type="button"
            onClick={handleExportOcds}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-[#0B1D31] border border-slate-300 dark:border-[#1D3A57] hover:bg-slate-50 dark:hover:bg-[#102843] rounded-md transition-colors whitespace-nowrap"
          >
            <FileCode2 className="w-3.5 h-3.5" aria-hidden="true" />
            OCDS JSON
          </button>
          <button
            type="button"
            onClick={handleExportMarkdown}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-[#0B1D31] border border-slate-300 dark:border-[#1D3A57] hover:bg-slate-50 dark:hover:bg-[#102843] rounded-md transition-colors whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            Dossiê (.md)
          </button>
          <button
            type="button"
            data-testid="export-dossier-json-btn"
            onClick={handleExportDossierJson}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#0B2540] dark:text-[#FAF9F5] bg-[#E8F1F6] dark:bg-[#102843] border border-[#0B2540]/20 dark:border-[#1D3A57] hover:bg-[#dce8f0] dark:hover:bg-[#163659] rounded-md transition-colors whitespace-nowrap"
          >
            <FileJson className="w-3.5 h-3.5 text-[#D95B35]" aria-hidden="true" />
            Exportar Dossiê
          </button>
          <button
            type="button"
            data-testid="export-pdf-report-btn"
            disabled={exportingPdf}
            onClick={() => void handleExportPdfReport()}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-[#0B2540] hover:bg-[#103256] dark:bg-[#D95B35] dark:hover:bg-[#C24C28] disabled:opacity-60 rounded-md transition-colors whitespace-nowrap"
          >
            <FileDown className="w-3.5 h-3.5" aria-hidden="true" />
            {exportingPdf ? 'Gerando PDF...' : 'Relatório Consolidado (PDF)'}
          </button>
        </div>
      </div>

      {/* Save Dossier Inline Form */}
      {showSaveBox && !isSnapshotReadOnly && (
        <form
          onSubmit={handleSaveDossier}
          className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-5 space-y-3"
        >
          <div className="flex items-center justify-between">
            <label
              htmlFor="analyst-note"
              className="text-sm font-semibold text-slate-900 dark:text-[#FAF9F5]"
            >
              Nota técnica do auditor para arquivamento do dossiê (snapshot imutável)
            </label>
            <button
              type="button"
              onClick={() => setShowSaveBox(false)}
              className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white"
            >
              Cancelar
            </button>
          </div>
          <textarea
            id="analyst-note"
            rows={2}
            value={analystNote}
            onChange={(e) => setAnalystNote(e.target.value)}
            placeholder="Ex.: Solicitar justificativa de reequilíbrio do 3º aditivo e certidão CEIS junto à secretaria..."
            className="w-full text-sm px-3 py-2 bg-white dark:bg-[#061321] text-slate-900 dark:text-[#FAF9F5] border border-slate-300 dark:border-[#1D3A57] rounded-md focus:outline-none focus:ring-2 focus:ring-[#0B2540] dark:focus:ring-[#D95B35]"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={savingDossier}
              className="px-4 py-2 text-xs font-semibold text-white bg-[#0B2540] hover:bg-[#103256] dark:bg-[#D95B35] dark:hover:bg-[#C24C28] rounded-md disabled:opacity-60"
            >
              {savingDossier ? 'Arquivando...' : 'Confirmar Arquivamento com Digest SHA-256'}
            </button>
          </div>
        </form>
      )}

      {savedFeedback && (
        <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-lg px-4 py-3 text-xs text-emerald-900 dark:text-emerald-200 flex items-center gap-2">
          <Check className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0" aria-hidden="true" />
          <span className="font-medium">{savedFeedback}</span>
        </div>
      )}

      {saveError && (
        <div
          role="alert"
          className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 text-xs text-red-900 dark:text-red-200"
        >
          {saveError}
        </div>
      )}

      {/* Primary Forensic Header Panel */}
      <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-5 pb-5 border-b border-slate-200 dark:border-[#1D3A57]">
          <div className="space-y-2 max-w-3xl">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
              <span className="font-mono font-semibold text-slate-800 dark:text-[#FAF9F5]">
                Contrato {contract.contractNumber}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {contract.municipalityName}/{contract.uf} (IBGE{' '}
                <span className="font-mono tabular-nums">{contract.municipalityIbge || '—'}</span>)
              </span>
              <span aria-hidden="true">·</span>
              <span>{contract.entityName}</span>
            </div>

            <h1
              className={`font-bold text-slate-900 dark:text-[#FAF9F5] leading-snug ${
                contract.object.length > 140 ? 'text-base lg:text-lg' : 'text-xl lg:text-2xl'
              }`}
            >
              {contract.object}
            </h1>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 dark:text-slate-300 pt-0.5">
              <span>
                Controle PNCP:{' '}
                <span className="font-mono text-slate-800 dark:text-slate-200">
                  {contract.pncpControlNumber || 'Não informado'}
                </span>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                Modalidade:{' '}
                <span className="text-slate-800 dark:text-slate-100 font-medium">
                  {contract.modality}
                </span>{' '}
                (
                {contract.biddersCount !== null
                  ? `${contract.biddersCount} participante${contract.biddersCount === 1 ? '' : 's'}`
                  : 'participantes não informados pela fonte'}
                )
              </span>
              <span aria-hidden="true">·</span>
              <span>
                Vigência:{' '}
                {contract.startDate || contract.endDate
                  ? `${formatDateBR(contract.startDate)} a ${formatDateBR(contract.endDate)}`
                  : 'Não informada pela fonte'}
              </span>
            </div>

            {/* Legal Time Travel Metadata Line */}
            <div
              data-testid="legal-ruleset-banner"
              className="text-xs text-slate-600 dark:text-slate-300 pt-1"
            >
              <span className="font-semibold text-slate-800 dark:text-slate-100">
                Norma vigente na assinatura:
              </span>{' '}
              {appliedLegalRuleset.legalBasis} ·{' '}
              <span className="font-mono text-slate-700 dark:text-slate-300">
                {appliedLegalRuleset.ruleId}
              </span>{' '}
              {appliedLegalRuleset.effectiveFrom && (
                <>(vigência a partir de {formatDateBR(appliedLegalRuleset.effectiveFrom)})</>
              )}
            </div>
          </div>

          {/* Risk Headline Block */}
          <div className="lg:text-right shrink-0 space-y-1">
            <div
              data-testid="risk-headline"
              className={`font-mono tabular-nums text-lg font-bold tracking-tight ${getRiskToneClass(
                displayScore,
                assessment.coverageStatus
              )}`}
            >
              {displayHeadline}
            </div>
            <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
              Cobertura: {assessment.coverageStatus ?? 'ADEQUATE'} · Motor {assessment.engineVersion}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xs lg:ml-auto">
              Achados objetivos e reproduzíveis para auditoria humana; não constituem conclusão
              jurídica ou prova automática de fraude.
            </p>
          </div>
        </div>

        {/* Strict Separation: Level 1 Contracted Obligation vs Level 2 Proven Execution */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 pt-5">
          {/* Level 1: Obrigação Contratada */}
          <div className="lg:col-span-6 space-y-3 lg:pr-6 lg:border-r lg:border-slate-200 dark:lg:border-[#1D3A57]">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-800 dark:text-slate-100">
                Nível 1 · Obrigação Contratada
              </span>
              <span className="font-mono text-slate-500 dark:text-slate-400">
                Assinatura {formatDateBR(contract.signatureDate)}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {contract.originalValue === 0 && contract.updatedValue === 0 ? (
                <>
                  <div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">Valor original</div>
                    <div className="mt-1 text-base font-semibold text-amber-800 dark:text-amber-400 whitespace-nowrap">
                      Não divulgado
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      Omitido na origem / ausente no PNCP
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">Valor atualizado</div>
                    <div className="mt-1 text-base font-semibold text-amber-800 dark:text-amber-400 whitespace-nowrap">
                      Não divulgado
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      Requer íntegra contratual
                    </div>
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <div className="text-xs text-slate-500 dark:text-slate-400">Estimativa mensal</div>
                    <div className="mt-1 text-base font-semibold font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap">
                      Não verificável
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      {executionChain.contractDurationMonths > 0
                        ? `Vigência ${executionChain.contractDurationMonths}m · sem valor base`
                        : 'Sem vigência/valor base'}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">Valor original</div>
                    <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-900 dark:text-[#FAF9F5] whitespace-nowrap">
                      {formatCurrencyBRL(contract.originalValue)}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      {contract.amendments.length} aditivo(s)
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">Valor atualizado</div>
                    <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-900 dark:text-[#FAF9F5] whitespace-nowrap">
                      {formatCurrencyBRL(contract.updatedValue)}
                    </div>
                    <div
                      className={`text-[11px] font-mono tabular-nums mt-0.5 ${
                        assessment.variationPct > 25
                          ? 'text-red-700 dark:text-red-400 font-semibold'
                          : assessment.variationPct > 0
                            ? 'text-amber-700 dark:text-amber-400'
                            : 'text-emerald-700 dark:text-emerald-400'
                      }`}
                    >
                      {formatPercentageBR(assessment.variationPct, true)} (teto 25%)
                    </div>
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <div className="text-xs text-slate-500 dark:text-slate-400">Estimativa mensal</div>
                    <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-700 dark:text-slate-200 whitespace-nowrap">
                      {executionChain.estimatedMonthlyContractValue > 0
                        ? formatCurrencyBRL(executionChain.estimatedMonthlyContractValue)
                        : 'Não verificável'}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      {executionChain.contractDurationMonths > 0
                        ? `Média ${executionChain.contractDurationMonths}m · não comprova pago`
                        : 'Vigência não informada'}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Level 2: Execução Financeira Comprovada */}
          <div className="lg:col-span-6 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-slate-800 dark:text-slate-100">
                Nível 2 · Execução Financeira Comprovada
              </span>
              <span className={chronoLabel.className}>{chronoLabel.text}</span>
            </div>

            {!hasFinancialExecution ? (
              <div
                data-testid="execution-not-verified"
                className="p-3.5 rounded-md bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] text-xs text-slate-600 dark:text-slate-300"
              >
                <div className="font-semibold text-slate-800 dark:text-slate-100">
                  Não verificado (sem execução financeira coletada)
                </div>
                <p className="mt-1 text-slate-500 dark:text-slate-400">
                  Não há notas de empenho, liquidações ou ordens bancárias indexadas para este
                  contrato. A ausência de coleta não equivale a pagamento zerado (R$ 0,00).
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">Empenhado</div>
                  <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-900 dark:text-[#FAF9F5] whitespace-nowrap">
                    {formatCurrencyBRL(executionChain.committedTotal)}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    Nota de empenho
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">Liquidado</div>
                  <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-900 dark:text-[#FAF9F5] whitespace-nowrap">
                    {formatCurrencyBRL(executionChain.liquidatedTotal)}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    Atesto / medição
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">Pago comprovado</div>
                  <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-900 dark:text-[#FAF9F5] whitespace-nowrap">
                    {formatCurrencyBRL(executionChain.netPaidTotal ?? executionChain.paidTotal)}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5">
                    {contract.updatedValue > 0
                      ? `${formatPercentageBR(((executionChain.netPaidTotal ?? executionChain.paidTotal) / contract.updatedValue) * 100)} do contrato`
                      : '—'}
                    {(executionChain.reversalsTotal ?? 0) > 0
                      ? ` · estornos ${formatCurrencyBRL(executionChain.reversalsTotal ?? 0)}`
                      : ''}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 pt-3 border-t border-slate-100 dark:border-[#1D3A57] text-[11px] text-slate-500 dark:text-slate-400">
          Separação financeira obrigatória: a estimativa mensal (
          <span className="font-mono">estimated_monthly_contract_value</span>) representa apenas a
          média da obrigação contratada no prazo e nunca substitui empenho, liquidação ou pagamento
          efetivo.
        </div>
      </section>

      {/* Dossier Section Tabs */}
      <div className="border-b border-slate-200 dark:border-[#1D3A57] overflow-x-auto">
        <div
          role="tablist"
          aria-label="Seções do dossiê"
          className="flex items-center gap-6 min-w-max"
        >
          {(
            [
              { id: 'overview', label: `Resumo e Riscos (${assessment.indicators.length})` },
              { id: 'benchmark', label: 'Benchmarking & Execução' },
              { id: 'graph', label: 'Grafo FollowTheMoney' },
              { id: 'supplier', label: 'Fornecedor e Sanções' },
              { id: 'financials', label: 'Itens e Aditivos' },
              {
                id: 'sources_docs',
                label: `Fontes e Documentos (${contract.sourceRecords.length + contract.documents.length})`,
              },
            ] as const
          ).map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                role="tab"
                type="button"
                aria-selected={active}
                onClick={() => setActiveTab(tab.id)}
                className={`pb-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'border-[#0B2540] dark:border-[#D95B35] text-[#0B2540] dark:text-[#FAF9F5]'
                    : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* TAB 1: RESUMO E RISCOS */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          <DossierRiskCharts
            ref={riskChartsRef}
            contract={contract}
            dismissedFindings={dismissedFindings}
          />

          {assessment.indicators.length === 0 ? (
            <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-8 text-center">
              {assessment.coverageStatus === 'INSUFFICIENT' ? (
                <>
                  <p className="text-base font-semibold text-amber-800 dark:text-amber-400">
                    Cobertura documental insuficiente para afirmar conformidade.
                  </p>
                  <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 max-w-xl mx-auto">
                    Este contrato não possui fontes oficiais reconciliadas ou documentos anexados
                    suficientes no repositório. O motor recusa classificá-lo como regular até
                    obtenção de evidências primárias.
                  </p>
                </>
              ) : assessment.coverageStatus === 'PARTIAL' ? (
                <>
                  <p className="text-base font-semibold text-slate-800 dark:text-[#FAF9F5]">
                    Cobertura parcial — sem indícios nos itens verificados.
                  </p>
                  <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 max-w-xl mx-auto">
                    As verificações executadas sobre os metadados disponíveis não acionaram
                    indicadores, porém faltam fontes complementares (execução financeira, planilha
                    de itens ou PDF integral) para auditoria completa.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-base font-semibold text-emerald-800 dark:text-emerald-400">
                    Nenhum indicador de risco acionado para este contrato.
                  </p>
                  <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 max-w-xl mx-auto">
                    Todas as verificações aplicáveis do Motor Forense Próprio (sanções vigentes e no
                    escopo, regras jurídicas temporais, preços, aditivos, CNAE e ordem cronológica)
                    resultaram em conformidade preliminar (cobertura:{' '}
                    {assessment.coverageStatus ?? 'ADEQUATE'}).
                  </p>
                </>
              )}
            </section>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left: Indicators Table */}
              <section className="lg:col-span-5 bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 dark:border-[#1D3A57]">
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-[#FAF9F5]">
                    Achados Acionados (Motor Forense Próprio)
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Regras temporais + Benchmarking Mediana/MAD + Sanções e Execução. Selecione um
                    achado para auditar a trilha probatória.
                  </p>
                </div>

                <div className="divide-y divide-slate-200 dark:divide-[#1D3A57]">
                  {assessment.indicators.map((ind) => {
                    const isSelected = selectedIndicator?.code === ind.code;
                    const isDismissed = Boolean(dismissedFindings[ind.findingId]);
                    const stateMeta = getFindingStateMeta(isDismissed ? 'DISMISSED' : ind.state);
                    return (
                      <button
                        key={ind.findingId}
                        type="button"
                        onClick={() => setSelectedIndicatorCode(ind.code)}
                        aria-pressed={isSelected}
                        className={`w-full text-left px-5 py-3.5 transition-colors flex items-start justify-between gap-4 ${
                          isSelected
                            ? 'bg-[#E8F1F6]/70 dark:bg-[#102843]'
                            : 'hover:bg-slate-50 dark:hover:bg-[#102843]/50'
                        } ${isDismissed ? 'opacity-65' : ''}`}
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="text-sm font-semibold text-slate-900 dark:text-[#FAF9F5]">
                            {ind.title}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            <span className="font-mono">{ind.code}</span> · Nível {ind.evidenceLevel}{' '}
                            · {Math.round(ind.confidence * 100)}% conf.
                          </div>
                          <div className={`text-[11px] font-mono ${stateMeta.className}`}>
                            {stateMeta.label}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <SeverityText severity={ind.severity} />
                          <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 mt-0.5">
                            {isDismissed ? '0 pts' : `+${ind.weightPoints} pts`}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* Right: Reproducible Evidence Trail & Alternative Hypotheses */}
              {selectedIndicator && (
                <section
                  aria-label="Trilha probatória do indicador selecionado"
                  className="lg:col-span-7 bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6 space-y-5"
                >
                  {(() => {
                    const dismissedEntry = dismissedFindings[selectedIndicator.findingId];
                    const isStaleDismissal = Boolean(
                      dismissedEntry?.findingInputsDigest &&
                        selectedIndicator.inputsDigest &&
                        dismissedEntry.findingInputsDigest !== selectedIndicator.inputsDigest
                    );
                    const effectiveState: FindingState = dismissedEntry
                      ? 'DISMISSED'
                      : selectedIndicator.state;
                    const stateMeta = getFindingStateMeta(effectiveState);

                    return (
                      <>
                        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-4 border-b border-slate-200 dark:border-[#1D3A57]">
                          <div className="space-y-1">
                            <div className="text-xs font-mono text-slate-500 dark:text-slate-400">
                              {selectedIndicator.findingId} · {selectedIndicator.code} · regra{' '}
                              {selectedIndicator.ruleVersion}
                            </div>
                            <h3 className="text-lg font-bold text-slate-900 dark:text-[#FAF9F5]">
                              {selectedIndicator.title}
                            </h3>
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                              <span className={`font-mono ${stateMeta.className}`}>
                                {stateMeta.label}
                              </span>
                              <span className="text-slate-400" aria-hidden="true">
                                ·
                              </span>
                              <span className="font-mono text-slate-700 dark:text-slate-300">
                                Evidência Nível {selectedIndicator.evidenceLevel}
                              </span>
                              <span className="text-slate-400" aria-hidden="true">
                                ·
                              </span>
                              <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300">
                                Confiança {Math.round(selectedIndicator.confidence * 100)}%
                              </span>
                              <span className="text-slate-400" aria-hidden="true">
                                ·
                              </span>
                              <span className="text-slate-600 dark:text-slate-400">
                                {selectedIndicator.framework}
                              </span>
                            </div>
                          </div>
                          <div className="shrink-0">
                            <SeverityText severity={selectedIndicator.severity} />
                          </div>
                        </div>

                        {dismissedEntry && (
                          <div className="p-3.5 rounded-md bg-slate-50 dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] text-xs space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-slate-800 dark:text-slate-100">
                                Achado descartado pelo auditor (DISMISSED · persistido em SQLite)
                              </span>
                              {!isSnapshotReadOnly && (
                                <button
                                  type="button"
                                  disabled={submittingReview}
                                  onClick={() => handleRestoreFinding(selectedIndicator)}
                                  className="inline-flex items-center gap-1 text-[#0B2540] dark:text-[#38BDF8] hover:underline font-medium disabled:opacity-50"
                                >
                                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                                  Reativar achado
                                </button>
                              )}
                            </div>
                            <p className="text-slate-600 dark:text-slate-300">
                              Justificativa registrada por{' '}
                              <span className="font-semibold">{dismissedEntry.author}</span>
                              {dismissedEntry.actorRole ? ` (${dismissedEntry.actorRole})` : ''}:{' '}
                              {dismissedEntry.rationale}
                            </p>
                            {isStaleDismissal && (
                              <p className="text-amber-800 dark:text-amber-400 font-medium">
                                Atenção: este descarte foi registrado sobre insumos anteriores do
                                achado — recomenda-se revalidação.
                              </p>
                            )}
                          </div>
                        )}

                        <p className="text-sm text-slate-800 dark:text-slate-200 leading-relaxed">
                          {selectedIndicator.summary}
                        </p>

                        {/* Explicit Epistemic Boundary (not_a_conclusion) */}
                        <div className="p-3.5 rounded-md bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] text-xs text-slate-700 dark:text-slate-300">
                          <span className="font-semibold text-slate-900 dark:text-[#FAF9F5]">
                            Limite epistêmico (não é conclusão):
                          </span>{' '}
                          {selectedIndicator.notAConclusion}
                        </div>

                        <dl className="space-y-3 text-xs">
                          <div className="pb-3 border-b border-slate-100 dark:border-[#1D3A57]">
                            <dt className="font-semibold text-slate-500 dark:text-slate-400">
                              Dados usados
                            </dt>
                            <dd className="text-slate-900 dark:text-slate-100 mt-1">
                              {selectedIndicator.dataUsed}
                            </dd>
                          </div>
                          <div className="pb-3 border-b border-slate-100 dark:border-[#1D3A57]">
                            <dt className="font-semibold text-slate-500 dark:text-slate-400">
                              Fonte primária
                            </dt>
                            <dd className="text-slate-900 dark:text-slate-100 mt-1">
                              {selectedIndicator.source}
                            </dd>
                          </div>
                          <div className="pb-3 border-b border-slate-100 dark:border-[#1D3A57]">
                            <dt className="font-semibold text-slate-500 dark:text-slate-400">
                              Cálculo reproduzível
                            </dt>
                            <dd className="font-mono text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] rounded px-3 py-2 mt-1 break-words">
                              {selectedIndicator.calculation}
                            </dd>
                          </div>
                          {selectedIndicator.legalReference && (
                            <div className="pb-3 border-b border-slate-100 dark:border-[#1D3A57]">
                              <dt className="font-semibold text-slate-500 dark:text-slate-400">
                                Referência normativa ({selectedIndicator.legalRulesetVersion})
                              </dt>
                              <dd className="text-slate-900 dark:text-slate-100 mt-1">
                                {selectedIndicator.legalReference}
                              </dd>
                            </div>
                          )}
                        </dl>

                        {/* Alternative Hypotheses */}
                        {selectedIndicator.alternativeHypotheses.length > 0 && (
                          <div className="space-y-2">
                            <div className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                              Hipóteses alternativas legítimas a verificar em diligência
                            </div>
                            <ul className="list-disc pl-5 space-y-1 text-xs text-slate-700 dark:text-slate-300">
                              {selectedIndicator.alternativeHypotheses.map((hyp) => (
                                <li key={hyp}>{hyp}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {linkedEvidences.length > 0 && (
                          <div className="space-y-2.5 pt-2">
                            <div className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                              Evidência vinculada (Documento · Página · Trecho · SHA-256)
                            </div>
                            {linkedEvidences.map((ev) => (
                              <div
                                key={ev.id}
                                className="bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] rounded-md p-3.5 text-xs space-y-1.5"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2 text-slate-600 dark:text-slate-400">
                                  <span className="font-semibold text-slate-900 dark:text-[#FAF9F5]">
                                    {ev.id} · {ev.documentTitle}
                                  </span>
                                  <span className="font-mono tabular-nums">
                                    Página {ev.pageNumber}
                                  </span>
                                </div>
                                <blockquote className="text-slate-800 dark:text-slate-200 italic">
                                  “{ev.excerpt}”
                                </blockquote>
                                <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                                  Fonte: {ev.sourceSystem} · Regra: {ev.legalRulesetVersion} ·
                                  SHA-256: {ev.sha256.slice(0, 18)}…
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Auditor Dismissal Workflow (Server-Derived Actor, Append-Only) */}
                        {!dismissedEntry && !isSnapshotReadOnly && (
                          <div className="pt-4 border-t border-slate-200 dark:border-[#1D3A57]">
                            {dismissingCode === selectedIndicator.code ? (
                              <div className="space-y-2.5">
                                <div>
                                  <label
                                    htmlFor="dismiss-rationale"
                                    className="block text-xs font-semibold text-slate-800 dark:text-slate-100 mb-1"
                                  >
                                    Justificativa técnica obrigatória (mín. 8 caracteres · autor
                                    derivado da sessão autenticada no servidor)
                                  </label>
                                  <input
                                    id="dismiss-rationale"
                                    type="text"
                                    value={dismissRationaleInput}
                                    onChange={(e) => {
                                      setDismissRationaleInput(e.target.value);
                                      setReviewError(null);
                                    }}
                                    placeholder="Ex.: Certidão de reabilitação apresentada nos autos do processo administrativo..."
                                    className="w-full h-9 px-3 text-xs bg-white dark:bg-[#061321] text-slate-900 dark:text-[#FAF9F5] border border-slate-300 dark:border-[#1D3A57] rounded-md focus:outline-none focus:ring-2 focus:ring-[#0B2540] dark:focus:ring-[#D95B35]"
                                  />
                                </div>
                                {reviewError && (
                                  <p
                                    role="alert"
                                    className="text-xs text-red-700 dark:text-red-400 font-medium"
                                  >
                                    {reviewError}
                                  </p>
                                )}
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    disabled={
                                      submittingReview || dismissRationaleInput.trim().length < 8
                                    }
                                    onClick={() => handleConfirmDismiss(selectedIndicator)}
                                    className="px-3 py-1.5 text-xs font-semibold text-white bg-[#0B2540] hover:bg-[#103256] dark:bg-[#D95B35] dark:hover:bg-[#C24C28] rounded-md disabled:opacity-50"
                                  >
                                    {submittingReview
                                      ? 'Registrando...'
                                      : 'Confirmar Descarte (DISMISSED)'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setDismissingCode(null);
                                      setDismissRationaleInput('');
                                      setReviewError(null);
                                    }}
                                    className="px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
                                  >
                                    Cancelar
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setDismissingCode(selectedIndicator.code)}
                                className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
                              >
                                <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
                                Descartar achado após diligência (marcar como DISMISSED)
                              </button>
                            )}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </section>
              )}
            </div>
          )}

          {/* Non-applicable or Non-verifiable Checks (Epistemic Transparency) */}
          {assessment.nonApplicableChecks.length > 0 && (
            <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 dark:border-[#1D3A57] flex items-center justify-between gap-4">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-[#FAF9F5]">
                  Verificações Não Aplicáveis ou Não Verificáveis (
                  {assessment.nonApplicableChecks.length})
                </h2>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Recusa explícita de inferência sem base legal ou amostra mínima
                </span>
              </div>
              <div className="divide-y divide-slate-200 dark:divide-[#1D3A57]">
                {assessment.nonApplicableChecks.map((check) => {
                  const meta = getFindingStateMeta(check.state);
                  return (
                    <div
                      key={`${check.code}-${check.state}`}
                      className="px-5 py-3.5 flex flex-col md:flex-row md:items-start justify-between gap-3 text-xs"
                    >
                      <div className="space-y-0.5 max-w-3xl">
                        <div className="font-semibold text-slate-900 dark:text-[#FAF9F5]">
                          <span className="font-mono text-slate-600 dark:text-slate-400 mr-2">
                            {check.code}
                          </span>
                          {check.title}
                        </div>
                        <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
                          {check.rationale}
                        </p>
                      </div>
                      <span className={`font-mono shrink-0 ${meta.className}`}>{check.state}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}

      {/* TAB 2: BENCHMARKING HORIZONTAL (MEDIANA/MAD) + CADEIA DE EXECUÇÃO + PRODUTIVIDADE */}
      {activeTab === 'benchmark' && (
        <div className="space-y-6">
          <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg overflow-hidden">
            <div className="p-6 border-b border-slate-200 dark:border-[#1D3A57]">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-mono text-slate-500 dark:text-slate-400">
                    BENCH_HORIZONTAL_SUPPLIER_V1 · Estatística Robusta (Mediana e MAD)
                  </div>
                  <h2 className="text-base font-semibold text-slate-900 dark:text-[#FAF9F5] mt-1">
                    Benchmarking Horizontal Intermunicipal com Controle de Escopo e Inflação
                  </h2>
                  <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 max-w-3xl">
                    Compara o preço unitário deste contrato com pares públicos comparáveis, usando{' '}
                    <span className="font-mono">robust_z = 0.6745 × (x − mediana) / MAD</span> e{' '}
                    <span className="font-mono">peer_ratio = x / mediana</span>. Amostras com{' '}
                    <span className="font-mono">n &lt; 4</span> são recusadas como{' '}
                    <span className="font-mono">NOT_VERIFIABLE</span>.
                  </p>
                </div>
                {horizontalBenchmark && (
                  <span
                    className={`font-mono text-xs shrink-0 ${
                      getFindingStateMeta(horizontalBenchmark.state).className
                    }`}
                  >
                    {horizontalBenchmark.state} · Nível {horizontalBenchmark.evidenceLevel}
                  </span>
                )}
              </div>

              {!horizontalBenchmark ? (
                <div className="mt-5 p-4 rounded-md bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] text-xs text-slate-600 dark:text-slate-300">
                  Não há grupo de pares homogêneos indexado para este contrato neste exercício
                  (estado <span className="font-mono font-semibold">NOT_VERIFIABLE</span>).
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-5 gap-5 mt-5 pt-5 border-t border-slate-200 dark:border-[#1D3A57]">
                    <div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        Preço do contrato
                      </div>
                      <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-900 dark:text-[#FAF9F5] whitespace-nowrap">
                        {formatCurrencyBRL(horizontalBenchmark.subjectAdjustedPrice)}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                        por {horizontalBenchmark.unitLabel}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        Mediana dos pares
                      </div>
                      <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-900 dark:text-[#FAF9F5] whitespace-nowrap">
                        {horizontalBenchmark.peerMedian !== null
                          ? formatCurrencyBRL(horizontalBenchmark.peerMedian)
                          : 'Recusado (n < 4)'}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                        {horizontalBenchmark.peerCount} incluído(s) ·{' '}
                        {horizontalBenchmark.excludedPeerCount} excluído(s)
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        MAD (Desvio Mediano)
                      </div>
                      <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-900 dark:text-[#FAF9F5] whitespace-nowrap">
                        {horizontalBenchmark.mad !== null
                          ? formatCurrencyBRL(horizontalBenchmark.mad)
                          : '—'}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                        {horizontalBenchmark.inflationIndexApplied}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        Escore Z Robusto
                      </div>
                      <div
                        className={`mt-1 text-base font-semibold font-mono tabular-nums whitespace-nowrap ${
                          horizontalBenchmark.robustZ !== null && horizontalBenchmark.robustZ >= 3
                            ? 'text-red-700 dark:text-red-400'
                            : 'text-slate-900 dark:text-[#FAF9F5]'
                        }`}
                      >
                        {horizontalBenchmark.robustZ !== null
                          ? `${horizontalBenchmark.robustZ.toFixed(2)}σ`
                          : horizontalBenchmark.madZero
                            ? 'MAD = 0'
                            : '—'}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                        Limiar de revisão: ≥ 3,00σ
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        Razão sobre Mediana
                      </div>
                      <div
                        className={`mt-1 text-base font-semibold font-mono tabular-nums whitespace-nowrap ${
                          horizontalBenchmark.peerRatio !== null &&
                          horizontalBenchmark.peerRatio >= 1.3
                            ? 'text-red-700 dark:text-red-400'
                            : 'text-slate-900 dark:text-[#FAF9F5]'
                        }`}
                      >
                        {horizontalBenchmark.peerRatio !== null
                          ? `${horizontalBenchmark.peerRatio.toFixed(2)}×`
                          : '—'}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                        Confiança {Math.round(horizontalBenchmark.confidence * 100)}%
                      </div>
                    </div>
                  </div>

                  <div className="mt-5 p-3.5 rounded-md bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] text-xs text-slate-700 dark:text-slate-300 space-y-1">
                    <div className="font-medium text-slate-900 dark:text-[#FAF9F5]">
                      {horizontalBenchmark.statement}
                    </div>
                    <div className="text-slate-600 dark:text-slate-400">
                      {horizontalBenchmark.notAConclusion}
                    </div>
                  </div>
                </>
              )}
            </div>

            {horizontalBenchmark && horizontalBenchmark.peers.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1D3A57] bg-slate-50 dark:bg-[#061321] text-xs font-medium text-slate-500 dark:text-slate-400">
                      <th className="py-2.5 px-4">Município / Par</th>
                      <th className="py-2.5 px-4 whitespace-nowrap">Contrato</th>
                      <th className="py-2.5 px-4 text-right whitespace-nowrap">Nominal</th>
                      <th className="py-2.5 px-4 text-right whitespace-nowrap">Ajustado</th>
                      <th className="py-2.5 px-4 text-right whitespace-nowrap">Dist. Escopo</th>
                      <th className="py-2.5 px-4">Elegibilidade e Motivo</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-[#1D3A57] text-xs">
                    {horizontalBenchmark.peers.map((peer) => (
                      <tr
                        key={peer.id}
                        className={
                          peer.included
                            ? 'text-slate-900 dark:text-slate-100'
                            : 'bg-slate-50/70 dark:bg-[#061321]/60 text-slate-500 dark:text-slate-400'
                        }
                      >
                        <td className="py-3 px-4 font-medium">
                          {peer.municipalityName}/{peer.uf}
                          {peer.sameSupplier && (
                            <span className="ml-2 font-mono text-[11px] text-[#0B2540] dark:text-[#38BDF8]">
                              mesmo fornecedor
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 font-mono whitespace-nowrap">
                          {peer.contractNumber} ({peer.contractYear})
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                          {formatCurrencyBRL(peer.nominalUnitPrice)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums font-medium whitespace-nowrap">
                          {formatCurrencyBRL(peer.inflationAdjustedPrice)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                          {peer.scopeDistance.toFixed(2)}
                        </td>
                        <td className="py-3 px-4">
                          {peer.included ? (
                            <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                              Incluído na mediana
                            </span>
                          ) : (
                            <span className="text-amber-800 dark:text-amber-400">
                              Excluído — {peer.exclusionReason}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Financial Execution Chain */}
          <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-[#1D3A57] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-[#FAF9F5]">
                  Cadeia de Execução Financeira e Ordem Cronológica (Lei 14.133/2021, art. 141)
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Rastreamento distinto de Empenho, Liquidação, Pagamento, Estorno, Instrumento de
                  Cobrança e Entrega/Medição.
                </p>
              </div>
              <span className={`text-xs ${chronoLabel.className}`}>{chronoLabel.text}</span>
            </div>

            {contract.payments.length === 0 ? (
              <div className="p-6 text-xs text-slate-500 dark:text-slate-400">
                Nenhum registro de execução financeira (empenho, liquidação ou pagamento) publicado
                na origem. A estimativa mensal contratual não comprova desembolso.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1D3A57] bg-slate-50 dark:bg-[#061321] text-xs font-medium text-slate-500 dark:text-slate-400">
                      <th className="py-2.5 px-4">Estágio</th>
                      <th className="py-2.5 px-4">Documento</th>
                      <th className="py-2.5 px-4">Data</th>
                      <th className="py-2.5 px-4 text-right">Valor</th>
                      <th className="py-2.5 px-4">Fonte / Ordem Cronológica</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-[#1D3A57] text-xs">
                    {contract.payments.map((pay) => (
                      <tr key={pay.id}>
                        <td className="py-3 px-4 font-semibold text-slate-900 dark:text-[#FAF9F5] whitespace-nowrap">
                          {pay.type}
                          {pay.isReversal && (
                            <span className="ml-1.5 font-mono text-[11px] text-amber-700 dark:text-amber-400">
                              (estorno)
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">
                          {pay.documentNumber || 'Sem nº'}
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">
                          {formatDateBR(pay.date)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-[#FAF9F5] whitespace-nowrap">
                          {formatCurrencyBRL(pay.amount)}
                        </td>
                        <td className="py-3 px-4 text-slate-600 dark:text-slate-300">
                          <div>{pay.sourceSystem}</div>
                          {pay.paidOutOfOrder && (
                            <div
                              className={`mt-0.5 font-medium ${
                                pay.justificationPublished
                                  ? 'text-amber-700 dark:text-amber-400'
                                  : 'text-red-700 dark:text-red-400'
                              }`}
                            >
                              {pay.justificationPublished
                                ? `Fora da fila com justificativa publicada: ${pay.outOfOrderJustification ?? 'OK'}`
                                : `Quebra da ordem cronológica sem justificativa publicada (art. 141)`}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Productivity / Spend vs Delivery Efficiency */}
          {contract.productivity && (
            <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6">
              <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2 pb-4 border-b border-slate-200 dark:border-[#1D3A57]">
                <div>
                  <h2 className="text-base font-semibold text-slate-900 dark:text-[#FAF9F5]">
                    Análise de Eficiência: Gasto × Entrega ({contract.productivity.domain})
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Confronto entre despesa comprovada e entrega física verificada.
                    {contract.productivity.populationInContractYear &&
                      contract.productivity.populationYear && (
                        <span>
                          {' '}
                          · População IBGE ({contract.productivity.populationYear}):{' '}
                          <span className="font-mono tabular-nums">
                            {contract.productivity.populationInContractYear.toLocaleString('pt-BR')}
                          </span>
                        </span>
                      )}
                  </p>
                </div>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Parâmetro: {contract.productivity.benchmarkSource}
                </span>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 pt-5">
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Output entregue / contratado
                  </div>
                  <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-900 dark:text-[#FAF9F5]">
                    {contract.productivity.deliveredOutput.toLocaleString('pt-BR')} /{' '}
                    {contract.productivity.contractedOutput.toLocaleString('pt-BR')}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    {contract.productivity.unitLabel}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Custo efetivo por entrega
                  </div>
                  <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-900 dark:text-[#FAF9F5]">
                    {formatCurrencyBRL(contract.productivity.actualUnitCost)}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    por {contract.productivity.unitLabel}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Referência de produtividade
                  </div>
                  <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-700 dark:text-slate-200">
                    {formatCurrencyBRL(contract.productivity.benchmarkUnitCost)}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    por {contract.productivity.unitLabel}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {contract.productivity.physicalProgressPct !== undefined
                      ? 'Avanço físico × financeiro'
                      : 'Desvio de custo unitário'}
                  </div>
                  {contract.productivity.physicalProgressPct !== undefined &&
                  contract.productivity.financialProgressPct !== undefined ? (
                    <>
                      <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-900 dark:text-[#FAF9F5]">
                        {contract.productivity.physicalProgressPct}% físico ·{' '}
                        {contract.productivity.financialProgressPct}% financ.
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        Diferença:{' '}
                        {contract.productivity.financialProgressPct -
                          contract.productivity.physicalProgressPct}{' '}
                        p.p.
                      </div>
                    </>
                  ) : (
                    <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-amber-700 dark:text-amber-400">
                      {formatPercentageBR(
                        ((contract.productivity.actualUnitCost -
                          contract.productivity.benchmarkUnitCost) /
                          contract.productivity.benchmarkUnitCost) *
                          100,
                        true
                      )}
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}
        </div>
      )}

      {/* TAB 3: GRAFO FOLLOWTHEMONEY */}
      {activeTab === 'graph' && (
        <EntityGraphTab contract={contract} onSelectContract={onSelectContract} />
      )}

      {/* TAB 4: FORNECEDOR, RECEITA/CNPJ, QSA E SANÇÕES */}
      {activeTab === 'supplier' && (
        <div className="space-y-6">
          <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-200 dark:border-[#1D3A57]">
              <div>
                <h2 className="text-lg font-bold text-slate-900 dark:text-[#FAF9F5]">
                  {contract.supplier.legalName}
                </h2>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-mono tabular-nums text-slate-800 dark:text-slate-200 font-medium">
                    CNPJ {formatCnpj(contract.supplier.cnpj)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>Situação: {contract.supplier.registrationStatus}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Sede:{' '}
                    {contract.supplier.municipality
                      ? `${contract.supplier.municipality}/${contract.supplier.uf}`
                      : 'Não informada'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>Abertura: {formatDateBR(contract.supplier.openingDate)}</span>
                </div>
              </div>

              <button
                type="button"
                disabled={checkingCnpj}
                onClick={handleLiveCnpjCheck}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-[#061321] border border-slate-300 dark:border-[#1D3A57] hover:bg-slate-50 dark:hover:bg-[#102843] rounded-md transition-colors whitespace-nowrap disabled:opacity-60"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${checkingCnpj ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                {checkingCnpj ? 'Consultando Receita...' : 'Consultar Receita (Tempo Real)'}
              </button>
            </div>

            {liveCnpjResult && (
              <div className="mt-4 p-3.5 rounded-md bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] text-xs text-slate-700 dark:text-slate-300">
                {liveCnpjResult.enriched ? (
                  <div>
                    <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                      Receita Federal verificada ({liveCnpjResult.source}):
                    </span>{' '}
                    {liveCnpjResult.legalName} · Situação {liveCnpjResult.registrationStatus} · CNAE{' '}
                    {liveCnpjResult.primaryCnaeDescription}
                  </div>
                ) : (
                  <div>{liveCnpjResult.message}</div>
                )}
              </div>
            )}

            <dl className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-5 text-sm">
              <div>
                <dt className="text-xs text-slate-500 dark:text-slate-400">CNAE Principal</dt>
                <dd className="mt-1 font-medium text-slate-900 dark:text-[#FAF9F5]">
                  {contract.supplier.primaryCnaeCode ? (
                    <>
                      <span className="font-mono">{contract.supplier.primaryCnaeCode}</span> —{' '}
                      {contract.supplier.primaryCnaeDescription}
                    </>
                  ) : (
                    'Não informado pela fonte'
                  )}
                </dd>
                {contract.expectedCnaePrefixes.length > 0 && (
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    Prefixos esperados para o objeto:{' '}
                    <span className="font-mono">{contract.expectedCnaePrefixes.join(', ')}</span>
                  </div>
                )}
              </div>
              <div>
                <dt className="text-xs text-slate-500 dark:text-slate-400">Capital Social</dt>
                <dd className="mt-1 font-mono tabular-nums font-semibold text-slate-900 dark:text-[#FAF9F5]">
                  {contract.supplier.shareCapital > 0
                    ? formatCurrencyBRL(contract.supplier.shareCapital)
                    : 'Não informado'}
                </dd>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Contratos ativos simultâneos: {contract.supplier.simultaneousActiveContracts}
                </div>
              </div>
              <div>
                <dt className="text-xs text-slate-500 dark:text-slate-400">
                  Histórico no Município
                </dt>
                <dd className="mt-1 font-mono tabular-nums font-semibold text-slate-900 dark:text-[#FAF9F5]">
                  {contract.supplier.priorMunicipalContracts} contrato(s) anterior(es)
                </dd>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Proveniência: {contract.supplier.dataProvenance}
                </div>
              </div>
            </dl>
          </section>

          {/* Sanctions Table */}
          <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 dark:border-[#1D3A57] flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-[#FAF9F5]">
                Sanções e Impedimentos (Verificação Temporal × Abrangência × Efeito)
              </h3>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {contract.supplier.sanctions.length} ocorrência(s)
              </span>
            </div>

            {contract.supplier.sanctions.length === 0 ? (
              <div className="p-6 text-sm text-slate-600 dark:text-slate-300">
                Nenhuma sanção indexada para este fornecedor na base local. Consulte a API do Portal
                da Transparência (CGU) com chave configurada para verificação em tempo real.
              </div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-[#1D3A57]">
                {contract.supplier.sanctions.map((s) => {
                  const activeOnSignature =
                    s.status === 'Ativa' &&
                    Boolean(contract.signatureDate) &&
                    s.startDate <= contract.signatureDate &&
                    s.endDate >= contract.signatureDate;
                  return (
                    <div
                      key={s.id}
                      className="p-5 flex flex-col md:flex-row md:items-start justify-between gap-4"
                    >
                      <div className="space-y-1">
                        <div
                          className={`flex items-center gap-2 text-sm font-semibold ${
                            activeOnSignature && s.sanctionEffect !== 'fine_only'
                              ? 'text-red-700 dark:text-red-400'
                              : 'text-slate-700 dark:text-slate-300'
                          }`}
                        >
                          <ShieldAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
                          <span>
                            {s.registry} · Situação {s.status} · Abrangência {s.scope}
                            {s.scopeUf ? ` (${s.scopeUf})` : ''}
                            {s.sanctionEffect ? ` · Efeito ${s.sanctionEffect}` : ''}
                          </span>
                        </div>
                        <p className="text-sm text-slate-900 dark:text-[#FAF9F5]">{s.reason}</p>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          Órgão sancionador: {s.sanctioningOrgan} · Fonte: {s.sourceSystem}
                        </div>
                      </div>
                      <div className="text-xs font-mono tabular-nums text-slate-700 dark:text-slate-300 shrink-0 md:text-right">
                        <div>
                          {formatDateBR(s.startDate)} a {formatDateBR(s.endDate)}
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                          {activeOnSignature
                            ? 'Vigente na assinatura'
                            : 'Fora da janela temporal'}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* QSA Shareholders */}
          <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 dark:border-[#1D3A57]">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-[#FAF9F5]">
                Quadro de Sócios e Administradores (QSA) — Verificação STF Tema 1001
              </h3>
            </div>
            {contract.supplier.shareholders.length === 0 ? (
              <div className="p-6 text-xs text-slate-500 dark:text-slate-400">
                Quadro societário não informado na origem. Utilize “Consultar Receita (Tempo Real)”
                acima para enriquecer.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1D3A57] bg-slate-50 dark:bg-[#061321] text-xs font-medium text-slate-500 dark:text-slate-400">
                      <th className="py-2.5 px-5">Nome</th>
                      <th className="py-2.5 px-5">Qualificação</th>
                      <th className="py-2.5 px-5">CPF/CNPJ</th>
                      <th className="py-2.5 px-5">Entrada</th>
                      <th className="py-2.5 px-5">Cruzamento de Vínculos</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-[#1D3A57]">
                    {contract.supplier.shareholders.map((sh) => (
                      <tr key={sh.name}>
                        <td className="py-3 px-5 font-medium text-slate-900 dark:text-[#FAF9F5]">
                          {sh.name}
                        </td>
                        <td className="py-3 px-5 text-slate-600 dark:text-slate-300">{sh.role}</td>
                        <td className="py-3 px-5 font-mono text-xs text-slate-600 dark:text-slate-300">
                          {sh.maskedCpfCnpj}
                        </td>
                        <td className="py-3 px-5 font-mono text-xs tabular-nums text-slate-600 dark:text-slate-300">
                          {formatDateBR(sh.entryDate)}
                        </td>
                        <td className="py-3 px-5 text-xs">
                          {sh.isPublicServantOverlap ? (
                            <span className="text-amber-800 dark:text-amber-400 font-semibold">
                              Potencial conflito (STF Tema 1001 — verificar estatuto local):{' '}
                              {sh.overlapDetail}
                            </span>
                          ) : (
                            <span className="text-slate-500 dark:text-slate-400">
                              Sem vínculo funcional detectado
                            </span>
                          )}
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

      {/* TAB 5: ITENS, COMPARAÇÃO DE PREÇOS E ADITIVOS */}
      {activeTab === 'financials' && (
        <div className="space-y-6">
          <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 dark:border-[#1D3A57] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-[#FAF9F5]">
                  Itens Contratados × Preços de Referência (Painel de Preços / SINAPI / BPS)
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Desvio médio ponderado sobre itens comparáveis:{' '}
                  <span
                    className={`font-mono font-semibold ${
                      assessment.weightedPriceDeviationPct >= 15
                        ? 'text-red-700 dark:text-red-400'
                        : 'text-emerald-700 dark:text-emerald-400'
                    }`}
                  >
                    {formatPercentageBR(assessment.weightedPriceDeviationPct, true)}
                  </span>
                  {priceReferenceCoverage && (
                    <span className="ml-2 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                      · Cobertura: {priceReferenceCoverage.comparableItemCount}/
                      {priceReferenceCoverage.totalItemCount} itens (
                      {priceReferenceCoverage.comparableValueSharePct.toFixed(1)}% do valor)
                    </span>
                  )}
                </p>
              </div>
            </div>

            {contract.items.length === 0 ? (
              <div className="p-6 text-sm text-slate-500 dark:text-slate-400">
                Planilha detalhada de itens não publicada na origem para este contrato.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1D3A57] bg-slate-50 dark:bg-[#061321] text-xs font-medium text-slate-500 dark:text-slate-400">
                      <th className="py-2.5 px-4">#</th>
                      <th className="py-2.5 px-4">Descrição do Item</th>
                      <th className="py-2.5 px-4 text-right">Qtd</th>
                      <th className="py-2.5 px-4 text-right">Unit. Contratado</th>
                      <th className="py-2.5 px-4 text-right">Referência</th>
                      <th className="py-2.5 px-4 text-right">Desvio</th>
                      <th className="py-2.5 px-4">Base</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-[#1D3A57]">
                    {contract.items.map((item) => {
                      const hasRef = item.referencePrice > 0;
                      const dev = hasRef
                        ? ((item.unitPrice - item.referencePrice) / item.referencePrice) * 100
                        : null;
                      return (
                        <tr key={item.id}>
                          <td className="py-3 px-4 font-mono text-xs text-slate-500 dark:text-slate-400">
                            {item.itemNumber}
                          </td>
                          <td className="py-3 px-4 text-slate-900 dark:text-[#FAF9F5] max-w-md">
                            {item.description}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-xs text-slate-700 dark:text-slate-300 whitespace-nowrap">
                            {item.quantity.toLocaleString('pt-BR')} {item.unit}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums font-medium text-slate-900 dark:text-[#FAF9F5] whitespace-nowrap">
                            {formatCurrencyBRL(item.unitPrice)}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">
                            {hasRef ? formatCurrencyBRL(item.referencePrice) : 'Sem referência'}
                          </td>
                          <td
                            className={`py-3 px-4 text-right font-mono tabular-nums font-semibold whitespace-nowrap ${
                              dev === null
                                ? 'text-slate-400 dark:text-slate-500'
                                : dev >= 20
                                  ? 'text-red-700 dark:text-red-400'
                                  : dev >= 10
                                    ? 'text-amber-700 dark:text-amber-400'
                                    : 'text-emerald-700 dark:text-emerald-400'
                            }`}
                          >
                            {dev !== null ? formatPercentageBR(dev, true) : 'N/A'}
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">
                            {item.referenceSource || '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Amendments */}
          <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 dark:border-[#1D3A57] flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-[#FAF9F5]">
                Termos Aditivos ({contract.amendments.length})
              </h3>
              <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                Acumulado: {formatPercentageBR(assessment.amendmentTotalPct, true)}
              </span>
            </div>
            {contract.amendments.length === 0 ? (
              <div className="p-6 text-sm text-slate-500 dark:text-slate-400">
                Nenhum termo aditivo registrado até o momento.
              </div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-[#1D3A57]">
                {contract.amendments.map((ad) => (
                  <div key={ad.id} className="p-4 space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-semibold text-slate-900 dark:text-[#FAF9F5]">
                        {ad.number} · {ad.type}
                      </span>
                      <span className="font-mono tabular-nums font-semibold text-red-700 dark:text-red-400">
                        +{formatCurrencyBRL(ad.addedValue)}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-300">{ad.justification}</p>
                    <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                      Data: {formatDateBR(ad.date)}
                      {ad.pageNumber ? ` · Evidência pág. ${ad.pageNumber}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* TAB 6: FONTES E DOCUMENTOS (SHA-256 / EVIDENCE STORE) */}
      {activeTab === 'sources_docs' && (
        <div className="space-y-6">
          <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6">
            <h2 className="text-base font-semibold text-slate-900 dark:text-[#FAF9F5]">
              Reconciliação Multifonte com Preservação de Proveniência
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 max-w-3xl">
              Nenhuma fonte pública sobrescreve outra. Os registros do PNCP, Portal da Transparência
              Municipal, TCE estadual e PDFs importados são mantidos lado a lado para apuração
              explícita de divergências.
            </p>

            {assessment.divergences.length > 0 && (
              <div className="mt-5 space-y-3">
                {assessment.divergences.map((div) => (
                  <div
                    key={div.field}
                    className="p-4 rounded-md bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-sm font-semibold text-slate-900 dark:text-[#FAF9F5]">
                        Divergência em: {div.field}
                      </span>
                      <SeverityText severity={div.severity} />
                    </div>
                    <p className="text-xs text-slate-700 dark:text-slate-300">
                      {div.deltaDescription}
                    </p>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono text-slate-800 dark:text-slate-200 pt-1">
                      {div.sources.map((s) => (
                        <span key={s.sourceSystem}>
                          {s.sourceSystem}: <strong>{s.value}</strong>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-6 overflow-x-auto border border-slate-200 dark:border-[#1D3A57] rounded-md">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-[#1D3A57] bg-slate-50 dark:bg-[#061321] text-xs font-medium text-slate-500 dark:text-slate-400">
                    <th className="py-2.5 px-4">Sistema Origem</th>
                    <th className="py-2.5 px-4">ID Externo</th>
                    <th className="py-2.5 px-4 text-right">Valor Original</th>
                    <th className="py-2.5 px-4 text-right">Valor Atualizado</th>
                    <th className="py-2.5 px-4">Situação</th>
                    <th className="py-2.5 px-4">Coleta</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-[#1D3A57]">
                  {contract.sourceRecords.map((src) => (
                    <tr key={src.id}>
                      <td className="py-3 px-4 font-semibold text-slate-900 dark:text-[#FAF9F5] whitespace-nowrap">
                        {src.sourceSystem}
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">
                        {src.externalId}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300 whitespace-nowrap">
                        {formatCurrencyBRL(src.reportedOriginalValue)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-[#FAF9F5] whitespace-nowrap">
                        {formatCurrencyBRL(src.reportedUpdatedValue)}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-700 dark:text-slate-300">
                        {src.reportedStatus}
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        {formatDateBR(src.retrievedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Documents & Evidence Store */}
          {contract.documents.length === 0 ? (
            <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-8 text-center text-sm text-slate-500 dark:text-slate-400">
              Nenhum arquivo PDF anexado automaticamente na origem PNCP. Utilize a aba Documento para
              importar o contrato manualmente.
            </section>
          ) : (
            contract.documents.map((doc) => (
              <section
                key={doc.id}
                className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg overflow-hidden"
              >
                <div className="p-5 border-b border-slate-200 dark:border-[#1D3A57] flex flex-col md:flex-row md:items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {doc.documentType} · {doc.sourceSystem} · {formatBytes(doc.sizeBytes)}
                    </div>
                    <h3 className="text-base font-semibold text-slate-900 dark:text-[#FAF9F5]">
                      {doc.title}
                    </h3>
                    <div className="text-xs font-mono text-slate-500 dark:text-slate-400 break-all">
                      SHA-256: {doc.sha256}
                    </div>
                    {doc.originalObjectStored && doc.originalDownloadUrl && (
                      <div className="pt-1">
                        <a
                          href={doc.originalDownloadUrl}
                          download
                          className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#0B2540] dark:text-[#38BDF8] hover:underline"
                        >
                          <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                          Baixar arquivo original verificado (SHA-256 intacto)
                        </a>
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-slate-600 dark:text-slate-300 md:text-right shrink-0 space-y-0.5 font-mono">
                    <div>Extrator: {doc.extractionSummary.extractorVersion}</div>
                    <div>
                      Páginas:{' '}
                      {doc.extractionSummary.processedPageCount ?? doc.extractionSummary.totalPages}/
                      {doc.extractionSummary.originalPageCount ?? doc.extractionSummary.totalPages} ·{' '}
                      {doc.extractionSummary.doclingPages + doc.extractionSummary.nativePages} nativo
                      · {doc.extractionSummary.ocrPages} OCR
                      {(doc.extractionSummary.multimodalPages ?? 0) > 0
                        ? ` · ${doc.extractionSummary.multimodalPages} multimodal`
                        : ''}
                    </div>
                  </div>
                </div>

                {doc.extractionSummary.truncated && (
                  <div className="px-5 py-2.5 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-300">
                    Extração parcial: processadas {doc.extractionSummary.processedPageCount} de{' '}
                    {doc.extractionSummary.originalPageCount} páginas originais por limite de
                    processamento.
                  </div>
                )}

                <div className="divide-y divide-slate-200 dark:divide-[#1D3A57]">
                  {doc.pages.map((page) => (
                    <div key={`${doc.id}-p${page.pageNumber}`} className="p-5 space-y-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="font-mono font-semibold text-slate-800 dark:text-slate-200">
                          Página {page.pageNumber}
                        </span>
                        <span className="font-mono text-slate-500 dark:text-slate-400">
                          método={page.extractionMethod} · confiança=
                          {Math.round(page.confidence * 100)}%
                        </span>
                      </div>
                      <p className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed font-mono bg-slate-50 dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] rounded p-3 whitespace-pre-wrap">
                        {page.text}
                      </p>
                      {page.highlights.length > 0 && (
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
                          {page.highlights.map((h, i) => (
                            <span key={`${h.field}-${i}`}>
                              <span className="font-mono text-[#0B2540] dark:text-[#38BDF8]">
                                {h.field}
                              </span>{' '}
                              ={' '}
                              <span className="font-mono text-slate-900 dark:text-[#FAF9F5]">
                                {h.normalizedValue}
                              </span>
                              {h.coordinates ? ` (${h.coordinates})` : ''}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  BookmarkCheck,
  Check,
  Download,
  FileCode2,
  FileDown,
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
import { buildAuditDossierMarkdown, mapContractToOCDS } from '../lib/ocdsMapper';
import { downloadAuditReportPdf } from '../lib/pdfReportGenerator';
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
      return { label: 'CONFIRMED_DATA · Dado oficial', className: 'text-red-700 font-semibold' };
    case 'OBSERVATION':
      return { label: 'OBSERVATION · Sinal técnico', className: 'text-amber-700 font-semibold' };
    case 'INSUFFICIENT_EVIDENCE':
      return { label: 'INSUFFICIENT_EVIDENCE', className: 'text-slate-600 font-medium' };
    case 'NOT_VERIFIABLE':
      return { label: 'NOT_VERIFIABLE · Não verificável', className: 'text-slate-600 font-medium' };
    case 'SOURCE_UNAVAILABLE':
      return { label: 'SOURCE_UNAVAILABLE', className: 'text-slate-500 font-medium' };
    case 'NOT_APPLICABLE':
      return { label: 'NOT_APPLICABLE · Não aplicável', className: 'text-slate-500 font-medium' };
    case 'DISMISSED':
      return { label: 'DISMISSED · Descartado pelo auditor', className: 'text-slate-500 line-through' };
  }
}

function getChronologicalOrderLabel(
  status: EvaluatedContract['assessment']['executionChain']['chronologicalOrderStatus']
): { text: string; className: string } {
  switch (status) {
    case 'valid_sequence':
      return { text: 'Sequência regular (art. 141)', className: 'text-emerald-700 font-medium' };
    case 'justified_exception':
      return {
        text: 'Exceção com justificativa publicada',
        className: 'text-amber-700 font-medium',
      };
    case 'unexplained_break':
      return {
        text: 'Quebra sem justificativa publicada',
        className: 'text-red-700 font-semibold',
      };
    default:
      return { text: 'Não verificável (sem pagamentos)', className: 'text-slate-500' };
  }
}

export function ContractDossierView({
  contract,
  onBack,
  onDossierSaved,
  onSelectContract,
}: ContractDossierViewProps) {
  const { assessment } = contract;
  const [activeTab, setActiveTab] = useState<DossierTab>('overview');
  const [selectedIndicatorCode, setSelectedIndicatorCode] = useState<string | null>(
    assessment.indicators[0]?.code ?? null
  );

  // Persisted append-only auditor review log
  const [reviewHistory, setReviewHistory] = useState<FindingReviewRecord[]>(contract.reviews ?? []);
  const [dismissingCode, setDismissingCode] = useState<string | null>(null);
  const [dismissRationaleInput, setDismissRationaleInput] = useState('');
  const [reviewAuthorInput, setReviewAuthorInput] = useState('Auditor(a) Responsável');
  const [submittingReview, setSubmittingReview] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  // Save dossier state
  const [showSaveBox, setShowSaveBox] = useState(false);
  const [analystNote, setAnalystNote] = useState('');
  const [savingDossier, setSavingDossier] = useState(false);
  const [savedFeedback, setSavedFeedback] = useState<string | null>(null);

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

  // Reset local selection and reload persisted finding reviews when switching contracts
  useEffect(() => {
    let cancelled = false;
    setActiveTab('overview');
    setSelectedIndicatorCode(assessment.indicators[0]?.code ?? null);
    setReviewHistory(contract.reviews ?? []);
    setDismissingCode(null);
    setDismissRationaleInput('');
    setReviewError(null);
    setLiveCnpjResult(null);
    setSavedFeedback(null);

    fetchFindingReviews(contract.id)
      .then((rows) => {
        if (!cancelled) setReviewHistory(rows);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [contract.id]);

  // Derive active dismissed findings from the append-only review history (last action wins)
  const dismissedFindings: Record<
    string,
    { rationale: string; dismissedAt: string; author: string }
  > = {};
  for (const rev of reviewHistory) {
    if (rev.action === 'dismiss') {
      dismissedFindings[rev.findingId] = {
        rationale: rev.rationale,
        dismissedAt: rev.createdAt,
        author: rev.author,
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
        author: reviewAuthorInput.trim() || 'Auditor(a) Responsável',
        ruleVersion: indicator.ruleVersion,
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
    setSubmittingReview(true);
    setReviewError(null);
    try {
      const res = await submitFindingReview(contract.id, indicator.findingId, {
        action: 'restore',
        rationale: 'Reativação manual registrada pelo auditor para nova verificação documental.',
        author: reviewAuthorInput.trim() || 'Auditor(a) Responsável',
        ruleVersion: indicator.ruleVersion,
      });
      setReviewHistory(res.reviews);
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Falha ao reativar achado.');
    } finally {
      setSubmittingReview(false);
    }
  };

  const handleExportPdfReport = () => {
    try {
      const filename = downloadAuditReportPdf(contract, {
        analystNote,
        reviews: reviewHistory,
      });
      setSavedFeedback(`Relatório PDF gerado e baixado (${filename}).`);
    } catch {
      setSavedFeedback('Não foi possível gerar o relatório em PDF neste momento.');
    }
  };

  const handleExportMarkdown = () => {
    const md = buildAuditDossierMarkdown({ ...contract, reviews: reviewHistory }, analystNote);
    downloadTextFile(
      `dossie-${contract.municipalityIbge}-${contract.contractNumber.replace('/', '-')}.md`,
      md,
      'text/markdown;charset=utf-8'
    );
  };

  const handleExportOcds = () => {
    const ocds = mapContractToOCDS(contract);
    downloadTextFile(
      `ocds-${contract.municipalityIbge}-${contract.contractNumber.replace('/', '-')}.json`,
      JSON.stringify(ocds, null, 2),
      'application/json;charset=utf-8'
    );
  };

  const handleSaveDossier = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingDossier(true);
    setSavedFeedback(null);
    try {
      const res = await saveDossier(contract.id, analystNote);
      setSavedFeedback(
        `Dossiê arquivado (${res.dossier.id}) · SHA-256 ${res.dossier.sha256Digest.slice(0, 12)}…`
      );
      setShowSaveBox(false);
      onDossierSaved();
    } catch {
      setSavedFeedback('Não foi possível salvar o dossiê neste momento.');
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

  const { executionChain, appliedLegalRuleset, horizontalBenchmark } = assessment;
  const chronoLabel = getChronologicalOrderLabel(executionChain.chronologicalOrderStatus);

  return (
    <div className="space-y-6">
      {/* Back navigation & exports */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
          Voltar à lista de contratos
        </button>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSaveBox((prev) => !prev)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap"
          >
            <BookmarkCheck className="w-3.5 h-3.5" aria-hidden="true" />
            Salvar Dossiê
          </button>
          <button
            type="button"
            onClick={handleExportOcds}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap"
          >
            <FileCode2 className="w-3.5 h-3.5" aria-hidden="true" />
            OCDS JSON
          </button>
          <button
            type="button"
            onClick={handleExportMarkdown}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            Dossiê (.md)
          </button>
          <button
            type="button"
            data-testid="export-pdf-report-btn"
            onClick={handleExportPdfReport}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap"
          >
            <FileDown className="w-3.5 h-3.5" aria-hidden="true" />
            Exportar Relatório
          </button>
        </div>
      </div>

      {/* Save Dossier Inline Form */}
      {showSaveBox && (
        <form
          onSubmit={handleSaveDossier}
          className="bg-white border border-slate-200 rounded-lg p-5 space-y-3"
        >
          <div className="flex items-center justify-between">
            <label htmlFor="analyst-note" className="text-sm font-semibold text-slate-900">
              Nota técnica do auditor para arquivamento do dossiê
            </label>
            <button
              type="button"
              onClick={() => setShowSaveBox(false)}
              className="text-xs text-slate-500 hover:text-slate-800"
            >
              Cancelar
            </button>
          </div>
          <textarea
            id="analyst-note"
            rows={2}
            value={analystNote}
            onChange={(e) => setAnalystNote(e.target.value)}
            placeholder="Ex.: Solicitar justificativa de reequilíbrio do 3º aditivo e certidão CEIS junto à SMS..."
            className="w-full text-sm px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={savingDossier}
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md disabled:opacity-60"
            >
              {savingDossier ? 'Arquivando...' : 'Confirmar Arquivamento com Digest SHA-256'}
            </button>
          </div>
        </form>
      )}

      {savedFeedback && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-xs text-emerald-900 flex items-center gap-2">
          <Check className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
          <span className="font-medium">{savedFeedback}</span>
        </div>
      )}

      {/* Primary Forensic Header Panel */}
      <section className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-5 pb-5 border-b border-slate-200">
          <div className="space-y-2 max-w-3xl">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
              <span className="font-mono font-semibold text-slate-800">
                Contrato {contract.contractNumber}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {contract.municipalityName}/{contract.uf} (IBGE{' '}
                <span className="font-mono tabular-nums">{contract.municipalityIbge}</span>)
              </span>
              <span aria-hidden="true">·</span>
              <span>{contract.entityName}</span>
            </div>

            <h1
              className={`font-bold text-slate-900 leading-snug ${
                contract.object.length > 140 ? 'text-base lg:text-lg' : 'text-xl lg:text-2xl'
              }`}
            >
              {contract.object}
            </h1>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 pt-0.5">
              <span>
                Controle PNCP:{' '}
                <span className="font-mono text-slate-800">{contract.pncpControlNumber}</span>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                Modalidade: <span className="text-slate-800 font-medium">{contract.modality}</span> (
                {contract.biddersCount} participante{contract.biddersCount === 1 ? '' : 's'})
              </span>
              <span aria-hidden="true">·</span>
              <span>
                Vigência: {formatDateBR(contract.startDate)} a {formatDateBR(contract.endDate)}
              </span>
            </div>

            {/* Legal Time Travel Metadata Line */}
            <div
              data-testid="legal-ruleset-banner"
              className="text-xs text-slate-600 pt-1"
            >
              <span className="font-semibold text-slate-800">Norma vigente na assinatura:</span>{' '}
              {appliedLegalRuleset.legalBasis} ·{' '}
              <span className="font-mono text-slate-700">{appliedLegalRuleset.ruleId}</span>{' '}
              (vigência a partir de {formatDateBR(appliedLegalRuleset.effectiveFrom)})
            </div>
          </div>

          {/* Risk Headline Block */}
          <div className="lg:text-right shrink-0 space-y-1">
            <div
              data-testid="risk-headline"
              className={`font-mono tabular-nums text-lg font-bold tracking-tight ${getRiskToneClass(
                displayScore
              )}`}
            >
              {displayHeadline}
            </div>
            <p className="text-xs text-slate-500 max-w-xs lg:ml-auto">
              Achados objetivos e reproduzíveis para auditoria humana; não constituem conclusão
              jurídica ou prova automática de fraude.
            </p>
          </div>
        </div>

        {/* Strict Separation: Level 1 Contracted Obligation vs Level 2 Proven Execution */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 pt-5">
          {/* Level 1: Obrigação Contratada */}
          <div className="lg:col-span-6 space-y-3 lg:pr-6 lg:border-r lg:border-slate-200">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-800">
                Nível 1 · Obrigação Contratada
              </span>
              <span className="font-mono text-slate-500">
                Assinatura {formatDateBR(contract.signatureDate)}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {contract.originalValue === 0 && contract.updatedValue === 0 ? (
                <>
                  <div>
                    <div className="text-xs text-slate-500">Valor original</div>
                    <div className="mt-1 text-base font-semibold text-amber-800 whitespace-nowrap">
                      Não divulgado
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Omitido na origem / ausente no PNCP
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">Valor atualizado</div>
                    <div className="mt-1 text-base font-semibold text-amber-800 whitespace-nowrap">
                      Não divulgado
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Requer íntegra contratual
                    </div>
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <div className="text-xs text-slate-500">Estimativa mensal</div>
                    <div className="mt-1 text-base font-semibold font-mono text-slate-500 whitespace-nowrap">
                      Não verificável
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Vigência {executionChain.contractDurationMonths}m · sem valor base
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <div className="text-xs text-slate-500">Valor original</div>
                    <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-900 whitespace-nowrap">
                      {formatCurrencyBRL(contract.originalValue)}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {contract.amendments.length} aditivo(s)
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">Valor atualizado</div>
                    <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-900 whitespace-nowrap">
                      {formatCurrencyBRL(contract.updatedValue)}
                    </div>
                    <div
                      className={`text-[11px] font-mono tabular-nums mt-0.5 ${
                        assessment.variationPct > 25
                          ? 'text-red-700 font-semibold'
                          : assessment.variationPct > 0
                            ? 'text-amber-700'
                            : 'text-emerald-700'
                      }`}
                    >
                      {formatPercentageBR(assessment.variationPct, true)} (teto 25%)
                    </div>
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <div className="text-xs text-slate-500">Estimativa mensal</div>
                    <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-700 whitespace-nowrap">
                      {formatCurrencyBRL(executionChain.estimatedMonthlyContractValue)}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Média {executionChain.contractDurationMonths}m · não comprova pago
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Level 2: Execução Financeira Comprovada */}
          <div className="lg:col-span-6 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-slate-800">
                Nível 2 · Execução Financeira Comprovada
              </span>
              <span className={chronoLabel.className}>{chronoLabel.text}</span>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <div className="text-xs text-slate-500">Empenhado</div>
                <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-900 whitespace-nowrap">
                  {formatCurrencyBRL(executionChain.committedTotal)}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">Nota de empenho</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Liquidado</div>
                <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-900 whitespace-nowrap">
                  {formatCurrencyBRL(executionChain.liquidatedTotal)}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">Atesto / medição</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Pago comprovado</div>
                <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-900 whitespace-nowrap">
                  {formatCurrencyBRL(executionChain.paidTotal)}
                </div>
                <div className="text-[11px] text-slate-500 font-mono tabular-nums mt-0.5">
                  {contract.updatedValue > 0
                    ? `${formatPercentageBR((executionChain.paidTotal / contract.updatedValue) * 100)} do contrato`
                    : '—'}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 pt-3 border-t border-slate-100 text-[11px] text-slate-500">
          Separação financeira obrigatória: a estimativa mensal (<span className="font-mono">estimated_monthly_contract_value</span>) representa apenas a média da obrigação contratada no prazo e nunca substitui empenho, liquidação ou pagamento efetivo.
        </div>
      </section>

      {/* Dossier Section Tabs */}
      <div className="border-b border-slate-200 overflow-x-auto">
        <div role="tablist" aria-label="Seções do dossiê" className="flex items-center gap-6 min-w-max">
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
                    ? 'border-blue-700 text-blue-700'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* TAB 1: RESUMO E RISCOS (ACHADOS EXPLICÁVEIS + ESTADOS EPISTÊMICOS + HIPÓTESES ALTERNATIVAS) */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {assessment.indicators.length === 0 ? (
            <section className="bg-white border border-slate-200 rounded-lg p-8 text-center">
              {assessment.coverageStatus === 'INSUFFICIENT' ? (
                <>
                  <p className="text-base font-semibold text-amber-800">
                    Cobertura documental insuficiente para afirmar conformidade.
                  </p>
                  <p className="text-xs text-slate-600 mt-1 max-w-xl mx-auto">
                    Este contrato não possui fontes oficiais reconciliadas nem documentos anexados
                    no repositório. O motor recusa classificá-lo como regular até obtenção de
                    evidências primárias.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-base font-semibold text-emerald-800">
                    Nenhum indicador de risco acionado para este contrato.
                  </p>
                  <p className="text-xs text-slate-600 mt-1 max-w-xl mx-auto">
                    Todas as verificações aplicáveis do Motor Forense Próprio (sanções vigentes e no
                    escopo, regras jurídicas temporais, preços, aditivos, CNAE e ordem cronológica)
                    resultaram em conformidade preliminar (cobertura: {assessment.coverageStatus ?? 'ADEQUATE'}).
                  </p>
                </>
              )}
            </section>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left: Indicators Table */}
              <section className="lg:col-span-5 bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200">
                  <h2 className="text-sm font-semibold text-slate-900">
                    Achados Acionados (Motor Forense Próprio)
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Regras temporais + Benchmarking Mediana/MAD + Sanções e Execução. Selecione um
                    achado para auditar a trilha probatória.
                  </p>
                </div>

                <div className="divide-y divide-slate-200">
                  {assessment.indicators.map((ind) => {
                    const isSelected = selectedIndicator?.code === ind.code;
                    const isDismissed = Boolean(dismissedFindings[ind.findingId]);
                    const stateMeta = getFindingStateMeta(isDismissed ? 'DISMISSED' : ind.state);
                    return (
                      <button
                        key={ind.code}
                        type="button"
                        onClick={() => setSelectedIndicatorCode(ind.code)}
                        aria-pressed={isSelected}
                        className={`w-full text-left px-5 py-3.5 transition-colors flex items-start justify-between gap-4 ${
                          isSelected ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                        } ${isDismissed ? 'opacity-65' : ''}`}
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="text-sm font-semibold text-slate-900">
                            {ind.title}
                          </div>
                          <div className="text-xs text-slate-500">
                            <span className="font-mono">{ind.code}</span> · Nível {ind.evidenceLevel}{' '}
                            · {Math.round(ind.confidence * 100)}% conf.
                          </div>
                          <div className={`text-[11px] font-mono ${stateMeta.className}`}>
                            {stateMeta.label}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <SeverityText severity={ind.severity} />
                          <div className="text-xs font-mono tabular-nums text-slate-500 mt-0.5">
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
                  className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-6 space-y-5"
                >
                  {(() => {
                    const dismissedEntry = dismissedFindings[selectedIndicator.findingId];
                    const effectiveState: FindingState = dismissedEntry
                      ? 'DISMISSED'
                      : selectedIndicator.state;
                    const stateMeta = getFindingStateMeta(effectiveState);

                    return (
                      <>
                        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-4 border-b border-slate-200">
                          <div className="space-y-1">
                            <div className="text-xs font-mono text-slate-500">
                              {selectedIndicator.findingId} · {selectedIndicator.code} · regra{' '}
                              {selectedIndicator.ruleVersion}
                            </div>
                            <h3 className="text-lg font-bold text-slate-900">
                              {selectedIndicator.title}
                            </h3>
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                              <span className={`font-mono ${stateMeta.className}`}>
                                {stateMeta.label}
                              </span>
                              <span className="text-slate-400" aria-hidden="true">·</span>
                              <span className="font-mono text-slate-700">
                                Evidência Nível {selectedIndicator.evidenceLevel}
                              </span>
                              <span className="text-slate-400" aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums text-slate-700">
                                Confiança {Math.round(selectedIndicator.confidence * 100)}%
                              </span>
                              <span className="text-slate-400" aria-hidden="true">·</span>
                              <span className="text-slate-600">{selectedIndicator.framework}</span>
                            </div>
                          </div>
                          <div className="shrink-0">
                            <SeverityText severity={selectedIndicator.severity} />
                          </div>
                        </div>

                        {dismissedEntry && (
                          <div className="p-3.5 rounded-md bg-slate-50 border border-slate-300 text-xs space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-slate-800">
                                Achado descartado pelo auditor (DISMISSED · persistido em SQLite)
                              </span>
                              <button
                                type="button"
                                disabled={submittingReview}
                                onClick={() => handleRestoreFinding(selectedIndicator)}
                                className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-800 font-medium disabled:opacity-50"
                              >
                                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                                Reativar achado
                              </button>
                            </div>
                            <p className="text-slate-600">
                              Justificativa registrada ({dismissedEntry.author}): {dismissedEntry.rationale}
                            </p>
                          </div>
                        )}

                        <p className="text-sm text-slate-800 leading-relaxed">
                          {selectedIndicator.summary}
                        </p>

                        {/* Explicit Epistemic Boundary (not_a_conclusion) */}
                        <div className="p-3.5 rounded-md bg-slate-50 border border-slate-200 text-xs text-slate-700">
                          <span className="font-semibold text-slate-900">
                            Limite epistêmico (não é conclusão):
                          </span>{' '}
                          {selectedIndicator.notAConclusion}
                        </div>

                        <dl className="space-y-3 text-xs">
                          <div className="pb-3 border-b border-slate-100">
                            <dt className="font-semibold text-slate-500">Dados usados</dt>
                            <dd className="text-slate-900 mt-1">{selectedIndicator.dataUsed}</dd>
                          </div>
                          <div className="pb-3 border-b border-slate-100">
                            <dt className="font-semibold text-slate-500">Fonte primária</dt>
                            <dd className="text-slate-900 mt-1">{selectedIndicator.source}</dd>
                          </div>
                          <div className="pb-3 border-b border-slate-100">
                            <dt className="font-semibold text-slate-500">Cálculo reproduzível</dt>
                            <dd className="font-mono text-slate-900 bg-slate-50 border border-slate-200 rounded px-3 py-2 mt-1 break-words">
                              {selectedIndicator.calculation}
                            </dd>
                          </div>
                          {selectedIndicator.legalReference && (
                            <div className="pb-3 border-b border-slate-100">
                              <dt className="font-semibold text-slate-500">
                                Referência normativa ({selectedIndicator.legalRulesetVersion})
                              </dt>
                              <dd className="text-slate-900 mt-1">
                                {selectedIndicator.legalReference}
                              </dd>
                            </div>
                          )}
                        </dl>

                        {/* Alternative Hypotheses */}
                        {selectedIndicator.alternativeHypotheses.length > 0 && (
                          <div className="space-y-2">
                            <div className="text-xs font-semibold text-slate-600">
                              Hipóteses alternativas legítimas a verificar em diligência
                            </div>
                            <ul className="list-disc pl-5 space-y-1 text-xs text-slate-700">
                              {selectedIndicator.alternativeHypotheses.map((hyp) => (
                                <li key={hyp}>{hyp}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {linkedEvidences.length > 0 && (
                          <div className="space-y-2.5 pt-2">
                            <div className="text-xs font-semibold text-slate-600">
                              Evidência vinculada (Documento · Página · Trecho · SHA-256)
                            </div>
                            {linkedEvidences.map((ev) => (
                              <div
                                key={ev.id}
                                className="bg-slate-50 border border-slate-200 rounded-md p-3.5 text-xs space-y-1.5"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2 text-slate-600">
                                  <span className="font-semibold text-slate-900">
                                    {ev.id} · {ev.documentTitle}
                                  </span>
                                  <span className="font-mono tabular-nums">
                                    Página {ev.pageNumber}
                                  </span>
                                </div>
                                <blockquote className="text-slate-800 italic">
                                  “{ev.excerpt}”
                                </blockquote>
                                <div className="text-[11px] font-mono text-slate-500">
                                  Fonte: {ev.sourceSystem} · Regra: {ev.legalRulesetVersion} ·
                                  SHA-256: {ev.sha256.slice(0, 18)}…
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Auditor Dismissal Workflow (Persisted append-only with mandatory human rationale) */}
                        {!dismissedEntry && (
                          <div className="pt-4 border-t border-slate-200">
                            {dismissingCode === selectedIndicator.code ? (
                              <div className="space-y-2.5">
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                  <div className="sm:col-span-1">
                                    <label
                                      htmlFor="review-author"
                                      className="block text-xs font-semibold text-slate-800 mb-1"
                                    >
                                      Auditor(a)
                                    </label>
                                    <input
                                      id="review-author"
                                      type="text"
                                      value={reviewAuthorInput}
                                      onChange={(e) => setReviewAuthorInput(e.target.value)}
                                      className="w-full h-9 px-3 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
                                    />
                                  </div>
                                  <div className="sm:col-span-2">
                                    <label
                                      htmlFor="dismiss-rationale"
                                      className="block text-xs font-semibold text-slate-800 mb-1"
                                    >
                                      Justificativa técnica obrigatória (mín. 8 caracteres)
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
                                      className="w-full h-9 px-3 text-xs bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
                                    />
                                  </div>
                                </div>
                                {reviewError && (
                                  <p role="alert" className="text-xs text-red-700 font-medium">
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
                                    className="px-3 py-1.5 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-900 rounded-md disabled:opacity-50"
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
                                    className="px-3 py-1.5 text-xs text-slate-600 hover:text-slate-900"
                                  >
                                    Cancelar
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setDismissingCode(selectedIndicator.code)}
                                className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
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
            <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-4">
                <h2 className="text-sm font-semibold text-slate-900">
                  Verificações Não Aplicáveis ou Não Verificáveis ({assessment.nonApplicableChecks.length})
                </h2>
                <span className="text-xs text-slate-500">
                  Recusa explícita de inferência sem base legal ou amostra mínima
                </span>
              </div>
              <div className="divide-y divide-slate-200">
                {assessment.nonApplicableChecks.map((check) => {
                  const meta = getFindingStateMeta(check.state);
                  return (
                    <div
                      key={`${check.code}-${check.state}`}
                      className="px-5 py-3.5 flex flex-col md:flex-row md:items-start justify-between gap-3 text-xs"
                    >
                      <div className="space-y-0.5 max-w-3xl">
                        <div className="font-semibold text-slate-900">
                          <span className="font-mono text-slate-600 mr-2">{check.code}</span>
                          {check.title}
                        </div>
                        <p className="text-slate-600 leading-relaxed">{check.rationale}</p>
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
          {/* Horizontal Benchmarking Median/MAD */}
          <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="p-6 border-b border-slate-200">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-mono text-slate-500">
                    BENCH_HORIZONTAL_SUPPLIER_V1 · Estatística Robusta (Mediana e MAD)
                  </div>
                  <h2 className="text-base font-semibold text-slate-900 mt-1">
                    Benchmarking Horizontal Intermunicipal com Controle de Escopo e Inflação
                  </h2>
                  <p className="text-xs text-slate-600 mt-1 max-w-3xl">
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
                <div className="mt-5 p-4 rounded-md bg-slate-50 border border-slate-200 text-xs text-slate-600">
                  Não há grupo de pares homogêneos indexado para este contrato neste exercício
                  (estado <span className="font-mono font-semibold">NOT_VERIFIABLE</span>).
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-5 gap-5 mt-5 pt-5 border-t border-slate-200">
                    <div>
                      <div className="text-xs text-slate-500">Preço do contrato</div>
                      <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-900 whitespace-nowrap">
                        {formatCurrencyBRL(horizontalBenchmark.subjectAdjustedPrice)}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        por {horizontalBenchmark.unitLabel}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">Mediana dos pares</div>
                      <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-900 whitespace-nowrap">
                        {horizontalBenchmark.peerMedian !== null
                          ? formatCurrencyBRL(horizontalBenchmark.peerMedian)
                          : 'Recusado (n < 4)'}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {horizontalBenchmark.peerCount} incluído(s) ·{' '}
                        {horizontalBenchmark.excludedPeerCount} excluído(s)
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">MAD (Desvio Mediano)</div>
                      <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-900 whitespace-nowrap">
                        {horizontalBenchmark.mad !== null
                          ? formatCurrencyBRL(horizontalBenchmark.mad)
                          : '—'}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {horizontalBenchmark.inflationIndexApplied}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">Escore Z Robusto</div>
                      <div
                        className={`mt-1 text-base font-semibold font-mono tabular-nums whitespace-nowrap ${
                          horizontalBenchmark.robustZ !== null && horizontalBenchmark.robustZ >= 3
                            ? 'text-red-700'
                            : 'text-slate-900'
                        }`}
                      >
                        {horizontalBenchmark.robustZ !== null
                          ? `${horizontalBenchmark.robustZ.toFixed(2)}σ`
                          : '—'}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        Limiar de revisão: ≥ 3,00σ
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">Razão sobre Mediana</div>
                      <div
                        className={`mt-1 text-base font-semibold font-mono tabular-nums whitespace-nowrap ${
                          horizontalBenchmark.peerRatio !== null &&
                          horizontalBenchmark.peerRatio >= 1.3
                            ? 'text-red-700'
                            : 'text-slate-900'
                        }`}
                      >
                        {horizontalBenchmark.peerRatio !== null
                          ? `${horizontalBenchmark.peerRatio.toFixed(2)}×`
                          : '—'}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        Confiança {Math.round(horizontalBenchmark.confidence * 100)}%
                      </div>
                    </div>
                  </div>

                  <div className="mt-5 p-3.5 rounded-md bg-slate-50 border border-slate-200 text-xs text-slate-700 space-y-1">
                    <div className="font-medium text-slate-900">{horizontalBenchmark.statement}</div>
                    <div className="text-slate-600">{horizontalBenchmark.notAConclusion}</div>
                  </div>
                </>
              )}
            </div>

            {horizontalBenchmark && horizontalBenchmark.peers.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                      <th className="py-2.5 px-4">Município / Par</th>
                      <th className="py-2.5 px-4 whitespace-nowrap">Contrato</th>
                      <th className="py-2.5 px-4 text-right whitespace-nowrap">Nominal</th>
                      <th className="py-2.5 px-4 text-right whitespace-nowrap">Ajustado IPCA</th>
                      <th className="py-2.5 px-4 text-right whitespace-nowrap">Dist. Escopo</th>
                      <th className="py-2.5 px-4">Elegibilidade e Motivo</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-xs">
                    {horizontalBenchmark.peers.map((peer) => (
                      <tr key={peer.id} className={peer.included ? '' : 'bg-slate-50/70 text-slate-500'}>
                        <td className="py-3 px-4 font-medium text-slate-900">
                          {peer.municipalityName}/{peer.uf}
                          {peer.sameSupplier && (
                            <span className="ml-2 font-mono text-[11px] text-blue-700">
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
                        <td className="py-3 px-4 text-right font-mono tabular-nums font-medium text-slate-900 whitespace-nowrap">
                          {formatCurrencyBRL(peer.inflationAdjustedPrice)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                          {peer.scopeDistance.toFixed(2)}
                        </td>
                        <td className="py-3 px-4">
                          {peer.included ? (
                            <span className="text-emerald-700 font-medium">
                              Incluído na mediana
                            </span>
                          ) : (
                            <span className="text-amber-800">
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

          {/* Financial Execution Chain (CONTRATO -> EMPENHO -> LIQUIDAÇÃO -> PAGAMENTO -> COBRANÇA -> ENTREGA) */}
          <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Cadeia de Execução Financeira e Ordem Cronológica (Lei 14.133/2021, art. 141)
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Rastreamento distinto de Empenho, Liquidação, Pagamento, Instrumento de Cobrança e
                  Entrega/Medição.
                </p>
              </div>
              <span className={`text-xs ${chronoLabel.className}`}>{chronoLabel.text}</span>
            </div>

            {contract.payments.length === 0 ? (
              <div className="p-6 text-xs text-slate-500">
                Nenhum registro de execução financeira (empenho, liquidação ou pagamento) publicado
                na origem. A estimativa mensal contratual não comprova desembolso.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                      <th className="py-2.5 px-4">Estágio</th>
                      <th className="py-2.5 px-4">Documento</th>
                      <th className="py-2.5 px-4">Data</th>
                      <th className="py-2.5 px-4 text-right">Valor</th>
                      <th className="py-2.5 px-4">Fonte / Ordem Cronológica</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-xs">
                    {contract.payments.map((pay) => (
                      <tr key={pay.id}>
                        <td className="py-3 px-4 font-semibold text-slate-900 whitespace-nowrap">
                          {pay.type}
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-700 whitespace-nowrap">
                          {pay.documentNumber}
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                          {formatDateBR(pay.date)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                          {formatCurrencyBRL(pay.amount)}
                        </td>
                        <td className="py-3 px-4 text-slate-600">
                          <div>{pay.sourceSystem}</div>
                          {pay.paidOutOfOrder && (
                            <div
                              className={`mt-0.5 font-medium ${
                                pay.justificationPublished ? 'text-amber-700' : 'text-red-700'
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
            <section className="bg-white border border-slate-200 rounded-lg p-6">
              <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2 pb-4 border-b border-slate-200">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    Análise de Eficiência: Gasto × Entrega ({contract.productivity.domain})
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
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
                <span className="text-xs text-slate-500">
                  Parâmetro: {contract.productivity.benchmarkSource}
                </span>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 pt-5">
                <div>
                  <div className="text-xs text-slate-500">Output entregue / contratado</div>
                  <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-900">
                    {contract.productivity.deliveredOutput.toLocaleString('pt-BR')} /{' '}
                    {contract.productivity.contractedOutput.toLocaleString('pt-BR')}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {contract.productivity.unitLabel}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">Custo efetivo por entrega</div>
                  <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-900">
                    {formatCurrencyBRL(contract.productivity.actualUnitCost)}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    por {contract.productivity.unitLabel}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">Referência de produtividade</div>
                  <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-700">
                    {formatCurrencyBRL(contract.productivity.benchmarkUnitCost)}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    por {contract.productivity.unitLabel}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">
                    {contract.productivity.physicalProgressPct !== undefined
                      ? 'Avanço físico × financeiro'
                      : 'Desvio de custo unitário'}
                  </div>
                  {contract.productivity.physicalProgressPct !== undefined &&
                  contract.productivity.financialProgressPct !== undefined ? (
                    <>
                      <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-900">
                        {contract.productivity.physicalProgressPct}% físico ·{' '}
                        {contract.productivity.financialProgressPct}% financ.
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        Diferença:{' '}
                        {contract.productivity.financialProgressPct -
                          contract.productivity.physicalProgressPct}{' '}
                        p.p.
                      </div>
                    </>
                  ) : (
                    <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-amber-700">
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

      {/* TAB 3: GRAFO FOLLOWTHEMONEY + ESPELHO HORIZONTAL DE FORNECEDOR */}
      {activeTab === 'graph' && (
        <EntityGraphTab contract={contract} onSelectContract={onSelectContract} />
      )}

      {/* TAB 4: FORNECEDOR, RECEITA/CNPJ, QSA E SANÇÕES */}
      {activeTab === 'supplier' && (
        <div className="space-y-6">
          <section className="bg-white border border-slate-200 rounded-lg p-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-200">
              <div>
                <h2 className="text-lg font-bold text-slate-900">{contract.supplier.legalName}</h2>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                  <span className="font-mono tabular-nums text-slate-800 font-medium">
                    CNPJ {formatCnpj(contract.supplier.cnpj)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>Situação: {contract.supplier.registrationStatus}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Sede: {contract.supplier.municipality}/{contract.supplier.uf}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>Abertura: {formatDateBR(contract.supplier.openingDate)}</span>
                </div>
              </div>

              <button
                type="button"
                disabled={checkingCnpj}
                onClick={handleLiveCnpjCheck}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap disabled:opacity-60"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${checkingCnpj ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                {checkingCnpj ? 'Consultando Receita...' : 'Consultar Receita (Tempo Real)'}
              </button>
            </div>

            {liveCnpjResult && (
              <div className="mt-4 p-3.5 rounded-md bg-slate-50 border border-slate-200 text-xs text-slate-700">
                {liveCnpjResult.enriched ? (
                  <div>
                    <span className="font-semibold text-emerald-700">
                      Receita Federal verificada ({liveCnpjResult.source}):
                    </span>{' '}
                    {liveCnpjResult.legalName} · Situação {liveCnpjResult.registrationStatus} ·
                    CNAE {liveCnpjResult.primaryCnaeDescription}
                  </div>
                ) : (
                  <div>{liveCnpjResult.message}</div>
                )}
              </div>
            )}

            <dl className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-5 text-sm">
              <div>
                <dt className="text-xs text-slate-500">CNAE Principal</dt>
                <dd className="mt-1 font-medium text-slate-900">
                  <span className="font-mono">{contract.supplier.primaryCnaeCode}</span> —{' '}
                  {contract.supplier.primaryCnaeDescription}
                </dd>
                {contract.expectedCnaePrefixes.length > 0 && (
                  <div className="text-xs text-slate-500 mt-1">
                    Prefixos esperados para o objeto:{' '}
                    <span className="font-mono">{contract.expectedCnaePrefixes.join(', ')}</span>
                  </div>
                )}
              </div>
              <div>
                <dt className="text-xs text-slate-500">Capital Social</dt>
                <dd className="mt-1 font-mono tabular-nums font-semibold text-slate-900">
                  {formatCurrencyBRL(contract.supplier.shareCapital)}
                </dd>
                <div className="text-xs text-slate-500 mt-1">
                  Contratos ativos simultâneos: {contract.supplier.simultaneousActiveContracts}
                </div>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Histórico no Município</dt>
                <dd className="mt-1 font-mono tabular-nums font-semibold text-slate-900">
                  {contract.supplier.priorMunicipalContracts} contrato(s) anterior(es)
                </dd>
                <div className="text-xs text-slate-500 mt-1">
                  Proveniência: {contract.supplier.dataProvenance}
                </div>
              </div>
            </dl>
          </section>

          {/* Sanctions Table (with scope & temporal check) */}
          <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">
                Sanções e Impedimentos (Verificação Temporal × Abrangência)
              </h3>
              <span className="text-xs text-slate-500">
                {contract.supplier.sanctions.length} ocorrência(s)
              </span>
            </div>

            {contract.supplier.sanctions.length === 0 ? (
              <div className="p-6 text-sm text-emerald-800">
                Nada consta em cadastros federais de sanções (CEIS, CNEP, CEPIM, CEAF e TCU Inidôneos)
                para a data de assinatura ({formatDateBR(contract.signatureDate)}).
              </div>
            ) : (
              <div className="divide-y divide-slate-200">
                {contract.supplier.sanctions.map((s) => {
                  const activeOnSignature =
                    s.status === 'Ativa' &&
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
                            activeOnSignature ? 'text-red-700' : 'text-slate-700'
                          }`}
                        >
                          <ShieldAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
                          <span>
                            {s.registry} · Situação {s.status} · Abrangência {s.scope}
                            {s.scopeUf ? ` (${s.scopeUf})` : ''}
                          </span>
                        </div>
                        <p className="text-sm text-slate-900">{s.reason}</p>
                        <div className="text-xs text-slate-500">
                          Órgão sancionador: {s.sanctioningOrgan} · Fonte: {s.sourceSystem}
                        </div>
                      </div>
                      <div className="text-xs font-mono tabular-nums text-slate-700 shrink-0 md:text-right">
                        <div>
                          {formatDateBR(s.startDate)} a {formatDateBR(s.endDate)}
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-500">
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
          <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200">
              <h3 className="text-sm font-semibold text-slate-900">
                Quadro de Sócios e Administradores (QSA) — Verificação STF Tema 1001
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-5">Nome</th>
                    <th className="py-2.5 px-5">Qualificação</th>
                    <th className="py-2.5 px-5">CPF/CNPJ</th>
                    <th className="py-2.5 px-5">Entrada</th>
                    <th className="py-2.5 px-5">Cruzamento de Vínculos</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {contract.supplier.shareholders.map((sh) => (
                    <tr key={sh.name}>
                      <td className="py-3 px-5 font-medium text-slate-900">{sh.name}</td>
                      <td className="py-3 px-5 text-slate-600">{sh.role}</td>
                      <td className="py-3 px-5 font-mono text-xs text-slate-600">
                        {sh.maskedCpfCnpj}
                      </td>
                      <td className="py-3 px-5 font-mono text-xs tabular-nums text-slate-600">
                        {formatDateBR(sh.entryDate)}
                      </td>
                      <td className="py-3 px-5 text-xs">
                        {sh.isPublicServantOverlap ? (
                          <span className="text-amber-800 font-semibold">
                            Potencial conflito (STF Tema 1001 — verificar estatuto local):{' '}
                            {sh.overlapDetail}
                          </span>
                        ) : (
                          <span className="text-slate-500">Sem vínculo funcional detectado</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* TAB 5: ITENS, COMPARAÇÃO DE PREÇOS E ADITIVOS */}
      {activeTab === 'financials' && (
        <div className="space-y-6">
          {/* Items vs Reference Prices */}
          <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Itens Contratados × Preços de Referência (Painel de Preços / SINAPI / BPS)
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Desvio médio ponderado da cesta:{' '}
                  <span
                    className={`font-mono font-semibold ${
                      assessment.weightedPriceDeviationPct >= 15
                        ? 'text-red-700'
                        : 'text-emerald-700'
                    }`}
                  >
                    {formatPercentageBR(assessment.weightedPriceDeviationPct, true)}
                  </span>
                </p>
              </div>
            </div>

            {contract.items.length === 0 ? (
              <div className="p-6 text-sm text-slate-500">
                Planilha detalhada de itens não publicada na origem para este contrato.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                      <th className="py-2.5 px-4">#</th>
                      <th className="py-2.5 px-4">Descrição do Item</th>
                      <th className="py-2.5 px-4 text-right">Qtd</th>
                      <th className="py-2.5 px-4 text-right">Unit. Contratado</th>
                      <th className="py-2.5 px-4 text-right">Referência</th>
                      <th className="py-2.5 px-4 text-right">Desvio</th>
                      <th className="py-2.5 px-4">Base</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {contract.items.map((item) => {
                      const dev =
                        item.referencePrice > 0
                          ? ((item.unitPrice - item.referencePrice) / item.referencePrice) * 100
                          : 0;
                      return (
                        <tr key={item.id}>
                          <td className="py-3 px-4 font-mono text-xs text-slate-500">
                            {item.itemNumber}
                          </td>
                          <td className="py-3 px-4 text-slate-900 max-w-md">{item.description}</td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-xs text-slate-700 whitespace-nowrap">
                            {item.quantity.toLocaleString('pt-BR')} {item.unit}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums font-medium text-slate-900 whitespace-nowrap">
                            {formatCurrencyBRL(item.unitPrice)}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                            {formatCurrencyBRL(item.referencePrice)}
                          </td>
                          <td
                            className={`py-3 px-4 text-right font-mono tabular-nums font-semibold whitespace-nowrap ${
                              dev >= 20
                                ? 'text-red-700'
                                : dev >= 10
                                  ? 'text-amber-700'
                                  : 'text-emerald-700'
                            }`}
                          >
                            {formatPercentageBR(dev, true)}
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-600 whitespace-nowrap">
                            {item.referenceSource}
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
          <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">
                Termos Aditivos ({contract.amendments.length})
              </h3>
              <span className="text-xs font-mono tabular-nums text-slate-500">
                Acumulado: {formatPercentageBR(assessment.amendmentTotalPct, true)}
              </span>
            </div>
            {contract.amendments.length === 0 ? (
              <div className="p-6 text-sm text-slate-500">
                Nenhum termo aditivo registrado até o momento.
              </div>
            ) : (
              <div className="divide-y divide-slate-200">
                {contract.amendments.map((ad) => (
                  <div key={ad.id} className="p-4 space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-semibold text-slate-900">
                        {ad.number} · {ad.type}
                      </span>
                      <span className="font-mono tabular-nums font-semibold text-red-700">
                        +{formatCurrencyBRL(ad.addedValue)}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600">{ad.justification}</p>
                    <div className="text-[11px] font-mono text-slate-500">
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

      {/* TAB 6: FONTES (SEM SOBRESCRITA) E DOCUMENTOS (SHA-256 / EVIDENCE STORE) */}
      {activeTab === 'sources_docs' && (
        <div className="space-y-6">
          {/* Source Reconciliation */}
          <section className="bg-white border border-slate-200 rounded-lg p-6">
            <h2 className="text-base font-semibold text-slate-900">
              Reconciliação Multifonte com Preservação de Proveniência
            </h2>
            <p className="text-xs text-slate-600 mt-1 max-w-3xl">
              Nenhuma fonte pública sobrescreve outra. Os registros do PNCP, Portal da Transparência
              Municipal, TCE estadual e PDFs importados são mantidos lado a lado para apuração
              explícita de divergências.
            </p>

            {assessment.divergences.length > 0 && (
              <div className="mt-5 space-y-3">
                {assessment.divergences.map((div) => (
                  <div
                    key={div.field}
                    className="p-4 rounded-md bg-amber-50/70 border border-amber-200 space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-sm font-semibold text-slate-900">
                        Divergência em: {div.field}
                      </span>
                      <SeverityText severity={div.severity} />
                    </div>
                    <p className="text-xs text-slate-700">{div.deltaDescription}</p>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono text-slate-800 pt-1">
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

            <div className="mt-6 overflow-x-auto border border-slate-200 rounded-md">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-4">Sistema Origem</th>
                    <th className="py-2.5 px-4">ID Externo</th>
                    <th className="py-2.5 px-4 text-right">Valor Original</th>
                    <th className="py-2.5 px-4 text-right">Valor Atualizado</th>
                    <th className="py-2.5 px-4">Situação</th>
                    <th className="py-2.5 px-4">Coleta</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {contract.sourceRecords.map((src) => (
                    <tr key={src.id}>
                      <td className="py-3 px-4 font-semibold text-slate-900 whitespace-nowrap">
                        {src.sourceSystem}
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-slate-600 whitespace-nowrap">
                        {src.externalId}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                        {formatCurrencyBRL(src.reportedOriginalValue)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                        {formatCurrencyBRL(src.reportedUpdatedValue)}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-700">{src.reportedStatus}</td>
                      <td className="py-3 px-4 font-mono text-xs text-slate-500 whitespace-nowrap">
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
            <section className="bg-white border border-slate-200 rounded-lg p-8 text-center text-sm text-slate-500">
              Nenhum arquivo PDF anexado automaticamente na origem PNCP. Utilize a aba Documento para
              importar o contrato manualmente.
            </section>
          ) : (
            contract.documents.map((doc) => (
              <section
                key={doc.id}
                className="bg-white border border-slate-200 rounded-lg overflow-hidden"
              >
                <div className="p-5 border-b border-slate-200 flex flex-col md:flex-row md:items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="text-xs text-slate-500">
                      {doc.documentType} · {doc.sourceSystem} · {formatBytes(doc.sizeBytes)}
                    </div>
                    <h3 className="text-base font-semibold text-slate-900">{doc.title}</h3>
                    <div className="text-xs font-mono text-slate-500 break-all">
                      SHA-256: {doc.sha256}
                    </div>
                  </div>
                  <div className="text-xs text-slate-600 md:text-right shrink-0 space-y-0.5 font-mono">
                    <div>Extrator: {doc.extractionSummary.extractorVersion}</div>
                    <div>
                      Páginas: {doc.extractionSummary.totalPages} total ·{' '}
                      {doc.extractionSummary.doclingPages + doc.extractionSummary.nativePages} nativo
                      · {doc.extractionSummary.ocrPages} OCR
                    </div>
                  </div>
                </div>

                <div className="divide-y divide-slate-200">
                  {doc.pages.map((page) => (
                    <div key={`${doc.id}-p${page.pageNumber}`} className="p-5 space-y-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="font-mono font-semibold text-slate-800">
                          Página {page.pageNumber}
                        </span>
                        <span className="font-mono text-slate-500">
                          método={page.extractionMethod} · confiança={Math.round(page.confidence * 100)}%
                        </span>
                      </div>
                      <p className="text-xs text-slate-700 leading-relaxed font-mono bg-slate-50 border border-slate-200 rounded p-3">
                        {page.text}
                      </p>
                      {page.highlights.length > 0 && (
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                          {page.highlights.map((h, i) => (
                            <span key={`${h.field}-${i}`}>
                              <span className="font-mono text-blue-700">{h.field}</span> ={' '}
                              <span className="font-mono text-slate-900">{h.normalizedValue}</span>
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

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Cpu,
  Download,
  FileUp,
  ShieldCheck,
} from 'lucide-react';
import type { EvaluatedContract } from '../types/audit';
import {
  fetchOcrStatus,
  uploadContractDocument,
  type DocumentUploadResponse,
  type OcrStatusResponse,
} from '../lib/api';
import { formatCnpj, formatCurrencyBRL } from '../lib/formatters';
import { notificationService } from '../lib/notificationService';
import { RiskScoreInline } from './RiskText';

interface DocumentUploadViewProps {
  onSelectContract: (contract: EvaluatedContract) => void;
}

export function DocumentUploadView({ onSelectContract }: DocumentUploadViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [forceOcr, setForceOcr] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DocumentUploadResponse | null>(null);
  const [batchResults, setBatchResults] = useState<
    Array<{ fileName: string; response?: DocumentUploadResponse; error?: string }>
  >([]);
  const [ocrStatus, setOcrStatus] = useState<OcrStatusResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchOcrStatus()
      .then((status) => {
        if (!cancelled) setOcrStatus(status);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    setError(null);
    if (files.length === 0) {
      setSelectedFiles([]);
      return;
    }
    const oversized = files.find((file) => file.size > 25 * 1024 * 1024);
    if (oversized) {
      setError(`O arquivo "${oversized.name}" excede o limite de 25 MB.`);
      setSelectedFiles([]);
      return;
    }
    setSelectedFiles(files);
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedFiles.length === 0) {
      setError(
        'Selecione um ou mais documentos de contrato (PDF, PNG, JPEG, WEBP, TIFF ou TXT) antes de iniciar.'
      );
      return;
    }

    setProcessing(true);
    setError(null);
    setBatchResults([]);
    setBatchProgress(selectedFiles.length > 1 ? { current: 0, total: selectedFiles.length } : null);

    try {
      if (selectedFiles.length === 1) {
        const response = await uploadContractDocument(selectedFiles[0], forceOcr);
        setResult(response);
        notificationService.notifyHighRiskBatch([response.contract], {
          sourceLabel: `Análise Documental (${selectedFiles[0].name})`,
          batchKey: `doc-upload:${response.sha256}:${Date.now()}`,
          onOpenContract: onSelectContract,
        });
      } else {
        const outcomes: Array<{
          fileName: string;
          response?: DocumentUploadResponse;
          error?: string;
        }> = [];
        const evaluatedContracts: EvaluatedContract[] = [];

        for (let i = 0; i < selectedFiles.length; i += 1) {
          const file = selectedFiles[i];
          setBatchProgress({ current: i + 1, total: selectedFiles.length });
          try {
            const response = await uploadContractDocument(file, forceOcr);
            outcomes.push({ fileName: file.name, response });
            evaluatedContracts.push(response.contract);
          } catch (fileErr) {
            outcomes.push({
              fileName: file.name,
              error: fileErr instanceof Error ? fileErr.message : 'Erro ao processar arquivo.',
            });
          }
        }

        setBatchResults(outcomes);
        const firstSuccess = outcomes.find((o) => o.response)?.response ?? null;
        setResult(firstSuccess);

        if (evaluatedContracts.length > 0) {
          notificationService.notifyHighRiskBatch(evaluatedContracts, {
            sourceLabel: `Análise em Lote (${selectedFiles.length} documentos)`,
            batchKey: `doc-batch:${Date.now()}:${evaluatedContracts.map((c) => c.id).join(',')}`,
            onOpenContract: onSelectContract,
          });
        }

        const failedCount = outcomes.filter((o) => o.error).length;
        if (failedCount === outcomes.length) {
          setError('Nenhum documento do lote pôde ser processado.');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao processar o documento.');
    } finally {
      setProcessing(false);
      setBatchProgress(null);
    }
  };

  return (
    <div className="space-y-6">
      <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6">
        <div className="mb-5">
          <h1 className="text-2xl font-bold tracking-tight text-[#0B2540] dark:text-[#FAF9F5]">
            Ingestão Documental e Motor Híbrido de OCR
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 mt-1 max-w-3xl">
            Envie um contrato em PDF, imagem digitalizada (PNG, JPEG, WEBP, TIFF) ou extrato TXT.
            Os bytes originais são preservados em armazenamento endereçado por SHA-256 antes da
            extração, com roteamento em camadas e proteção anti zip-bomb.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Upload Form */}
          <form onSubmit={handleUploadSubmit} className="lg:col-span-7 space-y-4">
            <div className="border border-dashed border-slate-300 dark:border-[#1D3A57] rounded-lg p-6 bg-[#FAF9F5] dark:bg-[#061321]">
              <div className="flex items-start gap-4">
                <FileUp className="w-6 h-6 text-[#D95B35] shrink-0 mt-0.5" aria-hidden="true" />
                <div className="flex-1 min-w-0">
                  <label
                    htmlFor="contract-file-input"
                    className="block text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5] cursor-pointer"
                  >
                    Selecionar arquivo(s) de contrato (individual ou em lote · máx. 25 MB cada)
                  </label>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    Selecione um ou múltiplos documentos (PDF, PNG, JPG, WEBP, TIFF ou TXT). Contratos
                    de alto risco detectados em lote disparam alerta imediato ao auditor.
                  </p>
                  <input
                    ref={fileInputRef}
                    id="contract-file-input"
                    type="file"
                    multiple
                    accept=".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff,.txt,application/pdf,image/png,image/jpeg,image/webp,image/tiff,text/plain"
                    onChange={handleFileChange}
                    className="mt-3 block w-full text-xs text-slate-600 dark:text-slate-300 file:mr-3 file:py-2 file:px-3.5 file:rounded-md file:border file:border-slate-300 dark:file:border-[#1D3A57] file:text-xs file:font-semibold file:bg-white dark:file:bg-[#0B1D31] file:text-[#0B2540] dark:file:text-[#FAF9F5] hover:file:bg-[#E8F1F6] dark:hover:file:bg-[#102843]"
                  />
                  {selectedFiles.length === 1 && (
                    <div className="mt-3 text-xs text-[#0B2540] dark:text-slate-200 font-mono">
                      Arquivo selecionado: {selectedFiles[0].name} (
                      {(selectedFiles[0].size / 1024).toFixed(1)} KB)
                    </div>
                  )}
                  {selectedFiles.length > 1 && (
                    <div className="mt-3 space-y-1">
                      <div className="text-xs font-semibold text-[#0B2540] dark:text-slate-200">
                        Lote selecionado: {selectedFiles.length} documento(s)
                      </div>
                      <ul className="text-[11px] font-mono text-slate-600 dark:text-slate-400 space-y-0.5 max-h-24 overflow-y-auto">
                        {selectedFiles.map((f) => (
                          <li key={`${f.name}-${f.size}`}>
                            · {f.name} ({(f.size / 1024).toFixed(1)} KB)
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={forceOcr}
                  onChange={(e) => setForceOcr(e.target.checked)}
                  className="rounded border-slate-300 dark:border-[#1D3A57] text-[#D95B35] focus:ring-[#D95B35]"
                />
                Forçar OCR externo (páginas digitalizadas ou carimbos)
              </label>

              <button
                type="submit"
                disabled={processing}
                className="px-5 py-2.5 text-sm font-semibold text-white bg-[#0B2540] hover:bg-[#102843] dark:bg-[#D95B35] dark:hover:bg-[#c04c29] disabled:opacity-60 rounded-md transition-colors whitespace-nowrap"
              >
                {processing
                  ? batchProgress
                    ? `Processando lote (${batchProgress.current}/${batchProgress.total})...`
                    : 'Processando pipeline...'
                  : selectedFiles.length > 1
                    ? `Auditar Lote (${selectedFiles.length} documentos)`
                    : 'Ingerir e Auditar Documento'}
              </button>
            </div>
          </form>

          {/* Live OCR Architecture & Status (Honest Real-Time Telemetry — zero sample presets) */}
          <div className="lg:col-span-5 border-t lg:border-t-0 lg:border-l border-slate-200 dark:border-[#1D3A57] pt-5 lg:pt-0 lg:pl-6 space-y-3">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-[#D95B35]" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                Arquitetura e Status do Motor de OCR
              </h2>
            </div>

            {ocrStatus ? (
              <div className="space-y-2.5 text-xs">
                <div className="p-3 rounded-md border border-slate-200 dark:border-[#1D3A57] bg-[#FAF9F5] dark:bg-[#061321] flex items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                      Tier 0 · PDF Nativo &amp; UTF-8
                    </div>
                    <div className="text-slate-500 dark:text-slate-400 mt-0.5">
                      FlateDecode com orçamento anti zip-bomb
                    </div>
                  </div>
                  <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-400">
                    ATIVO
                  </span>
                </div>

                <div className="p-3 rounded-md border border-slate-200 dark:border-[#1D3A57] bg-[#FAF9F5] dark:bg-[#061321] flex items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                      Tier 1a · Docling Serve
                    </div>
                    <div className="text-slate-500 dark:text-slate-400 mt-0.5">
                      {ocrStatus.doclingServe.detail}
                    </div>
                  </div>
                  <span
                    className={`font-mono font-semibold ${
                      ocrStatus.doclingServe.reachable
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    {ocrStatus.doclingServe.reachable ? 'ONLINE' : 'OFFLINE'}
                  </span>
                </div>

                <div className="p-3 rounded-md border border-slate-200 dark:border-[#1D3A57] bg-[#FAF9F5] dark:bg-[#061321] flex items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                      Tier 1b · Worker PaddleOCR PT-BR
                    </div>
                    <div className="text-slate-500 dark:text-slate-400 mt-0.5">
                      {ocrStatus.paddleOcr.detail}
                    </div>
                  </div>
                  <span
                    className={`font-mono font-semibold ${
                      ocrStatus.paddleOcr.reachable
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    {ocrStatus.paddleOcr.reachable ? 'ONLINE' : 'OFFLINE'}
                  </span>
                </div>

                <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed pt-1">
                  {ocrStatus.note}
                </p>
              </div>
            ) : (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Verificando disponibilidade dos motores OCR...
              </div>
            )}
          </div>
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

      {/* Batch Summary Table when multiple documents were processed */}
      {batchResults.length > 1 && (
        <section
          data-testid="batch-upload-summary"
          aria-label="Resumo da análise em lote de documentos"
          className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg overflow-hidden"
        >
          <div className="px-6 py-4 border-b border-slate-200 dark:border-[#1D3A57] flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                Resultado da Análise em Lote ({batchResults.length} documentos)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Selecione qualquer contrato do lote para inspecionar os detalhes ou abrir o dossiê
                completo.
              </p>
            </div>
          </div>
          <div className="divide-y divide-slate-200 dark:divide-[#1D3A57]">
            {batchResults.map((entry, idx) => (
              <div
                key={`${entry.fileName}-${idx}`}
                className="px-6 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-[#FAF9F5] dark:hover:bg-[#102843]/40 transition-colors"
              >
                <div className="min-w-0">
                  <div className="text-xs font-mono font-semibold text-[#0B2540] dark:text-[#FAF9F5] truncate">
                    {entry.fileName}
                  </div>
                  {entry.response ? (
                    <div className="text-xs text-slate-600 dark:text-slate-300 mt-0.5 truncate">
                      Contrato {entry.response.contract.contractNumber} ·{' '}
                      {entry.response.contract.municipalityName}
                      {entry.response.contract.uf ? `/${entry.response.contract.uf}` : ''}
                    </div>
                  ) : (
                    <div className="text-xs text-red-700 dark:text-red-400 mt-0.5">
                      {entry.error}
                    </div>
                  )}
                </div>

                {entry.response && (
                  <div className="flex items-center gap-3 shrink-0">
                    <RiskScoreInline
                      score={entry.response.contract.assessment.score}
                      coverageStatus={entry.response.contract.assessment.coverageStatus}
                    />
                    <button
                      type="button"
                      onClick={() => setResult(entry.response!)}
                      className="px-2.5 py-1.5 text-xs font-medium text-[#0B2540] dark:text-slate-200 border border-slate-300 dark:border-[#1D3A57] rounded-md hover:bg-[#E8F1F6] dark:hover:bg-[#102843]"
                    >
                      Detalhes
                    </button>
                    <button
                      type="button"
                      onClick={() => onSelectContract(entry.response!.contract)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-[#0B2540] dark:bg-[#D95B35] rounded-md hover:opacity-90"
                    >
                      Dossiê
                      <ArrowRight className="w-3 h-3" aria-hidden="true" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Pipeline Result & Provenance */}
      {result && (
        <section
          aria-label="Resultado do pipeline documental"
          className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg overflow-hidden"
        >
          <div className="p-6 border-b border-slate-200 dark:border-[#1D3A57] flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                <ShieldCheck className="w-4 h-4" aria-hidden="true" />
                <span>Cadeia de custódia e extração concluídas</span>
              </div>
              <h2 className="text-lg font-bold text-[#0B2540] dark:text-[#FAF9F5] mt-1">
                Contrato {result.contract.contractNumber} — {result.contract.municipalityName}
                {result.contract.uf ? `/${result.contract.uf}` : ''}
              </h2>
              <div className="text-xs font-mono text-slate-500 dark:text-slate-400 mt-1 break-all">
                SHA-256: {result.sha256}
              </div>
              {result.originalDownloadUrl && (
                <a
                  href={result.originalDownloadUrl}
                  download
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#D95B35] hover:underline mt-2"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  Baixar arquivo original preservado (SHA-256 verificado)
                </a>
              )}
            </div>

            <div className="flex flex-col items-start md:items-end gap-2 shrink-0">
              <RiskScoreInline
                score={result.contract.assessment.score}
                coverageStatus={result.contract.assessment.coverageStatus}
              />
              <button
                type="button"
                onClick={() => onSelectContract(result.contract)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#0B2540] dark:bg-[#D95B35] hover:opacity-90 rounded-md transition-colors whitespace-nowrap"
              >
                Abrir Dossiê Completo
                <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>

          {result.ocrTelemetry?.truncated && (
            <div className="px-6 py-3 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>
                Cobertura parcial de páginas: {result.ocrTelemetry.processedPageCount} de{' '}
                {result.ocrTelemetry.originalPageCount} páginas foram processadas dentro do orçamento
                seguro.
              </span>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 dark:divide-[#1D3A57]">
            {/* Stage Trace */}
            <div className="lg:col-span-5 p-6 space-y-4">
              <h3 className="text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                Etapas executadas
              </h3>
              <ol className="space-y-3.5">
                {result.pipelineSteps.map((step, idx) => (
                  <li key={`${step.stage}-${idx}`} className="flex items-start gap-3">
                    <CheckCircle2
                      className={`w-4 h-4 shrink-0 mt-0.5 ${
                        step.status === 'ok'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-amber-600 dark:text-amber-400'
                      }`}
                      aria-hidden="true"
                    />
                    <div>
                      <div className="text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                        0{idx + 1}. {step.stage}
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">
                        {step.detail}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            {/* Extracted Normalized Fields */}
            <div className="lg:col-span-7 p-6 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                  Campos extraídos e normalizados
                </h3>
                <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
                  Método: {result.extraction.extractionMethod} · Confiança{' '}
                  {Math.round(result.extraction.confidence * 100)}%
                </span>
              </div>

              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-xs">
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Nº Contrato</dt>
                  <dd className="font-mono font-semibold text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                    {result.extraction.contractNumber ?? result.contract.contractNumber}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">CNPJ Fornecedor</dt>
                  <dd className="font-mono font-semibold text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                    {result.extraction.cnpj || result.contract.supplier.cnpj
                      ? formatCnpj(result.extraction.cnpj ?? result.contract.supplier.cnpj)
                      : 'Não identificado no documento'}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Valor Original Extraído</dt>
                  <dd className="font-mono tabular-nums font-semibold text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                    {result.extraction.originalValue
                      ? formatCurrencyBRL(result.extraction.originalValue)
                      : result.contract.originalValue > 0
                        ? formatCurrencyBRL(result.contract.originalValue)
                        : 'Não divulgado na origem'}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Cruzamento PNCP</dt>
                  <dd className="font-medium text-[#0B2540] dark:text-[#FAF9F5] mt-0.5">
                    {result.matchedPncp
                      ? `Reconciliado (${result.contract.pncpControlNumber})`
                      : 'Não consultado no PNCP — dossiê documental'}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-slate-500 dark:text-slate-400">Objeto Identificado</dt>
                  <dd className="text-[#0B2540] dark:text-slate-200 mt-0.5">
                    {result.extraction.object ?? result.contract.object}
                  </dd>
                </div>
              </dl>

              {result.extraction.excerpts.length > 0 && (
                <div className="pt-3 border-t border-slate-100 dark:border-[#1D3A57]">
                  <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">
                    Trechos Probatórios Capturados
                  </div>
                  <div className="space-y-1.5">
                    {result.extraction.excerpts.slice(0, 4).map((ex, i) => (
                      <div
                        key={`${ex.field}-${i}`}
                        className="text-xs text-slate-700 dark:text-slate-200 font-mono bg-[#FAF9F5] dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] rounded px-2.5 py-1.5"
                      >
                        <span className="text-slate-500 dark:text-slate-400">
                          p.{ex.pageNumber} [{ex.field}]
                        </span>{' '}
                        — “{ex.excerpt}”
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

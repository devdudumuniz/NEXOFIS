import { useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, FileText, FileUp, ShieldCheck } from 'lucide-react';
import type { EvaluatedContract } from '../types/audit';
import {
  ingestSampleDocument,
  uploadContractDocument,
  type DocumentUploadResponse,
} from '../lib/api';
import { formatCnpj, formatCurrencyBRL } from '../lib/formatters';
import { RiskScoreInline } from './RiskText';

interface DocumentUploadViewProps {
  onSelectContract: (contract: EvaluatedContract) => void;
}

export function DocumentUploadView({ onSelectContract }: DocumentUploadViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [forceOcr, setForceOcr] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DocumentUploadResponse | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setError(null);
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('O arquivo excede o limite de 10 MB.');
      setSelectedFile(null);
      return;
    }
    setSelectedFile(file);
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) {
      setError('Selecione um documento de contrato (PDF, imagem digitalizada ou TXT) antes de iniciar.');
      return;
    }

    setProcessing(true);
    setError(null);
    try {
      const response = await uploadContractDocument(selectedFile, forceOcr);
      setResult(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao processar o documento.');
    } finally {
      setProcessing(false);
    }
  };

  const handleRunSample = async (
    sampleType: 'fsa-123-scan' | 'fsa-087-native' | 'bdc-fms-list'
  ) => {
    setProcessing(true);
    setError(null);
    try {
      const response = await ingestSampleDocument(sampleType);
      setResult(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao executar demonstração do pipeline.');
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="mb-5">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Pipeline Documental em 4 Níveis (Nativo → Docling → PaddleOCR)
          </h1>
          <p className="text-sm text-slate-600 mt-1 max-w-3xl">
            Envie um contrato em PDF, imagem digitalizada ou extrato textual. O original é preservado
            com hash criptográfico SHA-256, roteado por camada (texto nativo → Docling → fallback
            seletivo PaddleOCR / PP-StructureV3 apenas para páginas escaneadas) e cruzado com PNCP,
            Receita/CNPJ, sanções vigentes e regras jurídicas temporais.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Upload Form */}
          <form onSubmit={handleUploadSubmit} className="lg:col-span-7 space-y-4">
            <div className="border border-dashed border-slate-300 rounded-lg p-6 bg-slate-50/70">
              <div className="flex items-start gap-4">
                <FileUp className="w-6 h-6 text-blue-700 shrink-0 mt-0.5" aria-hidden="true" />
                <div className="flex-1 min-w-0">
                  <label
                    htmlFor="contract-file-input"
                    className="block text-sm font-semibold text-slate-900 cursor-pointer"
                  >
                    Selecionar arquivo do contrato (PDF, PNG, JPG ou TXT · máx. 10 MB)
                  </label>
                  <p className="text-xs text-slate-500 mt-1">
                    Se o PDF possuir camada textual válida, a extração ocorre diretamente sem custo
                    de OCR.
                  </p>
                  <input
                    ref={fileInputRef}
                    id="contract-file-input"
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg,.txt,application/pdf,image/png,image/jpeg,text/plain"
                    onChange={handleFileChange}
                    className="mt-3 block w-full text-xs text-slate-600 file:mr-3 file:py-2 file:px-3.5 file:rounded-md file:border file:border-slate-300 file:text-xs file:font-semibold file:bg-white file:text-slate-800 hover:file:bg-slate-50"
                  />
                  {selectedFile && (
                    <div className="mt-3 text-xs text-slate-700 font-mono">
                      Arquivo pronto: {selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={forceOcr}
                  onChange={(e) => setForceOcr(e.target.checked)}
                  className="rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                />
                Forçar OCR seletivo (páginas escaneadas ou carimbos manuscritos)
              </label>

              <button
                type="submit"
                disabled={processing}
                className="px-5 py-2.5 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-md transition-colors whitespace-nowrap"
              >
                {processing ? 'Processando pipeline...' : 'Ingerir e Auditar Documento'}
              </button>
            </div>
          </form>

          {/* Instant Reproducible Samples */}
          <div className="lg:col-span-5 border-t lg:border-t-0 lg:border-l border-slate-200 pt-5 lg:pt-0 lg:pl-6 space-y-3">
            <h2 className="text-sm font-semibold text-slate-900">
              Testar Fluxo com Documentos de Referência
            </h2>
            <p className="text-xs text-slate-500 leading-relaxed">
              Execute o pipeline completo (SHA-256, extração de campos, cruzamento PNCP e motor de
              risco) utilizando extratos reais de demonstração:
            </p>

            <div className="space-y-2.5 pt-1">
              <button
                type="button"
                disabled={processing}
                onClick={() => handleRunSample('fsa-123-scan')}
                className="w-full text-left p-3.5 rounded-md border border-slate-200 hover:border-blue-600 hover:bg-blue-50/40 transition-colors disabled:opacity-60"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-900">
                    Contrato 123/2026 — PDF Digitalizado (OCR Seletivo)
                  </span>
                  <FileText className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  SMS Feira de Santana · Executa fallback PaddleOCR + cruzamento PNCP/CEIS
                </div>
              </button>

              <button
                type="button"
                disabled={processing}
                onClick={() => handleRunSample('fsa-087-native')}
                className="w-full text-left p-3.5 rounded-md border border-slate-200 hover:border-blue-600 hover:bg-blue-50/40 transition-colors disabled:opacity-60"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-900">
                    Contrato 087/2026 — PDF Nativo (Docling Direto)
                  </span>
                  <FileText className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  SEDUC Feira de Santana · Extração nativa sem OCR + análise QSA e merenda
                </div>
              </button>

              <button
                type="button"
                disabled={processing}
                onClick={() => handleRunSample('bdc-fms-list')}
                className="w-full text-left p-3.5 rounded-md border border-slate-200 hover:border-blue-600 hover:bg-blue-50/40 transition-colors disabled:opacity-60"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-900">
                    Relação de Contratos — Sec. Saúde Barra do Choça (Multi-Contrato)
                  </span>
                  <FileText className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  Tabela 28/05/2026 (IN011, IN012/2026FMS, IN013, DL056) · Indexação em lote + CNAE Receita
                </div>
              </button>
            </div>
          </div>
        </div>
      </section>

      {error && (
        <div role="alert" className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* Pipeline Result & Provenance */}
      {result && (
        <section
          aria-label="Resultado do pipeline documental"
          className="bg-white border border-slate-200 rounded-lg overflow-hidden"
        >
          <div className="p-6 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-xs font-medium text-emerald-700">
                <ShieldCheck className="w-4 h-4" aria-hidden="true" />
                <span>Cadeia de custódia e extração concluídas</span>
              </div>
              <h2 className="text-lg font-bold text-slate-900 mt-1">
                Contrato {result.contract.contractNumber} — {result.contract.municipalityName}/
                {result.contract.uf}
              </h2>
              <div className="text-xs font-mono text-slate-500 mt-1 break-all">
                SHA-256: {result.sha256}
              </div>
            </div>

            <div className="flex flex-col items-start md:items-end gap-2 shrink-0">
              <RiskScoreInline score={result.contract.assessment.score} />
              <button
                type="button"
                onClick={() => onSelectContract(result.contract)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap"
              >
                Abrir Dossiê Completo
                <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
            {/* Stage Trace */}
            <div className="lg:col-span-5 p-6 space-y-4">
              <h3 className="text-sm font-semibold text-slate-900">
                Etapas executadas
              </h3>
              <ol className="space-y-3.5">
                {result.pipelineSteps.map((step, idx) => (
                  <li key={step.stage} className="flex items-start gap-3">
                    <CheckCircle2
                      className={`w-4 h-4 shrink-0 mt-0.5 ${
                        step.status === 'ok' ? 'text-emerald-600' : 'text-amber-600'
                      }`}
                      aria-hidden="true"
                    />
                    <div>
                      <div className="text-sm font-semibold text-slate-900">
                        0{idx + 1}. {step.stage}
                      </div>
                      <p className="text-xs text-slate-600 mt-0.5">{step.detail}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            {/* Extracted Normalized Fields */}
            <div className="lg:col-span-7 p-6 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-900">
                  Campos extraídos e normalizados
                </h3>
                <span className="text-xs font-mono text-slate-500">
                  Método: {result.extraction.extractionMethod} · Confiança{' '}
                  {Math.round(result.extraction.confidence * 100)}%
                </span>
              </div>

              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-xs">
                <div>
                  <dt className="text-slate-500">Nº Contrato</dt>
                  <dd className="font-mono font-semibold text-slate-900 mt-0.5">
                    {result.extraction.contractNumber ?? result.contract.contractNumber}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">CNPJ Fornecedor</dt>
                  <dd className="font-mono font-semibold text-slate-900 mt-0.5">
                    {formatCnpj(result.extraction.cnpj ?? result.contract.supplier.cnpj)}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Valor Original Extraído</dt>
                  <dd className="font-mono tabular-nums font-semibold text-slate-900 mt-0.5">
                    {result.extraction.originalValue
                      ? formatCurrencyBRL(result.extraction.originalValue)
                      : result.contract.originalValue > 0
                        ? formatCurrencyBRL(result.contract.originalValue)
                        : 'Não divulgado na origem'}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Cruzamento PNCP</dt>
                  <dd className="font-medium text-slate-900 mt-0.5">
                    {result.matchedPncp
                      ? `Reconciliado (${result.contract.pncpControlNumber})`
                      : 'Sem espelho PNCP — criado via documento'}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-slate-500">Objeto Identificado</dt>
                  <dd className="text-slate-900 mt-0.5">
                    {result.extraction.object ?? result.contract.object}
                  </dd>
                </div>
              </dl>

              {result.extraction.excerpts.length > 0 && (
                <div className="pt-3 border-t border-slate-100">
                  <div className="text-xs font-medium text-slate-500 mb-2">
                    Trechos Probatórios Capturados
                  </div>
                  <div className="space-y-1.5">
                    {result.extraction.excerpts.slice(0, 4).map((ex, i) => (
                      <div
                        key={`${ex.field}-${i}`}
                        className="text-xs text-slate-700 font-mono bg-slate-50 border border-slate-200 rounded px-2.5 py-1.5"
                      >
                        <span className="text-slate-500">p.{ex.pageNumber} [{ex.field}]</span> — “
                        {ex.excerpt}”
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {result.batchContracts && result.batchContracts.length > 1 && (
            <div className="border-t border-slate-200">
              <div className="px-6 py-4 bg-slate-50/70 border-b border-slate-200 flex items-center justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    Contratos Indexados da Tabela Municipal ({result.batchContracts.length})
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Todos os registros extraídos já estão disponíveis na busca e podem ser auditados individualmente.
                  </p>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                      <th className="py-2.5 px-4">Nº Contrato</th>
                      <th className="py-2.5 px-4">Fornecedor / CNPJ</th>
                      <th className="py-2.5 px-4">Objeto</th>
                      <th className="py-2.5 px-4">Risco</th>
                      <th className="py-2.5 px-4 text-right">Dossiê</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {result.batchContracts.map((item) => (
                      <tr key={item.id} className="hover:bg-slate-50/70">
                        <td className="py-3 px-4 font-mono font-semibold text-slate-900 whitespace-nowrap">
                          {item.contractNumber}
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-medium text-slate-900">{item.supplier.legalName}</div>
                          {item.supplier.cnpj !== '00000000000000' && (
                            <div className="font-mono text-slate-500">
                              {formatCnpj(item.supplier.cnpj)}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-700 max-w-md">{item.object}</td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <RiskScoreInline score={item.assessment.score} />
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => onSelectContract(item)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md"
                          >
                            Abrir
                            <ArrowRight className="w-3 h-3" aria-hidden="true" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

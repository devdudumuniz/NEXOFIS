import { useState } from 'react';
import { AlertTriangle, Archive, ArrowRight, FolderOpen, RefreshCw, Trash2 } from 'lucide-react';
import type { SavedDossierSummary } from '@nexofis/shared/types/audit';
import { matchesDatePeriod } from '@nexofis/shared/lib/datePeriod';
import { formatDateBR } from '@nexofis/shared/lib/formatters';
import { DatePeriodControls } from './DatePeriodControls';
import { RiskScoreInline } from './RiskText';

interface SavedDossiersViewProps {
  dossiers: SavedDossierSummary[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onOpenSnapshot: (dossierId: string) => void;
  onOpenContractId: (contractId: string) => void;
  onDeleteDossier: (id: string) => void;
  onExploreMunicipality: () => void;
}

export function SavedDossiersView({
  dossiers,
  loading = false,
  error = null,
  onRetry,
  onOpenSnapshot,
  onOpenContractId,
  onDeleteDossier,
  onExploreMunicipality,
}: SavedDossiersViewProps) {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const filteredDossiers = dossiers.filter((dos) =>
    matchesDatePeriod(dos.savedAt, {
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    })
  );

  return (
    <div className="space-y-6">
      <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6 space-y-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#0B2540] dark:text-[#FAF9F5]">
            Dossiês de Auditoria Arquivados
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 mt-1 max-w-3xl">
            Snapshots completos preservados em SQLite com avaliação, revisões humanas, nota do
            auditor e digest SHA-256 para reprodutibilidade perante controladorias, TCE ou Ministério
            Público.
          </p>
        </div>

        <div className="pt-3 border-t border-slate-100 dark:border-[#1D3A57] max-w-xl">
          <DatePeriodControls
            idPrefix="saved-dossiers"
            startDate={startDate}
            endDate={endDate}
            onStartDateChange={setStartDate}
            onEndDateChange={setEndDate}
            compact
          />
        </div>
      </section>

      {error && (
        <section
          role="alert"
          className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-lg p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        >
          <div className="flex items-start gap-2.5 text-sm text-red-800 dark:text-red-300">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{error}</span>
          </div>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-red-800 dark:text-red-200 bg-white dark:bg-red-900/40 border border-red-300 dark:border-red-700 rounded-md self-start sm:self-auto"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              Tentar novamente
            </button>
          )}
        </section>
      )}

      {loading && dossiers.length === 0 ? (
        <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-10 text-center text-sm text-slate-500 dark:text-slate-400">
          Carregando dossiês arquivados no SQLite...
        </section>
      ) : filteredDossiers.length === 0 ? (
        <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-12 text-center">
          <FolderOpen
            className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-3"
            aria-hidden="true"
          />
          <p className="text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
            {dossiers.length === 0
              ? 'Nenhum dossiê salvo no banco SQLite.'
              : 'Nenhum dossiê encontrado no período informado.'}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-md mx-auto">
            {dossiers.length === 0
              ? 'Abra qualquer contrato na investigação municipal, busca ou upload documental e clique em “Salvar Dossiê” para arquivar um snapshot reproduzível com SHA-256.'
              : 'Limpe ou amplie a data de início e a data final para visualizar todos os dossiês arquivados.'}
          </p>
          <button
            type="button"
            onClick={
              dossiers.length === 0
                ? onExploreMunicipality
                : () => {
                    setStartDate('');
                    setEndDate('');
                  }
            }
            className="mt-5 px-4 py-2 text-xs font-semibold text-white bg-[#0B2540] dark:bg-[#D95B35] hover:opacity-90 rounded-md transition-colors"
          >
            {dossiers.length === 0 ? 'Investigar Contratos Municipais' : 'Limpar período'}
          </button>
        </section>
      ) : (
        <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg divide-y divide-slate-200 dark:divide-[#1D3A57]">
          {filteredDossiers.map((dos) => (
            <div
              key={dos.id}
              className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
            >
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-x-2.5 text-xs">
                  <span className="font-mono font-semibold text-[#0B2540] dark:text-[#FAF9F5] text-sm">
                    Contrato {dos.contractNumber}
                  </span>
                  <span className="text-slate-400" aria-hidden="true">·</span>
                  <span className="text-slate-700 dark:text-slate-300 font-medium">
                    {dos.municipalityName}
                    {dos.municipalityIbge ? ` (IBGE ${dos.municipalityIbge})` : ''}
                  </span>
                  <span className="text-slate-400" aria-hidden="true">·</span>
                  <span className="font-mono text-slate-500 dark:text-slate-400">
                    Salvo em {formatDateBR(dos.savedAt)}
                  </span>
                </div>
                <div className="text-xs text-slate-600 dark:text-slate-300">
                  {dos.entityName} · Fornecedor: {dos.supplierName}
                </div>
                {dos.analystNote && (
                  <p className="text-xs text-[#0B2540] dark:text-slate-200 bg-[#FAF9F5] dark:bg-[#061321] border border-slate-200 dark:border-[#1D3A57] rounded px-3 py-2">
                    {dos.analystNote}
                  </p>
                )}
                <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                  ID {dos.id} · Digest SHA-256: {dos.sha256Digest.slice(0, 24)}…
                  {dos.hasSnapshot ? ' · Snapshot completo preservado' : ' · Registro legado (sem snapshot)'}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <RiskScoreInline score={dos.riskScore} />
                {dos.hasSnapshot && (
                  <button
                    type="button"
                    onClick={() => onOpenSnapshot(dos.id)}
                    aria-label={`Reabrir snapshot arquivado ${dos.id}`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-[#0B2540] dark:bg-[#D95B35] hover:opacity-90 rounded-md transition-colors whitespace-nowrap"
                  >
                    <Archive className="w-3.5 h-3.5" aria-hidden="true" />
                    Reabrir snapshot arquivado
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onOpenContractId(dos.contractId)}
                  aria-label={`Ver contrato atual ${dos.contractNumber}`}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#0B2540] dark:text-[#FAF9F5] bg-[#E8F1F6] dark:bg-[#102843] hover:opacity-90 rounded-md transition-colors whitespace-nowrap"
                >
                  Ver contrato atual
                  <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteDossier(dos.id)}
                  aria-label={`Remover dossiê ${dos.contractNumber}`}
                  className="p-2 text-slate-400 hover:text-red-700 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-md transition-colors"
                >
                  <Trash2 className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

import { useState } from 'react';
import { ArrowRight, FolderOpen, Trash2 } from 'lucide-react';
import type { SavedDossierSummary } from '../types/audit';
import { matchesDatePeriod } from '../lib/datePeriod';
import { formatDateBR } from '../lib/formatters';
import { DatePeriodControls } from './DatePeriodControls';
import { RiskScoreInline } from './RiskText';

interface SavedDossiersViewProps {
  dossiers: SavedDossierSummary[];
  onOpenContractId: (contractId: string) => void;
  onDeleteDossier: (id: string) => void;
  onExploreMunicipality: () => void;
}

export function SavedDossiersView({
  dossiers,
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
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Dossiês de Auditoria Arquivados
          </h1>
          <p className="text-sm text-slate-600 mt-1 max-w-3xl">
            Investigações salvas em SQLite com resumo de risco, nota do auditor e hash SHA-256 de
            verificação para reprodutibilidade em relatórios de controladoria, TCE ou Ministério
            Público.
          </p>
        </div>

        <div className="pt-3 border-t border-slate-100 max-w-xl">
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

      {filteredDossiers.length === 0 ? (
        <section className="bg-white border border-slate-200 rounded-lg p-12 text-center">
          <FolderOpen className="w-8 h-8 text-slate-300 mx-auto mb-3" aria-hidden="true" />
          <p className="text-sm font-semibold text-slate-800">
            {dossiers.length === 0
              ? 'Nenhum dossiê salvo no banco SQLite.'
              : 'Nenhum dossiê encontrado no período informado.'}
          </p>
          <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
            {dossiers.length === 0
              ? 'Abra qualquer contrato na investigação municipal ou via upload de PDF e clique em “Salvar Dossiê” para registrar suas conclusões com digest SHA-256.'
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
            className="mt-5 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors"
          >
            {dossiers.length === 0 ? 'Explorar Contratos Municipais' : 'Limpar período'}
          </button>
        </section>
      ) : (
        <section className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-200">
          {filteredDossiers.map((dos) => (
            <div
              key={dos.id}
              className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
            >
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-x-2.5 text-xs">
                  <span className="font-mono font-semibold text-slate-900 text-sm">
                    Contrato {dos.contractNumber}
                  </span>
                  <span className="text-slate-400" aria-hidden="true">·</span>
                  <span className="text-slate-700 font-medium">
                    {dos.municipalityName} (IBGE {dos.municipalityIbge})
                  </span>
                  <span className="text-slate-400" aria-hidden="true">·</span>
                  <span className="font-mono text-slate-500">
                    Salvo em {formatDateBR(dos.savedAt)}
                  </span>
                </div>
                <div className="text-xs text-slate-600">
                  {dos.entityName} · Fornecedor: {dos.supplierName}
                </div>
                {dos.analystNote && (
                  <p className="text-xs text-slate-800 bg-slate-50 border border-slate-200 rounded px-3 py-2">
                    {dos.analystNote}
                  </p>
                )}
                <div className="text-[11px] font-mono text-slate-400">
                  ID {dos.id} · Digest SHA-256: {dos.sha256Digest.slice(0, 24)}…
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <RiskScoreInline score={dos.riskScore} />
                <button
                  type="button"
                  onClick={() => onOpenContractId(dos.contractId)}
                  aria-label={`Reabrir dossiê do contrato ${dos.contractNumber}`}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors whitespace-nowrap"
                >
                  Reabrir
                  <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteDossier(dos.id)}
                  aria-label={`Remover dossiê ${dos.contractNumber}`}
                  className="p-2 text-slate-400 hover:text-red-700 hover:bg-red-50 rounded-md transition-colors"
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

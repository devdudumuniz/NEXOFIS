import { useEffect, useState } from 'react';
import { ArrowRight, GitBranch } from 'lucide-react';
import type { EvaluatedContract } from '../types/audit';
import { fetchSupplierMirrorContracts } from '../lib/api';
import { formatCnpj, formatCurrencyBRL, formatDateBR } from '../lib/formatters';
import { RiskScoreInline } from './RiskText';

interface EntityGraphTabProps {
  contract: EvaluatedContract;
  onSelectContract?: (contract: EvaluatedContract) => void;
}

interface FtmEntityNode {
  id: string;
  schema: 'PublicBody' | 'Contract' | 'Company' | 'Person' | 'Sanction' | 'Payment' | 'Document';
  label: string;
  identifier: string;
  detail: string;
  flag?: string;
}

interface FtmEdge {
  from: string;
  relation: string;
  to: string;
  evidence: string;
}

export function EntityGraphTab({ contract, onSelectContract }: EntityGraphTabProps) {
  const [mirrorContracts, setMirrorContracts] = useState<EvaluatedContract[]>([]);
  const [indexSource, setIndexSource] = useState<string>('SQLite Local + PNCP Search API');
  const [loadingMirror, setLoadingMirror] = useState(false);

  const hasValidSupplierCnpj =
    Boolean(contract.supplier.cnpj) && contract.supplier.cnpj !== '00000000000000';

  useEffect(() => {
    if (!hasValidSupplierCnpj) {
      setMirrorContracts([contract]);
      setLoadingMirror(false);
      return;
    }

    let cancelled = false;
    setLoadingMirror(true);
    fetchSupplierMirrorContracts(contract.supplier.cnpj)
      .then((res) => {
        if (cancelled) return;
        setMirrorContracts(res.contracts);
        setIndexSource(res.indexSource);
      })
      .catch(() => {
        if (!cancelled) setMirrorContracts([contract]);
      })
      .finally(() => {
        if (!cancelled) setLoadingMirror(false);
      });
    return () => {
      cancelled = true;
    };
  }, [contract.supplier.cnpj, contract.id, hasValidSupplierCnpj]);

  const nodes: FtmEntityNode[] = [
    {
      id: `ftm:publicbody:${contract.municipalityIbge || 'unknown'}:${contract.entityId}`,
      schema: 'PublicBody',
      label: contract.entityName,
      identifier: contract.municipalityIbge
        ? `IBGE ${contract.municipalityIbge} · ${contract.municipalityName}/${contract.uf}`
        : contract.municipalityName,
      detail: 'Órgão / unidade gestora contratante',
    },
    {
      id: `ftm:contract:${contract.id}`,
      schema: 'Contract',
      label: `Contrato ${contract.contractNumber}`,
      identifier: contract.pncpControlNumber || 'Sem nº de controle PNCP',
      detail: `${contract.modality} · Valor atualizado ${
        contract.updatedValue > 0 ? formatCurrencyBRL(contract.updatedValue) : 'Não divulgado'
      }`,
    },
    {
      id: `ftm:company:${contract.supplier.cnpj || 'unknown'}`,
      schema: 'Company',
      label: contract.supplier.legalName,
      identifier: hasValidSupplierCnpj
        ? `CNPJ ${formatCnpj(contract.supplier.cnpj)}`
        : 'CNPJ não identificado',
      detail: `CNAE ${contract.supplier.primaryCnaeCode || 'Não consultado'} · Situação ${contract.supplier.registrationStatus}`,
    },
  ];

  const edges: FtmEdge[] = [
    {
      from: contract.entityName,
      relation: 'CONTRATOU',
      to: `Contrato ${contract.contractNumber}`,
      evidence: contract.pncpControlNumber || contract.dataSourceOrigin,
    },
    {
      from: `Contrato ${contract.contractNumber}`,
      relation: 'ADJUDICADO_A',
      to: contract.supplier.legalName,
      evidence: contract.signatureDate
        ? `Assinatura ${formatDateBR(contract.signatureDate)}`
        : 'Data de assinatura não informada',
    },
  ];

  for (const sh of contract.supplier.shareholders) {
    nodes.push({
      id: `ftm:person:${sh.maskedCpfCnpj}:${sh.name.toLowerCase().replace(/\s+/g, '-')}`,
      schema: 'Person',
      label: sh.name,
      identifier: sh.maskedCpfCnpj,
      detail: `${sh.role} · Entrada ${formatDateBR(sh.entryDate)}`,
      flag: sh.isPublicServantOverlap
        ? `Vínculo público apontado (${sh.overlapDetail ?? 'verificar estatuto local'})`
        : undefined,
    });
    edges.push({
      from: sh.name,
      relation: 'SOCIO_DE',
      to: contract.supplier.legalName,
      evidence: 'QSA / Receita Federal',
    });
  }

  for (const sanc of contract.supplier.sanctions) {
    nodes.push({
      id: `ftm:sanction:${sanc.id}`,
      schema: 'Sanction',
      label: `${sanc.registry} (${sanc.status} · ${sanc.scope})`,
      identifier: `${formatDateBR(sanc.startDate)} a ${formatDateBR(sanc.endDate)}`,
      detail: `${sanc.sanctioningOrgan} — ${sanc.reason}`,
      flag: sanc.status === 'Ativa' ? 'Sanção vigente' : undefined,
    });
    edges.push({
      from: contract.supplier.legalName,
      relation: 'SANCIONADA_EM',
      to: `${sanc.registry} (${sanc.scope})`,
      evidence: sanc.sourceSystem,
    });
  }

  const provenPayments = contract.payments.filter(
    (p) => p.type === 'Pagamento' || p.type === 'Liquidação' || p.type === 'Empenho'
  );
  for (const pay of provenPayments.slice(0, 6)) {
    nodes.push({
      id: `ftm:payment:${pay.id}`,
      schema: 'Payment',
      label: `${pay.type} ${pay.documentNumber || pay.id}`,
      identifier: `${formatDateBR(pay.date)} · ${formatCurrencyBRL(pay.amount)}`,
      detail: pay.sourceSystem,
      flag: pay.paidOutOfOrder
        ? pay.justificationPublished
          ? 'Ordem cronológica: exceção justificada'
          : 'Ordem cronológica: quebra sem justificativa publicada'
        : undefined,
    });
    edges.push({
      from: `Contrato ${contract.contractNumber}`,
      relation: `EXECUCAO_${pay.type.toUpperCase()}`,
      to: `${pay.type} ${pay.documentNumber || pay.id}`,
      evidence: pay.sourceSystem,
    });
  }

  for (const doc of contract.documents) {
    nodes.push({
      id: `ftm:document:${doc.sha256.slice(0, 12)}`,
      schema: 'Document',
      label: doc.title,
      identifier: `SHA-256 ${doc.sha256.slice(0, 16)}…`,
      detail: `${doc.documentType} · ${doc.extractionSummary.extractorVersion}`,
    });
    edges.push({
      from: `Contrato ${contract.contractNumber}`,
      relation: 'COMPROVADO_POR',
      to: doc.title,
      evidence: `SHA-256 ${doc.sha256.slice(0, 12)}…`,
    });
  }

  const otherContracts = mirrorContracts.filter((c) => c.id !== contract.id);

  return (
    <div className="space-y-6">
      <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg p-6 space-y-5">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 pb-4 border-b border-slate-200 dark:border-[#1D3A57]">
          <div>
            <div className="flex items-center gap-2 text-xs font-mono text-slate-500 dark:text-slate-400">
              <GitBranch className="w-3.5 h-3.5 text-[#D95B35]" aria-hidden="true" />
              <span>Modelo FollowTheMoney (FtM) · Entidades e Relações Investigativas</span>
            </div>
            <h2 className="text-base font-semibold text-[#0B2540] dark:text-[#FAF9F5] mt-1">
              Grafo Probatório de Entidades ({nodes.length} nós · {edges.length} arestas)
            </h2>
          </div>
          <div className="text-xs font-mono text-slate-500 dark:text-slate-400 shrink-0">
            Entidade raiz: ftm:contract:{contract.id}
          </div>
        </div>

        <div className="overflow-x-auto border border-slate-200 dark:border-[#1D3A57] rounded-md">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-[#1D3A57] bg-[#FAF9F5] dark:bg-[#061321] text-xs font-medium text-slate-500 dark:text-slate-400">
                <th className="py-2.5 px-4 whitespace-nowrap">Schema FtM</th>
                <th className="py-2.5 px-4">Entidade</th>
                <th className="py-2.5 px-4 whitespace-nowrap">Identificador / Chave</th>
                <th className="py-2.5 px-4">Atributos e Observações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-[#1D3A57]">
              {nodes.map((node) => (
                <tr key={node.id}>
                  <td className="py-3 px-4 align-top whitespace-nowrap">
                    <span className="font-mono text-xs font-semibold text-[#D95B35]">
                      {node.schema}
                    </span>
                  </td>
                  <td className="py-3 px-4 align-top">
                    <div className="font-medium text-[#0B2540] dark:text-[#FAF9F5]">{node.label}</div>
                    <div className="text-[11px] font-mono text-slate-400 mt-0.5">{node.id}</div>
                  </td>
                  <td className="py-3 px-4 align-top font-mono text-xs tabular-nums text-slate-700 dark:text-slate-300 whitespace-nowrap">
                    {node.identifier}
                  </td>
                  <td className="py-3 px-4 align-top text-xs text-slate-600 dark:text-slate-300">
                    <div>{node.detail}</div>
                    {node.flag && (
                      <div className="text-red-700 dark:text-red-400 font-semibold mt-1">
                        {node.flag}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5] mb-3">
            Relações Verificáveis (Arestas do Grafo)
          </h3>
          <div className="border border-slate-200 dark:border-[#1D3A57] rounded-md divide-y divide-slate-200 dark:divide-[#1D3A57]">
            {edges.map((edge, idx) => (
              <div
                key={`${edge.from}-${edge.relation}-${idx}`}
                className="px-4 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[#0B2540] dark:text-slate-200">
                  <span className="font-semibold">{edge.from}</span>
                  <span className="font-mono text-[#D95B35] font-semibold">
                    —[{edge.relation}]→
                  </span>
                  <span className="font-semibold">{edge.to}</span>
                </div>
                <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 shrink-0">
                  {edge.evidence}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-white dark:bg-[#0B1D31] border border-slate-200 dark:border-[#1D3A57] rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-[#1D3A57]">
          <h3 className="text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
            Contratos Horizontais do Mesmo Fornecedor
          </h3>
          <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-1">
            Índice: {indexSource} · {mirrorContracts.length} contrato(s) localizado(s)
          </div>
        </div>

        {loadingMirror ? (
          <div className="p-6 text-xs text-slate-500 dark:text-slate-400">
            Consultando contratos horizontais do fornecedor...
          </div>
        ) : otherContracts.length === 0 ? (
          <div className="p-6 text-xs text-slate-600 dark:text-slate-300">
            Nenhum outro contrato localizado para este fornecedor na consulta atual.
          </div>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-[#1D3A57]">
            {otherContracts.map((rel) => (
              <div
                key={rel.id}
                className="px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-[#FAF9F5] dark:hover:bg-[#102843]/50"
              >
                <div className="space-y-1">
                  <div className="text-xs font-mono text-slate-700 dark:text-slate-300">
                    Contrato {rel.contractNumber} · {rel.municipalityName}
                    {rel.uf ? `/${rel.uf}` : ''}
                  </div>
                  <div className="text-sm font-medium text-[#0B2540] dark:text-[#FAF9F5]">
                    {rel.object}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">{rel.entityName}</div>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <div className="text-right">
                    <div className="font-mono tabular-nums text-sm font-semibold text-[#0B2540] dark:text-[#FAF9F5]">
                      {rel.updatedValue > 0 ? formatCurrencyBRL(rel.updatedValue) : 'Não divulgado'}
                    </div>
                    <div className="text-xs mt-0.5">
                      <RiskScoreInline
                        score={rel.assessment.score}
                        coverageStatus={rel.assessment.coverageStatus}
                      />
                    </div>
                  </div>
                  {onSelectContract && (
                    <button
                      type="button"
                      onClick={() => onSelectContract(rel)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-[#0B2540] dark:text-[#FAF9F5] bg-[#E8F1F6] dark:bg-[#102843] rounded-md whitespace-nowrap"
                    >
                      Abrir
                      <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

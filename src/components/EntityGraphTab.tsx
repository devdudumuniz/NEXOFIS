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
  const [indexSource, setIndexSource] = useState<string>(
    'Espelho Local Indexado Licitarium / PNCP'
  );
  const [loadingMirror, setLoadingMirror] = useState(true);

  useEffect(() => {
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
  }, [contract.supplier.cnpj, contract.id]);

  // Construct deterministic FollowTheMoney (FtM) entity graph
  const nodes: FtmEntityNode[] = [
    {
      id: `ftm:publicbody:${contract.municipalityIbge}:${contract.entityId}`,
      schema: 'PublicBody',
      label: contract.entityName,
      identifier: `IBGE ${contract.municipalityIbge} · ${contract.municipalityName}/${contract.uf}`,
      detail: 'Órgão / unidade gestora contratante',
    },
    {
      id: `ftm:contract:${contract.id}`,
      schema: 'Contract',
      label: `Contrato ${contract.contractNumber}`,
      identifier: contract.pncpControlNumber,
      detail: `${contract.modality} · Valor atualizado ${formatCurrencyBRL(contract.updatedValue)}`,
    },
    {
      id: `ftm:company:${contract.supplier.cnpj}`,
      schema: 'Company',
      label: contract.supplier.legalName,
      identifier: `CNPJ ${formatCnpj(contract.supplier.cnpj)}`,
      detail: `CNAE ${contract.supplier.primaryCnaeCode} · Situação ${contract.supplier.registrationStatus}`,
    },
  ];

  const edges: FtmEdge[] = [
    {
      from: contract.entityName,
      relation: 'CONTRATOU',
      to: `Contrato ${contract.contractNumber}`,
      evidence: `PNCP ${contract.pncpControlNumber}`,
    },
    {
      from: `Contrato ${contract.contractNumber}`,
      relation: 'ADJUDICADO_A',
      to: contract.supplier.legalName,
      evidence: `Assinatura ${formatDateBR(contract.signatureDate)}`,
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
    if (sh.isPublicServantOverlap) {
      edges.push({
        from: sh.name,
        relation: 'POTENCIAL_CONFLITO_STF_1001',
        to: contract.entityName,
        evidence: sh.overlapDetail ?? 'Sobreposição funcional em apuração',
      });
    }
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
  for (const pay of provenPayments.slice(0, 4)) {
    nodes.push({
      id: `ftm:payment:${pay.id}`,
      schema: 'Payment',
      label: `${pay.type} ${pay.documentNumber}`,
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
      to: `${pay.type} ${pay.documentNumber}`,
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
      {/* FollowTheMoney Entity Graph Overview */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 pb-4 border-b border-slate-200">
          <div>
            <div className="flex items-center gap-2 text-xs font-mono text-slate-500">
              <GitBranch className="w-3.5 h-3.5 text-slate-700" aria-hidden="true" />
              <span>Modelo FollowTheMoney (FtM) · Entidades e Relações Investigativas</span>
            </div>
            <h2 className="text-base font-semibold text-slate-900 mt-1">
              Grafo Probatório de Entidades ({nodes.length} nós · {edges.length} arestas)
            </h2>
            <p className="text-xs text-slate-600 mt-1 max-w-3xl">
              Estrutura compatível com OpenAleph / FollowTheMoney (Person, Company, PublicBody,
              Contract, Payment, Sanction, Document) para rastreamento de vínculos societários,
              sanções, pagamentos e contratos correlatos.
            </p>
          </div>
          <div className="text-xs font-mono text-slate-500 shrink-0">
            Entidade raiz: ftm:contract:{contract.id}
          </div>
        </div>

        {/* Typed Entities Table */}
        <div className="overflow-x-auto border border-slate-200 rounded-md">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4 whitespace-nowrap">Schema FtM</th>
                <th className="py-2.5 px-4">Entidade</th>
                <th className="py-2.5 px-4 whitespace-nowrap">Identificador / Chave</th>
                <th className="py-2.5 px-4">Atributos e Observações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {nodes.map((node) => (
                <tr key={node.id}>
                  <td className="py-3 px-4 align-top whitespace-nowrap">
                    <span className="font-mono text-xs font-semibold text-blue-800">
                      {node.schema}
                    </span>
                  </td>
                  <td className="py-3 px-4 align-top">
                    <div className="font-medium text-slate-900">{node.label}</div>
                    <div className="text-[11px] font-mono text-slate-400 mt-0.5">{node.id}</div>
                  </td>
                  <td className="py-3 px-4 align-top font-mono text-xs tabular-nums text-slate-700 whitespace-nowrap">
                    {node.identifier}
                  </td>
                  <td className="py-3 px-4 align-top text-xs text-slate-600">
                    <div>{node.detail}</div>
                    {node.flag && (
                      <div className="text-red-700 font-semibold mt-1">{node.flag}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Edges / Relationships */}
        <div>
          <h3 className="text-sm font-semibold text-slate-900 mb-3">
            Relações Verificáveis (Arestas do Grafo)
          </h3>
          <div className="border border-slate-200 rounded-md divide-y divide-slate-200">
            {edges.map((edge, idx) => (
              <div
                key={`${edge.from}-${edge.relation}-${idx}`}
                className="px-4 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-slate-800">
                  <span className="font-semibold">{edge.from}</span>
                  <span className="font-mono text-blue-700 font-semibold">
                    —[{edge.relation}]→
                  </span>
                  <span className="font-semibold">{edge.to}</span>
                </div>
                <span className="font-mono text-[11px] text-slate-500 shrink-0">
                  {edge.evidence}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Horizontal Supplier Mirror Lookup (solves PNCP organ-CNPJ limitation) */}
      <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200">
          <h3 className="text-sm font-semibold text-slate-900">
            Contratos Horizontais do Mesmo Fornecedor no Espelho PNCP Local
          </h3>
          <p className="text-xs text-slate-600 mt-0.5 max-w-3xl">
            Na API pública do PNCP, o parâmetro <span className="font-mono">cnpj</span> identifica o
            órgão contratante e não o fornecedor. Esta consulta horizontal utiliza a projeção local
            indexada (padrão Licitarium) para rastrear o CNPJ{' '}
            <span className="font-mono font-semibold text-slate-800">
              {formatCnpj(contract.supplier.cnpj)}
            </span>{' '}
            em todos os entes espelhados.
          </p>
          <div className="text-[11px] font-mono text-slate-500 mt-1">
            Índice: {indexSource} · {mirrorContracts.length} contrato(s) localizado(s)
          </div>
        </div>

        {loadingMirror ? (
          <div className="p-6 text-xs text-slate-500">
            Consultando índice horizontal de fornecedores...
          </div>
        ) : otherContracts.length === 0 ? (
          <div className="p-6 text-xs text-slate-600">
            Este é o único contrato indexado no espelho local para o CNPJ{' '}
            <span className="font-mono">{formatCnpj(contract.supplier.cnpj)}</span>. O histórico
            agregado do fornecedor indica {contract.supplier.simultaneousActiveContracts} contrato(s)
            ativo(s) simultâneo(s) e {contract.supplier.priorMunicipalContracts} contrato(s)
            anterior(es) no município.
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {otherContracts.map((rel) => (
              <div
                key={rel.id}
                className="px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-50"
              >
                <div className="space-y-1">
                  <div className="text-xs font-mono text-slate-700">
                    Contrato {rel.contractNumber} · {rel.municipalityName}/{rel.uf} (IBGE{' '}
                    {rel.municipalityIbge})
                  </div>
                  <div className="text-sm font-medium text-slate-900">{rel.object}</div>
                  <div className="text-xs text-slate-500">{rel.entityName}</div>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <div className="text-right">
                    <div className="font-mono tabular-nums text-sm font-semibold text-slate-900">
                      {formatCurrencyBRL(rel.updatedValue)}
                    </div>
                    <div className="text-xs mt-0.5">
                      <RiskScoreInline score={rel.assessment.score} />
                    </div>
                  </div>
                  {onSelectContract && (
                    <button
                      type="button"
                      onClick={() => onSelectContract(rel)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md whitespace-nowrap"
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

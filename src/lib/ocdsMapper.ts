import type { EvaluatedContract, OCDSRelease } from '../types/audit';
import { formatCnpj, formatCurrencyBRL, formatDateBR, formatPercentageBR } from './formatters';

export function mapContractToOCDS(contract: EvaluatedContract): OCDSRelease {
  const ocid = `ocds-br-pncp-${contract.municipalityIbge}-${contract.id.toLowerCase()}`;

  return {
    ocid,
    id: `${ocid}-r1`,
    date: contract.assessment.evaluatedAt,
    tag: ['planning', 'tender', 'award', 'contract', 'implementation'],
    initiationType: 'tender',
    buyer: {
      id: `BR-IBGE-${contract.municipalityIbge}-${contract.entityId}`,
      name: `${contract.entityName} (${contract.municipalityName}/${contract.uf})`,
    },
    planning: {
      budget: {
        amount: {
          amount: contract.originalValue,
          currency: 'BRL',
        },
        project: contract.objectCategory,
      },
    },
    tender: {
      id: `TND-${contract.pncpControlNumber}`,
      title: contract.object,
      procurementMethodDetails: contract.modality,
      numberOfTenderers: contract.biddersCount,
      value: {
        amount: contract.originalValue,
        currency: 'BRL',
      },
    },
    awards: [
      {
        id: `AWD-${contract.id}`,
        status: 'active',
        date: contract.signatureDate,
        value: {
          amount: contract.originalValue,
          currency: 'BRL',
        },
        suppliers: [
          {
            id: `BR-CNPJ-${contract.supplier.cnpj}`,
            name: contract.supplier.legalName,
          },
        ],
      },
    ],
    contracts: [
      {
        id: contract.pncpControlNumber,
        awardID: `AWD-${contract.id}`,
        title: `Contrato ${contract.contractNumber} — ${contract.object}`,
        status: contract.status.toLowerCase(),
        period: {
          startDate: contract.startDate,
          endDate: contract.endDate,
        },
        value: {
          amount: contract.updatedValue,
          currency: 'BRL',
        },
        amendments: contract.amendments.map((amend) => ({
          id: amend.id,
          date: amend.date,
          rationale: amend.justification,
          description: `${amend.number} (${amend.type}) · Acréscimo: ${formatCurrencyBRL(amend.addedValue)}`,
        })),
      },
    ],
    implementation: {
      transactions: contract.payments.map((payment) => ({
        id: payment.documentNumber,
        date: payment.date,
        value: {
          amount: payment.amount,
          currency: 'BRL',
        },
        payer: {
          name: contract.entityName,
        },
        payee: {
          name: contract.supplier.legalName,
        },
      })),
    },
  };
}

export function buildAuditDossierMarkdown(contract: EvaluatedContract, analystNote?: string): string {
  const { assessment } = contract;
  const lines: string[] = [
    `# Dossiê de Auditoria Reproduzível — Contrato ${contract.contractNumber}`,
    ``,
    `> **Classificação**: ${assessment.headline}`,
    `> **Aviso metodológico**: Os indicadores abaixo representam indícios objetivos, anomalias ou inconsistências verificáveis para revisão humana. Não constituem declaração automática de fraude.`,
    ``,
    `## 1. Identificação e Contexto Municipal`,
    `- **Município**: ${contract.municipalityName}/${contract.uf} (IBGE \`${contract.municipalityIbge}\`)`,
    `- **Órgão / Secretaria**: ${contract.entityName}`,
    `- **Controle PNCP**: \`${contract.pncpControlNumber}\``,
    `- **Modalidade**: ${contract.modality} (${contract.biddersCount} participante(s))`,
    `- **Objeto**: ${contract.object}`,
    `- **Vigência**: ${formatDateBR(contract.startDate)} a ${formatDateBR(contract.endDate)}`,
    `- **Fornecedor**: ${contract.supplier.legalName} (CNPJ ${formatCnpj(contract.supplier.cnpj)})`,
    ``,
    `## 2. Obrigação Contratada × Execução Financeira Comprovada`,
    `- **Valor original (obrigação)**: ${formatCurrencyBRL(contract.originalValue)}`,
    `- **Valor atualizado (obrigação)**: ${formatCurrencyBRL(contract.updatedValue)} (${formatPercentageBR(assessment.variationPct, true)})`,
    `- **Estimativa mensal contratual (\`estimated_monthly_contract_value\`)**: ${formatCurrencyBRL(assessment.executionChain.estimatedMonthlyContractValue)}/mês *(não comprova pagamento mensal)*`,
    `- **Empenhado**: ${formatCurrencyBRL(assessment.executionChain.committedTotal)} · **Liquidado**: ${formatCurrencyBRL(assessment.executionChain.liquidatedTotal)} · **Pago**: ${formatCurrencyBRL(assessment.executionChain.paidTotal)}`,
    `- **Norma vigente aplicada (Legal Time Travel)**: \`${assessment.appliedLegalRuleset.ruleId}\` — ${assessment.appliedLegalRuleset.legalBasis} (vigência a partir de ${formatDateBR(assessment.appliedLegalRuleset.effectiveFrom)})`,
    ``,
    `## 3. Pontos de Observação e Achados (${assessment.indicators.length})`,
    `| Finding ID | Código | Estado | Nível | Confiança | Indicador | Severidade |`,
    `|---|---|---|---|---|---|---|`,
    ...assessment.indicators.map(
      (ind) =>
        `| ${ind.findingId} | ${ind.code} | ${ind.state} | ${ind.evidenceLevel} | ${Math.round(ind.confidence * 100)}% | ${ind.title} | ${ind.severity} |`
    ),
    ``,
    `## 4. Trilha Probatória (Evidências)`,
    ...assessment.evidences.map(
      (ev) =>
        `- **${ev.id}** [${ev.indicatorCode} v${ev.ruleVersion} · ruleset ${ev.legalRulesetVersion}] · Fonte: ${ev.sourceSystem} · Documento: ${ev.documentTitle} (pág. ${ev.pageNumber}) · SHA-256: \`${ev.sha256.slice(0, 16)}…\`\n  - Trecho: "${ev.excerpt}"\n  - Cálculo: \`${ev.calculation}\``
    ),
    ``,
    `## 5. Reconciliação de Fontes (Sem Sobrescrita)`,
    ...contract.sourceRecords.map(
      (src) =>
        `- **${src.sourceSystem}** (\`${src.externalId}\`): Valor original ${formatCurrencyBRL(src.reportedOriginalValue)} · Valor atualizado ${formatCurrencyBRL(src.reportedUpdatedValue)} · Situação: ${src.reportedStatus}`
    ),
  ];

  if (analystNote?.trim()) {
    lines.push(``, `## 6. Nota do Auditor`, analystNote.trim());
  }

  lines.push(
    ``,
    `---`,
    `Motor forense: \`${assessment.engineVersion}\` · Ruleset legal: \`${assessment.appliedLegalRuleset.ruleId}\` · Gerado em: ${assessment.evaluatedAt}`
  );

  return lines.join('\n');
}

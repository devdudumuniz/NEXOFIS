import type { EvaluatedContract, FindingReviewRecord, OCDSRelease } from '../types/audit';
import { formatCnpj, formatCurrencyBRL, formatDateBR, formatPercentageBR } from './formatters';

/**
 * Maps an evaluated contract to an OCDS 1.1-aligned release:
 * - implementation.transactions lives inside contracts[0].implementation (OCDS 1.1 schema)
 * - only verified Pagamento records become implementation transactions (never Empenho/Liquidação)
 * - never fabricates planning/tender/award values when originalValue <= 0
 */
export function mapContractToOCDS(contract: EvaluatedContract): OCDSRelease {
  const ocid = `ocds-br-pncp-${contract.municipalityIbge}-${contract.id.toLowerCase()}`;
  const hasKnownOriginalValue = contract.originalValue > 0;
  const hasKnownUpdatedValue = contract.updatedValue > 0;

  // Deduplicate actual payments only (never map Empenho/Liquidação/Medição as OCDS payments)
  const seenPayments = new Set<string>();
  const verifiedPayments = contract.payments.filter((p) => {
    if (p.type !== 'Pagamento') return false;
    const key = `${p.documentNumber.trim().toLowerCase()}|${p.date}|${p.amount.toFixed(2)}`;
    if (seenPayments.has(key)) return false;
    seenPayments.add(key);
    return true;
  });

  const tags: string[] = ['contract'];
  if (hasKnownOriginalValue) {
    tags.unshift('tender', 'award');
  }
  if (verifiedPayments.length > 0) {
    tags.push('implementation');
  }

  const release: OCDSRelease = {
    ocid,
    id: `${ocid}-r1`,
    date: contract.assessment.evaluatedAt,
    tag: tags,
    initiationType: 'tender',
    buyer: {
      id: `BR-IBGE-${contract.municipalityIbge}-${contract.entityId}`,
      name: `${contract.entityName} (${contract.municipalityName}/${contract.uf})`,
    },
    tender: {
      id: `TND-${contract.pncpControlNumber}`,
      title: contract.object,
      procurementMethodDetails: contract.modality,
      ...(contract.biddersCount > 0 ? { numberOfTenderers: contract.biddersCount } : {}),
      ...(hasKnownOriginalValue
        ? { value: { amount: contract.originalValue, currency: 'BRL' as const } }
        : {}),
    },
    ...(hasKnownOriginalValue
      ? {
          awards: [
            {
              id: `AWD-${contract.id}`,
              status: 'active',
              date: contract.signatureDate,
              value: {
                amount: contract.originalValue,
                currency: 'BRL' as const,
              },
              suppliers: [
                {
                  id: `BR-CNPJ-${contract.supplier.cnpj}`,
                  name: contract.supplier.legalName,
                },
              ],
            },
          ],
        }
      : {}),
    contracts: [
      {
        id: contract.pncpControlNumber,
        ...(hasKnownOriginalValue ? { awardID: `AWD-${contract.id}` } : {}),
        title: `Contrato ${contract.contractNumber} — ${contract.object}`,
        status: contract.status === 'Encerrado' ? 'terminated' : contract.status === 'Suspenso' ? 'cancelled' : 'active',
        period: {
          startDate: contract.startDate,
          endDate: contract.endDate,
        },
        ...(hasKnownUpdatedValue
          ? {
              value: {
                amount: contract.updatedValue,
                currency: 'BRL' as const,
              },
            }
          : {}),
        amendments: contract.amendments.map((amend) => ({
          id: amend.id,
          date: amend.date,
          rationale: amend.justification,
          description: `${amend.number} (${amend.type}) · Acréscimo: ${formatCurrencyBRL(amend.addedValue)}`,
        })),
        implementation: {
          transactions: verifiedPayments.map((payment) => ({
            id: payment.documentNumber,
            date: payment.date,
            value: {
              amount: payment.amount,
              currency: 'BRL' as const,
            },
            payer: {
              name: contract.entityName,
            },
            payee: {
              name: contract.supplier.legalName,
            },
          })),
        },
      },
    ],
  };

  return release;
}

export function buildAuditDossierMarkdown(
  contract: EvaluatedContract,
  analystNote?: string,
  reviewsOverride?: FindingReviewRecord[]
): string {
  const { assessment } = contract;
  const reviews = reviewsOverride ?? contract.reviews ?? [];

  // Latest human review decision per findingId
  const latestReviewByFinding = new Map<string, FindingReviewRecord>();
  for (const rev of reviews) {
    latestReviewByFinding.set(rev.findingId, rev);
  }

  const lines: string[] = [
    `# Dossiê de Auditoria Reproduzível — Contrato ${contract.contractNumber}`,
    ``,
    `> **Classificação**: ${assessment.headline}`,
    `> **Cobertura da análise**: ${assessment.coverageStatus ?? 'ADEQUATE'}`,
    `> **Aviso metodológico**: Os indicadores abaixo representam indícios objetivos, anomalias ou inconsistências verificáveis para revisão humana. Não constituem declaração automática de fraude.`,
    `> **Separação de licenças**: Software NEXOFIS licenciado sob GNU AGPL-3.0-only; os dados públicos e documentos exportados neste dossiê permanecem sujeitos à origem oficial e à legislação brasileira aplicável (LAI/LGPD).`,
    ``,
    `## 1. Identificação e Contexto Municipal`,
    `- **Município**: ${contract.municipalityName}/${contract.uf} (IBGE \`${contract.municipalityIbge}\`)`,
    `- **Órgão / Secretaria**: ${contract.entityName}`,
    `- **Controle PNCP**: \`${contract.pncpControlNumber}\``,
    `- **Modalidade**: ${contract.modality} (${contract.biddersCount} participante(s))`,
    `- **Objeto**: ${contract.object}`,
    `- **Vigência**: ${formatDateBR(contract.startDate)} a ${formatDateBR(contract.endDate)}`,
    `- **Fornecedor**: ${contract.supplier.legalName} (CNPJ/CPF ${formatCnpj(contract.supplier.cnpj)})`,
    ``,
    `## 2. Obrigação Contratada × Execução Financeira Comprovada`,
    `- **Valor original (obrigação)**: ${formatCurrencyBRL(contract.originalValue)}`,
    `- **Valor atualizado (obrigação)**: ${formatCurrencyBRL(contract.updatedValue)} (${formatPercentageBR(assessment.variationPct, true)})`,
    `- **Estimativa mensal contratual (\`estimated_monthly_contract_value\`)**: ${formatCurrencyBRL(assessment.executionChain.estimatedMonthlyContractValue)}/mês *(não comprova pagamento mensal)*`,
    `- **Empenhado**: ${formatCurrencyBRL(assessment.executionChain.committedTotal)} · **Liquidado**: ${formatCurrencyBRL(assessment.executionChain.liquidatedTotal)} · **Pago**: ${formatCurrencyBRL(assessment.executionChain.paidTotal)}`,
    `- **Norma vigente aplicada (Legal Time Travel)**: \`${assessment.appliedLegalRuleset.ruleId}\` — ${assessment.appliedLegalRuleset.legalBasis}${assessment.appliedLegalRuleset.effectiveFrom ? ` (vigência a partir de ${formatDateBR(assessment.appliedLegalRuleset.effectiveFrom)})` : ''}`,
    ``,
    `## 3. Pontos de Observação e Achados (${assessment.indicators.length})`,
    `| Finding ID | Código | Estado | Revisão Humana | Nível | Indicador | Severidade |`,
    `|---|---|---|---|---|---|---|`,
    ...assessment.indicators.map((ind) => {
      const rev = latestReviewByFinding.get(ind.findingId);
      const revLabel =
        rev?.action === 'dismiss'
          ? `DISMISSED (${rev.author})`
          : rev?.action === 'restore'
            ? `RESTAURADO (${rev.author})`
            : 'Pendente';
      return `| ${ind.findingId} | ${ind.code} | ${ind.state} | ${revLabel} | ${ind.evidenceLevel} | ${ind.title} | ${ind.severity} |`;
    }),
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

  if (reviews.length > 0) {
    lines.push(
      ``,
      `## 6. Trilha de Revisão Humana (Append-Only)`,
      ...reviews.map(
        (r) =>
          `- [${r.createdAt}] **${r.findingId}** (${r.action === 'dismiss' ? 'Descartado' : 'Restaurado'}) por **${r.author}** (regra \`${r.ruleVersion}\`): ${r.rationale}`
      )
    );
  }

  if (analystNote?.trim()) {
    lines.push(``, `## ${reviews.length > 0 ? '7' : '6'}. Nota do Auditor`, analystNote.trim());
  }

  lines.push(
    ``,
    `---`,
    `NEXOFIS (AGPL-3.0-only) · Motor forense: \`${assessment.engineVersion}\` · Ruleset legal: \`${assessment.appliedLegalRuleset.ruleId}\` · Gerado em: ${assessment.evaluatedAt}`
  );

  return lines.join('\n');
}

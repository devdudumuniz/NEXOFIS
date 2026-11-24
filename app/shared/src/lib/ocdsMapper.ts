import type { EvaluatedContract, FindingReviewRecord, OCDSRelease } from '../types/audit';
import { formatCnpj, formatCurrencyBRL, formatDateBR, formatPercentageBR } from './formatters';
import { extractDistinctContractDates } from './contractLifecycleEvents';

/**
 * Maps an evaluated contract to an OCDS 1.1-aligned release:
 * - implementation.transactions lives inside contracts[0].implementation (OCDS 1.1 schema)
 * - only verified Pagamento records become implementation transactions (never Empenho/Liquidação)
 * - preserves distinct payments when documentNumber is absent (never collapses independent IDs or emits empty id)
 * - never fabricates planning/tender/award values, dates, or bidder counts when unknown
 */
export function mapContractToOCDS(contract: EvaluatedContract): OCDSRelease {
  const ocid = `ocds-br-pncp-${contract.municipalityIbge || '0000000'}-${contract.id.toLowerCase()}`;
  const hasKnownOriginalValue = contract.originalValue > 0;
  const hasKnownUpdatedValue = contract.updatedValue > 0;
  const hasVerifiedAwardEvidence = hasKnownOriginalValue && Boolean(contract.signatureDate?.trim());

  const seenPayments = new Set<string>();
  const verifiedPayments = contract.payments.filter((p) => {
    if (p.type !== 'Pagamento' || !Number.isFinite(p.amount) || p.amount <= 0 || p.isReversal) {
      return false;
    }
    const docNum = (p.documentNumber || '').trim().toLowerCase();
    const dateKey = (p.date || '').slice(0, 10);
    const amountCents = Math.round(p.amount * 100);
    const key = docNum
      ? `doc:${docNum}|${dateKey}|${amountCents}|${(p.fundingSource ?? '').trim().toLowerCase()}`
      : `src:${(p.sourceSystem || '').trim().toLowerCase()}|id:${(p.id || '').trim().toLowerCase()}|${dateKey}|${amountCents}`;
    if (seenPayments.has(key)) return false;
    seenPayments.add(key);
    return true;
  });

  const tags: string[] = ['contract'];
  if (hasVerifiedAwardEvidence) {
    tags.unshift('tender', 'award');
  }
  if (verifiedPayments.length > 0) {
    tags.push('implementation');
  }

  const distinctDates = extractDistinctContractDates(contract);
  const tenderPeriod: { startDate?: string; endDate?: string } = {};
  if (distinctDates.submissionWindowStart) {
    tenderPeriod.startDate = distinctDates.submissionWindowStart;
  }
  if (distinctDates.submissionWindowEnd || distinctDates.submissionDate) {
    tenderPeriod.endDate = distinctDates.submissionWindowEnd ?? distinctDates.submissionDate ?? undefined;
  }

  const release: OCDSRelease = {
    ocid,
    id: `${ocid}-r1`,
    date: contract.assessment.evaluatedAt,
    tag: tags,
    initiationType: 'tender',
    buyer: {
      id: `BR-IBGE-${contract.municipalityIbge || '0000000'}-${contract.entityId}`,
      name: `${contract.entityName} (${contract.municipalityName}/${contract.uf})`,
    },
    tender: {
      id: `TND-${contract.pncpControlNumber}`,
      title: contract.object,
      procurementMethodDetails: contract.modality,
      ...(distinctDates.publicationDate ? { datePublished: distinctDates.publicationDate } : {}),
      ...(tenderPeriod.startDate || tenderPeriod.endDate ? { tenderPeriod } : {}),
      ...(typeof contract.biddersCount === 'number' && contract.biddersCount > 0
        ? { numberOfTenderers: contract.biddersCount }
        : {}),
      ...(hasKnownOriginalValue
        ? { value: { amount: contract.originalValue, currency: 'BRL' as const } }
        : {}),
    },
    ...(hasVerifiedAwardEvidence
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
        ...(hasVerifiedAwardEvidence ? { awardID: `AWD-${contract.id}` } : {}),
        title: `Contrato ${contract.contractNumber} — ${contract.object}`,
        status:
          contract.status === 'Encerrado'
            ? 'terminated'
            : contract.status === 'Suspenso'
              ? 'cancelled'
              : 'active',
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
          transactions: verifiedPayments.map((payment, idx) => ({
            id: payment.documentNumber?.trim() || payment.id?.trim() || `TX-${contract.id}-${idx + 1}`,
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
  const distinctDatesMd = extractDistinctContractDates(contract);
  const reviews = reviewsOverride ?? contract.reviews ?? [];

  const latestReviewByFinding = new Map<string, FindingReviewRecord>();
  for (const rev of reviews) {
    latestReviewByFinding.set(rev.findingId, rev);
  }

  const biddersDisplay =
    typeof contract.biddersCount === 'number' && contract.biddersCount > 0
      ? `${contract.biddersCount} participante(s)`
      : 'participantes não informados';

  const executionLine =
    contract.payments.length === 0
      ? `- **Execução financeira**: Não verificada (sem empenhos, liquidações ou pagamentos coletados)`
      : `- **Empenhado**: ${formatCurrencyBRL(assessment.executionChain.committedTotal)} · **Liquidado**: ${formatCurrencyBRL(assessment.executionChain.liquidatedTotal)} · **Pago líquido**: ${formatCurrencyBRL(assessment.executionChain.paidTotal)}${
          (assessment.executionChain.reversalsTotal ?? 0) > 0
            ? ` (estornos: ${formatCurrencyBRL(assessment.executionChain.reversalsTotal ?? 0)})`
            : ''
        }`;

  const lines: string[] = [
    `# Dossiê de Auditoria Reproduzível — Contrato ${contract.contractNumber}`,
    ``,
    `> **Classificação**: ${assessment.headline}`,
    `> **Cobertura da análise**: ${assessment.coverageStatus ?? 'ADEQUATE'}`,
    `> **Aviso metodológico**: Os indicadores abaixo representam indícios objetivos, anomalias ou inconsistências verificáveis para revisão humana. Não constituem declaração automática de fraude.`,
    `> **Separação de licenças**: Software NEXOFIS licenciado sob GNU AGPL-3.0-only; os dados públicos e documentos exportados neste dossiê permanecem sujeitos à origem oficial e à legislação brasileira aplicável (LAI/LGPD).`,
    ``,
    `## 1. Identificação e Contexto Municipal`,
    `- **Município**: ${contract.municipalityName}/${contract.uf} (IBGE \`${contract.municipalityIbge || 'não informado'}\`)`,
    `- **Órgão / Secretaria**: ${contract.entityName}`,
    `- **Controle PNCP**: \`${contract.pncpControlNumber}\``,
    `- **Modalidade**: ${contract.modality} (${biddersDisplay})`,
    `- **Objeto**: ${contract.object}`,
    ...(distinctDatesMd.publicationDate
      ? [`- **Data de publicação oficial**: ${formatDateBR(distinctDatesMd.publicationDate)}`]
      : []),
    ...(distinctDatesMd.submissionDate || distinctDatesMd.submissionWindowStart || distinctDatesMd.submissionWindowEnd
      ? [
          `- **Data / janela de submissão de propostas**: ${
            distinctDatesMd.submissionWindowStart && distinctDatesMd.submissionWindowEnd
              ? `${formatDateBR(distinctDatesMd.submissionWindowStart)} a ${formatDateBR(distinctDatesMd.submissionWindowEnd)}`
              : formatDateBR(distinctDatesMd.submissionDate ?? distinctDatesMd.submissionWindowEnd ?? distinctDatesMd.submissionWindowStart ?? '')
          }`,
        ]
      : []),
    ...(contract.signatureDate
      ? [`- **Data de assinatura**: ${formatDateBR(contract.signatureDate)}`]
      : []),
    `- **Vigência**: ${formatDateBR(contract.startDate)} a ${formatDateBR(contract.endDate)}`,
    `- **Fornecedor**: ${contract.supplier.legalName} (CNPJ/CPF ${formatCnpj(contract.supplier.cnpj)})`,
    ``,
    `## 2. Obrigação Contratada × Execução Financeira Comprovada`,
    `- **Valor original (obrigação)**: ${contract.originalValue > 0 ? formatCurrencyBRL(contract.originalValue) : 'Não informado'}`,
    `- **Valor atualizado (obrigação)**: ${contract.updatedValue > 0 ? `${formatCurrencyBRL(contract.updatedValue)} (${formatPercentageBR(assessment.variationPct, true)})` : 'Não informado'}`,
    `- **Estimativa mensal contratual (\`estimated_monthly_contract_value\`)**: ${assessment.executionChain.estimatedMonthlyContractValue > 0 ? `${formatCurrencyBRL(assessment.executionChain.estimatedMonthlyContractValue)}/mês *(não comprova pagamento mensal)*` : 'Não calculável (valor ou vigência ausente)'}`,
    executionLine,
    `- **Norma vigente aplicada (Legal Time Travel)**: \`${assessment.appliedLegalRuleset.ruleId}\` — ${assessment.appliedLegalRuleset.legalBasis}${assessment.appliedLegalRuleset.effectiveFrom ? ` (vigência a partir de ${formatDateBR(assessment.appliedLegalRuleset.effectiveFrom)})` : ''}`,
    ``,
    `## 3. Pontos de Observação e Achados (${assessment.indicators.length})`,
    `| Finding ID | Código | Estado | Revisão Humana | Nível | Indicador | Severidade |`,
    `|---|---|---|---|---|---|---|`,
    ...assessment.indicators.map((ind) => {
      const rev = latestReviewByFinding.get(ind.findingId);
      const isStale =
        Boolean(rev?.findingInputsDigest && ind.inputsDigest && rev.findingInputsDigest !== ind.inputsDigest);
      const revLabel =
        rev?.action === 'dismiss'
          ? isStale
            ? `REVISÃO DESATUALIZADA (${rev.author})`
            : `DISMISSED (${rev.author})`
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
          `- [${r.createdAt}] **${r.findingId}** (${r.action === 'dismiss' ? 'Descartado' : 'Restaurado'}) por **${r.author}**${r.actorRole ? ` [${r.actorRole}]` : ''} (regra \`${r.ruleVersion}\`): ${r.rationale}`
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

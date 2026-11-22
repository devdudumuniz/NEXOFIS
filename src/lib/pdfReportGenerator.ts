import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { EvaluatedContract, FindingReviewRecord, SavedDossierSnapshot } from '../types/audit';
import {
  buildIndicatorWeightChartData,
  rasterizeRechartsSvgs,
  type EmbeddedChartImage,
} from './dossierCharts';
import {
  formatCnpj,
  formatCurrencyBRL,
  formatDateBR,
  formatPercentageBR,
} from './formatters';

interface AutoTableDoc extends jsPDF {
  lastAutoTable?: { finalY: number };
}

export interface AuditPdfOptions {
  analystNote?: string;
  reviews?: FindingReviewRecord[];
  archivedSnapshot?: SavedDossierSnapshot | null;
  chartImages?: EmbeddedChartImage[];
}

export interface ConsolidatedAuditPdfOptions extends AuditPdfOptions {
  chartContainerEl?: HTMLElement | null;
}

function safePdfText(value: string | undefined | null): string {
  if (!value) return '—';
  // Replace uncommon typographic symbols unsupported by standard PDF WinAnsi encoding
  return value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2014/g, ' - ')
    .replace(/\u2013/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u2264/g, '<=')
    .replace(/\u2265/g, '>=')
    .replace(/\u2260/g, '!=')
    .replace(/\u00D7/g, 'x')
    .replace(/\u2192/g, '->')
    .replace(/\s+/g, ' ')
    .trim();
}

function getRiskColorRgb(
  score: number,
  coverageStatus?: 'ADEQUATE' | 'PARTIAL' | 'INSUFFICIENT'
): [number, number, number] {
  if (score >= 70) return [185, 28, 28]; // crimson-700
  if (score >= 40) return [180, 83, 9]; // amber-700
  if (coverageStatus === 'INSUFFICIENT') return [71, 85, 105]; // slate-600 neutral
  return [21, 128, 61]; // emerald-700
}

function getTierLabel(
  score: number,
  coverageStatus?: 'ADEQUATE' | 'PARTIAL' | 'INSUFFICIENT'
): string {
  if (score >= 70) return 'ALTO RISCO';
  if (score >= 40) return 'RISCO MEDIO';
  if (coverageStatus === 'INSUFFICIENT') return 'COBERTURA INSUFICIENTE';
  if (coverageStatus === 'PARTIAL') return 'COBERTURA PARCIAL';
  return 'BAIXO RISCO';
}

function ensureVerticalSpace(doc: AutoTableDoc, y: number, needed: number): number {
  const pageHeight = doc.internal.pageSize.getHeight();
  if (y + needed > pageHeight - 20) {
    doc.addPage();
    return 18;
  }
  return y;
}

/**
 * Generates a reproducible multi-page PDF audit summary containing conclusions,
 * financial execution separation, legal time-travel ruleset, indicators, verifiable
 * evidence hashes, source reconciliation, and human review trail.
 */
export function buildAuditReportPdf(
  contract: EvaluatedContract,
  options: AuditPdfOptions = {}
): Uint8Array {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    compress: true,
  }) as AutoTableDoc;

  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 14;
  const contentWidth = pageWidth - marginX * 2;
  const { assessment } = contract;
  const reviews = options.reviews ?? contract.reviews ?? [];

  const latestReviewByFinding = new Map<string, FindingReviewRecord>();
  const activeDismissedIds = new Set<string>();
  for (const rev of reviews) {
    latestReviewByFinding.set(rev.findingId, rev);
    if (rev.action === 'dismiss') {
      activeDismissedIds.add(rev.findingId);
    } else if (rev.action === 'restore') {
      activeDismissedIds.delete(rev.findingId);
    }
  }

  const effectiveScore =
    activeDismissedIds.size > 0
      ? Math.min(
          100,
          assessment.indicators.reduce(
            (sum, ind) => (activeDismissedIds.has(ind.findingId) ? sum : sum + ind.weightPoints),
            0
          )
        )
      : assessment.score;

  const effectiveHeadline =
    activeDismissedIds.size > 0
      ? `RISCO ${effectiveScore}/100 - ajustado apos ${activeDismissedIds.size} descarte(s) auditado(s)`
      : assessment.headline;

  // Header Banner (Brandbook Navy #0B2540)
  doc.setFillColor(11, 37, 64);
  doc.rect(0, 0, pageWidth, 30, 'F');
  // Brand accent stripe (#D95B35)
  doc.setFillColor(217, 91, 53);
  doc.rect(0, 29, pageWidth, 1.2, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13.5);
  doc.text('NEXOFIS - Relatorio Consolidado de Auditoria Forense', marginX, 11);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.2);
  doc.setTextColor(203, 213, 225);
  doc.text(
    safePdfText(
      `Contrato ${contract.contractNumber} | ${contract.municipalityName}/${contract.uf} (IBGE ${contract.municipalityIbge}) | Controle PNCP: ${contract.pncpControlNumber}`
    ),
    marginX,
    17.5,
    { maxWidth: contentWidth }
  );
  doc.text(
    safePdfText(
      `Gerado em ${formatDateBR(assessment.evaluatedAt)} | Motor ${assessment.engineVersion} | Ruleset ${assessment.appliedLegalRuleset.ruleId}${options.archivedSnapshot ? ` | Snapshot ${options.archivedSnapshot.id}` : ''} | Software AGPL-3.0-only`
    ),
    marginX,
    23.8,
    { maxWidth: contentWidth }
  );

  let y = 36;

  // 1. Audit Conclusion Summary Box
  const [r, g, b] = getRiskColorRgb(effectiveScore, assessment.coverageStatus);
  doc.setDrawColor(203, 213, 225);
  doc.setFillColor(250, 249, 245);
  doc.roundedRect(marginX, y, contentWidth, 30, 2, 2, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text('1. CONCLUSAO DA AUDITORIA E CLASSIFICACAO DE RISCO', marginX + 4, y + 6);

  doc.setFontSize(11.5);
  doc.setTextColor(r, g, b);
  doc.text(
    safePdfText(`${getTierLabel(effectiveScore, assessment.coverageStatus)} - ${effectiveHeadline}`),
    marginX + 4,
    y + 13,
    { maxWidth: contentWidth - 8 }
  );

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.8);
  doc.setTextColor(51, 65, 85);
  const disclaimer = safePdfText(
    `Cobertura da analise: ${assessment.coverageStatus ?? 'ADEQUATE'} | Norma vigente na assinatura: ${assessment.appliedLegalRuleset.legalBasis}. Aviso metodologico: os achados representam indicios objetivos e reproduziveis para revisao humana; nao constituem declaracao automatica de fraude.`
  );
  doc.text(disclaimer, marginX + 4, y + 19.5, { maxWidth: contentWidth - 8 });

  y += 36;

  // 2. Consolidated Visual Risk Analytics (Recharts PNG images or native vector bars fallback)
  const chartImages = options.chartImages ?? [];
  const indicatorChartData = buildIndicatorWeightChartData(contract, activeDismissedIds);

  if (chartImages.length > 0) {
    y = ensureVerticalSpace(doc, y, 64);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(15, 23, 42);
    doc.text('2. Painel Grafico Consolidado de Risco (Recharts)', marginX, y);
    y += 5;

    for (const chart of chartImages) {
      const safeAspect = Number.isFinite(chart.aspectRatio) && chart.aspectRatio > 0.4 ? chart.aspectRatio : 2.1;
      const maxW = contentWidth - 4;
      const maxH = 68;
      let imgW = maxW;
      let imgH = imgW / safeAspect;
      if (imgH > maxH) {
        imgH = maxH;
        imgW = imgH * safeAspect;
      }

      const cardHeight = imgH + (chart.subtitle ? 15 : 11);
      y = ensureVerticalSpace(doc, y, cardHeight + 4);

      doc.setDrawColor(226, 232, 240);
      doc.setFillColor(255, 255, 255);
      doc.roundedRect(marginX, y, contentWidth, cardHeight, 1.8, 1.8, 'FD');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(11, 37, 64);
      doc.text(safePdfText(chart.title), marginX + 3.5, y + 5.2, { maxWidth: contentWidth - 7 });

      let imageTop = y + 7.5;
      if (chart.subtitle) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.2);
        doc.setTextColor(100, 116, 139);
        doc.text(safePdfText(chart.subtitle), marginX + 3.5, y + 9.2, { maxWidth: contentWidth - 7 });
        imageTop = y + 11.5;
      }

      const imgX = marginX + (contentWidth - imgW) / 2;
      try {
        doc.addImage(chart.dataUrl, 'PNG', imgX, imageTop, imgW, imgH, undefined, 'FAST');
      } catch {
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(7.5);
        doc.setTextColor(148, 163, 184);
        doc.text('Grafico indisponivel para incorporacao nesta pagina.', marginX + 4, imageTop + 8);
      }

      y += cardHeight + 4;
    }

    y += 2;
  } else if (indicatorChartData.length > 0) {
    // Clean deterministic vector bar fallback for headless/Node generation without DOM
    const barRows = indicatorChartData.slice(0, 6);
    const blockHeight = 14 + barRows.length * 8.5;
    y = ensureVerticalSpace(doc, y, blockHeight + 6);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(15, 23, 42);
    doc.text('2. Painel Grafico Consolidado de Risco (Resumo Vetorial)', marginX, y);
    y += 4;

    doc.setDrawColor(226, 232, 240);
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(marginX, y, contentWidth, blockHeight, 1.8, 1.8, 'FD');

    let barY = y + 7;
    const maxPts = Math.max(40, ...barRows.map((row) => row.weightPoints));
    const labelWidth = 54;
    const barAreaWidth = contentWidth - labelWidth - 26;

    for (const row of barRows) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.4);
      doc.setTextColor(30, 41, 59);
      doc.text(safePdfText(row.code), marginX + 3.5, barY + 2.8, { maxWidth: labelWidth - 4 });

      // Track
      doc.setFillColor(241, 245, 249);
      doc.rect(marginX + labelWidth, barY, barAreaWidth, 4, 'F');

      // Filled bar
      const fillW = Math.max(1, (row.effectivePoints / maxPts) * barAreaWidth);
      if (row.dismissed) {
        doc.setFillColor(148, 163, 184);
      } else if (row.severity === 'CRÍTICA') {
        doc.setFillColor(185, 28, 28);
      } else if (row.severity === 'ALTA') {
        doc.setFillColor(217, 91, 53);
      } else if (row.severity === 'MÉDIA') {
        doc.setFillColor(217, 119, 6);
      } else {
        doc.setFillColor(11, 37, 64);
      }
      if (row.effectivePoints > 0) {
        doc.rect(marginX + labelWidth, barY, fillW, 4, 'F');
      }

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.4);
      doc.setTextColor(71, 85, 105);
      doc.text(
        row.dismissed ? '0 pts (desc.)' : `+${row.effectivePoints} pts`,
        marginX + contentWidth - 3.5,
        barY + 2.8,
        { align: 'right' }
      );
      barY += 8.5;
    }

    y += blockHeight + 7;
  }

  // 3. Contract Identification & Financial Execution
  y = ensureVerticalSpace(doc, y, 28);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(15, 23, 42);
  doc.text('3. Identificacao do Contrato e Execucao Financeira', marginX, y);
  y += 3;

  const exec = assessment.executionChain;
  autoTable(doc, {
    startY: y,
    margin: { left: marginX, right: marginX },
    theme: 'grid',
    styles: { fontSize: 8, cellPadding: 2.2, textColor: [30, 41, 59] },
    headStyles: { fillColor: [30, 41, 59], textColor: [255, 255, 255], fontStyle: 'bold' },
    head: [['Campo', 'Detalhamento Verificado']],
    body: [
      ['Orgao / Secretaria', safePdfText(contract.entityName)],
      ['Municipio / IBGE', safePdfText(`${contract.municipalityName}/${contract.uf} (IBGE ${contract.municipalityIbge})`)],
      ['Objeto', safePdfText(contract.object)],
      [
        'Modalidade e Vigencia',
        safePdfText(
          `${contract.modality} (${typeof contract.biddersCount === 'number' && contract.biddersCount > 0 ? `${contract.biddersCount} participante(s)` : 'participantes nao informados'}) | Assinatura: ${formatDateBR(contract.signatureDate)} | Vigencia: ${formatDateBR(contract.startDate)} a ${formatDateBR(contract.endDate)}`
        ),
      ],
      [
        'Fornecedor',
        safePdfText(
          `${contract.supplier.legalName} | CNPJ: ${formatCnpj(contract.supplier.cnpj)} | Situacao: ${contract.supplier.registrationStatus} | CNAE: ${contract.supplier.primaryCnaeCode} - ${contract.supplier.primaryCnaeDescription}`
        ),
      ],
      [
        'Nivel 1 - Obrigacao Contratada',
        safePdfText(
          contract.originalValue > 0 || contract.updatedValue > 0
            ? `Original: ${formatCurrencyBRL(contract.originalValue)} | Atualizado: ${formatCurrencyBRL(contract.updatedValue)} (${formatPercentageBR(assessment.variationPct, true)}) | Estimativa mensal: ${exec.estimatedMonthlyContractValue > 0 ? `${formatCurrencyBRL(exec.estimatedMonthlyContractValue)}/mes (nao comprova pagamento)` : 'nao calculavel'}`
            : 'Valor contratual nao informado na fonte coletada.'
        ),
      ],
      [
        'Nivel 2 - Execucao Comprovada',
        safePdfText(
          contract.payments.length === 0
            ? 'Nao verificado (sem execucao financeira coletada nas fontes oficiais).'
            : `Empenhado: ${formatCurrencyBRL(exec.committedTotal)} | Liquidado: ${formatCurrencyBRL(exec.liquidatedTotal)} | Pago comprovado: ${formatCurrencyBRL(exec.paidTotal)} | Ordem cronologica: ${exec.chronologicalOrderStatus}`
        ),
      ],
    ],
    columnStyles: {
      0: { cellWidth: 46, fontStyle: 'bold', fillColor: [248, 250, 252] },
      1: { cellWidth: contentWidth - 46 },
    },
  });

  y = (doc.lastAutoTable?.finalY ?? y + 40) + 8;

  // 4. Audit Findings / Risk Indicators
  y = ensureVerticalSpace(doc, y, 28);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(15, 23, 42);
  doc.text(`4. Achados e Pontos de Observacao (${assessment.indicators.length})`, marginX, y);
  y += 3;

  if (assessment.indicators.length === 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(71, 85, 105);
    doc.text(
      safePdfText(
        assessment.coverageStatus === 'INSUFFICIENT'
          ? 'Nenhum indicador confirmado devido a cobertura documental insuficiente. Necessaria diligencia de fontes primarias.'
          : 'Nenhum indicador de anomalia ou desvio ativo foi acionado pelas regras forenses vigentes.'
      ),
      marginX,
      y + 4,
      { maxWidth: contentWidth }
    );
    y += 12;
  } else {
    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      theme: 'striped',
      styles: { fontSize: 7.6, cellPadding: 2.1, textColor: [30, 41, 59], overflow: 'linebreak' },
      headStyles: { fillColor: [30, 41, 59], textColor: [255, 255, 255], fontStyle: 'bold' },
      head: [['ID / Codigo', 'Sev.', 'Estado / Revisao', 'Indicador e Fundamentacao Tecnica']],
      body: assessment.indicators.map((ind) => {
        const rev = latestReviewByFinding.get(ind.findingId);
        const isStale = Boolean(
          rev?.findingInputsDigest && ind.inputsDigest && rev.findingInputsDigest !== ind.inputsDigest
        );
        const revText =
          rev?.action === 'dismiss'
            ? isStale
              ? `REVISAO DESATUALIZADA (${rev.author})`
              : `DESCARTADO (${rev.author})`
            : rev?.action === 'restore'
              ? `RESTAURADO (${rev.author})`
              : 'Pendente';
        return [
          safePdfText(`${ind.findingId}\n${ind.code} (v${ind.ruleVersion})`),
          safePdfText(ind.severity),
          safePdfText(`${ind.state}\nNivel ${ind.evidenceLevel}\n${revText}`),
          safePdfText(`${ind.title}: ${ind.summary}${ind.legalReference ? ` [Base: ${ind.legalReference}]` : ''}`),
        ];
      }),
      columnStyles: {
        0: { cellWidth: 30, fontStyle: 'bold' },
        1: { cellWidth: 16 },
        2: { cellWidth: 32 },
        3: { cellWidth: contentWidth - 78 },
      },
    });
    y = (doc.lastAutoTable?.finalY ?? y + 30) + 8;
  }

  // 5. Verifiable Evidence Trail
  y = ensureVerticalSpace(doc, y, 28);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(15, 23, 42);
  doc.text(`5. Trilha Probatoria e Evidencias (${assessment.evidences.length})`, marginX, y);
  y += 3;

  if (assessment.evidences.length === 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(71, 85, 105);
    doc.text(
      'Nenhuma evidencia vinculada a achados ativos para este contrato.',
      marginX,
      y + 4
    );
    y += 12;
  } else {
    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      theme: 'grid',
      styles: { fontSize: 7.4, cellPadding: 2, textColor: [30, 41, 59], overflow: 'linebreak' },
      headStyles: { fillColor: [30, 41, 59], textColor: [255, 255, 255], fontStyle: 'bold' },
      head: [['Evidencia', 'Fonte / Documento', 'Trecho, Calculo e Integridade SHA-256']],
      body: assessment.evidences.map((ev) => [
        safePdfText(`${ev.id}\n${ev.indicatorCode}\nv${ev.ruleVersion}`),
        safePdfText(`${ev.sourceSystem}\n${ev.documentTitle} (pag. ${ev.pageNumber})`),
        safePdfText(
          `Trecho: "${ev.excerpt}" | Calculo: ${ev.calculation} | SHA-256: ${ev.sha256.slice(0, 20)}...`
        ),
      ]),
      columnStyles: {
        0: { cellWidth: 28, fontStyle: 'bold' },
        1: { cellWidth: 44 },
        2: { cellWidth: contentWidth - 72 },
      },
    });
    y = (doc.lastAutoTable?.finalY ?? y + 30) + 8;
  }

  // 6. Source Reconciliation (without overwrite)
  if (contract.sourceRecords.length > 0) {
    y = ensureVerticalSpace(doc, y, 26);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(15, 23, 42);
    doc.text(`6. Reconciliacao de Fontes (${contract.sourceRecords.length})`, marginX, y);
    y += 3;

    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      theme: 'striped',
      styles: { fontSize: 7.5, cellPadding: 2, textColor: [30, 41, 59] },
      headStyles: { fillColor: [51, 65, 85], textColor: [255, 255, 255], fontStyle: 'bold' },
      head: [['Sistema', 'ID Externo', 'Valor Original', 'Valor Atualizado', 'Situacao']],
      body: contract.sourceRecords.map((src) => [
        safePdfText(src.sourceSystem),
        safePdfText(src.externalId),
        safePdfText(formatCurrencyBRL(src.reportedOriginalValue)),
        safePdfText(formatCurrencyBRL(src.reportedUpdatedValue)),
        safePdfText(src.reportedStatus),
      ]),
    });
    y = (doc.lastAutoTable?.finalY ?? y + 24) + 8;
  }

  // 7. Human Review Trail & Analyst Note
  if (reviews.length > 0) {
    y = ensureVerticalSpace(doc, y, 24);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(15, 23, 42);
    doc.text(`7. Trilha de Revisao Humana Append-Only (${reviews.length})`, marginX, y);
    y += 3;

    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      theme: 'grid',
      styles: { fontSize: 7.5, cellPadding: 2, textColor: [30, 41, 59] },
      headStyles: { fillColor: [51, 65, 85], textColor: [255, 255, 255], fontStyle: 'bold' },
      head: [['Data', 'Finding', 'Acao', 'Autor', 'Justificativa Tecnica']],
      body: reviews.map((rev) => [
        safePdfText(formatDateBR(rev.createdAt)),
        safePdfText(rev.findingId),
        rev.action === 'dismiss' ? 'Descartado' : 'Restaurado',
        safePdfText(rev.author),
        safePdfText(rev.rationale),
      ]),
    });
    y = (doc.lastAutoTable?.finalY ?? y + 24) + 8;
  }

  if (options.analystNote?.trim()) {
    y = ensureVerticalSpace(doc, y, 22);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(15, 23, 42);
    doc.text('Nota Tecnica do Auditor', marginX, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(30, 41, 59);
    doc.text(safePdfText(options.analystNote), marginX, y, { maxWidth: contentWidth });
  }

  // Page footers across all pages
  const totalPages = doc.getNumberOfPages();
  const pageHeight = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setDrawColor(226, 232, 240);
    doc.line(marginX, pageHeight - 13, pageWidth - marginX, pageHeight - 13);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.2);
    doc.setTextColor(100, 116, 139);
    doc.text(
      safePdfText(
        'NEXOFIS (GNU AGPL-3.0-only) | Dados publicos sujeitos a LAI (Lei 12.527/2011) e LGPD (Lei 13.709/2018).'
      ),
      marginX,
      pageHeight - 8
    );
    doc.text(
      `Pagina ${i} de ${totalPages}`,
      pageWidth - marginX,
      pageHeight - 8,
      { align: 'right' }
    );
  }

  return new Uint8Array(doc.output('arraybuffer'));
}

function triggerPdfDownload(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadAuditReportPdf(
  contract: EvaluatedContract,
  options: AuditPdfOptions = {}
): string {
  const bytes = buildAuditReportPdf(contract, options);
  const safeNum = contract.contractNumber.replace(/[^a-zA-Z0-9_-]+/g, '-');
  const filename = `relatorio-auditoria-${contract.municipalityIbge || 'doc'}-${safeNum}.pdf`;
  triggerPdfDownload(bytes, filename);
  return filename;
}

/**
 * Generates and downloads a consolidated official PDF audit report, rasterizing
 * any live Recharts SVG risk charts inside `chartContainerEl` to high-DPI PNGs
 * before embedding them into the PDF.
 */
export async function downloadConsolidatedAuditReportPdf(
  contract: EvaluatedContract,
  options: ConsolidatedAuditPdfOptions = {}
): Promise<{ filename: string; embeddedChartsCount: number }> {
  const chartImages =
    options.chartImages ??
    (options.chartContainerEl ? await rasterizeRechartsSvgs(options.chartContainerEl) : []);

  const bytes = buildAuditReportPdf(contract, {
    ...options,
    chartImages,
  });

  const safeNum = contract.contractNumber.replace(/[^a-zA-Z0-9_-]+/g, '-');
  const filename = `relatorio-consolidado-${contract.municipalityIbge || 'doc'}-${safeNum}.pdf`;
  triggerPdfDownload(bytes, filename);
  return {
    filename,
    embeddedChartsCount: chartImages.length,
  };
}

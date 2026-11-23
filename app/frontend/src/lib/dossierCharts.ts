import type { EvaluatedContract, RiskSeverity } from '@nexofis/shared/types/audit';
import { formatCurrencyCompactBRL } from '@nexofis/shared/lib/formatters';

export interface IndicatorWeightDatum {
  findingId: string;
  code: string;
  axisLabel: string;
  shortLabel: string;
  fullTitle: string;
  weightPoints: number;
  effectivePoints: number;
  severity: RiskSeverity;
  dismissed: boolean;
  color: string;
}

export interface SeverityDistributionDatum {
  severity: RiskSeverity;
  label: string;
  count: number;
  weightSum: number;
  color: string;
}

export interface FinancialComparisonDatum {
  stage: string;
  amount: number;
  formatted: string;
  color: string;
  level: 'obrigacao' | 'execucao';
}

export interface FinancialComparisonChartData {
  hasContractValue: boolean;
  hasFinancialExecution: boolean;
  bars: FinancialComparisonDatum[];
}

export interface EmbeddedChartImage {
  title: string;
  subtitle?: string;
  dataUrl: string;
  aspectRatio: number;
}

export const SEVERITY_CHART_COLORS: Record<RiskSeverity, string> = {
  'CRÍTICA': '#B91C1C', // crimson-700
  ALTA: '#D95B35', // NEXOFIS brand copper/vermilion
  'MÉDIA': '#D97706', // amber-600
  BAIXA: '#0B2540', // NEXOFIS brand navy
};

const SEVERITY_ORDER: RiskSeverity[] = ['CRÍTICA', 'ALTA', 'MÉDIA', 'BAIXA'];

function truncateLabel(value: string, maxLen: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, Math.max(4, maxLen - 1)).trimEnd()}…`;
}

/**
 * Pure builder for the Recharts horizontal BarChart displaying weight contribution
 * of each forensic risk indicator (respecting auditor dismissals).
 */
export function buildIndicatorWeightChartData(
  contract: EvaluatedContract,
  dismissedFindingIds?: ReadonlySet<string> | Record<string, unknown>
): IndicatorWeightDatum[] {
  const isDismissed = (findingId: string): boolean => {
    if (!dismissedFindingIds) return false;
    if (dismissedFindingIds instanceof Set) return dismissedFindingIds.has(findingId);
    return Boolean((dismissedFindingIds as Record<string, unknown>)[findingId]);
  };

  return contract.assessment.indicators
    .map((ind) => {
      const dismissed = isDismissed(ind.findingId);
      return {
        findingId: ind.findingId,
        code: ind.code,
        axisLabel: truncateLabel(ind.code, 20),
        shortLabel: `${ind.code} · ${truncateLabel(ind.title, 26)}`,
        fullTitle: ind.title,
        weightPoints: ind.weightPoints,
        effectivePoints: dismissed ? 0 : ind.weightPoints,
        severity: ind.severity,
        dismissed,
        color: dismissed ? '#94A3B8' : SEVERITY_CHART_COLORS[ind.severity],
      };
    })
    .sort((a, b) => b.effectivePoints - a.effectivePoints || b.weightPoints - a.weightPoints);
}

/**
 * Pure builder for the Recharts PieChart / Donut showing active indicator distribution
 * grouped by forensic severity.
 */
export function buildSeverityDistributionChartData(
  contract: EvaluatedContract,
  dismissedFindingIds?: ReadonlySet<string> | Record<string, unknown>
): SeverityDistributionDatum[] {
  const isDismissed = (findingId: string): boolean => {
    if (!dismissedFindingIds) return false;
    if (dismissedFindingIds instanceof Set) return dismissedFindingIds.has(findingId);
    return Boolean((dismissedFindingIds as Record<string, unknown>)[findingId]);
  };

  const buckets = new Map<RiskSeverity, { count: number; weightSum: number }>();
  for (const sev of SEVERITY_ORDER) {
    buckets.set(sev, { count: 0, weightSum: 0 });
  }

  for (const ind of contract.assessment.indicators) {
    if (isDismissed(ind.findingId)) continue;
    const entry = buckets.get(ind.severity);
    if (entry) {
      entry.count += 1;
      entry.weightSum += ind.weightPoints;
    }
  }

  return SEVERITY_ORDER.map((severity) => {
    const entry = buckets.get(severity)!;
    return {
      severity,
      label: severity,
      count: entry.count,
      weightSum: entry.weightSum,
      color: SEVERITY_CHART_COLORS[severity],
    };
  }).filter((item) => item.count > 0);
}

/**
 * Pure builder comparing Level 1 (Contracted Obligation) and Level 2 (Proven Financial Execution).
 * Strictly honest: never fabricates execution bars when `contract.payments.length === 0`.
 */
export function buildFinancialComparisonChartData(
  contract: EvaluatedContract
): FinancialComparisonChartData {
  const hasContractValue = contract.originalValue > 0 || contract.updatedValue > 0;
  const hasFinancialExecution = contract.payments.length > 0;
  const exec = contract.assessment.executionChain;
  const bars: FinancialComparisonDatum[] = [];

  if (hasContractValue) {
    bars.push({
      stage: 'Original',
      amount: contract.originalValue,
      formatted: formatCurrencyCompactBRL(contract.originalValue),
      color: '#0284C7',
      level: 'obrigacao',
    });
    bars.push({
      stage: 'Atualizado',
      amount: contract.updatedValue,
      formatted: formatCurrencyCompactBRL(contract.updatedValue),
      color: contract.assessment.variationPct > 25 ? '#B91C1C' : '#D95B35',
      level: 'obrigacao',
    });
  }

  if (hasFinancialExecution) {
    bars.push({
      stage: 'Empenhado',
      amount: exec.committedTotal,
      formatted: formatCurrencyCompactBRL(exec.committedTotal),
      color: '#1D4ED8',
      level: 'execucao',
    });
    bars.push({
      stage: 'Liquidado',
      amount: exec.liquidatedTotal,
      formatted: formatCurrencyCompactBRL(exec.liquidatedTotal),
      color: '#0F766E',
      level: 'execucao',
    });
    const paid = exec.netPaidTotal ?? exec.paidTotal;
    bars.push({
      stage: 'Pago',
      amount: paid,
      formatted: formatCurrencyCompactBRL(paid),
      color: '#15803D',
      level: 'execucao',
    });
  }

  return {
    hasContractValue,
    hasFinancialExecution,
    bars,
  };
}

/**
 * Normalizes SVG text & axis colors to high-contrast dark ink on a white print background
 * before serializing a Recharts SVG for PDF rasterization.
 */
function prepareSvgForPrint(svgEl: SVGSVGElement, width: number, height: number): string {
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  if (!clone.getAttribute('viewBox')) {
    clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }

  // Ensure crisp print typography regardless of active UI dark theme
  const texts = clone.querySelectorAll('text, tspan');
  texts.forEach((node) => {
    const el = node as SVGElement;
    const fill = (el.getAttribute('fill') || '').toLowerCase();
    if (!fill || fill === 'currentcolor' || fill === '#cbd5e1' || fill === '#e2e8f0' || fill === '#faf9f5' || fill === '#94a3b8') {
      el.setAttribute('fill', '#1E293B');
    }
    if (!el.getAttribute('font-family')) {
      el.setAttribute('font-family', 'Helvetica, Arial, sans-serif');
    }
  });

  const gridLines = clone.querySelectorAll('.recharts-cartesian-grid line, .recharts-cartesian-axis-line, .recharts-cartesian-axis-tick-line');
  gridLines.forEach((node) => {
    const el = node as SVGElement;
    el.setAttribute('stroke', '#CBD5E1');
  });

  // Insert solid white background behind chart elements
  const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bgRect.setAttribute('x', '0');
  bgRect.setAttribute('y', '0');
  bgRect.setAttribute('width', String(width));
  bgRect.setAttribute('height', String(height));
  bgRect.setAttribute('fill', '#FFFFFF');
  clone.insertBefore(bgRect, clone.firstChild);

  return new XMLSerializer().serializeToString(clone);
}

function rasterizeSingleSvg(
  svgEl: SVGSVGElement,
  scale = 2
): Promise<{ dataUrl: string; aspectRatio: number } | null> {
  return new Promise((resolve) => {
    try {
      const rect = svgEl.getBoundingClientRect();
      const attrW = Number(svgEl.getAttribute('width')) || 0;
      const attrH = Number(svgEl.getAttribute('height')) || 0;
      const width = Math.max(240, Math.round(rect.width || attrW || 480));
      const height = Math.max(160, Math.round(rect.height || attrH || 240));

      const svgMarkup = prepareSvgForPrint(svgEl, width, height);
      const blob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);

      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = width * scale;
          canvas.height = height * scale;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            URL.revokeObjectURL(url);
            resolve(null);
            return;
          }
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.scale(scale, scale);
          ctx.drawImage(img, 0, 0, width, height);
          const dataUrl = canvas.toDataURL('image/png');
          URL.revokeObjectURL(url);
          resolve({ dataUrl, aspectRatio: width / height });
        } catch {
          URL.revokeObjectURL(url);
          resolve(null);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    } catch {
      resolve(null);
    }
  });
}

/**
 * Finds all rendered Recharts chart cards inside a container (marked with `[data-pdf-chart-card]`),
 * rasterizes their `.recharts-surface` SVG elements to high-DPI PNG data URLs, and returns
 * ordered chart images ready to embed inside jsPDF.
 */
export async function rasterizeRechartsSvgs(
  containerEl: HTMLElement | null | undefined
): Promise<EmbeddedChartImage[]> {
  if (!containerEl || typeof window === 'undefined' || typeof document === 'undefined') {
    return [];
  }

  const cards = Array.from(
    containerEl.querySelectorAll<HTMLElement>('[data-pdf-chart-card="true"]')
  );
  const results: EmbeddedChartImage[] = [];

  for (const card of cards) {
    const svgEl =
      card.querySelector<SVGSVGElement>('svg.recharts-surface') ??
      card.querySelector<SVGSVGElement>('.recharts-wrapper svg');
    if (!svgEl) continue;

    const title = card.getAttribute('data-pdf-chart-title') || 'Grafico de Risco';
    const subtitle = card.getAttribute('data-pdf-chart-subtitle') || undefined;
    const raster = await rasterizeSingleSvg(svgEl, 2);
    if (raster && raster.dataUrl.startsWith('data:image/png;base64,')) {
      results.push({
        title,
        subtitle,
        dataUrl: raster.dataUrl,
        aspectRatio: raster.aspectRatio,
      });
    }
  }

  return results;
}

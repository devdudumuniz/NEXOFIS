export interface DatePeriodFilter {
  startDate?: string;
  endDate?: string;
}

export interface DatePeriodValidation {
  valid: boolean;
  startDate?: string;
  endDate?: string;
  error?: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDateString(value?: string | null): value is string {
  if (!value || !ISO_DATE_RE.test(value.trim())) return false;
  const trimmed = value.trim();
  const [y, m, d] = trimmed.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function normalizeIsoDateParam(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return isValidIsoDateString(trimmed) ? trimmed : undefined;
}

export function validateDatePeriod(
  rawStart?: string | null,
  rawEnd?: string | null
): DatePeriodValidation {
  const startTrimmed = (rawStart ?? '').trim();
  const endTrimmed = (rawEnd ?? '').trim();

  if (startTrimmed && !isValidIsoDateString(startTrimmed)) {
    return {
      valid: false,
      error: 'Data de início inválida. Utilize o formato AAAA-MM-DD.',
    };
  }
  if (endTrimmed && !isValidIsoDateString(endTrimmed)) {
    return {
      valid: false,
      error: 'Data final inválida. Utilize o formato AAAA-MM-DD.',
    };
  }
  if (startTrimmed && endTrimmed && startTrimmed > endTrimmed) {
    return {
      valid: false,
      error: 'A data de início não pode ser posterior à data final.',
    };
  }

  return {
    valid: true,
    startDate: startTrimmed || undefined,
    endDate: endTrimmed || undefined,
  };
}

/**
 * Checks whether a contract/record reference date (ISO YYYY-MM-DD or full ISO timestamp)
 * falls inclusively within [startDate, endDate].
 */
export function matchesDatePeriod(
  referenceDateIso: string | undefined | null,
  period: DatePeriodFilter
): boolean {
  const hasStart = isValidIsoDateString(period.startDate);
  const hasEnd = isValidIsoDateString(period.endDate);
  if (!hasStart && !hasEnd) return true;

  const normalizedRef = (referenceDateIso ?? '').trim().slice(0, 10);
  if (!isValidIsoDateString(normalizedRef)) {
    // When a period filter is explicitly active, records without a valid reference date are excluded
    return false;
  }

  if (hasStart && normalizedRef < period.startDate!) return false;
  if (hasEnd && normalizedRef > period.endDate!) return false;
  return true;
}

/**
 * Computes PNCP API YYYYMMDD bounds from optional startDate/endDate, keeping
 * PNCP's 365-day maximum query window intact.
 */
export function resolvePncpPeriodBounds(
  period: DatePeriodFilter,
  fallbackYear = 2026
): { dataInicial: string; dataFinal: string; targetYear: number } {
  const startIso = isValidIsoDateString(period.startDate)
    ? period.startDate!
    : `${fallbackYear}-01-01`;

  const nowIso = new Date().toISOString().slice(0, 10);
  let endIso = isValidIsoDateString(period.endDate)
    ? period.endDate!
    : startIso.slice(0, 4) === nowIso.slice(0, 4)
      ? nowIso
      : `${startIso.slice(0, 4)}-12-31`;

  if (endIso < startIso) {
    endIso = startIso;
  }

  // Enforce PNCP consultation API 365-day maximum window
  const startMs = Date.parse(`${startIso}T00:00:00Z`);
  const endMs = Date.parse(`${endIso}T00:00:00Z`);
  const maxSpanMs = 364 * 24 * 60 * 60 * 1000;
  if (endMs - startMs > maxSpanMs) {
    const capped = new Date(startMs + maxSpanMs).toISOString().slice(0, 10);
    endIso = capped;
  }

  return {
    dataInicial: startIso.replace(/-/g, ''),
    dataFinal: endIso.replace(/-/g, ''),
    targetYear: Number(startIso.slice(0, 4)) || fallbackYear,
  };
}

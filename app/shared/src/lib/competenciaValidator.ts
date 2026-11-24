/**
 * Strict validator for Brazilian public-sector competência and calendar dates.
 * Rejects impossible months (e.g. 2026-13, 2026-00), impossible days (e.g. 2026-02-30),
 * out-of-range quadrimestres/semestres, and malformed strings.
 */

export type CompetenciaFormat = 'month' | 'quadrimestre' | 'semestre' | 'year' | 'date';

export interface CompetenciaValidationResult {
  valid: boolean;
  normalized: string | null;
  format: CompetenciaFormat | null;
  periodEndDate: string | null;
  year: number | null;
  monthIndex: number | null; // 1..12 representative month for distance checks
  reason?: string;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1900 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

export function validateIsoDate(raw: string | null | undefined): {
  valid: boolean;
  normalized: string | null;
  reason?: string;
} {
  if (!raw || typeof raw !== 'string') {
    return { valid: false, normalized: null, reason: 'Data ausente.' };
  }
  const trimmed = raw.trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return { valid: false, normalized: null, reason: `Formato de data inválido ("${trimmed}"; esperado YYYY-MM-DD).` };
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidCalendarDate(year, month, day)) {
    return { valid: false, normalized: null, reason: `Data de calendário inexistente ("${trimmed}").` };
  }
  return { valid: true, normalized: trimmed };
}

export function validateCompetencia(raw: string | null | undefined): CompetenciaValidationResult {
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return {
      valid: false,
      normalized: null,
      format: null,
      periodEndDate: null,
      year: null,
      monthIndex: null,
      reason: 'Competência ausente ou vazia.',
    };
  }

  const trimmed = raw.trim().toUpperCase();

  // YYYY-MM-DD
  const dateMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    if (!isValidCalendarDate(year, month, day)) {
      return {
        valid: false,
        normalized: null,
        format: null,
        periodEndDate: null,
        year: null,
        monthIndex: null,
        reason: `Data inválida na competência ("${raw}").`,
      };
    }
    return {
      valid: true,
      normalized: trimmed,
      format: 'date',
      periodEndDate: trimmed,
      year,
      monthIndex: month,
    };
  }

  // YYYY-MM
  const monthMatch = trimmed.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) {
    const year = Number(monthMatch[1]);
    const month = Number(monthMatch[2]);
    if (year < 1900 || year > 2100 || month < 1 || month > 12) {
      return {
        valid: false,
        normalized: null,
        format: null,
        periodEndDate: null,
        year: null,
        monthIndex: null,
        reason: `Mês inválido na competência ("${raw}"; mês deve estar entre 01 e 12).`,
      };
    }
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return {
      valid: true,
      normalized: `${monthMatch[1]}-${monthMatch[2]}`,
      format: 'month',
      periodEndDate: `${monthMatch[1]}-${monthMatch[2]}-${String(lastDay).padStart(2, '0')}`,
      year,
      monthIndex: month,
    };
  }

  // YYYY-Q1..Q3 (Brazilian quadrimestre used in SIAPS/SISAB)
  const quadMatch = trimmed.match(/^(\d{4})-?Q(\d+)$/);
  if (quadMatch) {
    const year = Number(quadMatch[1]);
    const q = Number(quadMatch[2]);
    if (year < 1900 || year > 2100 || q < 1 || q > 3) {
      return {
        valid: false,
        normalized: null,
        format: null,
        periodEndDate: null,
        year: null,
        monthIndex: null,
        reason: `Quadrimestre inválido ("${raw}"; esperado Q1, Q2 ou Q3).`,
      };
    }
    const endMap: Record<number, { end: string; month: number }> = {
      1: { end: `${year}-04-30`, month: 4 },
      2: { end: `${year}-08-31`, month: 8 },
      3: { end: `${year}-12-31`, month: 12 },
    };
    return {
      valid: true,
      normalized: `${year}-Q${q}`,
      format: 'quadrimestre',
      periodEndDate: endMap[q].end,
      year,
      monthIndex: endMap[q].month,
    };
  }

  // YYYY-S1..S2 (Semestre)
  const semMatch = trimmed.match(/^(\d{4})-?S(\d+)$/);
  if (semMatch) {
    const year = Number(semMatch[1]);
    const s = Number(semMatch[2]);
    if (year < 1900 || year > 2100 || s < 1 || s > 2) {
      return {
        valid: false,
        normalized: null,
        format: null,
        periodEndDate: null,
        year: null,
        monthIndex: null,
        reason: `Semestre inválido ("${raw}"; esperado S1 ou S2).`,
      };
    }
    return {
      valid: true,
      normalized: `${year}-S${s}`,
      format: 'semestre',
      periodEndDate: s === 1 ? `${year}-06-30` : `${year}-12-31`,
      year,
      monthIndex: s === 1 ? 6 : 12,
    };
  }

  // YYYY
  const yearMatch = trimmed.match(/^(\d{4})$/);
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    if (year < 1900 || year > 2100) {
      return {
        valid: false,
        normalized: null,
        format: null,
        periodEndDate: null,
        year: null,
        monthIndex: null,
        reason: `Ano fora do intervalo válido ("${raw}").`,
      };
    }
    return {
      valid: true,
      normalized: yearMatch[1],
      format: 'year',
      periodEndDate: `${year}-12-31`,
      year,
      monthIndex: 12,
    };
  }

  return {
    valid: false,
    normalized: null,
    format: null,
    periodEndDate: null,
    year: null,
    monthIndex: null,
    reason: `Formato de competência inválido ("${raw}"; formatos aceitos: YYYY-MM, YYYY-Q1..Q3, YYYY-S1..S2, YYYY ou YYYY-MM-DD).`,
  };
}

/**
 * Computes approximate distance in months between two valid competências.
 * Returns null if either competência is invalid.
 */
export function competenciaDistanceMonths(compA: string, compB: string): number | null {
  const a = validateCompetencia(compA);
  const b = validateCompetencia(compB);
  if (!a.valid || !b.valid || a.year === null || b.year === null || a.monthIndex === null || b.monthIndex === null) {
    return null;
  }
  return Math.abs(a.year * 12 + a.monthIndex - (b.year * 12 + b.monthIndex));
}

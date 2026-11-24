/**
 * NEXOFIS — Validação de competência para snapshots oficiais.
 *
 * Defeito corrigido: "2026-13" era aceito e produzia uma data inválida.
 */

const YYYY_MM_RE = /^(\d{4})-(\d{2})$/;
const YYYY_RE = /^\d{4}$/;
const YYYY_MM_DD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface CompetenciaValidationResult {
  valid: boolean;
  error?: string;
  normalized: string;
}

export function validateCompetencia(raw: string): CompetenciaValidationResult {
  const trimmed = (raw ?? '').trim();

  if (!trimmed) {
    return { valid: false, error: 'Competência vazia.', normalized: '' };
  }

  const ymdMatch = trimmed.match(YYYY_MM_DD_RE);
  if (ymdMatch) {
    const [, y, m, d] = ymdMatch;
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    if (month < 1 || month > 12) {
      return { valid: false, error: `Mês inválido (${month}) na competência "${trimmed}". Mês deve estar entre 01 e 12.`, normalized: trimmed };
    }
    if (day < 1 || day > 31) {
      return { valid: false, error: `Dia inválido (${day}) na competência "${trimmed}".`, normalized: trimmed };
    }
    const dt = new Date(Date.UTC(year, month - 1, day));
    if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
      return { valid: false, error: `Data de competência "${trimmed}" não corresponde a uma data de calendário válida.`, normalized: trimmed };
    }
    return { valid: true, normalized: trimmed };
  }

  const ymMatch = trimmed.match(YYYY_MM_RE);
  if (ymMatch) {
    const [, y, m] = ymMatch;
    const year = Number(y);
    const month = Number(m);
    if (month < 1 || month > 12) {
      return { valid: false, error: `Mês inválido (${month}) na competência "${trimmed}". Mês deve estar entre 01 e 12.`, normalized: trimmed };
    }
    if (year < 1990 || year > 2100) {
      return { valid: false, error: `Ano inválido (${year}) na competência "${trimmed}".`, normalized: trimmed };
    }
    return { valid: true, normalized: trimmed };
  }

  if (YYYY_RE.test(trimmed)) {
    const year = Number(trimmed);
    if (year < 1990 || year > 2100) {
      return { valid: false, error: `Ano inválido (${year}) na competência "${trimmed}".`, normalized: trimmed };
    }
    return { valid: true, normalized: trimmed };
  }

  return { valid: false, error: `Formato de competência inválido: "${trimmed}". Use YYYY-MM, YYYY ou YYYY-MM-DD.`, normalized: trimmed };
}

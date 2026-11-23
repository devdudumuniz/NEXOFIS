/**
 * Brazilian CNPJ utilities supporting BOTH:
 * - Legacy numeric CNPJs (14 digits)
 * - Receita Federal 2026 alphanumeric CNPJs (12 base chars [0-9A-Z] + 2 numeric check digits)
 *   per RFB Nota Técnica (IN RFB nº 2.229/2024): value(ch) = ASCII(ch) - 48, Modulo-11 DV.
 */

const ALPHANUMERIC_CNPJ_CLEAN_RE = /^[0-9A-Z]{12}[0-9]{2}$/;
const FORMATTED_CNPJ_GLOBAL_RE = /\b([0-9A-Za-z]{2}\.[0-9A-Za-z]{3}\.[0-9A-Za-z]{3}\/[0-9A-Za-z]{4}-\d{2})\b/g;

const WEIGHTS_DV1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] as const;
const WEIGHTS_DV2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] as const;

/**
 * Strips punctuation/whitespace and uppercases letters while preserving alphanumeric CNPJ chars.
 */
export function normalizeCnpj(raw?: string | null): string {
  if (!raw) return '';
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
}

/**
 * Checks whether the normalized string has valid 14-char CNPJ structure (numeric or alphanumeric).
 */
export function isCnpjFormat(raw?: string | null): boolean {
  const clean = normalizeCnpj(raw);
  return ALPHANUMERIC_CNPJ_CLEAN_RE.test(clean);
}

/**
 * Computes the two official RFB Modulo-11 check digits for a 12-char alphanumeric CNPJ base.
 */
export function computeCnpjCheckDigits(base12: string): string | null {
  const upper = base12.toUpperCase();
  if (!/^[0-9A-Z]{12}$/.test(upper)) return null;

  let sum1 = 0;
  for (let i = 0; i < 12; i++) {
    const val = upper.charCodeAt(i) - 48;
    sum1 += val * WEIGHTS_DV1[i];
  }
  const rem1 = sum1 % 11;
  const dv1 = rem1 < 2 ? 0 : 11 - rem1;

  let sum2 = 0;
  for (let i = 0; i < 12; i++) {
    const val = upper.charCodeAt(i) - 48;
    sum2 += val * WEIGHTS_DV2[i];
  }
  sum2 += dv1 * WEIGHTS_DV2[12];
  const rem2 = sum2 % 11;
  const dv2 = rem2 < 2 ? 0 : 11 - rem2;

  return `${dv1}${dv2}`;
}

/**
 * Validates numeric and RFB 2026 alphanumeric CNPJs (format + check digits + all-identical guard).
 */
export function isValidCnpj(raw?: string | null): boolean {
  const clean = normalizeCnpj(raw);
  if (!ALPHANUMERIC_CNPJ_CLEAN_RE.test(clean)) return false;
  // Reject all-identical numeric sequences like 00000000000000 or 11111111111111
  if (/^([0-9])\1{13}$/.test(clean)) return false;

  const expectedDv = computeCnpjCheckDigits(clean.slice(0, 12));
  return expectedDv !== null && clean.slice(12, 14) === expectedDv;
}

/**
 * Formats a 14-char numeric or alphanumeric CNPJ as XX.XXX.XXX/XXXX-XX.
 */
export function formatCnpjValue(raw?: string | null): string {
  if (!raw) return '—';
  const clean = normalizeCnpj(raw);
  if (!ALPHANUMERIC_CNPJ_CLEAN_RE.test(clean)) return raw;
  return `${clean.slice(0, 2)}.${clean.slice(2, 5)}.${clean.slice(5, 8)}/${clean.slice(8, 12)}-${clean.slice(12, 14)}`;
}

/**
 * Derives the matriz CNPJ (branch 0001 with recalculated Modulo-11 check digits) for any valid CNPJ.
 */
export function deriveMatrizCnpj(raw?: string | null): string | null {
  const clean = normalizeCnpj(raw);
  if (!ALPHANUMERIC_CNPJ_CLEAN_RE.test(clean)) return null;
  if (clean.slice(8, 12) === '0001') return null;
  const root8 = clean.slice(0, 8);
  const base12 = `${root8}0001`;
  const dv = computeCnpjCheckDigits(base12);
  return dv ? `${base12}${dv}` : null;
}

/**
 * Checks whether a normalized CNPJ contains alphabetic characters (RFB 2026 alphanumeric format).
 */
export function isAlphanumericCnpj(raw?: string | null): boolean {
  const clean = normalizeCnpj(raw);
  return ALPHANUMERIC_CNPJ_CLEAN_RE.test(clean) && /[A-Z]/.test(clean);
}

/**
 * Extracts formatted numeric or alphanumeric CNPJs from free text.
 */
export function extractFormattedCnpjsFromText(text: string): Array<{ raw: string; normalized: string }> {
  const matches: Array<{ raw: string; normalized: string }> = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(FORMATTED_CNPJ_GLOBAL_RE)) {
    const raw = m[1];
    const normalized = normalizeCnpj(raw);
    if (isCnpjFormat(normalized) && !seen.has(normalized)) {
      seen.add(normalized);
      matches.push({ raw, normalized });
    }
  }
  return matches;
}

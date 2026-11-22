import type { Municipality } from '../types/audit';

const BRAZILIAN_UFS = new Set([
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO',
  'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR',
  'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
]);

export function normalizeMunicipalityText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[()[\],/\\|—–-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ParsedMunicipalityQuery {
  raw: string;
  normalized: string;
  ibgeDigits: string | null;
  nameQuery: string;
  ufFilter: string | null;
}

/**
 * Parses free-text municipality queries in common Brazilian formats:
 * - "2902906" or "IBGE 2902906"
 * - "Barra do Choça"
 * - "Barra do Choça (BA)"
 * - "Barra do Choça - BA"
 * - "Barra do Choça / BA"
 * - "Barra do Choça, BA"
 * - "Barra do Choça BA"
 */
export function parseMunicipalityQuery(rawQuery: string, explicitUf?: string): ParsedMunicipalityQuery {
  const raw = rawQuery.trim();
  const explicit = (explicitUf ?? '').trim().toUpperCase();
  let ufFilter: string | null =
    explicit && explicit !== 'ALL' && BRAZILIAN_UFS.has(explicit) ? explicit : null;

  const onlyDigits = raw.replace(/\D/g, '');
  const ibgeDigits = /^\d{7}$/.test(onlyDigits) ? onlyDigits : null;

  const normalized = normalizeMunicipalityText(raw);
  let nameQuery = normalized;

  if (!ibgeDigits && normalized) {
    // Check trailing 2-letter Brazilian UF token (e.g. "barra do choca ba" from "Barra do Choça (BA)" or "Barra do Choça - BA")
    const tokens = normalized.split(' ').filter(Boolean);
    if (tokens.length >= 2) {
      const lastUpper = tokens[tokens.length - 1].toUpperCase();
      if (BRAZILIAN_UFS.has(lastUpper)) {
        if (!ufFilter) {
          ufFilter = lastUpper;
        }
        nameQuery = tokens.slice(0, -1).join(' ');
      }
    } else if (tokens.length === 1 && tokens[0].length === 2) {
      const singleUpper = tokens[0].toUpperCase();
      if (BRAZILIAN_UFS.has(singleUpper)) {
        if (!ufFilter) {
          ufFilter = singleUpper;
        }
        nameQuery = '';
      }
    }
  }

  return {
    raw,
    normalized,
    ibgeDigits,
    nameQuery,
    ufFilter,
  };
}

export function filterAndRankMunicipalities(
  items: Municipality[],
  rawQuery: string,
  explicitUf?: string,
  limit = 30
): Municipality[] {
  const parsed = parseMunicipalityQuery(rawQuery, explicitUf);

  let filtered = items;

  if (parsed.ibgeDigits) {
    filtered = filtered.filter((m) => m.ibgeCode === parsed.ibgeDigits);
    return filtered.slice(0, limit);
  }

  if (parsed.ufFilter) {
    filtered = filtered.filter((m) => m.uf.toUpperCase() === parsed.ufFilter);
  }

  const needle = parsed.nameQuery;
  if (needle) {
    filtered = filtered.filter((m) => {
      const normName = normalizeMunicipalityText(m.name);
      const normCombined = `${normName} ${m.uf.toLowerCase()}`;
      return (
        normName.includes(needle) ||
        normCombined.includes(parsed.normalized) ||
        m.ibgeCode.includes(needle)
      );
    });
  } else if (parsed.normalized && !parsed.ufFilter) {
    filtered = filtered.filter(
      (m) =>
        normalizeMunicipalityText(m.name).includes(parsed.normalized) ||
        m.ibgeCode.includes(parsed.normalized)
    );
  }

  const ranked = [...filtered].sort((a, b) => {
    if (needle) {
      const aNorm = normalizeMunicipalityText(a.name);
      const bNorm = normalizeMunicipalityText(b.name);
      const aRank = aNorm === needle ? 0 : aNorm.startsWith(needle) ? 1 : 2;
      const bRank = bNorm === needle ? 0 : bNorm.startsWith(needle) ? 1 : 2;
      if (aRank !== bRank) return aRank - bRank;
    }
    return a.name.localeCompare(b.name, 'pt-BR');
  });

  return ranked.slice(0, limit);
}

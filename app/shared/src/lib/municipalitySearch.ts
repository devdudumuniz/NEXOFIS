import type { Municipality } from '../types/audit';

const BRAZILIAN_UFS = new Set([
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO',
  'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR',
  'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
]);

// Official 2-digit IBGE UF prefixes (11..53)
const VALID_IBGE_UF_PREFIXES = new Set([
  '11', '12', '13', '14', '15', '16', '17',
  '21', '22', '23', '24', '25', '26', '27', '28', '29',
  '31', '32', '33', '35',
  '41', '42', '43',
  '50', '51', '52', '53',
]);

const STATE_NAME_TO_UF: Record<string, string> = {
  acre: 'AC',
  alagoas: 'AL',
  amazonas: 'AM',
  amapa: 'AP',
  bahia: 'BA',
  ceara: 'CE',
  'distrito federal': 'DF',
  'espirito santo': 'ES',
  goias: 'GO',
  maranhao: 'MA',
  'minas gerais': 'MG',
  'mato grosso do sul': 'MS',
  'mato grosso': 'MT',
  para: 'PA',
  paraiba: 'PB',
  pernambuco: 'PE',
  piaui: 'PI',
  parana: 'PR',
  'rio de janeiro': 'RJ',
  'rio grande do norte': 'RN',
  rondonia: 'RO',
  roraima: 'RR',
  'rio grande do sul': 'RS',
  'santa catarina': 'SC',
  sergipe: 'SE',
  'sao paulo': 'SP',
  tocantins: 'TO',
};

export function normalizeMunicipalityText(value: string): string {
  return value
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[()[\]{},;/\\|•·—–\-:."'`´]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type IbgeInputValidationStatus =
  | 'empty'
  | 'name_search'
  | 'valid_ibge'
  | 'invalid_ibge';

export interface IbgeInputValidationResult {
  status: IbgeInputValidationStatus;
  ibgeCode: string | null;
  digitCount: number;
  message: string | null;
}

/**
 * Real-time validator for the MunicipalityView input field.
 * - Empty string -> 'empty'
 * - Text-only municipality query (e.g. "Barra do Choça (BA)") -> 'name_search'
 * - Numeric or IBGE-code entry -> validates strictly for 7 digits + valid UF prefix (11..53)
 */
export function validateMunicipalityInput(rawInput: string): IbgeInputValidationResult {
  const cleaned = rawInput.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').trim();
  if (!cleaned) {
    return { status: 'empty', ibgeCode: null, digitCount: 0, message: null };
  }

  const digits = cleaned.replace(/\D/g, '');
  if (digits.length === 0) {
    return { status: 'name_search', ibgeCode: null, digitCount: 0, message: null };
  }

  // Strip optional "IBGE" label and numeric punctuation to see if user mixed stray letters into a code
  const withoutIbgeLabel = cleaned
    .replace(/\bibge\b/gi, '')
    .replace(/[\s.\-/():#,]+/g, '');
  const isPureNumericCodeAttempt = /^\d+$/.test(withoutIbgeLabel);

  // If the user pasted a formatted label containing a valid 7-digit IBGE code (e.g. "Barra do Choça · IBGE 2902906")
  if (digits.length === 7) {
    const ufPrefix = digits.slice(0, 2);
    if (!VALID_IBGE_UF_PREFIXES.has(ufPrefix)) {
      return {
        status: 'invalid_ibge',
        ibgeCode: null,
        digitCount: 7,
        message: `Código IBGE inválido: o prefixo "${ufPrefix}" não corresponde a nenhuma UF brasileira (use 7 dígitos oficiais).`,
      };
    }
    if (!isPureNumericCodeAttempt && !/\bibge\b/i.test(cleaned) && !/\(\d{7}\)/.test(cleaned)) {
      return {
        status: 'invalid_ibge',
        ibgeCode: null,
        digitCount: 7,
        message: 'Formato inválido: o código IBGE deve conter apenas 7 dígitos numéricos, sem letras misturadas.',
      };
    }
    return {
      status: 'valid_ibge',
      ibgeCode: digits,
      digitCount: 7,
      message: `Código IBGE válido (7 dígitos): ${digits}`,
    };
  }

  if (!isPureNumericCodeAttempt) {
    return {
      status: 'invalid_ibge',
      ibgeCode: null,
      digitCount: digits.length,
      message: `Formato de código IBGE inválido: informe exatamente 7 dígitos numéricos (encontrado: ${digits.length} dígito${digits.length === 1 ? '' : 's'} com caracteres não numéricos).`,
    };
  }

  if (digits.length < 7) {
    return {
      status: 'invalid_ibge',
      ibgeCode: null,
      digitCount: digits.length,
      message: `Código IBGE incompleto: informe exatamente 7 dígitos numéricos (${digits.length}/7).`,
    };
  }

  return {
    status: 'invalid_ibge',
    ibgeCode: null,
    digitCount: digits.length,
    message: `Código IBGE inválido: deve possuir exatamente 7 dígitos numéricos (${digits.length} informados).`,
  };
}

export interface ParsedMunicipalityQuery {
  raw: string;
  normalized: string;
  ibgeDigits: string | null;
  nameQuery: string;
  ufFilter: string | null;
}

/**
 * Parses and sanitizes free-text municipality queries in Brazilian formats:
 * - "2902906" or "IBGE 2902906"
 * - "Barra do Choça"
 * - "Barra do Choça (BA)" / "Barra do Choça (Bahia)"
 * - "Barra do Choça - BA" / "Barra do Choça / BA" / "Barra do Choça, BA"
 * - "BA - Barra do Choça"
 * - "Prefeitura Municipal de Barra do Choça (BA)"
 */
export function parseMunicipalityQuery(
  rawQuery: string,
  explicitUf?: string
): ParsedMunicipalityQuery {
  const raw = rawQuery.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').trim();
  const explicit = (explicitUf ?? '').trim().toUpperCase();
  let ufFilter: string | null =
    explicit && explicit !== 'ALL' && BRAZILIAN_UFS.has(explicit) ? explicit : null;

  const onlyDigits = raw.replace(/\D/g, '');
  const ibgeDigits =
    /^\d{7}$/.test(onlyDigits) && VALID_IBGE_UF_PREFIXES.has(onlyDigits.slice(0, 2))
      ? onlyDigits
      : null;

  let normalized = normalizeMunicipalityText(raw);
  // Strip common institutional copy-paste prefixes
  normalized = normalized
    .replace(/^(?:prefeitura\s+(?:municipal\s+)?(?:de|do|da)\s+|municipio\s+(?:de|do|da)\s+)/, '')
    .trim();

  let nameQuery = normalized;

  if (!ibgeDigits && normalized) {
    // 1. Check trailing full state name (e.g. "barra do choca bahia" from "Barra do Choça (Bahia)")
    const stateEntries = Object.entries(STATE_NAME_TO_UF).sort((a, b) => b[0].length - a[0].length);
    let matchedStateSuffix = false;
    for (const [stateNorm, ufCode] of stateEntries) {
      if (nameQuery.length > stateNorm.length + 1 && nameQuery.endsWith(` ${stateNorm}`)) {
        if (!ufFilter) ufFilter = ufCode;
        nameQuery = nameQuery.slice(0, -(stateNorm.length + 1)).trim();
        matchedStateSuffix = true;
        break;
      }
    }

    // 2. Check trailing or leading 2-letter Brazilian UF token
    if (!matchedStateSuffix) {
      const tokens = nameQuery.split(' ').filter(Boolean);
      if (tokens.length >= 2) {
        const lastUpper = tokens[tokens.length - 1].toUpperCase();
        const firstUpper = tokens[0].toUpperCase();
        if (BRAZILIAN_UFS.has(lastUpper)) {
          if (!ufFilter) ufFilter = lastUpper;
          nameQuery = tokens.slice(0, -1).join(' ');
        } else if (BRAZILIAN_UFS.has(firstUpper)) {
          if (!ufFilter) ufFilter = firstUpper;
          nameQuery = tokens.slice(1).join(' ');
        }
      } else if (tokens.length === 1 && tokens[0].length === 2) {
        const singleUpper = tokens[0].toUpperCase();
        if (BRAZILIAN_UFS.has(singleUpper)) {
          if (!ufFilter) ufFilter = singleUpper;
          nameQuery = '';
        }
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

/**
 * Optimal String Alignment (Damerau-Levenshtein) distance with early exit threshold.
 * Handles character insertions, deletions, substitutions, and adjacent transpositions.
 */
export function damerauLevenshtein(a: string, b: string, maxDistance = 4): number {
  const lenA = a.length;
  const lenB = b.length;
  if (Math.abs(lenA - lenB) > maxDistance) return maxDistance + 1;
  if (a === b) return 0;
  if (lenA === 0) return lenB;
  if (lenB === 0) return lenA;

  const dp: number[][] = Array.from({ length: lenA + 1 }, () => new Array<number>(lenB + 1).fill(0));
  for (let i = 0; i <= lenA; i++) dp[i][0] = i;
  for (let j = 0; j <= lenB; j++) dp[0][j] = j;

  for (let i = 1; i <= lenA; i++) {
    let rowMin = maxDistance + 1;
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, dp[i - 2][j - 2] + 1);
      }
      dp[i][j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
  }

  return dp[lenA][lenB];
}

function computeFuzzyScore(needle: string, targetNormName: string): number | null {
  if (needle.length < 3) return null;

  // 1. Full-string Damerau-Levenshtein similarity
  const maxFullDist = needle.length >= 10 ? 3 : needle.length >= 5 ? 2 : 1;
  const fullDist = damerauLevenshtein(needle, targetNormName, maxFullDist);
  if (fullDist <= maxFullDist) {
    const similarity = 1 - fullDist / Math.max(needle.length, targetNormName.length);
    if (similarity >= 0.72) {
      return 3 + fullDist * 0.1 + (1 - similarity);
    }
  }

  // 2. Token-by-token fuzzy match (e.g. "bara do cossa" -> "barra do choca", "vitoria conqista" -> "vitoria da conquista")
  const queryTokens = needle.split(' ').filter((t) => t.length >= 2);
  const targetTokens = targetNormName.split(' ').filter((t) => t.length >= 2);
  if (queryTokens.length === 0 || targetTokens.length === 0) return null;

  let totalPenalty = 0;
  for (const qt of queryTokens) {
    const allowed = qt.length >= 6 ? 2 : qt.length >= 4 ? 1 : 0;
    let bestTokenDist = allowed + 1;
    for (const tt of targetTokens) {
      if (tt.startsWith(qt)) {
        bestTokenDist = 0;
        break;
      }
      const dist = damerauLevenshtein(qt, tt, allowed);
      if (dist < bestTokenDist) bestTokenDist = dist;
    }
    if (bestTokenDist > allowed) return null;
    totalPenalty += bestTokenDist;
  }

  return 4 + totalPenalty * 0.2 + Math.abs(targetTokens.length - queryTokens.length) * 0.05;
}

export function filterAndRankMunicipalities(
  items: Municipality[],
  rawQuery: string,
  explicitUf?: string,
  limit = 30
): Municipality[] {
  const parsed = parseMunicipalityQuery(rawQuery, explicitUf);

  if (parsed.ibgeDigits) {
    return items.filter((m) => m.ibgeCode === parsed.ibgeDigits).slice(0, limit);
  }

  let pool = items;
  if (parsed.ufFilter) {
    pool = pool.filter((m) => m.uf.toUpperCase() === parsed.ufFilter);
  }

  const needle = parsed.nameQuery;
  if (!needle) {
    const sorted = [...pool].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    return sorted.slice(0, limit);
  }

  // Pass 1: exact, prefix, and substring matching
  const scored: Array<{ item: Municipality; rank: number }> = [];
  for (const m of pool) {
    const normName = normalizeMunicipalityText(m.name);
    const normCombined = `${normName} ${m.uf.toLowerCase()}`;
    if (normName === needle) {
      scored.push({ item: m, rank: 0 });
    } else if (normName.startsWith(needle)) {
      scored.push({ item: m, rank: 1 });
    } else if (
      normName.includes(needle) ||
      normCombined.includes(parsed.normalized) ||
      m.ibgeCode.includes(needle)
    ) {
      scored.push({ item: m, rank: 2 });
    }
  }

  // Pass 2: fuzzy matching fallback when exact/substring yields 0 matches (handles typos like "Bara do Choca (BA)")
  if (scored.length === 0) {
    for (const m of pool) {
      const normName = normalizeMunicipalityText(m.name);
      const fuzzyRank = computeFuzzyScore(needle, normName);
      if (fuzzyRank !== null) {
        scored.push({ item: m, rank: fuzzyRank });
      }
    }
  }

  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.item.name.localeCompare(b.item.name, 'pt-BR');
  });

  return scored.slice(0, limit).map((s) => s.item);
}

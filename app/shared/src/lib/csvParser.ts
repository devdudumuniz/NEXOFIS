/**
 * RFC 4180 compliant CSV/TSV parser for official Brazilian public datasets
 * (SIAPS, INEP, SINAPI, Câmara dos Deputados, SICONFI).
 *
 * Handles:
 *  - Quoted fields containing commas, semicolons, tabs, or newlines (e.g. `"75,5"`)
 *  - Escaped double quotes (`""` -> `"`)
 *  - UTF-8 BOM stripping
 *  - Delimiter detection ignoring delimiters inside quoted strings
 *  - Strict Brazilian decimal parsing (`parseBrazilianNumber`) without silent truncation
 */

export interface CsvParseResult {
  delimiter: ',' | ';' | '\t';
  headers: string[];
  rows: string[][];
}

export function detectCsvDelimiter(raw: string): ',' | ';' | '\t' {
  const cleaned = raw.replace(/^\uFEFF/, '');
  const counts: Record<',' | ';' | '\t', number> = { ';': 0, '\t': 0, ',': 0 };
  let inQuotes = false;

  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (ch === '"') {
      if (inQuotes && cleaned[i + 1] === '"') {
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes) {
      if (ch === '\n' || ch === '\r') {
        if (counts[';'] > 0 || counts['\t'] > 0 || counts[','] > 0) break;
        continue;
      }
      if (ch === ';' || ch === '\t' || ch === ',') {
        counts[ch] += 1;
      }
    }
  }

  if (counts[';'] >= counts['\t'] && counts[';'] >= counts[','] && counts[';'] > 0) return ';';
  if (counts['\t'] >= counts[','] && counts['\t'] > 0) return '\t';
  return ',';
}

export function parseCsvRows(
  raw: string,
  explicitDelimiter?: ',' | ';' | '\t'
): { delimiter: ',' | ';' | '\t'; records: string[][] } {
  const text = raw.replace(/^\uFEFF/, '');
  const delimiter = explicitDelimiter ?? detectCsvDelimiter(text);
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.trim().length === 0) {
      inQuotes = true;
      field = '';
    } else if (ch === delimiter) {
      row.push(field.trim());
      field = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') {
        i += 1;
      }
      row.push(field.trim());
      if (row.some((c) => c.length > 0)) {
        records.push(row);
      }
      row = [];
      field = '';
    } else if (ch === '\n') {
      row.push(field.trim());
      if (row.some((c) => c.length > 0)) {
        records.push(row);
      }
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  row.push(field.trim());
  if (row.some((c) => c.length > 0)) {
    records.push(row);
  }

  return { delimiter, records };
}

export function parseCsvTable(
  raw: string,
  explicitDelimiter?: ',' | ';' | '\t'
): CsvParseResult {
  const { delimiter, records } = parseCsvRows(raw, explicitDelimiter);
  if (records.length === 0) {
    return { delimiter, headers: [], rows: [] };
  }
  const [headerRow, ...dataRows] = records;
  return {
    delimiter,
    headers: headerRow.map((h) => h.trim()),
    rows: dataRows,
  };
}

/**
 * Parses Brazilian or international numeric strings (e.g. `"75,5"`, `"1.234,56"`,
 * `"R$ 42,50"`, `"0.82"`). Returns `null` for blank, dashed, or unpublished markers
 * so unpublished data is NEVER coerced to 0.
 */
export function parseBrazilianNumber(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const cleaned = String(raw)
    .replace(/^"|"$/g, '')
    .replace(/^R\$\s*/i, '')
    .replace(/%$/, '')
    .trim();

  if (
    !cleaned ||
    cleaned === '-' ||
    cleaned === '--' ||
    /^n\/?d$/i.test(cleaned) ||
    /^n\/?a$/i.test(cleaned) ||
    /^s\/?i$/i.test(cleaned) ||
    /nao\s*publicado/i.test(cleaned) ||
    /não\s*publicado/i.test(cleaned)
  ) {
    return null;
  }

  let normalized = cleaned.replace(/\s+/g, '');

  const hasComma = normalized.includes(',');
  const hasDot = normalized.includes('.');

  if (hasComma && hasDot) {
    // Whichever separator appears last is the decimal separator
    if (normalized.lastIndexOf(',') > normalized.lastIndexOf('.')) {
      normalized = normalized.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = normalized.replace(/,/g, '');
    }
  } else if (hasComma) {
    // Multiple commas -> thousands separators; single comma -> decimal separator
    const parts = normalized.split(',');
    normalized = parts.length > 2 ? parts.join('') : parts.join('.');
  } else if (hasDot) {
    // Multiple dots (e.g. 1.234.567) -> thousands separators
    const parts = normalized.split('.');
    if (parts.length > 2) {
      normalized = parts.join('');
    }
  }

  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    return null;
  }

  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
}

/**
 * NEXOFIS — CSV parser robusto para arquivos oficiais (SINAPI, SIAPS, Câmara, INEP).
 *
 * Defeito corrigido: o parser anterior usava `line.split(delimiter)` que não
 * respeita aspas — "75,5" virava dois campos (75 e 5) em vez de um (75,5).
 */

export function parseCsvLine(line: string, delimiter: string = ','): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      current += char;
      i++;
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (char === delimiter) {
        fields.push(current);
        current = '';
        i++;
        continue;
      }
      current += char;
      i++;
    }
  }

  fields.push(current);
  return fields;
}

export function parseCsvText(text: string, delimiter: string = ','): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      currentField += char;
      i++;
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (char === delimiter) {
        currentRow.push(currentField);
        currentField = '';
        i++;
        continue;
      }
      if (char === '\r') {
        currentRow.push(currentField);
        currentField = '';
        rows.push(currentRow);
        currentRow = [];
        i++;
        if (i < text.length && text[i] === '\n') i++;
        continue;
      }
      if (char === '\n') {
        currentRow.push(currentField);
        currentField = '';
        rows.push(currentRow);
        currentRow = [];
        i++;
        continue;
      }
      currentField += char;
      i++;
    }
  }

  if (currentField !== '' || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  while (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop();
  }

  return rows;
}

export function parseBrazilianNumber(raw: string): number | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return null;

  const cleaned = trimmed.replace(/R\$\s?/gi, '').replace(/\s/g, '');

  if (cleaned.includes(',')) {
    const normalized = cleaned.replace(/\./g, '').replace(',', '.');
    const num = Number.parseFloat(normalized);
    return Number.isFinite(num) ? num : null;
  }

  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

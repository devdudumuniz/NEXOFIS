import type { ExtractionMethod } from '../types/audit';

export interface ExtractedDocumentFields {
  contractNumber: string | null;
  cnpj: string | null;
  supplierName: string | null;
  municipalityName: string | null;
  ibgeCode: string | null;
  entityName: string | null;
  object: string | null;
  originalValue: number | null;
  updatedValue: number | null;
  signatureDate: string | null;
  extractionMethod: ExtractionMethod;
  confidence: number;
  excerpts: Array<{
    field: string;
    pageNumber: number;
    excerpt: string;
    normalizedValue: string;
  }>;
}

export function parseBrazilianMoney(raw: string): number | null {
  const cleaned = raw.replace(/R\$\s*/i, '').replace(/\./g, '').replace(',', '.').trim();
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) && num > 0 ? num : null;
}

export interface TabularContractRow {
  contractNumber: string;
  fiscalName?: string;
  supplierName: string;
  object: string;
  cnpj?: string;
  startDate?: string;
  endDate?: string;
}

/**
 * Extracts multiple contracts from municipal transparency tabular lists
 * (e.g., "Relação dos Contratos - Fiscal de Contratos").
 */
export function extractTabularContractRows(text: string): TabularContractRow[] {
  const rows: TabularContractRow[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Pattern for rows containing municipal codes like IN012/2026FMS, PE02-01/2026FMS, DL056/2026FMS, CRED012/2026FMS
  const rowPattern =
    /\b((?:IN|DL|PE|PP|CC|CP|CRED|CR)\s*\d{1,4}(?:-\d{1,3})?\/20\d{2}[A-Z]{0,6})\b/gi;

  for (const line of lines) {
    const codeMatch = line.match(rowPattern);
    if (!codeMatch) continue;
    const contractNumber = codeMatch[0].replace(/\s+/g, '').toUpperCase();
    if (seen.has(contractNumber)) continue;

    // Extract 11–14 digit CNPJ (raw or formatted)
    const cnpjFormatted = line.match(/\b(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})\b/);
    const cnpjRaw = line.match(/\b(\d{13,14})\b/);
    const cnpj = cnpjFormatted
      ? cnpjFormatted[1].replace(/\D/g, '')
      : cnpjRaw
        ? cnpjRaw[1].padStart(14, '0')
        : undefined;

    // Extract dates (MM/DD/YYYY or DD/MM/YYYY)
    const dates = Array.from(line.matchAll(/\b(\d{1,2}\/\d{1,2}\/20\d{2})\b/g)).map((m) => m[1]);

    // Split remaining columns by pipe or multi-space
    const parts = line
      .split(/\s*\|\s*|\t+/)
      .map((p) => p.trim())
      .filter(Boolean);

    let supplierName = 'Fornecedor listado na tabela municipal';
    let object = 'Objeto constante na Relação de Contratos';
    let fiscalName: string | undefined;

    if (parts.length >= 4) {
      fiscalName = parts[1];
      supplierName = parts[2];
      object = parts[3];
    } else {
      const cleaned = line
        .replace(codeMatch[0], '')
        .replace(/\b\d{1,2}\/\d{1,2}\/20\d{2}\b/g, '')
        .replace(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, '')
        .replace(/\b\d{13,14}\b/g, '')
        .replace(/\s{2,}/g, ' | ')
        .trim();
      const segs = cleaned.split('|').map((s) => s.trim()).filter(Boolean);
      if (segs.length >= 2) {
        supplierName = segs[0];
        object = segs.slice(1).join(' — ');
      } else if (segs.length === 1) {
        object = segs[0];
      }
    }

    seen.add(contractNumber);
    rows.push({
      contractNumber,
      fiscalName,
      supplierName,
      object,
      cnpj,
      startDate: dates[0],
      endDate: dates[1],
    });
  }

  return rows;
}

export function extractFieldsFromNativeText(
  text: string,
  method: ExtractionMethod = 'native'
): ExtractedDocumentFields {
  const excerpts: ExtractedDocumentFields['excerpts'] = [];

  // Contract number e.g. "Contrato nº 123/2026", "IN012/2026FMS", "PE02-01/2026FMS", "CRED012/2026FMS"
  const contractMatch =
    text.match(/contrato(?:\s+administrativo|\s+emergencial)?\s*(?:n[º°.]?\s*)?([A-Za-z]{0,6}\d{1,5}(?:-\d{1,3})?\/\d{4}[A-Za-z]{0,6})/i) ??
    text.match(/\b((?:IN|DL|PE|PP|CC|CP|CRED|CR)\d{1,4}(?:-\d{1,3})?\/20\d{2}[A-Za-z]{0,6})\b/i);
  const contractNumber = contractMatch ? contractMatch[1].toUpperCase() : null;
  if (contractMatch && contractNumber) {
    excerpts.push({
      field: 'numero_contrato',
      pageNumber: 1,
      excerpt: contractMatch[0].trim(),
      normalizedValue: contractNumber,
    });
  }

  // CNPJ e.g. 27.841.920/0001-63
  const cnpjMatch = text.match(/\b(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})\b/);
  const cnpj = cnpjMatch ? cnpjMatch[1].replace(/\D/g, '') : null;
  if (cnpjMatch && cnpj) {
    excerpts.push({
      field: 'cnpj',
      pageNumber: 1,
      excerpt: `CNPJ ${cnpjMatch[1]}`,
      normalizedValue: cnpj,
    });
  }

  // IBGE 7-digit code
  const ibgeMatch = text.match(/IBGE\s*[:#-]?\s*(\d{7})/i);
  const ibgeCode = ibgeMatch ? ibgeMatch[1] : null;
  if (ibgeMatch && ibgeCode) {
    excerpts.push({
      field: 'ibge_code',
      pageNumber: 1,
      excerpt: ibgeMatch[0].trim(),
      normalizedValue: ibgeCode,
    });
  }

  // Supplier name
  const supplierMatch = text.match(/(?:CONTRATADA|FORNECEDOR)\s*[:\-]\s*([^.,;\n]{5,110})/i);
  const supplierName = supplierMatch ? supplierMatch[1].trim() : null;
  if (supplierMatch && supplierName) {
    excerpts.push({
      field: 'fornecedor',
      pageNumber: 1,
      excerpt: supplierMatch[0].trim(),
      normalizedValue: supplierName,
    });
  }

  // Organ / Entity name
  const entityMatch = text.match(/(?:CONTRATANTE|ÓRGÃO|SECRETARIA)\s*[:\-]\s*([^.,;\n]{5,110})/i);
  const entityName = entityMatch ? entityMatch[1].trim() : null;
  if (entityMatch && entityName) {
    excerpts.push({
      field: 'orgao',
      pageNumber: 1,
      excerpt: entityMatch[0].trim(),
      normalizedValue: entityName,
    });
  }

  // Municipality name
  const muniMatch = text.match(/(?:MUNICÍPIO|CIDADE|PREFEITURA MUNICIPAL DE)\s*(?:DE)?\s*[:\-]?\s*([A-ZÀ-Úa-zà-ú\s]{3,45}?)(?:\/[A-Z]{2}|,|\(|\n|$)/i);
  const municipalityName = muniMatch ? muniMatch[1].trim() : null;

  // Object
  const objectMatch = text.match(/OBJETO\s*[:\-]\s*([^\n.]{12,260})/i);
  const object = objectMatch ? objectMatch[1].trim() : null;
  if (objectMatch && object) {
    excerpts.push({
      field: 'objeto',
      pageNumber: 1,
      excerpt: objectMatch[0].trim(),
      normalizedValue: object,
    });
  }

  // Monetary values (original & updated)
  const moneyMatches = Array.from(text.matchAll(/R\$\s*(\d{1,3}(?:\.\d{3})*(?:,\d{2}))/g));
  const parsedMoney = moneyMatches
    .map((m) => ({ raw: m[0], value: parseBrazilianMoney(m[1]) }))
    .filter((m): m is { raw: string; value: number } => m.value !== null);

  const originalValue = parsedMoney[0]?.value ?? null;
  const updatedValue = parsedMoney.length > 1 ? Math.max(...parsedMoney.map((m) => m.value)) : originalValue;

  if (parsedMoney[0]) {
    excerpts.push({
      field: 'valor_original',
      pageNumber: 1,
      excerpt: parsedMoney[0].raw,
      normalizedValue: parsedMoney[0].value.toFixed(2),
    });
  }

  // Signature date dd/mm/yyyy
  const dateMatch = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  const signatureDate = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : null;

  const detectedCount = [contractNumber, cnpj, supplierName, object, originalValue].filter(Boolean).length;
  const confidence = Number(Math.min(0.99, 0.55 + detectedCount * 0.088).toFixed(2));

  return {
    contractNumber,
    cnpj,
    supplierName,
    municipalityName,
    ibgeCode,
    entityName,
    object,
    originalValue,
    updatedValue,
    signatureDate,
    extractionMethod: method,
    confidence,
    excerpts,
  };
}

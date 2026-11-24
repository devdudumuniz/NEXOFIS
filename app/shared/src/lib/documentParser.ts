import type { ExtractionMethod } from '../types/audit';
import { extractFormattedCnpjsFromText, isCnpjFormat, normalizeCnpj } from './cnpj';

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
  /** Explicit official publication date extracted from document text (distinct from submission/signature — Defect 1.8) */
  publicationDate: string | null;
  /** Explicit proposal submission date / deadline extracted from document text (distinct from publication — Defect 1.8) */
  submissionDate: string | null;
  submissionWindowStart: string | null;
  submissionWindowEnd: string | null;
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

    // Extract 14-char numeric or RFB 2026 alphanumeric CNPJ (formatted or raw)
    const cnpjFormatted = extractFormattedCnpjsFromText(line)[0];
    const cnpjRaw = line.match(/\b(\d{13,14})\b/);
    const cnpj = cnpjFormatted
      ? cnpjFormatted.normalized
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

  // CNPJ (numeric legacy or RFB 2026 alphanumeric e.g. 00.000.000/E08G-12)
  const extractedCnpj = extractFormattedCnpjsFromText(text)[0] ?? null;
  const cnpj = extractedCnpj ? extractedCnpj.normalized : null;
  if (extractedCnpj && cnpj) {
    excerpts.push({
      field: 'cnpj',
      pageNumber: 1,
      excerpt: `CNPJ ${extractedCnpj.raw}`,
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

  // Helper: convert DD/MM/YYYY or YYYY-MM-DD match to ISO YYYY-MM-DD
  const toIsoBrOrIso = (raw: string): string | null => {
    const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (br) return `${br[3]}-${br[2]}-${br[1]}`;
    const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    return iso ? iso[1] : null;
  };

  // Explicit publication date (Defect 1.8: strictly separate from proposal submission and contract signature)
  const pubMatch = text.match(
    /(?:data\s+de\s+publica[cç][aã]o|publicado\s+em|publica[cç][aã]o(?:\s+no\s+(?:pncp|di[aá]rio\s+oficial|dou|dom))?)\s*[:\-]?\s*(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})/i
  );
  const publicationDate = pubMatch ? toIsoBrOrIso(pubMatch[1]) : null;
  if (pubMatch && publicationDate) {
    excerpts.push({
      field: 'data_publicacao',
      pageNumber: 1,
      excerpt: pubMatch[0].trim(),
      normalizedValue: publicationDate,
    });
  }

  // Explicit proposal submission window / date (Defect 1.8: never conflated with publicationDate)
  const subOpenMatch = text.match(
    /(?:abertura\s+(?:das?\s+)?propostas?|in[ií]cio\s+(?:do\s+)?(?:envio|recebimento|submiss[aã]o)\s+(?:de|das?)\s+propostas?)\s*[:\-]?\s*(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})/i
  );
  const submissionWindowStart = subOpenMatch ? toIsoBrOrIso(subOpenMatch[1]) : null;
  if (subOpenMatch && submissionWindowStart) {
    excerpts.push({
      field: 'abertura_propostas',
      pageNumber: 1,
      excerpt: subOpenMatch[0].trim(),
      normalizedValue: submissionWindowStart,
    });
  }

  const subCloseMatch = text.match(
    /(?:encerramento\s+(?:das?\s+)?propostas?|prazo\s+(?:final\s+)?(?:para\s+)?(?:envio|submiss[aã]o)\s+(?:de|das?)\s+propostas?|limite\s+(?:de|para)\s+submiss[aã]o)\s*[:\-]?\s*(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})/i
  );
  const submissionWindowEnd = subCloseMatch ? toIsoBrOrIso(subCloseMatch[1]) : null;
  if (subCloseMatch && submissionWindowEnd) {
    excerpts.push({
      field: 'encerramento_propostas',
      pageNumber: 1,
      excerpt: subCloseMatch[0].trim(),
      normalizedValue: submissionWindowEnd,
    });
  }

  const subExplicitMatch = text.match(
    /(?:data\s+de\s+submiss[aã]o|submiss[aã]o\s+(?:de|das?)\s+propostas?|envio\s+(?:de|das?)\s+propostas?)\s*[:\-]?\s*(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})/i
  );
  const submissionDate =
    (subExplicitMatch ? toIsoBrOrIso(subExplicitMatch[1]) : null) ??
    submissionWindowEnd ??
    submissionWindowStart ??
    null;
  if (subExplicitMatch && submissionDate) {
    excerpts.push({
      field: 'data_submissao',
      pageNumber: 1,
      excerpt: subExplicitMatch[0].trim(),
      normalizedValue: submissionDate,
    });
  }

  // Signature date dd/mm/yyyy (prefer explicit label; fallback to generic date only when not labeled as publication/submission)
  const sigLabeledMatch = text.match(
    /(?:data\s+de\s+assinatura|assinado\s+em|assinatura\s+do\s+contrato)\s*[:\-]?\s*(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})/i
  );
  let signatureDate: string | null = sigLabeledMatch ? toIsoBrOrIso(sigLabeledMatch[1]) : null;
  if (!signatureDate && !publicationDate && !submissionDate) {
    const dateMatch = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    signatureDate = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : null;
  }

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
    publicationDate,
    submissionDate,
    submissionWindowStart,
    submissionWindowEnd,
    signatureDate,
    extractionMethod: method,
    confidence,
    excerpts,
  };
}

/**
 * Validates actual file header magic bytes against declared MIME type
 * so spoofed extensions/headers are rejected before parsing.
 */
export function validateUploadedFileMagic(
  bytes: Uint8Array,
  mimeType: string
): { valid: boolean; reason?: string } {
  if (!bytes || bytes.length === 0) {
    return { valid: false, reason: 'Arquivo vazio.' };
  }

  if (mimeType === 'application/pdf') {
    const header = String.fromCharCode(...bytes.slice(0, 5));
    if (header !== '%PDF-') {
      return {
        valid: false,
        reason: 'Cabeçalho binário inválido: o arquivo declarado como PDF não inicia com assinatura %PDF-.',
      };
    }
    return { valid: true };
  }

  if (mimeType === 'image/png') {
    const ok =
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a;
    return ok
      ? { valid: true }
      : { valid: false, reason: 'Cabeçalho binário inválido para imagem PNG.' };
  }

  if (mimeType === 'image/jpeg') {
    const ok = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    return ok
      ? { valid: true }
      : { valid: false, reason: 'Cabeçalho binário inválido para imagem JPEG.' };
  }

  if (mimeType === 'image/webp') {
    const riff = String.fromCharCode(...bytes.slice(0, 4));
    const webp = String.fromCharCode(...bytes.slice(8, 12));
    const ok = bytes.length >= 12 && riff === 'RIFF' && webp === 'WEBP';
    return ok
      ? { valid: true }
      : { valid: false, reason: 'Cabeçalho binário inválido para imagem WEBP.' };
  }

  if (mimeType === 'image/tiff') {
    const ok =
      bytes.length >= 4 &&
      ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
        (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a));
    return ok
      ? { valid: true }
      : { valid: false, reason: 'Cabeçalho binário inválido para imagem TIFF.' };
  }

  if (mimeType === 'text/plain') {
    // Reject obvious binary files (NUL bytes in first 1024 bytes)
    const sample = bytes.slice(0, Math.min(bytes.length, 1024));
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] === 0x00) {
        return {
          valid: false,
          reason: 'Arquivo declarado como texto plano contém bytes nulos binários.',
        };
      }
    }
    return { valid: true };
  }

  return { valid: false, reason: `Formato não suportado (${mimeType}).` };
}

/**
 * Ensures outbound URLs target only public HTTP(S) destinations and never private/loopback/metadata hosts.
 */
export function isSafePublicUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '[::1]' ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
      /^fe80:/i.test(host) ||
      /^fc00:/i.test(host) ||
      /^fd/i.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function normalizeKey(value?: string | null): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ContractMatchCandidate {
  id: string;
  contractNumber: string;
  pncpControlNumber: string;
  municipalityIbge: string;
  municipalityName: string;
  supplierCnpj: string;
  supplierName: string;
}

export type DocumentMatchResult<T extends { id: string; contractNumber: string; pncpControlNumber: string; municipalityIbge: string; municipalityName: string; supplier: { cnpj: string; legalName: string } }> =
  | { status: 'matched'; contract: T; matchRule: string }
  | { status: 'ambiguous'; candidates: ContractMatchCandidate[]; reason: string }
  | { status: 'unmatched'; reason: string };

/**
 * Strict multi-key document-to-contract reconciliation.
 * Refuses to auto-attach based solely on supplier CNPJ or solely on ambiguous contract number.
 */
export function resolveDocumentContractMatch<
  T extends {
    id: string;
    contractNumber: string;
    pncpControlNumber: string;
    municipalityIbge: string;
    municipalityName: string;
    supplier: { cnpj: string; legalName: string };
  },
>(
  extracted: Pick<ExtractedDocumentFields, 'contractNumber' | 'cnpj' | 'ibgeCode' | 'municipalityName'> & {
    pncpControlNumber?: string | null;
  },
  existingContracts: T[]
): DocumentMatchResult<T> {
  const toCandidate = (c: T): ContractMatchCandidate => ({
    id: c.id,
    contractNumber: c.contractNumber,
    pncpControlNumber: c.pncpControlNumber,
    municipalityIbge: c.municipalityIbge,
    municipalityName: c.municipalityName,
    supplierCnpj: c.supplier.cnpj,
    supplierName: c.supplier.legalName,
  });

  // 1. Exact PNCP control number match (globally unique key)
  if (extracted.pncpControlNumber?.trim()) {
    const pncpKey = normalizeKey(extracted.pncpControlNumber);
    const pncpMatches = existingContracts.filter(
      (c) => normalizeKey(c.pncpControlNumber) === pncpKey
    );
    if (pncpMatches.length === 1) {
      return {
        status: 'matched',
        contract: pncpMatches[0],
        matchRule: 'numero_controle_pncp',
      };
    }
  }

  const numKey = normalizeKey(extracted.contractNumber);
  const cnpjClean = normalizeCnpj(extracted.cnpj);
  const hasCnpj = isCnpjFormat(cnpjClean);
  const ibgeDigits = extracted.ibgeCode && /^\d{7}$/.test(extracted.ibgeCode) ? extracted.ibgeCode : '';
  const muniKey = normalizeKey(extracted.municipalityName);

  // 2. Composite keys: contractNumber + (ibgeCode OR supplier CNPJ OR municipalityName)
  if (numKey) {
    const byNumber = existingContracts.filter(
      (c) => normalizeKey(c.contractNumber) === numKey
    );

    if (byNumber.length > 0) {
      // 2a. contractNumber + ibgeCode
      if (ibgeDigits) {
        const strong = byNumber.filter((c) => c.municipalityIbge === ibgeDigits);
        if (strong.length === 1) {
          return { status: 'matched', contract: strong[0], matchRule: 'contract_number+ibge' };
        }
        if (strong.length > 1 && hasCnpj) {
          const stronger = strong.filter((c) => normalizeCnpj(c.supplier.cnpj) === cnpjClean);
          if (stronger.length === 1) {
            return {
              status: 'matched',
              contract: stronger[0],
              matchRule: 'contract_number+ibge+cnpj',
            };
          }
        }
      }

      // 2b. contractNumber + supplier CNPJ
      if (hasCnpj) {
        const strong = byNumber.filter((c) => normalizeCnpj(c.supplier.cnpj) === cnpjClean);
        if (strong.length === 1) {
          return { status: 'matched', contract: strong[0], matchRule: 'contract_number+cnpj' };
        }
      }

      // 2c. contractNumber + municipalityName
      if (muniKey) {
        const strong = byNumber.filter(
          (c) => normalizeKey(c.municipalityName) === muniKey
        );
        if (strong.length === 1) {
          return {
            status: 'matched',
            contract: strong[0],
            matchRule: 'contract_number+municipality',
          };
        }
      }

      // Number matched one or more contracts WITHOUT corroborating municipality/CNPJ -> ambiguous!
      return {
        status: 'ambiguous',
        candidates: byNumber.slice(0, 10).map(toCandidate),
        reason:
          byNumber.length > 1
            ? `Número ${extracted.contractNumber} existe em ${byNumber.length} contratos distintos e não há IBGE/CNPJ corroborante para desambiguar.`
            : `Número ${extracted.contractNumber} localizado sem IBGE ou CNPJ corroborante no documento; vinculação automática recusada para evitar falso vínculo entre entes.`,
      };
    }
  }

  // 3. Supplier CNPJ alone NEVER auto-attaches (a supplier may hold many contracts)
  if (hasCnpj) {
    const byCnpj = existingContracts.filter((c) => normalizeCnpj(c.supplier.cnpj) === cnpjClean);
    if (byCnpj.length > 0) {
      return {
        status: 'ambiguous',
        candidates: byCnpj.slice(0, 10).map(toCandidate),
        reason: `Apenas o CNPJ ${cnpjClean} coincidiu com ${byCnpj.length} contrato(s) no repositório sem número de contrato compatível; vinculação automática bloqueada.`,
      };
    }
  }

  return {
    status: 'unmatched',
    reason: 'Nenhuma correspondência inequívoca por chave composta encontrada no repositório.',
  };
}


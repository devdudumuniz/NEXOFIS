import zlib from 'node:zlib';

export interface NativePdfExtractionOptions {
  maxStreamOutputBytes?: number;
  maxTotalOutputBytes?: number;
  maxStreams?: number;
  maxPages?: number;
  maxDurationMs?: number;
}

export interface NativePdfExtractionResult {
  text: string;
  pageCount: number;
  originalPageCount: number;
  processedPageCount: number;
  isLikelyScanned: boolean;
  truncated: boolean;
  budgetExceeded: boolean;
  budgetReason?: string;
  decompressedBytes: number;
  extractorVersion: string;
}

const DEFAULT_MAX_STREAM_OUTPUT_BYTES = 1 * 1024 * 1024; // 1 MiB per FlateDecode stream
const DEFAULT_MAX_TOTAL_OUTPUT_BYTES = 4 * 1024 * 1024; // 4 MiB aggregate decoded budget
const DEFAULT_MAX_STREAMS = 400;
const DEFAULT_MAX_PAGES = 120;
const DEFAULT_MAX_DURATION_MS = 2500;

function unescapePdfString(raw: string): string {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\([0-7]{1,3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function extractTextOperatorsFromStream(content: string): string[] {
  const chunks: string[] = [];
  const btBlocks = content.match(/BT[\s\S]*?ET/g) ?? [content];
  for (const block of btBlocks) {
    const tjMatches = block.matchAll(/\((?:\\.|[^\\()])*\)\s*Tj/g);
    for (const m of tjMatches) {
      const inner = m[0].replace(/\)\s*Tj$/, '').slice(1);
      const decoded = unescapePdfString(inner).trim();
      if (decoded) chunks.push(decoded);
    }

    const tjArrayMatches = block.matchAll(/\[([\s\S]*?)\]\s*TJ/g);
    for (const m of tjArrayMatches) {
      const innerParts: string[] = [];
      const stringMatches = m[1].matchAll(/\((?:\\.|[^\\()])*\)/g);
      for (const sm of stringMatches) {
        innerParts.push(unescapePdfString(sm[0].slice(1, -1)));
      }
      const joined = innerParts.join('').trim();
      if (joined) chunks.push(joined);
    }
  }
  return chunks;
}

function inflateBounded(
  rawSlice: Buffer,
  maxOutputLength: number
): { ok: true; data: Buffer } | { ok: false; budgetExceeded: boolean } {
  const safeLimit = Math.max(1024, maxOutputLength);
  try {
    const out = zlib.inflateSync(rawSlice, { maxOutputLength: safeLimit });
    return { ok: true, data: out };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_BUFFER_TOO_LARGE' || /Cannot create a Buffer larger than/i.test(String(err))) {
      return { ok: false, budgetExceeded: true };
    }
    try {
      const out = zlib.inflateRawSync(rawSlice, { maxOutputLength: safeLimit });
      return { ok: true, data: out };
    } catch (rawErr) {
      const rawCode = (rawErr as NodeJS.ErrnoException)?.code;
      if (
        rawCode === 'ERR_BUFFER_TOO_LARGE' ||
        /Cannot create a Buffer larger than/i.test(String(rawErr))
      ) {
        return { ok: false, budgetExceeded: true };
      }
      return { ok: false, budgetExceeded: false };
    }
  }
}

/**
 * Extracts readable native text from uncompressed and FlateDecode-compressed PDF streams
 * with strict decompression byte, stream, page, and time budgets (A11 — prevents PDF zip-bomb DoS).
 */
export function extractNativePdfText(
  buffer: Buffer,
  options: NativePdfExtractionOptions = {}
): NativePdfExtractionResult {
  const startedAt = Date.now();
  const maxStreamBytes = options.maxStreamOutputBytes ?? DEFAULT_MAX_STREAM_OUTPUT_BYTES;
  const maxTotalBytes = options.maxTotalOutputBytes ?? DEFAULT_MAX_TOTAL_OUTPUT_BYTES;
  const maxStreams = options.maxStreams ?? DEFAULT_MAX_STREAMS;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;

  const latin1 = buffer.toString('latin1');

  const pageMatches = latin1.match(/\/Type\s*\/Page\b(?!s)/g);
  const originalPageCount = Math.max(1, pageMatches ? pageMatches.length : 1);
  const processedPageCount = Math.min(originalPageCount, maxPages);

  let truncated = originalPageCount > maxPages;
  let budgetExceeded = false;
  let budgetReason: string | undefined = truncated
    ? `Documento possui ${originalPageCount} páginas; processamento nativo limitado a ${maxPages} páginas.`
    : undefined;
  let decompressedBytes = 0;
  let streamCount = 0;

  const collected: string[] = [];

  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRegex.exec(latin1)) !== null) {
    if (Date.now() - startedAt > maxDurationMs) {
      budgetExceeded = true;
      truncated = true;
      budgetReason = `Orçamento de tempo de extração PDF (${maxDurationMs} ms) excedido.`;
      break;
    }
    if (streamCount >= maxStreams) {
      budgetExceeded = true;
      truncated = true;
      budgetReason = `Limite de streams PDF (${maxStreams}) excedido.`;
      break;
    }
    const remainingTotal = maxTotalBytes - decompressedBytes;
    if (remainingTotal <= 0) {
      budgetExceeded = true;
      truncated = true;
      budgetReason = `Orçamento máximo de descompressão PDF (${Math.round(maxTotalBytes / 1024)} KiB) excedido.`;
      break;
    }

    streamCount += 1;
    const startOffset = match.index;
    const dictWindow = latin1.slice(Math.max(0, startOffset - 260), startOffset);
    const streamHeaderLen = match[0].indexOf('\n') + 1;
    const streamBodyStart = startOffset + streamHeaderLen;
    const streamBodyEnd = match.index + match[0].length - 'endstream'.length;
    const rawSlice = buffer.subarray(streamBodyStart, Math.max(streamBodyStart, streamBodyEnd));

    let decodedContent = '';
    if (/\/Filter\s*\/FlateDecode|\/FlateDecode\b/.test(dictWindow)) {
      const allowed = Math.min(maxStreamBytes, remainingTotal);
      const inflated = inflateBounded(rawSlice, allowed);
      if (!inflated.ok) {
        if (inflated.budgetExceeded) {
          budgetExceeded = true;
          truncated = true;
          budgetReason = `Stream FlateDecode excedeu o limite seguro de descompressão (${Math.round(allowed / 1024)} KiB — possível zip-bomb ou stream malformado).`;
          break;
        }
      } else {
        decompressedBytes += inflated.data.length;
        decodedContent = inflated.data.toString('latin1');
      }
    } else if (!/\/Subtype\s*\/Image/.test(dictWindow)) {
      const sliceLen = Math.min(rawSlice.length, remainingTotal);
      if (rawSlice.length > remainingTotal) {
        budgetExceeded = true;
        truncated = true;
        budgetReason = `Orçamento máximo de leitura PDF (${Math.round(maxTotalBytes / 1024)} KiB) excedido.`;
      }
      decompressedBytes += sliceLen;
      decodedContent = rawSlice.subarray(0, sliceLen).toString('latin1');
    }

    if (decodedContent) {
      const pieces = extractTextOperatorsFromStream(decodedContent);
      if (pieces.length > 0) {
        collected.push(pieces.join(' '));
      }
    }
  }

  if (collected.length === 0 && !budgetExceeded) {
    const fallbackPieces = extractTextOperatorsFromStream(latin1.slice(0, maxTotalBytes));
    if (fallbackPieces.length > 0) {
      collected.push(fallbackPieces.join(' '));
    }
  }

  const text = collected
    .join('\n')
    .replace(/[^\x20-\x7E\xA0-\xFF\n\r\t]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  const isLikelyScanned = text.length < 40;

  return {
    text,
    pageCount: processedPageCount,
    originalPageCount,
    processedPageCount,
    isLikelyScanned,
    truncated,
    budgetExceeded,
    budgetReason,
    decompressedBytes,
    extractorVersion: 'nexofis-native-pdf-2.0 (bounded-zlib-flate)',
  };
}

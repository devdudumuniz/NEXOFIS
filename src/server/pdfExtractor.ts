import zlib from 'node:zlib';

export interface NativePdfExtractionResult {
  text: string;
  pageCount: number;
  isLikelyScanned: boolean;
  extractorVersion: string;
}

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
  // Extract BT ... ET text blocks
  const btBlocks = content.match(/BT[\s\S]*?ET/g) ?? [content];
  for (const block of btBlocks) {
    // Tj operator: (text) Tj
    const tjMatches = block.matchAll(/\((?:\\.|[^\\()])*\)\s*Tj/g);
    for (const m of tjMatches) {
      const inner = m[0].replace(/\)\s*Tj$/, '').slice(1);
      const decoded = unescapePdfString(inner).trim();
      if (decoded) chunks.push(decoded);
    }

    // TJ operator: [(text) -120 (text2)] TJ
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

/**
 * Extracts readable native text from uncompressed and FlateDecode-compressed PDF streams
 * and counts actual /Type /Page objects. Never falsely claims Docling/PaddleOCR.
 */
export function extractNativePdfText(buffer: Buffer): NativePdfExtractionResult {
  const latin1 = buffer.toString('latin1');

  // Count real /Type /Page declarations (excluding /Type /Pages)
  const pageMatches = latin1.match(/\/Type\s*\/Page\b(?!s)/g);
  const pageCount = Math.max(1, pageMatches ? pageMatches.length : 1);

  const collected: string[] = [];

  // Iterate over all stream ... endstream sections
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRegex.exec(latin1)) !== null) {
    const startOffset = match.index;
    const dictWindow = latin1.slice(Math.max(0, startOffset - 260), startOffset);
    const streamHeaderLen = match[0].indexOf('\n') + 1;
    const streamBodyStart = startOffset + streamHeaderLen;
    const streamBodyEnd = match.index + match[0].length - 'endstream'.length;
    const rawSlice = buffer.subarray(streamBodyStart, Math.max(streamBodyStart, streamBodyEnd));

    let decodedContent = '';
    if (/\/Filter\s*\/FlateDecode|\/FlateDecode\b/.test(dictWindow)) {
      try {
        decodedContent = zlib.inflateSync(rawSlice).toString('latin1');
      } catch {
        try {
          decodedContent = zlib.inflateRawSync(rawSlice).toString('latin1');
        } catch {
          decodedContent = '';
        }
      }
    } else if (!/\/Subtype\s*\/Image/.test(dictWindow)) {
      decodedContent = rawSlice.toString('latin1');
    }

    if (decodedContent) {
      const pieces = extractTextOperatorsFromStream(decodedContent);
      if (pieces.length > 0) {
        collected.push(pieces.join(' '));
      }
    }
  }

  // Fallback for plain uncompressed PDFs without stream wrapper
  if (collected.length === 0) {
    const fallbackPieces = extractTextOperatorsFromStream(latin1);
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
    pageCount,
    isLikelyScanned,
    extractorVersion: 'nexofis-native-pdf-1.0 (zlib-flate)',
  };
}

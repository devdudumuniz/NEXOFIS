/**
 * NEXOFIS — Avaliador de Qualidade Textual, Roteador Híbrido e Pós-processador OCR PT-BR
 * Licença: GNU AGPL-3.0-only (Eduardo Muniz — DM Technology)
 *
 * Princípios:
 * - Nunca inventar ou fabricar campos ausentes.
 * - Corrigir apenas confusões clássicas de OCR (O/0, I/l/1, S/5) estritamente dentro de tokens
 *   estruturados brasileiros (CNPJ, valores R$, datas DD/MM/AAAA) e quebras hifenizadas.
 * - Determinar de forma objetiva se uma página tem camada textual nativa confiável (evitando
 *   custo de OCR neural) ou se exige OCR seletivo.
 */

export interface NativeTextQualityReport {
  charCount: number;
  wordCount: number;
  printableRatio: number;
  alphaNumericRatio: number;
  replacementCharCount: number;
  qualityScore: number; // 0..1
  needsOcr: boolean;
  reason: string;
}

export interface PageRoutingDecision {
  pageNumber: number;
  needsOcr: boolean;
  qualityScore: number;
  charCount: number;
  reason: string;
}

export interface DocumentRoutingPlan {
  totalPages: number;
  nativePages: number[];
  ocrPages: number[];
  skipOcrCompletely: boolean;
  decisions: PageRoutingDecision[];
}

export interface BrazilianOcrNormalizationResult {
  text: string;
  correctionsApplied: number;
  appliedRules: string[];
}

export function assessNativeTextQuality(
  rawText: string,
  options?: { minCharsPerPage?: number; minQualityScore?: number }
): NativeTextQualityReport {
  const minChars = options?.minCharsPerPage ?? 48;
  const minScore = options?.minQualityScore ?? 0.62;
  const trimmed = rawText.trim();
  const charCount = trimmed.length;

  if (charCount === 0) {
    return {
      charCount: 0,
      wordCount: 0,
      printableRatio: 0,
      alphaNumericRatio: 0,
      replacementCharCount: 0,
      qualityScore: 0,
      needsOcr: true,
      reason: 'Camada textual vazia (página provavelmente digitalizada como imagem).',
    };
  }

  let printable = 0;
  let alphaNum = 0;
  let replacementChars = 0;

  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code === 0xfffd) {
      replacementChars += 1;
      continue;
    }
    const isWhitespace = code === 9 || code === 10 || code === 13 || code === 32;
    const isAsciiPrintable = code >= 33 && code <= 126;
    const isLatinExtended = code >= 0x00a0 && code <= 0x024f;
    const isCommonPunct = code >= 0x2010 && code <= 0x2027;
    if (isWhitespace || isAsciiPrintable || isLatinExtended || isCommonPunct) {
      printable += 1;
    }
    if (
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 0x00c0 && code <= 0x00ff && code !== 0x00d7 && code !== 0x00f7)
    ) {
      alphaNum += 1;
    }
  }

  const words = trimmed.split(/\s+/).filter((w) => w.length >= 2);
  const wordCount = words.length;
  const printableRatio = printable / charCount;
  const alphaNumericRatio = alphaNum / charCount;
  const replacementPenalty = Math.min(0.6, (replacementChars / charCount) * 3);

  const densityScore = Math.min(1, charCount / Math.max(1, minChars * 2.5));
  const wordScore = Math.min(1, wordCount / 12);
  const qualityScore = Number(
    Math.max(
      0,
      Math.min(
        1,
        printableRatio * 0.45 +
          Math.min(1, alphaNumericRatio / 0.6) * 0.25 +
          densityScore * 0.15 +
          wordScore * 0.15 -
          replacementPenalty
      )
    ).toFixed(3)
  );

  const tooShort = charCount < minChars || wordCount < 6;
  const garbled = printableRatio < 0.82 || replacementChars / charCount > 0.04;
  const needsOcr = tooShort || garbled || qualityScore < minScore;

  let reason = 'Camada textual nativa íntegra; OCR dispensado.';
  if (garbled) {
    reason = 'Codificação de fontes corrompida ou alta taxa de caracteres inválidos; OCR seletivo recomendado.';
  } else if (tooShort) {
    reason = `Densidade textual insuficiente (${charCount} caracteres / ${wordCount} palavras); OCR seletivo recomendado.`;
  } else if (qualityScore < minScore) {
    reason = `Índice de qualidade textual (${Math.round(qualityScore * 100)}%) abaixo do limiar mínimo.`;
  }

  return {
    charCount,
    wordCount,
    printableRatio: Number(printableRatio.toFixed(3)),
    alphaNumericRatio: Number(alphaNumericRatio.toFixed(3)),
    replacementCharCount: replacementChars,
    qualityScore,
    needsOcr,
    reason,
  };
}

export function routeDocumentPages(
  pageTexts: string[],
  options?: { forceOcr?: boolean }
): DocumentRoutingPlan {
  const decisions: PageRoutingDecision[] = pageTexts.map((text, idx) => {
    const pageNumber = idx + 1;
    if (options?.forceOcr) {
      return {
        pageNumber,
        needsOcr: true,
        qualityScore: 0,
        charCount: text.trim().length,
        reason: 'OCR forçado explicitamente pelo operador.',
      };
    }
    const report = assessNativeTextQuality(text);
    return {
      pageNumber,
      needsOcr: report.needsOcr,
      qualityScore: report.qualityScore,
      charCount: report.charCount,
      reason: report.reason,
    };
  });

  const nativePages = decisions.filter((d) => !d.needsOcr).map((d) => d.pageNumber);
  const ocrPages = decisions.filter((d) => d.needsOcr).map((d) => d.pageNumber);

  return {
    totalPages: decisions.length,
    nativePages,
    ocrPages,
    skipOcrCompletely: ocrPages.length === 0 && nativePages.length > 0,
    decisions,
  };
}

function fixNumericOcrToken(token: string): string {
  return token
    .replace(/[OoQq]/g, '0')
    .replace(/[Il|]/g, '1')
    .replace(/[Ss]/g, '5')
    .replace(/[Bb]/g, '8');
}

export function normalizeBrazilianOcrText(rawText: string): BrazilianOcrNormalizationResult {
  let text = rawText.replace(/\r\n?/g, '\n');
  let correctionsApplied = 0;
  const rules = new Set<string>();

  // 1. Rejoin Portuguese words broken with hyphen across line breaks (e.g., "contra-\ntação")
  const dehyphenated = text.replace(/([A-Za-zÀ-ÿ]{2,})-\n([a-zà-ÿ]{2,})/g, (_m, a, b) => {
    correctionsApplied += 1;
    rules.add('dehyphenation');
    return `${a}${b}`;
  });
  text = dehyphenated;

  // 2. Normalize broken currency markers like "R $ 1.200,00" or "RS 1.200,00"
  text = text.replace(/\bR\s*[\$S]\s*([0-9OoIl|]{1,3}(?:\.[0-9OoIl|]{3})*,[0-9OoIl|]{2})/g, (_m, amount) => {
    const fixed = fixNumericOcrToken(amount);
    if (fixed !== amount || _m.includes('R $') || _m.includes('RS')) {
      correctionsApplied += 1;
      rules.add('currency_brl');
    }
    return `R$ ${fixed}`;
  });

  // 3. Normalize OCR confusions strictly inside formatted CNPJ patterns (XX.XXX.XXX/XXXX-XX)
  text = text.replace(
    /\b([0-9OoIl|]{2}\.[0-9OoIl|]{3}\.[0-9OoIl|]{3}\/[0-9OoIl|]{4}-[0-9OoIl|]{2})\b/g,
    (match) => {
      const fixed = fixNumericOcrToken(match);
      if (fixed !== match) {
        correctionsApplied += 1;
        rules.add('cnpj_digits');
      }
      return fixed;
    }
  );

  // 4. Normalize OCR confusions strictly inside Brazilian dates (DD/MM/YYYY)
  text = text.replace(
    /\b([0-3OoIl|][0-9OoIl|]\/[0-1OoIl|][0-9OoIl|]\/20[0-9OoIl|]{2})\b/g,
    (match) => {
      const fixed = fixNumericOcrToken(match);
      if (fixed !== match) {
        correctionsApplied += 1;
        rules.add('date_br');
      }
      return fixed;
    }
  );

  // 5. Collapse excessive spaces/blank lines while preserving paragraph and table line boundaries
  const cleaned = text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    text: cleaned,
    correctionsApplied,
    appliedRules: Array.from(rules),
  };
}

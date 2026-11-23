/**
 * NEXOFIS — Motor Híbrido de OCR de Alta Eficiência (A10/A11)
 * Licença: GNU AGPL-3.0-only (Eduardo Muniz — DM Technology)
 *
 * Arquitetura em camadas (menor latência e custo primeiro):
 *   Cache SHA-256 -> Tier 0 (Texto Nativo / PDF FlateDecode com orçamento seguro)
 *                 -> Tier 1a (Docling Serve estruturado, se configurado)
 *                 -> Tier 1b (Worker Python PaddleOCR paralelo por página, se configurado)
 *                 -> Pós-processamento forense PT-BR (sem fabricar valores)
 */

import crypto from 'node:crypto';
import {
  assessNativeTextQuality,
  normalizeBrazilianOcrText,
} from '@nexofis/shared/lib/ocrPostProcessor';
import type { ExtractionMethod } from '@nexofis/shared/types/audit';
import {
  convertWithDoclingServe,
  extractWithPaddleOcrWorker,
} from './doclingClient';
import { extractNativePdfText } from './pdfExtractor';

export interface OcrTelemetry {
  engineUsed: 'native-utf8' | 'native-pdf-flate' | 'docling-serve' | 'paddleocr-worker' | 'unavailable';
  extractorVersion: string;
  durationMs: number;
  totalPages: number;
  originalPageCount: number;
  processedPageCount: number;
  truncated: boolean;
  budgetExceeded: boolean;
  budgetReason?: string;
  pagesSkippedOcr: number;
  pagesOcrProcessed: number;
  qualityScore: number;
  ocrCorrectionsApplied: number;
  appliedRules: string[];
  fromCache: boolean;
}

export interface OcrPipelinePage {
  pageNumber: number;
  method: ExtractionMethod;
  text: string;
  confidence: number;
}

export interface OcrPipelineResult {
  status: 'ok' | 'needs_external_ocr' | 'budget_exceeded';
  sha256: string;
  text: string;
  pages: OcrPipelinePage[];
  extractionMethod: ExtractionMethod;
  confidence: number;
  telemetry: OcrTelemetry;
  steps: Array<{ stage: string; status: 'ok' | 'fallback'; detail: string }>;
}

const OCR_CACHE_MAX_ENTRIES = 128;
const ocrResultCache = new Map<string, OcrPipelineResult>();

function setOcrCache(key: string, value: OcrPipelineResult): void {
  if (ocrResultCache.size >= OCR_CACHE_MAX_ENTRIES) {
    const oldestKey = ocrResultCache.keys().next().value;
    if (oldestKey) ocrResultCache.delete(oldestKey);
  }
  ocrResultCache.set(key, value);
}

export function clearOcrCache(): void {
  ocrResultCache.clear();
}

function splitTextIntoPages(
  text: string,
  pageCount: number,
  method: ExtractionMethod,
  confidence: number
): OcrPipelinePage[] {
  const safeCount = Math.max(1, pageCount);
  if (!text.trim()) {
    return [{ pageNumber: 1, method, text: '', confidence }];
  }
  if (safeCount === 1) {
    return [{ pageNumber: 1, method, text, confidence }];
  }
  const formFeedSplit = text.split(/\f+/);
  if (formFeedSplit.length > 1) {
    return formFeedSplit.map((chunk, idx) => ({
      pageNumber: idx + 1,
      method,
      text: chunk.trim(),
      confidence,
    }));
  }
  const chunkSize = Math.max(1, Math.ceil(text.length / safeCount));
  const pages: OcrPipelinePage[] = [];
  for (let i = 0; i < safeCount; i++) {
    const slice = text.slice(i * chunkSize, (i + 1) * chunkSize).trim();
    if (slice || i === 0) {
      pages.push({ pageNumber: i + 1, method, text: slice, confidence });
    }
  }
  return pages;
}

export async function runEfficientOcrPipeline(params: {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  forceOcr?: boolean;
}): Promise<OcrPipelineResult> {
  const startedAt = Date.now();
  const forceOcr = Boolean(params.forceOcr);
  const sha256 = crypto.createHash('sha256').update(params.buffer).digest('hex');
  const cacheKey = `${sha256}:${forceOcr ? 'ocr' : 'auto'}`;

  const cached = ocrResultCache.get(cacheKey);
  if (cached) {
    return {
      ...cached,
      telemetry: {
        ...cached.telemetry,
        fromCache: true,
        durationMs: Math.max(1, Date.now() - startedAt),
      },
    };
  }

  const steps: Array<{ stage: string; status: 'ok' | 'fallback'; detail: string }> = [
    {
      stage: 'Validação Binária e Hash SHA-256',
      status: 'ok',
      detail: `Assinatura verificada · SHA-256 ${sha256.slice(0, 16)}…`,
    },
  ];

  // Tier 0a: Direct UTF-8 text (zero OCR cost)
  if (params.mimeType === 'text/plain' && !forceOcr) {
    const rawText = params.buffer.toString('utf-8');
    const normalized = normalizeBrazilianOcrText(rawText);
    const quality = assessNativeTextQuality(normalized.text, { minCharsPerPage: 16 });
    const pageCount = Math.max(1, Math.ceil(normalized.text.length / 3000));
    const durationMs = Math.max(1, Date.now() - startedAt);
    const confidence = Math.max(0.92, quality.qualityScore);

    steps.push({
      stage: 'Motor Híbrido — Tier 0 (Texto Nativo UTF-8)',
      status: 'ok',
      detail: `Extração direta em ${durationMs} ms (${normalized.text.length} caracteres · OCR dispensado)`,
    });

    const result: OcrPipelineResult = {
      status: 'ok',
      sha256,
      text: normalized.text,
      pages: splitTextIntoPages(normalized.text, pageCount, 'native', confidence),
      extractionMethod: 'native',
      confidence,
      telemetry: {
        engineUsed: 'native-utf8',
        extractorVersion: 'nexofis-native-utf8-2.0',
        durationMs,
        totalPages: pageCount,
        originalPageCount: pageCount,
        processedPageCount: pageCount,
        truncated: false,
        budgetExceeded: false,
        pagesSkippedOcr: pageCount,
        pagesOcrProcessed: 0,
        qualityScore: quality.qualityScore,
        ocrCorrectionsApplied: normalized.correctionsApplied,
        appliedRules: normalized.appliedRules,
        fromCache: false,
      },
      steps,
    };
    setOcrCache(cacheKey, result);
    return result;
  }

  // Tier 0b: Bounded fast-path native PDF FlateDecode extractor + quality gate
  let detectedPageCount = 1;
  let originalPageCount = 1;
  if (params.mimeType === 'application/pdf' && !forceOcr) {
    const nativePdf = extractNativePdfText(params.buffer);
    detectedPageCount = Math.max(1, nativePdf.processedPageCount);
    originalPageCount = Math.max(1, nativePdf.originalPageCount);

    if (nativePdf.budgetExceeded && nativePdf.text.length < 40) {
      const durationMs = Math.max(1, Date.now() - startedAt);
      steps.push({
        stage: 'Proteção de Orçamento PDF (Anti Zip-Bomb)',
        status: 'fallback',
        detail: nativePdf.budgetReason ?? 'Orçamento seguro de descompressão PDF excedido.',
      });
      return {
        status: 'budget_exceeded',
        sha256,
        text: nativePdf.text,
        pages: [],
        extractionMethod: 'native',
        confidence: 0,
        telemetry: {
          engineUsed: 'native-pdf-flate',
          extractorVersion: nativePdf.extractorVersion,
          durationMs,
          totalPages: detectedPageCount,
          originalPageCount,
          processedPageCount: detectedPageCount,
          truncated: true,
          budgetExceeded: true,
          budgetReason: nativePdf.budgetReason,
          pagesSkippedOcr: 0,
          pagesOcrProcessed: 0,
          qualityScore: 0,
          ocrCorrectionsApplied: 0,
          appliedRules: [],
          fromCache: false,
        },
        steps,
      };
    }

    const quality = assessNativeTextQuality(nativePdf.text);

    if (!nativePdf.isLikelyScanned && !quality.needsOcr) {
      const normalized = normalizeBrazilianOcrText(nativePdf.text);
      const durationMs = Math.max(1, Date.now() - startedAt);
      const confidence = Math.min(0.99, Math.max(0.86, quality.qualityScore));
      steps.push({
        stage: 'Motor Híbrido — Tier 0 (Extrator Nativo PDF FlateDecode)',
        status: 'ok',
        detail: `${detectedPageCount}/${originalPageCount} pág. extraídas em ${durationMs} ms (qualidade ${Math.round(
          quality.qualityScore * 100
        )}% · OCR neural dispensado)${nativePdf.truncated ? ' · cobertura parcial' : ''}`,
      });

      const result: OcrPipelineResult = {
        status: 'ok',
        sha256,
        text: normalized.text,
        pages: splitTextIntoPages(normalized.text, detectedPageCount, 'native', confidence),
        extractionMethod: 'native',
        confidence,
        telemetry: {
          engineUsed: 'native-pdf-flate',
          extractorVersion: `${nativePdf.extractorVersion}+ptbr-norm`,
          durationMs,
          totalPages: detectedPageCount,
          originalPageCount,
          processedPageCount: detectedPageCount,
          truncated: nativePdf.truncated,
          budgetExceeded: nativePdf.budgetExceeded,
          budgetReason: nativePdf.budgetReason,
          pagesSkippedOcr: detectedPageCount,
          pagesOcrProcessed: 0,
          qualityScore: quality.qualityScore,
          ocrCorrectionsApplied: normalized.correctionsApplied,
          appliedRules: normalized.appliedRules,
          fromCache: false,
        },
        steps,
      };
      setOcrCache(cacheKey, result);
      return result;
    }

    steps.push({
      stage: 'Triagem de Qualidade Textual (PDF)',
      status: 'fallback',
      detail: `${detectedPageCount} pág. analisadas — ${quality.reason}`,
    });
  }

  // Tier 1a: Docling Serve (structured tables + layout + selective OCR) when configured
  const doclingResult = await convertWithDoclingServe(
    params.buffer,
    params.filename,
    params.mimeType,
    { doOcr: forceOcr || params.mimeType !== 'application/pdf' }
  );

  if (doclingResult.status === 'ok' && doclingResult.text.trim().length > 0) {
    const normalized = normalizeBrazilianOcrText(doclingResult.text);
    const quality = assessNativeTextQuality(normalized.text, { minCharsPerPage: 24 });
    const pagesCount = Math.max(detectedPageCount, doclingResult.processedPageCount ?? doclingResult.pageCount ?? 1);
    const origCount = Math.max(originalPageCount, doclingResult.originalPageCount ?? pagesCount);
    const durationMs = Math.max(1, Date.now() - startedAt);
    const confidence = Math.min(0.97, Math.max(0.82, quality.qualityScore));

    steps.push({
      stage: 'Motor Híbrido — Tier 1 (Docling Serve)',
      status: 'ok',
      detail: `${pagesCount}/${origCount} pág. convertidas em ${doclingResult.durationMs} ms · ${normalized.correctionsApplied} ajuste(s) pós-OCR PT-BR`,
    });

    const result: OcrPipelineResult = {
      status: 'ok',
      sha256,
      text: normalized.text,
      pages: splitTextIntoPages(normalized.text, pagesCount, 'docling', confidence),
      extractionMethod: 'docling',
      confidence,
      telemetry: {
        engineUsed: 'docling-serve',
        extractorVersion: doclingResult.extractorVersion,
        durationMs,
        totalPages: pagesCount,
        originalPageCount: origCount,
        processedPageCount: pagesCount,
        truncated: Boolean(doclingResult.truncated || origCount > pagesCount),
        budgetExceeded: false,
        pagesSkippedOcr: forceOcr ? 0 : pagesCount,
        pagesOcrProcessed: forceOcr ? pagesCount : 0,
        qualityScore: quality.qualityScore,
        ocrCorrectionsApplied: normalized.correctionsApplied,
        appliedRules: normalized.appliedRules,
        fromCache: false,
      },
      steps,
    };
    setOcrCache(cacheKey, result);
    return result;
  }

  // Tier 1b: Isolated High-Throughput Python PaddleOCR Worker
  const paddleResult = await extractWithPaddleOcrWorker(
    params.buffer,
    params.filename,
    params.mimeType
  );

  if (paddleResult.status === 'ok' && paddleResult.text.trim().length > 0) {
    const normalized = normalizeBrazilianOcrText(paddleResult.text);
    const quality = assessNativeTextQuality(normalized.text, { minCharsPerPage: 24 });
    const processedCount = Math.max(1, paddleResult.processedPageCount ?? paddleResult.pageCount ?? detectedPageCount);
    const origCount = Math.max(originalPageCount, paddleResult.originalPageCount ?? processedCount);
    const truncated = Boolean(paddleResult.truncated || origCount > processedCount);
    const durationMs = Math.max(1, Date.now() - startedAt);
    const confidence = Math.min(0.95, Math.max(0.78, quality.qualityScore));

    steps.push({
      stage: 'Motor Híbrido — Tier 1 (Worker PaddleOCR PT-BR)',
      status: 'ok',
      detail: `${processedCount}/${origCount} pág. processadas em ${paddleResult.durationMs} ms · ${normalized.correctionsApplied} correção(ões) PT-BR${truncated ? ' · cobertura parcial (limite de páginas)' : ''}`,
    });

    const resultPages: OcrPipelinePage[] =
      paddleResult.pages && paddleResult.pages.length > 0
        ? paddleResult.pages.map((p) => ({
            pageNumber: p.pageNumber,
            method: p.method,
            text: normalizeBrazilianOcrText(p.text).text,
            confidence: p.confidence,
          }))
        : splitTextIntoPages(normalized.text, processedCount, 'paddleocr', confidence);

    const nativePages = resultPages.filter((p) => p.method === 'native').length;
    const ocrPages = resultPages.length - nativePages;

    const result: OcrPipelineResult = {
      status: 'ok',
      sha256,
      text: normalized.text,
      pages: resultPages,
      extractionMethod: 'paddleocr',
      confidence,
      telemetry: {
        engineUsed: 'paddleocr-worker',
        extractorVersion: paddleResult.extractorVersion,
        durationMs,
        totalPages: processedCount,
        originalPageCount: origCount,
        processedPageCount: processedCount,
        truncated,
        budgetExceeded: false,
        pagesSkippedOcr: nativePages,
        pagesOcrProcessed: ocrPages,
        qualityScore: quality.qualityScore,
        ocrCorrectionsApplied: normalized.correctionsApplied,
        appliedRules: normalized.appliedRules,
        fromCache: false,
      },
      steps,
    };
    setOcrCache(cacheKey, result);
    return result;
  }

  const durationMs = Math.max(1, Date.now() - startedAt);
  return {
    status: 'needs_external_ocr',
    sha256,
    text: '',
    pages: [],
    extractionMethod: 'paddleocr',
    confidence: 0,
    telemetry: {
      engineUsed: 'unavailable',
      extractorVersion: 'nexofis-ocr-router-2.0',
      durationMs,
      totalPages: detectedPageCount,
      originalPageCount,
      processedPageCount: 0,
      truncated: false,
      budgetExceeded: false,
      pagesSkippedOcr: 0,
      pagesOcrProcessed: 0,
      qualityScore: 0,
      ocrCorrectionsApplied: 0,
      appliedRules: [],
      fromCache: false,
    },
    steps,
  };
}

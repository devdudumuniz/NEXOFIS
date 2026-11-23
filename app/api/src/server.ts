import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import {
  deriveMatrizCnpj,
  formatCnpjValue,
  isAlphanumericCnpj,
  isCnpjFormat,
  isValidCnpj,
  normalizeCnpj,
  resolveCorporatePartnerCnpj,
} from '@nexofis/shared/lib/cnpj';
import {
  matchesContractLifecycleFilter,
  normalizeLifecycleFilterParam,
} from '@nexofis/shared/lib/contractStatus';
import { aggregateRiskDashboard } from '@nexofis/shared/lib/dashboardAggregator';
import {
  matchesDatePeriod,
  resolvePncpPeriodBounds,
  validateDatePeriod,
} from '@nexofis/shared/lib/datePeriod';
import {
  extractFieldsFromNativeText,
  extractTabularContractRows,
  resolveDocumentContractMatch,
  validateUploadedFileMagic,
} from '@nexofis/shared/lib/documentParser';
import { filterAndRankMunicipalities } from '@nexofis/shared/lib/municipalitySearch';
import { mapContractToOCDS } from '@nexofis/shared/lib/ocdsMapper';
import {
  isRelatedContractNumber,
  parseBrazilianContractCode,
  parsePncpUrlFromQuery,
} from '@nexofis/shared/lib/pncpQueryParser';
import { evaluateContractRisk } from '@nexofis/shared/lib/riskEngine';
import {
  createAuthMiddleware,
  extractOptionalPrincipal,
  hashPasswordScrypt,
  isAuthEnforced,
  signNexofisToken,
  validateProductionAuthConfig,
  verifyPasswordScrypt,
  type AuthenticatedRequest,
  type NexofisRole,
} from '@nexofis/backend/authMiddleware';
import {
  queryCguSanctionsByCnpj,
  querySiconfiRreo,
} from '@nexofis/backend/connectors/portalTransparenciaClient';
import { checkExternalOcrHealth } from '@nexofis/backend/doclingClient';
import { createDurableJobQueue } from '@nexofis/backend/jobQueue';
import { runEfficientOcrPipeline } from '@nexofis/backend/ocrEngine';
import {
  fetchPncpContractsByCnpj,
  fetchPncpItemWinningSupplier,
  type PncpWinningSupplierResult,
} from '@nexofis/backend/pncpClient';
import {
  buildInvestigationExportPackage,
  evaluateForensicInvestigation,
  INVESTIGATION_ENGINE_VERSION,
  MAX_PRIVATE_EVIDENCE_BYTES,
  normalizeOrganKey,
  validateFactSetPayload,
  verifyCaseLedgerIntegrity,
  type InvestigationContractInput,
} from '@nexofis/shared/lib/forensicInvestigationEngine';
import {
  fetchBrasilApiMinimizedExtract,
  fetchBrasilApiRawCnpj,
  minimizeMaskedDocument,
} from '@nexofis/backend/connectors/brasilApiCadastral';
import {
  buildPartnerNetworkGraph,
  buildPartnerNetworkSuggestions,
  normalizePersonName,
  type PartnerNetworkQueryMode,
  type PartnerNetworkSourceCoverageItem,
  type SupplierQsaRecord,
} from '@nexofis/shared/lib/partnerNetworkGraph';
import {
  buildReverseParticipationIndex,
  classifyPartnerGraphAssertionState,
  disambiguatePersonQuery,
} from '@nexofis/shared/lib/temporalIdentityGraph';
import {
  evaluateAppointmentNepotismTrail,
  evaluateContractConflictTrail,
  evaluateDocumentedKinshipTrail,
  evaluateRoleLegalRequirementsTrail,
  parseCamaraDailyPersonnelSnapshot,
} from '@nexofis/shared/lib/publicIntegrityTrails';
import {
  computePairedDidEffect,
  evaluateOutcomeClaim,
  importInepPublicExport,
  importSiapsPublicExport,
  reconcileSiconfiExecution,
} from '@nexofis/shared/lib/outcomesEvaluationEngine';
import { evaluateInvestigativePriceComparison } from '@nexofis/shared/lib/benchmarkEngine';
import {
  auditEditalCommunicationChannels,
  evaluateParticipationChannels,
} from '@nexofis/shared/lib/participationChannelEvaluator';
import {
  executeKinshipOfficeContractQuery,
  executeMultiHopCorporateNetworkQuery,
  FORENSIC_GRAPH_CYPHER_CONSTRAINTS,
  FORENSIC_GRAPH_CYPHER_QUERIES,
  generateForensicCypherScript,
  type ForensicGraphSnapshot,
} from '@nexofis/shared/lib/forensicGraphCypher';
import { importSinapiOfficialFile } from '@nexofis/backend/connectors/sinapiImporter';
import {
  createObservabilityRegistry,
  sanitizeLogPayload,
} from '@nexofis/backend/securityGuards';
import { createNexofisStore, InvestigationVersionConflictError, type InvestigationActor } from '@nexofis/backend/storage';
import { resolveContractsSupplierNames } from '@nexofis/backend/supplierResolver';
import type {
  ContractRecord,
  DocumentPage,
  DocumentRecord,
  EvaluatedContract,
  ExtractionMethod,
  FindingReviewRecord,
  GovernmentEntity,
  Municipality,
  SavedDossierSummary,
} from '@nexofis/shared/types/audit';
import type {
  InvestigationCasePayload,
  InvestigationReviewAction,
  ObservedContractRecord,
  ObservedHistorySnapshot,
} from '@nexofis/shared/types/investigation';

const observability = createObservabilityRegistry();

// A09: Fail-closed boot check for production auth configuration
validateProductionAuthConfig();

const app = express();
const rawPort =
  process.env.NEXOFIS_PORT ||
  (process.env.NODE_ENV !== 'production' ||
  (process.env.NGINX_PORT && process.env.PORT === process.env.NGINX_PORT)
    ? process.env.DEFAULT_APP_PORT || '3000'
    : process.env.PORT || '3000');
const PORT = Number(rawPort) || 3000;
const STARTED_AT = Date.now();

app.use(express.json({ limit: '10mb' }));

// Security & privacy headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const privateEvidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PRIVATE_EVIDENCE_BYTES },
});

// Durable SQLite store + durable job queue
const sqliteDbPath = process.env.NEXOFIS_SQLITE_PATH?.trim() || undefined;
const store = createNexofisStore(sqliteDbPath);

const defaultJobsPath = sqliteDbPath
  ? path.join(path.dirname(path.resolve(sqliteDbPath)), 'nexofis-jobs.db')
  : undefined;
const jobsDbPath = process.env.NEXOFIS_JOBS_DB_PATH?.trim() || defaultJobsPath;
const jobQueue = createDurableJobQueue(jobsDbPath);
jobQueue.recoverExpiredLeases();

// RBAC middlewares (fail-closed in production unless NEXOFIS_ALLOW_INSECURE_LOCAL=true)
const requireAnalystAuth = createAuthMiddleware({ allowedRoles: ['admin', 'analyst'] });
const requireAdminAuth = createAuthMiddleware({ allowedRoles: ['admin'] });
const requireViewerOrAbove = createAuthMiddleware({ allowedRoles: ['admin', 'analyst', 'viewer'] });
// Strict mandatory authentication for Forensic Investigation module (always enforced, even in local mode)
const requireStrictInvestigationAuth = createAuthMiddleware({
  allowedRoles: ['admin', 'analyst'],
  enforceOverride: true,
});

// Neutral fallback municipalities (Brazilian state capitals) ONLY if live IBGE API times out
const NEUTRAL_IBGE_FALLBACK: Municipality[] = [
  { ibgeCode: '1200401', name: 'Rio Branco', uf: 'AC', stateName: 'Acre', region: 'Norte', source: 'Base Oficial IBGE (Cache)' },
  { ibgeCode: '1302603', name: 'Manaus', uf: 'AM', stateName: 'Amazonas', region: 'Norte', source: 'Base Oficial IBGE (Cache)' },
  { ibgeCode: '1501402', name: 'Belém', uf: 'PA', stateName: 'Pará', region: 'Norte', source: 'Base Oficial IBGE (Cache)' },
  { ibgeCode: '2304400', name: 'Fortaleza', uf: 'CE', stateName: 'Ceará', region: 'Nordeste', source: 'Base Oficial IBGE (Cache)' },
  { ibgeCode: '2611606', name: 'Recife', uf: 'PE', stateName: 'Pernambuco', region: 'Nordeste', source: 'Base Oficial IBGE (Cache)' },
  { ibgeCode: '2927408', name: 'Salvador', uf: 'BA', stateName: 'Bahia', region: 'Nordeste', source: 'Base Oficial IBGE (Cache)' },
  { ibgeCode: '3106200', name: 'Belo Horizonte', uf: 'MG', stateName: 'Minas Gerais', region: 'Sudeste', source: 'Base Oficial IBGE (Cache)' },
  { ibgeCode: '3304557', name: 'Rio de Janeiro', uf: 'RJ', stateName: 'Rio de Janeiro', region: 'Sudeste', source: 'Base Oficial IBGE (Cache)' },
  { ibgeCode: '3550308', name: 'São Paulo', uf: 'SP', stateName: 'São Paulo', region: 'Sudeste', source: 'Base Oficial IBGE (Cache)' },
  { ibgeCode: '4106902', name: 'Curitiba', uf: 'PR', stateName: 'Paraná', region: 'Sul', source: 'Base Oficial IBGE (Cache)' },
  { ibgeCode: '4314902', name: 'Porto Alegre', uf: 'RS', stateName: 'Rio Grande do Sul', region: 'Sul', source: 'Base Oficial IBGE (Cache)' },
  { ibgeCode: '5208707', name: 'Goiânia', uf: 'GO', stateName: 'Goiás', region: 'Centro-Oeste', source: 'Base Oficial IBGE (Cache)' },
  { ibgeCode: '5300108', name: 'Brasília', uf: 'DF', stateName: 'Distrito Federal', region: 'Centro-Oeste', source: 'Base Oficial IBGE (Cache)' },
];

// In-memory cache synchronized with SQLite (ZERO seed contracts — A01)
const contractStore = new Map<string, ContractRecord>();
for (const storedContract of store.getAllStoredContracts()) {
  contractStore.set(storedContract.id, storedContract);
}

function persistContract(contract: ContractRecord): void {
  contractStore.set(contract.id, contract);
  store.upsertContract(contract);
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function getAllContracts(): ContractRecord[] {
  return Array.from(contractStore.values());
}

function evaluateWithContext(contract: ContractRecord): EvaluatedContract {
  const assessment = evaluateContractRisk(contract);
  const reviews = store.listFindingReviews(contract.id);
  return { ...contract, assessment, reviews };
}

// ==========================================
// IBGE Municipalities Cache (5,570 municipalities)
// ==========================================
let ibgeCache: Municipality[] | null = null;
let ibgeFetchedAt = 0;

async function getIbgeMunicipalities(): Promise<{
  items: Municipality[];
  source: 'ibge-live' | 'fallback';
}> {
  const now = Date.now();
  if (ibgeCache && now - ibgeFetchedAt < 1000 * 60 * 60 * 12) {
    return { items: ibgeCache, source: 'ibge-live' };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(
      'https://servicodados.ibge.gov.br/api/v1/localidades/municipios?orderBy=nome',
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) throw new Error(`IBGE HTTP ${res.status}`);
    const raw = (await res.json()) as Array<{
      id: number;
      nome: string;
      microrregiao?: {
        mesorregiao?: {
          UF?: { sigla?: string; nome?: string; regiao?: { nome?: string } };
        };
      };
      'regiao-imediata'?: {
        'regiao-intermediaria'?: {
          UF?: { sigla?: string; nome?: string; regiao?: { nome?: string } };
        };
      };
    }>;

    ibgeCache = raw.map((item) => {
      const ufObj =
        item.microrregiao?.mesorregiao?.UF ??
        item['regiao-imediata']?.['regiao-intermediaria']?.UF;
      return {
        ibgeCode: String(item.id),
        name: item.nome,
        uf: ufObj?.sigla ?? 'BR',
        stateName: ufObj?.nome ?? 'Brasil',
        region: ufObj?.regiao?.nome,
        source: 'IBGE API Oficial' as const,
      };
    });
    ibgeFetchedAt = now;
    return { items: ibgeCache, source: 'ibge-live' };
  } catch {
    return { items: NEUTRAL_IBGE_FALLBACK, source: 'fallback' };
  }
}

// ==========================================
// Live PNCP API Fetcher by Municipality / Period (A02: zero fabricated fields)
// PNCP /v1/contratacoes/publicacao requires codigoModalidadeContratacao:
// 6 = Pregão Eletrônico, 8 = Dispensa de Licitação, 9 = Inexigibilidade, 4 = Concorrência Eletrônica
// ==========================================
const PNCP_CORE_MODALITIES = [6, 8, 9, 4] as const;

interface PncpPublicacaoItem {
  numeroControlePNCP?: string;
  numeroCompra?: string;
  sequencialCompra?: number;
  anoCompra?: number;
  objetoCompra?: string;
  valorTotalEstimado?: number;
  valorTotalHomologado?: number;
  dataPublicacaoPncp?: string;
  modalidadeNome?: string;
  situacaoCompraNome?: string;
  orgaoEntidade?: { cnpj?: string; razaoSocial?: string };
  unidadeOrgao?: { nomeUnidade?: string; codigoUnidade?: string; municipioNome?: string; ufSigla?: string };
  amparoLegal?: { nome?: string };
}

function hasRealSupplier(contract: ContractRecord): boolean {
  const cleanCnpj = normalizeCnpj(contract.supplier?.cnpj ?? '');
  return isCnpjFormat(cleanCnpj) && cleanCnpj !== '00000000000000' && isValidCnpj(cleanCnpj);
}

const PNCP_MUNICIPALITY_CACHE_TTL_MS = 2 * 60 * 1000;
const pncpMunicipalityFetchCache = new Map<
  string,
  {
    expiresAt: number;
    result: {
      records: ContractRecord[];
      signedContractCount: number;
      editalCount: number;
      liveAvailable: boolean;
      message: string;
    };
  }
>();

async function fetchLivePncpContratacoes(
  ibgeCode: string,
  municipalityName: string,
  uf: string,
  period: { startDate?: string; endDate?: string }
): Promise<{
  records: ContractRecord[];
  signedContractCount: number;
  editalCount: number;
  liveAvailable: boolean;
  message: string;
}> {
  const bounds = resolvePncpPeriodBounds(period, new Date().getFullYear());
  const cacheKey = `${ibgeCode}:${bounds.dataInicial}:${bounds.dataFinal}`;
  const cached = pncpMunicipalityFetchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  try {
    const modalityResults = await Promise.all(
      PNCP_CORE_MODALITIES.map(async (modalityCode) => {
        const url = `https://pncp.gov.br/api/consulta/v1/contratacoes/publicacao?dataInicial=${bounds.dataInicial}&dataFinal=${bounds.dataFinal}&codigoMunicipioIbge=${encodeURIComponent(
          ibgeCode
        )}&codigoModalidadeContratacao=${modalityCode}&pagina=1&tamanhoPagina=15`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6500);
        try {
          const res = await fetch(url, {
            signal: controller.signal,
            headers: {
              Accept: 'application/json',
              'User-Agent': 'Nexofis-Audit/1.0',
              Connection: 'close',
            },
          });
          clearTimeout(timer);
          if (res.status === 204) {
            return { ok: true, status: 204, items: [] as PncpPublicacaoItem[] };
          }
          if (!res.ok) {
            return { ok: false, status: res.status, items: [] as PncpPublicacaoItem[] };
          }
          const payload = (await res.json()) as { data?: PncpPublicacaoItem[] };
          return { ok: true, status: res.status, items: payload.data ?? [] };
        } catch {
          clearTimeout(timer);
          return { ok: false, status: 0, items: [] as PncpPublicacaoItem[] };
        }
      })
    );

    const anyOk = modalityResults.some((r) => r.ok);

    const deduped = new Map<string, PncpPublicacaoItem>();
    for (const res of modalityResults) {
      for (const item of res.items) {
        const key =
          item.numeroControlePNCP ??
          `${item.orgaoEntidade?.cnpj ?? ibgeCode}-${item.numeroCompra ?? ''}-${item.anoCompra ?? ''}`;
        if (!deduped.has(key)) {
          deduped.set(key, item);
        }
      }
    }

    const items = Array.from(deduped.values())
      .sort((a, b) => (b.dataPublicacaoPncp ?? '').localeCompare(a.dataPublicacaoPncp ?? ''))
      .slice(0, 30);

    // Collect distinct municipal organ CNPJs from live publications + existing local contracts
    const organCnpjs = new Set<string>();
    for (const item of items) {
      const cnpj = normalizeCnpj(item.orgaoEntidade?.cnpj);
      if (/^\d{14}$/.test(cnpj) && isValidCnpj(cnpj)) {
        organCnpjs.add(cnpj);
      }
    }
    for (const localContract of getAllContracts()) {
      if (localContract.municipalityIbge !== ibgeCode) continue;
      const match = /^ENT-(\d{14})-/.exec(localContract.entityId);
      if (match && isValidCnpj(match[1])) {
        organCnpjs.add(match[1]);
      }
    }

    // Fetch real signed PNCP Contratos (with supplier legalName, CNPJ, signatureDate, valorGlobal)
    // for up to 5 discovered municipal organ CNPJs
    const signedContracts: ContractRecord[] = [];
    const targetOrganCnpjs = Array.from(organCnpjs).slice(0, 5);
    if (targetOrganCnpjs.length > 0) {
      const contractSearchResults = await Promise.all(
        targetOrganCnpjs.map(async (orgCnpj) => {
          try {
            const res = await fetchPncpContractsByCnpj(orgCnpj, {
              maxPages: 3,
              pageSize: 50,
            });
            return { orgCnpj, res };
          } catch {
            return { orgCnpj, res: null };
          }
        })
      );

      for (const { orgCnpj, res } of contractSearchResults) {
        if (!res) continue;
        for (const rec of res.records) {
          const belongsToOrgan = rec.entityId.startsWith(`ENT-${orgCnpj}-`);
          const belongsToIbge = rec.municipalityIbge === ibgeCode;
          if (!belongsToIbge && !belongsToOrgan) continue;
          const normalizedRec: ContractRecord =
            !rec.municipalityIbge && belongsToOrgan
              ? {
                  ...rec,
                  municipalityIbge: ibgeCode,
                  municipalityName: rec.municipalityName || municipalityName,
                  uf: rec.uf || uf,
                }
              : rec;
          if (normalizedRec.municipalityIbge === ibgeCode) {
            signedContracts.push(normalizedRec);
          }
        }
      }
    }

    // For homologated/adjudicated contratações, recover real winning supplier from PNCP item results
    const homologatedCandidates = items
      .filter((item) => {
        if (!item.orgaoEntidade?.cnpj || !item.anoCompra || !item.sequencialCompra) return false;
        const hasHomologatedVal = Number(item.valorTotalHomologado ?? 0) > 0;
        const sit = (item.situacaoCompraNome ?? '').toLowerCase();
        const isAwardedStatus =
          sit.includes('homolog') ||
          sit.includes('adjudic') ||
          sit.includes('encerr') ||
          sit.includes('conclu');
        return hasHomologatedVal || isAwardedStatus;
      })
      .slice(0, 12);

    const winnerByPncpKey = new Map<string, PncpWinningSupplierResult>();

    if (homologatedCandidates.length > 0) {
      const winnerResults = await Promise.all(
        homologatedCandidates.map(async (item) => {
          const orgCnpj = normalizeCnpj(item.orgaoEntidade?.cnpj);
          if (!orgCnpj || !item.anoCompra || !item.sequencialCompra) return null;
          const winner = await fetchPncpItemWinningSupplier(
            orgCnpj,
            item.anoCompra,
            item.sequencialCompra,
            3500
          );
          if (!winner) return null;
          const key =
            item.numeroControlePNCP ??
            `${orgCnpj}-${item.numeroCompra ?? ''}-${item.anoCompra}`;
          return { key, winner };
        })
      );
      for (const entry of winnerResults) {
        if (entry) {
          winnerByPncpKey.set(entry.key, entry.winner);
        }
      }
    }

    if (!anyOk && signedContracts.length === 0) {
      const firstStatus = modalityResults.find((r) => r.status > 0)?.status;
      return {
        records: [],
        signedContractCount: 0,
        editalCount: 0,
        liveAvailable: false,
        message: firstStatus
          ? `API PNCP retornou HTTP ${firstStatus} para IBGE ${ibgeCode}.`
          : `API PNCP indisponível ou tempo esgotado para IBGE ${ibgeCode}.`,
      };
    }

    const retrievedAt = new Date().toISOString();
    const editalRecords: ContractRecord[] = items.map((item, idx) => {
      const pncpId = item.numeroControlePNCP ?? `PNCP-${ibgeCode}-${bounds.targetYear}-${idx + 1}`;
      const entityCnpj = normalizeCnpj(item.orgaoEntidade?.cnpj) || '';
      const homologadoNum = Number(item.valorTotalHomologado ?? 0);
      const estimadoNum = Number(item.valorTotalEstimado ?? 0);
      const winnerKey =
        item.numeroControlePNCP ??
        `${entityCnpj || ibgeCode}-${item.numeroCompra ?? ''}-${item.anoCompra ?? ''}`;
      const winner = winnerByPncpKey.get(winnerKey);

      // Guardrail: NEVER attribute the total value of a multi-item purchase to a supplier who won only one item.
      const isFullPurchaseWinner = winner?.attributionScope === 'full_purchase_verified';
      const canAttributeItemValue = Boolean(winner && winner.awardedValue > 0);

      const valor = isFullPurchaseWinner
        ? winner && winner.awardedValue > 0
          ? winner.awardedValue
          : Number.isFinite(homologadoNum) && homologadoNum > 0
            ? homologadoNum
            : 0
        : winner && !isFullPurchaseWinner
          ? canAttributeItemValue
            ? winner.awardedValue
            : Number.isFinite(homologadoNum) && homologadoNum > 0
              ? homologadoNum
              : Number.isFinite(estimadoNum) && estimadoNum > 0
                ? estimadoNum
                : 0
          : Number.isFinite(homologadoNum) && homologadoNum > 0
            ? homologadoNum
            : Number.isFinite(estimadoNum) && estimadoNum > 0
              ? estimadoNum
              : 0;

      const publishedAt = item.dataPublicacaoPncp?.slice(0, 10) ?? '';
      const rawModality = (item.modalidadeNome ?? '').toLowerCase();
      const modality: ContractRecord['modality'] = rawModality.includes('dispensa')
        ? 'Dispensa de Licitação'
        : rawModality.includes('inexig')
          ? 'Inexigibilidade'
          : rawModality.includes('concorr')
            ? 'Concorrência'
            : rawModality.includes('preg')
              ? 'Pregão Eletrônico'
              : 'Não informada';

      const statusText = (item.situacaoCompraNome ?? '').toLowerCase();
      const status: ContractRecord['status'] =
        statusText.includes('suspens') || statusText.includes('anul')
          ? 'Suspenso'
          : statusText.includes('encerr') || statusText.includes('conclu')
            ? 'Encerrado'
            : 'Vigente';

      const entityName =
        item.unidadeOrgao?.nomeUnidade ??
        item.orgaoEntidade?.razaoSocial ??
        `Órgão Público de ${municipalityName}`;
      const effectiveYear = item.anoCompra ?? bounds.targetYear;
      const docSha = crypto.createHash('sha256').update(pncpId + JSON.stringify(item)).digest('hex');
      const sourceUrl = `https://pncp.gov.br/app/editais?q=${encodeURIComponent(pncpId)}`;

      const supplierCnpj =
        isFullPurchaseWinner || canAttributeItemValue ? (winner?.supplierCnpj ?? '') : '';
      const supplierLegalName = isFullPurchaseWinner
        ? winner!.supplierName
        : winner && canAttributeItemValue
          ? `${winner.supplierName} (Item ${winner.itemNumber}${winner.totalCompraItems ? `/${winner.totalCompraItems}` : ''})`
          : winner
            ? 'Compra multi-itens — vedada atribuição do valor total a vencedor de item isolado'
            : 'Edital publicado — fornecedor ainda não homologado no PNCP';

      return {
        id: `PNCP-LIVE-${pncpId.replace(/[^a-zA-Z0-9-]/g, '_')}`,
        pncpControlNumber: pncpId,
        contractNumber: item.numeroCompra
          ? `${item.numeroCompra}/${effectiveYear}`
          : `PNCP-${idx + 1}/${effectiveYear}`,
        year: effectiveYear,
        municipalityIbge: ibgeCode,
        municipalityName: item.unidadeOrgao?.municipioNome ?? municipalityName,
        uf: item.unidadeOrgao?.ufSigla ?? uf,
        entityId: `ENT-${entityCnpj || ibgeCode}-${item.unidadeOrgao?.codigoUnidade ?? '1'}`,
        entityName,
        modality,
        biddersCount: null, // A02: nunca inventar licitantes
        object: item.objetoCompra ?? 'Objeto não detalhado na publicação PNCP.',
        objectCategory: item.amparoLegal?.nome ?? 'Contratação Pública PNCP',
        expectedCnaePrefixes: [],
        signatureDate: '', // A02: publicação de contratação/edital não traz assinatura contratual
        startDate: publishedAt,
        endDate: '', // A02: nunca fabricar término
        originalValue: valor,
        updatedValue: valor,
        status,
        supplier: {
          cnpj: supplierCnpj,
          legalName: supplierLegalName,
          openingDate: '', // A02: nunca fabricar 2020-01-01
          registrationStatus: 'DESCONHECIDA', // A02: nunca presumir ATIVA
          primaryCnaeCode: '',
          primaryCnaeDescription: 'Não consultado na RFB',
          secondaryCnaes: [],
          shareCapital: 0,
          municipality: item.unidadeOrgao?.municipioNome ?? municipalityName,
          uf: item.unidadeOrgao?.ufSigla ?? uf,
          shareholders: [],
          sanctions: [],
          priorMunicipalContracts: 0,
          simultaneousActiveContracts: 1,
          dataProvenance: winner
            ? `PNCP API Oficial (${winner.attributionNote})`
            : 'PNCP API Oficial (Publicação de Contratação)',
        },
        items:
          valor > 0
            ? [
                {
                  id: `ITEM-${idx + 1}`,
                  itemNumber: 1,
                  description: item.objetoCompra ?? 'Item consolidado da publicação PNCP',
                  unit: 'UN',
                  quantity: 1,
                  unitPrice: valor,
                  totalPrice: valor,
                  referencePrice: 0,
                  referenceSource: 'Sem Referência',
                  referenceDate: publishedAt,
                },
              ]
            : [],
        amendments: [],
        payments: [],
        sourceRecords: [
          {
            id: `SRC-PNCP-${idx + 1}`,
            sourceSystem: 'PNCP',
            externalId: pncpId,
            retrievedAt,
            rawPayloadHash: docSha,
            parserVersion: 'pncp-live-v3',
            reportedOriginalValue: valor,
            reportedUpdatedValue: valor,
            reportedSupplierCnpj: supplierCnpj || entityCnpj,
            reportedStatus: item.situacaoCompraNome ?? 'Publicado',
            reportedEndDate: '',
            sourceUrl,
          },
        ],
        documents: [
          {
            id: `DOC-PNCP-${idx + 1}`,
            title: `Publicação PNCP ${pncpId}`,
            documentType: 'Edital / TR',
            sourceUrl,
            sourceSystem: 'PNCP API Oficial',
            retrievedAt,
            sha256: docSha,
            mimeType: 'application/json',
            sizeBytes: Buffer.byteLength(JSON.stringify(item), 'utf8'),
            extractionSummary: {
              totalPages: 1,
              originalPageCount: 1,
              processedPageCount: 1,
              truncated: false,
              nativePages: 1,
              doclingPages: 0,
              ocrPages: 0,
              extractorVersion: 'pncp-json-v3',
            },
            pages: [
              {
                pageNumber: 1,
                extractionMethod: 'native',
                confidence: 1,
                text: `Publicação oficial PNCP ${pncpId}. Órgão: ${entityName}. Fornecedor: ${supplierLegalName}${supplierCnpj ? ` (${formatCnpjValue(supplierCnpj)})` : ''}. Objeto: ${item.objetoCompra ?? 'Não informado'}. Valor: R$ ${valor.toFixed(2)}.`,
                highlights: [],
              },
            ],
          },
        ],
        pncpVerification: {
          queried: true,
          status: 'completed_match',
          queriedAt: retrievedAt,
          querySummary: `IBGE ${ibgeCode} (${bounds.dataInicial}..${bounds.dataFinal})`,
        },
        fieldProvenance: {
          signatureDate: 'unknown',
          endDate: 'unknown',
          biddersCount: 'unknown',
          modality: modality === 'Não informada' ? 'unknown' : 'source_official',
          supplierOpeningDate: 'unknown',
          supplierRegistrationStatus: 'unknown',
        },
        dataSourceOrigin: 'PNCP API Oficial',
      };
    });

    const rawPersisted = [...signedContracts, ...editalRecords];
    const resolvedBatch = await enrichContractsWithSecondarySupplierLookup(rawPersisted, 8);
    const allPersisted = resolvedBatch.contracts;
    for (const r of allPersisted) {
      persistContract(r);
    }

    if (allPersisted.length === 0) {
      const emptyResult = {
        records: [],
        signedContractCount: 0,
        editalCount: 0,
        liveAvailable: true,
        message: `API PNCP consultada em tempo real — 0 contratos ou contratações retornados para o período (${bounds.dataInicial}..${bounds.dataFinal}).`,
      };
      pncpMunicipalityFetchCache.set(cacheKey, {
        expiresAt: Date.now() + PNCP_MUNICIPALITY_CACHE_TTL_MS,
        result: emptyResult,
      });
      return emptyResult;
    }

    const okResult = {
      records: allPersisted,
      signedContractCount: signedContracts.length,
      editalCount: editalRecords.length,
      liveAvailable: true,
      message: `${signedContracts.length} contrato(s) assinado(s) e ${editalRecords.length} edital(is)/contratação(ões) sincronizado(s) via API oficial do PNCP.`,
    };
    pncpMunicipalityFetchCache.set(cacheKey, {
      expiresAt: Date.now() + PNCP_MUNICIPALITY_CACHE_TTL_MS,
      result: okResult,
    });
    return okResult;
  } catch (err) {
    return {
      records: [],
      signedContractCount: 0,
      editalCount: 0,
      liveAvailable: false,
      message: `API PNCP indisponível no momento (${err instanceof Error ? err.message : 'erro de rede'}).`,
    };
  }
}

function buildEntitiesForMunicipality(
  ibgeCode: string,
  contracts: EvaluatedContract[]
): GovernmentEntity[] {
  const byEntity = new Map<string, GovernmentEntity>();
  for (const c of contracts) {
    if (c.municipalityIbge !== ibgeCode) continue;
    const isHigh = c.assessment.coverageStatus !== 'INSUFFICIENT' && c.assessment.score >= 50;
    const existing = byEntity.get(c.entityId);
    if (!existing) {
      const entityType: GovernmentEntity['entityType'] = c.entityName.toLowerCase().includes('fundo')
        ? 'Fundo Municipal'
        : c.entityName.toLowerCase().includes('secretaria')
          ? 'Secretaria'
          : c.entityName.toLowerCase().includes('autarquia') || c.entityName.toLowerCase().includes('saae')
            ? 'Autarquia'
            : 'Prefeitura';
      const organCnpj = c.entityId.replace(/^ENT-/, '').slice(0, 14);
      byEntity.set(c.entityId, {
        id: c.entityId,
        ibgeCode,
        cnpj: /^\d{14}$/.test(organCnpj) ? organCnpj : '',
        name: c.entityName,
        shortName: c.entityName.slice(0, 48),
        entityType,
        pncpOrgaoCode: organCnpj,
        pncpUnidadeCode: c.entityId.split('-').pop() ?? '1',
        contractCount: 1,
        totalValue: c.updatedValue,
        highRiskCount: isHigh ? 1 : 0,
      });
    } else {
      existing.contractCount += 1;
      existing.totalValue += c.updatedValue;
      if (isHigh) existing.highRiskCount += 1;
    }
  }
  return Array.from(byEntity.values()).sort((a, b) => b.totalValue - a.totalValue);
}

// ==========================================
// API ROUTES — HEALTH, AUTH & SYSTEM STATUS
// ==========================================

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'nexofis',
    license: 'AGPL-3.0-only',
    dbDriver: 'sqlite',
    storageReady: true,
    schemaVersion: store.getSchemaVersion(),
    authEnabled: isAuthEnforced(),
    contractsStored: contractStore.size,
    uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/auth/status', (req, res) => {
  const authEnabled = isAuthEnforced();
  const userCount = store.countUsers();
  const principal = extractOptionalPrincipal(req);
  const envAdminConfigured = Boolean(
    process.env.NEXOFIS_ADMIN_EMAIL?.trim() && process.env.NEXOFIS_ADMIN_PASSWORD?.trim()
  );

  res.json({
    authEnabled,
    needsBootstrap: userCount === 0 && !envAdminConfigured,
    userCount,
    principal:
      principal ??
      (authEnabled
        ? null
        : {
            userId: 'local-workspace',
            displayName: 'Workspace Local (sem autenticação)',
            role: 'admin' as NexofisRole,
            authEnabled: false,
          }),
  });
});

app.post('/api/auth/bootstrap-admin', (req, res) => {
  if (store.countUsers() > 0) {
    res.status(409).json({
      error: 'O administrador inicial já foi configurado neste banco de dados.',
    });
    return;
  }

  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const displayName = String(req.body?.displayName ?? '').trim();
  const password = String(req.body?.password ?? '');

  if (!email || !email.includes('@') || email.length > 160) {
    res.status(400).json({ error: 'Informe um e-mail válido para o administrador.' });
    return;
  }
  if (!displayName || displayName.length < 2 || displayName.length > 120) {
    res.status(400).json({ error: 'Informe um nome de exibição válido (2 a 120 caracteres).' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'A senha deve possuir no mínimo 8 caracteres.' });
    return;
  }

  const user = store.createUser({
    id: `USR-${crypto.randomUUID()}`,
    email,
    displayName,
    role: 'admin',
    passwordHash: hashPasswordScrypt(password),
    createdAt: new Date().toISOString(),
  });

  const token = signNexofisToken({
    sub: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
  });

  res.status(201).json({
    token,
    principal: {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      authEnabled: isAuthEnforced(),
    },
  });
});

app.post('/api/auth/login', (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');

  if (!email || !password) {
    res.status(400).json({ error: 'Informe e-mail e senha.' });
    return;
  }

  const dbUser = store.getUserByEmail(email);
  if (dbUser && verifyPasswordScrypt(password, dbUser.passwordHash)) {
    const token = signNexofisToken({
      sub: dbUser.id,
      email: dbUser.email,
      displayName: dbUser.displayName,
      role: dbUser.role,
    });
    res.json({
      token,
      principal: {
        userId: dbUser.id,
        email: dbUser.email,
        displayName: dbUser.displayName,
        role: dbUser.role,
        authEnabled: isAuthEnforced(),
      },
    });
    return;
  }

  const envEmail = process.env.NEXOFIS_ADMIN_EMAIL?.trim().toLowerCase();
  const envPassword = process.env.NEXOFIS_ADMIN_PASSWORD?.trim();
  if (envEmail && envPassword && email === envEmail) {
    const a = Buffer.from(password);
    const b = Buffer.from(envPassword);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      const token = signNexofisToken({
        sub: 'env-admin',
        email: envEmail,
        displayName: 'Administrador NEXOFIS',
        role: 'admin',
      });
      res.json({
        token,
        principal: {
          userId: 'env-admin',
          email: envEmail,
          displayName: 'Administrador NEXOFIS',
          role: 'admin' as NexofisRole,
          authEnabled: isAuthEnforced(),
        },
      });
      return;
    }
  }

  res.status(401).json({ error: 'Credenciais inválidas.' });
});

app.get('/api/auth/users', requireAdminAuth, (_req, res) => {
  res.json({ users: store.listUsers() });
});

app.post('/api/auth/users', requireAdminAuth, (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const displayName = String(req.body?.displayName ?? '').trim();
  const password = String(req.body?.password ?? '');
  const role = String(req.body?.role ?? 'analyst').trim() as NexofisRole;

  if (!email || !email.includes('@')) {
    res.status(400).json({ error: 'E-mail inválido.' });
    return;
  }
  if (!displayName || displayName.length < 2) {
    res.status(400).json({ error: 'Nome de exibição inválido.' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'A senha deve possuir no mínimo 8 caracteres.' });
    return;
  }
  if (!['admin', 'analyst', 'viewer'].includes(role)) {
    res.status(400).json({ error: 'Papel inválido (use admin, analyst ou viewer).' });
    return;
  }
  if (store.getUserByEmail(email)) {
    res.status(409).json({ error: 'Já existe um usuário com este e-mail.' });
    return;
  }

  const created = store.createUser({
    id: `USR-${crypto.randomUUID()}`,
    email,
    displayName,
    role,
    passwordHash: hashPasswordScrypt(password),
    createdAt: new Date().toISOString(),
  });

  res.status(201).json({
    user: {
      id: created.id,
      email: created.email,
      displayName: created.displayName,
      role: created.role,
      createdAt: created.createdAt,
    },
  });
});

app.get('/api/ocr/status', async (_req, res) => {
  const external = await checkExternalOcrHealth(1800);
  const geminiConfigured = Boolean(process.env.GEMINI_API_KEY?.trim());
  const fullOcrReady =
    external.doclingServe.reachable || external.paddleOcr.reachable || geminiConfigured;

  res.json({
    tier0NativeReady: true,
    doclingServe: external.doclingServe,
    paddleOcr: external.paddleOcr,
    multimodalFallbackConfigured: geminiConfigured,
    fullOcrReady,
    supportedFormats: ['PDF', 'PNG', 'JPEG', 'WEBP', 'TIFF', 'TXT'],
    note: fullOcrReady
      ? 'Motor híbrido operacional: PDFs com texto nativo são extraídos no Tier 0 (com orçamento seguro anti zip-bomb); PDFs digitalizados/imagens usam os provedores externos disponíveis.'
      : 'Somente Tier 0 (PDF nativo/UTF-8 com proteção anti zip-bomb) está ativo neste container. Para PDFs digitalizados e imagens, habilite o perfil full-ocr (Docling Serve / PaddleOCR) no Docker Compose ou configure GEMINI_API_KEY.',
    checkedAt: new Date().toISOString(),
  });
});

app.get('/api/system/integrations', async (_req, res) => {
  const externalOcr = await checkExternalOcrHealth(1500);
  const cguConfigured = Boolean(process.env.PORTAL_TRANSPARENCIA_API_KEY?.trim());
  const geminiConfigured = Boolean(process.env.GEMINI_API_KEY?.trim());
  const jobs = jobQueue.listByStatus(undefined, 100);

  res.json({
    dbDriver: 'sqlite',
    schemaVersion: store.getSchemaVersion(),
    authEnabled: isAuthEnforced(),
    jobQueue: {
      active: true,
      queued: jobs.filter((j) => j.status === 'queued').length,
      processing: jobs.filter((j) => j.status === 'processing').length,
      succeeded: jobs.filter((j) => j.status === 'succeeded').length,
      failed: jobs.filter((j) => j.status === 'failed').length,
    },
    connectors: {
      ibge: { configured: true, status: 'public_api' },
      pncp: { configured: true, status: 'public_api' },
      siconfi: { configured: true, status: 'public_api' },
      portalTransparenciaCgu: {
        configured: cguConfigured,
        status: cguConfigured ? 'api_key_configured' : 'api_key_required',
      },
      doclingServe: externalOcr.doclingServe,
      paddleOcr: externalOcr.paddleOcr,
      multimodalFallback: {
        configured: geminiConfigured,
        provider: geminiConfigured ? 'gemini-multimodal-parser-1.0' : null,
      },
    },
    checkedAt: new Date().toISOString(),
  });
});

app.get('/api/jobs', requireViewerOrAbove, (req, res) => {
  const statusParam = String(req.query.status ?? '').trim();
  const validStatuses = new Set(['queued', 'processing', 'succeeded', 'failed', 'cancelled']);
  const status = validStatuses.has(statusParam)
    ? (statusParam as 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled')
    : undefined;
  const limit = Number(req.query.limit ?? 50);
  res.json({ jobs: jobQueue.listByStatus(status, Number.isFinite(limit) ? limit : 50) });
});

app.get('/api/jobs/:id', requireViewerOrAbove, (req, res) => {
  const job = jobQueue.getById(String(req.params.id));
  if (!job) {
    res.status(404).json({ error: 'Job não encontrado.' });
    return;
  }
  res.json({ job });
});

// ==========================================
// API ROUTES — MUNICIPALITIES & CONTEXT (A01: neutral, zero hardcoded presets)
// ==========================================

app.get('/api/municipalities/search', async (req, res) => {
  const rawQuery = String(req.query.q ?? '');
  const uf = String(req.query.uf ?? '').trim().toUpperCase();
  const { items } = await getIbgeMunicipalities();

  const results = filterAndRankMunicipalities(items, rawQuery, uf, 30);

  res.json({
    results,
    totalIndexed: items.length,
  });
});

app.get('/api/municipalities/:ibgeCode/context', async (req, res) => {
  const ibgeCode = String(req.params.ibgeCode ?? '').trim();
  if (!/^\d{7}$/.test(ibgeCode)) {
    res.status(400).json({ error: 'Código IBGE inválido (esperado 7 dígitos numéricos).' });
    return;
  }

  const startDate = String(req.query.startDate ?? '').trim() || undefined;
  const endDate = String(req.query.endDate ?? '').trim() || undefined;
  const periodCheck = validateDatePeriod(startDate, endDate);
  if (!periodCheck.valid) {
    res.status(400).json({ error: periodCheck.error });
    return;
  }

  const { items: municipalities } = await getIbgeMunicipalities();
  const municipality: Municipality = municipalities.find((m) => m.ibgeCode === ibgeCode) ?? {
    ibgeCode,
    name: `Município IBGE ${ibgeCode}`,
    uf: 'BR',
    stateName: 'Brasil',
    source: 'Base Oficial IBGE (Cache)',
  };

  const liveRes = await fetchLivePncpContratacoes(
    ibgeCode,
    municipality.name,
    municipality.uf,
    { startDate, endDate }
  );

  const matchingRaw = getAllContracts().filter(
    (c) =>
      c.municipalityIbge === ibgeCode &&
      matchesDatePeriod(c.signatureDate || c.startDate, { startDate, endDate })
  );

  // Deduplicate by pncpControlNumber preferring signed contracts with real suppliers
  const dedupedContracts = new Map<string, ContractRecord>();
  for (const c of matchingRaw) {
    const key = (c.pncpControlNumber ?? '').trim().toUpperCase() || c.id;
    const existing = dedupedContracts.get(key);
    if (!existing) {
      dedupedContracts.set(key, c);
    } else {
      const existingRank = (hasRealSupplier(existing) ? 2 : 0) + (existing.signatureDate ? 1 : 0);
      const nextRank = (hasRealSupplier(c) ? 2 : 0) + (c.signatureDate ? 1 : 0);
      if (nextRank > existingRank || (nextRank === existingRank && c.updatedValue > existing.updatedValue)) {
        dedupedContracts.set(key, c);
      }
    }
  }

  const secretariaParam = String(
    req.query.secretaria ?? req.query.entityId ?? req.query.ent ?? ''
  ).trim();

  const dedupedList = Array.from(dedupedContracts.values());
  const enrichedMunicipalityBatch = await enrichContractsWithSecondarySupplierLookup(dedupedList, 8);

  const evaluatedAll = enrichedMunicipalityBatch.contracts
    .map((c) => evaluateWithContext(c))
    .sort((a, b) => {
      const aScore = a.assessment.coverageStatus !== 'INSUFFICIENT' ? a.assessment.score : -1;
      const bScore = b.assessment.coverageStatus !== 'INSUFFICIENT' ? b.assessment.score : -1;
      if (bScore !== aScore) return bScore - aScore;
      const aSup = hasRealSupplier(a) ? 1 : 0;
      const bSup = hasRealSupplier(b) ? 1 : 0;
      if (bSup !== aSup) return bSup - aSup;
      return b.updatedValue - a.updatedValue;
    });

  const entities = buildEntitiesForMunicipality(ibgeCode, evaluatedAll);

  // Refine contracts when a specific secretaria/entity filter is passed via URL query params
  let resolvedSecretariaId: string | null = null;
  let refinedContracts = evaluatedAll;
  if (secretariaParam && secretariaParam !== 'ALL') {
    const exactEntity = entities.find((e) => e.id === secretariaParam);
    if (exactEntity) {
      resolvedSecretariaId = exactEntity.id;
      refinedContracts = evaluatedAll.filter((c) => c.entityId === exactEntity.id);
    } else {
      const normalizedNeedle = normalizePersonName(secretariaParam);
      const matchedByName = entities.find(
        (e) =>
          normalizePersonName(e.shortName) === normalizedNeedle ||
          normalizePersonName(e.name) === normalizedNeedle ||
          normalizePersonName(e.shortName).includes(normalizedNeedle)
      );
      if (matchedByName) {
        resolvedSecretariaId = matchedByName.id;
        refinedContracts = evaluatedAll.filter((c) => c.entityId === matchedByName.id);
      } else if (normalizedNeedle) {
        resolvedSecretariaId = secretariaParam;
        refinedContracts = evaluatedAll.filter((c) =>
          normalizePersonName(c.entityName).includes(normalizedNeedle)
        );
      }
    }
  }

  res.json({
    municipality,
    entities,
    contracts: refinedContracts,
    summary: {
      contractCount: refinedContracts.length,
      totalMunicipalityContracts: evaluatedAll.length,
      selectedSecretaria: resolvedSecretariaId,
      entityCount: entities.length,
      totalValue: refinedContracts.reduce((sum, c) => sum + c.updatedValue, 0),
      highRiskCount: refinedContracts.filter(
        (c) => c.assessment.coverageStatus !== 'INSUFFICIENT' && c.assessment.score >= 50
      ).length,
      livePncpUsed: liveRes.liveAvailable,
      pncpMessage: liveRes.message,
    },
  });
});

app.get('/api/municipalities/:ibgeCode/siconfi', async (req, res) => {
  const ibgeCode = String(req.params.ibgeCode ?? '').trim();
  const year = Number(req.query.year ?? new Date().getFullYear() - 1);
  const bimester = Number(req.query.bimester ?? 6);
  const result = await querySiconfiRreo(ibgeCode, year, bimester);
  res.json(result);
});

// ==========================================
// API ROUTES — CONTRACTS & CNPJ SEARCH (A13: Alphanumeric + Numeric)
// ==========================================

app.get('/api/contracts/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const ibge = String(req.query.ibge ?? '').trim();
  const year = String(req.query.year ?? '').trim();
  const statusFilter = normalizeLifecycleFilterParam(String(req.query.status ?? ''));
  const startDate = String(req.query.startDate ?? '').trim() || undefined;
  const endDate = String(req.query.endDate ?? '').trim() || undefined;
  const minRisk = Number(req.query.minRisk ?? 0);

  const periodCheck = validateDatePeriod(startDate, endDate);
  if (!periodCheck.valid) {
    res.status(400).json({ error: periodCheck.error });
    return;
  }

  const parsedReference = parsePncpUrlFromQuery(q);
  const parsedContractCode = parseBrazilianContractCode(q);
  const normalizedCnpj = normalizeCnpj(q);
  const isCnpjQuery = isCnpjFormat(normalizedCnpj) && isValidCnpj(normalizedCnpj);

  let resolvedMunicipality: Municipality | null = null;
  let livePncpStatus: {
    queried: boolean;
    municipalityLabel?: string;
    totalLiveRecords: number;
    inexigibilidadeCount: number;
    message: string;
  } | null = null;

  if (/^\d{7}$/.test(ibge)) {
    const { items } = await getIbgeMunicipalities();
    resolvedMunicipality = items.find((m) => m.ibgeCode === ibge) ?? null;
    if (resolvedMunicipality) {
      const live = await fetchLivePncpContratacoes(
        ibge,
        resolvedMunicipality.name,
        resolvedMunicipality.uf,
        { startDate, endDate }
      );
      livePncpStatus = {
        queried: true,
        municipalityLabel: `${resolvedMunicipality.name}/${resolvedMunicipality.uf}`,
        totalLiveRecords: live.records.length,
        inexigibilidadeCount: live.records.filter((r) => r.modality === 'Inexigibilidade').length,
        message: live.message,
      };
    }
  }

  let cnpjCoverage: {
    cnpj: string;
    relatedMatrizCnpj?: string | null;
    filialPncpFetchedCount?: number;
    matrizPncpFetchedCount?: number;
    legalName: string | null;
    profileSource: string | null;
    registrationStatus: string | null;
    primaryCnae: string | null;
    pncpStatus: 'complete' | 'partial' | 'rate_limited' | 'unavailable';
    pncpTotalDeclared: number;
    pncpFetchedCount: number;
    localOnlyCount: number;
    partialCoverage: boolean;
    byRole: {
      fornecedor: number;
      orgao_contratante: number;
      subcontratado: number;
    };
    message: string;
  } | null = null;

  if (isCnpjQuery) {
    const liveResult = await fetchPncpContractsByCnpj(normalizedCnpj, {
      maxPages: 8,
      pageSize: 50,
    });
    for (const r of liveResult.records) {
      persistContract(r);
    }

    const matrizCnpj = deriveMatrizCnpj(normalizedCnpj);
    let matrizFetchedCount = 0;
    if (matrizCnpj) {
      const matrizRes = await fetchPncpContractsByCnpj(matrizCnpj, {
        maxPages: 4,
        pageSize: 50,
      });
      matrizFetchedCount = matrizRes.records.length;
      for (const r of matrizRes.records) {
        persistContract(r);
      }
    }

    const sampleMatch = liveResult.records[0];
    cnpjCoverage = {
      cnpj: normalizedCnpj,
      relatedMatrizCnpj: matrizCnpj,
      filialPncpFetchedCount: liveResult.records.length,
      matrizPncpFetchedCount: matrizFetchedCount,
      legalName: sampleMatch?.supplier.legalName ?? null,
      profileSource: isAlphanumericCnpj(normalizedCnpj)
        ? 'CNPJ Alfanumérico RFB 2026 (PNCP)'
        : 'PNCP Nacional',
      registrationStatus: null,
      primaryCnae: null,
      pncpStatus: liveResult.status,
      pncpTotalDeclared: liveResult.pncpTotalDeclared,
      pncpFetchedCount: liveResult.pncpFetchedCount,
      localOnlyCount: 0,
      partialCoverage: liveResult.partialCoverage,
      byRole: liveResult.byRole,
      message: liveResult.message,
    };

    store.upsertSyncCheckpoint({
      scopeKey: `cnpj:${normalizedCnpj}`,
      sourceSystem: 'PNCP Search API',
      lastSyncedAt: liveResult.retrievedAt,
      status: liveResult.status,
      totalDeclared: liveResult.pncpTotalDeclared,
      totalFetched: liveResult.pncpFetchedCount,
      detail: liveResult.message,
    });
  }

  const all = getAllContracts();
  const qNorm = normalizeText(q);
  const matrizForFilter = isCnpjQuery ? deriveMatrizCnpj(normalizedCnpj) : null;

  const matched = all.filter((c) => {
    if (ibge && c.municipalityIbge !== ibge) return false;
    if (year && String(c.year) !== year) return false;
    if (!matchesContractLifecycleFilter(c, statusFilter)) return false;
    if (!matchesDatePeriod(c.signatureDate || c.startDate, { startDate, endDate })) return false;

    if (q) {
      if (isCnpjQuery) {
        const supNorm = normalizeCnpj(c.supplier.cnpj);
        const matchesSup =
          supNorm === normalizedCnpj || (matrizForFilter != null && supNorm === matrizForFilter);
        if (!matchesSup) return false;
      } else if (parsedReference?.orgaoCnpj) {
        const hay = `${c.pncpControlNumber} ${c.entityId} ${c.contractNumber}`;
        if (!hay.includes(parsedReference.orgaoCnpj)) return false;
      } else {
        const hay = normalizeText(
          `${c.contractNumber} ${c.pncpControlNumber} ${c.object} ${c.supplier.legalName} ${c.supplier.cnpj} ${c.entityName} ${c.municipalityName}`
        );
        if (!hay.includes(qNorm)) return false;
      }
    }
    return true;
  });

  const enrichedSearchBatch = await enrichContractsWithSecondarySupplierLookup(matched, 6);
  const evaluated = enrichedSearchBatch.contracts
    .map((c) => evaluateWithContext(c))
    .filter((c) => {
      if (!Number.isFinite(minRisk) || minRisk <= 0) return true;
      return c.assessment.coverageStatus !== 'INSUFFICIENT' && c.assessment.score >= minRisk;
    })
    .sort((a, b) => b.assessment.score - a.assessment.score);

  // Related contracts with same sequential/year if exact code didn't match
  let relatedResults: EvaluatedContract[] = [];
  if (evaluated.length === 0 && parsedContractCode) {
    relatedResults = all
      .filter((c) => {
        if (ibge && c.municipalityIbge !== ibge) return false;
        return isRelatedContractNumber(c.contractNumber, parsedContractCode, c.year);
      })
      .map((c) => evaluateWithContext(c))
      .slice(0, 15);
  }

  const distinctMunicipalities = new Set(evaluated.map((r) => r.municipalityIbge).filter(Boolean));
  const disambiguationRequired = Boolean(q && !ibge && distinctMunicipalities.size > 1);

  res.json({
    results: evaluated,
    relatedResults,
    total: evaluated.length,
    disambiguationRequired,
    parsedReference,
    parsedContractCode,
    resolvedMunicipality,
    livePncpStatus,
    cnpjCoverage,
  });
});

async function handleCnpjContractsLookup(req: express.Request, res: express.Response) {
  const cleanCnpj = normalizeCnpj(String(req.params.cnpj ?? ''));
  if (!isCnpjFormat(cleanCnpj) || !isValidCnpj(cleanCnpj)) {
    res.status(400).json({
      error: 'CNPJ inválido. Informe 14 caracteres válidos (formato numérico ou alfanumérico RFB 2026).',
    });
    return;
  }

  const maxPages = Math.min(20, Math.max(1, Number(req.query.maxPages ?? 8)));
  const liveResult = await fetchPncpContractsByCnpj(cleanCnpj, { maxPages, pageSize: 50 });
  for (const r of liveResult.records) {
    persistContract(r);
  }

  const matrizCnpj = deriveMatrizCnpj(cleanCnpj);
  if (matrizCnpj) {
    const matrizRes = await fetchPncpContractsByCnpj(matrizCnpj, { maxPages: 4, pageSize: 50 });
    for (const r of matrizRes.records) {
      persistContract(r);
    }
  }

  const matching = getAllContracts()
    .filter(
      (c) =>
        normalizeCnpj(c.supplier.cnpj) === cleanCnpj ||
        (matrizCnpj != null && normalizeCnpj(c.supplier.cnpj) === matrizCnpj)
    )
    .map((c) => evaluateWithContext(c))
    .sort((a, b) => b.assessment.score - a.assessment.score);

  res.json({
    cnpj: cleanCnpj,
    formattedCnpj: formatCnpjValue(cleanCnpj),
    alphanumeric: isAlphanumericCnpj(cleanCnpj),
    relatedMatrizCnpj: matrizCnpj,
    indexSource: 'SQLite Local + PNCP Search API',
    total: matching.length,
    contracts: matching,
    pncpCnpjSync: {
      status: liveResult.status,
      pncpTotalDeclared: liveResult.pncpTotalDeclared,
      pncpFetchedCount: liveResult.pncpFetchedCount,
      pagesFetched: liveResult.pagesFetched,
      partialCoverage: liveResult.partialCoverage,
      byRole: liveResult.byRole,
      message: liveResult.message,
      retrievedAt: liveResult.retrievedAt,
    },
  });
}

app.get('/api/cnpj/:cnpj/contracts', handleCnpjContractsLookup);
app.get('/api/suppliers/:cnpj/contracts', handleCnpjContractsLookup);

app.get('/api/suppliers/:cnpj/sanctions', async (req, res) => {
  const rawCnpj = String(req.params.cnpj ?? '');
  const result = await queryCguSanctionsByCnpj(rawCnpj);
  res.json(result);
});

const QSA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function fetchAndCacheSupplierQsa(
  rawCnpj: string,
  options?: { forceRefresh?: boolean; timeoutMs?: number }
): Promise<{ record: SupplierQsaRecord | null; fromCache: boolean; error?: string }> {
  const cleanCnpj = normalizeCnpj(rawCnpj);
  if (!isCnpjFormat(cleanCnpj) || !isValidCnpj(cleanCnpj)) {
    return { record: null, fromCache: false, error: 'CNPJ inválido.' };
  }
  if (isAlphanumericCnpj(cleanCnpj)) {
    return {
      record: null,
      fromCache: false,
      error: 'CNPJ alfanumérico (RFB 2026) ainda sem suporte em BrasilAPI.',
    };
  }

  const cached = store.getSupplierQsa(cleanCnpj);
  if (cached && !options?.forceRefresh) {
    const ageMs = Date.now() - Date.parse(cached.fetchedAt);
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < QSA_CACHE_TTL_MS) {
      return { record: cached, fromCache: true };
    }
  }

  if (!/^\d{14}$/.test(cleanCnpj)) {
    return { record: cached, fromCache: Boolean(cached), error: 'CNPJ não numérico.' };
  }

  try {
    const { raw: data } = await fetchBrasilApiRawCnpj(cleanCnpj, {
      timeoutMs: options?.timeoutMs ?? 6000,
    });

    const record: SupplierQsaRecord = {
      cnpj: cleanCnpj,
      legalName: String(data.razao_social ?? '').trim() || `CNPJ ${formatCnpjValue(cleanCnpj)}`,
      registrationStatus: String(data.descricao_situacao_cadastral ?? 'DESCONHECIDA').trim(),
      openingDate: String(data.data_inicio_atividade ?? '').trim(),
      primaryCnaeCode: data.cnae_fiscal ? String(data.cnae_fiscal).trim() : '',
      primaryCnaeDescription: String(data.cnae_fiscal_descricao ?? '').trim(),
      municipality: String(data.municipio ?? '').trim(),
      uf: String(data.uf ?? '').trim(),
      shareCapital: Number.isFinite(Number(data.capital_social))
        ? Math.max(0, Number(data.capital_social))
        : 0,
      shareholders: (data.qsa ?? [])
        .filter((p) => Boolean(p.nome_socio && p.nome_socio.trim()))
        .map((p) => {
          const partnerType =
            p.identificador_de_socio === 1
              ? ('PJ' as const)
              : p.identificador_de_socio === 2
                ? ('PF' as const)
                : p.identificador_de_socio === 3
                  ? ('EXTERIOR' as const)
                  : undefined;
          const maskedDoc = minimizeMaskedDocument(p.cnpj_cpf_do_socio) || undefined;
          const partnerCnpj =
            resolveCorporatePartnerCnpj({
              maskedDocument: p.cnpj_cpf_do_socio ?? maskedDoc,
              partnerType,
            }) ?? undefined;
          return {
            name: String(p.nome_socio ?? '').trim(),
            role: String(p.qualificacao_socio ?? 'Sócio').trim(),
            entryDate: String(p.data_entrada_sociedade ?? '').trim(),
            maskedDocument: maskedDoc,
            ageRange: p.faixa_etaria ? String(p.faixa_etaria).trim() : undefined,
            partnerType,
            partnerCnpj,
            legalRepresentativeName: p.nome_representante_legal
              ? String(p.nome_representante_legal).trim()
              : undefined,
            legalRepresentativeRole: p.qualificacao_representante_legal
              ? String(p.qualificacao_representante_legal).trim()
              : undefined,
          };
        }),
      sourceProvider: 'BrasilAPI CNPJ (intermediário — dados Receita Federal)',
      fetchedAt: new Date().toISOString(),
    };

    store.upsertSupplierQsa(record);
    return { record, fromCache: false };
  } catch (err) {
    return {
      record: cached,
      fromCache: Boolean(cached),
      error: `Consulta cadastral indisponível (${err instanceof Error ? err.message : 'erro de rede'}).`,
    };
  }
}

async function enrichContractsWithSecondarySupplierLookup(
  records: ContractRecord[],
  maxExternalLookups = 8
) {
  return resolveContractsSupplierNames(records, {
    getLocalCompanyByCnpj: (cnpj) => store.getSupplierQsa(cnpj),
    getKnownContracts: () => getAllContracts(),
    fetchCompanyByCnpj: (cnpj) => fetchAndCacheSupplierQsa(cnpj, { timeoutMs: 4500 }),
    onContractEnriched: (enriched) => persistContract(enriched),
    maxExternalLookups,
  });
}

app.get('/api/suppliers/:cnpj/live-check', async (req, res) => {
  const cleanCnpj = normalizeCnpj(String(req.params.cnpj ?? ''));
  if (!isCnpjFormat(cleanCnpj) || !isValidCnpj(cleanCnpj)) {
    res.status(400).json({ error: 'CNPJ inválido.' });
    return;
  }

  if (isAlphanumericCnpj(cleanCnpj)) {
    res.json({
      enriched: false,
      source: 'BrasilAPI / ReceitaWS (suporte alfanumérico pendente no provedor externo)',
      message:
        'CNPJ alfanumérico válido conforme regra RFB 2026 (Módulo 11). Os provedores públicos gratuitos de consulta cadastral ainda não suportam consulta alfanumérica em tempo real.',
    });
    return;
  }

  const result = await fetchAndCacheSupplierQsa(cleanCnpj, { forceRefresh: true, timeoutMs: 5500 });
  if (!result.record) {
    res.json({
      enriched: false,
      source: 'BrasilAPI CNPJ',
      message: result.error ?? 'Consulta cadastral indisponível.',
    });
    return;
  }

  res.json({
    enriched: true,
    source: result.record.sourceProvider,
    data: {
      legalName: result.record.legalName,
      openingDate: result.record.openingDate,
      primaryCnaeCode: result.record.primaryCnaeCode,
      primaryCnaeDescription: result.record.primaryCnaeDescription,
      shareCapital: result.record.shareCapital,
      registrationStatus: result.record.registrationStatus,
      shareholders: result.record.shareholders.map((p) => ({
        name: p.name,
        role: p.role,
        entryDate: p.entryDate,
      })),
    },
  });
});

// ==========================================
// API ROUTES — MAPA DE VÍNCULOS SOCIETÁRIOS (REDE DE SÓCIOS — F06/M02/M05)
// ==========================================

function buildPartnerNetworkResponsePayload(params: {
  query: string;
  mode: PartnerNetworkQueryMode;
  liveEnrichedCnpjs: string[];
  sourceCoverage?: PartnerNetworkSourceCoverageItem[];
  expansionControl?: {
    truncated: boolean;
    truncationReasons: string[];
    cancelled: boolean;
    elapsedMs: number;
    requestsUsed: number;
    maxRequests: number;
    maxDurationMs: number;
    maxDepth: number;
    maxCompanies: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
  };
}) {
  const allContracts = getAllContracts();
  const evaluatedAll = allContracts.map((c) => evaluateWithContext(c));
  const qsaRecords = store.listAllSupplierQsa();

  const graph = buildPartnerNetworkGraph({
    query: params.query,
    mode: params.mode,
    contracts: evaluatedAll,
    qsaRecords,
  });

  // Annotate every edge with explicit assertionState (documented vs candidate vs contested)
  const annotatedEdges = graph.edges.map((edge) => ({
    ...edge,
    assertionState: classifyPartnerGraphAssertionState(edge),
  }));

  const cleanCnpj = normalizeCnpj(params.query);
  const isCnpjLookup = isCnpjFormat(cleanCnpj) && isValidCnpj(cleanCnpj);
  let disambiguation:
    | {
        requiresDisambiguation: boolean;
        candidateCount: number;
        snapshotCoverageDeclaration: string;
        candidates: Array<{
          candidateId: string;
          displayName: string;
          maskedDocuments: string[];
          relatedCompanyCnpjs: string[];
          relatedCompanyNames: string[];
          matchConfidence: 'candidate_masked_cpf_and_name' | 'candidate_nominal_only';
          disambiguationReason: string;
        }>;
      }
    | undefined;

  if (!isCnpjLookup) {
    const revIndex = buildReverseParticipationIndex(qsaRecords);
    const dis = disambiguatePersonQuery(params.query, revIndex);
    if (dis.candidateCount > 0) {
      disambiguation = {
        requiresDisambiguation: dis.requiresDisambiguation,
        candidateCount: dis.candidateCount,
        snapshotCoverageDeclaration: dis.snapshotCoverage.declaration,
        candidates: dis.candidates.slice(0, 12).map((c) => ({
          candidateId: c.candidateId,
          displayName: c.displayName,
          maskedDocuments: c.maskedDocuments,
          relatedCompanyCnpjs: c.relatedCompanyCnpjs,
          relatedCompanyNames: c.relatedCompanyNames,
          matchConfidence: c.matchConfidence,
          disambiguationReason: c.disambiguationReason,
        })),
      };
    }
  }

  const contractIdSet = new Set(graph.contracts.map((c) => c.contractId));
  const evaluatedContracts = evaluatedAll.filter((c) => contractIdSet.has(c.id));

  const uniqueSuppliers = new Set(
    allContracts
      .map((c) => normalizeCnpj(c.supplier?.cnpj ?? ''))
      .filter((c) => isCnpjFormat(c) && isValidCnpj(c))
  );
  const suggestions = buildPartnerNetworkSuggestions({
    contracts: allContracts,
    qsaRecords,
  });

  return {
    ...graph,
    edges: annotatedEdges,
    evaluatedContracts,
    indexCoverage: {
      totalUniqueSuppliers: uniqueSuppliers.size,
      indexedQsaCount: qsaRecords.length,
      totalPartnersIndexed: suggestions.totalPartnersIndexed,
      liveEnrichedCnpjs: params.liveEnrichedCnpjs,
      sourceCoverage: params.sourceCoverage,
    },
    ...(params.expansionControl ? { expansionControl: params.expansionControl } : {}),
    ...(disambiguation ? { disambiguation } : {}),
  };
}

app.get('/api/network/partners/suggestions', requireViewerOrAbove, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const allContracts = getAllContracts();
  const qsaRecords = store.listAllSupplierQsa();
  const suggestions = buildPartnerNetworkSuggestions({
    contracts: allContracts,
    qsaRecords,
  });
  res.json(suggestions);
});

app.post('/api/network/partners/enrich-index', requireAnalystAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const rawLimit = Number((req.body as { limit?: number } | undefined)?.limit ?? 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(15, Math.max(1, Math.trunc(rawLimit))) : 10;

  const allContracts = getAllContracts();
  const existingQsa = new Set(store.listAllSupplierQsa().map((q) => normalizeCnpj(q.cnpj)));

  // Rank uncached valid numeric supplier CNPJs by contract frequency
  const freqByCnpj = new Map<string, number>();
  for (const c of allContracts) {
    const clean = normalizeCnpj(c.supplier?.cnpj ?? '');
    if (!/^\d{14}$/.test(clean) || !isValidCnpj(clean)) continue;
    if (existingQsa.has(clean)) continue;
    freqByCnpj.set(clean, (freqByCnpj.get(clean) ?? 0) + 1);
  }

  const candidates = Array.from(freqByCnpj.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([cnpj]) => cnpj);

  const enrichedCnpjs: string[] = [];
  let failed = 0;

  for (let i = 0; i < candidates.length; i += 1) {
    const cnpj = candidates[i];
    const lookup = await fetchAndCacheSupplierQsa(cnpj, { timeoutMs: 5000 });
    if (lookup.record && !lookup.fromCache) {
      enrichedCnpjs.push(cnpj);
    } else if (!lookup.record) {
      failed += 1;
    }
    if (i < candidates.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 140));
    }
  }

  const updatedSuggestions = buildPartnerNetworkSuggestions({
    contracts: getAllContracts(),
    qsaRecords: store.listAllSupplierQsa(),
  });

  res.json({
    attempted: candidates.length,
    enriched: enrichedCnpjs.length,
    failed,
    enrichedCnpjs,
    suggestions: updatedSuggestions,
  });
});

// Strictly read-only query over locally indexed SQLite contracts & QSA (F06)
app.get('/api/network/partners', requireViewerOrAbove, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const q = String(req.query.q ?? '').trim();
  const rawMode = String(req.query.mode ?? 'auto').trim().toLowerCase();
  const mode: PartnerNetworkQueryMode =
    rawMode === 'company' || rawMode === 'partner' ? rawMode : 'auto';

  if (q.length < 2) {
    res.status(400).json({
      error: 'Informe um CNPJ (14 dígitos), razão social da empresa ou nome do empresário/sócio.',
    });
    return;
  }

  res.json(
    buildPartnerNetworkResponsePayload({
      query: q,
      mode,
      liveEnrichedCnpjs: [],
    })
  );
});

app.get('/api/network/partners/disambiguate', requireViewerOrAbove, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) {
    res.status(400).json({ error: 'Informe ao menos 2 caracteres para consulta nominal.' });
    return;
  }
  const index = buildReverseParticipationIndex(store.listAllSupplierQsa());
  res.json(disambiguatePersonQuery(q, index));
});

// Explicit state-changing sync endpoint (F06 + M02 + M05 + Incremental Expansion Guardrails):
// Enforces overall time budget, request budget, depth/company limits, pagination, and AbortSignal
// disconnect cancellation so slow upstream APIs NEVER cause gateway HTML timeouts.
app.post('/api/network/partners/sync', requireAnalystAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const startedAt = Date.now();
  const syncAbort = new AbortController();
  const onClientClose = () => {
    if (!res.writableEnded) {
      syncAbort.abort();
    }
  };
  req.on('close', onClientClose);

  try {
    const body = (req.body ?? {}) as {
      query?: string;
      mode?: string;
      syncPncp?: boolean;
      syncSecondaryCompanies?: boolean;
      maxDepth?: number;
      maxCompanies?: number;
      maxRequests?: number;
      maxDurationMs?: number;
      page?: number;
      pageSize?: number;
    };
    const q = String(body.query ?? '').trim();
    const rawMode = String(body.mode ?? 'auto').trim().toLowerCase();
    const mode: PartnerNetworkQueryMode =
      rawMode === 'company' || rawMode === 'partner' ? rawMode : 'auto';
    const syncPncp = body.syncPncp !== false;
    const syncSecondaryCompanies = body.syncSecondaryCompanies !== false;

    const MAX_SYNC_COMPANIES = Math.max(1, Math.min(Number(body.maxCompanies) || 6, 16));
    const MAX_RECURSION_DEPTH = Math.max(1, Math.min(Number(body.maxDepth) || 4, 6));
    const MAX_REQUESTS = Math.max(2, Math.min(Number(body.maxRequests) || 12, 24));
    const MAX_DURATION_MS = Math.max(2000, Math.min(Number(body.maxDurationMs) || 10_000, 22_000));
    const page = Math.max(1, Math.floor(Number(body.page) || 1));
    const pageSize = Math.max(5, Math.min(Math.floor(Number(body.pageSize) || 25), 100));

    if (q.length < 2) {
      res.status(400).json({
        error: 'Informe um CNPJ (14 dígitos), razão social da empresa ou nome do empresário/sócio.',
      });
      return;
    }

    const liveEnrichedCnpjs: string[] = [];
    const coverageMap = new Map<string, PartnerNetworkSourceCoverageItem>();
    const truncationReasons: string[] = [];
    let requestsUsed = 0;

    const addTruncation = (reason: string) => {
      if (!truncationReasons.includes(reason)) {
        truncationReasons.push(reason);
      }
    };

    const budgetRemainingMs = () => MAX_DURATION_MS - (Date.now() - startedAt);
    const isBudgetExhausted = (): boolean => {
      if (syncAbort.signal.aborted) {
        addTruncation('Sincronização cancelada pelo cliente.');
        return true;
      }
      if (budgetRemainingMs() <= 400) {
        addTruncation(`Orçamento de tempo da sincronização atingido (${MAX_DURATION_MS} ms).`);
        return true;
      }
      if (requestsUsed >= MAX_REQUESTS) {
        addTruncation(`Limite de requisições externas atingido (${MAX_REQUESTS}).`);
        return true;
      }
      return false;
    };

    const queue: Array<{ cnpj: string; depth: number; maxPncpPages: number }> = [];
    const enqueued = new Set<string>();

    const enqueueCnpj = (rawCnpj: string, depth: number, maxPncpPages: number) => {
      const clean = normalizeCnpj(rawCnpj);
      if (!isCnpjFormat(clean) || !isValidCnpj(clean)) return;
      if (depth > MAX_RECURSION_DEPTH) {
        addTruncation(`Limite de profundidade societária atingido (${MAX_RECURSION_DEPTH}).`);
        return;
      }
      if (enqueued.has(clean) || coverageMap.has(clean)) return;
      if (enqueued.size >= MAX_SYNC_COMPANIES) {
        addTruncation(`Limite de empresas sincronizadas por lote atingido (${MAX_SYNC_COMPANIES}).`);
        return;
      }
      enqueued.add(clean);
      queue.push({ cnpj: clean, depth, maxPncpPages });
    };

    const syncSingleCompany = async (
      cnpj: string,
      depth: number,
      maxPncpPages: number
    ): Promise<SupplierQsaRecord | null> => {
      const clean = normalizeCnpj(cnpj);
      if (!isCnpjFormat(clean) || !isValidCnpj(clean)) return null;
      if (coverageMap.has(clean)) return store.getSupplierQsa(clean);
      if (isBudgetExhausted()) return store.getSupplierQsa(clean);

      const item: PartnerNetworkSourceCoverageItem = {
        cnpj: clean,
        qsaStatus: 'skipped',
        pncpStatus: 'not_queried',
        pagesFetched: 0,
        totalDeclared: 0,
      };

      const qsaStart = Date.now();
      const qsaTimeout = Math.max(1200, Math.min(4000, budgetRemainingMs() - 250));
      requestsUsed += 1;
      const qsaLookup = await fetchAndCacheSupplierQsa(clean, { timeoutMs: qsaTimeout }).catch(
        (err: unknown) => ({
          record: null,
          fromCache: false,
          error: err instanceof Error ? err.message : 'erro ao consultar QSA',
        })
      );
      observability.recordSourceCall({
        source: 'brasilapi_qsa',
        ok: Boolean(qsaLookup.record),
        timedOut: Boolean(qsaLookup.error && /abort|timeout/i.test(qsaLookup.error)),
        latencyMs: Date.now() - qsaStart,
        statusLabel: qsaLookup.record ? (qsaLookup.fromCache ? 'cached' : 'live_ok') : 'unavailable',
      });

      if (qsaLookup.record) {
        item.qsaStatus = qsaLookup.fromCache ? 'cached' : 'live_ok';
        if (!qsaLookup.fromCache) {
          liveEnrichedCnpjs.push(clean);
        }
        for (const sh of qsaLookup.record.shareholders) {
          const corpCnpj = resolveCorporatePartnerCnpj({
            partnerCnpj: sh.partnerCnpj,
            maskedDocument: sh.maskedDocument,
            partnerType: sh.partnerType,
          });
          if (corpCnpj && corpCnpj !== clean) {
            enqueueCnpj(corpCnpj, depth + 1, 1);
          }
        }
      } else {
        item.qsaStatus = 'unavailable';
        if (qsaLookup.error) item.errorDetail = qsaLookup.error;
      }

      if (syncPncp && !isBudgetExhausted()) {
        const pncpStart = Date.now();
        const pncpTimeout = Math.max(1200, Math.min(3500, budgetRemainingMs() - 250));
        requestsUsed += 1;
        try {
          const livePncp = await fetchPncpContractsByCnpj(clean, {
            maxPages: Math.min(maxPncpPages, 2),
            pageSize: 50,
            timeoutMs: pncpTimeout,
            retries: 1,
            signal: syncAbort.signal,
          });
          observability.recordSourceCall({
            source: 'pncp_search',
            ok: livePncp.status === 'complete' || livePncp.status === 'partial',
            timedOut: livePncp.status === 'unavailable' && /abort|timeout/i.test(livePncp.message),
            latencyMs: Date.now() - pncpStart,
            statusLabel: livePncp.status,
          });
          item.pncpStatus = livePncp.status;
          item.pagesFetched = livePncp.pagesFetched;
          item.totalDeclared = livePncp.pncpTotalDeclared;
          if (livePncp.status !== 'complete' && livePncp.message) {
            item.errorDetail = item.errorDetail
              ? `${item.errorDetail}; ${livePncp.message}`
              : livePncp.message;
          }
          for (const rec of livePncp.records) {
            persistContract(rec);
          }
        } catch (err) {
          item.pncpStatus = 'unavailable';
          const msg = err instanceof Error ? err.message : 'erro de rede PNCP';
          item.errorDetail = item.errorDetail ? `${item.errorDetail}; ${msg}` : msg;
          observability.recordSourceCall({
            source: 'pncp_search',
            ok: false,
            timedOut: /abort|timeout/i.test(msg),
            latencyMs: Date.now() - pncpStart,
            statusLabel: 'error',
          });
        }
      }

      coverageMap.set(clean, item);
      return qsaLookup.record ?? null;
    };

    const cleanCnpjQuery = normalizeCnpj(q);
    const isCnpjQuery = isCnpjFormat(cleanCnpjQuery) && isValidCnpj(cleanCnpjQuery);

    if (isCnpjQuery) {
      enqueueCnpj(cleanCnpjQuery, 0, 2);
    } else if (mode !== 'partner') {
      const qTokens = normalizePersonName(q)
        .split(' ')
        .filter((t) => t.length >= 2);
      if (qTokens.length > 0) {
        let seeded = 0;
        for (const c of getAllContracts()) {
          const cnpj = normalizeCnpj(c.supplier?.cnpj ?? '');
          if (!/^\d{14}$/.test(cnpj) || !isValidCnpj(cnpj)) continue;
          const hay = normalizePersonName(c.supplier?.legalName ?? '');
          if (qTokens.every((t) => hay.includes(t))) {
            enqueueCnpj(cnpj, 0, 1);
            seeded += 1;
            if (seeded >= 3) break;
          }
        }
        if (seeded === 0) {
          for (const qsa of store.listAllSupplierQsa()) {
            const hay = normalizePersonName(qsa.legalName ?? '');
            if (qTokens.every((t) => hay.includes(t))) {
              enqueueCnpj(qsa.cnpj, 0, 1);
              seeded += 1;
              if (seeded >= 3) break;
            }
          }
        }
      }
    }

    let expansionPass = 0;
    const MAX_EXPANSION_PASSES = MAX_RECURSION_DEPTH;
    while (
      expansionPass < MAX_EXPANSION_PASSES &&
      coverageMap.size < MAX_SYNC_COMPANIES &&
      !isBudgetExhausted()
    ) {
      while (
        queue.length > 0 &&
        coverageMap.size < MAX_SYNC_COMPANIES &&
        !isBudgetExhausted()
      ) {
        const next = queue.shift()!;
        await syncSingleCompany(next.cnpj, next.depth, next.maxPncpPages);
      }

      if (
        !syncSecondaryCompanies ||
        coverageMap.size >= MAX_SYNC_COMPANIES ||
        isBudgetExhausted()
      ) {
        break;
      }

      const interimGraph = buildPartnerNetworkGraph({
        query: q,
        mode,
        contracts: getAllContracts(),
        qsaRecords: store.listAllSupplierQsa(),
      });

      const newlyDiscovered = interimGraph.companies
        .filter((c) => !coverageMap.has(c.cnpj) && !enqueued.has(c.cnpj))
        .sort((a, b) => {
          if (a.isCorporateShareholder !== b.isCorporateShareholder) {
            return a.isCorporateShareholder ? -1 : 1;
          }
          if ((a.qsaSource === 'none') !== (b.qsaSource === 'none')) {
            return a.qsaSource === 'none' ? -1 : 1;
          }
          return b.contractCount - a.contractCount;
        });

      if (newlyDiscovered.length === 0) {
        break;
      }

      for (const comp of newlyDiscovered) {
        enqueueCnpj(comp.cnpj, expansionPass + 1, 1);
        if (enqueued.size >= MAX_SYNC_COMPANIES) break;
      }

      expansionPass += 1;
    }

    if (res.writableEnded) return;

    const payload = buildPartnerNetworkResponsePayload({
      query: q,
      mode,
      liveEnrichedCnpjs,
      sourceCoverage: Array.from(coverageMap.values()),
      expansionControl: {
        truncated: truncationReasons.length > 0 || queue.length > 0,
        truncationReasons,
        cancelled: syncAbort.signal.aborted,
        elapsedMs: Date.now() - startedAt,
        requestsUsed,
        maxRequests: MAX_REQUESTS,
        maxDurationMs: MAX_DURATION_MS,
        maxDepth: MAX_RECURSION_DEPTH,
        maxCompanies: MAX_SYNC_COMPANIES,
        page,
        pageSize,
        hasMore: queue.length > 0,
      },
    });

    res.json(payload);
  } catch (err) {
    console.error(
      '[NEXOFIS] Erro na sincronização da rede societária:',
      sanitizeLogPayload({ error: err instanceof Error ? err.message : String(err) })
    );
    if (!res.headersSent) {
      res.status(500).json({
        error:
          'Falha interna ao sincronizar QSA e contratos da rede societária. Os dados já indexados permanecem preservados.',
      });
    }
  } finally {
    req.off('close', onClientClose);
  }
});

// ==========================================
// API ROUTES — CONTRACT DETAIL, OCDS & REVIEWS (A06 + A09)
// ==========================================

app.get('/api/contracts/:id', async (req, res) => {
  const contract = contractStore.get(String(req.params.id));
  if (!contract) {
    res.status(404).json({ error: 'Contrato não encontrado na base de auditoria.' });
    return;
  }

  const enriched = await enrichContractsWithSecondarySupplierLookup([contract], 1);
  const evaluated = evaluateWithContext(enriched.contracts[0] ?? contract);
  res.json(evaluated);
});

app.get('/api/contracts/:id/ocds', (req, res) => {
  const contract = contractStore.get(String(req.params.id));
  if (!contract) {
    res.status(404).json({ error: 'Contrato não encontrado.' });
    return;
  }
  const evaluated = evaluateWithContext(contract);
  res.json(mapContractToOCDS(evaluated));
});

app.get('/api/contracts/:id/reviews', (req, res) => {
  const contractId = String(req.params.id);
  if (!contractStore.has(contractId)) {
    res.status(404).json({ error: 'Contrato não encontrado.' });
    return;
  }
  res.json({ reviews: store.listFindingReviews(contractId) });
});

app.post(
  '/api/contracts/:id/findings/:findingId/review',
  requireAnalystAuth,
  (req: AuthenticatedRequest, res) => {
    const contractId = String(req.params.id);
    const findingId = String(req.params.findingId);
    const contract = contractStore.get(contractId);

    if (!contract) {
      res.status(404).json({ error: 'Contrato não encontrado.' });
      return;
    }

    const action = String(req.body?.action ?? '').trim() as FindingReviewRecord['action'];
    const rationale = String(req.body?.rationale ?? '').trim();

    if (action !== 'dismiss' && action !== 'restore') {
      res.status(400).json({
        error: 'Ação de revisão inválida. Utilize "dismiss" ou "restore".',
      });
      return;
    }

    if (rationale.length < 5) {
      res.status(400).json({
        error: 'Justificativa técnica obrigatória (mínimo de 5 caracteres).',
      });
      return;
    }

    // A06: Validate findingId against current server-evaluated indicators and stamp server ruleVersion + inputsDigest
    const evaluated = evaluateWithContext(contract);
    const matchedIndicator = evaluated.assessment.indicators.find(
      (ind) => ind.findingId === findingId
    );
    if (!matchedIndicator) {
      res.status(404).json({
        error: `Achado ${findingId} não pertence à avaliação atual do contrato ${contract.contractNumber}.`,
      });
      return;
    }

    // A09: Derive actor strictly from authenticated principal — NEVER trust client-supplied author
    const principal = req.nexofisPrincipal;
    const derivedAuthor = principal?.authEnabled
      ? principal.displayName || principal.email || principal.userId
      : 'Workspace Local (sem autenticação)';
    const derivedActorId = principal?.userId ?? 'local-workspace';
    const derivedActorRole = principal?.role ?? 'admin';

    const review: FindingReviewRecord = {
      id: `REV-${crypto.randomUUID()}`,
      contractId,
      findingId: matchedIndicator.findingId,
      action,
      author: derivedAuthor,
      actorId: derivedActorId,
      actorRole: derivedActorRole,
      rationale: rationale.slice(0, 2000),
      ruleVersion: matchedIndicator.ruleVersion,
      findingInputsDigest: matchedIndicator.inputsDigest,
      createdAt: new Date().toISOString(),
    };

    store.addFindingReview(review);

    res.status(201).json({
      review,
      reviews: store.listFindingReviews(contractId),
    });
  }
);

// ==========================================
// API ROUTES — FORENSIC INVESTIGATION MODULE (STRICT AUTH + PRIVATE EVIDENCE)
// ==========================================

function deriveStrictInvestigationActor(req: AuthenticatedRequest): InvestigationActor {
  const principal = req.nexofisPrincipal!;
  return {
    actorId: principal.userId,
    actorName: principal.displayName || principal.email || principal.userId,
    actorRole: principal.role,
  };
}

function buildInvestigationContractInput(contract: ContractRecord): InvestigationContractInput {
  return {
    id: contract.id,
    contractNumber: contract.contractNumber,
    pncpControlNumber: contract.pncpControlNumber,
    municipalityName: contract.municipalityName,
    municipalityIbge: contract.municipalityIbge,
    uf: contract.uf,
    entityName: contract.entityName,
    signatureDate: contract.signatureDate,
    originalValue: contract.originalValue,
    updatedValue: contract.updatedValue,
    supplierCnpj: contract.supplier.cnpj,
    supplierName: contract.supplier.legalName,
    supplierOpeningDate: contract.supplier.openingDate || undefined,
  };
}

function buildInvestigationCaseResponse(
  contract: ContractRecord,
  storedCase: ReturnType<typeof store.getOrCreateInvestigationCase>
): InvestigationCasePayload {
  const contractInput = buildInvestigationContractInput(contract);
  const evaluation = evaluateForensicInvestigation({
    contract: contractInput,
    factSet: storedCase.factSet,
    cadastralExtracts: storedCase.cadastralExtracts,
    observedHistory: storedCase.observedHistory,
    privateEvidence: storedCase.privateEvidence,
    reviews: storedCase.reviews,
  });
  const chainVerification = verifyCaseLedgerIntegrity({
    factSet: storedCase.factSet,
    events: storedCase.events,
  });

  return {
    contractId: contract.id,
    contractSummary: {
      contractNumber: contract.contractNumber,
      pncpControlNumber: contract.pncpControlNumber,
      municipalityName: contract.municipalityName,
      municipalityIbge: contract.municipalityIbge,
      uf: contract.uf,
      entityName: contract.entityName,
      signatureDate: contract.signatureDate,
      originalValue: contract.originalValue,
      updatedValue: contract.updatedValue,
      supplierCnpj: contract.supplier.cnpj,
      supplierName: contract.supplier.legalName,
    },
    factSet: storedCase.factSet,
    cadastralExtracts: storedCase.cadastralExtracts,
    observedHistory: storedCase.observedHistory,
    privateEvidence: storedCase.privateEvidence,
    reviews: storedCase.reviews,
    events: storedCase.events,
    chainVerification,
    evaluation,
  };
}

app.get(
  '/api/contracts/:id/investigation',
  requireStrictInvestigationAuth,
  (req: AuthenticatedRequest, res) => {
    const contractId = String(req.params.id);
    const contract = contractStore.get(contractId);
    if (!contract) {
      res.status(404).json({ error: 'Contrato não encontrado na base de auditoria.' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    const actor = deriveStrictInvestigationActor(req);
    const storedCase = store.getOrCreateInvestigationCase(contractId, actor);
    res.json(buildInvestigationCaseResponse(contract, storedCase));
  }
);

app.post(
  '/api/contracts/:id/investigation/cadastral-query',
  requireStrictInvestigationAuth,
  async (req: AuthenticatedRequest, res) => {
    const contractId = String(req.params.id);
    const contract = contractStore.get(contractId);
    if (!contract) {
      res.status(404).json({ error: 'Contrato não encontrado.' });
      return;
    }
    const actor = deriveStrictInvestigationActor(req);
    const purpose = String(req.body?.purpose ?? '').trim();
    const legalBasis = String(req.body?.legalBasis ?? '').trim();
    const justification = String(req.body?.justification ?? '').trim();

    if (purpose.length < 5 || legalBasis.length < 4 || justification.length < 8) {
      res.status(400).json({
        error:
          'Informe finalidade (mín. 5 caracteres), base legal (mín. 4 caracteres) e justificativa (mín. 8 caracteres) para registrar a consulta cadastral minimizada.',
      });
      return;
    }

    try {
      const extract = await fetchBrasilApiMinimizedExtract({
        cnpj: contract.supplier.cnpj,
        acquiredBy: actor.actorName,
        purpose,
        legalBasis,
        justification,
      });

      const updated = store.appendCadastralExtract(contractId, extract, actor);
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({
        extract,
        investigation: buildInvestigationCaseResponse(contract, updated),
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Falha na consulta cadastral BrasilAPI.',
      });
    }
  }
);

app.post(
  '/api/contracts/:id/investigation/pncp-history',
  requireStrictInvestigationAuth,
  async (req: AuthenticatedRequest, res) => {
    const contractId = String(req.params.id);
    const contract = contractStore.get(contractId);
    if (!contract) {
      res.status(404).json({ error: 'Contrato não encontrado.' });
      return;
    }
    const actor = deriveStrictInvestigationActor(req);
    const cleanCnpj = normalizeCnpj(contract.supplier.cnpj);
    if (!cleanCnpj) {
      res.status(400).json({ error: 'CNPJ do fornecedor ausente neste contrato.' });
      return;
    }

    let pncpStatus: ObservedHistorySnapshot['pncpStatus'] = 'local_only';
    let pncpMessage = 'Sincronizado com a base local observada.';
    const sourcesChecked = ['Base Local NEXOFIS (SQLite)'];

    if (isCnpjFormat(cleanCnpj) && isValidCnpj(cleanCnpj)) {
      try {
        const liveResult = await fetchPncpContractsByCnpj(cleanCnpj, { maxPages: 6, pageSize: 50 });
        sourcesChecked.push('PNCP Search API');
        pncpStatus = liveResult.status;
        pncpMessage = liveResult.message;
        for (const r of liveResult.records) {
          persistContract(r);
        }
      } catch (err) {
        sourcesChecked.push('PNCP Search API (indisponível)');
        pncpStatus = 'unavailable';
        pncpMessage = `PNCP indisponível (${err instanceof Error ? err.message : 'erro de rede'}); mantida base local.`;
      }
    }

    const matching = getAllContracts().filter(
      (c) => normalizeCnpj(c.supplier.cnpj) === cleanCnpj
    );

    const observedContracts: ObservedContractRecord[] = matching.map((c) => {
      const numericVal =
        typeof c.updatedValue === 'number' && Number.isFinite(c.updatedValue) && c.updatedValue > 0
          ? c.updatedValue
          : typeof c.originalValue === 'number' && Number.isFinite(c.originalValue) && c.originalValue > 0
            ? c.originalValue
            : null;
      return {
        id: c.id,
        pncpControlNumber: c.pncpControlNumber || null,
        contractNumber: c.contractNumber,
        buyerKey: normalizeOrganKey(c.entityName) || c.municipalityIbge || c.entityName,
        buyerName: c.entityName || c.municipalityName,
        municipalityIbge: c.municipalityIbge || null,
        signatureDate: c.signatureDate || null,
        contractValue: numericVal,
        hasValueDivergence: false,
        sourceSystem: c.dataSourceOrigin || 'Base Local NEXOFIS',
      };
    });

    const snapshot: ObservedHistorySnapshot = {
      updatedAt: new Date().toISOString(),
      updatedBy: actor.actorName,
      supplierCnpj: cleanCnpj,
      sourcesChecked,
      pncpStatus,
      coverageNote: `${pncpMessage} (${observedContracts.length} registro(s) observado(s) no universo consultado).`,
      contracts: observedContracts,
    };

    const updated = store.saveObservedHistory(contractId, snapshot, actor);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      observedHistory: snapshot,
      investigation: buildInvestigationCaseResponse(contract, updated),
    });
  }
);

app.post(
  '/api/contracts/:id/investigation/evidence',
  requireStrictInvestigationAuth,
  (req: AuthenticatedRequest, res, next) => {
    privateEvidenceUpload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: `Arquivo de evidência privada excede o limite de 1 MiB (${MAX_PRIVATE_EVIDENCE_BYTES} bytes).`,
        });
        return;
      }
      if (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Falha ao processar upload de evidência privada.',
        });
        return;
      }
      next();
    });
  },
  (req: AuthenticatedRequest, res) => {
    const contractId = String(req.params.id);
    const contract = contractStore.get(contractId);
    if (!contract) {
      res.status(404).json({ error: 'Contrato não encontrado.' });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'Nenhum arquivo enviado no campo "file".' });
      return;
    }

    const sourceLabel = String(req.body?.sourceLabel ?? '').trim();
    const description = String(req.body?.description ?? '').trim();
    const acquiredAt = String(req.body?.acquiredAt ?? '').trim() || new Date().toISOString();

    if (sourceLabel.length < 3 || description.length < 5) {
      res.status(400).json({
        error: 'Informe a origem documental (sourceLabel, mín. 3 chars) e a descrição (mín. 5 chars).',
      });
      return;
    }

    const ext = path.extname(file.originalname).toLowerCase();
    const detectedMime =
      file.mimetype && file.mimetype !== 'application/octet-stream'
        ? file.mimetype
        : ext === '.pdf'
          ? 'application/pdf'
          : ext === '.png'
            ? 'image/png'
            : ext === '.jpg' || ext === '.jpeg'
              ? 'image/jpeg'
              : ext === '.webp'
                ? 'image/webp'
                : ext === '.json'
                  ? 'application/json'
                  : ext === '.csv'
                    ? 'text/csv'
                    : 'text/plain';

    // Validate binary magic bytes for supported formats (allow JSON/TXT/CSV UTF-8 text safely)
    if (detectedMime !== 'application/json') {
      const magicCheck = validateUploadedFileMagic(file.buffer, detectedMime);
      if (!magicCheck.valid) {
        res.status(400).json({
          error: magicCheck.reason ?? 'Arquivo privado rejeitado na validação binária.',
        });
        return;
      }
    }

    const actor = deriveStrictInvestigationActor(req);
    try {
      const saved = store.savePrivateEvidence(
        {
          contractId,
          filename: file.originalname,
          mimeType: detectedMime,
          sourceLabel,
          description,
          acquiredAt,
          bytes: file.buffer,
        },
        actor
      );
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({
        evidence: saved.record,
        investigation: buildInvestigationCaseResponse(contract, saved.investigation),
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Erro ao armazenar evidência privada.',
      });
    }
  }
);

app.get(
  '/api/contracts/:id/investigation/evidence/:evidenceId/download',
  requireStrictInvestigationAuth,
  (req: AuthenticatedRequest, res) => {
    const contractId = String(req.params.id);
    const evidenceId = String(req.params.evidenceId);
    const contract = contractStore.get(contractId);
    if (!contract) {
      res.status(404).json({ error: 'Contrato não encontrado.' });
      return;
    }

    const ev = store.getPrivateEvidenceById(contractId, evidenceId);
    if (!ev) {
      res.status(404).json({ error: 'Evidência privada não encontrada para este contrato.' });
      return;
    }

    const stored = store.readPrivateEvidenceBytes(ev.sha256);
    if (!stored || !stored.verified) {
      res.status(404).json({
        error: 'Binário original da evidência privada ausente ou falhou na verificação SHA-256.',
      });
      return;
    }

    const safeFilename = ev.exportFilename.replace(/["\r\n]/g, '_');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', ev.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('X-Nexofis-Sha256', ev.sha256);
    res.setHeader('X-Nexofis-Sha256-Verified', 'true');
    res.send(stored.bytes);
  }
);

app.put(
  '/api/contracts/:id/investigation/facts',
  requireStrictInvestigationAuth,
  (req: AuthenticatedRequest, res) => {
    const contractId = String(req.params.id);
    const contract = contractStore.get(contractId);
    if (!contract) {
      res.status(404).json({ error: 'Contrato não encontrado.' });
      return;
    }

    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      res.status(400).json({
        error: 'Informe expectedVersion (inteiro positivo) para controle de concorrência otimista.',
      });
      return;
    }

    const validation = validateFactSetPayload(req.body?.facts);
    if (!validation.valid || !validation.sanitized) {
      res.status(400).json({
        error: validation.error ?? 'Conjunto de fatos inválido.',
      });
      return;
    }

    const actor = deriveStrictInvestigationActor(req);
    try {
      const updated = store.saveInvestigationFactSet(
        contractId,
        expectedVersion,
        validation.sanitized,
        actor
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json(buildInvestigationCaseResponse(contract, updated));
    } catch (err) {
      if (err instanceof InvestigationVersionConflictError) {
        res.status(409).json({
          error: err.message,
          expectedVersion: err.expectedVersion,
          currentVersion: err.currentVersion,
        });
        return;
      }
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Erro ao atualizar fatos da investigação.',
      });
    }
  }
);

app.post(
  '/api/contracts/:id/investigation/reviews',
  requireStrictInvestigationAuth,
  (req: AuthenticatedRequest, res) => {
    const contractId = String(req.params.id);
    const contract = contractStore.get(contractId);
    if (!contract) {
      res.status(404).json({ error: 'Contrato não encontrado.' });
      return;
    }

    const findingId = String(req.body?.findingId ?? '').trim();
    const action = String(req.body?.action ?? '').trim() as InvestigationReviewAction;
    const rationale = String(req.body?.rationale ?? '').trim();

    if (action !== 'dismiss' && action !== 'confirm' && action !== 'restore') {
      res.status(400).json({
        error: 'Ação inválida. Utilize "confirm", "dismiss" ou "restore".',
      });
      return;
    }
    if (rationale.length < 5) {
      res.status(400).json({
        error: 'Justificativa técnica obrigatória (mínimo de 5 caracteres).',
      });
      return;
    }

    const actor = deriveStrictInvestigationActor(req);
    const currentCase = store.getOrCreateInvestigationCase(contractId, actor);
    const currentEval = evaluateForensicInvestigation({
      contract: buildInvestigationContractInput(contract),
      factSet: currentCase.factSet,
      cadastralExtracts: currentCase.cadastralExtracts,
      observedHistory: currentCase.observedHistory,
      privateEvidence: currentCase.privateEvidence,
      reviews: currentCase.reviews,
    });

    const matchedFinding = currentEval.findings.find((f) => f.findingId === findingId);
    if (!matchedFinding) {
      res.status(404).json({
        error: `Apontamento "${findingId}" não encontrado na versão atual dos fatos (v${currentCase.factSet.version}).`,
      });
      return;
    }

    // F08 + Section 1 Hardening: Human reviews MUST supply expectedFactsVersion or expectedFindingInputsDigest
    // so stale/obsolete reviews can never be silently accepted.
    const expectedFactsVersionRaw = req.body?.expectedFactsVersion;
    const hasExpectedFactsVersion =
      expectedFactsVersionRaw !== undefined &&
      expectedFactsVersionRaw !== null &&
      String(expectedFactsVersionRaw).trim() !== '';
    const expectedFindingInputsDigest =
      typeof req.body?.expectedFindingInputsDigest === 'string'
        ? req.body.expectedFindingInputsDigest.trim()
        : '';

    if (!hasExpectedFactsVersion && !expectedFindingInputsDigest) {
      res.status(400).json({
        error:
          'A revisão humana exige informar a versão dos fatos (expectedFactsVersion) ou o digest dos insumos do apontamento (expectedFindingInputsDigest) analisado.',
        currentVersion: currentCase.factSet.version,
        currentFindingInputsDigest: matchedFinding.inputsDigest,
      });
      return;
    }

    if (
      hasExpectedFactsVersion &&
      Number(expectedFactsVersionRaw) !== currentCase.factSet.version
    ) {
      res.status(409).json({
        error: `A versão dos fatos foi alterada antes do envio da revisão (esperada v${expectedFactsVersionRaw}, atual v${currentCase.factSet.version}). Revisão obsoleta rejeitada.`,
        expectedVersion: Number(expectedFactsVersionRaw),
        currentVersion: currentCase.factSet.version,
        currentFindingInputsDigest: matchedFinding.inputsDigest,
      });
      return;
    }

    if (
      expectedFindingInputsDigest &&
      expectedFindingInputsDigest !== matchedFinding.inputsDigest
    ) {
      res.status(409).json({
        error:
          'Os insumos do apontamento mudaram desde que você abriu o formulário de revisão. Revisão obsoleta rejeitada.',
        expectedFindingInputsDigest,
        currentFindingInputsDigest: matchedFinding.inputsDigest,
        currentVersion: currentCase.factSet.version,
      });
      return;
    }

    const saved = store.addInvestigationReview(
      {
        contractId,
        findingId: matchedFinding.findingId,
        action,
        rationale: rationale.slice(0, 2000),
        factsVersion: currentCase.factSet.version,
        findingInputsDigest: matchedFinding.inputsDigest,
        actorId: actor.actorId,
        actorName: actor.actorName,
        actorRole: actor.actorRole,
      },
      actor
    );

    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({
      review: saved.review,
      investigation: buildInvestigationCaseResponse(contract, saved.investigation),
    });
  }
);

app.get(
  '/api/contracts/:id/investigation/export',
  requireStrictInvestigationAuth,
  (req: AuthenticatedRequest, res) => {
    const contractId = String(req.params.id);
    const contract = contractStore.get(contractId);
    if (!contract) {
      res.status(404).json({ error: 'Contrato não encontrado.' });
      return;
    }

    const actor = deriveStrictInvestigationActor(req);
    const storedCase = store.getOrCreateInvestigationCase(contractId, actor);
    const payload = buildInvestigationCaseResponse(contract, storedCase);
    const pkg = buildInvestigationExportPackage({
      contractSnapshot: payload.contractSummary,
      factSet: payload.factSet,
      cadastralExtracts: payload.cadastralExtracts,
      observedHistory: payload.observedHistory,
      privateEvidence: payload.privateEvidence,
      reviews: payload.reviews,
      events: payload.events,
      evaluation: payload.evaluation,
    });

    const safeId = contractId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="nexofis-investigacao-${safeId}.json"`
    );
    res.json(pkg);
  }
);

// ==========================================
// API ROUTES — DOCUMENT UPLOAD, ORIGINAL ARTIFACT RETRIEVAL & OCR (A07, A10, A11)
// ==========================================

app.get('/api/documents/:sha256/original', (req, res) => {
  const sha256 = String(req.params.sha256 ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    res.status(400).json({ error: 'SHA-256 inválido.' });
    return;
  }

  const artifact = store.getDocumentArtifactBySha256(sha256);
  const stored = store.readOriginalDocumentBytes(sha256);
  if (!stored || !stored.verified) {
    res.status(404).json({
      error: 'Objeto binário original não localizado ou falhou na verificação de integridade SHA-256.',
    });
    return;
  }

  const filename = (artifact?.filename ?? `${sha256.slice(0, 16)}.bin`).replace(/["\r\n]/g, '_');
  res.setHeader('Content-Type', artifact?.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Nexofis-Sha256', sha256);
  res.setHeader('X-Nexofis-Sha256-Verified', 'true');
  res.send(stored.bytes);
});

app.post(
  '/api/documents/upload',
  requireAnalystAuth,
  upload.single('file'),
  async (req: AuthenticatedRequest, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'Nenhum arquivo enviado no campo "file".' });
      return;
    }

    const ext = path.extname(file.originalname).toLowerCase();
    const detectedMime =
      file.mimetype && file.mimetype !== 'application/octet-stream'
        ? file.mimetype
        : ext === '.pdf'
          ? 'application/pdf'
          : ext === '.png'
            ? 'image/png'
            : ext === '.jpg' || ext === '.jpeg'
              ? 'image/jpeg'
              : ext === '.webp'
                ? 'image/webp'
                : ext === '.tif' || ext === '.tiff'
                  ? 'image/tiff'
                  : ext === '.csv'
                    ? 'text/csv'
                    : 'text/plain';
    const magicCheck = validateUploadedFileMagic(file.buffer, detectedMime);
    if (!magicCheck.valid) {
      res.status(400).json({ error: magicCheck.reason ?? 'Arquivo rejeitado na validação binária.' });
      return;
    }
    const validation = { valid: true, detectedMime };

    const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const forceOcr =
      String(req.body?.forceOcr ?? '').toLowerCase() === 'true' ||
      String(req.query.forceOcr ?? '').toLowerCase() === 'true';

    // Persist exact original raw bytes BEFORE any parsing/OCR (A07)
    const objectWrite = store.saveOriginalDocumentBytes(sha256, file.buffer);
    const originalDownloadUrl = `/api/documents/${sha256}/original`;

    // Track ingestion in durable SQLite job queue
    const workerId = `api-${process.pid}`;
    const { job } = jobQueue.enqueue({
      jobType: 'document_ingestion',
      idempotencyKey: `doc:${sha256}:${Date.now()}`,
      payload: {
        filename: file.originalname,
        mimeType: validation.detectedMime,
        sizeBytes: file.size,
        sha256,
        forceOcr,
      },
      maxAttempts: 1,
    });
    const claimed = jobQueue.claimNext(workerId, 120);
    const activeJobId = claimed?.id ?? job.id;

    try {
      const ocrResult = await runEfficientOcrPipeline({
        buffer: file.buffer,
        filename: file.originalname,
        mimeType: validation.detectedMime,
        forceOcr,
      });

      // A11: Hard anti-zip-bomb / decompression budget rejection
      if (ocrResult.status === 'budget_exceeded') {
        if (claimed) {
          jobQueue.fail(
            activeJobId,
            workerId,
            new Error(ocrResult.telemetry.budgetReason ?? 'Orçamento de descompressão excedido')
          );
        }
        res.status(422).json({
          error:
            ocrResult.telemetry.budgetReason ??
            'Arquivo PDF rejeitado pelo limite seguro de descompressão/páginas (proteção anti zip-bomb).',
          budgetExceeded: true,
          sha256,
          originalObjectStored: objectWrite.verified,
          originalDownloadUrl,
          ocrTelemetry: ocrResult.telemetry,
          pipelineSteps: ocrResult.steps,
        });
        return;
      }

      const pipelineSteps = [...ocrResult.steps];
      let extractedText = ocrResult.text;
      let extractionMethod: ExtractionMethod = ocrResult.extractionMethod;
      let extractorVersion = ocrResult.telemetry.extractorVersion;
      let confidence = ocrResult.confidence;
      let originalPageCount = ocrResult.telemetry.originalPageCount;
      let processedPageCount = ocrResult.telemetry.processedPageCount;
      let truncated = ocrResult.telemetry.truncated;
      let multimodalPages = 0;

      let pages: DocumentPage[] = ocrResult.pages.map((p) => ({
        pageNumber: p.pageNumber,
        extractionMethod: p.method,
        text: p.text,
        confidence: p.confidence,
        highlights: [],
      }));

      // Tier 2: Optional Gemini multimodal fallback ONLY when external OCR is unavailable AND GEMINI_API_KEY is set.
      // A10: NEVER attribute Gemini multimodal output as 'docling' or 'paddleocr'!
      if (ocrResult.status === 'needs_external_ocr') {
        const geminiKey = process.env.GEMINI_API_KEY?.trim();
        if (!geminiKey) {
          if (claimed) {
            jobQueue.fail(
              activeJobId,
              workerId,
              new Error('OCR externo indisponível para documento digitalizado/imagem.')
            );
          }
          res.status(422).json({
            error:
              'Documento digitalizado ou imagem requer serviço OCR (Docling Serve ou PaddleOCR Worker) ou GEMINI_API_KEY configurada. O arquivo original foi preservado com SHA-256 verificado, mas não foi possível extrair texto sem inventar dados.',
            needsExternalOcr: true,
            sha256,
            originalObjectStored: objectWrite.verified,
            originalDownloadUrl,
            ocrTelemetry: ocrResult.telemetry,
            pipelineSteps,
          });
          return;
        }

        const ai = new GoogleGenAI({ apiKey: geminiKey });
        const b64 = file.buffer.toString('base64');
        const geminiRes = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType: validation.detectedMime,
                    data: b64,
                  },
                },
                {
                  text: 'Transcreva fielmente todo o texto legível deste documento público brasileiro (contrato, aditivo, nota fiscal ou relação de contratos), preservando números de contrato, CNPJs, datas, valores monetários e nomes exatamente como constam na imagem/PDF. Não invente nem complete campos ilegíveis.',
                },
              ],
            },
          ],
        });

        const multimodalText = (geminiRes.text ?? '').trim();
        if (!multimodalText) {
          if (claimed) {
            jobQueue.fail(activeJobId, workerId, new Error('Extrator multimodal retornou texto vazio.'));
          }
          res.status(422).json({
            error: 'Não foi possível extrair texto legível do documento enviado.',
            sha256,
            originalObjectStored: objectWrite.verified,
            originalDownloadUrl,
            pipelineSteps,
          });
          return;
        }

        extractedText = multimodalText;
        extractionMethod = 'multimodal';
        extractorVersion = 'gemini-multimodal-parser-1.0';
        confidence = 0.84;
        processedPageCount = Math.max(1, originalPageCount);
        multimodalPages = processedPageCount;
        pages = [
          {
            pageNumber: 1,
            extractionMethod: 'multimodal',
            text: extractedText,
            confidence,
            highlights: [],
          },
        ];
        pipelineSteps.push({
          stage: 'Extração Multimodal (Gemini Fallback)',
          status: 'ok',
          detail: `Texto transcrito via gemini-multimodal-parser-1.0 (${extractedText.length} caracteres). Atribuição explícita como método multimodal.`,
        });
      }

      const extracted = extractFieldsFromNativeText(extractedText, extractionMethod);
      const tabularRows = extractTabularContractRows(extractedText);

      // Attach highlights to page 1 (or matching page)
      if (pages.length === 0) {
        pages = [
          {
            pageNumber: 1,
            extractionMethod,
            text: extractedText,
            confidence,
            highlights: [],
          },
        ];
      }
      pages[0] = {
        ...pages[0],
        highlights: extracted.excerpts.map((ex) => ({
          field: ex.field,
          excerpt: ex.excerpt,
          normalizedValue: ex.normalizedValue,
        })),
      };

      const retrievedAt = new Date().toISOString();
      const nativePages = pages.filter((p) => p.extractionMethod === 'native').length;
      const doclingPages = pages.filter((p) => p.extractionMethod === 'docling').length;
      const ocrPages = pages.filter((p) => p.extractionMethod === 'paddleocr').length;

      const uploadedDoc: DocumentRecord = {
        id: `DOC-UPL-${sha256.slice(0, 12)}`,
        title: file.originalname,
        documentType: extractedText.toLowerCase().includes('aditivo')
          ? 'Termo Aditivo'
          : extractedText.toLowerCase().includes('empenho')
            ? 'Nota de Empenho'
            : 'Documento Importado',
        sourceUrl: originalDownloadUrl,
        sourceSystem: 'Upload Documental (NEXOFIS)',
        retrievedAt,
        sha256,
        mimeType: validation.detectedMime,
        sizeBytes: file.size,
        originalObjectStored: objectWrite.verified,
        originalDownloadUrl,
        extractionSummary: {
          totalPages: pages.length,
          originalPageCount,
          processedPageCount,
          truncated,
          budgetExceeded: false,
          nativePages,
          doclingPages,
          ocrPages,
          multimodalPages,
          extractorVersion,
        },
        pages,
      };

      const existingArtifact = store.getDocumentArtifactBySha256(sha256);
      const existingContracts = getAllContracts();
      const match = resolveDocumentContractMatch(extracted, existingContracts);

      let targetContract: ContractRecord;
      if (match.status === 'matched' && match.contract && contractStore.has(match.contract.id)) {
        const existing = contractStore.get(match.contract.id)!;
        const alreadyAttached = existing.documents.some((d) => d.sha256 === sha256);
        targetContract = {
          ...existing,
          documents: alreadyAttached ? existing.documents : [uploadedDoc, ...existing.documents],
        };
        persistContract(targetContract);
        pipelineSteps.push({
          stage: 'Vinculação Exata / Composta',
          status: 'ok',
          detail: `Documento vinculado ao contrato existente ${existing.contractNumber} (${match.matchRule}).`,
        });
      } else {
        const yearMatch =
          extracted.signatureDate?.slice(0, 4) ??
          extracted.contractNumber?.match(/\/(20\d{2})/)?.[1] ??
          String(new Date().getFullYear());
        const parsedYear = Number.parseInt(yearMatch, 10) || new Date().getFullYear();
        const contractNum = extracted.contractNumber ?? `DOC-${sha256.slice(0, 8).toUpperCase()}`;
        const val = extracted.updatedValue ?? extracted.originalValue ?? 0;

        // A02: Zero fabricated fields on unmatched document ingestion
        targetContract = {
          id: `DOC-CONT-${sha256.slice(0, 12)}`,
          pncpControlNumber: '',
          contractNumber: contractNum,
          year: parsedYear,
          municipalityIbge: extracted.ibgeCode ?? '',
          municipalityName: extracted.municipalityName ?? 'Município não identificado no documento',
          uf: '',
          entityId: `ENT-DOC-${sha256.slice(0, 8)}`,
          entityName: extracted.entityName ?? 'Órgão não identificado no documento',
          modality: 'Não informada',
          biddersCount: null, // A02: nunca inventar 1 licitante
          object:
            extracted.object ??
            `Documento analisado (${file.originalname}) — objeto não delimitado automaticamente.`,
          objectCategory: 'Documento Auditado',
          expectedCnaePrefixes: [],
          signatureDate: extracted.signatureDate ?? '',
          startDate: extracted.signatureDate ?? '',
          endDate: '',
          originalValue: extracted.originalValue ?? val,
          updatedValue: val,
          status: 'Vigente',
          supplier: {
            cnpj: extracted.cnpj ?? '',
            legalName: extracted.supplierName ?? 'Fornecedor não identificado no documento',
            openingDate: '', // A02: nunca fabricar 2020-01-01
            registrationStatus: 'DESCONHECIDA', // A02: nunca presumir ATIVA
            primaryCnaeCode: '',
            primaryCnaeDescription: 'Não consultado',
            secondaryCnaes: [],
            shareCapital: 0,
            municipality: '',
            uf: '',
            shareholders: [],
            sanctions: [],
            priorMunicipalContracts: 0,
            simultaneousActiveContracts: 1,
            dataProvenance: 'Upload Documental (NEXOFIS)',
          },
          items:
            val > 0
              ? [
                  {
                    id: 'ITEM-DOC-1',
                    itemNumber: 1,
                    description: extracted.object ?? file.originalname,
                    unit: 'UN',
                    quantity: 1,
                    unitPrice: val,
                    totalPrice: val,
                    referencePrice: 0,
                    referenceSource: 'Sem Referência',
                    referenceDate: extracted.signatureDate ?? '',
                  },
                ]
              : [],
          amendments: [],
          payments: [],
          sourceRecords: [
            {
              id: `SRC-DOC-${sha256.slice(0, 10)}`,
              sourceSystem: 'PDF Importado',
              externalId: sha256.slice(0, 16),
              retrievedAt,
              rawPayloadHash: sha256,
              parserVersion: extractorVersion,
              reportedOriginalValue: extracted.originalValue ?? val,
              reportedUpdatedValue: val,
              reportedSupplierCnpj: extracted.cnpj ?? '',
              reportedStatus: 'Importado',
              reportedEndDate: '',
              sourceUrl: originalDownloadUrl,
            },
          ],
          documents: [uploadedDoc],
          pncpVerification: {
            queried: false,
            status: 'not_queried',
            coverageNote:
              'Documento importado localmente sem consulta ao PNCP; ausência no PNCP não foi verificada.',
          },
          fieldProvenance: {
            signatureDate: extracted.signatureDate ? 'document_extracted' : 'unknown',
            endDate: 'unknown',
            biddersCount: 'unknown',
            modality: 'unknown',
            supplierOpeningDate: 'unknown',
            supplierRegistrationStatus: 'unknown',
          },
          dataSourceOrigin: 'Upload Documental',
        };
        persistContract(targetContract);
        pipelineSteps.push({
          stage: 'Criação de Dossiê Documental',
          status: 'ok',
          detail: `Novo registro ${targetContract.contractNumber} criado preservando ausência de campos não encontrados.`,
        });
      }

      // Record FULL document artifact + pages in SQLite (A07: zero 1400-char truncation)
      store.recordDocumentArtifact({
        sha256,
        filename: file.originalname,
        mimeType: validation.detectedMime,
        sizeBytes: file.size,
        contractId: targetContract.id,
        extractorVersion,
        pageCount: pages.length,
        originalPageCount,
        truncated,
        objectKey: objectWrite.objectKey,
        fullText: extractedText,
        pages,
        createdAt: retrievedAt,
      });

      const editalChannelAudit = auditEditalCommunicationChannels(extractedText, {
        procurementId: targetContract.contractNumber || uploadedDoc.id,
        ocrQualityScore: confidence,
      });

      pipelineSteps.push({
        stage: 'Auditoria de Canais de Contato e Participação (Lei 14.133/2021 · LAI · PNTP)',
        status: editalChannelAudit.status === 'CONFORME' ? 'ok' : 'fallback',
        detail: `${editalChannelAudit.status} · E-mails: ${editalChannelAudit.emailsFound.length} · Telefones: ${editalChannelAudit.phonesFound.length} · Plataformas: ${editalChannelAudit.platformsFound.length}`,
      });

      const evaluated = evaluateWithContext(targetContract);

      if (claimed) {
        jobQueue.complete(activeJobId, workerId, {
          contractId: targetContract.id,
          sha256,
          extractionMethod,
          extractorVersion,
          pageCount: pages.length,
        });
      }

      res.status(201).json({
        jobId: activeJobId,
        sha256,
        idempotentDuplicate: Boolean(existingArtifact),
        originalObjectStored: objectWrite.verified,
        originalDownloadUrl,
        matchedPncp: Boolean(targetContract.pncpControlNumber),
        matchStatus: match.status,
        ambiguousCandidates:
          match.status === 'ambiguous'
            ? (match.candidates ?? []).map((c) => ({
                id: c.id,
                contractNumber: c.contractNumber,
                pncpControlNumber: c.pncpControlNumber,
                municipalityIbge: c.municipalityIbge,
                municipalityName: c.municipalityName,
                supplierCnpj: c.supplierCnpj,
                supplierName: c.supplierName,
              }))
            : undefined,
        extraction: extracted,
        editalChannelAudit,
        ocrTelemetry: ocrResult.telemetry,
        tabularRowsCount: tabularRows.length,
        pipelineSteps,
        contract: evaluated,
      });
    } catch (err) {
      if (claimed) {
        jobQueue.fail(activeJobId, workerId, err);
      }
      res.status(500).json({
        error: `Falha no processamento do documento: ${err instanceof Error ? err.message : 'erro interno'}`,
        sha256,
        originalDownloadUrl,
      });
    }
  }
);

// ==========================================
// API ROUTES — SAVED DOSSIERS (A06: Full Immutable Reproducible Snapshots)
// ==========================================

app.get('/api/dossiers', (_req, res) => {
  res.json({ dossiers: store.listDossiers() });
});

app.get('/api/dossiers/:id', (req, res) => {
  const id = String(req.params.id);
  const snapshot = store.getDossierById(id);
  if (!snapshot) {
    res.status(404).json({ error: 'Dossiê arquivado não encontrado.' });
    return;
  }
  res.json({ dossier: snapshot });
});

app.post('/api/dossiers', requireAnalystAuth, (req: AuthenticatedRequest, res) => {
  const contractId = String(req.body?.contractId ?? '').trim();
  const analystNote = String(req.body?.analystNote ?? '').trim().slice(0, 2000);
  const contract = contractStore.get(contractId);

  if (!contract) {
    res.status(404).json({ error: 'Contrato não encontrado para arquivamento de dossiê.' });
    return;
  }

  const evaluated = evaluateWithContext(contract);
  const reviews = store.listFindingReviews(contract.id);
  const savedAt = new Date().toISOString();

  // Compute canonical SHA-256 over the full reproducible snapshot payload
  const canonicalPayload = JSON.stringify({
    contract: evaluated,
    reviews,
    analystNote,
    engineVersion: evaluated.assessment.engineVersion,
  });
  const sha256Digest = crypto.createHash('sha256').update(canonicalPayload).digest('hex');

  const summary: SavedDossierSummary = {
    id: `DOS-${Date.now()}-${sha256Digest.slice(0, 6)}`,
    contractId: evaluated.id,
    contractNumber: evaluated.contractNumber,
    municipalityName: evaluated.municipalityName,
    municipalityIbge: evaluated.municipalityIbge,
    entityName: evaluated.entityName,
    supplierName: evaluated.supplier.legalName,
    riskScore: evaluated.assessment.score,
    savedAt,
    analystNote,
    sha256Digest,
    hasSnapshot: true,
  };

  const dossiers = store.saveDossier(summary, { contract: evaluated, reviews });
  res.status(201).json({ dossier: summary, dossiers });
});

app.delete('/api/dossiers/:id', requireAnalystAuth, (req, res) => {
  const deleted = store.deleteDossier(String(req.params.id));
  if (!deleted) {
    res.status(404).json({ error: 'Dossiê não encontrado.' });
    return;
  }
  res.json({ deleted: true, dossiers: store.listDossiers() });
});

// ==========================================
// API ROUTES — RISK DASHBOARD (A02: Explicit Unverifiable Bucket via aggregateRiskDashboard)
// ==========================================

function handleRiskDashboardSummary(req: express.Request, res: express.Response) {
  const startDate = String(req.query.startDate ?? req.query.dateFrom ?? '').trim() || undefined;
  const endDate = String(req.query.endDate ?? req.query.dateTo ?? '').trim() || undefined;
  const periodCheck = validateDatePeriod(startDate, endDate);
  if (!periodCheck.valid) {
    res.status(400).json({ error: periodCheck.error });
    return;
  }

  const storedContracts = store.getAllStoredContracts();
  const filtered = storedContracts.filter((c) =>
    matchesDatePeriod(c.signatureDate || c.startDate, { startDate, endDate })
  );
  const evaluated = filtered
    .map((c) => evaluateWithContext(c))
    .sort((a, b) => b.assessment.score - a.assessment.score);

  const summary = aggregateRiskDashboard(evaluated);

  res.json({
    storageEngine: 'SQLite (node:sqlite WAL)',
    totalStoredInSqlite: storedContracts.length,
    summary,
    contracts: evaluated,
  });
}

app.get('/api/dashboard/risk-summary', handleRiskDashboardSummary);
app.get('/api/dashboard/risks', handleRiskDashboardSummary);

// ==========================================
// API ROUTES — INVESTIGATIVE EVOLUTION (Sections 3–7: Integrity Trails, Outcomes, SINAPI/SIAPS/Camara Importers, Participation & Observability)
// ==========================================

app.post(
  '/api/investigative/public-integrity/evaluate',
  requireStrictInvestigationAuth,
  (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kinships = Array.isArray(body.kinships) ? body.kinships : [];
    const appointments = Array.isArray(body.appointments) ? body.appointments : [];
    const reciprocityHypotheses = Array.isArray(body.reciprocityHypotheses)
      ? body.reciprocityHypotheses
      : [];
    const contractConflicts = Array.isArray(body.contractConflicts)
      ? body.contractConflicts
      : [];
    const roleRequirementCheck = body.roleRequirementCheck as
      | Parameters<typeof evaluateRoleLegalRequirementsTrail>[0]
      | undefined;

    res.json({
      kinshipTrail: evaluateDocumentedKinshipTrail(
        kinships as Parameters<typeof evaluateDocumentedKinshipTrail>[0]
      ),
      appointmentNepotismTrail: evaluateAppointmentNepotismTrail({
        appointments: appointments as Parameters<typeof evaluateAppointmentNepotismTrail>[0]['appointments'],
        documentedKinships: kinships as Parameters<typeof evaluateAppointmentNepotismTrail>[0]['documentedKinships'],
        reciprocityHypotheses: reciprocityHypotheses as Parameters<
          typeof evaluateAppointmentNepotismTrail
        >[0]['reciprocityHypotheses'],
        applicableLegalBasis:
          typeof body.applicableLegalBasis === 'string' ? body.applicableLegalBasis : null,
        jurisdiction: typeof body.jurisdiction === 'string' ? body.jurisdiction : null,
        referenceDate: typeof body.referenceDate === 'string' ? body.referenceDate : null,
      }),
      contractConflictTrail: evaluateContractConflictTrail(
        contractConflicts as Parameters<typeof evaluateContractConflictTrail>[0]
      ),
      roleLegalRequirementsTrail: roleRequirementCheck
        ? evaluateRoleLegalRequirementsTrail(roleRequirementCheck)
        : null,
    });
  }
);

app.post(
  '/api/investigative/outcomes/evaluate',
  requireStrictInvestigationAuth,
  (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!body.claim || !body.definition || !Array.isArray(body.observations)) {
      res.status(400).json({
        error: 'Informe claim, definition e observations para avaliar compromissos contratuais.',
      });
      return;
    }
    const evaluationDate =
      typeof body.evaluationDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.evaluationDate)
        ? body.evaluationDate
        : new Date().toISOString().slice(0, 10);

    const run = evaluateOutcomeClaim({
      claim: body.claim as Parameters<typeof evaluateOutcomeClaim>[0]['claim'],
      definition: body.definition as Parameters<typeof evaluateOutcomeClaim>[0]['definition'],
      observations: body.observations as Parameters<typeof evaluateOutcomeClaim>[0]['observations'],
      evaluationDate,
      didDesign: body.didDesign as Parameters<typeof evaluateOutcomeClaim>[0]['didDesign'],
    });

    const siconfi =
      body.siconfi && typeof body.siconfi === 'object'
        ? reconcileSiconfiExecution(
            body.siconfi as Parameters<typeof reconcileSiconfiExecution>[0]
          )
        : null;

    res.json({ evaluationRun: run, siconfiReconciliation: siconfi });
  }
);

app.post(
  '/api/investigative/prices/evaluate',
  requireStrictInvestigationAuth,
  (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!body.subjectProfile || !Array.isArray(body.peers)) {
      res.status(400).json({
        error: 'Informe subjectProfile e peers para validação de comparabilidade de preços.',
      });
      return;
    }
    const result = evaluateInvestigativePriceComparison(
      body as unknown as Parameters<typeof evaluateInvestigativePriceComparison>[0]
    );
    res.json(result);
  }
);

app.post(
  '/api/investigative/participation/evaluate',
  requireStrictInvestigationAuth,
  (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!body.procurementId || !body.proposalSubmissionChannel) {
      res.status(400).json({
        error: 'Informe procurementId e proposalSubmissionChannel para avaliar canais de participação.',
      });
      return;
    }
    const evaluation = evaluateParticipationChannels(
      body as unknown as Parameters<typeof evaluateParticipationChannels>[0]
    );
    res.json(evaluation);
  }
);

app.post(
  '/api/investigative/importers/siaps',
  requireStrictInvestigationAuth,
  (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as {
      rawCsv?: string;
      filename?: string;
      defaultMethodologyVersion?: string;
    };
    if (typeof body.rawCsv !== 'string' || body.rawCsv.trim().length < 5) {
      res.status(400).json({ error: 'Conteúdo CSV/TSV da exportação pública SIAPS ausente.' });
      return;
    }
    const imported = importSiapsPublicExport({
      rawCsv: body.rawCsv,
      filename: String(body.filename || 'siaps-export.csv').slice(0, 120),
      defaultMethodologyVersion: String(body.defaultMethodologyVersion || 'siaps-v1'),
    });
    const actor = deriveStrictInvestigationActor(req);
    const saved = store.saveOfficialSnapshot({
      id: `snap_siaps_${imported.fileSha256.slice(0, 16)}`,
      sourceKind: 'siaps',
      filename: imported.filename,
      sha256: imported.fileSha256,
      competencia: imported.observations[0]?.competencia ?? 'multi',
      uf: null,
      metadataJson: JSON.stringify({
        rowCount: imported.rowCount,
        unpublishedCount: imported.unpublishedCount,
        sourceSystem: imported.sourceSystem,
      }),
      payloadJson: JSON.stringify(imported.observations),
      importedBy: actor.actorName,
    });
    res.status(saved.alreadyExisted ? 200 : 201).json({ ...imported, snapshot: saved });
  }
);

app.post(
  '/api/investigative/importers/sinapi',
  requireStrictInvestigationAuth,
  (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as {
      rawCsv?: string;
      filename?: string;
      uf?: string;
      competencia?: string;
      edition?: string;
      taxRegime?: 'desonerado' | 'nao_desonerado';
      defaultKind?: 'insumo' | 'composicao';
      isRectification?: boolean;
      rectificationNote?: string;
    };
    if (typeof body.rawCsv !== 'string' || body.rawCsv.trim().length < 5 || !body.uf || !body.competencia) {
      res.status(400).json({
        error: 'Informe rawCsv, uf e competencia da tabela oficial SINAPI.',
      });
      return;
    }
    const imported = importSinapiOfficialFile({
      rawBuffer: body.rawCsv,
      filename: String(body.filename || 'sinapi-oficial.csv').slice(0, 120),
      uf: body.uf,
      competencia: body.competencia,
      edition: String(body.edition || body.competencia),
      taxRegime: body.taxRegime === 'desonerado' ? 'desonerado' : 'nao_desonerado',
      defaultKind: body.defaultKind === 'composicao' ? 'composicao' : 'insumo',
      isRectification: Boolean(body.isRectification),
      rectificationNote: body.rectificationNote,
    });
    const actor = deriveStrictInvestigationActor(req);
    const saved = store.saveOfficialSnapshot({
      id: `snap_sinapi_${imported.originalFileSha256.slice(0, 16)}`,
      sourceKind: 'sinapi',
      filename: imported.filename,
      sha256: imported.originalFileSha256,
      competencia: imported.competencia,
      uf: imported.uf,
      metadataJson: JSON.stringify({
        edition: imported.edition,
        taxRegime: imported.taxRegime,
        isRectification: imported.isRectification,
        itemCount: imported.itemCount,
      }),
      payloadJson: JSON.stringify(imported.items),
      importedBy: actor.actorName,
    });
    res.status(saved.alreadyExisted ? 200 : 201).json({ ...imported, snapshot: saved });
  }
);

app.post(
  '/api/investigative/importers/camara-personnel',
  requireStrictInvestigationAuth,
  (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as {
      rawCsv?: string;
      filename?: string;
      snapshotDate?: string;
    };
    if (typeof body.rawCsv !== 'string' || body.rawCsv.trim().length < 5) {
      res.status(400).json({ error: 'Conteúdo CSV do arquivo diário da Câmara ausente.' });
      return;
    }
    const snapshotDate =
      typeof body.snapshotDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.snapshotDate)
        ? body.snapshotDate
        : new Date().toISOString().slice(0, 10);
    const parsed = parseCamaraDailyPersonnelSnapshot({
      rawCsv: body.rawCsv,
      snapshotDate,
    });
    const actor = deriveStrictInvestigationActor(req);
    const saved = store.saveOfficialSnapshot({
      id: `snap_camara_${parsed.sha256.slice(0, 16)}`,
      sourceKind: 'camara_personnel',
      filename: String(body.filename || `camara-funcionarios-${snapshotDate}.csv`).slice(0, 120),
      sha256: parsed.sha256,
      competencia: snapshotDate,
      uf: 'DF',
      metadataJson: JSON.stringify({
        coverageScope: parsed.coverageScope,
        hasHistoricalChanges: parsed.hasHistoricalChanges,
        recordCount: parsed.recordCount,
      }),
      payloadJson: JSON.stringify(parsed.rows),
      importedBy: actor.actorName,
    });
    res.status(saved.alreadyExisted ? 200 : 201).json({ ...parsed, snapshot: saved });
  }
);

app.post(
  '/api/investigative/outcomes/did-evaluate',
  requireStrictInvestigationAuth,
  (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      !body.contractId ||
      !body.indicatorId ||
      typeof body.treatedPreValue !== 'number' ||
      typeof body.treatedPostValue !== 'number' ||
      !Array.isArray(body.controlMunicipalities)
    ) {
      res.status(400).json({
        error:
          'Informe contractId, indicatorId, treatedPreValue, treatedPostValue e controlMunicipalities para cálculo de Diferença-em-Diferenças.',
      });
      return;
    }
    const result = computePairedDidEffect(
      body as unknown as Parameters<typeof computePairedDidEffect>[0]
    );
    res.json(result);
  }
);

app.post(
  '/api/investigative/importers/inep',
  requireStrictInvestigationAuth,
  (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as {
      rawCsv?: string;
      filename?: string;
      defaultMethodologyVersion?: string;
    };
    if (typeof body.rawCsv !== 'string' || body.rawCsv.trim().length < 5) {
      res.status(400).json({ error: 'Conteúdo CSV/TSV da tabela oficial INEP ausente.' });
      return;
    }
    const imported = importInepPublicExport({
      rawCsv: body.rawCsv,
      filename: String(body.filename || 'inep-ideb-saeb.csv').slice(0, 120),
      defaultMethodologyVersion: String(body.defaultMethodologyVersion || 'inep-ideb-v1'),
    });
    const actor = deriveStrictInvestigationActor(req);
    const saved = store.saveOfficialSnapshot({
      id: `snap_inep_${imported.fileSha256.slice(0, 16)}`,
      sourceKind: 'inep',
      filename: imported.filename,
      sha256: imported.fileSha256,
      competencia: imported.observations[0]?.competencia ?? 'multi',
      uf: null,
      metadataJson: JSON.stringify({
        rowCount: imported.rowCount,
        unpublishedCount: imported.unpublishedCount,
        sourceSystem: imported.sourceSystem,
      }),
      payloadJson: JSON.stringify(imported.observations),
      importedBy: actor.actorName,
    });
    res.status(saved.alreadyExisted ? 200 : 201).json({ ...imported, snapshot: saved });
  }
);

app.post(
  '/api/investigative/participation/audit-edital-text',
  requireStrictInvestigationAuth,
  (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as {
      text?: string;
      procurementId?: string;
      ocrQualityScore?: number | null;
      applicableLegalRule?: string;
      jurisdiction?: string;
    };
    if (typeof body.text !== 'string' || body.text.trim().length < 10) {
      res.status(400).json({ error: 'Texto do edital ausente ou muito curto para auditoria.' });
      return;
    }
    const audit = auditEditalCommunicationChannels(body.text, {
      procurementId: body.procurementId,
      ocrQualityScore: typeof body.ocrQualityScore === 'number' ? body.ocrQualityScore : null,
      applicableLegalRule: body.applicableLegalRule,
      jurisdiction: body.jurisdiction,
    });
    res.json(audit);
  }
);

app.post(
  '/api/investigative/graph/cypher',
  requireViewerOrAbove,
  (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as {
      targetCnpj?: string;
      onlyDocumented?: boolean;
      snapshot?: ForensicGraphSnapshot;
    };

    let snapshot: ForensicGraphSnapshot;
    if (body.snapshot && Array.isArray(body.snapshot.people)) {
      snapshot = body.snapshot;
    } else {
      // Project NEXOFIS's live SQLite QSA + contracts into the Neo4j-compatible forensic graph schema
      const qsaRecords = store.listAllSupplierQsa();
      const contracts = getAllContracts();
      const peopleMap = new Map<string, ForensicGraphSnapshot['people'][number]>();
      const companiesMap = new Map<string, ForensicGraphSnapshot['companies'][number]>();
      const agenciesMap = new Map<string, ForensicGraphSnapshot['agencies'][number]>();
      const contractNodes: ForensicGraphSnapshot['contracts'] = [];
      const shareholderEdges: ForensicGraphSnapshot['shareholderEdges'] = [];

      for (const qsa of qsaRecords) {
        const cleanCnpj = normalizeCnpj(qsa.cnpj);
        if (!cleanCnpj) continue;
        companiesMap.set(cleanCnpj, {
          cnpj: cleanCnpj,
          razaoSocial: qsa.legalName || cleanCnpj,
          capitalSocial: qsa.shareCapital ?? null,
        });
        for (const sh of qsa.shareholders ?? []) {
          const normName = normalizePersonName(sh.name);
          const docKey = sh.maskedDocument ? sh.maskedDocument.replace(/\s+/g, '') : 'SEM_DOC';
          const personId = `person_${normName.replace(/\s+/g, '_').slice(0, 40)}_${docKey}`;
          if (!peopleMap.has(personId)) {
            peopleMap.set(personId, {
              personId,
              nome: sh.name,
              cpfMascarado: sh.maskedDocument ?? null,
              cargoPolitico: null,
              escolaridadeDocumentada: null,
              identityResolved: Boolean(sh.maskedDocument && !sh.maskedDocument.includes('*')),
            });
          }
          shareholderEdges.push({
            personId,
            cnpj: cleanCnpj,
            qualificacao: sh.role || 'Sócio',
            participacaoPct: null,
            assertionState: sh.maskedDocument && !sh.maskedDocument.includes('*') ? 'documented' : 'candidate',
            evidenceRef: `QSA:${qsa.sourceProvider}:${cleanCnpj}`,
          });
        }
      }

      for (const c of contracts) {
        const cleanCnpj = normalizeCnpj(c.supplier?.cnpj ?? '');
        if (!cleanCnpj) continue;
        if (!companiesMap.has(cleanCnpj)) {
          companiesMap.set(cleanCnpj, {
            cnpj: cleanCnpj,
            razaoSocial: c.supplier?.legalName || cleanCnpj,
            capitalSocial: null,
          });
        }
        const orgaoId = `orgao_${c.municipalityIbge || 'BR'}_${normalizeOrganKey(c.entityName || c.municipalityName || 'ORGAO').slice(0, 32)}`;
        if (!agenciesMap.has(orgaoId)) {
          agenciesMap.set(orgaoId, {
            orgaoId,
            nome: c.entityName || c.municipalityName || 'Órgão Público',
            ibge: c.municipalityIbge || null,
          });
        }
        contractNodes.push({
          contratoId: c.id,
          numero: c.contractNumber,
          objeto: c.object,
          valorTotal: c.updatedValue || c.originalValue || 0,
          valorMensal: null,
          ano: c.year || new Date().getFullYear(),
          cnpjFornecedor: cleanCnpj,
          orgaoId,
        });
      }

      snapshot = {
        people: Array.from(peopleMap.values()),
        companies: Array.from(companiesMap.values()),
        agencies: Array.from(agenciesMap.values()),
        offices: [],
        contracts: contractNodes,
        kinshipEdges: [],
        shareholderEdges,
        officeHoldingEdges: [],
      };
    }

    const cypherScript = generateForensicCypherScript(snapshot);
    const kinshipMatches = executeKinshipOfficeContractQuery(snapshot, {
      onlyDocumented: body.onlyDocumented ?? true,
    });
    const cleanTarget = body.targetCnpj ? normalizeCnpj(body.targetCnpj) : '';
    const multiHopMatches = cleanTarget
      ? executeMultiHopCorporateNetworkQuery(snapshot, cleanTarget, {
          onlyDocumented: body.onlyDocumented ?? false,
        })
      : [];

    res.json({
      storageArchitectureNote:
        'Armazenamento primário permanece em SQLite; esta projeção gera script Cypher compatível com Neo4j 5+ e executa as consultas forenses em processo.',
      counts: {
        people: snapshot.people.length,
        companies: snapshot.companies.length,
        agencies: snapshot.agencies.length,
        offices: snapshot.offices.length,
        contracts: snapshot.contracts.length,
      },
      constraints: FORENSIC_GRAPH_CYPHER_CONSTRAINTS,
      queries: FORENSIC_GRAPH_CYPHER_QUERIES,
      cypherScript,
      inProcessResults: {
        kinshipOfficeContractOverlap: kinshipMatches,
        hiddenMultiHopCorporateNetwork: multiHopMatches,
      },
    });
  }
);

app.get('/api/investigative/snapshots', requireViewerOrAbove, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const rawKind = String(req.query.kind ?? '').trim();
  const kind =
    rawKind === 'siaps' || rawKind === 'sinapi' || rawKind === 'camara_personnel' || rawKind === 'inep'
      ? rawKind
      : undefined;
  res.json({ snapshots: store.listOfficialSnapshots(kind) });
});

app.get('/api/observability/metrics', requireViewerOrAbove, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const allContracts = getAllContracts();
  const uniqueSuppliers = new Set(
    allContracts
      .map((c) => normalizeCnpj(c.supplier?.cnpj ?? ''))
      .filter((c) => isCnpjFormat(c) && isValidCnpj(c))
  );
  res.json(
    observability.getSnapshot({
      engineVersion: INVESTIGATION_ENGINE_VERSION,
      schemaVersion: store.getSchemaVersion(),
      queueDepth:
        jobQueue.listByStatus('queued', 50).length + jobQueue.listByStatus('processing', 50).length,
      indexedSuppliers: uniqueSuppliers.size,
      indexedQsa: store.listAllSupplierQsa().length,
    })
  );
});

// Ensure unmatched /api/* routes ALWAYS return JSON 404 (never SPA HTML fallback!)
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Endpoint de API não encontrado.' });
});

// Global Express JSON error handler for /api/* (prevents HTML error pages on unexpected exceptions)
app.use(
  '/api',
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const message = err instanceof Error ? err.message : 'Erro interno inesperado na API.';
    console.error('[NEXOFIS] Erro não tratado em /api:', sanitizeLogPayload({ message }));
    if (res.headersSent) return;
    res.status(500).json({
      error: 'Erro interno na API do NEXOFIS. Tente novamente ou verifique os parâmetros enviados.',
    });
  }
);

// ==========================================
// SERVER BOOTSTRAP (Vite Dev Middleware or Static Production Build)
// ==========================================

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const vite = await createViteServer({
      configFile: path.resolve(process.cwd(), 'vite.config.ts'),
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[NEXOFIS] Servidor ativo em http://0.0.0.0:${PORT} (env=${process.env.NODE_ENV ?? 'development'}, db=${store.dbPath}, auth=${isAuthEnforced() ? 'enforced' : 'local'})`
    );
  });
}

startServer().catch((err) => {
  console.error('[NEXOFIS] Falha fatal na inicialização:', err);
  process.exit(1);
});

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
} from './src/lib/cnpj';
import {
  matchesContractLifecycleFilter,
  normalizeLifecycleFilterParam,
} from './src/lib/contractStatus';
import { aggregateRiskDashboard } from './src/lib/dashboardAggregator';
import {
  matchesDatePeriod,
  resolvePncpPeriodBounds,
  validateDatePeriod,
} from './src/lib/datePeriod';
import {
  extractFieldsFromNativeText,
  extractTabularContractRows,
  resolveDocumentContractMatch,
  validateUploadedFileMagic,
} from './src/lib/documentParser';
import { filterAndRankMunicipalities } from './src/lib/municipalitySearch';
import { mapContractToOCDS } from './src/lib/ocdsMapper';
import {
  isRelatedContractNumber,
  parseBrazilianContractCode,
  parsePncpUrlFromQuery,
} from './src/lib/pncpQueryParser';
import { evaluateContractRisk } from './src/lib/riskEngine';
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
} from './src/server/authMiddleware';
import {
  queryCguSanctionsByCnpj,
  querySiconfiRreo,
} from './src/server/connectors/portalTransparenciaClient';
import { checkExternalOcrHealth } from './src/server/doclingClient';
import { createDurableJobQueue } from './src/server/jobQueue';
import { runEfficientOcrPipeline } from './src/server/ocrEngine';
import { fetchPncpContractsByCnpj } from './src/server/pncpClient';
import { createNexofisStore } from './src/server/storage';
import { mountInvestigationRoutes } from './src/server/investigationRoutes';
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
} from './src/types/audit';

// A09: Fail-closed boot check for production auth configuration
validateProductionAuthConfig();

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
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

async function fetchLivePncpContratacoes(
  ibgeCode: string,
  municipalityName: string,
  uf: string,
  period: { startDate?: string; endDate?: string }
): Promise<{
  records: ContractRecord[];
  liveAvailable: boolean;
  message: string;
}> {
  const bounds = resolvePncpPeriodBounds(period, new Date().getFullYear());

  try {
    const modalityResults = await Promise.all(
      PNCP_CORE_MODALITIES.map(async (modalityCode) => {
        const url = `https://pncp.gov.br/api/consulta/v1/contratacoes/publicacao?dataInicial=${bounds.dataInicial}&dataFinal=${bounds.dataFinal}&codigoMunicipioIbge=${encodeURIComponent(
          ibgeCode
        )}&codigoModalidadeContratacao=${modalityCode}&pagina=1&tamanhoPagina=15`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);
        try {
          const res = await fetch(url, {
            signal: controller.signal,
            headers: { Accept: 'application/json', 'User-Agent': 'Nexofis-Audit/1.0' },
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
    if (!anyOk) {
      const firstStatus = modalityResults.find((r) => r.status > 0)?.status;
      return {
        records: [],
        liveAvailable: false,
        message: firstStatus
          ? `API PNCP retornou HTTP ${firstStatus} para IBGE ${ibgeCode}.`
          : `API PNCP indisponível ou tempo esgotado para IBGE ${ibgeCode}.`,
      };
    }

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

    const items = Array.from(deduped.values()).sort((a, b) =>
      (b.dataPublicacaoPncp ?? '').localeCompare(a.dataPublicacaoPncp ?? '')
    );

    if (items.length === 0) {
      return {
        records: [],
        liveAvailable: true,
        message: `API PNCP consultada em tempo real — 0 contratações retornadas para o período (${bounds.dataInicial}..${bounds.dataFinal}).`,
      };
    }

    const retrievedAt = new Date().toISOString();
    const records: ContractRecord[] = items.slice(0, 30).map((item, idx) => {
      const pncpId = item.numeroControlePNCP ?? `PNCP-${ibgeCode}-${bounds.targetYear}-${idx + 1}`;
      const entityCnpj = normalizeCnpj(item.orgaoEntidade?.cnpj) || '';
      const valor = Number(item.valorTotalHomologado ?? item.valorTotalEstimado ?? 0);
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
        signatureDate: '', // A02: contratação/publicação não traz assinatura contratual
        startDate: publishedAt,
        endDate: '', // A02: nunca fabricar término
        originalValue: valor,
        updatedValue: valor,
        status,
        supplier: {
          cnpj: '00000000000000', // A02: publicação de contratação/edital não informa CNPJ do fornecedor vencedor
          legalName: 'Fornecedor não divulgado na publicação (PNCP)',
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
          dataProvenance: 'PNCP API Oficial (Tempo Real)',
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
            parserVersion: 'pncp-live-v2',
            reportedOriginalValue: valor,
            reportedUpdatedValue: valor,
            reportedSupplierCnpj: entityCnpj,
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
              extractorVersion: 'pncp-json-v2',
            },
            pages: [
              {
                pageNumber: 1,
                extractionMethod: 'native',
                confidence: 1,
                text: `Publicação oficial PNCP ${pncpId}. Órgão: ${entityName}. Objeto: ${item.objetoCompra ?? 'Não informado'}. Valor: R$ ${valor.toFixed(2)}.`,
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

    for (const r of records) {
      persistContract(r);
    }

    return {
      records,
      liveAvailable: true,
      message: `${records.length} contratação(ões) oficial(is) carregada(s) em tempo real da API do PNCP.`,
    };
  } catch (err) {
    return {
      records: [],
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
      byEntity.set(c.entityId, {
        id: c.entityId,
        ibgeCode,
        cnpj: c.supplier.cnpj,
        name: c.entityName,
        shortName: c.entityName.slice(0, 48),
        entityType,
        pncpOrgaoCode: c.entityId.replace(/^ENT-/, '').slice(0, 14),
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

  const matching = getAllContracts().filter(
    (c) =>
      c.municipalityIbge === ibgeCode &&
      matchesDatePeriod(c.signatureDate || c.startDate, { startDate, endDate })
  );

  const evaluated = matching
    .map((c) => evaluateWithContext(c))
    .sort((a, b) => b.assessment.score - a.assessment.score);

  const entities = buildEntitiesForMunicipality(ibgeCode, evaluated);

  res.json({
    municipality,
    entities,
    contracts: evaluated,
    summary: {
      contractCount: evaluated.length,
      entityCount: entities.length,
      totalValue: evaluated.reduce((sum, c) => sum + c.updatedValue, 0),
      highRiskCount: evaluated.filter(
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

  const evaluated = matched
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
  store.upsertSyncCheckpoint({
    scopeKey: `cnpj:${cleanCnpj}`,
    sourceSystem: 'PNCP Search API',
    lastSyncedAt: liveResult.retrievedAt,
    status: liveResult.status,
    totalDeclared: liveResult.pncpTotalDeclared,
    totalFetched: liveResult.pncpFetchedCount,
    detail: liveResult.message,
  });
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

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5500);
    const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cleanCnpj}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'Nexofis-Audit/1.0' },
    });
    clearTimeout(timer);
    if (!r.ok) {
      res.json({
        enriched: false,
        source: 'BrasilAPI CNPJ',
        message: `BrasilAPI retornou HTTP ${r.status}.`,
      });
      return;
    }

    const data = (await r.json()) as {
      razao_social?: string;
      descricao_situacao_cadastral?: string;
      data_inicio_atividade?: string;
      cnae_fiscal?: string | number;
      cnae_fiscal_descricao?: string;
      capital_social?: number;
      qsa?: Array<{ nome_socio?: string; qualificacao_socio?: string; data_entrada_sociedade?: string }>;
    };

    res.json({
      enriched: true,
      source: 'BrasilAPI CNPJ (intermediário — dados Receita Federal)',
      data: {
        legalName: data.razao_social ?? '',
        openingDate: data.data_inicio_atividade ?? '',
        primaryCnaeCode: data.cnae_fiscal ? String(data.cnae_fiscal) : '',
        primaryCnaeDescription: data.cnae_fiscal_descricao ?? '',
        shareCapital: Number(data.capital_social ?? 0),
        registrationStatus: data.descricao_situacao_cadastral ?? 'DESCONHECIDA',
        shareholders: (data.qsa ?? []).map((p) => ({
          name: p.nome_socio ?? '',
          role: p.qualificacao_socio ?? '',
          entryDate: p.data_entrada_sociedade ?? '',
        })),
      },
    });
  } catch (err) {
    res.json({
      enriched: false,
      source: 'BrasilAPI CNPJ',
      message: `Consulta cadastral indisponível (${err instanceof Error ? err.message : 'erro de rede'}).`,
    });
  }
});

// ==========================================
// API ROUTES — CONTRACT DETAIL, OCDS & REVIEWS (A06 + A09)
// ==========================================

app.get('/api/contracts/:id', (req, res) => {
  const contract = contractStore.get(String(req.params.id));
  if (!contract) {
    res.status(404).json({ error: 'Contrato não encontrado na base de auditoria.' });
    return;
  }

  const evaluated = evaluateWithContext(contract);
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

// Documentary relationships and private evidence never enter public contract responses.
mountInvestigationRoutes(app, {
  store,
  getContract: (id) => contractStore.get(id),
  getAllContracts,
});

// Ensure unmatched /api/* routes ALWAYS return JSON 404 (never SPA HTML fallback!)
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Endpoint de API não encontrado.' });
});

// ==========================================
// SERVER BOOTSTRAP (Vite Dev Middleware or Static Production Build)
// ==========================================

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const vite = await createViteServer({
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

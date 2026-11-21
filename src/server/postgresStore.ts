/**
 * NEXOFIS — Adaptador de Persistência PostgreSQL (R-12)
 * Licença: GNU AGPL-3.0-only (Eduardo Muniz — DM Technology)
 *
 * Uso no ambiente do usuário:
 *   npm install pg @types/pg
 *   export NEXOFIS_DB_DRIVER=postgres
 *   export DATABASE_URL="postgres://nexofis:SENHA@localhost:5432/nexofis"
 *   npx tsx scripts/migrate-postgres.ts
 *
 * Mantém import dinâmico de `pg` para não quebrar execuções locais somente com SQLite (`node:sqlite`).
 */

import type {
  ContractRecord,
  FindingReviewRecord,
  SavedDossierSummary,
} from '../types/audit';
import type { DocumentArtifactRecord, SyncCheckpoint } from './storage';

interface PgQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number | null;
}

interface PgPoolLike {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgQueryResult<T>>;
  end(): Promise<void>;
}

export interface AsyncNexofisStore {
  readonly driver: 'postgres';
  close(): Promise<void>;
  getSchemaVersion(): Promise<number>;
  upsertContract(contract: ContractRecord): Promise<void>;
  upsertContracts(contracts: ContractRecord[]): Promise<void>;
  getAllStoredContracts(): Promise<ContractRecord[]>;
  getStoredContractById(id: string): Promise<ContractRecord | null>;
  listDossiers(): Promise<SavedDossierSummary[]>;
  saveDossier(dossier: SavedDossierSummary): Promise<SavedDossierSummary[]>;
  deleteDossier(id: string): Promise<boolean>;
  addFindingReview(review: FindingReviewRecord): Promise<FindingReviewRecord>;
  listFindingReviews(contractId: string): Promise<FindingReviewRecord[]>;
  upsertSyncCheckpoint(cp: SyncCheckpoint): Promise<void>;
  getSyncCheckpoint(scopeKey: string): Promise<SyncCheckpoint | null>;
  recordDocumentArtifact(artifact: DocumentArtifactRecord): Promise<{ alreadyExisted: boolean }>;
  getDocumentArtifactBySha256(sha256: string): Promise<DocumentArtifactRecord | null>;
}

function toCents(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

function toNullableDate(raw?: string | null): string | null {
  if (!raw) return null;
  const match = raw.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

export async function createPostgresStore(
  connectionString: string = process.env.DATABASE_URL ?? ''
): Promise<AsyncNexofisStore> {
  if (!connectionString.trim()) {
    throw new Error(
      'DATABASE_URL não configurada. Defina DATABASE_URL no arquivo .env antes de iniciar o adaptador PostgreSQL.'
    );
  }

  let pgModule: { Pool: new (cfg: { connectionString: string; max?: number }) => PgPoolLike };
  try {
    // Dynamic runtime load so SQLite-only environments do not require pg installed
    const modName = 'pg';
    pgModule = (await import(modName)) as typeof pgModule;
  } catch {
    throw new Error(
      'Pacote "pg" não encontrado. Execute `npm install pg` no seu ambiente para ativar o adaptador PostgreSQL.'
    );
  }

  const pool = new pgModule.Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX ?? 10),
  });

  const upsertContract = async (contract: ContractRecord): Promise<void> => {
    await pool.query(
      `
      INSERT INTO contracts (
        id, pncp_control_number, contract_number, municipality_ibge, municipality_name, uf,
        entity_id, entity_name, supplier_cnpj, cnpj_role, year, lifecycle_status,
        signature_date, start_date, end_date, original_value_cents, updated_value_cents,
        data_source_origin, payload_json, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17,
        $18, $19::jsonb, NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        pncp_control_number = EXCLUDED.pncp_control_number,
        contract_number = EXCLUDED.contract_number,
        municipality_ibge = EXCLUDED.municipality_ibge,
        municipality_name = EXCLUDED.municipality_name,
        uf = EXCLUDED.uf,
        entity_id = EXCLUDED.entity_id,
        entity_name = EXCLUDED.entity_name,
        supplier_cnpj = EXCLUDED.supplier_cnpj,
        cnpj_role = EXCLUDED.cnpj_role,
        year = EXCLUDED.year,
        lifecycle_status = EXCLUDED.lifecycle_status,
        signature_date = EXCLUDED.signature_date,
        start_date = EXCLUDED.start_date,
        end_date = EXCLUDED.end_date,
        original_value_cents = EXCLUDED.original_value_cents,
        updated_value_cents = EXCLUDED.updated_value_cents,
        data_source_origin = EXCLUDED.data_source_origin,
        payload_json = EXCLUDED.payload_json,
        updated_at = NOW()
      `,
      [
        contract.id,
        contract.pncpControlNumber,
        contract.contractNumber,
        contract.municipalityIbge,
        contract.municipalityName,
        contract.uf.slice(0, 2).toUpperCase(),
        contract.entityId,
        contract.entityName,
        contract.supplier.cnpj,
        contract.cnpjRole ?? null,
        contract.year,
        contract.status,
        toNullableDate(contract.signatureDate),
        toNullableDate(contract.startDate),
        toNullableDate(contract.endDate),
        toCents(contract.originalValue),
        toCents(contract.updatedValue),
        contract.dataSourceOrigin,
        JSON.stringify(contract),
      ]
    );
  };

  const storeApi: AsyncNexofisStore = {
    driver: 'postgres',

    async close() {
      await pool.end();
    },

    async getSchemaVersion() {
      const res = await pool.query<{ version: number }>(
        'SELECT COALESCE(MAX(version), 0)::int AS version FROM schema_migrations'
      );
      return res.rows[0]?.version ?? 0;
    },

    upsertContract,

    async upsertContracts(contracts: ContractRecord[]) {
      for (const c of contracts) {
        await upsertContract(c);
      }
    },

    async getAllStoredContracts() {
      const res = await pool.query<{ payload_json: ContractRecord }>(
        'SELECT payload_json FROM contracts ORDER BY updated_at DESC'
      );
      return res.rows.map((r) => r.payload_json);
    },

    async getStoredContractById(id: string) {
      const res = await pool.query<{ payload_json: ContractRecord }>(
        'SELECT payload_json FROM contracts WHERE id = $1',
        [id]
      );
      return res.rows[0]?.payload_json ?? null;
    },

    async listDossiers() {
      const res = await pool.query<{
        id: string;
        contract_id: string;
        contract_number: string;
        municipality_name: string;
        municipality_ibge: string;
        entity_name: string;
        supplier_name: string;
        risk_score: number;
        saved_at: Date | string;
        analyst_note: string;
        sha256_digest: string;
      }>('SELECT * FROM saved_dossiers ORDER BY saved_at DESC');

      return res.rows.map((r) => ({
        id: r.id,
        contractId: r.contract_id,
        contractNumber: r.contract_number,
        municipalityName: r.municipality_name,
        municipalityIbge: r.municipality_ibge,
        entityName: r.entity_name,
        supplierName: r.supplier_name,
        riskScore: r.risk_score,
        savedAt: r.saved_at instanceof Date ? r.saved_at.toISOString() : String(r.saved_at),
        analystNote: r.analyst_note,
        sha256Digest: r.sha256_digest,
      }));
    },

    async saveDossier(dossier: SavedDossierSummary) {
      await pool.query(
        `
        INSERT INTO saved_dossiers (
          id, contract_id, contract_number, municipality_name, municipality_ibge,
          entity_name, supplier_name, risk_score, saved_at, analyst_note, sha256_digest
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (contract_id) DO UPDATE SET
          risk_score = EXCLUDED.risk_score,
          saved_at = EXCLUDED.saved_at,
          analyst_note = EXCLUDED.analyst_note,
          sha256_digest = EXCLUDED.sha256_digest
        `,
        [
          dossier.id,
          dossier.contractId,
          dossier.contractNumber,
          dossier.municipalityName,
          dossier.municipalityIbge,
          dossier.entityName,
          dossier.supplierName,
          dossier.riskScore,
          dossier.savedAt,
          dossier.analystNote,
          dossier.sha256Digest,
        ]
      );
      return storeApi.listDossiers();
    },

    async deleteDossier(id: string) {
      const res = await pool.query('DELETE FROM saved_dossiers WHERE id = $1', [id]);
      return (res.rowCount ?? 0) > 0;
    },

    async addFindingReview(review: FindingReviewRecord) {
      await pool.query(
        `
        INSERT INTO finding_reviews (
          id, contract_id, finding_id, action, author, rationale, rule_version, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          review.id,
          review.contractId,
          review.findingId,
          review.action,
          review.author,
          review.rationale,
          review.ruleVersion,
          review.createdAt,
        ]
      );
      return review;
    },

    async listFindingReviews(contractId: string) {
      const res = await pool.query<{
        id: string;
        contract_id: string;
        finding_id: string;
        action: 'dismiss' | 'restore';
        author: string;
        rationale: string;
        rule_version: string;
        created_at: Date | string;
      }>(
        'SELECT * FROM finding_reviews WHERE contract_id = $1 ORDER BY created_at ASC',
        [contractId]
      );
      return res.rows.map((r) => ({
        id: r.id,
        contractId: r.contract_id,
        findingId: r.finding_id,
        action: r.action,
        author: r.author,
        rationale: r.rationale,
        ruleVersion: r.rule_version,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      }));
    },

    async upsertSyncCheckpoint(cp: SyncCheckpoint) {
      await pool.query(
        `
        INSERT INTO sync_checkpoints (
          scope_key, source_system, last_synced_at, status, total_declared, total_fetched, detail
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (scope_key) DO UPDATE SET
          source_system = EXCLUDED.source_system,
          last_synced_at = EXCLUDED.last_synced_at,
          status = EXCLUDED.status,
          total_declared = EXCLUDED.total_declared,
          total_fetched = EXCLUDED.total_fetched,
          detail = EXCLUDED.detail
        `,
        [
          cp.scopeKey,
          cp.sourceSystem,
          cp.lastSyncedAt,
          cp.status,
          cp.totalDeclared,
          cp.totalFetched,
          cp.detail,
        ]
      );
    },

    async getSyncCheckpoint(scopeKey: string) {
      const res = await pool.query<{
        scope_key: string;
        source_system: string;
        last_synced_at: Date | string;
        status: SyncCheckpoint['status'];
        total_declared: number;
        total_fetched: number;
        detail: string;
      }>('SELECT * FROM sync_checkpoints WHERE scope_key = $1', [scopeKey]);
      const r = res.rows[0];
      if (!r) return null;
      return {
        scopeKey: r.scope_key,
        sourceSystem: r.source_system,
        lastSyncedAt:
          r.last_synced_at instanceof Date ? r.last_synced_at.toISOString() : String(r.last_synced_at),
        status: r.status,
        totalDeclared: r.total_declared,
        totalFetched: r.total_fetched,
        detail: r.detail,
      };
    },

    async recordDocumentArtifact(artifact: DocumentArtifactRecord) {
      const existing = await storeApi.getDocumentArtifactBySha256(artifact.sha256);
      if (existing) return { alreadyExisted: true };
      await pool.query(
        `
        INSERT INTO document_artifacts (
          sha256, filename, mime_type, size_bytes, contract_id, extractor_version, page_count, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (sha256) DO NOTHING
        `,
        [
          artifact.sha256,
          artifact.filename,
          artifact.mimeType,
          artifact.sizeBytes,
          artifact.contractId,
          artifact.extractorVersion,
          artifact.pageCount,
          artifact.createdAt,
        ]
      );
      return { alreadyExisted: false };
    },

    async getDocumentArtifactBySha256(sha256: string) {
      const res = await pool.query<{
        sha256: string;
        filename: string;
        mime_type: string;
        size_bytes: number;
        contract_id: string | null;
        extractor_version: string;
        page_count: number;
        created_at: Date | string;
      }>('SELECT * FROM document_artifacts WHERE sha256 = $1', [sha256]);
      const r = res.rows[0];
      if (!r) return null;
      return {
        sha256: r.sha256,
        filename: r.filename,
        mimeType: r.mime_type,
        sizeBytes: Number(r.size_bytes),
        contractId: r.contract_id,
        extractorVersion: r.extractor_version,
        pageCount: r.page_count,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      };
    },
  };

  return storeApi;
}

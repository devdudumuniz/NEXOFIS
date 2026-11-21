import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ContractRecord,
  FindingReviewRecord,
  SavedDossierSummary,
} from '../types/audit';

export interface SyncCheckpoint {
  scopeKey: string;
  sourceSystem: string;
  lastSyncedAt: string;
  status: 'complete' | 'partial' | 'rate_limited' | 'unavailable';
  totalDeclared: number;
  totalFetched: number;
  detail: string;
}

export interface DocumentArtifactRecord {
  sha256: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contractId: string | null;
  extractorVersion: string;
  pageCount: number;
  createdAt: string;
}

export interface NexofisStore {
  dbPath: string;
  close(): void;
  getSchemaVersion(): number;
  upsertContract(contract: ContractRecord): void;
  upsertContracts(contracts: ContractRecord[]): void;
  getAllStoredContracts(): ContractRecord[];
  getStoredContractById(id: string): ContractRecord | null;
  listDossiers(): SavedDossierSummary[];
  saveDossier(dossier: SavedDossierSummary): SavedDossierSummary[];
  deleteDossier(id: string): boolean;
  addFindingReview(review: FindingReviewRecord): FindingReviewRecord;
  listFindingReviews(contractId: string): FindingReviewRecord[];
  listAllFindingReviews(): FindingReviewRecord[];
  upsertSyncCheckpoint(cp: SyncCheckpoint): void;
  getSyncCheckpoint(scopeKey: string): SyncCheckpoint | null;
  recordDocumentArtifact(artifact: DocumentArtifactRecord): { alreadyExisted: boolean };
  getDocumentArtifactBySha256(sha256: string): DocumentArtifactRecord | null;
  listDocumentArtifactsForContract(contractId: string): DocumentArtifactRecord[];
}

const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'data', 'nexofis.db');

export function createNexofisStore(dbPath: string = DEFAULT_DB_PATH): NexofisStore {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  // Versioned schema migrations table
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number };

  if (applied.version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS contracts (
        id TEXT PRIMARY KEY,
        pncp_control_number TEXT NOT NULL,
        contract_number TEXT NOT NULL,
        municipality_ibge TEXT NOT NULL,
        supplier_cnpj TEXT NOT NULL,
        cnpj_role TEXT,
        year INTEGER NOT NULL,
        data_source_origin TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_contracts_supplier_cnpj ON contracts(supplier_cnpj);
      CREATE INDEX IF NOT EXISTS idx_contracts_ibge ON contracts(municipality_ibge);
      CREATE INDEX IF NOT EXISTS idx_contracts_pncp ON contracts(pncp_control_number);

      CREATE TABLE IF NOT EXISTS saved_dossiers (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL UNIQUE,
        contract_number TEXT NOT NULL,
        municipality_name TEXT NOT NULL,
        municipality_ibge TEXT NOT NULL,
        entity_name TEXT NOT NULL,
        supplier_name TEXT NOT NULL,
        risk_score INTEGER NOT NULL,
        saved_at TEXT NOT NULL,
        analyst_note TEXT NOT NULL,
        sha256_digest TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS finding_reviews (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        finding_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('dismiss', 'restore')),
        author TEXT NOT NULL,
        rationale TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_finding_reviews_contract ON finding_reviews(contract_id, created_at);

      CREATE TABLE IF NOT EXISTS sync_checkpoints (
        scope_key TEXT PRIMARY KEY,
        source_system TEXT NOT NULL,
        last_synced_at TEXT NOT NULL,
        status TEXT NOT NULL,
        total_declared INTEGER NOT NULL,
        total_fetched INTEGER NOT NULL,
        detail TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS document_artifacts (
        sha256 TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        contract_id TEXT,
        extractor_version TEXT NOT NULL,
        page_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
    ).run(1, 'initial_nexofis_forensic_schema', new Date().toISOString());
  }

  const stmtUpsertContract = db.prepare(`
    INSERT INTO contracts (
      id, pncp_control_number, contract_number, municipality_ibge, supplier_cnpj,
      cnpj_role, year, data_source_origin, payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      pncp_control_number = excluded.pncp_control_number,
      contract_number = excluded.contract_number,
      municipality_ibge = excluded.municipality_ibge,
      supplier_cnpj = excluded.supplier_cnpj,
      cnpj_role = excluded.cnpj_role,
      year = excluded.year,
      data_source_origin = excluded.data_source_origin,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);

  const stmtGetAllContracts = db.prepare(
    'SELECT payload_json FROM contracts ORDER BY updated_at DESC'
  );
  const stmtGetContractById = db.prepare(
    'SELECT payload_json FROM contracts WHERE id = ?'
  );

  const stmtListDossiers = db.prepare(`
    SELECT id, contract_id, contract_number, municipality_name, municipality_ibge,
           entity_name, supplier_name, risk_score, saved_at, analyst_note, sha256_digest
    FROM saved_dossiers
    ORDER BY saved_at DESC
  `);

  const stmtUpsertDossier = db.prepare(`
    INSERT INTO saved_dossiers (
      id, contract_id, contract_number, municipality_name, municipality_ibge,
      entity_name, supplier_name, risk_score, saved_at, analyst_note, sha256_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contract_id) DO UPDATE SET
      id = excluded.id,
      contract_number = excluded.contract_number,
      municipality_name = excluded.municipality_name,
      municipality_ibge = excluded.municipality_ibge,
      entity_name = excluded.entity_name,
      supplier_name = excluded.supplier_name,
      risk_score = excluded.risk_score,
      saved_at = excluded.saved_at,
      analyst_note = excluded.analyst_note,
      sha256_digest = excluded.sha256_digest
  `);

  const stmtDeleteDossier = db.prepare('DELETE FROM saved_dossiers WHERE id = ?');

  const stmtInsertReview = db.prepare(`
    INSERT INTO finding_reviews (
      id, contract_id, finding_id, action, author, rationale, rule_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stmtListReviewsForContract = db.prepare(`
    SELECT id, contract_id, finding_id, action, author, rationale, rule_version, created_at
    FROM finding_reviews
    WHERE contract_id = ?
    ORDER BY created_at ASC
  `);

  const stmtListAllReviews = db.prepare(`
    SELECT id, contract_id, finding_id, action, author, rationale, rule_version, created_at
    FROM finding_reviews
    ORDER BY created_at ASC
  `);

  const stmtUpsertCheckpoint = db.prepare(`
    INSERT INTO sync_checkpoints (
      scope_key, source_system, last_synced_at, status, total_declared, total_fetched, detail
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_key) DO UPDATE SET
      source_system = excluded.source_system,
      last_synced_at = excluded.last_synced_at,
      status = excluded.status,
      total_declared = excluded.total_declared,
      total_fetched = excluded.total_fetched,
      detail = excluded.detail
  `);

  const stmtGetCheckpoint = db.prepare(`
    SELECT scope_key, source_system, last_synced_at, status, total_declared, total_fetched, detail
    FROM sync_checkpoints
    WHERE scope_key = ?
  `);

  const stmtGetArtifact = db.prepare(`
    SELECT sha256, filename, mime_type, size_bytes, contract_id, extractor_version, page_count, created_at
    FROM document_artifacts
    WHERE sha256 = ?
  `);

  const stmtInsertArtifact = db.prepare(`
    INSERT OR IGNORE INTO document_artifacts (
      sha256, filename, mime_type, size_bytes, contract_id, extractor_version, page_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stmtListArtifactsForContract = db.prepare(`
    SELECT sha256, filename, mime_type, size_bytes, contract_id, extractor_version, page_count, created_at
    FROM document_artifacts
    WHERE contract_id = ?
    ORDER BY created_at DESC
  `);

  function mapDossierRow(r: Record<string, unknown>): SavedDossierSummary {
    return {
      id: String(r.id),
      contractId: String(r.contract_id),
      contractNumber: String(r.contract_number),
      municipalityName: String(r.municipality_name),
      municipalityIbge: String(r.municipality_ibge),
      entityName: String(r.entity_name),
      supplierName: String(r.supplier_name),
      riskScore: Number(r.risk_score),
      savedAt: String(r.saved_at),
      analystNote: String(r.analyst_note),
      sha256Digest: String(r.sha256_digest),
    };
  }

  function mapReviewRow(r: Record<string, unknown>): FindingReviewRecord {
    return {
      id: String(r.id),
      contractId: String(r.contract_id),
      findingId: String(r.finding_id),
      action: r.action === 'restore' ? 'restore' : 'dismiss',
      author: String(r.author),
      rationale: String(r.rationale),
      ruleVersion: String(r.rule_version),
      createdAt: String(r.created_at),
    };
  }

  function mapArtifactRow(r: Record<string, unknown>): DocumentArtifactRecord {
    return {
      sha256: String(r.sha256),
      filename: String(r.filename),
      mimeType: String(r.mime_type),
      sizeBytes: Number(r.size_bytes),
      contractId: r.contract_id ? String(r.contract_id) : null,
      extractorVersion: String(r.extractor_version),
      pageCount: Number(r.page_count),
      createdAt: String(r.created_at),
    };
  }

  return {
    dbPath,
    close() {
      db.close();
    },
    getSchemaVersion() {
      const row = db
        .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
        .get() as { version: number };
      return Number(row.version);
    },
    upsertContract(contract: ContractRecord) {
      stmtUpsertContract.run(
        contract.id,
        contract.pncpControlNumber,
        contract.contractNumber,
        contract.municipalityIbge,
        contract.supplier.cnpj,
        contract.cnpjRole ?? null,
        contract.year,
        contract.dataSourceOrigin,
        JSON.stringify(contract),
        new Date().toISOString()
      );
    },
    upsertContracts(contracts: ContractRecord[]) {
      const now = new Date().toISOString();
      db.exec('BEGIN');
      try {
        for (const contract of contracts) {
          stmtUpsertContract.run(
            contract.id,
            contract.pncpControlNumber,
            contract.contractNumber,
            contract.municipalityIbge,
            contract.supplier.cnpj,
            contract.cnpjRole ?? null,
            contract.year,
            contract.dataSourceOrigin,
            JSON.stringify(contract),
            now
          );
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    getAllStoredContracts() {
      const rows = stmtGetAllContracts.all() as Array<{ payload_json: string }>;
      const list: ContractRecord[] = [];
      for (const row of rows) {
        try {
          list.push(JSON.parse(row.payload_json) as ContractRecord);
        } catch {
          // Skip malformed row safely
        }
      }
      return list;
    },
    getStoredContractById(id: string) {
      const row = stmtGetContractById.get(id) as { payload_json: string } | undefined;
      if (!row) return null;
      try {
        return JSON.parse(row.payload_json) as ContractRecord;
      } catch {
        return null;
      }
    },
    listDossiers() {
      const rows = stmtListDossiers.all() as Array<Record<string, unknown>>;
      return rows.map(mapDossierRow);
    },
    saveDossier(dossier: SavedDossierSummary) {
      stmtUpsertDossier.run(
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
        dossier.sha256Digest
      );
      return this.listDossiers();
    },
    deleteDossier(id: string) {
      const result = stmtDeleteDossier.run(id);
      return Number(result.changes) > 0;
    },
    addFindingReview(review: FindingReviewRecord) {
      stmtInsertReview.run(
        review.id,
        review.contractId,
        review.findingId,
        review.action,
        review.author,
        review.rationale,
        review.ruleVersion,
        review.createdAt
      );
      return review;
    },
    listFindingReviews(contractId: string) {
      const rows = stmtListReviewsForContract.all(contractId) as Array<Record<string, unknown>>;
      return rows.map(mapReviewRow);
    },
    listAllFindingReviews() {
      const rows = stmtListAllReviews.all() as Array<Record<string, unknown>>;
      return rows.map(mapReviewRow);
    },
    upsertSyncCheckpoint(cp: SyncCheckpoint) {
      stmtUpsertCheckpoint.run(
        cp.scopeKey,
        cp.sourceSystem,
        cp.lastSyncedAt,
        cp.status,
        cp.totalDeclared,
        cp.totalFetched,
        cp.detail
      );
    },
    getSyncCheckpoint(scopeKey: string) {
      const row = stmtGetCheckpoint.get(scopeKey) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        scopeKey: String(row.scope_key),
        sourceSystem: String(row.source_system),
        lastSyncedAt: String(row.last_synced_at),
        status: row.status as SyncCheckpoint['status'],
        totalDeclared: Number(row.total_declared),
        totalFetched: Number(row.total_fetched),
        detail: String(row.detail),
      };
    },
    recordDocumentArtifact(artifact: DocumentArtifactRecord) {
      const existing = stmtGetArtifact.get(artifact.sha256);
      if (existing) {
        return { alreadyExisted: true };
      }
      stmtInsertArtifact.run(
        artifact.sha256,
        artifact.filename,
        artifact.mimeType,
        artifact.sizeBytes,
        artifact.contractId,
        artifact.extractorVersion,
        artifact.pageCount,
        artifact.createdAt
      );
      return { alreadyExisted: false };
    },
    getDocumentArtifactBySha256(sha256: string) {
      const row = stmtGetArtifact.get(sha256) as Record<string, unknown> | undefined;
      return row ? mapArtifactRow(row) : null;
    },
    listDocumentArtifactsForContract(contractId: string) {
      const rows = stmtListArtifactsForContract.all(contractId) as Array<Record<string, unknown>>;
      return rows.map(mapArtifactRow);
    },
  };
}

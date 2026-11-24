import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ContractRecord,
  DocumentPage,
  EvaluatedContract,
  FindingReviewRecord,
  SavedDossierSnapshot,
  SavedDossierSummary,
} from '@nexofis/shared/types/audit';
import type {
  CadastralMinimizedExtract,
  InvestigationEventRecord,
  InvestigationFactSet,
  InvestigationReviewRecord,
  ObservedHistorySnapshot,
  PrivateEvidenceRecord,
} from '@nexofis/shared/types/investigation';
import {
  computeEventChainHash,
  computeFactSetDigest,
  createEmptyFactSet,
  MAX_PRIVATE_EVIDENCE_BYTES,
} from '@nexofis/shared/lib/forensicInvestigationEngine';
import type { SupplierQsaRecord, SupplierQsaShareholder } from '@nexofis/shared/lib/partnerNetworkGraph';
import {
  computeCanonicalDossierSnapshotHash,
  extractDistinctContractDates,
} from '@nexofis/shared/lib/contractLifecycleEvents';

export interface InvestigationActor {
  actorId: string;
  actorName: string;
  actorRole: 'admin' | 'analyst' | 'viewer';
}

export interface StoredInvestigationCase {
  contractId: string;
  factSet: InvestigationFactSet;
  cadastralExtracts: CadastralMinimizedExtract[];
  observedHistory: ObservedHistorySnapshot | null;
  privateEvidence: PrivateEvidenceRecord[];
  reviews: InvestigationReviewRecord[];
  events: InvestigationEventRecord[];
}

export class InvestigationVersionConflictError extends Error {
  readonly expectedVersion: number;
  readonly currentVersion: number;

  constructor(expectedVersion: number, currentVersion: number) {
    super(
      `Conflito de versão ao atualizar fatos da investigação (esperada v${expectedVersion}, atual v${currentVersion}). Recarregue o caso antes de salvar.`
    );
    this.name = 'InvestigationVersionConflictError';
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
}

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
  originalPageCount?: number;
  truncated?: boolean;
  objectKey?: string | null;
  fullText?: string | null;
  pages?: DocumentPage[];
  createdAt: string;
}

export interface NexofisUserRecord {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'analyst' | 'viewer';
  passwordHash: string;
  createdAt: string;
}

export interface NexofisStore {
  dbPath: string;
  objectsDir: string;
  privateEvidenceDir: string;
  close(): void;
  getSchemaVersion(): number;
  upsertContract(contract: ContractRecord): void;
  upsertContracts(contracts: ContractRecord[]): void;
  getAllStoredContracts(): ContractRecord[];
  getStoredContractById(id: string): ContractRecord | null;
  listDossiers(): SavedDossierSummary[];
  getDossierById(id: string): SavedDossierSnapshot | null;
  getDossierByHash(sha256Digest: string): SavedDossierSummary | null;
  saveDossier(
    dossier: SavedDossierSummary,
    snapshot?: { contract: EvaluatedContract; reviews: FindingReviewRecord[] }
  ): SavedDossierSummary[];
  saveDossierWithDedup(
    dossier: SavedDossierSummary,
    snapshot?: { contract: EvaluatedContract; reviews: FindingReviewRecord[] }
  ): {
    dossier: SavedDossierSummary;
    dossiers: SavedDossierSummary[];
    deduplicated: boolean;
    contentHash: string;
  };
  deleteDossier(id: string): boolean;
  addFindingReview(review: FindingReviewRecord): FindingReviewRecord;
  listFindingReviews(contractId: string): FindingReviewRecord[];
  listAllFindingReviews(): FindingReviewRecord[];
  upsertSyncCheckpoint(cp: SyncCheckpoint): void;
  getSyncCheckpoint(scopeKey: string): SyncCheckpoint | null;
  recordDocumentArtifact(artifact: DocumentArtifactRecord): { alreadyExisted: boolean };
  getDocumentArtifactBySha256(sha256: string): DocumentArtifactRecord | null;
  listDocumentArtifactsForContract(contractId: string): DocumentArtifactRecord[];
  saveOriginalDocumentBytes(sha256: string, bytes: Buffer): { objectKey: string; verified: boolean };
  readOriginalDocumentBytes(sha256: string): { bytes: Buffer; verified: boolean } | null;
  countUsers(): number;
  createUser(user: NexofisUserRecord): NexofisUserRecord;
  getUserByEmail(email: string): NexofisUserRecord | null;
  listUsers(): Array<Omit<NexofisUserRecord, 'passwordHash'>>;
  getOrCreateInvestigationCase(contractId: string, actor: InvestigationActor): StoredInvestigationCase;
  appendCadastralExtract(
    contractId: string,
    extract: CadastralMinimizedExtract,
    actor: InvestigationActor
  ): StoredInvestigationCase;
  saveObservedHistory(
    contractId: string,
    snapshot: ObservedHistorySnapshot,
    actor: InvestigationActor
  ): StoredInvestigationCase;
  saveInvestigationFactSet(
    contractId: string,
    expectedVersion: number,
    factsPayload: Omit<InvestigationFactSet, 'version' | 'updatedAt' | 'updatedBy'>,
    actor: InvestigationActor
  ): StoredInvestigationCase;
  savePrivateEvidence(
    input: {
      contractId: string;
      filename: string;
      mimeType: string;
      sourceLabel: string;
      description: string;
      acquiredAt: string;
      bytes: Buffer;
    },
    actor: InvestigationActor
  ): { record: PrivateEvidenceRecord; investigation: StoredInvestigationCase };
  getPrivateEvidenceById(contractId: string, evidenceId: string): PrivateEvidenceRecord | null;
  readPrivateEvidenceBytes(sha256: string): { bytes: Buffer; verified: boolean } | null;
  addInvestigationReview(
    review: Omit<InvestigationReviewRecord, 'id' | 'createdAt'>,
    actor: InvestigationActor
  ): { review: InvestigationReviewRecord; investigation: StoredInvestigationCase };
  listInvestigationEvents(contractId: string): InvestigationEventRecord[];
  upsertSupplierQsa(record: SupplierQsaRecord): void;
  getSupplierQsa(cnpj: string): SupplierQsaRecord | null;
  listAllSupplierQsa(): SupplierQsaRecord[];
  saveOfficialSnapshot(snapshot: {
    id: string;
    sourceKind: 'siaps' | 'sinapi' | 'camara_personnel' | 'inep';
    filename: string;
    sha256: string;
    competencia: string;
    uf: string | null;
    metadataJson: string;
    payloadJson: string;
    importedBy: string;
  }): { alreadyExisted: boolean; id: string };
  listOfficialSnapshots(sourceKind?: 'siaps' | 'sinapi' | 'camara_personnel' | 'inep'): Array<{
    id: string;
    sourceKind: 'siaps' | 'sinapi' | 'camara_personnel' | 'inep';
    filename: string;
    sha256: string;
    competencia: string;
    uf: string | null;
    metadataJson: string;
    importedBy: string;
    importedAt: string;
  }>;
}

const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'data', 'nexofis.db');
const SHA256_RE = /^[a-f0-9]{64}$/i;

function safeAddColumn(db: DatabaseSync, table: string, columnDef: string): void {
  const colName = columnDef.trim().split(/\s+/)[0];
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === colName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef};`);
  }
}

export function createNexofisStore(dbPath: string = DEFAULT_DB_PATH): NexofisStore {
  const resolvedDbPath = path.resolve(dbPath);
  const dir = path.dirname(resolvedDbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const objectsDir = path.resolve(dir, 'objects');
  if (!fs.existsSync(objectsDir)) {
    fs.mkdirSync(objectsDir, { recursive: true });
  }
  const privateEvidenceDir = path.resolve(dir, 'private_evidence');
  if (!fs.existsSync(privateEvidenceDir)) {
    fs.mkdirSync(privateEvidenceDir, { recursive: true });
  }

  function openHealthyDatabase(targetPath: string): DatabaseSync {
    const attemptOpen = (): DatabaseSync => {
      const candidate = new DatabaseSync(targetPath);
      candidate.exec('PRAGMA journal_mode = WAL;');
      candidate.exec('PRAGMA foreign_keys = ON;');
      const checkRow = candidate.prepare('PRAGMA quick_check(1);').get() as
        | { quick_check?: string }
        | undefined;
      if (checkRow?.quick_check !== 'ok') {
        candidate.close();
        throw new Error(`SQLite quick_check failed: ${checkRow?.quick_check ?? 'unknown'}`);
      }
      return candidate;
    };

    try {
      return attemptOpen();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isCorruption =
        /malformed|not a database|quick_check failed|corrupt/i.test(msg) ||
        (typeof err === 'object' && err !== null && 'errcode' in err && (err as { errcode?: number }).errcode === 11);

      if (!isCorruption || !fs.existsSync(targetPath)) {
        throw err;
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      for (const suffix of ['', '-wal', '-shm']) {
        const src = `${targetPath}${suffix}`;
        if (fs.existsSync(src)) {
          const backup = `${targetPath}.corrupt-${stamp}${suffix}`;
          try {
            fs.renameSync(src, backup);
          } catch {
            // If rename fails (e.g. cross-device), fall back to copy + unlink for sidecars
            fs.copyFileSync(src, backup);
            fs.unlinkSync(src);
          }
        }
      }
      console.warn(
        `[NEXOFIS] Banco SQLite corrompido detectado em ${targetPath}; cópia preservada em ${targetPath}.corrupt-${stamp} e novo banco íntegro inicializado.`
      );
      return attemptOpen();
    }
  }

  const db = openHealthyDatabase(resolvedDbPath);

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

  // Additive migration v2 (A06/A07/A09): preserves all existing rows!
  const currentVersionRow = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number };

  if (currentVersionRow.version < 2) {
    safeAddColumn(db, 'saved_dossiers', 'snapshot_json TEXT');
    safeAddColumn(db, 'finding_reviews', 'actor_id TEXT');
    safeAddColumn(db, 'finding_reviews', 'actor_role TEXT');
    safeAddColumn(db, 'finding_reviews', 'finding_inputs_digest TEXT');
    safeAddColumn(db, 'document_artifacts', 'object_key TEXT');
    safeAddColumn(db, 'document_artifacts', 'full_text TEXT');
    safeAddColumn(db, 'document_artifacts', 'pages_json TEXT');
    safeAddColumn(db, 'document_artifacts', 'original_page_count INTEGER');
    safeAddColumn(db, 'document_artifacts', 'truncated INTEGER DEFAULT 0');

    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'analyst', 'viewer')),
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
    ).run(2, 'durable_originals_dossier_snapshots_rbac_users', new Date().toISOString());
  }

  // Additive migration v3: Forensic investigation cases, isolated private evidence, append-only hash-chained ledger, fact-bound reviews
  const v3Check = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number };

  if (v3Check.version < 3) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS investigation_cases (
        contract_id TEXT PRIMARY KEY,
        facts_version INTEGER NOT NULL DEFAULT 1,
        facts_json TEXT NOT NULL,
        cadastral_extracts_json TEXT NOT NULL DEFAULT '[]',
        observed_history_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS investigation_private_evidence (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        source_label TEXT NOT NULL,
        description TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        uploaded_by TEXT NOT NULL,
        export_filename TEXT NOT NULL,
        object_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_inv_priv_ev_contract
        ON investigation_private_evidence(contract_id, created_at);

      CREATE TABLE IF NOT EXISTS investigation_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        contract_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        facts_version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_inv_events_contract_seq
        ON investigation_events(contract_id, seq);

      CREATE TRIGGER IF NOT EXISTS trg_investigation_events_no_update
      BEFORE UPDATE ON investigation_events
      BEGIN
        SELECT RAISE(ABORT, 'investigation_events is append-only: UPDATE forbidden');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_investigation_events_no_delete
      BEFORE DELETE ON investigation_events
      BEGIN
        SELECT RAISE(ABORT, 'investigation_events is append-only: DELETE forbidden');
      END;

      CREATE TABLE IF NOT EXISTS investigation_reviews (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        finding_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('dismiss', 'confirm', 'restore')),
        rationale TEXT NOT NULL,
        facts_version INTEGER NOT NULL,
        finding_inputs_digest TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_inv_reviews_contract
        ON investigation_reviews(contract_id, created_at);
    `);

    db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
    ).run(3, 'forensic_investigation_module_append_only_ledger', new Date().toISOString());
  }

  // Additive migration v4: Supplier QSA persistent cache for corporate/partner network graph
  const v4Check = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number };

  if (v4Check.version < 4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS supplier_qsa_cache (
        cnpj TEXT PRIMARY KEY,
        legal_name TEXT NOT NULL,
        registration_status TEXT NOT NULL,
        opening_date TEXT NOT NULL,
        primary_cnae_code TEXT NOT NULL,
        primary_cnae_description TEXT NOT NULL,
        municipality TEXT NOT NULL,
        uf TEXT NOT NULL,
        share_capital REAL NOT NULL DEFAULT 0,
        qsa_json TEXT NOT NULL DEFAULT '[]',
        source_provider TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_supplier_qsa_fetched_at
        ON supplier_qsa_cache(fetched_at);
    `);

    db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
    ).run(4, 'supplier_qsa_cache_partner_network', new Date().toISOString());
  }

  // Additive migration v5: Official reference snapshots (SIAPS, SINAPI, Camara daily personnel) with SHA-256 idempotency
  const v5Check = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number };

  if (v5Check.version < 5) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS official_reference_snapshots (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('siaps', 'sinapi', 'camara_personnel')),
        filename TEXT NOT NULL,
        sha256 TEXT NOT NULL UNIQUE,
        competencia TEXT NOT NULL,
        uf TEXT,
        metadata_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        imported_by TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_official_snapshots_kind
        ON official_reference_snapshots(source_kind, imported_at);
    `);

    db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
    ).run(5, 'official_reference_snapshots_siaps_sinapi_camara', new Date().toISOString());
  }

  // Additive migration v6: Support 'inep' source_kind and composite idempotency (source_kind, sha256, competencia, uf_norm)
  const v6Check = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number };

  if (v6Check.version < 6) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE official_reference_snapshots_v6 (
          id TEXT PRIMARY KEY,
          source_kind TEXT NOT NULL CHECK(source_kind IN ('siaps', 'sinapi', 'camara_personnel', 'inep')),
          filename TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          competencia TEXT NOT NULL,
          uf TEXT,
          uf_norm TEXT NOT NULL DEFAULT '',
          metadata_json TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          imported_by TEXT NOT NULL,
          imported_at TEXT NOT NULL,
          UNIQUE(source_kind, sha256, competencia, uf_norm)
        );

        INSERT INTO official_reference_snapshots_v6 (
          id, source_kind, filename, sha256, competencia, uf, uf_norm,
          metadata_json, payload_json, imported_by, imported_at
        )
        SELECT
          id,
          source_kind,
          filename,
          sha256,
          competencia,
          uf,
          COALESCE(UPPER(TRIM(uf)), ''),
          metadata_json,
          payload_json,
          imported_by,
          imported_at
        FROM official_reference_snapshots;

        DROP TABLE official_reference_snapshots;
        ALTER TABLE official_reference_snapshots_v6 RENAME TO official_reference_snapshots;

        CREATE INDEX IF NOT EXISTS idx_official_snapshots_kind
          ON official_reference_snapshots(source_kind, imported_at);
        CREATE INDEX IF NOT EXISTS idx_official_snapshots_sha
          ON official_reference_snapshots(sha256);
      `);

      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
      ).run(6, 'official_reference_snapshots_inep_and_composite_idempotency', new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // Additive migration v7:
  //  - Defect 1.8: Explicit separate publication_date, submission_date, and lifecycle_events_json columns on contracts
  //  - Defect 1.2: Content-hash deduplication UNIQUE(sha256_digest) on saved_dossiers so identical snapshots are NEVER replicated
  const v7Check = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number };

  if (v7Check.version < 7) {
    db.exec('BEGIN IMMEDIATE');
    try {
      safeAddColumn(db, 'contracts', 'publication_date TEXT');
      safeAddColumn(db, 'contracts', 'submission_date TEXT');
      safeAddColumn(db, 'contracts', 'lifecycle_events_json TEXT');

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_contracts_publication_date ON contracts(publication_date);
        CREATE INDEX IF NOT EXISTS idx_contracts_submission_date ON contracts(submission_date);

        CREATE TABLE saved_dossiers_v7 (
          id TEXT PRIMARY KEY,
          contract_id TEXT NOT NULL,
          contract_number TEXT NOT NULL,
          municipality_name TEXT NOT NULL,
          municipality_ibge TEXT NOT NULL,
          entity_name TEXT NOT NULL,
          supplier_name TEXT NOT NULL,
          risk_score INTEGER NOT NULL,
          saved_at TEXT NOT NULL,
          analyst_note TEXT NOT NULL,
          sha256_digest TEXT NOT NULL UNIQUE,
          snapshot_json TEXT
        );

        INSERT INTO saved_dossiers_v7 (
          id, contract_id, contract_number, municipality_name, municipality_ibge,
          entity_name, supplier_name, risk_score, saved_at, analyst_note, sha256_digest, snapshot_json
        )
        SELECT
          id, contract_id, contract_number, municipality_name, municipality_ibge,
          entity_name, supplier_name, risk_score, saved_at, analyst_note, sha256_digest, snapshot_json
        FROM saved_dossiers
        WHERE rowid IN (
          SELECT MIN(rowid) FROM saved_dossiers GROUP BY sha256_digest
        );

        DROP TABLE saved_dossiers;
        ALTER TABLE saved_dossiers_v7 RENAME TO saved_dossiers;

        CREATE INDEX IF NOT EXISTS idx_saved_dossiers_contract ON saved_dossiers(contract_id, saved_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_dossiers_sha256 ON saved_dossiers(sha256_digest);
      `);

      // Backfill explicit publication_date, submission_date, and lifecycle_events_json on existing contracts rows
      const existingContracts = db
        .prepare('SELECT id, payload_json FROM contracts')
        .all() as Array<{ id: string; payload_json: string }>;
      const stmtBackfillContractDates = db.prepare(
        'UPDATE contracts SET publication_date = ?, submission_date = ?, lifecycle_events_json = ? WHERE id = ?'
      );
      for (const row of existingContracts) {
        try {
          const parsed = JSON.parse(row.payload_json) as ContractRecord;
          const distinct = extractDistinctContractDates(parsed);
          stmtBackfillContractDates.run(
            distinct.publicationDate,
            distinct.submissionDate,
            distinct.events.length > 0 ? JSON.stringify(distinct.events) : null,
            row.id
          );
        } catch {
          // Ignore malformed legacy rows
        }
      }

      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
      ).run(7, 'contract_lifecycle_dates_and_dossier_hash_dedup', new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const stmtInsertOfficialSnapshot = db.prepare(`
    INSERT INTO official_reference_snapshots (
      id, source_kind, filename, sha256, competencia, uf, uf_norm,
      metadata_json, payload_json, imported_by, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtGetOfficialSnapshotByCompositeKey = db.prepare(`
    SELECT id
    FROM official_reference_snapshots
    WHERE source_kind = ? AND sha256 = ? AND competencia = ? AND uf_norm = ?
  `);
  const stmtGetOfficialSnapshotById = db.prepare(`
    SELECT id, source_kind, sha256, competencia, uf
    FROM official_reference_snapshots
    WHERE id = ?
  `);
  const stmtListOfficialSnapshotsAll = db.prepare(`
    SELECT id, source_kind, filename, sha256, competencia, uf, metadata_json, imported_by, imported_at
    FROM official_reference_snapshots
    ORDER BY imported_at DESC
    LIMIT 100
  `);
  const stmtListOfficialSnapshotsByKind = db.prepare(`
    SELECT id, source_kind, filename, sha256, competencia, uf, metadata_json, imported_by, imported_at
    FROM official_reference_snapshots
    WHERE source_kind = ?
    ORDER BY imported_at DESC
    LIMIT 100
  `);

  const stmtUpsertSupplierQsa = db.prepare(`
    INSERT INTO supplier_qsa_cache (
      cnpj, legal_name, registration_status, opening_date,
      primary_cnae_code, primary_cnae_description, municipality, uf,
      share_capital, qsa_json, source_provider, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cnpj) DO UPDATE SET
      legal_name = excluded.legal_name,
      registration_status = excluded.registration_status,
      opening_date = excluded.opening_date,
      primary_cnae_code = excluded.primary_cnae_code,
      primary_cnae_description = excluded.primary_cnae_description,
      municipality = excluded.municipality,
      uf = excluded.uf,
      share_capital = excluded.share_capital,
      qsa_json = excluded.qsa_json,
      source_provider = excluded.source_provider,
      fetched_at = excluded.fetched_at
  `);

  const stmtGetSupplierQsa = db.prepare(`
    SELECT cnpj, legal_name, registration_status, opening_date,
           primary_cnae_code, primary_cnae_description, municipality, uf,
           share_capital, qsa_json, source_provider, fetched_at
    FROM supplier_qsa_cache
    WHERE cnpj = ?
  `);

  const stmtListAllSupplierQsa = db.prepare(`
    SELECT cnpj, legal_name, registration_status, opening_date,
           primary_cnae_code, primary_cnae_description, municipality, uf,
           share_capital, qsa_json, source_provider, fetched_at
    FROM supplier_qsa_cache
    ORDER BY fetched_at DESC
  `);

  function mapSupplierQsaRow(row: Record<string, unknown>): SupplierQsaRecord {
    let shareholders: SupplierQsaShareholder[] = [];
    try {
      const parsed = JSON.parse(String(row.qsa_json ?? '[]'));
      if (Array.isArray(parsed)) shareholders = parsed as SupplierQsaShareholder[];
    } catch {
      shareholders = [];
    }
    return {
      cnpj: String(row.cnpj ?? ''),
      legalName: String(row.legal_name ?? ''),
      registrationStatus: String(row.registration_status ?? 'DESCONHECIDA'),
      openingDate: String(row.opening_date ?? ''),
      primaryCnaeCode: String(row.primary_cnae_code ?? ''),
      primaryCnaeDescription: String(row.primary_cnae_description ?? ''),
      municipality: String(row.municipality ?? ''),
      uf: String(row.uf ?? ''),
      shareCapital: Number(row.share_capital ?? 0),
      shareholders,
      sourceProvider: String(row.source_provider ?? 'BrasilAPI CNPJ'),
      fetchedAt: String(row.fetched_at ?? ''),
    };
  }

  const stmtUpsertContract = db.prepare(`
    INSERT INTO contracts (
      id, pncp_control_number, contract_number, municipality_ibge, supplier_cnpj,
      cnpj_role, year, data_source_origin, publication_date, submission_date, lifecycle_events_json,
      payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      pncp_control_number = excluded.pncp_control_number,
      contract_number = excluded.contract_number,
      municipality_ibge = excluded.municipality_ibge,
      supplier_cnpj = excluded.supplier_cnpj,
      cnpj_role = excluded.cnpj_role,
      year = excluded.year,
      data_source_origin = excluded.data_source_origin,
      publication_date = excluded.publication_date,
      submission_date = excluded.submission_date,
      lifecycle_events_json = excluded.lifecycle_events_json,
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
           entity_name, supplier_name, risk_score, saved_at, analyst_note, sha256_digest,
           CASE WHEN snapshot_json IS NOT NULL AND length(snapshot_json) > 2 THEN 1 ELSE 0 END AS has_snapshot
    FROM saved_dossiers
    ORDER BY saved_at DESC
  `);

  const stmtGetDossierById = db.prepare(`
    SELECT id, contract_id, contract_number, municipality_name, municipality_ibge,
           entity_name, supplier_name, risk_score, saved_at, analyst_note, sha256_digest, snapshot_json
    FROM saved_dossiers
    WHERE id = ?
  `);

  const stmtGetDossierByHash = db.prepare(`
    SELECT id, contract_id, contract_number, municipality_name, municipality_ibge,
           entity_name, supplier_name, risk_score, saved_at, analyst_note, sha256_digest,
           CASE WHEN snapshot_json IS NOT NULL AND length(snapshot_json) > 2 THEN 1 ELSE 0 END AS has_snapshot
    FROM saved_dossiers
    WHERE sha256_digest = ?
  `);

  const stmtListDossierSnapshotsByContract = db.prepare(`
    SELECT id, contract_id, contract_number, municipality_name, municipality_ibge,
           entity_name, supplier_name, risk_score, saved_at, analyst_note, sha256_digest, snapshot_json
    FROM saved_dossiers
    WHERE contract_id = ?
    ORDER BY saved_at ASC
  `);

  const stmtInsertDossier = db.prepare(`
    INSERT INTO saved_dossiers (
      id, contract_id, contract_number, municipality_name, municipality_ibge,
      entity_name, supplier_name, risk_score, saved_at, analyst_note, sha256_digest, snapshot_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stmtDeleteDossier = db.prepare('DELETE FROM saved_dossiers WHERE id = ?');

  const stmtInsertReview = db.prepare(`
    INSERT INTO finding_reviews (
      id, contract_id, finding_id, action, author, actor_id, actor_role, rationale, rule_version, finding_inputs_digest, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stmtListReviewsForContract = db.prepare(`
    SELECT id, contract_id, finding_id, action, author, actor_id, actor_role, rationale, rule_version, finding_inputs_digest, created_at
    FROM finding_reviews
    WHERE contract_id = ?
    ORDER BY created_at ASC
  `);

  const stmtListAllReviews = db.prepare(`
    SELECT id, contract_id, finding_id, action, author, actor_id, actor_role, rationale, rule_version, finding_inputs_digest, created_at
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
    SELECT sha256, filename, mime_type, size_bytes, contract_id, extractor_version,
           page_count, original_page_count, truncated, object_key, full_text, pages_json, created_at
    FROM document_artifacts
    WHERE sha256 = ?
  `);

  const stmtInsertArtifact = db.prepare(`
    INSERT INTO document_artifacts (
      sha256, filename, mime_type, size_bytes, contract_id, extractor_version,
      page_count, original_page_count, truncated, object_key, full_text, pages_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sha256) DO UPDATE SET
      contract_id = COALESCE(excluded.contract_id, document_artifacts.contract_id),
      object_key = COALESCE(excluded.object_key, document_artifacts.object_key),
      full_text = COALESCE(excluded.full_text, document_artifacts.full_text),
      pages_json = COALESCE(excluded.pages_json, document_artifacts.pages_json),
      original_page_count = COALESCE(excluded.original_page_count, document_artifacts.original_page_count),
      truncated = COALESCE(excluded.truncated, document_artifacts.truncated)
  `);

  const stmtListArtifactsForContract = db.prepare(`
    SELECT sha256, filename, mime_type, size_bytes, contract_id, extractor_version,
           page_count, original_page_count, truncated, object_key, full_text, pages_json, created_at
    FROM document_artifacts
    WHERE contract_id = ?
    ORDER BY created_at DESC
  `);

  const stmtCountUsers = db.prepare('SELECT COUNT(*) AS cnt FROM users');
  const stmtInsertUser = db.prepare(`
    INSERT INTO users (id, email, display_name, role, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const stmtGetUserByEmail = db.prepare(`
    SELECT id, email, display_name, role, password_hash, created_at
    FROM users
    WHERE lower(email) = lower(?)
  `);
  const stmtListUsers = db.prepare(`
    SELECT id, email, display_name, role, created_at
    FROM users
    ORDER BY created_at ASC
  `);

  function resolveSafeObjectPath(sha256: string): { objectKey: string; absPath: string } {
    const cleanSha = sha256.trim().toLowerCase();
    if (!SHA256_RE.test(cleanSha)) {
      throw new Error('SHA-256 inválido para armazenamento de documento.');
    }
    const prefix = cleanSha.slice(0, 2);
    const objectKey = `${prefix}/${cleanSha}`;
    const absPath = path.resolve(objectsDir, prefix, cleanSha);
    if (!absPath.startsWith(objectsDir + path.sep)) {
      throw new Error('Caminho de objeto fora do diretório confinado.');
    }
    return { objectKey, absPath };
  }

  function resolveSafePrivateEvidencePath(sha256: string): { objectKey: string; absPath: string } {
    const cleanSha = sha256.trim().toLowerCase();
    if (!SHA256_RE.test(cleanSha)) {
      throw new Error('SHA-256 inválido para armazenamento de evidência privada.');
    }
    const prefix = cleanSha.slice(0, 2);
    const objectKey = `${prefix}/${cleanSha}`;
    const absPath = path.resolve(privateEvidenceDir, prefix, cleanSha);
    if (!absPath.startsWith(privateEvidenceDir + path.sep)) {
      throw new Error('Caminho de evidência privada fora do diretório confinado.');
    }
    return { objectKey, absPath };
  }

  const stmtGetInvCase = db.prepare(`
    SELECT contract_id, facts_version, facts_json, cadastral_extracts_json,
           observed_history_json, created_at, updated_at, updated_by
    FROM investigation_cases
    WHERE contract_id = ?
  `);

  const stmtInsertInvCase = db.prepare(`
    INSERT INTO investigation_cases (
      contract_id, facts_version, facts_json, cadastral_extracts_json,
      observed_history_json, created_at, updated_at, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stmtUpdateInvCadastral = db.prepare(`
    UPDATE investigation_cases
    SET cadastral_extracts_json = ?, updated_at = ?, updated_by = ?
    WHERE contract_id = ?
  `);

  const stmtUpdateInvObservedHistory = db.prepare(`
    UPDATE investigation_cases
    SET observed_history_json = ?, updated_at = ?, updated_by = ?
    WHERE contract_id = ?
  `);

  const stmtUpdateInvFactsOptimistic = db.prepare(`
    UPDATE investigation_cases
    SET facts_version = ?, facts_json = ?, updated_at = ?, updated_by = ?
    WHERE contract_id = ? AND facts_version = ?
  `);

  const stmtInsertInvPrivateEvidence = db.prepare(`
    INSERT INTO investigation_private_evidence (
      id, contract_id, sha256, filename, mime_type, size_bytes,
      source_label, description, acquired_at, uploaded_by,
      export_filename, object_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stmtListInvPrivateEvidence = db.prepare(`
    SELECT id, contract_id, sha256, filename, mime_type, size_bytes,
           source_label, description, acquired_at, uploaded_by, export_filename
    FROM investigation_private_evidence
    WHERE contract_id = ?
    ORDER BY created_at ASC
  `);

  const stmtGetInvPrivateEvidenceById = db.prepare(`
    SELECT id, contract_id, sha256, filename, mime_type, size_bytes,
           source_label, description, acquired_at, uploaded_by, export_filename
    FROM investigation_private_evidence
    WHERE contract_id = ? AND id = ?
  `);

  const stmtInsertInvReview = db.prepare(`
    INSERT INTO investigation_reviews (
      id, contract_id, finding_id, action, rationale,
      facts_version, finding_inputs_digest, actor_id, actor_name, actor_role, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stmtListInvReviews = db.prepare(`
    SELECT id, contract_id, finding_id, action, rationale,
           facts_version, finding_inputs_digest, actor_id, actor_name, actor_role, created_at
    FROM investigation_reviews
    WHERE contract_id = ?
    ORDER BY created_at ASC
  `);

  const stmtGetLastInvEventHash = db.prepare(`
    SELECT event_hash
    FROM investigation_events
    WHERE contract_id = ?
    ORDER BY seq DESC
    LIMIT 1
  `);

  const stmtInsertInvEvent = db.prepare(`
    INSERT INTO investigation_events (
      id, contract_id, event_type, actor_id, actor_name, actor_role,
      facts_version, payload_json, prev_hash, event_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stmtListInvEvents = db.prepare(`
    SELECT seq, id, contract_id, event_type, actor_id, actor_name, actor_role,
           facts_version, payload_json, prev_hash, event_hash, created_at
    FROM investigation_events
    WHERE contract_id = ?
    ORDER BY seq ASC
  `);

  function appendInvEventTx(
    contractId: string,
    eventType: InvestigationEventRecord['eventType'],
    factsVersion: number,
    payload: Record<string, unknown>,
    actor: InvestigationActor
  ): void {
    const last = stmtGetLastInvEventHash.get(contractId) as { event_hash: string } | undefined;
    const prevHash = last?.event_hash ?? 'GENESIS';
    const id = `IEV-${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    const payloadJson = JSON.stringify(payload);
    const eventHash = computeEventChainHash({
      id,
      contractId,
      eventType,
      actorId: actor.actorId,
      actorName: actor.actorName,
      actorRole: actor.actorRole,
      factsVersion,
      payloadJson,
      prevHash,
      createdAt,
    });
    stmtInsertInvEvent.run(
      id,
      contractId,
      eventType,
      actor.actorId,
      actor.actorName,
      actor.actorRole,
      factsVersion,
      payloadJson,
      prevHash,
      eventHash,
      createdAt
    );
  }

  function mapPrivateEvidenceRow(r: Record<string, unknown>): PrivateEvidenceRecord {
    return {
      id: String(r.id),
      contractId: String(r.contract_id),
      sha256: String(r.sha256),
      filename: String(r.filename),
      mimeType: String(r.mime_type),
      sizeBytes: Number(r.size_bytes),
      sourceLabel: String(r.source_label),
      description: String(r.description),
      acquiredAt: String(r.acquired_at),
      uploadedBy: String(r.uploaded_by),
      exportFilename: String(r.export_filename),
    };
  }

  function mapInvReviewRow(r: Record<string, unknown>): InvestigationReviewRecord {
    return {
      id: String(r.id),
      contractId: String(r.contract_id),
      findingId: String(r.finding_id),
      action: r.action as InvestigationReviewRecord['action'],
      rationale: String(r.rationale),
      factsVersion: Number(r.facts_version),
      findingInputsDigest: String(r.finding_inputs_digest),
      actorId: String(r.actor_id),
      actorName: String(r.actor_name),
      actorRole: r.actor_role as InvestigationReviewRecord['actorRole'],
      createdAt: String(r.created_at),
    };
  }

  function mapInvEventRow(r: Record<string, unknown>): InvestigationEventRecord {
    return {
      seq: Number(r.seq),
      id: String(r.id),
      contractId: String(r.contract_id),
      eventType: r.event_type as InvestigationEventRecord['eventType'],
      actorId: String(r.actor_id),
      actorName: String(r.actor_name),
      actorRole: r.actor_role as InvestigationEventRecord['actorRole'],
      factsVersion: Number(r.facts_version),
      payloadJson: String(r.payload_json),
      prevHash: String(r.prev_hash),
      eventHash: String(r.event_hash),
      createdAt: String(r.created_at),
    };
  }

  function ensureInvestigationCaseRow(
    contractId: string,
    actor: InvestigationActor
  ): Record<string, unknown> {
    const existing = stmtGetInvCase.get(contractId) as Record<string, unknown> | undefined;
    if (existing) return existing;

    const now = new Date().toISOString();
    const initialFacts = createEmptyFactSet(actor.actorName);
    initialFacts.updatedAt = now;

    db.exec('BEGIN IMMEDIATE');
    try {
      const doubleCheck = stmtGetInvCase.get(contractId) as Record<string, unknown> | undefined;
      if (doubleCheck) {
        db.exec('COMMIT');
        return doubleCheck;
      }
      stmtInsertInvCase.run(
        contractId,
        1,
        JSON.stringify(initialFacts),
        '[]',
        null,
        now,
        now,
        actor.actorName
      );
      appendInvEventTx(
        contractId,
        'CASE_INITIALIZED',
        1,
        {
          message: 'Caso de investigação forense inicializado.',
          factsSnapshotDigest: computeFactSetDigest(initialFacts),
        },
        actor
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    return stmtGetInvCase.get(contractId) as Record<string, unknown>;
  }

  function hydrateInvestigationCase(
    contractId: string,
    actor: InvestigationActor
  ): StoredInvestigationCase {
    const row = ensureInvestigationCaseRow(contractId, actor);
    const factSet = JSON.parse(String(row.facts_json)) as InvestigationFactSet;
    const cadastralExtracts = JSON.parse(
      String(row.cadastral_extracts_json || '[]')
    ) as CadastralMinimizedExtract[];
    const observedHistory =
      typeof row.observed_history_json === 'string' && row.observed_history_json.trim()
        ? (JSON.parse(row.observed_history_json) as ObservedHistorySnapshot)
        : null;
    const privateEvidence = (
      stmtListInvPrivateEvidence.all(contractId) as Array<Record<string, unknown>>
    ).map(mapPrivateEvidenceRow);
    const reviews = (
      stmtListInvReviews.all(contractId) as Array<Record<string, unknown>>
    ).map(mapInvReviewRow);
    const events = (
      stmtListInvEvents.all(contractId) as Array<Record<string, unknown>>
    ).map(mapInvEventRow);

    return {
      contractId,
      factSet,
      cadastralExtracts,
      observedHistory,
      privateEvidence,
      reviews,
      events,
    };
  }

  function sanitizeExportFilenamePart(filename: string): string {
    const base = path.basename(filename || 'evidencia.bin');
    const clean = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    return (clean || 'evidencia.bin').slice(0, 120);
  }

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
      hasSnapshot: Boolean(r.has_snapshot ?? r.snapshot_json),
    };
  }

  function mapReviewRow(r: Record<string, unknown>): FindingReviewRecord {
    return {
      id: String(r.id),
      contractId: String(r.contract_id),
      findingId: String(r.finding_id),
      action: r.action === 'restore' ? 'restore' : 'dismiss',
      author: String(r.author),
      actorId: r.actor_id ? String(r.actor_id) : undefined,
      actorRole: r.actor_role ? String(r.actor_role) : undefined,
      rationale: String(r.rationale),
      ruleVersion: String(r.rule_version),
      findingInputsDigest: r.finding_inputs_digest ? String(r.finding_inputs_digest) : undefined,
      createdAt: String(r.created_at),
    };
  }

  function mapArtifactRow(r: Record<string, unknown>): DocumentArtifactRecord {
    let parsedPages: DocumentPage[] | undefined;
    if (typeof r.pages_json === 'string' && r.pages_json.trim()) {
      try {
        parsedPages = JSON.parse(r.pages_json) as DocumentPage[];
      } catch {
        parsedPages = undefined;
      }
    }
    return {
      sha256: String(r.sha256),
      filename: String(r.filename),
      mimeType: String(r.mime_type),
      sizeBytes: Number(r.size_bytes),
      contractId: r.contract_id ? String(r.contract_id) : null,
      extractorVersion: String(r.extractor_version),
      pageCount: Number(r.page_count),
      originalPageCount: r.original_page_count !== null && r.original_page_count !== undefined
        ? Number(r.original_page_count)
        : Number(r.page_count),
      truncated: Boolean(r.truncated),
      objectKey: r.object_key ? String(r.object_key) : null,
      fullText: typeof r.full_text === 'string' ? r.full_text : null,
      pages: parsedPages,
      createdAt: String(r.created_at),
    };
  }

  return {
    dbPath: resolvedDbPath,
    objectsDir,
    privateEvidenceDir,
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
      const distinctDates = extractDistinctContractDates(contract);
      const normalizedContract: ContractRecord = {
        ...contract,
        publicationDate: distinctDates.publicationDate,
        submissionDate: distinctDates.submissionDate,
        submissionWindowStart: distinctDates.submissionWindowStart,
        submissionWindowEnd: distinctDates.submissionWindowEnd,
        lifecycleEvents: distinctDates.events,
      };
      stmtUpsertContract.run(
        normalizedContract.id,
        normalizedContract.pncpControlNumber ?? '',
        normalizedContract.contractNumber ?? '',
        normalizedContract.municipalityIbge ?? '',
        normalizedContract.supplier?.cnpj ?? '',
        normalizedContract.cnpjRole ?? null,
        normalizedContract.year ?? new Date().getUTCFullYear(),
        normalizedContract.dataSourceOrigin ?? 'Índice Local',
        distinctDates.publicationDate,
        distinctDates.submissionDate,
        distinctDates.events.length > 0 ? JSON.stringify(distinctDates.events) : null,
        JSON.stringify(normalizedContract),
        new Date().toISOString()
      );
    },
    upsertContracts(contracts: ContractRecord[]) {
      const now = new Date().toISOString();
      db.exec('BEGIN');
      try {
        for (const contract of contracts) {
          const distinctDates = extractDistinctContractDates(contract);
          const normalizedContract: ContractRecord = {
            ...contract,
            publicationDate: distinctDates.publicationDate,
            submissionDate: distinctDates.submissionDate,
            submissionWindowStart: distinctDates.submissionWindowStart,
            submissionWindowEnd: distinctDates.submissionWindowEnd,
            lifecycleEvents: distinctDates.events,
          };
          stmtUpsertContract.run(
            normalizedContract.id,
            normalizedContract.pncpControlNumber,
            normalizedContract.contractNumber,
            normalizedContract.municipalityIbge,
            normalizedContract.supplier.cnpj,
            normalizedContract.cnpjRole ?? null,
            normalizedContract.year,
            normalizedContract.dataSourceOrigin,
            distinctDates.publicationDate,
            distinctDates.submissionDate,
            distinctDates.events.length > 0 ? JSON.stringify(distinctDates.events) : null,
            JSON.stringify(normalizedContract),
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
    getDossierById(id: string) {
      const row = stmtGetDossierById.get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      const summary = mapDossierRow(row);
      let snapshotContract: EvaluatedContract | null = null;
      let snapshotReviews: FindingReviewRecord[] = [];
      if (typeof row.snapshot_json === 'string' && row.snapshot_json.trim()) {
        try {
          const parsed = JSON.parse(row.snapshot_json) as {
            contract?: EvaluatedContract;
            reviews?: FindingReviewRecord[];
          };
          snapshotContract = parsed.contract ?? null;
          snapshotReviews = Array.isArray(parsed.reviews) ? parsed.reviews : [];
        } catch {
          snapshotContract = null;
          snapshotReviews = [];
        }
      }
      return {
        ...summary,
        snapshotContract,
        snapshotReviews,
      };
    },
    getDossierByHash(sha256Digest: string) {
      const cleanHash = sha256Digest.trim().toLowerCase();
      if (!cleanHash) return null;
      const row = stmtGetDossierByHash.get(cleanHash) as Record<string, unknown> | undefined;
      return row ? mapDossierRow(row) : null;
    },
    saveDossierWithDedup(
      dossier: SavedDossierSummary,
      snapshot?: { contract: EvaluatedContract; reviews: FindingReviewRecord[] }
    ) {
      // Defect 1.2: Always verify/compute canonical content hash on the backend so identical dossier
      // snapshots cannot be replicated even across different timestamps, IDs, or client-supplied digests.
      const verifiedContentHash = snapshot
        ? computeCanonicalDossierSnapshotHash({
            contractId: dossier.contractId,
            contract: snapshot.contract,
            reviews: snapshot.reviews,
            analystNote: dossier.analystNote,
          })
        : dossier.sha256Digest.trim().toLowerCase() ||
          crypto
            .createHash('sha256')
            .update(
              JSON.stringify({
                contractId: dossier.contractId,
                contractNumber: dossier.contractNumber,
                riskScore: dossier.riskScore,
                analystNote: dossier.analystNote.trim(),
              })
            )
            .digest('hex');

      const existing = stmtGetDossierByHash.get(verifiedContentHash) as Record<string, unknown> | undefined;
      if (existing) {
        return {
          dossier: mapDossierRow(existing),
          dossiers: this.listDossiers(),
          deduplicated: true,
          contentHash: verifiedContentHash,
        };
      }

      // Deep pre-persistence comparison: also verify canonical SHA-256 against any previously stored
      // snapshots for the same contract (protects against duplicating pre-v7 legacy rows whose stored
      // digest included volatile evaluatedAt timestamps).
      if (snapshot) {
        const contractRows = stmtListDossierSnapshotsByContract.all(dossier.contractId) as Array<
          Record<string, unknown>
        >;
        for (const row of contractRows) {
          if (typeof row.snapshot_json !== 'string' || !row.snapshot_json.trim()) continue;
          try {
            const parsed = JSON.parse(row.snapshot_json) as {
              contract?: EvaluatedContract;
              reviews?: FindingReviewRecord[];
            };
            if (!parsed.contract) continue;
            const storedCanonicalHash = computeCanonicalDossierSnapshotHash({
              contractId: String(row.contract_id),
              contract: parsed.contract,
              reviews: Array.isArray(parsed.reviews) ? parsed.reviews : [],
              analystNote: String(row.analyst_note ?? ''),
            });
            if (storedCanonicalHash === verifiedContentHash) {
              return {
                dossier: mapDossierRow(row),
                dossiers: this.listDossiers(),
                deduplicated: true,
                contentHash: verifiedContentHash,
              };
            }
          } catch {
            // Skip unreadable legacy JSON
          }
        }
      }

      const snapshotJson = snapshot ? JSON.stringify(snapshot) : null;
      try {
        const res = stmtInsertDossier.run(
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
          verifiedContentHash,
          snapshotJson
        );
        if (Number(res.changes) !== 1) {
          throw new Error(
            `Persistência do snapshot de dossiê falhou: nenhuma linha gravada (id=${dossier.id}).`
          );
        }
      } catch (err) {
        // Handle concurrent race on UNIQUE(sha256_digest) cleanly as idempotent deduplication
        const concurrentExisting = stmtGetDossierByHash.get(verifiedContentHash) as
          | Record<string, unknown>
          | undefined;
        if (concurrentExisting) {
          return {
            dossier: mapDossierRow(concurrentExisting),
            dossiers: this.listDossiers(),
            deduplicated: true,
            contentHash: verifiedContentHash,
          };
        }
        throw err;
      }

      const verifiedRow = stmtGetDossierById.get(dossier.id) as Record<string, unknown> | undefined;
      if (!verifiedRow) {
        throw new Error(`Releitura pós-gravação do dossiê falhou (id=${dossier.id}).`);
      }

      return {
        dossier: mapDossierRow(verifiedRow),
        dossiers: this.listDossiers(),
        deduplicated: false,
        contentHash: verifiedContentHash,
      };
    },
    saveDossier(dossier: SavedDossierSummary, snapshot?: { contract: EvaluatedContract; reviews: FindingReviewRecord[] }) {
      return this.saveDossierWithDedup(dossier, snapshot).dossiers;
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
        review.actorId ?? null,
        review.actorRole ?? null,
        review.rationale,
        review.ruleVersion,
        review.findingInputsDigest ?? null,
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
      stmtInsertArtifact.run(
        artifact.sha256,
        artifact.filename,
        artifact.mimeType,
        artifact.sizeBytes,
        artifact.contractId,
        artifact.extractorVersion,
        artifact.pageCount,
        artifact.originalPageCount ?? artifact.pageCount,
        artifact.truncated ? 1 : 0,
        artifact.objectKey ?? null,
        artifact.fullText ?? null,
        artifact.pages ? JSON.stringify(artifact.pages) : null,
        artifact.createdAt
      );
      return { alreadyExisted: Boolean(existing) };
    },
    getDocumentArtifactBySha256(sha256: string) {
      const row = stmtGetArtifact.get(sha256) as Record<string, unknown> | undefined;
      return row ? mapArtifactRow(row) : null;
    },
    listDocumentArtifactsForContract(contractId: string) {
      const rows = stmtListArtifactsForContract.all(contractId) as Array<Record<string, unknown>>;
      return rows.map(mapArtifactRow);
    },
    saveOriginalDocumentBytes(sha256: string, bytes: Buffer) {
      const computed = crypto.createHash('sha256').update(bytes).digest('hex');
      const expected = sha256.trim().toLowerCase();
      if (computed !== expected) {
        throw new Error('Divergência de integridade SHA-256 ao gravar documento original.');
      }
      const { objectKey, absPath } = resolveSafeObjectPath(expected);
      const subDir = path.dirname(absPath);
      if (!fs.existsSync(subDir)) {
        fs.mkdirSync(subDir, { recursive: true });
      }
      if (!fs.existsSync(absPath)) {
        const tmpPath = `${absPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, bytes);
        fs.renameSync(tmpPath, absPath);
      }
      return { objectKey, verified: true };
    },
    readOriginalDocumentBytes(sha256: string) {
      let absPath: string;
      try {
        absPath = resolveSafeObjectPath(sha256).absPath;
      } catch {
        return null;
      }
      if (!fs.existsSync(absPath)) return null;
      const bytes = fs.readFileSync(absPath);
      const computed = crypto.createHash('sha256').update(bytes).digest('hex');
      return {
        bytes,
        verified: computed === sha256.trim().toLowerCase(),
      };
    },
    countUsers() {
      const row = stmtCountUsers.get() as { cnt: number };
      return Number(row.cnt);
    },
    createUser(user: NexofisUserRecord) {
      stmtInsertUser.run(
        user.id,
        user.email.trim().toLowerCase(),
        user.displayName.trim(),
        user.role,
        user.passwordHash,
        user.createdAt
      );
      return user;
    },
    getUserByEmail(email: string) {
      const row = stmtGetUserByEmail.get(email.trim().toLowerCase()) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: String(row.id),
        email: String(row.email),
        displayName: String(row.display_name),
        role: row.role as NexofisUserRecord['role'],
        passwordHash: String(row.password_hash),
        createdAt: String(row.created_at),
      };
    },
    listUsers() {
      const rows = stmtListUsers.all() as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: String(row.id),
        email: String(row.email),
        displayName: String(row.display_name),
        role: row.role as NexofisUserRecord['role'],
        createdAt: String(row.created_at),
      }));
    },
    getOrCreateInvestigationCase(contractId: string, actor: InvestigationActor) {
      return hydrateInvestigationCase(contractId, actor);
    },
    appendCadastralExtract(
      contractId: string,
      extract: CadastralMinimizedExtract,
      actor: InvestigationActor
    ) {
      ensureInvestigationCaseRow(contractId, actor);
      const now = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = stmtGetInvCase.get(contractId) as Record<string, unknown>;
        const existing = JSON.parse(
          String(row.cadastral_extracts_json || '[]')
        ) as CadastralMinimizedExtract[];
        const nextList = [...existing, extract];
        stmtUpdateInvCadastral.run(JSON.stringify(nextList), now, actor.actorName, contractId);
        appendInvEventTx(
          contractId,
          'CADASTRAL_QUERY_RECORDED',
          Number(row.facts_version),
          {
            extractId: extract.id,
            cnpj: extract.cnpj,
            sourceProvider: extract.sourceProvider,
            sourceType: extract.sourceType,
            purpose: extract.purpose,
            legalBasis: extract.legalBasis,
            extractSha256: extract.extractSha256,
            qsaCount: extract.qsa.length,
          },
          actor
        );
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return hydrateInvestigationCase(contractId, actor);
    },
    saveObservedHistory(
      contractId: string,
      snapshot: ObservedHistorySnapshot,
      actor: InvestigationActor
    ) {
      ensureInvestigationCaseRow(contractId, actor);
      const now = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = stmtGetInvCase.get(contractId) as Record<string, unknown>;
        stmtUpdateInvObservedHistory.run(
          JSON.stringify(snapshot),
          now,
          actor.actorName,
          contractId
        );
        appendInvEventTx(
          contractId,
          'PNCP_HISTORY_SYNCED',
          Number(row.facts_version),
          {
            supplierCnpj: snapshot.supplierCnpj,
            pncpStatus: snapshot.pncpStatus,
            sourcesChecked: snapshot.sourcesChecked,
            contractsObservedCount: snapshot.contracts.length,
          },
          actor
        );
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return hydrateInvestigationCase(contractId, actor);
    },
    saveInvestigationFactSet(
      contractId: string,
      expectedVersion: number,
      factsPayload: Omit<InvestigationFactSet, 'version' | 'updatedAt' | 'updatedBy'>,
      actor: InvestigationActor
    ) {
      ensureInvestigationCaseRow(contractId, actor);
      const now = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = stmtGetInvCase.get(contractId) as Record<string, unknown>;
        const currentVersion = Number(row.facts_version);
        if (currentVersion !== expectedVersion) {
          db.exec('ROLLBACK');
          throw new InvestigationVersionConflictError(expectedVersion, currentVersion);
        }
        const nextVersion = currentVersion + 1;
        const nextFactSet: InvestigationFactSet = {
          ...factsPayload,
          version: nextVersion,
          updatedAt: now,
          updatedBy: actor.actorName,
        };
        const res = stmtUpdateInvFactsOptimistic.run(
          nextVersion,
          JSON.stringify(nextFactSet),
          now,
          actor.actorName,
          contractId,
          expectedVersion
        );
        if (Number(res.changes) === 0) {
          const latest = stmtGetInvCase.get(contractId) as Record<string, unknown>;
          db.exec('ROLLBACK');
          throw new InvestigationVersionConflictError(
            expectedVersion,
            Number(latest?.facts_version ?? currentVersion)
          );
        }
        appendInvEventTx(
          contractId,
          'FACTS_UPDATED',
          nextVersion,
          {
            previousVersion: currentVersion,
            newVersion: nextVersion,
            factsSnapshotDigest: computeFactSetDigest(nextFactSet),
            counts: {
              corporateDates: nextFactSet.corporateDates.length,
              corporateChanges: nextFactSet.corporateChanges.length,
              people: nextFactSet.people.length,
              corporateLinks: nextFactSet.corporateLinks.length,
              publicFunctions: nextFactSet.publicFunctions.length,
              kinshipRelations: nextFactSet.kinshipRelations.length,
              lotParticipants: nextFactSet.lotParticipants.length,
            },
          },
          actor
        );
        db.exec('COMMIT');
      } catch (err) {
        if (!(err instanceof InvestigationVersionConflictError)) {
          try {
            db.exec('ROLLBACK');
          } catch {
            // already rolled back
          }
        }
        throw err;
      }
      return hydrateInvestigationCase(contractId, actor);
    },
    savePrivateEvidence(
      input: {
        contractId: string;
        filename: string;
        mimeType: string;
        sourceLabel: string;
        description: string;
        acquiredAt: string;
        bytes: Buffer;
      },
      actor: InvestigationActor
    ) {
      if (input.bytes.length === 0) {
        throw new Error('Arquivo de evidência privada vazio.');
      }
      if (input.bytes.length > MAX_PRIVATE_EVIDENCE_BYTES) {
        throw new Error(
          `Evidência privada excede o limite de ${MAX_PRIVATE_EVIDENCE_BYTES} bytes (1 MiB).`
        );
      }
      ensureInvestigationCaseRow(input.contractId, actor);
      const sha256 = crypto.createHash('sha256').update(input.bytes).digest('hex');
      const { objectKey, absPath } = resolveSafePrivateEvidencePath(sha256);
      const subDir = path.dirname(absPath);
      if (!fs.existsSync(subDir)) {
        fs.mkdirSync(subDir, { recursive: true });
      }
      if (!fs.existsSync(absPath)) {
        const tmpPath = `${absPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, input.bytes);
        fs.renameSync(tmpPath, absPath);
      }

      const safeName = sanitizeExportFilenamePart(input.filename);
      const exportFilename = `${sha256}__${safeName}`;
      const id = `PEV-${crypto.randomUUID()}`;
      const now = new Date().toISOString();

      db.exec('BEGIN IMMEDIATE');
      try {
        const row = stmtGetInvCase.get(input.contractId) as Record<string, unknown>;
        stmtInsertInvPrivateEvidence.run(
          id,
          input.contractId,
          sha256,
          path.basename(input.filename || 'evidencia.bin').slice(0, 180),
          input.mimeType || 'application/octet-stream',
          input.bytes.length,
          input.sourceLabel.trim().slice(0, 200),
          input.description.trim().slice(0, 1000),
          input.acquiredAt.trim() || now,
          actor.actorName,
          exportFilename,
          objectKey,
          now
        );
        appendInvEventTx(
          input.contractId,
          'PRIVATE_EVIDENCE_UPLOADED',
          Number(row.facts_version),
          {
            evidenceId: id,
            sha256,
            filename: path.basename(input.filename || 'evidencia.bin').slice(0, 180),
            exportFilename,
            sizeBytes: input.bytes.length,
            sourceLabel: input.sourceLabel.trim().slice(0, 200),
          },
          actor
        );
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      const record: PrivateEvidenceRecord = {
        id,
        contractId: input.contractId,
        sha256,
        filename: path.basename(input.filename || 'evidencia.bin').slice(0, 180),
        mimeType: input.mimeType || 'application/octet-stream',
        sizeBytes: input.bytes.length,
        sourceLabel: input.sourceLabel.trim().slice(0, 200),
        description: input.description.trim().slice(0, 1000),
        acquiredAt: input.acquiredAt.trim() || now,
        uploadedBy: actor.actorName,
        exportFilename,
      };
      return {
        record,
        investigation: hydrateInvestigationCase(input.contractId, actor),
      };
    },
    getPrivateEvidenceById(contractId: string, evidenceId: string) {
      const row = stmtGetInvPrivateEvidenceById.get(contractId, evidenceId) as
        | Record<string, unknown>
        | undefined;
      return row ? mapPrivateEvidenceRow(row) : null;
    },
    readPrivateEvidenceBytes(sha256: string) {
      let absPath: string;
      try {
        absPath = resolveSafePrivateEvidencePath(sha256).absPath;
      } catch {
        return null;
      }
      if (!fs.existsSync(absPath)) return null;
      const bytes = fs.readFileSync(absPath);
      const computed = crypto.createHash('sha256').update(bytes).digest('hex');
      return {
        bytes,
        verified: computed === sha256.trim().toLowerCase(),
      };
    },
    addInvestigationReview(
      review: Omit<InvestigationReviewRecord, 'id' | 'createdAt'>,
      actor: InvestigationActor
    ) {
      ensureInvestigationCaseRow(review.contractId, actor);
      const id = `IRV-${crypto.randomUUID()}`;
      const createdAt = new Date().toISOString();

      db.exec('BEGIN IMMEDIATE');
      try {
        stmtInsertInvReview.run(
          id,
          review.contractId,
          review.findingId,
          review.action,
          review.rationale,
          review.factsVersion,
          review.findingInputsDigest,
          actor.actorId,
          actor.actorName,
          actor.actorRole,
          createdAt
        );
        appendInvEventTx(
          review.contractId,
          'FINDING_REVIEWED',
          review.factsVersion,
          {
            reviewId: id,
            findingId: review.findingId,
            action: review.action,
            findingInputsDigest: review.findingInputsDigest,
          },
          actor
        );
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      const fullReview: InvestigationReviewRecord = {
        ...review,
        id,
        actorId: actor.actorId,
        actorName: actor.actorName,
        actorRole: actor.actorRole,
        createdAt,
      };
      return {
        review: fullReview,
        investigation: hydrateInvestigationCase(review.contractId, actor),
      };
    },
    listInvestigationEvents(contractId: string) {
      const rows = stmtListInvEvents.all(contractId) as Array<Record<string, unknown>>;
      return rows.map(mapInvEventRow);
    },
    upsertSupplierQsa(record: SupplierQsaRecord) {
      stmtUpsertSupplierQsa.run(
        record.cnpj,
        record.legalName,
        record.registrationStatus,
        record.openingDate,
        record.primaryCnaeCode,
        record.primaryCnaeDescription,
        record.municipality,
        record.uf,
        Number(record.shareCapital || 0),
        JSON.stringify(record.shareholders ?? []),
        record.sourceProvider || 'BrasilAPI CNPJ',
        record.fetchedAt || new Date().toISOString()
      );
    },
    getSupplierQsa(cnpj: string) {
      const row = stmtGetSupplierQsa.get(cnpj) as Record<string, unknown> | undefined;
      return row ? mapSupplierQsaRow(row) : null;
    },
    listAllSupplierQsa() {
      const rows = stmtListAllSupplierQsa.all() as Array<Record<string, unknown>>;
      return rows.map(mapSupplierQsaRow);
    },
    saveOfficialSnapshot(snapshot) {
      const normalizedCompetencia = snapshot.competencia.trim();
      const normalizedUf = snapshot.uf ? snapshot.uf.trim().toUpperCase() : null;
      const ufNorm = normalizedUf ?? '';

      const existing = stmtGetOfficialSnapshotByCompositeKey.get(
        snapshot.sourceKind,
        snapshot.sha256,
        normalizedCompetencia,
        ufNorm
      ) as { id: string } | undefined;
      if (existing) {
        return { alreadyExisted: true, id: existing.id };
      }

      let effectiveId = snapshot.id;
      const collidingId = stmtGetOfficialSnapshotById.get(effectiveId) as { id: string } | undefined;
      if (collidingId) {
        const suffix = crypto
          .createHash('sha256')
          .update(`${snapshot.sourceKind}|${snapshot.sha256}|${normalizedCompetencia}|${ufNorm}`)
          .digest('hex')
          .slice(0, 8);
        effectiveId = `${snapshot.id}_${suffix}`;
      }

      const result = stmtInsertOfficialSnapshot.run(
        effectiveId,
        snapshot.sourceKind,
        snapshot.filename,
        snapshot.sha256,
        normalizedCompetencia,
        normalizedUf,
        ufNorm,
        snapshot.metadataJson,
        snapshot.payloadJson,
        snapshot.importedBy,
        new Date().toISOString()
      );
      if (Number(result.changes) !== 1) {
        throw new Error(
          `Falha ao persistir snapshot oficial (${snapshot.sourceKind}): esperado changes=1, obtido ${String(result.changes)}.`
        );
      }

      const persisted = stmtGetOfficialSnapshotById.get(effectiveId) as
        | { id: string; source_kind: string; sha256: string; competencia: string; uf: string | null }
        | undefined;
      if (
        !persisted ||
        persisted.source_kind !== snapshot.sourceKind ||
        persisted.sha256 !== snapshot.sha256 ||
        persisted.competencia !== normalizedCompetencia
      ) {
        throw new Error(
          `Verificação pós-escrita falhou para snapshot oficial ${effectiveId} (${snapshot.sourceKind}).`
        );
      }

      return { alreadyExisted: false, id: persisted.id };
    },
    listOfficialSnapshots(sourceKind) {
      const rows = (
        sourceKind
          ? stmtListOfficialSnapshotsByKind.all(sourceKind)
          : stmtListOfficialSnapshotsAll.all()
      ) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        sourceKind: String(r.source_kind) as 'siaps' | 'sinapi' | 'camara_personnel' | 'inep',
        filename: String(r.filename),
        sha256: String(r.sha256),
        competencia: String(r.competencia),
        uf: r.uf ? String(r.uf) : null,
        metadataJson: String(r.metadata_json),
        importedBy: String(r.imported_by),
        importedAt: String(r.imported_at),
      }));
    },
  };
}

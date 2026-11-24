-- NEXOFIS — Migração Inicial PostgreSQL (v001)
-- Licença do código-fonte: GNU AGPL-3.0-only (Eduardo Muniz — DM Technology)
-- Compatível com PostgreSQL 15/16+. Todas as datas armazenadas em TIMESTAMPTZ ou DATE ISO-8601.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  pncp_control_number TEXT NOT NULL,
  contract_number TEXT NOT NULL,
  municipality_ibge CHAR(7) NOT NULL CHECK (municipality_ibge ~ '^[0-9]{7}$'),
  municipality_name TEXT NOT NULL,
  uf CHAR(2) NOT NULL,
  entity_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  supplier_cnpj VARCHAR(18) NOT NULL,
  cnpj_role TEXT CHECK (cnpj_role IN ('fornecedor', 'orgao_contratante', 'subcontratado')),
  year INTEGER NOT NULL CHECK (year >= 1990 AND year <= 2100),
  lifecycle_status TEXT NOT NULL DEFAULT 'Vigente',
  publication_date DATE,
  submission_date DATE,
  signature_date DATE,
  start_date DATE,
  end_date DATE,
  original_value_cents BIGINT NOT NULL DEFAULT 0,
  updated_value_cents BIGINT NOT NULL DEFAULT 0,
  data_source_origin TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pg_contracts_supplier_cnpj ON contracts(supplier_cnpj);
CREATE INDEX IF NOT EXISTS idx_pg_contracts_ibge ON contracts(municipality_ibge);
CREATE INDEX IF NOT EXISTS idx_pg_contracts_pncp ON contracts(pncp_control_number);
CREATE INDEX IF NOT EXISTS idx_pg_contracts_publication_date ON contracts(publication_date);
CREATE INDEX IF NOT EXISTS idx_pg_contracts_submission_date ON contracts(submission_date);
CREATE INDEX IF NOT EXISTS idx_pg_contracts_signature_date ON contracts(signature_date);
CREATE INDEX IF NOT EXISTS idx_pg_contracts_status ON contracts(lifecycle_status);

CREATE TABLE IF NOT EXISTS saved_dossiers (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  contract_number TEXT NOT NULL,
  municipality_name TEXT NOT NULL,
  municipality_ibge CHAR(7) NOT NULL,
  entity_name TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  risk_score INTEGER NOT NULL CHECK (risk_score >= 0 AND risk_score <= 100),
  saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  analyst_note TEXT NOT NULL DEFAULT '',
  sha256_digest CHAR(64) NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_pg_saved_dossiers_contract ON saved_dossiers(contract_id, saved_at DESC);

-- Trilha append-only de revisões humanas (nunca sobrescrever ou apagar histórico)
CREATE TABLE IF NOT EXISTS finding_reviews (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  finding_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('dismiss', 'restore')),
  author TEXT NOT NULL,
  rationale TEXT NOT NULL CHECK (char_length(trim(rationale)) >= 8),
  rule_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pg_finding_reviews_contract ON finding_reviews(contract_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sync_checkpoints (
  scope_key TEXT PRIMARY KEY,
  source_system TEXT NOT NULL,
  last_synced_at TIMESTAMPTZ NOT NULL,
  next_run_at TIMESTAMPTZ,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL CHECK (status IN ('complete', 'partial', 'rate_limited', 'unavailable')),
  total_declared INTEGER NOT NULL DEFAULT 0,
  total_fetched INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS document_artifacts (
  sha256 CHAR(64) PRIMARY KEY,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  storage_uri TEXT,
  contract_id TEXT REFERENCES contracts(id) ON DELETE SET NULL,
  extractor_version TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  extraction_metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pg_artifacts_contract ON document_artifacts(contract_id);

-- Fila durável de processamento assíncrono (OCR, sincronização PNCP/TCE, reanálise)
CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  job_type TEXT NOT NULL,
  organization_scope TEXT NOT NULL DEFAULT 'public',
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'succeeded', 'failed', 'cancelled')),
  payload_json JSONB NOT NULL,
  result_json JSONB,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  is_permanent_error BOOLEAN NOT NULL DEFAULT FALSE,
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pg_jobs_status_next ON ingestion_jobs(status, next_retry_at);

-- Controle de acesso RBAC (admin, analyst, viewer) — sem credenciais padrão embutidas
CREATE TABLE IF NOT EXISTS audit_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'analyst', 'viewer')),
  organization_scope TEXT NOT NULL DEFAULT 'public',
  password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;

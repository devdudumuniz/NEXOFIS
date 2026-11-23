#!/usr/bin/env bash
set -euo pipefail

# NEXOFIS — Backup e Restauração Consistentes (SQLite WAL-safe + objects + private_evidence ou PostgreSQL)
# Licença: GNU AGPL-3.0-only (Eduardo Muniz — DM Technology)
#
# Uso:
#   ./scripts/backup-restore.sh backup-sqlite
#   ./scripts/backup-restore.sh verify-sqlite backups/nexofis-YYYYMMDD-HHMMSS.db
#   ./scripts/backup-restore.sh restore-sqlite backups/nexofis-YYYYMMDD-HHMMSS.db
#   ./scripts/backup-restore.sh backup-postgres
#   ./scripts/backup-restore.sh restore-postgres backups/nexofis-pg-YYYYMMDD-HHMMSS.dump

ACTION="${1:-}"
TARGET="${2:-}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${NEXOFIS_BACKUP_DIR:-backups}"
mkdir -p "$BACKUP_DIR"

verify_tar_safety() {
  local archive="$1"
  local expected_root="$2"
  node --input-type=module - "$archive" "$expected_root" <<'EOF'
import { execFileSync } from 'node:child_process';

const [archive, expectedRoot] = process.argv.slice(2);
const listing = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' });
const lines = listing.split(/\r?\n/).filter(Boolean);

for (const line of lines) {
  const typeChar = line[0];
  if (typeChar === 'l' || typeChar === 'h') {
    throw new Error(`Tar contém symlink ou hardlink proibido: ${line}`);
  }
  const parts = line.trim().split(/\s+/);
  const entryPath = parts[parts.length - 1];
  if (entryPath.startsWith('/') || entryPath.includes('..')) {
    throw new Error(`Tar contém caminho inseguro (path traversal ou absoluto): ${entryPath}`);
  }
  if (entryPath !== expectedRoot && !entryPath.startsWith(`${expectedRoot}/`)) {
    throw new Error(`Tar contém entrada fora do diretório esperado (${expectedRoot}/): ${entryPath}`);
  }
}
console.log(`Arquivo tar verificado com segurança (${lines.length} entradas sob ${expectedRoot}/).`);
EOF
}

run_node_sqlite_backup() {
  local src="$1"
  local dest="$2"
  node --input-type=module - "$src" "$dest" <<'EOF'
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [src, dest] = process.argv.slice(2);
if (fs.existsSync(dest)) fs.unlinkSync(dest);

const srcDb = new DatabaseSync(src);
try {
  const escapedDest = dest.replace(/'/g, "''");
  srcDb.exec(`VACUUM INTO '${escapedDest}';`);
} finally {
  srcDb.close();
}

const checkDb = new DatabaseSync(dest, { readOnly: true });
try {
  const res = checkDb.prepare('PRAGMA integrity_check;').get();
  if (!res || res.integrity_check !== 'ok') {
    throw new Error(`Integrity check falhou no backup: ${JSON.stringify(res)}`);
  }
  const tables = checkDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all();
  const counts = {};
  for (const t of tables) {
    const row = checkDb.prepare(`SELECT COUNT(*) AS cnt FROM "${t.name}"`).get();
    counts[t.name] = Number(row.cnt);
  }
  console.log(`Snapshot SQLite verificado (PRAGMA integrity_check=ok): ${JSON.stringify(counts)}`);
} finally {
  checkDb.close();
}
EOF
}

run_node_sqlite_verify() {
  local dbfile="$1"
  local priv_dir="${2:-}"
  node --input-type=module - "$dbfile" "$priv_dir" <<'EOF'
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_PRIVATE_EVIDENCE_BYTES = 1024 * 1024;
const [dbfile, privDir] = process.argv.slice(2);

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`)
    .join(',')}}`;
}

const db = new DatabaseSync(dbfile, { readOnly: true });
try {
  const res = db.prepare('PRAGMA integrity_check;').get();
  if (!res || res.integrity_check !== 'ok') {
    throw new Error(`Arquivo SQLite corrompido ou inválido: ${JSON.stringify(res)}`);
  }

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all();
  const tableNames = new Set(tables.map((t) => String(t.name)));
  const counts = {};
  for (const t of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM "${t.name}"`).get();
    counts[t.name] = Number(row.cnt);
  }

  // Verify investigation_events SHA-256 hash chain per contract_id if v3 table exists
  if (tableNames.has('investigation_events')) {
    const contracts = db
      .prepare('SELECT DISTINCT contract_id FROM investigation_events')
      .all();
    let totalChecked = 0;
    for (const c of contracts) {
      const events = db
        .prepare(
          `SELECT seq, id, contract_id, event_type, actor_id, actor_name, actor_role,
                  facts_version, payload_json, prev_hash, event_hash, created_at
           FROM investigation_events
           WHERE contract_id = ?
           ORDER BY seq ASC`
        )
        .all(c.contract_id);
      let expectedPrev = 'GENESIS';
      for (const ev of events) {
        if (ev.prev_hash !== expectedPrev) {
          throw new Error(`Cadeia de eventos corrompida (prev_hash) em ${c.contract_id} seq #${ev.seq}`);
        }
        const canonical = canonicalStringify({
          id: ev.id,
          contractId: ev.contract_id,
          eventType: ev.event_type,
          actorId: ev.actor_id,
          actorName: ev.actor_name,
          actorRole: ev.actor_role,
          factsVersion: Number(ev.facts_version),
          payloadJson: ev.payload_json,
          prevHash: ev.prev_hash,
          createdAt: ev.created_at,
        });
        const recomputed = crypto.createHash('sha256').update(canonical).digest('hex');
        if (recomputed !== ev.event_hash) {
          throw new Error(`Cadeia de eventos corrompida (event_hash) em ${c.contract_id} seq #${ev.seq}`);
        }
        expectedPrev = ev.event_hash;
        totalChecked += 1;
      }
    }
    console.log(`Cadeia SHA-256 de investigation_events íntegra (${totalChecked} eventos verificados).`);
  }

  // Verify staged private_evidence binaries against SQLite metadata if provided
  if (privDir && tableNames.has('investigation_private_evidence')) {
    const resolvedPriv = path.resolve(privDir);
    const rows = db
      .prepare('SELECT id, sha256, size_bytes, export_filename FROM investigation_private_evidence')
      .all();
    for (const row of rows) {
      const sha = String(row.sha256).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(sha)) {
        throw new Error(`SHA-256 inválido na tabela investigation_private_evidence (${row.id})`);
      }
      const absPath = path.resolve(resolvedPriv, sha.slice(0, 2), sha);
      if (!absPath.startsWith(resolvedPriv + path.sep)) {
        throw new Error(`Caminho fora do diretório private_evidence confinado: ${absPath}`);
      }
      if (!fs.existsSync(absPath)) {
        throw new Error(`Evidência privada ausente no backup: ${row.export_filename} (${sha})`);
      }
      const bytes = fs.readFileSync(absPath);
      if (bytes.length > MAX_PRIVATE_EVIDENCE_BYTES) {
        throw new Error(`Evidência privada excede 1 MiB: ${row.export_filename} (${bytes.length} bytes)`);
      }
      if (bytes.length !== Number(row.size_bytes)) {
        throw new Error(`Tamanho divergente para evidência privada ${row.export_filename}`);
      }
      const actualSha = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actualSha !== sha) {
        throw new Error(`SHA-256 divergente para evidência privada ${row.export_filename}`);
      }
    }
    console.log(`Evidências privadas verificadas (${rows.length} arquivos SHA-256 + limite 1 MiB OK).`);
  }

  console.log(`Integridade verificada (ok): ${JSON.stringify(counts)}`);
} finally {
  db.close();
}
EOF
}

case "$ACTION" in
  backup-sqlite)
    SRC="${NEXOFIS_SQLITE_PATH:-data/nexofis.db}"
    if [ ! -f "$SRC" ]; then
      echo "Banco SQLite não encontrado em $SRC" >&2
      exit 1
    fi
    DEST="$BACKUP_DIR/nexofis-$TIMESTAMP.db"
    run_node_sqlite_backup "$SRC" "$DEST"

    SRC_DIR="$(dirname "$SRC")"
    OBJ_DIR="$SRC_DIR/objects"
    if [ -d "$OBJ_DIR" ] && [ -n "$(ls -A "$OBJ_DIR" 2>/dev/null || true)" ]; then
      tar -czf "${DEST}.objects.tar.gz" -C "$SRC_DIR" objects
      echo "Arquivos originais (objects/) empacotados em: ${DEST}.objects.tar.gz"
    fi

    PRIV_DIR="$SRC_DIR/private_evidence"
    if [ -d "$PRIV_DIR" ] && [ -n "$(ls -A "$PRIV_DIR" 2>/dev/null || true)" ]; then
      tar -czf "${DEST}.private_evidence.tar.gz" -C "$SRC_DIR" private_evidence
      echo "Evidências privadas (private_evidence/) empacotadas em: ${DEST}.private_evidence.tar.gz"
    fi

    run_node_sqlite_verify "$DEST" "$PRIV_DIR"
    echo "Backup SQLite consistente salvo em: $DEST"
    ;;

  verify-sqlite)
    if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
      echo "Informe o arquivo .db de backup válido." >&2
      exit 1
    fi
    STAGE_DIR="$(mktemp -d)"
    trap 'rm -rf "$STAGE_DIR"' EXIT

    if [ -f "${TARGET}.objects.tar.gz" ]; then
      verify_tar_safety "${TARGET}.objects.tar.gz" "objects"
    fi
    PRIV_STAGE=""
    if [ -f "${TARGET}.private_evidence.tar.gz" ]; then
      verify_tar_safety "${TARGET}.private_evidence.tar.gz" "private_evidence"
      tar -xzf "${TARGET}.private_evidence.tar.gz" -C "$STAGE_DIR"
      PRIV_STAGE="$STAGE_DIR/private_evidence"
    fi
    run_node_sqlite_verify "$TARGET" "$PRIV_STAGE"
    ;;

  restore-sqlite)
    if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
      echo "Informe o arquivo .db de backup válido." >&2
      exit 1
    fi
    DEST="${NEXOFIS_SQLITE_PATH:-data/nexofis.db}"
    DEST_DIR="$(dirname "$DEST")"
    mkdir -p "$DEST_DIR"

    STAGE_DIR="$(mktemp -d)"
    trap 'rm -rf "$STAGE_DIR"' EXIT

    if [ -f "${TARGET}.objects.tar.gz" ]; then
      verify_tar_safety "${TARGET}.objects.tar.gz" "objects"
      tar -xzf "${TARGET}.objects.tar.gz" -C "$STAGE_DIR"
    fi

    PRIV_STAGE=""
    if [ -f "${TARGET}.private_evidence.tar.gz" ]; then
      verify_tar_safety "${TARGET}.private_evidence.tar.gz" "private_evidence"
      tar -xzf "${TARGET}.private_evidence.tar.gz" -C "$STAGE_DIR"
      PRIV_STAGE="$STAGE_DIR/private_evidence"
    fi

    echo "Verificando integridade do backup (SQLite, cadeia de eventos e evidências privadas) antes da restauração..."
    run_node_sqlite_verify "$TARGET" "$PRIV_STAGE"

    STAGED="${DEST}.restore-staged.$$"
    cp "$TARGET" "$STAGED"
    if [ -f "$DEST" ]; then
      cp "$DEST" "${DEST}.pre-restore-${TIMESTAMP}.bak"
    fi

    rm -f "${DEST}-wal" "${DEST}-shm"
    mv -f "$STAGED" "$DEST"

    if [ -d "$STAGE_DIR/objects" ]; then
      rm -rf "$DEST_DIR/objects.restore-prev"
      if [ -d "$DEST_DIR/objects" ]; then
        mv "$DEST_DIR/objects" "$DEST_DIR/objects.restore-prev"
      fi
      mv "$STAGE_DIR/objects" "$DEST_DIR/objects"
      rm -rf "$DEST_DIR/objects.restore-prev"
      echo "Objetos originais (objects/) restaurados em: $DEST_DIR/objects"
    fi

    if [ -d "$STAGE_DIR/private_evidence" ]; then
      rm -rf "$DEST_DIR/private_evidence.restore-prev"
      if [ -d "$DEST_DIR/private_evidence" ]; then
        mv "$DEST_DIR/private_evidence" "$DEST_DIR/private_evidence.restore-prev"
      fi
      mv "$STAGE_DIR/private_evidence" "$DEST_DIR/private_evidence"
      rm -rf "$DEST_DIR/private_evidence.restore-prev"
      echo "Evidências privadas (private_evidence/) restauradas em: $DEST_DIR/private_evidence"
    fi

    echo "Verificando banco e evidências privadas restaurados..."
    run_node_sqlite_verify "$DEST" "$DEST_DIR/private_evidence"
    echo "Banco SQLite restaurado com sucesso em: $DEST (reinicie o servidor NEXOFIS se estiver em execução)."
    ;;

  backup-postgres)
    if [ -z "${DATABASE_URL:-}" ]; then
      echo "Defina DATABASE_URL antes de executar backup-postgres." >&2
      exit 1
    fi
    DEST="$BACKUP_DIR/nexofis-pg-$TIMESTAMP.dump"
    pg_dump --format=custom --no-owner --file="$DEST" "$DATABASE_URL"
    echo "Backup PostgreSQL salvo em: $DEST"
    ;;

  restore-postgres)
    if [ -z "${DATABASE_URL:-}" ] || [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
      echo "Defina DATABASE_URL e informe o arquivo .dump válido." >&2
      exit 1
    fi
    pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$TARGET"
    echo "Backup PostgreSQL restaurado com sucesso."
    ;;

  *)
    echo "Uso: $0 {backup-sqlite|verify-sqlite <arquivo>|restore-sqlite <arquivo>|backup-postgres|restore-postgres <arquivo>}"
    exit 1
    ;;
esac

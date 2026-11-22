#!/usr/bin/env bash
set -euo pipefail

# NEXOFIS — Backup e Restauração Consistentes (SQLite WAL-safe ou PostgreSQL)
# Licença: GNU AGPL-3.0-only (Eduardo Muniz — DM Technology)
#
# Uso:
#   ./scripts/backup-restore.sh backup-sqlite
#   ./scripts/backup-restore.sh restore-sqlite backups/nexofis-YYYYMMDD-HHMMSS.db
#   ./scripts/backup-restore.sh backup-postgres
#   ./scripts/backup-restore.sh restore-postgres backups/nexofis-pg-YYYYMMDD-HHMMSS.dump

ACTION="${1:-}"
TARGET="${2:-}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${NEXOFIS_BACKUP_DIR:-backups}"
mkdir -p "$BACKUP_DIR"

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
  // VACUUM INTO creates a single self-contained, transactionally consistent SQLite snapshot
  // capturing all committed WAL transactions without locking readers or copying raw -wal/-shm files.
  const escapedDest = dest.replace(/'/g, "''");
  srcDb.exec(`VACUUM INTO '${escapedDest}';`);
} finally {
  srcDb.close();
}

// Verify integrity of the snapshot immediately
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
  node --input-type=module - "$dbfile" <<'EOF'
import { DatabaseSync } from 'node:sqlite';

const [dbfile] = process.argv.slice(2);
const db = new DatabaseSync(dbfile, { readOnly: true });
try {
  const res = db.prepare('PRAGMA integrity_check;').get();
  if (!res || res.integrity_check !== 'ok') {
    throw new Error(`Arquivo SQLite corrompido ou inválido: ${JSON.stringify(res)}`);
  }
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all();
  const counts = {};
  for (const t of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM "${t.name}"`).get();
    counts[t.name] = Number(row.cnt);
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

    # Also archive durable original objects store if present alongside SQLite
    OBJ_DIR="$(dirname "$SRC")/objects"
    if [ -d "$OBJ_DIR" ] && [ -n "$(ls -A "$OBJ_DIR" 2>/dev/null || true)" ]; then
      tar -czf "${DEST}.objects.tar.gz" -C "$(dirname "$SRC")" objects
      echo "Arquivos originais (objects/) empacotados em: ${DEST}.objects.tar.gz"
    fi
    echo "Backup SQLite consistente salvo em: $DEST"
    ;;

  restore-sqlite)
    if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
      echo "Informe o arquivo .db de backup válido." >&2
      exit 1
    fi
    DEST="${NEXOFIS_SQLITE_PATH:-data/nexofis.db}"
    DEST_DIR="$(dirname "$DEST")"
    mkdir -p "$DEST_DIR"

    echo "Verificando integridade do backup antes da restauração..."
    run_node_sqlite_verify "$TARGET"

    # Stage restore atomically and preserve a pre-restore copy of the current DB
    STAGED="${DEST}.restore-staged.$$"
    cp "$TARGET" "$STAGED"
    if [ -f "$DEST" ]; then
      cp "$DEST" "${DEST}.pre-restore-${TIMESTAMP}.bak"
    fi

    # Remove old WAL/SHM sidecars ONLY together with replacing the database with the verified self-contained snapshot
    rm -f "${DEST}-wal" "${DEST}-shm"
    mv -f "$STAGED" "$DEST"

    echo "Verificando banco restaurado..."
    run_node_sqlite_verify "$DEST"

    # Restore objects/ archive if present next to backup
    if [ -f "${TARGET}.objects.tar.gz" ]; then
      tar -xzf "${TARGET}.objects.tar.gz" -C "$DEST_DIR"
      echo "Objetos originais (objects/) restaurados em: $DEST_DIR/objects"
    fi
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
    echo "Uso: $0 {backup-sqlite|restore-sqlite <arquivo>|backup-postgres|restore-postgres <arquivo>}"
    exit 1
    ;;
esac

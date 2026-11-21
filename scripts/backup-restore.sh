#!/usr/bin/env bash
set -euo pipefail

# NEXOFIS — Backup e Restauração (SQLite local ou PostgreSQL)
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

case "$ACTION" in
  backup-sqlite)
    SRC="${NEXOFIS_SQLITE_PATH:-data/nexofis.db}"
    if [ ! -f "$SRC" ]; then
      echo "Banco SQLite não encontrado em $SRC" >&2
      exit 1
    fi
    DEST="$BACKUP_DIR/nexofis-$TIMESTAMP.db"
    cp "$SRC" "$DEST"
    [ -f "${SRC}-wal" ] && cp "${SRC}-wal" "${DEST}-wal"
    [ -f "${SRC}-shm" ] && cp "${SRC}-shm" "${DEST}-shm"
    echo "Backup SQLite salvo em: $DEST"
    ;;

  restore-sqlite)
    if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
      echo "Informe o arquivo .db de backup válido." >&2
      exit 1
    fi
    DEST="${NEXOFIS_SQLITE_PATH:-data/nexofis.db}"
    mkdir -p "$(dirname "$DEST")"
    cp "$TARGET" "$DEST"
    rm -f "${DEST}-wal" "${DEST}-shm"
    echo "Banco SQLite restaurado em: $DEST (reinicie o servidor NEXOFIS)."
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

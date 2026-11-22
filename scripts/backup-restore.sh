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

# SQLite and private originals are a recovery set. Stop NEXOFIS before restore.
# The multi-file swap is recoverable, not a cross-filesystem atomic transaction.
run_node_sqlite_recovery() {
  node --input-type=module - "$ACTION" "$TARGET" "$BACKUP_DIR" "$TIMESTAMP" <<'EOF'
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const [action, targetArg, backupDirArg, stamp] = process.argv.slice(2);
const dbPath = path.resolve(process.env.NEXOFIS_SQLITE_PATH || 'data/nexofis.db');
const backupDir = path.resolve(backupDirArg);
const parent = path.dirname(dbPath);
const PRIVATE = 'investigation-objects';
const PUBLIC = 'objects';
const MAX_PRIVATE_BYTES = 1024 * 1024;
const MAX_PUBLIC_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
function fail(message) { throw new Error(message); }
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
function snapshot(source, dest) {
  if (!fs.existsSync(source)) fail('Banco SQLite de origem não encontrado.');
  const db = new DatabaseSync(source, { readOnly: true });
  try { db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}';`); } finally { db.close(); }
  verifyDatabase(dest);
}
function verifyDatabase(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const result = db.prepare('PRAGMA integrity_check').get();
    if (result?.integrity_check !== 'ok') fail('Arquivo SQLite inválido: integrity_check falhou.');
  } finally { db.close(); }
}
function artifactReferences(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const refs = new Map();
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='investigation_events'").get()) return refs;
    let contractId = null; let previous = null; let sequence = 0;
    const rows = db.prepare('SELECT contract_id,sequence,id,kind,event_json,previous_event_hash,event_hash FROM investigation_events ORDER BY contract_id,sequence');
    for (const row of rows.iterate()) {
      if (row.contract_id !== contractId) { contractId = row.contract_id; previous = null; sequence = 0; }
      const event = JSON.parse(row.event_json);
      const { eventHash, ...unsigned } = event;
      if (!event.payload || event.contractId !== row.contract_id || event.sequence !== ++sequence || event.sequence !== row.sequence
        || event.id !== row.id || event.kind !== row.kind || event.previousEventHash !== previous || row.previous_event_hash !== previous
        || eventHash !== row.event_hash || hash(canonical(unsigned)) !== eventHash) fail('Hashchain investigativa inválida no snapshot.');
      if (event.kind === 'dataset' && hash(canonical(event.payload.dataset)) !== event.payload.datasetDigest) fail('Digest de dataset inválido no snapshot.');
      previous = eventHash;
      if (event.kind !== 'artifact') continue;
      const { artifactSha256: sha, sizeBytes: size } = event.payload;
      if (!HASH.test(sha) || !Number.isInteger(size) || size < 1 || size > MAX_PRIVATE_BYTES) fail('Referência de artefato inválida no snapshot.');
      if (refs.has(sha) && refs.get(sha) !== size) fail('Tamanhos conflitantes para o mesmo artefato.');
      refs.set(sha, size);
    }
    return refs;
  } finally { db.close(); }
}
function regularDirectory(dir) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Diretório de objetos ausente ou contém vínculo simbólico.');
}
function verifiedPrivateBytes(root, sha, size) {
  regularDirectory(root); regularDirectory(path.join(root, sha.slice(0, 2)));
  const file = path.join(root, sha.slice(0, 2), `${sha}.bin`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== size || stat.size > MAX_PRIVATE_BYTES) fail('Artefato ausente, inválido ou com metadados divergentes.');
  const bytes = fs.readFileSync(file);
  if (hash(bytes) !== sha) fail('SHA-256 do artefato diverge do evento registrado.');
  return bytes;
}
function verifyPrivateObjects(root, refs) {
  for (const [sha, size] of refs) verifiedPrivateBytes(root, sha, size);
}
function archiveObjects(stage, kind, dest) {
  const proc = spawnSync('tar', ['--format=ustar', '-czf', dest, '-C', stage, kind], { encoding: 'utf8' });
  if (proc.status !== 0) fail('Não foi possível empacotar objetos com tar.');
}
function octal(header, start, end) {
  const text = header.subarray(start, end).toString('ascii').replace(/\0/g, '').trim();
  if (!/^[0-7]+$/.test(text)) fail('Campo numérico tar não suportado.');
  return Number.parseInt(text, 8);
}
function field(header, start, end) {
  const bytes = header.subarray(start, end); const nul = bytes.indexOf(0);
  return bytes.subarray(0, nul < 0 ? bytes.length : nul).toString('utf8');
}
/**
 * Two passes: validate every tar member before extraction, then validate again while
 * extracting only regular hash-named files into a new private staging directory.
 * No links, devices, PAX/GNU extensions, absolute paths, traversal or arbitrary modes.
 */
async function inspectArchive(file, kind, extractRoot = null) {
  const stream = fs.createReadStream(file).pipe(createGunzip());
  const iterator = stream[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0); let ended = false; let total = 0;
  async function read(n, allowEnd = false) {
    const chunks = []; let needed = n;
    while (needed > 0) {
      if (!pending.length) {
        const next = await iterator.next();
        if (next.done) { ended = true; if (allowEnd && needed === n) return null; fail('Archive tar truncado.'); }
        pending = Buffer.from(next.value); total += pending.length;
        if (total > MAX_ARCHIVE_BYTES) fail('Archive excede o limite operacional de 2 GiB descomprimidos.');
      }
      const length = Math.min(needed, pending.length);
      chunks.push(pending.subarray(0, length)); pending = pending.subarray(length); needed -= length;
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, n);
  }
  const seen = new Set();
  try {
    while (true) {
      const header = await read(512, true);
      if (header === null) fail('Archive tar sem terminador.');
      if (header.every((b) => b === 0)) {
        const second = await read(512);
        if (!second.every((b) => b === 0)) fail('Terminador tar inválido.');
        while (!ended) {
          const padding = await read(512, true);
          if (padding && !padding.every((b) => b === 0)) fail('Conteúdo após o terminador tar.');
        }
        break;
      }
      const expected = octal(header, 148, 156);
      let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
      if (sum !== expected || !field(header, 257, 263).startsWith('ustar')) fail('Cabeçalho tar inválido ou formato não suportado.');
      const prefix = field(header, 345, 500); const name = `${prefix ? `${prefix}/` : ''}${field(header, 0, 100)}`;
      const type = String.fromCharCode(header[156]); const size = octal(header, 124, 136);
      const normalized = name.replace(/\/$/, '');
      const relative = normalized.startsWith(`${kind}/`) ? normalized.slice(kind.length + 1) : '';
      const isDir = type === '5';
      if (field(header, 157, 257) || !['0', '\0', '5'].includes(type)) fail('Archive contém link ou tipo de entrada proibido.');
      if (seen.has(normalized)) fail('Entrada tar duplicada.');
      seen.add(normalized);
      if (seen.size > 100000) fail('Archive excede o limite operacional de 100.000 entradas.');
      const suffix = kind === PRIVATE ? '\\.bin' : '(?:\\.bin)?';
      const filePattern = new RegExp(`^[a-f0-9]{2}/([a-f0-9]{64})${suffix}$`);
      const match = relative.match(filePattern);
      if (isDir) {
        if (size !== 0 || !(normalized === kind || new RegExp(`^${kind}/[a-f0-9]{2}$`).test(normalized))) fail('Caminho de diretório tar proibido.');
        if (extractRoot) fs.mkdirSync(path.join(extractRoot, normalized), { recursive: true, mode: 0o700 });
        continue;
      }
      if (!match || relative.slice(0, 2) !== match[1].slice(0, 2)) fail('Caminho de objeto tar inválido.');
      const max = kind === PRIVATE ? MAX_PRIVATE_BYTES : MAX_PUBLIC_BYTES;
      if (!Number.isSafeInteger(size) || size < 1 || size > max) fail('Objeto tar fora do limite de tamanho.');
      const bytes = await read(size);
      if (hash(bytes) !== match[1]) fail('SHA-256 do objeto no archive não corresponde ao nome.');
      if (extractRoot) {
        const dest = path.join(extractRoot, normalized);
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        fs.writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 });
      }
      const padding = (512 - size % 512) % 512;
      if (padding) await read(padding);
    }
  } finally { stream.destroy(); }
}
async function stageArchive(archive, kind, stage, required = false) {
  fs.mkdirSync(path.join(stage, kind), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(archive)) { if (required) fail('Acervo investigativo obrigatório ausente: archive investigation-objects não encontrado.'); return false; }
  await inspectArchive(archive, kind);
  await inspectArchive(archive, kind, stage);
  return true;
}

async function backup() {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const dest = path.join(backupDir, `nexofis-${stamp}-${process.pid}.db`);
  const stage = fs.mkdtempSync(path.join(backupDir, '.backup-stage-'));
  try {
    const stagedDb = path.join(stage, 'snapshot.db'); snapshot(dbPath, stagedDb);
    const refs = artifactReferences(stagedDb);
    fs.mkdirSync(path.join(stage, PRIVATE), { mode: 0o700 });
    for (const [sha, size] of refs) {
      const bytes = verifiedPrivateBytes(path.join(parent, PRIVATE), sha, size);
      const file = path.join(stage, PRIVATE, sha.slice(0, 2), `${sha}.bin`);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, bytes, { mode: 0o600 });
    }
    const privateArchive = path.join(stage, 'private.tar.gz');
    archiveObjects(stage, PRIVATE, privateArchive); await inspectArchive(privateArchive, PRIVATE);
    let publicArchive = null;
    if (fs.existsSync(path.join(parent, PUBLIC))) {
      publicArchive = path.join(stage, 'public.tar.gz');
      archiveObjects(parent, PUBLIC, publicArchive); await inspectArchive(publicArchive, PUBLIC);
    }
    // Publish the DB last; an interrupted backup cannot expose a completed DB without its archives.
    fs.renameSync(privateArchive, `${dest}.${PRIVATE}.tar.gz`);
    if (publicArchive) fs.renameSync(publicArchive, `${dest}.objects.tar.gz`);
    fs.renameSync(stagedDb, dest);
    console.log(`Backup SQLite consistente salvo em: ${dest}`);
    console.log(`Acervo investigativo preservado e verificado: ${refs.size} objeto(s). Mantenha os archives junto do .db.`);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
async function restore() {
  if (!targetArg || !fs.existsSync(targetArg)) fail('Informe o arquivo .db de backup válido.');
  const target = path.resolve(targetArg);
  if (target === dbPath) fail('O arquivo de backup e o destino devem ser distintos.');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  console.log('Restauração requer a aplicação NEXOFIS PARADA. A troca de banco e objetos não é uma transação atômica entre arquivos.');
  const stage = fs.mkdtempSync(path.join(parent, '.restore-stage-'));
  let rollback = null;
  const movedDirs = []; let databaseReplaced = false; let databaseMoved = false; let sidecarsMoved = false;
  try {
    const stagedDb = path.join(stage, 'snapshot.db'); fs.copyFileSync(target, stagedDb); verifyDatabase(stagedDb);
    const refs = artifactReferences(stagedDb);
    await stageArchive(`${target}.${PRIVATE}.tar.gz`, PRIVATE, stage, refs.size > 0);
    const hasPublic = await stageArchive(`${target}.objects.tar.gz`, PUBLIC, stage);
    verifyPrivateObjects(path.join(stage, PRIVATE), refs);
    // All incoming data passed validation. Preserve the existing state before any replacement.
    rollback = `${dbPath}.pre-restore-${stamp}-${process.pid}`;
    fs.mkdirSync(rollback, { mode: 0o700 });
    if (fs.existsSync(dbPath)) snapshot(dbPath, path.join(rollback, 'previous.db'));
    for (const kind of [PRIVATE, ...(hasPublic ? [PUBLIC] : [])]) {
      const current = path.join(parent, kind); const old = path.join(rollback, kind);
      const existed = fs.existsSync(current);
      if (existed) fs.renameSync(current, old);
      movedDirs.push({ kind, existed });
      fs.renameSync(path.join(stage, kind), current);
    }
    for (const suffix of ['-wal', '-shm']) if (fs.existsSync(dbPath + suffix)) {
      fs.renameSync(dbPath + suffix, path.join(rollback, `original${suffix}`)); sidecarsMoved = true;
    }
    if (fs.existsSync(dbPath)) { fs.renameSync(dbPath, path.join(rollback, 'original.db')); databaseMoved = true; }
    fs.renameSync(stagedDb, dbPath); databaseReplaced = true;
    verifyDatabase(dbPath); verifyPrivateObjects(path.join(parent, PRIVATE), refs);
    console.log(`Banco e acervo investigativo restaurados e verificados: ${dbPath}`);
    console.log(`Estado anterior preservado para recuperação em: ${rollback}`);
    console.log('Valide o caso e reinicie o NEXOFIS. Guarde a cópia anterior conforme a política de retenção.');
  } catch (error) {
    if (rollback) {
      // Best-effort rollback on operational failure; the preserved state remains available for manual recovery after a crash.
      if (databaseReplaced || databaseMoved || sidecarsMoved) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
        const previous = path.join(rollback, 'previous.db');
        if (fs.existsSync(previous)) fs.copyFileSync(previous, dbPath);
      }
      for (const { kind, existed } of movedDirs.reverse()) {
        fs.rmSync(path.join(parent, kind), { recursive: true, force: true });
        if (existed) fs.renameSync(path.join(rollback, kind), path.join(parent, kind));
      }
    }
    throw error;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
try { if (action === 'backup-sqlite') await backup(); else await restore(); }
catch (error) { console.error(`Falha de recuperação: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
EOF
}

case "$ACTION" in
  backup-sqlite|restore-sqlite)
    umask 077
    run_node_sqlite_recovery
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

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import type { InvestigationDataset } from "../types/investigation";
import { createInvestigationStore } from "../server/investigationStore";
import { createNexofisStore } from "../server/storage";

const SCRIPT = path.resolve("scripts/backup-restore.sh");
const ACTOR = {
  actorId: "synthetic-recovery-analyst",
  actorRole: "analyst",
  rationale: "Teste sintético de recuperação do acervo.",
};
const CASE = "synthetic-recovery-case";
const digest = (file: string) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function workspace(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexofis-recovery-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fixture(
  dir: string,
  text = "Documento sintético de recuperação íntegra.",
) {
  const db = path.join(dir, "case.db");
  const normal = createNexofisStore(db);
  const investigation = createInvestigationStore(db);
  const bytes = Buffer.from(text);
  const artifact = investigation.saveArtifact({
    ...ACTOR,
    contractId: CASE,
    filename: "evidence.txt",
    mimeType: "text/plain",
    bytes,
  });
  const ds: InvestigationDataset = {
    schemaVersion: "1.0",
    purpose: "Teste sintético de recuperação e integridade.",
    legalBasis: "Dados de teste, sem pessoas reais.",
    evidence: [
      {
        id: "e1",
        sourceName: "Documento sintético",
        sourceKind: "analyst_document",
        sourceUrl: null,
        retrievedAt: "2026-11-22T12:00:00Z",
        artifactSha256: artifact.artifactSha256,
        locator: "Documento completo sintético",
      },
    ],
    companyEvents: [],
    people: [],
    corporateLinks: [],
    publicRoles: [],
    familyLinks: [],
    competitions: [],
  };
  investigation.appendDataset({
    ...ACTOR,
    contractId: CASE,
    dataset: ds,
    expectedRevisionDigest: null,
  });
  const history = investigation.readHistory(CASE);
  investigation.close();
  normal.close();
  const object = path.join(
    dir,
    "investigation-objects",
    artifact.artifactSha256.slice(0, 2),
    `${artifact.artifactSha256}.bin`,
  );
  return { db, bytes, artifact, history, object };
}
function run(action: string, db: string, backups: string, target?: string) {
  return spawnSync("bash", [SCRIPT, action, ...(target ? [target] : [])], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
      NEXOFIS_SQLITE_PATH: db,
      NEXOFIS_BACKUP_DIR: backups,
    },
  });
}
function backup(db: string, backups: string): string {
  const result = run("backup-sqlite", db, backups);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const files = fs.readdirSync(backups).filter((name) => name.endsWith(".db"));
  assert.equal(files.length, 1);
  return path.join(backups, files[0]);
}
function makeTar(name: string, content: Buffer, type = "0", link = ""): Buffer {
  const header = Buffer.alloc(512);
  const put = (text: string, offset: number) =>
    header.write(text, offset, "ascii");
  put(name, 0);
  put("0000600\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(content.length.toString(8).padStart(11, "0") + "\0", 124);
  put("00000000000\0", 136);
  header.fill(32, 148, 156);
  put(type, 156);
  put(link, 157);
  put("ustar\0", 257);
  put("00", 263);
  const sum = header.reduce((a, b) => a + b, 0);
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return gzipSync(
    Buffer.concat([
      header,
      content,
      Buffer.alloc((512 - (content.length % 512)) % 512),
      Buffer.alloc(1024),
    ]),
  );
}

test("SQLite backup and restore preserve private originals, dataset and event hashchain in an empty destination", (t) => {
  const dir = workspace(t);
  const f = fixture(path.join(dir, "source"));
  const backups = path.join(dir, "backups");
  const saved = backup(f.db, backups);
  assert.ok(fs.existsSync(`${saved}.investigation-objects.tar.gz`));
  const dest = path.join(dir, "restored", "case.db");
  const result = run("restore-sqlite", dest, backups, saved);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const reopened = createInvestigationStore(dest);
  try {
    const history = reopened.readHistory(CASE);
    assert.equal(history.integrity.headHash, f.history.integrity.headHash);
    assert.equal(
      history.currentRevision?.datasetDigest,
      f.history.currentRevision?.datasetDigest,
    );
    assert.deepEqual(
      reopened.readArtifact(CASE, f.artifact.artifactSha256)?.bytes,
      f.bytes,
    );
    assert.equal(
      reopened.readArtifact(CASE, f.artifact.artifactSha256)?.verified,
      true,
    );
  } finally {
    reopened.close();
  }
});

test("missing private archive aborts restore before replacing an existing database or private object", (t) => {
  const dir = workspace(t);
  const f = fixture(path.join(dir, "source"));
  const current = fixture(
    path.join(dir, "current"),
    "Estado anterior que deve sobreviver.",
  );
  const backups = path.join(dir, "backups");
  const saved = backup(f.db, backups);
  fs.unlinkSync(`${saved}.investigation-objects.tar.gz`);
  const dbBefore = digest(current.db);
  const objectBefore = digest(current.object);
  const result = run("restore-sqlite", current.db, backups, saved);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /obrigatório ausente/);
  assert.equal(digest(current.db), dbBefore);
  assert.equal(digest(current.object), objectBefore);
});

test("a corrupt private object in a valid gzip/tar aborts restore without changing the target", (t) => {
  const dir = workspace(t);
  const f = fixture(path.join(dir, "source"));
  const current = fixture(
    path.join(dir, "current"),
    "Conteúdo anterior preservado.",
  );
  const backups = path.join(dir, "backups");
  const saved = backup(f.db, backups);
  const sha = f.artifact.artifactSha256;
  fs.writeFileSync(
    `${saved}.investigation-objects.tar.gz`,
    makeTar(
      `investigation-objects/${sha.slice(0, 2)}/${sha}.bin`,
      Buffer.alloc(f.bytes.length, 65),
    ),
  );
  const dbBefore = digest(current.db);
  const objectBefore = digest(current.object);
  const result = run("restore-sqlite", current.db, backups, saved);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA-256/);
  assert.equal(digest(current.db), dbBefore);
  assert.equal(digest(current.object), objectBefore);
});

test("tar traversal, symlink and hardlink entries are rejected before extraction or target changes", (t) => {
  const dir = workspace(t);
  const f = fixture(path.join(dir, "source"));
  const current = fixture(
    path.join(dir, "current"),
    "Estado prévio protegido.",
  );
  const backups = path.join(dir, "backups");
  const saved = backup(f.db, backups);
  const sha = f.artifact.artifactSha256;
  const objectPath = `investigation-objects/${sha.slice(0, 2)}/${sha}.bin`;
  const dbBefore = digest(current.db);
  const objectBefore = digest(current.object);
  for (const archive of [
    makeTar("../escape", f.bytes),
    makeTar(objectPath, Buffer.alloc(0), "2", "../../escape"),
    makeTar(objectPath, Buffer.alloc(0), "1", "../../escape"),
  ]) {
    fs.writeFileSync(`${saved}.investigation-objects.tar.gz`, archive);
    const result = run("restore-sqlite", current.db, backups, saved);
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(digest(current.db), dbBefore);
    assert.equal(digest(current.object), objectBefore);
    assert.equal(fs.existsSync(path.join(dir, "escape")), false);
  }
});

test("backup refuses missing or corrupted referenced originals and does not publish a complete database backup", (t) => {
  const dir = workspace(t);
  const f = fixture(path.join(dir, "source"));
  const backups = path.join(dir, "backups");
  fs.writeFileSync(f.object, Buffer.alloc(f.bytes.length, 90));
  const corrupt = run("backup-sqlite", f.db, backups);
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /SHA-256/);
  assert.equal(
    fs.readdirSync(backups).filter((file) => file.endsWith(".db")).length,
    0,
  );
  fs.unlinkSync(f.object);
  const missing = run("backup-sqlite", f.db, backups);
  assert.notEqual(missing.status, 0);
  assert.equal(
    fs.readdirSync(backups).filter((file) => file.endsWith(".db")).length,
    0,
  );
});

test("successful replacement preserves the former database and private originals for recovery", (t) => {
  const dir = workspace(t);
  const f = fixture(path.join(dir, "source"));
  const current = fixture(
    path.join(dir, "current"),
    "Versão anterior para rollback.",
  );
  const backups = path.join(dir, "backups");
  const saved = backup(f.db, backups);
  const result = run("restore-sqlite", current.db, backups, saved);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const parent = path.dirname(current.db);
  const rollback = fs
    .readdirSync(parent)
    .find((name) => name.startsWith("case.db.pre-restore-"));
  assert.ok(rollback);
  const prior = createInvestigationStore(
    path.join(parent, rollback, "previous.db"),
  );
  try {
    assert.equal(
      prior.readHistory(CASE).integrity.headHash,
      current.history.integrity.headHash,
    );
    assert.deepEqual(
      prior.readArtifact(CASE, current.artifact.artifactSha256)?.bytes,
      current.bytes,
    );
  } finally {
    prior.close();
  }
});

test("backup captures committed WAL events while the source connection is open", (t) => {
  const dir = workspace(t);
  const db = path.join(dir, "source", "case.db");
  const source = createInvestigationStore(db);
  try {
    source.saveArtifact({
      ...ACTOR,
      contractId: CASE,
      filename: "wal.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("Evento confirmado ainda presente no WAL."),
    });
    assert.ok(fs.statSync(`${db}-wal`).size > 0);
    const head = source.readHistory(CASE).integrity.headHash;
    const backups = path.join(dir, "backups");
    const saved = backup(db, backups);
    const dest = path.join(dir, "restored", "case.db");
    const result = run("restore-sqlite", dest, backups, saved);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const restored = createInvestigationStore(dest);
    try {
      assert.equal(restored.readHistory(CASE).integrity.headHash, head);
      assert.equal(restored.readHistory(CASE).artifacts.length, 1);
    } finally {
      restored.close();
    }
  } finally {
    source.close();
  }
});

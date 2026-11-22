import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  InvestigationDataset,
  InvestigationReview,
  InvestigationRevision,
} from "../types/investigation";

const MAX_CASE_EVENTS = 1000;
const MAX_CASE_BYTES = 16 * 1024 * 1024;

export function canonicalInvestigationJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalInvestigationJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalInvestigationJson(obj[key])}`,
    )
    .join(",")}}`;
}

export function investigationDigest(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(canonicalInvestigationJson(value))
    .digest("hex");
}

export class InvestigationIntegrityError extends Error {
  constructor() {
    super(
      "Falha de integridade no histórico da investigação. Consulta interrompida para preservar a evidência.",
    );
    this.name = "InvestigationIntegrityError";
  }
}
export class InvestigationConflictError extends Error {
  constructor(
    message = "A investigação mudou. Recarregue a versão atual antes de gravar.",
  ) {
    super(message);
    this.name = "InvestigationConflictError";
  }
}

export interface InvestigationArtifact {
  artifactSha256: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}
export interface InvestigationEvent {
  id: string;
  contractId: string;
  sequence: number;
  kind: "dataset" | "review" | "artifact";
  actorId: string;
  actorRole: string;
  createdAt: string;
  rationale: string;
  payload: Record<string, unknown>;
  previousEventHash: string | null;
  eventHash: string;
}
export interface InvestigationHistory {
  events: InvestigationEvent[];
  revisions: InvestigationRevision[];
  reviews: InvestigationReview[];
  artifacts: InvestigationArtifact[];
  currentRevision: InvestigationRevision | null;
  integrity: { valid: boolean; eventCount: number; headHash: string | null };
}
interface ActorInput {
  actorId: string;
  actorRole: string;
  rationale: string;
  createdAt?: string;
}

export function createInvestigationStore(dbPath: string) {
  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const objectsDir = path.join(path.dirname(resolved), "investigation-objects");
  fs.mkdirSync(objectsDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolved);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS investigation_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS investigation_events (
      contract_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('dataset','review','artifact')),
      event_json TEXT NOT NULL,
      previous_event_hash TEXT,
      event_hash TEXT NOT NULL,
      PRIMARY KEY(contract_id,sequence)
    );
    CREATE TRIGGER IF NOT EXISTS investigation_events_no_update BEFORE UPDATE ON investigation_events
      BEGIN SELECT RAISE(ABORT, 'Investigation history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS investigation_events_no_delete BEFORE DELETE ON investigation_events
      BEGIN SELECT RAISE(ABORT, 'Investigation history is append-only'); END;
  `);
  db.prepare(
    "INSERT OR IGNORE INTO investigation_schema_migrations(version, applied_at) VALUES(1,?)",
  ).run(new Date().toISOString());
  const rowsFor = db.prepare(
    "SELECT contract_id,sequence,id,kind,event_json,previous_event_hash,event_hash FROM investigation_events WHERE contract_id=? ORDER BY sequence ASC",
  );
  const limitsFor = db.prepare(
    "SELECT COUNT(*) AS cnt, COALESCE(SUM(length(CAST(event_json AS BLOB))),0) AS bytes FROM investigation_events WHERE contract_id=?",
  );
  const insert = db.prepare(
    "INSERT INTO investigation_events(contract_id,sequence,id,kind,event_json,previous_event_hash,event_hash) VALUES(?,?,?,?,?,?,?)",
  );

  function readHistory(contractId: string): InvestigationHistory {
    const limits = limitsFor.get(contractId) as { cnt: number; bytes: number };
    if (limits.cnt > MAX_CASE_EVENTS || limits.bytes > MAX_CASE_BYTES)
      throw new InvestigationIntegrityError();
    const rows = rowsFor.all(contractId) as Array<Record<string, unknown>>;
    const events: InvestigationEvent[] = [];
    let previous: string | null = null;
    for (const row of rows) {
      let event: InvestigationEvent;
      try {
        event = JSON.parse(String(row.event_json));
      } catch {
        throw new InvestigationIntegrityError();
      }
      if (
        !event ||
        typeof event !== "object" ||
        !event.payload ||
        event.sequence !== events.length + 1 ||
        event.contractId !== contractId ||
        event.sequence !== row.sequence ||
        event.id !== row.id ||
        event.kind !== row.kind ||
        event.previousEventHash !== previous ||
        row.previous_event_hash !== previous ||
        event.eventHash !== row.event_hash
      )
        throw new InvestigationIntegrityError();
      const { eventHash, ...unsigned } = event;
      if (investigationDigest(unsigned) !== eventHash)
        throw new InvestigationIntegrityError();
      if (
        event.kind === "dataset" &&
        investigationDigest(event.payload.dataset) !==
          event.payload.datasetDigest
      )
        throw new InvestigationIntegrityError();
      events.push(event);
      previous = eventHash;
    }
    const revisions: InvestigationRevision[] = events
      .filter((e) => e.kind === "dataset")
      .map(({ payload, kind: _, ...e }) => ({
        ...e,
        datasetDigest: String(payload.datasetDigest),
        dataset: payload.dataset as InvestigationDataset,
      }));
    const reviews: InvestigationReview[] = events
      .filter((e) => e.kind === "review")
      .map(({ payload, kind: _, ...e }) => ({
        ...e,
        findingId: String(payload.findingId),
        findingInputDigest: String(payload.findingInputDigest),
        action: payload.action as "dismiss" | "restore",
      }));
    const artifacts = events
      .filter((e) => e.kind === "artifact")
      .map((e) => e.payload as unknown as InvestigationArtifact);
    return {
      events,
      revisions,
      reviews,
      artifacts,
      currentRevision: revisions.at(-1) ?? null,
      integrity: { valid: true, eventCount: events.length, headHash: previous },
    };
  }

  function appendEvent(
    contractId: string,
    history: InvestigationHistory,
    kind: InvestigationEvent["kind"],
    payload: Record<string, unknown>,
    actor: ActorInput,
  ): InvestigationEvent {
    if (
      !actor.actorId ||
      !["admin", "analyst"].includes(actor.actorRole) ||
      actor.rationale.trim().length < 12
    )
      throw new Error("Autor e justificativa autenticados são obrigatórios.");
    const unsigned = {
      id: crypto.randomUUID(),
      contractId,
      sequence: history.events.length + 1,
      kind,
      actorId: actor.actorId,
      actorRole: actor.actorRole,
      createdAt: actor.createdAt ?? new Date().toISOString(),
      rationale: actor.rationale.trim(),
      payload,
      previousEventHash: history.integrity.headHash,
    };
    const event: InvestigationEvent = {
      ...unsigned,
      eventHash: investigationDigest(unsigned),
    };
    const serialized = canonicalInvestigationJson(event);
    const bytes =
      history.events.reduce(
        (sum, e) => sum + Buffer.byteLength(canonicalInvestigationJson(e)),
        0,
      ) + Buffer.byteLength(serialized);
    if (event.sequence > MAX_CASE_EVENTS || bytes > MAX_CASE_BYTES)
      throw new InvestigationConflictError(
        "Limite de histórico do caso atingido. Exporte e arquive antes de abrir um novo caso.",
      );
    insert.run(
      contractId,
      event.sequence,
      event.id,
      kind,
      serialized,
      event.previousEventHash,
      event.eventHash,
    );
    return event;
  }

  function transaction<T>(run: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function objectPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash))
      throw new Error("Hash de artefato inválido.");
    return path.join(objectsDir, hash.slice(0, 2), `${hash}.bin`);
  }

  return {
    objectsDir,
    close() {
      db.close();
    },
    readHistory,
    appendDataset(
      input: {
        contractId: string;
        dataset: InvestigationDataset;
        expectedRevisionDigest: string | null;
      } & ActorInput,
    ): InvestigationRevision {
      return transaction(() => {
        const history = readHistory(input.contractId);
        const datasetDigest = investigationDigest(input.dataset);
        // Exact retries are idempotent only against the current state, never an old revision.
        if (history.currentRevision?.datasetDigest === datasetDigest)
          return history.currentRevision;
        if (
          (history.currentRevision?.datasetDigest ?? null) !==
          input.expectedRevisionDigest
        )
          throw new InvestigationConflictError();
        const event = appendEvent(
          input.contractId,
          history,
          "dataset",
          { dataset: input.dataset, datasetDigest },
          input,
        );
        const { payload: _, kind: __, ...metadata } = event;
        return { ...metadata, dataset: input.dataset, datasetDigest };
      });
    },
    appendReview(
      input: {
        contractId: string;
        findingId: string;
        findingInputDigest: string;
        action: "dismiss" | "restore";
        expectedHeadHash: string | null;
      } & ActorInput,
    ): InvestigationReview {
      return transaction(() => {
        const history = readHistory(input.contractId);
        if (history.integrity.headHash !== input.expectedHeadHash)
          throw new InvestigationConflictError();
        const latest = history.reviews
          .filter(
            (r) =>
              r.findingId === input.findingId &&
              r.findingInputDigest === input.findingInputDigest,
          )
          .at(-1);
        if (
          latest?.action === input.action &&
          latest.actorId === input.actorId &&
          latest.rationale === input.rationale.trim()
        )
          return latest;
        const payload = {
          findingId: input.findingId,
          findingInputDigest: input.findingInputDigest,
          action: input.action,
        };
        const event = appendEvent(
          input.contractId,
          history,
          "review",
          payload,
          input,
        );
        const { payload: _, kind: __, ...metadata } = event;
        return { ...metadata, ...payload };
      });
    },
    saveArtifact(
      input: {
        contractId: string;
        filename: string;
        mimeType: string;
        bytes: Buffer;
      } & ActorInput,
    ): InvestigationArtifact {
      if (!input.bytes.length || input.bytes.length > 1024 * 1024)
        throw new Error("Artefato fora do limite de 1 MiB.");
      const artifactSha256 = crypto
        .createHash("sha256")
        .update(input.bytes)
        .digest("hex");
      const artifact: InvestigationArtifact = {
        artifactSha256,
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.bytes.length,
      };
      const file = objectPath(artifactSha256);
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      let createdObject = false;
      db.exec("BEGIN IMMEDIATE");
      try {
        const history = readHistory(input.contractId);
        const existing = history.artifacts.find(
          (a) => a.artifactSha256 === artifactSha256,
        );
        // Validate actor, chain and quotas BEFORE writing any new object. The lock
        // also serializes writers while the file is durably created.
        if (!existing || !fs.existsSync(file))
          appendEvent(
            input.contractId,
            history,
            "artifact",
            { ...artifact },
            existing
              ? {
                  ...input,
                  rationale: `Reaquisição de original ausente. ${input.rationale}`,
                }
              : input,
          );
        if (fs.existsSync(file)) {
          if (
            crypto
              .createHash("sha256")
              .update(fs.readFileSync(file))
              .digest("hex") !== artifactSha256
          )
            throw new InvestigationIntegrityError();
        } else {
          fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          const fd = fs.openSync(temp, "wx", 0o600);
          try {
            fs.writeFileSync(fd, input.bytes);
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
          fs.renameSync(temp, file);
          createdObject = true;
          if (process.platform !== "win32") {
            const directory = fs.openSync(path.dirname(file), "r");
            try {
              fs.fsyncSync(directory);
            } finally {
              fs.closeSync(directory);
            }
          }
        }
        db.exec("COMMIT");
        return existing ?? artifact;
      } catch (err) {
        // Delete only an object created by this transaction, while the write lock
        // is still held. Never remove an already shared, preserved original.
        try {
          if (fs.existsSync(temp)) fs.unlinkSync(temp);
          if (createdObject && fs.existsSync(file)) fs.unlinkSync(file);
        } finally {
          db.exec("ROLLBACK");
        }
        throw err;
      }
    },
    readArtifact(
      contractId: string,
      hash: string,
      knownHistory?: InvestigationHistory,
    ): {
      artifact: InvestigationArtifact;
      bytes: Buffer;
      verified: boolean;
    } | null {
      if (!/^[a-f0-9]{64}$/.test(hash)) return null;
      const artifact = (knownHistory ?? readHistory(contractId)).artifacts.find(
        (a) => a.artifactSha256 === hash,
      );
      if (!artifact) return null;
      const file = objectPath(hash);
      if (!fs.existsSync(file)) return null;
      const stat = fs.statSync(file);
      if (stat.size !== artifact.sizeBytes || stat.size > 1024 * 1024)
        return null;
      const bytes = fs.readFileSync(file);
      return {
        artifact,
        bytes,
        verified:
          crypto.createHash("sha256").update(bytes).digest("hex") === hash,
      };
    },
  };
}

export type InvestigationStore = ReturnType<typeof createInvestigationStore>;

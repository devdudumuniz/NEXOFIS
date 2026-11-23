import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type JobStatus = 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled';

export interface DurableJobRecord<TPayload = Record<string, unknown>> {
  id: string;
  jobType: string;
  idempotencyKey: string;
  payload: TPayload;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueJobInput<TPayload = Record<string, unknown>> {
  jobType: string;
  idempotencyKey: string;
  payload: TPayload;
  maxAttempts?: number;
  runAfter?: Date;
}

export class PermanentJobError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export interface DurableJobQueue {
  enqueue<TPayload = Record<string, unknown>>(
    input: EnqueueJobInput<TPayload>
  ): { job: DurableJobRecord<TPayload>; deduplicated: boolean };
  claimNext(workerId: string, leaseSeconds?: number, now?: Date): DurableJobRecord | null;
  heartbeat(jobId: string, workerId: string, leaseSeconds?: number, now?: Date): boolean;
  complete(jobId: string, workerId: string, result?: Record<string, unknown>, now?: Date): boolean;
  fail(
    jobId: string,
    workerId: string,
    error: unknown,
    options?: { baseBackoffSeconds?: number; now?: Date }
  ): DurableJobRecord | null;
  cancel(jobId: string, reason?: string, now?: Date): boolean;
  recoverExpiredLeases(now?: Date): number;
  getById(jobId: string): DurableJobRecord | null;
  listByStatus(status?: JobStatus, limit?: number): DurableJobRecord[];
  close(): void;
}

interface RawJobRow {
  id: string;
  job_type: string;
  idempotency_key: string;
  payload_json: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

function mapJobRow<TPayload = Record<string, unknown>>(row: RawJobRow): DurableJobRecord<TPayload> {
  return {
    id: row.id,
    jobType: row.job_type,
    idempotencyKey: row.idempotency_key,
    payload: JSON.parse(row.payload_json) as TPayload,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    result: row.result_json ? (JSON.parse(row.result_json) as Record<string, unknown>) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createDurableJobQueue(dbPath?: string): DurableJobQueue {
  const resolvedPath =
    dbPath ?? path.resolve(process.cwd(), 'data', 'nexofis-jobs.db');

  if (resolvedPath !== ':memory:') {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const db = new DatabaseSync(resolvedPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS durable_jobs (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      run_after TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      last_error TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_durable_jobs_claim
      ON durable_jobs (status, run_after);
    CREATE INDEX IF NOT EXISTS idx_durable_jobs_lease
      ON durable_jobs (status, lease_expires_at);
  `);

  const selectByKey = db.prepare('SELECT * FROM durable_jobs WHERE idempotency_key = ?');
  const selectById = db.prepare('SELECT * FROM durable_jobs WHERE id = ?');
  const insertJob = db.prepare(`
    INSERT INTO durable_jobs (
      id, job_type, idempotency_key, payload_json, status,
      attempts, max_attempts, run_after, lease_owner, lease_expires_at,
      last_error, result_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
  `);

  function recoverExpiredLeases(now = new Date()): number {
    const nowIso = now.toISOString();
    const expired = db
      .prepare(
        `SELECT id, attempts, max_attempts FROM durable_jobs
         WHERE status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`
      )
      .all(nowIso) as Array<{ id: string; attempts: number; max_attempts: number }>;

    let recovered = 0;
    for (const row of expired) {
      const nextStatus: JobStatus = row.attempts >= row.max_attempts ? 'failed' : 'queued';
      const errMsg =
        nextStatus === 'failed'
          ? 'Lease expirado após atingir o limite máximo de tentativas.'
          : 'Lease expirado; job devolvido automaticamente à fila.';
      const res = db
        .prepare(
          `UPDATE durable_jobs
           SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
               last_error = ?, run_after = ?, updated_at = ?
           WHERE id = ? AND status = 'processing'`
        )
        .run(nextStatus, errMsg, nowIso, nowIso, row.id);
      if (Number(res.changes) > 0) recovered += 1;
    }
    return recovered;
  }

  return {
    enqueue<TPayload = Record<string, unknown>>(input: EnqueueJobInput<TPayload>) {
      const existing = selectByKey.get(input.idempotencyKey) as unknown as RawJobRow | undefined;
      if (existing) {
        return { job: mapJobRow<TPayload>(existing), deduplicated: true };
      }

      const id = `JOB-${crypto.randomUUID()}`;
      const nowIso = new Date().toISOString();
      const runAfterIso = (input.runAfter ?? new Date()).toISOString();
      const maxAttempts = Math.max(1, Math.min(input.maxAttempts ?? 3, 10));

      insertJob.run(
        id,
        input.jobType,
        input.idempotencyKey,
        JSON.stringify(input.payload),
        maxAttempts,
        runAfterIso,
        nowIso,
        nowIso
      );

      const created = selectById.get(id) as unknown as RawJobRow;
      return { job: mapJobRow<TPayload>(created), deduplicated: false };
    },

    recoverExpiredLeases,

    claimNext(workerId: string, leaseSeconds = 60, now = new Date()): DurableJobRecord | null {
      recoverExpiredLeases(now);
      const nowIso = now.toISOString();
      const leaseUntil = new Date(now.getTime() + Math.max(5, leaseSeconds) * 1000).toISOString();

      const candidate = db
        .prepare(
          `SELECT * FROM durable_jobs
           WHERE status = 'queued' AND run_after <= ?
           ORDER BY run_after ASC, created_at ASC
           LIMIT 1`
        )
        .get(nowIso) as unknown as RawJobRow | undefined;

      if (!candidate) return null;

      const updated = db
        .prepare(
          `UPDATE durable_jobs
           SET status = 'processing',
               attempts = attempts + 1,
               lease_owner = ?,
               lease_expires_at = ?,
               updated_at = ?
           WHERE id = ? AND status = 'queued'`
        )
        .run(workerId, leaseUntil, nowIso, candidate.id);

      if (Number(updated.changes) === 0) return null;
      const claimed = selectById.get(candidate.id) as unknown as RawJobRow | undefined;
      return claimed ? mapJobRow(claimed) : null;
    },

    heartbeat(jobId: string, workerId: string, leaseSeconds = 60, now = new Date()): boolean {
      const nowIso = now.toISOString();
      const leaseUntil = new Date(now.getTime() + Math.max(5, leaseSeconds) * 1000).toISOString();
      const res = db
        .prepare(
          `UPDATE durable_jobs
           SET lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND status = 'processing' AND lease_owner = ?`
        )
        .run(leaseUntil, nowIso, jobId, workerId);
      return Number(res.changes) > 0;
    },

    complete(
      jobId: string,
      workerId: string,
      result?: Record<string, unknown>,
      now = new Date()
    ): boolean {
      const nowIso = now.toISOString();
      const res = db
        .prepare(
          `UPDATE durable_jobs
           SET status = 'succeeded',
               lease_owner = NULL,
               lease_expires_at = NULL,
               result_json = ?,
               last_error = NULL,
               updated_at = ?
           WHERE id = ? AND status = 'processing' AND lease_owner = ?`
        )
        .run(result ? JSON.stringify(result) : null, nowIso, jobId, workerId);
      return Number(res.changes) > 0;
    },

    fail(
      jobId: string,
      workerId: string,
      error: unknown,
      options?: { baseBackoffSeconds?: number; now?: Date }
    ): DurableJobRecord | null {
      const current = selectById.get(jobId) as unknown as RawJobRow | undefined;
      if (!current || current.status !== 'processing' || current.lease_owner !== workerId) {
        return null;
      }

      const now = options?.now ?? new Date();
      const nowIso = now.toISOString();
      const isPermanent =
        error instanceof PermanentJobError ||
        (typeof error === 'object' && error !== null && (error as { permanent?: boolean }).permanent === true);
      const errMessage = error instanceof Error ? error.message : String(error);

      const exhausted = isPermanent || current.attempts >= current.max_attempts;
      const nextStatus: JobStatus = exhausted ? 'failed' : 'queued';
      const baseBackoff = Math.max(1, options?.baseBackoffSeconds ?? 15);
      const backoffSeconds = Math.min(3600, baseBackoff * Math.pow(2, Math.max(0, current.attempts - 1)));
      const nextRunAfter = exhausted
        ? nowIso
        : new Date(now.getTime() + backoffSeconds * 1000).toISOString();

      db.prepare(
        `UPDATE durable_jobs
         SET status = ?,
             lease_owner = NULL,
             lease_expires_at = NULL,
             last_error = ?,
             run_after = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(nextStatus, errMessage.slice(0, 1000), nextRunAfter, nowIso, jobId);

      const updated = selectById.get(jobId) as unknown as RawJobRow | undefined;
      return updated ? mapJobRow(updated) : null;
    },

    cancel(jobId: string, reason = 'Cancelado manualmente.', now = new Date()): boolean {
      const nowIso = now.toISOString();
      const res = db
        .prepare(
          `UPDATE durable_jobs
           SET status = 'cancelled',
               lease_owner = NULL,
               lease_expires_at = NULL,
               last_error = ?,
               updated_at = ?
           WHERE id = ? AND status IN ('queued', 'processing')`
        )
        .run(reason.slice(0, 500), nowIso, jobId);
      return Number(res.changes) > 0;
    },

    getById(jobId: string): DurableJobRecord | null {
      const row = selectById.get(jobId) as unknown as RawJobRow | undefined;
      return row ? mapJobRow(row) : null;
    },

    listByStatus(status?: JobStatus, limit = 50): DurableJobRecord[] {
      const safeLimit = Math.max(1, Math.min(limit, 500));
      const rows = status
        ? (db
            .prepare(
              'SELECT * FROM durable_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?'
            )
            .all(status, safeLimit) as unknown as RawJobRow[])
        : (db
            .prepare('SELECT * FROM durable_jobs ORDER BY created_at DESC LIMIT ?')
            .all(safeLimit) as unknown as RawJobRow[]);
      return rows.map((row) => mapJobRow(row));
    },

    close() {
      db.close();
    },
  };
}

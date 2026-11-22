import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { NextFunction, Response } from 'express';
import {
  FIXTURE_SUSPENDED_PAVING,
  TEST_FIXTURE_CONTRACTS,
} from './__fixtures__/testContracts';
import {
  matchesContractLifecycleFilter,
  normalizeLifecycleFilterParam,
  resolveContractLifecycleStatus,
} from './contractStatus';
import { aggregateRiskDashboard } from './dashboardAggregator';
import { evaluateContractRisk } from './riskEngine';
import {
  createAuthMiddleware,
  hashPasswordScrypt,
  signNexofisToken,
  verifyNexofisToken,
  verifyPasswordScrypt,
  type AuthenticatedRequest,
} from '../server/authMiddleware';
import {
  checkExternalOcrHealth,
  convertWithDoclingServe,
  extractWithPaddleOcrWorker,
} from '../server/doclingClient';
import { createDurableJobQueue, PermanentJobError } from '../server/jobQueue';
import {
  queryCguSanctionsByCnpj,
  querySiconfiRreo,
} from '../server/connectors/portalTransparenciaClient';
import type { EvaluatedContract } from '../types/audit';

function evaluateFixtures(): EvaluatedContract[] {
  return TEST_FIXTURE_CONTRACTS.map((contract) => ({
    ...contract,
    assessment: evaluateContractRisk(contract),
    reviews: [],
  }));
}

test('contractStatus maps active, completed (by status or expired endDate), and suspended contracts deterministically', () => {
  const ref = '2026-11-21';

  assert.equal(
    resolveContractLifecycleStatus({ status: 'Vigente', endDate: '2026-12-31' }, ref),
    'em_andamento'
  );
  assert.equal(
    resolveContractLifecycleStatus({ status: 'Em Execução', endDate: '2027-01-15' }, ref),
    'em_andamento'
  );
  assert.equal(
    resolveContractLifecycleStatus({ status: 'Encerrado', endDate: '2027-01-15' }, ref),
    'concluido'
  );
  assert.equal(
    resolveContractLifecycleStatus({ status: 'Vigente', endDate: '2026-10-04' }, ref),
    'concluido'
  );
  assert.equal(
    resolveContractLifecycleStatus({ status: 'Suspenso', endDate: '2026-12-31' }, ref),
    'suspenso'
  );
  assert.equal(
    resolveContractLifecycleStatus(
      { status: 'Rescindido' as unknown as EvaluatedContract['status'], endDate: '2026-12-31' },
      ref
    ),
    'suspenso'
  );

  assert.equal(normalizeLifecycleFilterParam('Em Andamento'), 'em_andamento');
  assert.equal(normalizeLifecycleFilterParam('concluído'), 'concluido');
  assert.equal(normalizeLifecycleFilterParam('SUSPENSO'), 'suspenso');
  assert.equal(normalizeLifecycleFilterParam('todos'), '');

  assert.equal(
    matchesContractLifecycleFilter({ status: 'Suspenso', endDate: '2026-12-31' }, 'suspenso', ref),
    true
  );
  assert.equal(
    matchesContractLifecycleFilter({ status: 'Suspenso', endDate: '2026-12-31' }, 'em_andamento', ref),
    false
  );
});

test('TEST_FIXTURE_CONTRACTS covers all three lifecycle statuses (Em Andamento, Concluído, Suspenso)', () => {
  const ref = '2026-11-21';
  const emAndamento = TEST_FIXTURE_CONTRACTS.filter((c) =>
    matchesContractLifecycleFilter(c, 'em_andamento', ref)
  );
  const concluido = TEST_FIXTURE_CONTRACTS.filter((c) =>
    matchesContractLifecycleFilter(c, 'concluido', ref)
  );
  const suspenso = TEST_FIXTURE_CONTRACTS.filter((c) =>
    matchesContractLifecycleFilter(c, 'suspenso', ref)
  );

  assert.ok(emAndamento.length >= 1, 'Expected at least one Em Andamento contract');
  assert.ok(concluido.length >= 1, 'Expected at least one Concluído contract');
  assert.ok(suspenso.length >= 1, 'Expected at least one Suspenso contract');
  assert.ok(suspenso.some((c) => c.id === FIXTURE_SUSPENDED_PAVING.id));
});

test('dashboardAggregator computes Top 5 high-risk organs and municipalities concentration accurately', () => {
  const evaluated = evaluateFixtures();
  const summary = aggregateRiskDashboard(evaluated);

  assert.ok(summary.topHighRiskOrgans.length > 0 && summary.topHighRiskOrgans.length <= 5);
  assert.ok(summary.topHighRiskMunicipalities.length > 0 && summary.topHighRiskMunicipalities.length <= 5);

  // Verify strict descending ordering by highRiskCount (then highRiskValue / maxScore)
  for (let i = 1; i < summary.topHighRiskOrgans.length; i++) {
    const prev = summary.topHighRiskOrgans[i - 1];
    const curr = summary.topHighRiskOrgans[i];
    assert.ok(
      prev.highRiskCount >= curr.highRiskCount,
      `Expected organ ${prev.entityName} (${prev.highRiskCount}) >= ${curr.entityName} (${curr.highRiskCount})`
    );
  }

  for (const muni of summary.topHighRiskMunicipalities) {
    assert.ok(muni.highRiskCount > 0);
    assert.ok(muni.highRiskSharePct >= 0 && muni.highRiskSharePct <= 100);
    assert.ok(muni.totalContracts >= muni.highRiskCount);
  }
});

test('authMiddleware signs/verifies HMAC tokens, hashes scrypt passwords, and enforces RBAC when enabled', () => {
  const testSecret = 'unit-test-secret-key-with-sufficient-entropy-0123456789';
  const nowSec = 1_800_000_000;

  const adminToken = signNexofisToken(
    { sub: 'usr-1', email: 'auditor@nexofis.org', role: 'admin' },
    { secret: testSecret, ttlSeconds: 600, nowSeconds: nowSec }
  );
  const viewerToken = signNexofisToken(
    { sub: 'usr-2', email: 'leitor@nexofis.org', role: 'viewer' },
    { secret: testSecret, ttlSeconds: 600, nowSeconds: nowSec }
  );

  const okCheck = verifyNexofisToken(adminToken, { secret: testSecret, nowSeconds: nowSec + 10 });
  assert.equal(okCheck.valid, true);
  if (okCheck.valid) {
    assert.equal(okCheck.payload.role, 'admin');
    assert.equal(okCheck.payload.sub, 'usr-1');
  }

  const expiredCheck = verifyNexofisToken(adminToken, {
    secret: testSecret,
    nowSeconds: nowSec + 601,
  });
  assert.equal(expiredCheck.valid, false);

  const wrongSecretCheck = verifyNexofisToken(adminToken, {
    secret: 'different-secret',
    nowSeconds: nowSec + 10,
  });
  assert.equal(wrongSecretCheck.valid, false);

  // Password scrypt verification
  const storedHash = hashPasswordScrypt('S3nha-Forte-Auditoria!');
  assert.equal(verifyPasswordScrypt('S3nha-Forte-Auditoria!', storedHash), true);
  assert.equal(verifyPasswordScrypt('senha-errada', storedHash), false);

  // Express middleware pass-through when auth disabled
  const disabledMw = createAuthMiddleware({ allowedRoles: ['admin'], enforceOverride: false });
  let nextCalled = false;
  const reqOpen = { headers: {} } as AuthenticatedRequest;
  const mockRes = () => {
    let statusCode = 200;
    let body: unknown = null;
    const res = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(payload: unknown) {
        body = payload;
        return res;
      },
    } as unknown as Response;
    return { res, getStatus: () => statusCode, getBody: () => body };
  };

  disabledMw(reqOpen, mockRes().res, (() => {
    nextCalled = true;
  }) as NextFunction);
  assert.equal(nextCalled, true);
  assert.equal(reqOpen.nexofisPrincipal?.authEnabled, false);

  // Enforced middleware rejects missing token with 401 and insufficient role with 403
  const enforcedMw = createAuthMiddleware({
    allowedRoles: ['admin', 'analyst'],
    enforceOverride: true,
    secret: testSecret,
  });

  const missingRes = mockRes();
  enforcedMw({ headers: {} } as AuthenticatedRequest, missingRes.res, (() => {
    assert.fail('Should not call next without token');
  }) as NextFunction);
  assert.equal(missingRes.getStatus(), 401);

  const forbiddenRes = mockRes();
  const liveViewerToken = signNexofisToken(
    { sub: 'usr-2', role: 'viewer' },
    { secret: testSecret, ttlSeconds: 300 }
  );
  enforcedMw(
    { headers: { authorization: `Bearer ${liveViewerToken}` } } as AuthenticatedRequest,
    forbiddenRes.res,
    (() => {
      assert.fail('Should not allow viewer on admin/analyst endpoint');
    }) as NextFunction
  );
  assert.equal(forbiddenRes.getStatus(), 403);

  const liveAdminToken = signNexofisToken(
    { sub: 'usr-1', role: 'admin' },
    { secret: testSecret, ttlSeconds: 300 }
  );
  let adminPassed = false;
  const adminReq = {
    headers: { authorization: `Bearer ${liveAdminToken}` },
  } as AuthenticatedRequest;
  enforcedMw(adminReq, mockRes().res, (() => {
    adminPassed = true;
  }) as NextFunction);
  assert.equal(adminPassed, true);
  assert.equal(adminReq.nexofisPrincipal?.role, 'admin');
});

test('durableJobQueue guarantees idempotency, survives restart with lease recovery, retries with backoff, and supports permanent failure & cancel', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexofis-jobs-'));
  const dbPath = path.join(tmpDir, 'jobs.db');

  try {
    const q1 = createDurableJobQueue(dbPath);
    const t0 = new Date('2026-11-21T12:00:00.000Z');

    // Idempotency deduplication
    const first = q1.enqueue({
      jobType: 'pncp_sync',
      idempotencyKey: 'pncp:2902906:2026',
      payload: { ibgeCode: '2902906' },
      maxAttempts: 3,
      runAfter: t0,
    });
    const dup = q1.enqueue({
      jobType: 'pncp_sync',
      idempotencyKey: 'pncp:2902906:2026',
      payload: { ibgeCode: '2902906' },
      maxAttempts: 3,
      runAfter: t0,
    });
    assert.equal(first.deduplicated, false);
    assert.equal(dup.deduplicated, true);
    assert.equal(dup.job.id, first.job.id);

    // Worker 1 claims job with 30s lease and crashes (closes DB without completing)
    const claimed = q1.claimNext('worker-1', 30, t0);
    assert.ok(claimed);
    assert.equal(claimed.status, 'processing');
    assert.equal(claimed.attempts, 1);
    q1.close();

    // Reopen queue after restart; after lease expiry (+45s), worker-2 recovers & claims it
    const q2 = createDurableJobQueue(dbPath);
    const tAfterLease = new Date(t0.getTime() + 45_000);
    const recoveredCount = q2.recoverExpiredLeases(tAfterLease);
    assert.equal(recoveredCount, 1);

    const reclaimed = q2.claimNext('worker-2', 60, tAfterLease);
    assert.ok(reclaimed);
    assert.equal(reclaimed.id, first.job.id);
    assert.equal(reclaimed.attempts, 2);

    // Transient error schedules retry with backoff
    const retried = q2.fail(reclaimed.id, 'worker-2', new Error('PNCP HTTP 503'), {
      baseBackoffSeconds: 20,
      now: tAfterLease,
    });
    assert.equal(retried?.status, 'queued');
    assert.ok(retried && new Date(retried.runAfter).getTime() > tAfterLease.getTime());

    // Permanent error marks job failed immediately
    const perm = q2.enqueue({
      jobType: 'ocr_pdf',
      idempotencyKey: 'ocr:bad-file',
      payload: { sha256: 'abc' },
      maxAttempts: 3,
      runAfter: tAfterLease,
    });
    const permClaim = q2.claimNext('worker-2', 60, tAfterLease);
    assert.equal(permClaim?.id, perm.job.id);
    const permFailed = q2.fail(perm.job.id, 'worker-2', new PermanentJobError('Arquivo corrompido'), {
      now: tAfterLease,
    });
    assert.equal(permFailed?.status, 'failed');

    // Cancel queued job
    const cancelledOk = q2.cancel(first.job.id, 'Cancelado pelo operador', tAfterLease);
    assert.equal(cancelledOk, true);
    assert.equal(q2.getById(first.job.id)?.status, 'cancelled');
    q2.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('doclingClient and portalTransparenciaClient report honest unconfigured/offline status without mocking', async () => {
  const prevDocling = process.env.DOCLING_SERVE_URL;
  const prevPaddle = process.env.PADDLE_OCR_URL;
  const prevCgu = process.env.PORTAL_TRANSPARENCIA_API_KEY;
  delete process.env.DOCLING_SERVE_URL;
  delete process.env.PADDLE_OCR_URL;
  delete process.env.PORTAL_TRANSPARENCIA_API_KEY;

  try {
    const doclingRes = await convertWithDoclingServe(
      Buffer.from('%PDF-1.4'),
      'teste.pdf',
      'application/pdf'
    );
    assert.equal(doclingRes.status, 'source_unavailable');

    const paddleRes = await extractWithPaddleOcrWorker(
      Buffer.from('fake'),
      'scan.png',
      'image/png'
    );
    assert.equal(paddleRes.status, 'source_unavailable');

    const health = await checkExternalOcrHealth();
    assert.equal(health.doclingServe.configured, false);
    assert.equal(health.paddleOcr.configured, false);

    const cguRes = await queryCguSanctionsByCnpj('10.562.589/0001-75');
    assert.equal(cguRes.status, 'api_key_required');
    assert.equal(cguRes.sanctions.length, 0);

    const siconfiInvalid = await querySiconfiRreo('123', 2026, 6);
    assert.equal(siconfiInvalid.status, 'invalid_params');
    assert.ok(siconfiInvalid.aggregateOnlyNotice.includes('agregados'));
  } finally {
    if (prevDocling !== undefined) process.env.DOCLING_SERVE_URL = prevDocling;
    if (prevPaddle !== undefined) process.env.PADDLE_OCR_URL = prevPaddle;
    if (prevCgu !== undefined) process.env.PORTAL_TRANSPARENCIA_API_KEY = prevCgu;
  }
});

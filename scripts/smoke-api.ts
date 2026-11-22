/**
 * NEXOFIS Real HTTP End-to-End Smoke Test
 *
 * Spawns server.ts on an isolated port with a fresh temporary SQLite DB,
 * NODE_ENV=production (fail-closed auth), and verifies:
 *  1. GET /api/health returns JSON { status: 'ok' }
 *  2. Fresh DB has 0 contracts (zero hardcoded seed data)
 *  3. Unauthenticated POST /api/dossiers returns 401 (fail-closed)
 *  4. POST /api/auth/bootstrap-admin + POST /api/auth/login issues Bearer token
 *  5. POST /api/documents/upload persists verified original bytes (SHA-256 intact via GET /api/documents/:sha256/original)
 *  6. POST /api/contracts/:id/findings/:findingId/review derives actor from server session & rejects bogus findingId (404)
 *  7. POST /api/dossiers saves immutable snapshot & GET /api/dossiers/:id reopens exact snapshot
 *  8. GET /api/ocr/status does NOT leak internal service URLs
 *  9. Restarting server over the same SQLite path preserves contracts, dossiers, and reviews
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const PORT = 3200 + Math.floor(Math.random() * 500);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SESSION_SECRET = 'nexofis-smoke-test-production-secret-key-0123456789';

async function waitForHealth(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) {
        const data = (await res.json()) as { status?: string };
        if (data.status === 'ok') return;
      }
    } catch {
      // keep polling until deadline
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${BASE_URL}/api/health`);
}

function startServer(dbPath: string, jobsDbPath: string): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      DISABLE_HMR: 'true',
      NEXOFIS_SQLITE_PATH: dbPath,
      NEXOFIS_JOBS_DB_PATH: jobsDbPath,
      NEXOFIS_SESSION_SECRET: SESSION_SECRET,
      DOCLING_SERVE_URL: 'http://10.0.0.42:5001/internal-secret-host',
      PADDLE_OCR_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString();
    if (!text.includes('ExperimentalWarning')) {
      process.stderr.write(`[smoke-server] ${text}`);
    }
  });
  return child;
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexofis-smoke-'));
  const dbPath = path.join(tmpDir, 'nexofis-smoke.db');
  const jobsDbPath = path.join(tmpDir, 'nexofis-smoke-jobs.db');

  let server = startServer(dbPath, jobsDbPath);
  try {
    await waitForHealth();
    console.log('[smoke] 1. /api/health OK');

    // 2. Fresh DB has 0 contracts & OCR status redacts internal URLs
    const emptySearchRes = await fetch(`${BASE_URL}/api/contracts/search?q=123`);
    assert.equal(emptySearchRes.status, 200);
    const emptySearch = (await emptySearchRes.json()) as { total: number; contracts: unknown[] };
    assert.equal(emptySearch.total, 0, 'Fresh DB must contain 0 seed contracts');
    console.log('[smoke] 2. Fresh DB = 0 contracts OK');

    const ocrRes = await fetch(`${BASE_URL}/api/ocr/status`);
    assert.equal(ocrRes.status, 200);
    const ocrText = await ocrRes.text();
    assert.ok(
      !ocrText.includes('10.0.0.42') && !ocrText.includes('internal-secret-host'),
      'OCR status must redact internal URLs'
    );
    console.log('[smoke] 3. /api/ocr/status internal URL redaction OK');

    // 3. Unauthenticated write -> 401 fail-closed
    const unauthDossier = await fetch(`${BASE_URL}/api/dossiers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractId: 'ANY', analystNote: 'Should fail' }),
    });
    assert.equal(unauthDossier.status, 401, 'Production POST /api/dossiers must reject unauthenticated requests with 401');
    console.log('[smoke] 4. Production fail-closed 401 OK');

    // 4. Bootstrap admin + login
    const bootRes = await fetch(`${BASE_URL}/api/auth/bootstrap-admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@nexofis.local',
        password: 'SuperStrongPassword!2026',
        displayName: 'Auditor Chefe Smoke',
      }),
    });
    assert.equal(bootRes.status, 201);

    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@nexofis.local',
        password: 'SuperStrongPassword!2026',
      }),
    });
    assert.equal(loginRes.status, 200);
    const loginBody = (await loginRes.json()) as { token: string; principal: { role: string } };
    assert.ok(loginBody.token.length > 20);
    assert.equal(loginBody.principal.role, 'admin');
    const authHeader = { Authorization: `Bearer ${loginBody.token}` };
    console.log('[smoke] 5. Bootstrap admin + Bearer login OK');

    // 5. Real TXT document upload + original binary integrity verification
    const sampleDocText = [
      'CONTRATO ADMINISTRATIVO Nº 777/2026',
      'CONTRATANTE: Prefeitura Municipal Teste (IBGE 2910800)',
      'CONTRATADA: Empresa Smoke Ltda, CNPJ 00.000.000/E08G-12',
      'OBJETO: Prestação de serviços de manutenção predial preventiva',
      'Valor global inicial: R$ 120.000,00. Valor atualizado: R$ 180.000,00.',
      'Assinado em 15/03/2026.',
    ].join('\n');
    const rawBytes = Buffer.from(sampleDocText, 'utf8');
    const expectedSha = crypto.createHash('sha256').update(rawBytes).digest('hex');

    const form = new FormData();
    form.append('file', new Blob([rawBytes], { type: 'text/plain' }), 'contrato-777-2026.txt');

    const uploadRes = await fetch(`${BASE_URL}/api/documents/upload`, {
      method: 'POST',
      headers: authHeader,
      body: form,
    });
    assert.equal(uploadRes.status, 201, `Upload failed: ${await uploadRes.clone().text()}`);
    const uploadJson = (await uploadRes.json()) as {
      sha256: string;
      originalObjectStored: boolean;
      originalDownloadUrl: string;
      contract: {
        id: string;
        supplier: { cnpj: string };
        assessment: { indicators: Array<{ findingId: string; code: string }> };
      };
    };
    assert.equal(uploadJson.sha256, expectedSha);
    assert.equal(uploadJson.originalObjectStored, true);
    assert.equal(uploadJson.contract.supplier.cnpj, '00000000E08G12');

    // Download original binary and verify exact SHA-256
    const dlRes = await fetch(`${BASE_URL}${uploadJson.originalDownloadUrl}`);
    assert.equal(dlRes.status, 200);
    const dlBytes = Buffer.from(await dlRes.arrayBuffer());
    const dlSha = crypto.createHash('sha256').update(dlBytes).digest('hex');
    assert.equal(dlSha, expectedSha, 'Downloaded original binary SHA-256 must match uploaded bytes');
    console.log('[smoke] 6. Document upload + alphanumeric CNPJ + original binary SHA-256 OK');

    const contractId = uploadJson.contract.id;

    // 6. Bogus findingId rejected with 404; valid finding review derives actor from server session
    const bogusRev = await fetch(
      `${BASE_URL}/api/contracts/${encodeURIComponent(contractId)}/findings/FND-DOES-NOT-EXIST/review`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          action: 'dismiss',
          rationale: 'Tentativa de revisar achado inexistente.',
          author: 'Spoofed Name Should Be Ignored',
        }),
      }
    );
    assert.equal(bogusRev.status, 404, 'Review of unknown findingId must return 404');

    const firstFinding = uploadJson.contract.assessment.indicators[0];
    assert.ok(firstFinding, 'Uploaded contract with +50% value variation should trigger at least one finding');
    const validRevRes = await fetch(
      `${BASE_URL}/api/contracts/${encodeURIComponent(contractId)}/findings/${encodeURIComponent(firstFinding.findingId)}/review`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          action: 'dismiss',
          rationale: 'Aditivo justificado em processo administrativo verificado pelo auditor.',
          author: 'Spoofed Attacker Name',
        }),
      }
    );
    assert.equal(validRevRes.status, 201);
    const validRevJson = (await validRevRes.json()) as {
      review: { author: string; actorRole: string; findingInputsDigest?: string };
    };
    assert.equal(
      validRevJson.review.author,
      'Auditor Chefe Smoke',
      'Review author MUST be derived from authenticated session, never client body'
    );
    assert.equal(validRevJson.review.actorRole, 'admin');
    console.log('[smoke] 7. Finding review server-derived actor + bogus findingId 404 OK');

    // 7. Save immutable dossier snapshot & verify GET /api/dossiers/:id
    const saveDosRes = await fetch(`${BASE_URL}/api/dossiers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({
        contractId,
        analystNote: 'Snapshot imutável verificado no smoke test.',
      }),
    });
    assert.equal(saveDosRes.status, 201);
    const savedDos = (await saveDosRes.json()) as { dossier: { id: string; hasSnapshot: boolean } };
    assert.equal(savedDos.dossier.hasSnapshot, true);

    const snapRes = await fetch(`${BASE_URL}/api/dossiers/${encodeURIComponent(savedDos.dossier.id)}`);
    assert.equal(snapRes.status, 200);
    const snapJson = (await snapRes.json()) as {
      dossier: {
        snapshotContract: { id: string };
        snapshotReviews: Array<{ author: string }>;
      };
    };
    assert.equal(snapJson.dossier.snapshotContract.id, contractId);
    assert.equal(snapJson.dossier.snapshotReviews.length, 1);
    assert.equal(snapJson.dossier.snapshotReviews[0].author, 'Auditor Chefe Smoke');
    console.log('[smoke] 8. Immutable dossier snapshot save & reopen OK');

    // 8. Restart server over same SQLite DB & verify persistence
    await stopServer(server);
    server = startServer(dbPath, jobsDbPath);
    await waitForHealth();

    const afterRestartContract = await fetch(`${BASE_URL}/api/contracts/${encodeURIComponent(contractId)}`);
    assert.equal(afterRestartContract.status, 200);
    const afterRestartDossiers = await fetch(`${BASE_URL}/api/dossiers`);
    assert.equal(afterRestartDossiers.status, 200);
    const dossiersBody = (await afterRestartDossiers.json()) as { dossiers: Array<{ id: string }> };
    assert.equal(dossiersBody.dossiers.length, 1);
    assert.equal(dossiersBody.dossiers[0].id, savedDos.dossier.id);

    const afterRestartReviews = await fetch(
      `${BASE_URL}/api/contracts/${encodeURIComponent(contractId)}/reviews`
    );
    assert.equal(afterRestartReviews.status, 200);
    const reviewsBody = (await afterRestartReviews.json()) as { reviews: Array<{ author: string }> };
    assert.equal(reviewsBody.reviews.length, 1);
    console.log('[smoke] 9. Persistence across full server restart OK');

    // 9. Unmatched /api/* returns JSON 404
    const notFoundApi = await fetch(`${BASE_URL}/api/does-not-exist`);
    assert.equal(notFoundApi.status, 404);
    const ct = notFoundApi.headers.get('content-type') || '';
    assert.ok(ct.includes('application/json'), 'Unmatched /api/* must return JSON 404');
    console.log('[smoke] 10. Unmatched /api/* JSON 404 OK');

    console.log('ALL SMOKE CHECKS PASSED!');
  } finally {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err);
  process.exit(1);
});

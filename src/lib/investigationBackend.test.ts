import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import express from "express";
import { FIXTURE_HIGH_RISK } from "./__fixtures__/testContracts";
import { computeCnpjCheckDigits } from "./cnpj";
import { evaluateInvestigation } from "./investigationEngine";
import type {
  InvestigationDataset,
  InvestigationResponse,
} from "../types/investigation";
import { signNexofisToken } from "../server/authMiddleware";
import { fetchCompanyRegistryEvidence } from "../server/companyRegistryEvidence";
import { mountInvestigationRoutes } from "../server/investigationRoutes";
import {
  createInvestigationStore,
  investigationDigest,
  InvestigationConflictError,
  InvestigationIntegrityError,
} from "../server/investigationStore";
import {
  validateInvestigationDataset,
  validateInvestigationSourceUrl,
  validateInvestigationSubmission,
} from "../server/investigationValidation";
import { createNexofisStore } from "../server/storage";

const BASE = "123456780001";
const TEST_CNPJ = BASE + computeCnpjCheckDigits(BASE);
const ACTOR = {
  actorId: "analyst-synthetic",
  actorRole: "analyst",
  rationale: "Revisão documental sintética para teste.",
};

function dataset(): InvestigationDataset {
  return {
    schemaVersion: "1.0",
    purpose: "Auditoria sintética de testes automatizados.",
    legalBasis: "Fundamento declarado somente para cenário sintético.",
    evidence: [],
    companyEvents: [],
    people: [],
    corporateLinks: [],
    publicRoles: [],
    familyLinks: [],
    competitions: [],
  };
}

function contract() {
  const c = structuredClone(FIXTURE_HIGH_RISK);
  c.id = "SYN-INV-CASE";
  c.supplier.cnpj = TEST_CNPJ;
  c.supplier.openingDate = "2026-01-17";
  c.supplier.shareholders = [];
  c.supplier.sanctions = [];
  c.cnpjRole = "fornecedor";
  c.sourceRecords = [];
  c.documents = [];
  return c;
}

async function setup(
  t: TestContext,
  registryFetch?: Parameters<
    typeof mountInvestigationRoutes
  >[1]["registryFetch"],
) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "nexofis-investigation-test-"),
  );
  const store = createNexofisStore(path.join(dir, "case.db"));
  const privateStore = createInvestigationStore(store.dbPath);
  const subject = contract();
  const second = { ...structuredClone(subject), id: "SYN-INV-OTHER" };
  store.upsertContracts([subject, second]);
  const secret = crypto.randomBytes(32).toString("hex");
  const app = express();
  mountInvestigationRoutes(app, {
    store,
    investigationStore: privateStore,
    getContract: (id) => store.getStoredContractById(id),
    getAllContracts: () => [store.getStoredContractById(subject.id)!],
    authSecret: secret,
    registryFetch,
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/contracts/${subject.id}/investigation`;
  const token = signNexofisToken(
    { sub: ACTOR.actorId, role: "analyst" },
    { secret },
  );
  const viewer = signNexofisToken(
    { sub: "viewer-synthetic", role: "viewer" },
    { secret },
  );
  async function request(
    suffix = "",
    method = "GET",
    body?: unknown,
    accessToken: string | null = token,
  ) {
    return fetch(base + suffix, {
      method,
      headers: {
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    privateStore.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    store,
    privateStore,
    subject,
    second,
    token,
    viewer,
    base,
    request,
  };
}

test("investigation schema rejects extra fields, raw CPF, unknown references and impossible dates", () => {
  assert.throws(
    () => validateInvestigationDataset({ ...dataset(), cpf: "omitted" }),
    /campo não permitido/,
  );
  assert.throws(
    () =>
      validateInvestigationSubmission({
        dataset: dataset(),
        rationale: ACTOR.rationale,
        expectedRevisionDigest: null,
        actorId: "forged",
      }),
    /campo não permitido/,
  );
  const p = {
    id: "person-a",
    name: "Pessoa Sintética",
    publicRecordId: "registro:synthetic-a",
    identityStatus: "unresolved" as const,
    identityEvidenceIds: [],
  };
  assert.throws(
    () =>
      validateInvestigationDataset({
        ...dataset(),
        people: [{ ...p, publicRecordId: "12345678901" }],
      }),
    /CPF completo/,
  );
  assert.throws(
    () =>
      validateInvestigationDataset({
        ...dataset(),
        people: [{ ...p, name: "Pessoa 123.456.789-01" }],
      }),
    /CPF completo/,
  );
  assert.throws(
    () =>
      validateInvestigationDataset({
        ...dataset(),
        people: [{ ...p, identityEvidenceIds: ["missing"] }],
      }),
    /evidência de identidade não existe/,
  );
  assert.throws(
    () =>
      validateInvestigationDataset({
        ...dataset(),
        companyEvents: [
          {
            id: "event-a",
            cnpj: TEST_CNPJ,
            kind: "activity_start",
            date: "2026-02-30",
            evidenceIds: [],
          },
        ],
      }),
    /calendário/,
  );
  assert.throws(
    () => validateInvestigationDataset({ ...dataset(), people: [p, p] }),
    /únicos/,
  );
  assert.throws(
    () =>
      validateInvestigationDataset(
        JSON.parse('{"__proto__":{"polluted":true}}'),
      ),
    /campo não permitido/,
  );
  assert.deepEqual(validateInvestigationDataset(dataset()), dataset());
});

test("source URLs are metadata only and reject local, internal and credential-bearing targets", () => {
  for (const value of [
    "http://localhost/source",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://[::1]/",
    "http://169.254.169.254/",
    "http://server.internal/",
    "file:///etc/passwd",
    "https://user:password@dados.gov.br/",
  ]) {
    assert.throws(() => validateInvestigationSourceUrl(value));
  }
  assert.equal(
    validateInvestigationSourceUrl("https://dados.gov.br/documento"),
    "https://dados.gov.br/documento",
  );
});

test("opaque registry hash segments are not mistaken for CPF and dense relationship imports are rejected", () => {
  const input = dataset();
  const digestWithDecimalRun = `a12345678901${"b".repeat(20)}`;
  assert.equal(digestWithDecimalRun.length, 32);
  input.people = [
    {
      id: `registry:person:${TEST_CNPJ}:${digestWithDecimalRun}`,
      name: "Pessoa Sintética",
      publicRecordId: `registry:qsa:${TEST_CNPJ}:${digestWithDecimalRun}`,
      identityStatus: "unresolved",
      identityEvidenceIds: [],
    },
  ];
  assert.equal(validateInvestigationDataset(input).people.length, 1);
  input.people = [
    {
      id: "p-a",
      name: "Pessoa Sintética A",
      publicRecordId: "registro:p-a",
      identityStatus: "unresolved",
      identityEvidenceIds: [],
    },
    {
      id: "p-b",
      name: "Pessoa Sintética B",
      publicRecordId: "registro:p-b",
      identityStatus: "unresolved",
      identityEvidenceIds: [],
    },
  ];
  input.corporateLinks = Array.from({ length: 30 }, (_, i) => ({
    id: `corp-${i}`,
    personId: "p-a",
    companyCnpj: TEST_CNPJ,
    role: "shareholder",
    validFrom: null,
    validThrough: null,
    evidenceIds: [],
  }));
  input.publicRoles = Array.from({ length: 30 }, (_, i) => ({
    id: `role-${i}`,
    personId: "p-b",
    entityId: "agency",
    contractId: null,
    role: "director",
    validFrom: null,
    validThrough: null,
    evidenceIds: [],
  }));
  input.familyLinks = Array.from({ length: 30 }, (_, i) => ({
    id: `family-${i}`,
    personAId: "p-a",
    personBId: "p-b",
    relationship: "spouse",
    degree: null,
    verification: "unverified",
    validFrom: null,
    validThrough: null,
    evidenceIds: [],
  }));
  assert.throws(
    () => validateInvestigationDataset(input),
    /orçamento de 10.000 caminhos/,
  );
});

test("rejected artifact acquisitions leave no orphan object and filesystem failures roll back the event", () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "nexofis-artifact-rollback-"),
  );
  const dbPath = path.join(dir, "test.db");
  const store = createInvestigationStore(dbPath);
  try {
    const db = new DatabaseSync(dbPath);
    const stmt = db.prepare(
      "INSERT INTO investigation_events(contract_id,sequence,id,kind,event_json,previous_event_hash,event_hash) VALUES(?,?,?,?,?,?,?)",
    );
    db.exec("BEGIN");
    let previous: string | null = null;
    for (let sequence = 1; sequence <= 1000; sequence++) {
      const unsigned = {
        id: `seed-event-${sequence}`,
        contractId: "full",
        sequence,
        kind: "review",
        actorId: ACTOR.actorId,
        actorRole: ACTOR.actorRole,
        createdAt: "2026-11-22T12:00:00.000Z",
        rationale: ACTOR.rationale,
        payload: {
          findingId: "synthetic",
          findingInputDigest: "b".repeat(64),
          action: "dismiss",
        },
        previousEventHash: previous,
      };
      const eventHash = investigationDigest(unsigned);
      stmt.run(
        "full",
        sequence,
        unsigned.id,
        "review",
        JSON.stringify({ ...unsigned, eventHash }),
        previous,
        eventHash,
      );
      previous = eventHash;
    }
    db.exec("COMMIT");
    db.close();
    assert.equal(store.readHistory("full").integrity.eventCount, 1000);
    const bytes = Buffer.from(
      "Este upload será recusado por quota sem deixar arquivos.",
    );
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const target = path.join(store.objectsDir, hash.slice(0, 2), `${hash}.bin`);
    assert.throws(
      () =>
        store.saveArtifact({
          contractId: "full",
          filename: "quota.txt",
          mimeType: "text/plain",
          bytes,
          ...ACTOR,
        }),
      InvestigationConflictError,
    );
    assert.equal(fs.existsSync(target), false);
    assert.equal(store.readHistory("full").integrity.eventCount, 1000);
    // Simulate an unavailable object directory: the attempted acquisition event
    // must roll back together with the failing filesystem operation.
    const blockedPrefix = path.join(store.objectsDir, hash.slice(0, 2));
    fs.writeFileSync(blockedPrefix, "filesystem-blocker");
    assert.throws(() =>
      store.saveArtifact({
        contractId: "empty",
        filename: "fail.txt",
        mimeType: "text/plain",
        bytes,
        ...ACTOR,
      }),
    );
    assert.equal(store.readHistory("empty").integrity.eventCount, 0);
    fs.unlinkSync(blockedPrefix);
    const valid = store.saveArtifact({
      contractId: "valid",
      filename: "valid.txt",
      mimeType: "text/plain",
      bytes,
      ...ACTOR,
    });
    assert.equal(
      store.readArtifact("valid", valid.artifactSha256)?.verified,
      true,
    );
    assert.throws(
      () =>
        store.saveArtifact({
          contractId: "full",
          filename: "shared.txt",
          mimeType: "text/plain",
          bytes,
          ...ACTOR,
        }),
      InvestigationConflictError,
    );
    assert.equal(
      store.readArtifact("valid", valid.artifactSha256)?.verified,
      true,
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("immutable history survives restart, detects tampering and prevents stale dataset replacement", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexofis-chain-test-"));
  const dbPath = path.join(dir, "test.db");
  let store = createInvestigationStore(dbPath);
  try {
    const first = store.appendDataset({
      contractId: "case",
      dataset: dataset(),
      expectedRevisionDigest: null,
      ...ACTOR,
    });
    const retry = store.appendDataset({
      contractId: "case",
      dataset: dataset(),
      expectedRevisionDigest: null,
      ...ACTOR,
    });
    assert.equal(retry.id, first.id);
    const changed = {
      ...dataset(),
      purpose: "Finalidade alterada por análise sintética.",
    };
    assert.throws(
      () =>
        store.appendDataset({
          contractId: "case",
          dataset: changed,
          expectedRevisionDigest: null,
          ...ACTOR,
        }),
      InvestigationConflictError,
    );
    store.appendDataset({
      contractId: "case",
      dataset: changed,
      expectedRevisionDigest: first.datasetDigest,
      ...ACTOR,
    });
    store.close();
    store = createInvestigationStore(dbPath);
    const history = store.readHistory("case");
    assert.equal(history.revisions.length, 2);
    assert.equal(history.integrity.valid, true);
    assert.equal(history.revisions[1].previousEventHash, first.eventHash);
    const db = new DatabaseSync(dbPath);
    assert.throws(
      () =>
        db
          .prepare("DELETE FROM investigation_events WHERE contract_id=?")
          .run("case"),
      /append-only/,
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE investigation_events SET event_hash=? WHERE contract_id=?",
          )
          .run("tampered", "case"),
      /append-only/,
    );
    // Simulated privileged corruption: dropping a trigger must not bypass read verification.
    db.exec("DROP TRIGGER investigation_events_no_update");
    db.prepare(
      "UPDATE investigation_events SET event_hash=? WHERE contract_id=? AND sequence=2",
    ).run("tampered", "case");
    db.close();
    assert.throws(() => store.readHistory("case"), InvestigationIntegrityError);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP investigation is fail-closed even without global auth and rejects viewer access", async (t) => {
  const { request, viewer } = await setup(t);
  assert.equal((await request("", "GET", undefined, null)).status, 401);
  assert.equal((await request("", "GET", undefined, viewer)).status, 403);
  assert.equal((await request("/export", "GET", undefined, null)).status, 401);
  assert.equal((await request("/dataset", "POST", {}, viewer)).status, 403);
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const data = (await res.json()) as InvestigationResponse;
  assert.equal(data.dataset, null);
  assert.equal(data.report.coverage[1].status, "not_queried");
});

test("HTTP import uses server identity, validates originals, is idempotent and applies CAS", async (t) => {
  const { request, privateStore, subject } = await setup(t);
  const submitted = {
    dataset: dataset(),
    rationale: ACTOR.rationale,
    expectedRevisionDigest: null,
  };
  assert.equal(
    (await request("/dataset", "POST", { ...submitted, actorId: "forged" }))
      .status,
    400,
  );
  const firstResponse = await request("/dataset", "POST", submitted);
  assert.equal(firstResponse.status, 200);
  const first = (await firstResponse.json()) as InvestigationResponse;
  const secondResponse = await request("/dataset", "POST", submitted);
  assert.equal(secondResponse.status, 200);
  const second = (await secondResponse.json()) as InvestigationResponse;
  assert.equal(second.integrity.eventCount, 1);
  assert.equal(first.currentRevision?.id, second.currentRevision?.id);
  assert.equal(
    privateStore.readHistory(subject.id).currentRevision?.actorId,
    ACTOR.actorId,
  );
  const missingArtifact = {
    ...dataset(),
    evidence: [
      {
        id: "doc-a",
        sourceName: "Fonte sintética",
        sourceKind: "analyst_document",
        sourceUrl: null,
        retrievedAt: "2026-11-22T12:00:00.000Z",
        artifactSha256: "a".repeat(64),
        locator: "Página sintética um",
      },
    ],
  };
  assert.equal(
    (
      await request("/dataset", "POST", {
        ...submitted,
        dataset: missingArtifact,
        expectedRevisionDigest: first.currentRevision?.datasetDigest,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/dataset", "POST", {
        ...submitted,
        dataset: {
          ...dataset(),
          purpose: "Outra finalidade declarada explicitamente.",
        },
      })
    ).status,
    409,
  );
});

test("private originals are scoped to the contract, authenticated, verified and absent from public objects", async (t) => {
  const { request, dir, base, token, second } = await setup(t);
  const content = Buffer.from(
    "Conteúdo inteiramente sintético para teste de preservação.",
  );
  const upload = {
    filename: "evidencia-sintetica.txt",
    mimeType: "text/plain",
    contentBase64: content.toString("base64"),
  };
  assert.equal(
    (
      await request("/artifacts", "POST", {
        ...upload,
        filename: "../escape.txt",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/artifacts", "POST", {
        ...upload,
        mimeType: "application/pdf",
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("/artifacts", "POST", { ...upload, contentBase64: "%%%=" }))
      .status,
    400,
  );
  const savedResponse = await request("/artifacts", "POST", upload);
  assert.equal(savedResponse.status, 201);
  const saved = await savedResponse.json();
  assert.equal(
    saved.artifactSha256,
    crypto.createHash("sha256").update(content).digest("hex"),
  );
  assert.equal(
    (
      await request(
        `/artifacts/${saved.artifactSha256}`,
        "GET",
        undefined,
        null,
      )
    ).status,
    401,
  );
  const download = await request(`/artifacts/${saved.artifactSha256}`);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), content);
  assert.equal(
    fs.existsSync(
      path.join(
        dir,
        "objects",
        saved.artifactSha256.slice(0, 2),
        `${saved.artifactSha256}.bin`,
      ),
    ),
    false,
  );
  const otherUrl =
    base.replace("/SYN-INV-CASE/", `/${second.id}/`) +
    `/artifacts/${saved.artifactSha256}`;
  assert.equal(
    (await fetch(otherUrl, { headers: { Authorization: `Bearer ${token}` } }))
      .status,
    404,
  );
  fs.writeFileSync(
    path.join(
      dir,
      "investigation-objects",
      saved.artifactSha256.slice(0, 2),
      `${saved.artifactSha256}.bin`,
    ),
    Buffer.alloc(content.length, 65),
  );
  assert.equal(
    (await request(`/artifacts/${saved.artifactSha256}`)).status,
    404,
  );
});

test("review digests remain stable across GETs and stale findings cannot be dismissed", async (t) => {
  const { request } = await setup(t);
  const first = (await (await request()).json()) as InvestigationResponse;
  const second = (await (await request()).json()) as InvestigationResponse;
  assert.equal(first.report.inputDigest, second.report.inputDigest);
  const finding = first.report.findings.find(
    (f) => f.ruleCode === "INV-HISTORY-001",
  );
  assert.ok(finding);
  const review = {
    findingId: finding.id,
    findingInputDigest: finding.inputDigest,
    action: "dismiss",
    rationale: ACTOR.rationale,
  };
  assert.equal(
    (
      await request("/reviews", "POST", {
        ...review,
        findingInputDigest: "0".repeat(64),
      })
    ).status,
    409,
  );
  assert.equal((await request("/reviews", "POST", review)).status, 200);
  const after = (await (await request()).json()) as InvestigationResponse;
  assert.equal(after.reviews.length, 1);
  assert.equal(after.reviews[0].findingInputDigest, finding.inputDigest);
  assert.equal(after.reviews[0].actorId, ACTOR.actorId);
  assert.equal(
    after.report.findings.find((f) => f.id === finding.id)?.inputDigest,
    finding.inputDigest,
  );
  assert.equal((await request("/reviews", "POST", review)).status, 200);
  const retried = (await (await request()).json()) as InvestigationResponse;
  assert.equal(retried.reviews.length, 1);
  assert.equal(
    (
      await request("/reviews", "POST", {
        ...review,
        action: "restore",
        rationale: "Restauração fundamentada em cenário sintético.",
      })
    ).status,
    200,
  );
});

test("export contains reproducible inputs, an integrity digest and a private artifact manifest", async (t) => {
  const { request } = await setup(t);
  const bytes = Buffer.from(
    "Fonte documental sintética sem qualquer pessoa real.",
  );
  const saved = await (
    await request("/artifacts", "POST", {
      filename: "source.txt",
      mimeType: "text/plain",
      contentBase64: bytes.toString("base64"),
    })
  ).json();
  const input = dataset();
  input.evidence = [
    {
      id: "evidence-one",
      sourceName: "Documento sintético",
      sourceKind: "analyst_document",
      sourceUrl: null,
      retrievedAt: "2026-11-22T12:00:00.000Z",
      artifactSha256: saved.artifactSha256,
      locator: "Trecho sintético um",
    },
  ];
  input.companyEvents = [
    {
      id: "event-one",
      cnpj: TEST_CNPJ,
      kind: "activity_start",
      date: "2026-01-17",
      evidenceIds: ["evidence-one"],
    },
  ];
  assert.equal(
    (
      await request("/dataset", "POST", {
        dataset: input,
        rationale: ACTOR.rationale,
        expectedRevisionDigest: null,
      })
    ).status,
    200,
  );
  const response = await request("/export");
  assert.equal(response.status, 200);
  const pkg = await response.json();
  assert.equal(pkg.integrity.contentSha256, investigationDigest(pkg.payload));
  assert.equal(pkg.payload.artifactManifest[0].sha256VerifiedAtExport, true);
  assert.match(
    pkg.payload.artifactManifest[0].downloadPath,
    /investigation\/artifacts/,
  );
  const recalculated = evaluateInvestigation(pkg.payload.input);
  assert.deepEqual(recalculated, pkg.payload.report);
  assert.match(pkg.payload.methodNotice, /não comprova veracidade/);
  assert.match(pkg.payload.accessScope, /Não há segregação/);
});

test("registry refresh uses the fixed connector, preserves manual facts and enforces version guards", async (t) => {
  let called = 0;
  const registryFetch: typeof fetchCompanyRegistryEvidence = async (cnpj) => {
    called++;
    return fetchCompanyRegistryEvidence(cnpj, {
      now: "2026-11-22T12:00:00.000Z",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            cnpj: TEST_CNPJ,
            razao_social: "Empresa Sintética",
            data_inicio_atividade: "2026-01-17",
            qsa: [
              {
                identificador_de_socio: 2,
                nome_socio: "Pessoa Sintética",
                qualificacao_socio: "Sócio",
                codigo_qualificacao_socio: 22,
                data_entrada_sociedade: "2026-01-17",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
  };
  const { request } = await setup(t, registryFetch);
  const manual = dataset();
  manual.people = [
    {
      id: "manual-person",
      name: "Pessoa Documentada Sintética",
      publicRecordId: "fonte:registro-sintetico",
      identityStatus: "unresolved",
      identityEvidenceIds: [],
    },
  ];
  const created = (await (
    await request("/dataset", "POST", {
      dataset: manual,
      rationale: ACTOR.rationale,
      expectedRevisionDigest: null,
    })
  ).json()) as InvestigationResponse;
  const body = {
    purpose: manual.purpose,
    legalBasis: manual.legalBasis,
    rationale: ACTOR.rationale,
    expectedRevisionDigest: created.currentRevision!.datasetDigest,
  };
  assert.equal(
    (
      await request("/refresh-registry", "POST", {
        ...body,
        expectedRevisionDigest: null,
      })
    ).status,
    409,
  );
  assert.equal(called, 0);
  const refreshedResponse = await request("/refresh-registry", "POST", body);
  assert.equal(
    refreshedResponse.status,
    200,
    await refreshedResponse.clone().text(),
  );
  const refreshed = (await refreshedResponse.json()) as InvestigationResponse;
  assert.equal(called, 1);
  assert.ok(refreshed.dataset?.people.some((p) => p.id === "manual-person"));
  assert.ok(
    refreshed.dataset?.companyEvents.some((e) => e.kind === "activity_start"),
  );
  assert.ok(
    refreshed.dataset?.people.every((p) => p.identityStatus === "unresolved"),
  );
  assert.ok(
    refreshed.dataset?.corporateLinks.every((p) => p.validThrough === null),
  );
});

test("HTTP refuses imports when the append-only trail has been corrupted", async (t) => {
  const { request, store, subject } = await setup(t);
  await request("/dataset", "POST", {
    dataset: dataset(),
    rationale: ACTOR.rationale,
    expectedRevisionDigest: null,
  });
  const db = new DatabaseSync(store.dbPath);
  db.exec("DROP TRIGGER investigation_events_no_update");
  db.prepare(
    "UPDATE investigation_events SET event_hash=? WHERE contract_id=?",
  ).run("invalid", subject.id);
  db.close();
  const response = await request();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "INVESTIGATION_INTEGRITY_FAILURE");
  assert.equal((await request("/export")).status, 409);
});

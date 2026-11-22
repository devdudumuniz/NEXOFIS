import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { FIXTURE_HIGH_RISK } from "./__fixtures__/testContracts";
import { computeCnpjCheckDigits } from "./cnpj";
import { evaluateInvestigation } from "./investigationEngine";
import type {
  InvestigationDataset,
  InvestigationEngineInput,
} from "../types/investigation";
import { investigationDigest } from "../server/investigationStore";
import { verifyInvestigationPackage } from "../server/investigationVerifier";
import { runInvestigationVerificationCli } from "../../scripts/verify-investigation";

const NOW = "2026-11-22T12:00:00.000Z";
const ORIGINAL = Buffer.from(
  "Documento inteiramente sintético para verificação offline.",
);
const SHA = crypto.createHash("sha256").update(ORIGINAL).digest("hex");

function buildPackage(withOriginal = false) {
  const subject = structuredClone(FIXTURE_HIGH_RISK);
  subject.id = "SYN-VERIFY";
  subject.sourceRecords = [];
  subject.documents = [];
  subject.supplier.cnpj = `123456780001${computeCnpjCheckDigits("123456780001")}`;
  subject.supplier.shareholders = [];
  const dataset: InvestigationDataset | null = withOriginal
    ? {
        schemaVersion: "1.0",
        purpose: "Teste de integridade e reprodução sem pessoas reais.",
        legalBasis: "Cenário inteiramente sintético de teste automatizado.",
        evidence: [
          {
            id: "source-one",
            sourceName: "Documento sintético",
            sourceKind: "analyst_document",
            sourceUrl: null,
            retrievedAt: NOW,
            artifactSha256: SHA,
            locator: "Trecho sintético um",
          },
        ],
        companyEvents: [
          {
            id: "activity-one",
            cnpj: subject.supplier.cnpj,
            kind: "activity_start",
            date: "2026-01-17",
            evidenceIds: ["source-one"],
          },
        ],
        people: [],
        corporateLinks: [],
        publicRoles: [],
        familyLinks: [],
        competitions: [],
      }
    : null;
  const input: InvestigationEngineInput = {
    subject,
    portfolio: [subject],
    dataset,
    coverage: [],
    verifiedArtifactHashes: withOriginal ? [SHA] : [],
    evaluatedAt: NOW,
  };
  const events: Array<Record<string, unknown>> = [];
  const artifact = {
    artifactSha256: SHA,
    filename: "original.txt",
    mimeType: "text/plain",
    sizeBytes: ORIGINAL.length,
  };
  function append(kind: string, payload: Record<string, unknown>) {
    const unsigned = {
      id: `event-${events.length + 1}`,
      contractId: subject.id,
      sequence: events.length + 1,
      kind,
      actorId: "synthetic-analyst",
      actorRole: "analyst",
      createdAt: NOW,
      rationale: "Cenário de teste documental inteiramente sintético.",
      payload,
      previousEventHash: events.at(-1)?.eventHash ?? null,
    };
    events.push({ ...unsigned, eventHash: investigationDigest(unsigned) });
  }
  if (withOriginal) {
    append("artifact", artifact);
    append("dataset", { dataset, datasetDigest: investigationDigest(dataset) });
  }
  const payload = {
    input,
    report: evaluateInvestigation(input),
    dataset,
    events,
    integrity: {
      valid: true,
      eventCount: events.length,
      headHash: events.at(-1)?.eventHash ?? null,
    },
    artifactManifest: withOriginal
      ? [
          {
            ...artifact,
            sha256VerifiedAtExport: true,
            downloadPath: `/api/contracts/${subject.id}/investigation/artifacts/${SHA}`,
          },
        ]
      : [],
    methodNotice: "Hashes não certificam veracidade ou autoria.",
    accessScope: "Escopo sintético de teste.",
  };
  return {
    schema: "nexofis.investigation.v1",
    exportedAt: NOW,
    softwareLicense: "AGPL-3.0-only",
    integrity: {
      algorithm: "SHA-256",
      canonicalization: "stable-json-v1",
      contentSha256: investigationDigest(payload),
    },
    payload,
  };
}

function rehash<T extends ReturnType<typeof buildPackage>>(pkg: T): T {
  pkg.integrity.contentSha256 = investigationDigest(pkg.payload);
  return pkg;
}

test("offline verifier replays a valid package and states when no originals were declared", () => {
  const result = verifyInvestigationPackage(buildPackage());
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.checks.packageHashVerified, true);
  assert.equal(result.checks.eventChainVerified, true);
  assert.equal(result.checks.reportReplayed, true);
  assert.equal(result.checks.expectedOriginalCount, 0);
  assert.ok(
    result.warnings.some((warning) => warning.includes("Não há originais")),
  );
  assert.match(result.disclaimer, /Não certifica autoria/);
});

test("report tampering is detected even after recalculating the outer hash", () => {
  const pkg = buildPackage();
  pkg.payload.report.findings[0].statement =
    "Conclusão adulterada que não resulta do algoritmo.";
  const result = verifyInvestigationPackage(rehash(pkg));
  assert.equal(result.exitCode, 1);
  assert.equal(result.checks.packageHashVerified, true);
  assert.ok(
    result.errors.some((error) => error.includes("reprodução determinística")),
  );
});

test("payload corruption, wrong algorithm and malformed input fail without throwing", () => {
  const changed = buildPackage();
  changed.payload.input.subject.originalValue += 1;
  assert.equal(verifyInvestigationPackage(changed).exitCode, 1);
  const wrongAlgorithm = buildPackage();
  wrongAlgorithm.integrity.algorithm = "SHA-1";
  assert.equal(verifyInvestigationPackage(wrongAlgorithm).exitCode, 1);
  const malformed = buildPackage();
  (malformed.payload.input as unknown as Record<string, unknown>).coverage =
    "unexpected";
  assert.equal(verifyInvestigationPackage(rehash(malformed)).exitCode, 1);
  assert.equal(verifyInvestigationPackage(null).exitCode, 1);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.equal(verifyInvestigationPackage(cycle).exitCode, 1);
});

test("missing originals are incomplete; provided matching bytes verify completely; changed bytes fail", () => {
  const pkg = buildPackage(true);
  const noReader = verifyInvestigationPackage(pkg);
  assert.equal(noReader.exitCode, 2, JSON.stringify(noReader));
  assert.equal(noReader.checks.reportReplayed, true);
  assert.equal(noReader.checks.expectedOriginalCount, 1);
  assert.equal(noReader.checks.verifiedOriginalCount, 0);
  assert.equal(verifyInvestigationPackage(pkg, () => null).exitCode, 2);
  const valid = verifyInvestigationPackage(pkg, (sha) =>
    sha === SHA ? ORIGINAL : null,
  );
  assert.equal(valid.exitCode, 0, JSON.stringify(valid));
  assert.equal(valid.checks.verifiedOriginalCount, 1);
  const corrupted = verifyInvestigationPackage(pkg, () =>
    Buffer.from("alterado"),
  );
  assert.equal(corrupted.exitCode, 1);
  assert.ok(
    corrupted.errors.some((error) => error.includes("SHA-256 divergente")),
  );
  assert.equal(
    verifyInvestigationPackage(pkg, () => {
      throw new Error("reader unavailable");
    }).exitCode,
    2,
  );
});

test("broken event chain is detected even when the event and package hashes are recomputed", () => {
  const pkg = buildPackage(true);
  const event = pkg.payload.events[1];
  event.previousEventHash = "0".repeat(64);
  const { eventHash: _, ...unsigned } = event;
  event.eventHash = investigationDigest(unsigned);
  pkg.payload.integrity.headHash = String(event.eventHash);
  const result = verifyInvestigationPackage(rehash(pkg), () => ORIGINAL);
  assert.equal(result.exitCode, 1);
  assert.ok(result.errors.some((error) => error.includes("Cadeia inválida")));
});

test("manifest and captured verified hashes must correspond to acquisition events and references", () => {
  const pkg = buildPackage(true);
  pkg.payload.artifactManifest = [];
  const mismatch = verifyInvestigationPackage(rehash(pkg), () => ORIGINAL);
  assert.equal(mismatch.exitCode, 1);
  assert.ok(mismatch.errors.some((error) => error.includes("Manifesto")));
  const forgedVerified = buildPackage();
  forgedVerified.payload.input.verifiedArtifactHashes = [SHA];
  assert.equal(
    verifyInvestigationPackage(rehash(forgedVerified), () => ORIGINAL).exitCode,
    1,
  );
  const forgedFlag = buildPackage(true);
  forgedFlag.payload.artifactManifest[0].sha256VerifiedAtExport = false;
  assert.equal(
    verifyInvestigationPackage(rehash(forgedFlag), () => ORIGINAL).exitCode,
    1,
  );
});

test("unsupported engine version is incomplete and never presented as a successful replay", () => {
  const pkg = buildPackage();
  pkg.payload.report.engineVersion = "investigation-99.0.0";
  const result = verifyInvestigationPackage(rehash(pkg));
  assert.equal(result.exitCode, 2, JSON.stringify(result));
  assert.equal(result.checks.reportReplayed, false);
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes("versão correspondente"),
    ),
  );
});

test("unpreserved external source digests stay explicitly incomplete offline", () => {
  const pkg = buildPackage();
  pkg.payload.input.subject.sourceRecords = [
    {
      id: "synthetic-source",
      sourceSystem: "PNCP",
      externalId: "synthetic-record",
      retrievedAt: NOW,
      rawPayloadHash: SHA,
      reportedOriginalValue: 1,
      reportedUpdatedValue: 1,
      reportedSupplierCnpj: pkg.payload.input.subject.supplier.cnpj,
      reportedStatus: "Sintético",
      reportedEndDate: "2026-12-31",
      sourceUrl: "https://pncp.gov.br/",
    },
  ];
  pkg.payload.report = evaluateInvestigation(pkg.payload.input);
  const result = verifyInvestigationPackage(rehash(pkg));
  assert.equal(result.exitCode, 2, JSON.stringify(result));
  assert.equal(result.checks.expectedOriginalCount, 1);
  assert.equal(verifyInvestigationPackage(pkg, () => ORIGINAL).exitCode, 0);
});

test("CLI supports hash filenames, signals missing originals and refuses traversal through symlinks", () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "nexofis-offline-verifier-"),
  );
  try {
    const pkgFile = path.join(dir, "package.json");
    const originals = path.join(dir, "originais");
    fs.mkdirSync(originals);
    fs.writeFileSync(pkgFile, JSON.stringify(buildPackage(true)));
    assert.equal(runInvestigationVerificationCli([pkgFile]).exitCode, 2);
    fs.writeFileSync(path.join(originals, `${SHA}.bin`), ORIGINAL);
    assert.equal(
      runInvestigationVerificationCli([pkgFile, originals]).exitCode,
      0,
    );
    fs.unlinkSync(path.join(originals, `${SHA}.bin`));
    fs.mkdirSync(path.join(originals, SHA.slice(0, 2)));
    const nested = path.join(originals, SHA.slice(0, 2), `${SHA}.bin`);
    fs.writeFileSync(nested, ORIGINAL);
    assert.equal(
      runInvestigationVerificationCli([pkgFile, originals]).exitCode,
      0,
    );
    if (process.platform !== "win32") {
      fs.unlinkSync(nested);
      const outside = path.join(dir, "outside.bin");
      fs.writeFileSync(outside, ORIGINAL);
      fs.symlinkSync(outside, nested);
      const blocked = runInvestigationVerificationCli([pkgFile, originals]);
      assert.equal(blocked.exitCode, 2);
      assert.equal(blocked.checks.verifiedOriginalCount, 0);
    }
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/verify-investigation.ts", pkgFile],
      { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 },
    );
    assert.equal(child.status, 2, child.stderr);
    assert.equal(JSON.parse(child.stdout).exitCode, 2);
    assert.equal(runInvestigationVerificationCli([]).exitCode, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

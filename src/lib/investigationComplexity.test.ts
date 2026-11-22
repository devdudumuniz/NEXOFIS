import test from "node:test";
import assert from "node:assert/strict";
import type {
  InvestigationDataset,
  InvestigationEngineInput,
  InvestigationReport,
} from "../types/investigation";
import { validateInvestigationDataset } from "../server/investigationValidation";
import { FIXTURE_HIGH_RISK } from "./__fixtures__/testContracts";
import { evaluateInvestigation } from "./investigationEngine";

// Only synthetic facts. Distinct record IDs intentionally describe overlapping
// relations: append-only imports must not produce an unbounded Cartesian join.
const CNPJ = "11222333000181";
const OTHER_CNPJ = "00000000E08G12";
const HASH = "a".repeat(64);
const INTERVAL = {
  validFrom: "2026-01-01",
  validThrough: "2026-12-31",
  evidenceIds: ["e1"],
};

function repeatedRelations(count: number): InvestigationDataset {
  return {
    schemaVersion: "1.0",
    purpose: "Teste sintético de limites de processamento.",
    legalBasis: "Dados sintéticos para controle de qualidade.",
    evidence: [
      {
        id: "e1",
        sourceName: "Documento sintético",
        sourceKind: "analyst_document",
        sourceUrl: null,
        retrievedAt: "2026-11-22T12:00:00.000Z",
        artifactSha256: HASH,
        locator: "Registro sintético para o teste.",
      },
    ],
    companyEvents: [],
    people: ["owner", "official"].map((id) => ({
      id,
      name: "Pessoa Sintética Homônima",
      publicRecordId: `synthetic:${id}`,
      identityStatus: "documented",
      identityEvidenceIds: ["e1"],
    })),
    corporateLinks: Array.from({ length: count }, (_, i) => ({
      id: `corporate-${i}`,
      personId: "owner",
      companyCnpj: CNPJ,
      role: "shareholder",
      ...INTERVAL,
    })),
    publicRoles: Array.from({ length: count }, (_, i) => ({
      id: `role-${i}`,
      personId: "official",
      entityId: "synthetic-body",
      contractId: null,
      role: "director",
      ...INTERVAL,
    })),
    familyLinks: Array.from({ length: count }, (_, i) => ({
      id: `family-${i}`,
      personAId: "owner",
      personBId: "official",
      relationship: "consanguinity",
      degree: 2,
      verification: "documented",
      ...INTERVAL,
    })),
    competitions: [],
  };
}

function input(
  dataset: InvestigationDataset,
  validateImport = true,
): InvestigationEngineInput {
  const subject = structuredClone(FIXTURE_HIGH_RISK);
  Object.assign(subject, {
    id: "synthetic-contract",
    entityId: "synthetic-body",
    signatureDate: "2026-11-21",
    sourceRecords: [],
    documents: [],
    cnpjRole: "fornecedor",
  });
  subject.supplier = {
    ...subject.supplier,
    cnpj: CNPJ,
    openingDate: "2026-11-21",
    legalName: "Empresa Sintética",
    shareholders: [],
    sanctions: [],
  };
  return {
    subject,
    dataset: validateImport ? validateInvestigationDataset(dataset) : dataset,
    portfolio: [],
    coverage: [],
    verifiedArtifactHashes: [HASH],
    evaluatedAt: "2026-11-22T12:00:00.000Z",
  };
}

function rule(report: InvestigationReport, code: string) {
  return report.findings.filter((finding) => finding.ruleCode === code);
}

test(
  "legacy 500×500×500 family records are bounded before expansion and other rules remain available",
  { timeout: 3000 },
  () => {
    // Previously accepted/persisted revisions must remain safe when read even
    // after validation starts rejecting new imports with this complexity.
    const report = evaluateInvestigation(input(repeatedRelations(500), false));
    const family = rule(report, "INV-FAMILY-001");
    assert.equal(family.length, 1);
    assert.equal(family[0].state, "NOT_VERIFIABLE");
    assert.match(family[0].calculation, /125000000/);
    assert.match(family[0].limitation, /limite de complexidade/);
    assert.match(family[0].statement, /não se conclui ausência de vínculos/);
    assert.ok(
      report.limitations.some(
        (notice) =>
          notice.includes("INV-FAMILY-001") && notice.includes("125000000"),
      ),
    );
    assert.equal(
      report.graph.edges.filter((edge) => edge.id.startsWith("family:")).length,
      0,
    );
    assert.ok(report.graph.edges.length <= 1002);
    assert.ok(
      rule(report, "INV-TIME-002").some(
        (finding) => finding.state === "OBSERVATION",
      ),
    );
    assert.ok(
      rule(report, "INV-HISTORY-001").some(
        (finding) => finding.state === "OBSERVATION",
      ),
    );
    assert.ok(JSON.stringify(report).length < 2 * 1024 * 1024);
  },
);

test(
  "direct identity joins have an independent budget and do not affect the temporal track",
  { timeout: 3000 },
  () => {
    const dataset = repeatedRelations(500);
    dataset.publicRoles.forEach((role) => {
      role.personId = "owner";
    });
    dataset.familyLinks = [];
    const report = evaluateInvestigation(input(dataset, false));
    const direct = rule(report, "INV-REL-001");
    assert.equal(direct.length, 1);
    assert.equal(direct[0].state, "NOT_VERIFIABLE");
    assert.match(direct[0].calculation, /250000/);
    assert.ok(
      rule(report, "INV-TIME-002").some(
        (finding) => finding.state === "OBSERVATION",
      ),
    );
    assert.ok(report.graph.edges.length <= 1002);
  },
);

test("5 and 10 repeated relations keep complete findings and do not multiply graph edges per join", () => {
  for (const count of [5, 10]) {
    const report = evaluateInvestigation(input(repeatedRelations(count)));
    const family = rule(report, "INV-FAMILY-001");
    assert.equal(family.length, count ** 3);
    assert.ok(family.every((finding) => finding.state === "OBSERVATION"));
    assert.equal(
      new Set(family.map((finding) => finding.id)).size,
      family.length,
    );
    assert.equal(
      report.graph.edges.filter((edge) => edge.id.startsWith("family:")).length,
      count,
    );
    assert.equal(report.graph.edges.length, 3 * count + 2);
  }
});

test("over-budget relations are not silently reported as a complete first 1000 matches", () => {
  const report = evaluateInvestigation(input(repeatedRelations(11)));
  const family = rule(report, "INV-FAMILY-001");
  assert.equal(family.length, 1);
  assert.equal(family[0].state, "NOT_VERIFIABLE");
  assert.match(family[0].calculation, /1331/);
  assert.match(family[0].statement, /Não foram escolhidas apenas as primeiras/);
  assert.equal(
    report.graph.edges.filter((edge) => edge.id.startsWith("family:")).length,
    0,
  );
});

test("budget finding identity and input digest are stable under record ordering", () => {
  const dataset = repeatedRelations(11);
  const first = rule(
    evaluateInvestigation(input(dataset)),
    "INV-FAMILY-001",
  )[0];
  dataset.corporateLinks.reverse();
  dataset.publicRoles.reverse();
  dataset.familyLinks.reverse();
  dataset.people.reverse();
  const reordered = rule(
    evaluateInvestigation(input(dataset)),
    "INV-FAMILY-001",
  )[0];
  assert.equal(reordered.id, first.id);
  assert.equal(reordered.inputDigest, first.inputDigest);
  dataset.familyLinks[0].validThrough = "2026-12-30";
  const changed = rule(
    evaluateInvestigation(input(dataset)),
    "INV-FAMILY-001",
  )[0];
  assert.equal(changed.id, first.id);
  assert.notEqual(changed.inputDigest, first.inputDigest);
});

test(
  "irrelevant public roles and homonymous people do not consume a false Cartesian budget",
  { timeout: 3000 },
  () => {
    const dataset = repeatedRelations(500);
    dataset.publicRoles.forEach((role) => {
      role.entityId = "unrelated-public-body";
    });
    const report = evaluateInvestigation(input(dataset, false));
    assert.equal(rule(report, "INV-FAMILY-001").length, 1);
    assert.ok(
      !report.limitations.some((notice) =>
        notice.includes("limite de complexidade"),
      ),
    );
    assert.equal(
      rule(report, "INV-REL-001").filter(
        (finding) => finding.state === "OBSERVATION",
      ).length,
      0,
    );
    assert.equal(
      report.graph.nodes.filter((node) => node.kind === "person").length,
      1,
    );
  },
);

test(
  "competition graph expansion is budgeted before repeated lots can generate 50000 edges",
  { timeout: 3000 },
  () => {
    const dataset = repeatedRelations(500);
    dataset.publicRoles = [];
    dataset.familyLinks = [];
    dataset.corporateLinks.forEach((link, index) => {
      if (index % 2) link.companyCnpj = OTHER_CNPJ;
    });
    dataset.competitions = Array.from({ length: 100 }, (_, index) => ({
      id: `competition-${index}`,
      contractId: "synthetic-contract",
      lotId: `lot-${index}`,
      eventDate: "2026-11-20",
      bidderCnpjs: [CNPJ, OTHER_CNPJ],
      evidenceIds: ["e1"],
    }));
    const report = evaluateInvestigation(input(dataset));
    const competition = rule(report, "INV-COMPETITION-001");
    assert.equal(competition.length, 1);
    assert.equal(competition[0].state, "NOT_VERIFIABLE");
    assert.match(competition[0].calculation, /50000/);
    assert.equal(
      report.graph.edges.filter((edge) => edge.id.startsWith("competition:"))
        .length,
      0,
    );
    assert.ok(report.graph.edges.length <= 252);
    assert.ok(
      rule(report, "INV-TIME-002").some(
        (finding) => finding.state === "OBSERVATION",
      ),
    );
  },
);

test("new oversized relationship datasets are rejected before persistence as an additional import gate", () => {
  assert.throws(
    () => validateInvestigationDataset(repeatedRelations(500)),
    /orçamento.*10\.000 caminhos candidatos/,
  );
});

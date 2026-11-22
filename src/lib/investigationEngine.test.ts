import assert from "node:assert/strict";
import test from "node:test";
import type { ContractRecord } from "../types/audit";
import type {
  InvestigationDataset,
  InvestigationEngineInput,
  InvestigationReport,
} from "../types/investigation";
import { FIXTURE_HIGH_RISK } from "./__fixtures__/testContracts";
import { computeCnpjCheckDigits } from "./cnpj";
import {
  evaluateInvestigation,
  stableInvestigationJson,
  strictDateDays,
} from "./investigationEngine";

// Synthetic fixtures; no lookup or production import of these identities.
const cnpj = (base: string) => `${base}${computeCnpjCheckDigits(base)}`;
const A = cnpj("123456780001");
const B = cnpj("876543210001");
const H = "a".repeat(64);
const S = "2026-11-10";
function contract(
  id = "synthetic-contract",
  value = 100,
  entityId = "synthetic-buyer",
): ContractRecord {
  const c = structuredClone(FIXTURE_HIGH_RISK);
  c.id = id;
  c.pncpControlNumber = `synthetic-control-${id}`;
  c.contractNumber = id;
  c.entityId = entityId;
  c.entityName = "Órgão Sintético";
  c.signatureDate = S;
  c.updatedValue = value;
  c.originalValue = value;
  c.cnpjRole = "fornecedor";
  c.sourceRecords = [];
  c.documents = [];
  c.supplier = {
    ...c.supplier,
    cnpj: A,
    openingDate: "1999-01-01",
    legalName: "Empresa Sintética A",
    shareholders: [],
    sanctions: [],
  };
  return c;
}
function dataset(): InvestigationDataset {
  return {
    schemaVersion: "1.0",
    purpose: "Teste sintético de triagem, sem pessoas reais.",
    legalBasis: "Dados sintéticos para teste unitário.",
    evidence: [
      {
        id: "e1",
        sourceName: "Ato sintético",
        sourceKind: "analyst_document",
        sourceUrl: "https://example.test/ato",
        retrievedAt: "2026-11-11T10:00:00Z",
        artifactSha256: H,
        locator: "página 1",
      },
    ],
    companyEvents: [],
    people: [],
    corporateLinks: [],
    publicRoles: [],
    familyLinks: [],
    competitions: [],
  };
}
function input(
  ds: InvestigationDataset | null = null,
): InvestigationEngineInput {
  return {
    subject: contract(),
    portfolio: [],
    dataset: ds,
    verifiedArtifactHashes: [H],
    evaluatedAt: "2026-11-22T12:00:00Z",
    coverage: [
      {
        source: "Índice sintético",
        status: "partial",
        queriedAt: "2026-11-20T10:00:00Z",
        periodFrom: null,
        periodThrough: null,
        description: "Cobertura parcial e restrita aos dados de teste.",
      },
    ],
  };
}
function observed(r: InvestigationReport, rule: string) {
  return r.findings.filter(
    (f) => f.ruleCode === rule && f.state === "OBSERVATION",
  );
}
function familyCase(): InvestigationDataset {
  const ds = dataset();
  ds.people = ["owner", "official"].map((id) => ({
    id,
    name: `Pessoa Sintética ${id}`,
    publicRecordId: `synthetic:${id}`,
    identityStatus: "documented" as const,
    identityEvidenceIds: ["e1"],
  }));
  ds.corporateLinks = [
    {
      id: "ownership",
      personId: "owner",
      companyCnpj: A,
      role: "shareholder",
      validFrom: "2026-01-01",
      validThrough: "2026-12-31",
      evidenceIds: ["e1"],
    },
  ];
  ds.publicRoles = [
    {
      id: "office",
      personId: "official",
      entityId: "synthetic-buyer",
      contractId: null,
      role: "director",
      validFrom: "2026-01-01",
      validThrough: "2026-12-31",
      evidenceIds: ["e1"],
    },
  ];
  ds.familyLinks = [
    {
      id: "kinship",
      personAId: "owner",
      personBId: "official",
      relationship: "consanguinity",
      degree: 2,
      verification: "documented",
      validFrom: "2026-01-01",
      validThrough: "2026-12-31",
      evidenceIds: ["e1"],
    },
  ];
  return ds;
}

test("strict calendar arithmetic rejects rollover/timestamps and handles leap years", () => {
  assert.equal(strictDateDays("2026-02-29"), null);
  assert.equal(strictDateDays("2024-02-30"), null);
  assert.equal(strictDateDays("1900-02-29"), null);
  assert.equal(strictDateDays("2026-11-10T00:00:00Z"), null);
  assert.equal(strictDateDays("2026-13-01"), null);
  assert.equal(strictDateDays("2026-00-01"), null);
  assert.equal(strictDateDays(""), null);
  assert.equal(
    strictDateDays("2024-03-01")! - strictDateDays("2024-02-29")!,
    1,
  );
  assert.notEqual(strictDateDays("2000-02-29"), null);
});

test("D0 and D1 are temporal observations, not illegality or shell-company conclusions", () => {
  for (const [opening, days] of [
    [S, 0],
    ["2026-11-09", 1],
  ] as const) {
    const i = input();
    i.subject.supplier.openingDate = opening;
    const r = evaluateInvestigation(i);
    const fs = observed(r, "INV-TIME-002");
    assert.equal(r.metrics.daysFromActivityStart, days);
    assert.equal(fs.length, 1);
    assert.equal(fs[0].priority, "high");
    assert.match(fs[0].limitation, /não prazos de proibição legal/);
    assert.match(fs[0].limitation, /não foi preservada/);
    assert.match(
      fs[0].alternativeHypotheses.join(" "),
      /regularmente habilitada/,
    );
    assert.equal((r as unknown as { score?: number }).score, undefined);
  }
});

test("negative chronology is preserved rather than absolute-valued; future/invalid dates remain unverifiable", () => {
  const i = input();
  i.subject.supplier.openingDate = "2026-11-11";
  const r = evaluateInvestigation(i);
  assert.equal(r.metrics.daysFromActivityStart, -1);
  assert.equal(observed(r, "INV-TIME-001").length, 1);
  assert.equal(observed(r, "INV-TIME-002").length, 0);
  for (const bad of ["2026-02-30", "2026-12-01", ""]) {
    const j = input();
    j.subject.supplier.openingDate = bad;
    const x = evaluateInvestigation(j);
    assert.equal(x.metrics.daysFromActivityStart, null);
    assert.equal(observed(x, "INV-TIME-002").length, 0);
  }
  i.subject.signatureDate = "2026-12-05";
  i.subject.startDate = S;
  assert.equal(observed(evaluateInvestigation(i), "INV-TIME-002").length, 0);
});

test("constitution, registration and activity dates remain distinct; conflicting dates are not silently selected", () => {
  const ds = dataset();
  ds.companyEvents = [
    {
      id: "constitution",
      cnpj: A,
      kind: "constitution",
      date: "2010-01-01",
      evidenceIds: ["e1"],
    },
    {
      id: "registration",
      cnpj: A,
      kind: "cnpj_registration",
      date: S,
      evidenceIds: ["e1"],
    },
    {
      id: "activity1",
      cnpj: A,
      kind: "activity_start",
      date: "2026-11-09",
      evidenceIds: ["e1"],
    },
    {
      id: "activity2",
      cnpj: A,
      kind: "activity_start",
      date: "2025-01-01",
      evidenceIds: ["e1"],
    },
  ];
  const r = evaluateInvestigation(input(ds));
  assert.equal(r.metrics.daysFromActivityStart, null);
  assert.equal(observed(r, "INV-TIME-002").length, 1);
  assert.match(
    observed(r, "INV-TIME-002")[0].statement,
    /inscrição do estabelecimento/,
  );
  assert.ok(
    r.findings.some(
      (f) =>
        f.statement.includes("conflitantes") && f.state === "NOT_VERIFIABLE",
    ),
  );
  assert.equal(
    r.timeline.filter((t) => t.id === "company-date:activity_start").length,
    0,
  );
});

test("a recent branch is not equated to a recent company or merged with matriz contracts", () => {
  const i = input();
  i.subject.supplier.cnpj = cnpj("123456780002");
  i.subject.supplier.openingDate = S;
  i.portfolio = [contract("matriz-contract")];
  const r = evaluateInvestigation(i);
  assert.equal(r.metrics.observedContractCount, 1);
  assert.match(
    observed(r, "INV-TIME-002")[0].statement,
    /não foi inferida a idade da matriz/,
  );
});

test("single observed contract states coverage limitation and deduplicates mirrored control IDs", () => {
  const i = input();
  const mirror = structuredClone(i.subject);
  mirror.id = "other-internal-id";
  i.portfolio = [i.subject, mirror];
  const r = evaluateInvestigation(i);
  assert.equal(r.metrics.observedContractCount, 1);
  assert.match(
    observed(r, "INV-HISTORY-001")[0].statement,
    /não demonstra.*apenas um contrato/,
  );
  assert.ok(r.limitations.some((s) => s.includes("Cobertura parcial")));
  assert.equal(r.metrics.portfolioExcludedCount, 2);
});

test("supplier count excludes contracting-body/subcontractor/ambiguous roles and accepts sourced supplier", () => {
  const i = input();
  const body = contract("body");
  body.cnpjRole = "orgao_contratante";
  const sub = contract("sub");
  sub.cnpjRole = "subcontratado";
  const ambiguous = contract("ambiguous");
  delete ambiguous.cnpjRole;
  i.portfolio = [body, sub, ambiguous];
  assert.equal(evaluateInvestigation(i).metrics.observedContractCount, 1);
  ambiguous.sourceRecords = [
    {
      id: "s",
      sourceSystem: "PNCP",
      externalId: "ext",
      retrievedAt: "2026-11-11T00:00:00Z",
      reportedOriginalValue: 100,
      reportedUpdatedValue: 100,
      reportedSupplierCnpj: A,
      reportedStatus: "",
      reportedEndDate: "",
      sourceUrl: "https://example.test",
    },
  ];
  assert.equal(evaluateInvestigation(i).metrics.observedContractCount, 2);
});

test("prior observed contracts use strict dates before signature, not same-day records or undocumented intervals", () => {
  const i = input();
  const prior = contract("prior");
  prior.signatureDate = "2026-11-09";
  const sameDay = contract("same-day");
  i.portfolio = [prior, sameDay];
  assert.equal(evaluateInvestigation(i).metrics.observedPriorContractCount, 1);
  sameDay.signatureDate = "";
  assert.equal(
    evaluateInvestigation(i).metrics.observedPriorContractCount,
    null,
  );
  sameDay.signatureDate = S;
  const duplicate = structuredClone(prior);
  duplicate.signatureDate = S;
  i.portfolio.push(duplicate);
  assert.equal(
    evaluateInvestigation(i).metrics.observedPriorContractCount,
    null,
  );
});

test("concentration requires at least 3 usable contracts and rejects invalid values or conflicting mirrors", () => {
  const i = input();
  i.portfolio = [contract("two"), contract("three")];
  let r = evaluateInvestigation(i);
  assert.equal(r.metrics.sameBuyerValueSharePct, 100);
  assert.equal(observed(r, "INV-CONCENTRATION-001").length, 1);
  assert.match(
    observed(r, "INV-CONCENTRATION-001")[0].calculation,
    /não corresponde a faturamento/,
  );
  for (const bad of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
    const j = input();
    j.portfolio = [contract("two", bad), contract("three")];
    const x = evaluateInvestigation(j);
    assert.equal(x.metrics.sameBuyerValueSharePct, null);
    assert.equal(observed(x, "INV-CONCENTRATION-001").length, 0);
  }
  const conflicting = structuredClone(i.portfolio[0]);
  conflicting.updatedValue = 999;
  i.portfolio.push(conflicting);
  r = evaluateInvestigation(i);
  assert.equal(r.metrics.observedContractCount, 3);
  assert.equal(r.metrics.sameBuyerValueSharePct, null);
});

test("recent corporate change requires preserved documentary history, not current snapshot", () => {
  const ds = dataset();
  ds.companyEvents = [
    {
      id: "change",
      cnpj: A,
      kind: "shareholder_change",
      date: "2026-11-09",
      evidenceIds: ["e1"],
    },
  ];
  const i = input(ds);
  assert.equal(observed(evaluateInvestigation(i), "INV-CHANGE-001").length, 1);
  i.verifiedArtifactHashes = [];
  assert.equal(observed(evaluateInvestigation(i), "INV-CHANGE-001").length, 0);
});

test("fully documented identity, kinship, ownership and official function produce a review observation", () => {
  const r = evaluateInvestigation(input(familyCase()));
  assert.equal(observed(r, "INV-FAMILY-001").length, 1);
  assert.equal(observed(r, "INV-REL-001").length, 0);
  assert.match(
    observed(r, "INV-FAMILY-001")[0].limitation,
    /Confirmar o regime jurídico/,
  );
  assert.ok(
    r.graph.edges.some(
      (e) => e.id === "family:kinship" && e.status === "documented",
    ),
  );
});

test("same names, masked CPF and absent kinship never resolve identities or infer family", () => {
  const ds = familyCase();
  ds.people.forEach((p) => {
    p.name = "Pessoa Sintética Homônima";
    p.identityStatus = "unresolved";
  });
  ds.familyLinks = [];
  const r = evaluateInvestigation(input(ds));
  assert.equal(observed(r, "INV-FAMILY-001").length, 0);
  assert.equal(observed(r, "INV-REL-001").length, 0);
  assert.equal(r.graph.nodes.filter((n) => n.kind === "person").length, 2);
});

test("missing artifact or evidence reference does not upgrade URL or analyst assertion to documented relation", () => {
  for (const mutation of [
    (i: InvestigationEngineInput) => {
      i.verifiedArtifactHashes = [];
    },
    (i: InvestigationEngineInput) => {
      i.dataset!.evidence[0].artifactSha256 = null;
    },
    (i: InvestigationEngineInput) => {
      i.dataset!.familyLinks[0].evidenceIds.push("missing");
    },
    (i: InvestigationEngineInput) => {
      i.dataset!.people[0].identityEvidenceIds = [];
    },
    (i: InvestigationEngineInput) => {
      i.dataset!.familyLinks[0].verification = "unverified";
    },
    (i: InvestigationEngineInput) => {
      i.dataset!.evidence.push({ ...i.dataset!.evidence[0] });
    },
  ]) {
    const i = input(familyCase());
    mutation(i);
    assert.equal(
      observed(evaluateInvestigation(i), "INV-FAMILY-001").length,
      0,
    );
  }
});

test("unknown or expired temporal bounds cannot establish simultaneous family/function/ownership", () => {
  for (const change of ["family", "role", "company"] as const) {
    for (const end of [null, "2026-11-09", "2026-02-30"]) {
      const ds = familyCase();
      const item =
        change === "family"
          ? ds.familyLinks[0]
          : change === "role"
            ? ds.publicRoles[0]
            : ds.corporateLinks[0];
      item.validThrough = end;
      const r = evaluateInvestigation(input(ds));
      assert.equal(observed(r, "INV-FAMILY-001").length, 0);
      assert.ok(
        !r.graph.edges.some(
          (e) => e.id === "family:kinship" && e.status === "documented",
        ),
      );
      if (end === "2026-11-09" && change === "role")
        assert.ok(!r.graph.edges.some((e) => e.id === "role:office"));
    }
  }
});

test("foreign agency, generic PEP/politician and untied procurement agent are not role nexus", () => {
  for (const change of [
    (ds: InvestigationDataset) => {
      ds.publicRoles[0].entityId = "different-agency";
    },
    (ds: InvestigationDataset) => {
      ds.publicRoles[0].role = "elected_other";
    },
    (ds: InvestigationDataset) => {
      ds.publicRoles[0].role = "procurement_agent";
      ds.publicRoles[0].contractId = null;
    },
    (ds: InvestigationDataset) => {
      ds.publicRoles[0].role = "contract_inspector";
      ds.publicRoles[0].contractId = "different-contract";
    },
  ]) {
    const ds = familyCase();
    change(ds);
    assert.equal(
      observed(evaluateInvestigation(input(ds)), "INV-FAMILY-001").length,
      0,
    );
  }
});

test("family degree must be explicit within scope; spouses need no degree inferred", () => {
  const ds = familyCase();
  ds.familyLinks[0].degree = null;
  assert.equal(
    observed(evaluateInvestigation(input(ds)), "INV-FAMILY-001").length,
    0,
  );
  ds.familyLinks[0].degree = 4 as 3;
  assert.equal(
    observed(evaluateInvestigation(input(ds)), "INV-FAMILY-001").length,
    0,
  );
  ds.familyLinks[0].relationship = "spouse";
  ds.familyLinks[0].degree = null;
  assert.equal(
    observed(evaluateInvestigation(input(ds)), "INV-FAMILY-001").length,
    1,
  );
});

test("same documented identity holding corporate and relevant public roles is a distinct direct-link rule", () => {
  const ds = familyCase();
  ds.publicRoles[0].personId = "owner";
  ds.familyLinks = [];
  const r = evaluateInvestigation(input(ds));
  assert.equal(observed(r, "INV-REL-001").length, 1);
  assert.equal(observed(r, "INV-FAMILY-001").length, 0);
  ds.corporateLinks[0].validFrom = null;
  assert.equal(
    observed(evaluateInvestigation(input(ds)), "INV-REL-001").length,
    0,
  );
});

test("common bidder identity requires same lot, documented participant list and links active on event date", () => {
  const ds = familyCase();
  ds.publicRoles = [];
  ds.familyLinks = [];
  ds.corporateLinks.push({
    ...ds.corporateLinks[0],
    id: "ownership-b",
    companyCnpj: B,
  });
  ds.competitions = [
    {
      id: "competition",
      contractId: "synthetic-contract",
      lotId: "lot-1",
      eventDate: "2026-11-01",
      bidderCnpjs: [A, B],
      evidenceIds: ["e1"],
    },
  ];
  assert.equal(
    observed(evaluateInvestigation(input(ds)), "INV-COMPETITION-001").length,
    1,
  );
  ds.corporateLinks[1].validFrom = "2026-11-05";
  assert.equal(
    observed(evaluateInvestigation(input(ds)), "INV-COMPETITION-001").length,
    0,
  );
  ds.corporateLinks[1].validFrom = "2026-01-01";
  ds.competitions[0].contractId = "unrelated-contract";
  assert.equal(
    observed(evaluateInvestigation(input(ds)), "INV-COMPETITION-001").length,
    0,
  );
  ds.competitions[0].contractId = "synthetic-contract";
  ds.competitions[0].bidderCnpjs = [A, A];
  assert.equal(
    observed(evaluateInvestigation(input(ds)), "INV-COMPETITION-001").length,
    0,
  );
});

test("finding identity is stable on reorder/reevaluation and changed facts invalidate its input digest", () => {
  const i = input(familyCase());
  const first = observed(evaluateInvestigation(i), "INV-FAMILY-001")[0];
  i.dataset!.people.reverse();
  i.evaluatedAt = "2026-11-23T12:00:00Z";
  const second = observed(evaluateInvestigation(i), "INV-FAMILY-001")[0];
  assert.equal(first.id, second.id);
  assert.equal(first.inputDigest, second.inputDigest);
  i.dataset!.familyLinks[0].degree = 3;
  const third = observed(evaluateInvestigation(i), "INV-FAMILY-001")[0];
  assert.equal(first.id, third.id);
  assert.notEqual(first.inputDigest, third.inputDigest);
});

test("canonical JSON sorts object keys and engine does not mutate caller input", () => {
  assert.equal(
    stableInvestigationJson({ b: 2, a: { z: 1, y: undefined } }),
    '{"a":{"z":1},"b":2}',
  );
  const i = input(familyCase());
  const before = stableInvestigationJson(i);
  evaluateInvestigation(i);
  assert.equal(stableInvestigationJson(i), before);
});

test("report digest covers the evaluation date used to reject future events but is stable within a day", () => {
  const i = input();
  const one = evaluateInvestigation(i).inputDigest;
  i.evaluatedAt = "2026-11-22T18:30:00Z";
  assert.equal(evaluateInvestigation(i).inputDigest, one);
  i.evaluatedAt = "2026-11-23T12:00:00Z";
  assert.notEqual(evaluateInvestigation(i).inputDigest, one);
});

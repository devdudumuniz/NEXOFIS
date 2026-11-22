import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fetchCompanyRegistryEvidence } from "../server/companyRegistryEvidence";

const CNPJ = "11222333000181";
const NOW = "2026-11-22T12:00:00.000Z";
const BASE = {
  cnpj: CNPJ,
  razao_social: "EMPRESA SINTETICA DE TESTE LTDA",
  data_inicio_atividade: "2026-11-21",
  qsa: [
    {
      identificador_de_socio: 2,
      nome_socio: "PESSOA SINTETICA ALFA",
      qualificacao_socio: "Sócio-Administrador",
      codigo_qualificacao_socio: 49,
      data_entrada_sociedade: "2026-11-21",
    },
  ],
};

function mockedJson(payload: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json; charset=utf-8" },
    })) as typeof fetch;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("registry extract is minimized and its artifact hash covers exactly the returned bytes", async () => {
  const payload = {
    ...BASE,
    email: "restricted@example.invalid",
    logradouro: "ENDERECO PRIVADO SINTETICO",
    ddd_telefone_1: "001234567890",
    capital_social: 12345,
    qsa: [
      {
        ...BASE.qsa[0],
        cnpj_cpf_do_socio: "123.456.789-00",
        cpf_representante_legal: "987.654.321-00",
        nome_representante_legal: "REPRESENTANTE SINTETICO EXCLUIDO",
        family: ["PARENTE SINTETICO EXCLUIDO"],
      },
    ],
  };
  const result = await fetchCompanyRegistryEvidence("11.222.333/0001-81", {
    fetchImpl: mockedJson(payload),
    now: NOW,
  });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  const extract = JSON.parse(result.artifactBytes.toString("utf8"));
  assert.deepEqual(
    Object.keys(extract).sort(),
    [
      "schema",
      "sourceUrl",
      "retrievedAt",
      "sourcePayloadSha256",
      "derivation",
      "cnpj",
      "legalName",
      "activityStartDate",
      "shareholders",
    ].sort(),
  );
  assert.deepEqual(
    Object.keys(extract.shareholders[0]).sort(),
    ["name", "role", "entryDate"].sort(),
  );
  const encoded = JSON.stringify(result);
  for (const excluded of [
    "123.456.789-00",
    "987.654.321-00",
    "restricted@example.invalid",
    "ENDERECO PRIVADO SINTETICO",
    "REPRESENTANTE SINTETICO EXCLUIDO",
    "PARENTE SINTETICO EXCLUIDO",
    "001234567890",
  ]) {
    assert.equal(encoded.includes(excluded), false);
    assert.equal(result.artifactBytes.includes(Buffer.from(excluded)), false);
  }
  assert.equal(result.evidence.artifactSha256, sha256(result.artifactBytes));
  assert.equal(
    result.originalPayloadSha256,
    sha256(Buffer.from(JSON.stringify(payload))),
  );
  assert.equal(extract.sourcePayloadSha256, result.originalPayloadSha256);
  assert.notEqual(result.evidence.artifactSha256, result.originalPayloadSha256);
  assert.equal(result.evidence.sourceKind, "intermediary");
  assert.match(result.evidence.locator, /EXTRATO DERIVADO/);
  assert.match(result.evidence.locator, /original não foi arquivado/);
  assert.equal("familyLinks" in result, false);
});

test("fixed endpoint, no redirects, deadline, and validation precede any request", async () => {
  let calls = 0;
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls += 1;
    assert.equal(url, `https://brasilapi.com.br/api/cnpj/v1/${CNPJ}`);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response(JSON.stringify(BASE), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  for (const invalid of [
    "11222333000100",
    "00000000000000",
    "http://11222333000181",
    "11222333000181?redirect=1",
  ]) {
    assert.equal(
      (await fetchCompanyRegistryEvidence(invalid, { fetchImpl, now: NOW }))
        .status,
      "unavailable",
    );
  }
  assert.equal(calls, 0);
  assert.equal(
    (await fetchCompanyRegistryEvidence(CNPJ, { fetchImpl, now: NOW })).status,
    "available",
  );
  assert.equal(calls, 1);
});

test("alphanumeric CNPJ is checked and attempted without inventing an unsupported provider limitation", async () => {
  const alphaCnpj = "00000000E08G12";
  let called = false;
  const fetchImpl = (async (url: string | URL | Request) => {
    called = true;
    assert.equal(url, `https://brasilapi.com.br/api/cnpj/v1/${alphaCnpj}`);
    return new Response(JSON.stringify({ ...BASE, cnpj: alphaCnpj }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  assert.equal(
    (
      await fetchCompanyRegistryEvidence("00.000.000/e08g-12", {
        fetchImpl,
        now: NOW,
      })
    ).status,
    "available",
  );
  assert.equal(called, true);
});

test("provider CNPJ drift or missing CNPJ rejects the complete response", async () => {
  for (const cnpj of [
    "00000000E08G12",
    undefined,
    11222333000181,
    "11222333000100",
  ]) {
    const result = await fetchCompanyRegistryEvidence(CNPJ, {
      fetchImpl: mockedJson({ ...BASE, cnpj }),
      now: NOW,
    });
    assert.equal(result.status, "unavailable");
    assert.equal("artifactBytes" in result, false);
  }
});

test("same-name QSA rows remain separate unresolved records without a full CPF", async () => {
  const result = await fetchCompanyRegistryEvidence(CNPJ, {
    fetchImpl: mockedJson({ ...BASE, qsa: [BASE.qsa[0], BASE.qsa[0]] }),
    now: NOW,
  });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.people.length, 2);
  assert.notEqual(result.people[0].id, result.people[1].id);
  assert.notEqual(
    result.people[0].publicRecordId,
    result.people[1].publicRecordId,
  );
  assert.ok(
    result.people.every(
      (person) =>
        person.identityStatus === "unresolved" &&
        person.id.startsWith("registry:"),
    ),
  );
  assert.equal(result.corporateLinks.length, 4);
  assert.ok(
    result.corporateLinks.every(
      (link) => link.validFrom === "2026-11-21" && link.validThrough === null,
    ),
  );
  assert.deepEqual(
    result.companyEvents.map((event) => event.kind),
    ["activity_start"],
  );
});

test("invalid calendar dates are absent instead of silently rolling into the next month", async () => {
  const result = await fetchCompanyRegistryEvidence(CNPJ, {
    fetchImpl: mockedJson({
      ...BASE,
      data_inicio_atividade: "2026-02-30",
      qsa: [{ ...BASE.qsa[0], data_entrada_sociedade: "2025-02-29" }],
    }),
    now: NOW,
  });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.deepEqual(result.companyEvents, []);
  assert.ok(
    result.corporateLinks.every(
      (link) => link.validFrom === null && link.validThrough === null,
    ),
  );
  assert.equal(
    JSON.parse(result.artifactBytes.toString()).activityStartDate,
    null,
  );
  assert.match(result.message, /ausente ou inválida/);
});

test("invalid acquisition timestamp prevents the request", async () => {
  const fetchImpl = (async () => {
    throw new Error("must not request");
  }) as typeof fetch;
  for (const now of [
    "2026-02-30T00:00:00.000Z",
    "2026-11-22T24:00:00.000Z",
    "not-a-date",
  ]) {
    const result = await fetchCompanyRegistryEvidence(CNPJ, { fetchImpl, now });
    assert.equal(result.status, "unavailable");
    assert.equal(result.message, "Instante de aquisição inválido.");
  }
});

test("unknown or conflicting qualifications never become ownership relationships", async () => {
  const qsa = [
    {
      ...BASE.qsa[0],
      qualificacao_socio: "Colaborador",
      codigo_qualificacao_socio: 999,
    },
    {
      ...BASE.qsa[0],
      qualificacao_socio: "Administrador",
      codigo_qualificacao_socio: 49,
    },
  ];
  const result = await fetchCompanyRegistryEvidence(CNPJ, {
    fetchImpl: mockedJson({ ...BASE, qsa }),
    now: NOW,
  });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.people.length, 2);
  assert.deepEqual(result.corporateLinks, []);
});

test("corporate or unclassified foreign QSA entries are not turned into natural people", async () => {
  const qsa = [1, 3, undefined].map((identificador_de_socio) => ({
    ...BASE.qsa[0],
    identificador_de_socio,
  }));
  const result = await fetchCompanyRegistryEvidence(CNPJ, {
    fetchImpl: mockedJson({ ...BASE, qsa }),
    now: NOW,
  });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.deepEqual(result.people, []);
  assert.deepEqual(result.corporateLinks, []);
  assert.equal(
    JSON.parse(result.artifactBytes.toString()).shareholders.length,
    3,
  );
});

test("CPF and contact embedded in a selected name are redacted", async () => {
  const payload = {
    ...BASE,
    razao_social: "12345678900 EMPRESA SINTETICA",
    qsa: [
      {
        ...BASE.qsa[0],
        nome_socio: "SINTETICO 123.456.789-00 name@example.invalid",
      },
    ],
  };
  const result = await fetchCompanyRegistryEvidence(CNPJ, {
    fetchImpl: mockedJson(payload),
    now: NOW,
  });
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  const text = result.artifactBytes.toString();
  assert.equal(text.includes("12345678900"), false);
  assert.equal(text.includes("123.456.789-00"), false);
  assert.equal(text.includes("name@example.invalid"), false);
  assert.match(result.people[0].name, /identificador pessoal omitido/);
});

test("rate limiting, missing record, provider failure and timeout remain unavailable without upstream error leaks", async () => {
  for (const status of [400, 404, 429, 500, 503]) {
    const result = await fetchCompanyRegistryEvidence(CNPJ, {
      fetchImpl: (async () =>
        new Response("SENSITIVE_UPSTREAM_ERROR", { status })) as typeof fetch,
      now: NOW,
    });
    assert.equal(result.status, "unavailable");
    assert.equal(
      JSON.stringify(result).includes("SENSITIVE_UPSTREAM_ERROR"),
      false,
    );
  }
  const timeout = await fetchCompanyRegistryEvidence(CNPJ, {
    fetchImpl: (async () => {
      throw new DOMException("SENSITIVE_TIMEOUT_CONTENT", "TimeoutError");
    }) as typeof fetch,
    now: NOW,
  });
  assert.equal(timeout.status, "unavailable");
  assert.equal(
    JSON.stringify(timeout).includes("SENSITIVE_TIMEOUT_CONTENT"),
    false,
  );
});

test("oversized announced body is cancelled before it is read", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const result = await fetchCompanyRegistryEvidence(CNPJ, {
    fetchImpl: (async () =>
      new Response(body, {
        headers: {
          "content-type": "application/json",
          "content-length": String(1024 * 1024 + 1),
        },
      })) as typeof fetch,
    now: NOW,
  });
  assert.equal(result.status, "unavailable");
  assert.equal(cancelled, true);
});

test("actual streamed body limit is enforced without trusting Content-Length", async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(512 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const result = await fetchCompanyRegistryEvidence(CNPJ, {
    fetchImpl: (async () =>
      new Response(body, {
        headers: { "content-type": "application/json", "content-length": "1" },
      })) as typeof fetch,
    now: NOW,
  });
  assert.equal(result.status, "unavailable");
  assert.equal(cancelled, true);
  assert.equal(pulls, 3);
});

test("oversized or malformed QSA is rejected without silently dropping records", async () => {
  for (const qsa of [
    Array.from({ length: 201 }, () => BASE.qsa[0]),
    { socios: [] },
    [null],
    [{ ...BASE.qsa[0], nome_socio: "" }],
  ]) {
    assert.equal(
      (
        await fetchCompanyRegistryEvidence(CNPJ, {
          fetchImpl: mockedJson({ ...BASE, qsa }),
          now: NOW,
        })
      ).status,
      "unavailable",
    );
  }
});

test("malformed JSON, non-JSON, invalid UTF-8 or changed origin do not yield evidence", async () => {
  const responses = [
    new Response("{", { headers: { "content-type": "application/json" } }),
    new Response("<html/>", { headers: { "content-type": "text/html" } }),
    new Response(new Uint8Array([0xff]), {
      headers: { "content-type": "application/json" },
    }),
  ];
  const redirected = new Response(JSON.stringify(BASE), {
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(redirected, "url", {
    value: "https://example.invalid/redirect",
  });
  responses.push(redirected);
  for (const response of responses) {
    const result = await fetchCompanyRegistryEvidence(CNPJ, {
      fetchImpl: (async () => response) as typeof fetch,
      now: NOW,
    });
    assert.equal(result.status, "unavailable");
    assert.equal("evidence" in result, false);
  }
});

test("identical snapshot inputs reproduce hashes and IDs while missing QSA is explicit", async () => {
  const payload = { ...BASE, qsa: null };
  const a = await fetchCompanyRegistryEvidence(CNPJ, {
    fetchImpl: mockedJson(payload),
    now: NOW,
  });
  const b = await fetchCompanyRegistryEvidence(CNPJ, {
    fetchImpl: mockedJson(payload),
    now: NOW,
  });
  assert.equal(a.status, "available");
  assert.equal(b.status, "available");
  if (a.status !== "available" || b.status !== "available") return;
  assert.deepEqual(a, b);
  assert.match(a.message, /QSA não fornecido/);
});

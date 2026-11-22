import crypto from "node:crypto";
import type { ContractRecord } from "../types/audit";
import type { InvestigationEngineInput } from "../types/investigation";
import {
  evaluateInvestigation,
  INVESTIGATION_ENGINE_VERSION,
} from "../lib/investigationEngine";
import {
  canonicalInvestigationJson,
  investigationDigest,
} from "./investigationStore";
import {
  validateInvestigationDataset,
  validInvestigationDate,
} from "./investigationValidation";

export const MAX_INVESTIGATION_PACKAGE_BYTES = 64 * 1024 * 1024;
export const VERIFICATION_DISCLAIMER =
  "Esta conferência verifica consistência interna, reprodução das regras e correspondência dos bytes fornecidos. Não certifica autoria, veracidade, assinatura digital, carimbo de tempo, completude das fontes ou admissibilidade judicial. Uma cadeia inteiramente reescrita por quem controla os dados exige âncora externa para ser detectada.";

export interface VerificationResult {
  exitCode: 0 | 1 | 2;
  errors: string[];
  warnings: string[];
  checks: {
    packageHashVerified: boolean;
    eventChainVerified: boolean;
    reportReplayed: boolean;
    expectedOriginalCount: number;
    verifiedOriginalCount: number;
  };
  disclaimer: string;
}

type Obj = Record<string, unknown>;
const HASH = /^[a-f0-9]{64}$/;
const MAX_DEPTH = 64;
const MAX_NODES = 1_000_000;

function object(value: unknown, name: string): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name}: objeto obrigatório.`);
  return value as Obj;
}
function keys(value: Obj, expected: string[], name: string) {
  if (
    expected.some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some((k) => !expected.includes(k))
  )
    throw new Error(`${name}: campos ausentes ou não previstos pelo esquema.`);
}
function array(value: unknown, limit: number, name: string): unknown[] {
  if (!Array.isArray(value) || value.length > limit)
    throw new Error(`${name}: lista inválida ou limite de ${limit} excedido.`);
  return value;
}
function string(
  value: unknown,
  max: number,
  name: string,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!allowEmpty && !value.trim())
  )
    throw new Error(`${name}: texto inválido.`);
  return value;
}
function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !HASH.test(value))
    throw new Error(`${name}: SHA-256 inválido.`);
  return value;
}
function instant(value: unknown, name: string): string {
  const text = string(value, 30, name);
  if (
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?Z$/.test(
      text,
    ) ||
    !validInvestigationDate(text.slice(0, 10))
  )
    throw new Error(`${name}: instante UTC inválido.`);
  return text;
}
function same(left: unknown, right: unknown): boolean {
  return canonicalInvestigationJson(left) === canonicalInvestigationJson(right);
}

/** Bound recursive parsing/canonicalization, including callers supplying objects directly. */
function assertJson(value: unknown) {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++count > MAX_NODES || current.depth > MAX_DEPTH)
      throw new Error("Estrutura excede o orçamento de verificação JSON.");
    const item = current.value;
    if (item === null || typeof item === "string" || typeof item === "boolean")
      continue;
    if (typeof item === "number" && Number.isFinite(item)) continue;
    if (typeof item !== "object" || item === null)
      throw new Error("Pacote deve conter somente valores JSON finitos.");
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new Error("Pacote contém objeto não JSON.");
    for (const child of Object.values(item))
      stack.push({ value: child, depth: current.depth + 1 });
  }
  if (
    Buffer.byteLength(JSON.stringify(value)) > MAX_INVESTIGATION_PACKAGE_BYTES
  )
    throw new Error("Pacote excede 64 MiB.");
}

function validateContract(
  value: unknown,
  name: string,
  refsBudget: { count: number },
): ContractRecord {
  const c = object(value, name);
  for (const field of [
    "id",
    "pncpControlNumber",
    "contractNumber",
    "signatureDate",
    "entityId",
    "entityName",
  ])
    string(c[field], 4000, `${name}.${field}`, field !== "id");
  if (typeof c.updatedValue !== "number" || !Number.isFinite(c.updatedValue))
    throw new Error(`${name}.updatedValue: valor finito obrigatório.`);
  if (
    c.cnpjRole !== undefined &&
    !["fornecedor", "orgao_contratante", "subcontratado"].includes(
      String(c.cnpjRole),
    )
  )
    throw new Error(`${name}.cnpjRole: papel inválido.`);
  const supplier = object(c.supplier, `${name}.supplier`);
  for (const field of ["cnpj", "openingDate", "legalName", "dataProvenance"])
    string(supplier[field], 4000, `${name}.supplier.${field}`, true);
  const sources = array(c.sourceRecords, 500, `${name}.sourceRecords`);
  for (const [i, value] of sources.entries()) {
    const source = object(value, `${name}.sourceRecords[${i}]`);
    for (const field of [
      "sourceSystem",
      "sourceUrl",
      "retrievedAt",
      "externalId",
      "reportedSupplierCnpj",
    ])
      string(source[field], 8000, `${name}.sourceRecords[${i}].${field}`, true);
    if (source.rawPayloadHash !== undefined)
      string(
        source.rawPayloadHash,
        200,
        `${name}.sourceRecords[${i}].rawPayloadHash`,
        true,
      );
  }
  const docs = array(c.documents, 500, `${name}.documents`);
  for (const [i, value] of docs.entries()) {
    const doc = object(value, `${name}.documents[${i}]`);
    for (const field of [
      "id",
      "documentType",
      "sourceSystem",
      "sourceUrl",
      "retrievedAt",
      "sha256",
      "title",
    ])
      string(doc[field], 8000, `${name}.documents[${i}].${field}`, true);
  }
  refsBudget.count += sources.length + docs.length;
  if (refsBudget.count > 5000)
    throw new Error(
      "Fontes/documentos excedem o orçamento de reprodução de 5.000 registros.",
    );
  return c as unknown as ContractRecord;
}

function validateInput(value: unknown): InvestigationEngineInput {
  const input = object(value, "input");
  keys(
    input,
    [
      "subject",
      "portfolio",
      "dataset",
      "coverage",
      "verifiedArtifactHashes",
      "evaluatedAt",
    ],
    "input",
  );
  instant(input.evaluatedAt, "input.evaluatedAt");
  if (input.dataset !== null) validateInvestigationDataset(input.dataset);
  const refsBudget = { count: 0 };
  validateContract(input.subject, "input.subject", refsBudget);
  for (const [i, c] of array(
    input.portfolio,
    10_000,
    "input.portfolio",
  ).entries())
    validateContract(c, `input.portfolio[${i}]`, refsBudget);
  for (const [i, c] of array(input.coverage, 100, "input.coverage").entries()) {
    const source = object(c, `input.coverage[${i}]`);
    keys(
      source,
      [
        "source",
        "status",
        "queriedAt",
        "periodFrom",
        "periodThrough",
        "description",
      ],
      `input.coverage[${i}]`,
    );
    string(source.source, 1000, `input.coverage[${i}].source`);
    string(source.description, 8000, `input.coverage[${i}].description`);
    if (
      !["complete_in_source", "partial", "unavailable", "not_queried"].includes(
        String(source.status),
      )
    )
      throw new Error("Estado de cobertura inválido.");
    if (source.queriedAt !== null)
      instant(source.queriedAt, "coverage.queriedAt");
    for (const field of ["periodFrom", "periodThrough"])
      if (source[field] !== null && !validInvestigationDate(source[field]))
        throw new Error(`coverage.${field}: data inválida.`);
  }
  const verified = array(
    input.verifiedArtifactHashes,
    100,
    "input.verifiedArtifactHashes",
  ).map((h) => hash(h, "verifiedArtifactHash"));
  if (new Set(verified).size !== verified.length)
    throw new Error("Lista de hashes verificados contém duplicatas.");
  return input as unknown as InvestigationEngineInput;
}

/** No network access. Byte readers are supplied explicitly by the caller. */
export function verifyInvestigationPackage(
  pkg: unknown,
  readArtifact?: (sha: string) => Buffer | null,
): VerificationResult {
  const result: VerificationResult = {
    exitCode: 0,
    errors: [],
    warnings: [],
    checks: {
      packageHashVerified: false,
      eventChainVerified: false,
      reportReplayed: false,
      expectedOriginalCount: 0,
      verifiedOriginalCount: 0,
    },
    disclaimer: VERIFICATION_DISCLAIMER,
  };
  let incomplete = false;
  try {
    assertJson(pkg);
    const envelope = object(pkg, "package");
    keys(
      envelope,
      ["schema", "exportedAt", "softwareLicense", "integrity", "payload"],
      "package",
    );
    if (envelope.schema !== "nexofis.investigation.v1")
      throw new Error(
        "Esquema de pacote não suportado: esperado nexofis.investigation.v1.",
      );
    instant(envelope.exportedAt, "package.exportedAt");
    if (envelope.softwareLicense !== "AGPL-3.0-only")
      throw new Error("Metadado de licença incompatível com este esquema.");
    const integrity = object(envelope.integrity, "integrity");
    keys(
      integrity,
      ["algorithm", "canonicalization", "contentSha256"],
      "integrity",
    );
    if (
      integrity.algorithm !== "SHA-256" ||
      integrity.canonicalization !== "stable-json-v1"
    )
      throw new Error("Algoritmo ou canonicalização não suportados.");
    const contentHash = hash(
      integrity.contentSha256,
      "integrity.contentSha256",
    );
    const payload = object(envelope.payload, "payload");
    keys(
      payload,
      [
        "input",
        "report",
        "dataset",
        "events",
        "integrity",
        "artifactManifest",
        "methodNotice",
        "accessScope",
      ],
      "payload",
    );
    if (investigationDigest(payload) !== contentHash)
      throw new Error(
        "SHA-256 do payload diverge: pacote alterado ou corrompido.",
      );
    result.checks.packageHashVerified = true;
    const input = validateInput(payload.input);
    if (!same(payload.dataset, input.dataset))
      throw new Error("Dataset do payload diverge do input de reprodução.");
    const contractId = input.subject.id;
    const artifactEvents: Obj[] = [];
    const acquired = new Set<string>();
    const ids = new Set<string>();
    let previous: string | null = null;
    let latestDataset: unknown = null;
    const expectedHashes = new Set<string>();
    const events = array(payload.events, 1000, "events");
    for (const [index, value] of events.entries()) {
      const event = object(value, `events[${index}]`);
      keys(
        event,
        [
          "id",
          "contractId",
          "sequence",
          "kind",
          "actorId",
          "actorRole",
          "createdAt",
          "rationale",
          "payload",
          "previousEventHash",
          "eventHash",
        ],
        `events[${index}]`,
      );
      const id = string(event.id, 200, "event.id");
      if (ids.has(id)) throw new Error("ID de evento duplicado.");
      ids.add(id);
      if (
        event.contractId !== contractId ||
        event.sequence !== index + 1 ||
        event.previousEventHash !== previous
      )
        throw new Error(
          `Cadeia inválida no evento ${index + 1}: contrato, sequência ou elo anterior divergente.`,
        );
      string(event.actorId, 300, "event.actorId");
      if (!["analyst", "admin"].includes(String(event.actorRole)))
        throw new Error("Papel do autor não permitido no evento.");
      instant(event.createdAt, "event.createdAt");
      if (string(event.rationale, 5000, "event.rationale").trim().length < 12)
        throw new Error("Justificativa de evento insuficiente.");
      const eventHash = hash(event.eventHash, "event.eventHash");
      const { eventHash: _, ...unsigned } = event;
      if (investigationDigest(unsigned) !== eventHash)
        throw new Error(`Hash da cadeia diverge no evento ${index + 1}.`);
      const data = object(event.payload, "event.payload");
      if (event.kind === "artifact") {
        keys(
          data,
          ["artifactSha256", "filename", "mimeType", "sizeBytes"],
          "artifact event",
        );
        const sha = hash(data.artifactSha256, "artifactSha256");
        string(data.filename, 160, "artifact.filename");
        if (
          ![
            "application/pdf",
            "image/png",
            "image/jpeg",
            "text/plain",
          ].includes(String(data.mimeType))
        )
          throw new Error("MIME de artefato não previsto.");
        if (
          !Number.isInteger(data.sizeBytes) ||
          Number(data.sizeBytes) < 1 ||
          Number(data.sizeBytes) > 1024 * 1024
        )
          throw new Error("Tamanho de artefato fora dos limites.");
        acquired.add(sha);
        expectedHashes.add(sha);
        artifactEvents.push(data);
      } else if (event.kind === "dataset") {
        keys(data, ["dataset", "datasetDigest"], "dataset event");
        const dataset = validateInvestigationDataset(data.dataset);
        if (
          investigationDigest(data.dataset) !==
          hash(data.datasetDigest, "datasetDigest")
        )
          throw new Error("Digest do dataset no evento diverge.");
        for (const evidence of dataset.evidence)
          if (evidence.artifactSha256 && !acquired.has(evidence.artifactSha256))
            throw new Error(
              "Dataset referencia original sem aquisição anterior na trilha.",
            );
        latestDataset = data.dataset;
      } else if (event.kind === "review") {
        keys(
          data,
          ["findingId", "findingInputDigest", "action"],
          "review event",
        );
        string(data.findingId, 200, "findingId");
        hash(data.findingInputDigest, "findingInputDigest");
        if (!["dismiss", "restore"].includes(String(data.action)))
          throw new Error("Ação de revisão inválida.");
      } else throw new Error("Tipo de evento desconhecido.");
      previous = eventHash;
    }
    const historyIntegrity = object(payload.integrity, "payload.integrity");
    keys(
      historyIntegrity,
      ["valid", "eventCount", "headHash"],
      "payload.integrity",
    );
    if (
      historyIntegrity.valid !== true ||
      historyIntegrity.eventCount !== events.length ||
      historyIntegrity.headHash !== previous
    )
      throw new Error(
        "Cabeçalho de integridade da trilha diverge dos eventos.",
      );
    if (!same(latestDataset, input.dataset))
      throw new Error(
        "Input não corresponde à última revisão documental da trilha.",
      );
    result.checks.eventChainVerified = true;

    const manifest = array(
      payload.artifactManifest,
      1000,
      "artifactManifest",
    ).map((entry, i) => {
      const artifact = object(entry, `artifactManifest[${i}]`);
      keys(
        artifact,
        [
          "artifactSha256",
          "filename",
          "mimeType",
          "sizeBytes",
          "sha256VerifiedAtExport",
          "downloadPath",
        ],
        `artifactManifest[${i}]`,
      );
      hash(artifact.artifactSha256, "manifest.artifactSha256");
      if (typeof artifact.sha256VerifiedAtExport !== "boolean")
        throw new Error("Estado de verificação no manifesto inválido.");
      const expectedPath = `/api/contracts/${encodeURIComponent(contractId)}/investigation/artifacts/${artifact.artifactSha256}`;
      if (artifact.downloadPath !== expectedPath)
        throw new Error(
          "Caminho no manifesto não corresponde ao contrato/hash.",
        );
      return artifact;
    });
    if (
      !same(
        manifest.map(
          ({ sha256VerifiedAtExport: _, downloadPath: __, ...metadata }) =>
            metadata,
        ),
        artifactEvents,
      )
    )
      throw new Error(
        "Manifesto de originais diverge das aquisições registradas na trilha.",
      );
    const references = new Set(
      input.dataset?.evidence
        .map((e) => e.artifactSha256)
        .filter((h): h is string => Boolean(h)) ?? [],
    );
    for (const sha of references) {
      expectedHashes.add(sha);
      if (!manifest.some((a) => a.artifactSha256 === sha))
        throw new Error(
          "Original referenciado pelo dataset ausente do manifesto.",
        );
    }
    for (const sha of input.verifiedArtifactHashes) {
      if (
        !references.has(sha) ||
        !manifest.some(
          (a) => a.artifactSha256 === sha && a.sha256VerifiedAtExport === true,
        )
      )
        throw new Error(
          "Input declara hash verificado sem referência e manifesto coerentes.",
        );
    }
    for (const sha of references) {
      const verifiedAtExport = manifest.some(
        (a) => a.artifactSha256 === sha && a.sha256VerifiedAtExport === true,
      );
      if (verifiedAtExport !== input.verifiedArtifactHashes.includes(sha))
        throw new Error(
          "Estado do original no manifesto diverge do conjunto usado pelo motor.",
        );
    }

    const report = object(payload.report, "report");
    if (report.schemaVersion !== "1.0" || report.contractId !== contractId)
      throw new Error("Esquema ou contrato do relatório diverge dos inputs.");
    const reportVersion = string(
      report.engineVersion,
      100,
      "report.engineVersion",
    );
    if (reportVersion !== INVESTIGATION_ENGINE_VERSION) {
      incomplete = true;
      result.warnings.push(
        `Reprodução não realizada: pacote usa ${reportVersion}; este verificador contém ${INVESTIGATION_ENGINE_VERSION}. Use a versão correspondente do motor.`,
      );
    } else {
      const recalculated = evaluateInvestigation(input);
      if (!same(recalculated, report))
        throw new Error(
          "Relatório diverge da reprodução determinística dos inputs, mesmo que o hash do pacote tenha sido recalculado.",
        );
      result.checks.reportReplayed = true;
    }
    // Generated evidence may cite external source digests whose bytes were never
    // preserved by this installation. They remain explicitly incomplete offline.
    for (const value of array(report.evidence, 10_000, "report.evidence")) {
      const evidence = object(value, "report.evidence item");
      if (
        evidence.artifactSha256 !== null &&
        evidence.artifactSha256 !== undefined
      )
        expectedHashes.add(
          hash(evidence.artifactSha256, "report.evidence.artifactSha256"),
        );
    }
    result.checks.expectedOriginalCount = expectedHashes.size;
    for (const sha of expectedHashes) {
      let bytes: Buffer | null = null;
      try {
        bytes = readArtifact?.(sha) ?? null;
      } catch {
        incomplete = true;
        result.warnings.push(
          `Original ${sha}: leitura local indisponível ou fora dos limites.`,
        );
        continue;
      }
      if (bytes === null) {
        incomplete = true;
        result.warnings.push(
          `Original ${sha}: bytes não fornecidos para conferência offline.`,
        );
        continue;
      }
      if (!Buffer.isBuffer(bytes) || bytes.length > 1024 * 1024) {
        incomplete = true;
        result.warnings.push(
          `Original ${sha}: leitor não retornou Buffer dentro do limite de 1 MiB.`,
        );
        continue;
      }
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== sha) {
        result.errors.push(`Original ${sha}: SHA-256 divergente.`);
        continue;
      }
      if (
        manifest.some(
          (a) => a.artifactSha256 === sha && a.sizeBytes !== bytes.length,
        )
      ) {
        result.errors.push(`Original ${sha}: tamanho diverge do manifesto.`);
        continue;
      }
      result.checks.verifiedOriginalCount++;
    }
    if (!expectedHashes.size)
      result.warnings.push(
        "Não há originais com hash declarado neste pacote; o resultado completo limita-se à consistência dos dados e à reprodução das regras.",
      );
    result.warnings.push(
      "Data de exportação e licença são metadados do envelope; o SHA-256 declarado cobre o payload. Nenhum deles é assinatura digital.",
    );
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : "Pacote inválido.");
  }
  result.exitCode = result.errors.length ? 1 : incomplete ? 2 : 0;
  return result;
}

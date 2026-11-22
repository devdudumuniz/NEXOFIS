import { isIP } from "node:net";
import { isValidCnpj, normalizeCnpj } from "../lib/cnpj";
import type { InvestigationDataset } from "../types/investigation";

export const MAX_INVESTIGATION_JSON_BYTES = 512 * 1024;
export const MAX_INVESTIGATION_ARTIFACT_BYTES = 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const CPF_TEXT = /(?:^|[^0-9])(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})(?:$|[^0-9])/;

export class InvestigationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvestigationValidationError";
  }
}

function reject(message: string): never {
  throw new InvestigationValidationError(message);
}

export function strictObject(
  value: unknown,
  keys: string[],
  at: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    reject(`${at}: objeto obrigatório.`);
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some((key) => !keys.includes(key)))
    reject(`${at}: campo não permitido.`);
  if (keys.some((key) => !Object.hasOwn(obj, key)))
    reject(`${at}: campo obrigatório ausente.`);
  return obj;
}

function text(value: unknown, at: string, max = 300, min = 1): string {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    reject(`${at}: texto inválido (mínimo ${min}, máximo ${max} caracteres).`);
  }
  if (CPF_TEXT.test(value))
    reject(`${at}: CPF completo não é aceito neste esquema minimizado.`);
  return value.trim();
}

function id(value: unknown, at: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 160 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    reject(`${at}: identificador inválido.`);
  const result = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/.test(result) || result.includes(".."))
    reject(`${at}: identificador inválido.`);
  // Hash segments are opaque references, not CPF numbers embedded in a name.
  // Keep rejecting a literal 11-digit CPF while accepting connector IDs that contain
  // a random run of decimal digits inside a 32/64-character hexadecimal digest.
  const withoutHashSegments = result
    .split(":")
    .map((part) =>
      /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/i.test(part) ? "digest" : part,
    )
    .join(":");
  if (CPF_TEXT.test(withoutHashSegments))
    reject(`${at}: CPF completo não é aceito como identificador.`);
  return result;
}

function enumeration<T extends string>(
  value: unknown,
  allowed: readonly T[],
  at: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    reject(`${at}: valor não permitido.`);
  return value as T;
}

export function validInvestigationDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const year = Number(value.slice(0, 4));
  if (year < 1800 || year > 2200) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function date(value: unknown, at: string): string {
  if (!validInvestigationDate(value))
    reject(`${at}: use uma data de calendário válida AAAA-MM-DD.`);
  return value;
}

function nullableDate(value: unknown, at: string): string | null {
  return value === null ? null : date(value, at);
}

function timestamp(value: unknown, at: string): string {
  const str = text(value, at, 30);
  if (
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?Z$/.test(
      str,
    ) ||
    !validInvestigationDate(str.slice(0, 10)) ||
    !Number.isFinite(Date.parse(str))
  ) {
    reject(`${at}: instante UTC ISO 8601 inválido.`);
  }
  return str;
}

function cnpj(value: unknown, at: string): string {
  if (
    typeof value !== "string" ||
    !/^(?:[0-9A-Za-z]{12}\d{2}|[0-9A-Za-z]{2}\.[0-9A-Za-z]{3}\.[0-9A-Za-z]{3}\/[0-9A-Za-z]{4}-\d{2})$/.test(
      value.trim(),
    ) ||
    !isValidCnpj(value)
  )
    reject(`${at}: CNPJ inválido.`);
  return normalizeCnpj(value);
}

function list<T>(
  value: unknown,
  max: number,
  at: string,
  map: (x: unknown, at: string) => T,
): T[] {
  if (!Array.isArray(value) || value.length > max)
    reject(`${at}: lista obrigatória, máximo ${max} registros.`);
  return value.map((entry, i) => map(entry, `${at}[${i}]`));
}

function refs(value: unknown, at: string): string[] {
  const result = list(value, 20, at, id);
  if (new Set(result).size !== result.length)
    reject(`${at}: referências duplicadas.`);
  return result;
}

/** Metadata only. This URL is never fetched by the investigation import route. */
export function validateInvestigationSourceUrl(value: unknown): string | null {
  if (value === null) return null;
  const raw = text(value, "sourceUrl", 1200);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    reject("sourceUrl: URL inválida.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    reject("sourceUrl: somente URL pública HTTP(S), sem credenciais.");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipType = isIP(hostname);
  if (!hostname.includes(".") && !ipType)
    reject("sourceUrl: host público obrigatório.");
  if (/(^|\.)(localhost|local|internal|lan|test|invalid)$/.test(hostname))
    reject("sourceUrl: host local não permitido.");
  if (ipType === 6)
    reject("sourceUrl: use o nome público da fonte, não um endereço IPv6.");
  if (ipType === 4) {
    const [a, b] = hostname.split(".").map(Number);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    ) {
      reject("sourceUrl: endereço não público.");
    }
  }
  return url.href;
}

function interval(obj: Record<string, unknown>, at: string) {
  const validFrom = nullableDate(obj.validFrom, `${at}.validFrom`);
  const validThrough = nullableDate(obj.validThrough, `${at}.validThrough`);
  if (validFrom && validThrough && validFrom > validThrough)
    reject(`${at}: intervalo invertido.`);
  return {
    validFrom,
    validThrough,
    evidenceIds: refs(obj.evidenceIds, `${at}.evidenceIds`),
  };
}

export function validateInvestigationDataset(
  value: unknown,
): InvestigationDataset {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    reject("Dataset não serializável.");
  }
  if (
    typeof serialized !== "string" ||
    Buffer.byteLength(serialized) > MAX_INVESTIGATION_JSON_BYTES
  )
    reject("Dataset excede o limite de 512 KiB.");
  const o = strictObject(
    value,
    [
      "schemaVersion",
      "purpose",
      "legalBasis",
      "evidence",
      "companyEvents",
      "people",
      "corporateLinks",
      "publicRoles",
      "familyLinks",
      "competitions",
    ],
    "dataset",
  );
  const result: InvestigationDataset = {
    schemaVersion: enumeration(o.schemaVersion, ["1.0"], "schemaVersion"),
    purpose: text(o.purpose, "purpose", 800, 12),
    legalBasis: text(o.legalBasis, "legalBasis", 800, 12),
    evidence: list(o.evidence, 100, "evidence", (v, at) => {
      const x = strictObject(
        v,
        [
          "id",
          "sourceName",
          "sourceKind",
          "sourceUrl",
          "retrievedAt",
          "artifactSha256",
          "locator",
        ],
        at,
      );
      if (
        x.artifactSha256 !== null &&
        (typeof x.artifactSha256 !== "string" || !HASH.test(x.artifactSha256))
      )
        reject(`${at}: SHA-256 inválido.`);
      return {
        id: id(x.id, `${at}.id`),
        sourceName: text(x.sourceName, `${at}.sourceName`),
        sourceKind: enumeration(
          x.sourceKind,
          ["official", "intermediary", "analyst_document"],
          at,
        ),
        sourceUrl: validateInvestigationSourceUrl(x.sourceUrl),
        retrievedAt: timestamp(x.retrievedAt, `${at}.retrievedAt`),
        artifactSha256: x.artifactSha256 as string | null,
        locator: text(x.locator, `${at}.locator`, 500),
      };
    }),
    companyEvents: list(o.companyEvents, 200, "companyEvents", (v, at) => {
      const x = strictObject(
        v,
        ["id", "cnpj", "kind", "date", "evidenceIds"],
        at,
      );
      return {
        id: id(x.id, `${at}.id`),
        cnpj: cnpj(x.cnpj, at),
        kind: enumeration(
          x.kind,
          [
            "constitution",
            "cnpj_registration",
            "activity_start",
            "shareholder_change",
            "address_change",
            "cnae_change",
            "capital_change",
          ],
          at,
        ),
        date: date(x.date, at),
        evidenceIds: refs(x.evidenceIds, at),
      };
    }),
    people: list(o.people, 200, "people", (v, at) => {
      const x = strictObject(
        v,
        [
          "id",
          "name",
          "publicRecordId",
          "identityStatus",
          "identityEvidenceIds",
        ],
        at,
      );
      const name = text(x.name, `${at}.name`, 200);
      if (/[\d<>]/.test(name))
        reject(`${at}.name: use apenas o nome, sem identificadores pessoais.`);
      const publicRecordId = id(x.publicRecordId, `${at}.publicRecordId`);
      if (/cpf|^[a-f0-9]{32,64}$/i.test(publicRecordId))
        reject(
          `${at}.publicRecordId: use referência do registro público, não CPF ou hash de CPF.`,
        );
      return {
        id: id(x.id, `${at}.id`),
        name,
        publicRecordId,
        identityStatus: enumeration(
          x.identityStatus,
          ["unresolved", "documented"],
          at,
        ),
        identityEvidenceIds: refs(x.identityEvidenceIds, at),
      };
    }),
    corporateLinks: list(o.corporateLinks, 500, "corporateLinks", (v, at) => {
      const x = strictObject(
        v,
        [
          "id",
          "personId",
          "companyCnpj",
          "role",
          "validFrom",
          "validThrough",
          "evidenceIds",
        ],
        at,
      );
      return {
        id: id(x.id, at),
        personId: id(x.personId, at),
        companyCnpj: cnpj(x.companyCnpj, at),
        role: enumeration(
          x.role,
          ["shareholder", "administrator", "legal_representative"],
          at,
        ),
        ...interval(x, at),
      };
    }),
    publicRoles: list(o.publicRoles, 500, "publicRoles", (v, at) => {
      const x = strictObject(
        v,
        [
          "id",
          "personId",
          "entityId",
          "contractId",
          "role",
          "validFrom",
          "validThrough",
          "evidenceIds",
        ],
        at,
      );
      return {
        id: id(x.id, at),
        personId: id(x.personId, at),
        entityId: id(x.entityId, at),
        contractId: x.contractId === null ? null : id(x.contractId, at),
        role: enumeration(
          x.role,
          [
            "director",
            "procurement_agent",
            "contract_manager",
            "contract_inspector",
            "elected_other",
          ],
          at,
        ),
        ...interval(x, at),
      };
    }),
    familyLinks: list(o.familyLinks, 500, "familyLinks", (v, at) => {
      const x = strictObject(
        v,
        [
          "id",
          "personAId",
          "personBId",
          "relationship",
          "degree",
          "verification",
          "validFrom",
          "validThrough",
          "evidenceIds",
        ],
        at,
      );
      if (x.degree !== null && ![1, 2, 3].includes(x.degree as number))
        reject(`${at}.degree: grau explícito deve ser 1, 2, 3 ou null.`);
      const personAId = id(x.personAId, at),
        personBId = id(x.personBId, at);
      if (personAId === personBId)
        reject(`${at}: parentesco consigo próprio não permitido.`);
      return {
        id: id(x.id, at),
        personAId,
        personBId,
        relationship: enumeration(
          x.relationship,
          ["spouse", "partner", "consanguinity", "affinity"],
          at,
        ),
        degree: x.degree as 1 | 2 | 3 | null,
        verification: enumeration(
          x.verification,
          ["documented", "unverified"],
          at,
        ),
        ...interval(x, at),
      };
    }),
    competitions: list(o.competitions, 100, "competitions", (v, at) => {
      const x = strictObject(
        v,
        [
          "id",
          "contractId",
          "lotId",
          "eventDate",
          "bidderCnpjs",
          "evidenceIds",
        ],
        at,
      );
      const bidderCnpjs = list(x.bidderCnpjs, 100, `${at}.bidderCnpjs`, cnpj);
      if (new Set(bidderCnpjs).size !== bidderCnpjs.length)
        reject(`${at}: licitante repetido.`);
      return {
        id: id(x.id, at),
        contractId: id(x.contractId, at),
        lotId: id(x.lotId, at),
        eventDate: date(x.eventDate, at),
        bidderCnpjs,
        evidenceIds: refs(x.evidenceIds, at),
      };
    }),
  };
  const evidenceIds = new Set(result.evidence.map((e) => e.id));
  const personIds = new Set(result.people.map((p) => p.id));
  const allIds = [
    result.evidence,
    result.people,
    result.companyEvents,
    result.corporateLinks,
    result.publicRoles,
    result.familyLinks,
    result.competitions,
  ]
    .flat()
    .map((x) => x.id);
  if (new Set(allIds).size !== allIds.length)
    reject("IDs devem ser únicos em todo o dataset.");
  for (const item of [
    ...result.companyEvents,
    ...result.corporateLinks,
    ...result.publicRoles,
    ...result.familyLinks,
    ...result.competitions,
  ]) {
    if (item.evidenceIds.some((ref) => !evidenceIds.has(ref)))
      reject(`Registro ${item.id}: evidência referenciada não existe.`);
  }
  for (const p of result.people)
    if (p.identityEvidenceIds.some((ref) => !evidenceIds.has(ref)))
      reject(`Pessoa ${p.id}: evidência de identidade não existe.`);
  for (const link of [...result.corporateLinks, ...result.publicRoles])
    if (!personIds.has(link.personId))
      reject(`Vínculo ${link.id}: pessoa não existe.`);
  for (const link of result.familyLinks)
    if (!personIds.has(link.personAId) || !personIds.has(link.personBId))
      reject(`Vínculo ${link.id}: pessoa não existe.`);
  // Bound potential joins BEFORE persistence. Count actual person adjacencies,
  // not the Cartesian product of unrelated lists in a sparse investigation.
  const corporateCount = new Map<string, number>();
  const roleCount = new Map<string, number>();
  const companiesByPerson = new Map<string, Set<string>>();
  for (const link of result.corporateLinks) {
    corporateCount.set(
      link.personId,
      (corporateCount.get(link.personId) ?? 0) + 1,
    );
    const companies = companiesByPerson.get(link.personId) ?? new Set<string>();
    companies.add(link.companyCnpj);
    companiesByPerson.set(link.personId, companies);
  }
  for (const link of result.publicRoles)
    roleCount.set(link.personId, (roleCount.get(link.personId) ?? 0) + 1);
  let candidates = 0;
  for (const [person, count] of corporateCount)
    candidates += count * (roleCount.get(person) ?? 0);
  for (const link of result.familyLinks) {
    candidates +=
      (corporateCount.get(link.personAId) ?? 0) *
      (roleCount.get(link.personBId) ?? 0);
    candidates +=
      (corporateCount.get(link.personBId) ?? 0) *
      (roleCount.get(link.personAId) ?? 0);
  }
  for (const competition of result.competitions) {
    const bidders = new Set(competition.bidderCnpjs);
    for (const companies of companiesByPerson.values()) {
      let matched = 0;
      for (const company of companies) if (bidders.has(company)) matched++;
      candidates += (matched * (matched - 1)) / 2;
    }
  }
  if (candidates > 10_000)
    reject(
      "Dataset excede o orçamento de 10.000 caminhos candidatos. Divida a investigação em escopos menores e remova relações duplicadas.",
    );
  return result;
}

export function validateInvestigationSubmission(value: unknown) {
  const o = strictObject(
    value,
    ["dataset", "rationale", "expectedRevisionDigest"],
    "submission",
  );
  if (
    o.expectedRevisionDigest !== null &&
    (typeof o.expectedRevisionDigest !== "string" ||
      !HASH.test(o.expectedRevisionDigest))
  )
    reject("expectedRevisionDigest inválido.");
  return {
    dataset: validateInvestigationDataset(o.dataset),
    rationale: text(o.rationale, "rationale", 1500, 12),
    expectedRevisionDigest: o.expectedRevisionDigest as string | null,
  };
}

export function validateInvestigationReview(value: unknown) {
  const o = strictObject(
    value,
    ["findingId", "findingInputDigest", "action", "rationale"],
    "review",
  );
  if (
    typeof o.findingInputDigest !== "string" ||
    !HASH.test(o.findingInputDigest)
  )
    reject("findingInputDigest inválido.");
  return {
    findingId: id(o.findingId, "findingId"),
    findingInputDigest: o.findingInputDigest as string,
    action: enumeration(o.action, ["dismiss", "restore"], "action"),
    rationale: text(o.rationale, "rationale", 1500, 12),
  };
}

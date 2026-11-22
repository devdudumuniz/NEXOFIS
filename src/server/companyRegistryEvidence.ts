import { createHash } from "node:crypto";
import { isValidCnpj, normalizeCnpj } from "../lib/cnpj";
import type {
  CompanyEvent,
  CorporateLink,
  InvestigationEvidence,
  InvestigationPerson,
} from "../types/investigation";

export type RegistryEvidenceResult =
  | {
      status: "available";
      message: string;
      evidence: InvestigationEvidence;
      companyEvents: CompanyEvent[];
      people: InvestigationPerson[];
      corporateLinks: CorporateLink[];
      artifactBytes: Buffer;
      artifactFilename: string;
      originalPayloadSha256: string;
    }
  | {
      status: "unavailable" | "unsupported";
      message: string;
    };

const MAX_BYTES = 1024 * 1024;
const MAX_SHAREHOLDERS = 200;
const TIMEOUT_MS = 8_000;
const SOURCE_NAME = "BrasilAPI — provedor intermediário de dados cadastrais";
const DERIVATION =
  "EXTRATO DERIVADO MINIMIZADO. Campos selecionados de resposta da BrasilAPI; " +
  "CPF, contatos, endereço e representantes foram excluídos. O payload original não foi arquivado. " +
  "Seu hash é apenas referência de aquisição; não permite reconstrução ou autenticação do original. " +
  "Nomes no QSA não resolvem identidades; datas de entrada não comprovam permanência histórica.";

type JsonRecord = Record<string, unknown>;
type CorporateRole = CorporateLink["role"];

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedCnpj(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const input = value.trim();
  // Do not let the shared normalizer silently discard URL/control characters.
  if (
    !/^(?:[0-9A-Za-z]{12}\d{2}|[0-9A-Za-z]{2}\.[0-9A-Za-z]{3}\.[0-9A-Za-z]{3}\/[0-9A-Za-z]{4}-\d{2})$/.test(
      input,
    )
  )
    return null;
  return isValidCnpj(input) ? normalizeCnpj(input) : null;
}

function calendarDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? value
    : null;
}

function timestamp(value?: string): string | null {
  if (value === undefined) return new Date().toISOString();
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(
      value,
    )
  )
    return null;
  if (!calendarDate(value.slice(0, 10))) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function limitedText(value: unknown, limit: number): string | null {
  if (typeof value !== "string" || value.length > limit) return null;
  const text = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  if (!text) return null;
  // Some entrepreneurial names embed a CPF. Never copy it into the derived record.
  return text
    .replace(
      /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/g,
      "[identificador pessoal omitido]",
    )
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, "[contato omitido]");
}

function qualificationKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Deliberately narrow mappings. Unknown qualifications are retained in the extract
// but never upgraded to an ownership or management relationship.
const QUALIFICATIONS: ReadonlyArray<{
  code: number;
  label: string;
  roles: CorporateRole[];
}> = [
  { code: 5, label: "Administrador", roles: ["administrator"] },
  { code: 22, label: "Sócio", roles: ["shareholder"] },
  { code: 23, label: "Sócio Capitalista", roles: ["shareholder"] },
  { code: 24, label: "Sócio Comanditado", roles: ["shareholder"] },
  { code: 25, label: "Sócio Comanditário", roles: ["shareholder"] },
  { code: 26, label: "Sócio de Indústria", roles: ["shareholder"] },
  { code: 28, label: "Sócio-Gerente", roles: ["shareholder", "administrator"] },
  { code: 31, label: "Sócio Ostensivo", roles: ["shareholder"] },
  {
    code: 47,
    label: "Sócio Pessoa Física Residente no Brasil",
    roles: ["shareholder"],
  },
  {
    code: 49,
    label: "Sócio-Administrador",
    roles: ["shareholder", "administrator"],
  },
  { code: 52, label: "Sócio com Capital", roles: ["shareholder"] },
  { code: 53, label: "Sócio sem Capital", roles: ["shareholder"] },
  {
    code: 70,
    label: "Administrador Residente ou Domiciliado no Exterior",
    roles: ["administrator"],
  },
  {
    code: 74,
    label: "Sócio-Administrador Residente ou Domiciliado no Exterior",
    roles: ["shareholder", "administrator"],
  },
];

function qualification(row: JsonRecord): {
  label: string | null;
  roles: CorporateRole[];
} {
  const label = limitedText(row.qualificacao_socio, 160);
  const code = row.codigo_qualificacao_socio;
  const byLabel = label
    ? QUALIFICATIONS.find(
        (item) => qualificationKey(item.label) === qualificationKey(label),
      )
    : undefined;
  const byCode = Number.isInteger(code)
    ? QUALIFICATIONS.find((item) => item.code === code)
    : undefined;
  if (
    code !== undefined &&
    code !== null &&
    (!byCode || (label !== null && byLabel?.code !== byCode.code))
  ) {
    return { label, roles: [] };
  }
  if (byCode)
    return {
      label: label ?? `${byCode.label} (código ${byCode.code})`,
      roles: byCode.roles,
    };
  return { label, roles: byLabel?.roles ?? [] };
}

async function boundedBody(response: Response): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BYTES)
  ) {
    await response.body?.cancel();
    throw new Error("RESPONSE_SIZE_LIMIT");
  }
  if (!response.body) throw new Error("EMPTY_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error("RESPONSE_SIZE_LIMIT");
      }
      chunks.push(Buffer.from(value));
    }
    if (!total) throw new Error("EMPTY_RESPONSE");
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Retrieves only the fixed BrasilAPI endpoint and returns a private, minimized
 * derived artifact. It never persists/logs the response, infers family ties,
 * merges people by name, or marks an intermediary as an official source.
 * Schema reference: https://github.com/BrasilAPI/BrasilAPI/blob/main/pages/docs/doc/cnpj.json
 */
export async function fetchCompanyRegistryEvidence(
  rawCnpj: string,
  options: { fetchImpl?: typeof fetch; now?: string } = {},
): Promise<RegistryEvidenceResult> {
  const cnpj = normalizedCnpj(rawCnpj);
  if (!cnpj)
    return {
      status: "unavailable",
      message: "CNPJ inválido: formato ou dígitos verificadores não conferem.",
    };
  const retrievedAt = timestamp(options.now);
  if (!retrievedAt)
    return {
      status: "unavailable",
      message: "Instante de aquisição inválido.",
    };
  const sourceUrl = `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(sourceUrl, {
      signal,
      redirect: "error",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        status: response.status === 501 ? "unsupported" : "unavailable",
        message:
          response.status === 429
            ? "BrasilAPI limitou a consulta. Cobertura cadastral indisponível nesta tentativa."
            : `BrasilAPI não forneceu um cadastro verificável nesta tentativa (HTTP ${response.status}).`,
      };
    }
    if (response.redirected || (response.url && response.url !== sourceUrl)) {
      await response.body?.cancel();
      return {
        status: "unavailable",
        message: "Origem da resposta cadastral divergente.",
      };
    }
    if (
      !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      await response.body?.cancel();
      return {
        status: "unavailable",
        message: "Formato da resposta cadastral não reconhecido.",
      };
    }
    const originalBytes = await boundedBody(response);
    const originalPayloadSha256 = sha256(originalBytes);
    const payload: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(originalBytes),
    );
    if (!record(payload) || normalizedCnpj(payload.cnpj) !== cnpj) {
      return {
        status: "unavailable",
        message: "CNPJ da resposta não corresponde exatamente ao consultado.",
      };
    }
    const legalName = limitedText(payload.razao_social, 240);
    if (!legalName)
      return {
        status: "unavailable",
        message: "Identificação empresarial ausente ou inválida na resposta.",
      };
    if (payload.qsa != null && !Array.isArray(payload.qsa)) {
      return {
        status: "unavailable",
        message: "Estrutura do QSA divergente; nenhuma relação foi importada.",
      };
    }
    const qsa = (payload.qsa ?? []) as unknown[];
    if (qsa.length > MAX_SHAREHOLDERS || qsa.some((row) => !record(row))) {
      return {
        status: "unavailable",
        message:
          "QSA excede o limite de 200 registros ou contém estrutura inválida; consulta não importada.",
      };
    }
    const activityStartDate = calendarDate(payload.data_inicio_atividade);
    const shareholders = qsa.map((value, index) => {
      const row = value as JsonRecord;
      const name = limitedText(row.nome_socio, 180);
      const role = qualification(row);
      return {
        index,
        name,
        role,
        entryDate: calendarDate(row.data_entrada_sociedade),
        isPerson: row.identificador_de_socio === 2,
      };
    });
    if (shareholders.some((row) => !row.name)) {
      return {
        status: "unavailable",
        message: "QSA contém nome ausente ou inválido; consulta não importada.",
      };
    }
    const artifactBytes = Buffer.from(
      JSON.stringify(
        {
          schema: "nexofis.registry-derived-extract/1.0",
          sourceUrl,
          retrievedAt,
          sourcePayloadSha256: originalPayloadSha256,
          derivation: DERIVATION,
          cnpj,
          legalName,
          activityStartDate,
          shareholders: shareholders.map(({ name, role, entryDate }) => ({
            name,
            role: role.label,
            entryDate,
          })),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    const artifactSha256 = sha256(artifactBytes);
    const snapshotId = `${cnpj}:${artifactSha256.slice(0, 32)}`;
    const evidence: InvestigationEvidence = {
      id: `registry:evidence:${snapshotId}`,
      sourceName: SOURCE_NAME,
      sourceKind: "intermediary",
      sourceUrl,
      retrievedAt,
      artifactSha256,
      locator: DERIVATION,
    };
    const companyEvents: CompanyEvent[] = activityStartDate
      ? [
          {
            id: `registry:activity:${snapshotId}`,
            cnpj,
            kind: "activity_start",
            date: activityStartDate,
            evidenceIds: [evidence.id],
          },
        ]
      : [];
    const people: InvestigationPerson[] = [];
    const corporateLinks: CorporateLink[] = [];
    for (const row of shareholders) {
      // A QSA entry may be a company or an unclassified foreign entity. Do not
      // turn either into a natural person or use it in a family comparison.
      if (!row.isPerson) continue;
      const personId = `registry:person:${snapshotId}:${row.index}`;
      people.push({
        id: personId,
        name: row.name!,
        publicRecordId: `registry:qsa:${snapshotId}:${row.index}`,
        identityStatus: "unresolved",
        identityEvidenceIds: [evidence.id],
      });
      for (const role of row.role.roles) {
        corporateLinks.push({
          id: `registry:link:${snapshotId}:${row.index}:${role}`,
          personId,
          companyCnpj: cnpj,
          role,
          validFrom: row.entryDate,
          validThrough: null,
          evidenceIds: [evidence.id],
        });
      }
    }
    return {
      status: "available",
      message:
        "Extrato minimizado obtido via BrasilAPI (fonte intermediária). " +
        "O original não foi arquivado; identidades e continuidade histórica dos vínculos permanecem não verificadas." +
        (activityStartDate
          ? ""
          : " Data de início da atividade ausente ou inválida.") +
        (payload.qsa == null ? " QSA não fornecido pela fonte." : ""),
      evidence,
      companyEvents,
      people,
      corporateLinks,
      artifactBytes,
      artifactFilename: `registry-${cnpj}-${artifactSha256.slice(0, 16)}.json`,
      originalPayloadSha256,
    };
  } catch {
    // Never return an upstream error/body, which may contain personal fields.
    return {
      status: "unavailable",
      message:
        "Consulta cadastral não concluída: prazo, conexão, tamanho ou formato da resposta inválido.",
    };
  }
}

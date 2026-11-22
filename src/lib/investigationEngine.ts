import type { ContractRecord } from "../types/audit";
import type {
  CompanyEvent,
  CorporateLink,
  DocumentedInterval,
  InvestigationEngineInput,
  InvestigationEvidence,
  InvestigationFinding,
  InvestigationPerson,
  InvestigationReport,
  PublicRoleLink,
} from "../types/investigation";
import { isValidCnpj, normalizeCnpj } from "./cnpj";
import { sha256HexSync } from "./hash";

export const INVESTIGATION_ENGINE_VERSION = "investigation-1.0.1";
// Bound joins before expanding them. A skipped rule is explicitly unverifiable;
// a partial result must never look like an exhaustive relationship analysis.
export const INVESTIGATION_RELATION_JOIN_LIMIT = 1000;
export const INVESTIGATION_COMPETITION_LINK_LIMIT = 2000;
const DAY_MS = 86_400_000;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const RULE_LIMITATION =
  "Ponto de triagem para revisão humana; não determina fraude, parentesco por inferência ou responsabilidade penal.";
const RELATION_LIMITATION =
  "Vínculos são declarações documentadas do caso. Bytes preservados não autenticam a veracidade do documento. Confirmar o regime jurídico e as atribuições antes de avaliar eventual impedimento.";

/** Stable JSON keys; array order is preserved (no claim of RFC 8785 conformance). */
export function stableInvestigationJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map(stableInvestigationJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableInvestigationJson(obj[key])}`)
    .join(",")}}`;
}

/** Calendar-date arithmetic. Rejects rollover, timestamps, impossible days and years below 1900. */
export function strictDateDays(value: string): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (
    year < 1900 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  )
    return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return date.getTime() / DAY_MS;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
function sorted<T>(values: T[]): T[] {
  return [...values].sort((a, b) =>
    stableInvestigationJson(a).localeCompare(stableInvestigationJson(b)),
  );
}
function digest(value: unknown): string {
  return sha256HexSync(stableInvestigationJson(value));
}
function indexBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    const group = index.get(value);
    if (group) group.push(item);
    else index.set(value, [item]);
  }
  return index;
}
function contractKey(c: ContractRecord): string {
  return c.pncpControlNumber?.trim()
    ? `pncp:${c.pncpControlNumber.trim()}`
    : `local:${c.id}`;
}
function intervalStatus(
  link: DocumentedInterval,
  day: number | null,
): "active" | "inactive" | "unknown" {
  const from = link.validFrom ? strictDateDays(link.validFrom) : null;
  const through = link.validThrough ? strictDateDays(link.validThrough) : null;
  if (day === null || from === null || through === null || from > through)
    return "unknown";
  return day >= from && day <= through ? "active" : "inactive";
}
function roleInSubject(role: PublicRoleLink, subject: ContractRecord): boolean {
  if (
    !subject.entityId?.trim() ||
    role.entityId !== subject.entityId ||
    role.role === "elected_other"
  )
    return false;
  return role.role === "director"
    ? role.contractId === null || role.contractId === subject.id
    : role.contractId === subject.id;
}

type FindingOptions = Omit<
  InvestigationFinding,
  "id" | "ruleVersion" | "inputDigest"
> & { inputs: unknown };
const DATE_LABELS: Record<CompanyEvent["kind"], string> = {
  constitution: "constituição declarada da pessoa jurídica",
  cnpj_registration: "inscrição do estabelecimento no CNPJ",
  activity_start: "início de atividade cadastral do estabelecimento",
  shareholder_change: "alteração societária",
  address_change: "alteração de endereço empresarial",
  cnae_change: "alteração de CNAE",
  capital_change: "alteração de capital social",
};

export function evaluateInvestigation(
  input: InvestigationEngineInput,
): InvestigationReport {
  const { subject, dataset } = input;
  const supplierCnpj = normalizeCnpj(subject.supplier.cnpj);
  const validSupplier = isValidCnpj(supplierCnpj);
  const signatureDayRaw = strictDateDays(subject.signatureDate);
  const evaluationDay = strictDateDays(input.evaluatedAt.slice(0, 10));
  const signatureDay =
    signatureDayRaw !== null &&
    evaluationDay !== null &&
    signatureDayRaw <= evaluationDay
      ? signatureDayRaw
      : null;
  const verifiedHashes = new Set(
    input.verifiedArtifactHashes
      .filter((h) => SHA256_RE.test(h))
      .map((h) => h.toLowerCase()),
  );
  const evidence = [...(dataset?.evidence ?? [])];
  const evidenceCounts = new Map<string, number>();
  const evidenceById = new Map<string, InvestigationEvidence>();
  for (const item of evidence) {
    evidenceCounts.set(item.id, (evidenceCounts.get(item.id) ?? 0) + 1);
    evidenceById.set(item.id, item);
  }
  const retained = (ids: string[]): boolean =>
    ids.length > 0 &&
    ids.every((id) => {
      const item = evidenceById.get(id);
      return (
        evidenceCounts.get(id) === 1 &&
        !!item?.artifactSha256 &&
        SHA256_RE.test(item.artifactSha256) &&
        verifiedHashes.has(item.artifactSha256.toLowerCase())
      );
    });
  const evidenceInputs = (ids: string[]) =>
    unique(ids).map((id) => ({
      id,
      source: evidenceById.get(id) ?? null,
      retained: retained([id]),
    }));
  const registerGeneratedEvidence = (
    item: Omit<InvestigationEvidence, "id">,
  ): string => {
    let id = `generated:${digest(item).slice(0, 24)}`;
    while (
      evidenceById.has(id) &&
      stableInvestigationJson(evidenceById.get(id)) !==
        stableInvestigationJson({ id, ...item })
    )
      id += ":derived";
    if (!evidenceById.has(id)) {
      const registered = { id, ...item };
      evidence.push(registered);
      evidenceById.set(id, registered);
      evidenceCounts.set(id, 1);
    }
    return id;
  };
  const contractSourceEvidence = (c: ContractRecord): string[] => {
    const ids = c.sourceRecords.map((s) =>
      registerGeneratedEvidence({
        sourceName: s.sourceSystem,
        sourceKind:
          s.sourceSystem === "PDF Importado" ? "analyst_document" : "official",
        sourceUrl: s.sourceUrl || null,
        retrievedAt: s.retrievedAt || "",
        artifactSha256:
          s.rawPayloadHash && SHA256_RE.test(s.rawPayloadHash)
            ? s.rawPayloadHash.toLowerCase()
            : null,
        locator: `Contrato ${c.id}; registro externo ${s.externalId}; campos de fornecedor, valor e data conforme índice.`,
      }),
    );
    for (const d of c.documents.filter(
      (d) => d.documentType === "Contrato Original",
    ))
      ids.push(
        registerGeneratedEvidence({
          sourceName: d.sourceSystem,
          sourceKind: d.sourceSystem.includes("Import")
            ? "analyst_document"
            : "official",
          sourceUrl: d.sourceUrl || null,
          retrievedAt: d.retrievedAt || "",
          artifactSha256: SHA256_RE.test(d.sha256)
            ? d.sha256.toLowerCase()
            : null,
          locator: `Contrato ${c.id}; documento ${d.id}: ${d.title}. Conferir a página de assinatura.`,
        }),
      );
    return unique(ids);
  };
  const subjectEvidence = contractSourceEvidence(subject);
  const findings: InvestigationFinding[] = [];
  const timeline: InvestigationReport["timeline"] = [];
  const nodes = new Map<
    string,
    InvestigationReport["graph"]["nodes"][number]
  >();
  const edges = new Map<
    string,
    InvestigationReport["graph"]["edges"][number]
  >();
  const limitations = new Set<string>([
    RULE_LIMITATION,
    "Contagens e concentração referem-se apenas aos contratos observados, ao CNPJ exato e à cobertura informada; não representam todos os clientes, faturamento ou a ausência nacional de outros contratos.",
    "Nome, sobrenome, CPF mascarado, endereço compartilhado ou condição de PEP não confirmam identidade, parentesco, empresa fictícia ou ilícito.",
    "Datas cadastrais possuem significados distintos. Uma filial recente não demonstra que a pessoa jurídica ou seu grupo econômico seja recente.",
    "O grafo é uma representação dos registros do caso, não uma certificação de parentesco ou uma validação automática do art. 14 da Lei 14.133/2021.",
    "Verificação SHA-256 confirma correspondência de bytes com o acervo informado; não substitui autenticação documental, perícia ou os procedimentos de cadeia de custódia da autoridade competente.",
  ]);
  if (!validSupplier)
    limitations.add(
      "CNPJ do fornecedor inválido ou ausente: a associação cadastral e o universo de contratos não são verificáveis.",
    );
  if (signatureDay === null)
    limitations.add(
      "Data de assinatura ausente, inválida, futura ou data de avaliação inválida; não foi substituída pela data de publicação ou de início de vigência.",
    );
  if (
    !input.coverage.length ||
    input.coverage.some((c) => c.status !== "complete_in_source")
  ) {
    limitations.add(
      "Cobertura parcial, indisponível ou não consultada. Ausência de registros não é evidência de ausência de contratos ou de vínculos.",
    );
  }

  const add = ({ inputs, ...options }: FindingOptions): void => {
    const targetIds = unique(options.targetIds);
    findings.push({
      ...options,
      targetIds,
      evidenceIds: unique(options.evidenceIds),
      id: `INV-${digest({ contractId: subject.id, rule: options.ruleCode, targets: targetIds }).slice(0, 24)}`,
      ruleVersion: INVESTIGATION_ENGINE_VERSION,
      inputDigest: digest({
        ruleVersion: INVESTIGATION_ENGINE_VERSION,
        rule: options.ruleCode,
        inputs,
        state: options.state,
        evidence: evidenceInputs(options.evidenceIds),
      }),
    });
  };
  const check = (
    ruleCode: string,
    title: string,
    statement: string,
    targetIds: string[],
    inputs: unknown,
    evidenceIds: string[] = [],
    state: InvestigationFinding["state"] = "NOT_VERIFIABLE",
  ): void =>
    add({
      ruleCode,
      title,
      statement,
      targetIds,
      inputs,
      evidenceIds,
      state,
      priority: "context",
      calculation:
        "Não há cálculo conclusivo disponível para esta verificação.",
      alternativeHypotheses: [
        "Informação ausente, cadastro não atualizado ou documentação incompleta.",
      ],
      nextSteps: [
        "Obter a fonte original pertinente, confirmar as identidades e revisar o contexto temporal.",
      ],
      limitation: RULE_LIMITATION,
    });
  const node = (
    id: string,
    kind: InvestigationReport["graph"]["nodes"][number]["kind"],
    label: string,
  ) => nodes.set(id, { id, kind, label });
  const edge = (
    id: string,
    from: string,
    to: string,
    kind: string,
    status: "documented" | "unresolved",
    ids: string[],
  ) => edges.set(id, { id, from, to, kind, status, evidenceIds: unique(ids) });
  const companyNode = `company:${supplierCnpj || "unknown"}`;
  const contractNode = `contract:${subject.id}`;
  const bodyNode = `public_body:${subject.entityId || subject.id}`;
  node(
    companyNode,
    "company",
    subject.supplier.legalName || "Fornecedor não identificado",
  );
  node(
    contractNode,
    "contract",
    `Contrato ${subject.contractNumber || subject.id}`,
  );
  node(bodyNode, "public_body", subject.entityName || "Órgão não identificado");
  edge(
    "subject:supplier",
    contractNode,
    companyNode,
    "FORNECEDOR_DECLARADO_NO_CONTRATO",
    "unresolved",
    subjectEvidence,
  );
  edge(
    "subject:buyer",
    bodyNode,
    contractNode,
    "CONTRATANTE_DECLARADO",
    "unresolved",
    subjectEvidence,
  );
  if (signatureDay !== null)
    timeline.push({
      id: `signature:${subject.id}`,
      date: subject.signatureDate,
      label: "Assinatura informada do contrato; confirmar instrumento original",
      evidenceIds: subjectEvidence,
    });

  // Corporate dates are never interchangeable, and current QSA is not historical QSA.
  const events = (dataset?.companyEvents ?? []).filter(
    (e) => validSupplier && normalizeCnpj(e.cnpj) === supplierCnpj,
  );
  if (
    validSupplier &&
    subject.supplier.openingDate &&
    !events.some((e) => e.kind === "activity_start")
  ) {
    const source: Omit<InvestigationEvidence, "id"> = {
      sourceName:
        subject.supplier.dataProvenance ||
        "Cadastro no índice local; origem não registrada",
      sourceKind: "intermediary",
      sourceUrl: null,
      retrievedAt: "",
      artifactSha256: null,
      locator:
        "supplier.openingDate: início de atividade declarado; significado legado e original não comprovados",
    };
    const id = registerGeneratedEvidence(source);
    events.push({
      id,
      cnpj: supplierCnpj,
      kind: "activity_start",
      date: subject.supplier.openingDate,
      evidenceIds: [id],
    });
    limitations.add(
      "A data legada supplier.openingDate foi tratada como início de atividade declarado. Confirmar o significado no cadastro de origem; ela não prova constituição da pessoa jurídica.",
    );
  }
  let daysFromActivityStart: number | null = null;
  const originKinds = [
    "constitution",
    "cnpj_registration",
    "activity_start",
  ] as const;
  let hadOrigin = false;
  for (const kind of originKinds) {
    const candidates = sorted(events.filter((e) => e.kind === kind));
    if (!candidates.length) continue;
    hadOrigin = true;
    const targets = [`company:${supplierCnpj}`, kind];
    const corporateDateIds = unique(candidates.flatMap((e) => e.evidenceIds));
    const ids = unique([...corporateDateIds, ...subjectEvidence]);
    const dates = unique(candidates.map((e) => e.date));
    const dateDay = dates.length === 1 ? strictDateDays(dates[0]) : null;
    if (
      dates.length !== 1 ||
      dateDay === null ||
      signatureDay === null ||
      evaluationDay === null ||
      dateDay > evaluationDay
    ) {
      check(
        "INV-TIME-002",
        "Cronologia empresarial não verificável",
        dates.length > 1
          ? `Fontes apresentam datas conflitantes para ${DATE_LABELS[kind]}; não foi escolhida uma data silenciosamente.`
          : "A data empresarial ou de assinatura é ausente, inválida ou futura; não se calcula idade por aproximação.",
        targets,
        { candidates, signatureDate: subject.signatureDate },
        ids,
      );
      continue;
    }
    const days = signatureDay - dateDay;
    if (kind === "activity_start") daysFromActivityStart = days;
    timeline.push({
      id: `company-date:${kind}`,
      date: dates[0],
      label: DATE_LABELS[kind],
      evidenceIds: ids,
    });
    const proofNote = retained(corporateDateIds)
      ? "Há documento preservado para a data empresarial declarada; revisar sua autenticidade e o significado do campo. Conferir também a assinatura no instrumento contratual."
      : "A data consta nos dados declarados; a fonte original dessa data ainda não foi preservada e verificada.";
    const branchNote =
      supplierCnpj.slice(8, 12) !== "0001"
        ? " O estabelecimento não usa a sequência 0001; não foi inferida a idade da matriz ou da pessoa jurídica."
        : "";
    if (days < 0) {
      add({
        ruleCode: "INV-TIME-001",
        title: "Assinatura anterior à data empresarial informada",
        state: "OBSERVATION",
        priority: "medium",
        statement: `A assinatura antecede ${DATE_LABELS[kind]} em ${-days} dia(s).${branchNote}`,
        calculation: `${subject.signatureDate} − ${dates[0]} = ${days} dias`,
        targetIds: targets,
        evidenceIds: ids,
        inputs: {
          candidates,
          signatureDate: subject.signatureDate,
          companyCnpj: supplierCnpj,
        },
        alternativeHypotheses: [
          "Erro de transcrição ou de identificação do estabelecimento.",
          "Inscrição posterior à constituição; sucessão ou alteração cadastral.",
          "Data contratual extraída incorretamente.",
        ],
        nextSteps: [
          "Conferir contrato assinado e histórico cadastral original.",
          "Verificar matriz, filial, sucessão e a natureza exata de cada data.",
        ],
        limitation: `${proofNote} ${RULE_LIMITATION}`,
      });
    } else if (days <= 90) {
      const band =
        days <= 1
          ? days === 0
            ? "mesmo dia"
            : "dia seguinte"
          : days <= 30
            ? "até 30 dias"
            : "de 31 a 90 dias";
      add({
        ruleCode: "INV-TIME-002",
        title: `Contratação no ${band === "mesmo dia" || band === "dia seguinte" ? band : `intervalo ${band}`}`,
        state: "OBSERVATION",
        priority: days <= 1 ? "high" : "medium",
        statement: `A assinatura ocorreu ${days} dia(s) após ${DATE_LABELS[kind]}.${branchNote}`,
        calculation: `${subject.signatureDate} − ${dates[0]} = ${days} dias; faixa heurística: ${band}`,
        targetIds: targets,
        evidenceIds: ids,
        inputs: {
          candidates,
          signatureDate: subject.signatureDate,
          companyCnpj: supplierCnpj,
        },
        alternativeHypotheses: [
          "Empresa nova regularmente habilitada; o art. 65, § 1º, da Lei 14.133/2021 admite empresas criadas no exercício.",
          "Filial ou reorganização de empresa preexistente.",
          "Cadastro de início de atividade distinto da constituição.",
        ],
        nextSteps: [
          "Conferir habilitação, capacidade técnica e balanço de abertura.",
          "Comparar datas de edital, proposta, habilitação e assinatura com fontes originais.",
        ],
        limitation: `As faixas de 1/30/90 dias são heurísticas de triagem, não prazos de proibição legal. ${proofNote} ${RULE_LIMITATION}`,
      });
    } else {
      check(
        "INV-TIME-002",
        "Data empresarial fora da janela de proximidade",
        `${days} dias separam ${DATE_LABELS[kind]} da assinatura. Isso não demonstra regularidade de outras dimensões.`,
        targets,
        { candidates, signatureDate: subject.signatureDate },
        ids,
        "NOT_APPLICABLE",
      );
    }
  }
  if (!hadOrigin)
    check(
      "INV-TIME-002",
      "Data empresarial não disponível",
      "Não há data de constituição, inscrição ou início de atividade utilizável para o CNPJ exato.",
      ["company-date"],
      { supplierCnpj },
    );
  const changes = events.filter(
    (e) => !originKinds.includes(e.kind as (typeof originKinds)[number]),
  );
  for (const change of sorted(changes)) {
    const day = strictDateDays(change.date);
    const delta =
      signatureDay !== null && day !== null ? signatureDay - day : null;
    if (
      delta === null ||
      evaluationDay === null ||
      day! > evaluationDay ||
      !retained(change.evidenceIds)
    ) {
      check(
        "INV-CHANGE-001",
        "Alteração cadastral depende de comprovação",
        "Data ou fonte original da alteração não está verificada. Uma fotografia do cadastro atual não comprova uma alteração histórica.",
        [change.id],
        { change, signatureDate: subject.signatureDate },
        change.evidenceIds,
      );
    } else {
      timeline.push({
        id: `change:${change.id}`,
        date: change.date,
        label: DATE_LABELS[change.kind],
        evidenceIds: change.evidenceIds,
      });
      if (delta >= 0 && delta <= 30)
        add({
          ruleCode: "INV-CHANGE-001",
          title: "Alteração cadastral próxima à assinatura",
          state: "OBSERVATION",
          priority: "medium",
          statement: `${DATE_LABELS[change.kind]} registrada ${delta} dia(s) antes da assinatura.`,
          calculation: `${subject.signatureDate} − ${change.date} = ${delta} dias; janela heurística de 0 a 30 dias`,
          targetIds: [change.id],
          evidenceIds: change.evidenceIds,
          inputs: { change, signatureDate: subject.signatureDate },
          alternativeHypotheses: [
            "Reorganização legítima ou adaptação operacional.",
            "Atualização cadastral atrasada ou retificação.",
          ],
          nextSteps: [
            "Obter os atos anteriores e posteriores à alteração.",
            "Verificar capacidade de execução e eventual relação com a contratação.",
          ],
          limitation: RULE_LIMITATION,
        });
    }
  }
  if (!changes.length)
    check(
      "INV-CHANGE-001",
      "Histórico de alterações não disponível",
      "Não foram fornecidos atos históricos de alterações societárias, CNAE, capital ou endereço.",
      ["company-changes"],
      { supplierCnpj },
    );

  // Only exact supplier roles are counted; a matching query term is not proof of that role.
  const grouped = new Map<string, ContractRecord[]>();
  let excluded = 0;
  let implicitSubjectRole = false;
  for (const c of sorted([subject, ...input.portfolio])) {
    const exact =
      validSupplier && normalizeCnpj(c.supplier.cnpj) === supplierCnpj;
    const sourcedSupplier = c.sourceRecords.some(
      (s) => normalizeCnpj(s.reportedSupplierCnpj) === supplierCnpj,
    );
    const acceptedRole =
      c.cnpjRole === "fornecedor" ||
      (c.cnpjRole === undefined && (sourcedSupplier || c.id === subject.id));
    if (!exact || !acceptedRole) {
      excluded++;
      continue;
    }
    if (c.cnpjRole === undefined && !sourcedSupplier && c.id === subject.id)
      implicitSubjectRole = true;
    const key = contractKey(c);
    grouped.set(key, [...(grouped.get(key) ?? []), c]);
  }
  if (implicitSubjectRole)
    limitations.add(
      "O contrato-alvo declara este CNPJ no campo fornecedor, mas não há classificação independente de papel; a contagem o inclui como vínculo informado no contrato-alvo.",
    );
  const observed: ContractRecord[] = [];
  let conflictingPortfolio = false;
  let conflictingPortfolioDates = false;
  for (const group of grouped.values()) {
    observed.push(group[0]);
    excluded += group.length - 1;
    if (
      unique(
        group.map((c) =>
          stableInvestigationJson([
            c.entityId,
            c.updatedValue,
            c.signatureDate,
          ]),
        ),
      ).length > 1
    )
      conflictingPortfolio = true;
    if (unique(group.map((c) => c.signatureDate)).length > 1)
      conflictingPortfolioDates = true;
  }
  const observedPriorContractCount =
    signatureDay !== null &&
    observed.length > 0 &&
    !conflictingPortfolioDates &&
    observed.every((c) => {
      const d = strictDateDays(c.signatureDate);
      return d !== null && evaluationDay !== null && d <= evaluationDay;
    })
      ? observed.filter(
          (c) =>
            contractKey(c) !== contractKey(subject) &&
            strictDateDays(c.signatureDate)! < signatureDay,
        ).length
      : null;
  const observedBuyerCount = new Set(
    observed.map((c) => c.entityId).filter((id) => id?.trim()),
  ).size;
  const portfolioEvidenceIds = unique(observed.flatMap(contractSourceEvidence));
  const historyInputs = {
    supplierCnpj,
    records: observed.map((c) => ({
      key: contractKey(c),
      entityId: c.entityId,
      value: c.updatedValue,
      date: c.signatureDate,
    })),
    coverage: sorted(input.coverage),
  };
  if (observed.length === 1)
    add({
      ruleCode: "INV-HISTORY-001",
      title: "Um contrato localizado no universo observado",
      state: "OBSERVATION",
      priority: "context",
      statement:
        "Foi localizado 1 contrato do CNPJ exato no índice e nas fontes declaradas. Isso não demonstra que a empresa tenha apenas um contrato, um cliente ou nenhuma atividade privada.",
      calculation:
        "Contagem de identificadores contratuais deduplicados = 1; matriz e filiais não foram fundidas.",
      targetIds: ["observed-portfolio"],
      evidenceIds: portfolioEvidenceIds,
      inputs: historyInputs,
      alternativeHypotheses: [
        "Fornecedor novo no mercado público.",
        "Contratos privados, antigos ou publicados fora das fontes consultadas.",
        "Consulta parcial, indisponibilidade ou indexação incompleta.",
      ],
      nextSteps: [
        "Expandir fontes e período; registrar consultas e falhas.",
        "Examinar capacidade de entrega com documentos objetivos, sem presumir empresa fictícia.",
      ],
      limitation: RULE_LIMITATION,
    });
  else
    check(
      "INV-HISTORY-001",
      observed.length
        ? "Mais de um contrato observado"
        : "Histórico contratual não verificável",
      `${observed.length} contrato(s) do CNPJ exato localizado(s) no universo observado; não é uma contagem nacional exaustiva.`,
      ["observed-portfolio"],
      historyInputs,
      portfolioEvidenceIds,
      observed.length > 1 ? "NOT_APPLICABLE" : "NOT_VERIFIABLE",
    );
  const usableValues =
    observed.length >= 3 &&
    !conflictingPortfolio &&
    !!subject.entityId?.trim() &&
    observed.every(
      (c) =>
        Number.isFinite(c.updatedValue) &&
        c.updatedValue > 0 &&
        !!c.entityId?.trim(),
    );
  const totalValue = usableValues
    ? observed.reduce((sum, c) => sum + c.updatedValue, 0)
    : 0;
  const sameBuyerValue = usableValues
    ? observed
        .filter((c) => c.entityId === subject.entityId)
        .reduce((sum, c) => sum + c.updatedValue, 0)
    : 0;
  const share =
    usableValues &&
    Number.isFinite(totalValue) &&
    totalValue > 0 &&
    Number.isFinite(sameBuyerValue)
      ? (sameBuyerValue / totalValue) * 100
      : null;
  if (share !== null && share >= 80)
    add({
      ruleCode: "INV-CONCENTRATION-001",
      title: "Concentração observada no mesmo órgão",
      state: "OBSERVATION",
      priority: "context",
      statement: `${share.toFixed(2)}% do valor contratual observado deste CNPJ está no órgão contratante, em ${observed.length} contratos deduplicados.`,
      calculation: `${sameBuyerValue} / ${totalValue} × 100 = ${share.toFixed(2)}%; limiar heurístico de 80%; não corresponde a faturamento ou pagamentos.`,
      targetIds: ["observed-portfolio", subject.entityId],
      evidenceIds: portfolioEvidenceIds,
      inputs: historyInputs,
      alternativeHypotheses: [
        "Especialização regional, lote de contratos ou estratégia comercial legítima.",
        "Cobertura das fontes concentrada nesse órgão.",
      ],
      nextSteps: [
        "Ampliar a cobertura de outros órgãos e períodos.",
        "Comparar contratos, execução e pagamentos sem somar seus estágios financeiros.",
      ],
      limitation: RULE_LIMITATION,
    });
  else
    check(
      "INV-CONCENTRATION-001",
      "Concentração no universo observado",
      share === null
        ? "São necessários pelo menos 3 contratos deduplicados, órgãos identificados e valores positivos, finitos e sem divergências entre espelhos."
        : `Participação observada de ${share.toFixed(2)}%, abaixo do limiar heurístico de 80%.`,
      ["observed-portfolio", subject.entityId],
      historyInputs,
      portfolioEvidenceIds,
      share === null ? "NOT_VERIFIABLE" : "NOT_APPLICABLE",
    );

  const people = new Map<string, InvestigationPerson>();
  const duplicatePeople = new Set<string>();
  for (const person of dataset?.people ?? []) {
    if (people.has(person.id)) duplicatePeople.add(person.id);
    people.set(person.id, person);
  }
  const identityReady = (personId: string): boolean => {
    const p = people.get(personId);
    return (
      !!p &&
      !duplicatePeople.has(personId) &&
      !!p.publicRecordId?.trim() &&
      p.identityStatus === "documented" &&
      retained(p.identityEvidenceIds)
    );
  };
  const personEvidence = (id: string): string[] =>
    people.get(id)?.identityEvidenceIds ?? [];
  const corporate = sorted(dataset?.corporateLinks ?? []);
  const roles = sorted(dataset?.publicRoles ?? []);
  const targetCorporate = corporate.filter(
    (c) => validSupplier && normalizeCnpj(c.companyCnpj) === supplierCnpj,
  );
  const relevantRoles = roles.filter((r) => roleInSubject(r, subject));
  const corporateByPerson = indexBy(targetCorporate, (c) => c.personId);
  const rolesByPerson = indexBy(relevantRoles, (r) => r.personId);
  const corporateByCompany = indexBy(corporate, (c) =>
    normalizeCnpj(c.companyCnpj),
  );
  const familyLinks = sorted(dataset?.familyLinks ?? []);
  const scopedCompetitions = sorted(dataset?.competitions ?? []).filter(
    (c) => c.contractId === subject.id,
  );
  const exceedsBudget = (
    ruleCode: string,
    count: number,
    limit: number,
    inputs: unknown,
    ids: string[],
  ): boolean => {
    if (count <= limit) return false;
    const notice =
      `${ruleCode}: análise relacional não executada por limite de complexidade ` +
      `(${count} combinações candidatas; limite ${limit}). Não foram escolhidas apenas as primeiras combinações e não se conclui ausência de vínculos.`;
    limitations.add(notice);
    add({
      ruleCode,
      title: "Análise relacional excede o limite de complexidade",
      state: "NOT_VERIFIABLE",
      priority: "context",
      statement: notice,
      calculation: `${count} combinações candidatas > ${limit}; expansão interrompida antes do cruzamento.`,
      targetIds: ["complexity-limit"],
      evidenceIds: ids,
      inputs: { count, limit, records: inputs },
      alternativeHypotheses: [
        "Conjunto documental amplo ou referências redundantes; o volume não constitui indício de ilícito.",
      ],
      nextSteps: [
        "Delimitar a análise por período, pessoa, função ou lote sem eliminar o acervo histórico.",
        "Revisar referências redundantes e executar os subconjuntos com a delimitação registrada.",
      ],
      limitation: `${notice} ${RELATION_LIMITATION}`,
    });
    return true;
  };
  const usableCorporate = (c: CorporateLink, day: number | null) =>
    identityReady(c.personId) &&
    retained(c.evidenceIds) &&
    intervalStatus(c, day) === "active";
  const usableRole = (r: PublicRoleLink) =>
    identityReady(r.personId) &&
    retained(r.evidenceIds) &&
    intervalStatus(r, signatureDay) === "active" &&
    roleInSubject(r, subject);
  const addPerson = (id: string) => {
    const p = people.get(id);
    if (p) node(`person:${id}`, "person", p.name);
  };
  for (const link of targetCorporate) {
    addPerson(link.personId);
    if (intervalStatus(link, signatureDay) !== "inactive")
      edge(
        `corporate:${link.id}`,
        `person:${link.personId}`,
        companyNode,
        `VINCULO_${link.role.toUpperCase()}_NA_DATA_ANALISADA`,
        usableCorporate(link, signatureDay) ? "documented" : "unresolved",
        [...link.evidenceIds, ...personEvidence(link.personId)],
      );
  }
  for (const role of relevantRoles) {
    addPerson(role.personId);
    if (intervalStatus(role, signatureDay) !== "inactive")
      edge(
        `role:${role.id}`,
        `person:${role.personId}`,
        bodyNode,
        `FUNCAO_${role.role.toUpperCase()}_NA_DATA_ANALISADA`,
        usableRole(role) ? "documented" : "unresolved",
        [...role.evidenceIds, ...personEvidence(role.personId)],
      );
  }

  const directCandidates = [...corporateByPerson].reduce(
    (count, [personId, links]) =>
      count + links.length * (rolesByPerson.get(personId)?.length ?? 0),
    0,
  );
  const directLimited = exceedsBudget(
    "INV-REL-001",
    directCandidates,
    INVESTIGATION_RELATION_JOIN_LIMIT,
    { targetCorporate, relevantRoles, signatureDate: subject.signatureDate },
    [...targetCorporate, ...relevantRoles].flatMap((r) => r.evidenceIds),
  );
  for (const link of directLimited ? [] : targetCorporate)
    for (const role of rolesByPerson.get(link.personId) ?? []) {
      const ids = [
        ...link.evidenceIds,
        ...role.evidenceIds,
        ...personEvidence(link.personId),
      ];
      const inputs = {
        link,
        role,
        person: people.get(link.personId),
        signatureDate: subject.signatureDate,
        entityId: subject.entityId,
      };
      if (!usableCorporate(link, signatureDay) || !usableRole(role)) {
        const inactive =
          intervalStatus(link, signatureDay) === "inactive" ||
          intervalStatus(role, signatureDay) === "inactive";
        check(
          "INV-REL-001",
          "Vínculo societário e funcional requer verificação",
          inactive
            ? "Os intervalos documentados não coincidem com a assinatura; não há vínculo simultâneo demonstrado nessa data."
            : "Falta identidade documental, original preservado ou intervalo temporal explícito para o vínculo simultâneo.",
          [link.id, role.id],
          inputs,
          ids,
          inactive ? "NOT_APPLICABLE" : "NOT_VERIFIABLE",
        );
        continue;
      }
      add({
        ruleCode: "INV-REL-001",
        title: "Vínculo empresarial e função pública coincidentes",
        state: "OBSERVATION",
        priority: "high",
        statement:
          "Os registros documentados associam a mesma identidade ao fornecedor e a uma função pertinente no órgão/contratação na data da assinatura.",
        calculation:
          "Identidade documentada ∧ vínculo empresarial ativo ∧ função pertinente ativa ∧ órgão/contrato coincidente.",
        evidenceIds: ids,
        targetIds: [link.id, role.id],
        inputs,
        alternativeHypotheses: [
          "Erro no registro, no vínculo ou na delimitação das atribuições.",
          "Documento desatualizado, retificação ou hipótese jurídica específica que demande exame.",
        ],
        nextSteps: [
          "Revisar atos societários, nomeação, designação, impedimentos e regime jurídico aplicável.",
          "Documentar manifestação e eventuais elementos que afastem a hipótese.",
        ],
        limitation: RELATION_LIMITATION,
      });
    }
  if (!directCandidates)
    check(
      "INV-REL-001",
      "Vínculos funcionais sem comprovação suficiente",
      "Não há conjunto documental ligando uma identidade do fornecedor a função pertinente no órgão/contrato. PEP ou cargo político genérico não é impedimento automático.",
      ["direct-role"],
      { targetCorporate, relevantRoles },
    );

  const familyCandidates = familyLinks.reduce(
    (count, family) =>
      family.personAId === family.personBId
        ? count
        : count +
          (corporateByPerson.get(family.personAId)?.length ?? 0) *
            (rolesByPerson.get(family.personBId)?.length ?? 0) +
          (corporateByPerson.get(family.personBId)?.length ?? 0) *
            (rolesByPerson.get(family.personAId)?.length ?? 0),
    0,
  );
  const familyLimited = exceedsBudget(
    "INV-FAMILY-001",
    familyCandidates,
    INVESTIGATION_RELATION_JOIN_LIMIT,
    {
      familyLinks,
      targetCorporate,
      relevantRoles,
      signatureDate: subject.signatureDate,
    },
    [...familyLinks, ...targetCorporate, ...relevantRoles].flatMap(
      (r) => r.evidenceIds,
    ),
  );
  for (const family of familyLimited ? [] : familyLinks) {
    if (family.personAId === family.personBId) continue;
    for (const [supplierPersonId, officialId] of [
      [family.personAId, family.personBId],
      [family.personBId, family.personAId],
    ]) {
      const matchedRoles = rolesByPerson.get(officialId) ?? [];
      if (!matchedRoles.length) continue;
      for (const link of corporateByPerson.get(supplierPersonId) ?? [])
        for (const role of matchedRoles) {
          const ids = [
            ...family.evidenceIds,
            ...link.evidenceIds,
            ...role.evidenceIds,
            ...personEvidence(link.personId),
            ...personEvidence(officialId),
          ];
          const inputs = {
            family,
            link,
            role,
            supplierPerson: people.get(link.personId),
            officialPerson: people.get(officialId),
            signatureDate: subject.signatureDate,
            entityId: subject.entityId,
          };
          const degreeOk =
            family.relationship === "spouse" ||
            family.relationship === "partner" ||
            ([1, 2, 3] as unknown[]).includes(family.degree);
          const inactive = [family, link, role].some(
            (i) => intervalStatus(i, signatureDay) === "inactive",
          );
          const ready =
            family.verification === "documented" &&
            degreeOk &&
            retained(family.evidenceIds) &&
            identityReady(link.personId) &&
            identityReady(officialId) &&
            intervalStatus(family, signatureDay) === "active" &&
            usableCorporate(link, signatureDay) &&
            usableRole(role);
          addPerson(link.personId);
          addPerson(officialId);
          if (!inactive)
            edge(
              `family:${family.id}`,
              `person:${family.personAId}`,
              `person:${family.personBId}`,
              `RELACAO_${family.relationship.toUpperCase()}_DECLARADA`,
              ready ? "documented" : "unresolved",
              ids,
            );
          if (!ready) {
            check(
              "INV-FAMILY-001",
              "Relação familiar não estabelece impedimento demonstrado",
              inactive
                ? "Um ou mais vínculos estão fora do intervalo da assinatura; não há coincidência temporal demonstrada."
                : "Falta identidade, comprovação de parentesco/grau, nexo funcional ou intervalo documentado. Similaridade de nomes não preenche essas lacunas.",
              [family.id, link.id, role.id],
              inputs,
              ids,
              inactive ? "NOT_APPLICABLE" : "NOT_VERIFIABLE",
            );
            continue;
          }
          add({
            ruleCode: "INV-FAMILY-001",
            title: "Relação familiar documentada com nexo na contratação",
            state: "OBSERVATION",
            priority: "high",
            statement:
              "Uma identidade vinculada ao fornecedor possui relação familiar documentada com agente de função pertinente no órgão/contrato, com intervalos coincidentes na assinatura.",
            calculation: `Identidades documentadas ∧ vínculo empresarial ∧ ${family.relationship}${family.degree ? ` de grau ${family.degree}` : ""} ∧ função pertinente ∧ vigências coincidentes.`,
            evidenceIds: ids,
            targetIds: [family.id, link.id, role.id],
            inputs,
            alternativeHypotheses: [
              "Relação ou atribuição descrita incorretamente na fonte.",
              "Retificação documental ou particularidade do regime jurídico que exija avaliação individual.",
            ],
            nextSteps: [
              "Validar os atos originais, o grau de parentesco e as atribuições efetivas.",
              "Avaliar o art. 14, IV, se a Lei 14.133/2021 reger o caso; registrar contexto e contraditório.",
            ],
            limitation: RELATION_LIMITATION,
          });
        }
    }
  }
  if (!familyCandidates)
    check(
      "INV-FAMILY-001",
      "Parentesco com nexo contratual não comprovado",
      "Não há cadeia documental suficiente entre fornecedor, familiar e agente pertinente. Nomes e sobrenomes não geram vínculos automáticos.",
      ["family-role"],
      { familyLinks, targetCorporate, relevantRoles },
    );

  const competitionCandidates = scopedCompetitions.length;
  const competitionLinkCandidates = scopedCompetitions.reduce(
    (count, competition) =>
      count +
      unique(competition.bidderCnpjs.map(normalizeCnpj)).reduce(
        (sum, cnpj) => sum + (corporateByCompany.get(cnpj)?.length ?? 0),
        0,
      ),
    0,
  );
  const competitionLimited = exceedsBudget(
    "INV-COMPETITION-001",
    competitionLinkCandidates,
    INVESTIGATION_COMPETITION_LINK_LIMIT,
    { scopedCompetitions, corporate },
    [...scopedCompetitions, ...corporate].flatMap((r) => r.evidenceIds),
  );
  for (const competition of competitionLimited ? [] : scopedCompetitions) {
    const day = strictDateDays(competition.eventDate);
    const bidders = unique(competition.bidderCnpjs.map(normalizeCnpj));
    if (
      day === null ||
      evaluationDay === null ||
      day > evaluationDay ||
      !retained(competition.evidenceIds) ||
      !competition.lotId.trim() ||
      bidders.length < 2 ||
      bidders.some((cnpj) => !isValidCnpj(cnpj))
    ) {
      check(
        "INV-COMPETITION-001",
        "Comparação societária de licitantes não verificável",
        "Exige ata/lista preservada, data válida, lote e pelo menos dois CNPJs válidos distintos.",
        [competition.id],
        competition,
        competition.evidenceIds,
      );
      continue;
    }
    const byPerson = new Map<string, CorporateLink[]>();
    for (const cnpj of bidders)
      for (const link of corporateByCompany.get(cnpj) ?? []) {
        if (usableCorporate(link, day)) {
          const group = byPerson.get(link.personId);
          if (group) group.push(link);
          else byPerson.set(link.personId, [link]);
        }
      }
    let overlaps = 0;
    for (const [personId, links] of byPerson) {
      const companies = unique(links.map((l) => normalizeCnpj(l.companyCnpj)));
      if (companies.length < 2) continue;
      overlaps++;
      const ids = [
        ...competition.evidenceIds,
        ...personEvidence(personId),
        ...links.flatMap((l) => l.evidenceIds),
      ];
      addPerson(personId);
      for (const cnpj of companies)
        node(
          `company:${cnpj}`,
          "company",
          cnpj === supplierCnpj
            ? subject.supplier.legalName
            : `Empresa ${cnpj}`,
        );
      for (const link of links)
        edge(
          `competition:${competition.id}:${link.id}`,
          `person:${personId}`,
          `company:${normalizeCnpj(link.companyCnpj)}`,
          `VINCULO_${link.role.toUpperCase()}_NO_EVENTO_DO_LOTE_${competition.lotId}`,
          "documented",
          [
            ...link.evidenceIds,
            ...personEvidence(personId),
            ...competition.evidenceIds,
          ],
        );
      add({
        ruleCode: "INV-COMPETITION-001",
        title: "Identidade empresarial comum entre participantes do lote",
        state: "OBSERVATION",
        priority: "medium",
        statement: `Uma identidade documentada tem vínculos empresariais com ${companies.length} participantes do mesmo lote na data do evento.`,
        calculation: `Lote ${competition.lotId}; data ${competition.eventDate}; ${companies.length} CNPJs distintos; identidade e intervalos documentados.`,
        targetIds: [competition.id, personId, ...companies],
        evidenceIds: ids,
        inputs: { competition, links, person: people.get(personId) },
        alternativeHypotheses: [
          "Representação profissional compartilhada ou participação societária que não implica controle.",
          "Participação permitida no caso concreto ou erro de dados.",
        ],
        nextSteps: [
          "Verificar controle, influência, propostas, lances e independência das ofertas.",
          "Não equiparar vínculo comum a conluio sem evidência comportamental e jurídica.",
        ],
        limitation: RELATION_LIMITATION,
      });
    }
    if (!overlaps)
      check(
        "INV-COMPETITION-001",
        "Comparação de vínculos sem sobreposição demonstrada",
        "Não há identidade comum demonstrada pelos vínculos documentados disponíveis; QSA incompleto não exclui conexão.",
        [competition.id],
        { competition, corporate },
        competition.evidenceIds,
      );
  }
  if (!competitionCandidates)
    check(
      "INV-COMPETITION-001",
      "Participantes por lote não disponíveis",
      "Não foi fornecida lista documentada de participantes por lote e data para este contrato.",
      ["competition"],
      { contractId: subject.id },
    );

  return {
    schemaVersion: "1.0",
    engineVersion: INVESTIGATION_ENGINE_VERSION,
    contractId: subject.id,
    supplierCnpj,
    evaluatedAt: input.evaluatedAt,
    inputDigest: digest({
      evaluationDate: input.evaluatedAt.slice(0, 10),
      subject,
      portfolio: sorted(input.portfolio),
      dataset,
      coverage: sorted(input.coverage),
      verifiedArtifactHashes: unique([...verifiedHashes]),
    }),
    metrics: {
      observedContractCount: observed.length,
      observedPriorContractCount,
      observedBuyerCount,
      sameBuyerValueSharePct: share,
      portfolioExcludedCount: excluded,
      daysFromActivityStart,
    },
    coverage: sorted(input.coverage),
    findings: findings.sort(
      (a, b) =>
        a.ruleCode.localeCompare(b.ruleCode) || a.id.localeCompare(b.id),
    ),
    timeline: timeline.sort(
      (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
    ),
    graph: {
      nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
    },
    evidence: sorted(evidence),
    limitations: [...limitations],
  };
}

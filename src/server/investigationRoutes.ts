import express, { type Express, type Request, type Response } from "express";
import type { ContractRecord } from "../types/audit";
import type {
  InvestigationDataset,
  InvestigationEngineInput,
  InvestigationResponse,
} from "../types/investigation";
import { normalizeCnpj } from "../lib/cnpj";
import { validateUploadedFileMagic } from "../lib/documentParser";
import { evaluateInvestigation } from "../lib/investigationEngine";
import {
  createAuthMiddleware,
  type AuthenticatedRequest,
} from "./authMiddleware";
import { fetchCompanyRegistryEvidence } from "./companyRegistryEvidence";
import {
  canonicalInvestigationJson,
  createInvestigationStore,
  investigationDigest,
  InvestigationConflictError,
  InvestigationIntegrityError,
  type InvestigationHistory,
  type InvestigationStore,
} from "./investigationStore";
import {
  InvestigationValidationError,
  MAX_INVESTIGATION_ARTIFACT_BYTES,
  MAX_INVESTIGATION_JSON_BYTES,
  strictObject,
  validateInvestigationDataset,
  validateInvestigationReview,
  validateInvestigationSubmission,
} from "./investigationValidation";
import type { NexofisStore } from "./storage";

interface RouteOptions {
  store: NexofisStore;
  getContract: (id: string) => ContractRecord | null | undefined;
  getAllContracts: () => ContractRecord[];
  investigationStore?: InvestigationStore;
  authSecret?: string;
  registryFetch?: typeof fetchCompanyRegistryEvidence;
}

function actor(req: AuthenticatedRequest, rationale: string) {
  const p = req.nexofisPrincipal!;
  return { actorId: p.userId, actorRole: p.role, rationale };
}

function sendError(error: unknown, res: Response) {
  if (error instanceof InvestigationValidationError)
    return res.status(400).json({ error: error.message });
  if (error instanceof InvestigationConflictError)
    return res.status(409).json({ error: error.message });
  if (error instanceof InvestigationIntegrityError)
    return res
      .status(409)
      .json({ error: error.message, code: "INVESTIGATION_INTEGRITY_FAILURE" });
  return res
    .status(500)
    .json({
      error:
        "Não foi possível concluir a operação investigativa. Nenhuma conclusão deve ser inferida desta falha.",
    });
}

/** All investigation endpoints require an identified analyst, even in local/demo mode. */
export function mountInvestigationRoutes(
  app: Express,
  options: RouteOptions,
): InvestigationStore {
  const privateStore =
    options.investigationStore ??
    createInvestigationStore(options.store.dbPath);
  const router = express.Router({ mergeParams: true });
  router.use(
    createAuthMiddleware({
      allowedRoles: ["admin", "analyst"],
      enforceOverride: true,
      secret: options.authSecret,
    }),
  );
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  // Standalone router also applies body limits; the host may already have parsed JSON.
  router.use(express.json({ limit: "1500kb" }));

  function subject(req: Request, res: Response): ContractRecord | null {
    const id = String(req.params.id ?? "");
    if (!id || id.length > 200 || /[\u0000-\u001f]/.test(id)) {
      res.status(400).json({ error: "Identificador do contrato inválido." });
      return null;
    }
    const result = options.getContract(id);
    if (!result) {
      res.status(404).json({ error: "Contrato não encontrado." });
      return null;
    }
    return result;
  }

  function verifiedHashes(
    contract: ContractRecord,
    dataset: InvestigationDataset | null,
    history: InvestigationHistory,
  ): string[] {
    const hashes = [
      ...new Set(
        dataset?.evidence
          .map((e) => e.artifactSha256)
          .filter((h): h is string => Boolean(h)) ?? [],
      ),
    ];
    return hashes.filter((hash) => {
      const privateArtifact = privateStore.readArtifact(
        contract.id,
        hash,
        history,
      );
      return privateArtifact?.verified === true;
    });
  }

  function evaluate(
    contract: ContractRecord,
    history = privateStore.readHistory(contract.id),
  ) {
    const dataset = history.currentRevision?.dataset ?? null;
    const cnpj = normalizeCnpj(contract.supplier.cnpj);
    const checkpoint = options.store.getSyncCheckpoint(`cnpj:${cnpj}`);
    const input: InvestigationEngineInput = {
      subject: contract,
      portfolio: options
        .getAllContracts()
        .filter((c) => normalizeCnpj(c.supplier.cnpj) === cnpj),
      dataset,
      coverage: [
        {
          source: "Índice local persistido",
          status: "partial",
          queriedAt: null,
          periodFrom: null,
          periodThrough: null,
          description:
            "Registros locais do CNPJ exato; não representa a carteira completa nem a receita da empresa. Matriz e filiais não são fundidas.",
        },
        {
          source: "PNCP — consulta por CNPJ",
          status: checkpoint
            ? checkpoint.status === "complete"
              ? "complete_in_source"
              : checkpoint.status === "unavailable"
                ? "unavailable"
                : "partial"
            : "not_queried",
          queriedAt: checkpoint?.lastSyncedAt ?? null,
          periodFrom: null,
          periodThrough: null,
          description: checkpoint
            ? `Consulta registrada em ${checkpoint.lastSyncedAt}; ${checkpoint.totalFetched} registros capturados de ${checkpoint.totalDeclared} declarados na fonte. Cobertura nacional do portal não garante completude das contratações da empresa.`
            : "Sem checkpoint verificável de consulta PNCP por este CNPJ. Ausência de registros não comprova ausência de contratos.",
        },
      ],
      verifiedArtifactHashes: verifiedHashes(contract, dataset, history),
      evaluatedAt: new Date().toISOString(),
    };
    const response: InvestigationResponse = {
      report: evaluateInvestigation(input),
      dataset,
      currentRevision: history.currentRevision
        ? {
            id: history.currentRevision.id,
            sequence: history.currentRevision.sequence,
            datasetDigest: history.currentRevision.datasetDigest,
            eventHash: history.currentRevision.eventHash,
            createdAt: history.currentRevision.createdAt,
          }
        : null,
      reviews: history.reviews,
      integrity: history.integrity,
    };
    return { input, history, response };
  }

  router.get("/", (req, res) => {
    try {
      const contract = subject(req, res);
      if (contract) res.json(evaluate(contract).response);
    } catch (err) {
      sendError(err, res);
    }
  });

  router.post("/dataset", (req: AuthenticatedRequest, res) => {
    try {
      const contract = subject(req, res);
      if (!contract) return;
      if (
        Buffer.byteLength(JSON.stringify(req.body) ?? "") >
        MAX_INVESTIGATION_JSON_BYTES
      )
        return res
          .status(413)
          .json({ error: "Pacote de investigação excede 512 KiB." });
      const input = validateInvestigationSubmission(req.body);
      const history = privateStore.readHistory(contract.id);
      const verified = new Set(
        verifiedHashes(contract, input.dataset, history),
      );
      if (
        input.dataset.evidence.some(
          (e) => e.artifactSha256 && !verified.has(e.artifactSha256),
        )
      )
        throw new InvestigationValidationError(
          "Original referenciado não está preservado, vinculado a este contrato e íntegro. Envie o arquivo na área privada da investigação primeiro.",
        );
      privateStore.appendDataset({
        contractId: contract.id,
        ...input,
        ...actor(req, input.rationale),
      });
      res.json(evaluate(contract).response);
    } catch (err) {
      sendError(err, res);
    }
  });

  router.post("/reviews", (req: AuthenticatedRequest, res) => {
    try {
      const contract = subject(req, res);
      if (!contract) return;
      const input = validateInvestigationReview(req.body);
      const current = evaluate(contract);
      const finding = current.response.report.findings.find(
        (f) => f.id === input.findingId,
      );
      if (!finding || finding.inputDigest !== input.findingInputDigest)
        throw new InvestigationConflictError(
          "Achado ou insumos mudaram. Recarregue antes de revisar.",
        );
      privateStore.appendReview({
        contractId: contract.id,
        ...input,
        ...actor(req, input.rationale),
        expectedHeadHash: current.history.integrity.headHash,
      });
      res.json(evaluate(contract).response);
    } catch (err) {
      sendError(err, res);
    }
  });

  router.post("/artifacts", (req: AuthenticatedRequest, res) => {
    try {
      const contract = subject(req, res);
      if (!contract) return;
      const body = strictObject(
        req.body,
        ["filename", "mimeType", "contentBase64"],
        "artifact",
      );
      if (
        typeof body.filename !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,149}$/.test(body.filename) ||
        body.filename.includes("..")
      )
        throw new InvestigationValidationError(
          "Nome de arquivo inválido. Use um nome simples sem caminhos.",
        );
      if (
        typeof body.mimeType !== "string" ||
        !["application/pdf", "image/png", "image/jpeg", "text/plain"].includes(
          body.mimeType,
        )
      )
        throw new InvestigationValidationError(
          "Formato permitido: PDF, PNG, JPEG ou texto simples.",
        );
      if (
        typeof body.contentBase64 !== "string" ||
        body.contentBase64.length >
          Math.ceil(MAX_INVESTIGATION_ARTIFACT_BYTES / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          body.contentBase64,
        )
      )
        throw new InvestigationValidationError(
          "Base64 inválido ou arquivo acima de 1 MiB.",
        );
      const bytes = Buffer.from(body.contentBase64, "base64");
      if (
        !bytes.length ||
        bytes.length > MAX_INVESTIGATION_ARTIFACT_BYTES ||
        bytes.toString("base64") !== body.contentBase64
      )
        throw new InvestigationValidationError(
          "Arquivo vazio, inválido ou acima de 1 MiB.",
        );
      const magic = validateUploadedFileMagic(bytes, body.mimeType);
      if (!magic.valid)
        throw new InvestigationValidationError(
          magic.reason ?? "Assinatura binária inválida.",
        );
      const saved = privateStore.saveArtifact({
        contractId: contract.id,
        filename: body.filename,
        mimeType: body.mimeType,
        bytes,
        ...actor(
          req,
          "Preservação de arquivo original na investigação restrita.",
        ),
      });
      res.status(201).json(saved);
    } catch (err) {
      sendError(err, res);
    }
  });

  router.get("/artifacts/:sha256", (req, res) => {
    try {
      const contract = subject(req, res);
      if (!contract) return;
      const hash = String(req.params.sha256);
      const result = privateStore.readArtifact(contract.id, hash);
      if (!result || !result.verified)
        return res
          .status(404)
          .json({
            error:
              "Original privado não disponível ou íntegro para este contrato.",
          });
      res.setHeader("Content-Type", result.artifact.mimeType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${result.artifact.filename.replace(/["\r\n]/g, "_")}"`,
      );
      res.setHeader("X-Nexofis-Sha256", hash);
      res.send(result.bytes);
    } catch (err) {
      sendError(err, res);
    }
  });

  router.post("/refresh-registry", async (req: AuthenticatedRequest, res) => {
    try {
      const contract = subject(req, res);
      if (!contract) return;
      const body = strictObject(
        req.body,
        ["purpose", "legalBasis", "rationale", "expectedRevisionDigest"],
        "registry",
      );
      const history = privateStore.readHistory(contract.id);
      const existing = history.currentRevision?.dataset ?? {
        schemaVersion: "1.0" as const,
        purpose: "",
        legalBasis: "",
        evidence: [],
        companyEvents: [],
        people: [],
        corporateLinks: [],
        publicRoles: [],
        familyLinks: [],
        competitions: [],
      };
      const submission = validateInvestigationSubmission({
        dataset: {
          ...existing,
          purpose: body.purpose,
          legalBasis: body.legalBasis,
        },
        rationale: body.rationale,
        expectedRevisionDigest: body.expectedRevisionDigest,
      });
      if (
        (history.currentRevision?.datasetDigest ?? null) !==
        submission.expectedRevisionDigest
      )
        throw new InvestigationConflictError();
      const result = await (
        options.registryFetch ?? fetchCompanyRegistryEvidence
      )(contract.supplier.cnpj);
      if (result.status !== "available")
        return res.json({
          ...evaluate(contract).response,
          registryMessage: result.message,
        });
      // Preserve prior snapshots. A refresh is additive; contradictory dates stay visible to the engine.
      const appendUnique = <T extends { id: string }>(
        left: T[],
        right: T[],
      ) => [
        ...left,
        ...right.filter((item) => !left.some((old) => old.id === item.id)),
      ];
      const dataset = validateInvestigationDataset({
        ...submission.dataset,
        evidence: appendUnique(existing.evidence, [result.evidence]),
        companyEvents: appendUnique(
          existing.companyEvents,
          result.companyEvents,
        ),
        people: appendUnique(existing.people, result.people),
        corporateLinks: appendUnique(
          existing.corporateLinks,
          result.corporateLinks,
        ),
      });
      // Avoid an orphan acquisition event after a concurrent analyst edit during the external request.
      if (
        (privateStore.readHistory(contract.id).currentRevision?.datasetDigest ??
          null) !== submission.expectedRevisionDigest
      )
        throw new InvestigationConflictError();
      privateStore.saveArtifact({
        contractId: contract.id,
        filename: result.artifactFilename,
        mimeType: "text/plain",
        bytes: result.artifactBytes,
        ...actor(
          req,
          `Aquisição de extrato cadastral derivado e minimizado. ${submission.rationale}`,
        ),
      });
      privateStore.appendDataset({
        contractId: contract.id,
        dataset,
        expectedRevisionDigest: submission.expectedRevisionDigest,
        ...actor(req, submission.rationale),
      });
      res.json({
        ...evaluate(contract).response,
        registryMessage: result.message,
      });
    } catch (err) {
      sendError(err, res);
    }
  });

  router.get("/export", (req, res) => {
    try {
      const contract = subject(req, res);
      if (!contract) return;
      const { input, history, response } = evaluate(contract);
      const payload = {
        input,
        report: response.report,
        dataset: response.dataset,
        events: history.events,
        integrity: history.integrity,
        artifactManifest: history.artifacts.map((a) => ({
          ...a,
          sha256VerifiedAtExport:
            privateStore.readArtifact(contract.id, a.artifactSha256, history)
              ?.verified === true,
          downloadPath: `/api/contracts/${encodeURIComponent(contract.id)}/investigation/artifacts/${a.artifactSha256}`,
        })),
        methodNotice:
          "Pacote de elementos de informação para revisão. O hash permite verificar integridade dos bytes descritos; não comprova veracidade, autoria, assinatura digital, carimbo de tempo confiável ou admissibilidade judicial. Originais binários são obtidos separadamente no manifesto por acesso autenticado. A trilha local não substitui a cadeia de custódia institucional e pode ser reescrita por quem controle privilegiadamente o banco e os arquivos. Finalidade e fundamento são declarados pelo responsável, não certificados pelo sistema.",
        accessScope:
          "Acesso institucional único: todos os analistas e administradores autenticados desta instalação. Não há segregação por processo ou órgão neste módulo.",
      };
      const output = {
        schema: "nexofis.investigation.v1",
        exportedAt: new Date().toISOString(),
        softwareLicense: "AGPL-3.0-only",
        integrity: {
          algorithm: "SHA-256",
          canonicalization: "stable-json-v1",
          contentSha256: investigationDigest(payload),
        },
        payload,
      };
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="investigacao-nexofis-${contract.id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80)}.json"`,
      );
      res.type("application/json").send(canonicalInvestigationJson(output));
    } catch (err) {
      sendError(err, res);
    }
  });

  router.use(
    (
      err: unknown,
      _req: Request,
      res: Response,
      _next: express.NextFunction,
    ) => {
      const status = (err as { status?: number })?.status;
      res
        .status(status === 413 ? 413 : 400)
        .json({
          error:
            status === 413
              ? "Corpo da requisição excede o limite."
              : "JSON inválido.",
        });
    },
  );
  app.use("/api/contracts/:id/investigation", router);
  return privateStore;
}

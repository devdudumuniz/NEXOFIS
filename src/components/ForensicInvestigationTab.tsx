import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  FileUp,
  Fingerprint,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import type { EvaluatedContract } from "../types/audit";
import type {
  InvestigationDataset,
  InvestigationFinding,
  InvestigationResponse,
} from "../types/investigation";
import {
  ApiError,
  downloadInvestigationArtifact,
  exportInvestigation,
  fetchInvestigation,
  fetchSupplierMirrorContracts,
  importInvestigationDataset,
  refreshInvestigationRegistry,
  reviewInvestigationFinding,
  uploadInvestigationArtifact,
} from "../lib/api";
import { formatDateBR } from "../lib/formatters";

const panelClass =
  "rounded-lg border border-slate-200 dark:border-[#1D3A57] bg-white dark:bg-[#0B1D31] p-5";
const buttonClass =
  "inline-flex items-center justify-center gap-2 rounded-md border border-slate-300 dark:border-[#31516D] px-3 py-2 text-xs font-semibold text-[#0B2540] dark:text-slate-200 hover:bg-[#E8F1F6] dark:hover:bg-[#102843] disabled:opacity-50 disabled:cursor-not-allowed";
const fieldClass =
  "w-full rounded-md border border-slate-300 dark:border-[#31516D] bg-white dark:bg-[#061321] p-3 text-sm text-slate-900 dark:text-slate-100";

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadJson(filename: string, value: unknown): void {
  downloadBlob(
    filename,
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
}

function emptyDataset(): InvestigationDataset {
  return {
    schemaVersion: "1.0",
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
}

const states = {
  OBSERVATION: "Ponto de observação",
  NOT_VERIFIABLE: "Não verificável",
  NOT_APPLICABLE: "Sem disparo nesta regra",
} as const;
const priorities = {
  high: "Revisão prioritária",
  medium: "Revisão recomendada",
  context: "Contexto",
} as const;
const coverageLabels = {
  complete_in_source: "Consulta concluída na fonte",
  partial: "Cobertura parcial",
  unavailable: "Fonte indisponível",
  not_queried: "Fonte não consultada",
} as const;

interface Props {
  contract: EvaluatedContract;
  archived: boolean;
  onRequestAuthentication?: () => void;
}

/** Private, authenticated investigation workspace. Never hydrates a historical archive with live facts. */
export function ForensicInvestigationTab({
  contract,
  archived,
  onRequestAuthentication,
}: Props) {
  const [data, setData] = useState<InvestigationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [section, setSection] = useState<
    "findings" | "timeline" | "relations" | "evidence"
  >("findings");
  const [editor, setEditor] = useState("");
  const [editorBaseDigest, setEditorBaseDigest] = useState<string | null>(null);
  const [importRationale, setImportRationale] = useState("");
  const [registryForm, setRegistryForm] = useState(false);
  const [registryPurpose, setRegistryPurpose] = useState("");
  const [registryLegalBasis, setRegistryLegalBasis] = useState("");
  const [registryRationale, setRegistryRationale] = useState("");
  const [registryBaseDigest, setRegistryBaseDigest] = useState<string | null>(
    null,
  );
  const [reviewing, setReviewing] = useState<{
    finding: InvestigationFinding;
    action: "dismiss" | "restore";
  } | null>(null);
  const [reviewRationale, setReviewRationale] = useState("");
  const artifactInput = useRef<HTMLInputElement>(null);
  const jsonInput = useRef<HTMLInputElement>(null);

  const showError = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 409) {
      setNeedsReload(true);
      if (err.body?.code === "INVESTIGATION_INTEGRITY_FAILURE") setData(null);
    }
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      setData(null);
      setEditor("");
      setAuthRequired(err.status === 401);
    }
    setError(
      err instanceof Error ? err.message : "A operação não pôde ser concluída.",
    );
  }, []);

  useEffect(() => {
    if (archived) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchInvestigation(contract.id)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) showError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [contract.id, archived, showError]);

  async function run(label: string, operation: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setError(null);
    setFeedback(null);
    try {
      await operation();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(null);
    }
  }

  if (archived)
    return (
      <section className={panelClass}>
        <h2 className="font-semibold text-[#0B2540] dark:text-white">
          Investigação preservada em pacote próprio
        </h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          Este dossiê é um retrato histórico. Abra o contrato atual para
          consultar a investigação ou utilize o pacote JSON forense exportado na
          data da análise. Informações atuais não são acrescentadas
          silenciosamente a um arquivo antigo.
        </p>
      </section>
    );

  if (loading)
    return (
      <p role="status" className="p-6 text-sm text-slate-500">
        Verificando acesso e integridade da investigação…
      </p>
    );

  const report = data?.report;
  const observations =
    report?.findings.filter((f) => f.state === "OBSERVATION") ?? [];
  const nodeNames = new Map(
    report?.graph.nodes.map((n) => [n.id, n.label]) ?? [],
  );

  function latestReview(finding: InvestigationFinding) {
    return data?.reviews
      .filter(
        (r) =>
          r.findingId === finding.id &&
          r.findingInputDigest === finding.inputDigest,
      )
      .at(-1);
  }

  return (
    <div className="space-y-5" data-testid="forensic-investigation">
      <section className={panelClass}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-mono text-[#D95B35]">
              <Fingerprint size={16} aria-hidden="true" /> INTELIGÊNCIA
              DOCUMENTAL
            </div>
            <h2 className="mt-2 text-xl font-semibold text-[#0B2540] dark:text-white">
              Investigação forense do fornecedor
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-slate-600 dark:text-slate-300">
              Cronologia empresarial, histórico observado e relações
              documentadas. Cada apontamento apresenta seu cálculo, fontes,
              hipóteses alternativas e diligências sugeridas.
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#E8F1F6] dark:bg-[#102843] px-3 py-1 text-xs text-[#0B2540] dark:text-slate-200">
            <LockKeyhole size={13} aria-hidden="true" /> Acesso restrito
          </span>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className={buttonClass}
            disabled={!!busy}
            onClick={() =>
              run("recarregar", async () => {
                setData(await fetchInvestigation(contract.id));
                setAuthRequired(false);
                setNeedsReload(false);
              })
            }
          >
            <RefreshCw size={14} aria-hidden="true" /> Atualizar análise
          </button>
          {data && (
            <>
              <button
                className={buttonClass}
                disabled={!!busy || needsReload}
                onClick={() => {
                  setRegistryPurpose(data.dataset?.purpose ?? "");
                  setRegistryLegalBasis(data.dataset?.legalBasis ?? "");
                  setRegistryRationale("");
                  setRegistryBaseDigest(
                    data.currentRevision?.datasetDigest ?? null,
                  );
                  setRegistryForm(true);
                }}
              >
                <Search size={14} aria-hidden="true" /> Consultar cadastro e QSA
              </button>
              <button
                className={buttonClass}
                disabled={!!busy}
                onClick={() =>
                  run("histórico", async () => {
                    const result = await fetchSupplierMirrorContracts(
                      contract.supplier.cnpj,
                    );
                    setData(await fetchInvestigation(contract.id));
                    setFeedback(
                      result.pncpCnpjSync?.message ??
                        "Histórico atualizado nas fontes disponíveis.",
                    );
                  })
                }
              >
                <RefreshCw size={14} aria-hidden="true" /> Atualizar histórico
                PNCP
              </button>
              <button
                className={buttonClass}
                disabled={!!busy || needsReload || !data.integrity.valid}
                onClick={() =>
                  run("exportar", async () => {
                    const result = await exportInvestigation(contract.id);
                    downloadJson(
                      `investigacao-${contract.id.replace(/[^a-zA-Z0-9_-]/g, "-")}.json`,
                      result,
                    );
                    setFeedback(
                      "Pacote forense exportado com entradas congeladas, relatório e histórico. Preserve-o em local de acesso restrito.",
                    );
                  })
                }
              >
                <Download size={14} aria-hidden="true" /> Exportar pacote
                forense
              </button>
            </>
          )}
        </div>
        {busy && (
          <p role="status" className="mt-3 text-xs text-slate-500">
            Processando: {busy}…
          </p>
        )}
      </section>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4 text-sm text-amber-900 dark:text-amber-200"
        >
          <p>{error}</p>
          {authRequired && (
            <div className="mt-3">
              <p className="mb-2">
                Esta área exige uma sessão de analista ou administrador,
                inclusive em instalações locais.
              </p>
              <button className={buttonClass} onClick={onRequestAuthentication}>
                Entrar para investigar
              </button>
            </div>
          )}
        </div>
      )}
      {feedback && (
        <p
          role="status"
          className="rounded-md border border-slate-200 dark:border-[#1D3A57] p-4 text-sm text-slate-700 dark:text-slate-200"
        >
          {feedback}
        </p>
      )}
      {needsReload && (
        <p
          role="alert"
          className="rounded-md border border-amber-300 p-4 text-sm text-amber-800 dark:text-amber-200"
        >
          O estado exibido está desatualizado ou não pôde ser validado. Atualize
          a análise antes de registrar novas decisões. Um editor já aberto
          conserva a versão de origem e precisa ser reconciliado com a versão
          atual.
        </p>
      )}

      {data && report && (
        <>
          {registryForm && (
            <section className={panelClass}>
              <h3 className="font-semibold text-[#0B2540] dark:text-white">
                Registrar a finalidade da consulta cadastral
              </h3>
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                A consulta usa um provedor intermediário e preserva um extrato
                mínimo de data cadastral e QSA. Os sócios retornam como
                registros de identidade ainda não resolvida.
              </p>
              <div className="mt-4 space-y-3">
                <label
                  className="block text-sm text-slate-600 dark:text-slate-300"
                  htmlFor="registry-purpose"
                >
                  Finalidade específica
                </label>
                <textarea
                  id="registry-purpose"
                  rows={2}
                  className={fieldClass}
                  maxLength={800}
                  value={registryPurpose}
                  onChange={(e) => setRegistryPurpose(e.target.value)}
                />
                <label
                  className="block text-sm text-slate-600 dark:text-slate-300"
                  htmlFor="registry-legal-basis"
                >
                  Fundamento do tratamento declarado pelo responsável
                </label>
                <textarea
                  id="registry-legal-basis"
                  rows={2}
                  className={fieldClass}
                  maxLength={800}
                  value={registryLegalBasis}
                  onChange={(e) => setRegistryLegalBasis(e.target.value)}
                />
                <label
                  className="block text-sm text-slate-600 dark:text-slate-300"
                  htmlFor="registry-rationale"
                >
                  Motivo desta aquisição
                </label>
                <textarea
                  id="registry-rationale"
                  rows={2}
                  className={fieldClass}
                  maxLength={1500}
                  value={registryRationale}
                  onChange={(e) => setRegistryRationale(e.target.value)}
                />
                <div className="flex gap-2">
                  <button
                    className={buttonClass}
                    disabled={
                      !!busy ||
                      needsReload ||
                      [
                        registryPurpose,
                        registryLegalBasis,
                        registryRationale,
                      ].some((text) => text.trim().length < 12)
                    }
                    onClick={() =>
                      run("cadastro", async () => {
                        const result = await refreshInvestigationRegistry(
                          contract.id,
                          {
                            purpose: registryPurpose.trim(),
                            legalBasis: registryLegalBasis.trim(),
                            rationale: registryRationale.trim(),
                            expectedRevisionDigest: registryBaseDigest,
                          },
                        );
                        setData(result);
                        setEditor("");
                        setRegistryForm(false);
                        setFeedback(
                          result.registryMessage ??
                            "Extrato cadastral atualizado; as identidades do QSA continuam sujeitas a verificação.",
                        );
                      })
                    }
                  >
                    Registrar e consultar cadastro
                  </button>
                  <button
                    className={buttonClass}
                    disabled={!!busy}
                    onClick={() => setRegistryForm(false)}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            </section>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            {[
              [
                "Contratos observados",
                String(report.metrics.observedContractCount),
                `Anteriores à assinatura: ${report.metrics.observedPriorContractCount ?? "não verificável"}. Universo consultado, CNPJ exato.`,
              ],
              [
                "Órgãos observados",
                String(report.metrics.observedBuyerCount),
                "Contratantes distintos no índice",
              ],
              [
                "Intervalo cadastral",
                report.metrics.daysFromActivityStart === null
                  ? "Não verificável"
                  : `${report.metrics.daysFromActivityStart} dias`,
                "Início de atividade → assinatura",
              ],
              [
                "Concentração observada",
                report.metrics.sameBuyerValueSharePct === null
                  ? "Não verificável"
                  : `${report.metrics.sameBuyerValueSharePct.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`,
                "Valor observado no mesmo órgão",
              ],
            ].map(([label, value, hint]) => (
              <section key={label} className={panelClass}>
                <h3 className="text-xs text-slate-500 dark:text-slate-400">
                  {label}
                </h3>
                <p className="mt-2 text-xl font-semibold font-mono text-[#0B2540] dark:text-white">
                  {value}
                </p>
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  {hint}
                </p>
              </section>
            ))}
          </div>

          <section className={panelClass}>
            <div className="flex items-center gap-2 text-sm font-semibold text-[#0B2540] dark:text-white">
              <ShieldCheck size={16} aria-hidden="true" /> Cobertura e
              integridade
            </div>
            <div className="mt-3 space-y-2">
              {report.coverage.map((source, i) => (
                <div
                  key={`${source.source}-${i}`}
                  className="text-sm text-slate-600 dark:text-slate-300"
                >
                  <strong>{source.source}</strong> ·{" "}
                  {coverageLabels[source.status]}
                  <p className="mt-0.5 text-xs">{source.description}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              Revisão {data.currentRevision?.sequence ?? 0} ·{" "}
              {data.integrity.eventCount} eventos · Trilha de eventos{" "}
              {needsReload
                ? "pendente de nova verificação"
                : data.integrity.valid
                  ? "consistente na verificação"
                  : "não verificada"}{" "}
              · {observations.length} pontos de observação. A contagem não é
              probabilidade de crime.
            </p>
            <p className="mt-1 break-all text-[11px] font-mono text-slate-400">
              Entradas SHA-256: {report.inputDigest}
            </p>
          </section>

          <section className={panelClass}>
            <div
              role="tablist"
              aria-label="Seções da investigação"
              className="flex flex-wrap gap-2 border-b border-slate-200 dark:border-[#1D3A57] pb-3"
            >
              {(
                [
                  ["findings", "Apontamentos"],
                  ["timeline", "Linha do tempo"],
                  ["relations", "Relações documentais"],
                  ["evidence", "Fontes e evidências"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={section === id}
                  className={`${buttonClass} ${section === id ? "bg-[#E8F1F6] dark:bg-[#102843]" : ""}`}
                  onClick={() => setSection(id)}
                >
                  {label}
                </button>
              ))}
            </div>

            {section === "findings" && (
              <div className="mt-4 space-y-4">
                {report.findings.map((finding) => {
                  const review = latestReview(finding);
                  const dismissed = review?.action === "dismiss";
                  return (
                    <article
                      key={finding.id}
                      className={`rounded-lg border p-4 ${finding.state === "OBSERVATION" && !dismissed ? "border-[#D95B35]/40 bg-[#D95B35]/5" : "border-slate-200 dark:border-[#1D3A57]"}`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
                          {finding.ruleCode} · {states[finding.state]}
                        </span>
                        <span className="text-xs font-medium text-[#D95B35]">
                          {dismissed
                            ? "Descartado nesta versão dos dados"
                            : priorities[finding.priority]}
                        </span>
                      </div>
                      <h3 className="mt-2 font-semibold text-[#0B2540] dark:text-white">
                        {finding.title}
                      </h3>
                      <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
                        {finding.statement}
                      </p>
                      <p className="mt-2 rounded-md bg-slate-50 dark:bg-[#061321] p-3 text-xs font-mono break-words text-slate-600 dark:text-slate-400">
                        {finding.calculation}
                      </p>
                      <details className="mt-3 text-sm text-slate-600 dark:text-slate-300">
                        <summary className="cursor-pointer font-medium">
                          Evidências, hipóteses e próximas diligências
                        </summary>
                        <p className="mt-3 text-xs">
                          <strong>Evidências:</strong>{" "}
                          {finding.evidenceIds.join(", ") ||
                            "Ainda não vinculadas"}
                        </p>
                        <p className="mt-3 text-xs font-semibold">
                          Hipóteses alternativas
                        </p>
                        <ul className="mt-1 list-disc pl-5 text-xs space-y-1">
                          {finding.alternativeHypotheses.map((text, i) => (
                            <li key={i}>{text}</li>
                          ))}
                        </ul>
                        <p className="mt-3 text-xs font-semibold">
                          Diligências sugeridas
                        </p>
                        <ul className="mt-1 list-disc pl-5 text-xs space-y-1">
                          {finding.nextSteps.map((text, i) => (
                            <li key={i}>{text}</li>
                          ))}
                        </ul>
                        <p className="mt-3 text-xs">{finding.limitation}</p>
                        <p className="mt-2 break-all font-mono text-[10px]">
                          Dados do apontamento: {finding.inputDigest}
                        </p>
                      </details>
                      {review && (
                        <p className="mt-3 text-xs text-slate-500">
                          Revisão humana: {review.rationale}
                        </p>
                      )}
                      {finding.state === "OBSERVATION" && (
                        <button
                          className={`${buttonClass} mt-3`}
                          disabled={!!busy || needsReload}
                          onClick={() => {
                            setReviewing({
                              finding,
                              action: dismissed ? "restore" : "dismiss",
                            });
                            setReviewRationale("");
                          }}
                        >
                          {dismissed
                            ? "Restaurar apontamento"
                            : "Revisar apontamento"}
                        </button>
                      )}
                    </article>
                  );
                })}
                {!report.findings.length && (
                  <p className="text-sm text-slate-500">
                    Nenhum apontamento emitido. Verifique a cobertura das fontes
                    antes de interpretar o resultado.
                  </p>
                )}
              </div>
            )}

            {section === "timeline" && (
              <ol className="mt-5 space-y-4 border-l-2 border-[#D95B35]/40 pl-5">
                {report.timeline.map((event) => (
                  <li key={event.id}>
                    <p className="text-xs font-mono text-[#D95B35]">
                      {formatDateBR(event.date)}
                    </p>
                    <p className="mt-1 text-sm text-[#0B2540] dark:text-white">
                      {event.label}
                    </p>
                    <p className="mt-1 break-words text-xs text-slate-500">
                      Evidências:{" "}
                      {event.evidenceIds.join(", ") || "Não vinculadas"}
                    </p>
                  </li>
                ))}
                {!report.timeline.length && (
                  <li className="text-sm text-slate-500">
                    Não há eventos com data válida.
                  </li>
                )}
              </ol>
            )}

            {section === "relations" && (
              <div className="mt-4">
                <p className="mb-4 text-sm text-slate-600 dark:text-slate-300">
                  O caminho entre fornecedor, pessoa e órgão conserva
                  referências de origem. Nomes iguais não fundem pessoas;
                  parentesco não é inferido por sobrenome.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-slate-200 dark:border-[#1D3A57] text-xs text-slate-500">
                      <tr>
                        <th className="p-3">Origem</th>
                        <th className="p-3">Relação</th>
                        <th className="p-3">Destino</th>
                        <th className="p-3">Sustentação</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.graph.edges.map((edge) => (
                        <tr
                          key={edge.id}
                          className="border-b border-slate-100 dark:border-[#1D3A57] text-slate-700 dark:text-slate-300"
                        >
                          <td className="p-3">
                            {nodeNames.get(edge.from) ?? edge.from}
                          </td>
                          <td className="p-3 text-xs font-mono">{edge.kind}</td>
                          <td className="p-3">
                            {nodeNames.get(edge.to) ?? edge.to}
                          </td>
                          <td className="p-3 text-xs">
                            {edge.status === "documented"
                              ? "Documento vinculado"
                              : "Vínculo não resolvido"}
                            <p className="mt-1 text-slate-500">
                              {edge.evidenceIds.join(", ")}
                            </p>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 text-xs text-slate-500">
                  {report.graph.nodes.length} entidades ·{" "}
                  {report.graph.edges.length} relações. A vigência e o nexo com
                  esta contratação são avaliados em cada apontamento.
                </p>
              </div>
            )}

            {section === "evidence" && (
              <div className="mt-4 space-y-3">
                {report.evidence.map((item) => (
                  <article
                    key={item.id}
                    className="rounded-md border border-slate-200 dark:border-[#1D3A57] p-4"
                  >
                    <h3 className="text-sm font-semibold text-[#0B2540] dark:text-white">
                      {item.sourceName}
                    </h3>
                    <p className="mt-1 text-xs text-slate-500">
                      {item.id} ·{" "}
                      {item.sourceKind === "official"
                        ? "Fonte declarada oficial"
                        : item.sourceKind === "intermediary"
                          ? "Provedor intermediário"
                          : "Documento fornecido pelo analista"}{" "}
                      · {formatDateBR(item.retrievedAt)}
                    </p>
                    <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                      {item.locator}
                    </p>
                    {item.sourceUrl && (
                      <p className="mt-2 text-xs break-all text-slate-500">
                        Origem registrada: {item.sourceUrl}
                      </p>
                    )}
                    <p className="mt-2 break-all font-mono text-[10px] text-slate-500">
                      {item.artifactSha256
                        ? `Arquivo SHA-256: ${item.artifactSha256}`
                        : "Arquivo de suporte ainda não preservado."}
                    </p>
                    {item.artifactSha256 && (
                      <button
                        className={`${buttonClass} mt-3`}
                        disabled={!!busy}
                        onClick={() =>
                          run("evidência", async () => {
                            const blob = await downloadInvestigationArtifact(
                              contract.id,
                              item.artifactSha256!,
                            );
                            downloadBlob(`${item.artifactSha256}.bin`, blob);
                          })
                        }
                      >
                        <Download size={13} aria-hidden="true" /> Verificar e
                        baixar evidência
                      </button>
                    )}
                  </article>
                ))}
                {!report.evidence.length && (
                  <p className="text-sm text-slate-500">
                    Não há evidências suplementares nesta investigação.
                  </p>
                )}
              </div>
            )}
          </section>

          {reviewing && (
            <section className={panelClass}>
              <h3 className="font-semibold text-[#0B2540] dark:text-white">
                {reviewing.action === "dismiss" ? "Descartar" : "Restaurar"}:{" "}
                {reviewing.finding.title}
              </h3>
              <label
                htmlFor="investigation-review-rationale"
                className="mt-3 block text-sm text-slate-600 dark:text-slate-300"
              >
                Justificativa da revisão
              </label>
              <textarea
                id="investigation-review-rationale"
                className={`${fieldClass} mt-2`}
                rows={3}
                maxLength={1500}
                value={reviewRationale}
                onChange={(e) => setReviewRationale(e.target.value)}
                placeholder="Descreva a diligência e a evidência que fundamentam sua decisão (mínimo de 12 caracteres)."
              />
              <div className="mt-3 flex gap-2">
                <button
                  className={buttonClass}
                  disabled={
                    !!busy || needsReload || reviewRationale.trim().length < 12
                  }
                  onClick={() =>
                    run("revisão", async () => {
                      setData(
                        await reviewInvestigationFinding(contract.id, {
                          findingId: reviewing.finding.id,
                          findingInputDigest: reviewing.finding.inputDigest,
                          action: reviewing.action,
                          rationale: reviewRationale.trim(),
                        }),
                      );
                      setReviewing(null);
                      setReviewRationale("");
                      setFeedback(
                        "Revisão registrada com autor da sessão, versão dos dados e encadeamento de integridade.",
                      );
                    })
                  }
                >
                  Registrar revisão
                </button>
                <button
                  className={buttonClass}
                  disabled={!!busy}
                  onClick={() => setReviewing(null)}
                >
                  Cancelar
                </button>
              </div>
            </section>
          )}

          <details className={panelClass}>
            <summary className="cursor-pointer font-semibold text-[#0B2540] dark:text-white">
              Adicionar evidências e relações documentadas
            </summary>
            <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
              Preserve o documento de suporte e registre os fatos no conjunto
              estruturado. Informe finalidade e fundamento do tratamento,
              referências de identidade, datas de vigência e origem de cada
              vínculo. A marcação “documented” é uma afirmação do analista e
              precisa de suporte verificável.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <input
                ref={artifactInput}
                aria-label="Selecionar arquivo de evidência"
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.txt"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  void run("preservar arquivo", async () => {
                    const result = await uploadInvestigationArtifact(
                      contract.id,
                      file,
                    );
                    setFeedback(
                      `Evidência preservada (${result.filename}). Use este artifactSha256 no conjunto estruturado: ${result.artifactSha256}`,
                    );
                  });
                }}
              />
              <button
                className={buttonClass}
                disabled={!!busy}
                onClick={() => artifactInput.current?.click()}
              >
                <FileUp size={14} aria-hidden="true" /> Preservar evidência (até
                1 MiB)
              </button>
              <button
                className={buttonClass}
                disabled={!!busy}
                onClick={() => {
                  setEditor(
                    JSON.stringify(data.dataset ?? emptyDataset(), null, 2),
                  );
                  setEditorBaseDigest(
                    data.currentRevision?.datasetDigest ?? null,
                  );
                  setImportRationale("");
                }}
              >
                Editar conjunto atual
              </button>
              <button
                className={buttonClass}
                onClick={() =>
                  downloadJson(
                    "nexofis-investigation-template.json",
                    emptyDataset(),
                  )
                }
              >
                Baixar modelo vazio
              </button>
              <input
                ref={jsonInput}
                aria-label="Selecionar conjunto JSON"
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  void run("ler conjunto", async () => {
                    if (file.size > 512 * 1024)
                      throw new Error("O conjunto JSON deve ter até 512 KiB.");
                    const text = await file.text();
                    JSON.parse(text);
                    setEditor(text);
                    setEditorBaseDigest(
                      data.currentRevision?.datasetDigest ?? null,
                    );
                    setImportRationale("");
                    setFeedback(
                      "Arquivo carregado para revisão. A gravação ainda não foi realizada.",
                    );
                  });
                }}
              />
              <button
                className={buttonClass}
                disabled={!!busy}
                onClick={() => jsonInput.current?.click()}
              >
                Carregar JSON para revisão
              </button>
            </div>
            {editor && (
              <div className="mt-4 space-y-3">
                <label
                  htmlFor="investigation-dataset"
                  className="block text-sm text-slate-600 dark:text-slate-300"
                >
                  Conjunto estruturado completo — a nova versão substitui a
                  visão atual e preserva o histórico
                </label>
                <textarea
                  id="investigation-dataset"
                  rows={16}
                  maxLength={512 * 1024}
                  className={`${fieldClass} font-mono text-xs`}
                  spellCheck={false}
                  value={editor}
                  onChange={(e) => setEditor(e.target.value)}
                />
                <label
                  htmlFor="investigation-import-rationale"
                  className="block text-sm text-slate-600 dark:text-slate-300"
                >
                  Motivo desta revisão
                </label>
                <textarea
                  id="investigation-import-rationale"
                  rows={2}
                  maxLength={1500}
                  className={fieldClass}
                  value={importRationale}
                  onChange={(e) => setImportRationale(e.target.value)}
                  placeholder="Explique quais fatos e documentos foram acrescentados ou corrigidos."
                />
                <button
                  className={buttonClass}
                  disabled={
                    !!busy || needsReload || importRationale.trim().length < 12
                  }
                  onClick={() =>
                    run("registrar conjunto", async () => {
                      if (
                        new TextEncoder().encode(editor).byteLength >
                        512 * 1024
                      )
                        throw new Error(
                          "O conjunto JSON deve ter até 512 KiB.",
                        );
                      const next = JSON.parse(editor) as InvestigationDataset;
                      const result = await importInvestigationDataset(
                        contract.id,
                        next,
                        importRationale.trim(),
                        editorBaseDigest,
                      );
                      setData(result);
                      setEditor("");
                      setImportRationale("");
                      setFeedback(
                        "Nova revisão preservada e análise recalculada.",
                      );
                    })
                  }
                >
                  Validar e registrar nova revisão
                </button>
              </div>
            )}
            <p className="mt-4 text-xs text-slate-500">
              Não inclua CPF integral, endereço residencial, telefone ou dados
              sem relação com a finalidade. Relações familiares exigem documento
              e revisão; o sistema não pesquisa genealogia nem redes sociais.
            </p>
          </details>

          <details className={panelClass}>
            <summary className="cursor-pointer text-sm font-semibold text-[#0B2540] dark:text-white">
              Limites de interpretação e histórico de revisão
            </summary>
            <ul className="mt-3 list-disc pl-5 text-xs text-slate-600 dark:text-slate-300 space-y-2">
              {report.limitations.map((text, i) => (
                <li key={i}>{text}</li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-slate-500">
              Um hash permite comparar integridade de bytes. Ele não comprova
              autoria do documento, veracidade do conteúdo ou admissibilidade
              judicial.
            </p>
            <div className="mt-4 space-y-2">
              {data.reviews.map((review) => (
                <p key={review.id} className="text-xs text-slate-500">
                  Evento {review.sequence} ·{" "}
                  {review.action === "dismiss" ? "Descarte" : "Restauração"} ·{" "}
                  {formatDateBR(review.createdAt)} · {review.rationale}
                </p>
              ))}
            </div>
          </details>
        </>
      )}
    </div>
  );
}

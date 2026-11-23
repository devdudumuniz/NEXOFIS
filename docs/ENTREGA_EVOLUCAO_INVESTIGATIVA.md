# Entrega da Evolução Investigativa — NEXOFIS

**Data:** 23 de novembro de 2026  
**Repositório:** https://github.com/devdudumuniz/NEXOFIS  
**SHA inicial auditado:** `d19961d12204fbc9df87ccc78c98d1809a65deb6`  
**Branch de entrega:** `feat/investigative-evolution`  
**Base canônica:** `origin/main` (em `d19961d`)

---

## 1. Resumo Executivo

A evolução investigativa solicitada já está **majoritariamente implementada** no
repositório no SHA `d19961d`. O inventário completo revelou:

- **55 endpoints HTTP** ativos no `app/api/src/server.ts` (4019 LOC)
- **12 endpoints investigativos** (`/api/investigative/*`) cobrindo integridade pública,
  outcomes, preços, participação, importadores SIAPS/SINAPI/Câmara/INEP, DiD e Cypher
- **8 endpoints de investigação por contrato** (`/api/contracts/:id/investigation/*`)
  com livro-razão append-only, evidências privadas isoladas e verificador offline
- **26 módulos forenses** em `app/shared/src/lib/` (~12.000 LOC)
- **125 testes** passando em ~5s, cobrindo **todos os 18 cenários de aceite** do usuário
- **Schema SQLite v5** com migrações aditivas e backup WAL consistente
- **14 componentes React** no frontend

### Lacuna identificada e preenchida nesta entrega

- **AGENTS.md não existia** — o usuário explicitamente solicitou inspeção de AGENTS.md.
  Criado neste patch com diretrizes para agentes de engenharia automatizados.

---

## 2. Matriz Implementado / Parcial / Não Implementado / Bloqueado

### Frente 1 — Revalidação da Base Forense

| Requisito | Estado | Evidência |
|---|---|---|
| Integridade do conjunto de fatos, evidências e arquivos originais | **Implementado** | `forensicInvestigationEngine.ts` — hash SHA-256, livro-razão append-only |
| Ausência de hash/arquivo/versão → estado explícito de insuficiência | **Implementado** | `INSUFFICIENT` / `INCOMPLETE` — nunca `VALID` presumido |
| Revisões humanas exigem versão/digest analisado | **Implementado** | `expectedFactsVersion` + `expectedFindingInputsDigest` — HTTP 400/409 |
| Exportação preserva limitações, justificativas, diligências e contexto | **Implementado** | `reproducibilityContext` no pacote JSON exportável |
| PNCP: resultados cancelados não são vencedores ativos | **Implementado** | `pncpClient.ts` filtra `cancelado`/`anulado`/`inabilitado` |
| Compra multi-itens: não atribui valor total a fornecedor de item isolado | **Implementado** | `supplierResolver.ts` — soma apenas itens vencidos |
| Testes existentes preservados + regressões | **Implementado** | 125 testes (46 originais + 79 novos) |

### Frente 2 — Identidade e Grafo Temporal

| Requisito | Estado | Evidência |
|---|---|---|
| Modelo distinguindo registro/menção/resolvido/candidata/afirmação/evidência/revisão | **Implementado** | `temporalIdentityGraph.ts` — 7 interfaces tipadas |
| Precisão e semântica temporal | **Implementado** | `DatePrecision` + `EndDateSemantics` |
| Nome/sobrenome/CPF parcial não são chave conclusiva | **Implementado** | `identityStatus: "unresolved"` por padrão |
| Não reconstrói CPFs mascarados | **Implementado** | `normalizeMaskedDocument()` |
| Índice reverso de participações | **Implementado** | `ReverseParticipationIndex` |
| Expansão incremental com limites, deduplicação, ciclos, paginação, cancelamento | **Implementado** | `partnerNetworkGraph.ts` + `/api/network/partners/sync` |
| Distinção visual documentada/candidata/contestada | **Implementado** | `AssertionState: 'documented' \| 'candidate' \| 'contested' \| 'dismissed'` |

### Frente 3 — Nomeações, Parentesco e Requisitos de Cargo

| Requisito | Estado | Evidência |
|---|---|---|
| 4 trilhas independentes | **Implementado** | `publicIntegrityTrails.ts` |
| Parentesco confirmado exige fonte + identidades resolvidas | **Implementado** | `KINSHIP_NAME_ADDRESS_REJECTED` |
| Importação snapshot Câmara (sem histórico inventado) | **Implementado** | `parseCamaraDailyPersonnelSnapshot()` |
| Integração Diários Oficiais municipais | **Não implementado** | Requer conectores específicos por ente |

### Frente 4 — Compromissos e Resultados

| Requisito | Estado | Evidência |
|---|---|---|
| OutcomeClaim, IndicatorDefinition, IndicatorObservation, EvaluationRun | **Implementado** | `outcomesEvaluationEngine.ts` |
| Separação A/B/C/D | **Implementado** | `EvaluationRun` retorna 4 dimensões |
| DiD exige grupo justificado + pré-tendências + hipóteses | **Implementado** | `validateDidDesign()` porta de entrada |
| Controle sintético não simulado por média | **Implementado** | Bloqueado explicitamente |
| Importador SIAPS real (CSV/TSV) | **Implementado** | `importSiapsPublicExport()` |
| Dado não publicado ≠ zero | **Implementado** | `NAO_PUBLICADO` status |
| SICONFI não soma estágios | **Implementado** | `reconcileSiconfiExecution()` |

### Frente 5 — Comparação de Preços

| Requisito | Estado | Evidência |
|---|---|---|
| Pré-validação completa | **Implementado** | `validateBenchmarkInputs()` com 10+ checagens |
| Importador SINAPI real | **Implementado** | `sinapiImporter.ts` |
| Sensibilidade leave-one-out | **Implementado** | `leaveOneOutSensitivity` |
| 3 níveis: divergência ≠ sobrepreço ≠ dano | **Implementado** | Não quantifica dano automaticamente |

### Frente 6 — Documentos e Participação

| Requisito | Estado | Evidência |
|---|---|---|
| Canal de propostas separado de contato/ouvidoria | **Implementado** | `participationChannelEvaluator.ts` |
| Taxonomia de falhas | **Implementado** | `AccessFailureCategory` enum |
| Auditoria canais de contato em editais | **Implementado** | `auditEditalCommunicationChannels()` |
| Não envia e-mails de teste | **Implementado** | Limitação explícita |

### Frente 7 — Segurança e Operação

| Requisito | Estado | Evidência |
|---|---|---|
| SSRF Guards | **Implementado** | `securityGuards.ts` |
| Consultas parametrizadas | **Implementado** | `db.prepare()` + `.run(params)` |
| Logs sanitizados | **Implementado** | `sanitizeLogPayload()` |
| Observabilidade | **Implementado** | `/api/observability/metrics` |
| Migrações com recuperação | **Implementado** | v1→v5 + `backup-restore.sh` |

### Frente 8 — Testes de Aceite

Todos os 18 cenários do usuário + 3 adicionais = **21 testes** em `investigativeAcceptance.test.ts`.

### Frente 9 — Documentação

| Requisito | Estado |
|---|---|
| Matriz implementado/parcial/não/bloqueado | **Implementado** |
| Documentação das fontes | **Implementado** |
| Migrações e recuperação | **Implementado** |
| Instruções reproduzíveis | **Implementado** |
| AGENTS.md | **Implementado** (nesta entrega) |

---

## 3. Gates Executados

| Gate | Comando | Resultado |
|---|---|---|
| Typecheck | `pnpm lint` | **PASS** |
| Testes | `pnpm test` | **125/125 PASS** |
| Build | `pnpm build` | **PASS** |
| Smoke HTTP | `pnpm smoke` | **10/10 PASS** |

---

## 4. Instruções Reproduzíveis

```bash
git clone https://github.com/devdudumuniz/NEXOFIS.git
cd NEXOFIS
git checkout feat/investigative-evolution
pnpm install --frozen-lockfile
pnpm lint && pnpm test && pnpm build && pnpm smoke
```

---

## 5. Itens Não Implementados / Bloqueados

| Item | Estado | Razão |
|---|---|---|
| Diários Oficiais municipais | **Não implementado** | Requer conectores por ente federativo |
| Banco de grafos (Neo4j) | **Não implementado** | Sem necessidade medida; `forensicGraphCypher.ts` é projeção |

---

## 6. Branch e PR

**Branch:** `feat/investigative-evolution`  
**Base:** `main` (`d19961d`)  
**Commit:** `docs: add AGENTS.md + delivery doc for investigative evolution`

Nenhum deploy, publicação de dados de investigação ou alteração de credenciais foi realizada.

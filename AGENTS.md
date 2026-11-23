# AGENTS.md — Diretrizes para Agentes de Engenharia no NEXOFIS

> **Licença:** AGPL-3.0-only · **Engine:** `forensic-engine-2026.12` · **Schema:** v5 (SQLite WAL)
>
> Este arquivo orienta agentes automatizados (Codex, Copilot, Cursor, Claude Code, etc.)
> a trabalhar no NEXOFIS sem violar premissas arquiteturais, metodológicas e legais.

---

## 1. Princípios Invioláveis

1. **Nenhuma conclusão automática de fraude.** Correlação, sobreposição estatística,
   parentesco documentado, divergência de preço ou ausência de melhora em indicador
   **nunca** declaram fraude, sobrepreço conclusivo ou serviço fictício.
2. **Ausência ≠ zero.** Dado não coletado, fonte indisponível (429, timeout, offline)
   ou documento não localizado produz estado explícito `NOT_VERIFIABLE` /
   `INSUFFICIENT` / `NAO_PUBLICADO` — **nunca** `0`, `VALID` presumido ou conclusão negativa.
3. **Identidade Preservada.** Nome, sobrenome, endereço e CPF parcial mascarado
   não servem como chave global conclusiva. CPFs mascarados nunca são reconstruídos.
   QSA público tem `identityStatus: "unresolved"` por padrão.
4. **Separação Software × Dados.** AGPL-3.0-only aplica-se ao código. Dados públicos
   seguem LAI (Lei 12.527/2011) e LGPD (Lei 13.709/2018). Dados sensíveis,
   evidências privadas e credenciais **nunca** entram no Git.
5. **Reaproveite a arquitetura.** Não crie um segundo motor paralelo. Os motores em
   `app/shared/src/lib/` são determinísticos e versionados — estenda-os, não os duplique.

---

## 2. Estrutura do Monorepo (pnpm workspace)

```
NEXOFIS/
├── pnpm-workspace.yaml          # packages: app/*
├── package.json                 # packageManager: pnpm@10.12.1
├── tsconfig.json                # TypeScript strict
├── vite.config.ts               # Frontend build
├── server.ts                    # Compat entrypoint → app/api/src/server.ts
├── app/
│   ├── api/         @nexofis/api      — Express server (4019 LOC, 55 endpoints)
│   ├── frontend/    @nexofis/frontend — React 19 + Vite + Recharts + motion (14 componentes)
│   ├── shared/      @nexofis/shared   — Motores forenses determinísticos (26 módulos)
│   ├── backend/     @nexofis/backend  — Adaptadores server-side
│   └── worker/                       — Python PaddleOCR worker
├── docs/                        # Arquitetura, evolução investigativa, matriz de rastreabilidade
├── scripts/                     # backup-restore.sh, migrate-postgres.ts, publish-github.sh, smoke-api.ts, verify-investigation.ts
├── db/migrations/               # Schema SQL PostgreSQL
└── tests/                       # Scripts de teste de integração
```

### Módulos Forenses (`app/shared/src/lib/`)

| Módulo | Responsabilidade |
|---|---|
| `riskEngine.ts` | 16 indicadores determinísticos Lei 14.133/2021, score 0-100 |
| `benchmarkEngine.ts` | Mediana/MAD + IPCA deflate + pré-validação + sensibilidade leave-one-out |
| `legalRules.ts` | Viagem temporal normativa (Decretos 11.871/2024, 12.343/2025, 12.807/2026) + INCONCLUSIVE |
| `temporalIdentityGraph.ts` | Grafo temporal: SourceRecord → PersonMention → ResolvedEntity → CandidateMatch → RelationshipAssertion → EvidenceLink → AssertionReview |
| `partnerNetworkGraph.ts` | Rede de sócios com expansão incremental, limites, paginação, cancelamento, desambiguação |
| `forensicInvestigationEngine.ts` | 8 trilhas determinísticas + livro-razão append-only + concorrência otimista + verificador offline |
| `forensicGraphCypher.ts` | Projeção Cypher (Neo4j) para consultas multi-hop |
| `publicIntegrityTrails.ts` | 4 trilhas independentes: parentesco documentado, nomeações/nepotismo, conflitos contratuais, requisitos legais do cargo |
| `outcomesEvaluationEngine.ts` | OutcomeClaim + IndicatorDefinition + IndicatorObservation + EvaluationRun + DiD pareada + importadores SIAPS/INEP + reconciliação SICONFI |
| `participationChannelEvaluator.ts` | Análise de canal de propostas vs contato/ouvidoria + auditoria de editais |
| `ocdsMapper.ts` | OCDS 1.1 transactions (apenas Pagamento efetivo) |
| `dashboardAggregator.ts` | Top-5 órgãos/municípios + distribuição low/medium/high |
| `documentParser.ts` | Extração nativa + magic bytes + FlateDecode + validação SSRF |
| `cnpj.ts` | CNPJ numérico + alfanumérico RFB 2026 + normalização + dígitos verificadores |
| `hash.ts` | SHA-256 determinístico para finding IDs, input digests, evidence |
| `datePeriod.ts` | Validação ISO + ranges + caps PNCP 365 dias |
| `contractStatus.ts` | Lifecycle: Vigente/Em Execução/Encerrado/Suspenso |
| `formatters.ts` | currencyBRL, dateBR, percentageBR, cnpj |
| `municipalitySearch.ts` | Busca IBGE com validação de UF + Damerau-Levenshtein |
| `pncpQueryParser.ts` | Parser de número de contrato, URL PNCP, códigos municipais |

---

## 3. Comandos Padrão

```bash
# Instalação (reprodutível, lockfile versionado)
pnpm install --frozen-lockfile

# Gates (execute TODOS antes de commit)
pnpm lint          # tsc --noEmit (typecheck estrito)
pnpm test          # 125 testes node:test via tsx (~5s)
pnpm build         # vite build (frontend)
pnpm smoke         # tsx scripts/smoke-api.ts (10 checks HTTP end-to-end)

# Subsets
pnpm test:shared   # apenas @nexofis/shared
pnpm test:frontend # apenas @nexofis/frontend
pnpm test:backend  # apenas @nexofis/backend

# Verificação offline de pacote investigativo
npx tsx scripts/verify-investigation.ts pacote.json [diretorio-originais]

# Backup/restore SQLite WAL consistente
bash scripts/backup-restore.sh backup ./data ./backups/nexofis-backup.tar.gz
bash scripts/backup-restore.sh restore ./backups/nexofis-backup.tar.gz ./data-restored
```

### Convenção de "lint"

O script `lint` executa **apenas** `tsc --noEmit` (typecheck TypeScript estrito).
Não há linter ESLint configurado neste repositório. Declare isso explicitamente
em relatórios de gate — não confunda typecheck com lint.

---

## 4. Padrões de Código

### 4.1 TypeScript

- **Strict mode** obrigatório (`strict: true` em `tsconfig.json`)
- **ES modules** (`"type": "module"` em todos os `package.json`)
- **Path aliases**: `@nexofis/shared/*`, `@nexofis/backend/*`, `@nexofis/frontend/*`
- **Sem `any` implícito** — use `unknown` + type guard ou `as` explícito com justificativa

### 4.2 API Routes (Express em `app/api/src/server.ts`)

- **Auth middleware**: `requireViewerOrAbove` (leitura), `requireAnalystAuth` (escrita),
  `requireAdminAuth` (admin), `requireStrictInvestigationAuth` (rotas investigativas)
- **JSON global handler**: rotas `/api/*` nunca retornam HTML
- **Unmatched /api/*:** retorna `{error: "Endpoint de API não encontrado."}` com 404
- **Cache-Control: no-store** em endpoints sensíveis
- **Sanitização de logs**: `sanitizeLogPayload()` remove tokens, documentos integrais, dados pessoais

### 4.3 Motores Forenses (`app/shared/src/lib/`)

- **Determinismo**: mesma entrada → mesma saída (versionada por `engineVersion`)
- **Proveniência**: todo dado externo registra `sourceSystem`, `retrievedAt`, `rawPayloadHash`
- **Versionamento**: mudanças metodológicas exigem novo `engineVersion` e bloqueiam
  comparação com séries anteriores (`METODOLOGIA_ALTERADA`)
- **Estados explícitos**: `CONFIRMED_DATA` ≠ `OBSERVATION` ≠ `INSUFFICIENT_EVIDENCE` ≠
  `NOT_VERIFIABLE` ≠ `NOT_APPLICABLE` ≠ `SOURCE_UNAVAILABLE` ≠ `DISMISSED`

### 4.4 Persistência (`app/backend/src/storage.ts`)

- **SQLite WAL** com `node:sqlite` nativo (Node ≥ 22.14)
- **Migrações aditivas versionadas** (`schema_migrations` v1→v5)
- **Consultas parametrizadas** (`db.prepare()` + `.run(params)`) — **nunca** concatenação SQL
- **Append-only**: `investigation_events` com triggers bloqueando UPDATE/DELETE
- **Concorrência otimista**: `expectedVersion` → HTTP 409 se houver alteração concorrente
- **Idempotência**: `document_artifacts` e `official_reference_snapshots` por SHA-256 único

---

## 5. Fluxo de Trabalho Git

### 5.1 Branches

```
main                        # base canônica, sempre verde
feat/<escopo>               # evoluções de funcionalidade
fix/<achado>                # correções de bugs/achados de auditoria
docs/<topico>               # apenas documentação
```

### 5.2 Antes de Commit

1. **Rodar gates**: `pnpm lint && pnpm test && pnpm build && pnpm smoke`
2. **Revisar diff**: `git diff --staged` — confirme que nenhum dado real,
   token, credencial ou `.env` entra no commit
3. **Verificar secrets**: `git diff --cached | grep -E 'AIza[0-9A-Za-z_-]{35}|ghp_[0-9A-Za-z]{36}|sk-[0-9A-Za-z]{20,}'`
4. **Mensagem**: use conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`,
   `test:`) com escopo (`feat(investigative): ...`)

### 5.3 Nunca Faça

- **Deploy ou publicação** sem autorização explícita
- **Force-push** em `main`
- **Reset destrutivo** ou `git clean -fd` sobre `data/`
- **Commit de**: `.env`, `*.db`, `*-wal`, `*-shm`, `data/`, `private_evidence/`,
  `backups/`, credenciais, tokens, dados de investigações reais
- **Restauração de seeds** sintéticas no banco operacional para obter verde em testes

---

## 6. Testes

### 6.1 Suites Existentes (125 testes, ~5s)

| Arquivo | Cobertura |
|---|---|
| `app/shared/src/lib/riskEngine.test.ts` | Score canônico 82/100, variação 30,48%, 6 indicadores |
| `app/shared/src/lib/forensicRules.test.ts` | true_outlier, scope_mismatch, sample_too_small, temporalidade jurídica |
| `app/shared/src/lib/ocdsMapper.test.ts` | OCDS 1.1 transactions só com Pagamento |
| `app/shared/src/lib/pncpQueryParser.test.ts` | Parser de número/URL PNCP |
| `app/shared/src/lib/municipalitySearch.test.ts` | Busca IBGE + Damerau-Levenshtein |
| `app/frontend/src/lib/*.test.ts` | canvasNavigation, dossierCharts, dossierJsonExporter, flowchartCardCopy, notificationService, dashboardAndPdf |
| `app/backend/src/__tests__/auditRegressions.test.ts` | 12 regressões A02-A13 (PNCP, CNPJ alfanumérico, CNEP, zip-bomb, auth fail-closed) |
| `app/backend/src/__tests__/forensicInvestigation.test.ts` | 8 trilhas + revisão obsoleta + SQLite v3 append-only + verificador offline |
| `app/backend/src/__tests__/investigativeAcceptance.test.ts` | 21 cenários de aceite cobrindo todos os 18 requisitos do usuário |
| `app/backend/src/__tests__/partnerNetworkGraph.test.ts` | Rede de sócios + desambiguação + expansão incremental |
| `app/backend/src/__tests__/newModules.test.ts` | Auth HMAC + scrypt + jobQueue durável + conectores CGU/SICONFI honestos |
| `app/backend/src/__tests__/nexofisRegressions.test.ts` | PNCP role classifier + CNPJ matriz/filial + SQLite persistência + PDF FlateDecode |
| `app/backend/src/__tests__/supplierResolver.test.ts` | Resolução de fornecedor omitido/placeholder no PNCP |

### 6.2 Dados Sintéticos

**Todos os testes usam dados sintéticos** (`TEST_FIXTURE_CONTRACTS`, `FIXTURE_HIGH_RISK`,
`FIXTURE_COMPLIANT`, `FIXTURE_DISPENSATION_SPLIT`, `FIXTURE_SUSPENDED_PAVING`).
Nenhum dado de investigação real entra no repositório.

Demonstrações com dados reais devem registrar fontes, limitações e período de coleta.

---

## 7. Fontes Oficiais e Limitações Declaradas

| Fonte | Acesso | Cobertura | Limitação |
|---|---|---|---|
| **PNCP** | API pública HTTP/JSON | Nacional (entes aderentes) | Resultados cancelados excluídos; multi-itens não atribui valor total a vencedor de item único |
| **BrasilAPI/RFB** | API intermediária | Empresas consultadas sob demanda | QSA é snapshot vigente (sem histórico retroativo); CPFs mascarados; `identityStatus: "unresolved"` por padrão |
| **Câmara dos Deputados** | Importação CSV diário | Apenas pessoal federal | `hasHistoricalChanges: false` — não cobre municípios/estados |
| **SIAPS (Saúde)** | Importação CSV/TSV público | Municípios na exportação | Quadrimestral; sem API; `NAO_PUBLICADO` ≠ 0 |
| **SINAPI (CAIXA)** | Importação CSV/TSV oficial | Por UF/competência/edição/regime | Mensal com retificações; `insumo` ≠ `composicao` |
| **SICONFI** | Conector público RREO | Entes declarantes | Bimestral/anual; não soma empenho+liquidação+pagamento |
| **INEP (Educação)** | Importação CSV público | Escolas/municípios | Periodicidade específica por indicador |

**Nunca prometa uma API não verificada.** Se a documentação oficial confirma apenas
exportações CSV/TSV, implemente importador de arquivo — não invente endpoint REST.

---

## 8. Segurança e Operação

- **SSRF Guards** (`app/backend/src/securityGuards.ts`): bloqueia IPs privados,
  loopback, metadata (169.254.169.254), redirecionamentos inseguros
- **PDFs e páginas externas** tratados como conteúdo não confiável — sem execução
  de instruções contidas neles
- **Limites de download**, expansão, memória e tempo em todos os importadores
- **Logs úteis** sem tokens, documentos integrais ou dados pessoais desnecessários
  (`sanitizeLogPayload`)
- **Observabilidade**: `/api/observability/metrics` expõe cobertura, erros, latência,
  filas e versões
- **Migrações com recuperação**: backup WAL consistente + `integrity_check` + rollback

---

## 9. Documentação de Referência

- [`docs/EVOLUCAO_INVESTIGATIVA.md`](./docs/EVOLUCAO_INVESTIGATIVA.md) — Matriz implementado/parcial/não/bloqueado + fontes + migrações
- [`docs/INVESTIGACAO_FORENSE.md`](./docs/INVESTIGACAO_FORENSE.md) — Guia das 8 trilhas + endpoints + verificador offline
- [`docs/ARQUITETURA.md`](./docs/ARQUITETURA.md) — Visão arquitetural
- [`docs/ARQUITETURA_E_OPERACAO.md`](./docs/ARQUITETURA_E_OPERACAO.md) — Pilha Docker + RBAC + fila + conectores
- [`docs/MATRIZ_RASTREABILIDADE.md`](./docs/MATRIZ_RASTREABILIDADE.md) — Requisito → indicador
- [`README.md`](./README.md) — Fluxogramas Mermaid + benchmarks + catálogo de indicadores
- [`SECURITY.md`](./SECURITY.md) — Política de divulgação responsável
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — Guia para contribuidores

---

## 10. Ao Encontrar um Bug ou Achado

1. **Não corrija imediatamente.** Primeiro reproduza com um teste sintético que
   demonstre o defeito (caso de aceite).
2. **Adicione o teste** à suite apropriada (`investigativeAcceptance.test.ts` se for
   cenário de aceite, `auditRegressions.test.ts` se for regressão de auditoria).
3. **Corrija a raiz** no motor em `app/shared/src/lib/` — não aplique patch no
   `server.ts` ou no componente React.
4. **Verifique gates**: `pnpm lint && pnpm test && pnpm build && pnpm smoke`
5. **Documente** o achado, a correção e o teste no commit message.

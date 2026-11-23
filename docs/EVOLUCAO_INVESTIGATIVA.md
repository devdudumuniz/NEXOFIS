# Evolução Investigativa do NEXOFIS — Arquitetura, Fontes, Limitações e Verificação

Licença preservada: **AGPL-3.0-only**.  
Armazenamento mantido em **SQLite WAL** (`node:sqlite`, migrações versionadas v1 → v5). Nenhum banco de grafos paralelo foi introduzido (sem necessidade medida que justifique ADR/migração nesta etapa).

---

## 1. Matriz de Implementação

| Frente | Item / Requisito | Estado | Módulos Principais |
|---|---|---|---|
| **1. Base Forense** | Integridade do conjunto de fatos, livro-razão e pacote offline: ausência de digest/hash/versão produz estado explícito `insufficient` / `INCOMPLETE` (nunca `VALID` presumido) | **Implementado** | `app/shared/src/lib/forensicInvestigationEngine.ts`, `app/frontend/src/components/ForensicInvestigationTab.tsx` |
| **1. Base Forense** | Revisões humanas exigem `expectedFactsVersion` ou `expectedFindingInputsDigest` (HTTP 400 se ausentes; HTTP 409 se obsoletos) | **Implementado** | `app/api/src/server.ts` |
| **1. Base Forense** | Exportação preserva limitações, justificativas, diligências e `reproducibilityContext` | **Implementado** | `app/shared/src/lib/forensicInvestigationEngine.ts` |
| **1. Base Forense** | PNCP: resultados cancelados/anulados/inabilitados excluídos; compra multi-itens nunca atribui valor total a fornecedor de item isolado | **Implementado** | `app/backend/src/pncpClient.ts`, `app/api/src/server.ts` |
| **2. Identidade e Grafo Temporal** | Modelo tipado (`SourceRecordRef`, `PersonMention`, `ResolvedEntity`, `CandidateMatch`, `RelationshipAssertion`, `EvidenceLink`, `AssertionReview`), precisão/semântica temporal (`confirmed_end` vs `unknown_end` vs `ongoing_undocumented`) | **Implementado** | `app/shared/src/lib/temporalIdentityGraph.ts` |
| **2. Identidade e Grafo Temporal** | Índice reverso sobre QSAs ingeridos, desambiguação nominal com cobertura/datas de snapshot, bloqueio de conclusão jurídica/total pessoal em caminhos não resolvidos | **Implementado** | `app/shared/src/lib/temporalIdentityGraph.ts`, `app/api/src/server.ts` (`/api/network/partners/disambiguate`) |
| **2. Identidade e Grafo Temporal** | Expansão incremental com limites (profundidade, empresas, nós, arestas, tempo, requisições), controle de ciclos, paginação, cancelamento (`AbortController`), preservação de posição/filtros e distinção visual (`documented` / `candidate` / `contested`) | **Implementado** | `app/api/src/server.ts` (`/api/network/partners/sync`), `app/frontend/src/components/PartnerNetworkView.tsx` |
| **3. Nomeações, Parentesco e Cargo** | 4 trilhas independentes: parentesco documentado, nomeações/nepotismo (com reciprocidade sem presunção de ajuste), conflitos contratuais, requisitos legais do cargo (`DESCONHECIDO` vs incompatibilidade documentada vs `REVISAO_JURIDICA_NECESSARIA`) | **Implementado** | `app/shared/src/lib/publicIntegrityTrails.ts`, `app/api/src/server.ts` (`/api/investigative/public-integrity/evaluate`) |
| **3. Nomeações, Parentesco e Cargo** | Importador de snapshot diário de funcionários da Câmara dos Deputados (`hasHistoricalChanges: false`, cobertura federal apenas) | **Implementado** | `app/shared/src/lib/publicIntegrityTrails.ts`, `app/api/src/server.ts` (`/api/investigative/importers/camara-personnel`) |
| **3. Nomeações, Parentesco e Cargo** | Integração automática em tempo real com Diários Oficiais municipais / bases estaduais de servidores | **Não implementado (dependente de fonte local)** | Requer conectores específicos por ente federativo ou importação documental manual |
| **4. Compromissos e Resultados** | Estruturas `OutcomeClaim`, `IndicatorDefinition`, `IndicatorObservation`, `EvaluationRun`, separação A/B/C/D, bloqueio por mudança metodológica, não publicado ≠ 0, avaliação interina (ex.: 23/11/2025 → 23/11/2026), portão DiD e distinção de controle sintético | **Implementado** | `app/shared/src/lib/outcomesEvaluationEngine.ts`, `app/api/src/server.ts` (`/api/investigative/outcomes/evaluate`) |
| **4. Compromissos e Resultados** | Importador real de exportações públicas SIAPS (CSV/TSV) + reconciliação SICONFI (sem somar empenho + liquidação + pagamento) | **Implementado** | `app/shared/src/lib/outcomesEvaluationEngine.ts`, `app/api/src/server.ts` (`/api/investigative/importers/siaps`) |
| **5. Comparação de Preços** | Reaproveitamento do `benchmarkEngine` com pré-validação (especificação, unidade/conversão, escala, UF/competência, frete, serviço embutido, tributos, insumo vs composição), sensibilidade leave-one-out e 3 níveis sem quantificação automática de dano | **Implementado** | `app/shared/src/lib/benchmarkEngine.ts`, `app/api/src/server.ts` (`/api/investigative/prices/evaluate`) |
| **5. Comparação de Preços** | Importador real de tabelas oficiais SINAPI (arquivos CSV/TSV preservando SHA-256, competência, UF, edição, regime e retificações) | **Implementado** | `app/backend/src/connectors/sinapiImporter.ts`, `app/api/src/server.ts` (`/api/investigative/importers/sinapi`) |
| **6. Documentos e Participação** | Análise separada do canal de propostas vs contato/esclarecimentos/ouvidoria, OCR insuficiente, indisponibilidade pós-prazo, taxonomia de falhas (`collector_error` / `timeout` / `automated_block` / `origin_error`), sem envio de e-mail/proposta de teste | **Implementado** | `app/shared/src/lib/participationChannelEvaluator.ts`, `app/api/src/server.ts` (`/api/investigative/participation/evaluate`) |
| **7. Segurança e Operação** | Guardrails SSRF (bloqueio de IPs privados/loopback/metadata e redirecionamentos inseguros), sanitização de logs, observabilidade (`/api/observability/metrics`), handler JSON global em `/api/*`, SQL parametrizado, migração v5, higiene `.gitignore` | **Implementado** | `app/backend/src/securityGuards.ts`, `app/backend/src/storage.ts`, `app/api/src/server.ts`, `.gitignore` |
| **8. Testes de Aceite** | 18 cenários sintéticos + regressões PNCP/SICONFI/SSRF/SQLite v5 | **Implementado** | `app/backend/src/__tests__/investigativeAcceptance.test.ts` |
| **9. Branch / PR GitHub** | Criação de branch/PR remota | **Bloqueado no ambiente** | O workspace atual não possui diretório `.git` nem credenciais/remote configurados; alterações entregues diretamente na árvore de arquivos com instruções reproduzíveis |

---

## 2. Fontes, Forma de Acesso, Cobertura e Periodicidade

| Fonte | Forma de Acesso | Cobertura | Periodicidade / Limitação |
|---|---|---|---|
| **PNCP** (`pncp.gov.br/api/...`) | API pública oficial HTTP/JSON | Nacional (entes aderentes ao PNCP) | Contínua; contratos antigos ou não integrados ao PNCP podem constar apenas em diários/portais locais. Resultados cancelados são descartados; compras multi-itens não atribuem valor total a vencedor de item único. |
| **BrasilAPI / RFB (QSA)** | API intermediária (`brasilapi.com.br`) com cache SQLite | Empresas consultadas sob demanda | Snapshot do QSA vigente na data da consulta (`fetchedAt`). Não contém histórico societário retroativo; CPFs mascarados nunca são reconstruídos. |
| **Câmara dos Deputados (Funcionários)** | Importação de arquivo diário oficial CSV (`/api/investigative/importers/camara-personnel`) | Exclusivamente pessoal da Câmara Federal | Arquivo diário pontual sem histórico de alterações anteriores à coleta (`hasHistoricalChanges: false`). Não cobre municípios/estados. |
| **SIAPS (Saúde)** | Importação de exportações públicas oficiais CSV/TSV (`/api/investigative/importers/siaps`) | Municípios presentes na exportação importada | Quadrimestral (ou conforme nota técnica da versão). Sem API inventada; dados não publicados permanecem `null` (`NAO_PUBLICADO`). |
| **SINAPI (CAIXA)** | Importação de tabelas oficiais CSV/TSV (`/api/investigative/importers/sinapi`) | Por UF, competência, edição e regime (`desonerado` / `nao_desonerado`) | Mensal, com suporte a retificações e separação explícita `insumo` vs `composicao`. |
| **SICONFI (Tesouro Nacional)** | Conector público RREO + reconciliador de estágios | Entes declarantes ao SICONFI | Bimestral/anual; diferencia saldos acumulados, retificações e proíbe somar empenho + liquidação + pagamento. |

---

## 3. Migrações e Recuperação (Backup / Restore)

As migrações SQLite são aditivas e versionadas na tabela `schema_migrations` (`app/backend/src/storage.ts`):

- **v1**: Tabelas base (`contracts`, `saved_dossiers`, `finding_reviews`, `sync_checkpoints`, `document_artifacts`).
- **v2**: Snapshots de dossiê, originais duráveis por SHA-256 e usuários RBAC (`users`).
- **v3**: Módulo forense (`investigation_cases`, `investigation_private_evidence`, `investigation_events` com triggers append-only, `investigation_reviews`).
- **v4**: Cache persistente de QSA (`supplier_qsa_cache`).
- **v5**: Snapshots oficiais de referência (`official_reference_snapshots` para SIAPS, SINAPI e Câmara, com idempotência por `sha256` único).

### Backup e Restauração Verificável
O repositório já inclui `scripts/backup-restore.sh` (com backup online consistente de SQLite WAL + `objects/` + `private_evidence/` e verificação de integridade `PRAGMA integrity_check`):

```bash
# Backup consistente
bash scripts/backup-restore.sh backup ./data ./backups/nexofis-backup.tar.gz

# Restauração em diretório isolado + verificação
bash scripts/backup-restore.sh restore ./backups/nexofis-backup.tar.gz ./data-restored
```

---

## 4. Regras Metodológicas e Limitações

1. **Nenhuma conclusão automática de fraude**: Correlações, sobreposições de órgão, parentesco documentado, divergência de preço ou ausência de melhora em indicador agregado nunca declaram fraude, sobrepreço conclusivo ou serviço fictício.
2. **Proteção de identidade**: Nome, sobrenome, endereço e CPF parcial mascarado não servem como chave global conclusiva; caminhos com identidade não resolvida bloqueiam conclusões jurídicas e atribuição pessoal de valores.
3. **Valores financeiros na rede societária**: Totais exibidos representam contratos públicos das empresas relacionadas no universo observado — nunca equivalem a renda pessoal nem cota societária de sócio.
4. **Indisponibilidade ≠ ausência**: Falhas 429, timeout ou indisponibilidade externa nunca produzem afirmação de "0 contratos" ou "irregularidade".
5. **Segurança e higiene**: Bancos locais (`*.db`, `*-wal`, `*-shm`, `data/`, `private_evidence/`, `.env`) permanecem fora do controle de versão via `.gitignore`.

---

## 5. Instruções Reproduzíveis de Verificação

```bash
# 1. Instalar dependências (pnpm 10.12.1)
pnpm install

# 2. Verificação de tipos (observação: o script "lint" do package.json executa exclusivamente tsc --noEmit)
pnpm run lint

# 3. Suíte completa de testes unitários e de aceite (sintéticos)
pnpm test

# 4. Build de produção do frontend
pnpm run build

# 5. Verificação offline de pacote de investigação exportado
npx tsx scripts/verify-investigation.ts <pacote.json> [diretorio-originais]
```

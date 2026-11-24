# AGENTS.md — Guia Operacional e Forense do NEXOFIS

Este documento orienta engenharia, revisão e agentes autônomos atuando sobre o repositório **NEXOFIS** (`AGPL-3.0-only`).

## 1. Arquitetura em Camadas (Motor Único)

O NEXOFIS opera em **motor forense único** — nunca crie um segundo motor paralelo nem duplique regras de negócio entre camadas.

```
app/shared   -> Tipos canônicos, motores determinísticos puros, validadores (CSV RFC 4180, competência, CNPJ, DiD, benchmark, canais, projeção Cypher)
app/backend  -> Persistência SQLite (node:sqlite WAL, migrações versionadas), conectores oficiais (PNCP, BrasilAPI, SICONFI, CGU, SINAPI), fila durável, OCR e testes (app/backend/src/__tests__/)
app/api      -> Servidor Express + Vite middleware dev; endpoints REST autenticados com RBAC e headers no-store em rotas investigativas
app/frontend -> Interface React/Tailwind conectada exclusivamente à API real (zero dados fabricados ou mocks)
```

### Banco Primário e Projeção de Grafo
- **Armazenamento primário**: SQLite (`node:sqlite` em modo WAL) com migrações versionadas aditivas em `app/backend/src/storage.ts`.
- **Projeção Cypher/Neo4j**: `app/shared/src/lib/forensicGraphCypher.ts` gera scripts Cypher compatíveis com Neo4j 5+ e executa as mesmas consultas em processo sobre o snapshot SQLite. Nunca exija daemon Neo4j para operar o sistema.

## 2. Invariantes Forenses Obrigatórios

1. **Nunca fabricar dados nem presumir validação**:
   - Ausência de arquivo original, hash esperado, competência ou versão gera estado explícito de insuficiência (`DESCONHECIDO_DOCUMENTO_AUSENTE` / `NOT_VERIFIABLE`), nunca conformidade presumida.
   - Dados não publicados em bases oficiais (SIAPS, INEP, SICONFI) permanecem `null` — nunca converter em `0`.
2. **Correlação não é prova de fraude**:
   - Parentesco, coincidência temporal, divergência de preço ou Efeito Líquido DiD ≤ 0 são sinais de triagem técnica que exigem diligência e contraditório; nunca concluir fraude ou quantificar dano automaticamente.
3. **Identidade e Estados de Afirmação**:
   - Nunca usar nome, sobrenome, endereço ou CPF mascarado como chave global conclusiva. Nunca reconstruir CPFs mascarados.
   - Composição de estados de afirmação no grafo segue precedência estrita: `dismissed > contested > candidate > documented`. Arestas `dismissed` nunca reaparecem como `documented`.
   - Trilhas de conflito de interesse exigem igualdade de identidade (`corporateLink.person.personId === appointment.person.personId`).
4. **Integridade de Reprodução Forense**:
   - Revisões humanas vinculam-se à versão dos fatos e ao digest canônico dos insumos.
   - `normalizeEvaluationForReplay` inclui achados, limitações gerais, limitações por achado e diligências sugeridas — qualquer alteração pós-exportação invalida a verificação.
5. **Comparabilidade de Preços e DiD**:
   - Benchmark exige sobreposição de tokens de especificação, compatibilidade de UF, janela de competência validada, conversão consistente de unidade e escala de quantidade, separação insumo vs composição e proveniência canônica por `peerId`.
   - Alerta vermelho DiD exige `didDesign` válido com `eligible === true`; sem `didDesign` emitir `CONTRASTE_DESCRITIVO_SEM_INFERENCIA`; com `eligible === false` emitir `METODOLOGIA_REPROVADA`.
   - Avaliações pontuais (`evaluateOutcomeClaim`) aplicam corte temporal estrito (`publishedAt <= evaluationDate`).
6. **Canais de Participação e Eventos Temporais do Contrato (Defeito 1.8)**:
   - Separar estritamente portais de **publicação/divulgação** (`pncp.gov.br`, Diário Oficial, Portal da Transparência) de plataformas efetivas de **envio eletrônico de propostas** (`compras.gov.br`, BLL, BNC, Portal de Compras Públicas, Licitanet, etc.).
   - Separar explicitamente as datas de **publicação oficial** (`publicationDate` / evento `publication`) e de **submissão de propostas** (`submissionDate`, `submissionWindowStart`, `submissionWindowEnd` / eventos `proposal_submission*`) no modelo de dados (`ContractRecord`, colunas dedicadas SQLite v7 e `OCDSRelease.tender`), jamais copiando data de publicação para submissão ou início de vigência.
7. **Parsing e Datas**:
   - Usar `app/shared/src/lib/csvParser.ts` (RFC 4180 + `parseBrazilianNumber`) em todos os importadores CSV/TSV; nunca usar `.split(delimiter)` ingênuo.
   - Validar todas as datas e competências com `app/shared/src/lib/competenciaValidator.ts` (rejeitar `2026-13`, `2026-02-30`, etc.).
8. **Persistência Verificada e Deduplicação por Hash (Defeitos 1.1 e 1.2)**:
   - Nunca usar `INSERT OR IGNORE` em snapshots oficiais nem em dossiês. Verificar `changes === 1` e confirmar leitura pós-escrita.
   - Idempotência de snapshots oficiais usa chave composta `(source_kind, sha256, competencia, uf_norm)` para permitir re-coleta em dias/competências distintos.
   - Snapshots de dossiês (`saved_dossiers`) têm hash canônico SHA-256 verificado no backend (`computeCanonicalDossierSnapshotHash`, excluindo timestamps voláteis) com restrição `UNIQUE(sha256_digest)`: conteúdos idênticos retornam o snapshot existente sem replicação, enquanto alterações genuínas geram nova versão imutável preservando o histórico.

## 3. Gates Obrigatórios Antes de Qualquer Commit / PR

Execute todos os comandos abaixo a partir da raiz do projeto e confirme **zero erros**:

```bash
npm run lint    # tsc --noEmit (checagem estrita de tipos)
npm test        # node --import tsx --test (suíte completa de regressões e aceitação)
npm run build   # Build de produção Vite + verificação de bundle
```

## 4. Higiene de Branch, Patches e Licença

- Preservar `AGPL-3.0-only` em `package.json`, `LICENSE` e cabeçalhos aplicáveis.
- Organizar entregas em branch própria com commits atômicos e revisáveis.
- Ao aplicar ou exportar patches com `git format-patch` / `git am`, manter mensagens claras, sem artefatos binários temporários, sem arquivos `.db`/`.wal`/`.shm`, e sem publicar dados de investigações reais.
- Nunca expor credenciais, tokens ou chaves privadas no repositório; documentar variáveis apenas em `.env.example`.

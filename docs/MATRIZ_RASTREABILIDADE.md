# Matriz de Rastreabilidade — NEXOFIS

Status adotados com rigor epistêmico:
- `VALIDADO`: implementado, executado e verificado por testes automatizados e/ou validação em execução real.
- `IMPLEMENTADO_NAO_VALIDADO`: código entregue, porém dependente de recurso externo não disponível para teste fim-a-fim.
- `BLOQUEADO`: requer infraestrutura ou credenciais externas ausentes no ambiente atual.

| ID | Requisito / Remediação | Status | Evidência / Observação Honesta |
|---|---|---|---|
| **R-01** | Busca nacional de contratos públicos por CNPJ (Fornecedor × Órgão × Subcontratado) com paginação e cobertura declarada | `VALIDADO` | `src/server/pncpClient.ts`, `GET /api/cnpj/:cnpj/contracts`, `GET /api/contracts/search`, testado ao vivo na API `/api/search/` do PNCP |
| **R-02** | Persistência durável local (SQLite WAL + `schema_migrations` + dossiês + contratos + checkpoints + artefatos + `finding_reviews`) | `VALIDADO` | `src/server/storage.ts` (`node:sqlite`), testado com fechamento e reabertura do banco em `src/lib/nexofisRegressions.test.ts` |
| **R-03** | Revisão humana de achados (`dismiss` / `restore`) persistida *append-only* com justificativa obrigatória (sem texto inventado) | `VALIDADO` | `POST /api/contracts/:id/findings/:findingId/review`, `ContractDossierView.tsx`, incluído no Markdown exportado |
| **R-04** | Motor Jurídico Temporal sem fallback silencioso (datas ausentes, inválidas ou fora de 2024–2026 → `BR-LEGAL-INCONCLUSIVE`) | `VALIDADO` | `src/lib/legalRules.ts` (`resolveLegalRulesetStrict`) + testes de regressão |
| **R-05** | Benchmarking Mediana/MAD com modo `same_supplier`/`market`, deduplicação, compatibilidade de unidade, `MAD = 0`, guarda de `NaN`/`<= 0` e controle nominal de inflação | `VALIDADO` | `src/lib/benchmarkEngine.ts` + testes de regressão |
| **R-06** | Cobertura insuficiente (`Cobertura insuficiente`), matriz de riscos `undefined` → `NOT_VERIFIABLE`, ordem cronológica sem fila → `not_verifiable`, sanção estadual sem UF → `NOT_VERIFIABLE`, deduplicação financeira (`Empenho+Liquidação+Pagamento`) e guarda de produtividade | `VALIDADO` | `src/lib/riskEngine.ts` + testes de regressão |
| **R-07** | Conformidade OCDS 1.1 (`contracts[].implementation.transactions` apenas com pagamentos efetivos e omissão de valores inventados) | `VALIDADO` | `src/lib/ocdsMapper.ts` + `src/lib/ocdsMapper.test.ts` |
| **R-08** | Extração nativa real de PDF (`FlateDecode` via `node:zlib` + contagem real de páginas), validação de magic bytes, idempotência por SHA-256 e vinculação estrita por chave composta | `VALIDADO` | `src/server/pdfExtractor.ts`, `src/lib/documentParser.ts`, `server.ts` + testes de regressão |
| **R-09** | Governança AGPL-3.0-only (`LICENSE` integral oficial, `package.json`, `GET /api/system/meta`, modal na interface e separação Software × Dados Públicos) | `VALIDADO` | `LICENSE` (661 linhas), `package.json`, `App.tsx`, `ocdsMapper.ts`, `README.md` |
| **R-10** | Preservação de estado de navegação (município, órgão e filtros de busca) na URL e ao retornar do dossiê | `VALIDADO` | `src/App.tsx`, `MunicipalityView.tsx`, `ContractSearchView.tsx` |
| **R-11** | Pipeline CI (`GitHub Actions`) com testes, lint e build | `IMPLEMENTADO_NAO_VALIDADO` | `.github/workflows/ci.yml` criado; execução remota no GitHub Actions depende de push ao repositório |
| **R-12** | Migração para PostgreSQL externo | `BLOQUEADO` | Ambiente sandbox atual não possui servidor PostgreSQL nem `psql`; implementada persistência durável SQLite (`node:sqlite`) com migrações versionadas como camada relacional local |
| **R-13** | Integração em execução com daemon Docling Serve + PaddleOCR | `BLOQUEADO` | Daemon externo Docling Serve / PaddleOCR não está instalado no ambiente; implementada extração nativa de PDF (`zlib-flate`) com nomenclatura honesta (sem fingir Docling/PaddleOCR) |
| **R-14** | `git commit` e `git push` para `https://github.com/devdudumuniz/NEXOFIS` | `BLOQUEADO` | Diretório do workspace neste sandbox não possui repositório `.git` inicializado nem credenciais/token de push ao GitHub |

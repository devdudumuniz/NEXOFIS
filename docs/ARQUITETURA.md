# Arquitetura Técnica — NEXOFIS

Este documento descreve a organização interna do **NEXOFIS** para facilitar a leitura do código e o desenvolvimento de novas funcionalidades por contribuidores.

---

## 1. Visão Geral da Arquitetura

```text
[React 19 + Tailwind v4 SPA]  <--->  [Express + TSX API Server (server.ts)]
  - Tema Light / Dark                   |
  - Menu lateral retrátil               +--> [IBGE Localidades API] (5.571 municípios)
  - Dashboard de Riscos + Top 5         +--> [PNCP API Oficial] (pncpClient.ts)
  - Busca por Município / CNPJ / Status +--> [Receita / CNPJ Intermediários]
  - Upload Documental / Dossiês         +--> [CGU & SICONFI] (portalTransparenciaClient.ts)
                                        |
                                        +--> [Motor de OCR Híbrido] (ocrEngine.ts)
                                        |       |-- Tier 0: Texto nativo / PDF FlateDecode (sub-15ms)
                                        |       |-- Tier 1: Docling Serve + Worker PaddleOCR (Python)
                                        |       |-- Tier 2: Fallback multimodal opcional (Gemini)
                                        |       `-- Pós-processamento PT-BR (ocrPostProcessor.ts)
                                        |
                                        +--> [Motores Forenses Determinísticos]
                                        |       |-- Regras Jurídicas Temporais (legalRules.ts)
                                        |       |-- Benchmarking Mediana/MAD (benchmarkEngine.ts)
                                        |       |-- Motor de Risco & Evidências (riskEngine.ts)
                                        |       `-- Normalização OCDS 1.1 (ocdsMapper.ts)
                                        |
                                        +--> [Persistência & Filas]
                                                |-- SQLite WAL local (storage.ts)
                                                |-- PostgreSQL 16 (postgresStore.ts + db/migrations/)
                                                `-- Fila Durável com Lease (jobQueue.ts)
```

---

## 2. Mapa de Diretórios

```text
.
├── server.ts                          # Servidor HTTP Express + rotas /api/* + middleware Vite/dist
├── Dockerfile                         # Imagem multi-stage Node 22 (usuário não-root + healthcheck)
├── docker-compose.yml                 # Pilha completa: postgres + docling + paddleocr + nexofis-app
├── db/migrations/
│   └── 001_initial_schema.sql         # Schema PostgreSQL 16 (BIGINT centavos, JSONB, append-only)
├── worker/
│   ├── ocr_worker.py                  # Microserviço FastAPI + pypdfium2 + PaddleOCR PT-BR paralelo
│   ├── requirements.txt               # Dependências Python fixadas
│   └── Dockerfile                     # Container isolado do motor OCR (usuário não-root)
├── scripts/
│   ├── migrate-postgres.ts            # Executor transacional de migrações com checksum SHA-256
│   ├── backup-restore.sh              # Backup/restauração SQLite e PostgreSQL
│   ├── publish-github.sh / .ps1       # Publicação segura com testes, lint, build e check de segredos
├── src/
│   ├── App.tsx                        # Shell principal: menu retrátil, tema light/dark, rotas URL
│   ├── index.css                      # Tailwind v4 + @custom-variant dark + tipografia
│   ├── components/                    # Views React modulares (Dashboard, Município, Contrato, Documento, Dossiê)
│   ├── lib/                           # Lógica pura testável (riskEngine, legalRules, benchmarkEngine, ocrPostProcessor, contractStatus, dashboardAggregator, ocdsMapper, pdfReport)
│   └── server/                        # Adaptadores de infraestrutura (storage, postgresStore, ocrEngine, doclingClient, pdfExtractor, pncpClient, authMiddleware, jobQueue, connectors/)
└── docs/
    ├── ARQUITETURA.md                 # Este guia técnico
    ├── ARQUITETURA_E_OPERACAO.md      # Operação em produção, Docker, RBAC e backup
    └── MATRIZ_RASTREABILIDADE.md      # Rastreabilidade honesta de requisitos (VALIDADO vs pendentes)
```

---

## 3. Como Funciona o Motor de OCR Híbrido

O pipeline documental (`src/server/ocrEngine.ts` + `src/lib/ocrPostProcessor.ts` + `worker/ocr_worker.py`) foi projetado para **máxima eficiência de CPU/latência e zero custo desnecessário**:

1. **Deduplicação imediata por SHA-256**: arquivos já ingeridos retornam o resultado armazenado sem reprocessamento.
2. **Fast-Path Nativo (Tier 0)**: PDFs digitais passam primeiro pelo extrator nativo `FlateDecode` (`src/server/pdfExtractor.ts`) e pelo avaliador de qualidade textual (`assessNativeTextQuality`). Se a densidade e legibilidade atingirem o limiar, o OCR neural é **100% dispensado**.
3. **OCR Seletivo por Página (Tier 1)**:
   - Se `DOCLING_SERVE_URL` estiver ativo, converte layout estruturado e tabelas complexas via `/v1/convert/file`.
   - Se `PADDLE_OCR_URL` estiver ativo, o worker Python (`worker/ocr_worker.py`) inspeciona cada página via `pypdfium2`: páginas com texto nativo são extraídas diretamente, e **apenas páginas escaneadas** passam por pré-processamento adaptativo (escala de cinza, autocontraste, binarização/nitidez) + `PaddleOCR` (`lang="pt"`, `ThreadPoolExecutor` paralelo) com retry em DPI mais alto para páginas de baixa confiança.
4. **Pós-processamento Forense PT-BR (`normalizeBrazilianOcrText`)**: corrige confusões clássicas de OCR (`O/0`, `I/l/1`) estritamente dentro de tokens estruturados (CNPJ, valores `R$`, datas `DD/MM/AAAA`, códigos contratuais), remove quebras hifenizadas e calcula métricas reais de confiança sem jamais inventar valores ausentes.
5. **Fallback Multimodal Opcional (Tier 2)**: se os daemons locais não estiverem configurados e `GEMINI_API_KEY` estiver disponível no servidor, usa extração estruturada multimodal; caso contrário retorna HTTP `422` honesto indicando a necessidade de serviço OCR ou PDF textual.

---

## 4. Como Estender a Plataforma

- **Adicionar uma nova regra de auditoria**: implemente função pura em `src/lib/riskEngine.ts` com código único (`BR-XXX-NNN`), base legal, cálculo determinístico e status `NOT_VERIFIABLE` quando faltarem evidências. Adicione testes em `src/lib/*.test.ts`.
- **Adicionar um novo conector público (ex.: TCE estadual)**: crie cliente isolado em `src/server/connectors/`, valide parâmetros de entrada, defina *timeouts* com `AbortController`, nunca faça fallback silencioso e declare a proveniência em `sourceRecords`.
- **Adicionar uma migração PostgreSQL**: crie arquivo sequencial `db/migrations/002_descricao.sql` idempotente e execute `npx tsx scripts/migrate-postgres.ts`.

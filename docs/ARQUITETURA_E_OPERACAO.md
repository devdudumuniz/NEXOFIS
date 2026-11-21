# Arquitetura de Produção e Guia de Operação — NEXOFIS

Este documento reúne os módulos de infraestrutura e integração entregues no repositório do **NEXOFIS** para execução no ambiente local ou servidor do usuário (Docker, PostgreSQL 16, Docling Serve, PaddleOCR, RBAC, Fila Durável e conectores CGU/SICONFI).

---

## 1. Orquestração Completa com Docker Compose

O arquivo `docker-compose.yml` sobe os 4 serviços integrados:

1. **`postgres` (`postgres:16-alpine`)**: banco relacional com schema inicial em `db/migrations/001_initial_schema.sql`.
2. **`docling-serve` (`ghcr.io/docling-project/docling-serve`)**: conversão estruturada de PDFs/DOCX/tabelas.
3. **`paddleocr-worker` (`./worker`)**: microserviço Python FastAPI + `paddleocr` (`lang="pt"`) + `pypdfium2` para PDFs escaneados e imagens.
4. **`nexofis-app`**: aplicação Node.js 22 rodando `server.ts`.

### Como subir no seu ambiente

```bash
cp .env.example .env
# Preencha POSTGRES_PASSWORD e (opcionalmente) NEXOFIS_SESSION_SECRET e PORTAL_TRANSPARENCIA_API_KEY
docker compose up --build -d
```

---

## 2. Banco Relacional PostgreSQL (`db/migrations/` + `src/server/postgresStore.ts`)

- **Migrações versionadas**: `db/migrations/001_initial_schema.sql` cria `schema_migrations`, `contracts` (valores monetários em `BIGINT` centavos + `JSONB`), `saved_dossiers`, `finding_reviews` (*append-only*), `sync_checkpoints`, `document_artifacts`, `ingestion_jobs` e `audit_users`.
- **Aplicar migrações manualmente**:
  ```bash
  npm install pg @types/pg
  DATABASE_URL="postgresql://nexofis:SUA_SENHA@localhost:5432/nexofis" npx tsx scripts/migrate-postgres.ts
  ```
- **Adaptador**: `src/server/postgresStore.ts` utiliza consultas parametrizadas (`$1..$N`) e carregamento dinâmico de `pg`, mantendo compatibilidade total com execuções locais em SQLite (`NEXOFIS_DB_DRIVER=sqlite`).

---

## 3. OCR Externo: Docling Serve + Worker PaddleOCR

- **Adaptador Node**: `src/server/doclingClient.ts` consulta `DOCLING_SERVE_URL` (`/v1/convert/file`) e `PADDLE_OCR_URL` (`/ocr`), além de verificar `/health` via `GET /api/system/integrations`.
- **Microserviço Python**: `worker/ocr_worker.py`, `worker/requirements.txt` e `worker/Dockerfile`.
- **Execução local sem Docker**:
  ```bash
  cd worker
  python3 -m venv .venv && source .venv/bin/activate
  pip install -r requirements.txt
  uvicorn ocr_worker:app --host 0.0.0.0 --port 8090
  ```
- Quando `DOCLING_SERVE_URL` ou `PADDLE_OCR_URL` não estão configurados ou offline, o sistema declara explicitamente `source_unavailable` sem simular extração.

---

## 4. Autenticação e RBAC (`src/server/authMiddleware.ts`)

- **Opt-in seguro**: ative com `NEXOFIS_AUTH_ENABLED=true` e defina `NEXOFIS_SESSION_SECRET` (mínimo 32 caracteres aleatórios) no `.env`.
- **Papéis suportados**: `admin`, `analyst`, `viewer`.
- **Proteção aplicada em `server.ts`**:
  - `POST /api/dossiers`, `POST /api/contracts/:id/findings/:findingId/review`, `POST /api/documents/upload`: exige `admin` ou `analyst`.
  - `DELETE /api/dossiers/:id`: exige `admin`.
- **Senhas**: `hashPasswordScrypt` / `verifyPasswordScrypt` (`crypto.scryptSync` + salt aleatório + `timingSafeEqual`) para a tabela `audit_users`.

---

## 5. Fila Durável de Ingestão (`src/server/jobQueue.ts`)

- Persistida em SQLite WAL (`data/nexofis-jobs.db`) com:
  - Chave de idempotência (`idempotency_key UNIQUE`) evitando duplicação;
  - Estados `queued | processing | succeeded | failed | cancelled`;
  - *Lease* com expiração e `heartbeat`, recuperando automaticamente tarefas presas após queda de processo;
  - *Backoff* exponencial limitado para erros transitórios e falha imediata para `PermanentJobError`.

---

## 6. Conectores Oficiais CGU e SICONFI (`src/server/connectors/portalTransparenciaClient.ts`)

- **CGU (CEIS / CNEP / CEPIM)**: requer `PORTAL_TRANSPARENCIA_API_KEY` configurada no servidor. Se ausente, retorna `api_key_required` (nunca simula certidão negativa).
- **SICONFI / Tesouro Nacional (RREO)**: consulta aberta por código IBGE de 7 dígitos, retornando aviso explícito de que se trata de dado fiscal agregado (não prova irregularidade individual de contrato).

---

## 7. Backup, Restauração e Publicação no GitHub

- **Backup / Restauração**:
  ```bash
  bash scripts/backup-restore.sh backup-sqlite
  bash scripts/backup-restore.sh backup-postgres
  ```
- **Publicação segura no GitHub (`https://github.com/devdudumuniz/NEXOFIS`)**:
  - Linux/macOS/WSL: `bash scripts/publish-github.sh "feat: sua mensagem"` (use `NEXOFIS_AUTO_PUSH=true` para executar o `git push` ao final).
  - Windows PowerShell: `.\scripts\publish-github.ps1 -CommitMessage "feat: sua mensagem" -Push`.

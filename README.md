<p align="left">
  <img src="./public/brand/nexofis-logo-horizontal.svg" alt="NEXOFIS — Auditoria Forense de Contratos Públicos" height="44" />
</p>

# NEXOFIS

Plataforma brasileira de auditoria forense e análise reprodutível de contratos públicos municipais e nacionais, desenvolvida por **Eduardo Muniz — DM Technology**.

## Princípios de Integridade Forense

- **Zero dados fictícios em produção**: o servidor inicia sobre banco SQLite limpo, sem municípios pré-selecionados, sem consultas rápidas embutidas e sem documentos de demonstração injetados.
- **Não fabricação de campos ausentes**: datas de assinatura/vigência, número de participantes, situação cadastral, cobertura no PNCP e execução financeira nunca são preenchidos com valores inventados.
- **Separação estrita entre obrigação contratada e execução comprovada**: ausência de notas de empenho ou pagamentos é exibida explicitamente como `Não verificado (sem execução financeira coletada)`, nunca como `R$ 0,00`.
- **Cobertura evidenciária declarada**: contratos sem fontes ou documentos suficientes são classificados como `Cobertura insuficiente` e nunca entram no balde de `Baixo Risco` ou conformidade regular.
- **Identidade de achado estável e snapshots imutáveis**: cada achado possui `findingId` semântico + `inputsDigest` SHA-256; dossiês arquivados preservam o snapshot completo do contrato e das revisões no momento do arquivamento.

## Principais Recursos

- **Busca Nacional por CNPJ (`GET /api/cnpj/:cnpj/contracts` e aba Contrato)**: suporta CNPJ numérico tradicional e **CNPJ alfanumérico (RFB 2026)**, consultando a API oficial do PNCP e o índice local persistido em SQLite, com enriquecimento cadastral via provedores intermediários (`publica.cnpj.ws` / `BrasilAPI`).
- **Resolução Territorial IBGE (5.571 municípios)**: mapeamento por município, código IBGE de 7 dígitos, secretarias, fundos municipais e indicadores SICONFI.
- **Persistência Durável em SQLite WAL (`data/nexofis.db`)**: usa `node:sqlite` em modo WAL com migrações aditivas (`schema_migrations`), armazenamento content-addressed dos arquivos originais enviados (`data/objects/<sha256>`), revisões *append-only* (`finding_reviews`) com autor derivado do servidor, e fila de jobs durável.
- **Motor Forense Determinístico (`forensic-engine-2026.13`)**:
  - **Viagem Temporal Normativa**: aplica os tetos vigentes na data da assinatura (Decretos nº 11.871/2024, 12.343/2025 e 12.807/2026) e recusa fallback silencioso em datas ausentes ou inválidas (`BR-LEGAL-INCONCLUSIVE`).
  - **Benchmarking Horizontal (Mediana/MAD)**: modos `same_supplier` e `market`, proteção contra mistura de valores nominais e corrigidos por inflação, e suporte explícito a `MAD = 0` (`robustZ: null`, `peerRatio`).
  - **Sanções (CEIS/CNEP/CEPIM)**: diferencia multa pecuniária (`fine_only`) de impedimento de contratar (`impediment`), vigência na data da assinatura e abrangência federativa.
  - **Execução Financeira e OCDS 1.1**: preservação de pagamentos sem número de documento, contabilização de estornos (`isReversal`) e validação de fila cronológica (art. 141 da Lei nº 14.133/2021).
- **Pipeline Documental & OCR Auditável**: validação real de magic bytes (PDF, PNG, JPEG, WebP, TIFF), defesa contra PDF zip-bomb com limites explícitos (`maxOutputLength`, tempo e páginas), deduplicação por SHA-256, preservação do binário original (`GET /api/documents/:sha256/original`), suporte a **Docling Serve** e **PaddleOCR Worker** (com fallback nativo e multimodal devidamente rotulados).
- **Interface Operacional com Brandkit v1.0**: menu lateral retrátil, tema Claro e Escuro (`Manrope` + `IBM Plex Mono`), URLs compartilháveis com hidratação de estado e exportação em **PDF**, **Markdown** e **OCDS 1.1 JSON**.
- **Autenticação Fail-Closed em Produção (RBAC)**: tokens Bearer HMAC-SHA256 mantidos apenas em memória no navegador (nunca em `localStorage`), com papéis `admin`, `auditor` e `viewer`, bootstrap do primeiro administrador (`/api/auth/bootstrap-admin`) e ator de revisão sempre derivado da sessão autenticada.

## Execução Local (Linux, macOS e Windows)

### Pré-requisitos
- Node.js `>= 22.14` (recomendado `22.23+` com `node:sqlite` nativo) ou Bun `>= 1.2`.

### Instalação e Execução

```bash
cp .env.example .env
bun install --frozen-lockfile   # ou: npm install
npm run dev
```

A aplicação ficará disponível em `http://localhost:3000`.

### Testes, Lint, Build e Smoke Test HTTP

```bash
npm run lint
npm test
npm run build
npx tsx scripts/smoke-api.ts
```

## Execução em Container (Docker)

### Modo Standalone (SQLite WAL + Extrator Nativo)

Defina `NEXOFIS_SESSION_SECRET` (mínimo 32 caracteres) no `.env` e execute:

```bash
docker compose up --build -d
```

### Modo Completo com OCR Distribuído (Docling Serve + PaddleOCR) e/ou PostgreSQL

```bash
docker compose --profile full-ocr up --build -d
# ou com PostgreSQL:
docker compose --profile full-ocr --profile postgres up --build -d
```

### Backup e Restauração Consistente (SQLite WAL + Objetos Originais)

O script `scripts/backup-restore.sh` usa `VACUUM INTO` + `PRAGMA integrity_check` para garantir consistência mesmo com escrita ativa em modo WAL, preservando também os arquivos originais em `data/objects/`:

```bash
bash scripts/backup-restore.sh backup-sqlite
bash scripts/backup-restore.sh restore-sqlite backups/<arquivo>.db
```

## Arquitetura, Contribuição e Matriz de Rastreabilidade

- Guia operacional e arquitetura: [`docs/ARQUITETURA_E_OPERACAO.md`](./docs/ARQUITETURA_E_OPERACAO.md)
- Guia de contribuição: [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- Matriz de rastreabilidade da auditoria (A01–A15 / UI-01–UI-08): [`docs/MATRIZ_RASTREABILIDADE.md`](./docs/MATRIZ_RASTREABILIDADE.md)

## Limitações e Escopo dos Conectores Externos

- **PNCP**: a busca nacional captura contratos publicados no PNCP. Contratos publicados apenas em Diários Oficiais locais constam no NEXOFIS mediante importação documental.
- **Cadastro CNPJ**: `publica.cnpj.ws` e `BrasilAPI` atuam como provedores intermediários da base pública da Receita Federal.
- **Serviços Externos Opcionais**: **Docling Serve**, **PaddleOCR Worker**, **Portal da Transparência (CGU)** e **PostgreSQL** dependem de execução/configuração no ambiente do operador; quando ausentes, o NEXOFIS declara o estado real de indisponibilidade sem simular resultados.

## Licença e Governança

O código-fonte do **NEXOFIS** é licenciado sob a **GNU Affero General Public License v3.0 (`AGPL-3.0-only`)** — consulte [`LICENSE`](./LICENSE).

> **Separação Software × Dados Públicos:** A licença `AGPL-3.0-only` aplica-se exclusivamente ao código-fonte do software. Dados públicos coletados e documentos analisados permanecem sujeitos à Lei de Acesso à Informação (Lei nº 12.527/2011) e à LGPD (Lei nº 13.709/2018).

# Guia de Contribuição — NEXOFIS

Obrigado pelo interesse em contribuir com o **NEXOFIS**! Este projeto é software livre sob a licença **GNU AGPL-3.0-only**, voltado à auditoria forense transparente e reproduzível de contratos públicos brasileiros.

---

## 1. Princípios Inegociáveis do Projeto

Antes de abrir uma *Issue* ou *Pull Request*, observe os pilares do NEXOFIS:

1. **Rigor Epistêmico**: nunca inventar, inferir silenciosamente ou mascarar dados ausentes. Quando uma fonte está offline ou um dado não existe, retorne explicitamente `NOT_VERIFIABLE` ou `source_unavailable`.
2. **Neutralidade do Repositório**: **não** adicione municípios, empresas ou CNPJs pessoais como atalhos fixos (*quick access*) ou valores padrão na interface. Qualquer exemplo de teste deve ficar restrito a arquivos `*.test.ts`.
3. **Trilha Probatória Reproduzível**: toda regra de risco deve declarar base legal, versão da regra, cálculo exato e fontes consultadas (sem sobrescrever divergências entre portais).
4. **Segurança por Padrão**: jamais faça commit de chaves de API, senhas, `.env` ou bancos `.db`. Todas as consultas SQL devem ser parametrizadas.
5. **Licença AGPL-3.0-only**: todas as contribuições ao código-fonte passam a ser licenciadas sob GNU AGPL-3.0-only.

---

## 2. Configuração do Ambiente Local

### Opção A — Node.js 22 (desenvolvimento rápido)

Pré-requisito: **Node.js >= 22.14** (com suporte nativo a `node:sqlite`).

```bash
git clone https://github.com/devdudumuniz/NEXOFIS.git
cd NEXOFIS
cp .env.example .env
npm install
npm run dev
```

Acesse `http://localhost:3000`.

### Opção B — Pilha Completa em Containers (Docker Compose)

Sobe **NEXOFIS + PostgreSQL 16 + Docling Serve + Worker PaddleOCR (PT-BR)**:

```bash
cp .env.example .env
# Defina POSTGRES_PASSWORD no arquivo .env
docker compose up --build -d
docker compose ps
```

Para executar apenas a imagem do app NEXOFIS em modo container (SQLite em volume):

```bash
docker build -t nexofis:local .
docker run --rm -p 3000:3000 -v nexofis_data:/app/data nexofis:local
```

---

## 3. Verificações Obrigatórias Antes do Pull Request

Todo PR deve passar integralmente nos três comandos abaixo:

```bash
# 1. Suíte de testes unitários (node:test via tsx)
npx --yes tsx --test src/lib/*.test.ts

# 2. Checagem estrita de tipos TypeScript
npm run lint

# 3. Build de produção Vite
npm run build
```

---

## 4. Mapa de Onde Contribuir

| Área | Diretório / Arquivos | Boas primeiras contribuições |
|---|---|---|
| **Motor de Risco e Regras Brasileiras** | `src/lib/riskEngine.ts`, `src/lib/legalRules.ts`, `src/lib/benchmarkEngine.ts` | Novas regras da Lei nº 14.133/2021, decretos anuais, testes de borda |
| **Motor de OCR e Inteligência Documental** | `src/server/ocrEngine.ts`, `src/lib/ocrPostProcessor.ts`, `worker/ocr_worker.py` | Pré-processamento de imagem, parsers de tabelas municipais, correções PT-BR |
| **Conectores de Dados Públicos** | `src/server/pncpClient.ts`, `src/server/connectors/` | Adaptadores para TCEs estaduais, Compras.gov, SINAPI, Painel de Preços |
| **Persistência e Filas** | `src/server/storage.ts`, `src/server/postgresStore.ts`, `src/server/jobQueue.ts`, `db/migrations/` | Novas migrações SQL, índices de busca, workers assíncronos |
| **Interface Investigativa (React + Tailwind)** | `src/components/`, `src/App.tsx` | Acessibilidade WCAG AA, tema claro/escuro, visualização de evidências |

---

## 5. Convenção de Commits e Branches

- Crie branches a partir de `main`: `feat/conector-tce-ba`, `fix/ocr-tabelas-multilinha`, `docs/guia-docker`.
- Use [Conventional Commits](https://www.conventionalcommits.org/):
  - `feat:` nova funcionalidade
  - `fix:` correção de defeito
  - `docs:` documentação
  - `test:` adição ou correção de testes
  - `refactor:` refatoração sem mudança de comportamento
- Inclua testes unitários (`src/lib/*.test.ts`) para toda nova regra de negócio, parser ou cálculo.

---

## 6. Revisão de Código

Ao abrir um PR, preencha o template (`.github/PULL_REQUEST_TEMPLATE.md`) informando:
- O que mudou e qual problema resolve;
- Quais testes foram executados localmente;
- Quais integrações externas não puderam ser testadas no ambiente local (honestidade técnica).

# NEXOFIS

Plataforma brasileira de auditoria forense e análise reprodutível de contratos públicos municipais e nacionais, desenvolvida por **Eduardo Muniz — DM Technology**.

## Principais Recursos

- **Busca Nacional por CNPJ (`GET /api/cnpj/:cnpj/contracts` e aba Contrato)**: consulta paginada em tempo real na API oficial de busca do PNCP (`/api/search/?q={cnpj}&tipos_documento=contrato`), separando explicitamente o papel do CNPJ (**Fornecedor**, **Órgão Contratante** ou **Subcontratado**), combinada com o índice local persistido em SQLite e enriquecimento cadastral via provedores intermediários (`publica.cnpj.ws` / `BrasilAPI`).
- **Resolução Territorial IBGE (5.571 municípios)**: mapeamento por município, código IBGE de 7 dígitos, secretarias e fundos municipais.
- **Persistência Durável em SQLite (`data/nexofis.db`)**: usa `node:sqlite` em modo WAL com migrações versionadas (`schema_migrations`) para contratos sincronizados, dossiês salvos, checkpoints de sincronização, artefatos documentais por SHA-256 e revisões humanas *append-only* (`finding_reviews`).
- **Motor Forense Determinístico**:
  - **Viagem Temporal Normativa**: aplica estritamente os tetos vigentes na data da assinatura (Decretos nº 11.871/2024, 12.343/2025 e 12.807/2026) e recusa fallback silencioso em datas ausentes, inválidas ou fora da cobertura (`BR-LEGAL-INCONCLUSIVE`).
  - **Benchmarking Horizontal (Mediana/MAD)**: suporta modos `same_supplier` e `market`, deduplicação de contratos repetidos, verificação de compatibilidade de unidade e tratamento explícito de `MAD = 0` e inflação nominal.
  - **Execução Financeira e OCDS 1.1**: separa obrigação contratada de execução comprovada (empenho, liquidação, pagamento), deduplica lançamentos entre portais e exporta `contracts[].implementation.transactions` contendo apenas pagamentos efetivos.
  - **Cobertura Evidenciária Declarada**: recusa classificar contratos sem fontes e sem documentos como regulares (`Cobertura insuficiente`).
- **Pipeline Documental Auditável**: validação real de assinatura binária (magic bytes), deduplicação por SHA-256, extração nativa de PDF (`FlateDecode` via `node:zlib` com contagem real de páginas), vinculação estrita por chave composta (nunca anexa automaticamente apenas por CNPJ ou número ambíguo) e fallback multimodal opcional.

## Execução Local (Linux e Windows)

### Pré-requisitos
- Node.js `>= 22.14` (recomendado `22.23+` com `node:sqlite` nativo) ou Bun.

### Instalação e Execução

```bash
cp .env.example .env
npm install
npm run dev
```

No **Windows (PowerShell)**:

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

A aplicação fica disponível em `http://localhost:3000`.

### Testes, Lint e Build

```bash
node --import tsx --test src/lib/*.test.ts
npm run lint
npm run build
```

### Backup e Restauração do Banco Local (SQLite)

O banco persistente fica em `data/nexofis.db`. Para backup seguro (com o servidor parado ou via cópia dos arquivos `.db`, `.db-wal`, `.db-shm`):

```bash
mkdir -p backups
cp data/nexofis.db* backups/
```

## Cobertura e Limitações Conhecidas

- **PNCP**: A busca nacional por CNPJ captura contratos **publicados no PNCP**. Contratos municipais publicados apenas em Diários Oficiais locais ou portais próprios (ex.: parte das inexigibilidades do FMS de Barra do Choça/BA) não aparecem na API pública do PNCP e constam no NEXOFIS apenas quando importados via PDF/extrato ou indexados localmente.
- **Cadastro CNPJ**: `publica.cnpj.ws` e `BrasilAPI` são **provedores intermediários** da base pública da Receita Federal; o NEXOFIS identifica explicitamente essa proveniência.
- **OCR Externo (Docling Serve / PaddleOCR)**: Não é executado daemon local de Docling/PaddleOCR neste pacote por padrão. PDFs com camada textual nativa são extraídos localmente via `zlib-flate`; scans/imagens requerem `GEMINI_API_KEY` configurada no `.env` ou integração futura com Docling Serve.

## Licença e Governança

O código-fonte do **NEXOFIS** é licenciado sob a **GNU Affero General Public License v3.0 (`AGPL-3.0-only`)** — consulte [`LICENSE`](./LICENSE).

> **Separação Software × Dados Públicos:** A licença `AGPL-3.0-only` aplica-se exclusivamente ao código-fonte do software. Dados públicos coletados e documentos analisados permanecem sujeitos à Lei de Acesso à Informação (Lei nº 12.527/2011) e à LGPD (Lei nº 13.709/2018).

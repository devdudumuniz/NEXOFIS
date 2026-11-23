# Guia de Investigação Documental de Fornecedores — NEXOFIS

O módulo **Investigação Forense** adiciona ao dossiê de cada contrato um ambiente determinístico, auditável e reproduzível para reunir cronologia empresarial, histórico contratual observado, vínculos documentados, evidências privadas isoladas e revisões humanas vinculadas à versão dos fatos.

> **Salvaguarda metodológica:** Todos os apontamentos orientam diligências humanas. O motor **nunca** declara fraude, conluio ou ilegalidade automaticamente, e **nunca** funde identidades por semelhança nominal (homonímia).

---

## 1. As 8 Trilhas Determinísticas

| Código | Trilha | Critério objetivo | Salvaguarda / Prevenção de falso positivo |
|---|---|---|---|
| `INV_CHRONOLOGY_INCOMPATIBLE` | Cronologia incompatível | Assinatura anterior à data empresarial informada (`Δd < 0`). | Sinaliza inconsistência e orienta conferir documento, estabelecimento, sucessão empresarial e significado da data. |
| `INV_RECENT_COMPANY` | Empresa recente | `Δd = d_assinatura - d_evento_cadastral` nas faixas **0–1**, **2–30** e **31–90 dias**. | Mantém separados `constituicao`, `inscricao_cnpj` e `inicio_atividade`; empresa recente não é automaticamente impedida pela Lei nº 14.133/2021. |
| `INV_RECENT_CORPORATE_CHANGE` | Alterações próximas à contratação | Mudanças (`societario`, `cnae`, `endereco`, `capital`) nos **30 dias anteriores** à assinatura (`0 <= Δd <= 30`). | Exige comprovação histórica documental (`isHistoricalDocumented: true`); consulta cadastral atual não comprova a data de alteração. |
| `INV_SINGLE_OBSERVED_CONTRACT` | Contrato único observado | Apenas 1 contrato localizado para o CNPJ no universo observado. | Registra explicitamente as fontes consultadas; "apenas um observado" não equivale a "único no país". |
| `INV_BUYER_CONCENTRATION` | Concentração por comprador | Um órgão concentra **80% ou mais** do valor observado, com **pelo menos 3 contratos comparáveis**. | Deduplica registros e interrompe o cálculo se faltarem valores válidos ou houver divergência de valor. |
| `INV_CORPORATE_PUBLIC_FUNCTION_LINK` | Vínculo empresarial e função pública | Pessoa com identidade documentada vinculada ao fornecedor e a função pública pertinente na data da contratação. | Rejeita identidades `unresolved` (incluindo QSA público) e exige vigência/pertinência comprovadas. |
| `INV_DOCUMENTED_KINSHIP_NEXUS` | Parentesco com nexo contratual | Relação familiar documentada (art. 14, IV, Lei nº 14.133/2021) entre vinculado ao fornecedor e agente público pertinente. | Exige documentação do parentesco, grau (≤ 3º grau para consanguinidade/afinidade), identidades documentadas e vigência. |
| `INV_LOT_PARTICIPANT_SHARED_LINK` | Relações entre participantes | Participantes do mesmo lote compartilham pessoa com identidade empresarial documentada na data do certame. | Avalia lote, data e vínculos vigentes; não conclui conluio automaticamente. |

O motor aplica orçamento explícito de cruzamento (`MAX_CROSSREF_BUDGET = 2500`). Caso o volume exceda o limite, registra `ORCAMENTO_EXCEDIDO` em vez de truncar silenciosamente.

---

## 2. Segurança, Autenticação e Isolamento de Evidências Privadas

1. **Autenticação obrigatória estrita:** Todas as rotas `/api/contracts/:id/investigation*` exigem token Bearer válido com perfil `analyst` ou `admin` mesmo quando o restante da aplicação opera em modo local.
2. **Isolamento físico de evidências privadas:** Arquivos privados (limite de **1 MiB**) são gravados em `data/private_evidence/<prefix>/<sha256>` e nomeados no download/exportação como `<sha256>__<nome>`. Eles **nunca** são acessíveis pela rota pública `/api/documents/:sha256/original`.
3. **Extrato cadastral minimizado (BrasilAPI):** Toda consulta exige `purpose`, `legalBasis` e `justification`, armazena apenas o extrato minimizado rotulado como `provedor_intermediario` e marca todos os integrantes do QSA como `identityStatus: "unresolved"`.
4. **Livro-razão append-only e concorrência otimista:** A tabela `investigation_events` encadeia cada evento por SHA-256 (`prev_hash` → `event_hash`) e possui triggers SQLite bloqueando `UPDATE` e `DELETE`. Atualizações do conjunto de fatos exigem `expectedVersion` (retornando HTTP `409 Conflict` se houver alteração concorrente).
5. **Revisão vinculada aos fatos:** Toda revisão humana (`confirm`, `dismiss`, `restore`) é gravada com `factsVersion` e `findingInputsDigest`. Se os fatos ou o digest de entrada mudarem, a revisão anterior é sinalizada como desatualizada.

---

## 3. Endpoints da API

Todos exigem `Authorization: Bearer <token>` (perfis `admin` ou `analyst`):

- `GET /api/contracts/:id/investigation` — Obtém ou inicializa o caso, verifica a cadeia SHA-256 e executa as 8 trilhas.
- `POST /api/contracts/:id/investigation/cadastral-query` — Consulta minimizada na BrasilAPI com finalidade, base legal e justificativa.
- `POST /api/contracts/:id/investigation/pncp-history` — Sincroniza histórico contratual observado do CNPJ (PNCP + base local).
- `POST /api/contracts/:id/investigation/evidence` — Upload de evidência privada (`multipart/form-data`, campo `file` ≤ 1 MiB, `sourceLabel`, `description`).
- `GET /api/contracts/:id/investigation/evidence/:evidenceId/download` — Download autenticado do binário original com verificação SHA-256.
- `PUT /api/contracts/:id/investigation/facts` — Atualiza o conjunto versionado de fatos (`{ expectedVersion, facts }`).
- `POST /api/contracts/:id/investigation/reviews` — Registra revisão humana vinculada ao apontamento e versão dos fatos.
- `GET /api/contracts/:id/investigation/export` — Exporta o pacote JSON verificável (`nexofis-investigation-pkg/1.0`).

---

## 4. Verificação Independente Offline

Sem rede e sem servidor em execução, qualquer auditor pode validar o pacote exportado e os arquivos originais baixados:

```bash
npx tsx scripts/verify-investigation.ts pacote.json [diretorio-originais]
```

Códigos de saída:
- `0` — Válido no escopo declarado (schema, digest SHA-256 do pacote, cadeia de eventos, reprodução determinística e originais conferidos).
- `1` — Inválido, adulterado, hash divergente ou reprodução incompatível.
- `2` — Verificação incompleta (diretório/arquivos originais ausentes ou versão do motor diferente).

---

## 5. Backup, Verificação e Restauração

O script `scripts/backup-restore.sh` inclui `private_evidence/` junto com o banco SQLite e `objects/`, verificando:
- Integridade do SQLite (`PRAGMA integrity_check`);
- Integridade da cadeia SHA-256 de `investigation_events`;
- Ausência de path traversal (`..`), caminhos absolutos ou symlinks no arquivo tar antes da extração;
- Tamanho (≤ 1 MiB) e SHA-256 de cada evidência privada antes de substituir o diretório de destino.

```bash
bash scripts/backup-restore.sh backup data backups/nexofis-backup.tar.gz
bash scripts/backup-restore.sh verify backups/nexofis-backup.tar.gz
bash scripts/backup-restore.sh restore backups/nexofis-backup.tar.gz data-restored
```

---

## 6. Licenciamento

O código-fonte do NEXOFIS permanece licenciado sob **AGPL-3.0-only**. Os dados públicos consultados e as evidências privadas anexadas pelos auditores são regidos separadamente pela legislação aplicável (LAI, LGPD e normas de controle externo).

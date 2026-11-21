# Política de Segurança — NEXOFIS

## Versões Suportadas

| Versão | Suporte de Segurança |
|---|---|
| `main` (`0.1.x`) | Ativo |

## Como Reportar uma Vulnerabilidade

**Não abra uma Issue pública** para vulnerabilidades de segurança exploráveis.

1. Utilize o recurso **GitHub Security Advisories** ("Report a vulnerability") na aba *Security* do repositório `https://github.com/devdudumuniz/NEXOFIS`;
2. Inclua descrição técnica clara, passos mínimos para reprodução, impacto estimado e, se possível, sugestão de correção;
3. Mantenedores acusarão recebimento em até 72 horas úteis e coordenarão a correção antes da divulgação pública.

## Fronteiras de Segurança da Arquitetura

- **Credenciais**: todas as chaves (`PORTAL_TRANSPARENCIA_API_KEY`, `GEMINI_API_KEY`, `DATABASE_URL`, `NEXOFIS_SESSION_SECRET`) residem estritamente no servidor (`process.env`), nunca no bundle do navegador.
- **SQL e Uploads**: consultas SQL em SQLite e PostgreSQL utilizam parâmetros vinculados (`?` / `$1..$N`); arquivos enviados passam por validação de *magic bytes*, limite de tamanho e hash SHA-256 antes do roteamento OCR.
- **Autenticação e RBAC**: rotas de escrita suportam proteção Bearer HMAC-SHA256 com papéis (`admin`, `analyst`, `viewer`) via `NEXOFIS_AUTH_ENABLED=true`.
- **Containers**: tanto o container principal (`Dockerfile`) quanto o worker OCR (`worker/Dockerfile`) executam com usuários não-root.
- **Privacidade e Dados Públicos**: os registros auditados provêm de fontes oficiais públicas (LAI — Lei nº 12.527/2011) e devem ser tratados com observância da LGPD (Lei nº 13.709/2018).

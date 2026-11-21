# Política de Segurança — NEXOFIS

## Reportando Vulnerabilidades

Caso identifique uma vulnerabilidade de segurança no NEXOFIS, evite abrir uma *issue* pública com detalhes exploráveis. Envie o relato de forma privada ao mantenedor (**Eduardo Muniz — DM Technology**) pelo repositório oficial (`https://github.com/devdudumuniz/NEXOFIS/security/advisories`).

## Salvaguardas Implementadas

- **Validação de arquivos enviados**: conferência da assinatura binária real (magic bytes) contra o tipo MIME declarado e limite de tamanho por arquivo.
- **Consultas parametrizadas**: todas as operações de banco SQLite utilizam *prepared statements* parametrizados.
- **Restrição de destinos externos**: validação de URLs públicas para bloquear endereços locais/privados ou esquemas não HTTP(S).
- **Segredos fora do código-fonte**: chaves opcionais (ex.: `GEMINI_API_KEY`) são lidas exclusivamente de variáveis de ambiente no servidor e nunca expostas no frontend.
- **Privacidade (LGPD)**: CPFs em registros de pessoas físicas são mascarados na camada de apresentação e exportação.

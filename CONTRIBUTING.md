# Contribuindo com o NEXOFIS

Obrigado pelo interesse em contribuir com o **NEXOFIS**!

## Padrões de Engenharia

1. **Idioma**: Documentação, textos de interface, achados forenses e mensagens ao usuário devem ser escritos em **português brasileiro (PT-BR)** claro e técnico.
2. **Honestidade Epistêmica**:
   - Nunca converta erro de rede, timeout ou HTTP 429 em "ausência de contratos/sanções".
   - Nunca invente percentuais de confiança arbitrários nem justificativas automáticas de descarte.
   - Sempre declare cobertura parcial ou dados não verificáveis (`NOT_VERIFIABLE` / `Cobertura insuficiente`).
3. **Verificação Obrigatória antes de Pull Request**:
   - `node --import tsx --test src/lib/*.test.ts`
   - `npm run lint`
   - `npm run build`

## Licença das Contribuições

Todas as contribuições submetidas a este repositório são licenciadas sob **GNU AGPL-3.0-only**, nos termos do arquivo [`LICENSE`](./LICENSE).

## Resumo das Alterações

Descreva de forma objetiva o que foi alterado e qual problema resolve.

## Tipo de Mudança

- [ ] Nova funcionalidade (`feat`)
- [ ] Correção de defeito (`fix`)
- [ ] Motor de OCR / pipeline documental
- [ ] Regra jurídica / motor de risco / conector público
- [ ] Infraestrutura / Docker / CI
- [ ] Documentação (`docs`)

## Checklist Obrigatório

- [ ] Executei `npx --yes tsx --test src/lib/*.test.ts` e todos os testes passaram
- [ ] Executei `npm run lint` (`tsc --noEmit`) sem erros
- [ ] Executei `npm run build` sem erros
- [ ] Nenhum segredo, `.env`, CNPJ/município pessoal hardcoded ou dado fabricado foi adicionado
- [ ] Novas regras ou parsers possuem testes unitários determinísticos
- [ ] Limitações não testadas no ambiente local estão declaradas honestamente abaixo

## O que foi validado e o que depende de ambiente externo

- **Validado localmente:** ...
- **Não validado localmente (motivo):** ...

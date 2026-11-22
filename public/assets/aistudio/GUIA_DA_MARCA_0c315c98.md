# NEXOFIS — Guia da marca

**Versão 1.0 · Identidade para produto digital, documentação e comunicação**  
**Projeto:** NEXOFIS · **Responsável:** Eduardo Muniz · **Organização:** DM Technology

## 1. Ideia central

O NEXOFIS conecta informações sobre contratos, fornecedores, despesas e entregas para apoiar uma análise verificável da gestão pública. A marca expressa essa conexão por meio de um **N geométrico formado por duas peças**, com um encaixe central visível.

O encaixe é a assinatura do símbolo. Deve permanecer reconhecível nas versões colorida, monocromática e reversa. O cobre destaca uma das peças; a identidade não depende da cor para existir.

**Nome:** NEXOFIS, sempre em uma palavra.  
**Assinatura:** Inteligência sobre o gasto público.

A apresentação visual deve transmitir precisão, clareza e confiança. O símbolo identifica o software; não representa um órgão público, um selo de conformidade ou uma conclusão sobre fraude.

## 2. Voz e linguagem

Escrever em português brasileiro, com frases diretas e termos verificáveis. Priorizar o que foi encontrado, a origem, a data, a cobertura e a ação disponível.

| Preferir | Evitar |
| --- | --- |
| “Diferença de preço identificada” | “Fraude confirmada” sem conclusão competente e evidência correspondente |
| “Fonte indisponível; exibindo dados da última coleta” | “Nenhum contrato encontrado” quando a consulta falhou |
| “Evidência insuficiente para esta análise” | “Regular” por ausência de alertas |
| “Revisão registrada por…” | “Validado” sem autor, escopo e data |

Na comunicação de produto, explicar benefícios concretos: localizar documentos, comparar referências compatíveis, acompanhar despesas e reconstruir evidências. Reservar as conclusões jurídicas e contábeis ao contexto, aos dados e à revisão correspondentes.

## 3. Sistema de assinaturas

| Versão | Aplicação principal | Orientação |
| --- | --- | --- |
| Horizontal | Cabeçalho, login, README e relatórios | Símbolo à esquerda e nome à direita. É a versão padrão. |
| Empilhada | Áreas estreitas, apresentações e materiais quadrados | Símbolo acima do nome, com alinhamento central. |
| Com assinatura | Apresentação do produto e peças institucionais | Acrescenta “Inteligência sobre o gasto público”. Usar quando houver espaço suficiente. |
| Símbolo | Menu recolhido, favicon, avatar e aplicativo | Manter o recorte central e a proporção original. |
| Monocromática | Impressão simples, gravação e aplicação com uma tinta | Uma cor sólida, sem fechar o recorte. |
| Reversa | Fundo azul profundo ou superfície escura compatível | Nome e estrutura claros; usar a composição preparada para esse fundo. |
| Micro | Aplicações muito pequenas | Usar o arquivo simplificado específico, sem slogan. |

As versões de aplicação devem vir dos arquivos mestres. Não recriar o nome digitando uma fonte semelhante e não recortar a marca da prancha de apresentação.

### Arquivos de referência

- `logo/nexofis-logo-horizontal.svg`
- `logo/nexofis-logo-horizontal-reverse.svg`
- `logo/nexofis-logo-horizontal-mono.svg`
- `logo/nexofis-logo-stacked.svg`
- `logo/nexofis-logo-signature.svg`
- `icon/nexofis-symbol.svg`
- `icon/nexofis-symbol-micro.svg`

O inventário do pacote relaciona os arquivos realmente entregues, seus formatos e dimensões. Os exemplos de integração usam o prefixo público `/brand/`.

## 4. Construção, respiro e redução

### Área de proteção

Considere **H** a altura visível do símbolo, sem as margens do arquivo. Reserve pelo menos **H/4** ao redor da composição completa. Em telas de login, capas e materiais institucionais, prefira mais espaço.

Essa área deve permanecer livre de texto, bordas, outros logotipos e detalhes de fotografia. O respiro interno de um ícone para aplicativo não substitui a proteção externa da marca em uma composição.

### Tamanhos de referência

| Aplicação | Referência mínima de projeto |
| --- | --- |
| Símbolo micro | 16 × 16 pixels, usando o desenho micro |
| Símbolo regular | 24 pixels de altura |
| Marca horizontal sem assinatura | 160 pixels de largura |
| Marca com assinatura | Preferencialmente 480 pixels de largura ou mais |
| Impressão | Fazer prova no tamanho final; observar principalmente o encaixe e a assinatura |

Esses valores são diretrizes de projeto. A aprovação de cada exportação depende de verificar o recorte, a leitura do nome e o contraste no tamanho real. Não considerar um arquivo aprovado apenas porque ele tem as dimensões indicadas.

Se a assinatura perder leitura, usar a marca sem assinatura. Em espaços de 16 a 23 pixels, priorizar o símbolo micro. Manter proporção; alterar largura e altura conjuntamente.

## 5. Paleta principal

| Nome | HEX | RGB | Uso |
| --- | --- | --- | --- |
| Azul profundo | `#0B2540` | 11, 37, 64 | Estrutura da marca, nome, títulos e elementos principais |
| Cobre | `#D95B35` | 217, 91, 53 | Peça de conexão e destaques pontuais |
| Branco quente | `#FAF9F5` | 250, 249, 245 | Fundo claro principal |
| Azul claro | `#E8F1F6` | 232, 241, 246 | Superfícies auxiliares e agrupamentos leves |

Usar os valores digitais como fonte canônica. Para impressão, converter com o perfil ICC da gráfica e aprovar uma prova física; não tratar uma conversão CMYK genérica como equivalência exata.

O azul profundo domina a identidade. O cobre funciona como acento. Evitar grandes áreas em cobre quando elas competirem com documentos, tabelas e evidências.

### Contraste calculado da paleta

Razões calculadas a partir das cores sRGB sólidas, sem transparência:

| Par | Contraste aproximado | Aplicação recomendada |
| --- | --- | --- |
| Azul profundo / branco quente | 14,734:1 | Texto, títulos e marca |
| Azul profundo / azul claro | 13,559:1 | Texto em superfícies auxiliares |
| Cobre / branco quente | 3,625:1 | Acento visual; não usar como texto pequeno |
| Cobre / azul profundo | 4,064:1 | Acento visual; não assumir aprovação para texto pequeno |
| Branco puro / cobre | 3,819:1 | Não usar como combinação padrão de botão com texto pequeno |

O critério WCAG 2.2 de contraste mínimo estabelece 4,5:1 para texto comum e 3:1 para texto grande. A exceção aplicável a logotipos não se estende automaticamente aos textos da interface. Os valores acima verificam apenas pares de cores; não certificam a acessibilidade do produto. [Referência W3C](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).

Para botões, links e rótulos, usar os tokens semânticos do sistema e verificar o estado completo: normal, hover, foco, selecionado e desabilitado. Não aplicar opacidade sobre um par aprovado sem recalcular o resultado.

## 6. Cor da marca e estado da análise

O cobre identifica a marca e destaca ações ou informação. Não significa, por si só, irregularidade, gravidade ou fraude.

Manter os tokens de identidade separados dos tokens de sucesso, atenção, erro, informação e estado inconclusivo. Todo estado deve ter um rótulo explícito e, quando útil, um ícone. Gráficos devem usar legenda, nomes, padrões ou outra distinção visível além da cor. Isso segue o princípio de não transmitir informação exclusivamente por cor. [Referência W3C](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html).

Exemplos adequados: “Coleta parcial”, “Revisão necessária”, “Fonte indisponível” e “Evidência insuficiente”. A gravidade deve vir do resultado documentado da regra, com origem e limites, não da força visual da paleta.

## 7. Tipografia

**Família de interface:** Manrope.  
**Fallback:** `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.

| Uso | Peso recomendado | Orientação |
| --- | --- | --- |
| Títulos de página | 700 | Frases curtas e hierarquia clara |
| Títulos de seção | 600 | Diferenciar por tamanho e espaçamento |
| Corpo e explicações | 400 | Preferir 16 pixels como base de leitura |
| Controles e rótulos | 500 ou 600 | Não depender apenas do peso para indicar seleção |
| Números em tabelas | 400 a 600 | Usar algarismos tabulares quando disponíveis |
| Nome vetorial da marca | Desenho mestre | Não substituir por texto vivo na implementação |

A família variável incluída cobre os pesos 200 a 800. O TTF Manrope tem versão interna 4.505; os WOFF2 Latin e Latin Extended vieram da distribuição oficial Google Fonts. A licença integral SIL OFL 1.1 e o registro das origens acompanham os arquivos em `fonts/`. A versão vetorial do nome utiliza contornos obtidos do peso 800 e não depende de carregar uma fonte para ser exibida.

Usar os arquivos locais incluídos no pacote para reduzir dependências de rede. O fallback deve manter o conteúdo legível durante o carregamento e quando a fonte não estiver disponível. Não rasterizar textos de navegação ou conteúdo analítico.

## 8. Aplicação em temas claro e escuro

### Tema claro

Usar fundo branco quente, texto azul profundo e superfícies auxiliares em azul claro. Aplicar a marca colorida ou monocromática escura. Usar o cobre com moderação, preservando os contrastes dos controles.

### Tema escuro

Usar a versão reversa preparada. O nome e a estrutura principal devem ficar claros, preservando o encaixe. Os tokens semânticos definem fundos, superfícies, bordas e textos; trocar somente o fundo da página não constitui um tema escuro completo.

Confirmar a leitura da marca em menus, modais, barras de navegação, estados de carregamento e exportações. Uma área pública não deve exibir configurações internas, credenciais ou informações de infraestrutura como parte da identidade visual.

## 9. Favicon, PWA e avatar

Usar somente o símbolo nesses formatos. O nome completo e a assinatura não devem entrar no favicon.

- **Favicon SVG:** versão preparada para o contexto do navegador.
- **ICO e PNG pequenos:** conferir em 16 e 32 pixels reais.
- **Apple touch icon:** usar o arquivo com fundo e margens definidos.
- **PWA comum:** usar os tamanhos declarados no manifest.
- **PWA maskable:** usar o arquivo específico, respeitando sua área segura; não substituir automaticamente pelo ícone comum.
- **Avatar:** centralizar o símbolo e conferir o recorte circular.

Testar a instalação com os arquivos finais. Um manifest que aponta para arquivos inexistentes não é uma entrega funcional. A definição de ícone não comprova, por si só, operação offline do sistema.

## 10. Acessibilidade e comportamento

Quando a marca identifica o produto, usar texto alternativo “NEXOFIS”. Se for um link para o início, dar ao link um nome claro, como “NEXOFIS — início”, sem leitura duplicada. Se a imagem repetir um nome já presente no mesmo controle, tratá-la como decorativa.

Manter foco de teclado visível nos links da marca. Não transformar o símbolo em ação sem nome acessível. Evitar animação contínua da marca; qualquer movimento decorativo deve respeitar a preferência de redução de movimento.

O SVG de distribuição deve ser estático, sem scripts, chamadas externas ou fontes remotas. Se o nome estiver convertido em contornos, o arquivo continua precisando de identificação acessível quando aplicado.

## 11. Usos incorretos

- Deformar, inclinar, girar ou alterar a proporção.
- Fechar o encaixe ou preenchê-lo com outra cor.
- Aplicar sombras, relevo, brilho, texturas ou gradientes à marca principal.
- Alterar as cores livremente fora das versões previstas.
- Usar contorno improvisado para compensar um fundo inadequado.
- Aplicar a versão escura em fundo que elimine a leitura.
- Acrescentar brasões, símbolos partidários, selos ou qualificações oficiais à marca.
- Redigitar o nome para simular o arquivo vetorial.
- Usar o logo como indicador automático de aprovação de um contrato.
- Inserir slogan em tamanhos nos quais ele deixa de ser legível.

## 12. Distribuição e créditos

Responsável pelo projeto: **Eduardo Muniz — DM Technology**.

O código do NEXOFIS adota a decisão de licenciamento **AGPL-3.0-only**. Esse escopo deve ser documentado no repositório com o texto correspondente. A fonte tipográfica, outros componentes de terceiros e o uso da identidade visual precisam manter seus avisos próprios.

Este guia não cria uma licença de marca, não transfere titularidade e não declara registro ou disponibilidade do nome. As condições de uso da marca devem ser definidas pelo titular. Preservar as licenças das fontes incluídas e os créditos dos materiais de origem; não substituir esses textos pela licença do software.

## 13. Checklist para aplicar a marca no produto

O relatório `docs/VALIDACAO.md` registra as verificações dos arquivos entregues. A lista abaixo é reutilizável e deve ser conferida em cada integração, porque fundos, tamanho de exibição, permissões de arquivo e recortes podem mudar no produto. Um item só recebe aprovação quando o comportamento correspondente for observado no contexto de aplicação.

- [ ] O nome está escrito NEXOFIS em todas as versões.
- [ ] As cores vetoriais correspondem aos valores canônicos.
- [ ] O encaixe permanece aberto nas versões colorida, mono e reversa.
- [ ] Os SVGs contêm geometria vetorial, sem imagem raster embutida no lugar do logo.
- [ ] Os PNGs transparentes possuem canal alfa e não incluem fundo quadriculado desenhado.
- [ ] As proporções e margens são consistentes entre formatos.
- [ ] O símbolo foi inspecionado em 16, 24 e 32 pixels.
- [ ] A assinatura foi inspecionada em sua largura de aplicação.
- [ ] Os arquivos de favicon e manifest existem nos caminhos documentados.
- [ ] O ícone maskable foi conferido com máscaras de recorte.
- [ ] As variantes de tema claro e escuro foram verificadas.
- [ ] Os pares de texto dos tokens foram calculados, sem aprovação inferida da paleta.
- [ ] Os estados de análise usam texto e não dependem exclusivamente de cor.
- [ ] As fontes incluídas têm origem e licença preservadas.
- [ ] O pacote tem inventário de arquivos e instruções de integração.
- [ ] O código de integração foi conferido no ambiente-alvo antes da publicação.

## 14. Referências de produção

- [WCAG 2.2 — contraste mínimo](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
- [WCAG 2.2 — uso de cor](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html).
- [Google Fonts — Manrope](https://fonts.google.com/specimen/Manrope) e [arquivos oficiais](https://github.com/google/fonts/tree/main/ofl/manrope): origens, versão e licença verificadas nesta entrega.
- [Manifest de aplicativos web — W3C](https://www.w3.org/TR/appmanifest/): conferir os campos e ícones usados na implementação.

As referências técnicas orientam a produção. A validação dos arquivos finais, a origem das fontes e o comportamento no produto devem constar do relatório de QA que acompanha a entrega.

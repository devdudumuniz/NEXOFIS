# Validação do brandkit NEXOFIS 1.0

Data da entrega: 21 de novembro de 2026. Escopo: identidade, arquivos e exemplos de integração.

## Executado

| Item | Evidência / resultado |
| --- | --- |
| Fonte única da geometria | `source/build_assets.py` e `source/construction.json` geram os arquivos derivados. |
| SVG | 27 documentos XML válidos, com `viewBox`, sem scripts, imagens raster ou `foreignObject`. Os logos e símbolos são geometria real. |
| PNG | 49 exports de assets decodificados; dimensões corretas. A prancha adicional também foi renderizada e inspecionada. |
| Transparência | Logos e símbolos transparentes com alfa 0–255; Apple e maskable opacos. |
| Cores | Cores sólidas canônicas, sem sombras ou gradientes nos mestres. A prancha apresenta as quatro cores adotadas. |
| Fontes | TTF Manrope 4.505, eixo 200–800; WOFF2 oficiais e SIL OFL 1.1 integral. |
| Contrastes | 28 pares semânticos calculados com razão ≥4,5:1. Cobre base decorativo explicitamente separado dos pares de texto normal. |
| Manifest e caminhos | JSON válido; 19 referências dos arquivos de integração resolvidas. |
| Maskable | Limite geométrico essencial no raio 0,3661 do quadro, dentro da área segura de raio 0,4; fundo opaco. |
| React | Checagem estrita de tipos aprovada; detalhes e versões em `system/QA_INTEGRACAO.md`. |
| Marca | Inspeção visual da assinatura, símbolo, ícone 512 e favicon 16. A prancha final confirma a versão reversa e a consistência visual. |
| Guia | PDF de nove páginas gerado; inspeção visual das páginas 1, 5 e 9; texto extraível em todas as páginas. |
| Galeria local | HTML com assets relativos e fonte incorporada para leitura offline. Links locais conferidos antes do empacotamento. |

## Limites registrados

- O teste automatizado de abertura da galeria no Chromium não iniciou: o ambiente recusou a criação do socket do processo. Não houve alegação de teste de navegador concluído. O PDF e a prancha foram renderizados por um mecanismo independente e inspecionados.
- O pacote não equivale a uma auditoria de acessibilidade ou ao build completo do NEXOFIS. O componente e os pares declarados foram verificados no escopo acima.
- Instalação de PWA, recortes dos sistemas operacionais e adaptação a componentes existentes devem ser ensaiados no produto. O suporte geométrico ao maskable foi verificado; instalação em dispositivo não foi realizada.
- PDFs de impressão estão em RGB. Conversão ICC e prova física devem usar o processo da gráfica.

O inventário e o manifesto acompanham o ZIP. Os arquivos não dependem de uma sessão de geração de imagens nem de serviços remotos para serem usados.

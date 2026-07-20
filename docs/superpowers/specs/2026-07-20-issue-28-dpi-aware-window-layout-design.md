# Issue 28: organizador de janelas consciente de DPI

## Contexto e causa raiz

O organizador calcula a grade a partir de `Display.workArea`, que o Electron informa em pontos independentes de densidade (DIP). Em uma tela física de 1920×1080 com escala do Windows em 150%, por exemplo, a área útil aparece para o Electron como aproximadamente 1280×672 DIP. Isso é esperado e não representa erro de detecção.

A divergência surge na conversão para as janelas reais do Chromium. O preview cria `BrowserWindow`s diretamente com os retângulos em DIP, permitindo que o Electron aplique corretamente a escala do monitor. O Chromium recebe uma geometria compensada apenas por `force-device-scale-factor`; o `Display.scaleFactor` do Windows não participa do tamanho, da posição nem do cálculo da escala adaptativa da interface. Assim, os valores lógicos acabam tratados como pixels físicos. Em 150%, o conjunto de janelas ocupa cerca de dois terços da largura e da altura físicas, exatamente como reproduzido localmente.

O runtime também usa o mesmo campo `placement.scale` para representar ora a escala ideal da grade, ora a escala efetivamente fixada no lançamento de uma janela. Essa sobrecarga dificulta aplicar uma nova geometria a navegadores abertos sem confundir a escala desejada com a escala que o processo já usa.

## Objetivos

- Fazer preview, abertura e aplicação de layout ocuparem a mesma área útil física do monitor em qualquer escala suportada pelo Windows.
- Preservar a grade em DIP como representação lógica e converter explicitamente os slots para pixels físicos na fronteira com o Chromium.
- Manter densidade e legibilidade equivalentes quando a escala do Windows mudar, calculando a escala adaptativa do Chromium a partir do espaço físico disponível.
- Reorganizar janelas abertas imediatamente, sem reinício e sem aviso sobre ajuste futuro de escala interna.
- Suportar monitor principal ou secundário, incluindo origens negativas e monitores com fatores de escala diferentes.
- Tornar a matemática de layout isolada e testável, removendo a duplicação entre renderer, preview e runtime.

## Alternativas consideradas

1. Multiplicar localmente `toWindowGeometry()` por `Display.scaleFactor`. É a menor alteração, mas mantém unidades implícitas, duplica regras e é frágil em monitores com origens ou escalas diferentes.
2. Centralizar o cálculo lógico e introduzir uma fronteira explícita DIP → pixels físicos → geometria do Chromium. Esta é a opção escolhida porque corrige a causa raiz, preserva múltiplos monitores e cria uma seam de teste confiável.
3. Remover `force-device-scale-factor` e depender apenas do DPI do sistema. Isso simplificaria parte da geometria, mas mudaria a quantidade de janelas que cabe na grade, a legibilidade e o fingerprint já estabelecido. Está fora do escopo.

## Modelo de geometria

O layout terá quatro representações distintas:

1. **Slot lógico em DIP:** posição e tamanho calculados dentro de `Display.workArea`. Esta é a fonte de verdade da grade e do preview do Electron.
2. **Retângulo físico desejado:** slot lógico convertido pela API de tela do Electron para os pixels reais do monitor correspondente.
3. **Geometria do Chromium:** posição e tamanho enviados no lançamento ou por CDP, compensados pela escala interna efetivamente usada por aquela janela.
4. **Pegada física efetiva:** tamanho que a janela realmente pode ocupar após considerar o mínimo do Chromium e o piso de escala. Normalmente coincide com o retângulo desejado; em grades densas pode ser maior, sobrepor a célula vizinha ou ultrapassar a borda do monitor.

As unidades devem ficar explícitas nos nomes e interfaces; funções não aceitarão um `Rectangle` ambíguo. A conversão de monitor usará `screen.dipToScreenRect(null, rect)` no Windows, em vez de multiplicar coordenadas globais diretamente. O cálculo preservará a origem física do monitor e compensará somente o deslocamento interno e as dimensões pela escala do Chromium. Isso evita deslocar incorretamente monitores à esquerda ou acima do principal.

O cálculo da escala adaptativa deixa de usar a largura e a altura DIP da célula. Ele usa as dimensões físicas desejadas e mantém os limites operacionais atuais de escala. Dessa forma, uma célula com tamanho físico semelhante produz uma interface semelhante em 100%, 125%, 150% ou 200%.

## Componentes e responsabilidades

### Cálculo lógico compartilhado

Um módulo puro compartilhado será responsável por:

- normalizar modo, linhas, colunas, gap e margem;
- construir todos os slots lógicos em DIP;
- calcular os slots de cascata;
- informar a quantidade de slots sem conhecer Electron, CDP ou janelas abertas.

`ScreenLayoutPanel` e `BrowserRuntimeService` consumirão esse módulo. O renderer deixará de manter uma segunda implementação da matemática da grade.

### Conversão de geometria no processo principal

Um módulo pequeno do processo principal será responsável por:

- converter um slot DIP no retângulo físico do monitor;
- calcular a escala adaptativa ideal a partir do retângulo físico;
- produzir a geometria do Chromium a partir do retângulo físico, da origem do monitor e da escala efetiva da janela;
- calcular a pegada física efetiva e os indicadores de sobreposição e corte preservados pelo preview atual;
- comparar a geometria pedida com os bounds retornados pelo Chromium dentro de uma tolerância pequena de arredondamento.

A dependência da API `screen` ficará na borda desse módulo. O núcleo matemático receberá valores simples para poder ser testado sem iniciar Electron ou um navegador.

### Estado das janelas abertas

O handle do runtime distinguirá:

- o slot lógico atual;
- a escala ideal calculada para novos lançamentos;
- a escala efetivamente fixada quando aquele Chromium foi aberto.

Aplicar layout em uma janela aberta usará sua escala efetiva apenas para converter o novo retângulo físico em geometria do Chromium. A janela ocupará o mesmo slot mostrado no preview sem precisar reiniciar. Nenhuma mensagem sobre diferença de escala interna será exibida quando a geometria for aplicada com sucesso.

## Fluxos

### Preview

1. Resolver o monitor selecionado e suas métricas atuais.
2. Calcular os slots lógicos compartilhados.
3. Converter cada slot para o retângulo físico esperado, calcular a escala ideal e determinar sua pegada física efetiva.
4. Converter a pegada efetiva de volta para DIP e criar as janelas-fantasma, pois `BrowserWindow` opera corretamente nesse sistema de coordenadas.

O preview embutido no painel e as janelas-fantasma usarão os mesmos slots lógicos. Não haverá fórmula paralela no renderer. Quando a escala atingir o piso e o Chromium não couber na célula, o preview continuará exibindo os alertas de sobreposição e corte existentes.

### Abertura de novo navegador

1. Calcular o slot DIP e seu retângulo físico.
2. Calcular a escala ideal do Chromium usando as dimensões físicas.
3. Converter o retângulo físico para argumentos `--window-position` e `--window-size` com essa escala.
4. Iniciar o navegador com `--force-device-scale-factor` quando a escala for menor que 1.
5. Registrar separadamente a escala efetivamente lançada.

### Aplicação em janelas abertas

1. Recalcular os slots usando as métricas atuais do monitor.
2. Converter cada slot DIP para seu retângulo físico.
3. Produzir a geometria do Chromium usando a escala efetivamente lançada daquela janela, mesmo que a escala ideal atual seja diferente.
4. Aplicar os bounds por CDP sem fechar ou reabrir o perfil.
5. Consultar `Browser.getWindowBounds` e comparar com a geometria solicitada.
6. Atualizar o slot lógico do handle somente após uma aplicação confirmada.

O sucesso continua silencioso além do status normal de layout aplicado. Não haverá aviso para reabrir a janela por diferença de escala.

## Erros e tolerâncias

- Escalas ausentes, não finitas ou menores ou iguais a zero usam fallback seguro igual a 1 e geram diagnóstico técnico.
- Se o monitor salvo não existir mais, o runtime mantém o fallback atual para o monitor principal.
- Diferenças de até dois pixels por eixo ou dimensão são aceitas como arredondamento.
- Se o CDP não responder, rejeitar os bounds ou devolver divergência maior que a tolerância, a aplicação daquela janela falha sem interromper as demais.
- Uma falha real mantém a mensagem existente de janela que não respondeu ao reposicionamento; diferenças normais de escala interna não geram aviso.
- As métricas do monitor são resolvidas novamente em cada preview, lançamento e aplicação. Mudar o DPI do Windows não exige reiniciar o Spider BOT para que uma nova ação use os valores atuais.

## Testes automatizados

### Geometria pura

- Matrizes de escala do Windows em 100%, 125%, 150% e 200%.
- Grades 4×1 e 5×2, incluindo o cenário reproduzido de 1920×1080 físico, 1280×672 DIP e 150%.
- Invariante de que o último slot termina dentro da margem física esperada do monitor, descontada a área da barra de tarefas.
- Estabilidade da escala adaptativa para células com tamanho físico equivalente em DPIs diferentes.
- Arredondamento sem lacunas acumuladas relevantes na última linha e coluna.
- Grade densa que atinge o piso de escala e preserva a pegada maior, a sobreposição e o corte no preview.
- Monitor secundário à direita, à esquerda e acima do principal, com origem positiva ou negativa.
- Dois monitores com fatores de escala diferentes.

### Integração do runtime

- Novo lançamento recebe geometria calculada a partir do retângulo físico e registra a escala lançada separadamente.
- Janela aberta usa sua escala efetiva anterior, ocupa o novo retângulo físico e não solicita relaunch.
- Preview e aplicação selecionam exatamente os mesmos slots lógicos.
- `Browser.getWindowBounds` dentro da tolerância confirma sucesso.
- Bounds divergentes ou indisponíveis produzem falha individual sem falso sucesso.
- Alterar as métricas simuladas entre duas aplicações usa os novos valores, sem cache obsoleto.

Os testes existentes `npm test` e `npm run check` continuam obrigatórios.

## Validação manual

1. Em 100%, abrir uma grade 4×1, comparar preview e janelas reais e registrar os bounds.
2. Sem reiniciar o Spider BOT, mudar o Windows para 150%, usar grade 5×2, aplicar em janelas já abertas e confirmar ocupação de toda a área útil.
3. Fechar e reabrir os mesmos perfis em 150% e confirmar que o resultado externo permanece idêntico.
4. Repetir em 125% ou 200% para cobrir uma segunda escala não nativa.
5. Quando houver monitor secundário disponível, validar seleção, posição e tamanho com DPI igual e diferente do principal.
6. Confirmar que o preview embutido, as janelas-fantasma e as janelas reais concordam visualmente.

O relatório manual registrará escala do Windows, resolução física, `workArea`, `scaleFactor`, grade, geometria solicitada, bounds retornados e captura de tela.

## Critérios de aceite

- Em 100%, 125%, 150% e 200%, o layout usa toda a área útil prevista, respeitando margem e gap.
- No cenário 5×2 em 150%, as janelas deixam de terminar perto de 1280 pixels e passam a alcançar a largura física útil de uma tela 1920×1080.
- Preview e aplicação real não divergem além de dois pixels por eixo ou dimensão.
- Aplicar em janelas abertas não reinicia perfis e não mostra aviso de ajuste futuro de escala.
- Novas janelas e janelas já abertas ocupam os mesmos slots externos, ainda que tenham sido lançadas com escalas internas diferentes.
- Múltiplos monitores não sofrem deslocamento de origem nem usam o fator de escala do monitor errado.
- O runtime não informa sucesso quando o Chromium devolve bounds materialmente diferentes dos solicitados.
- `npm test` e `npm run check` passam.

## Documentação da decisão

A implementação registrará um ADR sobre a separação entre DIP, pixels físicos e escala interna do Chromium, incluindo a razão para usar conversão nativa do Electron e manter a escala lançada separada da escala ideal.

## Fora de escopo

- Reiniciar automaticamente navegadores para trocar `force-device-scale-factor`.
- Mostrar aviso sobre escala interna diferente da ideal.
- Alterar o fingerprint ou remover a máscara de `devicePixelRatio` existente.
- Permitir margem e gap personalizados; os valores fixos atuais permanecem.
- Criar um editor de slots customizados.
- Reorganizar automaticamente todas as janelas no instante em que o Windows emitir uma mudança de DPI; a ação continua ocorrendo por preview, abertura ou aplicação do usuário.

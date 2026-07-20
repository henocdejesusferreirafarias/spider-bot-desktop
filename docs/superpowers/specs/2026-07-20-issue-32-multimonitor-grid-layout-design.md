# Issue 32: organizador de janelas com grades multimonitor

## Contexto

A issue #32 foi aberta como uma evolução ampla do organizador de janelas, incluindo slots livres, drag, resize, presets e múltiplos monitores. Durante o design, o escopo foi reduzido: o produto continuará usando as grades de linhas e colunas atuais, mas permitirá selecionar, ordenar e configurar vários monitores independentemente.

A issue #28 já corrigiu a divergência entre preview e aplicação real. O `origin/main` agora contém um módulo lógico compartilhado em `src/shared/window-layout.ts`, conversão consciente de DPI em `src/main/services/window-geometry.ts` e validação dos bounds aplicados. Esta evolução deve aprofundar esse seam em vez de criar outro motor de layout.

## Objetivos

- Permitir que o usuário escolha quais monitores disponíveis serão usados pelo bot.
- Permitir uma grade independente de linhas e colunas para cada monitor.
- Permitir ordenar a prioridade dos monitores com ações de subir e descer.
- Distribuir perfis sequencialmente por todos os slots dos monitores habilitados.
- Preservar a sobreposição atual quando a quantidade de janelas exceder a capacidade total.
- Fazer preview embutido, preview fantasma, abertura e aplicação consumirem a mesma lista de slots.
- Preservar a correção de DPI da #28 em monitores com resoluções, escalas e origens diferentes.
- Migrar automaticamente a configuração atual de um monitor.
- Reutilizar o calibrador, os controles de grade e a barra de ações atuais, adicionando apenas uma barra lateral compacta de monitores.

## Fora de escopo

- Arrastar ou redimensionar slots.
- Layouts livres ou `customSlots`.
- Fixar um perfil específico a um monitor ou slot.
- Presets nomeados e múltiplos layouts salvos.
- Exibir prioridade, capacidade ou dimensão da grade dentro de cada item da lista lateral.
- Redesenhar o calibrador, os controles de coluna/linha ou os botões atuais.
- Impedir a abertura de janelas quando a capacidade total for excedida.

## Alternativas consideradas

1. Manter o modelo atual e adicionar um mapa de monitores extras. A migração seria menor, mas haveria duas fontes de verdade e condições especiais entre o primeiro monitor e os demais.
2. Evoluir o módulo atual para uma lista ordenada de grades por monitor. Esta é a opção escolhida porque mantém uma única fonte de verdade, reutiliza a geometria da #28 e cria uma interface pequena para renderer e runtime.
3. Criar um documento genérico de layout preparado para drag, resize e atribuição de perfis. Essa flexibilidade deixou de ter valor no escopo aprovado e aumentaria desnecessariamente a implementação e a migração.

## Modelo persistido

O layout passa a ser versionado:

```ts
interface ScreenLayoutSettings {
  version: 2;
  monitors: ScreenMonitorLayout[];
}

interface ScreenMonitorLayout {
  displayId: string;
  enabled: boolean;
  mode: "grid" | "cascade";
  columns: number;
  rows: number;
}
```

A posição de `ScreenMonitorLayout` no array é a prioridade. Não haverá um campo numérico redundante.

As seguintes invariantes serão mantidas:

- cada `displayId` aparece no máximo uma vez;
- linhas e colunas são inteiros maiores ou iguais a 1;
- gap e margem continuam fixos no módulo lógico atual;
- pelo menos um monitor conectado fica habilitado;
- configurações de monitores ausentes permanecem no array, mas não participam do layout efetivo;
- um monitor conectado sem configuração ganha um registro padrão desabilitado;
- `customSlots` não existe no formato v2.

O modo `cascade` permanece no modelo para compatibilidade com configurações existentes. Alterar linhas ou colunas continua selecionando `grid`, como ocorre hoje.

## Módulo lógico multimonitor

`src/shared/window-layout.ts` continuará sendo a fonte de verdade. Uma nova função pura receberá as configurações persistidas e os monitores atualmente disponíveis, chamará `buildLogicalLayout(...)` para cada monitor habilitado e retornará um resultado agregado semelhante a:

```ts
interface MultiDisplayLogicalLayout {
  displays: ResolvedDisplayLayout[];
  slots: MultiDisplayLogicalSlot[];
  capacity: number;
}

interface MultiDisplayLogicalSlot extends LogicalLayoutSlot {
  displayId: string;
  localSlotIndex: number;
  globalSlotIndex: number;
}
```

A interface deve esconder normalização, filtro de monitores ausentes, prioridade e concatenação dos slots. Renderer e runtime não reconstruirão essas regras.

Para dois monitores `5×2`, o resultado contém vinte slots globais:

- primeiro monitor: slots globais 0–9;
- segundo monitor: slots globais 10–19.

O slot efetivo de uma janela usa `requestedSlotIndex % capacity`. Assim, a vigésima primeira janela volta ao primeiro slot e mantém a sobreposição existente.

## Reconciliação de monitores

`screen.getAllDisplays()` continua definindo quais monitores aparecem na interface. Um monitor que o Windows/Electron não considera disponível:

- não aparece na barra lateral;
- não participa do preview, da abertura ou da aplicação;
- mantém silenciosamente seu registro persistido.

Ao retornar com o mesmo `displayId`, recupera habilitação, posição no array e grade anteriores.

Se nenhum registro habilitado corresponder a um monitor disponível, o monitor principal será habilitado como fallback. A tela de organização persiste essa reconciliação ao carregar ou atualizar a lista; o runtime usa o mesmo fallback imediatamente para nunca ficar sem slots.

## Experiência da tela

A única estrutura visual nova será uma barra lateral compacta ao lado esquerdo do organizador atual.

Cada item visível contém apenas:

- checkbox ou chave de habilitação;
- nome do monitor e indicação do principal;
- resolução/escala já disponíveis em `ScreenDisplayInfo`;
- botões de subir e descer.

O item selecionado recebe o estado visual de acento já usado pelo Spider BOT. Clicar no corpo do item seleciona o monitor editado sem alterar seu checkbox. O checkbox controla participação na distribuição. Os botões reordenam o array persistido; ações impossíveis no primeiro ou último item ficam desabilitadas.

Reordenar troca as posições dos dois registros conectados no array completo. Registros de monitores ausentes permanecem onde estavam e mantêm sua ordem relativa. Assim, uma desconexão temporária não altera silenciosamente a prioridade que será recuperada quando o monitor voltar.

A última desmarcação de um monitor conectado é impedida. Monitores desconectados não aparecem, nem mesmo como itens indisponíveis.

O restante da tela permanece como está:

- título do calibrador;
- simulação da grade com os slots;
- controles de coluna e linha na barra inferior;
- botão de pré-visualização;
- botão `Aplicar Agora`.

Selecionar outro monitor troca o calibrador e os controles para a configuração daquele monitor. Alterar linha ou coluna continua persistindo por `onUpdate`, como hoje. `Aplicar Agora` continua sendo a ação que reposiciona as janelas abertas.

A barra lateral usará os tokens existentes de `app.css`: fundos `#0a0a0a`/`#141414`, bordas translúcidas, raios compactos e vermelho `#dc2626`/`#ef4444` como acento. Não será criado um sistema visual paralelo.

## Fluxo de preview, abertura e aplicação

### Preview embutido

O renderer resolve o layout agregado pelo módulo compartilhado e mostra apenas os slots do monitor selecionado. Números exibidos podem usar a ordem local para manter a leitura simples; a associação interna continua global.

### Preview fantasma

`getLayoutPreviewRects(...)` percorre todos os slots globais dos monitores habilitados. Cada slot usa o display correspondente para a conversão DIP/física da #28. As janelas-fantasma aparecem simultaneamente em todos os monitores ativos.

### Abertura

O runtime aloca um índice global. O módulo lógico resolve o monitor e o slot local; `window-geometry.ts` converte o retângulo usando as métricas daquele display. Quando todos os slots já estiverem ocupados, o índice continua crescendo e sua resolução por módulo reinicia a distribuição no primeiro monitor.

### Aplicação em janelas abertas

`applyLayout(...)` ordena os handles pelo slot global e redistribui do primeiro slot em diante. Cada janela usa sua escala efetivamente lançada e os bounds são confirmados por CDP, preservando a decisão da #28. Uma falha individual não interrompe as demais janelas.

## Persistência e migração

O SQLite continua armazenando `AppSettings` como JSON; não é necessária migração de schema.

Ao carregar um formato antigo:

1. criar `version: 2`;
2. criar um único registro para o `monitorId` anterior;
3. preservar `mode`, `columns` e `rows`;
4. habilitar esse registro;
5. quando o valor legado for `"primary"`, mantê-lo como sentinel transitório até a reconciliação receber `screen.getPrimaryDisplay().id`, substituí-lo pelo ID concreto e persistir o resultado;
6. usar o monitor principal quando outro identificador antigo não for válido;
7. descartar `gap`, `margin` customizados e `customSlots`, mantendo os valores fixos atuais.

A normalização não deve remover registros ausentes quando o renderer salvar alterações nos monitores conectados.

## Erros e comportamento defensivo

- A UI impede a última desmarcação e informa o motivo sem alterar a configuração.
- Se o único monitor habilitado desaparecer fora da tela de organização, o principal disponível é usado imediatamente.
- Ausência de slots após normalização é um erro técnico; o runtime registra diagnóstico e usa o layout padrão do principal.
- Falha de conversão, sessão CDP, aplicação ou readback afeta somente a janela correspondente.
- Bounds com diferença de até dois pixels continuam aceitos; divergências maiores não são informadas como sucesso.
- Alterações de resolução, posição ou DPI são lidas novamente em cada preview, abertura e aplicação.

## Testes automatizados

### Módulo lógico

- duas grades diferentes são concatenadas na ordem configurada;
- reordenar monitores altera a ordem dos slots globais;
- monitor desabilitado ou ausente não produz slots;
- a configuração de um monitor ausente é preservada e volta quando o display reaparece;
- nenhum monitor ativo aplica fallback no principal;
- a capacidade é a soma das grades habilitadas;
- índices iguais ou maiores que a capacidade reiniciam por módulo;
- cascata antiga continua produzindo oito slots;
- migração v1 → v2 preserva monitor, modo, linhas e colunas;
- entradas duplicadas, eixos inválidos e formato parcial são normalizados.

### Renderer

- clicar no item troca o monitor editado sem mudar sua habilitação;
- checkbox altera somente `enabled`;
- a última desmarcação é recusada;
- subir/descer troca os registros conectados sem mover ou perder configurações ocultas;
- controles existentes editam somente o monitor selecionado;
- somente monitores disponíveis aparecem na lista.

### Runtime e geometria

- preview, abertura e aplicação usam a mesma sequência global;
- cada slot usa bounds, work area e DPI do monitor correto;
- origens negativas e positivas permanecem corretas;
- duas janelas em monitores com escalas diferentes geram geometrias independentes;
- falha de uma janela não bloqueia as demais;
- readback divergente continua rejeitando falso sucesso.

`npm test`, `npm run check` e `git diff --check` são gates obrigatórios.

## QA manual

1. Conectar dois monitores com resoluções e, quando possível, DPIs diferentes.
2. Habilitar ambos, configurar `5×2` em cada um e confirmar a prévia individual.
3. Abrir vinte perfis e confirmar dez janelas no primeiro monitor e dez no segundo.
4. Abrir janelas adicionais e confirmar que a sobreposição reinicia no primeiro slot.
5. Alterar a prioridade e aplicar novamente, confirmando a inversão da distribuição.
6. Desabilitar um monitor e confirmar que a última desmarcação é impedida.
7. Desconectar um monitor, confirmar que desaparece da lista e aplicar apenas no restante.
8. Reconectar o monitor e confirmar a recuperação silenciosa de grade, habilitação e ordem.
9. Comparar preview fantasma, geometria solicitada e bounds reais em ambos os monitores.
10. Reiniciar o aplicativo e confirmar a persistência e a migração do layout anterior.

O relatório manual deve registrar displays disponíveis, ordem, grades, fatores de escala, slots globais, geometria solicitada, bounds retornados e capturas de tela.

## Critérios de aceite

- A barra lateral lista somente monitores conectados e permite habilitar, selecionar e reordenar.
- O usuário não consegue desmarcar o último monitor conectado.
- Cada monitor mantém sua própria configuração de linha, coluna e modo.
- Duas grades `5×2` distribuem vinte janelas como dez no primeiro monitor e dez no segundo.
- Janelas excedentes reiniciam no primeiro slot e se sobrepõem como no comportamento atual.
- Monitores ausentes não aparecem nem recebem janelas, mas recuperam a configuração quando voltam.
- Preview embutido, preview fantasma, abertura e aplicação usam a mesma fonte de verdade.
- A conversão DPI e a validação de bounds da #28 permanecem válidas por monitor.
- O formato antigo é migrado sem perder a grade existente.
- O visual novo se limita à barra lateral e reutiliza a identidade e os controles atuais.
- Testes automatizados, typecheck e QA manual passam.

## Documentação da decisão

A implementação registrará um ADR explicando o layout global como concatenação ordenada de grades por monitor, a preservação silenciosa de configurações ausentes e a reutilização da geometria consciente de DPI da ADR 0010.

## Pontos de implementação

- `src/shared/contracts.ts`
- `src/shared/defaults.ts`
- `src/shared/window-layout.ts`
- `src/renderer/components/ScreenLayoutPanel.tsx`
- `src/renderer/styles/app.css`
- `src/renderer/hooks/usePredatorApp.ts`
- `src/preload/index.ts`
- `src/main/index.ts`
- `src/main/services/browser-runtime.ts`
- `src/main/services/database.ts`
- `test/window-layout.test.ts`
- `test/window-geometry.test.ts`
- `test/window-layout-runtime.test.ts`

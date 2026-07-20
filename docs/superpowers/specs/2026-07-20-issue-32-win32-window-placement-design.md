# Issue 32: posicionamento físico de janelas via Win32

## Contexto e causa raiz

A grade multimonitor distribui corretamente os slots em DIP e o Electron converte esses slots para retângulos físicos corretos. No cenário reproduzido, o monitor principal ocupa `0..1919`, o secundário ocupa `1920..4319` e o primeiro slot do secundário começa próximo de `x = 1928`.

O deslocamento aparece na fronteira com o Chromium. Quando a grade exige `--force-device-scale-factor` menor que 1, o Chromium mantém uma origem própria para o monitor secundário. Com escala interna `0.94`, por exemplo, o Windows inicia o monitor em `1920`, enquanto o Chromium expõe uma origem próxima de `2042`. `Browser.setWindowBounds` e `Browser.getWindowBounds` usam esse mesmo espaço interno; por isso o readback confirma os valores pedidos mesmo quando `GetWindowRect` mostra a janela fisicamente deslocada.

A correção anterior, que dividiu a coordenada global pela escala interna, reduziu o deslocamento, mas não compensou a translação da origem própria do monitor. Continuar ajustando a fórmula do CDP dependeria de detalhes internos e versões do Chromium.

O Spider BOT continuará exclusivo para Windows. A posição física final pode, portanto, usar a API Win32 como fonte de verdade sem carregar uma abstração multiplataforma sem uso.

## Objetivos

- Posicionar cada janela exatamente no `x/y` físico calculado para seu slot.
- Preservar o tamanho e a escala interna que já encaixam corretamente na grade.
- Funcionar com monitores à direita, à esquerda ou acima do principal, com resoluções e DPIs distintos.
- Reutilizar o mesmo mecanismo na abertura e em `Aplicar Agora`.
- Processar várias janelas em um único lote transitório, sem serviço residente ou polling.
- Nunca mover um Chrome pessoal, uma janela de outro perfil ou outra instância do Spider BOT.
- Falhar de forma isolada: uma janela não localizada não impede as demais nem fecha o navegador.

## Fora de escopo

- Suporte a macOS ou Linux.
- Remover `--force-device-scale-factor` ou alterar fingerprint, zoom ou conteúdo da página.
- Redimensionar janelas pela API Win32; o tamanho continua sob responsabilidade do Chromium/CDP.
- Monitoramento contínuo de movimentos feitos pelo usuário.
- Introduzir addon nativo Node/Electron.
- Alterar seleção, prioridade, persistência ou visual da lista de monitores.

## Alternativas consideradas

1. **Posicionamento final via Win32.** Opção escolhida. Mantém o Chromium responsável pelo tamanho e pela escala interna, mas aplica a posição física final com `SetWindowPos` e valida com `GetWindowRect`.
2. **Nova compensação matemática no CDP.** Teria alteração menor, mas continuaria acoplada à origem interna do Chromium e seu readback não provaria a posição física.
3. **Remover a escala forçada.** Eliminaria a interação defeituosa, mas mudaria o encaixe das grades densas, fingerprint e legibilidade. O impacto excede o bug.
4. **Addon nativo como `ffi-napi` ou equivalente.** Evitaria iniciar PowerShell, mas adicionaria binário nativo, compatibilidade de ABI, assinatura e risco de empacotamento para uma operação eventual.

## Arquitetura

Um novo módulo `windows-window-placement.ts` no processo principal terá uma interface pequena e Windows-only. Ele receberá um lote de alvos:

```ts
interface NativeWindowPlacementTarget {
  profileId: string;
  userDataDir: string;
  x: number;
  y: number;
}

interface NativeWindowPlacementResult {
  profileId: string;
  status: "positioned" | "window-not-ready" | "failed";
  actual?: { x: number; y: number };
  error?: string;
}
```

O módulo manterá uma fila em memória indexada por perfil. Novas solicitações substituem coordenadas antigas do mesmo perfil. Um debounce curto, entre 250 e 500 ms, retira um snapshot da fila e executa um único lote. Solicitações recebidas durante a execução ficam para o lote seguinte.

O helper será um comando PowerShell codificado e mantido no próprio módulo, iniciado com `-NoProfile`, `-NonInteractive`, `-WindowStyle Hidden` e `-EncodedCommand`. Os alvos serão enviados como JSON pelo `stdin`; resultados serão emitidos como JSON pelo `stdout`. Assim, não há script externo para copiar ao pacote nem mudança em `extraResources`.

O PowerShell fará `Add-Type` de uma ponte C# mínima para:

- `EnumWindows`;
- `GetWindowThreadProcessId`;
- `GetClassName`;
- `IsWindowVisible`;
- `SetWindowPos`;
- `GetWindowRect`.

Uma única consulta `Get-CimInstance Win32_Process` listará processos `chrome.exe` e `chromium.exe` e suas linhas de comando. O helper cruzará o `--user-data-dir` normalizado com cada alvo e aceitará apenas janelas visíveis da classe `Chrome_WidgetWin_1` cujo PID pertença ao conjunto daquele perfil. A comparação de caminhos será case-insensitive e exigirá correspondência do valor completo do argumento, não um fragmento curto.

`SetWindowPos` usará `SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE`. Portanto, o helper altera somente `x/y`, não rouba foco, não muda a ordem das janelas e não interfere no tamanho já estabelecido.

## Fluxo operacional

### Abertura

1. O runtime calcula o slot e abre o Chromium com os argumentos aproximados atuais.
2. O CDP aplica tamanho, escala e bounds como hoje.
3. Assim que a página primária estiver disponível e o perfil puder ser associado ao seu `user-data-dir`, o runtime enfileira o `x/y` de `targetPhysicalRect`.
4. Lançamentos próximos são consolidados em um lote.
5. O helper localiza cada `HWND`, move a janela e lê novamente seu retângulo físico.
6. O slot do handle só é considerado aplicado quando a posição nativa for confirmada dentro da tolerância.

### Aplicar Agora

1. O runtime recalcula todos os slots com as métricas atuais dos monitores.
2. O CDP atualiza dimensões e normaliza o estado das janelas.
3. Todos os handles recebem a posição física final em uma única reconciliação Win32.
4. O resultado agregado mantém sucesso ou falha por janela; uma falha não interrompe as demais.

### Concorrência

- Haverá no máximo um helper em execução por `BrowserRuntimeService`.
- A fila é coalescida por `profileId`; somente a posição mais recente é aplicada.
- O fechamento de um perfil remove sua solicitação pendente.
- Uma alteração de layout durante um lote cria um novo lote com a revisão mais recente, evitando que um resultado antigo seja tratado como definitivo.

## Tentativas, timeout e fallback

Uma janela pode ainda não possuir `HWND` quando o contexto do Patchright já existe. Resultados `window-not-ready` serão reenfileirados no máximo três vezes com atraso curto. Cada lote terá timeout limitado; o processo PowerShell será encerrado se excedê-lo.

Depois das tentativas:

- `positioned`: `GetWindowRect` confirmou `x/y` dentro de dois pixels;
- `window-not-ready`: nenhuma janela segura foi encontrada para o perfil;
- `failed`: o helper, a API Win32 ou a validação apresentou erro.

Falhas mantêm a janela aberta no posicionamento aproximado do CDP, registram diagnóstico técnico com `profileId` e não alteram outros perfis. Saída inválida, timeout ou execução bloqueada do PowerShell são tratados como falha do lote, sem exceção não capturada no runtime.

## Segurança de associação

O helper nunca selecionará uma janela apenas por título, posição ou nome `chrome.exe`. Para mover uma janela, todas as condições devem ser verdadeiras:

- `userDataDir` não vazio e suficientemente específico;
- linha de comando contém o argumento completo `--user-data-dir` daquele perfil;
- PID do `HWND` pertence a esse conjunto de processos;
- janela visível;
- classe exatamente `Chrome_WidgetWin_1`;
- existe uma associação não ambígua para o perfil.

Zero ou múltiplos candidatos ambíguos resultam em `window-not-ready` ou `failed`; o helper não escolhe arbitrariamente. Perfis e instâncias já usam diretórios distintos, preservando o isolamento existente no encerramento escopado de processos.

## Desempenho e recursos

O mecanismo é orientado a eventos. Não há processo residente, timer de polling ou enumeração contínua.

Para vinte janelas abertas em massa:

- um debounce produz um lote;
- uma consulta CIM lista todos os Chromiums;
- uma enumeração Win32 lista todas as janelas;
- até vinte chamadas de posicionamento e validação são feitas;
- o PowerShell termina e libera toda a memória.

O custo relevante é a inicialização transitória do PowerShell e do `Add-Type`; as chamadas Win32 são pequenas. A implementação registrará duração, quantidade de alvos, tentativas e resultado do lote. O critério é não deixar processo residual nem aumentar perceptivelmente o tempo total de abertura frente ao custo dos próprios navegadores.

## Testes automatizados

O módulo separará funções puras da execução do helper para permitir testes sem mover janelas reais:

- normalização e validação de `userDataDir`;
- coalescência da fila por perfil;
- somente um lote simultâneo;
- solicitação nova durante execução gera lote posterior;
- remoção de perfil cancela alvo pendente;
- parsing de resultado único, múltiplo, vazio ou inválido do PowerShell;
- retry somente para `window-not-ready` e dentro do limite;
- timeout e erro do helper não escapam nem bloqueiam outros perfis;
- resultados fora da tolerância não são aceitos;
- lote de vinte perfis produz uma única invocação;
- seleção ambígua nunca resulta em comando de movimento.

Os testes do runtime verificarão que:

- lançamento e `Aplicar Agora` enfileiram `targetPhysicalRect.x/y`, não coordenadas internas do CDP;
- o tamanho continua aplicado pelo CDP;
- sucesso exige confirmação nativa;
- falha individual não impede a atualização dos demais handles;
- o teste antigo não simula mais posição física como `geometry * scale`.

`npm test`, `npm run check` e `git diff --check` permanecem gates obrigatórios.

## Validação Windows

Além dos testes puros, um harness manual Windows-only usará o Chromium gerenciado pelo Spider BOT e comparará o alvo com `GetWindowRect`:

1. monitor secundário à direita, grade `5x2` e escala interna próxima de `0.94`;
2. monitor secundário à esquerda;
3. monitor secundário acima;
4. resoluções e escalas do Windows distintas;
5. vinte janelas reconciliadas em um lote;
6. `Aplicar Agora` em janelas existentes;
7. Chrome pessoal aberto, confirmando que não é movido;
8. confirmação de que nenhum PowerShell permanece após o lote.

O teste manual visual final continuará sob responsabilidade do usuário. A implementação automatizará as verificações que não dependem da configuração física de vários monitores.

## Critérios de aceite

- A borda externa de cada janela fica a até dois pixels do `x/y` físico do slot em qualquer origem de monitor suportada pelo Windows.
- O segundo monitor não invade o primeiro quando a grade usa escala interna menor que 1.
- Tamanho, espaçamento e escala visual existentes permanecem inalterados.
- Abertura e `Aplicar Agora` usam o mesmo reconciliador nativo.
- Vinte solicitações próximas são processadas por um único helper.
- Não existe PowerShell ou serviço auxiliar residente após a aplicação.
- Chrome pessoal, outros perfis e outras instâncias não são movidos.
- Falha de uma janela não fecha navegadores nem bloqueia as demais.
- Testes, typecheck e verificação de diff passam.

## Pontos de implementação

- `src/main/services/windows-window-placement.ts` — fila, debounce, execução e parsing do helper.
- `src/main/services/browser-runtime.ts` — integração na abertura, aplicação, fechamento e diagnóstico.
- `src/main/services/window-geometry.ts` — manter tamanho do Chromium e remover afirmações incorretas sobre posição física derivada do CDP.
- `test/windows-window-placement.test.ts` — fila, parsing, retry, timeout e isolamento.
- `test/window-layout-runtime.test.ts` — integração e confirmação nativa.
- `test/window-geometry.test.ts` — retirar a falsa prova `geometry * scale`.
- `docs/adr/0012-posicionamento-fisico-win32.md` — registrar Win32 como autoridade final de posição.

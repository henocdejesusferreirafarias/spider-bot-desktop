# ADR 0012: Posicionamento físico de janelas via Win32

## Status

Aceito.

## Contexto

A grade multimonitor calcula slots em DIP e usa `screen.dipToScreenRect()` para
obter os retângulos físicos corretos. Em grades densas, o Chromium é iniciado
com `--force-device-scale-factor` menor que 1 para preservar tamanho e
legibilidade. Nessa combinação, um monitor secundário com origem diferente de
zero ganha uma origem própria no espaço interno do Chromium.

No caso reproduzido, o Windows iniciava o monitor direito em `x=1920`, mas o
Chromium com escala interna `0.94` expunha origem próxima de `2042`.
`Browser.setWindowBounds` e `Browser.getWindowBounds` compartilhavam esse mesmo
espaço; portanto, o readback repetia o valor pedido enquanto `GetWindowRect`
mostrava a janela aproximadamente 117 pixels à esquerda.

Ajustar novamente a fórmula do CDP manteria o código dependente de detalhes
internos e da versão do Chromium. O produto continuará exclusivo para Windows.

## Decisão

O Electron permanece a fonte do retângulo físico desejado. O CDP continua
normalizando o estado e aplicando as dimensões compensadas pela escala interna,
mas a posição externa final (`x/y`) passa a ser aplicada e confirmada por Win32.

Um serviço orientado a eventos agrupa solicitações próximas e inicia um único
Windows PowerShell oculto e transitório. O helper:

- declara o processo como `PER_MONITOR_AWARE_V2`;
- recebe alvos em JSON pelo `stdin`;
- consulta uma vez os processos Chromium e enumera uma vez as janelas;
- associa o argumento completo `--user-data-dir` ao PID;
- exige janela visível da classe `Chrome_WidgetWin_1`;
- chama `SetWindowPos` com `SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE`;
- confirma `x/y` por `GetWindowRect`, com tolerância de dois pixels;
- devolve um resultado isolado por perfil e encerra.

Zero candidatos, múltiplos candidatos ou associação incompleta são fail-closed.
O helper nunca escolhe por título nem apenas pelo nome do executável. Somente
`window-not-ready` recebe até três tentativas curtas; falhas definitivas não são
repetidas.

`Aplicar Agora` executa CDP para os candidatos e envia todos os posicionamentos
físicos válidos em um lote. O handle só recebe o novo slot depois da confirmação
nativa. Durante um lançamento, falha nativa degrada para a posição aproximada
do CDP, registra diagnóstico e não fecha o navegador.

## Consequências

- origem positiva ou negativa de monitor deixa de depender do espaço interno do Chromium;
- tamanho, escala, conteúdo e fingerprint permanecem inalterados;
- o helper consome recursos apenas durante abertura ou aplicação do layout;
- não há processo residente, polling, arquivo temporário ou addon nativo;
- Chrome pessoal, outro perfil ou outra instância não são movidos sem associação completa;
- uma falha individual não bloqueia as demais janelas;
- macOS e Linux não são suportados por esta decisão;
- o readback CDP continua útil para dimensões, mas não comprova posição física.

## Verificação

```powershell
npx tsx --test test/windows-window-placement.test.ts test/window-layout-runtime.test.ts test/window-geometry.test.ts
npm test
npm run check
npm run build
git diff --check
```

Uma sonda segura com `user-data-dir` inexistente também deve compilar e executar
o helper real, retornando `window-not-ready` sem mover janela. A aceitação física
final exige reteste do usuário com dois monitores e escala interna menor que 1.

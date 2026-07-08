# 0003 — Modo espelho coexiste com a emulação de toque

- **Status:** Aceito
- **Data:** 2026-07-08
- **Componente:** `src/main/services/browser-runtime.ts`

## Contexto

O **modo espelho** replica cada ação (clique/tecla/scroll) de uma janela-fonte para as demais
janelas selecionadas. Ele captura eventos no mundo principal via um script CDP e reproduz nos
destinos com `Input.dispatchMouseEvent` / `Input.dispatchTouchEvent` / `Input.dispatchKeyEvent`,
usando uma sessão CDP dedicada por página (`mirrorSessions`).

Em paralelo, os perfis mobile-emulados dependem da **emulação de toque**: um watchdog
(`startTouchEmulationWatchdog`) reaplica a cada ~1.5s `Emulation.setTouchEmulationEnabled` +
`Emulation.setEmitTouchEventsForMouse` numa sessão CDP separada (`gameTouchEmulationSessions`).
Isso é necessário porque o stealth do Patchright **reverte silenciosamente** esses overrides
após certas operações CDP/automação, e sem eles `navigator.maxTouchPoints`/`ontouchstart` e a
ponte mouse→touch degradam. Os fluxos de depósito/saque tocam a tela via
`page.touchscreen.tap`, que só é escolhido quando `prefersTouchTap` (checa
`maxTouchPoints > 0 || "ontouchstart" in window`) retorna verdadeiro.

## Problema

Ao ativar o espelho, a emulação de toque parava — quebrando os fluxos mobile (depósito/saque
dependem de touch sintético) — e o espelho era instável.

A implementação anterior **pausava o watchdog por toda a sessão do espelho**:

```ts
if (!this.mirrorEnabled) {
  this.gameTouchEmulationState.delete(page);
  await this.updateGameTouchEmulation(page, mobileLike);
}
```

A intenção era evitar que a atividade CDP constante do watchdog (`Emulation.*` a cada 1.5s)
rodasse **concorrente** com o tráfego do espelho (`Input.*`/`Runtime.*`) na mesma página — o
Patchright desestabiliza/desanexa sessões sob esse tipo de concorrência, causando a
intermitência. Mas pausar por completo tem um efeito colateral fatal: quando o Patchright
reverte a emulação de toque, ela **nunca é reparada** enquanto o espelho está ligado. O toque
decai, `prefersTouchTap` passa a retornar `false`, e depósito/saque (e frames de jogo) param.

## Decisão

Em vez de **pausar** a emulação de toque durante o espelho, **adiar** o tick do watchdog apenas
enquanto há uma rajada de replay em andamento **naquela página**:

- Novo `mirrorReplayActiveUntil: WeakMap<Page, number>`, marcado sincronamente no início de
  `dispatchMirrorEventToPage` com `now + MIRROR_REPLAY_CLEAR_DELAY_MS` (350 ms) — espelhando o
  `mirrorReplayBlockedUntil` que já era setado ali.
- Novo helper `isMirrorReplayActive(page)` (`mirrorReplayActiveUntil.get(page) > now`).
- O guard do watchdog troca `!this.mirrorEnabled` por `!this.isMirrorReplayActive(page)`.
- Limpeza do `WeakMap` na navegação do frame principal, junto dos demais caches por página.

Consequência do desenho: `Emulation.*` nunca roda concorrente com o `Input.*`/`Runtime.*` do
espelho na mesma página (remove a fonte da intermitência), mas o toque volta a ser reaplicado
nos intervalos entre rajadas. A **janela-fonte não recebe replay** → seu `mirrorReplayActiveUntil`
nunca é marcado → seu watchdog roda normalmente e o toque nela permanece intacto durante todo o
espelho. Com o espelho desligado, o comportamento é idêntico ao anterior (nenhuma página tem
replay ativo).

## Consequências

- ✅ Emulação de toque permanece viva com o espelho ligado; depósito/saque e frames de jogo
  voltam a funcionar.
- ✅ A concorrência CDP que desestabilizava o espelho continua eliminada (adiamento durante a
  rajada, em vez de execução concorrente).
- ✅ Mudança cirúrgica e localizada (um `WeakMap`, um helper, um guard) — sem tocar a hot path do
  replay nem fundir as sessões CDP (o espelho e a emulação seguem em sessões separadas, o que
  respeita a restrição do Patchright de não combinar `Emulation.*` com outras operações na mesma
  sessão).
- ⚠️ Durante uma rajada de replay ativa (~350 ms), uma janela de **destino** que também rode
  automação touch-dependente pode ver a emulação momentaneamente defasada. Na prática as duas
  coisas não coincidem na mesma janela/instante; a emulação é reaplicada assim que a rajada cessa.

## Verificação

- `npm run typecheck` limpo.
- Testes source-inspection adicionados em `test/mirror-runtime.test.ts`: o watchdog não gateia
  mais em `!this.mirrorEnabled` e passa a usar `isMirrorReplayActive`; `dispatchMirrorEventToPage`
  marca `mirrorReplayActiveUntil`.
- Suíte de testes: mesmas falhas pré-existentes/ambientais no baseline e no branch — **zero**
  regressões introduzidas.
- ⚠️ Verificação de runtime contra sites reais **pendente**: o comportamento do stealth do
  Patchright e a coexistência espelho×toque só se confirmam com N janelas mobile-emuladas em
  operação (depósito/saque com o espelho ligado). Recomendado validar em ambiente real antes do
  release.

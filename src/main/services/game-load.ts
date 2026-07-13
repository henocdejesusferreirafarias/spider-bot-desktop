// Deteccao e recuperacao de carga de jogo (Cocos/WebGL em iframe). O app nao abre
// o jogo programaticamente -- o usuario clica o tile e o iframe navega. Quando ha
// MUITAS janelas, a saturacao de CPU/GPU/rede faz o canvas nunca renderizar ou o
// loader do engine ficar preso ("A carregar", "ligacao a Internet esta lenta",
// "Atualizar"). Antes nao havia deteccao nem retry: falha silenciosa. Aqui ficam
// os SINAIS ESTRUTURAIS (seletor do canvas, regex do loader) e a decisao PURA de
// recuperacao, testavel sem browser.

// Seletor do canvas do jogo (Cocos classico e variantes). Mesmo conjunto usado
// pelos gates de speed/touch em browser-runtime.
export const GAME_CANVAS_SELECTOR =
  "#GameCanvas,canvas.gameCanvas,#gameCanvas,#Cocos2dGameContainer,#Cocos2dGameContainer canvas,canvas";

// Texto do loader/interstitial do engine enquanto o jogo ainda NAO comecou
// (inclui os avisos de rede lenta e os CTAs de re-tentar). Fonte: a mesma copy
// observada no gate de speed (isPgLoadingOrInterstitial).
export const GAME_LOADER_PATTERN =
  /A\s*carregar|A\s*iniciar\s*sess[aã]o|carregando|loading|Internet\s+est[aá]\s+lenta|lig[aá]?[cç][aã]o\s+[àa]\s+Internet|Atualizar|Aguardar|reconectar|reconnect|retry|tentar\s+novamente/i;

export type GameLoadSignal = {
  // Ha um canvas de jogo presente no frame?
  canvasPresent: boolean;
  // O loader/interstitial do engine esta visivel (jogo ainda nao comecou)?
  loaderVisible: boolean;
  // Tempo decorrido (ms) desde a ultima (re)navegacao do frame do jogo.
  elapsedMs: number;
  // Quantas recargas ja foram feitas para este carregamento.
  attempts: number;
};

export type GameLoadDecision =
  | { action: "ready" }
  | { action: "wait" }
  | { action: "reload"; reason: string }
  | { action: "giveup"; reason: string };

export type GameLoadOptions = {
  // Apos este tempo sem o jogo pronto, consideramos "preso" e agimos.
  stuckAfterMs?: number;
  // Maximo de recargas automaticas antes de desistir (e logar o motivo).
  maxReloadAttempts?: number;
};

export function shouldMonitorGameLoadFrame(input: {
  isMainFrame: boolean;
  isKnownGameFrame: boolean;
}): boolean {
  return !input.isMainFrame && input.isKnownGameFrame;
}

// Decisao PURA de recuperacao de carga do jogo, a partir de sinais estruturais
// (nao de espera fixa). Regras:
//  - canvas presente E sem loader -> jogo comecou: "ready" (NUNCA recarrega um
//    jogo em andamento; so agimos em estados presos);
//  - ainda dentro da janela de espera -> "wait" (jogo lento e normal);
//  - preso (sem canvas, ou loader ainda visivel) alem de stuckAfterMs:
//      - se ainda ha tentativas -> "reload" (recarrega o frame preso: seguro,
//        pois so ocorre quando o jogo nao comecou);
//      - senao -> "giveup" com o motivo (qual sinal nao chegou) -- sem falha calada.
export function decideGameLoadRecovery(
  signal: GameLoadSignal,
  options: GameLoadOptions = {}
): GameLoadDecision {
  const stuckAfterMs = options.stuckAfterMs ?? 12000;
  const maxReloadAttempts = options.maxReloadAttempts ?? 2;

  if (signal.canvasPresent && !signal.loaderVisible) {
    return { action: "ready" };
  }

  if (signal.elapsedMs < stuckAfterMs) {
    return { action: "wait" };
  }

  const missingSignal = !signal.canvasPresent
    ? "canvas do jogo nao apareceu"
    : "loader do jogo nao saiu (possivel lentidao de rede/recurso)";

  if (signal.attempts >= maxReloadAttempts) {
    return {
      action: "giveup",
      reason: `${missingSignal} apos ${signal.attempts} recarga(s)`
    };
  }

  return { action: "reload", reason: missingSignal };
}

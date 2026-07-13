import assert from "node:assert/strict";
import test from "node:test";
import {
  decideGameLoadRecovery,
  GAME_LOADER_PATTERN,
  shouldMonitorGameLoadFrame
} from "../src/main/services/game-load.js";

// decideGameLoadRecovery: nucleo da recuperacao de carga do jogo. So age em
// estados PRESOS (loader/ausencia de canvas) apos a janela de espera; nunca
// recarrega um jogo ja em andamento.

test("ready: canvas presente e sem loader = jogo comecou (nao recarrega)", () => {
  const decision = decideGameLoadRecovery({
    canvasPresent: true,
    loaderVisible: false,
    elapsedMs: 30000,
    attempts: 0
  });
  assert.deepEqual(decision, { action: "ready" });
});

test("wait: dentro da janela de espera, jogo lento e normal", () => {
  const decision = decideGameLoadRecovery({
    canvasPresent: false,
    loaderVisible: true,
    elapsedMs: 3000,
    attempts: 0
  });
  assert.equal(decision.action, "wait");
});

test("reload: preso alem do tempo com tentativas restantes -> recarrega com motivo", () => {
  const semCanvas = decideGameLoadRecovery({
    canvasPresent: false,
    loaderVisible: false,
    elapsedMs: 13000,
    attempts: 0
  });
  assert.equal(semCanvas.action, "reload");
  assert.match((semCanvas as { reason: string }).reason, /canvas/i);

  const loaderPreso = decideGameLoadRecovery({
    canvasPresent: true,
    loaderVisible: true,
    elapsedMs: 13000,
    attempts: 1
  });
  assert.equal(loaderPreso.action, "reload");
  assert.match((loaderPreso as { reason: string }).reason, /loader|lentidao/i);
});

test("giveup: esgotou as recargas -> desiste com motivo (nao falha calado)", () => {
  const decision = decideGameLoadRecovery(
    { canvasPresent: false, loaderVisible: true, elapsedMs: 20000, attempts: 2 },
    { maxReloadAttempts: 2 }
  );
  assert.equal(decision.action, "giveup");
  assert.match((decision as { reason: string }).reason, /2 recarga/);
});

test("opcoes: stuckAfterMs/maxReloadAttempts configuraveis", () => {
  // Com stuckAfterMs alto, ainda espera.
  assert.equal(
    decideGameLoadRecovery(
      { canvasPresent: false, loaderVisible: true, elapsedMs: 13000, attempts: 0 },
      { stuckAfterMs: 20000 }
    ).action,
    "wait"
  );
  // maxReloadAttempts=0 pula direto p/ giveup quando preso.
  assert.equal(
    decideGameLoadRecovery(
      { canvasPresent: false, loaderVisible: false, elapsedMs: 13000, attempts: 0 },
      { maxReloadAttempts: 0 }
    ).action,
    "giveup"
  );
});

test("GAME_LOADER_PATTERN casa os textos de loader/lentidao conhecidos", () => {
  assert.match("A carregar...", GAME_LOADER_PATTERN);
  assert.match("A sua ligação à Internet está lenta", GAME_LOADER_PATTERN);
  assert.match("Atualizar", GAME_LOADER_PATTERN);
  assert.doesNotMatch("Rodada vencedora! Saldo: 100", GAME_LOADER_PATTERN);
});

test("recuperacao nunca recarrega a pagina principal que apenas hospeda o jogo", () => {
  assert.equal(
    shouldMonitorGameLoadFrame({ isMainFrame: true, isKnownGameFrame: true }),
    false
  );
  assert.equal(
    shouldMonitorGameLoadFrame({ isMainFrame: false, isKnownGameFrame: true }),
    true
  );
  assert.equal(
    shouldMonitorGameLoadFrame({ isMainFrame: false, isKnownGameFrame: false }),
    false
  );
});

test("recuperacao nao monitora provedor cujo frame nao aceita reload seguro", () => {
  assert.equal(
    shouldMonitorGameLoadFrame({
      isMainFrame: false,
      isKnownGameFrame: true,
      supportsAutomaticReload: false
    }),
    false
  );
});

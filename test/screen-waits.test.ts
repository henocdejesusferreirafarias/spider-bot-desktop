import assert from "node:assert/strict";
import test from "node:test";
import type { Frame, Page } from "patchright";
import {
  waitForDepositSurface,
  waitForProfileSurface,
  waitForWithdrawalManagementDestination,
  waitForWithdrawalPasswordConfirmationDestination,
  waitForPixReceivingAccountSurface,
  waitForExistingWithdrawalPasswordModal,
} from "../src/main/services/screen-waits.js";

// A camada de esperas condicionais (screen-waits) faz polling de predicados de
// screen-detection ate o sinal aparecer, com o timeout so como rede de seguranca.
// Estes testes exercitam o CONTRATO dos loops sem browser real: um fake de Page
// cujo `evaluate` decide o predicado e cujo `waitForTimeout` resolve na hora.

function fakeFrame(url = "https://p.example/"): Frame {
  return { url: () => url, name: () => "" } as unknown as Frame;
}

// resolveContentFrame(page) devolve a propria page quando so ha o main frame, entao
// o predicado (hasProfileSurface/hasDepositSurface) chama page.evaluate diretamente.
function fakePage(evaluate: () => Promise<unknown>): Page {
  const main = fakeFrame();
  return {
    frames: () => [main],
    mainFrame: () => main,
    evaluate,
    waitForTimeout: async () => undefined
  } as unknown as Page;
}

function fakePixReceivingPage(
  states: Array<{ hasReceivingAccountArea: boolean; hasPixAddAction: boolean }>,
): Page {
  let index = 0;
  return fakePage(async () => {
    const state = states[Math.min(index, states.length - 1)]!;
    index += 1;
    return state;
  });
}

function fakeDestinationPage(destinations: Array<"needs_withdrawal_password" | "withdrawal_ready" | "unknown">): Page {
  let evaluations = 0;
  return fakePage(async () => {
    const destination = destinations[Math.min(Math.floor(evaluations / 3), destinations.length - 1)]!;
    const signal = evaluations % 3;
    evaluations += 1;
    if (destination === "needs_withdrawal_password") return signal === 0;
    if (destination === "withdrawal_ready") return signal === 1;
    return false;
  });
}

test("waitForProfileSurface: retorna true assim que a superficie aparece", async () => {
  let ticks = 0;
  // Superficie de perfil so na 3a checagem: garante que o loop de polling roda.
  const page = fakePage(async () => {
    ticks += 1;
    return ticks >= 3;
  });

  assert.equal(await waitForProfileSurface(page, 2000), true);
  assert.ok(ticks >= 3);
});

test("waitForProfileSurface: retorna a checagem final (false) no timeout, sem lancar", async () => {
  const page = fakePage(async () => false);
  assert.equal(await waitForProfileSurface(page, 30), false);
});

test("waitForProfileSurface: evaluate que rejeita e tratado como ausente (guard do catch)", async () => {
  const page = fakePage(async () => {
    throw new Error("frame detached");
  });
  assert.equal(await waitForProfileSurface(page, 30), false);
});

test("waitForDepositSurface: retorna true assim que a superficie de deposito aparece", async () => {
  const page = fakePage(async () => true);
  assert.equal(await waitForDepositSurface(page, 2000), true);
});

test("waitForDepositSurface: retorna a checagem final (false) no timeout, sem lancar", async () => {
  const page = fakePage(async () => false);
  assert.equal(await waitForDepositSurface(page, 30), false);
});

test("waitForWithdrawalManagementDestination: retorna setup assim que a superficie e confirmada", async () => {
  const page = fakePage(async () => true);

  assert.equal(
    await waitForWithdrawalManagementDestination(page, 2000),
    "needs_withdrawal_password"
  );
});

test("waitForWithdrawalPasswordConfirmationDestination: ignora setup transitorio ate o saque aparecer", async () => {
  const page = fakeDestinationPage([
    "needs_withdrawal_password",
    "needs_withdrawal_password",
    "withdrawal_ready",
  ]);

  assert.equal(
    await waitForWithdrawalPasswordConfirmationDestination(page, 2000),
    "withdrawal_ready",
  );
});

test("waitForPixReceivingAccountSurface: ignora sinais parciais ate a aba PIX estar pronta", async () => {
  const page = fakePixReceivingPage([
    { hasReceivingAccountArea: false, hasPixAddAction: false },
    { hasReceivingAccountArea: true, hasPixAddAction: false },
    { hasReceivingAccountArea: true, hasPixAddAction: true },
  ]);
  const readRoute = async () => ({
    name: "withdraw",
    path: "/home/withdraw",
    fullPath: "/home/withdraw?active=10",
    query: { active: "10" },
  });

  assert.equal(
    (await waitForPixReceivingAccountSurface(page, readRoute, 2000)).ready,
    true,
  );
});

test("waitForExistingWithdrawalPasswordModal: espera o prompt apos a transicao", async () => {
  let checks = 0;
  const page = fakePage(async () => {
    checks += 1;
    return checks >= 3;
  });

  assert.equal(await waitForExistingWithdrawalPasswordModal(page, 2000), true);
  assert.ok(checks >= 3);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { Frame, Page } from "patchright";
import {
  decideWithdrawalManagementDestination,
  decidePixReceivingAccountSignals,
  hasDepositSurface,
  isDetachedDepositRouteState,
  decideRegistrationCompletion
} from "../src/main/services/screen-detection.js";
import { resolveContentFrame } from "../src/main/services/automation-dom.js";

// A camada de deteccao de telas foi extraida de automation-runtime.ts como
// funcoes puras. Estes testes exercitam o modulo ISOLADAMENTE, sem instanciar o
// runtime nem um browser real -- so fakes de Page/Frame.

function fakeFrame(url: string, name = ""): Frame {
  return { url: () => url, name: () => name } as unknown as Frame;
}

test("isDetachedDepositRouteState: rota que nao e de recarga nunca e detached", () => {
  assert.equal(
    isDetachedDepositRouteState({ url: "https://p.example/home/mine", body: "" }),
    false
  );
});

test("isDetachedDepositRouteState: rota m_recharge com corpo vazio e detached", () => {
  assert.equal(
    isDetachedDepositRouteState({ url: "https://p.example/m_recharge", body: "" }),
    true
  );
});

test("isDetachedDepositRouteState: m_recharge com conteudo de deposito carregado NAO e detached", () => {
  const body =
    "Deposito via PIX. Informe o valor. Canal de pagamento. Gerar QR code. " +
    "Recarga rapida com metodo PIX e confirmacao imediata do pagamento.";
  assert.ok(body.length >= 120);
  assert.equal(
    isDetachedDepositRouteState({ url: "https://p.example/m_recharge", body }),
    false
  );
});

test("isDetachedDepositRouteState: firstrecharge com corpo longo sem palavras de deposito e detached", () => {
  const body = "x".repeat(200);
  assert.equal(
    isDetachedDepositRouteState({ url: "https://p.example/firstrecharge", body }),
    true
  );
});

test("isDetachedDepositRouteState: url malformada cai no fallback de string cru", () => {
  assert.equal(isDetachedDepositRouteState({ url: "m_recharge", body: "" }), true);
});

test("resolveContentFrame: sem frames filhos retorna a propria page", () => {
  const main = fakeFrame("https://p.example/home");
  const page = {
    frames: () => [main],
    mainFrame: () => main
  } as unknown as Page;
  assert.equal(resolveContentFrame(page), page);
});

test("resolveContentFrame: prefere o app frame (h5_iframe/redirect)", () => {
  const main = fakeFrame("https://p.example/");
  const appFrame = fakeFrame("https://p.example/h5_iframe?isredirect=1");
  const page = {
    frames: () => [main, appFrame],
    mainFrame: () => main
  } as unknown as Page;
  assert.equal(resolveContentFrame(page), appFrame);
});

test("resolveContentFrame: ignora frames de captcha e escolhe o de conteudo", () => {
  const main = fakeFrame("https://p.example/");
  const captcha = fakeFrame("https://geetest.com/captcha");
  const content = fakeFrame("https://p.example/dashboard");
  const page = {
    frames: () => [main, captcha, content],
    mainFrame: () => main
  } as unknown as Page;
  assert.equal(resolveContentFrame(page), content);
});

// decideRegistrationCompletion: nucleo da confirmacao de cadastro por SINAL
// ESTRUTURAL. Endurece o antigo "campo de conta sumiu => cadastrada": aqui so
// confirmamos com sessao ativa ou formulario ausente de forma estavel.

test("decideRegistrationCompletion: erro da plataforma encerra como falha (prioridade maxima)", () => {
  const decision = decideRegistrationCompletion({
    platformError: "conta ja existe",
    // Mesmo com sessao/ausencia, o erro vence: nao cadastrou.
    registrationFormPresent: false,
    activeSession: true,
    consecutiveFormAbsences: 9
  });
  assert.deepEqual(decision, {
    status: "failed",
    via: "erro-plataforma",
    reason: "conta ja existe"
  });
});

test("decideRegistrationCompletion: formulario ainda presente => pendente (tela nao saiu)", () => {
  // Este e o caso que causava o falso-positivo: a tela ainda esta carregando/
  // presente. NAO pode assumir cadastrada.
  const decision = decideRegistrationCompletion({
    registrationFormPresent: true,
    activeSession: false,
    consecutiveFormAbsences: 0
  });
  assert.equal(decision.status, "pending");
});

test("decideRegistrationCompletion: sessao ativa confirma o cadastro (sinal forte)", () => {
  const decision = decideRegistrationCompletion({
    registrationFormPresent: false,
    activeSession: true,
    consecutiveFormAbsences: 1
  });
  assert.deepEqual(decision, { status: "registered", via: "sessao-ativa" });
});

test("decideRegistrationCompletion: formulario ausente porem instavel ainda e pendente", () => {
  // Uma unica ausencia (form pode sumir e voltar num re-render) nao basta.
  const decision = decideRegistrationCompletion({
    registrationFormPresent: false,
    activeSession: false,
    consecutiveFormAbsences: 1
  });
  assert.equal(decision.status, "pending");
});

test("decideRegistrationCompletion: ausencia estavel sem sessao confirma via fallback", () => {
  const decision = decideRegistrationCompletion({
    registrationFormPresent: false,
    activeSession: false,
    consecutiveFormAbsences: 3
  });
  assert.deepEqual(decision, {
    status: "registered",
    via: "formulario-encerrado"
  });
});

test("decideRegistrationCompletion: minFormAbsences configuravel endurece o fallback", () => {
  const signal = {
    registrationFormPresent: false,
    activeSession: false,
    consecutiveFormAbsences: 3
  };
  assert.equal(
    decideRegistrationCompletion(signal, { minFormAbsences: 5 }).status,
    "pending"
  );
  assert.equal(
    decideRegistrationCompletion(
      { ...signal, consecutiveFormAbsences: 5 },
      { minFormAbsences: 5 }
    ).status,
    "registered"
  );
});

test("hasDepositSurface: repassa o resultado do evaluate do frame resolvido", async () => {
  const main = fakeFrame("https://p.example/");
  const page = {
    frames: () => [main],
    mainFrame: () => main,
    evaluate: async () => true
  } as unknown as Page;
  assert.equal(await hasDepositSurface(page), true);
});

test("hasDepositSurface: retorna false quando o evaluate rejeita (guard do catch)", async () => {
  const main = fakeFrame("https://p.example/");
  const page = {
    frames: () => [main],
    mainFrame: () => main,
    evaluate: async () => {
      throw new Error("frame detached");
    }
  } as unknown as Page;
  assert.equal(await hasDepositSurface(page), false);
});

test("Withdrawal Management destination requires the password setup surface", () => {
  assert.equal(
    decideWithdrawalManagementDestination({
      hasPasswordSetupSurface: true,
      hasWithdrawalAccountSurface: true,
      hasWithdrawalRequestSurface: true
    }),
    "needs_withdrawal_password"
  );
});

test("Withdrawal Management destination accepts a real withdrawal surface", () => {
  assert.equal(
    decideWithdrawalManagementDestination({
      hasPasswordSetupSurface: false,
      hasWithdrawalAccountSurface: true,
      hasWithdrawalRequestSurface: false
    }),
    "withdrawal_ready"
  );
});

test("Withdrawal Management destination stays unknown without a confirmed surface", () => {
  assert.equal(
    decideWithdrawalManagementDestination({
      hasPasswordSetupSurface: false,
      hasWithdrawalAccountSurface: false,
      hasWithdrawalRequestSurface: false
    }),
    "unknown"
  );
});

test("PIX receiving signals: active=10 sem superficie nao fica pronto", () => {
  assert.deepEqual(
    decidePixReceivingAccountSignals({
      routeActive10: true,
      hasReceivingAccountArea: false,
      hasPixAddAction: false,
    }),
    {
      routeActive10: true,
      hasReceivingAccountArea: false,
      hasPixAddAction: false,
      ready: false,
    },
  );
});

test("PIX receiving signals: superficie sem active=10 nao fica pronta", () => {
  assert.equal(
    decidePixReceivingAccountSignals({
      routeActive10: false,
      hasReceivingAccountArea: true,
      hasPixAddAction: true,
    }).ready,
    false,
  );
});

test("PIX receiving signals: tres sinais confirmam a aba", () => {
  assert.equal(
    decidePixReceivingAccountSignals({
      routeActive10: true,
      hasReceivingAccountArea: true,
      hasPixAddAction: true,
    }).ready,
    true,
  );
});

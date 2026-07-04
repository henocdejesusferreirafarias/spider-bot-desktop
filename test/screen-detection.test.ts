import assert from "node:assert/strict";
import test from "node:test";
import type { Frame, Page } from "patchright";
import {
  hasDepositSurface,
  isDetachedDepositRouteState
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

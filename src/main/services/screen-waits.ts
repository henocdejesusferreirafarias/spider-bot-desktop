import type { Page } from "patchright";
import { resolveContentFrame, type BrowserRuntimeWindow } from "./automation-dom.js";
import type { RouteInfo } from "./spa-navigation.js";
import {
  hasActiveSession,
  isLoginFormVisible,
  hasWithdrawalPasswordSetupSurface,
  hasWithdrawalAccountSurface,
  hasWithdrawalRequestSurface,
  classifyWithdrawalManagementDestination,
  type WithdrawalManagementDestination,
  readPixReceivingAccountSignals,
  type PixReceivingAccountSignals,
  hasVisibleNumberKeyboard,
  hasDepositSurface,
  hasProfileSurface
} from "./screen-detection.js";

// Camada de esperas condicionais (sinais): funcoes puras de polling de tela.

export async function waitForLoginSuccess(page: Page, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await hasActiveSession(page)) return true;
    if (!(await isLoginFormVisible(page))) {
      await page.waitForTimeout(600);
      if (await hasActiveSession(page)) return true;
      if (!(await isLoginFormVisible(page))) return true;
    }
    await page.waitForTimeout(400);
  }
  return hasActiveSession(page);
}

export async function waitForWithdrawalPasswordSetupToClose(page: Page, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await hasWithdrawalPasswordSetupSurface(page))) {
      return true;
    }
    await page.waitForTimeout(220).catch(() => null);
  }

  return !(await hasWithdrawalPasswordSetupSurface(page));
}

// Espera CONDICIONAL pos-router.push: retorna assim que QUALQUER coisa acionavel da
// tela de saque aparece (form de saque, prompt p/ DEFINIR senha, modal de ENTRAR senha,
// ou o CTA de adicionar senha). Substitui os waitForTimeout fixos que chutavam um tempo
// e seguiam no escuro -- fragil em PC fraco e mascarava o prompt de senha quando ele
// demorava mais que o tempo chutado.
export async function waitForWithdrawalOrPasswordSignal(page: Page, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  const frame = resolveContentFrame(page);
  while (Date.now() - startedAt < timeoutMs) {
    // Um UNICO evaluate por tick com UMA leitura de innerText compartilhada pelos sinais.
    // Antes eram ate 4 evaluates/tick (3 deles liam body.innerText -> 1 reflow cada). Isto
    // e so o GATE de espera; a classificacao definitiva (DEFINIR/ENTRAR) acontece depois em
    // handleWithdrawalPasswordPrompts, entao um sinal aproximado aqui e seguro.
    const ready = await frame
      .evaluate(() => {
        const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
        const text = (runtimeWindow.document.body?.innerText || "")
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        const accountSurface =
          /solicitar saque|conta para recebimento|registro de saques/.test(text) &&
          /pix|adicionar conta para saque|valor do saque/.test(text);
        const enterModal =
          /inserir (?:senha|pin)/.test(text) && /senha de saque/.test(text) && /proximo/.test(text);
        const setupSurface =
          /senha de saque/.test(text) &&
          /(definir|defina|cadastr|criar|crie|configurar|configure)\b(?:\s+\w+){0,2}\s+senha/.test(text);
        const passwordCta =
          /(adicionar|cadastrar|definir|configurar)\b(?:\s+\w+){0,2}\s+senha\s+de\s+saque/.test(text);
        return accountSurface || enterModal || setupSurface || passwordCta;
      })
      .catch(() => false);
    if (ready) {
      return;
    }
    await page.waitForTimeout(150).catch(() => null);
  }
}

export async function waitForWithdrawalAccountSurface(page: Page, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await hasWithdrawalAccountSurface(page)) {
      return true;
    }
    await page.waitForTimeout(220).catch(() => null);
  }

  return hasWithdrawalAccountSurface(page);
}

export async function waitForWithdrawalRequestSurface(page: Page, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await hasWithdrawalRequestSurface(page)) {
      return true;
    }
    await page.waitForTimeout(220).catch(() => null);
  }

  return hasWithdrawalRequestSurface(page);
}

// Espera por um destino confirmado apos a Gestao de saques. O timeout e apenas
// teto de seguranca; sucesso exige uma superficie real, nunca somente a rota.
export async function waitForWithdrawalManagementDestination(
  page: Page,
  timeoutMs: number
): Promise<WithdrawalManagementDestination> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const destination = await classifyWithdrawalManagementDestination(page);
    if (destination !== "unknown") {
      return destination;
    }
    await page.waitForTimeout(180).catch(() => null);
  }
  return classifyWithdrawalManagementDestination(page);
}

// Depois do submit da senha, `needs_withdrawal_password` representa a tela
// anterior enquanto a SPA carrega. Diferente da entrada pela Gestao de saques,
// somente a superficie de saque confirma que o submit foi aceito.
export async function waitForWithdrawalPasswordConfirmationDestination(
  page: Page,
  timeoutMs: number,
): Promise<WithdrawalManagementDestination> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const destination = await classifyWithdrawalManagementDestination(page);
    if (destination === "withdrawal_ready") {
      return destination;
    }
    await page.waitForTimeout(180).catch(() => null);
  }
  return classifyWithdrawalManagementDestination(page);
}

export async function waitForPixReceivingAccountSurface(
  page: Page,
  readRoute: () => Promise<RouteInfo | null>,
  timeoutMs: number,
): Promise<PixReceivingAccountSignals> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const signals = await readPixReceivingAccountSignals(page, await readRoute());
    if (signals.ready) {
      return signals;
    }
    await page.waitForTimeout(180).catch(() => null);
  }
  return readPixReceivingAccountSignals(page, await readRoute());
}

export async function waitForAddPixModal(page: Page, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = await resolveContentFrame(page)
      .evaluate(() => {
        const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
        return /adicionar pix/i.test(runtimeWindow.document.body?.innerText || "");
      })
      .catch(() => false);
    if (found) {
      return true;
    }
    await page.waitForTimeout(220).catch(() => null);
  }

  return resolveContentFrame(page)
    .evaluate(() => {
      const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
      return /adicionar pix/i.test(runtimeWindow.document.body?.innerText || "");
    })
    .catch(() => false);
}

export async function waitForPixRegistrationSaved(page: Page, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const saved = await resolveContentFrame(page)
      .evaluate(() => {
        const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
        const normalize = (value: string | null | undefined) =>
          (value || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        const text = normalize(runtimeWindow.document.body?.innerText || "");
        return (
          !/adicionar pix/.test(text) ||
          /sucesso|cadastrad|adicionad|salvo|success/.test(text)
        );
      })
      .catch(() => false);
    if (saved) {
      return true;
    }
    await page.waitForTimeout(350).catch(() => null);
  }

  return false;
}

export async function waitForVisibleNumberKeyboard(page: Page, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await hasVisibleNumberKeyboard(page)) {
      return true;
    }
    await page.waitForTimeout(80).catch(() => null);
  }

  return hasVisibleNumberKeyboard(page);
}

export async function waitForDepositSurface(page: Page, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await hasDepositSurface(page)) {
      return true;
    }
    await page.waitForTimeout(180);
  }

  return hasDepositSurface(page);
}

export async function waitForProfileSurface(page: Page, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await hasProfileSurface(page)) {
      return true;
    }
    await page.waitForTimeout(180);
  }
  return hasProfileSurface(page);
}

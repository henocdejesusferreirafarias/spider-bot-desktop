import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "patchright";
import type { SpaHandle } from "../src/main/services/spa-navigation.js";
import {
  confirmExistingWithdrawalPassword,
  formatPixAddFormDiagnostics,
  inspectPixAddForm,
  waitForPixAddForm,
} from "../src/main/services/pix-password-confirmation.js";

type FakeButton = { text: string; disabled?: boolean };

type FakeElement = {
  textContent?: string;
  disabled?: boolean;
  classList: { contains: (name: string) => boolean };
  getAttribute: (name: string) => string | null;
  hasAttribute: (name: string) => boolean;
  getBoundingClientRect: () => { width: number; height: number };
  querySelectorAll: (selector: string) => FakeElement[];
  querySelector: (selector: string) => FakeElement | null;
};

function element(
  classes: string[],
  children: Record<string, FakeElement[]> = {},
  options: { text?: string; disabled?: boolean; hidden?: boolean } = {},
): FakeElement {
  return {
    textContent: options.text ?? "",
    disabled: options.disabled,
    classList: { contains: (name) => classes.includes(name) },
    getAttribute: (name) => name === "disabled" && options.disabled ? "" : null,
    hasAttribute: (name) => name === "disabled" && Boolean(options.disabled),
    getBoundingClientRect: () => ({ width: options.hidden ? 0 : 300, height: options.hidden ? 0 : 40 }),
    querySelectorAll: (selector) => children[selector] ?? [],
    querySelector: (selector) => children[selector]?.[0] ?? null,
  };
}

function withPinConfirmationSurface<T>(
  options: { filledCells: number; buttons: FakeButton[]; hiddenLeadingModal?: boolean; serializedEvaluate?: boolean },
  callback: (surface: SpaHandle, clicks: () => number) => Promise<T>,
): Promise<T> {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalGetComputedStyle = globalThis.getComputedStyle;
  let clicks = 0;
  const cells = Array.from({ length: 6 }, (_, index) => element(
    ["ui-password-input__item"],
    {},
    { text: index < options.filledCells ? "•" : "" },
  ));
  const grid = element(["ui-password-input"], { ".ui-password-input__item": cells });
  const buttons = options.buttons.map((button) => element(
    ["ui-button"],
    {},
    { text: button.text, disabled: button.disabled },
  ));
  const modal = element(
    ["ui-popup", "ui-dialog"],
    {
      ".ui-password-input": [grid],
      ".ui-button": buttons,
    },
  );
  const hiddenLeadingModal = element(["ui-popup", "ui-dialog"], {}, { hidden: true });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelectorAll: (selector: string) => selector === ".ui-popup.ui-dialog"
        ? options.hiddenLeadingModal ? [hiddenLeadingModal, modal] : [modal]
        : [],
    },
  });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({ display: "block", visibility: "visible" }),
  });

  let selectedModalIndex = -1;
  const expectedModalIndex = options.hiddenLeadingModal ? 1 : 0;
  const surface = {
    evaluate: async (fn: () => unknown) => {
      if (options.serializedEvaluate && String(fn).includes("CONFIRM_LABELS")) {
        throw new Error("page callback captured main-process state");
      }
      return fn();
    },
    locator: () => ({
      nth: (modalIndex: number) => {
        selectedModalIndex = modalIndex;
        return {
        locator: () => ({
          nth: () => ({
            click: async () => {
              if (selectedModalIndex !== expectedModalIndex) throw new Error("locator targeted hidden modal");
              clicks += 1;
            },
          }),
        }),
      };
      },
    }),
  } as unknown as SpaHandle;

  return callback(surface, () => clicks).finally(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete (globalThis as { document?: unknown }).document;
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: originalGetComputedStyle });
  });
}

test("confirma uma vez o PIN completo no modal resolvido", async () => {
  await withPinConfirmationSurface({
    filledCells: 6,
    buttons: [{ text: "Próximo" }],
  }, async (surface, clicks) => {
    const result = await confirmExistingWithdrawalPassword(surface);

    assert.deepEqual(result, { ok: true });
    assert.equal(clicks(), 1);
  });
});

test("preserva o indice global quando um modal PIN oculto antecede o modal ativo", async () => {
  await withPinConfirmationSurface({
    filledCells: 6,
    buttons: [{ text: "Próximo" }],
    hiddenLeadingModal: true,
  }, async (surface, clicks) => {
    const result = await confirmExistingWithdrawalPassword(surface);

    assert.deepEqual(result, { ok: true });
    assert.equal(clicks(), 1);
  });
});

test("nao captura rotulos de confirmacao fora do mundo da pagina", async () => {
  await withPinConfirmationSurface({
    filledCells: 6,
    buttons: [{ text: "Próximo" }],
    serializedEvaluate: true,
  }, async (surface, clicks) => {
    const result = await confirmExistingWithdrawalPassword(surface);

    assert.deepEqual(result, { ok: true });
    assert.equal(clicks(), 1);
  });
});

test("recusa PIN incompleto sem clicar", async () => {
  await withPinConfirmationSurface({
    filledCells: 5,
    buttons: [{ text: "Próximo" }],
  }, async (surface, clicks) => {
    const result = await confirmExistingWithdrawalPassword(surface);

    assert.equal(result.reason, "source-invalid");
    assert.equal(clicks(), 0);
  });
});

test("recusa confirmacao ambigua sem clicar", async () => {
  await withPinConfirmationSurface({
    filledCells: 6,
    buttons: [{ text: "Próximo" }, { text: "Confirmar" }],
  }, async (surface, clicks) => {
    const result = await confirmExistingWithdrawalPassword(surface);

    assert.equal(result.reason, "confirm-action-ambiguous");
    assert.equal(clicks(), 0);
  });
});

test("recusa botao desabilitado sem clicar", async () => {
  await withPinConfirmationSurface({
    filledCells: 6,
    buttons: [{ text: "Próximo", disabled: true }],
  }, async (surface, clicks) => {
    const result = await confirmExistingWithdrawalPassword(surface);

    assert.equal(result.reason, "confirm-action-absent");
    assert.equal(clicks(), 0);
  });
});

function withPixAddFormSurface<T>(
  options: {
    visibleInputs: number;
    visibleSelectors: number;
    enabledPrimaryActions: number;
    visiblePinGrids: number;
    visibleKeyboards: number;
    visibleDialogs: number;
    text: string;
  },
  callback: (surface: SpaHandle) => Promise<T>,
): Promise<T> {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalGetComputedStyle = globalThis.getComputedStyle;
  const inputs = Array.from({ length: options.visibleInputs }, () => element(["ui-input__input"]));
  const selectors = Array.from({ length: options.visibleSelectors }, () => element(["ui-select__reference"]));
  const actions = Array.from({ length: options.enabledPrimaryActions }, () => element(["ui-button"], {}, { text: "Confirmar" }));
  const grids = Array.from({ length: options.visiblePinGrids }, () => element(["ui-password-input"]));
  const keyboards = Array.from({ length: options.visibleKeyboards }, () => element(["ui-number-keyboard"]));
  const dialogs = Array.from({ length: options.visibleDialogs }, () => element(
    ["ui-popup", "ui-dialog"],
    {
      "input": inputs,
      ".ui-select__reference": selectors,
      ".ui-button": actions,
    },
    { text: options.text },
  ));
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelectorAll: (selector: string) => {
        if (selector === ".ui-popup.ui-dialog") return dialogs;
        if (selector === ".ui-password-input") return grids;
        if (selector === ".ui-number-keyboard") return keyboards;
        return [];
      },
    },
  });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({ display: "block", visibility: "visible" }),
  });
  const surface = {
    evaluate: async (fn: (active10: boolean) => unknown, active10: boolean) => fn(active10),
  } as unknown as SpaHandle;

  return callback(surface).finally(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete (globalThis as { document?: unknown }).document;
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: originalGetComputedStyle });
  });
}

test("reconhece o formulario PIX apenas com todos os sinais estruturais", async () => {
  await withPixAddFormSurface({
    visibleInputs: 2,
    visibleSelectors: 1,
    enabledPrimaryActions: 1,
    visiblePinGrids: 0,
    visibleKeyboards: 0,
    visibleDialogs: 1,
    text: "Adicionar PIX",
  }, async (surface) => {
    const result = await inspectPixAddForm(surface, true);

    assert.equal(result.ready, true);
  });
});

test("rejeita texto PIX sozinho", async () => {
  await withPixAddFormSurface({
    visibleInputs: 0,
    visibleSelectors: 0,
    enabledPrimaryActions: 0,
    visiblePinGrids: 0,
    visibleKeyboards: 0,
    visibleDialogs: 1,
    text: "Adicionar PIX",
  }, async (surface) => {
    assert.equal((await inspectPixAddForm(surface, true)).ready, false);
  });
});

test("rejeita PIN ou teclado visivel e rota fora do destino", async () => {
  const base = {
    visibleInputs: 2,
    visibleSelectors: 1,
    enabledPrimaryActions: 1,
    visibleDialogs: 1,
    text: "Adicionar PIX",
  };
  for (const options of [
    { ...base, visiblePinGrids: 1, visibleKeyboards: 0, routeActive10: true },
    { ...base, visiblePinGrids: 0, visibleKeyboards: 1, routeActive10: true },
    { ...base, visiblePinGrids: 0, visibleKeyboards: 0, routeActive10: false },
  ]) {
    await withPixAddFormSurface(options, async (surface) => {
      assert.equal((await inspectPixAddForm(surface, options.routeActive10)).ready, false);
    });
  }
});

function withDelayedPixAddFormSurface<T>(
  options: { readyOnInspection: number },
  callback: (surface: SpaHandle, waits: () => number) => Promise<T>,
): Promise<T> {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalGetComputedStyle = globalThis.getComputedStyle;
  const originalRouter = Object.getOwnPropertyDescriptor(globalThis, "$router");
  let inspections = 0;
  let waits = 0;
  const input = () => element(["ui-input__input"]);
  const selector = () => element(["ui-select__reference"]);
  const action = () => element(["ui-button"], {}, { text: "Confirmar" });
  const dialog = () => element(
    ["ui-popup", "ui-dialog"],
    { input: [input(), input()], ".ui-select__reference": [selector()], ".ui-button": [action()] },
    { text: "Adicionar PIX" },
  );
  const pin = () => element(["ui-password-input"]);
  const keyboard = () => element(["ui-number-keyboard"]);
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelectorAll: (query: string) => {
        const ready = inspections >= options.readyOnInspection;
        if (query === ".ui-popup.ui-dialog") return ready ? [dialog()] : [];
        if (query === ".ui-password-input") return ready ? [] : [pin()];
        if (query === ".ui-number-keyboard") return ready ? [] : [keyboard()];
        if (query === "body, body *") return [];
        return [];
      },
    },
  });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({ display: "block", visibility: "visible" }),
  });
  Object.defineProperty(globalThis, "$router", {
    configurable: true,
    value: { push: () => undefined, currentRoute: { value: { name: "withdraw", path: "/home/withdraw", query: { active: "10" } } } },
  });
  const surface = {
    evaluate: async (fn: (payload?: unknown) => unknown, payload?: unknown) => {
      if (String(fn).includes("visiblePinGrids")) inspections += 1;
      return fn(payload);
    },
    waitForTimeout: async () => { waits += 1; },
  } as unknown as SpaHandle;

  return callback(surface, () => waits).finally(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete (globalThis as { document?: unknown }).document;
    if (originalRouter) Object.defineProperty(globalThis, "$router", originalRouter);
    else delete (globalThis as { $router?: unknown }).$router;
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: originalGetComputedStyle });
  });
}

test("aguarda o formulario PIX condicionalmente sem novo clique", async () => {
  await withDelayedPixAddFormSurface({ readyOnInspection: 3 }, async (surface, waits) => {
    const result = await waitForPixAddForm(surface, 1_000);

    assert.equal(result.ready, true);
    assert.equal(waits(), 2);
  });
});

test("nao confirma destino incompleto ao esgotar o teto", async () => {
  await withDelayedPixAddFormSurface({ readyOnInspection: Number.MAX_SAFE_INTEGER }, async (surface, waits) => {
    const result = await waitForPixAddForm(surface, 0);

    assert.equal(result.ready, false);
    assert.equal(result.visiblePinGrids, 1);
    assert.equal(waits(), 0);
  });
});

test("formata diagnostico do formulario PIX somente com sinais estruturais", () => {
  const diagnostic = formatPixAddFormDiagnostics({
    routeActive10: true,
    visiblePinGrids: 0,
    visibleKeyboards: 0,
    visibleDialogs: 1,
    visibleInputs: 2,
    visibleSelectors: 1,
    enabledPrimaryActions: 1,
    hasPixSemantic: true,
    ready: false,
  });

  assert.equal(
    diagnostic,
    "active10=true pinGrids=0 keyboards=0 dialogs=1 inputs=2 selectors=1 actions=1 pixSemantic=true",
  );
});

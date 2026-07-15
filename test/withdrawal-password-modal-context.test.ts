import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "patchright";
import type { SpaHandle } from "../src/main/services/spa-navigation.js";
import {
  selectUniqueWithdrawalPasswordModalSurface,
  waitForUniqueWithdrawalPasswordModalSurface,
} from "../src/main/services/withdrawal-password-modal-context.js";

const eligibleInspection = {
  visibleGrids: 1,
  gridCells: 6,
  filledCells: 0,
  focusedCells: 1,
  visibleKeyboards: 1,
  keyboardKeys: 12,
};

test("seleciona o modal elegivel da pagina principal", () => {
  const top = {} as SpaHandle;
  const staleFrame = {} as SpaHandle;

  const result = selectUniqueWithdrawalPasswordModalSurface([
    { surface: top, inspection: eligibleInspection },
    { surface: staleFrame, inspection: { ...eligibleInspection, focusedCells: 0 } },
  ]);

  assert.deepEqual(result, { ok: true, surface: top });
});

test("seleciona o modal elegivel em frame vivo", () => {
  const top = {} as SpaHandle;
  const modalFrame = {} as SpaHandle;

  const result = selectUniqueWithdrawalPasswordModalSurface([
    { surface: top, inspection: { ...eligibleInspection, visibleGrids: 0 } },
    { surface: modalFrame, inspection: eligibleInspection },
  ]);

  assert.deepEqual(result, { ok: true, surface: modalFrame });
});

test("recusa dois modais igualmente acionaveis", () => {
  const result = selectUniqueWithdrawalPasswordModalSurface([
    { surface: {} as SpaHandle, inspection: eligibleInspection },
    { surface: {} as SpaHandle, inspection: eligibleInspection },
  ]);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "surface-ambiguous");
});

test("recusa grid parcial como alvo do PIN", () => {
  const result = selectUniqueWithdrawalPasswordModalSurface([
    { surface: {} as SpaHandle, inspection: { ...eligibleInspection, filledCells: 1 } },
  ]);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "surface-absent");
});

test("seleciona o contexto que aparece apos a navegacao", async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalGetComputedStyle = globalThis.getComputedStyle;
  let scans = 0;
  let waits = 0;
  const cells = Array.from({ length: 6 }, (_, index) => ({
    textContent: "",
    classList: { contains: (name: string) => name === "ui-password-input__item--focus" && index === 0 },
    querySelector: () => null,
  }));
  const field = {
    getBoundingClientRect: () => ({ height: 40, width: 300 }),
    querySelectorAll: () => cells,
  };
  const keyboard = {
    getBoundingClientRect: () => ({ height: 220, width: 300 }),
    querySelectorAll: () => Array.from({ length: 12 }, () => ({})),
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelectorAll: (selector: string) => {
        if (scans < 2) return [];
        if (selector === ".ui-password-input") return [field];
        if (selector === ".ui-number-keyboard") return [keyboard];
        return [];
      },
    },
  });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({ display: "block", visibility: "visible" }),
  });
  const main = {};
  const page = {
    frames: () => [main],
    mainFrame: () => main,
    evaluate: async (fn: () => unknown) => {
      scans += 1;
      return fn();
    },
    waitForTimeout: async () => { waits += 1; },
  } as unknown as Page;

  try {
    const result = await waitForUniqueWithdrawalPasswordModalSurface(page, 500);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.surface, page);
    assert.equal(waits, 1);
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete (globalThis as { document?: unknown }).document;
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: originalGetComputedStyle });
  }
});

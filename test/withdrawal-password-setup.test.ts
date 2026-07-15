import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "patchright";
import { fillWithdrawalPasswordSetup } from "../src/main/services/withdrawal-password-setup.js";

type FakeCell = {
  textContent: string;
  classList: { contains: (name: string) => boolean };
  getBoundingClientRect: () => { height: number; width: number };
  querySelector: () => null;
};

function withPasswordSurface<T>(partiallyFilled: boolean, callback: (page: Page, touchCount: () => number) => Promise<T>): Promise<T> {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalGetComputedStyle = globalThis.getComputedStyle;
  const originalTouch = (globalThis as { Touch?: unknown }).Touch;
  const originalTouchEvent = (globalThis as { TouchEvent?: unknown }).TouchEvent;
  const fields = [0, 1].map(() => {
    const cells: FakeCell[] = Array.from({ length: 6 }, (_, index) => ({
      textContent: partiallyFilled && index === 0 ? "9" : "",
      classList: { contains: (name) => name === "ui-password-input__item--focus" && index === 0 },
      getBoundingClientRect: () => ({ height: 40, width: 40 }),
      querySelector: () => null
    }));
    return {
      cells,
      getBoundingClientRect: () => ({ height: 40, width: 300 }),
      querySelectorAll: () => cells
    };
  });
  let activeField = 0;
  let activeCell = partiallyFilled ? 1 : 0;
  let touches = 0;
  for (const [fieldIndex, field] of fields.entries()) {
    for (const [cellIndex, cell] of field.cells.entries()) {
      cell.classList = {
        contains: (name) => name === "ui-password-input__item--focus" && fieldIndex === activeField && cellIndex === activeCell
      };
    }
  }
  const setFocus = (fieldIndex: number, cellIndex: number) => {
    activeField = fieldIndex;
    activeCell = cellIndex;
  };
  const keyboard = {
    getBoundingClientRect: () => ({ height: 220, width: 300 }),
    querySelectorAll: () => Array.from({ length: 10 }, (_, digit) => ({
      textContent: String(digit),
      getBoundingClientRect: () => ({ left: 0, top: 0, height: 40, width: 40 }),
      dispatchEvent: () => {
        touches += 1;
        const cell = fields[activeField]!.cells[activeCell]!;
        cell.textContent = String(digit);
        if (activeCell < 5) setFocus(activeField, activeCell + 1);
        else if (activeField === 0) setFocus(1, 0);
        return true;
      }
    }))
  };
  const documentValue = {
    querySelectorAll: (selector: string) => selector === ".ui-password-input" ? fields : [],
    querySelector: (selector: string) => selector === ".ui-number-keyboard" ? keyboard : null
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentValue });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({ display: "block", visibility: "visible" })
  });
  Object.defineProperty(globalThis, "Touch", { configurable: true, value: class { constructor(_: unknown) {} } });
  Object.defineProperty(globalThis, "TouchEvent", { configurable: true, value: class { constructor(_: string, __: unknown) {} } });
  const page = {
    evaluate: async (fn: (payload: { expectedFieldIndex: number; password: string }) => unknown, payload: { expectedFieldIndex: number; password: string }) => fn(payload)
  } as unknown as Page;
  return callback(page, () => touches).finally(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete (globalThis as { document?: unknown }).document;
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: originalGetComputedStyle });
    if (originalTouch === undefined) delete (globalThis as { Touch?: unknown }).Touch;
    else Object.defineProperty(globalThis, "Touch", { configurable: true, value: originalTouch });
    if (originalTouchEvent === undefined) delete (globalThis as { TouchEvent?: unknown }).TouchEvent;
    else Object.defineProperty(globalThis, "TouchEvent", { configurable: true, value: originalTouchEvent });
  });
}

test("preenche os dois campos pelo teclado virtual e confirma cada checkpoint", async () => {
  await withPasswordSurface(false, async (page, touchCount) => {
    const stages: string[] = [];
    const result = await fillWithdrawalPasswordSetup(page, "102345", async (stage) => { stages.push(stage); });

    assert.deepEqual(result, { ok: true, firstFieldFilled: true, secondFieldFilled: true });
    assert.deepEqual(stages, ["first-field-filled", "second-field-filled"]);
    assert.equal(touchCount(), 12);
  });
});

test("recusa continuar quando a tela ja contem uma senha parcial", async () => {
  await withPasswordSurface(true, async (page, touchCount) => {
    const stages: string[] = [];
    const result = await fillWithdrawalPasswordSetup(page, "102345", async (stage) => { stages.push(stage); });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "field-partially-filled");
    assert.deepEqual(stages, []);
    assert.equal(touchCount(), 0);
  });
});

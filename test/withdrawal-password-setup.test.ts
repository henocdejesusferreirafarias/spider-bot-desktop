import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "patchright";
import * as withdrawalPasswordSetup from "../src/main/services/withdrawal-password-setup.js";
import { fillWithdrawalPasswordSetup } from "../src/main/services/withdrawal-password-setup.js";

type FakeCell = {
  textContent: string;
  classList: { contains: (name: string) => boolean };
  getBoundingClientRect: () => { height: number; width: number };
  querySelector: () => null;
};

function withPasswordSurface<T>(options: { hiddenKeyboardFirst?: boolean; initiallyFocused?: boolean; partiallyFilled?: boolean; listenerBoundKeyboard?: "hidden" | "visible" }, callback: (page: Page, touchCount: () => number, focusTapCount: () => number, evaluateWorlds: () => boolean[]) => Promise<T>): Promise<T> {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalGetComputedStyle = globalThis.getComputedStyle;
  const originalTouch = (globalThis as { Touch?: unknown }).Touch;
  const originalTouchEvent = (globalThis as { TouchEvent?: unknown }).TouchEvent;
  const partiallyFilled = options.partiallyFilled ?? false;
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
      querySelectorAll: () => cells,
      querySelector: (selector: string) => selector === ".ui-password-input__item--focus"
        ? cells.find((cell) => cell.classList.contains("ui-password-input__item--focus")) ?? null
        : null
    };
  });
  let activeField = options.initiallyFocused === false ? -1 : 0;
  let activeCell = partiallyFilled ? 1 : 0;
  let touches = 0;
  let focusTaps = 0;
  let keyboardVisible = activeField === 0;
  let activeTouch = false;
  let pendingDigit: string | undefined;
  const evaluateWorlds: boolean[] = [];
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
    keyboardVisible = true;
  };
  const keyboardKeys = (acceptsTouch: boolean) => Array.from({ length: 10 }, (_, digit) => ({
      textContent: String(digit),
      getBoundingClientRect: () => ({ left: 0, top: 0, height: 40, width: 40 }),
      dispatchEvent: (event: { type: string }) => {
        if (event.type === "touchend") {
          activeTouch = false;
          if (acceptsTouch) queueMicrotask(flushPendingDigit);
          return true;
        }
        if (event.type !== "touchstart" || activeTouch) return true;
        if (!acceptsTouch) return true;
        activeTouch = true;
        touches += 1;
        pendingDigit = String(digit);
        return true;
      }
    }));
  const keyboard = {
    getBoundingClientRect: () => ({ height: keyboardVisible ? 220 : 0, width: keyboardVisible ? 300 : 0 }),
    querySelectorAll: () => keyboardKeys(options.listenerBoundKeyboard !== "hidden")
  };
  const hiddenKeyboard = {
    getBoundingClientRect: () => ({ height: 0, width: 0 }),
    querySelectorAll: () => keyboardKeys(options.listenerBoundKeyboard === "hidden")
  };
  const documentValue = {
    querySelectorAll: (selector: string) => {
      if (selector === ".ui-password-input") return fields;
      if (selector === ".ui-number-keyboard") {
        if (options.hiddenKeyboardFirst) return [hiddenKeyboard, keyboard];
        return options.listenerBoundKeyboard === "hidden" ? [keyboard, hiddenKeyboard] : [keyboard];
      }
      return [];
    },
    querySelector: (selector: string) => selector === ".ui-number-keyboard"
      ? options.hiddenKeyboardFirst ? hiddenKeyboard : keyboard
      : null
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentValue });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({ display: "block", visibility: "visible" })
  });
  Object.defineProperty(globalThis, "Touch", { configurable: true, value: class { constructor(_: unknown) {} } });
  Object.defineProperty(globalThis, "TouchEvent", {
    configurable: true,
    value: class {
      type: string;
      constructor(type: string, _: unknown) {
        this.type = type;
      }
    }
  });
  const flushPendingDigit = () => {
    if (!pendingDigit) return;
    const cell = fields[activeField]!.cells[activeCell]!;
    cell.textContent = pendingDigit;
    pendingDigit = undefined;
    if (activeCell < 5) setFocus(activeField, activeCell + 1);
    else if (activeField === 0) setFocus(1, 0);
  };
  const page = {
    evaluate: async (fn: (payload: { expectedFieldIndex: number; password: string }) => unknown, payload: { expectedFieldIndex: number; password: string }, mainWorld?: boolean) => {
      evaluateWorlds.push(Boolean(mainWorld));
      const result = fn(payload);
      flushPendingDigit();
      return result;
    },
    locator: () => ({
      first: () => ({
        locator: () => ({
          first: () => ({
            tap: async () => {
              if (options.hiddenKeyboardFirst) throw new Error("tap should not be needed when the visible keyboard is already active");
              focusTaps += 1;
              setFocus(0, 0);
            }
          })
        })
      })
    })
  } as unknown as Page;
  return callback(page, () => touches, () => focusTaps, () => evaluateWorlds).finally(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete (globalThis as { document?: unknown }).document;
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: originalGetComputedStyle });
    if (originalTouch === undefined) delete (globalThis as { Touch?: unknown }).Touch;
    else Object.defineProperty(globalThis, "Touch", { configurable: true, value: originalTouch });
    if (originalTouchEvent === undefined) delete (globalThis as { TouchEvent?: unknown }).TouchEvent;
    else Object.defineProperty(globalThis, "TouchEvent", { configurable: true, value: originalTouchEvent });
  });
}

function withConfirmationSurface<T>(
  options: { pinCount: [number, number]; confirmControls: number },
  callback: (page: Page, confirmCount: () => number) => Promise<T>,
): Promise<T> {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalGetComputedStyle = globalThis.getComputedStyle;
  const originalMouseEvent = (globalThis as { MouseEvent?: unknown }).MouseEvent;
  let confirmations = 0;
  const fields = options.pinCount.map((count) => ({
    getBoundingClientRect: () => ({ height: 40, width: 300 }),
    querySelectorAll: () => Array.from({ length: 6 }, (_, index) => ({
      textContent: index < count ? "•" : "",
      getBoundingClientRect: () => ({ height: 40, width: 40 }),
      querySelector: () => null,
    })),
  }));
  const controls = Array.from({ length: options.confirmControls }, () => ({
    textContent: "Confirmar",
    getAttribute: () => null,
    getBoundingClientRect: () => ({ height: 44, width: 300 }),
    contains: () => false,
    dispatchEvent: () => {
      confirmations += 1;
      return true;
    },
  }));
  const documentValue = {
    querySelectorAll: (selector: string) => {
      if (selector === ".ui-password-input") return fields;
      if (selector === "button,[role='button'],.ui-button,input[type='submit'],div,span") return controls;
      return [];
    },
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentValue });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({ display: "block", visibility: "visible" }),
  });
  Object.defineProperty(globalThis, "MouseEvent", {
    configurable: true,
    value: class { constructor(_: string, __: unknown) {} },
  });
  const page = {
    evaluate: async (fn: () => unknown) => fn(),
  } as unknown as Page;
  return callback(page, () => confirmations).finally(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete (globalThis as { document?: unknown }).document;
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: originalGetComputedStyle });
    if (originalMouseEvent === undefined) delete (globalThis as { MouseEvent?: unknown }).MouseEvent;
    else Object.defineProperty(globalThis, "MouseEvent", { configurable: true, value: originalMouseEvent });
  });
}

type ConfirmationSetupModule = {
  confirmWithdrawalPasswordSetup?: (page: Page) => Promise<{ ok: boolean; reason?: string }>;
};

const confirmWithdrawalPasswordSetup = (withdrawalPasswordSetup as ConfirmationSetupModule).confirmWithdrawalPasswordSetup;

test("confirma uma unica acao semantica apos os dois PINs", async () => {
  assert.equal(typeof confirmWithdrawalPasswordSetup, "function");
  await withConfirmationSurface({ pinCount: [6, 6], confirmControls: 1 }, async (page, confirmCount) => {
    const result = await confirmWithdrawalPasswordSetup!(page);

    assert.deepEqual(result, { ok: true });
    assert.equal(confirmCount(), 1);
  });
});

test("nao confirma quando os dois PINs nao estao completos", async () => {
  assert.equal(typeof confirmWithdrawalPasswordSetup, "function");
  await withConfirmationSurface({ pinCount: [6, 5], confirmControls: 1 }, async (page, confirmCount) => {
    const result = await confirmWithdrawalPasswordSetup!(page);

    assert.equal(result.reason, "surface-invalid");
    assert.equal(confirmCount(), 0);
  });
});

test("recusa controles de confirmacao ambiguos sem clicar", async () => {
  assert.equal(typeof confirmWithdrawalPasswordSetup, "function");
  await withConfirmationSurface({ pinCount: [6, 6], confirmControls: 2 }, async (page, confirmCount) => {
    const result = await confirmWithdrawalPasswordSetup!(page);

    assert.equal(result.reason, "confirm-action-ambiguous");
    assert.equal(confirmCount(), 0);
  });
});

test("preenche os dois campos pelo teclado virtual e confirma cada checkpoint", async () => {
  await withPasswordSurface({}, async (page, touchCount) => {
    const stages: string[] = [];
    const result = await fillWithdrawalPasswordSetup(page, "102345", async (stage) => { stages.push(stage); });

    assert.deepEqual(result, { ok: true, firstFieldFilled: true, secondFieldFilled: true });
    assert.deepEqual(stages, ["first-field-filled", "second-field-filled"]);
    assert.equal(touchCount(), 12);
  });
});

test("recusa continuar quando a tela ja contem uma senha parcial", async () => {
  await withPasswordSurface({ partiallyFilled: true }, async (page, touchCount) => {
    const stages: string[] = [];
    const result = await fillWithdrawalPasswordSetup(page, "102345", async (stage) => { stages.push(stage); });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "field-partially-filled");
    assert.deepEqual(stages, []);
    assert.equal(touchCount(), 0);
  });
});

test("toca o primeiro campo quando o cadastro abre sem foco nem teclado", async () => {
  await withPasswordSurface({ initiallyFocused: false }, async (page, touchCount, focusTapCount) => {
    const result = await fillWithdrawalPasswordSetup(page, "102345", async () => undefined);

    assert.equal(result.ok, true);
    assert.equal(focusTapCount(), 1);
    assert.equal(touchCount(), 12);
  });
});

test("usa o teclado visivel quando uma instancia oculta aparece primeiro no DOM", async () => {
  await withPasswordSurface({ hiddenKeyboardFirst: true }, async (page, touchCount, focusTapCount) => {
    const result = await fillWithdrawalPasswordSetup(page, "102345", async () => undefined);

    assert.equal(result.ok, true);
    assert.equal(focusTapCount(), 0);
    assert.equal(touchCount(), 12);
  });
});

test("confirma por efeito quando o listener ativo esta no teclado oculto", async () => {
  await withPasswordSurface({ listenerBoundKeyboard: "hidden" }, async (page, touchCount) => {
    const result = await fillWithdrawalPasswordSetup(page, "102345", async () => undefined);

    assert.equal(result.ok, true);
    assert.equal(touchCount(), 12);
  });
});

test("executa a interacao da senha no contexto principal da pagina", async () => {
  await withPasswordSurface({}, async (page, _touchCount, _focusTapCount, evaluateWorlds) => {
    const result = await fillWithdrawalPasswordSetup(page, "102345", async () => undefined);

    assert.equal(result.ok, true);
    assert.equal(evaluateWorlds().length > 0, true);
    assert.equal(evaluateWorlds().every((isolatedContext) => !isolatedContext), true, JSON.stringify(evaluateWorlds()));
  });
});

test("preenche cada PIN em uma unica transacao da pagina", async () => {
  await withPasswordSurface({}, async (page, _touchCount, _focusTapCount, evaluateWorlds) => {
    const result = await fillWithdrawalPasswordSetup(page, "102345", async () => undefined);

    assert.equal(result.ok, true);
    assert.equal(evaluateWorlds().length, 3);
  });
});

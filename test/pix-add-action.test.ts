import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "patchright";
import { programmaticPixAddAction } from "../src/main/services/pix-add-action.js";

type RuntimeElement = {
  _vei?: { onClick?: unknown };
  getBoundingClientRect: () => { width: number; height: number };
  parentElement?: RuntimeElement | null;
  textContent: string;
};

function fakePage(elements: RuntimeElement[]): Page {
  return {
    evaluate: async (callback: () => unknown) => {
      const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: { querySelectorAll: () => elements },
      });
      try {
        return callback();
      } finally {
        if (originalDocument) {
          Object.defineProperty(globalThis, "document", originalDocument);
        } else {
          delete (globalThis as { document?: unknown }).document;
        }
      }
    },
  } as unknown as Page;
}

test("PIX add invokes the unique live listener once", async () => {
  let calls = 0;
  const listener = Object.assign(() => undefined, {
    value: () => {
      calls += 1;
    },
  });
  const element: RuntimeElement = {
    _vei: { onClick: listener },
    getBoundingClientRect: () => ({ width: 320, height: 44 }),
    textContent: "PIX Adicionar",
  };

  const result = await programmaticPixAddAction(fakePage([element]));

  assert.equal(result.ok, true);
  assert.equal(calls, 1);
});

test("PIX add refuses ambiguous live listeners without clicking", async () => {
  let calls = 0;
  const makeElement = (): RuntimeElement => ({
    _vei: {
      onClick: Object.assign(() => undefined, {
        value: () => {
          calls += 1;
        },
      }),
    },
    getBoundingClientRect: () => ({ width: 320, height: 44 }),
    textContent: "PIX Adicionar",
  });

  const result = await programmaticPixAddAction(fakePage([makeElement(), makeElement()]));

  assert.equal(result.ok, false);
  assert.equal(result.reason, "pix-add-action-ambiguous");
  assert.equal(calls, 0);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Page } from "patchright";
import { BrowserRuntimeService } from "../src/main/services/browser-runtime.js";
import type { DpiAwarePlacement } from "../src/main/services/window-geometry.js";

const placement: DpiAwarePlacement = {
  slotIndex: 0,
  x: 8,
  y: 8,
  width: 246,
  height: 324,
  mode: "grid",
  monitorPhysicalBounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workAreaPhysical: { x: 0, y: 0, width: 1920, height: 1008 },
  targetPhysicalRect: { x: 12, y: 12, width: 369, height: 486 },
  footprintPhysicalRect: { x: 12, y: 12, width: 369, height: 486 },
  idealScale: 0.738,
  overlaps: false,
  cutOff: false
};

function fakePage(returnedBounds: Record<string, number>) {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const session = {
    send: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "Browser.getWindowForTarget") {
        return { windowId: 7 };
      }
      if (method === "Browser.getWindowBounds") {
        return { bounds: returnedBounds };
      }
      return {};
    },
    detach: async () => undefined
  };
  const page = {
    isClosed: () => false,
    context: () => ({ newCDPSession: async () => session })
  } as unknown as Page;
  return { page, calls };
}

test("runtime separa escala ideal da escala lançada e não pede relaunch", async () => {
  const source = await readFile(
    new URL("../src/main/services/browser-runtime.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /launchedScale: number;/);
  assert.match(source, /placement\.idealScale/);
  assert.match(source, /handle\.launchedScale/);
  const forbiddenRelaunchNotice = [
    "Reabra este navegador para ajustar",
    "a escala da interface"
  ].join(" ");
  assert.equal(source.includes(forbiddenRelaunchNotice), false);
  assert.doesNotMatch(
    source,
    /handle\.placement = \{ \.\.\.placement, scale: previousScale \}/
  );
});

test("preview e launch resolvem métricas atuais do monitor em cada ação", async () => {
  const source = await readFile(
    new URL("../src/main/services/browser-runtime.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /getLayoutPreviewRects\(settings: AppSettings\)[\s\S]*?this\.resolveLayoutDisplay\(settings\.screenLayout\)/
  );
  assert.match(
    source,
    /private buildBrowserPlacement\([\s\S]*?settings: AppSettings[\s\S]*?this\.resolveLayoutDisplay\(settings\.screenLayout\)/
  );
});

test("apply confirma bounds reais compatíveis usando a escala lançada", async () => {
  const runtime = new BrowserRuntimeService(() => undefined);
  const harness = runtime as unknown as {
    applyPlacementToPage(
      page: Page,
      placement: DpiAwarePlacement,
      effectiveScale: number
    ): Promise<boolean>;
  };
  const { page, calls } = fakePage({
    left: 16,
    top: 16,
    width: 492,
    height: 648
  });
  assert.equal(await harness.applyPlacementToPage(page, placement, 0.75), true);
  assert.ok(calls.some((call) => call.method === "Browser.getWindowBounds"));
  assert.deepEqual(
    calls.findLast((call) => call.method === "Browser.setWindowBounds")?.params,
    {
      windowId: 7,
      bounds: { left: 16, top: 16, width: 492, height: 648 }
    }
  );
});

test("apply rejeita falso sucesso quando Chromium devolve bounds divergentes", async () => {
  const runtime = new BrowserRuntimeService(() => undefined);
  const harness = runtime as unknown as {
    applyPlacementToPage(
      page: Page,
      placement: DpiAwarePlacement,
      effectiveScale: number
    ): Promise<boolean>;
  };
  const { page } = fakePage({ left: 16, top: 16, width: 400, height: 648 });
  assert.equal(await harness.applyPlacementToPage(page, placement, 0.75), false);
});

test("apply rejeita falso sucesso quando Chromium não devolve bounds", async () => {
  const runtime = new BrowserRuntimeService(() => undefined);
  const harness = runtime as unknown as {
    applyPlacementToPage(
      page: Page,
      placement: DpiAwarePlacement,
      effectiveScale: number
    ): Promise<boolean>;
  };
  const { page } = fakePage({});
  assert.equal(await harness.applyPlacementToPage(page, placement, 0.75), false);
});

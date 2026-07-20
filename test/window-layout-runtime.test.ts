import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Page } from "patchright";
import { BrowserRuntimeService } from "../src/main/services/browser-runtime.js";
import type { DpiAwarePlacement } from "../src/main/services/window-geometry.js";
import type {
  NativeWindowPlacementCoordinator,
  NativeWindowPlacementResult,
  NativeWindowPlacementStatus,
  NativeWindowPlacementTarget
} from "../src/main/services/windows-window-placement.js";
import { defaultSettings } from "../src/shared/defaults.js";
import type { AppSettings } from "../src/shared/contracts.js";
import type {
  AvailableScreenDisplay,
  LayoutRect
} from "../src/shared/window-layout.js";

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

const availableDisplays: AvailableScreenDisplay[] = [
  {
    id: "1",
    primary: true,
    scaleFactor: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 }
  },
  {
    id: "2",
    primary: false,
    scaleFactor: 1.5,
    bounds: { x: -1707, y: 0, width: 1707, height: 960 },
    workArea: { x: -1707, y: 0, width: 1707, height: 920 }
  }
];

const multiMonitorSettings: AppSettings = {
  ...defaultSettings,
  screenLayout: {
    version: 2,
    monitors: [
      {
        displayId: "1",
        enabled: true,
        mode: "grid",
        columns: 1,
        rows: 1
      },
      {
        displayId: "2",
        enabled: true,
        mode: "grid",
        columns: 1,
        rows: 1
      }
    ]
  }
};

class FakeNativePlacementService implements NativeWindowPlacementCoordinator {
  readonly batches: NativeWindowPlacementTarget[][] = [];
  readonly cancelled: string[] = [];
  readonly statuses = new Map<string, NativeWindowPlacementStatus>();
  shutdownCalled = false;

  async enqueue(target: NativeWindowPlacementTarget): Promise<NativeWindowPlacementResult> {
    const [result] = await this.enqueueMany([target]);
    if (!result) throw new Error("missing fake native placement result");
    return result;
  }

  async enqueueMany(
    targets: readonly NativeWindowPlacementTarget[]
  ): Promise<NativeWindowPlacementResult[]> {
    this.batches.push([...targets]);
    return targets.map(({ profileId, x, y }) => {
      const status = this.statuses.get(profileId) ?? "positioned";
      return {
        profileId,
        status,
        ...(status === "positioned"
          ? { actual: { x, y } }
          : { error: "fake-native-failure" })
      };
    });
  }

  cancel(profileId: string): void {
    this.cancelled.push(profileId);
  }

  async shutdown(): Promise<void> {
    this.shutdownCalled = true;
  }
}

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
    /getLayoutPreviewRects\(settings: AppSettings\)[\s\S]*?this\.buildCurrentLogicalLayout\(settings\)/
  );
  assert.match(
    source,
    /private buildBrowserPlacement\([\s\S]*?settings: AppSettings[\s\S]*?this\.buildCurrentLogicalLayout\(settings\)/
  );
});

test("launch resolves the global sequence across displays and wraps on overflow", () => {
  const runtime = new BrowserRuntimeService(() => undefined);
  const harness = runtime as unknown as {
    getAvailableLayoutDisplays: () => AvailableScreenDisplay[];
    dipToPhysicalRect: (rect: LayoutRect) => LayoutRect;
    buildBrowserPlacement: (
      settings: AppSettings,
      forcedSlotIndex: number
    ) => DpiAwarePlacement & { displayId: string; displayScaleFactor: number };
  };
  harness.getAvailableLayoutDisplays = () => availableDisplays;
  harness.dipToPhysicalRect = (rect) => ({ ...rect });

  const first = harness.buildBrowserPlacement(multiMonitorSettings, 0);
  const second = harness.buildBrowserPlacement(multiMonitorSettings, 1);
  const overflow = harness.buildBrowserPlacement(multiMonitorSettings, 2);

  assert.equal(first.displayId, "1");
  assert.equal(first.displayScaleFactor, 1);
  assert.equal(second.displayId, "2");
  assert.equal(second.displayScaleFactor, 1.5);
  assert.equal(second.monitorPhysicalBounds.x, -1707);
  assert.equal(overflow.displayId, "1");
  assert.equal(overflow.slotIndex, 2);
});

test("preview includes every enabled display in global order", () => {
  const runtime = new BrowserRuntimeService(() => undefined);
  const harness = runtime as unknown as {
    getAvailableLayoutDisplays: () => AvailableScreenDisplay[];
    dipToPhysicalRect: (rect: LayoutRect) => LayoutRect;
    physicalToDipRect: (rect: LayoutRect) => LayoutRect;
  };
  harness.getAvailableLayoutDisplays = () => availableDisplays;
  harness.dipToPhysicalRect = (rect) => ({ ...rect });
  harness.physicalToDipRect = (rect) => ({ ...rect });

  const preview = runtime.getLayoutPreviewRects(multiMonitorSettings);

  assert.deepEqual(preview.slots.map((slot) => slot.displayId), ["1", "2"]);
  assert.deepEqual(preview.slots.map((slot) => slot.globalSlotIndex), [0, 1]);
  assert.deepEqual(preview.slots.map((slot) => slot.label), ["1", "2"]);
});

test("native target uses the physical slot instead of Chromium coordinates", () => {
  const nativePlacement = new FakeNativePlacementService();
  const runtime = new BrowserRuntimeService(() => undefined, nativePlacement);
  const harness = runtime as unknown as {
    buildNativePlacementTarget(
      profileId: string,
      storagePath: string,
      placement: DpiAwarePlacement
    ): NativeWindowPlacementTarget;
  };

  assert.deepEqual(
    harness.buildNativePlacementTarget("profile-a", "C:\\Predator\\profiles\\profile-a", placement),
    {
      profileId: "profile-a",
      userDataDir: "C:\\Predator\\profiles\\profile-a",
      x: 12,
      y: 12
    }
  );
});

test("apply isolates a placement failure and continues with the next window", async () => {
  const notifications: string[] = [];
  const nativePlacement = new FakeNativePlacementService();
  nativePlacement.statuses.set("first", "failed");
  const runtime = new BrowserRuntimeService((profileId, _status, detail) => {
    notifications.push(`${profileId}:${detail ?? ""}`);
  }, nativePlacement);
  const page = {
    isClosed: () => false,
    context: () => ({})
  } as unknown as Page;
  const context = { pages: () => [page] };
  const handles = new Map([
    ["first", {
      profileId: "first",
      slotIndex: 10,
      primaryPage: page,
      context,
      storagePath: "C:\\Predator\\profiles\\first",
      launchedScale: 0.75,
      placement
    }],
    ["second", {
      profileId: "second",
      slotIndex: 11,
      primaryPage: page,
      context,
      storagePath: "C:\\Predator\\profiles\\second",
      launchedScale: 0.75,
      placement
    }]
  ]);
  const harness = runtime as unknown as {
    handles: Map<string, unknown>;
    buildBrowserPlacement: (_settings: AppSettings, slotIndex: number) => DpiAwarePlacement;
    applyPlacementToPage: () => Promise<boolean>;
    updateContextBadges: () => Promise<void>;
  };
  harness.handles = handles;
  harness.buildBrowserPlacement = (_settings, slotIndex) => ({
    ...placement,
    slotIndex,
    targetPhysicalRect: { ...placement.targetPhysicalRect, x: 1000 + slotIndex }
  });
  harness.applyPlacementToPage = async () => true;
  harness.updateContextBadges = async () => undefined;

  await runtime.applyLayout(multiMonitorSettings);

  assert.equal(nativePlacement.batches.length, 1);
  assert.deepEqual(
    nativePlacement.batches[0]?.map(({ profileId, x }) => [profileId, x]),
    [["first", 1000], ["second", 1001]]
  );
  assert.equal((handles.get("first") as { slotIndex: number }).slotIndex, 10);
  assert.equal((handles.get("second") as { slotIndex: number }).slotIndex, 1);
  assert.ok(notifications.some((message) => message.startsWith("first:")));
  assert.ok(notifications.some((message) => message.startsWith("second:")));
});

test("runtime cancels pending native work and shuts the coordinator down", async () => {
  const nativePlacement = new FakeNativePlacementService();
  const runtime = new BrowserRuntimeService(() => undefined, nativePlacement);
  await runtime.stopProfile("missing-profile");
  await runtime.shutdown();
  assert.deepEqual(nativePlacement.cancelled, ["missing-profile"]);
  assert.equal(nativePlacement.shutdownCalled, true);
});

test("browser context close cancels pending native placement", () => {
  const nativePlacement = new FakeNativePlacementService();
  const runtime = new BrowserRuntimeService(() => undefined, nativePlacement);
  let closeHandler: (() => void) | undefined;
  const context = {
    on: (event: string, handler: () => void) => {
      if (event === "close") closeHandler = handler;
    }
  };
  const harness = runtime as unknown as {
    attachContextCloseHandler(profileId: string, context: unknown): void;
  };
  harness.attachContextCloseHandler("profile-close", context);
  closeHandler?.();
  assert.deepEqual(nativePlacement.cancelled, ["profile-close"]);
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

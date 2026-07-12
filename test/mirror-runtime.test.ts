import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserRuntimeService as BrowserRuntimeServiceType } from "../src/main/services/browser-runtime.js";

const { BrowserRuntimeService, projectMirrorFrameCoordinates, resolvePgSpeedStrategy } = await import(
  "../src/main/services/browser-runtime.js"
);
const { AutomationRuntimeService, isPlausibleQrImageDimensions } = await import(
  "../src/main/services/automation-runtime.js"
);
const { extractQrCode } = await import("../src/main/services/qr-dom.js");

type MirrorRuntimeHarness = {
  applyMirrorStateToAllPages(enabled: boolean, strict: boolean): Promise<void>;
  buildMirrorCaptureScript(enabled: boolean): string;
  disableMirrorForUnavailableTargets(reason: string): void;
  handles: Map<string, { profileId: string; slotIndex: number }>;
  mirrorEnabled: boolean;
};

function createMirrorHarness(): {
  runtime: BrowserRuntimeServiceType;
  harness: MirrorRuntimeHarness;
} {
  const runtime = new BrowserRuntimeService(() => undefined);
  const harness = runtime as unknown as MirrorRuntimeHarness;
  harness.handles.set("profile-1", { profileId: "profile-1", slotIndex: 0 });
  return { runtime, harness };
}

test("mirror activation commits only after capture setup succeeds", async () => {
  const { runtime, harness } = createMirrorHarness();
  let applied = false;
  harness.applyMirrorStateToAllPages = async (enabled, strict) => {
    assert.equal(enabled, true);
    assert.equal(strict, true);
    applied = true;
  };

  await runtime.setMirrorMode(true, { mode: "all" });

  assert.equal(applied, true);
  assert.equal(harness.mirrorEnabled, true);
});

test("mirror activation rolls back when capture setup fails", async () => {
  const { runtime, harness } = createMirrorHarness();
  harness.applyMirrorStateToAllPages = async (enabled) => {
    if (enabled) throw new Error("binding indisponivel");
  };

  await assert.rejects(
    runtime.setMirrorMode(true, { mode: "all" }),
    /binding indisponivel/
  );
  assert.equal(harness.mirrorEnabled, false);
});

test("rapid mirror transitions settle on the latest requested state", async () => {
  const { runtime, harness } = createMirrorHarness();
  const transitions: boolean[] = [];
  harness.applyMirrorStateToAllPages = async (enabled) => {
    transitions.push(enabled);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  };

  await Promise.all([
    runtime.setMirrorMode(true, { mode: "all" }),
    runtime.setMirrorMode(false, { mode: "all" })
  ]);

  assert.deepEqual(transitions, [true, false]);
  assert.equal(harness.mirrorEnabled, false);
});

test("mirror turns off when its last runtime window disappears", async () => {
  const { runtime, harness } = createMirrorHarness();
  harness.applyMirrorStateToAllPages = async () => undefined;
  await runtime.setMirrorMode(true, { mode: "all" });

  harness.handles.clear();
  harness.disableMirrorForUnavailableTargets("test-window-close");

  assert.equal(harness.mirrorEnabled, false);
});

test("iframe coordinates are projected into the top-level viewport", () => {
  const projected = projectMirrorFrameCoordinates(
    { kind: "pointerdown", xRatio: 0.5, yRatio: 0.25 },
    {
      frameBox: { x: 100, y: 200, width: 400, height: 300 },
      sourceViewport: { width: 1000, height: 800 }
    }
  );

  assert.equal(projected.xRatio, 0.3);
  assert.equal(projected.yRatio, 0.34375);
});

test("PG Director tick experiment is opt-in and defaults to the bundle strategy", () => {
  assert.equal(resolvePgSpeedStrategy(undefined), "bundle-timescale");
  assert.equal(resolvePgSpeedStrategy("director-tick"), "director-tick");
  assert.equal(resolvePgSpeedStrategy(" DIRECTOR-TICK "), "director-tick");
  assert.equal(resolvePgSpeedStrategy("unsupported"), "bundle-timescale");
});

test("mirror capture script does not exclude child frames", () => {
  const { harness } = createMirrorHarness();
  const script = harness.buildMirrorCaptureScript(true);
  assert.doesNotMatch(script, /window\.top\s*!==\s*window/);
  assert.match(script, /__predatorMirrorEvent/);
});

test("QR screenshot validation accepts squares and rejects viewport captures", () => {
  assert.equal(isPlausibleQrImageDimensions(270, 270), true);
  assert.equal(isPlausibleQrImageDimensions(320, 320), true);
  assert.equal(isPlausibleQrImageDimensions(1280, 720), false);
  assert.equal(isPlausibleQrImageDimensions(24, 24), false);
});

test("QR extraction uses intrinsic canvas pixels instead of its responsive CSS size", () => {
  const source = extractQrCode.toString();

  assert.match(source, /hasQrContrast\(canvas,\s*canvas\.width,\s*canvas\.height\)/);
  assert.match(source, /probe\.width\s*=\s*64/);
  assert.doesNotMatch(source, /getImageData\(0, 0, sw, sh\)/);
});

test("QR watcher remains alive after the automation run completes", () => {
  const prototype = AutomationRuntimeService.prototype as unknown as {
    startQrOverlayWatcher: () => void;
  };
  const source = prototype.startQrOverlayWatcher.toString();

  assert.match(source, /!page\.isClosed\(\)/);
  assert.doesNotMatch(source, /isRunActiveSafe/);
});

test("QR overlay is committed only after the image has loaded", () => {
  const prototype = AutomationRuntimeService.prototype as unknown as {
    renderQrOverlay: () => Promise<boolean>;
  };
  const source = prototype.renderQrOverlay.toString();

  assert.match(source, /imageReady/);
  assert.match(source, /imageLoaded/);
  // Caminho de falha: se a imagem nao carregou, remove a overlay e nao confirma.
  assert.match(source, /!imageLoaded/);
  assert.match(source, /root\.remove\(\)/);
});

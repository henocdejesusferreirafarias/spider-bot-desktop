import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserRuntimeService as BrowserRuntimeServiceType } from "../src/main/services/browser-runtime.js";

const { BrowserRuntimeService, projectMirrorFrameCoordinates } = await import(
  "../src/main/services/browser-runtime.js"
);
const { patchGameSpeedScript, resolveProviderByFrameUrl } = await import(
  "../src/main/services/provider-timing.js"
);
const { AutomationRuntimeService, isPlausibleQrImageDimensions } = await import(
  "../src/main/services/automation-runtime.js"
);
const { extractQrCode } = await import("../src/main/services/qr-dom.js");

type MirrorRuntimeHarness = {
  applyMirrorStateToAllPages(enabled: boolean, strict: boolean): Promise<void>;
  buildMirrorCaptureScript(enabled: boolean): string;
  buildMainWorldControlsScript(initialSpeedRate?: number): string;
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

test("PG loading guard is reversible and has no Director tick experiment", () => {
  const { harness } = createMirrorHarness();
  const script = harness.buildMainWorldControlsScript(4);

  assert.match(script, /pgLoadingState/);
  assert.match(script, /new MutationObserver/);
  assert.doesNotMatch(script, /__predatorPgSpeedUnlocked/);
  assert.doesNotMatch(script, /__predatorPgSpeedGateReason/);
  assert.doesNotMatch(script, /pgDirectorTickExperiment|cocos-director-tick-runtime/);
});

test("PG only releases Speed Time after the shared ready signal", () => {
  const { harness } = createMirrorHarness();
  const controlsScript = harness.buildMainWorldControlsScript(4);
  const profile = resolveProviderByFrameUrl("https://m.j67z85nx4.com/1543462/index.html");
  assert.ok(profile);

  const patchedBundle = patchGameSpeedScript(
    '"Director";"_timeScale";requestAnimationFrame();this._timeScale=1;',
    4,
    profile
  );

  assert.match(controlsScript, /elementFromPoint/);
  assert.doesNotMatch(controlsScript, /tagName === "svg"|tagName === "img"/);
  assert.match(controlsScript, /pgSawBlockingLayerAfterCanvas/);
  assert.match(controlsScript, /pgUserConfirmedReady/);
  assert.match(controlsScript, /addEventListener\('pointerdown'/);
  assert.match(controlsScript, /data-rtc-game-ready/);
  assert.match(patchedBundle, /data-rtc-game-ready/);
});

test("JDB installs dynamic clocks during early init even at 1x", () => {
  const { harness } = createMirrorHarness();
  const script = harness.buildMainWorldControlsScript(1);

  assert.match(script, /isJdbGameDocument/);
  assert.match(script, /const jdbGameDocument = isJdbGameDocument\(\)/);
  assert.match(script, /if \(jdbGameDocument\) return true/);
  assert.match(script, /jdbUserConfirmedReady/);
  assert.match(script, /if \(jdbGameDocument\) installSpeed\(\)/);
  assert.match(script, /window\.Date = ScaledDate/);
  assert.match(
    script,
    /performanceStart \+ \(ts - performanceStart\) \* readRate\(\)/
  );
  assert.doesNotMatch(script, /start \+ \(ts - start\) \* readRate\(\)/);
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

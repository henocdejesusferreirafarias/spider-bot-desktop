import assert from "node:assert/strict";
import test from "node:test";

import {
  WindowsWindowPlacementService,
  WINDOWS_WINDOW_PLACEMENT_SCRIPT,
  type NativeWindowPlacementTarget,
  parseNativePlacementResults,
  validateNativePlacementTarget
} from "../src/main/services/windows-window-placement.js";

const target = {
  profileId: "profile-a",
  userDataDir: "C:\\Users\\tester\\Predator\\profiles\\profile-a",
  x: 1928,
  y: 8
};

test("accepts a specific target and rounds physical coordinates", () => {
  assert.deepEqual(
    validateNativePlacementTarget({ ...target, x: 1928.4, y: 7.6 }),
    target
  );
});

test("rejects an empty or short directory and non-finite coordinates", () => {
  assert.throws(() => validateNativePlacementTarget({ ...target, userDataDir: "" }));
  assert.throws(() => validateNativePlacementTarget({ ...target, userDataDir: "ab" }));
  assert.throws(() => validateNativePlacementTarget({ ...target, x: Number.NaN }));
});

test("parses one result or a result list without trusting extra fields", () => {
  const expected = [{
    profileId: "profile-a",
    status: "positioned" as const,
    actual: { x: 1928, y: 8 }
  }];
  assert.deepEqual(parseNativePlacementResults(JSON.stringify(expected)), expected);
  assert.deepEqual(parseNativePlacementResults(JSON.stringify(expected[0])), expected);
});

test("rejects empty, invalid or unknown helper output", () => {
  assert.throws(() => parseNativePlacementResults(""));
  assert.throws(() => parseNativePlacementResults("not-json"));
  assert.throws(() => parseNativePlacementResults(JSON.stringify({
    profileId: "profile-a",
    status: "moved"
  })));
});

test("PowerShell helper is position-only and associates windows fail-closed", () => {
  for (const required of [
    "SetWindowPos",
    "GetWindowRect",
    "SWP_NOSIZE",
    "SWP_NOZORDER",
    "SWP_NOACTIVATE",
    "SetProcessDpiAwarenessContext",
    "EnablePerMonitorDpiAwareness",
    "Chrome_WidgetWin_1",
    "--user-data-dir"
  ]) {
    assert.match(WINDOWS_WINDOW_PLACEMENT_SCRIPT, new RegExp(required));
  }
  assert.doesNotMatch(WINDOWS_WINDOW_PLACEMENT_SCRIPT, /SetWindowText|ShowWindow|MainWindowTitle/);
});

const placementTarget = (index: number): NativeWindowPlacementTarget => ({
  profileId: `profile-${index}`,
  userDataDir: `C:\\Predator\\profiles\\profile-${index}`,
  x: 100 + index,
  y: 8
});

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("coalesces twenty profiles into one runner invocation", async () => {
  const batches: NativeWindowPlacementTarget[][] = [];
  const service = new WindowsWindowPlacementService({
    debounceMs: 0,
    retryDelayMs: 0,
    runner: async (targets) => {
      batches.push([...targets]);
      return targets.map(({ profileId, x, y }) => ({
        profileId,
        status: "positioned",
        actual: { x, y }
      }));
    }
  });

  const results = await service.enqueueMany(
    Array.from({ length: 20 }, (_, index) => placementTarget(index))
  );

  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.length, 20);
  assert.ok(results.every((result) => result.status === "positioned"));
  await service.shutdown();
});

test("coalesces repeated profile requests to the newest coordinates", async () => {
  const batches: NativeWindowPlacementTarget[][] = [];
  const service = new WindowsWindowPlacementService({
    debounceMs: 0,
    runner: async (targets) => {
      batches.push([...targets]);
      return targets.map(({ profileId, x, y }) => ({
        profileId,
        status: "positioned",
        actual: { x, y }
      }));
    }
  });
  const first = service.enqueue(placementTarget(1));
  const second = service.enqueue({ ...placementTarget(1), x: 900 });

  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.length, 1);
  assert.equal(batches[0]?.[0]?.x, 900);
  assert.equal(firstResult.actual?.x, 900);
  assert.deepEqual(firstResult, secondResult);
  await service.shutdown();
});

test("starts a later batch only after the active batch settles", async () => {
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const batches: NativeWindowPlacementTarget[][] = [];
  const service = new WindowsWindowPlacementService({
    debounceMs: 0,
    runner: async (targets) => {
      batches.push([...targets]);
      if (batches.length === 1) await firstBlocked;
      return targets.map(({ profileId, x, y }) => ({
        profileId,
        status: "positioned",
        actual: { x, y }
      }));
    }
  });

  const first = service.enqueue(placementTarget(1));
  await nextTurn();
  const second = service.enqueue(placementTarget(2));
  await nextTurn();
  assert.equal(batches.length, 1);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.equal(batches.length, 2);
  await service.shutdown();
});

test("retries only window-not-ready and stops at the configured limit", async () => {
  let invocations = 0;
  const service = new WindowsWindowPlacementService({
    debounceMs: 0,
    retryDelayMs: 0,
    maxAttempts: 3,
    runner: async (targets) => {
      invocations += 1;
      return targets.map(({ profileId, x, y }) => invocations < 3
        ? { profileId, status: "window-not-ready", error: "window-not-found" }
        : { profileId, status: "positioned", actual: { x, y } });
    }
  });

  assert.equal((await service.enqueue(placementTarget(1))).status, "positioned");
  assert.equal(invocations, 3);
  await service.shutdown();
});

test("does not retry failed placement", async () => {
  let invocations = 0;
  const service = new WindowsWindowPlacementService({
    debounceMs: 0,
    retryDelayMs: 0,
    runner: async (targets) => {
      invocations += 1;
      return targets.map(({ profileId }) => ({ profileId, status: "failed", error: "ambiguous-window" }));
    }
  });

  assert.equal((await service.enqueue(placementTarget(1))).status, "failed");
  assert.equal(invocations, 1);
  await service.shutdown();
});

test("cancel and shutdown settle pending requests without invoking the runner", async () => {
  let invocations = 0;
  const service = new WindowsWindowPlacementService({
    debounceMs: 100,
    runner: async () => {
      invocations += 1;
      return [];
    }
  });
  const cancelled = service.enqueue(placementTarget(1));
  service.cancel("profile-1");
  assert.deepEqual(await cancelled, {
    profileId: "profile-1",
    status: "failed",
    error: "cancelled"
  });
  const shutdown = service.enqueue(placementTarget(2));
  await service.shutdown();
  assert.deepEqual(await shutdown, {
    profileId: "profile-2",
    status: "failed",
    error: "shutdown"
  });
  assert.equal(invocations, 0);
  assert.equal((await service.enqueue(placementTarget(3))).error, "service-shutdown");
});

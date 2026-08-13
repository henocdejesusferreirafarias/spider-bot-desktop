import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserRuntimeService,
  closeProfileBrowser
} from "../src/main/services/browser-runtime.js";

test("profile browser timeout includes a page close that never settles", async () => {
  const killedPaths: string[] = [];
  let contextCloseCalled = false;
  const never = new Promise<void>(() => undefined);
  const target = {
    storagePath: "C:\\profiles\\profile-a",
    context: {
      pages: () => [{ close: () => never }],
      close: async () => {
        contextCloseCalled = true;
      }
    }
  };

  await closeProfileBrowser(target, {
    timeoutMs: 20,
    forceKill: async (storagePath) => {
      killedPaths.push(storagePath);
    }
  });

  assert.equal(contextCloseCalled, false);
  assert.deepEqual(killedPaths, ["C:\\profiles\\profile-a"]);
});

test("graceful profile browser close does not force kill", async () => {
  const calls: string[] = [];
  const target = {
    storagePath: "C:\\profiles\\profile-b",
    context: {
      pages: () => [{ close: async () => calls.push("page") }],
      close: async () => {
        calls.push("context");
      }
    }
  };

  await closeProfileBrowser(target, {
    timeoutMs: 100,
    forceKill: async () => {
      calls.push("kill");
    }
  });

  assert.deepEqual(calls, ["page", "context"]);
});

test("profile browser stop remains bounded when force kill never settles", async () => {
  const never = new Promise<void>(() => undefined);
  const target = {
    storagePath: "C:\\profiles\\profile-c",
    context: {
      pages: () => [{ close: () => never }],
      close: () => never
    }
  };

  const outcome = await Promise.race([
    closeProfileBrowser(target, {
      timeoutMs: 5,
      forceKillTimeoutMs: 5,
      forceKill: () => never
    }).then(() => "completed" as const),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 500))
  ]);

  assert.equal(outcome, "completed");
});

test("active browser stop keeps runtime status notifications for persistence", async () => {
  const notifications: string[] = [];
  const runtime = new BrowserRuntimeService((_profileId, status) => {
    notifications.push(status);
  });
  let closeListener: (() => void) | undefined;
  const context = {
    pages: () => [],
    on: (event: string, listener: () => void) => {
      if (event === "close") closeListener = listener;
    },
    close: async () => {
      closeListener?.();
    }
  };
  const runtimeInternals = runtime as unknown as {
    handles: Map<string, unknown>;
    attachContextCloseHandler: (
      profileId: string,
      context: typeof context
    ) => void;
  };
  runtimeInternals.attachContextCloseHandler("profile-a", context);
  runtimeInternals.handles.set("profile-a", {
    profileId: "profile-a",
    storagePath: "C:\\profiles\\profile-a",
    context
  });

  await runtime.stopProfile("profile-a");

  assert.equal(notifications[0], "stopping");
  assert.ok(notifications.includes("idle"));
  assert.equal(runtime.isActive("profile-a"), false);
});

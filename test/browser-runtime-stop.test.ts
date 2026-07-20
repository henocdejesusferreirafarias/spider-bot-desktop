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

test("bulk deletion can stop an active browser without intermediate status snapshots", async () => {
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

  await runtime.stopProfile("profile-a", { notify: false });

  assert.deepEqual(notifications, []);
  assert.equal(runtime.isActive("profile-a"), false);
});

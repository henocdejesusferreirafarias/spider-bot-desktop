import assert from "node:assert/strict";
import test from "node:test";
import { closeProfileBrowser } from "../src/main/services/browser-runtime.js";

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

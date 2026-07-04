import assert from "node:assert/strict";
import test from "node:test";
import {
  pollForLabelResult,
  resolveAutomationOrigin,
  resolveRemoteActionTimeoutMs,
  resolveRemoteNavigationTimeoutMs,
  resolveRemoteStepTimeoutMs,
  trustCurrentAutomationOrigin,
  trustRedirectedAutomationOrigin
} from "../src/main/services/automation-helpers.js";

function makeSleepRecorder() {
  const calls: number[] = [];
  const sleep = async (ms: number) => {
    calls.push(ms);
  };
  return { calls, sleep };
}

test("pollForLabelResult returns the first successful label", async () => {
  let attempt = 0;
  const result = await pollForLabelResult(
    async () => {
      attempt += 1;
      return attempt >= 3 ? "found-it" : undefined;
    },
    async () => undefined
  );
  assert.equal(result, "found-it");
  assert.equal(attempt, 3);
});

test("pollForLabelResult returns undefined when every attempt fails", async () => {
  let attempts = 0;
  const result = await pollForLabelResult(
    async () => {
      attempts += 1;
      return undefined;
    },
    async () => undefined,
    { maxAttempts: 3, initialDelayMs: 10 }
  );
  assert.equal(result, undefined);
  assert.equal(attempts, 3);
});

test("pollForLabelResult does not sleep after the last attempt", async () => {
  const { calls, sleep } = makeSleepRecorder();
  await pollForLabelResult(
    async () => undefined,
    sleep,
    { maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 500 }
  );
  assert.deepEqual(calls, [100, 150]);
});

test("pollForLabelResult grows the delay exponentially up to maxDelayMs", async () => {
  const { calls, sleep } = makeSleepRecorder();
  await pollForLabelResult(
    async () => undefined,
    sleep,
    { maxAttempts: 6, initialDelayMs: 100, maxDelayMs: 350 }
  );
  assert.deepEqual(calls, [100, 150, 225, 337.5, 350]);
});

test("pollForLabelResult stops sleeping once an attempt succeeds", async () => {
  const { calls, sleep } = makeSleepRecorder();
  await pollForLabelResult(
    async () => "label-1",
    sleep,
    { maxAttempts: 6, initialDelayMs: 100, maxDelayMs: 500 }
  );
  assert.equal(calls.length, 0);
});

test("pollForLabelResult swallows sleep rejections so a closed page cannot abort the poll", async () => {
  const result = await pollForLabelResult(
    async () => "ok",
    async () => {
      throw new Error("page closed");
    },
    { maxAttempts: 3, initialDelayMs: 5 }
  );
  assert.equal(result, "ok");
});

test("trustRedirectedAutomationOrigin accepts an HTTP to HTTPS redirect", () => {
  const allowedOrigins = new Set(["http://entry.example"]);

  const redirectedOrigin = trustRedirectedAutomationOrigin(
    allowedOrigins,
    "http://entry.example/",
    "https://entry.example/register"
  );

  assert.equal(redirectedOrigin, "https://entry.example");
  assert.equal(allowedOrigins.has("https://entry.example"), true);
});

test("trustRedirectedAutomationOrigin accepts a platform redirect to another host", () => {
  const allowedOrigins = new Set(["https://platform-entry.example"]);

  const redirectedOrigin = trustRedirectedAutomationOrigin(
    allowedOrigins,
    "https://platform-entry.example/",
    "https://platform-live.example/home"
  );

  assert.equal(redirectedOrigin, "https://platform-live.example");
  assert.equal(allowedOrigins.has("https://platform-live.example"), true);
});

test("trustCurrentAutomationOrigin accepts unlimited delayed redirects after authorized navigation", () => {
  const trustedNavigationOrigins = new Set(["https://entry.example"]);

  const secondOrigin = trustCurrentAutomationOrigin(
    trustedNavigationOrigins,
    "https://gateway.example/loading"
  );
  const thirdOrigin = trustCurrentAutomationOrigin(
    trustedNavigationOrigins,
    "https://platform.example/register"
  );
  const fourthOrigin = trustCurrentAutomationOrigin(
    trustedNavigationOrigins,
    "https://account.platform-cdn.example/form"
  );

  assert.equal(secondOrigin, "https://gateway.example");
  assert.equal(thirdOrigin, "https://platform.example");
  assert.equal(fourthOrigin, "https://account.platform-cdn.example");
  assert.equal(trustedNavigationOrigins.size, 4);
});

test("trustCurrentAutomationOrigin requires an authorized navigation anchor", () => {
  assert.throws(
    () =>
      trustCurrentAutomationOrigin(
        new Set(),
        "https://redirected.example/register"
      ),
    /Nenhuma navegacao autorizada/
  );
});

test("trustRedirectedAutomationOrigin still rejects an unauthorized requested URL", () => {
  assert.throws(
    () =>
      trustRedirectedAutomationOrigin(
        new Set(["https://allowed.example"]),
        "https://untrusted.example/",
        "https://redirected.example/"
      ),
    /Origem remota nao autorizada/
  );
});

test("resolveAutomationOrigin rejects non-web protocols", () => {
  assert.throws(
    () => resolveAutomationOrigin("file:///C:/Windows/System32/calc.exe"),
    /Protocolo de automacao nao permitido/
  );
});

test("account registration gets extended timeouts for slow machines", () => {
  assert.equal(resolveRemoteNavigationTimeoutMs("account-registration"), 90_000);
  assert.equal(resolveRemoteActionTimeoutMs("account-registration", 8_000), 60_000);
  assert.equal(resolveRemoteStepTimeoutMs("account-registration", 45_000), 300_000);
});

test("other workflows keep their configured timeouts", () => {
  assert.equal(resolveRemoteNavigationTimeoutMs("login"), 30_000);
  assert.equal(resolveRemoteActionTimeoutMs("login", 8_000), 8_000);
  assert.equal(resolveRemoteStepTimeoutMs("login", 45_000), 45_000);
});

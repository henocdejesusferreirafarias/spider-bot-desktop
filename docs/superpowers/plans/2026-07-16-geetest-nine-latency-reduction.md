# GeeTest Nine Latency Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce automatic GeeTest `nine` latency by replacing per-answer search budgets with global reroll accounting and removing unnecessary fixed waits.

**Architecture:** Keep `geetest-solver.ts` responsible for classifying loaded challenges and enforcing one search budget, while `automation-runtime.ts` owns the lifetime counters for one captcha solve. Keep the ONNX queue and model unchanged; optimize only network orchestration, completion settling, and error visibility.

**Tech Stack:** TypeScript strict ESM, Node test runner through `tsx --test`, Patchright request/page APIs, ONNX Runtime Node.

## Global Constraints

- Preserve a maximum of 10 non-nine, malformed, or failed `/load` rerolls per automatic solve.
- Preserve a maximum of 5 usable `nine` challenges selected for solving per automatic solve.
- Preserve the 60,000 ms overall deadline and manual fallback.
- Wait 180 ms only after malformed/error loads and rejected/failed `nine` answers.
- Do not change the model, preprocessing, ranking, inference concurrency, or manual captcha workflow.
- Do not restore `icon`, `slide`, or Python solver support.
- Do not stage or modify `dataset/`.

---

### Task 1: Global Reroll Budget and Delay Classification

**Files:**
- Modify: `src/main/services/geetest-solver.ts`
- Test: `test/geetest-solver.test.ts`

**Interfaces:**
- Consumes: `GeetestNineClient.load(captchaId, "nine")` and the existing 60-second `deadlineAt`.
- Produces: `NineChallengeSearchResult` carrying `loadAttempts` and `rerollAttempts`; `NineChallengeSearchOptions.maxRerolls` limits discarded/error loads for one invocation.

- [ ] **Step 1: Replace the old search expectations with failing global-budget and delay-policy tests**

Add tests that use a virtual clock and record delay calls:

```ts
test("findNineChallengeWithClient exhausts exactly ten rerolls", async () => {
  let loads = 0;
  const waits: number[] = [];
  const client = {
    async load() {
      loads += 1;
      return challenge("icon", String(loads));
    },
    async fetchImage() { return Buffer.alloc(0); },
    async verify() { return {}; },
  };

  const result = await findNineChallengeWithClient(client, "captcha-1", {
    deadlineAt: 60_000,
    maxRerolls: 10,
    now: () => 0,
    wait: async (delayMs) => { waits.push(delayMs); },
  });

  assert.deepEqual(result, {
    status: "exhausted",
    loadAttempts: 10,
    rerollAttempts: 10,
  });
  assert.equal(loads, 10);
  assert.deepEqual(waits, []);
});

test("findNineChallengeWithClient delays malformed and failed loads only", async () => {
  const waits: number[] = [];
  let loads = 0;
  const client = {
    async load() {
      loads += 1;
      if (loads === 1) throw new Error("network");
      if (loads === 2) return { ...challenge("nine", "bad"), process_token: "" };
      if (loads === 3) return challenge("icon", "icon");
      return challenge("nine", "good");
    },
    async fetchImage() { return Buffer.alloc(0); },
    async verify() { return {}; },
  };

  const result = await findNineChallengeWithClient(client, "captcha-1", {
    deadlineAt: 60_000,
    maxRerolls: 10,
    now: () => 0,
    wait: async (delayMs) => { waits.push(delayMs); },
  });

  assert.deepEqual(result, {
    status: "found",
    data: challenge("nine", "good"),
    loadAttempts: 4,
    rerollAttempts: 3,
  });
  assert.deepEqual(waits, [180, 180]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx tsx --test test/geetest-solver.test.ts`

Expected: FAIL because `maxRerolls`, `loadAttempts`, and `rerollAttempts` are not implemented and valid non-nine responses still wait 180 ms.

- [ ] **Step 3: Implement result accounting and reason-aware delay**

Change the public result/options types and search loop to this shape:

```ts
export type NineChallengeSearchResult =
  | {
      status: "found";
      data: GeetestChallengeData;
      loadAttempts: number;
      rerollAttempts: number;
    }
  | {
      status: "exhausted" | "deadline";
      loadAttempts: number;
      rerollAttempts: number;
    };

export interface NineChallengeSearchOptions {
  deadlineAt: number;
  maxRerolls?: number;
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
}
```

In `findNineChallengeWithClient`, count every call as `loadAttempts` and each non-usable result/error as `rerollAttempts`. A response is a valid non-nine reroll only when it has a non-empty `captcha_type` other than `nine`; all thrown loads, missing types, and malformed `nine` responses set `shouldDelay = true`. Return `exhausted` immediately when `rerollAttempts` reaches `maxRerolls`; otherwise wait 180 ms only when `shouldDelay` is true.

- [ ] **Step 4: Update the remaining focused tests to the new result fields and run GREEN**

Run: `npx tsx --test test/geetest-solver.test.ts`

Expected: all `geetest-solver` tests PASS, including no wait for valid `icon` rerolls and two waits for error/malformed responses.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/main/services/geetest-solver.ts test/geetest-solver.test.ts
git commit -m "fix(captcha): enforce global nine reroll accounting"
```

---

### Task 2: Runtime-Wide Counters and Real Error Reporting

**Files:**
- Modify: `src/main/services/automation-runtime.ts`
- Test: `test/automation-runtime.test.ts`

**Interfaces:**
- Consumes: Task 1 result fields `loadAttempts`, `rerollAttempts` and option `maxRerolls`.
- Produces: one `tryAutoSolveGeetestCaptcha` execution with lifetime `rerollAttempts <= 10`, `answerAttempts <= 5`, and logs that distinguish thrown pipeline errors from verify rejection.

- [ ] **Step 1: Write failing runtime regression tests**

Replace the test that expects a fresh ten-search budget per rejected answer with this regression:

```ts
function runtimeChallenge(captchaType: string, suffix: string) {
  return {
    lot_number: `lot-${suffix}`,
    pow_detail: { hashfunc: "md5", version: "1", bits: 0, datetime: "2026-07-16" },
    pt: "0",
    captcha_type: captchaType,
    payload: `payload-${suffix}`,
    process_token: `process-${suffix}`,
    imgs: "grid.jpg",
    ques: ["ques.png"],
    nine_nums: 3,
  };
}

test("Geetest runtime shares ten rerolls across rejected nine answers", async () => {
  const { runtime } = createRuntime();
  const geetest = runtime as unknown as GeetestRuntimeHarness;
  let loads = 0;
  let answers = 0;
  const messages: string[] = [];
  geetest.geetestCapturedData.set("run-1", {
    captchaId: "0123456789abcdef0123456789abcdef",
    baseUrl: "https://gcaptcha4.geevisit.com",
  });
  geetest.createGeetestClient = () => ({
    async load() {
      loads += 1;
      return runtimeChallenge(loads === 10 ? "nine" : "icon", String(loads));
    },
  });
  geetest.solveLoadedNineChallenge = async () => {
    answers += 1;
    return null;
  };
  geetest.waitForRunDelay = async () => undefined;
  geetest.ensureRunActive = () => undefined;
  geetest.nowMs = () => 0;
  geetest.log = (...args) => { messages.push(String(args.at(-1))); };

  const solved = await geetest.tryAutoSolveGeetestCaptcha(
    "run-1",
    {} as Page,
    "Teste",
  );

  assert.equal(solved, false);
  assert.equal(loads, 11);
  assert.equal(answers, 1);
  assert.match(messages.at(-1) ?? "", /10 reroll/);
});
```

Add a separate test where `solveLoadedNineChallenge` throws `new Error("inference failed")`; assert the log contains `inference failed` and that the attempt is consumed. Keep a null-return test asserting the existing `Resposta nine rejeitada` wording.

- [ ] **Step 2: Run the runtime tests and verify RED**

Run: `npx tsx --test test/automation-runtime.test.ts`

Expected: FAIL with 50 loads instead of 11 and without the thrown error message in logs.

- [ ] **Step 3: Implement lifetime counters and error-aware logging**

In `tryAutoSolveGeetestCaptcha`, add:

```ts
let totalLoadAttempts = 0;
let rerollAttempts = 0;

for (
  let answerAttempt = 1;
  answerAttempt <= GEETEST_NINE_ANSWER_LIMIT;
  answerAttempt += 1
) {
  const remainingRerolls = GEETEST_NINE_SEARCH_LIMIT - rerollAttempts;
  if (remainingRerolls <= 0) return false;
  const selection = await findNineChallengeWithClient(client, captchaId, {
    deadlineAt,
    maxRerolls: remainingRerolls,
    now: () => this.nowMs(),
    wait: (delayMs) => this.waitForRunDelay(runId, page, delayMs),
  });
  totalLoadAttempts += selection.loadAttempts;
  rerollAttempts += selection.rerollAttempts;
  // preserve deadline/manual fallback handling
}
```

Capture the thrown value separately from a null verify result:

```ts
let solveError: unknown;
try {
  solution = await this.solveLoadedNineChallenge(client, captchaId, selection.data);
} catch (error) {
  solveError = error;
}
```

Log `Falha ao processar resposta nine (N/5): <message>.` for `solveError`, and retain `Resposta nine rejeitada (N/5).` only when the pipeline returned `null`. Both paths consume the answer and wait 180 ms before another attempt when limits permit.

- [ ] **Step 4: Run runtime and solver tests GREEN**

Run: `npx tsx --test test/automation-runtime.test.ts test/geetest-solver.test.ts`

Expected: PASS with 11 loads in the regression scenario, one answered `nine`, and the real pipeline error visible.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/main/services/automation-runtime.ts test/automation-runtime.test.ts
git commit -m "fix(captcha): bound nine retries across one solve"
```

---

### Task 3: Parallel Image Fetch and Conditional Success Settle

**Files:**
- Modify: `src/main/services/captcha/signer.ts`
- Modify: `src/main/services/automation-runtime.ts`
- Test: `test/captcha-signer.test.ts`
- Test: `test/automation-runtime.test.ts`

**Interfaces:**
- Consumes: existing `generateNineW(data, captchaId, fetchImage)` and `detectCaptchaChallenge(page)`.
- Produces: optional `findCells` dependency for signer tests and private `waitForGeetestDismissal(runId, page, maxMs)` used after bridge success.

- [ ] **Step 1: Write a failing signer concurrency test**

Add an optional fourth `findCells` argument to the test call and use deferred fetches:

```ts
test("generateNineW starts grid and prompt downloads concurrently", async () => {
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const fetchImage = (path: string) => new Promise<Buffer>((resolve) => {
    started.push(path);
    releases.set(path, () => resolve(Buffer.from(path)));
  });
  const resultPromise = generateNineW(
    {
      lot_number: "0123456789abcdefghijklmnopqrstuvwxyz",
      pow_detail: { hashfunc: "md5", version: "1", bits: 0, datetime: "2026-07-16" },
      pt: "0",
      imgs: "grid.jpg",
      ques: ["ques.png"],
      nine_nums: 3,
    },
    "captcha-1",
    fetchImage,
    async () => [[1, 1], [2, 2], [3, 3]],
  );

  await Promise.resolve();
  assert.deepEqual(started, ["grid.jpg", "ques.png"]);
  releases.get("grid.jpg")?.();
  releases.get("ques.png")?.();
  assert.match(await resultPromise, /userresponse/);
});
```

- [ ] **Step 2: Write a failing early-dismissal test**

Extend `GeetestRuntimeHarness` with `waitForGeetestDismissal` and `detectCaptchaChallenge`. Simulate `active: true` then `active: false`, advance virtual time in `waitForRunDelay`, and assert only 100 ms elapsed rather than 1,200 ms.

- [ ] **Step 3: Run both focused files and verify RED**

Run: `npx tsx --test test/captcha-signer.test.ts test/automation-runtime.test.ts`

Expected: FAIL because `generateNineW` fetches sequentially and no conditional dismissal helper exists.

- [ ] **Step 4: Fetch images concurrently with an injectable matcher**

Add this type and signature in `signer.ts`:

```ts
export type FindNineMatchCells = (
  gridBuf: Buffer,
  quesBuf: Buffer,
  nineNums: number,
) => Promise<Array<[number, number]>>;

export async function generateNineW(
  data: GeetestChallengeData,
  captchaId: string,
  fetchImage: (path: string) => Promise<Buffer>,
  findCells?: FindNineMatchCells,
): Promise<string> {
```

Start both downloads with `Promise.all`, then resolve `findCells ?? (await import("./solvers/nine-match.js")).findNineMatchCells` and invoke it with the unchanged `nine_nums` value.

- [ ] **Step 5: Replace the fixed success sleep with conditional polling**

Add a private helper that checks immediately, then waits in 100 ms increments up to 1,200 ms:

```ts
private async waitForGeetestDismissal(
  runId: string,
  page: Page,
  maxMs = 1200,
): Promise<boolean> {
  const deadlineAt = this.nowMs() + maxMs;
  while (true) {
    if (!(await this.detectCaptchaChallenge(page)).active) return true;
    const remaining = deadlineAt - this.nowMs();
    if (remaining <= 0) return false;
    await this.waitForRunDelay(runId, page, Math.min(100, remaining));
  }
}
```

After `tryAutoSolveGeetestCaptcha` returns true, call this helper instead of `waitForRunDelay(..., 1200)`. Preserve mask restoration and the existing return behavior.

- [ ] **Step 6: Run focused tests GREEN**

Run: `npx tsx --test test/captcha-signer.test.ts test/automation-runtime.test.ts test/geetest-solver.test.ts`

Expected: PASS; both image fetches begin together and the dismissal test settles after its first 100 ms poll.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/main/services/captcha/signer.ts src/main/services/automation-runtime.ts test/captcha-signer.test.ts test/automation-runtime.test.ts
git commit -m "perf(captcha): remove avoidable nine solve waits"
```

---

### Task 4: Final Verification and Latency Evidence

**Files:**
- Modify only if a gate exposes a defect in Tasks 1-3.

**Interfaces:**
- Consumes: all behavior implemented in Tasks 1-3.
- Produces: passing repository gates and measured local model latency evidence.

- [ ] **Step 1: Scan for obsolete per-answer budget behavior and debug instrumentation**

Run:

```bash
rg -n "fresh search budget|searchAttempts|\[DEBUG-" src/main/services test
```

Expected: no old fresh-budget assertion, no stale `searchAttempts` field, and no temporary debug tags.

- [ ] **Step 2: Run typecheck**

Run: `npm run check`

Expected: exit 0 with both strict TypeScript configurations passing.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`

Expected: all tests pass with zero failures and zero skips.

- [ ] **Step 4: Re-run the local ONNX benchmark**

Use one preserved `dataset/raw/<challenge>` sample to call `findNineMatchCells` six times. Record cold and warmed timings in the handoff; do not create or stage benchmark artifacts.

- [ ] **Step 5: Verify Git scope**

Run:

```bash
git status --short
git diff --check
git log --oneline 29b0914..HEAD
```

Expected: only `dataset/` remains untracked; no dataset file is staged; implementation commits are limited to the planned captcha runtime, signer, and tests.

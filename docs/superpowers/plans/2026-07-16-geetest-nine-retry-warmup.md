# GeeTest nine retry, warm-up, and legacy cleanup implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Captcha Killer search up to 10 times for each eligible `nine` challenge, submit at most 5 failed `nine` answers within 60 seconds, warm the singleton ONNX session early, and remove the unused Python GeeTest runtime.

**Architecture:** Keep challenge loading and loaded-challenge verification in `geetest-solver.ts`, while `AutomationRuntimeService` owns the nested answer policy and browser fallback. Make `NineMatchClassifier` initialization a shared retryable promise. Remove the Python process service and every packaging/setup path that can install or ship it, while retaining current offline model-training scripts.

**Tech Stack:** TypeScript strict ESM/NodeNext, Electron main process, Patchright request context, `onnxruntime-node`, Node `node:test`, electron-builder, Python only for offline training verification.

## Global Constraints

- Start from commit `532d9ac` or later on branch `feat/solver-captcha-ts`.
- Search limit is exactly 10 `/load` calls per answer round.
- Answer limit is exactly 5 selected `nine` challenges that reach solve/verify.
- Retry delay is exactly 180 ms.
- Total automatic-solving deadline is exactly 60,000 ms.
- A returned `captcha_type=nine`, compared case-insensitively, is required even when the request sends `risk_type=nine`.
- Hitting either retry limit or the deadline returns to the existing manual captcha flow.
- No `icon`, `slide`, or other GeeTest solver is added.
- Do not restore or call the Python solver as a fallback.
- Keep the existing singleton classifier and inference concurrency queue; default concurrency remains 1.
- Keep `scripts/captcha-train-nine-match.py`, `scripts/captcha-train-photo.py`, and `scripts/captcha-oracle-ques.py`.
- Do not change model binaries, model metadata, datasets, ADRs, or historical plans/specs.
- The worktree is already dirty. Do not stage or revert `assets/captcha/nine_match.onnx`, `assets/captcha/nine_match.json`, `dataset/`, probe scripts, HAR files, or unrelated user changes.
- Preserve `GeekedTest-main/LICENSE` as `assets/captcha/GeekedTest-LICENSE.txt` before deleting the vendored tree.
- Use `apply_patch` for source and test edits. The vendored tree and obsolete scripts may be removed mechanically after their exact paths are verified.
- Required final gates are `npm run check` and `npm test`.

## File map

| File | Responsibility after this plan |
|---|---|
| `src/main/services/captcha/onnx-session.ts` | Own one retryable promise for the singleton nine-match ONNX session and expose warm-up. |
| `src/main/services/geetest-solver.ts` | Define GeeTest contracts, select a usable `nine` challenge, and solve an already loaded challenge through the TypeScript signer. Contains no process spawning. |
| `src/main/services/automation-runtime.ts` | Start model warm-up, own the 10-search/5-answer/60-second policy, apply solutions, and fall back to manual handling. |
| `test/captcha-photo-classifier.test.ts` | Verify shared ONNX initialization and retry after initialization failure. |
| `test/geetest-solver.test.ts` | Verify search counting, requested/returned types, malformed loads, deadline, and loaded-challenge verification. |
| `test/automation-runtime.test.ts` | Verify the two independent counters and non-`nine` captured-type behavior at runtime. |
| `test/geetest-legacy-cleanup.test.ts` | Prevent Python solver setup or packaging from returning. |
| `package.json` | Keep offline training commands; remove runtime Python setup and resources. |
| `README.md` | Describe TypeScript/ONNX runtime and Python only as offline training tooling. |
| `assets/captcha/GeekedTest-LICENSE.txt` | Retain the vendored project's MIT notice in packaged assets. |

---

### Task 1: Retryable singleton ONNX warm-up

**Files:**
- Modify: `src/main/services/captcha/onnx-session.ts:232-280`
- Test: `test/captcha-photo-classifier.test.ts`

**Interfaces:**
- Consumes: `ort.InferenceSession.create(NINE_MATCH_MODEL)` and the existing `NineMatchInferenceQueue`.
- Produces: `new NineMatchClassifier(createSession?)`, `NineMatchClassifier.warmup(): Promise<void>`, and `warmNineMatchClassifier(): Promise<void>`.

- [ ] **Step 1: Write failing tests for shared initialization and failure recovery**

Add `InferenceSession` as a type-only import and append these helpers/tests to `test/captcha-photo-classifier.test.ts`:

```ts
import type { InferenceSession } from 'onnxruntime-node';
import {
  NineMatchClassifier,
  NineMatchInferenceQueue,
  normalizeNineMatchPairForImageNet,
  normalizePhotoRgbForImageNet,
} from '../src/main/services/captcha/onnx-session.js';

function fakeNineSession(): InferenceSession {
  return {
    async run() {
      return { logit: { data: new Float32Array([0]) } };
    },
  } as unknown as InferenceSession;
}

test('NineMatchClassifier shares initialization between warm-up and first inference', async () => {
  let createCalls = 0;
  let release: ((session: InferenceSession) => void) | undefined;
  const pendingSession = new Promise<InferenceSession>((resolve) => {
    release = resolve;
  });
  const classifier = new NineMatchClassifier(async () => {
    createCalls += 1;
    return pendingSession;
  });
  const image = { data: new Uint8Array(4), width: 1, height: 1 };

  const warming = classifier.warmup();
  const scoring = classifier.scoreCells(image, [image]);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.equal(createCalls, 1);
  release?.(fakeNineSession());
  await warming;
  assert.deepEqual(await scoring, [0.5]);
});

test('NineMatchClassifier retries initialization after warm-up failure', async () => {
  let createCalls = 0;
  const classifier = new NineMatchClassifier(async () => {
    createCalls += 1;
    if (createCalls === 1) throw new Error('warm-up failed');
    return fakeNineSession();
  });

  await assert.rejects(classifier.warmup(), /warm-up failed/);
  await classifier.warmup();

  assert.equal(createCalls, 2);
});
```

Merge the new named imports into the file's existing import from `onnx-session.js`; do not leave two imports from the same module.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx tsx --test test/captcha-photo-classifier.test.ts
```

Expected: FAIL because `NineMatchClassifier` has no public `warmup()` and its constructor does not accept a factory.

- [ ] **Step 3: Implement one shared retryable session promise**

Replace the session field and `ensure()` implementation in `NineMatchClassifier`, add `warmup()`, and add the singleton wrapper:

```ts
type NineMatchSessionFactory = () => Promise<ort.InferenceSession>;

export class NineMatchClassifier {
  private sessionPromise: Promise<ort.InferenceSession> | undefined;
  private readonly queue = new NineMatchInferenceQueue(resolveNineMatchInferenceConcurrency());

  constructor(
    private readonly createSession: NineMatchSessionFactory = () =>
      ort.InferenceSession.create(NINE_MATCH_MODEL),
  ) {}

  private ensure(): Promise<ort.InferenceSession> {
    if (!this.sessionPromise) {
      const pending = this.createSession().catch((error: unknown) => {
        if (this.sessionPromise === pending) this.sessionPromise = undefined;
        throw error;
      });
      this.sessionPromise = pending;
    }
    return this.sessionPromise;
  }

  async warmup(): Promise<void> {
    await this.ensure();
  }
}

let _nineMatchClassifier: NineMatchClassifier | undefined;
export function getNineMatchClassifier(): NineMatchClassifier {
  return _nineMatchClassifier ??= new NineMatchClassifier();
}
export async function warmNineMatchClassifier(): Promise<void> {
  await getNineMatchClassifier().warmup();
}
```

Leave the existing `score()`, `scoreCells()`, `IconClassifier`, and
`PhotoClassifier` implementations byte-for-byte unchanged; only their
surrounding nine-match initialization code changes in this task.

- [ ] **Step 4: Run the focused test and typecheck**

Run:

```powershell
npx tsx --test test/captcha-photo-classifier.test.ts
npm run check
```

Expected: all photo-classifier tests PASS; typecheck exits 0.

- [ ] **Step 5: Commit only Task 1 files**

```powershell
git add -- src/main/services/captcha/onnx-session.ts test/captcha-photo-classifier.test.ts
git commit -m "perf(captcha): warm nine model once"
```

---

### Task 2: Bounded `nine` challenge selection and loaded solve

**Files:**
- Modify: `src/main/services/geetest-solver.ts:64-129`
- Test: `test/geetest-solver.test.ts`

**Interfaces:**
- Consumes: `GeetestNineClient.load`, `GeetestNineClient.fetchImage`, `GeetestNineClient.verify`, and `generateW`.
- Produces: `GEETEST_NINE_SEARCH_LIMIT`, `GEETEST_NINE_ANSWER_LIMIT`, `GEETEST_NINE_RETRY_DELAY_MS`, `GEETEST_NINE_DEADLINE_MS`, `NineChallengeSearchResult`, `findNineChallengeWithClient(...)`, and `solveLoadedNineGeetestWithClient(...)`.

- [ ] **Step 1: Replace obsolete policy tests with failing selector tests**

Keep the existing successful verification assertion as a loaded-challenge test. Replace tests that expect captured `icon` to skip before `/load` with these cases in `test/geetest-solver.test.ts`:

```ts
import {
  findNineChallengeWithClient,
  solveLoadedNineGeetestWithClient,
} from '../src/main/services/geetest-solver.js';

function challenge(captchaType: string, suffix: string) {
  return {
    lot_number: `lot-${suffix}`,
    pow_detail: { hashfunc: 'md5', version: '1', bits: 0, datetime: '2026-07-16' },
    pt: '0',
    captcha_type: captchaType,
    payload: `payload-${suffix}`,
    process_token: `process-${suffix}`,
    imgs: 'grid.jpg',
    ques: ['ques.png'],
    nine_nums: 3,
  };
}

test('findNineChallengeWithClient requests nine and accepts the tenth nine response', async () => {
  const requestedTypes: Array<string | null | undefined> = [];
  let loads = 0;
  const client = {
    async load(_captchaId: string, riskType?: string | null) {
      requestedTypes.push(riskType);
      loads += 1;
      return challenge(loads === 10 ? ' NINE ' : 'icon', String(loads));
    },
    async fetchImage() { return Buffer.alloc(0); },
    async verify() { return {}; },
  };

  const result = await findNineChallengeWithClient(client, 'captcha-1', {
    deadlineAt: 60_000,
    now: () => 0,
    wait: async () => undefined,
  });

  assert.equal(result.status, 'found');
  assert.equal(result.searchAttempts, 10);
  assert.deepEqual(requestedTypes, Array(10).fill('nine'));
});

test('findNineChallengeWithClient exhausts ten non-nine responses', async () => {
  let loads = 0;
  const client = {
    async load() {
      loads += 1;
      return challenge('icon', String(loads));
    },
    async fetchImage() { return Buffer.alloc(0); },
    async verify() { return {}; },
  };

  const result = await findNineChallengeWithClient(client, 'captcha-1', {
    deadlineAt: 60_000,
    now: () => 0,
    wait: async () => undefined,
  });

  assert.deepEqual(result, { status: 'exhausted', searchAttempts: 10 });
});

test('findNineChallengeWithClient counts load errors and honors the deadline', async () => {
  let now = 0;
  let loads = 0;
  const client = {
    async load() {
      loads += 1;
      throw new Error('network');
    },
    async fetchImage() { return Buffer.alloc(0); },
    async verify() { return {}; },
  };

  const result = await findNineChallengeWithClient(client, 'captcha-1', {
    deadlineAt: 60_000,
    now: () => now,
    wait: async () => { now += 30_000; },
  });

  assert.deepEqual(result, { status: 'deadline', searchAttempts: 2 });
  assert.equal(loads, 2);
});
```

Update the existing signer-path test to call `solveLoadedNineGeetestWithClient(client, 'captcha-1', challenge('nine', '1'), async () => 'signed-w')` and assert that `client.load` is never called.

- [ ] **Step 2: Run the focused tests and verify RED**

```powershell
npx tsx --test test/geetest-solver.test.ts
```

Expected: FAIL because the selector and loaded-challenge function do not exist.

- [ ] **Step 3: Add policy constants and the bounded selector**

Add these exports after `GeetestNineClient` in `src/main/services/geetest-solver.ts`:

```ts
export const GEETEST_NINE_SEARCH_LIMIT = 10;
export const GEETEST_NINE_ANSWER_LIMIT = 5;
export const GEETEST_NINE_RETRY_DELAY_MS = 180;
export const GEETEST_NINE_DEADLINE_MS = 60_000;

export type NineChallengeSearchResult =
  | { status: 'found'; data: GeetestChallengeData; searchAttempts: number }
  | { status: 'exhausted' | 'deadline'; searchAttempts: number };

export interface NineChallengeSearchOptions {
  deadlineAt: number;
  maxAttempts?: number;
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUsableNineChallenge(
  data: GeetestChallengeData & { captcha_type?: string },
): boolean {
  const questions = Array.isArray(data.ques) ? data.ques : [];
  return shouldAttemptAutomaticGeetestSolve(data.captcha_type)
    && hasText(data.lot_number)
    && hasText(data.payload)
    && hasText(data.process_token)
    && hasText(data.imgs)
    && hasText(questions[0]);
}

export async function findNineChallengeWithClient(
  client: GeetestNineClient,
  captchaId: string,
  options: NineChallengeSearchOptions,
): Promise<NineChallengeSearchResult> {
  const maxAttempts = options.maxAttempts ?? GEETEST_NINE_SEARCH_LIMIT;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((delayMs: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let searchAttempts = 0;

  while (searchAttempts < maxAttempts) {
    if (now() >= options.deadlineAt) {
      return { status: 'deadline', searchAttempts };
    }
    searchAttempts += 1;
    try {
      const data = await client.load(captchaId, 'nine');
      if (now() >= options.deadlineAt) {
        return { status: 'deadline', searchAttempts };
      }
      if (isUsableNineChallenge(data)) {
        return { status: 'found', data, searchAttempts };
      }
    } catch {
      // The failed request consumes this search attempt.
    }
    if (searchAttempts < maxAttempts) {
      if (now() >= options.deadlineAt) {
        return { status: 'deadline', searchAttempts };
      }
      await wait(GEETEST_NINE_RETRY_DELAY_MS);
    }
  }

  return { status: 'exhausted', searchAttempts };
}
```

- [ ] **Step 4: Split solving from challenge loading**

Replace `solveNineGeetestWithClient` with a function that accepts the selector's loaded data and performs no hidden `/load`:

```ts
export async function solveLoadedNineGeetestWithClient(
  client: GeetestNineClient,
  captchaId: string,
  data: GeetestChallengeData,
  generateGeetestW: GenerateGeetestW = (challengeData, id, type, fetchImage) =>
    generateW(challengeData, id, type, fetchImage, () => 0),
): Promise<GeetestSolution | null> {
  const w = await generateGeetestW(
    data,
    captchaId,
    'nine',
    (path) => client.fetchImage(path),
  );
  const result = await client.verify({
    captchaId,
    lotNumber: data.lot_number,
    payload: String(data.payload ?? ''),
    processToken: String(data.process_token ?? ''),
    w,
    riskType: 'nine',
  });
  const seccode = result.seccode;
  if (!seccode?.pass_token || !seccode.lot_number) return null;
  return {
    captcha_id: seccode.captcha_id ?? captchaId,
    lot_number: seccode.lot_number,
    pass_token: seccode.pass_token,
    gen_time: seccode.gen_time,
    captcha_output: seccode.captcha_output,
  };
}
```

To keep this task independently compilable, retain `shouldProbeGeetestChallenge`
temporarily and add this compatibility wrapper below the new loaded-solve
function. Task 3 removes both after migrating the runtime:

```ts
export async function solveNineGeetestWithClient(
  client: GeetestNineClient,
  captchaId: string,
  riskType?: string | null,
  generateGeetestW?: GenerateGeetestW,
): Promise<GeetestSolution | null> {
  if (!shouldProbeGeetestChallenge(riskType)) return null;
  const selection = await findNineChallengeWithClient(client, captchaId, {
    deadlineAt: Date.now() + GEETEST_NINE_DEADLINE_MS,
    maxAttempts: 1,
    wait: async () => undefined,
  });
  if (selection.status !== 'found') return null;
  return solveLoadedNineGeetestWithClient(
    client,
    captchaId,
    selection.data,
    generateGeetestW,
  );
}
```

- [ ] **Step 5: Run focused tests and typecheck**

```powershell
npx tsx --test test/geetest-solver.test.ts
npm run check
```

Expected: selector and loaded-solve tests PASS; typecheck exits 0 because the
temporary compatibility wrapper preserves the current runtime contract.

- [ ] **Step 6: Commit Task 2 files**

Run `npm run check` once more and commit only the solver and its tests:

```powershell
git add -- src/main/services/geetest-solver.ts test/geetest-solver.test.ts
git commit -m "refactor(captcha): separate nine selection from solve"
```

Expected: commit is created only after `npm run check` exits 0.

---

### Task 3: Independent search and answer retries in the runtime

**Files:**
- Modify: `src/main/services/geetest-solver.ts`
- Modify: `src/main/services/automation-runtime.ts:24-26,90,2332-2338,6860-6927`
- Test: `test/automation-runtime.test.ts`

**Interfaces:**
- Consumes: Task 1 `warmNineMatchClassifier()` and Task 2 constants, `findNineChallengeWithClient()`, `solveLoadedNineGeetestWithClient()`, `GeetestNineClient`, and `NineChallengeSearchResult`.
- Produces: runtime behavior with 10 searches per answer, 5 answer attempts, 180 ms delays, 60-second deadline, and unchanged manual fallback.

- [ ] **Step 1: Add a runtime harness test for independent counters**

Extend the test harness type with the private methods used by existing monkey-patching style:

```ts
type GeetestRuntimeHarness = {
  geetestCapturedData: Map<string, { captchaId: string; baseUrl: string; riskType?: string }>;
  createGeetestClient(page: Page, baseUrl: string): unknown;
  solveLoadedNineChallenge(client: unknown, captchaId: string, data: unknown): Promise<unknown>;
  tryAutoSolveGeetestCaptcha(runId: string, page: Page, profileName: string): Promise<boolean>;
  resolveGeetestWithPageBridge(page: Page, solution: unknown): Promise<{ resolved: boolean }>;
  waitForRunDelay(runId: string, page: Page, delayMs: number): Promise<void>;
  ensureRunActive(runId: string): void;
  nowMs(): number;
  log(): void;
};
```

Cast the returned runtime to include `GeetestRuntimeHarness`, then add:

```ts
test('Geetest runtime gives each rejected nine answer a fresh search budget', async () => {
  const { runtime } = createRuntime();
  const geetest = runtime as unknown as GeetestRuntimeHarness;
  let loads = 0;
  let answers = 0;
  const fakeClient = {
    async load() {
      loads += 1;
      const isNine = loads % 10 === 0;
      return {
        lot_number: `lot-${loads}`,
        pow_detail: { hashfunc: 'md5', version: '1', bits: 0, datetime: '2026-07-16' },
        pt: '0',
        captcha_type: isNine ? 'nine' : 'icon',
        payload: `payload-${loads}`,
        process_token: `process-${loads}`,
        imgs: 'grid.jpg',
        ques: ['ques.png'],
        nine_nums: 3,
      };
    },
  };
  geetest.geetestCapturedData.set('run-1', {
    captchaId: '0123456789abcdef0123456789abcdef',
    baseUrl: 'https://gcaptcha4.geevisit.com',
    riskType: 'icon',
  });
  geetest.createGeetestClient = () => fakeClient;
  geetest.solveLoadedNineChallenge = async () => {
    answers += 1;
    return null;
  };
  geetest.waitForRunDelay = async () => undefined;
  geetest.ensureRunActive = () => undefined;
  geetest.nowMs = () => 0;
  geetest.log = () => undefined;
  const page = {} as Page;

  const solved = await geetest.tryAutoSolveGeetestCaptcha('run-1', page, 'Teste');

  assert.equal(solved, false);
  assert.equal(loads, 50);
  assert.equal(answers, 5);
});
```

Add this success test to prove that captured `icon` enters selection:

```ts
test('Geetest runtime searches for nine when the captured risk type is icon', async () => {
  const { runtime } = createRuntime();
  const geetest = runtime as unknown as GeetestRuntimeHarness;
  let loads = 0;
  let answers = 0;
  geetest.geetestCapturedData.set('run-1', {
    captchaId: '0123456789abcdef0123456789abcdef',
    baseUrl: 'https://gcaptcha4.geevisit.com',
    riskType: 'icon',
  });
  geetest.createGeetestClient = () => ({
    async load() {
      loads += 1;
      return {
        lot_number: 'lot-1',
        pow_detail: { hashfunc: 'md5', version: '1', bits: 0, datetime: '2026-07-16' },
        pt: '0',
        captcha_type: 'nine',
        payload: 'payload-1',
        process_token: 'process-1',
        imgs: 'grid.jpg',
        ques: ['ques.png'],
        nine_nums: 3,
      };
    },
  });
  geetest.solveLoadedNineChallenge = async () => {
    answers += 1;
    return { lot_number: 'lot-1', pass_token: 'pass-1' };
  };
  geetest.resolveGeetestWithPageBridge = async () => ({ resolved: true });
  geetest.waitForRunDelay = async () => undefined;
  geetest.ensureRunActive = () => undefined;
  geetest.nowMs = () => 0;
  geetest.log = () => undefined;

  const solved = await geetest.tryAutoSolveGeetestCaptcha('run-1', {} as Page, 'Teste');

  assert.equal(solved, true);
  assert.equal(loads, 1);
  assert.equal(answers, 1);
});
```

- [ ] **Step 2: Run the runtime test and verify RED**

```powershell
npx tsx --test test/automation-runtime.test.ts
```

Expected: FAIL because client creation, loaded solving, and clock access are not overridable methods and explicit `icon` still returns early.

- [ ] **Step 3: Add testable runtime boundaries and warm-up at run start**

Import Task 1 and Task 2 APIs, plus
`GeetestChallengeData` from `./captcha/signer.js`. Replace
`GEETEST_AUTO_SOLVE_ATTEMPTS` with imported policy constants. Add these private
wrappers near the GeeTest interception helpers:

```ts
private nowMs(): number {
  return Date.now();
}

private createGeetestClient(page: Page, baseUrl: string): GeetestNineClient {
  return new GeetestClient(page.context().request, baseUrl);
}

private solveLoadedNineChallenge(
  client: GeetestNineClient,
  captchaId: string,
  data: GeetestChallengeData,
): Promise<GeetestSolution | null> {
  return solveLoadedNineGeetestWithClient(client, captchaId, data);
}
```

Inside the existing `if (autoCaptchaSolverEnabled)` block, start handled background warm-up before installing the page bridge:

```ts
void warmNineMatchClassifier().catch((error: unknown) => {
  this.log(
    runId,
    'warning',
    `[${profile.name}] Nao foi possivel preaquecer o modelo nine: ${error instanceof Error ? error.message : String(error)}.`,
  );
});
```

After changing the runtime imports, delete the Task 2 compatibility
`solveNineGeetestWithClient` wrapper and `shouldProbeGeetestChallenge` from
`geetest-solver.ts`. No caller should remain.

- [ ] **Step 4: Replace `tryAutoSolveGeetestCaptcha` with nested bounded retries**

The replacement method must follow this complete control flow:

```ts
private async tryAutoSolveGeetestCaptcha(
  runId: string,
  page: Page,
  profileName: string,
): Promise<boolean> {
  const captured = this.geetestCapturedData.get(runId);
  const captchaId = captured?.captchaId || await this.extractGeetestCaptchaIdFromPage(page);
  if (!captchaId) return false;

  const client = this.createGeetestClient(
    page,
    captured?.baseUrl ?? 'https://gcaptcha4.geevisit.com',
  );
  const deadlineAt = this.nowMs() + GEETEST_NINE_DEADLINE_MS;
  let totalSearchAttempts = 0;

  for (let answerAttempt = 1; answerAttempt <= GEETEST_NINE_ANSWER_LIMIT; answerAttempt += 1) {
    this.ensureRunActive(runId);
    const selection = await findNineChallengeWithClient(client, captchaId, {
      deadlineAt,
      now: () => this.nowMs(),
      wait: (delayMs) => this.waitForRunDelay(runId, page, delayMs),
    });
    totalSearchAttempts += selection.searchAttempts;

    if (selection.status !== 'found') {
      const reason = selection.status === 'deadline'
        ? 'limite total de 60 segundos atingido'
        : `nenhum captcha nine em ${selection.searchAttempts} busca(s)`;
      this.log(runId, 'warning', `[${profileName}] ${reason}; aguardando solucao manual.`);
      return false;
    }

    let solution: GeetestSolution | null = null;
    try {
      solution = await this.solveLoadedNineChallenge(client, captchaId, selection.data);
    } catch {
      solution = null;
    }

    if (this.nowMs() >= deadlineAt) {
      this.log(
        runId,
        'warning',
        `[${profileName}] Limite total de 60 segundos atingido; aguardando solucao manual.`,
      );
      return false;
    }

    if (!solution?.lot_number || !solution.pass_token) {
      this.log(
        runId,
        'warning',
        `[${profileName}] Resposta nine rejeitada (${answerAttempt}/${GEETEST_NINE_ANSWER_LIMIT}).`,
      );
      if (answerAttempt < GEETEST_NINE_ANSWER_LIMIT && this.nowMs() < deadlineAt) {
        await this.waitForRunDelay(runId, page, GEETEST_NINE_RETRY_DELAY_MS);
        continue;
      }
      const reason = this.nowMs() >= deadlineAt
        ? 'limite total de 60 segundos atingido'
        : `${GEETEST_NINE_ANSWER_LIMIT} resposta(s) nine rejeitada(s)`;
      this.log(
        runId,
        'warning',
        `[${profileName}] ${reason} apos ${totalSearchAttempts} busca(s); aguardando solucao manual.`,
      );
      return false;
    }

    const bridgeResult = await this.resolveGeetestWithPageBridge(page, solution);
    if (bridgeResult.resolved) {
      this.log(
        runId,
        'success',
        `[${profileName}] Captcha nine resolvido na tentativa ${answerAttempt}/${GEETEST_NINE_ANSWER_LIMIT} apos ${totalSearchAttempts} busca(s).`,
      );
      return true;
    }
    if (await this.interactWithGeetestWidget(page, solution)) {
      this.log(
        runId,
        'success',
        `[${profileName}] Captcha nine resolvido na tentativa ${answerAttempt}/${GEETEST_NINE_ANSWER_LIMIT} apos ${totalSearchAttempts} busca(s).`,
      );
      return true;
    }

    this.log(
      runId,
      'warning',
      `[${profileName}] Nao consegui acionar o callback do Geetest; mantendo o captcha aberto para evitar travar o cadastro.`,
    );
    await this.injectGeetestSolution(page, solution);
    return false;
  }

  return false;
}
```

Remove the early `shouldProbeGeetestChallenge(captured.riskType)` return. The captured type no longer controls eligibility; the selector's returned `captcha_type` does.

- [ ] **Step 5: Add and pass the deadline runtime test**

Add this deadline test:

```ts
test('Geetest runtime stops searching at the 60 second deadline', async () => {
  const { runtime } = createRuntime();
  const geetest = runtime as unknown as GeetestRuntimeHarness;
  let now = 0;
  let loads = 0;
  geetest.geetestCapturedData.set('run-1', {
    captchaId: '0123456789abcdef0123456789abcdef',
    baseUrl: 'https://gcaptcha4.geevisit.com',
  });
  geetest.createGeetestClient = () => ({
    async load() {
      loads += 1;
      return {
        lot_number: `lot-${loads}`,
        pow_detail: { hashfunc: 'md5', version: '1', bits: 0, datetime: '2026-07-16' },
        pt: '0',
        captcha_type: 'icon',
      };
    },
  });
  geetest.waitForRunDelay = async () => { now += 30_000; };
  geetest.ensureRunActive = () => undefined;
  geetest.nowMs = () => now;
  geetest.log = () => undefined;

  const solved = await geetest.tryAutoSolveGeetestCaptcha('run-1', {} as Page, 'Teste');

  assert.equal(solved, false);
  assert.equal(loads, 2);
});
```

Run:

```powershell
npx tsx --test test/automation-runtime.test.ts test/geetest-solver.test.ts test/captcha-photo-classifier.test.ts
npm run check
```

Expected: all focused tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit Task 3 files**

```powershell
git add -- src/main/services/geetest-solver.ts src/main/services/automation-runtime.ts test/automation-runtime.test.ts
git commit -m "feat(captcha): retry until nine with bounded answers"
```

---

### Task 4: Remove the legacy Python runtime and packaging

**Files:**
- Modify: `src/main/services/geetest-solver.ts`
- Modify: `package.json`
- Modify: `README.md`
- Create: `test/geetest-legacy-cleanup.test.ts`
- Move: `GeekedTest-main/LICENSE` -> `assets/captcha/GeekedTest-LICENSE.txt`
- Delete: `GeekedTest-main/**` after moving the license
- Delete: `scripts/geetest_solver_bridge.py`
- Delete: `scripts/geetest_solver_worker.py`
- Delete: `scripts/setup-python.mjs`
- Delete: `scripts/captcha-autolabel-clip.py`
- Delete: `scripts/clip-burn.py`

**Interfaces:**
- Consumes: the active TypeScript exports retained by Tasks 2 and 3.
- Produces: an Electron runtime and package with no Python solver setup, subprocess, bridge, worker, or vendored solver tree.

- [ ] **Step 1: Write a failing package hygiene test**

Create `test/geetest-legacy-cleanup.test.ts`:

```ts
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  build: { extraResources?: unknown[] };
};

test('desktop package has no legacy Python GeeTest runtime', () => {
  assert.equal(packageJson.scripts['setup:python'], undefined);
  assert.doesNotMatch(packageJson.scripts.postinstall ?? '', /setup-python/i);
  assert.doesNotMatch(
    JSON.stringify(packageJson.build.extraResources ?? []),
    /GeekedTest-main|geetest_solver_bridge|geetest_solver_worker/i,
  );
  for (const relativePath of [
    'GeekedTest-main',
    'scripts/geetest_solver_bridge.py',
    'scripts/geetest_solver_worker.py',
    'scripts/setup-python.mjs',
    'scripts/captcha-autolabel-clip.py',
    'scripts/clip-burn.py',
  ]) {
    assert.equal(existsSync(join(root, relativePath)), false, relativePath);
  }
  assert.equal(existsSync(join(root, 'assets/captcha/GeekedTest-LICENSE.txt')), true);
  assert.match(packageJson.scripts['train:nine-match'] ?? '', /captcha-train-nine-match\.py/);
});
```

- [ ] **Step 2: Run the hygiene test and verify RED**

```powershell
npx tsx --test test/geetest-legacy-cleanup.test.ts
```

Expected: FAIL on `setup:python`, `postinstall`, `extraResources`, and existing legacy files.

- [ ] **Step 3: Remove the Python process service from TypeScript**

In `src/main/services/geetest-solver.ts`, delete everything used only by `GeetestSolverService`:

- imports from `node:child_process`, `node:crypto`, `node:fs`, `node:path`, and `node:url`;
- `PROJECT_ROOT`, `RESOURCE_ROOT`, bridge/worker paths, and worker timeout constants;
- payload, worker response, worker outcome, and pending request interfaces;
- Python discovery and resource-root helpers;
- the complete `GeetestSolverService` class.

After deletion, the file must begin with only active TypeScript imports:

```ts
import { generateW, type GeetestChallengeData } from './captcha/signer.js';
import type { GeetestVerifyResult } from './captcha/geetest-client.js';
```

Run:

```powershell
rg -n "child_process|spawn|execSync|GeetestSolverService|geetest_solver_|python" src/main/services/geetest-solver.ts
```

Expected: no matches.

- [ ] **Step 4: Remove setup and packaged resources from `package.json`**

Change scripts to:

```json
"postinstall": "patch-package && npm run napi:build -w @spider-bot/license-core"
```

Delete the `setup:python` script. In `build.extraResources`, retain only the `dist-renderer` and `assets/icon.png` entries; delete the scripts filter and `GeekedTest-main` entries. Do not change `train:nine-match` or `train:nine-siamese`.

- [ ] **Step 5: Preserve the license and delete exact legacy paths**

First verify the targets:

```powershell
git ls-files GeekedTest-main scripts/geetest_solver_bridge.py scripts/geetest_solver_worker.py scripts/setup-python.mjs scripts/captcha-autolabel-clip.py scripts/clip-burn.py
```

Expected: the 28 tracked vendored files plus the five named scripts are listed.

Then move the license and remove the remaining tracked legacy files:

```powershell
git mv -- GeekedTest-main/LICENSE assets/captcha/GeekedTest-LICENSE.txt
git rm -r -- GeekedTest-main
git rm -- scripts/geetest_solver_bridge.py scripts/geetest_solver_worker.py scripts/setup-python.mjs scripts/captcha-autolabel-clip.py scripts/clip-burn.py
```

Do not delete `scripts/captcha-train-nine-match.py`, `scripts/captcha-train-photo.py`, or `scripts/captcha-oracle-ques.py`.

- [ ] **Step 6: Update runtime documentation**

Replace the README stack bullet with:

```markdown
- TypeScript GeeTest `nine` solver with singleton ONNX inference
```

Replace the development comment and prerequisite with:

```markdown
npm install        # patch-package + napi build (needs Rust/cargo)
```

```markdown
- Node 22+ and Rust toolchain (for `license-core`)
- Python 3 with training dependencies (optional, only for offline captcha model training)
```

- [ ] **Step 7: Run cleanup, training, and focused verification**

```powershell
npx tsx --test test/geetest-legacy-cleanup.test.ts test/geetest-solver.test.ts
npm run train:nine-match -- --self-test
npm run check
```

Expected: tests PASS, trainer prints successful self-test output and exits 0, typecheck exits 0.

Run the live-reference scan:

```powershell
rg -n "GeetestSolverService|geetest_solver_bridge|geetest_solver_worker|setup-python|GeekedTest-main" src scripts test package.json README.md
```

Expected: only the string assertions inside `test/geetest-legacy-cleanup.test.ts`; no runtime, setup, packaging, or README references.

- [ ] **Step 8: Commit only cleanup files**

Review staged files carefully because model assets and datasets are dirty:

```powershell
git status --short
git add -- src/main/services/geetest-solver.ts package.json README.md test/geetest-legacy-cleanup.test.ts assets/captcha/GeekedTest-LICENSE.txt
git diff --cached --stat
git commit -m "chore(captcha): remove legacy python solver"
```

Expected: `assets/captcha/nine_match.onnx`, `assets/captcha/nine_match.json`, `dataset/`, probe scripts, and HAR files are not staged.

---

## Final verification

- [ ] **Step 1: Install with the cleaned postinstall**

```powershell
npm install
```

Expected: exits 0 after `patch-package` and napi build, with no Python solver setup or pip installation.

- [ ] **Step 2: Run required gates**

```powershell
npm run check
npm test
```

Expected: both exit 0; the full test suite has no failures.

- [ ] **Step 3: Verify runtime and package hygiene**

```powershell
rg -n "child_process|GeetestSolverService|geetest_solver_bridge|geetest_solver_worker|setup-python|GeekedTest-main" src scripts package.json README.md
```

Expected: no matches.

```powershell
git status --short
git log -6 --oneline
```

Expected: four implementation commits appear above `532d9ac`; only pre-existing user-owned model, dataset, probe, plan/spec, and HAR changes remain unstaged/untracked.

- [ ] **Step 4: Report the result**

Report:

- the four commits added;
- `npm install`, `npm run check`, `npm test`, and trainer self-test status;
- confirmation that search attempts are 10, answer attempts are 5, deadline is 60 seconds, and fallback is manual;
- confirmation that the ONNX model warms once and inference remains queued;
- confirmation that no Python solver runtime or packaged worker remains;
- any residual risk from not producing a signed Windows installer during local verification.

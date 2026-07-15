# PIX Receiving Account Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move a verified withdrawal page to its receiving-account PIX tab and finish only after the PIX receiving surface is visibly ready.

**Architecture:** Preserve the separation between live SPA navigation, screen classification, and conditional waits. A small pure classifier combines `active=10` with two DOM-derived semantic signals; the runtime performs the router push and only then declares PIX entry ready.

**Tech Stack:** TypeScript ESM, Patchright `Page`/`Frame`, Vue router in the page main world, Node test runner, strict TypeScript.

## Global Constraints

- Do not use host, brand, colour, coordinates, or a hard-coded full URL.
- Reuse the live withdrawal route, preserving its identity and query entries while replacing `active` with `"10"`.
- Success requires all signals: router query `active=10`, visible receiving-account area, and visible PIX add action.
- `PIX_MS(12000)` is the ceiling: 12 seconds by default and 12–72 seconds with `SPIDERBOT_PIX_SLOWNESS` 1–6.
- Do not click or open the PIX add control in this slice.
- Failure must include the missing signals and observed route; do not continue later PIX work.
- Preserve independent sessions/windows and the existing concurrency limit.

---

### Task 1: Classify and wait for the receiving-account PIX surface

**Files:**

- Modify: `src/main/services/screen-detection.ts` after `WithdrawalManagementDestination`.
- Modify: `src/main/services/screen-waits.ts` after the withdrawal-password confirmation waiter.
- Modify: `test/screen-detection.test.ts` after withdrawal destination tests.
- Modify: `test/screen-waits.test.ts` after withdrawal destination waiter tests.

**Interfaces:**

- Produce `PixReceivingAccountSignals` with `routeActive10`, `hasReceivingAccountArea`, `hasPixAddAction`, and `ready`.
- Produce `decidePixReceivingAccountSignals(input)` to test the three-signal policy without a browser.
- Produce `readPixReceivingAccountSignals(page, route)` and `waitForPixReceivingAccountSurface(page, readRoute, timeoutMs)`.
- Consume `RouteInfo` through injected `readRoute` so the screen modules do not discover the Vue router themselves.

- [ ] **Step 1: Write failing classifier tests**

Append the following to `test/screen-detection.test.ts`:

```ts
test("PIX receiving signals: active=10 sem superficie nao fica pronto", () => {
  assert.deepEqual(
    decidePixReceivingAccountSignals({
      routeActive10: true,
      hasReceivingAccountArea: false,
      hasPixAddAction: false,
    }),
    {
      routeActive10: true,
      hasReceivingAccountArea: false,
      hasPixAddAction: false,
      ready: false,
    },
  );
});

test("PIX receiving signals: superficie sem active=10 nao fica pronta", () => {
  assert.equal(
    decidePixReceivingAccountSignals({
      routeActive10: false,
      hasReceivingAccountArea: true,
      hasPixAddAction: true,
    }).ready,
    false,
  );
});

test("PIX receiving signals: tres sinais confirmam a aba", () => {
  assert.equal(
    decidePixReceivingAccountSignals({
      routeActive10: true,
      hasReceivingAccountArea: true,
      hasPixAddAction: true,
    }).ready,
    true,
  );
});
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm test -- --test-name-pattern "PIX receiving signals"
```

Expected: FAIL because `decidePixReceivingAccountSignals` is not exported.

- [ ] **Step 3: Implement the minimal classifier and DOM reader**

In `screen-detection.ts`, add this pure contract:

```ts
export interface PixReceivingAccountSignals {
  routeActive10: boolean;
  hasReceivingAccountArea: boolean;
  hasPixAddAction: boolean;
  ready: boolean;
}

export function decidePixReceivingAccountSignals(
  input: Omit<PixReceivingAccountSignals, "ready">,
): PixReceivingAccountSignals {
  return { ...input, ready: input.routeActive10 && input.hasReceivingAccountArea && input.hasPixAddAction };
}
```

Implement `readPixReceivingAccountSignals(page, route)`. It must use only visible elements, normalize accents/case/whitespace, recognize `conta para recebimento` or `receiving account`, and find a short visible control containing both `pix` and `adicionar|add`. It passes `route?.query.active === "10"` to the classifier. A detached-page evaluation returns both DOM signals false and never throws.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
npm test -- --test-name-pattern "PIX receiving signals"
```

Expected: PASS for the three tests.

- [ ] **Step 5: Write the failing waiter test**

Append to `test/screen-waits.test.ts` a fake page whose three polls report, in order, no DOM signals, only receiving area, then both DOM signals. Use this route reader:

```ts
const readRoute = async () => ({
  name: "withdraw",
  path: "/home/withdraw",
  fullPath: "/home/withdraw?active=10",
  query: { active: "10" },
});

assert.equal(
  (await waitForPixReceivingAccountSurface(page, readRoute, 2000)).ready,
  true,
);
```

Name the test `waitForPixReceivingAccountSurface: ignora sinais parciais ate a aba PIX estar pronta`.

- [ ] **Step 6: Verify RED**

Run:

```powershell
npm test -- --test-name-pattern "waitForPixReceivingAccountSurface"
```

Expected: FAIL because `waitForPixReceivingAccountSurface` is not exported.

- [ ] **Step 7: Implement the conditional waiter**

Add to `screen-waits.ts`:

```ts
export async function waitForPixReceivingAccountSurface(
  page: Page,
  readRoute: () => Promise<RouteInfo | null>,
  timeoutMs: number,
): Promise<PixReceivingAccountSignals> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const signals = await readPixReceivingAccountSignals(page, await readRoute());
    if (signals.ready) return signals;
    await page.waitForTimeout(180).catch(() => null);
  }
  return readPixReceivingAccountSignals(page, await readRoute());
}
```

Import `RouteInfo` from `spa-navigation.ts` and the new screen-detection interface/reader. Do not introduce a fixed sleep or make route state alone a success signal.

- [ ] **Step 8: Verify focused tests and commit**

Run:

```powershell
npm test -- --test-name-pattern "PIX receiving signals|waitForPixReceivingAccountSurface"
git add src/main/services/screen-detection.ts src/main/services/screen-waits.ts test/screen-detection.test.ts test/screen-waits.test.ts
git commit -m "feat(pix): detect receiving account surface"
```

Expected: focused tests PASS; commit contains only the detector, waiter, and their tests.

### Task 2: Navigate the verified withdrawal route to the receiving-account tab

**Files:**

- Modify: `src/main/services/spa-navigation.ts` after `getCurrentRoute`.
- Modify: `src/main/services/automation-runtime.ts` in `runPixWithdrawalEntryForProfile` after `withdrawal_ready`.
- Create: `test/spa-navigation.test.ts`.

**Interfaces:**

- Consume `RouteInfo` from `getCurrentRoute(spa)` after the withdrawal destination is confirmed.
- Produce `buildPixReceivingAccountTarget(route: RouteInfo): RouteTarget | null`.
- Consume `waitForPixReceivingAccountSurface(session.page, () => getCurrentRoute(spa), PIX_MS(12000))`.
- Produce success status `pix_receiving_ready` and diagnostic values `active10`, `receivingArea`, and `pixAddAction`.

- [ ] **Step 1: Write failing route-target tests**

Create `test/spa-navigation.test.ts`:

```ts
test("buildPixReceivingAccountTarget preserva a rota de saque e troca somente active", () => {
  assert.deepEqual(
    buildPixReceivingAccountTarget({
      name: "withdraw", path: "/home/withdraw", fullPath: "/home/withdraw?active=20&campaign=x",
      query: { active: "20", campaign: "x" },
    }),
    { name: "withdraw", path: "/home/withdraw", query: { active: "10", campaign: "x" } },
  );
});

test("buildPixReceivingAccountTarget recusa rota sem nome e sem path", () => {
  assert.equal(
    buildPixReceivingAccountTarget({ name: null, path: null, fullPath: null, query: {} }),
    null,
  );
});
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm test -- --test-name-pattern "buildPixReceivingAccountTarget"
```

Expected: FAIL because the target builder is not exported.

- [ ] **Step 3: Implement the target builder**

Add to `spa-navigation.ts`:

```ts
export function buildPixReceivingAccountTarget(route: RouteInfo): RouteTarget | null {
  if (!route.name && !route.path) return null;
  return {
    ...(route.name ? { name: route.name } : {}),
    ...(route.path ? { path: route.path } : {}),
    query: { ...route.query, active: "10" },
  };
}
```

It derives the target solely from the active withdrawal page. It must not call `resolvePlatformDescriptor` or build a full URL.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
npm test -- --test-name-pattern "buildPixReceivingAccountTarget"
```

Expected: both target-builder tests PASS.

- [ ] **Step 5: Wire the runtime after withdrawal confirmation**

Keep password setup/confirmation unchanged. After `resultStatus` is `withdrawal_ready`, obtain the live route, build and push the target, then wait conditionally:

```ts
const withdrawalRoute = await getCurrentRoute(spa);
const receivingTarget = withdrawalRoute && buildPixReceivingAccountTarget(withdrawalRoute);
if (!receivingTarget || !(await routerPush(spa, receivingTarget))) {
  throw new Error(`rota de recebimento PIX indisponivel (${await describeSpaState(spa)})`);
}
const receiving = await waitForPixReceivingAccountSurface(
  session.page, () => getCurrentRoute(spa), PIX_MS(12000),
);
if (!receiving.ready) {
  throw new Error(
    `conta para recebimento PIX nao confirmada (active10=${receiving.routeActive10}; receivingArea=${receiving.hasReceivingAccountArea}; pixAddAction=${receiving.hasPixAddAction}; ${await describeSpaState(spa)})`,
  );
}
```

Set the success status/metric/log to `pix_receiving_ready`. Do not invoke `programmaticPixUiAction`, `waitForAddPixModal`, or a PIX add control.

- [ ] **Step 6: Verify, commit, and manually checkpoint**

Run:

```powershell
npm test
npm run check
git diff --check
git add src/main/services/spa-navigation.ts src/main/services/automation-runtime.ts test/spa-navigation.test.ts
git commit -m "feat(pix): navigate to receiving account tab"
```

Expected: all tests/typecheck/diff check pass and the commit excludes `package-lock.json`.

Then ask the user to run `npm run dev` with a disposable account. Expected result: the flow stops at "Conta para recebimento" with a PIX add action visible and logs `pix_receiving_ready`; it must not open the add modal. On failure, request only the run log with the three signal values.

## Self-review

- Spec coverage: Task 1 provides the three-signal detector and conditional timeout; Task 2 derives the live route, safely navigates, logs diagnostics, and leaves the add control untouched.
- Placeholder scan: no TODO/TBD or deferred implementation steps are present.
- Type consistency: Task 1 exports `PixReceivingAccountSignals` and `waitForPixReceivingAccountSurface`; Task 2 consumes them unchanged.


# PIX Add Password Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the withdrawal-password prompt from the ready PIX receiving area and stop before PIN entry.

**Architecture:** Add a focused main-world action module that finds exactly one semantic PIX add action and invokes it once. Reuse the existing structural password-prompt detector through a dedicated conditional waiter; the PIX runtime calls these components after `pix_receiving_ready`.

**Tech Stack:** TypeScript ESM, Patchright, Vue runtime listeners, Node test runner, strict TypeScript.

## Global Constraints

- Do not use host, brand, colour, coordinates, hard-coded URL, Pinia-direct navigation, or the legacy `programmaticPixUiAction`.
- Action eligibility requires visible PIX plus `adicionar|add|vincular|cadastrar`.
- Deduplicate nested candidates by listener and require one highest-scoring action.
- The action may run once only; an already-open password prompt produces no click.
- Prompt confirmation uses the existing one-PIN-grid-in-dialog structural signal; text is fallback only.
- Poll with `PIX_MS(12000)`; do not use arbitrary sleeps.
- Do not enter PIN, open the PIX form, choose key type, or submit data.
- Failures log only action/prompt diagnostics, never the password.

---

### Task 1: Create the focused PIX-add action

**Files:**

- Create: `src/main/services/pix-add-action.ts`.
- Create: `test/pix-add-action.test.ts`.

**Interfaces:**

- Produce `programmaticPixAddAction(spa: SpaHandle): Promise<PixAddActionResult>`.
- Produce `PixAddActionResult` with `ok`, optional `reason` (`pix-add-action-absent`, `pix-add-action-ambiguous`, `pix-add-listener-failed`), and non-secret diagnostic text.
- Consume only the active SPA document in Patchright main world.

- [ ] **Step 1: Write failing action tests**

Create `test/pix-add-action.test.ts` with a helper that temporarily provides fake visible DOM elements to the callback passed into `page.evaluate`. Add:

```ts
test("PIX add invokes the unique live listener once", async () => {
  let calls = 0;
  const listener = Object.assign(() => undefined, { value: () => { calls += 1; } });
  const element = {
    _vei: { onClick: listener },
    getBoundingClientRect: () => ({ width: 320, height: 44 }),
    textContent: "PIX Adicionar",
  };
  const result = await programmaticPixAddAction(fakePage([element]));
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
});

test("PIX add refuses ambiguous live listeners without clicking", async () => {
  let calls = 0;
  const makeElement = () => ({
    _vei: { onClick: Object.assign(() => undefined, { value: () => { calls += 1; } }) },
    getBoundingClientRect: () => ({ width: 320, height: 44 }),
    textContent: "PIX Adicionar",
  });
  const result = await programmaticPixAddAction(fakePage([makeElement(), makeElement()]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "pix-add-action-ambiguous");
  assert.equal(calls, 0);
});
```

`fakePage` must run the evaluate callback with `document.querySelectorAll` returning the provided elements and must not implement a real browser click.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm test -- --test-name-pattern "PIX add"
```

Expected: FAIL because `pix-add-action.ts` does not yet exist.

- [ ] **Step 3: Implement the semantic action**

Create `src/main/services/pix-add-action.ts`. Use `MAIN_WORLD = false`. Inside the one `evaluate` callback:

1. normalize labels with NFD/accent/case/whitespace handling;
2. scan `body, body *` for visible elements with short labels matching PIX plus an add verb;
3. walk at most seven parents to read Vue expando event maps and extract `onClick.value` or `onClick`;
4. score local PIX+verb labels above broad parent copy, deduplicate candidates by listener, and reject zero or multiple highest-score listeners;
5. invoke the unique listener once with a synthetic `MouseEvent("click")`;
6. if no listener exists but exactly one semantic control exists, dispatch one synthetic click to that element;
7. catch and return the declared reason/diagnostic.

The module must not import or call `programmaticPixUiAction`.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```powershell
npm test -- --test-name-pattern "PIX add"
git add src/main/services/pix-add-action.ts test/pix-add-action.test.ts
git commit -m "feat(pix): invoke semantic pix add action"
```

Expected: both action tests PASS and the commit contains only the focused module and test.

### Task 2: Wait for the existing withdrawal-password prompt

**Files:**

- Modify: `src/main/services/screen-waits.ts` after `waitForPixReceivingAccountSurface`.
- Modify: `test/screen-waits.test.ts` after PIX receiving waiter tests.

**Interfaces:**

- Consume `hasExistingWithdrawalPasswordModal(page)` from `screen-detection.ts`.
- Produce `waitForExistingWithdrawalPasswordModal(page, timeoutMs): Promise<boolean>`.

- [ ] **Step 1: Write the failing waiter test**

Append:

```ts
test("waitForExistingWithdrawalPasswordModal: espera o prompt apos a transicao", async () => {
  let checks = 0;
  const page = fakePage(async () => {
    checks += 1;
    return checks >= 3;
  });
  assert.equal(await waitForExistingWithdrawalPasswordModal(page, 2000), true);
  assert.ok(checks >= 3);
});
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm test -- --test-name-pattern "waitForExistingWithdrawalPasswordModal"
```

Expected: FAIL because the waiter is not exported.

- [ ] **Step 3: Implement the waiter**

In `screen-waits.ts`, import `hasExistingWithdrawalPasswordModal` and add:

```ts
export async function waitForExistingWithdrawalPasswordModal(
  page: Page,
  timeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await hasExistingWithdrawalPasswordModal(page)) return true;
    await page.waitForTimeout(180).catch(() => null);
  }
  return hasExistingWithdrawalPasswordModal(page);
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run:

```powershell
npm test -- --test-name-pattern "waitForExistingWithdrawalPasswordModal"
git add src/main/services/screen-waits.ts test/screen-waits.test.ts
git commit -m "feat(pix): wait for withdrawal password prompt"
```

Expected: the waiter test passes and no timeout is treated as success.

### Task 3: Wire the PIX runtime and public result

**Files:**

- Modify: `src/main/services/automation-runtime.ts: runPixWithdrawalEntryForProfile`.
- Modify: `src/shared/contracts.ts: PixKeyRegistrationControlResult`.
- Modify: `src/renderer/components/ControlPanel.tsx: summarizePixRegistrationResults`.

**Interfaces:**

- Consume `programmaticPixAddAction`, `hasExistingWithdrawalPasswordModal`, and `waitForExistingWithdrawalPasswordModal`.
- Add public status `withdrawal_password_required` and step `pix-add-password`.
- Preserve `pix_receiving_ready` only as the prior internal checkpoint; final successful result becomes `withdrawal_password_required`.

- [ ] **Step 1: Wire the one-click action after receiving readiness**

After the `pix_receiving_ready` assignment in `runPixWithdrawalEntryForProfile`, set `step = "pix-add-password"`. Check `hasExistingWithdrawalPasswordModal(session.page)`. Only when false, call:

```ts
const opened = await programmaticPixAddAction(spa);
if (!opened.ok) {
  throw new Error(
    `acao PIX adicionar indisponivel (${opened.reason ?? "desconhecido"}; ${opened.diag ?? "sem diagnostico"})`,
  );
}
```

Then wait:

```ts
if (!(await waitForExistingWithdrawalPasswordModal(session.page, PIX_MS(12000)))) {
  throw new Error(`prompt de senha de saque nao confirmado (${await describeSpaState(spa)})`);
}
resultStatus = "withdrawal_password_required";
```

No method that fills a PIN or opens/submits a PIX form may appear in this block.

- [ ] **Step 2: Extend result contracts and UI summary**

In `src/shared/contracts.ts`, add `withdrawal_password_required` to the PIX result status union and `pix-add-password` to its step union. In `ControlPanel.tsx`, count that status and render `senha de saque solicitada`; leave failure counts unchanged.

- [ ] **Step 3: Run full verification and commit**

Run:

```powershell
npm test
npm run check
git diff --check
git add src/main/services/automation-runtime.ts src/shared/contracts.ts src/renderer/components/ControlPanel.tsx
git commit -m "feat(pix): open withdrawal password prompt"
```

Expected: all tests/typecheck/diff check pass; do not stage `package-lock.json`.

- [ ] **Step 4: Manual checkpoint**

Have the user run `npm run dev` against a disposable account. Expected: after “PIX / Adicionar”, the visible modal asks for the withdrawal password and no PIN cell is filled. The log/result must be `withdrawal_password_required`. On failure collect the run log only; no retry click is added.

## Self-review

- Spec coverage: Task 1 isolates a single semantic action; Task 2 confirms the structural password prompt with conditional waiting; Task 3 makes the path idempotent, exposes the result, and leaves PIN/form work untouched.
- Placeholder scan: no TODO/TBD, vague validation, or deferred implementation step remains.
- Type consistency: `PixAddActionResult`, `waitForExistingWithdrawalPasswordModal`, `withdrawal_password_required`, and `pix-add-password` use the same names in all tasks.


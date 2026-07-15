# PIX Withdrawal Password Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the existing six-digit withdrawal password in the PIX password prompt and stop before “Próximo”.

**Architecture:** Generalize the field activation and virtual-keyboard engine in `withdrawal-password-setup.ts` with an expected visible-grid count. The existing two-grid setup retains its contract; a new one-grid entry function reuses the same main-world, effect-confirmed interaction. The runtime reads a persisted password only and reports a distinct non-confirmed result.

**Tech Stack:** TypeScript ESM, Patchright, Vue virtual keyboard, Node test runner, strict TypeScript.

## Global Constraints

- Never call `ensureProfileWithdrawalPassword` in the existing-password entry path.
- Require a persisted six-digit password before any DOM interaction.
- Require exactly one visible PIN grid, six cells, and zero filled cells before entry.
- Validate every digit by a single visual advance; no direct keyboard typing.
- Do not click “Próximo”, open a PIX form, or submit data.
- Do not log password material or digits.
- Preserve the existing two-grid setup behavior and its tests.

---

### Task 1: Generalize the new virtual PIN engine for one or two fields

**Files:**

- Modify: `src/main/services/withdrawal-password-setup.ts`.
- Modify: `test/withdrawal-password-setup.test.ts`.

**Interfaces:**

- Extend internal `activateFirstWithdrawalPasswordField` and `fillFocusedField` with `expectedFieldCount: number`.
- Produce `fillExistingWithdrawalPassword(spa, password): Promise<WithdrawalPasswordEntryResult>`.
- Produce `WithdrawalPasswordEntryResult` with `ok`, `passwordEntered`, and the existing safe reason/diagnostic vocabulary.
- Keep `fillWithdrawalPasswordSetup(spa, password, onStage)` unchanged publicly and pass `2` internally.

- [ ] **Step 1: Write failing one-grid tests**

Extend the fake surface helper in `test/withdrawal-password-setup.test.ts` to accept `fieldCount: 1 | 2`. Add:

```ts
test("preenche o PIN existente em um unico grid e confirma seis avancos", async () => {
  await withPasswordSurface({ fieldCount: 1 }, async (page, touchCount) => {
    const result = await fillExistingWithdrawalPassword(page, "102345");
    assert.deepEqual(result, { ok: true, passwordEntered: true });
    assert.equal(touchCount(), 6);
  });
});

test("recusa PIN existente quando o grid unico ja esta parcial", async () => {
  await withPasswordSurface({ fieldCount: 1, partiallyFilled: true }, async (page, touchCount) => {
    const result = await fillExistingWithdrawalPassword(page, "102345");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "field-partially-filled");
    assert.equal(touchCount(), 0);
  });
});
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm test -- --test-name-pattern "PIN existente"
```

Expected: FAIL because `fillExistingWithdrawalPassword` is not exported.

- [ ] **Step 3: Implement the minimal generalization**

Change the two internal function signatures to receive `expectedFieldCount`. Replace their hard-coded `fields.length !== 2` readiness/validation checks with `fields.length !== expectedFieldCount`.

Add:

```ts
export interface WithdrawalPasswordEntryResult {
  ok: boolean;
  passwordEntered: boolean;
  reason?: WithdrawalPasswordSetupResult["reason"];
  diag?: string;
}

export async function fillExistingWithdrawalPassword(
  spa: SpaHandle,
  password: string,
): Promise<WithdrawalPasswordEntryResult> {
  if (!/^\d{6}$/.test(password)) {
    return { ok: false, passwordEntered: false, reason: "surface-invalid", diag: "password-format" };
  }
  const activation = await activateFirstWithdrawalPasswordField(spa, 1);
  if (!activation.ok) {
    return { ok: false, passwordEntered: false, reason: activation.reason, diag: activation.diag };
  }
  const filled = await fillFocusedField(spa, 0, password, 1);
  return filled.ok
    ? { ok: true, passwordEntered: true }
    : { ok: false, passwordEntered: false, reason: filled.reason, diag: filled.diag };
}
```

Update the existing setup calls to pass `2`. Do not change the one-page transaction, keyboard-root preference, touch events, or dot-count rule.

- [ ] **Step 4: Verify GREEN and regression**

Run:

```powershell
npm test -- --test-name-pattern "PIN existente|preenche os dois campos|teclado oculto|confirma por efeito"
npm run check
git add src/main/services/withdrawal-password-setup.ts test/withdrawal-password-setup.test.ts
git commit -m "feat(pix): fill existing withdrawal password"
```

Expected: new one-grid tests and existing two-grid regression tests pass; typecheck passes.

### Task 2: Read only the persisted password and wire the PIX runtime

**Files:**

- Modify: `src/main/services/database.ts` after the public profile-account getter.
- Modify: `src/main/services/automation-runtime.ts: runPixWithdrawalEntryForProfile`.
- Modify: `src/shared/contracts.ts: PixKeyRegistrationControlResult`.
- Modify: `src/renderer/components/ControlPanel.tsx: summarizePixRegistrationResults`.
- Modify: `test/database.test.ts` or the existing database test file containing `ensureProfileWithdrawalPassword`.

**Interfaces:**

- Produce `getPersistedProfileWithdrawalPassword(profileId): string | undefined`.
- Consume `fillExistingWithdrawalPassword(spa, persistedPassword)`.
- Add result status `withdrawal_password_entered` and step `pix-enter-password`.

- [ ] **Step 1: Write the failing persistence test**

Near the existing ensure-password test, add:

```ts
test("getPersistedProfileWithdrawalPassword nao gera senha quando ela esta ausente", () => {
  const database = createTestDatabase();
  const profile = database.createProfile(testProfileDraft());
  assert.equal(database.getPersistedProfileWithdrawalPassword(profile.id), undefined);
});
```

Use the repository’s existing in-memory database helper names instead of introducing a second fixture.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm test -- --test-name-pattern "getPersistedProfileWithdrawalPassword"
```

Expected: FAIL because the read-only method does not exist.

- [ ] **Step 3: Implement the read-only database method**

Add:

```ts
getPersistedProfileWithdrawalPassword(profileId: string): string | undefined {
  const password = this.ensureProfileAccount(profileId).withdrawalPassword;
  return password && /^\d{6}$/.test(password) ? password : undefined;
}
```

It may create the account record if absent, as existing account getters do, but must not generate or save a password.

- [ ] **Step 4: Wire runtime after prompt confirmation**

After `withdrawal_password_required`, set `step = "pix-enter-password"`, read the password with the new method, and fail before `fillExistingWithdrawalPassword` when undefined:

```ts
const withdrawalPassword = this.database.getPersistedProfileWithdrawalPassword(profile.id);
if (!withdrawalPassword) {
  throw new Error("senha de saque reservada ausente");
}
const entered = await fillExistingWithdrawalPassword(spa, withdrawalPassword);
if (!entered.ok || !entered.passwordEntered) {
  throw new Error(
    `senha de saque nao confirmou preenchimento (${entered.reason ?? "desconhecido"}${entered.diag ? `; ${entered.diag}` : ""})`,
  );
}
resultStatus = "withdrawal_password_entered";
```

Do not call a confirmation action in this block.

- [ ] **Step 5: Extend public result/UI summary**

Add `withdrawal_password_entered` to the shared result status union and `pix-enter-password` to its step union. Count it in `ControlPanel.tsx` as `senha de saque preenchida`, distinct from `withdrawal_password_required`.

- [ ] **Step 6: Full verification, commit, and manual checkpoint**

Run:

```powershell
npm test
npm run check
git diff --check
git add src/main/services/database.ts src/main/services/automation-runtime.ts src/shared/contracts.ts src/renderer/components/ControlPanel.tsx test/database.test.ts
git commit -m "feat(pix): enter persisted withdrawal password"
```

Expected: all tests/typecheck/diff check pass and `package-lock.json` is not staged.

Then have the user run `npm run dev` on a disposable account. Expected: six masked cells are filled, “Próximo” remains unpressed, and the log says `withdrawal_password_entered`. On failure collect the safe run diagnostic only; do not retry or generate another password.

## Self-review

- Spec coverage: Task 1 shares the effect-confirmed virtual keyboard with both one- and two-grid screens; Task 2 prevents generation at entry time, publishes a distinct result, and stops before confirmation.
- Placeholder scan: no TODO/TBD or unspecified error behavior remains.
- Type consistency: the names `fillExistingWithdrawalPassword`, `WithdrawalPasswordEntryResult`, `getPersistedProfileWithdrawalPassword`, `withdrawal_password_entered`, and `pix-enter-password` are consistent throughout.


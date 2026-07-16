# PIX PHONE Key Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send the filled PIX PHONE form once, confirm its registration on the platform, and manage the key inventory through visible temporary and pending states.

**Architecture:** Keep inventory transitions in `PredatorDatabase`, with `reserved` scoped to an active run and `pending_confirmation` durable before the final click. Put mask matching and platform-account decisions in a small pure service; put DOM/Pinia inspection and the scoped final click in a dedicated browser service. The runtime composes them per profile and never lets a conflict stop other `Promise.allSettled` results.

**Tech Stack:** TypeScript ESM, node:sqlite `DatabaseSync`, Patchright, React 19, Node test runner.

## Global Constraints

- Do not hard-code platform host, viewport, coordinates, or a full phone value in logs.
- Keep `SCHEMA_VERSION = 1`; add optional columns through idempotent `ALTER TABLE` helpers so opening an existing workspace never invokes `resetWorkspaceData()`.
- A phone value may be read only in the renderer/form or matching routine; diagnostics and metrics contain only state/reason/counts.
- A final click is dispatched at most once. `pending_confirmation` is persisted before that attempt.
- Importing a phone number already present in inventory never reactivates a `used`, `reserved`, or `pending_confirmation` record; only a genuinely new number is added to stock.
- A terminal platform state is explicit: `pix_already_registered` is a clean/manual-account outcome, `pix_key_registered` is a confirmed automated outcome, `pix_key_pending_confirmation` requires later reconciliation, and `pix_key_conflict` stops only that profile for review.
- UI labels are Portuguese: **Disponível**, **Em cadastro**, **Aguardando confirmação**, **Cadastrada**.
- Run `npm test` and `npm run check` before the manual multi-window validation.

---

### Task 1: Persist lifecycle states without destructive migration

**Files:**
- Modify: `src/shared/contracts.ts:81-82,203-217`
- Modify: `src/main/services/database.ts:36,218-230,901-910,1037-1049,2104-2277,2983-2995`
- Modify: `test/database.test.ts`

**Interfaces:**
- Produces `PixPhoneKeyStatus = "available" | "reserved" | "pending_confirmation" | "used"`.
- Produces `reservePixPhoneKey(profileId, runId)`, `releasePixPhoneKeyReservation(keyId, runId)`, `markPixPhoneKeyPendingConfirmation(keyId, { profileId, runId })`, `markPixPhoneKeyUsed(keyId, opts)`, `findPendingPixPhoneKey(profileId)` and `recoverInactivePixPhoneKeyReservations(activeRunIds)`.
- `PixPhoneKeyRecord` gains `reservationRunId?`, `pendingProfileId?`, `pendingRunId?`, `pendingAt?` while keeping existing audit fields.

- [ ] **Step 1: Write the failing database tests**

```ts
test("PIX key releases a run-scoped reservation after an unsubmitted failure", () => {
  const key = db.reservePixPhoneKey(profile.id, "run-a");
  assert.equal(key?.status, "reserved");
  db.releasePixPhoneKeyReservation(key!.id, "run-a");
  assert.equal(db.listPixPhoneKeys().find((candidate) => candidate.id === key!.id)?.status, "available");
});

test("PIX key survives an ambiguous final click as pending and becomes used only after confirmation", () => {
  const key = db.reservePixPhoneKey(profile.id, "run-a")!;
  db.markPixPhoneKeyPendingConfirmation(key.id, { profileId: profile.id, runId: "run-a" });
  assert.equal(db.findPendingPixPhoneKey(profile.id)?.status, "pending_confirmation");
  db.markPixPhoneKeyUsed(key.id, { profileId: profile.id });
  assert.equal(db.listPixPhoneKeys().find((candidate) => candidate.id === key.id)?.status, "used");
});

test("recovery releases only inactive reserved keys and keeps pending keys", () => {
  // reserve two keys, move one to pending, recover with no active runs
  // expect available and pending_confirmation respectively
});

test("reimporting a used phone preserves its used audit state", () => {
  // add, reserve, mark used, then import the same phone again
  // expect one record whose status remains used
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx tsx --test test/database.test.ts`

Expected: failure because lifecycle methods/status do not exist.

- [ ] **Step 3: Add the schema and atomic transitions**

```ts
export type PixPhoneKeyStatus = "available" | "reserved" | "pending_confirmation" | "used";

private ensurePixPhoneKeyLifecycleColumns(): void {
  this.ensureColumn("pix_phone_keys", "reservation_run_id", "TEXT");
  this.ensureColumn("pix_phone_keys", "pending_profile_id", "TEXT");
  this.ensureColumn("pix_phone_keys", "pending_run_id", "TEXT");
  this.ensureColumn("pix_phone_keys", "pending_at", "TEXT");
}

markPixPhoneKeyPendingConfirmation(keyId: string, input: { profileId: string; runId: string }): boolean {
  return this.db.prepare(`UPDATE pix_phone_keys
    SET status = 'pending_confirmation', pending_profile_id = ?, pending_run_id = ?, pending_at = ?, updated_at = ?
    WHERE id = ? AND status = 'reserved' AND assigned_profile_id = ? AND reservation_run_id = ?`
  ).run(input.profileId, input.runId, now, now, keyId, input.profileId, input.runId).changes === 1;
}
```

Keep `SCHEMA_VERSION` unchanged. Call `ensurePixPhoneKeyLifecycleColumns()` from `initializeSchema()` after `createSchema()`, update the create-table definition for fresh workspaces, map all new fields, list all statuses, and reject edit/delete unless `status === "available"`. Make duplicate imports no-ops for every existing status so a historical `used` key is never made available again. Clear transient reservation fields when a key becomes `pending_confirmation` or `used`, retain the pending profile/run fields until `used`, and retain only non-secret audit metadata after `used`.

Invoke `recoverInactivePixPhoneKeyReservations()` immediately after the existing interrupted-run recovery in the database startup path. It releases only rows that are still `reserved` and whose `reservation_run_id` is no longer active; it never alters `pending_confirmation` or `used`.

- [ ] **Step 4: Run database tests and typecheck**

Run: `npx tsx --test test/database.test.ts && npm run check`

Expected: all database tests pass and both TypeScript projects typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts.ts src/main/services/database.ts test/database.test.ts
git commit -m "feat(pix): persist temporary phone key lifecycle"
```

### Task 2: Decide clean, pending, and conflicting PIX account states

**Files:**
- Create: `src/main/services/pix-phone-key-lifecycle.ts`
- Create: `test/pix-phone-key-lifecycle.test.ts`

**Interfaces:**
- Produces `matchesMaskedPixPhone(mask: string, phone: string): boolean`.
- Produces `decidePixPhonePreflight({ pendingKeyId?, accounts, phoneNumber? }): "clean" | "manual-account" | "resume-pending" | "pending-used" | "conflict" | "insufficient-evidence"`.
- Produces `pixResultForPreflight(decision)` so the runtime maps preflight states to typed control results without duplicating branches.
- Consumes account snapshots with `kind: "pix-phone" | "other"` and `maskedPhone?: string`; it never receives or returns an unmasked value in diagnostics.

- [ ] **Step 1: Write failing pure behavior tests**

```ts
test("mask requires preserved prefix and suffix", () => {
  assert.equal(matchesMaskedPixPhone("41***690", "41980042690"), true);
  assert.equal(matchesMaskedPixPhone("41***690", "41980041690"), true);
  assert.equal(matchesMaskedPixPhone("4***90", "41980042690"), false);
});

test("clean profile with a manual PIX account never reserves inventory", () => {
  assert.equal(decidePixPhonePreflight({ accounts: [{ kind: "pix-phone", maskedPhone: "41***690" }] }), "manual-account");
});

test("pending key resolves as used, resume, or conflict", () => {
  assert.equal(decidePixPhonePreflight({ pendingKeyId: "k", phoneNumber: "41980042690", accounts: [{ kind: "pix-phone", maskedPhone: "41***690" }] }), "pending-used");
  assert.equal(decidePixPhonePreflight({ pendingKeyId: "k", phoneNumber: "41980042690", accounts: [] }), "resume-pending");
  assert.equal(decidePixPhonePreflight({ pendingKeyId: "k", phoneNumber: "41980042690", accounts: [{ kind: "pix-phone", maskedPhone: "55***123" }] }), "conflict");
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx tsx --test test/pix-phone-key-lifecycle.test.ts`

Expected: failure because the lifecycle service is missing.

- [ ] **Step 3: Implement the pure matcher and decision table**

Extract digit chunks around `*`; require a first chunk of at least 2 digits and final chunk of at least 3 digits. Match the first chunk with `startsWith` and the final chunk with `endsWith`. Do not concatenate chunks and compare them as a fake suffix. If a pending account mask fails the evidence threshold, return `insufficient-evidence`, not `pending-used`. A clean profile with any existing receiving account maps to `manual-account`; it must not consume a stock key, even if its masked value cannot be associated with inventory.

- [ ] **Step 4: Run focused tests**

Run: `npx tsx --test test/pix-phone-key-lifecycle.test.ts`

Expected: all lifecycle decision tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/pix-phone-key-lifecycle.ts test/pix-phone-key-lifecycle.test.ts
git commit -m "feat(pix): decide phone key reconciliation safely"
```

### Task 3: Inspect and confirm a PIX account in the live SPA

**Files:**
- Create: `src/main/services/pix-phone-key-confirmation.ts`
- Create: `test/pix-phone-key-confirmation.test.ts`
- Modify: `src/main/services/pix-password-confirmation.ts` only if shared modal visibility helpers can be exported without changing behavior

**Interfaces:**
- Produces `inspectPixReceivingAccounts(surface): Promise<PixReceivingAccountSnapshot>`.
- Produces `confirmPixPhoneSubmission(surface, phoneNumber, timeoutMs): Promise<{ actionAttempted: boolean; result: "confirmed" | "conflict" | "pending" | "error"; reason?: string }>`.
- The snapshot contains only account kind, masked text and structural counts; callers must not log its mask.

- [ ] **Step 1: Write failing browser-service tests with a fake main-world surface**

```ts
test("confirmation waits for the modal to disappear and a compatible PIX PHONE card", async () => {
  const result = await confirmPixPhoneSubmission(fakeSurface([
    { modal: true, accounts: [] },
    { modal: false, accounts: [{ kind: "pix-phone", maskedPhone: "41***690" }] },
  ]), "41980042690", 300);
  assert.equal(result.result, "confirmed");
  assert.equal(result.actionAttempted, true);
});

test("confirmation makes one scoped click and leaves ambiguous output pending", async () => {
  const result = await confirmPixPhoneSubmission(fakeAmbiguousSurface(), "41980042690", 100);
  assert.equal(result.result, "pending");
  assert.equal(fakeAmbiguousSurface.clicks, 1);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx tsx --test test/pix-phone-key-confirmation.test.ts`

Expected: failure because the confirmation service is missing.

- [ ] **Step 3: Implement scoped click, account inspection, and conditional polling**

Locate exactly one visible `Confirmar` button inside exactly one `.ui-popup.ui-dialog` whose normalized text includes PIX and which has no visible PIN/keyboard. Dispatch it once with the current locator. Poll `active=10`, visible dialogs, error semantics, `withdraw.accountList`, and PIX account DOM cards. Classify the account by visible `PIX(PHONE)` semantics plus store/card structure; pass only the masked account text to the pure decision service. Return `pending` on timeout or insufficient evidence; never click again.

- [ ] **Step 4: Run focused tests and existing password-confirmation tests**

Run: `npx tsx --test test/pix-phone-key-confirmation.test.ts test/pix-password-confirmation.test.ts`

Expected: all tests pass without regressions to PIN confirmation.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/pix-phone-key-confirmation.ts test/pix-phone-key-confirmation.test.ts src/main/services/pix-password-confirmation.ts test/pix-password-confirmation.test.ts
git commit -m "feat(pix): confirm phone key from live account state"
```

### Task 4: Compose preflight, submission, recovery, and per-profile results

**Files:**
- Modify: `src/main/services/automation-runtime.ts:850-1020`
- Modify: `src/shared/contracts.ts:458-463`
- Modify: `src/renderer/components/ControlPanel.tsx:84-105`
- Test: `test/pix-phone-key-lifecycle.test.ts`

**Interfaces:**
- Adds control results `pix_already_registered`, `pix_key_registered`, `pix_key_pending_confirmation`, and `pix_key_conflict` plus steps `pix-preflight`, `pix-submit`, `pix-submission-confirmation`.
- Consumes Task 1 database transitions, Task 2 preflight decisions, and Task 3 confirmation.

- [ ] **Step 1: Write failing orchestration tests**

```ts
test("manual PIX account maps to a no-reservation terminal result", () => {
  assert.deepEqual(pixResultForPreflight("manual-account"), {
    status: "pix_already_registered",
    reservation: "none",
  });
});

test("compatible pending account maps to used without another reservation", () => {
  assert.deepEqual(pixResultForPreflight("pending-used"), {
    status: "pix_key_registered",
    reservation: "consume-pending",
  });
});

test("conflicting pending account maps to a preserved-pending result", () => {
  assert.deepEqual(pixResultForPreflight("conflict"), {
    status: "pix_key_conflict",
    reservation: "keep-pending",
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx tsx --test test/pix-phone-key-lifecycle.test.ts`

Expected: failure because runtime outcomes and preflight integration do not exist.

- [ ] **Step 3: Integrate lifecycle in `runPixWithdrawalEntryForProfile`**

After `waitForPixReceivingAccountSurface`, inspect accounts before calling `reservePixPhoneKey`. Handle manual-account, pending-used, resume-pending, conflict and insufficient-evidence outcomes before opening the add modal. Reserve with `run.id` only for clean accounts. After `fillPixPhoneAddForm`, move the key to pending, call Task 3 once, mark used only on `confirmed`, release only when `actionAttempted === false`, and otherwise keep pending. Return `pix_key_pending_confirmation` for a submitted-but-unconfirmed attempt, and `pix_key_conflict` for a mismatch or insufficient evidence; both leave the pending key intact and stop only that profile. In `catch`/`finally`, release this run's `reserved` key only; never release pending keys. Return per-profile statuses so the existing `Promise.allSettled` batch continues.

- [ ] **Step 4: Run runtime-adjacent tests and typecheck**

Run: `npx tsx --test test/pix-phone-key-lifecycle.test.ts test/database.test.ts && npm run check`

Expected: lifecycle statuses compile through main, preload, shared contracts, and renderer.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/automation-runtime.ts src/shared/contracts.ts src/renderer/components/ControlPanel.tsx test/pix-phone-key-lifecycle.test.ts
git commit -m "feat(pix): reconcile phone keys across submission runs"
```

### Task 5: Show complete key inventory with Portuguese state labels

**Files:**
- Modify: `src/renderer/components/PixKeysPanel.tsx:1-260`
- Create: `src/renderer/lib/pix-key-status.ts`
- Test: `test/pix-key-status.test.ts`

**Interfaces:**
- Produces `pixKeyStatusLabel(status)` and `canManagePixKey(status)`.
- `PixKeysPanel` consumes all `PixPhoneKeyRecord` states from Task 1 and exposes edit/delete controls only for `available` rows.

- [ ] **Step 1: Write the failing renderer behavior test**

```tsx
test("maps internal PIX key states to Portuguese UI labels", () => {
  assert.equal(pixKeyStatusLabel("available"), "Disponível");
  assert.equal(pixKeyStatusLabel("reserved"), "Em cadastro");
  assert.equal(pixKeyStatusLabel("pending_confirmation"), "Aguardando confirmação");
  assert.equal(pixKeyStatusLabel("used"), "Cadastrada");
  assert.equal(canManagePixKey("available"), true);
  assert.equal(canManagePixKey("used"), false);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx tsx --test test/pix-key-status.test.ts`

Expected: failure because the panel currently lists only available keys and exposes all actions.

- [ ] **Step 3: Implement complete inventory rows**

Replace the available-only count with counts by state. Add profile binding and relevant reservation/pending/used timestamp columns when present. Keep the phone formatting behavior, but render edit/delete buttons only for `available`; remove them entirely for every other status. Use a small local status map:

```ts
const PIX_KEY_STATUS_LABEL: Record<PixPhoneKeyStatus, string> = {
  available: "Disponível",
  reserved: "Em cadastro",
  pending_confirmation: "Aguardando confirmação",
  used: "Cadastrada",
};
```

- [ ] **Step 4: Run the renderer test and full verification**

Run: `npm test && npm run check`

Expected: all tests pass and TypeScript validates both renderer and Electron projects.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/PixKeysPanel.tsx src/renderer/lib/pix-key-status.ts test/pix-key-status.test.ts
git commit -m "feat(pix): show phone key lifecycle in Portuguese"
```

### Task 6: Manual multi-window validation

**Files:**
- No source changes unless a failing manual scenario is reproduced by a new automated test first.

- [ ] **Step 1: Start the desktop app**

Run: `npm run dev`

Expected: desktop app opens with the rebuilt flow.

- [ ] **Step 2: Validate the clean, manual, and recovery cases**

Run the PIX action across separate disposable profiles:

1. clean profile without receiving account: one PHONE key reaches **Cadastrada** only after the card appears;
2. profile with manually registered PIX: result is `pix_already_registered`, stock count unchanged;
3. interrupt before final click: key returns to **Disponível**;
4. interrupt after final dispatch: key appears as **Aguardando confirmação**; rerun resolves it to **Cadastrada**, resumes it, or logs conflict;
5. one conflicting window among several: only it stops, others complete.

- [ ] **Step 3: Record result and commit only test-backed fixes**

Run: `git status --short`

Expected: no unrelated changes are staged; preserve the user-owned `package-lock.json` if it remains modified.

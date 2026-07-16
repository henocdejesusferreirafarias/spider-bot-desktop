# PIX Password Modal Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the live document or frame hosting the PIX withdrawal-password modal immediately before PIN entry.

**Architecture:** A dedicated resolver scans the top-level page and each live child frame when the prompt is ready. It returns exactly one structurally actionable `SpaHandle`; the existing effect-confirmed keyboard engine stays unchanged. The runtime uses this fresh handle only for PIN entry.

**Tech Stack:** TypeScript ESM, Patchright Page/Frame, Node test runner, strict TypeScript.

## Global Constraints

- Do not select the modal by host, route, label, or frame order.
- A target requires one visible empty six-cell PIN grid, exactly one focused cell, and a visible numeric keyboard with keys.
- Scan the Page plus child frames, never the main document twice.
- Absence or ambiguity uses conditional waiting and never triggers a tap or digit.
- Preserve keyboard-root selection by visual dot advancement and never click “Próximo”.
- Keep PIN material out of diagnostics and logs; do not stage `package-lock.json`.

---

### Task 1: Build and test live modal-context selection

**Files:**
- Create: `src/main/services/withdrawal-password-modal-context.ts`.
- Create: `test/withdrawal-password-modal-context.test.ts`.

**Interfaces:**
- `inspectWithdrawalPasswordModalSurface(surface: SpaHandle): Promise<WithdrawalPasswordModalSurfaceInspection>`.
- `selectUniqueWithdrawalPasswordModalSurface(candidates: WithdrawalPasswordModalSurfaceCandidate[]): WithdrawalPasswordModalSurfaceResolution`.
- `waitForUniqueWithdrawalPasswordModalSurface(page: Page, timeoutMs: number): Promise<WithdrawalPasswordModalSurfaceResolution>`.
- Resolution: `{ ok: true; surface: SpaHandle }` or `{ ok: false; reason: "surface-absent" | "surface-ambiguous"; diag: string }`.

- [ ] **Step 1: Write failing selector tests**

Create fixture `eligibleInspection = { visibleGrids: 1, gridCells: 6, filledCells: 0, focusedCells: 1, visibleKeyboards: 1, keyboardKeys: 12 }`. Test that `selectUniqueWithdrawalPasswordModalSurface` selects the top Page when a stale frame has `focusedCells: 0`; selects a live frame when top has `visibleGrids: 0`; returns `surface-ambiguous` for two eligible candidates; and returns `surface-absent` for a grid with `filledCells: 1`.

- [ ] **Step 2: Verify RED**

Run `npm test -- --test-name-pattern "modal elegivel|modais igualmente|grid parcial"`.

Expected: FAIL because the resolver module does not exist.

- [ ] **Step 3: Implement structural inspection and pure selection**

Evaluate every `SpaHandle` in the main world. Count visible `.ui-password-input` grids, their `.ui-password-input__item` cells, visually filled cells (text or visible marker), focused cells, visible `.ui-number-keyboard` roots, and `.ui-number-keyboard-key__wrapper` keys. A candidate is eligible only when:

```ts
inspection.visibleGrids === 1
  && inspection.gridCells === 6
  && inspection.filledCells === 0
  && inspection.focusedCells === 1
  && inspection.visibleKeyboards >= 1
  && inspection.keyboardKeys >= 10
```

Return only the unique eligible target. For zero/multiple targets, return count-only diagnostics with `surface-absent`/`surface-ambiguous`; never return page text or PIN data.

- [ ] **Step 4: Implement scan and conditional wait**

Build surfaces with `[page, ...page.frames().filter((frame) => frame !== page.mainFrame())]`. An evaluation rejection is non-eligible with `evaluate-error` diagnostics. Poll each 180 ms until `timeoutMs`, return as soon as exactly one candidate exists, and perform one final scan on timeout. The resolver has no locator, touch, or keyboard action.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```powershell
npm test -- --test-name-pattern "modal elegivel|modais igualmente|grid parcial"
npm run check
git add src/main/services/withdrawal-password-modal-context.ts test/withdrawal-password-modal-context.test.ts
git commit -m "feat(pix): resolve live password modal context"
```

Expected: selector tests and typecheck pass.

### Task 2: Use the fresh context only for PIN entry

**Files:**
- Modify: `src/main/services/automation-runtime.ts: runPixWithdrawalEntryForProfile`.
- Modify: `test/withdrawal-password-modal-context.test.ts`.

**Interfaces:**
- Consume `waitForUniqueWithdrawalPasswordModalSurface(session.page, PIX_MS(4000))`.
- Consume `fillExistingWithdrawalPassword(resolution.surface, withdrawalPassword)`.
- Keep public status `withdrawal_password_entered` and step `pix-enter-password`.

- [ ] **Step 1: Write failing conditional-wait test**

Add `seleciona o contexto que aparece apos a navegacao`: a fake Page with no child frames has no eligible candidate in its first scan and a valid top-page candidate in its second. Assert `ok === true`, `surface === page`, and one conditional wait.

- [ ] **Step 2: Verify RED**

Run `npm test -- --test-name-pattern "seleciona o contexto que aparece apos a navegacao"`.

Expected: FAIL until the conditional wait exists.

- [ ] **Step 3: Replace the stale entry handle**

Immediately after the existing prompt wait, resolve `modalSurface = await waitForUniqueWithdrawalPasswordModalSurface(session.page, PIX_MS(4000))`. If it is not ok, throw `contexto do modal de senha indisponivel` with only its reason and diagnostic. Pass `modalSurface.surface` to `fillExistingWithdrawalPassword`. Keep persisted-password validation and all preceding navigation on the existing `spa`; do not alter the keyboard algorithm or invoke “Próximo”.

- [ ] **Step 4: Verify, commit, and manually validate**

Run:

```powershell
npm test
npm run check
git diff --check
git add src/main/services/automation-runtime.ts test/withdrawal-password-modal-context.test.ts
git commit -m "fix(pix): use live context for withdrawal password"
git status --short
```

Expected: all tests/typecheck pass and only user-owned `package-lock.json` may remain modified. The user then runs `npm run dev` in the nine sessions: each “Inserir PIN” modal fills six masked cells, does not advance, and logs `withdrawal_password_entered`. A safe failure logs only `surface-absent` or `surface-ambiguous` count diagnostics.

## Self-review

- Task 1 covers top page, live frame, absence, partial grid, and ambiguity with no interaction.
- Task 2 changes only the stale handle at the PIN boundary; navigation and PIN safeguards remain intact.
- All interfaces, failure names, test commands, and commit scopes are consistent.

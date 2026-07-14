# PIX Withdrawal Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy PIX registration path with a verified entry flow that opens Profile, invokes the platform's live Withdrawal Management action, and returns only the resulting password-setup or withdrawal-ready state.

**Architecture:** Add a small SPA capability adapter for the live Vue action and a screen-state classifier with condition-based waits. The runtime schedules profile workers through a two-permit semaphore and exposes preparatory results through the existing PIX IPC, while removing every legacy PIX-only registration action.

**Tech Stack:** TypeScript ESM, Electron main process, Patchright `Page`/`Frame`, Vue runtime internals, Node test runner (`tsx --test`).

## Global Constraints

- Work only in `spider-bot-desktop`; do not add host/domain mappings.
- Discover a fresh router/listener in the current SPA document; never cache a Vue listener between navigations.
- Do not use screen coordinates, `HTMLElement.click()`, or a fixed sleep as success evidence.
- First slice must not fill, submit, reserve, consume, or modify a PIX key or a withdrawal password.
- A missing or ambiguous management action must fail safely with diagnostics.
- Limit this operation to two active profile workers; failures remain per-profile.
- Run `npm test`, `npm run check`, and a manual `npm run dev` test before the next slice.

---

### Task 1: Define the preparatory result contract and control copy

**Files:**
- Modify: `src/shared/contracts.ts:451-462, 575-580`
- Modify: `src/main/index.ts:1740-1773`
- Modify: `src/renderer/components/ControlPanel.tsx:88-100, 610-640`
- Test: `test/control-selection.test.ts` (only if an existing control-result harness can cover the changed result shape)

**Interfaces:**
- Produces `PixRegistrationPreparationStatus = "needs_withdrawal_password" | "withdrawal_ready" | "failed"`.
- Produces `PixKeyRegistrationControlResult { status: PixRegistrationPreparationStatus; step?: "profile" | "withdrawal-management"; error?: string; pixType: PixRegistrationType; profileId: string; profileName: string; }`.
- The existing preload/IPC method name remains `registerPixKey`; its behavior is preparation only in this slice.

- [ ] **Step 1: Write the failing type-level usage in the renderer**

Change `summarizePixRegistrationResults` to require the new statuses and add branches that return `"X tela(s) aguardando cadastro de senha."`, `"X tela(s) pronta(s) para saque."`, or failures. Reference the new `PixRegistrationPreparationStatus` in the component so the old `succeeded` branch no longer typechecks.

- [ ] **Step 2: Run the typecheck to verify it fails**

Run: `npm run check`

Expected: TypeScript reports that `PixKeyRegistrationControlResult.status` does not include the preparation statuses.

- [ ] **Step 3: Implement the minimal shared contract and presentation change**

Add the status union and optional `step` to `src/shared/contracts.ts`. Update the ControlPanel button label to `Preparar cadastro PIX` and its summary to describe preparation rather than successful PIX registration. In the IPC handler remove the available-key count preflight and replace the activity message with `Preparacao de cadastro PIX concluida ...`.

- [ ] **Step 4: Run the typecheck to verify it passes**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/shared/contracts.ts src/main/index.ts src/renderer/components/ControlPanel.tsx
git commit -m "feat(pix): report withdrawal entry preparation"
```

### Task 2: Add a runtime-safe Withdrawal Management action

**Files:**
- Modify: `src/main/services/spa-navigation.ts:817-851, 852-1405`
- Modify: `test/spa-navigation.test.ts`

**Interfaces:**
- Produces `ProgrammaticWithdrawalManagementResult { ok: boolean; reason?: "management-action-absent" | "management-action-ambiguous" | "management-listener-failed"; diag?: string; }`.
- Produces `programmaticWithdrawalManagementAction(spa: SpaHandle): Promise<ProgrammaticWithdrawalManagementResult>`.
- Consumes the existing main-world `evaluate` convention and fresh DOM listener lookup.

- [ ] **Step 1: Write failing tests for a unique semantic listener and an ambiguous candidate set**

Add a harness with one visible element named `Gestão de saques` whose Symbol `_vei` map contains an `onClick.value` handler. Assert `programmaticWithdrawalManagementAction(page).ok === true` and one handler call. Add a second harness with two equally eligible visible elements and assert `ok === false`, `reason === "management-action-ambiguous"`, and zero handler calls.

- [ ] **Step 2: Run the focused test file to verify it fails**

Run: `npm test -- test/spa-navigation.test.ts`

Expected: FAIL because `programmaticWithdrawalManagementAction` is not exported.

- [ ] **Step 3: Implement the smallest capability adapter**

Extract the existing live Vue listener invocation helpers from `programmaticPixUiAction` into reusable local helpers inside its main-world callback pattern. The new action must normalize accents/case/spacing, score aliases (`gestao de saques`, `gestao saque`, `saques`, `withdraw`, `withdrawal`, `cash out`) against visible text and attributes, collect the unique highest-score listener candidate, and invoke its current `value` handler with a `MouseEvent` argument. Return diagnostics; do not dispatch an event or call `HTMLElement.click()`.

- [ ] **Step 4: Run the focused test file to verify it passes**

Run: `npm test -- test/spa-navigation.test.ts`

Expected: PASS, including all existing PIX navigation tests.

- [ ] **Step 5: Commit**

```powershell
git add src/main/services/spa-navigation.ts test/spa-navigation.test.ts
git commit -m "feat(pix): invoke live withdrawal management action"
```

### Task 3: Classify the destination with conditional waits

**Files:**
- Modify: `src/main/services/screen-detection.ts`
- Modify: `src/main/services/screen-waits.ts`
- Modify: `test/screen-detection.test.ts`
- Modify: `test/screen-waits.test.ts`

**Interfaces:**
- Produces `WithdrawalManagementDestination = "needs_withdrawal_password" | "withdrawal_ready" | "unknown"`.
- Produces `classifyWithdrawalManagementDestination(page: Page): Promise<WithdrawalManagementDestination>`.
- Produces `waitForWithdrawalManagementDestination(page: Page, timeoutMs: number): Promise<WithdrawalManagementDestination>`.

- [ ] **Step 1: Write failing classifier tests**

Add test fixtures for: (a) a security/setup surface containing `Defina sua senha de saque` and `Confirmar Nova Senha`; (b) a withdrawal/receiving-account surface; (c) an unrelated route with no recognized surface. Assert `needs_withdrawal_password`, `withdrawal_ready`, and `unknown` respectively.

- [ ] **Step 2: Run the focused screen tests to verify they fail**

Run: `npm test -- test/screen-detection.test.ts test/screen-waits.test.ts`

Expected: FAIL because the classifier and wait are absent.

- [ ] **Step 3: Implement minimal strong signals and polling**

Classify setup only when the security/password context and both definition and confirmation phrases are present. Classify withdrawal only through the existing withdrawal-account/request surface helpers. Poll every 180ms, returning early for a recognized state and returning a final `unknown` after the timeout. Catch detached/evaluate errors as unknown; do not turn them into success.

- [ ] **Step 4: Run the focused screen tests to verify they pass**

Run: `npm test -- test/screen-detection.test.ts test/screen-waits.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/services/screen-detection.ts src/main/services/screen-waits.ts test/screen-detection.test.ts test/screen-waits.test.ts
git commit -m "feat(pix): verify withdrawal management destination"
```

### Task 4: Replace the legacy PIX worker with the verified entry worker

**Files:**
- Modify: `src/main/services/automation-runtime.ts:128-165, 624-680, 831-1000, 3400-4300, 5300-5700`
- Modify: `src/main/services/async-semaphore.ts` only if an existing constructor cannot be reused directly
- Test: `test/automation-runtime.test.ts`

**Interfaces:**
- Consumes `programmaticWithdrawalManagementAction`, `resolveRouteTarget(..., "profile", ...)`, `routerPush`, `waitForProfileSurface`, and `waitForWithdrawalManagementDestination`.
- Produces `runManualPixKeyRegistration(profileIds, pixType, settings)` with only preparatory statuses.
- Uses `new AsyncSemaphore(2)` around each profile worker.

- [ ] **Step 1: Write failing worker-orchestration tests**

Create a runtime harness that records calls. Assert that a profile worker: resolves and pushes the profile route, waits for Profile before invoking the management action, returns `needs_withdrawal_password` for the setup destination, and never calls `reservePixPhoneKey`, `markPixPhoneKeyUsed`, or PIX form helpers. Add a multi-profile harness where three delayed workers observe a peak of two active workers.

- [ ] **Step 2: Run the focused runtime test to verify it fails**

Run: `npm test -- test/automation-runtime.test.ts`

Expected: FAIL because the old worker reserves a PIX key and runs the old registration sequence.

- [ ] **Step 3: Implement the entry-only worker and remove legacy PIX-only code**

Replace `PixRegistrationStep` with `profile | withdrawal-management`. Remove phone-key reservation/consumption and all PIX-only execution helpers (`executePixKeyRegistration`, prompt handling used solely by it, receiving-tab/modal/type/form/submit/persistence helpers). In the new worker: acquire a permit, create the run/session, ensure login, resolve/push Profile, require `waitForProfileSurface`, invoke the management action once, wait/classify the destination, persist an accurate run metric, and release the permit/session in `finally`. Return `failed` with stage and `describeSpaState` diagnostics whenever a required condition is absent.

- [ ] **Step 4: Run focused tests and typecheck to verify green**

Run: `npm test -- test/automation-runtime.test.ts`

Expected: PASS.

Run: `npm run check`

Expected: PASS with no unused legacy imports or functions.

- [ ] **Step 5: Commit**

```powershell
git add src/main/services/automation-runtime.ts src/main/services/async-semaphore.ts test/automation-runtime.test.ts
git commit -m "feat(pix): replace legacy registration with verified entry"
```

### Task 5: Verify the complete first slice

**Files:**
- Modify: `docs/adr/` only if runtime testing reveals a new lasting architectural decision beyond the approved design

- [ ] **Step 1: Run the complete automated suite**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 2: Run the complete typecheck**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 3: Manually test the first slice**

Run: `npm run dev`

Expected: from the PIX control, a new account reaches the confirmed password-setup state after Profile and Withdrawal Management; no password field is filled and no PIX key is reserved.

- [ ] **Step 4: Record actual validation evidence in the issue/PR description**

State the test account condition (no withdrawal password), the observed final state, and the exact commands/results. Do not record credentials or account identifiers.

- [ ] **Step 5: Commit any verification-only documentation**

```powershell
git add docs/adr
git commit -m "docs: record pix withdrawal entry verification"
```

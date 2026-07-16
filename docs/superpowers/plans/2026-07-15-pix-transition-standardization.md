# Padronização de transições PIX remanescentes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aplicar o modelo origem estável → ação única → destino estrutural à confirmação da senha de saque e à abertura do PIN para adicionar PIX.

**Architecture:** Cada serviço expõe uma inspeção segura da origem e separa a tentativa de ação de sua confirmação. O runtime só encerra sucesso quando o destino existente é observado; handlers/listeners que rejeitam após a tentativa não causam segundo dispatch.

**Tech Stack:** TypeScript estrito, Patchright, Node test runner, Electron.

## Global Constraints

- Não alterar preenchimento ou submissão de chave PIX, nem código legado.
- Não usar host, viewport, coordenadas, valores de campos, PIN, CPF ou texto de usuário como estado de decisão.
- Duas leituras iguais em intervalo de 180 ms, com teto de 4 s, precedem toda ação.
- Cada janela executa no máximo um dispatch/listener/click por transição.
- O teto para o destino é 12 s e o destino estrutural decide o sucesso.
- Diagnósticos só contêm contagens, índices, booleanos e `actionRejected`.
- Não preparar `package-lock.json`.

---

### Task 1: Estabilizar e confirmar o cadastro inicial da senha de saque

**Files:**
- Modify: `src/main/services/withdrawal-password-setup.ts:18-31,286-385`
- Modify: `test/withdrawal-password-setup.test.ts:120-275`

**Interfaces:**
- Produces:
  ```ts
  interface WithdrawalPasswordConfirmationResult {
    ok: boolean;
    actionAttempted: boolean;
    actionRejected: boolean;
    reason?: "surface-invalid" | "confirm-action-absent" | "confirm-action-ambiguous" | "destination-not-confirmed";
    diag?: string;
  }
  ```

- [ ] **Step 1: Write failing setup-confirmation tests**

Extend `withConfirmationSurface` with `stabilizeOnInspection` and `throwAfterDispatch`. Add:

```ts
test("espera duas leituras estaveis antes de confirmar o cadastro da senha", async () => {
  await withConfirmationSurface(
    { pinCount: [6, 6], confirmControls: 1, stabilizeOnInspection: 2 },
    async (page, confirmCount, inspections) => {
      const result = await confirmWithdrawalPasswordSetup(page);

      assert.equal(result.actionAttempted, true);
      assert.equal(confirmCount(), 1);
      assert.equal(inspections(), 3);
    },
  );
});
```

Add a second test where the dispatch increments `confirmCount` then throws; pass it to `confirmAndVerifyWithdrawalPasswordSetup` with destination `withdrawal_ready`, asserting success and exactly one dispatch. Add the inverse with destination `unknown`, asserting `destination-not-confirmed` and one dispatch.

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```powershell
npm test -- --test-name-pattern "espera duas leituras estaveis antes de confirmar o cadastro|dispatch rejeitado"
```

Expected: FAIL because setup confirmation acts after a single inspection and stops before destination waiting after a rejected action.

- [ ] **Step 3: Split inspection, action attempt and destination confirmation**

Extract a page-world `inspectWithdrawalPasswordConfirmationSource(spa)` that returns only:

```ts
{ fields: number; filled: number[]; controls: number; controlIndex?: number }
```

Add a 4 s poll that requires two consecutive valid samples with the same `controlIndex`. Keep all helpers inside the page callback so no main-process closure is captured.

Set `actionAttempted: true` immediately before the one listener invocation or `dispatchEvent`. If it throws, return `actionRejected: true` instead of a terminal failure. In `confirmAndVerifyWithdrawalPasswordSetup`, call the existing destination wait whenever `actionAttempted` is true. Preserve failure when no action was attempted.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run:

```powershell
npm test -- --test-name-pattern "espera duas leituras estaveis antes de confirmar o cadastro|dispatch rejeitado|confirmacao da senha exige destino"
```

Expected: PASS, with one action in every case and success governed by `withdrawal_ready`.

- [ ] **Step 5: Commit Task 1**

```powershell
git add src/main/services/withdrawal-password-setup.ts test/withdrawal-password-setup.test.ts
git commit -m "fix(pix): stabilize withdrawal password confirmation"
```

### Task 2: Estabilizar a origem e o resultado de Adicionar PIX

**Files:**
- Modify: `src/main/services/pix-add-action.ts`
- Modify: `src/main/services/automation-runtime.ts:938-952`
- Modify: `test/pix-add-action.test.ts` or the existing test file that covers `programmaticPixAddAction`

**Interfaces:**
- Produces:
  ```ts
  interface PixAddActionResult {
    ok: boolean;
    actionAttempted: boolean;
    actionRejected: boolean;
    reason?: "pix-add-action-absent" | "pix-add-action-ambiguous";
    diag?: string;
  }
  ```

- [ ] **Step 1: Write failing PIX-add tests**

Find the existing `PIX add modal invokes ...` tests and extend their fake DOM/listener with an inspection counter. Add a case that presents the same unique candidate twice before invocation and assert one listener call. Add a case whose listener records invocation then throws; assert:

```ts
assert.equal(result.actionAttempted, true);
assert.equal(result.actionRejected, true);
assert.equal(listenerCalls(), 1);
```

Add a runtime-oriented composition test in which `actionRejected: true` is followed by the existing `waitForExistingWithdrawalPasswordModal` condition resolving true; assert no second listener call.

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```powershell
npm test -- --test-name-pattern "PIX add aguarda origem estavel|PIX add preserva tentativa rejeitada"
```

Expected: FAIL because the action executes after one discovery and a listener rejection is terminal.

- [ ] **Step 3: Add stable candidate inspection and single invocation**

Refactor `pix-add-action.ts` into three private operations:

1. `inspectPixAddAction`: discovers the existing Vue listener or semantic DOM fallback and returns a count-only candidate identity `strategy:index`;
2. `waitForStablePixAddAction`: polls up to 4 s and returns only two equal unique identities;
3. `invokeStablePixAddAction`: re-discovers the live candidate, verifies its identity equals the stable one, and invokes it once.

All three execute discovery inside the live page context. The invoker marks `actionAttempted` immediately before `Reflect.apply` or `dispatchEvent`; caught listener errors yield `actionRejected: true`, never a retry.

- [ ] **Step 4: Make the runtime destination-authoritative**

In `automation-runtime.ts`, throw immediately only when `opened.actionAttempted` is false. When true, always use the existing `waitForExistingWithdrawalPasswordModal(session.page, PIX_MS(12000))`. If absent, fail with `actionRejected` plus count-only diagnostics; if present, continue to PIN entry normally.

- [ ] **Step 5: Run full verification and commit**

Run:

```powershell
npm test
npm run check
git diff --check
git status --short
```

Expected: all tests and typecheck pass; only user-owned `M package-lock.json` remains outside intended changes.

Commit:

```powershell
git add src/main/services/pix-add-action.ts src/main/services/automation-runtime.ts test
git commit -m "fix(pix): stabilize add pix transition"
```

## Manual checkpoint

- [ ] Run `npm run dev` from this worktree.
- [ ] Test first-time PIN setup and opening the add-PIX PIN across multiple compatible windows.
- [ ] Confirm each destination succeeds after a single action and no duplicate modal/action appears.
- [ ] Confirm a destination that never appears fails without a second attempt.


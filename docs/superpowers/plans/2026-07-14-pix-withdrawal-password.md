# Senha de saque no cadastro PIX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preencher os dois PINs de senha de saque do cadastro PIX usando a mesma senha persistida, sem acionar `Confirmar` neste corte.

**Architecture:** O runtime persiste a senha cifrada antes da primeira interacao. Um primitivo isolado descobre dois `ui-password-input` e `ui-number-keyboard`, invoca listeners Vue vivos e confirma seis celulas por campo. Checkpoints nominais no run permitem retomada com a mesma senha.

**Tech Stack:** TypeScript estrito, Electron, Patchright, Vue main world, SQLite secure store, `tsx --test`.

## Global Constraints

- Senha de seis digitos, cifrada antes do primeiro digito e ausente de logs, metricas, IPC e diagnosticos.
- Reexecucao reutiliza a senha persistida; nunca gera uma segunda senha para o perfil.
- Sem coordenadas, `HTMLElement.click()` ou espera fixa como sucesso.
- Este corte nao aciona `Confirmar`.
- Senha existente na plataforma sem senha local persistida e erro critico.

---

### Task 1: Resultado e checkpoint sem segredo

**Files:**
- Modify: `src/shared/contracts.ts:458-463`
- Modify: `src/main/services/automation-runtime.ts:822-900`
- Test: `test/automation-runtime.test.ts`

**Interfaces:** Produz `PixWithdrawalPasswordStage = "reserved" | "first-field-filled" | "second-field-filled" | "submitted" | "confirmed"` e adiciona `"withdrawal_password_filled"` a `PixKeyRegistrationControlResult.status`.

- [ ] **Step 1: Write the failing test**

```ts
test("persists the withdrawal password before invoking the grid", async () => {
  const order: string[] = [];
  const runtime = createPixRuntime({
    ensurePassword: () => { order.push("persist"); return "123456"; },
    fillPassword: async () => { order.push("fill"); return filledPasswordResult; }
  });
  await runtime.preparePixForProfile("profile-1", "PHONE");
  assert.deepEqual(order, ["persist", "fill"]);
  assert.doesNotMatch(JSON.stringify(runtime.runMetrics()), /123456/);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- test/automation-runtime.test.ts`

Expected: FAIL because the password stage and result status do not exist.

- [ ] **Step 3: Implement the minimal contract and checkpoint**

```ts
type PixWithdrawalPasswordStage = "reserved" | "first-field-filled" | "second-field-filled" | "submitted" | "confirmed";
const nextMetrics = { ...existingRun.metrics, pixWithdrawalPasswordStage: stage };
```

Call `database.ensureProfileWithdrawalPassword(profile.id)` only after the password-setup surface is confirmed. Persist metric `reserved` before calling a browser primitive. Do not add the password to any result object.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- test/automation-runtime.test.ts`

Expected: PASS and password absent from serialized run metrics.

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts.ts src/main/services/automation-runtime.ts test/automation-runtime.test.ts && git commit -m "feat(pix): checkpoint withdrawal password setup"
```

### Task 2: Listener-based password-grid primitive

**Files:**
- Create: `src/main/services/withdrawal-password-setup.ts`
- Test: `test/withdrawal-password-setup.test.ts`

**Interfaces:**

```ts
export interface WithdrawalPasswordSetupResult {
  ok: boolean;
  firstFieldFilled: boolean;
  secondFieldFilled: boolean;
  reason?: "surface-invalid" | "field-handler-absent" | "keyboard-handler-absent" | "digit-unconfirmed";
  diag?: string;
}
export async function fillWithdrawalPasswordSetup(
  spa: SpaHandle,
  password: string,
  onStage: (stage: "first-field-filled" | "second-field-filled") => Promise<void>
): Promise<WithdrawalPasswordSetupResult>;
```

- [ ] **Step 1: Write failing tests**

```ts
test("fills both six-cell grids through live Vue listeners", async () => {
  const fixture = createWithdrawalPasswordFixture();
  const stages: string[] = [];
  const result = await fillWithdrawalPasswordSetup(fixture.page, "123456", async (stage) => stages.push(stage));
  assert.equal(result.ok, true);
  assert.deepEqual(fixture.dotCounts(), [6, 6]);
  assert.deepEqual(stages, ["first-field-filled", "second-field-filled"]);
});
test("fails when a digit does not change the visible grid", async () => {
  const result = await fillWithdrawalPasswordSetup(createWithdrawalPasswordFixture({ ignoreDigit: "6" }).page, "123456", async () => undefined);
  assert.equal(result.reason, "digit-unconfirmed");
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- test/withdrawal-password-setup.test.ts`

Expected: FAIL because the primitive is absent.

- [ ] **Step 3: Implement the minimal primitive**

Validate `/^\d{6}$/`. In a main-world evaluation require exactly two visible `.ui-password-input`, each with six visible `.ui-password-input__item`, plus visible `.ui-number-keyboard`. For each grid, invoke the live Vue focus listener, invoke the delegated keyboard listener for each digit with synthetic `MouseEvent`, then require six visually filled cells. Invoke `onStage` only after that count succeeds. Return counts and error names only.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- test/withdrawal-password-setup.test.ts`

Expected: PASS for two grids and missed-digit failure.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/withdrawal-password-setup.ts test/withdrawal-password-setup.test.ts && git commit -m "feat(pix): fill withdrawal password grids safely"
```

### Task 3: Integrar ao fluxo PIX existente

**Files:**
- Modify: `src/main/services/automation-runtime.ts:822-900`
- Modify: `src/renderer/components/ControlPanel.tsx`
- Test: `test/automation-runtime.test.ts`

**Interfaces:** Consome `fillWithdrawalPasswordSetup`; produz `withdrawal_password_filled` somente quando ambos os campos confirmarem seis celulas.

- [ ] **Step 1: Write the failing test**

```ts
test("returns withdrawal_password_filled after both checkpoints", async () => {
  const runtime = createPixRuntime({
    ensurePassword: () => "123456",
    fillPassword: async (_spa, _password, stage) => {
      await stage("first-field-filled");
      await stage("second-field-filled");
      return filledPasswordResult;
    }
  });
  const result = await runtime.preparePixForProfile("profile-1", "PHONE");
  assert.equal(result.status, "withdrawal_password_filled");
  assert.equal(runtime.runMetrics().pixWithdrawalPasswordStage, "second-field-filled");
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- test/automation-runtime.test.ts`

Expected: FAIL because the worker only returns `needs_withdrawal_password`.

- [ ] **Step 3: Wire the worker**

```ts
const password = this.database.ensureProfileWithdrawalPassword(profile.id);
await checkpoint("reserved");
const filled = await fillWithdrawalPasswordSetup(spa, password, checkpoint);
if (!filled.ok || !filled.firstFieldFilled || !filled.secondFieldFilled) {
  throw new Error(`senha de saque nao confirmou preenchimento (${filled.reason ?? "desconhecido"})`);
}
destination = "withdrawal_password_filled";
```

`checkpoint` merges existing metrics with `pixWithdrawalPasswordStage`; renderer copy reads “senha de saque preenchida; aguardando confirmação”, never “PIX cadastrado”.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- test/automation-runtime.test.ts && npm run check`

Expected: PASS and no TypeScript diagnostics.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/automation-runtime.ts src/renderer/components/ControlPanel.tsx test/automation-runtime.test.ts && git commit -m "feat(pix): checkpoint filled withdrawal password"
```

### Task 4: Manual validation and interruption recovery

**Files:**
- Test: `test/withdrawal-password-setup.test.ts`, `test/automation-runtime.test.ts`, all `test/*.test.ts`

- [ ] **Step 1: Run focused tests**

Run: `npm test -- test/withdrawal-password-setup.test.ts test/automation-runtime.test.ts`

Expected: PASS for malformed surface, missed digit, checkpoint ordering and password reuse.

- [ ] **Step 2: Run full verification**

Run: `npm test && npm run check`

Expected: all tests pass with no type errors.

- [ ] **Step 3: Validate visually**

Run: `npm run dev`

Expected: a disposable account reaches `Senha de Saque`, both grids contain six hidden dots, platform `Confirmar` remains untouched, and the control panel shows pending confirmation.

- [ ] **Step 4: Validate recovery**

Run: close the target browser after the first grid, reopen it, then invoke `Preparar cadastro PIX`.

Expected: the same persisted password fills both grids, no new password is generated, and no log reveals it.

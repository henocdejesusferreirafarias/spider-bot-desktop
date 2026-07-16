# Tolerância à transição do PIN PIX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminar falsos negativos e cliques precoces na confirmação do PIN, mantendo uma única tentativa por janela.

**Architecture:** `pix-password-confirmation.ts` passa a aguardar a origem estrutural estável antes do locator e a devolver separadamente “origem inválida” e “tentativa de clique rejeitada”. O runtime sempre espera o formulário PIX depois de uma tentativa; o destino estrutural é a autoridade para sucesso.

**Tech Stack:** TypeScript estrito, Patchright, Node test runner, Electron.

## Global Constraints

- Não vincular seletor, timeout ou lógica a host, marca, viewport, coordenadas ou ordem de janela.
- PIN, CPF, textos de campo e valores de formulário não entram em diagnósticos.
- Há no máximo uma chamada de `locator.click()` por execução e por janela.
- Origem requer duas leituras idênticas separadas por 180 ms, com teto de 4 segundos.
- Destino mantém teto de 12 segundos e exige os sinais estruturais do formulário PIX.
- Não alterar as demais etapas nesta fatia.
- Não incluir `package-lock.json`.

---

### Task 1: Estabilizar a origem antes da tentativa única

**Files:**
- Modify: `src/main/services/pix-password-confirmation.ts:31-114`
- Modify: `test/pix-password-confirmation.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface StableSourceAction {
    modalIndex: number;
    buttonIndex: number;
    sourceModals: number;
    sourceActions: number;
  }

  async function waitForStableSourceAction(
    surface: SpaHandle,
    timeoutMs: number,
  ): Promise<StableSourceAction | null>;
  ```

- [ ] **Step 1: Write the failing stability tests**

Extend the fake PIN surface so consecutive `evaluate` calls can expose an unstable button index before settling. Add:

```ts
test("aguarda duas leituras iguais antes de confirmar o PIN", async () => {
  const { surface, clicks, inspections } = withPinConfirmationSurface({
    filledCells: 6,
    buttons: [{ text: "Próximo" }],
    stabilizeOnInspection: 3,
  });

  const result = await confirmExistingWithdrawalPassword(surface);

  assert.equal(result.actionAttempted, true);
  assert.equal(clicks(), 1);
  assert.equal(inspections(), 3);
});
```

Add a timeout test where the action never becomes stable; assert zero clicks and a source-invalid result.

- [ ] **Step 2: Run the focused tests to verify RED**

Run:

```powershell
npm test -- --test-name-pattern "aguarda duas leituras iguais|recusa origem que nao estabiliza"
```

Expected: FAIL because confirmation currently acts after one inspection.

- [ ] **Step 3: Implement the minimal stability wait**

Keep `inspectSourceAction` as a count-only page-world inspection. Add `waitForStableSourceAction` with a local previous eligible sample. A sample is stable only when both `modalIndex` and `buttonIndex` equal the previous sample. Poll with `surface.waitForTimeout(180)`; return `null` at four seconds without a stable pair.

Use the returned stable source for the existing scoped locator. Do not retry the locator action.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run:

```powershell
npm test -- --test-name-pattern "aguarda duas leituras iguais|recusa origem que nao estabiliza|confirma uma vez o PIN completo"
```

Expected: PASS, with one click only after a stable pair.

### Task 2: Confirmar pelo destino quando o locator rejeita durante a transição

**Files:**
- Modify: `src/main/services/pix-password-confirmation.ts:17-114,187-211`
- Modify: `src/main/services/automation-runtime.ts:964-984`
- Modify: `test/pix-password-confirmation.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface PixPasswordConfirmationResult {
    actionAttempted: boolean;
    clickRejected: boolean;
    reason?: "source-invalid";
    diag?: string;
  }
  ```

- [ ] **Step 1: Write the failing rejected-click tests**

Extend the fake locator to increment the click counter and then throw. Add:

```ts
test("mantem a tentativa unica quando o locator rejeita apos disparar o clique", async () => {
  const { surface, clicks } = withPinConfirmationSurface({
    filledCells: 6,
    buttons: [{ text: "Próximo" }],
    throwAfterClick: true,
  });

  const result = await confirmExistingWithdrawalPassword(surface);

  assert.equal(result.actionAttempted, true);
  assert.equal(result.clickRejected, true);
  assert.equal(clicks(), 1);
});
```

Add a runtime-oriented composition test: a rejected click followed por `waitForPixAddForm` ready is successful; a rejected click without destination produces only `formulario PIX nao confirmado`, never a second click.

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```powershell
npm test -- --test-name-pattern "locator rejeita apos disparar|rejeitado sem destino"
```

Expected: FAIL because rejected locator errors currently end the run before destination polling.

- [ ] **Step 3: Implement outcome separation and runtime handoff**

In `confirmExistingWithdrawalPassword`, set `actionAttempted: true` immediately before the only `locator.click()`. If it rejects, return `clickRejected: true`; do not call locator again.

In `automation-runtime.ts`, throw immediately only when `actionAttempted` is false. Otherwise call `waitForPixAddForm(..., PIX_MS(12000))`. If ready, return `pix_add_form_ready`; otherwise include only `clickRejected` and the existing count/boolean destination diagnostics in the error.

- [ ] **Step 4: Run focused tests and full verification**

Run:

```powershell
npm test -- --test-name-pattern "aguarda duas leituras iguais|recusa origem que nao estabiliza|locator rejeita apos disparar|rejeitado sem destino"
npm test
npm run check
git diff --check
```

Expected: all tests pass, typecheck passes and no whitespace errors.

- [ ] **Step 5: Commit**

```powershell
git add src/main/services/pix-password-confirmation.ts src/main/services/automation-runtime.ts test/pix-password-confirmation.test.ts
git commit -m "fix(pix): confirm pin by destination transition"
```

## Manual checkpoint

- [ ] Run `npm run dev` from this worktree.
- [ ] Test the PIN confirmation on multiple compatible windows.
- [ ] Confirm a window that opens “Adicionar PIX” is logged as `pix_add_form_ready` even if the locator encounters a post-dispatch rejection.
- [ ] Confirm a window that does not transition fails after the destination wait and is never clicked again.


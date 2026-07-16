# Confirmação do PIN de saque e abertura do formulário PIX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirmar uma vez o PIN de saque já preenchido e encerrar esta fatia somente quando o formulário estrutural de adicionar PIX estiver aberto.

**Architecture:** Um serviço novo isola a validação da origem, o clique por locator limitado ao modal e a espera condicional do destino. O runtime apenas coordena a senha persistida, converte o sucesso em `pix_add_form_ready` e registra diagnósticos sem conteúdo sensível. A origem é o contexto dinâmico já resolvido, para não reutilizar uma referência de SPA obsoleta.

**Tech Stack:** TypeScript estrito, Patchright, Node test runner, Electron.

## Global Constraints

- Trabalhar somente no worktree `spider-bot-desktop-SP-17-pix-registration`, branch `SP/17-pix-registration-rebuild`.
- Não incluir, reverter ou preparar `package-lock.json`; a alteração atual é do usuário.
- Não vincular a automação por host, marca, domínio, cor, viewport, coordenadas ou ordem global de elementos.
- O PIN, CPF, texto de inputs e valores inseridos nunca entram em logs, resultados, diagnósticos ou testes.
- A ação de confirmar é executada no máximo uma vez por janela; falha de destino nunca dispara segundo clique.
- O timeout de destino é um teto de 12 segundos; a conclusão depende dos sinais estruturais, não do tempo transcorrido.
- Esta etapa abre e confirma o formulário PIX, mas não preenche, seleciona, envia ou cadastra uma chave PIX.
- Todo comportamento novo começa pelo ciclo RED → GREEN → REFACTOR.

---

### Task 1: Serviço de confirmação do PIN e inspeção estrutural do formulário PIX

**Files:**
- Create: `src/main/services/pix-password-confirmation.ts`
- Test: `test/pix-password-confirmation.test.ts`

**Interfaces:**
- Consumes: `SpaHandle` de `src/main/services/spa-navigation.ts`; o contexto retornado por `waitForUniqueWithdrawalPasswordModalSurface(page, timeoutMs)`.
- Produces:
  ```ts
  export type PixPasswordConfirmationReason =
    | "source-invalid"
    | "confirm-action-absent"
    | "confirm-action-ambiguous"
    | "confirm-action-failed"
    | "destination-not-confirmed";

  export interface PixAddFormSignals {
    routeActive10: boolean;
    visiblePinGrids: number;
    visibleKeyboards: number;
    visibleDialogs: number;
    visibleInputs: number;
    visibleSelectors: number;
    enabledPrimaryActions: number;
    hasPixSemantic: boolean;
    ready: boolean;
  }

  export interface PixPasswordConfirmationResult {
    ok: boolean;
    reason?: PixPasswordConfirmationReason;
    diag?: string;
  }

  export async function confirmExistingWithdrawalPassword(
    surface: SpaHandle,
  ): Promise<PixPasswordConfirmationResult>;

  export async function inspectPixAddForm(
    surface: SpaHandle,
    routeActive10: boolean,
  ): Promise<PixAddFormSignals>;
  ```

- [ ] **Step 1: Write the failing origin-action tests**

Create `test/pix-password-confirmation.test.ts` with a fake `SpaHandle` whose page-world DOM exposes a visible `.ui-popup.ui-dialog`, a six-cell PIN grid, and enabled `.ui-button` controls. Assert that exactly one eligible `Próximo` control produces one locator click:

```ts
test("confirma uma vez o PIN completo no modal resolvido", async () => {
  const { surface, clicks } = withPinConfirmationSurface({
    filledCells: 6,
    buttons: [{ text: "Próximo", disabled: false }],
  });

  const result = await confirmExistingWithdrawalPassword(surface);

  assert.deepEqual(result, { ok: true });
  assert.equal(clicks(), 1);
});
```

Add independent tests that assert zero clicks for a five-cell PIN, two enabled eligible controls, an empty/incompatible label, and a disabled control. The fake locator must expose `locator(...).count()`, `nth(index)`, and `click()` so the test verifies the browser-locator path rather than a synthetic page click.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```powershell
npm test -- --test-name-pattern "confirma uma vez o PIN completo|recusa PIN incompleto|recusa confirmacao ambigua|recusa botao desabilitado"
```

Expected: FAIL because `pix-password-confirmation.js` does not exist and the exported confirmation function is unavailable.

- [ ] **Step 3: Implement the minimal guarded source action**

Create `src/main/services/pix-password-confirmation.ts`. In the page-world inspection, use local DOM helpers only:

```ts
const visible = (element: Element) => {
  const rect = element.getBoundingClientRect();
  const style = globalThis.getComputedStyle(element);
  return style.display !== "none"
    && style.visibility !== "hidden"
    && rect.width > 8
    && rect.height > 8;
};

const normalize = (value: string | null | undefined) => (value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/\s+/g, " ")
  .trim()
  .toLowerCase();
```

Inspect only visible roots matching `.ui-popup.ui-dialog`. An eligible source root must contain exactly one visible `.ui-password-input`, exactly six cells, all six filled by text or visible marker, and exactly one visible enabled `.ui-button` whose normalized label is one of `proximo`, `confirmar`, `next`, or `continue`. Return a root/button index and count-only diagnostics from `evaluate`.

Outside `evaluate`, reject zero or multiple eligible roots/actions. Click the verified action with a Patchright locator scoped to the verified modal root:

```ts
await surface
  .locator(".ui-popup.ui-dialog")
  .nth(source.modalIndex)
  .locator(".ui-button")
  .nth(source.buttonIndex)
  .click({ timeout: 1_500 });
```

Catch only locator action failure and return `confirm-action-failed`; never retry or call `.click()` from page JavaScript.

- [ ] **Step 4: Run the focused origin-action tests to verify GREEN**

Run:

```powershell
npm test -- --test-name-pattern "confirma uma vez o PIN completo|recusa PIN incompleto|recusa confirmacao ambigua|recusa botao desabilitado"
```

Expected: PASS, including a single observed locator click only in the valid case.

- [ ] **Step 5: Write the failing destination-signal tests**

Extend `test/pix-password-confirmation.test.ts` with a fake visible modal for the post-click state. Assert that `inspectPixAddForm(surface, true)` returns `ready: true` only for two visible inputs, one visible `.ui-select__reference`, one enabled primary button, no visible PIN grid/keyboard, exactly one dialog, and a `pix` semantic reinforcement:

```ts
test("reconhece o formulario PIX apenas com todos os sinais estruturais", async () => {
  const { surface } = withPixAddFormSurface({
    routeActive10: true,
    visibleInputs: 2,
    visibleSelectors: 1,
    enabledPrimaryActions: 1,
    visiblePinGrids: 0,
    visibleKeyboards: 0,
    visibleDialogs: 1,
    text: "Adicionar PIX",
  });

  assert.equal((await inspectPixAddForm(surface, true)).ready, true);
});
```

Add tests that reject: text PIX sozinho, rota fora de `active=10`, PIN ainda visível, teclado ainda visível, diálogo duplicado, input ausente, seletor ausente, ou ação primária ausente. Assertions must inspect only counts/booleans, never input values.

- [ ] **Step 6: Run the focused destination tests to verify RED**

Run:

```powershell
npm test -- --test-name-pattern "reconhece o formulario PIX|rejeita texto PIX sozinho|rejeita PIN visivel|rejeita rota fora"
```

Expected: FAIL because `inspectPixAddForm` is not implemented or does not enforce every required signal.

- [ ] **Step 7: Implement the destination inspector**

In `pix-password-confirmation.ts`, inspect only visible `.ui-popup.ui-dialog` roots and aggregate:

```ts
const ready =
  routeActive10
  && visiblePinGrids === 0
  && visibleKeyboards === 0
  && visibleDialogs === 1
  && visibleInputs === 2
  && visibleSelectors >= 1
  && enabledPrimaryActions >= 1
  && hasPixSemantic;
```

Count inputs, selectors, and enabled `.ui-button` inside the one visible dialog only. Detect `hasPixSemantic` from normalized dialog text containing `pix`. Do not read, return, or log the input values.

- [ ] **Step 8: Run the complete service test file and commit**

Run:

```powershell
npm test -- test/pix-password-confirmation.test.ts
```

Expected: PASS.

Commit only the service and test:

```powershell
git add src/main/services/pix-password-confirmation.ts test/pix-password-confirmation.test.ts
git commit -m "feat(pix): confirm withdrawal password prompt"
```

### Task 2: Espera condicional de destino PIX sem segundo clique

**Files:**
- Modify: `src/main/services/pix-password-confirmation.ts`
- Modify: `test/pix-password-confirmation.test.ts`

**Interfaces:**
- Consumes: `inspectPixAddForm(surface, routeActive10)` from Task 1 and `getCurrentRoute(surface)` from `src/main/services/spa-navigation.ts`.
- Produces:
  ```ts
  export async function waitForPixAddForm(
    surface: SpaHandle,
    timeoutMs: number,
  ): Promise<PixAddFormSignals>;
  ```

- [ ] **Step 1: Write the failing conditional-wait tests**

Add a fake surface whose state sequence is PIN-removing first and form-complete on the third inspection. Assert it waits and returns ready without invoking any action:

```ts
test("aguarda o formulario PIX condicionalmente sem novo clique", async () => {
  const { surface, waits, clicks } = withDelayedPixAddFormSurface({ readyOnInspection: 3 });

  const result = await waitForPixAddForm(surface, 1_000);

  assert.equal(result.ready, true);
  assert.equal(waits(), 2);
  assert.equal(clicks(), 0);
});
```

Add a timeout test that leaves one PIN grid visible and asserts `ready: false`, plus count-only diagnostics from the final state.

- [ ] **Step 2: Run the focused wait tests to verify RED**

Run:

```powershell
npm test -- --test-name-pattern "aguarda o formulario PIX condicionalmente|nao confirma destino incompleto"
```

Expected: FAIL because `waitForPixAddForm` is unavailable.

- [ ] **Step 3: Implement the polling ceiling**

Use a 180 ms poll and make the final inspection after the deadline. Read the route from the same live `SpaHandle` through `getCurrentRoute(surface)`, derive `routeActive10` from `route.name === "withdraw"` or `route.path === "/home/withdraw"` plus `route.query.active === "10"`, then call `inspectPixAddForm`. Return immediately only if `signals.ready` is true:

```ts
const startedAt = Date.now();
while (Date.now() - startedAt < timeoutMs) {
  const route = await getCurrentRoute(surface);
  const signals = await inspectPixAddForm(surface, isWithdrawalActive10(route));
  if (signals.ready) return signals;
  await surface.waitForTimeout(180).catch(() => undefined);
}
return inspectPixAddForm(surface, isWithdrawalActive10(await getCurrentRoute(surface)));
```

The function performs no click and keeps no shared mutable state.

- [ ] **Step 4: Run the focused wait tests to verify GREEN**

Run:

```powershell
npm test -- --test-name-pattern "aguarda o formulario PIX condicionalmente|nao confirma destino incompleto"
```

Expected: PASS, with zero action clicks in both tests.

- [ ] **Step 5: Commit the conditional wait**

```powershell
git add src/main/services/pix-password-confirmation.ts test/pix-password-confirmation.test.ts
git commit -m "feat(pix): wait for add pix form"
```

### Task 3: Integrar o resultado no runtime, contrato e resumo

**Files:**
- Modify: `src/main/services/automation-runtime.ts:49-56,849-976`
- Modify: `src/shared/contracts.ts:456-463`
- Modify: `src/renderer/components/ControlPanel.tsx:88-100`
- Test: `test/pix-password-confirmation.test.ts`

**Interfaces:**
- Consumes: `confirmExistingWithdrawalPassword(modalSurface.surface)` and `waitForPixAddForm(modalSurface.surface, PIX_MS(12000))`.
- Produces: status `pix_add_form_ready` and step `pix-password-confirmation` in `PixKeyRegistrationControlResult`.

- [ ] **Step 1: Write the failing contract and orchestration test**

Add a focused test that imports the result union through a small typed fixture, proving `pix_add_form_ready` is accepted. In the service test, add a composition test in which one successful `confirmExistingWithdrawalPassword` call is followed by a delayed ready destination and assert the observed action count remains one:

```ts
test("a confirmacao bem-sucedida produz um unico clique antes do destino PIX", async () => {
  const { source, clicks, destination } = withConfirmThenPixDestination();

  assert.deepEqual(await confirmExistingWithdrawalPassword(source), { ok: true });
  assert.equal((await waitForPixAddForm(destination, 1_000)).ready, true);
  assert.equal(clicks(), 1);
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```powershell
npm test -- --test-name-pattern "produz um unico clique antes do destino PIX"
npm run check
```

Expected: the test passes only once the service composition exists; `npm run check` initially fails because `pix_add_form_ready` is not yet in the contract/runtime/renderer unions.

- [ ] **Step 3: Make the minimal runtime integration**

Import the two Task 1/2 functions in `automation-runtime.ts`. Immediately after `fillExistingWithdrawalPassword` returns success:

```ts
step = "pix-password-confirmation";
const confirmation = await confirmExistingWithdrawalPassword(modalSurface.surface);
if (!confirmation.ok) {
  throw new Error(
    `confirmacao da senha de saque indisponivel (${confirmation.reason ?? "desconhecido"}${confirmation.diag ? `; ${confirmation.diag}` : ""})`,
  );
}
const pixAddForm = await waitForPixAddForm(modalSurface.surface, PIX_MS(12000));
if (!pixAddForm.ready) {
  throw new Error(
    `formulario PIX nao confirmado (${formatPixAddFormDiagnostics(pixAddForm)})`,
  );
}
resultStatus = "pix_add_form_ready";
```

Define `formatPixAddFormDiagnostics` locally in the new service (or export it) as a count/boolean-only formatter. Do not place raw modal text or form values in the error.

Extend both shared unions exactly:

```ts
status: /* existing */ | "pix_add_form_ready";
step: /* existing */ | "pix-password-confirmation";
```

Update `summarizePixRegistrationResults` so the UI separately counts `pix_add_form_ready` as `formulario(s) PIX pronto(s)`.

- [ ] **Step 4: Run targeted tests and typecheck to verify GREEN**

Run:

```powershell
npm test -- test/pix-password-confirmation.test.ts
npm run check
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Run the full suite and commit**

Run:

```powershell
npm test
npm run check
git status --short
```

Expected: all tests and typecheck pass; status lists only user-owned `M package-lock.json` beyond the intended source changes.

Commit only intended files:

```powershell
git add src/main/services/automation-runtime.ts src/main/services/pix-password-confirmation.ts src/shared/contracts.ts src/renderer/components/ControlPanel.tsx test/pix-password-confirmation.test.ts
git commit -m "feat(pix): verify add pix form after pin"
```

## Verification and user checkpoint

- [ ] Start the user-managed application with `npm run dev` from this worktree.
- [ ] On a disposable profile already at the PIN prompt, run the PIX preparation action once and verify exactly one `Próximo` click occurs.
- [ ] Verify the run reports `pix_add_form_ready` only after the Add PIX form is visible.
- [ ] Verify no CPF/key/name field is changed and no PIX submission occurs.
- [ ] Run the same check across multiple compatible windows to confirm each resolves its own modal independently.


# Confirmacao segura da senha de saque Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirmar uma unica vez a senha de saque ja preenchida e concluir somente ao detectar a superficie real de saque.

**Architecture:** `withdrawal-password-setup.ts` ganha uma operacao pequena para validar os dois PINs e invocar o controle semantico de confirmacao no main world. `AutomationRuntimeService` a chama uma vez, reutiliza o classificador de destino existente e grava o checkpoint `confirmed` somente quando o destino e `withdrawal_ready`.

**Tech Stack:** TypeScript ESM, Patchright, Node test runner, Electron.

## Global Constraints

- Nao usar host, marca, cor, coordenada ou rota fixa como identificador.
- Nao registrar senha em log, metrica, erro ou resultado IPC.
- Exigir dois PINs visiveis e preenchidos antes do clique.
- Acionar somente um controle de confirmacao inequivoco, uma unica vez; nenhuma repeticao de submit.
- Sucesso exige `withdrawal_ready`; sumico de modal ou URL isolada nao contam.
- Manter limite de duas janelas e isolamento por sessao/run/perfil.
- Nao abrir nem cadastrar chave PIX neste corte.

---

### Task 1: Confirmacao semantica da tela de senha

**Files:**
- Modify: `src/main/services/withdrawal-password-setup.ts`
- Modify: `test/withdrawal-password-setup.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WithdrawalPasswordConfirmationResult {
    ok: boolean;
    reason?: "surface-invalid" | "confirm-action-absent" | "confirm-action-ambiguous" | "confirm-action-failed";
    diag?: string;
  }
  export async function confirmWithdrawalPasswordSetup(spa: SpaHandle): Promise<WithdrawalPasswordConfirmationResult>;
  ```
- Consumes: os dois PINs preenchidos por `fillWithdrawalPasswordSetup`.

- [ ] **Step 1: Write the failing tests**

  Adicionar uma superficie fake com dois PINs preenchidos e um botao `Confirmar` que conta invocacoes. Cobrir os tres contratos abaixo:

  ```ts
  test("confirma uma unica acao semantica apos os dois PINs", async () => {
    await withConfirmationSurface({ pinCount: [6, 6], confirmControls: 1 }, async (page, confirmCount) => {
      const result = await confirmWithdrawalPasswordSetup(page);
      assert.deepEqual(result, { ok: true });
      assert.equal(confirmCount(), 1);
    });
  });

  test("nao confirma quando os dois PINs nao estao completos", async () => {
    await withConfirmationSurface({ pinCount: [6, 5], confirmControls: 1 }, async (page, confirmCount) => {
      const result = await confirmWithdrawalPasswordSetup(page);
      assert.equal(result.reason, "surface-invalid");
      assert.equal(confirmCount(), 0);
    });
  });

  test("recusa controles de confirmacao ambiguos sem clicar", async () => {
    await withConfirmationSurface({ pinCount: [6, 6], confirmControls: 2 }, async (page, confirmCount) => {
      const result = await confirmWithdrawalPasswordSetup(page);
      assert.equal(result.reason, "confirm-action-ambiguous");
      assert.equal(confirmCount(), 0);
    });
  });
  ```

- [ ] **Step 2: Run the tests to verify RED**

  Run: `npm test -- --test-name-pattern "confirma uma unica acao semantica"`

  Expected: FAIL because `confirmWithdrawalPasswordSetup` is not exported.

- [ ] **Step 3: Implement the minimal semantic confirmation**

  No main world, localizar os dois `.ui-password-input` visiveis, exigir seis marcadores preenchidos em cada um e encontrar controles visiveis com texto/`aria-label` normalizado igual a `confirmar` ou `confirm`. Aceitar somente um candidato. Tentar primeiro o listener Vue `onClick` vivo; se nao existir, executar `dispatchEvent(new MouseEvent("click", ...))` no proprio candidato. Retornar somente diagnosticos estruturais, como `fields=2 controls=1`; nunca incluir o PIN.

- [ ] **Step 4: Run the focused tests to verify GREEN**

  Run: `npm test -- --test-name-pattern "confirma uma unica acao semantica|nao confirma quando os dois PINs|recusa controles de confirmacao ambiguos"`

  Expected: PASS; a contagem de clique do fake e 1 somente no primeiro caso.

- [ ] **Step 5: Commit Task 1**

  ```powershell
  git add -- src/main/services/withdrawal-password-setup.ts test/withdrawal-password-setup.test.ts
  git commit -m "feat(pix): confirm withdrawal password setup"
  ```

### Task 2: Confirmacao de destino e checkpoint do run

**Files:**
- Modify: `src/main/services/automation-runtime.ts`
- Modify: `test/withdrawal-password-setup.test.ts`

**Interfaces:**
- Consumes: `confirmWithdrawalPasswordSetup(spa)` da Task 1 e `waitForWithdrawalManagementDestination(page, timeoutMs)` existente.
- Produces: `pixWithdrawalPasswordStage: "confirmed"` somente depois de `withdrawal_ready`.

- [ ] **Step 1: Write the failing orchestration tests**

  Extrair uma pequena funcao testavel, no modulo de senha, que recebe uma confirmacao e uma espera de destino injetada:

  ```ts
  export async function confirmAndVerifyWithdrawalPasswordSetup(
    spa: SpaHandle,
    waitForDestination: () => Promise<"needs_withdrawal_password" | "withdrawal_ready" | "unknown">,
  ): Promise<WithdrawalPasswordConfirmationResult>;
  ```

  Cobrir sucesso com `withdrawal_ready` e falha quando a espera retorna `needs_withdrawal_password` ou `unknown`; nos tres casos, o controle deve receber no maximo um clique.

- [ ] **Step 2: Run the tests to verify RED**

  Run: `npm test -- --test-name-pattern "confirmacao da senha exige destino de saque"`

  Expected: FAIL because `confirmAndVerifyWithdrawalPasswordSetup` does not exist.

- [ ] **Step 3: Implement the minimal orchestration**

  Depois de `second-field-filled` em `runPixWithdrawalEntryForProfile`, chamar a confirmacao uma vez. Em seguida, aguardar `waitForWithdrawalManagementDestination(session.page, PIX_MS(12000))`. Se o retorno nao for `withdrawal_ready`, encerrar a etapa `withdrawal-password-confirmation` com erro e sem novo clique. Em sucesso, gravar o checkpoint `confirmed`, definir `resultStatus = "withdrawal_ready"` e manter o restante do fluxo parado antes do PIX.

- [ ] **Step 4: Run focused tests and whole suite**

  Run:

  ```powershell
  npm test -- --test-name-pattern "confirmacao da senha exige destino de saque"
  npm test
  npm run check
  ```

  Expected: todos passam.

- [ ] **Step 5: Commit Task 2**

  ```powershell
  git add -- src/main/services/automation-runtime.ts src/main/services/withdrawal-password-setup.ts test/withdrawal-password-setup.test.ts
  git commit -m "feat(pix): verify withdrawal password confirmation"
  ```

### Task 3: Validacao manual controlada

**Files:**
- Modify: nenhum

**Interfaces:**
- Consumes: build da Task 2.
- Produces: evidência manual de que a pagina chega ao saque sem abrir o cadastro PIX.

- [ ] **Step 1: Start the development application**

  Run: `npm run dev`

  Expected: Electron recompila a aplicacao sem erro.

- [ ] **Step 2: Execute uma conta descartavel**

  Acionar o fluxo PIX em uma unica janela com senha de saque ausente. Confirmar visualmente que os dois PINs sao preenchidos, a tela de senha e submetida uma vez e a superficie de saque/conta de recebimento aparece.

- [ ] **Step 3: Confirmar o limite de escopo**

  Verificar que nenhum modal de cadastro PIX foi aberto e que o log final e `withdrawal_ready`/checkpoint `confirmed`, sem senha exposta.

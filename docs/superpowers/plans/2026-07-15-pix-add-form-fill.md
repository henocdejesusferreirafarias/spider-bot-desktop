# PIX PHONE Add Form Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preencher e verificar o formulário vivo de chave PIX PHONE sem enviar o cadastro.

**Architecture:** Um serviço novo resolve o modal PIX vivo, seleciona PHONE e atualiza cada campo pelo modelo/evento vivo da SPA, relendo o efeito no DOM. A camada SQLite fornece uma reserva PHONE idempotente por perfil; a automação integra o serviço após `pix_add_form_ready` e termina em `pix_add_form_filled`.

**Tech Stack:** TypeScript ESM estrito, Patchright, Node test e SQLite `node:sqlite`.

## Global Constraints

- Implementar apenas `PHONE`; `PixRegistrationType` continua `"PHONE"`.
- Não reutilizar o fluxo legado de cadastro PIX.
- Não clicar em “Confirmar”, não enviar o formulário, não consumir a chave reservada.
- Não depender de host, viewport, coordenadas, texto de usuário ou ordem global de elementos.
- Diagnósticos não podem conter nome, CPF, telefone ou PIN.
- Cada janela deve ter modal, reserva e waits próprios.
- A origem precisa ser `/home/withdraw?active=10`, sem PIN-grid nem teclado visível.
- Usar `apply_patch`; não incluir `package-lock.json` em commits.

---

## File Structure

- `src/main/services/database.ts`: reserva PHONE idempotente e persistente por perfil.
- `test/database.test.ts`: reuso da reserva e preservação após reinício.
- `src/main/services/pix-add-form-fill.ts`: modal vivo, seleção PHONE, escrita e confirmação dos campos.
- `test/pix-add-form-fill.test.ts`: fake SPA para seleção, campos, nome bloqueado e ausência de envio.
- `src/main/services/automation-runtime.ts`: integra a nova etapa.
- `src/shared/contracts.ts`: expõe o resultado e a etapa novos.

### Task 1: Tornar a reserva PHONE retomável

**Files:**
- Modify: `src/main/services/database.ts:894,2242-2267`
- Modify: `test/database.test.ts:135-175`

**Interfaces:**
- Consumes: `reservePixPhoneKey(profileId: string): PixPhoneKeyRecord | undefined`.
- Produces: a mesma função retorna primeiro uma chave `reserved` daquele perfil; a inicialização não libera reservas automaticamente.

- [ ] **Step 1: Write failing tests**

```ts
test("reservePixPhoneKey reutiliza a reserva existente do mesmo perfil", () => {
  const first = db.reservePixPhoneKey(profile.id)!;
  const second = db.reservePixPhoneKey(profile.id)!;
  assert.equal(second.id, first.id);
  assert.equal(db.listPixPhoneKeys().filter((key) => key.status === "reserved").length, 1);
});

test("a inicializacao preserva reserva PIX para retomada", () => {
  const reserved = db.reservePixPhoneKey(profile.id)!;
  const reopened = openDatabaseAtSamePath();
  assert.equal(reopened.reservePixPhoneKey(profile.id)!.id, reserved.id);
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- --test-name-pattern "reutiliza a reserva existente|preserva reserva PIX"`

Expected: FAIL because the current query selects only `available` keys and startup releases reservations.

- [ ] **Step 3: Implement the minimum reservation behavior**

```ts
const existing = this.db.prepare(`
  SELECT * FROM pix_phone_keys
  WHERE status = 'reserved' AND assigned_profile_id = ?
  ORDER BY assigned_at ASC LIMIT 1
`).get(profileId) as PixPhoneKeyRow | undefined;
if (existing) return this.getPixPhoneKey(existing.id);
```

Keep the conditional `UPDATE ... status = 'available'` for a newly selected key. Remove only the startup call to `releaseInterruptedPixPhoneKeyReservations`; retain the explicit release method for a future user-authorized cancellation.

- [ ] **Step 4: Verify the tests pass**

Run: `npm test -- --test-name-pattern "reutiliza a reserva existente|preserva reserva PIX|reservePixPhoneKey"`

Expected: PASS; a second profile still cannot receive the first profile’s key.

- [ ] **Step 5: Commit**

```powershell
git add src/main/services/database.ts test/database.test.ts
git commit -m "fix(pix): retain phone key reservations"
```

### Task 2: Criar o serviço de preenchimento vivo

**Files:**
- Create: `src/main/services/pix-add-form-fill.ts`
- Create: `test/pix-add-form-fill.test.ts`

**Interfaces:**

```ts
export interface PixPhoneFormData {
  realName: string;
  phoneNumber: string;
  cpf: string;
}

export interface PixPhoneFormFillResult {
  ok: boolean;
  nameMode: "filled" | "validated-disabled";
  reason?: "surface-invalid" | "phone-type-not-confirmed" | "name-mismatch" | "field-not-writable" | "field-not-confirmed";
  diag?: string;
}

export async function fillPixPhoneAddForm(
  surface: SpaHandle,
  data: PixPhoneFormData,
): Promise<PixPhoneFormFillResult>;
```

- [ ] **Step 1: Write failing pure-helper tests**

```ts
assert.deepEqual(resolvePixPhoneFormRoles([
  { index: 0, precedesSelector: true, followsSelector: false, writable: true },
  { index: 1, precedesSelector: false, followsSelector: true, writable: true },
  { index: 2, precedesSelector: false, followsSelector: true, writable: true },
]), { nameIndex: 0, phoneIndex: 1, cpfIndex: 2 });
assert.equal(normalizeDigits("(11) 98888-7777"), "11988887777");
assert.equal(normalizeIdentity("Eduardo Vargas Pinto"), normalizeIdentity(" eduardo  vargas pinto "));
```

- [ ] **Step 2: Verify the helpers fail**

Run: `npm test -- --test-name-pattern "PIX PHONE roles|normaliza telefone|normaliza nome"`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement role and normalization helpers**

```ts
export function resolvePixPhoneFormRoles(inputs: PixPhoneInputDescriptor[]) {
  const name = inputs.filter((input) => input.precedesSelector).at(-1);
  const after = inputs.filter((input) => input.followsSelector && input.writable);
  return { nameIndex: name?.index, phoneIndex: after[0]?.index, cpfIndex: after[1]?.index };
}
```

Require one name candidate and two writable inputs after the selector. Identity normalizes Unicode, whitespace and case; phone/CPF retain digits only.

- [ ] **Step 4: Verify the helpers pass**

Run: `npm test -- --test-name-pattern "PIX PHONE roles|normaliza telefone|normaliza nome"`

Expected: PASS.

- [ ] **Step 5: Write failing live-modal tests**

The fake `SpaHandle` must expose one visible PIX modal, duplicate selector wrappers that share one action, a Vue-style `onUpdate:modelValue` handler, and a PHONE option.

```ts
test("seleciona PHONE e espera tres campos antes de escrever", async () => {
  const result = await fillPixPhoneAddForm(surface, data);
  assert.equal(result.ok, true);
  assert.equal(surface.selectedType(), "PHONE");
  assert.equal(surface.submitClicks(), 0);
});

test("preenche nome vazio e valida nome bloqueado correspondente", async () => {
  assert.equal((await fillPixPhoneAddForm(emptyNameSurface, data)).nameMode, "filled");
  assert.equal((await fillPixPhoneAddForm(lockedNameSurface, data)).nameMode, "validated-disabled");
});

test("recusa nome bloqueado divergente sem escrever telefone ou CPF", async () => {
  const result = await fillPixPhoneAddForm(divergentNameSurface, data);
  assert.equal(result.reason, "name-mismatch");
  assert.equal(divergentNameSurface.writeCount(), 0);
});
```

- [ ] **Step 6: Verify the live-modal tests fail**

Run: `npm test -- --test-name-pattern "seleciona PHONE|nome vazio|nome bloqueado divergente"`

Expected: FAIL because `fillPixPhoneAddForm` is absent.

- [ ] **Step 7: Implement modal, selection and verified write**

Within page callbacks, resolve one visible `.ui-popup.ui-dialog` with PIX semantic, no visible password grid/keyboard and exactly the expected active route. Resolve the selector inside that root, invoke its live Vue handler or dispatch one DOM event, then poll for at most `12_000` ms until the selector normalizes to `phone` and exactly three inputs are visible.

Write through `onUpdate:modelValue` if exposed; otherwise use the native value setter followed by `input` and `change`. Reinspect after every write. A blank writable name is filled; a blocked name is only compared; any nonblank mismatch fails. No `.ui-button` may be queried or clicked.

- [ ] **Step 8: Verify the live-modal tests pass**

Run: `npm test -- --test-name-pattern "seleciona PHONE|nome vazio|nome bloqueado divergente|nao envia"`

Expected: PASS; each success confirms values and records zero submit clicks.

- [ ] **Step 9: Commit**

```powershell
git add src/main/services/pix-add-form-fill.ts test/pix-add-form-fill.test.ts
git commit -m "feat(pix): fill phone add form safely"
```

### Task 3: Integrar o resultado no fluxo novo

**Files:**
- Modify: `src/main/services/automation-runtime.ts:842-1010`
- Modify: `src/shared/contracts.ts:451-462`
- Test: `test/automation-runtime.test.ts` or a new focused runtime control test.

**Interfaces:**
- Consumes: `fillPixPhoneAddForm`, `DatabaseService.reservePixPhoneKey`, `ProfileAccountRecord`.
- Produces: `pix_add_form_filled` e etapa `pix-add-form-fill`.

- [ ] **Step 1: Write failing runtime data-resolution tests**

```ts
assert.deepEqual(resolvePixPhoneFillData(account, key), {
  realName: "Nome do Perfil",
  cpf: "12345678901",
  phoneNumber: "11988887777",
});
assert.throws(() => resolvePixPhoneFillData(accountWithoutCpf, key), /CPF/);
```

Also assert that missing name, CPF or available PHONE key prevents `fillPixPhoneAddForm` from being called.

- [ ] **Step 2: Verify the runtime test fails**

Run: `npm test -- --test-name-pattern "dados PHONE para preenchimento|nao preenche sem chave"`

Expected: FAIL because the helper and result path do not exist.

- [ ] **Step 3: Integrate after the existing form-destination check**

```ts
const pixKey = this.database.reservePixPhoneKey(profile.id);
const fillData = resolvePixPhoneFillData(account, pixKey);
const filled = await fillPixPhoneAddForm(spa, fillData);
if (!filled.ok) throw new Error(`formulario PIX nao confirmou preenchimento (${filled.reason}${filled.diag ? `; ${filled.diag}` : ""})`);
resultStatus = "pix_add_form_filled";
```

Extend local result/step unions and `PixKeyRegistrationControlResult`. Do not call `markPixPhoneKeyUsed`, `markProfilePixKeyRegistered` or any submit routine. Preserve the reservation on every failure path.

- [ ] **Step 4: Verify the runtime test passes**

Run: `npm test -- --test-name-pattern "dados PHONE para preenchimento|nao preenche sem chave"`

Expected: PASS; `pix_add_form_filled` occurs only after all fields are confirmed.

- [ ] **Step 5: Run complete verification**

Run: `npm test; npm run check; git diff --check`

Expected: all tests pass, both TypeScript projects typecheck, and there are no whitespace errors.

- [ ] **Step 6: Commit**

```powershell
git add src/main/services/automation-runtime.ts src/shared/contracts.ts test/automation-runtime.test.ts
git commit -m "feat(pix): complete phone form fill stage"
```

## Future EMAIL Extension

This plan intentionally retains `PixRegistrationType = "PHONE"`. The extension seam is the new modal-resolution and verified-write service: a later `EmailFormData` and EMAIL field-role contract reuse only modal resolution, event/model write and diagnostics. PHONE reservation remains separate and is never interpreted as e-mail data.

## Plan Self-Review

- Spec coverage: Tasks 1–3 cover retained reservation, unique live modal, PHONE selection, both name modes, field checks, no-submit behavior, status exposure and verification.
- Placeholder scan: no unresolved markers or unspecified test/action remains.
- Type consistency: Task 2 defines `PixPhoneFormData`, `PixPhoneFormFillResult` and `fillPixPhoneAddForm`; Task 3 consumes those exact names and introduces `pix_add_form_filled` before returning it.

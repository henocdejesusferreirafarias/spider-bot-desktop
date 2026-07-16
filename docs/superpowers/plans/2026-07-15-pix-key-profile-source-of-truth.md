# Chave PIX do Perfil como Fonte de Verdade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Persistir a chave PIX confirmada no perfil, removê-la do estoque e usar esse parâmetro no preflight.

**Architecture:** pix_phone_keys passa a guardar somente estoque disponível e reservas transitórias. profile_accounts recebe a chave PIX confirmada, cifrada e independente do telefone da conta. Uma transação local grava a chave no perfil e apaga a reserva apenas depois da confirmação estrutural da plataforma.

**Tech Stack:** TypeScript ESM estrito, node:sqlite (DatabaseSync), Electron, React 19 e tsx --test.

## Global Constraints

- Trabalhar apenas em spider-bot-desktop e não modificar package-lock.json.
- A chave PIX exata é cifrada em repouso, mascarada na interface e nunca escrita em logs.
- phoneNumber da conta e a chave PIX são dados diferentes.
- Chaves confirmadas saem do estoque; reutilização entre plataformas está fora de escopo e pertence à issue #25.
- Evidência insuficiente deixa somente o perfil afetado para revisão e mantém a chave pendente.
- Cada tarefa começa com teste focal e termina com commit; concluir com npm test e npm run check.

---

## Estrutura de arquivos

- src/shared/contracts.ts: contrato ProfileAccountRecord.
- src/main/services/database.ts: coluna, migração, consumo atômico e mapeamento.
- src/main/services/pix-phone-key-lifecycle.ts: decisão pura de preflight.
- src/main/services/automation-runtime.ts: integração do ciclo no cadastro PIX.
- src/main/services/browser-runtime.ts e src/renderer/components/ProfileDetailModal.tsx: apresentação correta da chave.
- src/renderer/lib/pix-registration-summary.ts e ControlPanel.tsx: resumo compacto e novos rótulos.
- test/database.test.ts, test/pix-phone-key-lifecycle.test.ts, test/mask-sensitive-value.test.ts e test/pix-registration-summary.test.ts: regressões.

### Task 1: Persistir a chave PIX e consumir o estoque atomicamente

**Files:**
- Modify: src/shared/contracts.ts:173-190
- Modify: src/main/services/database.ts:200-211, 893-900, 995-1060, 2190-2214, 2443-2451, 2625-2690, 3035-3055
- Modify: test/database.test.ts:230-300

**Interfaces:**
- Produces: ProfileAccountRecord.pixPhoneKey?: string.
- Produces: DatabaseService.confirmPixPhoneKeyRegistration(keyId, { profileId, origin }): boolean.
- Produces: DatabaseService.migrateLegacyUsedPixPhoneKeys(): number.

- [ ] **Step 1: Write failing database tests**

Add the following tests beside the existing lifecycle tests, reusing the file's profile fixture.

~~~ts
test("confirma chave PIX no perfil e a remove do estoque", () => {
  const profile = createProfile(db);
  db.addPixPhoneKeys("41980042690");
  const key = db.reservePixPhoneKey(profile.id, "run-a");
  assert.ok(key);
  assert.equal(db.markPixPhoneKeyPendingConfirmation(key.id, { profileId: profile.id, runId: "run-a" }), true);

  assert.equal(
    db.confirmPixPhoneKeyRegistration(key.id, { profileId: profile.id, origin: "Telefone" }),
    true,
  );
  assert.equal(db.getOrCreateProfileAccount(profile.id).pixPhoneKey, "41980042690");
  assert.equal(db.listPixPhoneKeys().some((candidate) => candidate.id === key.id), false);
});

test("nao consome chave PIX pendente de outro perfil", () => {
  const owner = createProfile(db);
  const other = createProfile(db);
  db.addPixPhoneKeys("41980042690");
  const key = db.reservePixPhoneKey(owner.id, "run-a");
  assert.ok(key);
  db.markPixPhoneKeyPendingConfirmation(key.id, { profileId: owner.id, runId: "run-a" });

  assert.equal(db.confirmPixPhoneKeyRegistration(key.id, { profileId: other.id, origin: "Telefone" }), false);
  assert.equal(db.findPendingPixPhoneKey(owner.id)?.id, key.id);
  assert.equal(db.getOrCreateProfileAccount(other.id).pixPhoneKey, undefined);
});
~~~

Add a migration test: seed a legacy used key for a real profile, call migrateLegacyUsedPixPhoneKeys(), then assert the key exists on the profile and no used row remains. Seed an orphan used row and assert it is deleted without creating an account.

- [ ] **Step 2: Run the focal test and verify it fails**

Run: npm test -- --test-name-pattern="confirma chave PIX no perfil|nao consome chave PIX|migra chave PIX usada"

Expected: FAIL because the account property and database methods do not exist.

- [ ] **Step 3: Add the encrypted profile field and idempotent schema upgrade**

Add pixPhoneKey to ProfileAccountRecord and pix_phone_key_enc to ProfileAccountRow. Add pix_phone_key_enc TEXT to the profile_accounts table creation SQL. Implement ensureProfileAccountPixKeyColumn() using PRAGMA table_info(profile_accounts); when absent, execute:

~~~ts
this.db.exec("ALTER TABLE profile_accounts ADD COLUMN pix_phone_key_enc TEXT;");
~~~

Call it during initialization before interrupted-run recovery. Extend setProfileAccount and mapProfileAccount to encrypt/decrypt pixPhoneKey with secureStore. New generated accounts initialise pixPhoneKey as undefined.

- [ ] **Step 4: Implement confirmation and legacy migration**

Replace markPixPhoneKeyUsed with confirmPixPhoneKeyRegistration. Use a DatabaseSync transaction that selects the key only where status is pending_confirmation and pending_profile_id equals opts.profileId; updates the profile account with the encrypted phone number, pix_key_registered_at and merged origin; and deletes the same key with the same guarded profile id. Return false without updating anything when the guarded row is absent.

Implement migrateLegacyUsedPixPhoneKeys() as an idempotent transaction. For every status used row, copy its decrypted phone number to its existing used_profile_id profile, preserving used_at as the registration time; delete the row even if the profile was deleted. Never change reserved or pending_confirmation rows. Call the migration immediately after the schema upgrade.

- [ ] **Step 5: Run the focal database tests**

Run: npm test -- --test-name-pattern="confirma chave PIX no perfil|nao consome chave PIX|migra chave PIX usada"

Expected: PASS. The key is persisted only on its owner and confirmed inventory records disappear.

- [ ] **Step 6: Commit**

~~~powershell
git add src/shared/contracts.ts src/main/services/database.ts test/database.test.ts
git commit -m "feat(pix): persist confirmed key on profile"
~~~

### Task 2: Decidir preflight com a chave persistida

**Files:**
- Modify: src/main/services/pix-phone-key-lifecycle.ts:1-86
- Modify: src/main/services/automation-runtime.ts:946-985, 1065-1072
- Modify: test/pix-phone-key-lifecycle.test.ts

**Interfaces:**
- Consumes: ProfileAccountRecord.pixPhoneKey and confirmPixPhoneKeyRegistration from Task 1.
- Produces: decision profile-used and result { status: "pix_key_registered", reservation: "none" }.

- [ ] **Step 1: Write failing pure-decision tests**

~~~ts
test("perfil com chave persistida e mascara compativel nao reserva estoque", () => {
  const decision = decidePixPhonePreflight({
    persistedPhoneNumber: "41980042690",
    accounts: [{ kind: "pix-phone", maskedPhone: "41***690" }],
  });
  assert.equal(decision, "profile-used");
  assert.deepEqual(pixResultForPreflight(decision), {
    status: "pix_key_registered",
    reservation: "none",
  });
});

test("perfil com chave persistida e evidencia insuficiente exige revisao", () => {
  assert.equal(
    decidePixPhonePreflight({
      persistedPhoneNumber: "41980042690",
      accounts: [{ kind: "pix-phone" }],
    }),
    "insufficient-evidence",
  );
});
~~~

Also add cases for a different mask (conflict) and no receiving account (insufficient-evidence). Keep existing clean, manual and pending tests.

- [ ] **Step 2: Run the focal lifecycle tests and verify they fail**

Run: npm test -- --test-name-pattern="chave persistida|preflight"

Expected: FAIL because persistedPhoneNumber and profile-used do not exist.

- [ ] **Step 3: Extend the pure decision**

Add persistedPhoneNumber?: string to PixPhonePreflightInput and profile-used to PixPhonePreflightDecision. Evaluate persisted evidence before pending/clean allocation:

~~~ts
if (input.persistedPhoneNumber) {
  if (!input.accounts.length) return "insufficient-evidence";
  const phoneAccounts = input.accounts.filter((account) => account.kind === "pix-phone");
  if (!phoneAccounts.length) return "conflict";
  if (phoneAccounts.some((account) =>
    account.maskedPhone && matchesMaskedPixPhone(account.maskedPhone, input.persistedPhoneNumber!),
  )) return "profile-used";
  return phoneAccounts.some((account) => !account.maskedPhone || !maskEvidence(account.maskedPhone))
    ? "insufficient-evidence"
    : "conflict";
}
~~~

Map profile-used to pix_key_registered with reservation none. A persisted key with unprovable evidence must never lead to a new reservation.

- [ ] **Step 4: Integrate the result in the runtime**

Read getOrCreateProfileAccount(profile.id).pixPhoneKey and pass it as persistedPhoneNumber. Treat profile-used as a successful run with no reservation. Replace both markPixPhoneKeyUsed calls with confirmPixPhoneKeyRegistration(keyId, { profileId: profile.id, origin: pixType }). Keep conflict/inconclusive branches unchanged: mark run failed, log review, retain the pending key and continue other profiles.

- [ ] **Step 5: Verify tests and types**

Run: npm test -- --test-name-pattern="chave persistida|preflight"

Expected: PASS.

Run: npm run check

Expected: PASS with no markPixPhoneKeyUsed references.

- [ ] **Step 6: Commit**

~~~powershell
git add src/main/services/pix-phone-key-lifecycle.ts src/main/services/automation-runtime.ts test/pix-phone-key-lifecycle.test.ts
git commit -m "feat(pix): reconcile profile key before allocation"
~~~

### Task 3: Mostrar a chave correta no perfil e no overlay

**Files:**
- Create: src/renderer/lib/mask-sensitive-value.ts
- Modify: src/main/services/browser-runtime.ts:8018-8030
- Modify: src/renderer/components/ProfileDetailModal.tsx:108-120
- Create: test/mask-sensitive-value.test.ts

**Interfaces:**
- Consumes: ProfileAccountRecord.pixPhoneKey.
- Produces: maskPixPhoneKey(value?: string): string.

- [ ] **Step 1: Write failing masking tests**

~~~ts
import assert from "node:assert/strict";
import test from "node:test";
import { maskPixPhoneKey } from "../src/renderer/lib/mask-sensitive-value.js";

test("mascara a chave PIX telefone sem exibir o numero completo", () => {
  assert.equal(maskPixPhoneKey("41980042690"), "41***690");
});

test("nao inventa uma chave PIX quando o valor esta ausente", () => {
  assert.equal(maskPixPhoneKey(undefined), "—");
});
~~~

- [ ] **Step 2: Run the focal test and verify it fails**

Run: npm test -- --test-name-pattern="mascara a chave PIX|nao inventa uma chave PIX"

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement safe presentation**

Implement maskPixPhoneKey by retaining the first two and final three normalized digits, returning — for an absent value. In ProfileDetailModal add a masked Chave PIX field and retain PIX cadastrado for the timestamp.

In browser-runtime.ts, include CHAVE PIX only when account.pixPhoneKey exists. Always show phoneNumber as CELULAR, never as CHAVE PIX. PixKeysPanel already permits actions only for available keys; Task 1 makes confirmed keys disappear naturally.

- [ ] **Step 4: Run focal test and typecheck**

Run: npm test -- --test-name-pattern="mascara a chave PIX|nao inventa uma chave PIX"

Expected: PASS.

Run: npm run check

Expected: PASS.

- [ ] **Step 5: Commit**

~~~powershell
git add src/main/services/browser-runtime.ts src/renderer/components/ProfileDetailModal.tsx src/renderer/lib/mask-sensitive-value.ts test/mask-sensitive-value.test.ts
git commit -m "fix(pix): show registered key independently from phone"
~~~

### Task 4: Compactar o feedback do painel PIX

**Files:**
- Create: src/renderer/lib/pix-registration-summary.ts
- Modify: src/renderer/components/ControlPanel.tsx:1-106, 613-651
- Create: test/pix-registration-summary.test.ts

**Interfaces:**
- Produces: summarizePixRegistrationResults(results: readonly PixKeyRegistrationControlResult[]): string.
- Consumed by: ControlPanel after onRegisterPixKey resolves.

- [ ] **Step 1: Write failing summary tests**

~~~ts
import assert from "node:assert/strict";
import test from "node:test";
import { summarizePixRegistrationResults } from "../src/renderer/lib/pix-registration-summary.js";

test("resume apenas categorias PIX finais nao zeradas", () => {
  assert.equal(
    summarizePixRegistrationResults([
      { status: "pix_key_registered" },
      { status: "pix_already_registered" },
      { status: "pix_key_pending_confirmation" },
      { status: "pix_key_conflict" },
    ] as never),
    "Cadastro PIX: 2 concluídos · 1 aguardando confirmação · 1 para revisão",
  );
});

test("nao expoe etapas internas no resumo PIX", () => {
  assert.equal(
    summarizePixRegistrationResults([{ status: "withdrawal_password_entered" }] as never),
    "Cadastro PIX: 1 em andamento",
  );
});
~~~

Add a third test proving failed is counted as para revisão and zero-count categories are omitted.

- [ ] **Step 2: Run the focal test and verify it fails**

Run: npm test -- --test-name-pattern="resume apenas categorias PIX|nao expoe etapas internas"

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement compact feedback and copy**

Create the helper. Count pix_key_registered and pix_already_registered as concluídos; pix_key_pending_confirmation as aguardando confirmação; pix_key_conflict and failed as para revisão; all remaining statuses as em andamento. Emit only nonzero fragments:

~~~ts
return fragments.length
  ? "Cadastro PIX: " + fragments.join(" · ")
  : "Cadastro PIX finalizado.";
~~~

Import it into ControlPanel. Change button copy from Preparar cadastro PIX to Cadastrar chave PIX and the busy copy to Cadastrando.... Preserve detailed operation logs.

- [ ] **Step 4: Verify UI-focused tests and types**

Run: npm test -- --test-name-pattern="resumo.*PIX|categorias PIX|etapas internas"

Expected: PASS.

Run: npm run check

Expected: PASS with no renderer string Preparar cadastro PIX.

- [ ] **Step 5: Commit**

~~~powershell
git add src/renderer/lib/pix-registration-summary.ts src/renderer/components/ControlPanel.tsx test/pix-registration-summary.test.ts
git commit -m "fix(pix): compact registration feedback"
~~~

### Task 5: Validate the integrated flow

**Files:**
- Test: test/database.test.ts, test/pix-phone-key-lifecycle.test.ts, test/mask-sensitive-value.test.ts and test/pix-registration-summary.test.ts.

- [ ] **Step 1: Run target regressions**

Run: npm test -- --test-name-pattern="chave PIX|preflight|mascara|resumo"

Expected: PASS, covering atomic consumption, migration, compatible/incompatible preflight, masked display and concise summary.

- [ ] **Step 2: Run complete tests**

Run: npm test

Expected: PASS for all repository tests.

- [ ] **Step 3: Run typecheck**

Run: npm run check

Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 4: Validate manually in development**

Run: npm run dev

Verify with one disposable profile that a confirmed key disappears from Chaves PIX, appears masked in the profile detail, and a second registration attempt reports a concise completed result without allocating a new key. Verify a pending key stays visible but cannot be edited or deleted.

- [ ] **Step 5: Commit a regression correction only when a test proves one is needed**

~~~powershell
git add src test
git commit -m "test(pix): verify profile key consumption flow"
~~~

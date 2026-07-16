# Recusa de chave PIX e retry automático Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Marcar uma chave PIX explicitamente rejeitada como Recusada e tentar, no mesmo formulário, a próxima chave disponível sem comprometer pendências ambíguas.

**Architecture:** O estoque passa a conhecer o estado terminal global `rejected`, com razão e data. A submissão PIX instala um observador de toast antes do clique e classifica exclusivamente a mensagem comprovada. Um pequeno orquestrador de retry separa a política “somente rejeição explícita tenta a próxima” do runtime de browser, que continua responsável por navegar, preencher e persistir as transições de banco.

**Tech Stack:** TypeScript estrito, Electron, React, SQLite `node:sqlite`, Patchright e testes nativos `node:test` via `tsx`.

## Global Constraints

- `rejected` é global e não pode voltar ao estoque automaticamente.
- Chaves Recusadas podem apenas ser excluídas; edição permanece exclusiva de `available`.
- Toasts sem classificação explícita mantêm a chave em `pending_confirmation`.
- Uma tentativa de retry não repete navegação, senha de saque ou PIN; ela substitui somente os dados no formulário PIX já vivo.
- Não registrar números PIX completos em logs.
- Preservar a alteração do usuário em `package-lock.json` fora dos commits.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
| --- | --- |
| `src/shared/contracts.ts` | Expõe status e metadados de recusa para main, preload e renderer. |
| `src/main/services/database.ts` | Persiste a transição pendente → recusada, reserva apenas chaves disponíveis e permite excluir recusadas. |
| `src/renderer/lib/pix-key-status.ts` | Centraliza rótulo, tom e permissões por status. |
| `src/renderer/components/PixKeysPanel.tsx` | Exibe Recusada em vermelho e somente a ação Excluir. |
| `src/main/services/pix-phone-key-confirmation.ts` | Observa e classifica o toast surgido após o submit PIX. |
| `src/main/services/pix-phone-key-retry.ts` | Executa o laço finito de retry apenas para resultados explicitamente recusados. |
| `src/main/services/automation-runtime.ts` | Conecta preenchimento, transições no banco e retry ao fluxo PIX existente. |
| `test/*.test.ts` | Protege transições, classificação, retry e apresentação. |

---

### Task 1: Estado `rejected` no estoque e na interface

**Files:**
- Modify: `src/shared/contracts.ts:81,204-220`
- Modify: `src/main/services/database.ts:219-235,1046-1064,2185-2390,2458-2473,3118-3135`
- Modify: `src/renderer/lib/pix-key-status.ts`
- Modify: `src/renderer/components/PixKeysPanel.tsx:150-245`
- Modify: `test/database.test.ts`
- Modify: `test/pix-key-status.test.ts`

**Interfaces:**
- Produces `PixPhoneKeyStatus = "available" | "reserved" | "pending_confirmation" | "rejected" | "used"`.
- Produces `rejectPixPhoneKey(id, { profileId, reason }): boolean`.
- Produces `canEditPixKey(status)` and `canDeletePixKey(status)`; a chave recusada só satisfaz a segunda função.

- [ ] **Step 1: Escrever os testes vermelhos de banco e apresentação**

```ts
test("marca uma chave PIX pendente como recusada sem vincula-la ao perfil", () => {
  const key = db.reservePixPhoneKey(profile.id, "run-a")!;
  db.markPixPhoneKeyPendingConfirmation(key.id, { profileId: profile.id, runId: "run-a" });

  assert.equal(db.rejectPixPhoneKey(key.id, {
    profileId: profile.id,
    reason: "withdrawal-account-already-linked"
  }), true);

  const rejected = db.getPixPhoneKey(key.id);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.pendingProfileId, undefined);
  assert.equal(rejected.rejectionReason, "withdrawal-account-already-linked");
  assert.equal(db.getOrCreateProfileAccount(profile.id).pixPhoneKey, undefined);
  assert.equal(db.reservePixPhoneKey(profile.id, "run-b"), undefined);
});

test("permite excluir uma chave PIX recusada, mas nao edita-la", () => {
  assert.equal(canEditPixKey("rejected"), false);
  assert.equal(canDeletePixKey("rejected"), true);
  assert.equal(pixKeyStatusLabel("rejected"), "Recusada");
});
```

- [ ] **Step 2: Rodar os testes para confirmar a falha**

Run: `npm test -- --test-name-pattern="recusada|recusado"`  
Expected: FAIL por ausência de `rejected`, `rejectPixPhoneKey` e `canDeletePixKey`.

- [ ] **Step 3: Implementar o estado e a transição guardada**

Adicionar `rejected_at` e `rejection_reason` tanto à criação de `pix_phone_keys` quanto a `ensurePixPhoneKeyLifecycleColumns()`. Mapear ambos em `PixPhoneKeyRecord`.

```ts
rejectPixPhoneKey(
  pixKeyId: string,
  input: { profileId: string; reason: "withdrawal-account-already-linked" }
): boolean {
  const now = new Date().toISOString();
  return this.db.prepare(`
    UPDATE pix_phone_keys
    SET status = 'rejected', assigned_profile_id = NULL, assigned_at = NULL,
        reservation_run_id = NULL, pending_profile_id = NULL, pending_run_id = NULL,
        pending_at = NULL, rejected_at = ?, rejection_reason = ?, updated_at = ?
    WHERE id = ? AND status = 'pending_confirmation' AND pending_profile_id = ?
  `).run(now, input.reason, now, pixKeyId, input.profileId).changes === 1;
}
```

Manter `reservePixPhoneKey()` com consulta exclusiva a `status = 'available'`. Alterar a exclusão para `status IN ('available', 'rejected')`; manter `updatePixPhoneKeyPhoneNumber()` exclusiva de `available`.

No renderer, usar:

```ts
const PIX_KEY_STATUS_LABEL: Record<PixPhoneKeyStatus, string> = {
  available: "Disponível",
  reserved: "Em cadastro",
  pending_confirmation: "Aguardando confirmação",
  rejected: "Recusada",
  used: "Cadastrada"
};

export const canEditPixKey = (status: PixPhoneKeyStatus) => status === "available";
export const canDeletePixKey = (status: PixPhoneKeyStatus) =>
  status === "available" || status === "rejected";
```

Fazer `PixKeysPanel` renderizar o botão Excluir quando `canDeletePixKey` for verdadeiro, o botão Editar somente quando `canEditPixKey` for verdadeiro e aplicar `danger` ao pill de `rejected`.

- [ ] **Step 4: Rodar os testes focais e a checagem de tipos**

Run: `npm test -- --test-name-pattern="recusada|recusado"; npm run check`  
Expected: PASS, chave recusada fora da reserva e interface tipada.

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts.ts src/main/services/database.ts src/renderer/lib/pix-key-status.ts src/renderer/components/PixKeysPanel.tsx test/database.test.ts test/pix-key-status.test.ts
git commit -m "feat(pix): retain explicitly rejected keys"
```

### Task 2: Classificar o toast de rejeição no submit PIX

**Files:**
- Modify: `src/main/services/pix-phone-key-confirmation.ts`
- Modify: `test/pix-phone-key-confirmation.test.ts`

**Interfaces:**
- Produces `classifyPixRejectionToast(text: string): "withdrawal-account-already-linked" | undefined`.
- Extends `PixPhoneSubmissionResult["result"]` com `"rejected"`.
- `confirmPixPhoneSubmission()` instala e remove o observador em todas as saídas.

- [ ] **Step 1: Escrever testes vermelhos do classificador e do desfecho**

```ts
test("classifica o toast de conta de saque vinculada sem depender de acento", () => {
  assert.equal(
    classifyPixRejectionToast("Esta conta de saque ja foi vinculada por outro membro"),
    "withdrawal-account-already-linked"
  );
  assert.equal(classifyPixRejectionToast("Falha temporaria"), undefined);
});

test("submission retorna rejected quando o observador captura o toast novo", async () => {
  const fake = fakeSurface([snapshot(), snapshot(), snapshot({ rejectionReason: "withdrawal-account-already-linked" })]);
  const result = await confirmPixPhoneSubmission(fake.surface, "41980042690", 300);
  assert.equal(result.result, "rejected");
  assert.equal(result.reason, "withdrawal-account-already-linked");
});
```

- [ ] **Step 2: Rodar o teste para confirmar a falha**

Run: `npm test -- --test-name-pattern="toast de conta de saque|submission retorna rejected"`  
Expected: FAIL por classificador, campo de snapshot e resultado inexistentes.

- [ ] **Step 3: Implementar observação temporal e classificação restrita**

Criar um normalizador local que remova acentos, reduza espaços e use caixa baixa. O classificador deve aceitar somente a frase comprovada, não padrões genéricos de erro.

Antes do `locator(...).click()`, instalar no mundo da página uma observação com `MutationObserver` que captura apenas elementos adicionados após a instalação:

```ts
const isRejectedToast = (element: Element) =>
  visible(element)
  && element.matches(".ui-toast__toast--error")
  && classifyPixRejectionToast(element.querySelector(".ui-toast__toast-message")?.textContent ?? "");
```

Guardar apenas o enum da razão, nunca o telefone ou HTML do toast. Durante o polling, consultar a razão capturada antes de verificar confirmação estrutural. Retornar:

```ts
{ actionAttempted: true, clickRejected, result: "rejected", reason: "withdrawal-account-already-linked" }
```

Usar `try/finally` para desconectar o observador e apagar seu estado temporário mesmo em timeout, erro de click ou retorno antecipado.

- [ ] **Step 4: Rodar os testes focais e a checagem de tipos**

Run: `npm test -- --test-name-pattern="toast de conta de saque|submission retorna rejected|confirmation"; npm run check`  
Expected: PASS; o resultado `pending` continua reservado para ausência de prova.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/pix-phone-key-confirmation.ts test/pix-phone-key-confirmation.test.ts
git commit -m "feat(pix): detect explicit key rejection toast"
```

### Task 3: Repetir somente chaves explicitamente recusadas

**Files:**
- Create: `src/main/services/pix-phone-key-retry.ts`
- Create: `test/pix-phone-key-retry.test.ts`
- Modify: `src/main/services/automation-runtime.ts:1015-1110`

**Interfaces:**
- Produces `type PixPhoneKeyAttemptResult = "confirmed" | "rejected" | "pending" | "conflict" | "error"`.
- Produces `retryRejectedPixPhoneKeys<T>(initialKey, attempt, reserveNext)`.
- `attempt(key)` devolve `"confirmed" | "rejected" | "pending" | "conflict" | "error"`.
- `reserveNext()` devolve a próxima chave reservada ou `undefined`; apenas `rejected` invoca essa função.

- [ ] **Step 1: Escrever o teste vermelho do orquestrador de retry**

```ts
test("submete a proxima chave somente depois de uma recusa explicita", async () => {
  const attempted: string[] = [];
  const outcome = await retryRejectedPixPhoneKeys(
    "primeira",
    async (key) => { attempted.push(key); return key === "primeira" ? "rejected" : "confirmed"; },
    () => "segunda"
  );

  assert.deepEqual(attempted, ["primeira", "segunda"]);
  assert.deepEqual(outcome, { key: "segunda", result: "confirmed", rejectedAttempts: 1 });
});

test("nao busca outra chave para pendencia ou conflito", async () => {
  let reserveCalls = 0;
  const outcome = await retryRejectedPixPhoneKeys("primeira", async () => "pending", () => {
    reserveCalls += 1;
    return "segunda";
  });
  assert.equal(outcome.result, "pending");
  assert.equal(reserveCalls, 0);
});
```

- [ ] **Step 2: Rodar o teste para confirmar a falha**

Run: `npm test -- --test-name-pattern="proxima chave somente|nao busca outra chave"`  
Expected: FAIL por módulo e função inexistentes.

- [ ] **Step 3: Implementar o laço finito e conectá-lo ao runtime**

Implementar o helper sem acesso a browser ou banco:

```ts
export type PixPhoneKeyAttemptResult =
  | "confirmed"
  | "rejected"
  | "pending"
  | "conflict"
  | "error";

export async function retryRejectedPixPhoneKeys<T>(
  initialKey: T,
  attempt: (key: T) => Promise<PixPhoneKeyAttemptResult>,
  reserveNext: () => T | undefined,
): Promise<{ key: T; result: PixPhoneKeyAttemptResult; rejectedAttempts: number }> {
  let key = initialKey;
  let rejectedAttempts = 0;
  for (;;) {
    const result = await attempt(key);
    if (result !== "rejected") return { key, result, rejectedAttempts };
    rejectedAttempts += 1;
    const next = reserveNext();
    if (!next) return { key, result: "error", rejectedAttempts };
    key = next;
  }
}
```

No runtime, depois de o modal PIX estar pronto e com senha/PIN já processados, encapsular o preenchimento, a promoção para pendência e `confirmPixPhoneSubmission()` em `attempt(key)`. Para um resultado `rejected`, chamar `database.rejectPixPhoneKey(key.id, { profileId: profile.id, reason })` antes de devolver `rejected` ao helper. `reserveNext` deve chamar `reservePixPhoneKey(profile.id, run.id)` e atualizar `reservedPhoneKeyId` para que exceções ainda liberem somente a nova reserva.

O preenchimento deve chamar novamente `fillPixPhoneAddForm()` com a chave seguinte; o setter já substitui `phoneInput.value` e a função verifica igualdade dos dígitos, portanto não reaproveita ou concatena o número recusado. Não repetir os blocos de rota, abertura do modal, PIN ou busca de CPF/nome.

Converter `confirmed`, `pending`, `conflict` e `error` para os resultados existentes. Quando o helper devolver `error` após ao menos uma recusa e não houver nova reserva, encerrar o perfil como `failed` com razão `pix-keys-exhausted-after-rejection`; não criar uma pendência para a última chave, pois ela já está `rejected`.

- [ ] **Step 4: Rodar testes focais e a suíte de fluxo PIX**

Run: `npm test -- --test-name-pattern="proxima chave somente|nao busca outra chave|PIX key|confirmation"; npm run check`  
Expected: PASS; retry acontece somente após recusa e não há regressão em pendência/conflito.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/pix-phone-key-retry.ts test/pix-phone-key-retry.test.ts src/main/services/automation-runtime.ts
git commit -m "feat(pix): retry after explicit key rejection"
```

### Task 4: Validação integrada e teste manual

**Files:**
- Verify: `test/database.test.ts`, `test/pix-phone-key-confirmation.test.ts`, `test/pix-phone-key-retry.test.ts`, `test/pix-key-status.test.ts`
- Verify: `src/main/services/automation-runtime.ts`, `src/renderer/components/PixKeysPanel.tsx`

- [ ] **Step 1: Executar a suíte e o build**

Run: `npm test; npm run check; npm run build; git diff --check`  
Expected: todos os testes passam, TypeScript e build concluem sem erro e não há whitespace inválido.

- [ ] **Step 2: Validar manualmente no app**

Run: `npm run dev`  
Expected: em uma plataforma que emite o toast observado, a primeira chave passa a **Recusada**, a próxima é preenchida no mesmo modal e somente a chave aceita é removida do estoque. Em um toast não reconhecido, a chave permanece **Aguardando confirmação**.

- [ ] **Step 3: Verificar a árvore e registrar o resultado**

Run: `git status --short; git log --oneline -3`  
Expected: somente `package-lock.json` permanece sujo se já estava assim antes; todos os arquivos da feature estão commitados.

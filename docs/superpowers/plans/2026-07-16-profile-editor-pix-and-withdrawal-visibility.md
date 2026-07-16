# Visibilidade de PIX e senha de saque no editor — Plano de implementação

> Para agentes: executar com teste primeiro, tarefa por tarefa.

**Objetivo:** Exibir a chave PIX completa e bloqueada no editor, permitir mostrar/ocultar a senha de saque e renomear CPF PIX para CPF.

**Arquitetura:** Um helper puro resolve o valor visual da chave PIX e recebe testes unitários. O modal preserva a responsabilidade pelo estado local de mostrar/ocultar; nenhuma alteração é feita em `ProfileDraft` ou na persistência da chave PIX.

**Tecnologias:** React 19, TypeScript estrito e `tsx --test`.

## Restrições

- A chave PIX confirmada é somente leitura, completa e não participa do salvamento.
- A senha continua editável e inicia oculta.
- O `package-lock.json` já alterado pelo usuário não entra em commits.

### Tarefa 1: Helper de apresentação da chave PIX

**Arquivos:** criar `src/renderer/lib/profile-editor-fields.ts` e `test/profile-editor-fields.test.ts`.

- [ ] Criar teste antes da implementação:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { profileEditorPixKeyValue } from "../src/renderer/lib/profile-editor-fields.js";

test("expõe a chave PIX completa no editor", () => {
  assert.equal(profileEditorPixKeyValue({ pixPhoneKey: "41980042690" }), "41980042690");
});

test("mantém o campo PIX vazio sem chave confirmada", () => {
  assert.equal(profileEditorPixKeyValue(undefined), "");
});
```

- [ ] Rodar `npm test -- test/profile-editor-fields.test.ts`; deve falhar pela ausência do helper.
- [ ] Criar o helper:

```ts
import type { ProfileAccountRecord } from "../../shared/contracts.js";

export function profileEditorPixKeyValue(account?: Pick<ProfileAccountRecord, "pixPhoneKey">): string {
  return account?.pixPhoneKey ?? "";
}
```

- [ ] Rodar novamente o teste; deve passar.
- [ ] Commitar apenas helper e teste com `test(profile): cover PIX editor field`.

### Tarefa 2: Interface do editor e consistência de rótulos

**Arquivos:** modificar `src/renderer/components/ProfileEditorModal.tsx` e `src/renderer/components/ProfileDetailModal.tsx`.

- [ ] No editor, importar o helper, adicionar `showWithdrawalPassword` como estado local e redefini-lo para `false` sempre que o modal abrir.
- [ ] Inserir campo **Chave PIX** completo, `readOnly`, sem `onChange`, cujo valor é `profileEditorPixKeyValue(profile?.account)`.
- [ ] Renomear `CPF PIX` para **CPF** no editor e no modal de detalhes.
- [ ] Para a senha, usar `type={showWithdrawalPassword ? "text" : "password"}` e um botão `type="button"` acessível que alterna Mostrar/Ocultar sem submeter o formulário.
- [ ] Rodar `npm test -- test/profile-editor-fields.test.ts; npm run check`; ambos devem passar.
- [ ] Commitar os arquivos da tarefa com `feat(profile): expose PIX key in editor`.

### Tarefa 3: Verificação final

- [ ] Rodar `npm test; npm run check; npm run build; git diff --check; git status --short`.
- [ ] Rodar `npm run dev` e validar: chave PIX completa e bloqueada, CPF correto, senha mostra/oculta e salvar/reabrir não muda a chave PIX.
- [ ] Se houver ajuste derivado da validação, commitar apenas arquivos relacionados.

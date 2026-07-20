# Issue 29 Bulk Profile Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Excluir vários perfis sem bloquear o processo principal, com concorrência limitada, progresso e falhas parciais.

**Architecture:** Uma função de domínio independente coordena a exclusão de cada perfil com dois workers. O banco remove a pasta por `fs/promises`, o runtime limita o fechamento completo do navegador, o main publica um único snapshot final e o renderer acompanha eventos leves de progresso.

**Tech Stack:** TypeScript ESM, Electron IPC, React 19, node:test, node:sqlite e `node:fs/promises`.

## Global Constraints

- Trabalhar apenas no repo dedicado `spider-bot-desktop`.
- Executar no máximo duas exclusões de perfil simultaneamente.
- Nunca encerrar Chrome globalmente; usar somente `forceKillProfileBrowser(storagePath)`.
- Manter compatibilidade da exclusão individual.
- Publicar um único snapshot e uma única atualização de instâncias ao final do lote.
- Preservar o perfil no SQLite quando a remoção de sua pasta falhar.

---

### Task 1: Coordenador de exclusão em lote

**Files:**
- Create: `src/main/services/profile-deletion.ts`
- Create: `test/profile-deletion.test.ts`

**Interfaces:**
- Consumes: callbacks `getProfileName`, `isProfileActive`, `stopProfile` e `deleteProfile`.
- Produces: `deleteProfilesWithConcurrency(profileIds, dependencies, concurrency): Promise<ProfileDeletionResult>` e eventos `ProfileDeletionProgress`.

- [ ] **Step 1: Write the failing tests**

Cobrir limite de dois workers, continuidade depois de uma falha, ordem do resultado, deduplicação de IDs e progresso acumulado:

```ts
const result = await deleteProfilesWithConcurrency(
  ["a", "b", "c"],
  {
    getProfileName: (profileId) => `Perfil ${profileId.toUpperCase()}`,
    isProfileActive: () => false,
    stopProfile: async () => undefined,
    deleteProfile: async (profileId) => runMeasuredDeletion(profileId),
    onProgress: (progress) => progressEvents.push(progress)
  },
  2
);
assert.equal(peak, 2);
assert.equal(result.deleted, 3);
assert.equal(progressEvents.at(-1)?.completed, 3);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/profile-deletion.test.ts`
Expected: FAIL porque `profile-deletion.ts` ainda não existe.

- [ ] **Step 3: Write minimal implementation**

Criar dois workers que compartilham um índice, armazenam cada resultado na posição original e chamam `onProgress` após cada item. Cada worker deve capturar o erro do próprio perfil sem rejeitar o lote.

```ts
export async function deleteProfilesWithConcurrency(
  profileIds: string[],
  dependencies: ProfileDeletionDependencies,
  concurrency = 2
): Promise<ProfileDeletionResult>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/profile-deletion.test.ts`
Expected: todos os testes do coordenador passam.

- [ ] **Step 5: Commit**

```powershell
git add src/main/services/profile-deletion.ts test/profile-deletion.test.ts
git commit -m "feat: coordinate bounded profile deletion"
```

### Task 2: Remoção de pasta sem bloqueio

**Files:**
- Modify: `src/main/services/database.ts`
- Modify: `test/database.test.ts`

**Interfaces:**
- Consumes: `RemoveProfileDirectory = (path: string) => Promise<void>`, com padrão `fs.promises.rm`.
- Produces: `PredatorDatabase.deleteProfile(profileId): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Injetar uma remoção pendente e provar que `deleteProfile` retorna uma Promise imediatamente, conserva a linha enquanto a pasta não terminou e só então remove o registro.

```ts
const deletion = db.deleteProfile(profile.id);
assert.equal(db.profileExists(profile.id), true);
finishDirectoryRemoval();
await deletion;
assert.equal(db.profileExists(profile.id), false);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/database.test.ts`
Expected: FAIL porque a exclusão atual é síncrona e remove a linha antes da pasta.

- [ ] **Step 3: Write minimal implementation**

Adicionar a dependência opcional no construtor e trocar `rmSync` por `await removeProfileDirectory(storagePath)`. Executar o `DELETE` e o log somente depois da remoção física bem-sucedida.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/database.test.ts`
Expected: testes do banco passam.

- [ ] **Step 5: Commit**

```powershell
git add src/main/services/database.ts test/database.test.ts
git commit -m "fix: remove profile storage asynchronously"
```

### Task 3: Timeout cobre páginas e contexto

**Files:**
- Modify: `src/main/services/browser-runtime.ts`
- Create: `test/browser-runtime-stop.test.ts`

**Interfaces:**
- Produces: `closeProfileBrowser(target, options): Promise<void>`, onde `target` contém `context` e `storagePath`, e `options` permite `timeoutMs` e `forceKill`.
- `BrowserRuntimeService.stopProfile` reutiliza essa função.

- [ ] **Step 1: Write the failing test**

Criar uma página cujo `close()` nunca resolve, usar timeout curto e confirmar que o kill recebe somente o diretório daquele perfil e que a Promise termina.

```ts
await closeProfileBrowser(target, {
  timeoutMs: 20,
  forceKill: async (storagePath) => killedPaths.push(storagePath)
});
assert.deepEqual(killedPaths, ["C:\\profiles\\profile-a"]);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/browser-runtime-stop.test.ts`
Expected: FAIL porque o helper ainda não existe.

- [ ] **Step 3: Write minimal implementation**

Executar fechamento de páginas e contexto dentro de uma única corrida contra o timeout. Em timeout ou rejeição, aguardar `forceKillProfileBrowser(storagePath)` antes de devolver o controle.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/browser-runtime-stop.test.ts`
Expected: testes de fechamento passam.

- [ ] **Step 5: Commit**

```powershell
git add src/main/services/browser-runtime.ts test/browser-runtime-stop.test.ts
git commit -m "fix: bound complete profile browser shutdown"
```

### Task 4: IPC único, progresso e resultado parcial

**Files:**
- Modify: `src/shared/contracts.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts`
- Modify: `src/renderer/hooks/usePredatorApp.ts`
- Create: `src/renderer/lib/profile-deletion.ts`
- Create: `test/profile-deletion-renderer.test.ts`

**Interfaces:**
- Produces: `PredatorApi.profiles.deleteMany(profileIds): Promise<ProfileDeletionResult>`.
- Produces evento `profile-deletion-progress` com `ProfileDeletionProgress`.
- Produces helpers puros `failedProfileIds(result)` e `describeProfileDeletionFailures(result)`.

- [ ] **Step 1: Write the failing renderer test**

Comprovar que apenas IDs falhos permanecem selecionados e que o resumo contém contagens e motivos.

```ts
assert.deepEqual(failedProfileIds(result), ["b"]);
assert.match(describeProfileDeletionFailures(result), /2 perfis excluídos/);
assert.match(describeProfileDeletionFailures(result), /Perfil B: disco ocupado/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/profile-deletion-renderer.test.ts`
Expected: FAIL porque os helpers ainda não existem.

- [ ] **Step 3: Wire contracts, preload and main**

O handler `profiles:delete-many` chama o coordenador, envia progresso somente à janela da instância e publica snapshot/instâncias uma vez no final. `profiles:delete` chama o mesmo caminho com um ID e converte falha individual em erro IPC.

- [ ] **Step 4: Wire renderer state**

O hook mantém `profileDeletionProgress`, chama `deleteMany`, mantém selecionados apenas os falhos e não solicita snapshot por perfil. Os eventos `snapshot-updated` continuam sendo a fonte da lista final.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx tsx --test test/profile-deletion.test.ts test/database.test.ts test/browser-runtime-stop.test.ts test/profile-deletion-renderer.test.ts`
Expected: todos passam.

Run: `npm run check`
Expected: TypeScript sem erros.

- [ ] **Step 6: Commit**

```powershell
git add src/shared/contracts.ts src/preload/index.ts src/main/index.ts src/renderer/hooks/usePredatorApp.ts src/renderer/lib/profile-deletion.ts test/profile-deletion-renderer.test.ts
git commit -m "feat: expose bulk profile deletion progress"
```

### Task 5: Feedback visual e verificação completa

**Files:**
- Modify: `src/renderer/App.tsx`
- Create: `docs/adr/0009-exclusao-em-lote-nao-bloqueante.md`

**Interfaces:**
- Consumes: `app.deleteProfiles`, `app.profileDeletionProgress` e o resumo puro de falhas.

- [ ] **Step 1: Update the confirmation dialog**

Durante a operação, definir `busy` e substituir a mensagem por `Excluindo X de Y...`. Ao concluir, fechar a confirmação; se houver falhas, abrir `AlertDialog` com o resumo e manter os IDs falhos selecionados.

- [ ] **Step 2: Record the decision**

Registrar contexto, causas, concorrência 2, ordem pasta-antes-do-SQLite, kill escopado e comandos de verificação no ADR.

- [ ] **Step 3: Run full automated verification**

Run: `npm run check`
Expected: exit 0.

Run: `npm test`
Expected: todos os testes passam, zero falhas.

Run: `git diff --check`
Expected: nenhuma saída.

- [ ] **Step 4: Run manual ten-profile verification**

Criar uma base temporária com dez perfis e milhares de arquivos, excluir via o mesmo coordenador e registrar: pico de concorrência 2, timer do event loop executando durante a remoção, dez diretórios ausentes e dez registros ausentes. Depois validar o helper de timeout com perfil ativo simulado e confirmar que o kill recebeu somente o diretório alvo.

- [ ] **Step 5: Commit**

```powershell
git add src/renderer/App.tsx docs/adr/0009-exclusao-em-lote-nao-bloqueante.md
git commit -m "fix: keep bulk profile deletion responsive"
```

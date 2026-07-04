# 0001 — Kill escopado por `user-data-dir` ao invés de `taskkill /IM` global

- **Status:** Aceito
- **Data:** 2026-07-04
- **Issue:** [#2 — Fechar uma janela fecha todas as janelas abertas](https://github.com/henocdejesusferreirafarias/spider-bot-desktop/issues/2) (bug, P0-critical)
- **Componente:** `src/main/services/browser-runtime.ts`, `src/main/services/browser-process-kill.ts`

## Contexto

Cada perfil abre como um navegador **isolado**, via
`chromium.launchPersistentContext(profile.storagePath, …)` — um processo `chrome.exe`
próprio, com `--user-data-dir` único por perfil. O usuário roda vários perfis em grade
(ex.: 9 janelas) na mesma máquina.

Relato de campo: **às vezes, fechar/parar um único perfil derrubava todas as janelas**,
matando automações em andamento. Intermitente, e nunca reproduzível em máquinas rápidas.

## Causa-raiz

O encerramento de um perfil (`stopProfile` / `shutdown`) tinha uma rede de segurança: se
`context.close()` travasse por **3 s**, um kill de emergência era disparado. Esse kill era
**machine-wide**:

```ts
// ANTES — browser-runtime.ts
await execFileAsync("taskkill", ["/F", "/IM", "chromium.exe", "/T"]);
await execFileAsync("taskkill", ["/F", "/IM", "chrome.exe", "/T"]);
```

`taskkill /IM` seleciona por **nome de imagem**, ou seja **todo** `chrome.exe`/`chromium.exe`
da máquina — incluindo os outros perfis e até o Chrome pessoal do usuário.

Encadeamento do sintoma: o usuário para um perfil cujo navegador está ocupado (PC fraco,
muitas janelas) → o `context.close()` dele trava > 3 s → dispara `taskkill /IM` → **todos os
navegadores morrem juntos**. Não é propagação de evento nem race no handler de janela; é o
*fallback* de kill ser global em vez de escopado. Explica o "sob carga" e o "some em máquina
rápida" (onde o close nunca chega a travar 3 s).

### Evidência (reprodução controlada)

Dois contextos persistentes isolados (A e B). Ao mandar parar **só o A** com o `close`
forçado a travar > 3 s, o kill de emergência disparava e **o perfil B — que ninguém mandou
fechar — também morria** (emitia `close`, processos encerrados). Bug confirmado
empiricamente antes de qualquer alteração.

## Decisão

Escopar o kill de emergência ao **processo-árvore do perfil-alvo**, usando o `user-data-dir`
único (`profile.storagePath`). Verificou-se que **todos** os processos do Chromium daquele
perfil (principal + renderers/gpu/etc.) carregam `--user-data-dir=<storagePath>` na linha de
comando — logo o filtro por esse diretório isola o perfil sem tocar nos demais.

Novo módulo `browser-process-kill.ts`:
- `selectPidsForUserDataDir(processes, userDataDir)` — puro: PIDs cujo command line contém o
  `user-data-dir`. **Fail-safe:** `userDataDir` vazio/curto retorna `[]` (nunca casa com tudo).
- `forceKillProfileBrowser(userDataDir)` — enumera processos via
  `Get-CimInstance Win32_Process` (o único que expõe `CommandLine`; `tasklist` não expõe) e
  roda `taskkill /F /PID <pid> /T` apenas nos PIDs casados. Windows-only; no-op fora dele.

`RuntimeHandle` passou a guardar `storagePath`, e os 3 call sites de emergência
(`stopProfile` timeout/catch, `shutdown` timeout/catch) agora chamam
`forceKillProfileBrowser(handle.storagePath)`. O `taskkill /IM` global foi **removido**.

O timeout de 3 s continua como rede de segurança — muda só o **alvo** do kill.

## Consequências

- ✅ Fechar/parar um perfil nunca mais derruba os demais nem o Chrome pessoal do usuário.
- ✅ O "parar tudo" intencional continua funcionando (itera todos os handles, cada um escopado).
- ⚠️ Dependência de `Get-CimInstance` (PowerShell) no caminho de kill. Já era Windows-only.
- ⚠️ Se a enumeração falhar ou nada casar, o kill vira no-op (fail-safe) — melhor um browser
  órfão ocasional do que matar tudo. Órfãos são recolhidos no `shutdown` do app.

## Verificação

- Unit test `test/browser-process-kill.test.ts` — seleção correta, isolamento entre perfis,
  case-insensitive, e os casos fail-safe (dir vazio/curto ⇒ `[]`).
- Reprodução end-to-end (2 navegadores reais): parar A com `close` travado agora mata **só**
  os processos de A; B segue vivo.
- `npm run typecheck` limpo.

> Reprodução manual é destrutiva (dispara kill real de `chrome.exe`); rode apenas com o
> Chrome pessoal fechado. A lógica testável em CI é o unit test acima.

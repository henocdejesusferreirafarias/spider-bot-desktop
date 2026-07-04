# 0002 — Depósito do bot é sempre por injeção de estado; remoção do fluxo por navegação

- **Status:** Aceito
- **Data:** 2026-07-04
- **Issue:** [#11](https://github.com/henocdejesusferreirafarias/spider-bot-desktop/issues/11) (sub-issue de #1 esperas fixas e #5 decompor o monólito)
- **Componente:** `src/main/services/automation-runtime.ts`

## Contexto

O depósito pós-cadastro foi migrado para **injeção de estado** (dispatch Pinia via
`programmaticDeposit` → `recharge-with-form.submit`), que abre a janela de depósito, preenche e
submete **sem navegar** até a área de perfil. O QR gerado é aumentado por um overlay.

O produto tem exatamente **dois** modos de depósito:

1. **Pelo bot** — injeção de estado, sempre com um valor. Gera o QR e aumenta.
2. **Manual pelo usuário** — o usuário navega/preenche/submete como quiser; o bot apenas
   **aumenta o QR** que aparecer, via watcher passivo `armQrOverlayObserverForManualDeposit`
   (observa o DOM; independente de qualquer fluxo de navegação).

Não existe um terceiro modo "o bot navega até a tela de depósito e o usuário preenche".

## Problema

`prepareLocalDepositAfterSuccessfulRegistration` mantinha um ramo que fazia justamente esse
terceiro modo inexistente: quando `depositAmount` era `undefined`, navegava até o perfil
(`tryOpenProfileViaRoute` / `clickProfileEntryPoint`), esperava a superfície do perfil
(`waitForProfileSurface(…, 8000)`) e abria o depósito (`openDepositFromProfileArea`).

Esse ramo era **inalcançável**: `resolveDepositAmount` nunca retorna vazio (default `"200"`, ou
random entre min/max), e todos os call sites internos passam por ele — logo o valor chega sempre
definido e o caminho de injeção sempre executa (`return`). Uma inconsistência reforçava o risco: o
call site do primitivo remoto passava `context.depositAmount` **sem** o fallback
`?? resolveDepositAmount(...)` que o primitivo irmão já tinha. Era código morto cheio de esperas
fixas (raiz da issue #1) inflando o monólito (issue #5).

## Decisão

Fazer o **tipo** codificar o invariante de negócio ("depósito do bot sempre tem valor") e deixar o
código morto colapsar por consequência:

- `depositAmount` passou a ser **obrigatório** (`string`, não `string | undefined`) em
  `prepareDepositAfterSuccessfulRegistration` e `prepareLocalDepositAfterSuccessfulRegistration`.
- Fallback `?? resolveDepositAmount(automation.params)` adicionado no call site do primitivo remoto
  (fecha a inconsistência; garante o invariante em todo caminho).
- `resolveDepositAmount` agora retorna `string` (o tipo deixa de mentir).
- Com o valor sempre presente, o ramo de navegação virou inalcançável e foi **removido**, junto com
  a cadeia que ficou órfã (verificada caller-a-caller + confirmada pelo `noUnusedLocals` do
  compilador): `openDepositFromProfileArea`, `tryOpenProfileViaRoute`, `clickProfileEntryPoint`,
  `waitForProfileSurface`, `hasProfileSurface`, `clickVisiblePlatformEntryPoint` (~770 linhas), e o
  import órfão `pollForLabelResult`.

O watcher de QR do depósito manual permanece intacto — é ortogonal a este fluxo.

## Consequências

- ✅ Deleção líquida de ~1000 linhas do monólito (`-998`).
- ✅ Esperas fixas removidas na **raiz** (deletar > converter): o melhor conserto para um wait fixo
  em código morto é o código não existir.
- ✅ O tipo agora reflete a regra de negócio; futuras leituras não caem na armadilha do "e se não
  tiver valor?".
- ⚠️ `describeDepositFieldState` (método público de diagnóstico) já estava órfão **antes** desta
  mudança e permanece — fora do escopo aqui; candidato a limpeza futura.

## Verificação

- `npm run typecheck` limpo (o `noUnusedLocals` confirma o fechamento total de órfãos).
- Suíte de testes: mesmas 6 falhas pré-existentes de cadastro/PIX no `main` e no branch — **zero**
  regressões introduzidas.

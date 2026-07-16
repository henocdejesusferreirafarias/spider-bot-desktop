# WG Speed Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aplicar o Speed Time ao loop Cocos dos jogos WG sem depender do host de entrega.

**Architecture:** O registry declara WG como `cocos-director-tick` e fornece seus padrões de frame. O script do mundo principal instala uma única vez um wrapper em `cc.Director.prototype.tick`, que multiplica o delta pela taxa atual em `data-rtc-speed`.

**Tech Stack:** TypeScript ESM, Node test runner, Patchright/CDP e JavaScript injetado no mundo principal.

## Global Constraints

- O caminho `/clientv3/index.html` só é candidato; `cc.Director.prototype.tick` confirma Cocos antes do patch.
- PG e PP não mudam de estratégia.
- Em 1x, o delta é encaminhado sem alteração.
- O wrapper não pode ser empilhado.
- Verificar com `npm run check` e `npm test`.

---

### Task 1: Declarar e testar o perfil WG Cocos

**Files:**
- Create: `test/provider-timing.test.ts`
- Modify: `src/main/services/provider-timing.ts`

**Interfaces:**
- Produces: `EngineSpeedStrategy` com `"cocos-director-tick"` e `cocosDirectorTickFramePatternSources(): string[]`.
- Consumes: `resolveProviderByFrameUrl()` e `PROVIDER_TIMING_PROFILES` existentes.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  cocosDirectorTickFramePatternSources,
  resolveProviderByFrameUrl
} from "../src/main/services/provider-timing.js";

test("WG networking launcher resolves to the Cocos Director strategy", () => {
  const profile = resolveProviderByFrameUrl(
    "https://pwmercjm.wgnetworking.com/clientv3/index.html"
  );
  assert.equal(profile?.id, "wg");
  assert.equal(profile?.speedStrategy, "cocos-director-tick");
  assert.equal(cocosDirectorTickFramePatternSources().length, 1);
});

test("WG timing does not claim a non-WG clientv3 frame", () => {
  assert.equal(
    resolveProviderByFrameUrl("https://example.com/clientv3/index.html"),
    undefined
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/provider-timing.test.ts`

Expected: FAIL because the export is absent and WG uses `generic-timers`.

- [ ] **Step 3: Write minimal implementation**

```ts
export type EngineSpeedStrategy =
  | "cocos-timescale"
  | "cocos-director-tick"
  | "generic-timers";

const WG_PROFILE: ProviderTimingProfile = {
  id: "wg",
  label: "WG (Cocos 3)",
  gameFrameUrlPattern: /\/clientv3\/index\.html$/i,
  speedStrategy: "cocos-director-tick",
  speedRange: DEFAULT_SPEED_RANGE
};

export function cocosDirectorTickFramePatternSources(): string[] {
  return PROVIDER_TIMING_PROFILES
    .filter((profile) => profile.speedStrategy === "cocos-director-tick")
    .map((profile) => profile.gameFrameUrlPattern.source);
}
```

`patchGameSpeedScript()` deve devolver o corpo inalterado para essa estratégia: WG é tratado no script do mundo principal, não por reescrita de resposta de rede.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/provider-timing.test.ts`

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```powershell
git add src/main/services/provider-timing.ts test/provider-timing.test.ts
git commit -m "feat(speed): recognize WG Cocos launchers"
```

### Task 2: Instalar o wrapper Cocos Director

**Files:**
- Modify: `src/main/services/browser-runtime.ts:buildMainWorldControlsScript`
- Test: `test/provider-timing.test.ts`

**Interfaces:**
- Consumes: `cocosDirectorTickFramePatternSources()`.
- Produces: injeção idempotente que escala `cc.Director.prototype.tick(delta)` apenas em frame WG reconhecido.

- [ ] **Step 1: Write the failing test**

```ts
test("WG Cocos pattern matches the observed launcher URL", () => {
  const [source] = cocosDirectorTickFramePatternSources();
  assert.ok(source);
  assert.match(
    "https://pwmercjm.wgnetworking.com/clientv3/index.html",
    new RegExp(source, "i")
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/provider-timing.test.ts`

Expected: FAIL before Task 1 creates the WG Cocos pattern export.

- [ ] **Step 3: Write minimal implementation**

Import `cocosDirectorTickFramePatternSources` and serialize it into `buildMainWorldControlsScript`. After `readRate()` is defined, add a WG-only installer that polls with the captured native interval until `globalThis.cc?.Director?.prototype.tick` exists. It must store the original method in its closure, mark the wrapper with `__predatorWgTick`, and perform:

```js
const patchedTick = function (delta, ...rest) {
  const rate = readRate();
  const scaled = typeof delta === "number" && Number.isFinite(delta) ? delta * rate : delta;
  return originalTick.call(this, scaled, ...rest);
};
```

Clear the retry interval after installation or after a bounded number of attempts. Run this installer only for the serialized WG patterns. Disable generic timer/RAF overrides for this candidate so `Director.tick` is the only scaling path; keep existing PG and PP behavior unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/provider-timing.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```powershell
git add src/main/services/browser-runtime.ts test/provider-timing.test.ts
git commit -m "feat(speed): scale WG Cocos director ticks"
```

### Task 3: Registrar e verificar a mudança

**Files:**
- Create: `docs/adr/0003-wg-speed-time-cocos-director.md`

- [ ] **Step 1: Write the ADR**

Registre o launcher WG observado, Cocos 3.8.3, o experimento sem efeito do Scheduler, o experimento bem-sucedido de `Director.tick`, o isolamento por URL e a validação manual em 1x/2x/4x/8x.

- [ ] **Step 2: Run complete verification**

Run: `npm run check; npm test`

Expected: exit code 0 e todos os testes aprovados.

- [ ] **Step 3: Commit**

```powershell
git add docs/adr/0003-wg-speed-time-cocos-director.md
git commit -m "docs: record WG speed time decision"
```

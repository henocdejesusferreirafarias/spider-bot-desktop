# PP UHT Speed Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Acelerar a lógica visual dos jogos Pragmatic Play pelo `Time.deltaTime` do engine UHT, mantendo loading e relógios globais em 1x.

**Architecture:** O registro identifica apenas o documento real `/gs2c/html5Game.do` e seleciona uma estratégia dedicada. O script do mundo principal evita os wrappers genéricos nesse documento, aguarda o objeto global `Time` e substitui somente `deltaTime` por uma propriedade dinâmica gated por `loaderIsVisible`.

**Tech Stack:** TypeScript ESM, Electron, Patchright/CDP main world, Node test runner com `tsx --test`.

## Global Constraints

- Trabalhar somente em `spider-bot-desktop-speed-time`, branch `fix/issue-9-speed-time-providers`.
- Reconhecer PP pelo pathname `/gs2c/html5Game.do`, sem host nem query string.
- Não alterar `Date`, `performance.now`, RAF, timeout ou interval no documento PP.
- Não reescrever `build.js` e não acelerar `/gs2c/playGame.do`.
- Manter o fator efetivo em 1x enquanto `globalThis.loaderIsVisible !== false`.

---

### Task 1: Registrar a estratégia PP UHT

**Files:**
- Modify: `src/main/services/provider-timing.ts:25-112,218-227`
- Test: `test/provider-timing.test.ts`

**Interfaces:**
- Consumes: `ProviderTimingProfile`, `PROVIDER_TIMING_PROFILES` e `resolveProviderByFrameUrl(url)`.
- Produces: `EngineSpeedStrategy` com `"uht-delta-time"` e `uhtDeltaTimeFramePatternSources(): string[]`.

- [ ] **Step 1: Write the failing provider tests**

Adicionar a `test/provider-timing.test.ts`:

```ts
test("PP UHT resolves from the stable html5Game path on a dynamic host", () => {
  const profile = resolveProviderByFrameUrl(
    "https://dynamic.example/gs2c/html5Game.do?key=secret"
  );

  assert.equal(profile?.id, "pp");
  assert.equal(profile?.speedStrategy, "uht-delta-time");
});

test("PP wrapper is not treated as the UHT game document", () => {
  assert.equal(
    resolveProviderByFrameUrl("https://dynamic.example/gs2c/playGame.do?key=secret"),
    undefined
  );
});
```

- [ ] **Step 2: Run the provider tests and verify RED**

Run: `npx tsx --test test/provider-timing.test.ts`

Expected: FAIL porque o placeholder PP usa `generic-timers` e não reconhece o pathname confirmado de forma exata.

- [ ] **Step 3: Implement the registry entry and strategy selector**

Em `src/main/services/provider-timing.ts`, ampliar o tipo:

```ts
export type EngineSpeedStrategy =
  | "cocos-timescale"
  | "cocos-director-tick"
  | "uht-delta-time"
  | "generic-timers";
```

Substituir o placeholder PP por:

```ts
const PP_PROFILE: ProviderTimingProfile = {
  id: "pp",
  label: "Pragmatic Play (UHT)",
  gameFrameUrlPattern: /\/gs2c\/html5Game\.do$/i,
  speedStrategy: "uht-delta-time",
  speedRange: DEFAULT_SPEED_RANGE
};
```

Adicionar ao fim do arquivo:

```ts
export function uhtDeltaTimeFramePatternSources(): string[] {
  return PROVIDER_TIMING_PROFILES
    .filter((profile) => profile.speedStrategy === "uht-delta-time")
    .map((profile) => profile.gameFrameUrlPattern.source);
}
```

No `switch` de `patchGameSpeedScript`, deixar `uht-delta-time` retornar o body intacto, como `generic-timers`, pois o patch é de runtime e não de bundle.

- [ ] **Step 4: Run the provider tests and verify GREEN**

Run: `npx tsx --test test/provider-timing.test.ts`

Expected: todos os testes do arquivo passam.

- [ ] **Step 5: Commit the provider registry**

```powershell
git add src/main/services/provider-timing.ts test/provider-timing.test.ts
git commit -m "feat(speed): register PP UHT timing"
```

### Task 2: Escalar somente o delta UHT após o loading

**Files:**
- Modify: `src/main/services/browser-runtime.ts:35-50,5903-6275`
- Modify: `test/mirror-runtime.test.ts:133-160`
- Create: `docs/adr/0006-pp-uht-delta-time.md`

**Interfaces:**
- Consumes: `uhtDeltaTimeFramePatternSources()` e os atributos existentes `data-rtc-speed`.
- Produces: patch idempotente `Time.__predatorUhtDeltaTime` no mundo principal.

- [ ] **Step 1: Write the failing runtime serialization test**

Adicionar a `test/mirror-runtime.test.ts`:

```ts
test("PP scales only UHT deltaTime after its loader is gone", () => {
  const { harness } = createMirrorHarness();
  const script = harness.buildMainWorldControlsScript(5);

  assert.match(script, /isUhtDeltaTimeDocument/);
  assert.match(script, /loaderIsVisible !== false/);
  assert.match(script, /__predatorUhtDeltaTime/);
  assert.match(script, /rawDelta \* readRate\(\)/);
  assert.match(script, /if \(uhtDeltaTimeDocument\) \{\s*restoreSpeed\(\);\s*return;/);
});
```

- [ ] **Step 2: Run the runtime test and verify RED**

Run: `npx tsx --test test/mirror-runtime.test.ts`

Expected: FAIL porque o script ainda não serializa a detecção nem o patch UHT.

- [ ] **Step 3: Serialize the UHT patterns and keep effective rate at 1x during loading**

Importar `uhtDeltaTimeFramePatternSources` de `provider-timing.ts`. Em `buildMainWorldControlsScript`, serializar os padrões como já é feito para Cocos Director:

```js
const uhtDeltaTimePatterns = PATTERN_SOURCES.map((source) => {
  try { return new RegExp(source, "i"); } catch (error) { return null; }
}).filter(Boolean);
const isUhtDeltaTimeDocument = () => {
  try {
    const path = window.location.pathname || "";
    const href = window.location.href || "";
    return uhtDeltaTimePatterns.some((pattern) => pattern.test(path) || pattern.test(href));
  } catch (error) {
    return false;
  }
};
const uhtDeltaTimeDocument = isUhtDeltaTimeDocument();
```

Incluir o loading PP no `readRate`:

```js
const isUhtLoading = () => uhtDeltaTimeDocument && globalThis.loaderIsVisible !== false;
const readRate = () => (
  isPgLoadingOrInterstitial() || jdbLoadingState || isUhtLoading()
    ? 1
    : readDesiredRate()
);
```

- [ ] **Step 4: Install the idempotent deltaTime property and exclude generic clocks**

No `syncSpeed`, antes da regra genérica:

```js
if (uhtDeltaTimeDocument) {
  restoreSpeed();
  return;
}
```

Adicionar a instalação:

```js
const installUhtDeltaTimeSpeed = () => {
  try {
    const time = globalThis.Time;
    if (!time || typeof time.deltaTime !== "number") return false;
    if (time.__predatorUhtDeltaTime) return true;
    const descriptor = Object.getOwnPropertyDescriptor(time, "deltaTime");
    if (!descriptor || !descriptor.configurable) return false;
    let rawDelta = time.deltaTime;
    Object.defineProperty(time, "deltaTime", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() { return rawDelta * readRate(); },
      set(value) { rawDelta = Number(value) || 0; }
    });
    Object.defineProperty(time, "__predatorUhtDeltaTime", { value: true });
    return true;
  } catch (error) {
    return false;
  }
};
```

Quando `uhtDeltaTimeDocument` for verdadeiro, tentar imediatamente e repetir com o interval nativo a cada 50 ms por no máximo 300 tentativas; cancelar o interval assim que instalar.

- [ ] **Step 5: Record the final decision**

Criar `docs/adr/0006-pp-uht-delta-time.md`:

```md
# ADR 0006: Speed Time PP pelo delta UHT

## Contexto

Jogos PP usam PIXI para renderização, mas o loop proprietário `globalDoFrame` atualiza animações e lógica cliente por `Time.deltaTime`.

## Decisão

Reconhecer somente `/gs2c/html5Game.do` e multiplicar a propriedade configurável `Time.deltaTime` pela taxa dinâmica. Manter 1x enquanto `loaderIsVisible` não for exatamente `false` e não instalar relógios genéricos no PP.

## Consequências

- Animações UHT e lógica visual cliente aceleram.
- Loading, RAF, timers globais e rede permanecem no tempo normal.
- Componentes internos que usam deliberadamente `Time.deltaTime` também avançam pela taxa escolhida.
```

- [ ] **Step 6: Verify focused and full checks**

Run:

```powershell
npx tsx --test test/provider-timing.test.ts test/mirror-runtime.test.ts
npm test
npm run check
git diff --check
```

Expected: 0 falhas, TypeScript exit 0 e `git diff --check` sem erros.

- [ ] **Step 7: Commit the runtime implementation**

```powershell
git add src/main/services/browser-runtime.ts test/mirror-runtime.test.ts docs/adr/0006-pp-uht-delta-time.md
git commit -m "feat(speed): scale PP UHT delta time"
```

- [ ] **Step 8: Manual validation**

Reiniciar `npm run dev`, abrir dois jogos PP diferentes, aguardar o loader desaparecer e alterar o Speed Time. Confirmar sem apostas que personagens/textos ociosos aceleram e que loading, navegação e aba do jogo não recarregam.

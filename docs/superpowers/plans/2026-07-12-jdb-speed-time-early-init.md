# JDB Early Timing Diagnostic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture, before JDB bundles run, the native scheduling APIs retained by the proprietary runtime so a later Speed Time strategy can patch the actual clock safely.

**Architecture:** Add a single passive script builder to `BrowserRuntimeService` and concatenate its result with the existing BrowserContext init scripts. It delegates immediately to the native RAF/timeout/interval functions, retains bounded samples in memory, and sends one compact result through the existing `__spiderInputDiagnostic` binding only after JDB is identified.

**Tech Stack:** TypeScript ESM, Patchright BrowserContext init scripts, Electron main process, Node test runner (`tsx --test`).

## Global Constraints

- Work only in `spider-bot-desktop-speed-time` on `fix/issue-9-speed-time-providers`.
- Do not change a clock, timer delay, callback argument, network request, or JDB bundle body.
- Reuse `__spiderInputDiagnostic` and `%APPDATA%\Predator\input-diagnostics.log`; create no new binding or log file.
- Record at most 16 samples per API and 240 characters per callback source; never record stacks, query strings, account data, or resource response bodies.
- Remove the temporary script immediately after identifying the retained JDB scheduler.

---

## File Structure

- `src/main/services/browser-runtime.ts` — build and register the passive init script.
- `test/mirror-runtime.test.ts` — enforce serialization and pass-through boundaries.
- `docs/adr/0005-jdb-early-timing-diagnostic.md` — record why the temporary diagnostic exists and its removal condition.

### Task 1: Add the passive early-init diagnostic

**Files:**
- Modify: `test/mirror-runtime.test.ts:16-131`
- Modify: `src/main/services/browser-runtime.ts:1291-1300,2431-2512`
- Create: `docs/adr/0005-jdb-early-timing-diagnostic.md`

**Interfaces:**
- Consumes: `BrowserRuntimeService.buildInputDiagnosticsScript()` and the existing `__spiderInputDiagnostic` binding.
- Produces: `BrowserRuntimeService.buildJdbEarlyTimingDiagnosticScript(): string`, installed by `context.addInitScript`.

- [ ] **Step 1: Write the failing test**

Add this to `test/mirror-runtime.test.ts` after the PG test and add `buildJdbEarlyTimingDiagnosticScript(): string;` to `MirrorRuntimeHarness`:

```ts
test("JDB early diagnostic is bounded and never scales time", () => {
  const { harness } = createMirrorHarness();
  const script = harness.buildJdbEarlyTimingDiagnosticScript();

  assert.match(script, /jdb-early-timing-diagnostic/);
  assert.match(script, /requestAnimationFrame/);
  assert.match(script, /setTimeout/);
  assert.match(script, /setInterval/);
  assert.match(script, /jdbsgv3way|\\/h5\\/games\\//);
  assert.match(script, /slice\(0, 16\)/);
  assert.match(script, /slice\(0, 240\)/);
  assert.doesNotMatch(script, /Date\s*=|Date\.prototype|\/\s*rate|\*\s*rate/);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npx tsx --test test/mirror-runtime.test.ts`

Expected: FAIL because `buildJdbEarlyTimingDiagnosticScript` is not implemented.

- [ ] **Step 3: Implement and register the script builder**

Add this method beside `buildInputDiagnosticsScript()`:

```ts
private buildJdbEarlyTimingDiagnosticScript(): string {
  return `
(() => {
  if (window.__predatorJdbEarlyTimingDiagnosticInstalled) return;
  window.__predatorJdbEarlyTimingDiagnosticInstalled = true;
  const samples = { requestAnimationFrame: [], setTimeout: [], setInterval: [] };
  const remember = (api, callback, delay) => {
    const bucket = samples[api];
    if (!bucket || bucket.length >= 16) return;
    bucket.push({
      delay: Number.isFinite(Number(delay)) ? Number(delay) : null,
      source: typeof callback === "function" ? String(callback).slice(0, 240) : ""
    });
  };
  const nativeRaf = window.requestAnimationFrame;
  const nativeSetTimeout = window.setTimeout;
  const nativeSetInterval = window.setInterval;
  if (typeof nativeRaf === "function") {
    window.requestAnimationFrame = function(callback) {
      remember("requestAnimationFrame", callback, null);
      return nativeRaf.call(window, callback);
    };
  }
  window.setTimeout = function(callback, delay, ...args) {
    remember("setTimeout", callback, delay);
    return nativeSetTimeout.call(window, callback, delay, ...args);
  };
  window.setInterval = function(callback, delay, ...args) {
    remember("setInterval", callback, delay);
    return nativeSetInterval.call(window, callback, delay, ...args);
  };
  let emitted = false;
  const isJdb = () => {
    try {
      return Boolean(document.querySelector("#jdbGameContainer")) ||
        performance.getEntriesByType("resource").some((entry) =>
          /jdbsgv3way|\\/h5\\/games\\//i.test(String(entry.name || ""))
        );
    } catch { return false; }
  };
  const emit = () => {
    if (emitted || !isJdb()) return;
    emitted = true;
    const send = window.__spiderInputDiagnostic;
    if (typeof send === "function") {
      Promise.resolve(send({ kind: "jdb-early-timing-diagnostic", samples })).catch(() => undefined);
    }
  };
  try { new PerformanceObserver(emit).observe({ type: "resource", buffered: true }); } catch {}
  document.addEventListener("DOMContentLoaded", emit, { once: true });
  nativeSetTimeout.call(window, emit, 1500);
})();
`;
}
```

Insert `this.buildJdbEarlyTimingDiagnosticScript()` immediately after `this.buildInputDiagnosticsScript()` in the init `scripts` array.

Create `docs/adr/0005-jdb-early-timing-diagnostic.md`:

```md
# ADR 0005: Diagnóstico antecipado do agendador JDB

## Contexto

Testes no Console depois de a JDB carregar não afetaram o runtime proprietário, indicando que ele captura agendadores antes de o Console executar.

## Decisão

Registrar passivamente os primeiros usos de RAF, timeout e interval em um init script do contexto. Emitir uma amostra limitada somente depois de identificar recursos ou o contêiner JDB, pelo binding local existente.

## Consequências

- O diagnóstico não muda tempo, tráfego ou bundles.
- O resultado identifica o agendador retido no boot.
- O código deve ser removido após definir a estratégia JDB.
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `npx tsx --test test/mirror-runtime.test.ts`

Expected: PASS, including the JDB diagnostic test.

- [ ] **Step 5: Verify all work and commit**

Run: `npm test`, then `npm run check`, then `git diff --check`.

Expected: all tests pass, TypeScript exits 0, and `git diff --check` has no output.

Commit:

```powershell
git add src/main/services/browser-runtime.ts test/mirror-runtime.test.ts docs/adr/0005-jdb-early-timing-diagnostic.md
git commit -m "chore(speed): diagnose JDB early timing"
```

### Task 2: Capture a fresh JDB boot and remove the temporary script

**Files:**
- Modify: `src/main/services/browser-runtime.ts:1291-1300,2431-2512`
- Modify: `test/mirror-runtime.test.ts:115-145`
- Modify: `docs/adr/0005-jdb-early-timing-diagnostic.md`

**Interfaces:**
- Consumes: one `jdb-early-timing-diagnostic` row in `%APPDATA%\Predator\input-diagnostics.log`.
- Produces: a clean runtime with no JDB diagnostic wrappers and an ADR section naming the observed scheduler.

- [ ] **Step 1: Capture the startup evidence**

Start the desktop app from the worktree, open a new JDB game with Speed Time at 1x, wait two seconds, then read the newest `jdb-early-timing-diagnostic` row from `%APPDATA%\Predator\input-diagnostics.log`.

Expected: exactly one compact event from the JDB frame; the game remains at normal speed.

- [ ] **Step 2: Record the result**

Append `## Resultado` to ADR 0005. Record the API and callback signature prefix that identify the JDB scheduler. Do not copy a query string, a response body, or more than the 240-character callback cap.

- [ ] **Step 3: Write the failing cleanup test**

Replace the Task 1 test with:

```ts
test("runtime no longer installs the temporary JDB early diagnostic", () => {
  const { harness } = createMirrorHarness();
  const script = harness.buildInputDiagnosticsScript();

  assert.doesNotMatch(script, /jdb-early-timing-diagnostic/);
  assert.doesNotMatch(script, /__predatorJdbEarlyTimingDiagnosticInstalled/);
});
```

- [ ] **Step 4: Run the focused test and verify it fails**

Run: `npx tsx --test test/mirror-runtime.test.ts`

Expected: FAIL because the temporary script is still installed.

- [ ] **Step 5: Remove the diagnostic and verify cleanup**

Delete `buildJdbEarlyTimingDiagnosticScript()` and remove its entry from the init `scripts` array. Keep `buildInputDiagnosticsScript()` and the existing binding unchanged. Then run `npx tsx --test test/mirror-runtime.test.ts`, `npm test`, `npm run check`, and `git diff --check`.

Expected: all commands succeed and source no longer contains `__predatorJdbEarlyTimingDiagnosticInstalled`.

- [ ] **Step 6: Commit cleanup**

```powershell
git add src/main/services/browser-runtime.ts test/mirror-runtime.test.ts docs/adr/0005-jdb-early-timing-diagnostic.md
git commit -m "chore(speed): remove JDB timing diagnostic"
```

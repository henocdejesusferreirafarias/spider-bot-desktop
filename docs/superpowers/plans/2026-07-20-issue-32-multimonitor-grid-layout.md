# Issue 32 Multimonitor Grid Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir selecionar, ordenar e configurar grades independentes por monitor, distribuindo as janelas pela sequência global de slots e preservando a sobreposição desde o primeiro slot quando a capacidade for excedida.

**Architecture:** `src/shared/window-layout.ts` será a fonte única para migração, normalização, reconciliação de displays e concatenação das grades. O renderer mantém apenas o monitor atualmente editado e renderiza a barra lateral; o runtime resolve novamente os displays disponíveis em cada preview, abertura e aplicação e entrega cada slot ao conversor DPI já criado na issue #28.

**Tech Stack:** TypeScript ESM estrito, Electron 42 `screen`, Patchright/CDP, React 19, CSS existente do Spider BOT, Node `node:test` + `assert`.

## Global Constraints

- Trabalhar somente no repositório dedicado `spider-bot-desktop`, na branch `feat/issue-32-multimonitor-layout` e no worktree `spider-bot-desktop-issue-32`.
- Não implementar drag, resize, slots livres, presets, fixação de perfil ou `customSlots`.
- Reutilizar o calibrador, os controles de coluna/linha, o preview e os botões atuais; a única estrutura visual nova é a barra lateral de monitores.
- Não exibir prioridade, dimensão da grade ou quantidade de slots dentro dos itens da barra lateral.
- Listar somente displays retornados por `screen.getAllDisplays()`; preservar configurações ausentes silenciosamente.
- Impedir a desmarcação do último monitor conectado habilitado.
- Preservar `cascade` para migração e compatibilidade, mas qualquer alteração de linha/coluna seleciona `grid`.
- Preservar `FIXED_GRID_GAP = 8`, `FIXED_GRID_MARGIN = 8` e toda a conversão/validação de DPI da ADR 0010.
- Usar a ordem do array persistido como prioridade; não criar um campo `priority` redundante.
- Quando a capacidade for excedida, resolver `requestedSlotIndex % capacity`, reiniciando a sobreposição no slot global zero.
- Uma falha ao reposicionar uma janela não pode interromper as demais.
- Não adicionar dependências nem criar uma stack de testes de componentes React.
- Manter os contratos IPC atuais de `screens.listDisplays`, `screens.previewLayout` e `screens.applyLayout`.
- Gates obrigatórios: `npm test`, `npm run check`, `git diff --check` e QA manual com dois monitores.

## File Map

- Modify `src/shared/contracts.ts`: substituir o formato v1 por `ScreenLayoutSettings` v2 e `ScreenMonitorLayout`.
- Modify `src/shared/defaults.ts`: criar o registro transitório habilitado para `primary`.
- Modify `src/shared/window-layout.ts`: normalização por monitor, migração v1, reconciliação de displays, grade agregada e resolução cíclica de slots.
- Modify `src/main/services/database.ts`: migrar e persistir JSON legado ao carregar configurações.
- Create `src/renderer/lib/screen-layout-state.ts`: seleção, toggle protegido, edição e reordenação sem mover registros ocultos.
- Modify `src/renderer/components/ScreenLayoutPanel.tsx`: adicionar a barra lateral e ligar os controles atuais ao monitor selecionado.
- Modify `src/renderer/styles/app.css`: layout de duas colunas e estilos compactos usando os tokens atuais.
- Modify `src/main/services/browser-runtime.ts`: usar a sequência global em preview, launch e apply, com geometria por display.
- Modify `test/window-layout.test.ts`: adaptar os testes atuais ao layout por monitor.
- Create `test/screen-layout-settings.test.ts`: migração, reconciliação, toggle, edição e prioridade.
- Modify `test/window-layout-runtime.test.ts`: garantir preview/launch/apply multimonitor e isolamento de falha.
- Create `docs/adr/0011-grades-ordenadas-por-monitor.md`: registrar a decisão.
- Modify `docs/adr/README.md`: indexar o ADR 0011.
- Create `docs/superpowers/reports/2026-07-20-issue-32-multimonitor-manual-qa.md`: registrar a QA real.
- No change expected in `src/preload/index.ts`, `src/main/index.ts` or `src/renderer/hooks/usePredatorApp.ts`: os contratos e callbacks atuais já suportam a feature.

---

### Task 1: Versionar o modelo e migrar a configuração legada

**Files:**
- Modify: `src/shared/contracts.ts:240-275`
- Modify: `src/shared/defaults.ts:16-24`
- Modify: `src/shared/window-layout.ts:1-130`
- Modify: `src/main/services/database.ts:133-143, 1890-1929`
- Test: `test/screen-layout-settings.test.ts`
- Test: `test/database.test.ts`

**Interfaces:**
- Produces: `ScreenMonitorLayout`, `ScreenLayoutSettings`, `normalizeMonitorLayout()` e `migrateScreenLayoutSettings()`.
- Consumes: JSON desconhecido salvo em `app_settings` e o sentinel legado `primary`.

- [ ] **Step 1: Escrever os testes falhando de migração e normalização**

Criar `test/screen-layout-settings.test.ts` com estes casos iniciais:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  migrateScreenLayoutSettings,
  normalizeMonitorLayout
} from "../src/shared/window-layout.js";

test("migra layout v1 e preserva monitor, modo e eixos", () => {
  assert.deepEqual(
    migrateScreenLayoutSettings({
      monitorId: "primary",
      mode: "cascade",
      columns: 5,
      rows: 2,
      gap: 99,
      margin: 99,
      customSlots: [{ id: "legacy" }]
    }),
    {
      version: 2,
      monitors: [{
        displayId: "primary",
        enabled: true,
        mode: "cascade",
        columns: 5,
        rows: 2
      }]
    }
  );
});

test("normaliza eixos, modo e ids duplicados do formato v2", () => {
  assert.deepEqual(
    migrateScreenLayoutSettings({
      version: 2,
      monitors: [
        { displayId: "7", enabled: true, mode: "custom", columns: 5.9, rows: 0 },
        { displayId: "7", enabled: false, mode: "cascade", columns: 2, rows: 3 },
        { displayId: "", enabled: true, mode: "grid", columns: 2, rows: 2 }
      ]
    }),
    {
      version: 2,
      monitors: [{
        displayId: "7",
        enabled: true,
        mode: "grid",
        columns: 5,
        rows: 1
      }]
    }
  );
  assert.deepEqual(
    normalizeMonitorLayout({ displayId: "8", enabled: false, mode: "cascade", columns: 3.8, rows: 2.9 }),
    { displayId: "8", enabled: false, mode: "cascade", columns: 3, rows: 2 }
  );
});
```

Adicionar em `test/database.test.ts` um teste que escreva no `app_settings` o JSON v1, reabra `PredatorDatabase`, confirme `version: 2` e leia novamente `value_json` para provar que a migração foi persistida.

- [ ] **Step 2: Executar apenas os testes novos e confirmar a falha**

Run:

```powershell
npx tsx --test test/screen-layout-settings.test.ts test/database.test.ts
```

Expected: FAIL porque `migrateScreenLayoutSettings`, `normalizeMonitorLayout` e o contrato v2 ainda não existem.

- [ ] **Step 3: Substituir o contrato persistido**

Em `src/shared/contracts.ts`, usar exatamente:

```ts
export type ScreenLayoutMode = "grid" | "cascade";

export interface ScreenMonitorLayout {
  displayId: string;
  enabled: boolean;
  mode: ScreenLayoutMode;
  columns: number;
  rows: number;
}

export interface ScreenLayoutSettings {
  version: 2;
  monitors: ScreenMonitorLayout[];
}
```

Manter `ScreenLayoutSlot`, pois ele continua sendo o formato percentual do preview embutido. Remover apenas o uso persistido de `monitorId`, `gap`, `margin` e `customSlots`.

- [ ] **Step 4: Criar o default v2 e os normalizadores puros**

Em `src/shared/defaults.ts`:

```ts
screenLayout: {
  version: 2,
  monitors: [{
    displayId: "primary",
    enabled: true,
    mode: "grid",
    columns: 4,
    rows: 1
  }]
},
```

Em `src/shared/window-layout.ts`, adicionar um parser defensivo que aceite `unknown`, dedupe pelo primeiro `displayId` válido e normalize os eixos:

```ts
export function normalizeMonitorLayout(layout: ScreenMonitorLayout): ScreenMonitorLayout {
  return {
    displayId: layout.displayId.trim(),
    enabled: layout.enabled === true,
    mode: layout.mode === "cascade" ? "cascade" : "grid",
    columns: sanitizeAxis(layout.columns),
    rows: sanitizeAxis(layout.rows)
  };
}

export function migrateScreenLayoutSettings(value: unknown): ScreenLayoutSettings {
  const candidate = isRecord(value) ? value : {};
  if (candidate.version === 2 && Array.isArray(candidate.monitors)) {
    const seen = new Set<string>();
    const monitors = candidate.monitors.flatMap((item) => {
      if (!isRecord(item) || typeof item.displayId !== "string") return [];
      const normalized = normalizeMonitorLayout({
        displayId: item.displayId,
        enabled: item.enabled === true,
        mode: item.mode === "cascade" ? "cascade" : "grid",
        columns: toFiniteNumber(item.columns, 4),
        rows: toFiniteNumber(item.rows, 1)
      });
      if (!normalized.displayId || seen.has(normalized.displayId)) return [];
      seen.add(normalized.displayId);
      return [normalized];
    });
    return { version: 2, monitors: monitors.length ? monitors : defaultPrimaryMonitors() };
  }

  return {
    version: 2,
    monitors: [{
      displayId: typeof candidate.monitorId === "string" && candidate.monitorId.trim()
        ? candidate.monitorId.trim()
        : "primary",
      enabled: true,
      mode: candidate.mode === "cascade" ? "cascade" : "grid",
      columns: sanitizeAxis(toFiniteNumber(candidate.columns, 4)),
      rows: sanitizeAxis(toFiniteNumber(candidate.rows, 1))
    }]
  };
}
```

Implementar `isRecord`, `toFiniteNumber` e `defaultPrimaryMonitors` no mesmo módulo, sem casts amplos no chamador.

- [ ] **Step 5: Migrar e persistir no carregamento do banco**

Em `database.ts`, trocar o merge campo a campo legado por:

```ts
const storedSettings = jsonParse<Partial<AppSettings> & { screenLayout?: unknown }>(
  row.value_json,
  {}
);
const loadedSettings: AppSettings = {
  ...defaultSettings,
  ...storedSettings,
  screenLayout: migrateScreenLayoutSettings(storedSettings.screenLayout),
  exportDirectory: this.paths.exportsRoot
};
const settings = normalizeSettings(loadedSettings);

if (JSON.stringify(settings.screenLayout) !== JSON.stringify(storedSettings.screenLayout)) {
  this.setSettings(settings);
}
```

Também chamar `migrateScreenLayoutSettings(settings.screenLayout)` dentro de `normalizeSettings()` para que `updateSettings()` nunca persista um formato parcial.

- [ ] **Step 6: Rodar os testes focados e o typecheck**

Run:

```powershell
npx tsx --test test/screen-layout-settings.test.ts test/database.test.ts
npm run check
```

Expected: PASS; o typecheck pode apontar consumidores do contrato antigo. Corrigir apenas os usos mecânicos necessários para deixar o build verde, sem implementar ainda a lógica multimonitor.

- [ ] **Step 7: Commit atômico**

```powershell
git add src/shared/contracts.ts src/shared/defaults.ts src/shared/window-layout.ts src/main/services/database.ts test/screen-layout-settings.test.ts test/database.test.ts
git commit -m "feat: version multimonitor screen layout settings"
```

---

### Task 2: Reconciliar displays e construir a sequência global de slots

**Files:**
- Modify: `src/shared/window-layout.ts`
- Modify: `test/window-layout.test.ts`
- Modify: `test/screen-layout-settings.test.ts`

**Interfaces:**
- Produces: `reconcileScreenLayout()`, `buildMultiDisplayLogicalLayout()`, `resolveMultiDisplaySlot()` e os tipos agregados.
- Consumes: `ScreenLayoutSettings` v2 e `ScreenDisplayInfo[]` atualizados.

- [ ] **Step 1: Adaptar o helper dos testes da grade local**

Em `test/window-layout.test.ts`, substituir o helper v1 por:

```ts
const monitor = (
  displayId: string,
  columns: number,
  rows: number,
  enabled = true
): ScreenMonitorLayout => ({
  displayId,
  enabled,
  mode: "grid",
  columns,
  rows
});
```

Manter as asserções já existentes de grid `5x2`, percentuais e cascata, agora passando `ScreenMonitorLayout` para `buildLogicalLayout()`.

- [ ] **Step 2: Escrever os testes falhando de reconciliação e concatenação**

Adicionar casos que provem:

```ts
const displays: ScreenDisplayInfo[] = [
  {
    id: "1", label: "M1", primary: true, scaleFactor: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1280, height: 672 }
  },
  {
    id: "2", label: "M2", primary: false, scaleFactor: 1.5,
    bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
    workArea: { x: 1280, y: 0, width: 1707, height: 920 }
  }
];

test("concatena duas grades 5x2 em ordem global", () => {
  const result = buildMultiDisplayLogicalLayout(
    { version: 2, monitors: [monitor("1", 5, 2), monitor("2", 5, 2)] },
    displays
  );
  assert.equal(result.capacity, 20);
  assert.deepEqual(result.slots.map((slot) => [slot.displayId, slot.localSlotIndex, slot.globalSlotIndex]), [
    ...Array.from({ length: 10 }, (_, index) => ["1", index, index]),
    ...Array.from({ length: 10 }, (_, index) => ["2", index, index + 10])
  ]);
  assert.equal(resolveMultiDisplaySlot(result, 20).globalSlotIndex, 0);
  assert.equal(resolveMultiDisplaySlot(result, 20).requestedSlotIndex, 20);
});

test("ignora monitor ausente ou desabilitado sem apagar a configuracao", () => {
  const settings = { version: 2, monitors: [monitor("1", 2, 1, false), monitor("hidden", 7, 3)] } as const;
  const reconciled = reconcileScreenLayout(settings, displays);
  assert.deepEqual(reconciled.monitors.map((item) => item.displayId), ["1", "hidden", "2"]);
  assert.equal(reconciled.monitors.find((item) => item.displayId === "hidden")?.columns, 7);
  assert.equal(reconciled.monitors.find((item) => item.displayId === "1")?.enabled, true);
  assert.equal(buildMultiDisplayLogicalLayout(reconciled, displays).capacity, 2);
});
```

Adicionar também: ordem invertida, eixos diferentes, sentinel `primary` substituído pelo ID real, fallback no principal quando nenhum conectado está habilitado e erro explícito para `resolveMultiDisplaySlot()` com capacidade zero.

- [ ] **Step 3: Executar e confirmar a falha**

```powershell
npx tsx --test test/window-layout.test.ts test/screen-layout-settings.test.ts
```

Expected: FAIL porque as funções agregadas ainda não existem.

- [ ] **Step 4: Implementar os tipos e a reconciliação**

Em `window-layout.ts`, adicionar:

```ts
export type AvailableScreenDisplay = Pick<
  ScreenDisplayInfo,
  "id" | "primary" | "scaleFactor" | "bounds" | "workArea"
>;

export interface MultiDisplayLogicalSlot extends LogicalLayoutSlot {
  displayId: string;
  localSlotIndex: number;
  globalSlotIndex: number;
}

export interface ResolvedDisplayLayout {
  display: AvailableScreenDisplay;
  monitor: ScreenMonitorLayout;
  slots: MultiDisplayLogicalSlot[];
}

export interface MultiDisplayLogicalLayout {
  displays: ResolvedDisplayLayout[];
  slots: MultiDisplayLogicalSlot[];
  capacity: number;
}

export interface ResolvedMultiDisplaySlot extends MultiDisplayLogicalSlot {
  requestedSlotIndex: number;
}
```

`reconcileScreenLayout()` deve seguir esta ordem:

1. migrar/normalizar sem remover registros ausentes;
2. substituir o primeiro sentinel `primary` pelo ID concreto do display principal;
3. se o ID concreto já existir, remover o sentinel e preservar a configuração concreta; se não existir, substituir o sentinel no mesmo índice;
4. anexar displays conectados ainda não configurados com `enabled: false`, grid `4x1`;
5. se nenhum registro conectado estiver habilitado, habilitar o principal disponível;
6. retornar os registros ausentes exatamente nas posições relativas restantes.

- [ ] **Step 5: Implementar a concatenação e o módulo**

```ts
export function buildMultiDisplayLogicalLayout(
  settings: ScreenLayoutSettings,
  availableDisplays: AvailableScreenDisplay[]
): MultiDisplayLogicalLayout {
  const reconciled = reconcileScreenLayout(settings, availableDisplays);
  const displayById = new Map(availableDisplays.map((display) => [display.id, display]));
  let globalSlotIndex = 0;
  const displays = reconciled.monitors.flatMap((monitor) => {
    const display = displayById.get(monitor.displayId);
    if (!display || !monitor.enabled) return [];
    const logical = buildLogicalLayout(display.workArea, monitor);
    const slots = logical.slots.map((slot) => ({
      ...slot,
      slotIndex: globalSlotIndex,
      displayId: display.id,
      localSlotIndex: slot.slotIndex,
      globalSlotIndex: globalSlotIndex++
    }));
    return [{ display, monitor, slots }];
  });
  const slots = displays.flatMap((display) => display.slots);
  return { displays, slots, capacity: slots.length };
}

export function resolveMultiDisplaySlot(
  layout: MultiDisplayLogicalLayout,
  requestedSlotIndex: number
): ResolvedMultiDisplaySlot {
  if (layout.capacity < 1) throw new Error("Layout sem slots disponíveis.");
  const normalizedIndex = Math.max(0, Math.trunc(requestedSlotIndex));
  const template = layout.slots[normalizedIndex % layout.capacity];
  if (!template) throw new Error("Layout sem slots disponíveis.");
  return { ...template, slotIndex: normalizedIndex, requestedSlotIndex: normalizedIndex };
}
```

- [ ] **Step 6: Rodar a suíte lógica**

```powershell
npx tsx --test test/window-layout.test.ts test/screen-layout-settings.test.ts test/window-geometry.test.ts
```

Expected: PASS, incluindo todas as regressões da ADR 0010.

- [ ] **Step 7: Commit atômico**

```powershell
git add src/shared/window-layout.ts test/window-layout.test.ts test/screen-layout-settings.test.ts
git commit -m "feat: build ordered multimonitor slot sequence"
```

---

### Task 3: Aplicar a sequência global no runtime e no preview fantasma

**Files:**
- Modify: `src/main/services/browser-runtime.ts:330-354, 1531-1585, 7802-7865`
- Modify: `test/window-layout-runtime.test.ts`

**Interfaces:**
- Consumes: `buildMultiDisplayLogicalLayout()` e `resolveMultiDisplaySlot()`.
- Preserves: `buildDpiAwarePlacement()`, `toPreviewDipRect()` e tolerância de dois pixels.

`LayoutPreviewResult` é interno ao processo principal e deve passar a representar somente a lista plana necessária por `showLayoutPreview()`:

```ts
export interface LayoutPreviewSlot {
  displayId: string;
  globalSlotIndex: number;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  overlaps: boolean;
  cutOff: boolean;
}

export interface LayoutPreviewResult {
  slots: LayoutPreviewSlot[];
}
```

Remover `mode` e `workArea` do resultado agregado: não existe um único valor correto em uma grade multimonitor e `src/main/index.ts` já consome somente `preview.slots`.

- [ ] **Step 1: Escrever um harness de displays e os testes falhando**

No teste do runtime, injetar displays por um método privado substituível em teste:

```ts
const availableDisplays = [
  {
    id: "1", primary: true, scaleFactor: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 }
  },
  {
    id: "2", primary: false, scaleFactor: 1.5,
    bounds: { x: -2560, y: 0, width: 2560, height: 1440 },
    workArea: { x: -1707, y: 0, width: 1707, height: 920 }
  }
];

const settings = {
  ...defaultSettings,
  screenLayout: {
    version: 2,
    monitors: [
      { displayId: "1", enabled: true, mode: "grid", columns: 1, rows: 1 },
      { displayId: "2", enabled: true, mode: "grid", columns: 1, rows: 1 }
    ]
  }
};
```

Testar via harness privado:

- slot solicitado `0` usa display `1`;
- slot solicitado `1` usa display `2` e origem negativa;
- slot solicitado `2` volta ao display `1`, mas mantém `placement.slotIndex === 2`;
- o preview retorna slots de ambos os displays na ordem global;
- cada chamada resolve novamente a lista de displays;
- `applyLayout()` continua depois de uma página falhar e notifica cada handle separadamente.

- [ ] **Step 2: Executar e confirmar a falha**

```powershell
npx tsx --test test/window-layout-runtime.test.ts test/window-geometry.test.ts
```

Expected: FAIL porque o runtime ainda resolve apenas `monitorId` e uma grade.

- [ ] **Step 3: Centralizar a leitura atual dos displays**

Substituir `resolveLayoutDisplay()` por:

```ts
private getAvailableLayoutDisplays(): AvailableScreenDisplay[] {
  const primaryId = String(screen.getPrimaryDisplay().id);
  return screen.getAllDisplays().map((display) => ({
    id: String(display.id),
    primary: String(display.id) === primaryId,
    scaleFactor: display.scaleFactor,
    bounds: display.bounds,
    workArea: display.workArea
  }));
}

private buildCurrentLogicalLayout(settings: AppSettings): MultiDisplayLogicalLayout {
  return buildMultiDisplayLogicalLayout(
    settings.screenLayout,
    this.getAvailableLayoutDisplays()
  );
}
```

Esses métodos devem permanecer privados, mas serem acessíveis pelo padrão de harness já usado nos testes do repositório.

- [ ] **Step 4: Resolver placements globais por display**

Atualizar `buildBrowserPlacement()`:

```ts
private buildBrowserPlacement(settings: AppSettings, forcedSlotIndex?: number): DpiAwarePlacement {
  const logical = this.buildCurrentLogicalLayout(settings);
  const requestedSlotIndex = forcedSlotIndex ?? this.allocateSlotIndex(logical.capacity);
  const slot = resolveMultiDisplaySlot(logical, requestedSlotIndex);
  const resolvedDisplay = logical.displays.find(({ display }) => display.id === slot.displayId);
  if (!resolvedDisplay) throw new Error(`Monitor ${slot.displayId} indisponível.`);
  return buildDpiAwarePlacement(
    slot,
    resolvedDisplay.monitor.mode,
    resolvedDisplay.display.bounds,
    resolvedDisplay.display.workArea,
    (rect) => screen.dipToScreenRect(null, rect)
  );
}
```

Manter `allocateSlotIndex(capacity)` procurando lacunas entre índices dos handles e dos launches; quando todos estiverem ocupados, retornar `occupiedSlots.size`. A resolução cíclica acontece somente em `resolveMultiDisplaySlot()`.

- [ ] **Step 5: Produzir o preview fantasma agregado**

`getLayoutPreviewRects()` deve percorrer `logical.slots`, localizar o display de cada slot e retornar uma lista plana. Usar `String(slot.globalSlotIndex + 1)` como label e o conversor correspondente a esse display. `showLayoutPreview()` em `src/main/index.ts` já percorre uma lista plana, portanto não precisa ser alterado.

- [ ] **Step 6: Simplificar a redistribuição do apply**

Em `applyLayout()`:

```ts
const handles = [...this.handles.entries()].sort(([, a], [, b]) => a.slotIndex - b.slotIndex);

for (const [nextSlotIndex, [profileId, handle]] of handles.entries()) {
  try {
    const placement = this.buildBrowserPlacement(this.resolvePlacementSettings(settings), nextSlotIndex);
    // preservar seleção de page, applyPlacementToPage, badges e atualização do handle
  } catch (error) {
    this.notify(profileId, "active", "Layout salvo, mas esta janela não pôde ser reposicionada.");
  }
}
```

Não usar `Promise.all` aqui: a ordem é útil para diagnóstico e o requisito é apenas isolar falhas. Preservar a escala `handle.launchedScale`, o readback CDP e a tolerância de dois pixels.

- [ ] **Step 7: Rodar os testes de runtime e geometria**

```powershell
npx tsx --test test/window-layout-runtime.test.ts test/window-geometry.test.ts
npm run check
```

Expected: PASS; nenhuma regressão em DPI, bounds ou relaunch.

- [ ] **Step 8: Commit atômico**

```powershell
git add src/main/services/browser-runtime.ts test/window-layout-runtime.test.ts
git commit -m "feat: distribute browser windows across monitors"
```

---

### Task 4: Adicionar a barra lateral e editar uma grade por vez

**Files:**
- Create: `src/renderer/lib/screen-layout-state.ts`
- Modify: `src/renderer/components/ScreenLayoutPanel.tsx`
- Modify: `src/renderer/styles/app.css:4120-4365`
- Modify: `test/screen-layout-settings.test.ts`

**Interfaces:**
- Consumes: `reconcileScreenLayout()`, `buildLogicalLayout()` e `toPercentSlot()`.
- Produces: handlers puros de toggle, patch e movimento, testáveis sem DOM.

- [ ] **Step 1: Escrever os testes falhando da interação pura**

Adicionar a `test/screen-layout-settings.test.ts`:

```ts
import {
  moveConnectedMonitor,
  patchMonitorLayout,
  toggleConnectedMonitor
} from "../src/renderer/lib/screen-layout-state.js";

test("toggle altera somente enabled e impede a ultima desmarcacao conectada", () => {
  const settings = {
    version: 2,
    monitors: [monitor("1", 5, 2), monitor("hidden", 7, 3), monitor("2", 4, 1, false)]
  } as ScreenLayoutSettings;
  const blocked = toggleConnectedMonitor(settings, ["1", "2"], "1", false);
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.settings, settings);
  const enabled = toggleConnectedMonitor(settings, ["1", "2"], "2", true);
  assert.equal(enabled.blocked, false);
  assert.equal(enabled.settings.monitors.find((item) => item.displayId === "2")?.enabled, true);
});

test("mover monitores conectados troca somente seus slots no array completo", () => {
  const settings = {
    version: 2,
    monitors: [monitor("1", 5, 2), monitor("hidden", 7, 3), monitor("2", 4, 1)]
  } as ScreenLayoutSettings;
  const moved = moveConnectedMonitor(settings, ["1", "2"], "2", -1);
  assert.deepEqual(moved.monitors.map((item) => item.displayId), ["2", "hidden", "1"]);
  assert.equal(moved.monitors[1]?.columns, 7);
});

test("editar grade altera somente o monitor selecionado e força grid", () => {
  const settings = {
    version: 2,
    monitors: [
      { ...monitor("1", 5, 2), mode: "cascade" },
      monitor("2", 4, 1)
    ]
  } as ScreenLayoutSettings;
  const next = patchMonitorLayout(settings, "1", { columns: 6 });
  assert.deepEqual(next.monitors[0], { ...settings.monitors[0], mode: "grid", columns: 6 });
  assert.deepEqual(next.monitors[1], settings.monitors[1]);
});
```

- [ ] **Step 2: Executar e confirmar a falha**

```powershell
npx tsx --test test/screen-layout-settings.test.ts
```

Expected: FAIL porque `screen-layout-state.ts` não existe.

- [ ] **Step 3: Implementar os helpers de estado sem React**

Criar `src/renderer/lib/screen-layout-state.ts` com:

```ts
export interface ToggleMonitorResult {
  settings: ScreenLayoutSettings;
  blocked: boolean;
}

export function toggleConnectedMonitor(
  settings: ScreenLayoutSettings,
  connectedIds: readonly string[],
  displayId: string,
  enabled: boolean
): ToggleMonitorResult;

export function moveConnectedMonitor(
  settings: ScreenLayoutSettings,
  connectedIds: readonly string[],
  displayId: string,
  direction: -1 | 1
): ScreenLayoutSettings;

export function patchMonitorLayout(
  settings: ScreenLayoutSettings,
  displayId: string,
  patch: Partial<Pick<ScreenMonitorLayout, "mode" | "columns" | "rows">>
): ScreenLayoutSettings;
```

`moveConnectedMonitor()` deve encontrar o conectado anterior/próximo na ordem persistida e trocar somente os dois registros completos. `patchMonitorLayout()` força `mode: "grid"` apenas quando `columns` ou `rows` estiverem no patch e normaliza o monitor alterado.

- [ ] **Step 4: Reconciliar displays ao carregar e atualizar**

No componente, manter `selectedDisplayId` separado da habilitação. `refreshDisplays()` deve:

1. chamar `window.predator.screens.listDisplays()`;
2. calcular `reconcileScreenLayout(settings.screenLayout, nextDisplays)`;
3. atualizar `displays`;
4. selecionar o ID anterior se ainda estiver conectado, senão o principal, senão o primeiro;
5. chamar `onUpdate({ screenLayout: reconciled })` somente se o JSON do layout mudou.

Usar `useCallback` para estabilizar `refreshDisplays` e um `useEffect` de montagem. O botão `Atual.` continua chamando a mesma função.

- [ ] **Step 5: Renderizar somente a barra lateral nova**

Estruturar o stage assim, preservando o calibrador atual sem redesenho:

```tsx
<div className="screen-layout-stage">
  <aside className="screen-monitor-sidebar" aria-label="Monitores disponíveis">
    <div className="screen-monitor-list">
      {orderedDisplays.map((display, index) => {
        const monitor = layout.monitors.find((item) => item.displayId === display.id);
        if (!monitor) return null;
        const selected = display.id === selectedDisplayId;
        return (
          <div
            className={`screen-monitor-item${selected ? " selected" : ""}`}
            key={display.id}
            onClick={() => setSelectedDisplayId(display.id)}
            role="button"
            tabIndex={0}
          >
            <input
              aria-label={`Usar ${display.label}`}
              checked={monitor.enabled}
              onChange={(event) => handleMonitorToggle(display.id, event.target.checked)}
              onClick={(event) => event.stopPropagation()}
              type="checkbox"
            />
            <div className="screen-monitor-copy">
              <strong>{display.label}{display.primary ? " · Principal" : ""}</strong>
              <span>{display.bounds.width}×{display.bounds.height} · {Math.round(display.scaleFactor * 100)}%</span>
            </div>
            <div className="screen-monitor-order">
              <button aria-label={`Subir ${display.label}`} disabled={index === 0} type="button">↑</button>
              <button aria-label={`Descer ${display.label}`} disabled={index === orderedDisplays.length - 1} type="button">↓</button>
            </div>
          </div>
        );
      })}
    </div>
    {guardMessage && <p className="screen-monitor-guard" role="status">{guardMessage}</p>}
  </aside>
  <section className="screen-calibrator">{/* conteúdo atual */}</section>
</div>
```

Adicionar suporte de teclado Enter/Espaço para seleção do item. Os botões de ordem e checkbox devem chamar `stopPropagation()`. Não renderizar texto de prioridade, `5x2` ou quantidade de slots.

- [ ] **Step 6: Ligar preview e controles ao monitor selecionado**

Derivar `selectedMonitor` pelo `selectedDisplayId`; para a simulação embutida, chamar `buildLogicalLayout(selectedDisplay.workArea, selectedMonitor)` mesmo se o monitor estiver desabilitado, permitindo configurar antes de habilitar. Atualizar `columns` e `rows` por `patchMonitorLayout()` e manter os inputs locais `colStr`/`rowStr` sincronizados ao trocar a seleção.

Remover o `<select>` de monitor da barra inferior. Preservar, na mesma ordem visual, botão `Atual.`, controles `Col`/`Lin`, `Pré-visualização` e `Aplicar Agora`.

- [ ] **Step 7: Aplicar os estilos usando a identidade existente**

Em `app.css`:

```css
.screen-layout-stage {
  grid-template-columns: clamp(168px, 22vw, 220px) minmax(0, 1fr);
}

.screen-monitor-sidebar,
.screen-monitor-item {
  border: 1px solid var(--glass-border);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent), rgba(11, 11, 14, 0.66);
}

.screen-monitor-sidebar {
  min-height: 0;
  padding: 6px;
  border-radius: var(--radius-md);
  overflow: auto;
}

.screen-monitor-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  padding: 7px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.screen-monitor-item.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(226, 38, 38, 0.18);
}
```

Completar estados hover/focus/disabled, ellipsis no nome e botões compactos. Ajustar `.screen-bottom-bar` para remover a coluna do select, sem alterar as cores dos botões atuais.

- [ ] **Step 8: Rodar testes e build do renderer**

```powershell
npx tsx --test test/screen-layout-settings.test.ts test/window-layout.test.ts
npm run check
npm run build:renderer
```

Expected: PASS e build Vite sem warnings novos.

- [ ] **Step 9: Commit atômico**

```powershell
git add src/renderer/lib/screen-layout-state.ts src/renderer/components/ScreenLayoutPanel.tsx src/renderer/styles/app.css test/screen-layout-settings.test.ts
git commit -m "feat: add compact monitor layout sidebar"
```

---

### Task 5: Registrar a decisão arquitetural e preparar a QA

**Files:**
- Create: `docs/adr/0011-grades-ordenadas-por-monitor.md`
- Modify: `docs/adr/README.md`
- Create: `docs/superpowers/reports/2026-07-20-issue-32-multimonitor-manual-qa.md`

- [ ] **Step 1: Escrever o ADR 0011**

Registrar:

- contexto da issue #32 e redução de escopo;
- decisão pelo array ordenado `ScreenMonitorLayout[]`;
- concatenação das grades em slots globais e módulo sobre a capacidade;
- preservação silenciosa de registros ausentes;
- fallback no principal e sentinel transitório da migração;
- reutilização explícita da ADR 0010 para DIP, físico e readback;
- consequências: distribuição determinística, configuração recuperável e ausência de pinagem por perfil.

- [ ] **Step 2: Indexar o ADR**

Adicionar ao final da tabela/lista de `docs/adr/README.md` uma entrada para `0011-grades-ordenadas-por-monitor.md` com status `Aceito`.

- [ ] **Step 3: Criar o relatório de QA sem inventar resultados**

Criar o relatório com cabeçalho de ambiente e uma tabela inicialmente `PENDENTE`:

```md
| Cenário | Evidência esperada | Resultado | Evidência real |
| --- | --- | --- | --- |
| 2 monitores, grades 5x2 | slots 0-9 no primeiro e 10-19 no segundo | PENDENTE | |
| 21ª janela | sobrepõe o slot global 0 | PENDENTE | |
| Reordenação | distribuição troca de monitor | PENDENTE | |
| Última desmarcação | configuração não muda e aviso aparece | PENDENTE | |
| Desconectar/reconectar | item some e retorna com configuração | PENDENTE | |
| Preview fantasma | molduras nos dois monitores | PENDENTE | |
| Reinício/migração | v2 persistido sem perder grade v1 | PENDENTE | |
```

Incluir campos para ID, resolução, work area, escala, origem, geometria solicitada, bounds retornados e caminho absoluto das capturas.

- [ ] **Step 4: Verificar documentação e commit**

```powershell
git diff --check
git add docs/adr/0011-grades-ordenadas-por-monitor.md docs/adr/README.md docs/superpowers/reports/2026-07-20-issue-32-multimonitor-manual-qa.md
git commit -m "docs: record ordered multimonitor grid decision"
```

---

### Task 6: Verificação automatizada e QA manual real

**Files:**
- Modify: `docs/superpowers/reports/2026-07-20-issue-32-multimonitor-manual-qa.md`

- [ ] **Step 1: Rodar os gates automatizados completos**

```powershell
npm test
npm run check
npm run build
git diff --check
```

Expected: todos PASS. Registrar contagem de testes, duração e artefatos do build no relatório.

- [ ] **Step 2: Iniciar o app e validar a barra lateral**

```powershell
npm run dev
```

Confirmar visualmente:

- somente monitores conectados aparecem;
- a lista contém apenas checkbox, nome/principal, resolução/escala e setas;
- seleção não altera habilitação;
- última desmarcação mostra aviso e não persiste;
- controles e botões originais permanecem alinhados;
- foco por teclado e estados disabled são visíveis.

- [ ] **Step 3: Validar distribuição 5x2, overflow e prioridade**

Com dois monitores habilitados em `5x2`, abrir vinte perfis e registrar dez janelas em cada monitor. Abrir a 21ª e confirmar sobreposição no slot global zero. Trocar a prioridade e usar `Aplicar Agora`; confirmar que a distribuição inverte sem reiniciar janelas.

- [ ] **Step 4: Validar DPI, preview e tolerância de bounds**

Usar dois monitores com resoluções e, quando disponível, escalas diferentes. Registrar preview fantasma, posição física observada, retângulo solicitado e `Browser.getWindowBounds`. Confirmar origens negativas/positivas e diferença máxima de dois pixels.

- [ ] **Step 5: Validar desconexão, reconexão e persistência**

Desconectar o secundário, atualizar a lista, confirmar que ele some e que somente o principal recebe janelas. Reconectar com o mesmo ID, atualizar e confirmar retorno de habilitação, prioridade e grade. Reiniciar o app e confirmar o mesmo estado. Para migração, usar uma cópia isolada do banco ou fixture; nunca sobrescrever dados reais do usuário.

- [ ] **Step 6: Preencher o relatório apenas com evidências observadas**

Trocar cada `PENDENTE` por `PASS` ou `FAIL`, anexar capturas e dados medidos. Se houver `FAIL`, parar a finalização, escrever um teste de regressão e voltar à task correspondente.

- [ ] **Step 7: Revisar escopo e ausência de resíduos legados**

```powershell
rg -n "monitorId|customSlots|screen-monitor-field" src test
rg -n 'Prioridade:|[0-9]+ slots' src/renderer/components/ScreenLayoutPanel.tsx
git status --short
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: `monitorId`/`customSlots` aparecem apenas em parser/testes de migração, `screen-monitor-field` não aparece, os textos proibidos não aparecem na barra lateral e nenhum arquivo não relacionado entra no diff.

- [ ] **Step 8: Commit da evidência real**

```powershell
git add docs/superpowers/reports/2026-07-20-issue-32-multimonitor-manual-qa.md
git commit -m "test: document issue 32 multimonitor manual QA"
```

---

## Final Review Checklist

- [ ] Todos os critérios de aceite da spec têm teste automatizado ou passo explícito de QA.
- [ ] O layout v1 migra uma vez e o JSON v2 é persistido.
- [ ] Registros ausentes nunca são removidos por reconciliação, toggle, edição ou reorder.
- [ ] O fallback no principal funciona no renderer e no runtime.
- [ ] Preview embutido, preview fantasma, abertura e aplicação derivam das mesmas grades compartilhadas.
- [ ] O slot solicitado continua crescente e apenas a resolução geométrica usa módulo da capacidade.
- [ ] A barra lateral não exibe prioridade, grade ou capacidade.
- [ ] A geometria por monitor continua usando a fronteira DPI da ADR 0010.
- [ ] Nenhuma dependência foi adicionada.
- [ ] `npm test`, `npm run check`, `npm run build` e `git diff --check` passaram na execução final.
- [ ] O relatório manual contém evidência real, não resultados presumidos.

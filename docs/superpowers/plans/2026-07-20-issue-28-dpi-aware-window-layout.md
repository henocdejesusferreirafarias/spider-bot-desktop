# Issue 28 DPI-Aware Window Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer preview, lançamento e aplicação do organizador ocuparem a mesma área útil física em qualquer escala do Windows, sem reiniciar nem avisar sobre a escala interna de janelas abertas.

**Architecture:** A grade lógica passa a existir uma única vez em `src/shared/window-layout.ts`, sempre em DIP. O processo principal converte o slot DIP em retângulo físico e só então compensa `force-device-scale-factor` em `src/main/services/window-geometry.ts`; `BrowserRuntimeService` orquestra lançamento, preview e aplicação, guardando separadamente a escala ideal e a escala efetivamente lançada.

**Tech Stack:** TypeScript ESM estrito, Electron 42 `screen`, Patchright/CDP, Node `node:test` + `assert`, React 19.

## Global Constraints

- Trabalhar somente no repositório dedicado `spider-bot-desktop`, na branch `fix/issue-28-dpi-layout` e no worktree `spider-bot-desktop-issue-28`.
- Preservar `FIXED_GRID_GAP = 8`, `FIXED_GRID_MARGIN = 8`, escala de interface entre `0.5` e `1`, largura mínima Chromium `500` e altura mínima `250`.
- Manter a grade em DIP e usar `screen.dipToScreenRect(null, rect)` na fronteira com pixels físicos; nunca multiplicar coordenadas globais diretamente por `scaleFactor`.
- Aplicar em janelas abertas sem relaunch e sem a mensagem “Reabra este navegador para ajustar a escala da interface”.
- Preservar os alertas de sobreposição e corte quando uma grade densa satura o piso de escala.
- Resolver as métricas do monitor novamente em preview, lançamento e aplicação; não criar reorganização automática no evento de mudança de DPI.
- Não remover nem alterar a máscara de fingerprint de `devicePixelRatio`.
- Tolerar no máximo dois pixels de diferença em cada eixo ou dimensão ao validar bounds do Chromium.
- Não adicionar dependências.
- Verificação final obrigatória: `npm run check`, `npm test`, `git diff --check` e QA manual em 100%, 150% e mais uma escala entre 125%/200%.

## File Map

- Create `src/shared/window-layout.ts`: normalização e slots lógicos em DIP, consumidos por main e renderer.
- Create `src/main/services/window-geometry.ts`: DIP → físico → geometria Chromium, escala adaptativa, pegada efetiva e comparação de bounds.
- Modify `src/renderer/components/ScreenLayoutPanel.tsx`: remover a fórmula duplicada e consumir os slots compartilhados.
- Modify `src/main/services/browser-runtime.ts`: usar a nova geometria em preview, launch e apply; separar `idealScale` de `launchedScale`; ler bounds após aplicar.
- Create `test/window-layout.test.ts`: regressão da grade lógica e dos percentuais do renderer.
- Create `test/window-geometry.test.ts`: matriz de DPI, monitores com origens diferentes e grades densas.
- Create `test/window-layout-runtime.test.ts`: contrato do runtime e integração CDP com sessão falsa.
- Create `docs/adr/0010-geometria-de-janelas-consciente-de-dpi.md`: decisão arquitetural.
- Modify `docs/adr/README.md`: registrar o ADR 0010.
- Create `docs/superpowers/reports/2026-07-20-issue-28-manual-qa.md`: evidências reais de 100%, 150%, 125% ou 200%, janelas abertas/reabertas e múltiplos monitores quando disponível.

---

### Task 1: Centralizar a grade lógica em DIP

**Files:**
- Create: `src/shared/window-layout.ts`
- Modify: `src/renderer/components/ScreenLayoutPanel.tsx:1-125`
- Test: `test/window-layout.test.ts`

**Interfaces:**
- Consumes: `ScreenLayoutSettings`, `ScreenLayoutSlot` e `ScreenLayoutMode` de `src/shared/contracts.ts`.
- Produces: `LayoutRect`, `LogicalLayoutSlot`, `LogicalLayoutResult`, `normalizeScreenLayout()`, `getScreenLayoutSlotCount()`, `buildLogicalLayout()` e `toPercentSlot()`.

- [ ] **Step 1: Escrever o teste falhando da fonte única de grade**

Criar `test/window-layout.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLogicalLayout,
  normalizeScreenLayout,
  toPercentSlot
} from "../src/shared/window-layout.js";
import type { ScreenLayoutSettings } from "../src/shared/contracts.js";

const grid = (columns: number, rows: number): ScreenLayoutSettings => ({
  monitorId: "primary",
  mode: "grid",
  columns,
  rows,
  gap: 99,
  margin: 99,
  customSlots: [{ id: "legacy", label: "x", xPercent: 0, yPercent: 0, widthPercent: 10, heightPercent: 10 }]
});

test("normaliza grade para gap e margem fixos", () => {
  assert.deepEqual(normalizeScreenLayout(grid(5.9, 2.4)), {
    monitorId: "primary",
    mode: "grid",
    columns: 5,
    rows: 2,
    gap: 8,
    margin: 8,
    customSlots: []
  });
});

test("grade 5x2 em 1280x672 produz os mesmos slots do runtime", () => {
  const result = buildLogicalLayout({ x: 0, y: 0, width: 1280, height: 672 }, grid(5, 2));
  assert.equal(result.slots.length, 10);
  assert.deepEqual(result.slots[0], { slotIndex: 0, x: 8, y: 8, width: 246, height: 324 });
  assert.deepEqual(result.slots[4], { slotIndex: 4, x: 1024, y: 8, width: 246, height: 324 });
  assert.deepEqual(result.slots[9], { slotIndex: 9, x: 1024, y: 340, width: 246, height: 324 });
});

test("percentuais do renderer derivam do slot lógico e da origem do monitor", () => {
  const workArea = { x: -1280, y: 0, width: 1280, height: 672 };
  const first = buildLogicalLayout(workArea, grid(5, 2)).slots[0];
  assert.ok(first);
  assert.deepEqual(toPercentSlot(first, workArea), {
    id: "1",
    label: "1",
    xPercent: 0.625,
    yPercent: 1.1904761904761905,
    widthPercent: 19.21875,
    heightPercent: 48.214285714285715
  });
});

test("cascata preserva oito slots e escala lógica de 66% por 72%", () => {
  const result = buildLogicalLayout(
    { x: 0, y: 0, width: 1920, height: 1040 },
    { ...grid(4, 1), mode: "cascade" }
  );
  assert.equal(result.mode, "cascade");
  assert.equal(result.slots.length, 8);
  assert.deepEqual(result.slots[0], { slotIndex: 0, x: 0, y: 0, width: 1267, height: 748 });
  assert.deepEqual(result.slots[7], { slotIndex: 7, x: 224, y: 224, width: 1267, height: 748 });
});
```

- [ ] **Step 2: Executar o teste e confirmar a falha**

Run:

```powershell
npx tsx --test test/window-layout.test.ts
```

Expected: FAIL com `Cannot find module '../src/shared/window-layout.js'`.

- [ ] **Step 3: Implementar o módulo lógico compartilhado**

Criar `src/shared/window-layout.ts`:

```ts
import type {
  ScreenLayoutMode,
  ScreenLayoutSettings,
  ScreenLayoutSlot
} from "./contracts.js";

export const FIXED_GRID_GAP = 8;
export const FIXED_GRID_MARGIN = 8;
export const MIN_ADAPTIVE_GRID_WINDOW_WIDTH = 128;
export const MIN_ADAPTIVE_GRID_WINDOW_HEIGHT = 96;

export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LogicalLayoutSlot extends LayoutRect {
  slotIndex: number;
}

export interface LogicalLayoutResult {
  mode: "grid" | "cascade";
  workArea: LayoutRect;
  slots: LogicalLayoutSlot[];
}

const sanitizeAxis = (value: number): number =>
  Math.max(1, Math.trunc(Number.isFinite(value) ? value : 1));

export function normalizeScreenLayout(layout: ScreenLayoutSettings): ScreenLayoutSettings {
  const mode: ScreenLayoutMode = layout.mode === "cascade" ? "cascade" : "grid";
  return {
    ...layout,
    mode,
    columns: sanitizeAxis(layout.columns),
    rows: sanitizeAxis(layout.rows),
    gap: FIXED_GRID_GAP,
    margin: FIXED_GRID_MARGIN,
    customSlots: []
  };
}

export function getScreenLayoutSlotCount(layout: ScreenLayoutSettings): number {
  const normalized = normalizeScreenLayout(layout);
  return normalized.mode === "cascade" ? 8 : normalized.columns * normalized.rows;
}

function buildGridSlots(workArea: LayoutRect, layout: ScreenLayoutSettings): LogicalLayoutSlot[] {
  const columns = layout.columns;
  const rows = layout.rows;
  const width = Math.max(
    MIN_ADAPTIVE_GRID_WINDOW_WIDTH,
    Math.floor((workArea.width - FIXED_GRID_MARGIN * 2 - FIXED_GRID_GAP * (columns - 1)) / columns)
  );
  const height = Math.max(
    MIN_ADAPTIVE_GRID_WINDOW_HEIGHT,
    Math.floor((workArea.height - FIXED_GRID_MARGIN * 2 - FIXED_GRID_GAP * (rows - 1)) / rows)
  );
  return Array.from({ length: columns * rows }, (_, slotIndex) => {
    const column = slotIndex % columns;
    const row = Math.floor(slotIndex / columns);
    return {
      slotIndex,
      x: workArea.x + FIXED_GRID_MARGIN + column * (width + FIXED_GRID_GAP),
      y: workArea.y + FIXED_GRID_MARGIN + row * (height + FIXED_GRID_GAP),
      width,
      height
    };
  });
}

function buildCascadeSlots(workArea: LayoutRect): LogicalLayoutSlot[] {
  const width = Math.max(360, Math.floor(workArea.width * 0.66));
  const height = Math.max(300, Math.floor(workArea.height * 0.72));
  const maxXOffset = Math.max(0, workArea.width - width);
  const maxYOffset = Math.max(0, workArea.height - height);
  return Array.from({ length: 8 }, (_, slotIndex) => {
    const shift = slotIndex * 32;
    return {
      slotIndex,
      x: workArea.x + Math.min(shift, maxXOffset),
      y: workArea.y + Math.min(shift, maxYOffset),
      width,
      height
    };
  });
}

export function buildLogicalLayout(
  workArea: LayoutRect,
  layout: ScreenLayoutSettings
): LogicalLayoutResult {
  const normalized = normalizeScreenLayout(layout);
  return {
    mode: normalized.mode === "cascade" ? "cascade" : "grid",
    workArea: { ...workArea },
    slots: normalized.mode === "cascade"
      ? buildCascadeSlots(workArea)
      : buildGridSlots(workArea, normalized)
  };
}

export function toPercentSlot(slot: LogicalLayoutSlot, workArea: LayoutRect): ScreenLayoutSlot {
  return {
    id: `${slot.slotIndex + 1}`,
    label: String(slot.slotIndex + 1),
    xPercent: ((slot.x - workArea.x) / workArea.width) * 100,
    yPercent: ((slot.y - workArea.y) / workArea.height) * 100,
    widthPercent: (slot.width / workArea.width) * 100,
    heightPercent: (slot.height / workArea.height) * 100
  };
}
```

- [ ] **Step 4: Substituir a matemática duplicada do renderer**

Em `ScreenLayoutPanel.tsx`, remover `FIXED_GRID_*`, `sanitizeAxis`, `buildGridSlots()` e `buildCascadeSlots()`. Manter um sanitizador de input que delega para o módulo compartilhado e usar:

```ts
import { useEffect, useMemo, useState } from "react";
import type {
  AppSettings,
  ScreenDisplayInfo,
  ScreenLayoutMode,
  ScreenLayoutSettings
} from "../../shared/contracts.js";
import {
  buildLogicalLayout,
  normalizeScreenLayout,
  toPercentSlot
} from "../../shared/window-layout.js";

const sanitizeAxisInput = (value: number): number =>
  Math.max(1, Math.trunc(Number.isFinite(value) ? value : 1));

const getDisplayWorkArea = (display?: ScreenDisplayInfo) =>
  display?.workArea ?? { x: 0, y: 0, width: 1920, height: 1080 };
```

Substituir os memos de layout/slots por:

```ts
const effectiveLayout = useMemo(() => normalizeScreenLayout(layout), [layout]);
const previewSlots = useMemo(() => {
  const workArea = getDisplayWorkArea(selectedDisplay);
  return buildLogicalLayout(workArea, effectiveLayout).slots.map((slot) =>
    toPercentSlot(slot, workArea)
  );
}, [effectiveLayout, selectedDisplay]);
```

Nos handlers numéricos, trocar chamadas de `sanitizeAxis` por `sanitizeAxisInput`. Em `displaySize`, usar:

```ts
const displaySize = getDisplayWorkArea(selectedDisplay);
```

Trocar também os dois call sites restantes de `sanitizeLayout()` para que nenhum caminho continue usando a implementação removida:

```ts
const nextLayout = normalizeScreenLayout(layout);

screenLayout: normalizeScreenLayout({
  ...layout,
  ...patch
})
```

- [ ] **Step 5: Executar testes e typecheck**

Run:

```powershell
npx tsx --test test/window-layout.test.ts
npm run check
```

Expected: 4 testes PASS e ambos os `tsc --noEmit` concluídos com exit code 0.

- [ ] **Step 6: Commitar a fonte lógica compartilhada**

```powershell
git add src/shared/window-layout.ts src/renderer/components/ScreenLayoutPanel.tsx test/window-layout.test.ts
git commit -m "refactor(layout): centralizar grade lógica em DIP"
```

---

### Task 2: Implementar a conversão DPI-aware e a escala física

**Files:**
- Create: `src/main/services/window-geometry.ts`
- Test: `test/window-geometry.test.ts`

**Interfaces:**
- Consumes: `LayoutRect`, `LogicalLayoutSlot` de `src/shared/window-layout.ts` e uma função injetada `RectConverter`.
- Produces: `DpiAwarePlacement`, `buildDpiAwarePlacement()`, `normalizeInterfaceScale()`, `toChromiumWindowGeometry()`, `toPreviewDipRect()`, `chromiumBoundsMatch()`.

- [ ] **Step 1: Escrever testes falhando para 100%, 125%, 150%, 200%, múltiplos monitores e escala inválida**

Criar `test/window-geometry.test.ts` com estes casos completos:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildLogicalLayout } from "../src/shared/window-layout.js";
import {
  buildDpiAwarePlacement,
  chromiumBoundsMatch,
  normalizeInterfaceScale,
  toChromiumWindowGeometry,
  toPreviewDipRect
} from "../src/main/services/window-geometry.js";

const layout = {
  monitorId: "primary",
  mode: "grid" as const,
  columns: 5,
  rows: 2,
  gap: 8,
  margin: 8,
  customSlots: []
};

const primaryConverter = (factor: number) => (rect: { x: number; y: number; width: number; height: number }) => ({
  x: Math.round(rect.x * factor),
  y: Math.round(rect.y * factor),
  width: Math.round(rect.width * factor),
  height: Math.round(rect.height * factor)
});

test("100%, 125%, 150% e 200% convertem a mesma tela para 1920x1080 físicos", () => {
  for (const [factor, width, height] of [
    [1, 1920, 1080],
    [1.25, 1536, 864],
    [1.5, 1280, 720],
    [2, 960, 540]
  ] as const) {
    const display = { x: 0, y: 0, width, height };
    const slot = { slotIndex: 0, ...display };
    const placement = buildDpiAwarePlacement(
      slot,
      "cascade",
      display,
      display,
      primaryConverter(factor)
    );
    assert.deepEqual(placement.targetPhysicalRect, { x: 0, y: 0, width: 1920, height: 1080 });
  }
});

test("150% converte a célula 246x324 DIP em 369x486 físicos", () => {
  const workArea = { x: 0, y: 0, width: 1280, height: 672 };
  const slot = buildLogicalLayout(workArea, layout).slots[0];
  assert.ok(slot);
  const placement = buildDpiAwarePlacement(
    slot,
    "grid",
    { x: 0, y: 0, width: 1280, height: 720 },
    workArea,
    primaryConverter(1.5)
  );
  assert.deepEqual(placement.targetPhysicalRect, { x: 12, y: 12, width: 369, height: 486 });
  assert.equal(placement.idealScale, 0.738);
  assert.deepEqual(toChromiumWindowGeometry(placement, placement.idealScale), {
    x: 16,
    y: 16,
    width: 500,
    height: 659
  });
});

test("100% e 150% mantêm escala interna próxima para células fisicamente equivalentes", () => {
  const workArea100 = { x: 0, y: 0, width: 1920, height: 1008 };
  const workArea150 = { x: 0, y: 0, width: 1280, height: 672 };
  const slot100 = buildLogicalLayout(workArea100, layout).slots[0];
  const slot150 = buildLogicalLayout(workArea150, layout).slots[0];
  assert.ok(slot100 && slot150);
  const at100 = buildDpiAwarePlacement(slot100, "grid", { x: 0, y: 0, width: 1920, height: 1080 }, workArea100, primaryConverter(1));
  const at150 = buildDpiAwarePlacement(slot150, "grid", { x: 0, y: 0, width: 1280, height: 720 }, workArea150, primaryConverter(1.5));
  assert.ok(Math.abs(at100.idealScale - at150.idealScale) <= 0.02);
});

test("grade 4x1 em 150% termina na margem física sem acumular lacunas", () => {
  const fourByOne = { ...layout, columns: 4, rows: 1 };
  const workArea = { x: 0, y: 0, width: 1280, height: 672 };
  const slots = buildLogicalLayout(workArea, fourByOne).slots;
  const placements = slots.map((slot) =>
    buildDpiAwarePlacement(
      slot,
      "grid",
      { x: 0, y: 0, width: 1280, height: 720 },
      workArea,
      primaryConverter(1.5)
    )
  );
  assert.equal(placements.length, 4);
  assert.equal(placements[0]?.targetPhysicalRect.x, 12);
  const last = placements[3]?.targetPhysicalRect;
  assert.ok(last);
  assert.equal(last.x + last.width, 1908);
  assert.equal(1920 - (last.x + last.width), 12);
  assert.deepEqual(
    placements.slice(1).map((item, index) => {
      const previous = placements[index]?.targetPhysicalRect;
      return previous ? item.targetPhysicalRect.x - (previous.x + previous.width) : -1;
    }),
    [12, 12, 12]
  );
});

test("monitor à esquerda preserva a origem física e escala apenas o offset local", () => {
  const displayDip = { x: -1280, y: 0, width: 1280, height: 720 };
  const workAreaDip = { x: -1280, y: 0, width: 1280, height: 672 };
  const slot = buildLogicalLayout(workAreaDip, layout).slots[0];
  assert.ok(slot);
  const convert = (rect: typeof displayDip) => ({
    x: -1920 + Math.round((rect.x - displayDip.x) * 1.5),
    y: Math.round(rect.y * 1.5),
    width: Math.round(rect.width * 1.5),
    height: Math.round(rect.height * 1.5)
  });
  const placement = buildDpiAwarePlacement(slot, "grid", displayDip, workAreaDip, convert);
  assert.equal(placement.monitorPhysicalBounds.x, -1920);
  assert.equal(placement.targetPhysicalRect.x, -1908);
  assert.equal(toChromiumWindowGeometry(placement, placement.idealScale).x, -1904);
});

test("monitor acima preserva origem física negativa no eixo vertical", () => {
  const displayDip = { x: 0, y: -720, width: 1280, height: 720 };
  const workAreaDip = { x: 0, y: -720, width: 1280, height: 672 };
  const slot = buildLogicalLayout(workAreaDip, layout).slots[0];
  assert.ok(slot);
  const convert = (rect: typeof displayDip) => ({
    x: Math.round(rect.x * 1.5),
    y: -1080 + Math.round((rect.y - displayDip.y) * 1.5),
    width: Math.round(rect.width * 1.5),
    height: Math.round(rect.height * 1.5)
  });
  const placement = buildDpiAwarePlacement(slot, "grid", displayDip, workAreaDip, convert);
  assert.equal(placement.monitorPhysicalBounds.y, -1080);
  assert.equal(placement.targetPhysicalRect.y, -1068);
  assert.equal(toChromiumWindowGeometry(placement, placement.idealScale).y, -1064);
});

test("cada monitor usa seu próprio conversor e fator de escala", () => {
  const primary = buildDpiAwarePlacement(
    { slotIndex: 0, x: 0, y: 0, width: 1920, height: 1080 },
    "cascade",
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 0, y: 0, width: 1920, height: 1080 },
    primaryConverter(1)
  );
  const secondary = buildDpiAwarePlacement(
    { slotIndex: 0, x: 1920, y: 0, width: 1280, height: 720 },
    "cascade",
    { x: 1920, y: 0, width: 1280, height: 720 },
    { x: 1920, y: 0, width: 1280, height: 720 },
    (rect) => ({
      x: 1920 + Math.round((rect.x - 1920) * 1.5),
      y: Math.round(rect.y * 1.5),
      width: Math.round(rect.width * 1.5),
      height: Math.round(rect.height * 1.5)
    })
  );
  assert.deepEqual(primary.targetPhysicalRect, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(secondary.targetPhysicalRect, { x: 1920, y: 0, width: 1920, height: 1080 });
});

test("grade densa preserva pegada mínima, sobreposição e preview em DIP", () => {
  const slot = { slotIndex: 0, x: 8, y: 8, width: 120, height: 90 };
  const placement = buildDpiAwarePlacement(
    slot,
    "grid",
    { x: 0, y: 0, width: 1280, height: 720 },
    { x: 0, y: 0, width: 1280, height: 672 },
    primaryConverter(1)
  );
  assert.equal(placement.idealScale, 0.5);
  assert.deepEqual(placement.footprintPhysicalRect, { x: 8, y: 8, width: 250, height: 125 });
  assert.equal(placement.overlaps, true);
  assert.deepEqual(toPreviewDipRect(placement, primaryConverter(1)), { x: 8, y: 8, width: 250, height: 125 });
});

test("comparação de bounds tolera dois pixels e rejeita três", () => {
  const expected = { x: 16, y: 16, width: 500, height: 659 };
  assert.equal(chromiumBoundsMatch(expected, { left: 18, top: 14, width: 498, height: 661 }), true);
  assert.equal(chromiumBoundsMatch(expected, { left: 19, top: 16, width: 500, height: 659 }), false);
  assert.equal(chromiumBoundsMatch(expected, { left: 16, top: 16, width: 500 }), false);
});

test("escala inválida cai para 1 e emite diagnóstico", () => {
  let diagnostics = 0;
  assert.equal(normalizeInterfaceScale(Number.NaN, () => { diagnostics += 1; }), 1);
  assert.equal(normalizeInterfaceScale(0, () => { diagnostics += 1; }), 1);
  assert.equal(normalizeInterfaceScale(0.75, () => { diagnostics += 1; }), 0.75);
  assert.equal(diagnostics, 2);
});
```

- [ ] **Step 2: Executar e confirmar a falha**

```powershell
npx tsx --test test/window-geometry.test.ts
```

Expected: FAIL porque `window-geometry.ts` ainda não existe.

- [ ] **Step 3: Implementar o núcleo de geometria física**

Criar `src/main/services/window-geometry.ts`:

```ts
import type {
  LayoutRect,
  LogicalLayoutSlot
} from "../../shared/window-layout.js";

export const MIN_INTERFACE_SCALE = 0.5;
export const MAX_INTERFACE_SCALE = 1;
export const CHROMIUM_MIN_WINDOW_WIDTH = 500;
export const CHROMIUM_MIN_WINDOW_HEIGHT = 250;
export const WINDOW_BOUNDS_TOLERANCE = 2;

export type RectConverter = (rect: LayoutRect) => LayoutRect;

export interface ChromiumWindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChromiumWindowBounds {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

export interface DpiAwarePlacement extends LogicalLayoutSlot {
  mode: "grid" | "cascade";
  monitorPhysicalBounds: LayoutRect;
  workAreaPhysical: LayoutRect;
  targetPhysicalRect: LayoutRect;
  footprintPhysicalRect: LayoutRect;
  idealScale: number;
  overlaps: boolean;
  cutOff: boolean;
}

export function normalizeInterfaceScale(
  scale: number,
  onInvalidScale?: () => void
): number {
  if (Number.isFinite(scale) && scale > 0) return scale;
  onInvalidScale?.();
  return 1;
}

function resolveIdealScale(mode: "grid" | "cascade", target: LayoutRect): number {
  if (mode === "cascade") return 1;
  const fit = Math.min(
    MAX_INTERFACE_SCALE,
    target.width / CHROMIUM_MIN_WINDOW_WIDTH,
    target.height / CHROMIUM_MIN_WINDOW_HEIGHT
  );
  return Math.max(MIN_INTERFACE_SCALE, fit);
}

export function buildDpiAwarePlacement(
  slotDip: LogicalLayoutSlot,
  mode: "grid" | "cascade",
  displayBoundsDip: LayoutRect,
  workAreaDip: LayoutRect,
  dipToPhysicalRect: RectConverter
): DpiAwarePlacement {
  const monitorPhysicalBounds = dipToPhysicalRect(displayBoundsDip);
  const workAreaPhysical = dipToPhysicalRect(workAreaDip);
  const targetPhysicalRect = dipToPhysicalRect(slotDip);
  const idealScale = resolveIdealScale(mode, targetPhysicalRect);
  const footprintPhysicalRect = {
    x: targetPhysicalRect.x,
    y: targetPhysicalRect.y,
    width: Math.max(targetPhysicalRect.width, Math.round(CHROMIUM_MIN_WINDOW_WIDTH * idealScale)),
    height: Math.max(targetPhysicalRect.height, Math.round(CHROMIUM_MIN_WINDOW_HEIGHT * idealScale))
  };
  const overlaps =
    footprintPhysicalRect.width > targetPhysicalRect.width + 1 ||
    footprintPhysicalRect.height > targetPhysicalRect.height + 1;
  const cutOff =
    footprintPhysicalRect.x + footprintPhysicalRect.width > workAreaPhysical.x + workAreaPhysical.width + 1 ||
    footprintPhysicalRect.y + footprintPhysicalRect.height > workAreaPhysical.y + workAreaPhysical.height + 1;
  return {
    ...slotDip,
    mode,
    monitorPhysicalBounds,
    workAreaPhysical,
    targetPhysicalRect,
    footprintPhysicalRect,
    idealScale,
    overlaps,
    cutOff
  };
}

export function toChromiumWindowGeometry(
  placement: DpiAwarePlacement,
  effectiveScale: number,
  onInvalidScale?: () => void
): ChromiumWindowGeometry {
  const scale = normalizeInterfaceScale(effectiveScale, onInvalidScale);
  const origin = placement.monitorPhysicalBounds;
  const target = placement.targetPhysicalRect;
  return {
    x: Math.round(origin.x + (target.x - origin.x) / scale),
    y: Math.round(origin.y + (target.y - origin.y) / scale),
    width: Math.round(target.width / scale),
    height: Math.round(target.height / scale)
  };
}

export function toPreviewDipRect(
  placement: DpiAwarePlacement,
  physicalToDipRect: RectConverter
): LayoutRect {
  return physicalToDipRect(placement.footprintPhysicalRect);
}

export function chromiumBoundsMatch(
  expected: ChromiumWindowGeometry,
  actual: ChromiumWindowBounds,
  tolerance = WINDOW_BOUNDS_TOLERANCE
): boolean {
  if (
    typeof actual.left !== "number" ||
    typeof actual.top !== "number" ||
    typeof actual.width !== "number" ||
    typeof actual.height !== "number"
  ) return false;
  return (
    Math.abs(expected.x - actual.left) <= tolerance &&
    Math.abs(expected.y - actual.top) <= tolerance &&
    Math.abs(expected.width - actual.width) <= tolerance &&
    Math.abs(expected.height - actual.height) <= tolerance
  );
}
```

- [ ] **Step 4: Executar testes e ajustar apenas diferenças reais de arredondamento**

```powershell
npx tsx --test test/window-layout.test.ts test/window-geometry.test.ts
npm run check
```

Expected: todos os testes focados PASS, zero falhas e typecheck com exit code 0. Se um valor arredondado divergir, confirmar manualmente a fórmula antes de corrigir a expectativa; não ampliar a tolerância acima de 2.

- [ ] **Step 5: Commitar o núcleo DPI-aware**

```powershell
git add src/main/services/window-geometry.ts test/window-geometry.test.ts
git commit -m "feat(layout): converter slots DIP para geometria física"
```

---

### Task 3: Usar a geometria única no preview e em novos lançamentos

**Files:**
- Modify: `src/main/services/browser-runtime.ts:19-97,255-375,1181-1265,7780-7975,8516-8660`
- Modify: `test/window-geometry.test.ts`
- Create: `test/window-layout-runtime.test.ts`

**Interfaces:**
- Consumes: `buildLogicalLayout()`, `getScreenLayoutSlotCount()`, `normalizeScreenLayout()`, `buildDpiAwarePlacement()`, `toChromiumWindowGeometry()`.
- Produces: `BrowserRuntimeService.buildBrowserPlacement()` retornando `DpiAwarePlacement`; `RuntimeHandle.launchedScale`; preview em DIP derivado da pegada física.

- [ ] **Step 1: Adicionar regressão falhando para preview e separação das escalas**

Acrescentar a `test/window-geometry.test.ts`:

```ts
test("preview 5x2 em 150% volta da pegada física para o mesmo slot DIP", () => {
  const workArea = { x: 0, y: 0, width: 1280, height: 672 };
  const slot = buildLogicalLayout(workArea, layout).slots[0];
  assert.ok(slot);
  const placement = buildDpiAwarePlacement(
    slot,
    "grid",
    { x: 0, y: 0, width: 1280, height: 720 },
    workArea,
    primaryConverter(1.5)
  );
  const physicalToDip = primaryConverter(1 / 1.5);
  assert.deepEqual(toPreviewDipRect(placement, physicalToDip), { x: 8, y: 8, width: 246, height: 324 });
  assert.equal(placement.overlaps, false);
  assert.equal(placement.cutOff, false);
});
```

Criar `test/window-layout-runtime.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("runtime separa escala ideal da escala lançada e não pede relaunch", async () => {
  const source = await readFile(new URL("../src/main/services/browser-runtime.ts", import.meta.url), "utf8");
  assert.match(source, /launchedScale: number;/);
  assert.match(source, /placement\.idealScale/);
  assert.match(source, /handle\.launchedScale/);
  assert.doesNotMatch(source, /Reabra este navegador para ajustar a escala da interface/);
  assert.doesNotMatch(source, /handle\.placement = \{ \.\.\.placement, scale: previousScale \}/);
});

test("preview e launch resolvem métricas atuais do monitor em cada ação", async () => {
  const source = await readFile(new URL("../src/main/services/browser-runtime.ts", import.meta.url), "utf8");
  assert.match(source, /getLayoutPreviewRects\(settings: AppSettings\)[\s\S]*?this\.resolveLayoutDisplay\(settings\.screenLayout\)/);
  assert.match(source, /private buildBrowserPlacement\(settings: AppSettings[\s\S]*?this\.resolveLayoutDisplay\(settings\.screenLayout\)/);
});
```

- [ ] **Step 2: Confirmar que o contrato do runtime falha antes da refatoração**

```powershell
npx tsx --test test/window-geometry.test.ts test/window-layout-runtime.test.ts
```

Expected: teste do contrato FAIL porque ainda existem `placement.scale`, `previousScale` e a mensagem de relaunch.

- [ ] **Step 3: Refatorar imports, placement e handle**

Em `browser-runtime.ts`, remover as constantes de grade/escala locais e importar:

```ts
import {
  buildLogicalLayout,
  getScreenLayoutSlotCount,
  normalizeScreenLayout,
  type LayoutRect
} from "../../shared/window-layout.js";
import {
  buildDpiAwarePlacement,
  toChromiumWindowGeometry,
  toPreviewDipRect,
  type DpiAwarePlacement
} from "./window-geometry.js";
```

Remover `BrowserPlacement`. Em `RuntimeHandle`, substituir:

```ts
placement: DpiAwarePlacement;
launchedScale: number;
```

Substituir `buildBrowserPlacement()` por:

```ts
private buildBrowserPlacement(settings: AppSettings, forcedSlotIndex?: number): DpiAwarePlacement {
  const display = this.resolveLayoutDisplay(settings.screenLayout);
  const logical = buildLogicalLayout(display.workArea, settings.screenLayout);
  const slotCount = logical.slots.length;
  const slotIndex = forcedSlotIndex ?? this.allocateSlotIndex(slotCount);
  const template = logical.slots[slotIndex % slotCount];
  if (!template) throw new Error("Layout sem slots disponíveis.");
  const slot = { ...template, slotIndex };
  return buildDpiAwarePlacement(
    slot,
    logical.mode,
    display.bounds,
    display.workArea,
    (rect) => screen.dipToScreenRect(null, rect)
  );
}
```

Trocar `LayoutPreviewResult.workArea` de `Rectangle` para `LayoutRect`. Delegar `getLayoutSlotCount()` e `normalizeScreenLayout()` para as funções compartilhadas ou remover os métodos e trocar seus call sites diretamente. Depois de remover os helpers antigos, remover também o import `Rectangle` do Electron, que não terá mais uso.

Em `applyLayout()`, preservar a regra atual de alocação, mas calcular a quantidade com a função compartilhada:

```ts
const effectiveLayout = normalizeScreenLayout(settings.screenLayout);
const allocationSlotCount = Math.max(
  getScreenLayoutSlotCount(effectiveLayout),
  handles.length
);
```

- [ ] **Step 4: Migrar launch, fingerprint e badges para nomes explícitos**

No launch:

```ts
const launchedScale = placement.idealScale;
const windowGeometry = toChromiumWindowGeometry(
  placement,
  launchedScale,
  () => appendInputDiagnostic({
    kind: "invalid-window-interface-scale",
    profileId,
    slotIndex: placement.slotIndex,
    effectiveScale: launchedScale
  })
);
```

Trocar os testes/args de `placement.scale` por `launchedScale`. Manter:

```ts
fingerprintConfig.devicePixelRatio = reportedDpr;
fingerprintConfig.screenDimensionScale = launchedScale / reportedDpr;
```

Salvar o handle assim:

```ts
slotIndex: placement.slotIndex,
placement,
launchedScale,
```

Alterar `buildBadgesScript()`, `updateContextBadges()` e `applyBadgeToPage()` para receber `effectiveScale: number`; calcular a compensação com esse argumento:

```ts
const compensation = Math.min(2, Math.max(1, 1 / (effectiveScale > 0 ? effectiveScale : 1)));
```

Durante launch, passar `launchedScale`; para handles existentes, passar `handle.launchedScale` em todos os call sites.

- [ ] **Step 5: Migrar o preview para a pegada física convertida de volta a DIP**

Substituir o corpo de `getLayoutPreviewRects()` por:

```ts
getLayoutPreviewRects(settings: AppSettings): LayoutPreviewResult {
  const display = this.resolveLayoutDisplay(settings.screenLayout);
  const logical = buildLogicalLayout(display.workArea, settings.screenLayout);
  const slots = logical.slots.map((slot) => {
    const placement = buildDpiAwarePlacement(
      slot,
      logical.mode,
      display.bounds,
      display.workArea,
      (rect) => screen.dipToScreenRect(null, rect)
    );
    const preview = toPreviewDipRect(
      placement,
      (rect) => screen.screenToDipRect(null, rect)
    );
    return {
      label: String(slot.slotIndex + 1),
      ...preview,
      scale: placement.idealScale,
      overlaps: placement.overlaps,
      cutOff: placement.cutOff
    };
  });
  return { mode: logical.mode, workArea: display.workArea, slots };
}
```

- [ ] **Step 6: Executar testes focados, typecheck e suíte completa**

```powershell
npx tsx --test test/window-layout.test.ts test/window-geometry.test.ts test/window-layout-runtime.test.ts
npm run check
npm test
```

Expected: testes focados PASS, typecheck exit 0 e suíte completa com pelo menos os 384 testes da baseline passando.

- [ ] **Step 7: Commitar preview e launch DPI-aware**

```powershell
git add src/main/services/browser-runtime.ts test/window-geometry.test.ts test/window-layout-runtime.test.ts
git commit -m "fix(layout): alinhar preview e launch ao DPI físico"
```

---

### Task 4: Aplicar janelas abertas sem relaunch e verificar bounds reais

**Files:**
- Modify: `src/main/services/browser-runtime.ts:1542-1595,7712-7763`
- Modify: `test/window-layout-runtime.test.ts`

**Interfaces:**
- Consumes: `RuntimeHandle.launchedScale`, `DpiAwarePlacement`, `toChromiumWindowGeometry()`, `chromiumBoundsMatch()`.
- Produces: `applyPlacementToPage(page, placement, effectiveScale)` que retorna `true` somente após `Browser.getWindowBounds` compatível.

- [ ] **Step 1: Escrever integração CDP falhando com bounds compatíveis e divergentes**

Acrescentar a `test/window-layout-runtime.test.ts`:

```ts
import type { Page } from "patchright";
import { BrowserRuntimeService } from "../src/main/services/browser-runtime.js";
import type { DpiAwarePlacement } from "../src/main/services/window-geometry.js";

const placement: DpiAwarePlacement = {
  slotIndex: 0,
  x: 8,
  y: 8,
  width: 246,
  height: 324,
  mode: "grid",
  monitorPhysicalBounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workAreaPhysical: { x: 0, y: 0, width: 1920, height: 1008 },
  targetPhysicalRect: { x: 12, y: 12, width: 369, height: 486 },
  footprintPhysicalRect: { x: 12, y: 12, width: 369, height: 486 },
  idealScale: 0.738,
  overlaps: false,
  cutOff: false
};

function fakePage(returnedBounds: Record<string, number>) {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const session = {
    send: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "Browser.getWindowForTarget") return { windowId: 7 };
      if (method === "Browser.getWindowBounds") return { bounds: returnedBounds };
      return {};
    },
    detach: async () => undefined
  };
  const page = {
    isClosed: () => false,
    context: () => ({ newCDPSession: async () => session })
  } as unknown as Page;
  return { page, calls };
}

test("apply confirma bounds reais compatíveis usando a escala lançada", async () => {
  const runtime = new BrowserRuntimeService(() => undefined);
  const harness = runtime as unknown as {
    applyPlacementToPage(page: Page, placement: DpiAwarePlacement, effectiveScale: number): Promise<boolean>;
  };
  const { page, calls } = fakePage({ left: 16, top: 16, width: 492, height: 648 });
  assert.equal(await harness.applyPlacementToPage(page, placement, 0.75), true);
  assert.ok(calls.some((call) => call.method === "Browser.getWindowBounds"));
  assert.deepEqual(calls.findLast((call) => call.method === "Browser.setWindowBounds")?.params, {
    windowId: 7,
    bounds: { left: 16, top: 16, width: 492, height: 648 }
  });
});

test("apply rejeita falso sucesso quando Chromium devolve bounds divergentes", async () => {
  const runtime = new BrowserRuntimeService(() => undefined);
  const harness = runtime as unknown as {
    applyPlacementToPage(page: Page, placement: DpiAwarePlacement, effectiveScale: number): Promise<boolean>;
  };
  const { page } = fakePage({ left: 16, top: 16, width: 400, height: 648 });
  assert.equal(await harness.applyPlacementToPage(page, placement, 0.75), false);
});

test("apply rejeita falso sucesso quando Chromium não devolve bounds", async () => {
  const runtime = new BrowserRuntimeService(() => undefined);
  const harness = runtime as unknown as {
    applyPlacementToPage(page: Page, placement: DpiAwarePlacement, effectiveScale: number): Promise<boolean>;
  };
  const { page } = fakePage({});
  assert.equal(await harness.applyPlacementToPage(page, placement, 0.75), false);
});
```

- [ ] **Step 2: Executar e confirmar que o teste de falso sucesso falha**

```powershell
npx tsx --test test/window-layout-runtime.test.ts
```

Expected: o caso divergente FAIL porque o método atual retorna `true` sem consultar `Browser.getWindowBounds`.

- [ ] **Step 3: Adicionar readback no método real**

Importar `chromiumBoundsMatch` e substituir a parte de aplicação por:

```ts
const geometry = toChromiumWindowGeometry(
  placement,
  effectiveScale,
  () => appendInputDiagnostic({
    kind: "invalid-window-interface-scale",
    slotIndex: placement.slotIndex,
    effectiveScale
  })
);
await session.send("Browser.setWindowBounds", {
  windowId,
  bounds: {
    left: geometry.x,
    top: geometry.y,
    width: geometry.width,
    height: geometry.height
  }
});
const readback = (await session.send("Browser.getWindowBounds", { windowId })) as {
  bounds?: { left?: number; top?: number; width?: number; height?: number };
};
await session.send("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
return chromiumBoundsMatch(geometry, readback.bounds ?? {});
```

Manter `catch => false` e `finally => detach`. Não transformar ausência de readback em sucesso.

- [ ] **Step 4: Aplicar usando `handle.launchedScale` e remover o aviso**

Em `applyLayout()`:

```ts
const placement = this.buildBrowserPlacement(this.resolvePlacementSettings(settings), slot);
const boundsApplied = await this.applyPlacementToPage(page, placement, handle.launchedScale);
```

Quando `boundsApplied` for `true`, atualizar:

```ts
handle.primaryPage = page;
handle.slotIndex = placement.slotIndex;
handle.placement = placement;
```

Notificar somente:

```ts
this.notify(
  profileId,
  "active",
  boundsApplied
    ? "Layout de tela aplicado ao navegador."
    : "Layout salvo, mas a janela aberta nao respondeu ao reposicionamento."
);
```

Passar `handle.launchedScale` ao atualizar badges. Não comparar escala ideal com escala lançada e não reiniciar o perfil.

- [ ] **Step 5: Executar regressões e verificar ausência da mensagem proibida**

```powershell
npx tsx --test test/window-layout-runtime.test.ts test/window-geometry.test.ts
rg -n "Reabra este navegador para ajustar a escala" src test
npm run check
npm test
```

Expected: testes PASS; `rg` sem resultados; typecheck exit 0; suíte completa sem regressões.

- [ ] **Step 6: Commitar aplicação e readback**

```powershell
git add src/main/services/browser-runtime.ts test/window-layout-runtime.test.ts
git commit -m "fix(layout): aplicar bounds físicos em janelas abertas"
```

---

### Task 5: Registrar a decisão e executar validação completa

**Files:**
- Create: `docs/adr/0010-geometria-de-janelas-consciente-de-dpi.md`
- Modify: `docs/adr/README.md`
- Create: `docs/superpowers/reports/2026-07-20-issue-28-manual-qa.md`

**Interfaces:**
- Consumes: implementação e resultados das Tasks 1–4.
- Produces: ADR permanente, relatório manual reproduzível e evidência final da issue #28.

- [ ] **Step 1: Criar o ADR 0010 com a decisão final**

Criar `docs/adr/0010-geometria-de-janelas-consciente-de-dpi.md`:

```md
# ADR 0010: Geometria de janelas consciente de DPI

## Status

Aceito.

## Contexto

O Electron informa `Display.workArea` em DIP. Com Windows em 150%, uma tela física
1920x1080 aparece como aproximadamente 1280x720 DIP. O preview usava esses valores
corretamente em `BrowserWindow`, mas o Chromium recebia uma compensação apenas por
`force-device-scale-factor` e ocupava cerca de dois terços da tela física.

## Causa raiz

- slots lógicos em DIP eram tratados como pixels físicos na fronteira do Chromium;
- `Display.scaleFactor` era usado no fingerprint, mas não na geometria;
- a escala ideal e a escala efetivamente lançada compartilhavam o mesmo campo;
- preview, renderer e runtime mantinham fórmulas paralelas;
- `Browser.setWindowBounds` era aceito sem leitura posterior dos bounds.

## Decisão

A grade lógica permanece em DIP e vive em um módulo compartilhado. O processo
principal usa `screen.dipToScreenRect` para obter o retângulo físico do slot e a
origem física do monitor. A geometria enviada ao Chromium compensa a escala interna
somente depois dessa conversão e preserva a origem do monitor.

A escala adaptativa usa o tamanho físico da célula. Cada handle guarda separadamente
o placement ideal e `launchedScale`. Janelas abertas usam sua escala lançada para
chegar ao novo retângulo físico, sem reinício nem aviso. Após aplicar, o runtime lê
`Browser.getWindowBounds` e aceita diferença máxima de dois pixels.

## Consequências

- 100%, 125%, 150% e 200% ocupam a mesma proporção física da área útil;
- preview, launch e apply compartilham a mesma grade lógica;
- grades densas preservam alertas de sobreposição e corte;
- monitores secundários preservam origens positivas ou negativas;
- mudar DPI exige uma nova ação de preview, launch ou apply, mas não reiniciar o app;
- falhas ou divergências de bounds não são reportadas como sucesso.

## Verificação

```powershell
npx tsx --test test/window-layout.test.ts test/window-geometry.test.ts test/window-layout-runtime.test.ts
npm run check
npm test
git diff --check
```

A QA manual compara preview, bounds CDP e ocupação física em 100% e 150%, incluindo
janelas abertas antes da mudança de DPI e perfis reabertos depois dela.
```

Adicionar ao índice em `docs/adr/README.md`:

```md
| [0010](0010-geometria-de-janelas-consciente-de-dpi.md) | Geometria de janelas consciente de DPI | Aceito |
```

- [ ] **Step 2: Executar a verificação automatizada final**

```powershell
npx tsx --test test/window-layout.test.ts test/window-geometry.test.ts test/window-layout-runtime.test.ts
npm run check
npm test
git diff --check
```

Expected: todos os testes focados PASS; `npm run check` exit 0; suíte completa com zero falhas; `git diff --check` sem saída.

- [ ] **Step 3: Fazer QA manual em 100%**

1. Ajustar o Windows para 100%.
2. Iniciar o desktop com `npm run dev`.
3. Configurar grade 4×1 e abrir quatro perfis.
4. Acionar “Pré-visualização” e capturar a tela.
5. Acionar “Aplicar Agora” e confirmar que margem/gap e bordas reais coincidem com o preview.
6. Registrar no relatório: resolução física, `workArea`, `scaleFactor`, grade, escala ideal, geometria enviada e bounds retornados.

Expected: preview e janelas reais diferem no máximo dois pixels por eixo/dimensão e usam toda a área útil prevista.

- [ ] **Step 4: Fazer QA manual em 150% sem reiniciar perfis**

1. Com os perfis abertos, alterar o Windows para 150%.
2. Configurar grade 5×2 e abrir perfis suficientes para dez slots.
3. Acionar “Pré-visualização” e depois “Aplicar Agora”.
4. Confirmar que as janelas alcançam a largura física útil de 1920 em vez de terminar perto de 1280.
5. Confirmar que nenhum perfil reiniciou e que não apareceu aviso para reabrir o navegador.
6. Fechar e reabrir os perfis e confirmar que a ocupação externa permanece equivalente.

Expected: dez janelas usam toda a área útil, respeitam gap/margem e continuam operacionais.

- [ ] **Step 5: Repetir a QA em 125% ou 200%**

Escolher uma escala adicional disponível no hardware, repetir preview e aplicação com grade 4×1 e registrar os mesmos campos de geometria. Não basta alterar a configuração: comparar os bounds pedidos e retornados e confirmar margem/gap físicos.

Expected: a ocupação externa continua equivalente a 100% e 150%, com diferença máxima de dois pixels.

- [ ] **Step 6: Validar monitor secundário quando disponível**

Selecionar um monitor secundário, repetir preview/apply e registrar se ele está à direita, esquerda ou acima, sua escala e seus bounds. Se não houver segundo monitor físico, executar os testes automatizados de origem negativa e registrar “não disponível no hardware de QA” no relatório; não inventar evidência manual.

- [ ] **Step 7: Escrever o relatório com evidência real**

Criar `docs/superpowers/reports/2026-07-20-issue-28-manual-qa.md` contendo:

- ambiente e commit testado;
- tabela 100% 4×1;
- tabela 150% 5×2 antes/depois de aplicar;
- tabela 125% ou 200% 4×1;
- resultado de janelas abertas e reabertas;
- resultado do monitor secundário ou indisponibilidade declarada;
- comandos automatizados e contagens reais;
- caminhos das capturas produzidas;
- conclusão explícita para cada critério de aceite.

- [ ] **Step 8: Commitar ADR e relatório**

```powershell
git add docs/adr/0010-geometria-de-janelas-consciente-de-dpi.md docs/adr/README.md docs/superpowers/reports/2026-07-20-issue-28-manual-qa.md
git commit -m "docs(layout): registrar decisão e QA de DPI"
```

- [ ] **Step 9: Auditoria final da branch**

```powershell
git status --short --branch
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: worktree limpo; commits pequenos da spec, plano e Tasks 1–5; diff limitado ao organizador, testes e documentação; nenhum erro de whitespace.

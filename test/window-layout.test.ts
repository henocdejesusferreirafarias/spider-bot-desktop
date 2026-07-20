import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMultiDisplayLogicalLayout,
  buildLogicalLayout,
  normalizeMonitorLayout,
  reconcileScreenLayout,
  resolveMultiDisplaySlot,
  toPercentSlot
} from "../src/shared/window-layout.js";
import type {
  ScreenDisplayInfo,
  ScreenLayoutSettings,
  ScreenMonitorLayout
} from "../src/shared/contracts.js";

const grid = (
  columns: number,
  rows: number,
  displayId = "primary",
  enabled = true
): ScreenMonitorLayout => ({
  displayId,
  enabled,
  mode: "grid",
  columns,
  rows
});

const display = (
  id: string,
  primary: boolean,
  workArea: ScreenDisplayInfo["workArea"],
  scaleFactor = 1
): ScreenDisplayInfo => ({
  id,
  label: `M${id}`,
  primary,
  scaleFactor,
  bounds: { ...workArea },
  workArea
});

const displays = [
  display("1", true, { x: 0, y: 0, width: 1280, height: 672 }),
  display("2", false, { x: 1280, y: 0, width: 1707, height: 920 }, 1.5)
];

test("normaliza eixos e preserva a configuração do monitor", () => {
  assert.deepEqual(normalizeMonitorLayout(grid(5.9, 2.4, " 7 ")), {
    displayId: "7",
    enabled: true,
    mode: "grid",
    columns: 5,
    rows: 2
  });
});

test("grade 5x2 em 1280x672 produz os mesmos slots do runtime", () => {
  const result = buildLogicalLayout(
    { x: 0, y: 0, width: 1280, height: 672 },
    grid(5, 2)
  );
  assert.equal(result.slots.length, 10);
  assert.deepEqual(result.slots[0], {
    slotIndex: 0,
    x: 8,
    y: 8,
    width: 246,
    height: 324
  });
  assert.deepEqual(result.slots[4], {
    slotIndex: 4,
    x: 1024,
    y: 8,
    width: 246,
    height: 324
  });
  assert.deepEqual(result.slots[9], {
    slotIndex: 9,
    x: 1024,
    y: 340,
    width: 246,
    height: 324
  });
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
  assert.deepEqual(result.slots[0], {
    slotIndex: 0,
    x: 0,
    y: 0,
    width: 1267,
    height: 748
  });
  assert.deepEqual(result.slots[7], {
    slotIndex: 7,
    x: 224,
    y: 224,
    width: 1267,
    height: 748
  });
});

test("concatena duas grades 5x2 na ordem configurada", () => {
  const result = buildMultiDisplayLogicalLayout(
    {
      version: 2,
      monitors: [grid(5, 2, "1"), grid(5, 2, "2")]
    },
    displays
  );

  assert.equal(result.capacity, 20);
  assert.deepEqual(
    result.slots.map((slot) => [
      slot.displayId,
      slot.localSlotIndex,
      slot.globalSlotIndex
    ]),
    [
      ...Array.from({ length: 10 }, (_, index) => ["1", index, index]),
      ...Array.from({ length: 10 }, (_, index) => ["2", index, index + 10])
    ]
  );
});

test("reordenar monitores altera a sequência global", () => {
  const result = buildMultiDisplayLogicalLayout(
    {
      version: 2,
      monitors: [grid(1, 1, "2"), grid(1, 1, "1")]
    },
    displays
  );

  assert.deepEqual(result.slots.map((slot) => slot.displayId), ["2", "1"]);
});

test("ignora monitor desabilitado ou ausente sem remover sua configuração", () => {
  const settings: ScreenLayoutSettings = {
    version: 2,
    monitors: [
      grid(2, 1, "1", false),
      grid(7, 3, "hidden"),
      grid(3, 1, "2")
    ]
  };
  const reconciled = reconcileScreenLayout(settings, displays);
  const result = buildMultiDisplayLogicalLayout(reconciled, displays);

  assert.deepEqual(reconciled.monitors.map((monitor) => monitor.displayId), [
    "1",
    "hidden",
    "2"
  ]);
  assert.equal(reconciled.monitors[1]?.columns, 7);
  assert.equal(result.capacity, 3);
  assert.deepEqual(result.slots.map((slot) => slot.displayId), ["2", "2", "2"]);
});

test("substitui sentinel primary pelo id concreto e adiciona displays novos desabilitados", () => {
  const reconciled = reconcileScreenLayout(
    {
      version: 2,
      monitors: [grid(5, 2)]
    },
    displays
  );

  assert.deepEqual(reconciled, {
    version: 2,
    monitors: [grid(5, 2, "1"), grid(4, 1, "2", false)]
  });
});

test("habilita o principal quando nenhum monitor conectado está ativo", () => {
  const reconciled = reconcileScreenLayout(
    {
      version: 2,
      monitors: [grid(2, 1, "1", false), grid(7, 3, "hidden")]
    },
    displays
  );

  assert.equal(reconciled.monitors.find((monitor) => monitor.displayId === "1")?.enabled, true);
  assert.equal(reconciled.monitors.find((monitor) => monitor.displayId === "hidden")?.enabled, true);
  assert.equal(buildMultiDisplayLogicalLayout(reconciled, displays).capacity, 2);
});

test("índices acima da capacidade reiniciam no primeiro slot sem perder o solicitado", () => {
  const result = buildMultiDisplayLogicalLayout(
    {
      version: 2,
      monitors: [grid(1, 1, "1"), grid(1, 1, "2")]
    },
    displays
  );
  const resolved = resolveMultiDisplaySlot(result, 2);

  assert.equal(resolved.displayId, "1");
  assert.equal(resolved.globalSlotIndex, 0);
  assert.equal(resolved.requestedSlotIndex, 2);
  assert.equal(resolved.slotIndex, 2);
});

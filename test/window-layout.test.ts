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
  customSlots: [
    {
      id: "legacy",
      label: "x",
      xPercent: 0,
      yPercent: 0,
      widthPercent: 10,
      heightPercent: 10
    }
  ]
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

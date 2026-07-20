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
  displayId: "primary",
  enabled: true,
  mode: "grid" as const,
  columns: 5,
  rows: 2
};

const primaryConverter = (factor: number) =>
  (rect: { x: number; y: number; width: number; height: number }) => ({
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
    assert.deepEqual(placement.targetPhysicalRect, {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080
    });
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
  assert.deepEqual(placement.targetPhysicalRect, {
    x: 12,
    y: 12,
    width: 369,
    height: 486
  });
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
  const at100 = buildDpiAwarePlacement(
    slot100,
    "grid",
    { x: 0, y: 0, width: 1920, height: 1080 },
    workArea100,
    primaryConverter(1)
  );
  const at150 = buildDpiAwarePlacement(
    slot150,
    "grid",
    { x: 0, y: 0, width: 1280, height: 720 },
    workArea150,
    primaryConverter(1.5)
  );
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
      return previous
        ? item.targetPhysicalRect.x - (previous.x + previous.width)
        : -1;
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
  const placement = buildDpiAwarePlacement(
    slot,
    "grid",
    displayDip,
    workAreaDip,
    convert
  );
  assert.equal(placement.monitorPhysicalBounds.x, -1920);
  assert.equal(placement.targetPhysicalRect.x, -1908);
  assert.equal(
    toChromiumWindowGeometry(placement, placement.idealScale).x,
    -1904
  );
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
  const placement = buildDpiAwarePlacement(
    slot,
    "grid",
    displayDip,
    workAreaDip,
    convert
  );
  assert.equal(placement.monitorPhysicalBounds.y, -1080);
  assert.equal(placement.targetPhysicalRect.y, -1068);
  assert.equal(
    toChromiumWindowGeometry(placement, placement.idealScale).y,
    -1064
  );
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
  assert.deepEqual(primary.targetPhysicalRect, {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080
  });
  assert.deepEqual(secondary.targetPhysicalRect, {
    x: 1920,
    y: 0,
    width: 1920,
    height: 1080
  });
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
  assert.deepEqual(placement.footprintPhysicalRect, {
    x: 8,
    y: 8,
    width: 250,
    height: 125
  });
  assert.equal(placement.overlaps, true);
  assert.deepEqual(toPreviewDipRect(placement, primaryConverter(1)), {
    x: 8,
    y: 8,
    width: 250,
    height: 125
  });
});

test("comparação de bounds tolera dois pixels e rejeita três", () => {
  const expected = { x: 16, y: 16, width: 500, height: 659 };
  assert.equal(
    chromiumBoundsMatch(expected, {
      left: 18,
      top: 14,
      width: 498,
      height: 661
    }),
    true
  );
  assert.equal(
    chromiumBoundsMatch(expected, {
      left: 19,
      top: 16,
      width: 500,
      height: 659
    }),
    false
  );
  assert.equal(
    chromiumBoundsMatch(expected, { left: 16, top: 16, width: 500 }),
    false
  );
});

test("escala inválida cai para 1 e emite diagnóstico", () => {
  let diagnostics = 0;
  assert.equal(
    normalizeInterfaceScale(Number.NaN, () => {
      diagnostics += 1;
    }),
    1
  );
  assert.equal(
    normalizeInterfaceScale(0, () => {
      diagnostics += 1;
    }),
    1
  );
  assert.equal(
    normalizeInterfaceScale(0.75, () => {
      diagnostics += 1;
    }),
    0.75
  );
  assert.equal(diagnostics, 2);
});

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
  assert.deepEqual(toPreviewDipRect(placement, physicalToDip), {
    x: 8,
    y: 8,
    width: 246,
    height: 324
  });
  assert.equal(placement.overlaps, false);
  assert.equal(placement.cutOff, false);
});

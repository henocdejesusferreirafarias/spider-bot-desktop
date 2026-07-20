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

function buildGridSlots(
  workArea: LayoutRect,
  layout: ScreenLayoutSettings
): LogicalLayoutSlot[] {
  const columns = layout.columns;
  const rows = layout.rows;
  const width = Math.max(
    MIN_ADAPTIVE_GRID_WINDOW_WIDTH,
    Math.floor(
      (workArea.width -
        FIXED_GRID_MARGIN * 2 -
        FIXED_GRID_GAP * (columns - 1)) /
        columns
    )
  );
  const height = Math.max(
    MIN_ADAPTIVE_GRID_WINDOW_HEIGHT,
    Math.floor(
      (workArea.height -
        FIXED_GRID_MARGIN * 2 -
        FIXED_GRID_GAP * (rows - 1)) /
        rows
    )
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
    slots:
      normalized.mode === "cascade"
        ? buildCascadeSlots(workArea)
        : buildGridSlots(workArea, normalized)
  };
}

export function toPercentSlot(
  slot: LogicalLayoutSlot,
  workArea: LayoutRect
): ScreenLayoutSlot {
  return {
    id: `${slot.slotIndex + 1}`,
    label: String(slot.slotIndex + 1),
    xPercent: ((slot.x - workArea.x) / workArea.width) * 100,
    yPercent: ((slot.y - workArea.y) / workArea.height) * 100,
    widthPercent: (slot.width / workArea.width) * 100,
    heightPercent: (slot.height / workArea.height) * 100
  };
}

import type {
  ScreenDisplayInfo,
  ScreenMonitorLayout,
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toFiniteNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const defaultPrimaryMonitors = (): ScreenMonitorLayout[] => [
  {
    displayId: "primary",
    enabled: true,
    mode: "grid",
    columns: 4,
    rows: 1
  }
];

export function normalizeMonitorLayout(layout: ScreenMonitorLayout): ScreenMonitorLayout {
  return {
    displayId: layout.displayId.trim(),
    enabled: layout.enabled === true,
    mode: layout.mode === "cascade" ? "cascade" : "grid",
    columns: sanitizeAxis(layout.columns),
    rows: sanitizeAxis(layout.rows)
  };
}

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

export const normalizeScreenLayout = normalizeMonitorLayout;

export function migrateScreenLayoutSettings(value: unknown): ScreenLayoutSettings {
  const candidate = isRecord(value) ? value : {};
  if (candidate.version === 2 && Array.isArray(candidate.monitors)) {
    const seen = new Set<string>();
    const monitors: ScreenMonitorLayout[] = [];

    for (const item of candidate.monitors) {
      if (!isRecord(item) || typeof item.displayId !== "string") {
        continue;
      }
      const normalized = normalizeMonitorLayout({
        displayId: item.displayId,
        enabled: item.enabled !== false,
        mode: item.mode === "cascade" ? "cascade" : "grid",
        columns: toFiniteNumber(item.columns, 4),
        rows: toFiniteNumber(item.rows, 1)
      });
      if (!normalized.displayId || seen.has(normalized.displayId)) {
        continue;
      }
      seen.add(normalized.displayId);
      monitors.push(normalized);
    }

    return {
      version: 2,
      monitors: monitors.length > 0 ? monitors : defaultPrimaryMonitors()
    };
  }

  const displayId =
    typeof candidate.monitorId === "string" && candidate.monitorId.trim()
      ? candidate.monitorId.trim()
      : "primary";
  return {
    version: 2,
    monitors: [
      {
        displayId,
        enabled: true,
        mode: candidate.mode === "cascade" ? "cascade" : "grid",
        columns: sanitizeAxis(toFiniteNumber(candidate.columns, 4)),
        rows: sanitizeAxis(toFiniteNumber(candidate.rows, 1))
      }
    ]
  };
}

export function reconcileScreenLayout(
  settings: ScreenLayoutSettings,
  availableDisplays: readonly AvailableScreenDisplay[]
): ScreenLayoutSettings {
  const normalized = migrateScreenLayoutSettings(settings);
  const primary =
    availableDisplays.find((display) => display.primary) ?? availableDisplays[0];
  let monitors = normalized.monitors.map((monitor) => ({ ...monitor }));

  if (primary) {
    const sentinelIndex = monitors.findIndex((monitor) => monitor.displayId === "primary");
    const concreteIndex = monitors.findIndex((monitor) => monitor.displayId === primary.id);
    if (sentinelIndex >= 0 && concreteIndex >= 0) {
      monitors.splice(sentinelIndex, 1);
    } else if (sentinelIndex >= 0) {
      const sentinel = monitors[sentinelIndex];
      if (sentinel) {
        monitors[sentinelIndex] = { ...sentinel, displayId: primary.id };
      }
    }
  }

  const configuredIds = new Set(monitors.map((monitor) => monitor.displayId));
  for (const display of availableDisplays) {
    if (configuredIds.has(display.id)) {
      continue;
    }
    monitors.push({
      displayId: display.id,
      enabled: false,
      mode: "grid",
      columns: 4,
      rows: 1
    });
    configuredIds.add(display.id);
  }

  const availableIds = new Set(availableDisplays.map((display) => display.id));
  if (!monitors.some((monitor) => monitor.enabled && availableIds.has(monitor.displayId))) {
    const fallbackId = primary?.id ?? availableDisplays[0]?.id;
    if (fallbackId) {
      monitors = monitors.map((monitor) =>
        monitor.displayId === fallbackId ? { ...monitor, enabled: true } : monitor
      );
    }
  }

  return { version: 2, monitors };
}

export function getScreenLayoutSlotCount(layout: ScreenMonitorLayout): number {
  const normalized = normalizeMonitorLayout(layout);
  return normalized.mode === "cascade" ? 8 : normalized.columns * normalized.rows;
}

function buildGridSlots(
  workArea: LayoutRect,
  layout: ScreenMonitorLayout
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
  layout: ScreenMonitorLayout
): LogicalLayoutResult {
  const normalized = normalizeMonitorLayout(layout);
  return {
    mode: normalized.mode === "cascade" ? "cascade" : "grid",
    workArea: { ...workArea },
    slots:
      normalized.mode === "cascade"
        ? buildCascadeSlots(workArea)
        : buildGridSlots(workArea, normalized)
  };
}

export function buildMultiDisplayLogicalLayout(
  settings: ScreenLayoutSettings,
  availableDisplays: readonly AvailableScreenDisplay[]
): MultiDisplayLogicalLayout {
  const reconciled = reconcileScreenLayout(settings, availableDisplays);
  const displayById = new Map(availableDisplays.map((display) => [display.id, display]));
  let nextGlobalSlotIndex = 0;
  const displays: ResolvedDisplayLayout[] = [];

  for (const monitor of reconciled.monitors) {
    const display = displayById.get(monitor.displayId);
    if (!display || !monitor.enabled) {
      continue;
    }
    const logical = buildLogicalLayout(display.workArea, monitor);
    const slots = logical.slots.map((slot) => {
      const globalSlotIndex = nextGlobalSlotIndex;
      nextGlobalSlotIndex += 1;
      return {
        ...slot,
        slotIndex: globalSlotIndex,
        displayId: display.id,
        localSlotIndex: slot.slotIndex,
        globalSlotIndex
      };
    });
    displays.push({ display, monitor, slots });
  }

  const slots = displays.flatMap((display) => display.slots);
  return { displays, slots, capacity: slots.length };
}

export function resolveMultiDisplaySlot(
  layout: MultiDisplayLogicalLayout,
  requestedSlotIndex: number
): ResolvedMultiDisplaySlot {
  if (layout.capacity < 1) {
    throw new Error("Layout sem slots disponíveis.");
  }
  const normalizedIndex = Math.max(
    0,
    Math.trunc(Number.isFinite(requestedSlotIndex) ? requestedSlotIndex : 0)
  );
  const template = layout.slots[normalizedIndex % layout.capacity];
  if (!template) {
    throw new Error("Layout sem slots disponíveis.");
  }
  return {
    ...template,
    slotIndex: normalizedIndex,
    requestedSlotIndex: normalizedIndex
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

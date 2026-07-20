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
  if (Number.isFinite(scale) && scale > 0) {
    return scale;
  }
  onInvalidScale?.();
  return 1;
}

function resolveIdealScale(
  mode: "grid" | "cascade",
  target: LayoutRect
): number {
  if (mode === "cascade") {
    return 1;
  }
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
    width: Math.max(
      targetPhysicalRect.width,
      Math.round(CHROMIUM_MIN_WINDOW_WIDTH * idealScale)
    ),
    height: Math.max(
      targetPhysicalRect.height,
      Math.round(CHROMIUM_MIN_WINDOW_HEIGHT * idealScale)
    )
  };
  const overlaps =
    footprintPhysicalRect.width > targetPhysicalRect.width + 1 ||
    footprintPhysicalRect.height > targetPhysicalRect.height + 1;
  const cutOff =
    footprintPhysicalRect.x + footprintPhysicalRect.width >
      workAreaPhysical.x + workAreaPhysical.width + 1 ||
    footprintPhysicalRect.y + footprintPhysicalRect.height >
      workAreaPhysical.y + workAreaPhysical.height + 1;

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
  const target = placement.targetPhysicalRect;
  return {
    x: Math.round(target.x / scale),
    y: Math.round(target.y / scale),
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
  ) {
    return false;
  }
  return (
    Math.abs(expected.x - actual.left) <= tolerance &&
    Math.abs(expected.y - actual.top) <= tolerance &&
    Math.abs(expected.width - actual.width) <= tolerance &&
    Math.abs(expected.height - actual.height) <= tolerance
  );
}

import type {
  ScreenDisplayInfo,
  ScreenLayoutSettings,
  ScreenMonitorLayout
} from "../../shared/contracts.js";
import { normalizeMonitorLayout } from "../../shared/window-layout.js";

export interface ToggleMonitorResult {
  settings: ScreenLayoutSettings;
  blocked: boolean;
}

export function getOrderedConnectedDisplays(
  settings: ScreenLayoutSettings,
  displays: readonly ScreenDisplayInfo[]
): ScreenDisplayInfo[] {
  const displayById = new Map(displays.map((display) => [display.id, display]));
  return settings.monitors.flatMap((monitor) => {
    const display = displayById.get(monitor.displayId);
    return display ? [display] : [];
  });
}

export function toggleConnectedMonitor(
  settings: ScreenLayoutSettings,
  connectedIds: readonly string[],
  displayId: string,
  enabled: boolean
): ToggleMonitorResult {
  const connectedIdSet = new Set(connectedIds);
  const enabledConnectedCount = settings.monitors.filter(
    (monitor) => monitor.enabled && connectedIdSet.has(monitor.displayId)
  ).length;
  const target = settings.monitors.find((monitor) => monitor.displayId === displayId);

  if (!target || !connectedIdSet.has(displayId)) {
    return { settings, blocked: false };
  }
  if (!enabled && target.enabled && enabledConnectedCount <= 1) {
    return { settings, blocked: true };
  }

  return {
    settings: {
      version: 2,
      monitors: settings.monitors.map((monitor) =>
        monitor.displayId === displayId ? { ...monitor, enabled } : monitor
      )
    },
    blocked: false
  };
}

export function moveConnectedMonitor(
  settings: ScreenLayoutSettings,
  connectedIds: readonly string[],
  displayId: string,
  direction: -1 | 1
): ScreenLayoutSettings {
  const connectedIdSet = new Set(connectedIds);
  const connectedMonitors = settings.monitors.filter((monitor) =>
    connectedIdSet.has(monitor.displayId)
  );
  const connectedIndex = connectedMonitors.findIndex(
    (monitor) => monitor.displayId === displayId
  );
  const swapTarget = connectedMonitors[connectedIndex + direction];
  if (connectedIndex < 0 || !swapTarget) {
    return settings;
  }

  const sourceIndex = settings.monitors.findIndex(
    (monitor) => monitor.displayId === displayId
  );
  const targetIndex = settings.monitors.findIndex(
    (monitor) => monitor.displayId === swapTarget.displayId
  );
  if (sourceIndex < 0 || targetIndex < 0) {
    return settings;
  }

  const monitors = settings.monitors.slice();
  const source = monitors[sourceIndex];
  const target = monitors[targetIndex];
  if (!source || !target) {
    return settings;
  }
  monitors[sourceIndex] = target;
  monitors[targetIndex] = source;
  return { version: 2, monitors };
}

export function patchMonitorLayout(
  settings: ScreenLayoutSettings,
  displayId: string,
  patch: Partial<Pick<ScreenMonitorLayout, "mode" | "columns" | "rows">>
): ScreenLayoutSettings {
  const changesAxis = patch.columns !== undefined || patch.rows !== undefined;
  return {
    version: 2,
    monitors: settings.monitors.map((monitor) =>
      monitor.displayId === displayId
        ? normalizeMonitorLayout({
            ...monitor,
            ...patch,
            ...(changesAxis ? { mode: "grid" as const } : {})
          })
        : monitor
    )
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  migrateScreenLayoutSettings,
  normalizeMonitorLayout
} from "../src/shared/window-layout.js";
import {
  getOrderedConnectedDisplays,
  moveConnectedMonitor,
  patchMonitorLayout,
  toggleConnectedMonitor
} from "../src/renderer/lib/screen-layout-state.js";
import type {
  ScreenDisplayInfo,
  ScreenLayoutSettings,
  ScreenMonitorLayout
} from "../src/shared/contracts.js";

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

const display = (id: string, primary = false): ScreenDisplayInfo => ({
  id,
  label: `M${id}`,
  primary,
  scaleFactor: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 }
});

test("migrates v1 layout preserving monitor, mode and axes", () => {
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
      monitors: [
        {
          displayId: "primary",
          enabled: true,
          mode: "cascade",
          columns: 5,
          rows: 2
        }
      ]
    }
  );
});

test("normalizes v2 axes, mode and duplicate display ids", () => {
  assert.deepEqual(
    migrateScreenLayoutSettings({
      version: 2,
      monitors: [
        {
          displayId: "7",
          enabled: true,
          mode: "custom",
          columns: 5.9,
          rows: 0
        },
        {
          displayId: "7",
          enabled: false,
          mode: "cascade",
          columns: 2,
          rows: 3
        },
        {
          displayId: "",
          enabled: true,
          mode: "grid",
          columns: 2,
          rows: 2
        }
      ]
    }),
    {
      version: 2,
      monitors: [
        {
          displayId: "7",
          enabled: true,
          mode: "grid",
          columns: 5,
          rows: 1
        }
      ]
    }
  );

  assert.deepEqual(
    normalizeMonitorLayout({
      displayId: " 8 ",
      enabled: false,
      mode: "cascade",
      columns: 3.8,
      rows: 2.9
    }),
    {
      displayId: "8",
      enabled: false,
      mode: "cascade",
      columns: 3,
      rows: 2
    }
  );
});

test("falls back to one enabled primary layout for invalid data", () => {
  assert.deepEqual(migrateScreenLayoutSettings(null), {
    version: 2,
    monitors: [
      {
        displayId: "primary",
        enabled: true,
        mode: "grid",
        columns: 4,
        rows: 1
      }
    ]
  });
});

test("toggle changes only enabled and blocks the last connected monitor", () => {
  const settings: ScreenLayoutSettings = {
    version: 2,
    monitors: [
      monitor("1", 5, 2),
      monitor("hidden", 7, 3),
      monitor("2", 4, 1, false)
    ]
  };

  const blocked = toggleConnectedMonitor(settings, ["1", "2"], "1", false);
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.settings, settings);

  const enabled = toggleConnectedMonitor(settings, ["1", "2"], "2", true);
  assert.equal(enabled.blocked, false);
  assert.equal(
    enabled.settings.monitors.find((item) => item.displayId === "2")?.enabled,
    true
  );
  assert.deepEqual(
    enabled.settings.monitors.find((item) => item.displayId === "hidden"),
    settings.monitors[1]
  );
});

test("moving connected monitors swaps them without moving hidden records", () => {
  const settings: ScreenLayoutSettings = {
    version: 2,
    monitors: [
      monitor("1", 5, 2),
      monitor("hidden", 7, 3),
      monitor("2", 4, 1)
    ]
  };

  const moved = moveConnectedMonitor(settings, ["1", "2"], "2", -1);

  assert.deepEqual(moved.monitors.map((item) => item.displayId), [
    "2",
    "hidden",
    "1"
  ]);
  assert.equal(moved.monitors[1]?.columns, 7);
});

test("patching axes edits only the selected monitor and forces grid mode", () => {
  const settings: ScreenLayoutSettings = {
    version: 2,
    monitors: [
      { ...monitor("1", 5, 2), mode: "cascade" },
      monitor("2", 4, 1)
    ]
  };

  const next = patchMonitorLayout(settings, "1", { columns: 6 });

  assert.deepEqual(next.monitors[0], {
    ...settings.monitors[0],
    mode: "grid",
    columns: 6
  });
  assert.deepEqual(next.monitors[1], settings.monitors[1]);
});

test("orders only connected displays by persisted monitor priority", () => {
  const settings: ScreenLayoutSettings = {
    version: 2,
    monitors: [
      monitor("2", 4, 1),
      monitor("hidden", 7, 3),
      monitor("1", 5, 2)
    ]
  };

  assert.deepEqual(
    getOrderedConnectedDisplays(settings, [display("1", true), display("3"), display("2")])
      .map((item) => item.id),
    ["2", "1"]
  );
});

import { useEffect, useMemo, useState } from "react";
import type {
  AppSettings,
  ScreenDisplayInfo,
  ScreenLayoutMode,
  ScreenLayoutSettings,
  ScreenLayoutSlot
} from "../../shared/contracts.js";

const FIXED_GRID_GAP = 8;
const FIXED_GRID_MARGIN = 8;

const modeLabels: Record<ScreenLayoutMode, string> = {
  grid: "GRADE",
  cascade: "CASCATA",
  custom: "GRADE"
};

function sanitizeAxis(value: number): number {
  return Math.max(1, Math.trunc(Number.isFinite(value) ? value : 1));
}

function getDisplaySize(display?: ScreenDisplayInfo) {
  return {
    width: display?.workArea.width ?? 1920,
    height: display?.workArea.height ?? 1080
  };
}

function sanitizeLayout(layout: ScreenLayoutSettings): ScreenLayoutSettings {
  const mode: ScreenLayoutMode = layout.mode === "cascade" ? "cascade" : "grid";
  return {
    ...layout,
    mode,
    gap: FIXED_GRID_GAP,
    margin: FIXED_GRID_MARGIN,
    columns: sanitizeAxis(layout.columns),
    rows: sanitizeAxis(layout.rows),
    customSlots: []
  };
}

function buildGridSlots(layout: ScreenLayoutSettings, display?: ScreenDisplayInfo): ScreenLayoutSlot[] {
  const effectiveLayout = sanitizeLayout(layout);
  const { width, height } = getDisplaySize(display);
  const columns = effectiveLayout.columns;
  const rows = effectiveLayout.rows;
  const gap = effectiveLayout.gap;
  const margin = effectiveLayout.margin;
  const cellWidth = Math.max(1, (width - margin * 2 - gap * (columns - 1)) / columns);
  const cellHeight = Math.max(1, (height - margin * 2 - gap * (rows - 1)) / rows);
  const slots: ScreenLayoutSlot[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = slots.length + 1;
      slots.push({
        id: `grid-${index}`,
        label: String(index),
        xPercent: ((margin + column * (cellWidth + gap)) / width) * 100,
        yPercent: ((margin + row * (cellHeight + gap)) / height) * 100,
        widthPercent: (cellWidth / width) * 100,
        heightPercent: (cellHeight / height) * 100
      });
    }
  }

  return slots;
}

function buildCascadeSlots(display?: ScreenDisplayInfo): ScreenLayoutSlot[] {
  const { width, height } = getDisplaySize(display);
  const offsetX = (32 / width) * 100;
  const offsetY = (32 / height) * 100;
  return Array.from({ length: 8 }, (_, index) => ({
    id: `cascade-${index + 1}`,
    label: String(index + 1),
    xPercent: Math.min(index * offsetX, 28),
    yPercent: Math.min(index * offsetY, 22),
    widthPercent: 66,
    heightPercent: 72
  }));
}

export function ScreenLayoutPanel({
  settings,
  onUpdate,
  onApplyLayout,
  onPreviewLayout
}: {
  settings: AppSettings;
  onUpdate: (draft: Partial<AppSettings>) => Promise<unknown>;
  onApplyLayout: () => Promise<unknown>;
  onPreviewLayout: () => Promise<unknown>;
}) {
  const [displays, setDisplays] = useState<ScreenDisplayInfo[]>([]);
  const layout = settings.screenLayout;

  const refreshDisplays = async () => {
    setDisplays(await window.predator.screens.listDisplays());
  };

  useEffect(() => {
    void refreshDisplays();
  }, []);

  const selectedDisplay = useMemo(() => {
    if (layout.monitorId !== "primary") {
      const matched = displays.find((display) => display.id === layout.monitorId);
      if (matched) {
        return matched;
      }
    }

    return displays.find((display) => display.primary) ?? displays[0];
  }, [displays, layout.monitorId]);

  const effectiveLayout = useMemo(() => sanitizeLayout(layout), [layout]);
  const previewSlots = useMemo(
    () =>
      effectiveLayout.mode === "cascade"
        ? buildCascadeSlots(selectedDisplay)
        : buildGridSlots(effectiveLayout, selectedDisplay),
    [effectiveLayout, selectedDisplay]
  );

  useEffect(() => {
    const nextLayout = sanitizeLayout(layout);
    if (
      nextLayout.mode !== layout.mode ||
      nextLayout.columns !== layout.columns ||
      nextLayout.rows !== layout.rows ||
      nextLayout.gap !== layout.gap ||
      nextLayout.margin !== layout.margin ||
      layout.customSlots.length > 0
    ) {
      void onUpdate({
        screenLayout: nextLayout
      });
    }
  }, [layout, onUpdate]);

  const updateLayout = (patch: Partial<ScreenLayoutSettings>) => {
    return onUpdate({
      screenLayout: sanitizeLayout({
        ...layout,
        ...patch
      })
    });
  };

  const [colStr, setColStr] = useState(String(effectiveLayout.columns));
  const [rowStr, setRowStr] = useState(String(effectiveLayout.rows));

  useEffect(() => { setColStr(String(effectiveLayout.columns)); }, [effectiveLayout.columns]);
  useEffect(() => { setRowStr(String(effectiveLayout.rows)); }, [effectiveLayout.rows]);

  const handleAxisChange = (key: "columns" | "rows", raw: string, setter: (s: string) => void) => {
    setter(raw);
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1) {
      void updateLayout({ mode: "grid", [key]: sanitizeAxis(n) });
    }
  };

  const handleAxisBlur = (key: "columns" | "rows", raw: string, setter: (s: string) => void) => {
    const sanitized = sanitizeAxis(parseInt(raw, 10) || 1);
    setter(String(sanitized));
    void updateLayout({ mode: "grid", [key]: sanitized });
  };

  const stepAxis = (key: "columns" | "rows", delta: number) => {
    const current = key === "columns" ? effectiveLayout.columns : effectiveLayout.rows;
    const next = sanitizeAxis(current + delta);
    if (key === "columns") setColStr(String(next));
    else setRowStr(String(next));
    void updateLayout({ mode: "grid", [key]: next });
  };

  const displaySize = getDisplaySize(selectedDisplay);

  return (
    <div className="screen-layout-panel">
      <div className="screen-layout-stage">
        <section className="screen-calibrator">
          <div className="screen-calibrator-title">
            CALIBRADOR: {displaySize.width}x{displaySize.height} [{modeLabels[effectiveLayout.mode]}]
          </div>

          <div className="screen-preview">
            <div className="screen-preview-inner">
              {previewSlots.map((slot, index) => (
                <div
                  key={slot.id}
                  className="screen-slot"
                  style={{
                    left: `${slot.xPercent}%`,
                    top: `${slot.yPercent}%`,
                    width: `${slot.widthPercent}%`,
                    height: `${slot.heightPercent}%`,
                    zIndex: index + 1
                  }}
                >
                  <img src="./07-china.png" alt="" className="screen-slot-logo" />
                  <span>{slot.label}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      <div className="screen-bottom-bar">
        <label className="screen-bottom-field screen-monitor-field">
          <span>Monitor</span>
          <select
            onChange={(event) => void updateLayout({ monitorId: event.target.value })}
            value={layout.monitorId}
          >
            <option value="primary">Principal</option>
            {displays.map((display) => (
              <option key={display.id} value={display.id}>
                {display.label}
                {display.primary ? " - principal" : ""}
              </option>
            ))}
          </select>
        </label>

        <button className="screen-refresh-button" onClick={() => void refreshDisplays()} title="Atualizar monitores" type="button">
          Atual.
        </button>

        <div className="screen-bottom-field screen-grade-field">
          <span className="screen-axis-label">Col</span>
          <button className="screen-axis-btn" onClick={() => stepAxis("columns", -1)} type="button">−</button>
          <input
            inputMode="numeric"
            onBlur={() => handleAxisBlur("columns", colStr, setColStr)}
            onChange={(e) => handleAxisChange("columns", e.target.value, setColStr)}
            type="text"
            value={colStr}
          />
          <button className="screen-axis-btn" onClick={() => stepAxis("columns", 1)} type="button">+</button>
          <b>×</b>
          <span className="screen-axis-label">Lin</span>
          <button className="screen-axis-btn" onClick={() => stepAxis("rows", -1)} type="button">−</button>
          <input
            inputMode="numeric"
            onBlur={() => handleAxisBlur("rows", rowStr, setRowStr)}
            onChange={(e) => handleAxisChange("rows", e.target.value, setRowStr)}
            type="text"
            value={rowStr}
          />
          <button className="screen-axis-btn" onClick={() => stepAxis("rows", 1)} type="button">+</button>
        </div>

        <button className="screen-bottom-button screen-preview-button" onClick={() => void onPreviewLayout()} type="button">
          Pré-visualização
        </button>

        <button className="primary-button screen-bottom-button" onClick={() => void onApplyLayout()} type="button">
          Aplicar Agora
        </button>
      </div>
    </div>
  );
}

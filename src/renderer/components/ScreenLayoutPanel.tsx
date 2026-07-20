import { useEffect, useMemo, useState } from "react";
import type {
  AppSettings,
  ScreenDisplayInfo,
  ScreenLayoutMode,
  ScreenMonitorLayout
} from "../../shared/contracts.js";
import {
  buildLogicalLayout,
  reconcileScreenLayout,
  toPercentSlot
} from "../../shared/window-layout.js";
import {
  getOrderedConnectedDisplays,
  moveConnectedMonitor,
  patchMonitorLayout,
  toggleConnectedMonitor
} from "../lib/screen-layout-state.js";

const modeLabels: Record<ScreenLayoutMode, string> = {
  grid: "GRADE",
  cascade: "CASCATA"
};

function sanitizeAxisInput(value: number): number {
  return Math.max(1, Math.trunc(Number.isFinite(value) ? value : 1));
}

const fallbackMonitor: ScreenMonitorLayout = {
  displayId: "primary",
  enabled: true,
  mode: "grid",
  columns: 4,
  rows: 1
};

const getDisplayWorkArea = (display?: ScreenDisplayInfo) =>
  display?.workArea ?? { x: 0, y: 0, width: 1920, height: 1080 };

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
  const [selectedDisplayId, setSelectedDisplayId] = useState<string>();
  const [guardMessage, setGuardMessage] = useState("");
  const layout = settings.screenLayout;
  const reconciledLayout = useMemo(
    () => reconcileScreenLayout(layout, displays),
    [displays, layout]
  );
  const orderedDisplays = useMemo(
    () => getOrderedConnectedDisplays(reconciledLayout, displays),
    [displays, reconciledLayout]
  );

  const refreshDisplays = async () => {
    const nextDisplays = await window.predator.screens.listDisplays();
    const nextLayout = reconcileScreenLayout(layout, nextDisplays);
    setDisplays(nextDisplays);
    setSelectedDisplayId((current) =>
      nextDisplays.some((display) => display.id === current)
        ? current
        : (nextDisplays.find((display) => display.primary)?.id ?? nextDisplays[0]?.id)
    );
    if (JSON.stringify(nextLayout) !== JSON.stringify(layout)) {
      await onUpdate({ screenLayout: nextLayout });
    }
  };

  useEffect(() => {
    void refreshDisplays();
  }, []);

  const effectiveSelectedDisplayId =
    orderedDisplays.some((display) => display.id === selectedDisplayId)
      ? selectedDisplayId
      : (orderedDisplays.find((display) => display.primary)?.id ?? orderedDisplays[0]?.id);
  const selectedDisplay = displays.find(
    (display) => display.id === effectiveSelectedDisplayId
  );
  const selectedMonitor =
    reconciledLayout.monitors.find(
      (monitor) => monitor.displayId === effectiveSelectedDisplayId
    ) ?? fallbackMonitor;
  const previewSlots = useMemo(() => {
    const workArea = getDisplayWorkArea(selectedDisplay);
    return buildLogicalLayout(workArea, selectedMonitor).slots.map((slot) =>
      toPercentSlot(slot, workArea)
    );
  }, [selectedDisplay, selectedMonitor]);

  const [colStr, setColStr] = useState(String(selectedMonitor.columns));
  const [rowStr, setRowStr] = useState(String(selectedMonitor.rows));

  useEffect(() => {
    setColStr(String(selectedMonitor.columns));
  }, [selectedMonitor.columns, selectedMonitor.displayId]);

  useEffect(() => {
    setRowStr(String(selectedMonitor.rows));
  }, [selectedMonitor.displayId, selectedMonitor.rows]);

  const updateSelectedMonitor = (
    patch: Partial<Pick<ScreenMonitorLayout, "mode" | "columns" | "rows">>
  ) => {
    if (!effectiveSelectedDisplayId) {
      return Promise.resolve();
    }
    return onUpdate({
      screenLayout: patchMonitorLayout(
        reconciledLayout,
        effectiveSelectedDisplayId,
        patch
      )
    });
  };

  const handleAxisChange = (
    key: "columns" | "rows",
    raw: string,
    setter: (value: string) => void
  ) => {
    setter(raw);
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      void updateSelectedMonitor({ [key]: sanitizeAxisInput(parsed) });
    }
  };

  const handleAxisBlur = (
    key: "columns" | "rows",
    raw: string,
    setter: (value: string) => void
  ) => {
    const sanitized = sanitizeAxisInput(Number.parseInt(raw, 10) || 1);
    setter(String(sanitized));
    void updateSelectedMonitor({ [key]: sanitized });
  };

  const stepAxis = (key: "columns" | "rows", delta: number) => {
    const current = key === "columns" ? selectedMonitor.columns : selectedMonitor.rows;
    const next = sanitizeAxisInput(current + delta);
    if (key === "columns") {
      setColStr(String(next));
    } else {
      setRowStr(String(next));
    }
    void updateSelectedMonitor({ [key]: next });
  };

  const handleMonitorToggle = (displayId: string, enabled: boolean) => {
    const result = toggleConnectedMonitor(
      reconciledLayout,
      displays.map((display) => display.id),
      displayId,
      enabled
    );
    if (result.blocked) {
      setGuardMessage("Mantenha ao menos um monitor conectado habilitado.");
      return;
    }
    setGuardMessage("");
    void onUpdate({ screenLayout: result.settings });
  };

  const handleMoveMonitor = (displayId: string, direction: -1 | 1) => {
    setGuardMessage("");
    void onUpdate({
      screenLayout: moveConnectedMonitor(
        reconciledLayout,
        displays.map((display) => display.id),
        displayId,
        direction
      )
    });
  };

  const selectMonitorFromKeyboard = (
    event: React.KeyboardEvent<HTMLDivElement>,
    displayId: string
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelectedDisplayId(displayId);
    }
  };

  const displaySize = getDisplayWorkArea(selectedDisplay);

  return (
    <div className="screen-layout-panel">
      <div className="screen-layout-stage">
        <aside className="screen-monitor-sidebar" aria-label="Monitores disponíveis">
          <div className="screen-monitor-list">
            {orderedDisplays.map((display, index) => {
              const monitor = reconciledLayout.monitors.find(
                (item) => item.displayId === display.id
              );
              if (!monitor) {
                return null;
              }
              const selected = display.id === effectiveSelectedDisplayId;
              return (
                <div
                  className={`screen-monitor-item${selected ? " selected" : ""}`}
                  key={display.id}
                  onClick={() => setSelectedDisplayId(display.id)}
                  onKeyDown={(event) => selectMonitorFromKeyboard(event, display.id)}
                  role="button"
                  tabIndex={0}
                >
                  <input
                    aria-label={`Usar ${display.label}`}
                    checked={monitor.enabled}
                    onChange={(event) =>
                      handleMonitorToggle(display.id, event.target.checked)
                    }
                    onClick={(event) => event.stopPropagation()}
                    type="checkbox"
                  />
                  <div className="screen-monitor-copy">
                    <strong>
                      {display.label}
                      {display.primary ? " · Principal" : ""}
                    </strong>
                    <span>
                      {display.bounds.width}×{display.bounds.height} ·{" "}
                      {Math.round(display.scaleFactor * 100)}%
                    </span>
                  </div>
                  <div className="screen-monitor-order">
                    <button
                      aria-label={`Subir ${display.label}`}
                      disabled={index === 0}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleMoveMonitor(display.id, -1);
                      }}
                      type="button"
                    >
                      ↑
                    </button>
                    <button
                      aria-label={`Descer ${display.label}`}
                      disabled={index === orderedDisplays.length - 1}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleMoveMonitor(display.id, 1);
                      }}
                      type="button"
                    >
                      ↓
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {guardMessage && (
            <p className="screen-monitor-guard" role="status">
              {guardMessage}
            </p>
          )}
        </aside>

        <section className="screen-calibrator">
          <div className="screen-calibrator-title">
            CALIBRADOR: {displaySize.width}x{displaySize.height} [{modeLabels[selectedMonitor.mode]}]
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
        <button
          className="screen-refresh-button"
          onClick={() => void refreshDisplays()}
          title="Atualizar monitores"
          type="button"
        >
          Atual.
        </button>

        <div className="screen-bottom-field screen-grade-field">
          <span className="screen-axis-label">Col</span>
          <button className="screen-axis-btn" onClick={() => stepAxis("columns", -1)} type="button">−</button>
          <input
            inputMode="numeric"
            onBlur={() => handleAxisBlur("columns", colStr, setColStr)}
            onChange={(event) => handleAxisChange("columns", event.target.value, setColStr)}
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
            onChange={(event) => handleAxisChange("rows", event.target.value, setRowStr)}
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

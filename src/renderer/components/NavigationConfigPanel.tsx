import type { NavigationMode } from "../../shared/contracts.js";

export function NavigationConfigPanel({
  mobileMode,
  running,
  onMobileModeChange
}: {
  mobileMode: NavigationMode;
  running?: boolean;
  onMobileModeChange: (mode: NavigationMode) => void;
}) {
  return (
    <div className="navigation-config-panel">
      <div className="factory-title">Configuracao de Navegacao</div>

      <label className="nav-config-select">
        <select
          disabled={running}
          onChange={(event) => onMobileModeChange(event.target.value as NavigationMode)}
          value={mobileMode}
        >
          <option value="mobile-ios-android">Modo Mobile</option>
          <option value="desktop">Modo Computador</option>
        </select>
      </label>
    </div>
  );
}

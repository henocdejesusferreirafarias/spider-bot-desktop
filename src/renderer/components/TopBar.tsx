import type { Ref } from "react";
import type { ReactNode } from "react";
import type { UpdateStatus } from "../../shared/contracts.js";
import { Icon } from "./Icon.js";

export function TopBar({
  appVersion,
  instanceName,
  updateStatus,
  onCheckUpdates,
  onInstallUpdate,
  onToggleLicensePopover,
  cockpitActive,
  cockpitAvailable,
  onToggleCockpit,
  onToggleCockpitAlwaysOnTop,
  cockpitAlwaysOnTop,
  licensePopoverOpen,
  licensePopover,
  licenseAnchorRef
}: {
  appVersion: string;
  instanceName?: string;
  updateStatus: UpdateStatus;
  onCheckUpdates: () => void;
  onInstallUpdate: () => void;
  onToggleLicensePopover: () => void;
  cockpitActive?: boolean;
  cockpitAvailable?: boolean;
  onToggleCockpit?: () => void;
  onToggleCockpitAlwaysOnTop?: () => void;
  cockpitAlwaysOnTop?: boolean;
  licensePopoverOpen: boolean;
  licensePopover: ReactNode;
  licenseAnchorRef?: Ref<HTMLDivElement>;
}) {
  const updateBusy = updateStatus.phase === "checking" || updateStatus.phase === "downloading";
  const updateReady = updateStatus.phase === "downloaded";
  const updateLabel = updateReady
    ? "Reiniciar e atualizar"
    : updateStatus.phase === "downloading"
      ? `Baixando ${Math.round(updateStatus.progressPercent ?? 0)}%`
      : "Verificar atualizacoes";
  const cockpitEnabled = Boolean(cockpitActive || cockpitAvailable);
  const cockpitLabel = cockpitActive
    ? "Sair do cockpit"
    : cockpitAvailable
      ? "Entrar no cockpit"
      : "Inicie a automacao para usar o cockpit";

  return (
    <header className="topbar">
      <div className="titlebar-brand">
        <img src="./07-china.png" alt="" style={{width:22,height:22,borderRadius:4,flexShrink:0}} />
        <strong>Spider BOT</strong>
        <span>v{appVersion}</span>
        {instanceName ? <span className="titlebar-instance">{instanceName}</span> : null}
      </div>

      <div aria-hidden="true" className="topbar-drag-spacer" />

      <div className="topbar-actions">
        <button
          aria-label={updateLabel}
          className={`titlebar-icon-button update-status-button phase-${updateStatus.phase}`}
          disabled={updateBusy}
          onClick={updateReady ? onInstallUpdate : onCheckUpdates}
          title={`${updateLabel}. ${updateStatus.message}`}
          type="button"
        >
          <Icon name="refresh" size={15} />
        </button>

        <div className="topbar-action-wrap" ref={licenseAnchorRef}>
          <button
            aria-haspopup="dialog"
            aria-label="Licença"
            aria-pressed={licensePopoverOpen ? true : undefined}
            className={`titlebar-icon-button ${licensePopoverOpen ? "active" : ""}`}
            onClick={onToggleLicensePopover}
            title="Licença"
            type="button"
          >
            <Icon name="shield" size={15} />
          </button>
          {licensePopoverOpen ? licensePopover : null}
        </div>
      </div>

      <div className="window-actions">
        <button
          aria-label="Minimizar Spider BOT"
          className="window-control"
          onClick={() => void window.predator.app.minimize()}
          type="button"
        >
          <Icon name="minus" size={14} />
        </button>
        {cockpitActive ? (
          <button
            aria-label={cockpitAlwaysOnTop ? "Desativar sempre no topo" : "Ativar sempre no topo"}
            className={`window-control cockpit-pin ${cockpitAlwaysOnTop ? "active" : ""}`}
            onClick={onToggleCockpitAlwaysOnTop}
            title={cockpitAlwaysOnTop ? "Sempre no topo" : "Sempre no topo desativado"}
            type="button"
          >
            <Icon name="pin" size={13} />
          </button>
        ) : null}
        <button
          aria-label={cockpitLabel}
          className={`window-control cockpit-toggle ${cockpitActive ? "active" : ""}`}
          disabled={!cockpitEnabled}
          onClick={onToggleCockpit}
          title={cockpitLabel}
          type="button"
        >
          <Icon name={cockpitActive ? "maximize" : "cockpit"} size={13} />
        </button>
        <button
          aria-label="Fechar Spider BOT"
          className="window-control close"
          onClick={() => void window.predator.app.close()}
          type="button"
        >
          <Icon name="close" size={15} />
        </button>
      </div>
    </header>
  );
}

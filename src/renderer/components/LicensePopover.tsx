import type { LicenseClientState } from "@spider-bot/licensing-contracts";
import { formatDateTime, licenseStatusLabel, licenseStatusTone, planTypeLabel } from "../lib/format.js";
import { Pill } from "./Pill.js";

export function LicensePopover({ state, onClose }: { state: LicenseClientState; onClose: () => void }) {
  const statusTone = licenseStatusTone(state.status);

  return (
    <div className="license-popover" role="dialog" aria-label="Detalhes da licença">
      <header className="license-popover-head">
        <div className="license-popover-title">
          <h2>Licença</h2>
          <Pill tone={statusTone}>{licenseStatusLabel(state.status)}</Pill>
        </div>
        <button
          aria-label="Fechar"
          className="license-popover-close"
          onClick={onClose}
          type="button"
        >
          ×
        </button>
      </header>

      <dl className="license-popover-facts">
        <div>
          <dt>E-mail</dt>
          <dd>{state.email ?? "—"}</dd>
        </div>
        <div>
          <dt>Plano</dt>
          <dd>{planTypeLabel(state.planType)}</dd>
        </div>
        <div>
          <dt>Expira em</dt>
          <dd>{formatDateTime(state.expiresAt)}</dd>
        </div>
      </dl>
    </div>
  );
}

import { useState } from "react";
import {
  MAX_AUTOMATION_START_DELAY_SECONDS,
  MIN_AUTOMATION_START_DELAY_SECONDS,
  type AppSettings,
  type CustomDepositAmountRecord
} from "../../shared/contracts.js";
import { CustomDepositModal } from "./CustomDepositModal.js";

interface ProfileFactorySettings {
  quantity: number;
  postRegistrationDepositEnabled: boolean;
  depositAmountMin: number;
  depositAmountMax: number;
  useCustomDeposits: boolean;
  automationStartDelaySeconds: number;
}

export function ProfileFactoryPanel({
  settings,
  running,
  customDepositAmounts,
  onChange,
  onUpdateSettings
}: {
  settings: ProfileFactorySettings;
  running?: boolean;
  customDepositAmounts: CustomDepositAmountRecord[];
  onChange: (settings: ProfileFactorySettings) => void;
  onUpdateSettings: (draft: Partial<AppSettings>) => Promise<unknown>;
}) {
  const [customDepositModalOpen, setCustomDepositModalOpen] = useState(false);
  const [customDepositBusy, setCustomDepositBusy] = useState(false);
  const depositControlsDisabled = Boolean(running || !settings.postRegistrationDepositEnabled);

  const setQuantity = (quantity: number) => {
    onChange({
      ...settings,
      quantity: Math.max(1, Math.min(50, Math.trunc(quantity) || 1))
    });
  };

  const setAutomationStartDelaySeconds = (value: number) => {
    const finite = Number.isFinite(value) ? value : 0;
    const rounded = Math.round(finite * 10) / 10;
    const clamped = Math.max(
      MIN_AUTOMATION_START_DELAY_SECONDS,
      Math.min(MAX_AUTOMATION_START_DELAY_SECONDS, rounded)
    );
    onChange({ ...settings, automationStartDelaySeconds: clamped });
  };

  const normalizeDepositValue = (value: number, fallback: number) =>
    Math.max(1, Math.min(999999, Math.trunc(value) || fallback));

  const formatDelayValue = (value: number) => {
    const rounded = Math.round((Number.isFinite(value) ? value : 0) * 10) / 10;
    if (Number.isInteger(rounded)) {
      return String(rounded);
    }
    return rounded.toFixed(1);
  };

  const setDepositMin = (value: number) => {
    const depositAmountMin = normalizeDepositValue(value, settings.depositAmountMin);
    onChange({
      ...settings,
      depositAmountMin,
      depositAmountMax: Math.max(depositAmountMin, settings.depositAmountMax)
    });
  };

  const setDepositMax = (value: number) => {
    const depositAmountMax = normalizeDepositValue(value, settings.depositAmountMax);
    onChange({
      ...settings,
      depositAmountMin: Math.min(settings.depositAmountMin, depositAmountMax),
      depositAmountMax
    });
  };

  const saveCustomDepositAmounts = async (amounts: CustomDepositAmountRecord[]) => {
    setCustomDepositBusy(true);
    try {
      await onUpdateSettings({
        customDepositAmounts: amounts
      });
      onChange({
        ...settings,
        useCustomDeposits: settings.postRegistrationDepositEnabled && (amounts.length > 0 || settings.useCustomDeposits)
      });
    } finally {
      setCustomDepositBusy(false);
    }
  };

  const setPostRegistrationDepositEnabled = (enabled: boolean) => {
    onChange({
      ...settings,
      postRegistrationDepositEnabled: enabled
    });
    void onUpdateSettings({ postRegistrationDepositEnabled: enabled }).catch(() => undefined);
  };

  return (
    <div className="profile-factory-panel">
      <div className="factory-title">Ajustes de Execucao</div>

      <div className="factory-field">
        <span>Quantidade de perfis</span>
        <div className="factory-stepper">
          <button disabled={running} onClick={() => setQuantity(settings.quantity - 1)} type="button">
            -
          </button>
          <input
            disabled={running}
            inputMode="numeric"
            min={1}
            onChange={(event) => setQuantity(Number(event.target.value))}
            pattern="[0-9]*"
            type="text"
            value={settings.quantity}
          />
          <button disabled={running} onClick={() => setQuantity(settings.quantity + 1)} type="button">
            +
          </button>
        </div>
      </div>

      <div className="factory-field">
        <span>
          Delay entre perfis
        </span>
        <div className="factory-stepper factory-stepper-delay">
          <button
            disabled={running || settings.automationStartDelaySeconds <= MIN_AUTOMATION_START_DELAY_SECONDS}
            onClick={() => setAutomationStartDelaySeconds(settings.automationStartDelaySeconds - 1)}
            type="button"
          >
            -
          </button>
          <input
            disabled={running}
            inputMode="decimal"
            min={MIN_AUTOMATION_START_DELAY_SECONDS}
            max={MAX_AUTOMATION_START_DELAY_SECONDS}
            onChange={(event) => setAutomationStartDelaySeconds(Number(event.target.value))}
            pattern="[0-9]*\.?[0-9]*"
            step="0.5"
            type="text"
            value={formatDelayValue(settings.automationStartDelaySeconds)}
          />
          <button
            disabled={running || settings.automationStartDelaySeconds >= MAX_AUTOMATION_START_DELAY_SECONDS}
            onClick={() => setAutomationStartDelaySeconds(settings.automationStartDelaySeconds + 1)}
            type="button"
          >
            +
          </button>
        </div>
      </div>

      <div className={`factory-deposit-config ${settings.postRegistrationDepositEnabled ? "" : "disabled"}`} aria-disabled={!settings.postRegistrationDepositEnabled}>
        <label className={`factory-checkbox factory-deposit-toggle ${settings.postRegistrationDepositEnabled ? "active" : ""}`}>
          <input
            checked={settings.postRegistrationDepositEnabled}
            disabled={running}
            onChange={(event) => setPostRegistrationDepositEnabled(event.target.checked)}
            type="checkbox"
          />
          <span>Depósito pós-cadastro</span>
        </label>
        <span>Valores Para Depósito:</span>
        <div className="factory-deposit-row">
          <div className="factory-deposit-range">
            <input
              disabled={depositControlsDisabled || settings.useCustomDeposits}
              inputMode="numeric"
              onChange={(event) => setDepositMin(Number(event.target.value))}
              pattern="[0-9]*"
              type="text"
              value={settings.depositAmountMin}
            />
            <input
              disabled={depositControlsDisabled || settings.useCustomDeposits}
              inputMode="numeric"
              onChange={(event) => setDepositMax(Number(event.target.value))}
              pattern="[0-9]*"
              type="text"
              value={settings.depositAmountMax}
            />
          </div>
          <button
            className="primary-button"
            disabled={depositControlsDisabled || !settings.useCustomDeposits}
            onClick={() => {
              onChange({ ...settings, useCustomDeposits: true });
              setCustomDepositModalOpen(true);
            }}
            type="button"
          >
            Personalizar
          </button>
        </div>
        <label className="factory-checkbox factory-deposit-checkbox factory-deposit-checkbox-center">
          <input
            checked={settings.useCustomDeposits}
            disabled={depositControlsDisabled}
            onChange={(event) => onChange({ ...settings, useCustomDeposits: event.target.checked })}
            type="checkbox"
          />
          <span>Usar personalizados</span>
        </label>
      </div>

      <CustomDepositModal
        amounts={customDepositAmounts}
        busy={customDepositBusy}
        onClose={() => setCustomDepositModalOpen(false)}
        onSave={saveCustomDepositAmounts}
        open={customDepositModalOpen}
      />
    </div>
  );
}

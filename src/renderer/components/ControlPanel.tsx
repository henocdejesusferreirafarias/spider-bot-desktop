import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  ActivityLogRecord,
  AppSettings,
  ManualDepositControlResult,
  PixKeyRegistrationControlResult,
  ProfileSummary,
  RuntimeControlSelectionState,
  RuntimeControlTargetSelection,
  RuntimeControlNavigationAction,
  RuntimeWindowTarget,
  WithdrawalPreparationControlResult
} from "../../shared/contracts.js";
import { friendlyActivityLog } from "../lib/friendlyLogs.js";
import { Icon } from "./Icon.js";

interface ControlPanelProps {
  activeProfiles: ProfileSummary[];
  activity: ActivityLogRecord[];
  controlSelectionCanApply: boolean;
  controlSelectionDirty: boolean;
  controlSelectionHint: string;
  controlSelectionState: RuntimeControlSelectionState;
  controlWindowsInput: string;
  mirrorBusy: boolean;
  mirrorFeedback: string;
  mirrorMode: boolean;
  onOpenActivity: () => void;
  onApplyControlWindows: () => void;
  onControlWindowsInputChange: (value: string) => void;
  onMirrorModeChange: (enabled: boolean) => void;
  onOpenWithdrawals: (targetSelection: RuntimeControlTargetSelection) => Promise<WithdrawalPreparationControlResult[]>;
  onRegisterPixKey: (targetSelection: RuntimeControlTargetSelection) => Promise<PixKeyRegistrationControlResult[]>;
  onUpdateSettings: (draft: Partial<AppSettings>) => Promise<unknown>;
  pixPhoneKeyCount: number;
  runtimeWindows: RuntimeWindowTarget[];
  settings: AppSettings;
  variant?: "default" | "cockpit";
  startStopAction?: ReactNode;
  // Estado de deposito elevado ao App (sobrevive a remontagem ao alternar cockpit).
  useCustomDeposits: boolean;
  onUseCustomDepositsChange: (value: boolean) => void;
  depositRangeMin: string;
  onDepositRangeMinChange: (value: string) => void;
  depositRangeMax: string;
  onDepositRangeMaxChange: (value: string) => void;
  onOpenDepositModal: () => void;
}

interface ConsoleLine {
  id: string;
  label: string;
  tone: "neutral" | "success" | "warning" | "danger" | "info";
  value: string;
}

const navigationActions = ["Página Inicial", "Relatório de Apostas", "Página de Baús", "Atualizar Página"];
const navigationRuntimeActions: Partial<Record<string, RuntimeControlNavigationAction>> = {
  "Página Inicial": "home",
  "Relatório de Apostas": "bet-report",
  "Página de Baús": "treasure-chests",
  "Atualizar Página": "refresh"
};
const pixTypes = ["Telefone"];

function randomDepositInRange(min: number, max: number): number {
  const safeMin = Math.max(1, Math.trunc(Math.min(min, max)) || 1);
  const safeMax = Math.max(safeMin, Math.trunc(Math.max(min, max)) || safeMin);
  return safeMin + Math.floor(Math.random() * (safeMax - safeMin + 1));
}

// Gera `count` valores aleatorios (um por perfil), todos dentro de [min, max].
function buildManualDepositAmounts(count: number, min: number, max: number): string[] {
  const total = Math.max(1, Math.trunc(count) || 1);
  return Array.from({ length: total }, () => String(randomDepositInRange(min, max)));
}

function summarizeDepositResults(results: ManualDepositControlResult[]): string {
  const succeeded = results.filter((result) => result.status === "succeeded").length;
  const failed = results.length - succeeded;
  if (failed > 0) {
    return `${succeeded} sucesso(s), ${failed} falha(s).`;
  }

  return `${succeeded} deposito(s) enviado(s).`;
}

function summarizePixRegistrationResults(results: PixKeyRegistrationControlResult[]): string {
  const needsPassword = results.filter((result) => result.status === "needs_withdrawal_password").length;
  const passwordFilled = results.filter((result) => result.status === "withdrawal_password_filled").length;
  const withdrawalReady = results.filter((result) => result.status === "withdrawal_ready").length;
  const pixReceivingReady = results.filter((result) => result.status === "pix_receiving_ready").length;
  const passwordRequired = results.filter((result) => result.status === "withdrawal_password_required").length;
  const passwordEntered = results.filter((result) => result.status === "withdrawal_password_entered").length;
  const pixAddFormReady = results.filter((result) => result.status === "pix_add_form_ready").length;
  const failed = results.filter((result) => result.status === "failed").length;
  if (failed > 0) {
    return `${needsPassword} aguardando senha, ${passwordFilled} senha(s) preenchida(s), ${withdrawalReady} saque(s) pronto(s), ${pixReceivingReady} conta(s) PIX pronta(s), ${passwordRequired} senha(s) de saque solicitada(s), ${passwordEntered} PIN(s) informado(s), ${pixAddFormReady} formulario(s) PIX pronto(s), ${failed} falha(s).`;
  }
  return `${needsPassword} tela(s) aguardando senha; ${passwordFilled} senha(s) preenchida(s); ${withdrawalReady} tela(s) de saque pronta(s); ${pixReceivingReady} conta(s) PIX pronta(s); ${passwordRequired} senha(s) de saque solicitada(s); ${passwordEntered} PIN(s) informado(s); ${pixAddFormReady} formulario(s) PIX pronto(s).`;
}

function summarizeWithdrawalPreparationResults(results: WithdrawalPreparationControlResult[]): string {
  const succeeded = results.filter((result) => result.status === "succeeded").length;
  const failed = results.length - succeeded;
  if (failed > 0) {
    return `${succeeded} saque(s) aberto(s), ${failed} falha(s).`;
  }

  return `${succeeded} tela(s) de saque pronta(s).`;
}

function toneClass(tone: ConsoleLine["tone"]) {
  return tone === "neutral" ? "info" : tone;
}

export function ControlPanel({
  activeProfiles,
  activity,
  controlSelectionCanApply,
  controlSelectionDirty,
  controlSelectionHint,
  controlSelectionState,
  controlWindowsInput,
  mirrorBusy,
  mirrorFeedback,
  mirrorMode,
  onOpenActivity,
  onApplyControlWindows,
  onControlWindowsInputChange,
  onMirrorModeChange,
  onOpenWithdrawals,
  onRegisterPixKey,
  onUpdateSettings,
  pixPhoneKeyCount,
  runtimeWindows,
  settings,
  variant = "default",
  startStopAction,
  useCustomDeposits,
  onUseCustomDepositsChange,
  depositRangeMin,
  onDepositRangeMinChange,
  depositRangeMax,
  onDepositRangeMaxChange,
  onOpenDepositModal
}: ControlPanelProps) {
  const [depositBusy, setDepositBusy] = useState(false);
  const [depositFeedback, setDepositFeedback] = useState("");
  const [pixBusy, setPixBusy] = useState(false);
  const [pixFeedback, setPixFeedback] = useState("");
  const [withdrawalBusy, setWithdrawalBusy] = useState(false);
  const [withdrawalFeedback, setWithdrawalFeedback] = useState("");
  const [selectedPixType, setSelectedPixType] = useState(pixTypes[0] ?? "CPF");
  const [speedHack, setSpeedHack] = useState(1);
  const [speedFeedback, setSpeedFeedback] = useState("");
  const [selectedAction, setSelectedAction] = useState(navigationActions[0] ?? "Página Inicial");
  const [slotSearchTerm, setSlotSearchTerm] = useState("");
  const customDepositAmounts = settings.customDepositAmounts ?? [];
  const targetSelection = controlSelectionState.mode === "none" ? undefined : controlSelectionState;
  const targetCount = targetSelection
    ? targetSelection.mode === "all"
      ? runtimeWindows.length
      : targetSelection.windows.length
    : 0;
  const controlsBlocked = !targetSelection || targetCount === 0;
  const pixTargetCount = targetCount;
  const cockpitMode = variant === "cockpit";

  const visibleConsoleLines = useMemo(() => {
    const accountLines = activeProfiles.flatMap<ConsoleLine>((profile, index) => {
      const account = profile.account;
      if (!account) {
        return [
          {
            id: `${profile.id}-session`,
            label: "Sessao",
            tone: "warning",
            value: `Perfil ${index + 1} aberto sem conta gerada.`
          }
        ];
      }

      return [
        {
          id: `${profile.id}-user`,
          label: "Usuario",
          tone: "success",
          value: `[${account.username}]`
        },
        {
          id: `${profile.id}-password`,
          label: "Senha",
          tone: "warning",
          value: `[${account.password}]`
        },
        {
          id: `${profile.id}-name`,
          label: "Nome real",
          tone: "info",
          value: `[${account.realName}]`
        },
        {
          id: `${profile.id}-phone`,
          label: "Celular",
          tone: "warning",
          value: account.phoneNumber
            ? `[${account.phoneCountryCode} ${account.phoneNumber}]`
            : "Telefone sera gerado no cadastro"
        },
        {
          id: `${profile.id}-session`,
          label: "Sessao",
          tone: "success",
          value: `Perfil ${index + 1} aberto [${profile.proxy ? profile.proxy.label : "Sem Proxy"}]`
        }
      ];
    });
    const activityLines = activity.slice(0, 10).map((entry) => {
      const friendly = friendlyActivityLog(entry);
      return {
        id: entry.id,
        label: friendly.meta,
        tone: friendly.tone,
        value: friendly.title
      } satisfies ConsoleLine;
    });

    return [...accountLines, ...activityLines];
  }, [activeProfiles, activity]);

  useEffect(() => {
    void window.predator.controls.setSelectedWindows(controlSelectionState).catch(() => undefined);
  }, [controlSelectionState]);

  useEffect(() => {
    if (!targetSelection) {
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      void window.predator.controls
        .setSpeed(speedHack, targetSelection)
        .then(() => setSpeedFeedback(""))
        .catch(() => setSpeedFeedback(""));
    }, 80);

    return () => window.clearTimeout(timeout);
  }, [speedHack, targetSelection]);

  const runNavigationAction = (action: string) => {
    setSelectedAction(action);

    const runtimeAction = navigationRuntimeActions[action];
    if (!runtimeAction) {
      return;
    }

    if (!targetSelection) {
      return;
    }

    void window.predator.controls.navigate(runtimeAction, targetSelection).catch(() => undefined);
  };

  const runSlotSearch = () => {
    if (!slotSearchTerm.trim()) {
      return;
    }
    setSelectedAction("Buscar Slots");
    if (!targetSelection) {
      return;
    }
    void window.predator.controls.navigate("slot-search", targetSelection, slotSearchTerm).catch(() => undefined);
  };

  const runDepositAction = async () => {
    const rangeMin = Math.trunc(Number(depositRangeMin));
    const rangeMax = Math.trunc(Number(depositRangeMax));
    if (!useCustomDeposits && (!Number.isFinite(rangeMin) || !Number.isFinite(rangeMax) || rangeMin < 1 || rangeMax < 1)) {
      setDepositFeedback("Defina um intervalo de deposito valido (min e max >= 1).");
      return;
    }
    if (!targetSelection) {
      setDepositFeedback(controlSelectionState.mode === "none" ? controlSelectionState.reason ?? controlSelectionHint : controlSelectionHint);
      return;
    }

    const depositTargetCount = targetCount;
    const amounts = useCustomDeposits
      ? customDepositAmounts.map((entry) => entry.amount)
      : buildManualDepositAmounts(Math.max(1, depositTargetCount), rangeMin, rangeMax);

    if (amounts.length === 0) {
      setDepositFeedback("Cadastre valores personalizados antes de depositar.");
      onOpenDepositModal();
      return;
    }

    setDepositBusy(true);
    setDepositFeedback("");
    try {
      const results = await window.predator.controls.deposit({
        amounts,
        targetSelection
      });
      setDepositFeedback(summarizeDepositResults(results));
      setSelectedAction(useCustomDeposits ? "Depósito personalizado" : `Depósito ${depositRangeMin}-${depositRangeMax}`);
    } catch (caught) {
      setDepositFeedback(caught instanceof Error ? caught.message : "Nao foi possivel executar o deposito.");
    } finally {
      setDepositBusy(false);
    }
  };

  const runPixRegistrationAction = async () => {
    if (!targetSelection || pixTargetCount === 0) {
      setPixFeedback("Abra pelo menos um perfil antes de cadastrar a chave PIX.");
      return;
    }
    if (pixPhoneKeyCount < pixTargetCount) {
      setPixFeedback(
        `Voce selecionou ${pixTargetCount} perfil(is), mas ha apenas ${pixPhoneKeyCount} chave(s) PIX telefone disponiveis.`
      );
      return;
    }

    setPixBusy(true);
    setPixFeedback("");
    setWithdrawalFeedback("");
    try {
      const results = await onRegisterPixKey(targetSelection);
      setPixFeedback(summarizePixRegistrationResults(results));
      setSelectedAction("Cadastrar PIX Telefone");
    } catch (caught) {
      setPixFeedback(caught instanceof Error ? caught.message : "Nao foi possivel cadastrar a chave PIX.");
    } finally {
      setPixBusy(false);
    }
  };

  const runWithdrawalPreparationAction = async () => {
    if (!targetSelection || targetCount === 0) {
      setWithdrawalFeedback("Abra pelo menos um perfil antes de acessar os saques.");
      return;
    }

    setWithdrawalBusy(true);
    setWithdrawalFeedback("");
    setPixFeedback("");
    try {
      const results = await onOpenWithdrawals(targetSelection);
      setWithdrawalFeedback(summarizeWithdrawalPreparationResults(results));
      setSelectedAction("Abrir Saques");
    } catch (caught) {
      setWithdrawalFeedback(caught instanceof Error ? caught.message : "Nao foi possivel abrir os saques.");
    } finally {
      setWithdrawalBusy(false);
    }
  };

  return (
    <div className={`control-panel-shell ${cockpitMode ? "cockpit-control-panel" : ""}`}>
      {!cockpitMode ? (
        <section className="control-console-card">
          <div className="control-card-header">
            <div>
              <h3>Log de Operacoes</h3>
              <p>Painel ativo enquanto os perfis estiverem abertos.</p>
            </div>
            <div className="control-card-actions">
              <button className="ghost-button" onClick={onOpenActivity} type="button">
                <Icon name="activity" size={12} />
                Abrir
              </button>
            </div>
          </div>

          <div className="control-console-frame">
            <div className="control-console-list">
              {visibleConsoleLines.map((line) => (
                <article className="control-console-line" key={line.id}>
                  <span className={`control-console-dot ${toneClass(line.tone)}`} />
                  <div className="control-console-copy">
                    <strong>{line.label}</strong>
                    <span>{line.value}</span>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      <aside className="control-tools-panel">
        {!cockpitMode ? (
          <div className="control-card-header">
            <div>
              <h3>Ferramentas</h3>
              <p>Pronto para integrar os comandos da operacao.</p>
            </div>
          </div>
        ) : null}

        {cockpitMode ? null : (
          <div className="control-tools-list">
            <label className={`control-tool-checkbox ${mirrorMode ? "active" : ""}`}>
              <input
                checked={mirrorMode}
                disabled={mirrorBusy || (controlsBlocked && !mirrorMode)}
                onChange={(event) => onMirrorModeChange(event.target.checked)}
                type="checkbox"
              />
              <span>Modo Espelho</span>
              <strong>{mirrorBusy ? "..." : mirrorMode ? "ON" : "OFF"}</strong>
            </label>
            {mirrorFeedback ? <small className="control-feedback">{mirrorFeedback}</small> : null}
            <label className={`control-tool-checkbox ${settings.autoClosePopupsDuringNavigation ? "active" : ""}`}>
              <input
                checked={settings.autoClosePopupsDuringNavigation}
                onChange={(event) =>
                  void onUpdateSettings({
                    autoClosePopupsDuringNavigation: event.target.checked
                  })
                }
                type="checkbox"
              />
              <span>Fechar Popups</span>
              <strong>{settings.autoClosePopupsDuringNavigation ? "ON" : "OFF"}</strong>
            </label>
            <label className={`control-tool-checkbox ${settings.showAccountInfoOverlay ? "active" : ""}`}>
              <input
                checked={settings.showAccountInfoOverlay}
                onChange={(event) =>
                  void onUpdateSettings({ showAccountInfoOverlay: event.target.checked })
                }
                type="checkbox"
              />
              <span>Dados da conta</span>
              <strong>{settings.showAccountInfoOverlay ? "ON" : "OFF"}</strong>
            </label>
          </div>
        )}

        <div className="control-range-card speed-card">
          <span>Speed Time</span>
          <div className="control-range-row">
            <input
              disabled={controlsBlocked}
              max={25}
              min={1}
              onChange={(event) => setSpeedHack(Number(event.target.value))}
              step={0.25}
              type="range"
              value={speedHack}
            />
            <strong>{speedHack.toFixed(2)}x</strong>
          </div>
          {speedFeedback ? <small className="control-feedback">{speedFeedback}</small> : null}
        </div>

        {cockpitMode ? (
          <label className={`control-tool-checkbox ${settings.showAccountInfoOverlay ? "active" : ""}`}>
            <input
              checked={settings.showAccountInfoOverlay}
              onChange={(event) =>
                void onUpdateSettings({ showAccountInfoOverlay: event.target.checked })
              }
              type="checkbox"
            />
            <span>Dados da conta</span>
          </label>
        ) : null}
      </aside>

      <section className="control-action-card navigation">
        <div className="control-action-list">
          {navigationActions.map((action) => (
            <button
              key={action}
              className={`ghost-button stretch ${selectedAction === action ? "control-action-active" : ""}`}
              disabled={controlsBlocked}
              onClick={() => runNavigationAction(action)}
              type="button"
            >
              {action}
            </button>
          ))}
        </div>
        {cockpitMode ? (
          <div className="control-tool-row">
            <label className={`control-tool-checkbox ${mirrorMode ? "active" : ""}`}>
              <input
                checked={mirrorMode}
                disabled={mirrorBusy || (controlsBlocked && !mirrorMode)}
                onChange={(event) => onMirrorModeChange(event.target.checked)}
                type="checkbox"
              />
              <span>Modo Espelho</span>
            </label>
            <label className={`control-tool-checkbox ${settings.autoClosePopupsDuringNavigation ? "active" : ""}`}>
              <input
                checked={settings.autoClosePopupsDuringNavigation}
                onChange={(event) =>
                  void onUpdateSettings({
                    autoClosePopupsDuringNavigation: event.target.checked
                  })
                }
                type="checkbox"
              />
              <span>Fechar Popups</span>
            </label>
          </div>
        ) : null}
        {cockpitMode && mirrorFeedback ? (
          <small className="control-feedback">{mirrorFeedback}</small>
        ) : null}
      </section>

      <section className="control-action-card deposit">
        {!cockpitMode ? (
          <div className="control-card-header">
            <div>
              <h3>Depósito</h3>
              <p>Valores preparados para o fluxo automatico.</p>
            </div>
          </div>
        ) : null}
        <div className="control-deposit-range">
          <label>
            <span>Min</span>
            <input
              aria-label="Depósito mínimo"
              disabled={useCustomDeposits}
              inputMode="numeric"
              onChange={(event) => onDepositRangeMinChange(event.target.value)}
              pattern="[0-9]*"
              placeholder="Min"
              title="Depósito mínimo"
              type="text"
              value={depositRangeMin}
            />
          </label>
          <label>
            <span>Max</span>
            <input
              aria-label="Depósito máximo"
              disabled={useCustomDeposits}
              inputMode="numeric"
              onChange={(event) => onDepositRangeMaxChange(event.target.value)}
              pattern="[0-9]*"
              placeholder="Max"
              title="Depósito máximo"
              type="text"
              value={depositRangeMax}
            />
          </label>
          <button
            className="ghost-button control-deposit-customize"
            disabled={!useCustomDeposits}
            onClick={onOpenDepositModal}
            type="button"
          >
            Personalizar
          </button>
        </div>
        {cockpitMode ? (
          <div className="deposit-action-row">
            <label className="factory-checkbox control-checkbox">
              <input
                checked={useCustomDeposits}
                onChange={(event) => onUseCustomDepositsChange(event.target.checked)}
                type="checkbox"
              />
              <span>Usar personalizados</span>
            </label>
            <button
              className="primary-button stretch"
              disabled={depositBusy || controlsBlocked}
              onClick={() => void runDepositAction()}
              type="button"
            >
              {depositBusy ? "Depositando..." : "Depositar"}
            </button>
          </div>
        ) : (
          <>
            <label className="factory-checkbox control-checkbox">
              <input
                checked={useCustomDeposits}
                onChange={(event) => onUseCustomDepositsChange(event.target.checked)}
                type="checkbox"
              />
              <span>Usar personalizados</span>
            </label>
            <button
              className="primary-button stretch"
              disabled={depositBusy || controlsBlocked}
              onClick={() => void runDepositAction()}
              type="button"
            >
              {depositBusy ? "Depositando..." : "Depositar"}
            </button>
          </>
        )}
        {depositFeedback ? <small className="control-feedback">{depositFeedback}</small> : null}
      </section>

      <section className="control-action-card pix">
        {!cockpitMode ? (
          <div className="control-card-header">
            <div>
              <h3>Chaves PIX</h3>
              <p>{pixPhoneKeyCount} chave(s) disponiveis para {pixTargetCount} perfil(is).</p>
            </div>
          </div>
        ) : !pixFeedback ? (
          // No cockpit a altura do card e fixa. A contagem e o feedback sao ambos uma
          // linha de <small>; mostrar a contagem so quando NAO ha feedback mantem o card
          // com a mesma altura e impede que o checkbox "Dados da conta" seja cortado.
          <small>{pixPhoneKeyCount} chave(s) / {pixTargetCount} perfil(is)</small>
        ) : null}
        <select onChange={(event) => setSelectedPixType(event.target.value)} value={selectedPixType}>
          {pixTypes.map((pixType) => (
            <option key={pixType} value={pixType}>
              {pixType}
            </option>
          ))}
        </select>
        <button
          className="primary-button stretch"
          disabled={pixBusy || controlsBlocked}
          onClick={() => void runPixRegistrationAction()}
          type="button"
        >
          {pixBusy ? "Preparando..." : "Preparar cadastro PIX"}
        </button>
        <button
          className="ghost-button stretch"
          disabled={withdrawalBusy || controlsBlocked}
          onClick={() => void runWithdrawalPreparationAction()}
          type="button"
        >
          {withdrawalBusy ? "Preparando saques..." : "Preparar Saques"}
        </button>
        {pixFeedback ? <small className="control-feedback">{pixFeedback}</small> : null}
        {withdrawalFeedback ? <small className="control-feedback">{withdrawalFeedback}</small> : null}
      </section>

      <section className="control-action-card slot-search">
        {!cockpitMode ? (
          <div className="control-card-header">
            <div>
              <h3>Buscar Slots</h3>
            </div>
          </div>
        ) : null}
        <div className="control-slot-search-row">
          <input
            onChange={(event) => setSlotSearchTerm(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                runSlotSearch();
              }
            }}
            placeholder="Buscar Slots"
            value={slotSearchTerm}
          />
          <button
            className="ghost-button"
            disabled={!slotSearchTerm.trim() || controlsBlocked}
            onClick={runSlotSearch}
            type="button"
          >
            Buscar
          </button>
        </div>
      </section>

      <section className="control-action-card windows">
        {!cockpitMode ? (
          <div className="control-card-header">
            <div>
              <h3>Janelas Para Controlar</h3>
            </div>
          </div>
        ) : null}
        <div className="control-window-selection-row">
          <input
            onChange={(event) => onControlWindowsInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && controlSelectionCanApply) {
                onApplyControlWindows();
              }
            }}
            placeholder="Ex: 1,2,4 ou 1-3"
            value={controlWindowsInput}
          />
          <button
            className="ghost-button"
            disabled={mirrorBusy || !controlSelectionCanApply}
            onClick={onApplyControlWindows}
            type="button"
          >
            Aplicar
          </button>
        </div>
        <small className={controlSelectionState.mode === "none" ? "control-feedback" : undefined}>
          {controlSelectionDirty && controlSelectionCanApply
            ? `${controlSelectionHint} - clique em Aplicar.`
            : controlSelectionHint || "Nenhuma janela ativa"}
        </small>
        {startStopAction ? <div className="control-start-stop-slot">{startStopAction}</div> : null}
      </section>
    </div>
  );
}

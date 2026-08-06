import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  NAVIGATION_MODES,
  type AppContext,
  type CustomDepositAmountRecord,
  type NavigationMode,
  type ProfileSummary,
  type ProxyConfig,
  type RuntimeControlSelectionState,
  type RuntimeControlTargetSelection,
} from "../shared/contracts.js";
import { ConfirmDialog } from "./components/ConfirmDialog.js";
import { AlertDialog } from "./components/AlertDialog.js";
import { ControlPanel } from "./components/ControlPanel.js";
import { CustomDepositModal } from "./components/CustomDepositModal.js";
import { DomainBlockModal } from "./components/DomainBlockModal.js";
import { DashboardFunctionalPanel } from "./components/DashboardFunctionalPanel.js";
import { Icon } from "./components/Icon.js";
import { InstanceManager } from "./components/InstanceManager.js";
import {
  LinkManagerModal,
  type IndicationLink,
} from "./components/LinkManagerModal.js";
import { LicensePopover } from "./components/LicensePopover.js";
import { NavigationConfigPanel } from "./components/NavigationConfigPanel.js";
import { SystemLogPanel } from "./components/SystemLogPanel.js";
import { SystemLogsView } from "./components/SystemLogsView.js";
import { OperationFooter } from "./components/OperationFooter.js";
import { PixKeysPanel } from "./components/PixKeysPanel.js";
import { countAvailablePixKeys } from "./lib/pix-key-status.js";
import {
  describeProfileDeletionFailures,
  formatProfileDeletionProgress,
} from "./lib/profile-deletion.js";
import { ProfileDetailModal } from "./components/ProfileDetailModal.js";
import { ProfileEditorModal } from "./components/ProfileEditorModal.js";
import { ProfileFactoryPanel } from "./components/ProfileFactoryPanel.js";
import { QuickLaunchPanel } from "./components/QuickLaunchPanel.js";
import { ProfileTable } from "./components/ProfileTable.js";
import { ProxyEditorModal } from "./components/ProxyEditorModal.js";
import { ProxyManager } from "./components/ProxyManager.js";
import { ScreenLayoutPanel } from "./components/ScreenLayoutPanel.js";
import { SectionCard } from "./components/SectionCard.js";
import { Sidebar } from "./components/Sidebar.js";
import { BulkStartStopButton } from "./components/BulkStartStopButton.js";
import { StartStopButton } from "./components/StartStopButton.js";
import { TopBar } from "./components/TopBar.js";
import { usePredatorApp } from "./hooks/usePredatorApp.js";
import { useEditableFocusGuard } from "./hooks/useEditableFocusGuard.js";
import {
  parseRuntimeWindowSelection,
  validateRuntimeWindowSelection,
} from "./lib/controlSelection.js";

type InstanceAppContext = Extract<AppContext, { kind: "instance" }>;

function buildInstanceStorageKey(instanceId: string, key: string): string {
  return `predator:instance:${instanceId}:${key}`;
}

function loadIndicationLinks(storageKey: string): IndicationLink[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as IndicationLink[]) : [];
  } catch {
    return [];
  }
}

function loadNavigationMode(storageKey: string): NavigationMode {
  const stored = window.localStorage.getItem(storageKey);
  return NAVIGATION_MODES.includes(stored as NavigationMode)
    ? (stored as NavigationMode)
    : "mobile-ios-android";
}

function formatDelaySeconds(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0s";
  }
  const rounded = Math.round(value * 10) / 10;
  if (Number.isInteger(rounded)) {
    return `${rounded}s`;
  }
  return `${rounded.toFixed(1)}s`;
}

export default function App() {
  useEditableFocusGuard();
  const [context, setContext] = useState<AppContext>();

  useEffect(() => {
    void window.predator.app.context().then(setContext);
  }, []);

  if (!context) {
    return (
      <div className="app-loading-shell">
        <Icon name="bug" size={24} />
      </div>
    );
  }

  if (context.kind === "manager") {
    return <InstanceManager />;
  }

  return <InstanceApp context={context} />;
}

function InstanceApp({ context }: { context: InstanceAppContext }) {
  const app = usePredatorApp();
  const indicationLinksStorageKey = buildInstanceStorageKey(
    context.instance.id,
    "indication-links",
  );
  const captchaSolverStorageKey = buildInstanceStorageKey(
    context.instance.id,
    "captcha-solver-enabled",
  );
  const navigationModeStorageKey = buildInstanceStorageKey(
    context.instance.id,
    "navigation-mode",
  );
  const [profileEditor, setProfileEditor] = useState<{
    profile?: ProfileSummary;
  }>();
  const [profileDetail, setProfileDetail] = useState<{
    profile: ProfileSummary;
  }>();
  const [proxyEditor, setProxyEditor] = useState<{ proxy?: ProxyConfig }>();
  const [clearLogsConfirmOpen, setClearLogsConfirmOpen] = useState(false);
  const [deleteSelectedConfirmOpen, setDeleteSelectedConfirmOpen] =
    useState(false);
  const [deleteSelectedFeedback, setDeleteSelectedFeedback] =
    useState<string>();
  const [captchaSolverConfirmOpen, setCaptchaSolverConfirmOpen] =
    useState(false);
  const [operationUrl, setOperationUrl] = useState("https://example.com");
  const [multipleLinksEnabled, setMultipleLinksEnabled] = useState(false);
  const [captchaSolverEnabled, setCaptchaSolverEnabled] = useState(
    () => window.localStorage.getItem(captchaSolverStorageKey) === "true",
  );
  const [useProxyOnFactory, setUseProxyOnFactory] = useState(false);
  const [linkManagerOpen, setLinkManagerOpen] = useState(false);
  const [indicationLinks, setIndicationLinks] = useState<IndicationLink[]>(() =>
    loadIndicationLinks(indicationLinksStorageKey),
  );
  const [mobileMode, setMobileMode] = useState<NavigationMode>(() =>
    loadNavigationMode(navigationModeStorageKey),
  );
  const [licensePopoverOpen, setLicensePopoverOpen] = useState(false);
  const [cockpitMode, setCockpitMode] = useState(false);
  const [cockpitAlwaysOnTop, setCockpitAlwaysOnTop] = useState(true);
  const [mirrorMode, setMirrorMode] = useState(false);
  const [mirrorBusy, setMirrorBusy] = useState(false);
  const [mirrorFeedback, setMirrorFeedback] = useState("");
  const mirrorRequestIdRef = useRef(0);
  const mirrorSelectionRef = useRef<RuntimeControlTargetSelection>({
    mode: "all",
  });
  // Estado do deposito manual + modal, elevado para sobreviver a remontagem do
  // ControlPanel quando o cockpit alterna (cockpit/normal sao arvores separadas).
  const [manualUseCustomDeposits, setManualUseCustomDeposits] = useState(false);
  const [manualDepositMin, setManualDepositMin] = useState("10");
  const [manualDepositMax, setManualDepositMax] = useState("50");
  const [controlWindowsInput, setControlWindowsInput] = useState("");
  const [appliedControlWindowsInput, setAppliedControlWindowsInput] =
    useState("");
  const [appliedControlSelection, setAppliedControlSelection] =
    useState<RuntimeControlSelectionState>({ mode: "all" });
  const [depositModalOpen, setDepositModalOpen] = useState(false);
  const [depositModalBusy, setDepositModalBusy] = useState(false);
  const [restoreCockpitAfterDeposit, setRestoreCockpitAfterDeposit] =
    useState(false);
  const [domainBlockModalOpen, setDomainBlockModalOpen] = useState(false);
  const licensePopoverRef = useRef<HTMLDivElement>(null);
  const [profileFactory, setProfileFactory] = useState({
    quantity: 1,
    postRegistrationDepositEnabled: true,
    depositAmountMin: 10,
    depositAmountMax: 30,
    useCustomDeposits: false,
    automationStartDelaySeconds: 20,
  });

  // Perfis com status de automacao ativa (launching, active, running-automation).
  // Usado para logs e informativos - NAO para visibilidade do painel/footer.
  const activeProfiles = app.snapshot.profiles.filter((profile) =>
    ["active", "launching", "running-automation"].includes(profile.status),
  );
  const healthyProxies = app.snapshot.proxies.filter(
    (proxy) => proxy.status === "healthy",
  );
  const panelActivity = app.snapshot.activity.slice(0, 20);
  const creatingProfiles = app.autoProfileRun.running;

  // Ha janelas de browser abertas (runtimeWindows existe enquanto o browser esta
  // aberto, mesmo que a automacao tenha falhado e o perfil esteja em "error").
  // Usado para determinar se o painel de controle e footer devem aparecer.
  const hasOpenWindows = app.snapshot.runtimeWindows.length > 0;
  const operationRunning = creatingProfiles || hasOpenWindows;
  const controlPanelMode = app.section === "dashboard" && operationRunning;
  const openWindowCount = app.snapshot.runtimeWindows.length;
  const operationRunningLabel = app.autoProfileRun.stopping
    ? "Parando..."
    : creatingProfiles
      ? `Criando ${app.autoProfileRun.launched}/${app.autoProfileRun.requested} (delay ${formatDelaySeconds(
          app.autoProfileRun.automationStartDelaySeconds,
        )})`
      : `${openWindowCount} aba${openWindowCount === 1 ? "" : "s"} aberta${openWindowCount === 1 ? "" : "s"}`;
  const selectedIndicationLinks = indicationLinks.filter(
    (link) => link.selected,
  );
  const contentModeClass = [
    app.section === "dashboard" ? "dashboard-mode" : "",
    app.section === "screens" ? "screen-mode" : "",
    controlPanelMode ? "control-mode" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const licenseState = app.snapshot.license;
  const postRegistrationDepositEnabled =
    app.snapshot.settings.postRegistrationDepositEnabled ?? true;
  // Janelas ABERTAS de verdade (runtimeWindows vem dos handles abertos). Usado para o botao
  // Play/Stop refletir a janela, nao so o status da automacao (ex.: "error" fica aberto).
  const openWindowProfileIds = useMemo(
    () =>
      new Set(
        app.snapshot.runtimeWindows.map(
          (windowTarget) => windowTarget.profileId,
        ),
      ),
    [app.snapshot.runtimeWindows],
  );
  const controlSelectionDraft = useMemo(
    () =>
      parseRuntimeWindowSelection(
        controlWindowsInput,
        app.snapshot.runtimeWindows,
      ),
    [controlWindowsInput, app.snapshot.runtimeWindows],
  );
  const validatedAppliedControlSelection = useMemo(
    () =>
      validateRuntimeWindowSelection(
        appliedControlSelection,
        app.snapshot.runtimeWindows,
      ),
    [appliedControlSelection, app.snapshot.runtimeWindows],
  );
  const controlSelectionDirty =
    controlWindowsInput !== appliedControlWindowsInput;
  const controlSelectionState = useMemo<RuntimeControlSelectionState>(() => {
    if (!controlSelectionDirty) {
      return validatedAppliedControlSelection;
    }
    if (controlSelectionDraft.state.mode === "none") {
      return controlSelectionDraft.state;
    }
    return {
      mode: "none",
      reason: "Clique em Aplicar para confirmar as janelas.",
    };
  }, [
    controlSelectionDirty,
    controlSelectionDraft.state,
    validatedAppliedControlSelection,
  ]);
  const appliedControlSelectionHint = useMemo(
    () =>
      parseRuntimeWindowSelection(
        appliedControlWindowsInput,
        app.snapshot.runtimeWindows,
      ).message,
    [appliedControlWindowsInput, app.snapshot.runtimeWindows],
  );
  const controlSelectionHint = controlSelectionDirty
    ? controlSelectionDraft.message
    : controlSelectionState.mode === "none"
      ? (controlSelectionState.reason ?? controlSelectionDraft.message)
      : appliedControlSelectionHint;
  const controlSelectionCanApply =
    controlSelectionDraft.state.mode !== "none" &&
    (controlSelectionDirty || controlSelectionState.mode === "none");

  const applyMirrorMode = useCallback(
    async (
      enabled: boolean,
      selection: RuntimeControlTargetSelection,
      successMessage = "",
    ): Promise<boolean> => {
      const requestId = mirrorRequestIdRef.current + 1;
      mirrorRequestIdRef.current = requestId;
      setMirrorBusy(true);
      setMirrorFeedback("");

      try {
        await window.predator.controls.setMirrorMode(enabled, selection);
        if (mirrorRequestIdRef.current !== requestId) {
          return false;
        }
        setMirrorMode(enabled);
        if (enabled) {
          mirrorSelectionRef.current = selection;
        }
        setMirrorFeedback(successMessage);
        return true;
      } catch (caught) {
        if (mirrorRequestIdRef.current === requestId) {
          setMirrorMode(false);
          setMirrorFeedback(
            caught instanceof Error
              ? caught.message
              : "Nao foi possivel atualizar o Modo Espelho.",
          );
        }
        return false;
      } finally {
        if (mirrorRequestIdRef.current === requestId) {
          setMirrorBusy(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    setProfileFactory((current) =>
      current.postRegistrationDepositEnabled === postRegistrationDepositEnabled
        ? current
        : { ...current, postRegistrationDepositEnabled },
    );
  }, [postRegistrationDepositEnabled]);

  useEffect(() => {
    if (!mirrorMode) {
      return;
    }

    const leftControlPanel = app.section !== "dashboard";
    const noOpenWindows = !hasOpenWindows;
    const staleSelection = validatedAppliedControlSelection.mode === "none";
    if (!leftControlPanel && !noOpenWindows && !staleSelection) {
      return;
    }

    const feedback = staleSelection
      ? (validatedAppliedControlSelection.reason ??
        "A selecao do Modo Espelho ficou desatualizada.")
      : "";

    if (leftControlPanel) {
      void applyMirrorMode(false, mirrorSelectionRef.current, feedback);
      return;
    }

    const timer = setTimeout(() => {
      void applyMirrorMode(false, mirrorSelectionRef.current, feedback);
    }, 800);
    return () => clearTimeout(timer);
  }, [
    app.section,
    applyMirrorMode,
    hasOpenWindows,
    mirrorMode,
    validatedAppliedControlSelection,
  ]);

  useEffect(() => {
    void window.predator.app
      .getWindowMode()
      .then((mode) => {
        setCockpitMode(mode.cockpit);
        setCockpitAlwaysOnTop(mode.alwaysOnTop);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      indicationLinksStorageKey,
      JSON.stringify(indicationLinks),
    );
  }, [indicationLinks]);

  useEffect(() => {
    window.localStorage.setItem(
      captchaSolverStorageKey,
      captchaSolverEnabled ? "true" : "false",
    );
  }, [captchaSolverEnabled]);

  useEffect(() => {
    window.localStorage.setItem(navigationModeStorageKey, mobileMode);
  }, [mobileMode]);

  useEffect(() => {
    if (!licensePopoverOpen) return;
    const handlePointer = (event: MouseEvent) => {
      const anchor = licensePopoverRef.current;
      if (
        anchor &&
        event.target instanceof Node &&
        !anchor.contains(event.target)
      ) {
        setLicensePopoverOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLicensePopoverOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [licensePopoverOpen]);

  useEffect(() => {
    if (!cockpitMode || operationRunning) {
      return;
    }

    void window.predator.app
      .setCockpitMode(false)
      .then((mode) => {
        setCockpitMode(mode.cockpit);
        setCockpitAlwaysOnTop(mode.alwaysOnTop);
      })
      .catch(() => {
        setCockpitMode(false);
      });
  }, [cockpitMode, operationRunning]);

  const deleteProfile = (profileId: string) => {
    return app.deleteProfile(profileId);
  };

  // Perfis selecionados que estao em status ativo (launching, active, running-automation).
  // Usado para o botao Start/Stop da lista de perfis.
  const anySelectedRunning = useMemo(() => {
    if (app.selectedProfileIds.size === 0) return false;
    for (const profile of app.snapshot.profiles) {
      if (!app.selectedProfileIds.has(profile.id)) continue;
      const status = profile.status;
      if (
        status === "active" ||
        status === "launching" ||
        status === "running-automation"
      ) {
        return true;
      }
    }
    return false;
  }, [app.selectedProfileIds, app.snapshot.profiles]);

  // Perfis selecionados que tem janela aberta (mesmo que a automacao tenha falhado).
  // Usado para permitir parar perfis mesmo quando a automacao esta em "error".
  const anySelectedWithOpenWindow = useMemo(() => {
    if (app.selectedProfileIds.size === 0) return false;
    for (const windowTarget of app.snapshot.runtimeWindows) {
      if (app.selectedProfileIds.has(windowTarget.profileId)) {
        return true;
      }
    }
    return false;
  }, [app.selectedProfileIds, app.snapshot.runtimeWindows]);

  const launchSelectedProfiles = () => {
    for (const profileId of app.selectedProfileIds) {
      const profile = app.snapshot.profiles.find(
        (candidate) => candidate.id === profileId,
      );
      if (!profile) continue;
      const status = profile.status;
      if (
        status === "active" ||
        status === "launching" ||
        status === "running-automation" ||
        status === "stopping"
      ) {
        continue;
      }
      app.launchProfile(profileId);
    }
  };

  const stopSelectedProfiles = () => {
    for (const profileId of app.selectedProfileIds) {
      const profile = app.snapshot.profiles.find(
        (candidate) => candidate.id === profileId,
      );
      if (!profile) continue;
      const status = profile.status;
      if (
        status === "active" ||
        status === "launching" ||
        status === "running-automation"
      ) {
        app.stopProfile(profileId);
      }
    }
  };

  const selectedProfileCount = app.selectedProfileIds.size;
  const allProfilesSelected =
    app.filteredProfiles.length > 0 &&
    app.filteredProfiles.every((profile) =>
      app.selectedProfileIds.has(profile.id),
    );

  const toggleSelectAllProfiles = () => {
    app.setProfileSelection(
      app.filteredProfiles.map((profile) => profile.id),
      !allProfilesSelected,
    );
  };

  const deleteSelectedProfiles = async () => {
    try {
      const result = await app.deleteProfiles([...app.selectedProfileIds]);
      setDeleteSelectedFeedback(describeProfileDeletionFailures(result));
    } catch (error) {
      setDeleteSelectedFeedback(
        error instanceof Error
          ? error.message
          : "Nao foi possivel excluir os perfis.",
      );
    } finally {
      setDeleteSelectedConfirmOpen(false);
    }
  };

  const deleteProxy = (proxyId: string) => {
    return app.deleteProxy(proxyId);
  };

  const clearLogs = async () => {
    await app.clearActivity();
    await app.clearRuns();
    setClearLogsConfirmOpen(false);
  };

  const runProfileFactory = () => {
    app.setSection("dashboard");
    return app.createProfilesAutomatically({
      ...profileFactory,
      captchaSolverEnabled,
      customDepositAmounts: app.snapshot.settings.customDepositAmounts ?? [],
      homeUrl: operationUrl,
      homeUrls: multipleLinksEnabled
        ? selectedIndicationLinks.map((link) => link.url)
        : undefined,
      navigationMode: mobileMode,
      proxyIds: useProxyOnFactory
        ? app.snapshot.proxies.map((proxy) => proxy.id)
        : undefined,
    });
  };

  const toggleCockpitMode = () => {
    const nextMode = !cockpitMode;
    if (nextMode && !operationRunning) {
      return;
    }

    void window.predator.app
      .setCockpitMode(nextMode)
      .then((mode) => {
        setCockpitMode(mode.cockpit);
        setCockpitAlwaysOnTop(mode.alwaysOnTop);
      })
      .catch(() => undefined);
  };

  const toggleCockpitAlwaysOnTop = () => {
    const nextValue = !cockpitAlwaysOnTop;
    void window.predator.app
      .setCockpitAlwaysOnTop(nextValue)
      .then((mode) => {
        setCockpitAlwaysOnTop(mode.alwaysOnTop);
        setCockpitMode(mode.cockpit);
      })
      .catch(() => undefined);
  };

  const setCockpitFromMode = (mode: {
    cockpit: boolean;
    alwaysOnTop: boolean;
  }) => {
    setCockpitMode(mode.cockpit);
    setCockpitAlwaysOnTop(mode.alwaysOnTop);
  };

  const saveDepositAmounts = async (amounts: CustomDepositAmountRecord[]) => {
    setDepositModalBusy(true);
    try {
      await app.updateSettings({ customDepositAmounts: amounts });
    } finally {
      setDepositModalBusy(false);
    }
  };

  // No cockpit, abrir os depositos personalizados restaura a janela ao tamanho
  // normal (modal in-app consistente e instantaneo) e volta ao cockpit ao fechar.
  const openDepositModal = () => {
    if (cockpitMode) {
      setRestoreCockpitAfterDeposit(true);
      void window.predator.app
        .setCockpitMode(false)
        .then(setCockpitFromMode)
        .catch(() => undefined);
    }
    setDepositModalOpen(true);
  };

  const closeDepositModal = () => {
    setDepositModalOpen(false);
    if (restoreCockpitAfterDeposit) {
      setRestoreCockpitAfterDeposit(false);
      void window.predator.app
        .setCockpitMode(true)
        .then(setCockpitFromMode)
        .catch(() => undefined);
    }
  };

  // Bloqueio de dominios e configurado na tela inicial (Funcionalidades), antes de iniciar
  // as automacoes — nao aparece no ControlPanel/cockpit, entao nao ha dance de cockpit aqui.
  const openDomainBlockModal = () => setDomainBlockModalOpen(true);
  const closeDomainBlockModal = () => setDomainBlockModalOpen(false);

  const applyControlWindowSelection = async () => {
    if (controlSelectionDraft.state.mode === "none") {
      return;
    }

    if (mirrorMode) {
      const reconfigured = await applyMirrorMode(
        true,
        controlSelectionDraft.state,
      );
      if (!reconfigured) {
        return;
      }
    }

    setAppliedControlWindowsInput(controlWindowsInput);
    setAppliedControlSelection(controlSelectionDraft.state);
  };

  const changeMirrorMode = async (enabled: boolean) => {
    if (mirrorBusy) {
      return;
    }

    if (enabled) {
      if (controlSelectionState.mode === "none") {
        setMirrorFeedback(
          controlSelectionState.reason ||
            "Selecione pelo menos uma janela ativa.",
        );
        return;
      }
      await applyMirrorMode(true, controlSelectionState);
      return;
    }

    await applyMirrorMode(false, mirrorSelectionRef.current);
  };

  const depositControlProps = {
    useCustomDeposits: manualUseCustomDeposits,
    onUseCustomDepositsChange: setManualUseCustomDeposits,
    depositRangeMin: manualDepositMin,
    onDepositRangeMinChange: setManualDepositMin,
    depositRangeMax: manualDepositMax,
    onDepositRangeMaxChange: setManualDepositMax,
    onOpenDepositModal: openDepositModal,
  };

  const controlPanel = (variant: "default" | "cockpit" = "default") => (
    <ControlPanel
      activeProfiles={activeProfiles}
      activity={panelActivity}
      controlSelectionCanApply={controlSelectionCanApply}
      controlSelectionDirty={controlSelectionDirty}
      controlSelectionHint={controlSelectionHint}
      controlSelectionState={controlSelectionState}
      controlWindowsInput={controlWindowsInput}
      mirrorBusy={mirrorBusy}
      mirrorFeedback={mirrorFeedback}
      mirrorMode={mirrorMode}
      onOpenActivity={() => app.setSection("activity")}
      onApplyControlWindows={applyControlWindowSelection}
      onControlWindowsInputChange={setControlWindowsInput}
      onMirrorModeChange={(enabled) => void changeMirrorMode(enabled)}
      onOpenWithdrawals={app.openWithdrawals}
      onRegisterPixKey={app.registerPixKey}
      onUpdateSettings={app.updateSettings}
      pixPhoneKeyCount={countAvailablePixKeys(
        app.snapshot.pixPhoneKeys.map((key) => key.status),
      )}
      runtimeWindows={app.snapshot.runtimeWindows}
      settings={app.snapshot.settings}
      variant={variant}
      {...depositControlProps}
    />
  );

  const controlPanelWithStartStop = (
    <ControlPanel
      activeProfiles={activeProfiles}
      activity={panelActivity}
      controlSelectionCanApply={controlSelectionCanApply}
      controlSelectionDirty={controlSelectionDirty}
      controlSelectionHint={controlSelectionHint}
      controlSelectionState={controlSelectionState}
      controlWindowsInput={controlWindowsInput}
      mirrorBusy={mirrorBusy}
      mirrorFeedback={mirrorFeedback}
      mirrorMode={mirrorMode}
      onOpenActivity={() => app.setSection("activity")}
      onApplyControlWindows={applyControlWindowSelection}
      onControlWindowsInputChange={setControlWindowsInput}
      onMirrorModeChange={(enabled) => void changeMirrorMode(enabled)}
      onOpenWithdrawals={app.openWithdrawals}
      onRegisterPixKey={app.registerPixKey}
      onUpdateSettings={app.updateSettings}
      pixPhoneKeyCount={countAvailablePixKeys(
        app.snapshot.pixPhoneKeys.map((key) => key.status),
      )}
      runtimeWindows={app.snapshot.runtimeWindows}
      settings={app.snapshot.settings}
      startStopAction={
        <StartStopButton
          onRun={() => void runProfileFactory()}
          onStop={() => void app.stopAutomaticProfileCreation()}
          running={operationRunning}
        />
      }
      variant="cockpit"
      {...depositControlProps}
    />
  );

  const operationFooter = (
    <OperationFooter
      activeSessionCount={openWindowCount}
      compact={cockpitMode}
      multipleLinksEnabled={multipleLinksEnabled}
      onOperationUrlChange={setOperationUrl}
      onOpenLinks={() => setLinkManagerOpen(true)}
      onRun={() => void runProfileFactory()}
      onStop={() => void app.stopAutomaticProfileCreation()}
      operationUrl={operationUrl}
      profileCount={app.snapshot.profiles.length}
      proxyHealth={`${healthyProxies.length}/${app.snapshot.proxies.length}`}
      running={operationRunning}
      runningLabel={operationRunningLabel}
      selectedLinkCount={selectedIndicationLinks.length}
    />
  );

  return (
    <div className={`app-shell ${cockpitMode ? "cockpit-mode" : ""}`}>
      <TopBar
        licenseAnchorRef={licensePopoverRef}
        licensePopover={
          <LicensePopover
            onClose={() => setLicensePopoverOpen(false)}
            state={licenseState}
          />
        }
        licensePopoverOpen={licensePopoverOpen}
        appVersion={app.appInfo.version}
        instanceName={context.instance.name}
        cockpitActive={cockpitMode}
        cockpitAvailable={operationRunning}
        cockpitAlwaysOnTop={cockpitAlwaysOnTop}
        onCheckUpdates={() => void app.checkForUpdates().catch(() => undefined)}
        onInstallUpdate={() => void app.installUpdate().catch(() => undefined)}
        onToggleCockpit={toggleCockpitMode}
        onToggleCockpitAlwaysOnTop={toggleCockpitAlwaysOnTop}
        onToggleLicensePopover={() => setLicensePopoverOpen((open) => !open)}
        updateStatus={app.updateStatus}
      />

      {!cockpitMode ? (
        <Sidebar
          activeSection={app.section}
          activeSessions={openWindowCount}
          onSectionChange={app.setSection}
          totalProfiles={app.snapshot.profiles.length}
        />
      ) : null}

      <main className={`workspace ${cockpitMode ? "cockpit-workspace" : ""}`}>
        {cockpitMode ? (
          <section className="cockpit-control-strip">
            {controlPanelWithStartStop}
          </section>
        ) : (
          <section className={`content-grid ${contentModeClass}`}>
            <div className="primary-column">
              {app.section === "dashboard" &&
                (controlPanelMode ? (
                  <>
                    <SectionCard chrome="bare" title="Painel de Controle">
                      {controlPanel()}
                    </SectionCard>
                    <QuickLaunchPanel
                      busy={app.busyAction === "profile:quick-launch"}
                      navigationMode={mobileMode}
                      onLaunch={(url, triggerAutomation) => {
                        void app
                          .quickLaunchProfile(url, {
                            triggerAutomation,
                            navigationMode: mobileMode,
                          })
                          .catch(() => undefined);
                      }}
                    />
                  </>
                ) : (
                  <SectionCard chrome="bare" title="Operacao">
                    <div className="operation-config-stack">
                      <NavigationConfigPanel
                        mobileMode={mobileMode}
                        onMobileModeChange={setMobileMode}
                        running={creatingProfiles}
                      />
                      <ProfileFactoryPanel
                        customDepositAmounts={
                          app.snapshot.settings.customDepositAmounts ?? []
                        }
                        onChange={setProfileFactory}
                        onUpdateSettings={app.updateSettings}
                        running={creatingProfiles}
                        settings={profileFactory}
                      />
                    </div>
                  </SectionCard>
                ))}

              {app.section === "profiles" && (
                <SectionCard chrome="bare" title="Contas">
                  <div className="profile-card-layout">
                    <div className="profiles-toolbar">
                      <button
                        className="ghost-button"
                        disabled={app.filteredProfiles.length === 0}
                        onClick={toggleSelectAllProfiles}
                        type="button"
                      >
                        <Icon
                          name={allProfilesSelected ? "close" : "duplicate"}
                          size={13}
                        />
                        <span>
                          {allProfilesSelected
                            ? "Limpar selecao"
                            : "Selecionar todos"}
                        </span>
                      </button>
                      {selectedProfileCount > 0 ? (
                        <span className="profiles-toolbar-count">
                          {selectedProfileCount} selecionada
                          {selectedProfileCount > 1 ? "s" : ""}
                        </span>
                      ) : null}
                      <div className="profiles-toolbar-spacer" />
                      <BulkStartStopButton
                        disabled={selectedProfileCount === 0}
                        onRun={launchSelectedProfiles}
                        onStop={stopSelectedProfiles}
                        running={
                          anySelectedRunning || anySelectedWithOpenWindow
                        }
                      />
                      <button
                        className="danger-button"
                        disabled={selectedProfileCount === 0}
                        onClick={() => setDeleteSelectedConfirmOpen(true)}
                        type="button"
                      >
                        <Icon name="trash" size={13} />
                        <span>Excluir selecionados</span>
                      </button>
                    </div>
                    <div className="profile-list-zone">
                      <ProfileTable
                        busyAction={app.busyAction ?? null}
                        onDelete={deleteProfile}
                        onDetail={(profile) => setProfileDetail({ profile })}
                        onEdit={(profile) => setProfileEditor({ profile })}
                        onLaunch={app.launchProfile}
                        onStop={app.stopProfile}
                        onToggleProfile={app.toggleProfileSelection}
                        openProfileIds={openWindowProfileIds}
                        profiles={app.filteredProfiles}
                        selectedProfileIds={app.selectedProfileIds}
                      />
                    </div>
                  </div>
                </SectionCard>
              )}

              {app.section === "dashboard" && !controlPanelMode && (
                <>
                  <SectionCard title="Funcionalidades">
                    <DashboardFunctionalPanel
                      blockedDomainCount={
                        app.snapshot.settings.blockedDomains?.length ?? 0
                      }
                      captchaSolverEnabled={captchaSolverEnabled}
                      domainBlockEnabled={
                        app.snapshot.settings.domainBlockEnabled ?? true
                      }
                      multipleLinksEnabled={multipleLinksEnabled}
                      onManageDomains={openDomainBlockModal}
                      onManageLinks={() => setLinkManagerOpen(true)}
                      onToggleCaptchaSolver={(enabled) => {
                        if (enabled) {
                          setCaptchaSolverConfirmOpen(true);
                        } else {
                          setCaptchaSolverEnabled(false);
                        }
                      }}
                      onToggleDomainBlock={(enabled) =>
                        void app.updateSettings({ domainBlockEnabled: enabled })
                      }
                      onToggleMultipleLinks={setMultipleLinksEnabled}
                      onToggleUseProxyOnFactory={setUseProxyOnFactory}
                      selectedLinkCount={selectedIndicationLinks.length}
                      totalLinkCount={indicationLinks.length}
                      totalProxyCount={app.snapshot.proxies.length}
                      useProxyOnFactory={useProxyOnFactory}
                    />
                  </SectionCard>
                </>
              )}

              {app.section === "proxies" && (
                <SectionCard title="Proxies">
                  <ProxyManager
                    busyAction={app.busyAction}
                    onCreateClick={() => setProxyEditor({})}
                    onDelete={deleteProxy}
                    onEdit={(proxy) => setProxyEditor({ proxy })}
                    onTest={app.testProxy}
                    proxies={app.snapshot.proxies}
                  />
                </SectionCard>
              )}

              {app.section === "pix-keys" && (
                <SectionCard title="Chaves PIX">
                  <PixKeysPanel
                    busyAction={app.busyAction}
                    onAdd={app.addPixPhoneKeys}
                    onDelete={app.deletePixPhoneKey}
                    onUpdate={app.updatePixPhoneKey}
                    pixKeys={app.snapshot.pixPhoneKeys}
                    profiles={app.snapshot.profiles}
                  />
                </SectionCard>
              )}

              {app.section === "screens" && (
                <SectionCard chrome="bare" title="Telas">
                  <ScreenLayoutPanel
                    onApplyLayout={app.applyScreenLayout}
                    onPreviewLayout={app.previewScreenLayout}
                    onUpdate={app.updateSettings}
                    settings={app.snapshot.settings}
                  />
                </SectionCard>
              )}

              {app.section === "activity" && (
                <SectionCard
                  subtitle="Stream consolidado de atividade, execuÃ§Ãµes e alertas do workspace."
                  title="Logs do sistema"
                >
                  <SystemLogsView
                    activity={app.snapshot.activity}
                    profiles={app.snapshot.profiles}
                    runs={app.snapshot.runs}
                    onClear={clearLogs}
                  />
                </SectionCard>
              )}
            </div>

            {app.section === "dashboard" && !controlPanelMode ? (
              <div className="secondary-column">
                <SystemLogPanel
                  activity={panelActivity}
                  onClear={() => setClearLogsConfirmOpen(true)}
                  onOpenActivity={() => app.setSection("activity")}
                />
              </div>
            ) : null}
          </section>
        )}

        {!cockpitMode ? operationFooter : null}
      </main>

      <LinkManagerModal
        links={indicationLinks}
        onChange={setIndicationLinks}
        onClose={() => setLinkManagerOpen(false)}
        open={linkManagerOpen}
      />

      {/* Renderizado no nivel do App (fora do ramo cockpit/normal) para sobreviver
          a transicao de cockpit -> normal ao abrir os depositos personalizados. */}
      <CustomDepositModal
        amounts={app.snapshot.settings.customDepositAmounts ?? []}
        busy={depositModalBusy}
        onClose={closeDepositModal}
        onSave={saveDepositAmounts}
        open={depositModalOpen}
      />

      <DomainBlockModal
        domains={app.snapshot.settings.blockedDomains ?? []}
        onChange={(blockedDomains) =>
          void app.updateSettings({ blockedDomains })
        }
        onClose={closeDomainBlockModal}
        open={domainBlockModalOpen}
      />

      <ProfileDetailModal
        onClose={() => setProfileDetail(undefined)}
        onEdit={(profile) => {
          setProfileDetail(undefined);
          setProfileEditor({ profile });
        }}
        open={Boolean(profileDetail)}
        profile={profileDetail?.profile}
      />

      <ProfileEditorModal
        busy={app.busyAction === "profile:update"}
        onClose={() => setProfileEditor(undefined)}
        onSubmit={(draft) => {
          const profile = profileEditor?.profile;
          if (!profile) {
            return Promise.resolve(undefined);
          }
          return app.updateProfile(profile.id, draft);
        }}
        open={Boolean(profileEditor)}
        profile={profileEditor?.profile}
        proxies={app.snapshot.proxies}
      />

      <ProxyEditorModal
        busy={
          app.busyAction === "proxy:create" || app.busyAction === "proxy:update"
        }
        onClose={() => setProxyEditor(undefined)}
        onSubmit={async (drafts) => {
          const proxy = proxyEditor?.proxy;
          const firstDraft = drafts[0];
          if (!firstDraft) {
            return;
          }

          if (proxy) {
            await app.updateProxy(proxy.id, firstDraft);
            return;
          }

          for (const draft of drafts) {
            await app.createProxy(draft);
          }
        }}
        open={Boolean(proxyEditor)}
        proxy={proxyEditor?.proxy}
      />

      <ConfirmDialog
        confirmLabel="Limpar logs"
        message="Apagar todos os logs de atividade e execuções? Esta ação não pode ser desfeita."
        onCancel={() => setClearLogsConfirmOpen(false)}
        onConfirm={() => void clearLogs()}
        open={clearLogsConfirmOpen}
        title="Limpar logs"
      />

      <ConfirmDialog
        busy={app.busyAction === "profiles:delete-many"}
        confirmLabel={`Excluir ${selectedProfileCount} conta${selectedProfileCount > 1 ? "s" : ""}`}
        message={
          app.profileDeletionProgress
            ? formatProfileDeletionProgress(app.profileDeletionProgress)
            : `Excluir ${selectedProfileCount} conta${selectedProfileCount > 1 ? "s" : ""} selecionada${selectedProfileCount > 1 ? "s" : ""}? Esta ação não pode ser desfeita.`
        }
        onCancel={() => {
          if (app.busyAction !== "profiles:delete-many") {
            setDeleteSelectedConfirmOpen(false);
          }
        }}
        onConfirm={() => void deleteSelectedProfiles()}
        open={deleteSelectedConfirmOpen}
        title="Excluir contas selecionadas"
      />

      <AlertDialog
        message={deleteSelectedFeedback ?? ""}
        onClose={() => setDeleteSelectedFeedback(undefined)}
        open={Boolean(deleteSelectedFeedback)}
        title="Resultado da exclusao"
      />

      <ConfirmDialog
        confirmLabel="Ativar captcha solver"
        message="O captcha solver é uma funcionalidade em fase beta. Pode causar instabilidades no desempenho, erros em automações e não garante resolução de 100% dos captchas. Ativar mesmo assim?"
        onCancel={() => setCaptchaSolverConfirmOpen(false)}
        onConfirm={() => {
          setCaptchaSolverEnabled(true);
          setCaptchaSolverConfirmOpen(false);
        }}
        open={captchaSolverConfirmOpen}
        variant="primary"
        title="Aviso!"
      />
    </div>
  );
}

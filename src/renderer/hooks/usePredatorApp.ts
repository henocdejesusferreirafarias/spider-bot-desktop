import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppInfo,
  AppSection,
  AppSnapshot,
  AutomationDraft,
  CustomDepositAmountRecord,
  NavigationMode,
  PersonaConfig,
  ProfileDraft,
  ProfileSummary,
  ProxyDraft,
  RuntimeControlTargetSelection,
  UpdateStatus
} from "../../shared/contracts.js";
import {
  ACCOUNT_REGISTRATION_KIND,
  MAX_AUTOMATION_START_DELAY_SECONDS,
  MIN_AUTOMATION_START_DELAY_SECONDS,
  RECOMMENDED_MIN_START_DELAY_SECONDS,
  NAVIGATION_MODE_LAUNCH_ARG_PREFIX
} from "../../shared/contracts.js";

const autoProfileColors = ["#d6d6d6", "#b8c0c8", "#8f989f", "#f2f2f2"];
const activeRuntimeStatuses = new Set<ProfileSummary["status"]>(["active", "launching", "running-automation", "error", "stopping"]);
const defaultAutomationLaunchArgs = ["--disable-session-crashed-bubble", "--disable-features=TranslateUI"];

const FALLBACK_SNAPSHOT: AppSnapshot = {
  profiles: [],
  proxies: [],
  automations: [],
  runs: [],
  activity: [],
  pixPhoneKeys: [],
  runtimeWindows: [],
  settings: {
    browserChannel: "chromium",
    autoRestoreSessions: true,
    autoClosePopupsDuringNavigation: false,
    showAccountInfoOverlay: false,
    postRegistrationDepositEnabled: true,
    customDepositAmounts: [],
    reducedMotion: false,
    themeMode: "light",
    exportDirectory: "",
    screenLayout: {
      monitorId: "primary",
      mode: "grid",
      columns: 4,
      rows: 1,
      gap: 8,
      margin: 8,
      customSlots: []
    },
    automationStartDelaySeconds: 20,
    domainBlockEnabled: true,
    blockedDomains: []
  },
  exports: [],
  license: {
    status: "unlicensed",
    operational: false,
    message: "Ative sua licenca para usar as operacoes do Spider BOT."
  }
};

const FALLBACK_APP_INFO: AppInfo = {
  name: "Spider BOT",
  version: "0.0.0",
  isPackaged: false,
  releaseUrl: "https://github.com/henocdejesusferreirafarias/spider-bot-releases/releases/latest"
};

const FALLBACK_UPDATE_STATUS: UpdateStatus = {
  phase: "disabled",
  currentVersion: FALLBACK_APP_INFO.version,
  message: "Atualizacoes automaticas ficam ativas no app instalado."
};

interface AutoProfileRunOptions {
  quantity: number;
  postRegistrationDepositEnabled: boolean;
  depositAmountMin: number;
  depositAmountMax: number;
  useCustomDeposits: boolean;
  customDepositAmounts?: CustomDepositAmountRecord[];
  captchaSolverEnabled: boolean;
  navigationMode: NavigationMode;
  homeUrl: string;
  homeUrls?: string[];
  proxyIds?: string[];
  automationStartDelaySeconds: number;
}

interface AutoProfileRunner {
  cancelled: boolean;
  launchedProfileIds: Set<string>;
}

interface AutoProfileLaunchJob {
  index: number;
  url: string;
}

interface AutoProfileRunState {
  running: boolean;
  stopping: boolean;
  requested: number;
  created: number;
  launched: number;
  automationStartDelaySeconds: number;
}

function createIdleAutoProfileRunState(delaySeconds = 20): AutoProfileRunState {
  return {
    running: false,
    stopping: false,
    requested: 0,
    created: 0,
    launched: 0,
    automationStartDelaySeconds: delaySeconds
  };
}

function normalizeUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function normalizeUrlOrDefault(value: string) {
  return normalizeUrl(value) || "https://example.com";
}

function buildNavigationPersona(navigationMode: NavigationMode): Partial<PersonaConfig> {
  const launchArgs = [
    ...defaultAutomationLaunchArgs,
    `${NAVIGATION_MODE_LAUNCH_ARG_PREFIX}${navigationMode}`
  ];

  if (navigationMode === "desktop") {
    return {
      userAgent: "",
      viewport: {
        width: 1440,
        height: 960,
        deviceScaleFactor: 1
      },
      launchArgs
    };
  }

  return {
    userAgent: "",
    viewport: {
      width: 390,
      height: 844,
      deviceScaleFactor: 2.75
    },
    launchArgs
  };
}

function isRuntimeProfileActive(profile: ProfileSummary) {
  return activeRuntimeStatuses.has(profile.status);
}

function randomIntInclusive(min: number, max: number): number {
  const safeMin = Math.trunc(Math.min(min, max));
  const safeMax = Math.trunc(Math.max(min, max));
  const span = safeMax - safeMin + 1;
  if (span <= 1) {
    return safeMin;
  }

  const cryptoApi = window.crypto;
  if (cryptoApi?.getRandomValues) {
    const maxUint = 0xffffffff;
    const bucketSize = Math.floor((maxUint + 1) / span);
    const limit = bucketSize * span;
    const buffer = new Uint32Array(1);
    do {
      cryptoApi.getRandomValues(buffer);
    } while ((buffer[0] ?? 0) >= limit);
    return safeMin + Math.floor((buffer[0] ?? 0) / bucketSize);
  }

  return safeMin + Math.floor(Math.random() * span);
}

function shuffleNumbers(values: number[]): number[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIntInclusive(0, index);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
}

function buildDepositAmountPlan(count: number, min: number, max: number): number[] {
  const total = Math.max(0, Math.trunc(count));
  const safeMin = Math.trunc(Math.min(min, max));
  const safeMax = Math.trunc(Math.max(min, max));
  const span = safeMax - safeMin + 1;
  if (total <= 0 || span <= 0) {
    return [];
  }
  if (span === 1) {
    return Array.from({ length: total }, () => safeMin);
  }

  const plan: number[] = [];
  if (span <= 5000) {
    const values = Array.from({ length: span }, (_, index) => safeMin + index);
    while (plan.length < total) {
      const cycle = shuffleNumbers(values);
      if (plan.length > 0 && cycle.length > 2 && Math.abs((cycle[0] ?? safeMin) - (plan.at(-1) ?? safeMin)) <= 1) {
        cycle.push(cycle.shift()!);
      }
      plan.push(...cycle.slice(0, total - plan.length));
    }
    return plan;
  }

  for (let index = 0; index < total; index += 1) {
    const bucketStart = safeMin + Math.floor((index * span) / total);
    const bucketEnd = safeMin + Math.floor(((index + 1) * span) / total) - 1;
    plan.push(randomIntInclusive(bucketStart, Math.max(bucketStart, Math.min(safeMax, bucketEnd))));
  }

  return shuffleNumbers(plan);
}

function buildCustomDepositAmountPlan(count: number, amounts: CustomDepositAmountRecord[]): string[] {
  const normalizedAmounts = amounts
    .map((entry) => entry.amount.trim().replace(",", "."))
    .filter((amount) => /^\d+(?:\.\d{1,2})?$/.test(amount) && Number(amount) > 0);

  if (count <= 0 || normalizedAmounts.length === 0) {
    return [];
  }

  return Array.from({ length: count }, (_, index) => normalizedAmounts[index % normalizedAmounts.length] ?? normalizedAmounts[0] ?? "");
}

function buildAutoProfileLaunchJobs(
  urls: string[],
  quantityPerLink: number
): AutoProfileLaunchJob[] {
  return urls.flatMap((url, linkIndex) =>
    Array.from({ length: quantityPerLink }, (_, sequenceIndex) => ({
      index: linkIndex * quantityPerLink + sequenceIndex,
      url
    }))
  );
}

export function usePredatorApp() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(FALLBACK_SNAPSHOT);
  const [appInfo, setAppInfo] = useState<AppInfo>(FALLBACK_APP_INFO);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(FALLBACK_UPDATE_STATUS);
  const [section, setSection] = useState<AppSection>("dashboard");
  const [search, setSearch] = useState("");
  const [selectedProfileIds, setSelectedProfileIds] = useState<Set<string>>(() => new Set());
  const [busyAction, setBusyAction] = useState<string>();
  const [importPath, setImportPath] = useState("");
  const [autoProfileRun, setAutoProfileRun] = useState<AutoProfileRunState>(createIdleAutoProfileRunState);
  const autoProfileRunRef = useRef<AutoProfileRunner | null>(null);
  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    void window.predator.app.info().then(setAppInfo).catch(() => undefined);
    void window.predator.updates.status().then(setUpdateStatus).catch(() => undefined);
    void window.predator.app.snapshot().then((next) => {
      setSnapshot(next);
      setSelectedProfileIds((current) => {
        if (current.size > 0) {
          const validIds = new Set(next.profiles.map((profile) => profile.id));
          for (const id of current) {
            if (!validIds.has(id)) current.delete(id);
          }
          return new Set(current);
        }
        return current;
      });
    });

    return window.predator.events.subscribe((event) => {
      if (event.type === "snapshot-updated" && event.payload) {
        const next = event.payload as unknown as AppSnapshot;
        setSnapshot(next);
        setSelectedProfileIds((current) => {
          if (current.size === 0) return current;
          const validIds = new Set(next.profiles.map((profile) => profile.id));
          const next2 = new Set<string>();
          for (const id of current) {
            if (validIds.has(id)) next2.add(id);
          }
          return next2;
        });
      }
      if (event.type === "update-status-changed" && event.payload) {
        setUpdateStatus(event.payload as unknown as UpdateStatus);
      }
    });
  }, []);

  const filteredProfiles = useMemo(() => {
    const term = deferredSearch.trim().toLowerCase();
    if (!term) {
      return snapshot.profiles;
    }

    return snapshot.profiles.filter((profile) =>
      [profile.name, profile.codeName, profile.notes, ...profile.tags]
        .join(" ")
        .toLowerCase()
        .includes(term)
    );
  }, [deferredSearch, snapshot.profiles]);

  const selectedProfile = useMemo(() => {
    for (const profile of snapshot.profiles) {
      if (selectedProfileIds.has(profile.id)) return profile;
    }
    return filteredProfiles[0] ?? snapshot.profiles[0];
  }, [filteredProfiles, selectedProfileIds, snapshot.profiles]);

  const mutate = async <T,>(key: string, operation: () => Promise<T>) => {
    setBusyAction(key);
    try {
      const result = await operation();
      const next = await window.predator.app.snapshot();
      setSnapshot(next);
      return result;
    } finally {
      setBusyAction(undefined);
    }
  };

  const stopRunnerProfiles = async (runner: AutoProfileRunner) => {
    const profileIds = Array.from(runner.launchedProfileIds);
    await Promise.allSettled(profileIds.map((profileId) => window.predator.profiles.stop(profileId)));
    setSnapshot(await window.predator.app.snapshot());
  };

  const stopActiveProfiles = async () => {
    setBusyAction("profiles:stop-active");
    try {
      const next = await window.predator.app.snapshot();
      const profileIds = next.profiles.filter(isRuntimeProfileActive).map((profile) => profile.id);

      await Promise.allSettled(profileIds.map((profileId) => window.predator.profiles.stop(profileId)));
      setSnapshot(await window.predator.app.snapshot());
    } finally {
      setBusyAction(undefined);
    }
  };

  const stopAutomaticProfileCreation = async () => {
    const runner = autoProfileRunRef.current;
    if (!runner) {
      await window.predator.automations.cancelBatch().catch(() => undefined);
      await stopActiveProfiles();
      return;
    }

    runner.cancelled = true;
    setAutoProfileRun((current) => ({
      ...current,
      running: true,
      stopping: true
    }));
    await window.predator.automations.cancelBatch().catch(() => undefined);
    await stopRunnerProfiles(runner);
  };

  const createProfilesAutomatically = async ({
    quantity,
    postRegistrationDepositEnabled,
    depositAmountMin,
    depositAmountMax,
    useCustomDeposits,
    customDepositAmounts,
    captchaSolverEnabled,
    navigationMode,
    homeUrl,
    homeUrls,
    proxyIds,
    automationStartDelaySeconds
  }: AutoProfileRunOptions) => {
    if (autoProfileRunRef.current) {
      return;
    }

    const quantityPerLink = Math.max(1, Math.min(50, Math.trunc(quantity)));
    const normalizedDepositMin = Math.max(1, Math.min(999999, Math.trunc(depositAmountMin) || 1));
    const normalizedDepositMax = Math.max(normalizedDepositMin, Math.min(999999, Math.trunc(depositAmountMax) || normalizedDepositMin));
    const targetUrls = (homeUrls?.length ? homeUrls : [homeUrl])
      .map(normalizeUrl)
      .filter(Boolean);
    const fallbackUrl = normalizeUrlOrDefault(homeUrl);
    const launchTargets = targetUrls.length ? targetUrls : [fallbackUrl];
    const launchJobs = buildAutoProfileLaunchJobs(launchTargets, quantityPerLink);
    const total = launchJobs.length;
    const customDepositAmountPlan = postRegistrationDepositEnabled && useCustomDeposits
      ? buildCustomDepositAmountPlan(total, customDepositAmounts ?? [])
      : [];
    const depositAmountPlan = postRegistrationDepositEnabled && useCustomDeposits && customDepositAmountPlan.length === 0
      ? buildDepositAmountPlan(total, normalizedDepositMin, normalizedDepositMax).map(String)
      : customDepositAmountPlan;
    const normalizedDelaySeconds = Math.max(
      MIN_AUTOMATION_START_DELAY_SECONDS,
      Math.min(
        MAX_AUTOMATION_START_DELAY_SECONDS,
        Math.round((Number(automationStartDelaySeconds) || 0) * 10) / 10
      )
    );

    // Iniciar varias sessoes com delay curto faz N navegadores carregarem SPAs pesadas ao
    // mesmo tempo -> contencao de CPU/GPU -> janelas "travam carregando" e a automacao
    // estoura o tempo de espera. Abaixo de 20s o risco e alto; avisamos antes de prosseguir.
    if (total > 1 && normalizedDelaySeconds < RECOMMENDED_MIN_START_DELAY_SECONDS) {
      const proceed = window.confirm(
        `Voce vai iniciar ${total} sessoes com um delay de ${normalizedDelaySeconds}s entre elas.\n\n` +
          `Delays abaixo de ${RECOMMENDED_MIN_START_DELAY_SECONDS}s podem sobrecarregar o computador e fazer paginas ` +
          `"travarem carregando", causando falhas na automacao.\n\n` +
          `Recomendado: ${RECOMMENDED_MIN_START_DELAY_SECONDS}s ou mais.\n\nDeseja iniciar mesmo assim?`
      );
      if (!proceed) {
        return undefined;
      }
    }

    if (proxyIds && proxyIds.length > 0) {
      const uniqueProxyIds = Array.from(new Set(proxyIds));
      const tested = await Promise.all(
        uniqueProxyIds.map((id) => window.predator.proxies.test(id).catch(() => null))
      );
      const hasHealthy = tested.some(
        (proxy) => proxy !== null && proxy.status === "healthy"
      );
      if (!hasHealthy) {
        window.alert(
          "Nenhum proxy está online no momento. Verifique a conexão dos proxies antes de iniciar a automação."
        );
        return undefined;
      }
    }

    const baseCount = snapshot.profiles.length;
    const runner: AutoProfileRunner = {
      cancelled: false,
      launchedProfileIds: new Set<string>()
    };
    const preparedJobs: Array<{ profileId: string; automationId: string }> = [];

    autoProfileRunRef.current = runner;
    setBusyAction("profiles:auto");
    setAutoProfileRun({
      running: true,
      stopping: false,
      requested: total,
      created: 0,
      launched: 0,
      automationStartDelaySeconds: normalizedDelaySeconds
    });

    try {
      // Fase 1: provisiona perfis + automacoes no banco (sequencial, rapido).
      for (const job of launchJobs) {
        if (runner.cancelled) {
          break;
        }

        const stamp = baseCount + job.index + 1;
        const targetUrl = job.url;
        const depositAmount = postRegistrationDepositEnabled && useCustomDeposits ? depositAmountPlan[job.index] : undefined;
        const proxyId = proxyIds && proxyIds.length > 0 ? proxyIds[job.index % proxyIds.length] : undefined;
        const created = await window.predator.profiles.create({
          name: `Auto Profile ${stamp}`,
          notes: depositAmount
            ? `Created by automatic factory for ${targetUrl}. Deposit target: ${depositAmount}.`
            : `Created by automatic factory for ${targetUrl}.`,
          homeUrl: targetUrl,
          tags: ["auto"],
          color: autoProfileColors[stamp % autoProfileColors.length] ?? "#d6d6d6",
          proxyId,
          persona: buildNavigationPersona(navigationMode)
        });

        const automation = await window.predator.automations.create({
          profileId: created.id,
          kind: ACCOUNT_REGISTRATION_KIND
        });
        await window.predator.automations.update(automation.id, {
          params: {
            ...automation.params,
            postRegistrationDepositEnabled: postRegistrationDepositEnabled ? "true" : "",
            depositAmount: depositAmount ? String(depositAmount) : "",
            // O range "Valores Para Deposito" (min/max) e sempre visivel na fabrica e
            // independente de "Usar personalizados". Gravamos SEMPRE -> senao, sem o
            // custom ligado, min/max iam vazios e resolveDepositAmount caia no 200 fixo.
            depositAmountMin: String(normalizedDepositMin),
            depositAmountMax: String(normalizedDepositMax),
            autoCaptchaSolverEnabled: captchaSolverEnabled ? "true" : ""
          }
        });

        preparedJobs.push({ profileId: created.id, automationId: automation.id });
        runner.launchedProfileIds.add(created.id);

        setAutoProfileRun((current) => ({
          ...current,
          created: Math.min(total, current.created + 1)
        }));
      }

      if (runner.cancelled || preparedJobs.length === 0) {
        return undefined;
      }

      await Promise.allSettled(
        preparedJobs.map((job) =>
          window.predator.profiles
            .launch(job.profileId, { triggerAutomation: false, deferNavigation: true })
            .then(() => {
              runner.launchedProfileIds.add(job.profileId);
              setAutoProfileRun((current) => ({
                ...current,
                launched: Math.min(total, current.launched + 1)
              }));
            })
            .catch(() => undefined)
        )
      );

      setSnapshot(await window.predator.app.snapshot());

      if (runner.cancelled) {
        return undefined;
      }

      // Fase 3: dispara as automacoes com o delay configurado entre cada.
      // O main process mostra a logo do sistema em fundo preto em cada janela
      // que estiver aguardando a sua vez e remove assim que a automacao inicia.
      await window.predator.automations
        .runBatch({
          automationIds: preparedJobs.map((job) => job.automationId),
          delaySeconds: normalizedDelaySeconds
        })
        .catch(() => undefined);

      return undefined;
    } finally {
      if (runner.cancelled) {
        await window.predator.automations.cancelBatch().catch(() => undefined);
        await stopRunnerProfiles(runner);
      } else {
        setSnapshot(await window.predator.app.snapshot());
      }

      if (autoProfileRunRef.current === runner) {
        autoProfileRunRef.current = null;
      }
      setBusyAction(undefined);
      setAutoProfileRun(createIdleAutoProfileRunState(normalizedDelaySeconds));
    }
  };

  const createProxy = async (input?: ProxyDraft) => {
    const stamp = snapshot.proxies.length + 1;
    await mutate("proxy:create", () =>
      window.predator.proxies.create(
        input ?? {
          label: `Proxy ${stamp}`,
          protocol: "http",
          host: "127.0.0.1",
          port: 8000 + stamp,
          notes: "Quick-created operational proxy."
        }
      )
    );
  };

  const createAutomation = async (input?: AutomationDraft) => {
    const targetProfile = input
      ? snapshot.profiles.find((profile) => profile.id === input.profileId)
      : selectedProfile;

    if (!targetProfile) {
      return;
    }

    await mutate("automation:create", () =>
      window.predator.automations.create(
        input ?? {
          profileId: targetProfile.id,
          kind: ACCOUNT_REGISTRATION_KIND
        }
      )
    );
  };

  return {
    snapshot,
    appInfo,
    updateStatus,
    section,
    search,
    deferredSearch,
    busyAction,
    autoProfileRun,
    importPath,
    filteredProfiles,
    selectedProfile,
    selectedProfileIds,
    setImportPath,
    setSearch: (value: string) => {
      startTransition(() => {
        setSearch(value);
      });
    },
    setSection: (nextSection: AppSection) => {
      startTransition(() => {
        setSection(nextSection);
      });
    },
    toggleProfileSelection: (profileId: string) => {
      setSelectedProfileIds((current) => {
        const next = new Set(current);
        if (next.has(profileId)) {
          next.delete(profileId);
        } else {
          next.add(profileId);
        }
        return next;
      });
    },
    setProfileSelection: (profileIds: string[], selectAll: boolean) => {
      setSelectedProfileIds((current) => {
        const next = new Set(current);
        if (selectAll) {
          for (const id of profileIds) next.add(id);
        } else {
          for (const id of profileIds) next.delete(id);
        }
        return next;
      });
    },
    clearProfileSelection: () => setSelectedProfileIds(new Set()),
    createProfilesAutomatically,
    stopAutomaticProfileCreation,
    createProxy,
    createAutomation,
    checkForUpdates: () => mutate("updates:check", () => window.predator.updates.check()).then(setUpdateStatus),
    installUpdate: () => mutate("updates:install", () => window.predator.updates.install()).then(setUpdateStatus),
    updateProfile: (profileId: string, draft: Partial<ProfileDraft>) =>
      mutate("profile:update", () => window.predator.profiles.update(profileId, draft)),
    deleteProfile: (profileId: string) => mutate("profile:delete", () => window.predator.profiles.delete(profileId)),
    duplicateProfile: (profileId: string) =>
      mutate("profile:duplicate", () => window.predator.profiles.duplicate(profileId)),
    launchProfile: (profileId: string) => mutate(`profile:launch:${profileId}`, () => window.predator.profiles.launch(profileId)),
    stopProfile: (profileId: string) => mutate(`profile:stop:${profileId}`, () => window.predator.profiles.stop(profileId)),
    bindProxy: (profileId: string, proxyId?: string) =>
      mutate("profile:bind-proxy", () => window.predator.profiles.bindProxy(profileId, proxyId)),
    importNative: (path: string) => mutate("profile:import", () => window.predator.profiles.importNative(path)),
    updateProxy: (proxyId: string, draft: Partial<ProxyDraft>) =>
      mutate("proxy:update", () => window.predator.proxies.update(proxyId, draft)),
    deleteProxy: (proxyId: string) => mutate("proxy:delete", () => window.predator.proxies.delete(proxyId)),
    testProxy: (proxyId: string) => mutate(`proxy:test:${proxyId}`, () => window.predator.proxies.test(proxyId)),
    runAutomation: (automationId: string) =>
      mutate(`automation:run:${automationId}`, () => window.predator.automations.runNow(automationId)),
    cancelRun: (runId: string) => mutate(`automation:cancel:${runId}`, () => window.predator.automations.cancel(runId)),
    updateAutomation: (automationId: string, draft: Partial<AutomationDraft>) =>
      mutate("automation:update", () => window.predator.automations.update(automationId, draft)),
    addPixPhoneKeys: (input: string) => mutate("pix-keys:add", () => window.predator.pixKeys.addPhoneNumbers(input)),
    updatePixPhoneKey: (pixKeyId: string, phoneNumber: string) =>
      mutate("pix-keys:update", () => window.predator.pixKeys.updatePhoneNumber(pixKeyId, phoneNumber)),
    deletePixPhoneKey: (pixKeyId: string) => mutate("pix-keys:delete", () => window.predator.pixKeys.delete(pixKeyId)),
    registerPixKey: (targetSelection: RuntimeControlTargetSelection) =>
      mutate("controls:register-pix-key", () =>
        window.predator.controls.registerPixKey({
          pixType: "PHONE",
          targetSelection
        })
      ),
    openWithdrawals: (targetSelection: RuntimeControlTargetSelection) =>
      mutate("controls:open-withdrawals", () =>
        window.predator.controls.openWithdrawals({
          targetSelection
        })
      ),
    updateSettings: (draft: Partial<AppSnapshot["settings"]>) =>
      mutate("settings:update", () => window.predator.settings.update(draft)),
    applyScreenLayout: () => mutate("screens:apply-layout", () => window.predator.screens.applyLayout()),
    previewScreenLayout: () =>
      mutate("screens:preview-layout", () => window.predator.screens.previewLayout()),
    activateLicense: (email: string, licenseKey: string) =>
      mutate("license:activate", () => window.predator.license.activate({ email, licenseKey })),
    revalidateLicense: () => mutate("license:revalidate", () => window.predator.license.revalidate()),
    clearLicense: () => mutate("license:clear", () => window.predator.license.clear()),
    clearActivity: () => mutate("activity:clear", () => window.predator.activity.clear()),
    clearRuns: () => mutate("runs:clear", () => window.predator.runs.clear())
  };
}

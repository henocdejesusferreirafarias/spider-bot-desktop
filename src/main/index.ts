import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, net, protocol, screen, shell, type IpcMainInvokeEvent, type Rectangle } from "electron";
import type {
  AppSnapshot,
  AppSettings,
  AutomationDraft,
  InstanceRecord,
  ManualDepositControlRequest,
  PixKeyRegistrationControlRequest,
  ProfileDraft,
  ProxyDraft,
  RuntimeControlNavigationAction,
  RuntimeControlSelectionState,
  RuntimeControlTargetSelection,
  RuntimeEvent,
  RuntimeStatus,
  ScreenDisplayInfo,
  WithdrawalPreparationControlRequest
} from "../shared/contracts.js";
import { AutomationRuntimeService } from "./services/automation-runtime.js";
import { BrowserRuntimeService, type LayoutPreviewResult } from "./services/browser-runtime.js";
import { PredatorDatabase } from "./services/database.js";
import { InstanceRegistry } from "./services/instance-registry.js";
import { LicenseService, normalizePemFromEnv } from "./services/license-service.js";
import {
  createPredatorGlobalPaths,
  createPredatorInstancePaths,
  loadDotEnv
} from "./services/paths.js";
import { SecureStore } from "./services/secure-store.js";
import { shouldEnableAutoUpdates, UpdateService } from "./services/update-service.js";

const loadedEnvFile = loadDotEnv();
if (loadedEnvFile) {
  console.log(`[predator] loaded env from ${loadedEnvFile}`);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rendererUrl = "http://127.0.0.1:5173";
const rendererProtocolScheme = "spiderbot";
const rendererBuildRoot = app.isPackaged
  ? join(process.resourcesPath, "dist-renderer")
  : join(__dirname, "../../dist-renderer");
const rendererBuildFile = join(rendererBuildRoot, "index.html");
protocol.registerSchemesAsPrivileged([
  {
    scheme: rendererProtocolScheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
]);
function getAppIcon(): string {
  if (app.isPackaged) return join(process.resourcesPath, "icon.png");
  return join(__dirname, "../../assets/icon.png");
}
const desktopReleaseUrl =
  process.env.PREDATOR_DESKTOP_RELEASE_URL ??
  "https://github.com/henocdejesusferreirafarias/spider-bot-releases/releases/latest";
const defaultLicenseApiUrl = "https://spiderbot.07corp.bio/";
const desktopAppVersion = resolveDesktopAppVersion();
const instanceWindowMinimumSize = {
  width: 920,
  height: 560
} as const;
const managerWindowMinimumSize = instanceWindowMinimumSize;
const cockpitWindowMinimumSize = {
  width: 760,
  height: 150
} as const;
const cockpitWindowPreferredSize = {
  width: 1100,
  height: 170
} as const;
const cockpitWindowMargin = 8;

interface InstanceSession {
  allowWindowClose: boolean;
  automationRuntime: AutomationRuntimeService;
  browserRuntime: BrowserRuntimeService;
  database: PredatorDatabase;
  cockpitMode: boolean;
  cockpitAlwaysOnTop: boolean;
  cockpitRestoreBounds?: Rectangle;
  id: string;
  recentRuntimeLogs: Map<string, { at: number; message: string; status: string }>;
  /**
   * True enquanto o cleanup de stopInstance esta em andamento. Renomeado de
   * `stopping` para deixar claro que cobre tambem o caso de cleanup parcial
   * em janela em estado de erro (nao apenas o estado "iniciando parada").
   */
  cleanupStarted: boolean;
  window: BrowserWindow;
}

interface ActiveAutomationBatch {
  splashTimerHandles: Set<ReturnType<typeof setTimeout>>;
  runAbortController: AbortController;
}

let managerWindow: BrowserWindow | null = null;
let openManagerWindow: (() => Promise<void>) | undefined;
let shuttingDown = false;

// Janelas-fantasma da pre-visualizacao de layout: molduras transparentes nas posicoes/tamanhos exatos
// onde os navegadores abririam. Estado global (a previa cobre o monitor, independe da instancia que
// disparou). Auto-some apos PREVIEW_AUTO_DISMISS_MS; chamar de novo enquanto visivel alterna (fecha).
let layoutPreviewWindows: BrowserWindow[] = [];
let layoutPreviewTimer: ReturnType<typeof setTimeout> | null = null;
const PREVIEW_AUTO_DISMISS_MS = 6000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function closeLayoutPreview(): void {
  if (layoutPreviewTimer) {
    clearTimeout(layoutPreviewTimer);
    layoutPreviewTimer = null;
  }
  for (const window of layoutPreviewWindows) {
    if (!window.isDestroyed()) {
      window.close();
    }
  }
  layoutPreviewWindows = [];
}

function buildLayoutPreviewHtml(
  label: string,
  width: number,
  height: number,
  scalePercent: number,
  overlaps: boolean,
  cutOff: boolean
): string {
  const numberSize = Math.max(16, Math.min(160, Math.round(Math.min(width, height) * 0.38)));
  // Âmbar quando a escala saturou no piso e a janela invade a vizinha; teal quando cabe certinho.
  const accent = overlaps ? "#ffb454" : "#36f5c8";
  const accentSoft = overlaps ? "#ffd9a0" : "#9febdb";
  const accentRgb = overlaps ? "255,180,84" : "54,245,200";
  const flags = `${overlaps ? " · ⚠ SOBREPÕE" : ""}${cutOff ? " · ✂ CORTADA" : ""}`;
  const tag = `TELA ${label} · ${width}×${height} · ${scalePercent}%${flags}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;overflow:hidden;background:transparent;
      font-family:'Segoe UI',system-ui,sans-serif;-webkit-user-select:none;cursor:default}
    .frame{box-sizing:border-box;height:100vh;width:100vw;border:3px solid ${accent};border-radius:10px;
      background:rgba(8,12,16,${overlaps ? "0.30" : "0.40"});display:flex;align-items:center;justify-content:center;
      position:relative;box-shadow:inset 0 0 24px rgba(${accentRgb},0.25)}
    .tag{position:absolute;top:8px;left:11px;font-size:12px;letter-spacing:.10em;color:${accentSoft};opacity:.9;
      text-shadow:0 1px 3px rgba(0,0,0,.8)}
    .num{font-size:${numberSize}px;font-weight:800;color:${accent};opacity:.92;
      text-shadow:0 0 14px rgba(${accentRgb},.65)}
  </style></head><body>
    <div class="frame"><span class="tag">${tag}</span><span class="num">${label}</span></div>
  </body></html>`;
}

// Abre as molduras-fantasma da pre-visualizacao. Toggle: se ja houver previa na tela, fecha e retorna 0.
function showLayoutPreview(preview: LayoutPreviewResult): number {
  if (layoutPreviewWindows.length > 0) {
    closeLayoutPreview();
    return 0;
  }

  for (const slot of preview.slots) {
    const width = Math.max(1, Math.round(slot.width));
    const height = Math.max(1, Math.round(slot.height));
    const window = new BrowserWindow({
      x: Math.round(slot.x),
      y: Math.round(slot.y),
      width,
      height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      alwaysOnTop: true,
      backgroundColor: "#00000000",
      webPreferences: { contextIsolation: true, sandbox: true }
    });
    window.setAlwaysOnTop(true, "screen-saver");
    window.setIgnoreMouseEvents(true);
    const html = buildLayoutPreviewHtml(
      slot.label,
      width,
      height,
      Math.round(slot.scale * 100),
      slot.overlaps,
      slot.cutOff
    );
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) {
        window.showInactive();
      }
    });
    layoutPreviewWindows.push(window);
  }

  layoutPreviewTimer = setTimeout(() => closeLayoutPreview(), PREVIEW_AUTO_DISMISS_MS);
  return layoutPreviewWindows.length;
}

app.on("before-quit", () => closeLayoutPreview());

function resolveDesktopAppVersion(): string {
  const envVersion = process.env.npm_package_version?.trim();
  if (envVersion) {
    return envVersion;
  }

  const packageJsonPath = join(__dirname, "../../package.json");
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // In packaged builds Electron should provide the application version.
  }

  return app.getVersion();
}

async function waitForRendererDevServer(url: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal
      });

      if (response.ok) {
        return true;
      }
    } catch {
      // Vite may have opened the TCP port before the app shell is available.
    } finally {
      clearTimeout(timeout);
    }

    await sleep(250);
  }

  return false;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeStartupDiagnostic(context: string, error: unknown): void {
  try {
    const logDir = join(predatorUserDataPath, "predator");
    mkdirSync(logDir, { recursive: true });
    const lines = [
      `[${new Date().toISOString()}] ${context}`,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
      ""
    ];
    appendFileSync(join(logDir, "startup-errors.log"), `${lines.join("\n")}\n`, "utf-8");
  } catch {
    // Last-resort diagnostics must never become the startup failure.
  }
}

function safeConsoleError(message: string, error: unknown): void {
  try {
    console.error(message, error);
  } catch {
    // On Windows GUI builds, a broken stderr pipe can throw EPIPE and hide the
    // original startup error. The file diagnostic above remains the source of truth.
  }
}

// Erros que NAO devem derrubar o processo principal. O caso central e a
// `ERR_INTERNAL_ASSERTION` que o cliente HTTP do Node lanca de forma assincrona
// (via setImmediate) ao reusar/encerrar um socket entregue pela lib `socks` quando
// o proxy-chain encaminha uma requisicao HTTP simples por um upstream SOCKS5.
// Por ser assincrona, ela escapa de qualquer try/catch ao redor do tunel e so
// pode ser contida aqui. Conter mantem o app e os demais perfis vivos; um proxy
// ruim deixa de matar a aplicacao inteira. Vale para http/https/socks5 igualmente,
// pois todos passam pelo mesmo tunel local.
function isContainableRuntimeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code ?? "";
  const haystack = `${error.stack ?? ""}\n${error.message ?? ""}`;

  if (
    code === "ERR_INTERNAL_ASSERTION" &&
    (/socksclient/i.test(haystack) || /_http_client/.test(haystack))
  ) {
    return true;
  }

  // Erros de socket transitorios de proxy/rede: nunca devem ser fatais.
  const transientCodes = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "EPIPE",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ERR_STREAM_WRITE_AFTER_END",
    "ERR_STREAM_DESTROYED",
    "ERR_SOCKET_CLOSED"
  ]);
  if (transientCodes.has(code)) {
    return true;
  }

  // proxy-chain/socks tambem emitem erros so com mensagem (sem `code`).
  if (/socksclient|proxy-chain|socket hang up/i.test(haystack)) {
    return true;
  }

  return false;
}

let processSafetyNetInstalled = false;
function installProcessSafetyNet(): void {
  if (processSafetyNetInstalled) {
    return;
  }
  processSafetyNetInstalled = true;
  console.log("[predator] safety-net de processo instalado (proxy/socks contidos)");

  process.on("uncaughtException", (error) => {
    writeStartupDiagnostic("uncaughtException", error);
    if (isContainableRuntimeError(error)) {
      safeConsoleError("[predator] erro de proxy/rede contido (app segue ativo)", error);
      return;
    }
    safeConsoleError("[predator] uncaughtException nao tratada", error);
    try {
      dialog.showErrorBox(
        "Spider BOT",
        `Ocorreu um erro inesperado:\n\n${error instanceof Error ? error.stack ?? error.message : String(error)}`
      );
    } catch {
      // Mostrar o dialogo nunca pode virar a falha final.
    }
  });

  process.on("unhandledRejection", (reason) => {
    writeStartupDiagnostic("unhandledRejection", reason);
    if (isContainableRuntimeError(reason)) {
      safeConsoleError("[predator] rejeicao de proxy/rede contida (app segue ativo)", reason);
      return;
    }
    safeConsoleError("[predator] unhandledRejection nao tratada", reason);
  });
}

function registerRendererProtocol(): void {
  protocol.handle(rendererProtocolScheme, (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("Invalid renderer URL.", { status: 400 });
    }

    const requestedPath = decodeURIComponent(url.pathname || "/index.html").replace(/^\/+/, "");
    const filePath = resolve(rendererBuildRoot, requestedPath || "index.html");
    const relativePath = relative(rendererBuildRoot, filePath);
    if (relativePath.startsWith("..") || relativePath.includes("..\\")) {
      return new Response("Renderer asset outside build root.", { status: 403 });
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });
}

function buildRendererProtocolUrl(query: Record<string, string>): string {
  const url = new URL(`${rendererProtocolScheme}://renderer/index.html`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function refocusRenderer(window: BrowserWindow): void {
  if (window.isDestroyed() || window.isMinimized()) {
    return;
  }

  window.webContents.focus();
}

function installRendererFocusRecovery(window: BrowserWindow): void {
  const scheduleRefocus = () => {
    setTimeout(() => refocusRenderer(window), 0);
  };

  window.on("focus", scheduleRefocus);
  window.on("restore", scheduleRefocus);
  window.on("show", scheduleRefocus);
}

// Keep the original storage location so renamed builds can still read Electron
// safeStorage data. App workspaces now live below userData/predator/instances.
const predatorUserDataPath = join(app.getPath("appData"), "Predator");
// Registrado o quanto antes: contem assercoes assincronas de socks/http_client
// (proxy SOCKS5 via proxy-chain) que, sem handler, exibem o dialogo fatal do
// Electron e matam o app inteiro ao abrir/automatizar um perfil.
installProcessSafetyNet();
const predatorLocalAppDataPath = process.env.LOCALAPPDATA || app.getPath("appData");
const predatorSessionDataPath = join(predatorLocalAppDataPath, "Predator", "session");
const predatorDiskCachePath = join(predatorSessionDataPath, "Cache");
const predatorGpuCachePath = join(predatorSessionDataPath, "GPUCache");

mkdirSync(predatorUserDataPath, { recursive: true });
mkdirSync(predatorDiskCachePath, { recursive: true });
mkdirSync(predatorGpuCachePath, { recursive: true });

app.setPath("userData", predatorUserDataPath);
app.setPath("sessionData", predatorSessionDataPath);
app.commandLine.appendSwitch("disk-cache-dir", predatorDiskCachePath);
app.commandLine.appendSwitch("gpu-disk-cache-dir", predatorGpuCachePath);
app.setName("Spider BOT");

async function bootstrap(): Promise<void> {
  const globalPaths = createPredatorGlobalPaths();
  const secureStore = new SecureStore({ allowPlaintext: !app.isPackaged });
  const registry = new InstanceRegistry(globalPaths);
  const instanceSessions = new Map<string, InstanceSession>();
  const windowInstanceIds = new Map<number, string>();
  const activeAutomationBatches = new Map<string, ActiveAutomationBatch>();

  const licenseService = new LicenseService(globalPaths, secureStore, {
    apiBaseUrl: process.env.PREDATOR_LICENSE_API_URL ?? defaultLicenseApiUrl,
    appVersion: desktopAppVersion,
    developmentPublicKeyPem: app.isPackaged
      ? undefined
      : normalizePemFromEnv(process.env.PREDATOR_LICENSE_PUBLIC_KEY),
    // Fail-closed: em producao (empacotado) exige o nucleo nativo (Frente C);
    // em dev permite fallback JS para nao travar o desenvolvimento.
    requireNativeCore: app.isPackaged
  });
  await licenseService.initialize();

  // Frente B: script do popup-killer servido (cifrado por device). Buscado quando
  // a licença está operacional e empurrado aos runtimes; se o fetch falhar, a
  // varredura fica desligada, sem fallback do conteúdo no binário.
  let servedPopupScript: string | null = null;
  const refreshServedPayloads = async () => {
    if (!licenseService.getState().operational) {
      return;
    }
    try {
      const script = await licenseService.fetchPayload("popup-killer");
      servedPopupScript = script;
      for (const session of instanceSessions.values()) {
        session.browserRuntime.setServedPopupSweepScript(script);
      }
    } catch {
      // Recurso servido indisponível (offline/sem suporte) — mantém desligado.
    }
  };
  void refreshServedPayloads();

  const broadcastAll = (event: RuntimeEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send("predator:event", event);
      }
    }
  };

  const summarizeSnapshot = (snapshot: Pick<AppSnapshot, "profiles" | "proxies" | "pixPhoneKeys">) => ({
    profileCount: snapshot.profiles.length,
    proxyCount: snapshot.proxies.length,
    pixPhoneKeyCount: snapshot.pixPhoneKeys.length
  });

  const listInstances = (): InstanceRecord[] =>
    registry.listInstances().map((instance) => {
      const session = instanceSessions.get(instance.id);
      if (!session) {
        return {
          ...instance,
          status: "stopped"
        };
      }

      const snapshot = {
        ...session.database.getSnapshot(),
        license: licenseService.getState()
      };

      return {
        ...instance,
        ...summarizeSnapshot(snapshot),
        status: "running"
      };
    });

  const broadcastInstancesUpdated = () => {
    broadcastAll({
      type: "instances-updated",
      payload: {
        instances: listInstances()
      }
    });
  };

  const broadcastLicenseStatus = () => {
    broadcastAll({
      type: "license-status-changed",
      payload: licenseService.getState() as unknown as Record<string, unknown>
    });
  };

  const getSnapshot = (session: InstanceSession): AppSnapshot => {
    const databaseSnapshot = session.database.getSnapshot();
    return {
      ...databaseSnapshot,
      runtimeWindows: session.browserRuntime.getRuntimeWindowTargets(databaseSnapshot.profiles),
      license: licenseService.getState()
    };
  };

  const broadcastToSession = (session: InstanceSession, event: RuntimeEvent) => {
    if (!session.window.isDestroyed()) {
      session.window.webContents.send("predator:event", event);
    }
  };

  const pushSnapshot = (session: InstanceSession) => {
    broadcastToSession(session, {
      type: "snapshot-updated",
      payload: getSnapshot(session) as unknown as Record<string, unknown>
    });
  };

  const pushAllSnapshots = () => {
    for (const session of instanceSessions.values()) {
      pushSnapshot(session);
    }
  };

  const requireLicense = () => {
    licenseService.ensureOperational();
  };

  const requireTargetSelection = (
    selection: RuntimeControlSelectionState
  ): RuntimeControlTargetSelection => {
    if (selection.mode === "none") {
      throw new Error(selection.reason || "Selecao de janelas invalida.");
    }
    return selection;
  };

  const describeTargetSelection = (selection: RuntimeControlTargetSelection): string =>
    selection.mode === "all"
      ? "todas"
      : selection.windows
          .map((windowRef) => windowRef.slotNumber)
          .sort((left, right) => left - right)
          .join(", ");

  const getRuntimeTargetsForSelection = (
    session: InstanceSession,
    selection: RuntimeControlTargetSelection
  ) => session.browserRuntime.resolveRuntimeWindowTargets(selection, session.database.listProfiles());

  const ensureNoAutomationConflict = (
    session: InstanceSession,
    selection: RuntimeControlTargetSelection,
    actionLabel: string
  ) => {
    const blocked = getRuntimeTargetsForSelection(session, selection).filter((target) => target.automationActive);
    if (blocked.length > 0) {
      throw new Error(
        `${actionLabel} bloqueado: ${blocked
          .map((target) => `Tela ${target.slotNumber} (${target.profileName})`)
          .join(", ")} em automacao ativa.`
      );
    }
  };

  const buildSpeedTargetSelection = (
    session: InstanceSession,
    selection: RuntimeControlTargetSelection
  ): RuntimeControlTargetSelection => {
    const targets = getRuntimeTargetsForSelection(session, selection);
    const allowed = targets.filter((target) => !target.automationActive);
    if (allowed.length === 0) {
      throw new Error("Speed Time bloqueado: todas as janelas alvo estao em automacao ativa.");
    }
    if (selection.mode === "all" && allowed.length === targets.length) {
      return selection;
    }
    return {
      mode: "windows",
      windows: allowed.map((target) => ({
        profileId: target.profileId,
        slotNumber: target.slotNumber
      }))
    };
  };

  const updateService = new UpdateService({
    currentVersion: desktopAppVersion,
    enabled: shouldEnableAutoUpdates(app.isPackaged),
    onStatusChange: (status) => {
      broadcastAll({
        type: "update-status-changed",
        payload: status as unknown as Record<string, unknown>
      });
    }
  });

  const bringInstanceAboveLaunchedBrowsers = (session: InstanceSession) => {
    if (session.window.isDestroyed()) {
      return;
    }

    session.window.setAlwaysOnTop(true);
    session.window.moveTop();
    setTimeout(() => {
      if (!session.window.isDestroyed()) {
        session.window.setAlwaysOnTop(false);
        refocusRenderer(session.window);
      }
    }, 900);
  };

  const handleRuntimeStatus = (
    session: InstanceSession,
    profileId: string,
    status: RuntimeStatus,
    detail?: string
  ) => {
    const profileExists = session.database.profileExists(profileId);
    if (profileExists) {
      session.database.updateProfileStatus(profileId, status);
    }
    const level = status === "error" ? "error" : status === "active" ? "success" : "info";
    const message = detail ?? `Navegador mudou para ${status}.`;
    const nowMs = Date.now();
    const recent = session.recentRuntimeLogs.get(profileId);
    const repeated = recent?.status === status && recent.message === message && nowMs - recent.at < 1200;

    session.recentRuntimeLogs.set(profileId, {
      at: nowMs,
      message,
      status
    });

    if (!repeated) {
      session.database.logActivity({
        id: crypto.randomUUID(),
        scope: "runtime",
        scopeId: profileId,
        level,
        message,
        details: {
          status
        },
        createdAt: new Date().toISOString()
      });
    }
    if (profileExists) {
      broadcastToSession(session, {
        type: "profile-status-changed",
        payload: {
          profileId,
          status,
          detail
        }
      });
    }
    pushSnapshot(session);
    broadcastInstancesUpdated();
    if (status === "active") {
      bringInstanceAboveLaunchedBrowsers(session);
    }
  };

  const logRuntimePreparation = (
    session: InstanceSession,
    level: "info" | "success" | "error",
    message: string
  ) => {
    session.database.logActivity({
      id: crypto.randomUUID(),
      scope: "runtime",
      level,
      message,
      createdAt: new Date().toISOString()
    });
    pushSnapshot(session);
  };

  const startBrowserRuntimePreparation = (session: InstanceSession) => {
    logRuntimePreparation(session, "info", "Verificando Chromium padrao...");
    void session.browserRuntime.ensureBrowserRuntime((message) => {
      logRuntimePreparation(session, "info", message);
    }).then(
      () => {
        logRuntimePreparation(session, "success", "Chromium padrao pronto para abrir perfis.");
      },
      (error) => {
        logRuntimePreparation(
          session,
          "error",
          error instanceof Error ? error.message : "Nao foi possivel preparar o Chromium padrao."
        );
      }
    );
  };

  const listDisplays = (): ScreenDisplayInfo[] => {
    const primaryId = String(screen.getPrimaryDisplay().id);
    return screen.getAllDisplays().map((display, index) => ({
      id: String(display.id),
      label: `M${index + 1}: ${display.workArea.width}x${display.workArea.height}`,
      primary: String(display.id) === primaryId,
      scaleFactor: display.scaleFactor,
      bounds: display.bounds,
      workArea: display.workArea
    }));
  };

  const getCockpitBounds = (window: BrowserWindow): Rectangle => {
    const display = screen.getDisplayMatching(window.getBounds());
    const { workArea } = display;
    const availableWidth = Math.max(320, workArea.width - cockpitWindowMargin * 2);
    const availableHeight = Math.max(180, workArea.height - cockpitWindowMargin * 2);
    const width = Math.min(cockpitWindowPreferredSize.width, availableWidth);
    const height = Math.min(cockpitWindowPreferredSize.height, availableHeight);

    return {
      x: workArea.x + Math.round((workArea.width - width) / 2),
      y: workArea.y + workArea.height - height - cockpitWindowMargin,
      width,
      height
    };
  };

  const setSessionCockpitMode = (session: InstanceSession, enabled: boolean) => {
    const window = session.window;
    if (window.isDestroyed()) {
      return {
        cockpit: false,
        alwaysOnTop: false
      };
    }

    if (enabled) {
      if (!session.cockpitMode) {
        session.cockpitRestoreBounds = window.getBounds();
        session.cockpitAlwaysOnTop = true;
      }

      if (window.isMinimized()) {
        window.restore();
      }

      session.cockpitMode = true;
      const cockpitBounds = getCockpitBounds(window);
      window.setMinimumSize(
        Math.min(cockpitWindowMinimumSize.width, cockpitBounds.width),
        Math.min(cockpitWindowMinimumSize.height, cockpitBounds.height)
      );
      window.setResizable(false);
      window.setMovable(true);
      window.setMaximizable(false);
      window.setFullScreenable(false);
      window.setAlwaysOnTop(session.cockpitAlwaysOnTop, "floating");
      window.setBounds(cockpitBounds, false);
      window.moveTop();
      refocusRenderer(window);
      return {
        cockpit: true,
        alwaysOnTop: session.cockpitAlwaysOnTop
      };
    }

    if (session.cockpitMode) {
      session.cockpitMode = false;
      session.cockpitAlwaysOnTop = true;
      const restoreBounds = session.cockpitRestoreBounds;
      session.cockpitRestoreBounds = undefined;
      window.setAlwaysOnTop(false);
      window.setMovable(true);
      window.setResizable(true);
      window.setMinimumSize(instanceWindowMinimumSize.width, instanceWindowMinimumSize.height);
      if (restoreBounds) {
        window.setBounds(restoreBounds, false);
      }
      refocusRenderer(window);
    }

    return {
      cockpit: false,
      alwaysOnTop: false
    };
  };

  const setSessionCockpitAlwaysOnTop = (session: InstanceSession, enabled: boolean) => {
    const window = session.window;
    if (window.isDestroyed()) {
      return {
        cockpit: Boolean(session.cockpitMode),
        alwaysOnTop: false
      };
    }

    session.cockpitAlwaysOnTop = Boolean(enabled);
    if (session.cockpitMode) {
      window.setAlwaysOnTop(session.cockpitAlwaysOnTop, "floating");
    }

    return {
      cockpit: session.cockpitMode,
      alwaysOnTop: session.cockpitAlwaysOnTop
    };
  };

  const loadRenderer = async (window: BrowserWindow, query: Record<string, string>) => {
    const devUrl = new URL(rendererUrl);
    const packagedUrl = buildRendererProtocolUrl(query);
    for (const [key, value] of Object.entries(query)) {
      devUrl.searchParams.set(key, value);
    }

    if (!app.isPackaged) {
      const rendererReady = await waitForRendererDevServer(rendererUrl);

      if (rendererReady) {
        try {
          await window.loadURL(devUrl.toString());
          return;
        } catch (error) {
          if (existsSync(rendererBuildFile)) {
            console.warn(`Renderer dev server load failed, falling back to built renderer: ${describeError(error)}`);
            await window.loadURL(packagedUrl);
            return;
          }
          throw new Error(`Renderer dev server failed to load: ${describeError(error)}`);
        }
      }

      if (existsSync(rendererBuildFile)) {
        console.warn("Renderer dev server did not respond in time; falling back to built renderer.");
        await window.loadURL(packagedUrl);
        return;
      }

      throw new Error(`Renderer dev server did not respond at ${rendererUrl} and no built renderer was found.`);
    }

    await window.loadURL(packagedUrl);
  };

  const createManagerWindow = async () => {
    if (managerWindow && !managerWindow.isDestroyed()) {
      managerWindow.focus();
      refocusRenderer(managerWindow);
      return;
    }

    const window = new BrowserWindow({
      width: managerWindowMinimumSize.width,
      height: managerWindowMinimumSize.height,
      minWidth: managerWindowMinimumSize.width,
      minHeight: managerWindowMinimumSize.height,
      backgroundColor: "#0a0a0a",
      icon: getAppIcon(),
      frame: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        sandbox: false
      }
    });

    managerWindow = window;
    installRendererFocusRecovery(window);
    window.on("close", (event) => {
      if (shuttingDown || instanceSessions.size === 0) {
        return;
      }

      const result = dialog.showMessageBoxSync(window, {
        type: "warning",
        buttons: ["Cancelar", "Fechar tudo"],
        defaultId: 0,
        cancelId: 0,
        title: "Fechar Spider BOT",
        message: "Existem instancias abertas.",
        detail: "Fechar o gerenciador tambem vai parar todas as instancias e navegadores abertos."
      });

      if (result !== 1) {
        event.preventDefault();
        refocusRenderer(window);
        return;
      }

      event.preventDefault();
      shuttingDown = true;
      void stopAllInstances().finally(() => {
        if (!window.isDestroyed()) {
          window.close();
        }
        app.quit();
      });
    });
    window.on("closed", () => {
      if (managerWindow === window) {
        managerWindow = null;
      }
    });

    await loadRenderer(window, { window: "manager" });
  };

  const getInstanceSessionForEvent = (event: IpcMainInvokeEvent): InstanceSession => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const instanceId = window ? windowInstanceIds.get(window.id) : undefined;
    const session = instanceId ? instanceSessions.get(instanceId) : undefined;

    if (!session) {
      throw new Error("Esta acao so esta disponivel dentro de uma instancia aberta.");
    }

    return session;
  };

  const stopInstance = async (instanceId: string): Promise<InstanceRecord | undefined> => {
    const session = instanceSessions.get(instanceId);
    if (!session) {
      const stopped = registry.markStopped(instanceId);
      broadcastInstancesUpdated();
      return stopped ? listInstances().find((instance) => instance.id === instanceId) : undefined;
    }

    const pendingBatch = activeAutomationBatches.get(instanceId);
    if (pendingBatch) {
      pendingBatch.runAbortController.abort();
      for (const handle of pendingBatch.splashTimerHandles) {
        clearTimeout(handle);
      }
      pendingBatch.splashTimerHandles.clear();
      activeAutomationBatches.delete(instanceId);
    }

    // Encerramento em duas fases:
    //  1) cleanupLogico: para runtime/automation/browser/database. Cada await
    //     tem catch individual para que um erro em uma camada NAO impeca a
    //     próxima (ex.: automationRuntime travado em janela com erro NAO
    //     deve impedir o browser de fechar).
    //  2) cleanupFisico (sempre via finally): fecha a janela do Electron e
    //     remove a sessão dos mapas, mesmo que o cleanup logico tenha
    //     falhado parcialmente. Sem isso, uma sessão parcialmente
    //     encerrada ficava órfã (stopping=true, instanceSessions ainda
    //     contendo, window aberta) e o stop geral subsequente caia no
    //     early-return do flag stopping sem fechar o navegador.
    if (session.cleanupStarted) {
      return listInstances().find((instance) => instance.id === instanceId);
    }
    session.cleanupStarted = true;

    try {
      try {
        await session.automationRuntime.shutdown();
      } catch (cleanupError) {
        try { console.warn(`[stopInstance ${instanceId}] automationRuntime.shutdown falhou:`, cleanupError); } catch {}
      }

      try {
        await session.browserRuntime.shutdown();
      } catch (cleanupError) {
        try { console.warn(`[stopInstance ${instanceId}] browserRuntime.shutdown falhou:`, cleanupError); } catch {}
      }

      try {
        session.database.close();
      } catch (cleanupError) {
        try { console.warn(`[stopInstance ${instanceId}] database.close falhou:`, cleanupError); } catch {}
      }
    } finally {
      instanceSessions.delete(instanceId);
      if (session.window && !session.window.isDestroyed()) {
        try { windowInstanceIds.delete(session.window.id); } catch {}
      }
      try { registry.markStopped(instanceId); } catch {}

      if (session.window && !session.window.isDestroyed()) {
        session.allowWindowClose = true;
        try { session.window.close(); } catch {}
      }
    }

    broadcastInstancesUpdated();
    return listInstances().find((instance) => instance.id === instanceId);
  };

  const stopAllInstances = async () => {
    const instanceIds = [...instanceSessions.keys()];
    await Promise.allSettled(instanceIds.map((instanceId) => stopInstance(instanceId)));
  };

  let licenseStateQueue = Promise.resolve();
  const applyLicenseOperation = <T extends { operational: boolean }>(
    operation: () => Promise<T> | T
  ): Promise<T> => {
    const queued = licenseStateQueue.then(async () => {
      const wasOperational = licenseService.getState().operational;
      const state = await operation();
      if (wasOperational && !state.operational) {
        servedPopupScript = null;
        for (const session of instanceSessions.values()) {
          session.browserRuntime.setServedPopupSweepScript(null);
        }
        await stopAllInstances();
      }
      pushAllSnapshots();
      broadcastLicenseStatus();
      return state;
    });
    licenseStateQueue = queued.then(() => undefined, () => undefined);
    return queued;
  };

  const openInstance = async (instanceId: string): Promise<InstanceRecord> => {
    const existing = instanceSessions.get(instanceId);
    if (existing) {
      if (!existing.window.isDestroyed()) {
        existing.window.focus();
        refocusRenderer(existing.window);
      }
      return listInstances().find((instance) => instance.id === instanceId) ?? registry.getInstance(instanceId);
    }

    const instance = registry.markOpened(instanceId);
    const paths = createPredatorInstancePaths(globalPaths, instance.id);
    const database = new PredatorDatabase(paths, secureStore);
    const window = new BrowserWindow({
      width: instanceWindowMinimumSize.width,
      height: instanceWindowMinimumSize.height,
      minWidth: instanceWindowMinimumSize.width,
      minHeight: instanceWindowMinimumSize.height,
      backgroundColor: "#0a0a0a",
      icon: getAppIcon(),
      frame: false,
      autoHideMenuBar: true,
      maximizable: false,
      fullscreenable: false,
      title: `${instance.name} - Spider BOT`,
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        sandbox: false
      }
    });
    installRendererFocusRecovery(window);
    let session: InstanceSession | undefined;
    const browserRuntime = new BrowserRuntimeService((profileId, status, detail) => {
      if (session) {
        handleRuntimeStatus(session, profileId, status, detail);
      }
    });
    const automationRuntime = new AutomationRuntimeService(
      database,
      browserRuntime,
      (event) => {
        if (session) {
          broadcastToSession(session, event);
          pushSnapshot(session);
          broadcastInstancesUpdated();
        }
      },
      requireLicense
    );
    session = {
      allowWindowClose: false,
      automationRuntime,
      browserRuntime,
      cockpitMode: false,
      cockpitAlwaysOnTop: true,
      database,
      id: instance.id,
      recentRuntimeLogs: new Map(),
      cleanupStarted: false,
      window
    };

    instanceSessions.set(instance.id, session);
    windowInstanceIds.set(window.id, instance.id);
    // Frente B: aplica o script servido já buscado a este novo runtime.
    browserRuntime.setServedPopupSweepScript(servedPopupScript);

    window.on("close", (event) => {
      if (session.allowWindowClose || shuttingDown) {
        return;
      }

      event.preventDefault();
      void stopInstance(instance.id);
    });
    window.on("closed", () => {
      if (instanceSessions.get(instance.id) === session) {
        void stopInstance(instance.id);
      }
    });

    try {
      await loadRenderer(window, {
        window: "instance",
        instanceId: instance.id
      });
    } catch (error) {
      instanceSessions.delete(instance.id);
      windowInstanceIds.delete(window.id);
      database.close();
      registry.markStopped(instance.id);
      if (!window.isDestroyed()) {
        session.allowWindowClose = true;
        window.close();
      }
      broadcastInstancesUpdated();
      throw error;
    }
    startBrowserRuntimePreparation(session);
    broadcastInstancesUpdated();
    return listInstances().find((entry) => entry.id === instance.id) ?? instance;
  };

  ipcMain.handle("app:context", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const instanceId = window ? windowInstanceIds.get(window.id) : undefined;
    if (!instanceId) {
      return {
        kind: "manager"
      };
    }

    return {
      kind: "instance",
      instance: listInstances().find((instance) => instance.id === instanceId) ?? registry.getInstance(instanceId)
    };
  });
  ipcMain.handle("app:info", () => ({
    name: app.getName(),
    version: desktopAppVersion,
    isPackaged: app.isPackaged,
    releaseUrl: desktopReleaseUrl
  }));
  ipcMain.handle("app:snapshot", (event) => getSnapshot(getInstanceSessionForEvent(event)));
  ipcMain.handle("app:get-window-mode", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const instanceId = window ? windowInstanceIds.get(window.id) : undefined;
    const session = instanceId ? instanceSessions.get(instanceId) : undefined;

    return {
      cockpit: Boolean(session?.cockpitMode),
      alwaysOnTop: Boolean(session?.cockpitAlwaysOnTop)
    };
  });
  ipcMain.handle("app:set-cockpit-mode", (event, enabled: boolean) => {
    const session = getInstanceSessionForEvent(event);
    return setSessionCockpitMode(session, Boolean(enabled));
  });
  ipcMain.handle("app:set-cockpit-always-on-top", (event, enabled: boolean) => {
    const session = getInstanceSessionForEvent(event);
    return setSessionCockpitAlwaysOnTop(session, Boolean(enabled));
  });
  ipcMain.handle("app:minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle("app:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle("app:open-releases", () => shell.openExternal(desktopReleaseUrl));

  ipcMain.handle("instances:list", () => listInstances());
  ipcMain.handle("instances:create", (_event, name?: string) => {
    requireLicense();
    const created = registry.createInstance(name);
    broadcastInstancesUpdated();
    return listInstances().find((instance) => instance.id === created.id) ?? created;
  });
  ipcMain.handle("instances:rename", (_event, instanceId: string, name: string) => {
    requireLicense();
    const renamed = registry.renameInstance(instanceId, name);
    const session = instanceSessions.get(instanceId);
    if (session && !session.window.isDestroyed()) {
      session.window.setTitle(`${renamed.name} - Spider BOT`);
    }
    broadcastInstancesUpdated();
    return listInstances().find((instance) => instance.id === instanceId) ?? renamed;
  });
  ipcMain.handle("instances:delete", async (_event, instanceId: string) => {
    requireLicense();
    if (instanceSessions.has(instanceId)) {
      await stopInstance(instanceId);
    }
    registry.deleteInstance(instanceId);
    broadcastInstancesUpdated();
  });
  ipcMain.handle("instances:open", (_event, instanceId: string) => {
    requireLicense();
    return openInstance(instanceId);
  });
  ipcMain.handle("instances:stop", (_event, instanceId: string) => stopInstance(instanceId));

  ipcMain.handle("updates:status", () => updateService.getStatus());
  ipcMain.handle("updates:check", () => updateService.checkForUpdates());
  ipcMain.handle("updates:install", () => updateService.installDownloadedUpdate());
  ipcMain.handle("license:status", () => licenseService.getState());
  ipcMain.handle("license:activate", (_event, input: { email: string; licenseKey: string }) =>
    applyLicenseOperation(() => licenseService.activate(input))
  );
  ipcMain.handle("license:revalidate", () =>
    applyLicenseOperation(() => licenseService.revalidate())
  );
  ipcMain.handle("license:clear", () =>
    applyLicenseOperation(() => licenseService.clear())
  );

  ipcMain.handle("profiles:list", (event) => getInstanceSessionForEvent(event).database.listProfiles());
  ipcMain.handle("profiles:create", (event, draft: ProfileDraft) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    const created = session.database.createProfile(draft);
    pushSnapshot(session);
    broadcastInstancesUpdated();
    return created;
  });
  ipcMain.handle("profiles:update", (event, profileId: string, draft: Partial<ProfileDraft>) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    const updated = session.database.updateProfile(profileId, draft);
    pushSnapshot(session);
    return updated;
  });
  ipcMain.handle("profiles:delete", async (event, profileId: string) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    if (session.browserRuntime.isActive(profileId)) {
      await session.browserRuntime.stopProfile(profileId);
    }
    if (session.database.profileExists(profileId)) {
      session.database.deleteProfile(profileId);
    }
    pushSnapshot(session);
    broadcastInstancesUpdated();
  });
  ipcMain.handle("profiles:archive", (event, profileId: string) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    session.database.archiveProfile(profileId);
    pushSnapshot(session);
  });
  ipcMain.handle("profiles:duplicate", (event, profileId: string) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    const created = session.database.duplicateProfile(profileId);
    pushSnapshot(session);
    broadcastInstancesUpdated();
    return created;
  });
  ipcMain.handle(
    "profiles:launch",
    async (
      event,
      profileId: string,
      options?: { triggerAutomation?: boolean; deferNavigation?: boolean }
    ) => {
      requireLicense();
      const session = getInstanceSessionForEvent(event);
      const profile = session.database.getProfile(profileId);
      await session.browserRuntime.launchProfile(profile, session.database.getSettings(), {
        deferNavigation: options?.deferNavigation === true
      });
      const currentProfile = session.database.getProfile(profileId);
      const automation = session.database.getSystemAutomationForProfile(profileId);

      if (options?.triggerAutomation === false) {
        return session.database.getProfile(profileId);
      }

    if (!session.database.isProfileAccountRegisteredForUrl(profileId, currentProfile.homeUrl)) {
      await session.automationRuntime.runAutomation(automation.id, session.database.getSettings());
    } else {
      session.database.logActivity({
        id: crypto.randomUUID(),
        scope: "automation",
        scopeId: automation.id,
        level: "info",
        message: `Conta de ${currentProfile.name} ja esta registrada neste link; cadastro automatico ignorado.`,
        createdAt: new Date().toISOString()
      });
      pushSnapshot(session);
      session.automationRuntime.runAutoLogin(profileId, session.database.getSettings()).catch(() => undefined);
    }

    return session.database.getProfile(profileId);
  });
  ipcMain.handle("profiles:stop", async (event, profileId: string) => {
    const session = getInstanceSessionForEvent(event);
    await session.browserRuntime.stopProfile(profileId);
    return session.database.profileExists(profileId) ? session.database.getProfile(profileId) : undefined;
  });
  ipcMain.handle("profiles:restart", async (event, profileId: string) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    await session.browserRuntime.restartProfile(session.database.getProfile(profileId), session.database.getSettings());
    session.automationRuntime.runAutoLogin(profileId, session.database.getSettings()).catch(() => undefined);
    return session.database.getProfile(profileId);
  });
  ipcMain.handle("profiles:bind-proxy", (event, profileId: string, proxyId?: string) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    const updated = session.database.bindProxy(profileId, proxyId);
    pushSnapshot(session);
    return updated;
  });
  ipcMain.handle("profiles:export-native", (event, profileIds: string[]) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    const exported = session.database.exportProfiles(profileIds);
    pushSnapshot(session);
    return exported;
  });
  ipcMain.handle("profiles:import-native", (event, importPath: string) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    const snapshot = session.database.importProfiles(importPath);
    pushSnapshot(session);
    broadcastInstancesUpdated();
    return snapshot;
  });

  ipcMain.handle("proxies:list", (event) => getInstanceSessionForEvent(event).database.listProxies());
  ipcMain.handle("proxies:create", (event, draft: ProxyDraft) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    const created = session.database.createProxy(draft);
    pushSnapshot(session);
    broadcastInstancesUpdated();
    return created;
  });
  ipcMain.handle("proxies:update", (event, proxyId: string, draft: Partial<ProxyDraft>) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    const updated = session.database.updateProxy(proxyId, draft);
    pushSnapshot(session);
    return updated;
  });
  ipcMain.handle("proxies:delete", (event, proxyId: string) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    session.database.deleteProxy(proxyId);
    pushSnapshot(session);
    broadcastInstancesUpdated();
  });
  ipcMain.handle("proxies:test", async (event, proxyId: string) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    const proxy = session.database.getProxy(proxyId);
    const { status, detail, protocol } = await session.browserRuntime.testProxyDetailed(proxy);
    // Auto-deteccao corrigiu o protocolo (ex.: o proxy era SOCKS5 mas estava
    // cadastrado como HTTP): persiste para que o launch use o mesmo.
    const protocolChanged = protocol !== undefined && protocol !== proxy.protocol;
    if (protocolChanged) {
      session.database.updateProxy(proxyId, { protocol });
    }
    const updated = session.database.updateProxyStatus(proxyId, status);
    session.database.logActivity({
      id: crypto.randomUUID(),
      scope: "proxy",
      scopeId: proxyId,
      level: status === "healthy" ? "success" : status === "degraded" ? "warning" : "error",
      message:
        status === "healthy"
          ? protocolChanged
            ? `Proxy ${proxy.label} esta pronto para uso (protocolo ajustado para ${protocol}).`
            : `Proxy ${proxy.label} esta pronto para uso.`
          : `Proxy ${proxy.label} precisa de atencao (${status})${detail ? `: ${detail}` : ""}.`,
      createdAt: new Date().toISOString()
    });
    pushSnapshot(session);
    return updated;
  });

  ipcMain.handle("automations:list", (event) => getInstanceSessionForEvent(event).database.listAutomations());
  ipcMain.handle("automations:create", (event, draft: AutomationDraft) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    const created = session.database.createAutomation(draft);
    pushSnapshot(session);
    return created;
  });
  ipcMain.handle("automations:update", (event, automationId: string, draft: Partial<AutomationDraft>) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    const updated = session.database.updateAutomation(automationId, draft);
    pushSnapshot(session);
    return updated;
  });
  ipcMain.handle("automations:run-now", async (event, automationId: string) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    const run = await session.automationRuntime.runAutomation(automationId, session.database.getSettings());
    pushSnapshot(session);
    return run;
  });
  ipcMain.handle("automations:cancel", async (event, runId: string) => {
    const session = getInstanceSessionForEvent(event);
    await session.automationRuntime.cancelRun(runId);
    pushSnapshot(session);
  });
  ipcMain.handle(
    "automations:run-batch",
    async (event, request: { automationIds: string[]; delaySeconds: number }) => {
      requireLicense();
      const session = getInstanceSessionForEvent(event);
      const automationIds = Array.from(new Set(request?.automationIds ?? [])).filter(Boolean);
      // Ordena pelo slotIndex (esquerda -> direita) para que o inicio das automacoes
      // siga a ordem visual das janelas, mesmo quando os launches em paralelo
      // (Promise.allSettled no renderer) alocam slots fora de ordem.
      automationIds.sort((left, right) => {
        const leftAutomation = session.database.getAutomation(left);
        const rightAutomation = session.database.getAutomation(right);
        const leftSlot = leftAutomation
          ? session.browserRuntime.getSlotIndexForProfile(leftAutomation.profileId) ?? Number.MAX_SAFE_INTEGER
          : Number.MAX_SAFE_INTEGER;
        const rightSlot = rightAutomation
          ? session.browserRuntime.getSlotIndexForProfile(rightAutomation.profileId) ?? Number.MAX_SAFE_INTEGER
          : Number.MAX_SAFE_INTEGER;
        return leftSlot - rightSlot;
      });
      const safeDelaySeconds = Math.max(
        0,
        Math.min(600, Math.floor((Number(request?.delaySeconds) || 0) * 10) / 10)
      );
      const delayMs = Math.round(safeDelaySeconds * 1000);
      const settings = session.database.getSettings();
      const batchState: ActiveAutomationBatch = {
        splashTimerHandles: new Set(),
        runAbortController: new AbortController()
      };
      activeAutomationBatches.set(session.id, batchState);
      // Marca o instante de origem do batch para calcular targetStartAt acumulado
      // (automacao[i] inicia em baseTime + i * delayMs, nao apenas em +delayMs).
      const baseTime = Date.now();
      logRuntimePreparation(
        session,
        "info",
        automationIds.length > 1
          ? `Painel paralelo configurado: ${automationIds.length} janelas com ${
              safeDelaySeconds > 0 ? `${safeDelaySeconds}s entre automacoes` : "inicio simultaneo"
            }.`
          : automationIds.length === 1
            ? `Painel paralelo: 1 janela sem espera entre automacoes.`
            : "Painel paralelo vazio; nada a iniciar."
      );

      for (let index = 0; index < automationIds.length; index += 1) {
        const automationId = automationIds[index];
        if (!automationId) {
          continue;
        }
        const targetStartAt = baseTime + index * delayMs;

        const schedule = async () => {
          if (batchState.runAbortController.signal.aborted) {
            return;
          }
          const automation = session.database.getAutomation(automationId);
          const profile = session.database.getProfile(automation.profileId);

          if (index > 0 && delayMs > 0) {
            await session.browserRuntime
              .setSplashOverlay(profile.id, true)
              .catch(() => undefined);
          }

          const waitMs = targetStartAt - Date.now();
          if (waitMs > 0) {
            await new Promise<void>((resolve) => {
              if (batchState.runAbortController.signal.aborted) {
                resolve();
                return;
              }
              const handle = setTimeout(resolve, waitMs);
              batchState.splashTimerHandles.add(handle);
              const clear = () => {
                batchState.splashTimerHandles.delete(handle);
              };
              handle.unref?.();
              batchState.runAbortController.signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(handle);
                  clear();
                  resolve();
                },
                { once: true }
              );
            });
          }

          if (batchState.runAbortController.signal.aborted) {
            await session.browserRuntime
              .setSplashOverlay(profile.id, false)
              .catch(() => undefined);
            return;
          }

          requireLicense();
          if (session.database.isProfileAccountRegisteredForUrl(profile.id, profile.homeUrl)) {
            // Ja registrada: pula o cadastro e tira o splash.
            await session.browserRuntime
              .setSplashOverlay(profile.id, false)
              .catch(() => undefined);
            session.database.logActivity({
              id: crypto.randomUUID(),
              scope: "automation",
              scopeId: automation.id,
              level: "info",
              message: `Conta de ${profile.name} ja esta registrada neste link; cadastro automatico ignorado.`,
              createdAt: new Date().toISOString()
            });
            pushSnapshot(session);
            session.automationRuntime.runAutoLogin(profile.id, settings).catch(() => undefined);
            return;
          }

          try {
            if (batchState.runAbortController.signal.aborted) {
              return;
            }
            await session.browserRuntime
              .setSplashOverlay(profile.id, false)
              .catch(() => undefined);
            await session.automationRuntime.runAutomation(automation.id, settings);
          } finally {
            await session.browserRuntime
              .setSplashOverlay(profile.id, false)
              .catch(() => undefined);
          }
        };

        void schedule();
      }

      return {
        scheduled: automationIds.length,
        delaySeconds: safeDelaySeconds
      };
    }
  );
  ipcMain.handle("automations:cancel-batch", async (event) => {
    const session = getInstanceSessionForEvent(event);
    const batchState = activeAutomationBatches.get(session.id);
    if (!batchState) {
      return { cancelled: false };
    }
    batchState.runAbortController.abort();
    for (const handle of batchState.splashTimerHandles) {
      clearTimeout(handle);
    }
    batchState.splashTimerHandles.clear();
    activeAutomationBatches.delete(session.id);
    // Parada DURA: alem de impedir as janelas enfileiradas de iniciarem (abort acima),
    // interrompe os cadastros JA em andamento para que o Stop pare tudo, nao so a fila.
    await session.automationRuntime.cancelActiveRuns().catch(() => undefined);
    return { cancelled: true };
  });

  ipcMain.handle("runs:list", (event) => getInstanceSessionForEvent(event).database.listRuns());
  ipcMain.handle("runs:clear", (event) => {
    const session = getInstanceSessionForEvent(event);
    const removed = session.database.clearRuns();
    pushSnapshot(session);
    return { removed };
  });
  ipcMain.handle("activity:list", (event) => getInstanceSessionForEvent(event).database.listActivity());
  ipcMain.handle("activity:clear", (event) => {
    const session = getInstanceSessionForEvent(event);
    const removed = session.database.clearActivityLogs();
    pushSnapshot(session);
    return { removed };
  });
  ipcMain.handle("pix-keys:list", (event) => getInstanceSessionForEvent(event).database.listPixPhoneKeys());
  ipcMain.handle("pix-keys:add-phone-numbers", (event, input: string) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    const result = session.database.addPixPhoneKeys(input);
    pushSnapshot(session);
    broadcastInstancesUpdated();
    return result;
  });
  ipcMain.handle("pix-keys:update-phone-number", (event, pixKeyId: string, phoneNumber: string) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    const updated = session.database.updatePixPhoneKeyPhoneNumber(pixKeyId, phoneNumber);
    pushSnapshot(session);
    return updated;
  });
  ipcMain.handle("pix-keys:delete", (event, pixKeyId: string) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    session.database.deletePixPhoneKey(pixKeyId);
    pushSnapshot(session);
    broadcastInstancesUpdated();
  });
  ipcMain.handle("settings:get", (event) => getInstanceSessionForEvent(event).database.getSettings());
  ipcMain.handle("settings:update", async (event, draft: Partial<AppSettings>) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    const updated = session.database.updateSettings(draft);
    if (draft.screenLayout !== undefined) {
      session.browserRuntime.setScreenLayout(updated.screenLayout);
    }
    if (draft.autoClosePopupsDuringNavigation !== undefined) {
      await session.browserRuntime.setAutoClosePopupsDuringNavigation(updated.autoClosePopupsDuringNavigation);
    }
    if (draft.showAccountInfoOverlay !== undefined) {
      await session.browserRuntime.setAccountInfoOverlayEnabled(updated.showAccountInfoOverlay);
    }
    if (draft.domainBlockEnabled !== undefined || draft.blockedDomains !== undefined) {
      session.browserRuntime.setDomainBlock(updated.domainBlockEnabled, updated.blockedDomains);
    }
    pushSnapshot(session);
    return updated;
  });
  ipcMain.handle("screens:list-displays", () => listDisplays());
  ipcMain.handle("screens:apply-layout", async (event) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    await session.browserRuntime.applyLayout(session.database.getSettings());
    session.database.logActivity({
      id: crypto.randomUUID(),
      scope: "runtime",
      level: "success",
      message: "Layout de telas aplicado nas janelas abertas.",
      createdAt: new Date().toISOString()
    });
    pushSnapshot(session);
  });
  ipcMain.handle("screens:preview-layout", (event) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    const preview = session.browserRuntime.getLayoutPreviewRects(session.database.getSettings());
    showLayoutPreview(preview);
  });
  ipcMain.handle(
    "controls:navigate",
    async (
      event,
      action: RuntimeControlNavigationAction,
      targetSelection: RuntimeControlTargetSelection,
      searchTerm?: string
    ) => {
      requireLicense();
      const session = getInstanceSessionForEvent(event);
      ensureNoAutomationConflict(session, targetSelection, "Navegacao");
      await session.browserRuntime.navigate(action, targetSelection, searchTerm);
      const actionLabel =
        action === "slot-search"
          ? `Busca de slots: ${searchTerm ?? ""}`
          : action === "bet-report"
            ? "Relatorio de apostas"
            : action === "refresh"
              ? "Atualizacao de pagina"
              : "Pagina inicial";

      session.database.logActivity({
        id: crypto.randomUUID(),
        scope: "runtime",
        level: "success",
        message: `${actionLabel} enviado para as janelas abertas.`,
        details: {
          windows: describeTargetSelection(targetSelection)
        },
        createdAt: new Date().toISOString()
      });
      pushSnapshot(session);
    }
  );
  ipcMain.handle("controls:deposit", async (event, request: ManualDepositControlRequest) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    const targetProfileIds = session.browserRuntime.getActiveProfileIdsForSelection(request.targetSelection);
    const results = await session.automationRuntime.runManualDeposit(
      targetProfileIds,
      request.amounts,
      session.database.getSettings()
    );
    const succeeded = results.filter((result) => result.status === "succeeded").length;
    const failed = results.length - succeeded;

    session.database.logActivity({
      id: crypto.randomUUID(),
      scope: "runtime",
      level: failed > 0 ? "warning" : "success",
      message:
        failed > 0
          ? `Deposito manual concluido com ${succeeded} sucesso(s) e ${failed} falha(s).`
          : `Deposito manual enviado para ${succeeded} janela(s).`,
      details: {
        windows: describeTargetSelection(request.targetSelection)
      },
      createdAt: new Date().toISOString()
    });
    pushSnapshot(session);
    return results;
  });
  ipcMain.handle("controls:register-pix-key", async (event, request: PixKeyRegistrationControlRequest) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    const targetProfileIds = session.browserRuntime.getActiveProfileIdsForSelection(request.targetSelection);
    const availablePixKeyCount = session.database.listPixPhoneKeys().length;
    if (request.pixType === "PHONE" && targetProfileIds.length > availablePixKeyCount) {
      throw new Error(
        `Voce selecionou ${targetProfileIds.length} perfil(is), mas ha apenas ${availablePixKeyCount} chave(s) PIX telefone disponiveis.`
      );
    }
    const results = await session.automationRuntime.runManualPixKeyRegistration(
      targetProfileIds,
      request.pixType,
      session.database.getSettings()
    );
    const succeeded = results.filter((result) => result.status === "succeeded").length;
    const failed = results.length - succeeded;

    session.database.logActivity({
      id: crypto.randomUUID(),
      scope: "runtime",
      level: failed > 0 ? "warning" : "success",
      message:
        failed > 0
          ? `Cadastro PIX concluido com ${succeeded} sucesso(s) e ${failed} falha(s).`
          : `Cadastro PIX enviado para ${succeeded} janela(s).`,
      details: {
        pixType: request.pixType,
        windows: describeTargetSelection(request.targetSelection)
      },
      createdAt: new Date().toISOString()
    });
    pushSnapshot(session);
    return results;
  });
  ipcMain.handle(
    "controls:open-withdrawals",
    async (event, request: WithdrawalPreparationControlRequest) => {
      requireLicense();
      const session = getInstanceSessionForEvent(event);
      const targetProfileIds = session.browserRuntime.getActiveProfileIdsForSelection(request.targetSelection);
      const results = await session.automationRuntime.runWithdrawalPreparation(
        targetProfileIds,
        session.database.getSettings()
      );
      const succeeded = results.filter((result) => result.status === "succeeded").length;
      const failed = results.length - succeeded;

      session.database.logActivity({
        id: crypto.randomUUID(),
        scope: "runtime",
        level: failed > 0 ? "warning" : "success",
        message:
          failed > 0
            ? `Abertura de saques concluida com ${succeeded} sucesso(s) e ${failed} falha(s).`
            : `Tela de saques aberta em ${succeeded} janela(s).`,
        details: {
          windows: describeTargetSelection(request.targetSelection)
        },
        createdAt: new Date().toISOString()
      });
      pushSnapshot(session);
      return results;
    }
  );
  ipcMain.handle("controls:set-mirror-mode", async (event, enabled: boolean, selection: RuntimeControlSelectionState) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    if (enabled) {
      ensureNoAutomationConflict(session, requireTargetSelection(selection), "Modo Espelho");
    }
    await session.browserRuntime.setMirrorMode(enabled, selection);
  });
  ipcMain.handle("controls:set-selected-windows", async (event, selection: RuntimeControlSelectionState) => {
    requireLicense();
    await getInstanceSessionForEvent(event).browserRuntime.setSelectedWindows(selection);
  });
  ipcMain.handle("controls:set-speed", async (event, rate: number, targetSelection: RuntimeControlTargetSelection) => {
    requireLicense();
    const session = getInstanceSessionForEvent(event);
    await session.browserRuntime.setSpeed(rate, buildSpeedTargetSelection(session, targetSelection));
  });

  openManagerWindow = createManagerWindow;
  await createManagerWindow();

  const updateCheckTimer = setTimeout(() => {
    void updateService.checkForUpdates();
  }, 12_000);
  updateCheckTimer.unref?.();

  const licenseRevalidationTimer = setInterval(() => {
    void applyLicenseOperation(() => licenseService.revalidate())
      .then((state) => {
        if (state.operational) {
          void refreshServedPayloads();
        }
      })
      .catch(() => undefined);
  }, 30 * 1000);

  app.on("before-quit", (event) => {
    if (shuttingDown) {
      return;
    }

    event.preventDefault();
    shuttingDown = true;
    clearTimeout(updateCheckTimer);
    clearInterval(licenseRevalidationTimer);
    void stopAllInstances().finally(() => {
      registry.close();
      app.quit();
    });
  });
}

app.setAppUserModelId("com.spiderbot.desktop");

app.whenReady().then(() => {
  registerRendererProtocol();
  bootstrap().catch((error) => {
    writeStartupDiagnostic("Spider BOT bootstrap failed", error);
    safeConsoleError("Spider BOT bootstrap failed", error);
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    openManagerWindow?.().catch((error) => {
      writeStartupDiagnostic("Spider BOT activate failed", error);
      safeConsoleError("Spider BOT activate failed", error);
      app.quit();
    });
  }
});

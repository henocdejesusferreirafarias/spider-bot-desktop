import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Socket } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import * as electron from "electron";
import {
  chromium as patchrightChromium,
  type BrowserContext,
  type CDPSession,
  type Frame,
  type Locator,
  type Page,
  type Route
} from "patchright";
import { buildProxyUsername } from "./proxy-routing.js";
import { forceKillProfileBrowser } from "./browser-process-kill.js";
import { ProxyChainService, type ProxyTunnelFailure } from "./proxy-chain.js";
import { resolveRuntimeWindowTargetsStrict } from "./runtime-window-selection.js";
import { selectMobileDevice, type DeviceProfile } from "./device-catalog.js";
import {
  bundleMatchesEngine,
  cocosDirectorTickFramePatternSources,
  isKnownGameFrameUrl,
  knownGameFramePatternSources,
  patchGameSpeedScript,
  resolveProviderByFrameUrl,
  resolveProviderByScriptUrl,
  uhtDeltaTimeFramePatternSources
} from "./provider-timing.js";
import { AsyncSemaphore, resolveMaxConcurrentLaunches } from "./async-semaphore.js";
import {
  decideGameLoadRecovery,
  GAME_CANVAS_SELECTOR,
  GAME_LOADER_PATTERN,
  shouldMonitorGameLoadFrame
} from "./game-load.js";
import {
  detectPlatformDescriptor,
  getCurrentRoute,
  hasSpaRouter,
  resolveRouteTarget,
  routerPush
} from "./spa-navigation.js";
import type { RouteKind, RouteTarget } from "./spa-navigation.js";
import {
  buildDpiAwarePlacement,
  toChromiumWindowGeometry,
  toPreviewDipRect,
  type DpiAwarePlacement
} from "./window-geometry.js";
import {
  NAVIGATION_MODE_LAUNCH_ARG_PREFIX,
  NAVIGATION_MODES,
  type AppSettings,
  type NavigationMode,
  type ProfileSummary,
  type ProxyConfig,
  type RuntimeControlNavigationAction,
  type RuntimeControlSelectionState,
  type RuntimeControlTargetSelection,
  type RuntimeStatus,
  type RuntimeWindowTarget,
  type ScreenLayoutSettings
} from "../../shared/contracts.js";
import {
  buildLogicalLayout,
  getScreenLayoutSlotCount,
  normalizeScreenLayout,
  type LayoutRect
} from "../../shared/window-layout.js";

const { screen } = electron;

type RuntimeNotifier = (profileId: string, status: RuntimeStatus, detail?: string) => void;
type BrowserLaunchOptions = NonNullable<Parameters<typeof patchrightChromium.launchPersistentContext>[1]>;
const execFileAsync = promisify(execFile);
const PATCHRIGHT_INIT_SCRIPT_CONTEXT = false;

const __filenameForSplash = fileURLToPath(import.meta.url);
const __dirnameForSplash = dirname(__filenameForSplash);

function resolveSplashLogoDataUrl(): string {
  const candidates = [
    join(__dirnameForSplash, "../../../../assets/icon.png"),
    join(__dirnameForSplash, "../../../assets/icon.png"),
    join(__dirnameForSplash, "../../assets/icon.png"),
    join(__dirnameForSplash, "../assets/icon.png"),
    join(process.resourcesPath, "icon.png")
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        const buffer = readFileSync(candidate);
        return `data:image/png;base64,${buffer.toString("base64")}`;
      }
    } catch {
      // tenta o proximo
    }
  }
  return "";
}

let cachedSplashLogoDataUrl: string | undefined;
function getSplashLogoDataUrl(): string {
  if (cachedSplashLogoDataUrl === undefined) {
    cachedSplashLogoDataUrl = resolveSplashLogoDataUrl();
  }
  return cachedSplashLogoDataUrl;
}
const LEGACY_DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const LEGACY_DEFAULT_MOBILE_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7863.0 Mobile Safari/537.36";
const PRESERVE_NATIVE_FEATURES = new Set(["UserAgentClientHint"]);
const DEFAULT_NAVIGATION_MODE: NavigationMode = "desktop";
const AUTOMATION_CONTROLLED_ARG = "--disable-blink-features=AutomationControlled";
export const WEBRTC_PROXIED_UDP_ONLY_ARG = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";
const TREASURE_TEMPLATE_ID = "15";
const TREASURE_CATEGORY_API_PATH = "hall/api/active/category/currency/{currency}/language/{language}.json";
const DEFAULT_TREASURE_CURRENCY_CODE = "BRL";
const DEFAULT_TREASURE_LANGUAGE_CODE = "pt";
const BET_REPORT_LEGACY_ROUTE = "home/report?reportCurrent=1";
const INPUT_DIAGNOSTIC_LOG_PATH = join(
  process.env.APPDATA ?? process.cwd(),
  "Predator",
  "input-diagnostics.log"
);
const INPUT_DIAGNOSTIC_MAX_BYTES = 2 * 1024 * 1024;

const sanitizeDiagnosticUrl = (value: string): string => {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0] ?? "";
  }
};

const appendInputDiagnostic = (entry: Record<string, unknown>): void => {
  try {
    mkdirSync(dirname(INPUT_DIAGNOSTIC_LOG_PATH), { recursive: true });
    if (existsSync(INPUT_DIAGNOSTIC_LOG_PATH)) {
      const currentSize = statSync(INPUT_DIAGNOSTIC_LOG_PATH).size;
      if (currentSize >= INPUT_DIAGNOSTIC_MAX_BYTES) {
        writeFileSync(INPUT_DIAGNOSTIC_LOG_PATH, "");
      }
    }
    writeFileSync(
      INPUT_DIAGNOSTIC_LOG_PATH,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\r\n`,
      { flag: "a" }
    );
  } catch {
    // Diagnostics must never interfere with browser operation.
  }
};

const normalizeProfileLocale = (locale: string | undefined) => locale?.trim() || "pt-BR";

const buildNavigatorLanguages = (locale: string): string[] => {
  const normalized = normalizeProfileLocale(locale);
  const base = normalized.split("-")[0] || normalized;
  const fallbacks = base === "pt" ? ["pt", "en-US", "en"] : [base, "en-US", "en"];
  return Array.from(new Set([normalized, ...fallbacks].filter((language): language is string => Boolean(language))));
};

const buildAcceptLanguageHeader = (languages: string[]): string =>
  languages
    .map((language, index) => (index === 0 ? language : `${language};q=${Math.max(0.5, 1 - index * 0.1).toFixed(1)}`))
    .join(",");

const resolveProfileUserAgent = (userAgent: string | undefined): string | undefined => {
  const trimmed = userAgent?.trim();
  if (!trimmed || trimmed === LEGACY_DEFAULT_USER_AGENT || trimmed === LEGACY_DEFAULT_MOBILE_USER_AGENT) {
    return undefined;
  }
  return trimmed;
};

const resolveProfileLocale = (persona: ProfileSummary["persona"]): string => {
  const locale = normalizeProfileLocale(persona.locale);
  const usesLegacyBrazilDefaults =
    locale === "en-US" &&
    persona.timezone === "America/Sao_Paulo" &&
    !resolveProfileUserAgent(persona.userAgent);

  return usesLegacyBrazilDefaults ? "pt-BR" : locale;
};

const resolveNavigatorPlatform = (userAgent: string | undefined, navigationMode: NavigationMode): string => {
  const normalizedUserAgent = userAgent ?? "";

  if (/\b(iphone|ipod)\b/i.test(normalizedUserAgent)) {
    return "iPhone";
  }
  if (/\bipad\b/i.test(normalizedUserAgent)) {
    return "iPad";
  }
  if (navigationMode !== "desktop" || /\bandroid\b/i.test(normalizedUserAgent)) {
    return "Linux armv81";
  }
  if (/\b(macintosh|mac os x)\b/i.test(normalizedUserAgent)) {
    return "MacIntel";
  }
  if (/\blinux\b/i.test(normalizedUserAgent)) {
    return "Linux x86_64";
  }

  return "Win32";
};

const buildFingerprintConsistencyConfig = (
  userAgent: string | undefined,
  languages: string[],
  navigationMode: NavigationMode,
  userAgentMetadata: UserAgentMetadataConfig | undefined,
  hardware?: { hardwareConcurrency: number; deviceMemory: number; maxTouchPoints: number }
): FingerprintConsistencyConfig => {
  const mobileLike = navigationMode !== "desktop";

  return {
    ...(userAgent ? { userAgent } : {}),
    languages,
    platform: resolveNavigatorPlatform(userAgent, navigationMode),
    vendor: "Google Inc.",
    hardwareConcurrency: hardware?.hardwareConcurrency ?? 8,
    deviceMemory: hardware?.deviceMemory ?? (mobileLike ? 4 : 8),
    maxTouchPoints: hardware?.maxTouchPoints ?? (mobileLike ? 5 : 0),
    ...(userAgentMetadata ? { userAgentMetadata } : {})
  };
};

interface RuntimeHandle {
  profileId: string;
  context: BrowserContext;
  // user-data-dir deste perfil (profile.storagePath). Unico por perfil; usado para
  // escopar o kill de emergencia ao processo-arvore certo (ver browser-process-kill).
  storagePath: string;
  primaryPage: Page;
  pageOrder: Page[];
  slotIndex: number;
  placement: DpiAwarePlacement;
  launchedScale: number;
  ipLabel: string;
  homeUrl: string;
  speedRate: number;
  navigationRunId: number;
  mobileLike: boolean;
  proxyChain?: ProxyChainService;
  pendingNavigation?: { homeUrl: string };
  // Memo de sessao: true quando a plataforma usa o wrapper iframe (ex.: 467win.top).
  // Detectado uma vez (iframe#h5_iframe / ?isredirect=1) e lembrado, pois ao navegar a
  // partir de uma rota profunda o iframe nao esta montado e a deteccao falharia.
  usesIframeApp?: boolean;
}

interface CloseProfileBrowserTarget {
  storagePath: string;
  context: {
    pages: () => Array<{
      close: (options: { runBeforeUnload: boolean }) => Promise<unknown>;
    }>;
    close: () => Promise<unknown>;
  };
}

interface CloseProfileBrowserOptions {
  timeoutMs?: number;
  forceKillTimeoutMs?: number;
  forceKill?: (storagePath: string) => Promise<void>;
}

export async function closeProfileBrowser(
  target: CloseProfileBrowserTarget,
  options: CloseProfileBrowserOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const forceKillTimeoutMs = options.forceKillTimeoutMs ?? 3000;
  const forceKill = options.forceKill ?? forceKillProfileBrowser;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const runBoundedForceKill = async () => {
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        forceKill(target.storagePath).catch(() => undefined),
        new Promise<void>((resolve) => {
          forceKillTimeout = setTimeout(resolve, forceKillTimeoutMs);
        })
      ]);
    } finally {
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
    }
  };

  const gracefulClose = async () => {
    await Promise.all(
      target.context.pages().map((page) =>
        page.close({ runBeforeUnload: false }).catch(() => undefined)
      )
    );
    await target.context.close();
  };

  try {
    const outcome = await Promise.race([
      gracefulClose().then(() => "closed" as const),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), timeoutMs);
      })
    ]);
    if (outcome === "timeout") {
      await runBoundedForceKill();
    }
  } catch {
    await runBoundedForceKill();
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export interface LayoutPreviewSlot {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  // true quando a janela real fica maior que a celula (escala saturada no piso) e invade a vizinha.
  overlaps: boolean;
  // true quando a janela estende-se alem da borda do monitor (a ultima coluna/linha fica cortada).
  cutOff: boolean;
}

export interface LayoutPreviewResult {
  mode: "grid" | "cascade";
  workArea: LayoutRect;
  slots: LayoutPreviewSlot[];
}

interface DeviceHardwareConfig {
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
}

interface MobileEmulationConfig {
  userAgent: string;
  userAgentMetadata: UserAgentMetadataConfig;
  /** Rotulo do aparelho atribuido (catalogo) ou "custom" para UA definido manualmente. */
  deviceLabel: string;
  /** Specs de hardware do aparelho, refletidas em navigator.* para coerencia. */
  hardware: DeviceHardwareConfig;
}

interface UserAgentMetadataConfig {
  architecture: string;
  bitness: string;
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  mobile: boolean;
  model: string;
  platform: string;
  platformVersion: string;
  wow64: boolean;
}

interface UserAgentOverrideConfig {
  userAgent: string;
  userAgentMetadata: UserAgentMetadataConfig;
}

interface FingerprintConsistencyConfig {
  userAgent?: string;
  languages: string[];
  platform: string;
  vendor: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
  userAgentMetadata?: UserAgentMetadataConfig;
  // Mascara o force-device-scale-factor: valor de devicePixelRatio a reportar (DPR real do monitor).
  devicePixelRatio?: number;
  // Multiplicador aplicado a screen.width/height para manter a resolucao coerente com o DPR reportado.
  screenDimensionScale?: number;
}

interface LaunchProxyInfo {
  proxy?: {
    server: string;
    username?: string;
    password?: string;
  };
  proxyChain?: ProxyChainService;
  ipLabel: string;
}

interface ProxyProbeOptions {
  profileId?: string;
  targetUrl?: string;
  // Forca um protocolo de upstream especifico nesta tentativa, ignorando o
  // protocolo salvo no proxy. Usado pela auto-deteccao de protocolo.
  protocolOverride?: ProxyConfig["protocol"];
}

interface ProxyProbeTarget {
  hostname: string;
  port: number;
  authority: string;
}

interface ProxyProbeResponse {
  statusCode: number;
  statusText: string;
}

interface ProxyProbeResult {
  status: ProxyConfig["status"];
  detail?: string;
  // Protocolo de upstream que efetivamente conectou (pode diferir do salvo
  // quando a auto-deteccao corrige http<->socks5<->https).
  protocol?: ProxyConfig["protocol"];
}

interface MirrorEventPayload {
  kind: "pointerdown" | "pointerup" | "pointermove" | "wheel" | "keydown" | "keyup";
  xRatio?: number;
  yRatio?: number;
  button?: number;
  buttons?: number;
  deltaX?: number;
  deltaY?: number;
  key?: string;
  code?: string;
  keyCode?: number;
  text?: string;
  pointerType?: string;
}

interface MirrorFrameProjection {
  frameBox: { x: number; y: number; width: number; height: number };
  sourceViewport: { width: number; height: number };
}

export function projectMirrorFrameCoordinates(
  payload: MirrorEventPayload,
  projection: MirrorFrameProjection
): MirrorEventPayload {
  const localXRatio = Math.max(0, Math.min(1, payload.xRatio ?? 0.5));
  const localYRatio = Math.max(0, Math.min(1, payload.yRatio ?? 0.5));
  const rootX = projection.frameBox.x + localXRatio * projection.frameBox.width;
  const rootY = projection.frameBox.y + localYRatio * projection.frameBox.height;
  return {
    ...payload,
    xRatio: rootX / Math.max(1, projection.sourceViewport.width),
    yRatio: rootY / Math.max(1, projection.sourceViewport.height)
  };
}

interface TreasureEventCandidate {
  id: string;
  score: number;
  source: string;
  status?: number;
  startTime?: number;
  endTime?: number;
}

interface TreasureCategoryPayload {
  source: string;
  text: string;
  url: string;
}

interface TreasureResourceHints {
  baseUrls: string[];
  currencyCode?: string;
  languageCode?: string;
}

export interface AutomationSession {
  context: BrowserContext;
  page: Page;
  release: (options?: { closeBrowser?: boolean }) => Promise<void>;
}

interface BrowserLaunchTarget {
  executablePath?: string;
  label: string;
  missingReason?: string;
}

const findFirstExistingFile = (candidates: Array<string | undefined>): string | undefined =>
  candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

const CHROMIUM_SNAPSHOT_DOWNLOAD_URL = "https://download-chromium.appspot.com/dl/Win_x64?type=snapshots";
const MANAGED_CHROMIUM_DIR_NAME = "chromium-snapshot";

const resolveManagedChromiumCacheRoot = (): string =>
  process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Predator", "Browsers")
    : join(process.cwd(), "browsers");

const resolveManagedChromiumInstallRoot = (): string =>
  join(resolveManagedChromiumCacheRoot(), MANAGED_CHROMIUM_DIR_NAME);

const findManagedChromiumExecutablePath = (): string | undefined => {
  const installRoot = resolveManagedChromiumInstallRoot();
  return findFirstExistingFile([
    join(installRoot, "chrome-win", "chrome.exe"),
    join(installRoot, "chrome-win64", "chrome.exe")
  ]);
};

const resolveStandardChromiumExecutablePath = (): string | undefined => {
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const resourcesPath = process.resourcesPath;

  return (
    findFirstExistingFile([
      process.env.PREDATOR_CHROMIUM_PATH,
      process.env.CHROMIUM_PATH,
      localAppData ? join(localAppData, "Chromium", "Application", "chrome.exe") : undefined,
      programFiles ? join(programFiles, "Chromium", "Application", "chrome.exe") : undefined,
      programFilesX86 ? join(programFilesX86, "Chromium", "Application", "chrome.exe") : undefined,
      localAppData ? join(localAppData, "ungoogled-chromium", "chrome.exe") : undefined,
      programFiles ? join(programFiles, "ungoogled-chromium", "chrome.exe") : undefined,
      resourcesPath ? join(resourcesPath, "chromium", "chrome-win", "chrome.exe") : undefined,
      resourcesPath ? join(resourcesPath, "chromium", "chrome-win64", "chrome.exe") : undefined
    ]) ??
    findManagedChromiumExecutablePath()
  );
};

let chromiumInstallPromise: Promise<void> | undefined;

interface DownloadProgress {
  downloadedBytes: number;
  totalBytes?: number;
}

const formatMegabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const downloadFile = async (
  url: string,
  destinationPath: string,
  onProgress?: (progress: DownloadProgress) => void,
  redirectCount = 0
): Promise<void> => {
  if (redirectCount > 5) {
    throw new Error("redirecionamentos demais ao baixar Chromium");
  }

  await new Promise<void>((resolve, reject) => {
    const parsed = new URL(url);
    const request = parsed.protocol === "http:" ? httpRequest : httpsRequest;
    const req = request(parsed, (response) => {
      const statusCode = response.statusCode ?? 0;
      const location = response.headers.location;

      if (statusCode >= 300 && statusCode < 400 && location) {
        response.resume();
        const nextUrl = new URL(location, parsed).toString();
        downloadFile(nextUrl, destinationPath, onProgress, redirectCount + 1).then(resolve, reject);
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`download retornou HTTP ${statusCode}`));
        return;
      }

      const contentLength = Number(response.headers["content-length"]);
      const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined;
      let downloadedBytes = 0;
      onProgress?.({ downloadedBytes, ...(totalBytes ? { totalBytes } : {}) });
      response.on("data", (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        onProgress?.({ downloadedBytes, ...(totalBytes ? { totalBytes } : {}) });
      });
      pipeline(response, createWriteStream(destinationPath)).then(resolve, reject);
    });

    req.setTimeout(5 * 60 * 1000, () => {
      req.destroy(new Error("timeout ao baixar Chromium"));
    });
    req.on("error", reject);
    req.end();
  });
};

const downloadChromiumArchive = async (
  archivePath: string,
  partialArchivePath: string,
  onStatus?: (message: string) => void
): Promise<void> => {
  rmSync(partialArchivePath, { force: true });
  onStatus?.("Baixando Chromium oficial... 0%");

  let lastReportedPercent = 0;
  let lastReportedBytes = 0;
  await downloadFile(CHROMIUM_SNAPSHOT_DOWNLOAD_URL, partialArchivePath, ({ downloadedBytes, totalBytes }) => {
    if (totalBytes) {
      const percent = Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100));
      const reportablePercent = Math.floor(percent / 5) * 5;
      if (reportablePercent <= lastReportedPercent) {
        return;
      }
      lastReportedPercent = reportablePercent;
      onStatus?.(
        `Baixando Chromium oficial... ${reportablePercent}% (${formatMegabytes(downloadedBytes)} / ${formatMegabytes(totalBytes)})`
      );
      return;
    }

    const reportIntervalBytes = 25 * 1024 * 1024;
    if (downloadedBytes - lastReportedBytes >= reportIntervalBytes) {
      lastReportedBytes = downloadedBytes;
      onStatus?.(`Baixando Chromium oficial... ${formatMegabytes(downloadedBytes)}`);
    }
  });

  renameSync(partialArchivePath, archivePath);
  onStatus?.("Download do Chromium concluido.");
};

const extractChromiumArchive = async (
  archivePath: string,
  tempRoot: string,
  onStatus?: (message: string) => void
): Promise<string> => {
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });

  onStatus?.("Extraindo Chromium oficial...");
  const tarExecutable = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "tar.exe")
    : "tar.exe";
  await execFileAsync(tarExecutable, ["-xf", archivePath, "-C", tempRoot], {
    windowsHide: true,
    timeout: 10 * 60 * 1000,
    maxBuffer: 1024 * 1024
  });

  const extractedExecutable = findFirstExistingFile([
    join(tempRoot, "chrome-win", "chrome.exe"),
    join(tempRoot, "chrome-win64", "chrome.exe")
  ]);
  if (!extractedExecutable) {
    throw new Error("chrome.exe nao foi encontrado no pacote baixado");
  }

  onStatus?.("Chromium oficial extraido com sucesso.");
  return extractedExecutable;
};

const installManagedChromium = async (onStatus?: (message: string) => void): Promise<void> => {
  const cacheRoot = resolveManagedChromiumCacheRoot();
  const installRoot = resolveManagedChromiumInstallRoot();
  const tempRoot = join(cacheRoot, `${MANAGED_CHROMIUM_DIR_NAME}.tmp`);
  const zipPath = join(cacheRoot, `${MANAGED_CHROMIUM_DIR_NAME}.zip.tmp`);
  const partialZipPath = join(cacheRoot, `${MANAGED_CHROMIUM_DIR_NAME}.zip.download`);
  mkdirSync(cacheRoot, { recursive: true });

  let archiveValidated = false;
  try {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(partialZipPath, { force: true });

    const hasCachedArchive = existsSync(zipPath);
    if (hasCachedArchive) {
      onStatus?.("Download completo do Chromium encontrado. Retomando instalacao...");
    } else {
      await downloadChromiumArchive(zipPath, partialZipPath, onStatus);
    }

    try {
      await extractChromiumArchive(zipPath, tempRoot, onStatus);
    } catch (error) {
      if (!hasCachedArchive) {
        throw error;
      }

      onStatus?.("Cache anterior do Chromium esta incompleto. Baixando novamente...");
      rmSync(zipPath, { force: true });
      await downloadChromiumArchive(zipPath, partialZipPath, onStatus);
      await extractChromiumArchive(zipPath, tempRoot, onStatus);
    }
    archiveValidated = true;

    rmSync(installRoot, { recursive: true, force: true });
    renameSync(tempRoot, installRoot);
    rmSync(zipPath, { force: true });
  } catch (error) {
    if (!archiveValidated) {
      rmSync(zipPath, { force: true });
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Nao foi possivel instalar o Chromium oficial automaticamente. ${detail}`);
  } finally {
    rmSync(partialZipPath, { force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
};

const ensureStandardChromiumExecutablePath = async (
  onStatus?: (message: string) => void
): Promise<string> => {
  const existing = resolveStandardChromiumExecutablePath();
  if (existing) {
    return existing;
  }

  onStatus?.("Chromium padrao nao encontrado. Instalando runtime de navegacao...");
  chromiumInstallPromise ??= installManagedChromium(onStatus).finally(() => {
    chromiumInstallPromise = undefined;
  });
  await chromiumInstallPromise;

  const installed = resolveStandardChromiumExecutablePath();
  if (!installed) {
    throw new Error(
      "Chromium foi instalado, mas chrome.exe nao foi localizado. Defina PREDATOR_CHROMIUM_PATH apontando para chrome.exe."
    );
  }

  onStatus?.("Chromium padrao instalado e pronto.");
  return installed;
};

const resolveBrowserLaunchTargets = async (
  _settings: AppSettings,
  onStatus?: (message: string) => void
): Promise<BrowserLaunchTarget[]> => {
  try {
    const executablePath = await ensureStandardChromiumExecutablePath(onStatus);
    return [{ executablePath, label: "Chromium padrao" }];
  } catch (error) {
    return [
      {
        label: "Chromium padrao",
        missingReason: error instanceof Error ? error.message : String(error)
      }
    ];
  }
};

// Script de stealth avanÃ§ado para ser injetado em todos os contextos (pÃ¡gina, workers, iframes)
const STEALTH_INIT_SCRIPT = `
(() => {
  // Lista UNICA de sinais de automacao/CDP/Playwright.
  const S = [
    '__playwright', '__pw_manual', '__PW_inspect', '__playwrightBinding',
    '__playwright__binding__', '__pwInitScripts', '_webdriver', 'webdriver',
    'domAutomation', 'domAutomationController', '__cdpSession',
    '__playwrightConsole', '__pw_browser_protocol_version',
    'selenium', '__Selenium', '__driver_evaluate', '__execute_evaluate',
    '__unwrapped_evaluate', '__lastScriptResponse', '__Inspector_',
    '__devtools', '__CDP_', 'playwright', 'pw', '__predatorRuntimeControlsInstalled',
    '__chromeRemoteSessionId', '__crdp_', '__crdpsession', '__CDPSession',
    '__devtoolsProtocol', '__inspector', '__protocol', '__remoteDebuggingPort',
    '__wsEndpoint', '__browserURL', '__pageTarget', '__targetInfo',
    '__sessionId', '__method', '__params', '__result', '__error', '__id',
    '__pw_channel', '__cdpChannel', '__automationChannel',
    '__pw_tracker', '__pw_recorder', '__pw_connection',
    '__pw_channel_main', '__pw_guid', '__pw_objectRegistry', '__pw_eventListeners',
    '__pw_context', '__pw_frame', '__pw_page', '__pw_browser', '__pw_selectors',
    '__pw_stack', '__pw_callLog', '__pw_actionability', '__pw_waitFor',
    '__pw_timeout', '__pw_retry', '__pw_attempts', '__pw_force',
    '__pw_noWaitAfter', '__pw_timeoutSetting', '__pw_screenshot', '__pw_video',
    '__pw_har', '__pw_trace', '__pw_route', '__pw_request', '__pw_response',
    '__pw_download', '__pw_upload', '__pw_fileChooser', '__pw_dialog',
    '__pw_console', '__pw_debug', '__pw_log', '__pw_error', '__pw_warning',
    '__pw_info', '__pw_verbose', '__pw_silent', '__pw_quiet', '__pw_debugger',
    '__pw_devtools', '__pw_inspector', '__pw_protocol', '__pw_cdp',
    '__pw_cdpSession', '__pw_cdpConnection', '__pw_cdpClient', '__pw_cdpServer',
    '__pw_cdpEndpoint', '__pw_cdpUrl', '__pw_cdpPort', '__pw_cdpHost',
    '__pw_cdpPath', '__pw_cdpQuery', '__pw_cdpFragment', '__pw_cdpUsername',
    '__pw_cdpPassword', '__pw_cdpAuth', '__pw_cdpCredentials', '__pw_cdpToken',
    '__pw_cdpKey', '__pw_cdpSecret', '__pw_cdpApiKey', '__pw_cdpApiSecret',
    '__pw_cdpApiToken', '__pw_cdpApiKeySecret', '__pw_cdpApiKeyId',
    '__pw_cdpApiKeyName', '__pw_cdpApiKeyValue', '__pw_cdpApiKeyType',
    '__pw_cdpApiKeyIdType', '__pw_cdpApiKeyIdName', '__pw_cdpApiKeyIdValue',
    '__pw_fetch', '__pw_network', '__pw_input', '__pw_touchscreen',
    '__pw_keyboard', '__pw_mouse', '__pw_clipboard', '__pw_permissions',
    '__pw_storage', '__pw_cookies', '__pw_cache', '__pw_indexeddb',
    '__pw_websql', '__pw_localstorage', '__pw_sessionstorage', '__pw_webgl',
    '__pw_canvas', '__pw_audio', '__pw_media', '__pw_geolocation',
    '__pw_battery', '__pw_networkinfo', '__pw_bluetooth', '__pw_usb',
    '__pw_serial', '__pw_hid', '__pw_nfc', '__pw_payment',
    '__pw_credential', '__pw_identity', '__pw_share', '__pw_clipboardread',
    '__pw_clipboardwrite', '__pw_backgroundfetch', '__pw_backgroundsync',
    '__pw_push', '__pw_notification', '__pw_midi', '__pw_camera',
    '__pw_microphone', '__pw_speaker', '__pw_display', '__pw_wake lock',
    '__pw_screenwake', '__pw_idle', '__pw_reporting', '__pw_performance',
    '__pw_navigation', '__pw_painttiming', '__pw_largestcontentfulpaint',
    '__pw_firstinputdelay', '__pw_cumulativelayoutshift', '__pw_layoutinstability',
    '__pw_longtask', '__pw_eventcounts', '__pw_goodbadspeedratio',
    '__pw_experimentalfeature', '__pw_origintrial', '__pw_deprecation',
    '__pw_intervention', '__pw_errorreporting', '__pw_crashreporting',
    '__pw_analytics', '__pw_measurement', '__pw_tracking', '__pw_fingerprint',
    '__pw_telemetry', '__pw_diagnostic', '__pw_debugging', '__pw_testing',
    '__pw_qa', '__pw_automation', '__pw_bot', '__pw_crawler', '__pw_scraper',
    '__pw_spider', '__pw_robot', '__pw_headless', '__pw_automated'
  ];

  const isSuspicious = (k) => {
    const s = String(k);
    return S.includes(s) || s.includes('pw_') || s.includes('playwright') || s.includes('cdp') || s.includes('automation');
  };

  const purge = (scope) => {
    if (!scope) return;
    for (const k of S) {
      try { if (scope[k] !== undefined) delete scope[k]; } catch {}
    }
  };

  // === LIMPEZA IMEDIATA: window + Window.prototype + navigator.webdriver ===
  purge(typeof window !== 'undefined' ? window : undefined);
  try { purge(typeof Window !== 'undefined' ? Window.prototype : undefined); } catch {}
  try { delete navigator.webdriver; } catch {}

  // === ORIENTACAO MOBILE ===
  try {
    const isMobileLike = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(navigator.userAgent)
      || (navigator.maxTouchPoints && navigator.maxTouchPoints > 1);

    if (isMobileLike) {
      const portraitOrientation = {
        type: 'portrait-primary',
        angle: 0,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false
      };

      const patchOrientationObject = (orientation) => {
        if (!orientation || typeof orientation !== 'object') return;
        try { Object.defineProperty(orientation, 'type', { configurable: true, get: () => 'portrait-primary' }); } catch {}
        try { Object.defineProperty(orientation, 'angle', { configurable: true, get: () => 0 }); } catch {}
      };

      patchOrientationObject(screen && screen.orientation);

      try {
        if (typeof ScreenOrientation !== 'undefined' && ScreenOrientation.prototype) {
          Object.defineProperty(ScreenOrientation.prototype, 'type', { configurable: true, get: () => 'portrait-primary' });
          Object.defineProperty(ScreenOrientation.prototype, 'angle', { configurable: true, get: () => 0 });
        }
      } catch {}

      try { Object.defineProperty(screen, 'orientation', { configurable: true, get: () => portraitOrientation }); } catch {}
      try {
        if (typeof Screen !== 'undefined' && Screen.prototype) {
          Object.defineProperty(Screen.prototype, 'orientation', { configurable: true, get: () => portraitOrientation });
        }
      } catch {}

      Object.defineProperty(window, 'orientation', { configurable: true, get: () => 0 });
      Object.defineProperty(window, 'onorientationchange', { configurable: true, writable: true, value: null });

      const nativeMatchMedia = window.matchMedia ? window.matchMedia.bind(window) : undefined;
      if (nativeMatchMedia) {
        const buildOrientationQuery = (query, matches) => {
          const mediaQuery = nativeMatchMedia(query);
          try {
            Object.defineProperty(mediaQuery, 'matches', { configurable: true, get: () => matches });
            return mediaQuery;
          } catch {
            return {
              media: String(query), matches, onchange: null,
              addEventListener: () => undefined, removeEventListener: () => undefined,
              addListener: () => undefined, removeListener: () => undefined,
              dispatchEvent: () => false
            };
          }
        };

        window.matchMedia = (query) => {
          const q = String(query).toLowerCase().replace(/\\s+/g, '');
          if (q.includes('orientation:portrait')) return buildOrientationQuery(query, true);
          if (q.includes('orientation:landscape')) return buildOrientationQuery(query, false);
          return nativeMatchMedia(query);
        };
      }
    }
  } catch {}

  // === CANVAS FINGERPRINT NOISE ===
  try {
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    let noiseApplied = false;
    CanvasRenderingContext2D.prototype.getImageData = function(sx, sy, sw, sh) {
      const imageData = origGetImageData.call(this, sx, sy, sw, sh);
      if (!noiseApplied && imageData.data.length > 0) {
        noiseApplied = true;
        const seed = Math.random() * 1000;
        for (let i = 0; i < imageData.data.length; i += 4) {
          if (Math.random() < 0.001) {
            const n = Math.sin(seed + i) * 2;
            imageData.data[i] = Math.min(255, Math.max(0, imageData.data[i] + n));
            imageData.data[i + 1] = Math.min(255, Math.max(0, imageData.data[i + 1] + n));
            imageData.data[i + 2] = Math.min(255, Math.max(0, imageData.data[i + 2] + n));
          }
        }
      }
      return imageData;
    };
  } catch {}

  // === AUDIO FINGERPRINT NOISE ===
  try {
    if (typeof AudioContext !== 'undefined') {
      const origGetByteFreq = AnalyserNode.prototype.getByteFrequencyData;
      AnalyserNode.prototype.getByteFrequencyData = function(array) {
        const result = origGetByteFreq.call(this, array);
        if (array && array.length > 0) {
          for (let i = 0; i < array.length; i++) {
            if (Math.random() < 0.01) {
              array[i] = Math.min(255, Math.max(0, array[i] + (Math.random() - 0.5) * 2));
            }
          }
        }
        return result;
      };
    }
  } catch {}

  // === WORKER SCOPE ===
  if (typeof WorkerGlobalScope !== 'undefined') {
    try {
      purge(self);

      const origNav = Object.getPrototypeOf(self).navigator || navigator;
      const navProxy = new Proxy(origNav, {
        get(target, prop) {
          if (prop === 'plugins') return [];
          if (prop === 'mimeTypes') return [];
          if (prop === 'userAgent') return target.userAgent || navigator.userAgent;
          if (prop === 'languages') return navigator.languages || ['en-US'];
          if (prop === 'language') return navigator.language || 'en-US';
          const value = target[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        },
        has(target, prop) {
          return isSuspicious(prop) ? false : prop in target;
        },
        ownKeys(target) {
          return Reflect.ownKeys(target).filter(k => !isSuspicious(k));
        },
        getOwnPropertyDescriptor(target, prop) {
          return isSuspicious(prop) ? undefined : Reflect.getOwnPropertyDescriptor(target, prop);
        }
      });

      Object.defineProperty(self, 'navigator', { value: navProxy, configurable: true, writable: false });
      try { purge(self.__proto__); } catch {}
      if (typeof window !== 'undefined' && window !== self) purge(window);
    } catch {}
  }

  // === CONSOLE FILTER ===
  try {
    const origLog = console.log;
    console.log = function(...args) {
      if (args.some(a => typeof a === 'string' && (a.includes('playwright') || a.includes('pw:')))) return;
      origLog.apply(console, args);
    };
  } catch {}

  // === POSTMESSAGE FILTER ===
  try {
    if (window.postMessage) {
      const origPostMessage = window.postMessage;
      window.postMessage = function(message, targetOrigin, transfer) {
        if (typeof message === 'string' && (message.includes('__pw_') || message.includes('playwright'))) return;
        return origPostMessage.call(this, message, targetOrigin, transfer);
      };
    }
  } catch {}

  // === TOUCH SUPPORT ===
  if (!('ontouchstart' in window)) {
    try { Object.defineProperty(window, 'ontouchstart', { value: null, writable: true, configurable: true }); } catch {}
  }
  if (navigator.maxTouchPoints === undefined) {
    try { Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true }); } catch {}
  }

  // === CONNECTION INFO ===
  if (navigator.connection) {
    try {
      const conn = navigator.connection;
      if (!conn.effectiveType) Object.defineProperty(conn, 'effectiveType', { get: () => '4g', configurable: true });
      if (!conn.rtt) Object.defineProperty(conn, 'rtt', { get: () => 50 + Math.floor(Math.random() * 100), configurable: true });
      if (!conn.downlink) Object.defineProperty(conn, 'downlink', { get: () => 10 + Math.random() * 5, configurable: true });
    } catch {}
  }
})();
`;

export class BrowserRuntimeService {
  private readonly handles = new Map<string, RuntimeHandle>();
  private selectedWindowState: RuntimeControlSelectionState = { mode: "all" };
  private mirrorTargetSelection: RuntimeControlTargetSelection = { mode: "all" };
  private readonly mirrorSlotNumbers = new Set<number>();
  private readonly runtimePageHooks = new WeakSet<Page>();
  private readonly mirrorBindingContexts = new WeakSet<BrowserContext>();
  private readonly popupCloserPageOverrides = new WeakMap<Page, boolean>();
  // Loop Node-driven do popup killer: o runtime varre/remove os popups via
  // page.evaluate() de fora (mecanismo confiavel, igual ao deposito), em vez de
  // depender so do script injetado. Um timer por pagina enquanto habilitado.
  private readonly nodePopupKillerTimers = new Map<Page, ReturnType<typeof setInterval>>();
  private static readonly NODE_POPUP_SWEEP_MS = 400;
  // Frente B (cutover): o script do popup-killer é entregue SOMENTE via payload
  // servido (cifrado por device) — não está mais embutido no binário. `null` =
  // ainda não recebido (ou indisponível offline/não semeado) -> a varredura é
  // pulada. Degrada só este recurso; nunca derruba a operação.
  private servedPopupSweepScript: string | null = null;
  private readonly userAgentOverrideSessions = new WeakMap<Page, CDPSession>();
  private readonly gameTouchEmulationSessions = new WeakMap<Page, CDPSession>();
  private readonly gameTouchEmulationState = new WeakMap<Page, boolean>();
  private readonly touchEmulationWatchdogs = new WeakMap<Page, NodeJS.Timeout>();
  private readonly runtimeNewDocumentSessions = new WeakMap<Page, CDPSession>();
  private readonly runtimeNewDocumentScriptIds = new WeakMap<Page, string>();
  private readonly runtimeNewDocumentRates = new WeakMap<Page, number>();
  // Espelho (mirror): sessao CDP por pagina (reusada para registrar o script de
  // captura via Page.addScriptToEvaluateOnNewDocument E para o replay via Input.*),
  // id do script de captura registrado, ultimo estado enabled embutido nele, e o
  // viewport (innerWidth/innerHeight) do destino em cache para converter ratio->px
  // sem um evaluate por evento. Tudo invalidado na navegacao do frame principal.
  private readonly mirrorSessions = new WeakMap<Page, CDPSession>();
  private readonly mirrorCaptureScriptIds = new WeakMap<Page, string>();
  private readonly mirrorCaptureEnabledState = new WeakMap<Page, boolean>();
  private readonly mirrorViewportCache = new WeakMap<Page, { width: number; height: number }>();
  // Fila de replay por pagina: serializa os dispatches CDP para preservar a ORDEM
  // exata dos eventos (press -> move -> ... -> release). Sem isso os handlers async
  // do binding corriam em paralelo e invertiam a ordem, quebrando drag e scroll.
  private readonly mirrorReplayChains = new WeakMap<Page, Promise<void>>();
  private readonly mirrorReplayProfileChains = new Map<string, Promise<void>>();
  private readonly mirrorReplayMarkedPages = new WeakSet<Page>();
  private readonly mirrorReplayClearTimers = new WeakMap<Page, ReturnType<typeof setTimeout>>();
  private readonly mirrorTouchActive = new WeakMap<Page, boolean>();
  private readonly contextSpeedRates = new WeakMap<BrowserContext, number>();
  private readonly launchingSlotIndexes = new Set<number>();
  private readonly activeSplashes = new Map<string, string>();
  private activeScreenLayout?: ScreenLayoutSettings;
  private screenLayoutRevision = 0;
  private mirrorEnabled = false;
  // Cada chamada do IPC espera sua propria transicao terminar. Isto evita que um
  // toggle novo "herde" a Promise de um sweep antigo e a UI confirme o estado cedo.
  private mirrorTransition: Promise<void> = Promise.resolve();
  private mirrorRequestSequence = 0;
  // Eventos sinteticos bloqueiam apenas o perfil de destino. Assim o operador
  // pode trocar rapidamente a janela-fonte sem ser confundido com um eco.
  private readonly mirrorReplayBlockedUntil = new Map<string, number>();
  private static readonly MIRROR_REPLAY_CLEAR_DELAY_MS = 350;
  private autoClosePopupsDuringNavigation = false;
  private accountInfoOverlayEnabled = false;
  // Bloqueio de dominios (corta transmissoes ao vivo/recursos de fundo que drenam o proxy).
  // Lidos AO VIVO dentro da rota registrada por contexto, entao o setter afeta requisicoes
  // novas sem reiniciar o navegador. Casamento por hostname (dominio + subdominios).
  private domainBlockEnabled = true;
  private blockedDomains: string[] = [];
  // Campos atuais do overlay de dados da conta, por profileId. O init script (addInitScript)
  // assa os campos do momento do launch e re-roda a cada navegacao; sem isto, qualquer dado
  // atualizado depois (ex.: senha de saque/chave PIX apos o cadastro) some ao navegar. Mantemos
  // a versao viva aqui e re-aplicamos em applyRuntimeStateToPage apos cada load/navegacao.
  private latestAccountInfoFields = new Map<string, Array<{ label: string; value: string }>>();
  private defaultSpeedRate = 1;

  // Escalonador do lancamento em massa: no maximo N navegadores subindo ao mesmo
  // tempo. Abrir todas as janelas headed (GPU/WebGL) de uma vez satura CPU/GPU e
  // faz jogos "travarem carregando"; com o semaforo elas sobem em ondas.
  private readonly launchSemaphore = new AsyncSemaphore(resolveMaxConcurrentLaunches());

  // Frames de jogo cuja carga ja esta sendo monitorada (evita monitores duplicados
  // por navegacao/evento). Chaveado por Frame; entradas somem quando o frame e GC'd.
  private readonly gameFrameLoadMonitors = new WeakSet<object>();

  constructor(private readonly notify: RuntimeNotifier) {
    appendInputDiagnostic({
      kind: "diagnostic-session-start",
      pid: process.pid
    });
  }

  private attachContextCloseHandler(
    profileId: string,
    context: BrowserContext,
    proxyChain?: ProxyChainService
  ): void {
    context.on("close", () => {
      appendInputDiagnostic({
        kind: "browser-context-close",
        profileId
      });
      this.activeSplashes.delete(profileId);
      this.mirrorReplayProfileChains.delete(profileId);
      this.handles.delete(profileId);
      this.disableMirrorForUnavailableTargets("browser-context-close");
      void proxyChain?.stop().catch(() => undefined);
      this.notify(profileId, "idle", "🧹 Navegador fechado.");
    });
  }

  async ensureBrowserRuntime(onStatus?: (message: string) => void): Promise<void> {
    await ensureStandardChromiumExecutablePath(onStatus);
  }

  setScreenLayout(layout: ScreenLayoutSettings): void {
    this.activeScreenLayout = this.cloneScreenLayout(layout);
    this.screenLayoutRevision += 1;
  }

  async launchProfile(
    profile: ProfileSummary,
    settings: AppSettings,
    options?: { deferNavigation?: boolean }
  ): Promise<void> {
    appendInputDiagnostic({
      kind: "profile-launch-start",
      profileId: profile.id,
      homeUrl: sanitizeDiagnosticUrl(profile.homeUrl)
    });
    if (this.handles.has(profile.id)) {
      this.notify(profile.id, "active", "ðŸŒ Navegador jÃ¡ estava aberto.");
      return;
    }

    this.notify(profile.id, "launching", "ðŸš€ Abrindo navegador isolado...");

    const launchTargets = await resolveBrowserLaunchTargets(settings, (message) => {
      this.notify(profile.id, "launching", message);
    });
    const browserLabel = launchTargets[0]?.label ?? "Browser";

    const launchProxy = await this.resolveLaunchProxy(profile);
    const navigationMode = this.resolveNavigationMode(profile);
    let placement = this.buildBrowserPlacement(this.resolvePlacementSettings(settings));
    let placementRevision = this.screenLayoutRevision;
    const refreshPlacementFromLatestLayout = () => {
      if (placementRevision === this.screenLayoutRevision) {
        return;
      }

      this.launchingSlotIndexes.delete(placement.slotIndex);
      placement = this.buildBrowserPlacement(this.resolvePlacementSettings(settings));
      placementRevision = this.screenLayoutRevision;
      this.launchingSlotIndexes.add(placement.slotIndex);
    };

    this.launchingSlotIndexes.add(placement.slotIndex);
    this.autoClosePopupsDuringNavigation = settings.autoClosePopupsDuringNavigation;
    this.domainBlockEnabled = settings.domainBlockEnabled ?? true;
    this.blockedDomains = settings.blockedDomains ?? [];
    const profileLocale = resolveProfileLocale(profile.persona);
    const profileLanguages = buildNavigatorLanguages(profileLocale);
    const profileUserAgent = resolveProfileUserAgent(profile.persona.userAgent);
    const mobileEmulation = this.buildMobileEmulationConfig(profile, navigationMode);
    const resolvedUserAgent = mobileEmulation?.userAgent ?? profileUserAgent;
    const mobileLike = Boolean(mobileEmulation);
    const userAgentOverride = resolvedUserAgent
      ? {
          userAgent: resolvedUserAgent,
          userAgentMetadata: mobileEmulation?.userAgentMetadata ?? this.buildUserAgentMetadata(resolvedUserAgent)
        }
      : undefined;
    const fingerprintConfig = buildFingerprintConsistencyConfig(
      resolvedUserAgent,
      profileLanguages,
      navigationMode,
      userAgentOverride?.userAgentMetadata,
      mobileEmulation?.hardware
    );
    if (mobileEmulation) {
      this.notify(
        profile.id,
        "launching",
        `📱 Emulando dispositivo: ${mobileEmulation.deviceLabel}`
      );
    }
    if (placement.idealScale < 1) {
      const layoutDisplayScale = this.resolveLayoutDisplay(
        this.resolvePlacementSettings(settings).screenLayout
      ).scaleFactor;
      const reportedDpr =
        Number.isFinite(layoutDisplayScale) && layoutDisplayScale > 0 ? layoutDisplayScale : 1;
      fingerprintConfig.devicePixelRatio = reportedDpr;
      fingerprintConfig.screenDimensionScale = placement.idealScale / reportedDpr;
    }
    this.prepareBrowserPreferences(profile.storagePath, profile.persona.webRtcMode);
    const launchedScale = placement.idealScale;
    const windowGeometry = toChromiumWindowGeometry(
      placement,
      launchedScale,
      () => appendInputDiagnostic({
        kind: "invalid-window-interface-scale",
        profileId: profile.id,
        slotIndex: placement.slotIndex,
        effectiveScale: launchedScale
      })
    );
    // Escala efetivamente passada nos args; force-device-scale-factor nao muda em runtime, entao todo
    // reposicionamento desta janela usa esta escala mesmo que a grade mude durante a abertura.
    const args = this.mergeDisableFeatureArgs([
      ...profile.persona.launchArgs.filter(
        (arg) =>
          !arg.startsWith("--window-position") &&
          !arg.startsWith("--window-size") &&
          !arg.startsWith("--force-device-scale-factor") &&
          !arg.startsWith("--high-dpi-support") &&
          !arg.startsWith("--lang=") &&
          !arg.startsWith("--accept-lang=") &&
          !arg.startsWith("--user-agent=") &&
          !arg.startsWith("--app=") &&
          !arg.startsWith("--proxy-server") &&
          !arg.startsWith("--proxy-pac-url") &&
          !arg.startsWith("--proxy-bypass-list") &&
          !arg.startsWith("--proxy-auto-detect") &&
          !arg.startsWith("--no-proxy-server") &&
          !arg.startsWith(AUTOMATION_CONTROLLED_ARG) &&
          !arg.startsWith(NAVIGATION_MODE_LAUNCH_ARG_PREFIX)
      ),
      ...this.buildFingerprintArgs(profile),
      `--lang=${profileLocale}`,
      `--accept-lang=${profileLanguages.join(",")}`,
      ...(resolvedUserAgent ? [`--user-agent=${resolvedUserAgent}`] : []),
      `--window-position=${windowGeometry.x},${windowGeometry.y}`,
      `--window-size=${windowGeometry.width},${windowGeometry.height}`,
      ...(launchedScale < 1
        ? [`--force-device-scale-factor=${launchedScale}`, "--high-dpi-support=1"]
        : []),
      ...(launchProxy.proxy ? [WEBRTC_PROXIED_UDP_ONLY_ARG] : []),
      ...this.buildHostRulesArgs()
    ]);
    const chromium = patchrightChromium;

    const launchOptions = {
      headless: false,
      chromiumSandbox: true,
      ignoreDefaultArgs: ["--enable-automation"],
      proxy: launchProxy.proxy,
      timezoneId: profile.persona.timezone,
      ...(resolvedUserAgent ? { userAgent: resolvedUserAgent } : {}),
      viewport: null,
      ...(mobileEmulation
        ? {
            hasTouch: true
          }
        : {}),
      geolocation: profile.persona.geolocation,
      serviceWorkers: "block",
      args
    } satisfies BrowserLaunchOptions;

    // Escalona o lancamento pesado (launch + boot da SPA): so N janelas sobem ao
    // mesmo tempo. As demais esperam aqui em fila, evitando o pico de CPU/GPU que
    // faz os jogos travarem carregando. Liberado assim que a navegacao inicial
    // termina (o resto e bookkeeping barato) e em qualquer caminho de erro.
    const releaseLaunchSlot = await this.launchSemaphore.acquire();
    let launchSlotReleased = false;
    const releaseLaunchSlotOnce = () => {
      if (launchSlotReleased) {
        return;
      }
      launchSlotReleased = true;
      releaseLaunchSlot();
    };

    let context: BrowserContext | undefined;
    let lastLaunchError: unknown;

    for (let index = 0; index < launchTargets.length; index += 1) {
      const launchTarget = launchTargets[index];
      if (!launchTarget) {
        continue;
      }

      if (launchTarget.missingReason) {
        lastLaunchError = new Error(launchTarget.missingReason);
        this.notify(profile.id, "launching", launchTarget.missingReason);
        continue;
      }

      try {
        context = await chromium.launchPersistentContext(
          profile.storagePath,
          launchTarget.executablePath
            ? { ...launchOptions, executablePath: launchTarget.executablePath }
            : launchOptions
        );
        break;
      } catch (error) {
        lastLaunchError = error;
        const nextTarget = launchTargets[index + 1];

        if (nextTarget && !nextTarget.missingReason) {
          this.notify(
            profile.id,
            "launching",
            `${launchTarget.label} nao esta disponivel; tentando ${nextTarget.label}.`
          );
        }
      }
    }

    if (!context) {
      releaseLaunchSlotOnce();
      this.launchingSlotIndexes.delete(placement.slotIndex);
      await launchProxy.proxyChain?.stop().catch(() => undefined);
      const detail = lastLaunchError instanceof Error ? lastLaunchError.message : String(lastLaunchError);
      this.notify(
        profile.id,
        "error",
        `${browserLabel} nao ficou disponivel. ${detail}`
      );
      throw lastLaunchError;
    }

    let primaryPage: Page | undefined;
    try {
    refreshPlacementFromLatestLayout();
    const extraHeaders: Record<string, string> = {
      ...Object.fromEntries(
        profile.persona.headers
          .filter((entry) => entry.key.toLowerCase() !== "accept-language")
          .map((entry) => [entry.key, entry.value])
      ),
      "Accept-Language": buildAcceptLanguageHeader(profileLanguages)
    };
    await context.setExtraHTTPHeaders(extraHeaders);

    this.contextSpeedRates.set(context, this.defaultSpeedRate);

    // --- Rota combinada (1 IPC em vez de 3) ---
    await this.installCombinedRoute(context, fingerprintConfig);

    // --- Init scripts combinados (1 IPC em vez de 9) ---
    // O removePlaywrightSignals avulso foi removido: STEALTH_INIT_SCRIPT ja cobre
    // todos os sinais. O installRuntimeControlsInitScript (mundo isolado) foi
    // removido: nenhum codigo externo invocava __predatorApplySpeedHack nesse
    // mundo; o speed hack real e entregue via CDP main world (pgGameOnly).
    this.latestAccountInfoFields.set(profile.id, this.buildAccountInfoFields(profile));
    {
      const logoDataUrl = getSplashLogoDataUrl();
      const scripts: string[] = [
        this.buildFingerprintConsistencyScript(fingerprintConfig),
        STEALTH_INIT_SCRIPT,
        this.buildServiceWorkerCleanupScript(),
        this.buildInputDiagnosticsScript(),
        this.buildBadgesScript(profile.id, placement, launchedScale, launchProxy.ipLabel),
        this.buildSplashOverlayScript(logoDataUrl),
      ];
      const accountInfoScript = this.buildAccountInfoScript(profile);
      if (accountInfoScript) scripts.push(accountInfoScript);
      await context.addInitScript(scripts.join("\n"));
    }

    await context
      .exposeBinding("__spiderInputDiagnostic", (source, payload: unknown) => {
        appendInputDiagnostic({
          profileId: profile.id,
          pageUrl: sanitizeDiagnosticUrl(source.page.url()),
          frameUrl: sanitizeDiagnosticUrl(source.frame.url()),
          ...(payload && typeof payload === "object"
            ? payload as Record<string, unknown>
            : { kind: "invalid-binding-payload" })
        });
      })
      .catch(() => undefined);
    if (this.mirrorEnabled) {
      await this.installMirrorBinding(profile.id, context);
    }

    primaryPage = await this.createPrimaryRuntimePage(context, settings.autoRestoreSessions);
    refreshPlacementFromLatestLayout();
    await this.applyPlacementToPage(primaryPage, placement, launchedScale).catch(() => null);
    this.attachRuntimePageHandlers(profile.id, primaryPage);
    await this.installRuntimeControlsNewDocumentScript(primaryPage, this.defaultSpeedRate);
    await this.applyPageEnvironmentOverride(primaryPage, userAgentOverride, mobileLike, profileLanguages);
    const deferNavigation = options?.deferNavigation === true;
    if (deferNavigation) {
      // Mantem a pagina em branco ate a automacao ser iniciada pelo batch; o splash
      // sera mostrado em cima. Forca about:blank em qualquer caso (sessao restaurada
      // ou chrome://new-tab-page/) porque o init script do splash NAO roda em URLs
      // chrome://, e isso deixaria a overlay sem ser criada.
      const currentUrl = primaryPage.url();
      if (currentUrl !== "about:blank") {
        await primaryPage.goto("about:blank", { waitUntil: "domcontentloaded" }).catch(() => null);
      }
    } else {
      await primaryPage.goto(profile.homeUrl, {
        waitUntil: "domcontentloaded"
      }).catch(() => null);
    }
    // Boot pesado concluido: libera o slot para a proxima janela subir. O que
    // resta (badges, handlers, registro do handle) e barato e nao contende GPU.
    releaseLaunchSlotOnce();
    const visibleIp = await this.resolveVisibleIp(primaryPage, launchProxy.ipLabel);
    await this.updateContextBadges(profile.id, context, placement, launchedScale, visibleIp);
    await this.applySpeedToPage(primaryPage, this.defaultSpeedRate);
    await this.applyMirrorConfigToPage(primaryPage);
    await this.applyPopupCloserConfigToPage(primaryPage);

    // === DIAGNOSTICO TEMPORARIO (REMOVER) ===
    void this.diagnoseChromeAndWorker(profile.id, primaryPage).catch(() => null);

    context.on("page", (page) => {
      this.attachRuntimePageHandlers(profile.id, page);
      this.markRuntimePageActive(profile.id, page, "context-page");
      void this.installRuntimeControlsNewDocumentScript(page, this.defaultSpeedRate);
      void this.applyPageEnvironmentOverride(page, userAgentOverride, mobileLike, profileLanguages);
      void page
        .waitForLoadState("domcontentloaded", { timeout: 15000 })
        .catch(() => null)
        .then(async () => {
          const handle = this.handles.get(profile.id);
          if (handle) {
            await this.applyRuntimeStateToPage(handle, page);
          } else {
            await this.applyBadgeToPage(page, profile.id, placement, launchedScale, visibleIp);
            await this.applySpeedToPage(page, this.defaultSpeedRate);
            await this.applyMirrorConfigToPage(page);
            await this.applyPopupCloserConfigToPage(page);
          }
        });
    });

    this.attachContextCloseHandler(profile.id, context, launchProxy.proxyChain);

    refreshPlacementFromLatestLayout();
    await this.applyPlacementToPage(primaryPage, placement, launchedScale).catch(() => null);
    this.handles.set(profile.id, {
      profileId: profile.id,
      context,
      storagePath: profile.storagePath,
      primaryPage,
      pageOrder: [primaryPage],
      slotIndex: placement.slotIndex,
      placement,
      launchedScale,
      ipLabel: visibleIp,
      homeUrl: profile.homeUrl,
      speedRate: this.defaultSpeedRate,
      navigationRunId: 0,
      mobileLike,
      ...(launchProxy.proxyChain ? { proxyChain: launchProxy.proxyChain } : {}),
      ...(deferNavigation ? { pendingNavigation: { homeUrl: profile.homeUrl } } : {})
    });
    appendInputDiagnostic({
      kind: "profile-launch-ready",
      profileId: profile.id,
      pageUrl: sanitizeDiagnosticUrl(primaryPage.url())
    });
    this.launchingSlotIndexes.delete(placement.slotIndex);
    } catch (error) {
      releaseLaunchSlotOnce();
      this.launchingSlotIndexes.delete(placement.slotIndex);
      await launchProxy.proxyChain?.stop().catch(() => undefined);
      await context.close().catch(() => null);
      throw error;
    }
    const handle = this.handles.get(profile.id);
    if (handle && primaryPage) {
      await this.applyRuntimeStateToPage(handle, primaryPage);
    }
    this.notify(profile.id, "active", "ðŸŒ Navegador aberto e pronto.");
  }

  /**
   * Mantem a homeUrl do handle em memoria em sincronia com o banco. Necessario
   * quando a plataforma redireciona para outro host durante o cadastro: sem isso
   * o botao "Pagina inicial" continuaria navegando para a URL antiga ate a
   * janela ser fechada e reaberta.
   */
  updateProfileHomeUrl(profileId: string, homeUrl: string): void {
    const handle = this.handles.get(profileId);
    if (!handle) {
      return;
    }
    handle.homeUrl = homeUrl;
    if (handle.pendingNavigation) {
      handle.pendingNavigation = { homeUrl };
    }
  }

  async stopProfile(profileId: string): Promise<void> {
    const handle = this.handles.get(profileId);
    if (!handle) {
      this.notify(profileId, "idle", "ðŸ§¹ Navegador jÃ¡ estava fechado.");
      return;
    }

    this.notify(profileId, "stopping", "â¹ï¸ Fechando navegador...");

    // O teto cobre paginas E contexto. Se qualquer etapa travar, o kill continua
    // escopado ao user-data-dir deste perfil — nunca aos demais.
    await closeProfileBrowser(handle);
    this.handles.delete(profileId);
    this.disableMirrorForUnavailableTargets("profile-stopped");
    this.latestAccountInfoFields.delete(profileId);
    this.notify(profileId, "idle", "ðŸ§¹ Navegador fechado.");
  }

  async restartProfile(profile: ProfileSummary, settings: AppSettings): Promise<void> {
    await this.stopProfile(profile.id);
    await this.launchProfile(profile, settings);
  }

  async applyLayout(settings: AppSettings): Promise<void> {
    this.setScreenLayout(settings.screenLayout);
    const handles = [...this.handles.entries()].sort(([, a], [, b]) => a.slotIndex - b.slotIndex);
    const effectiveLayout = normalizeScreenLayout(settings.screenLayout);
    const allocationSlotCount = Math.max(
      getScreenLayoutSlotCount(effectiveLayout),
      handles.length
    );
    const takenSlots = new Set<number>();

    for (const [profileId, handle] of handles) {
      let slot = -1;
      for (let candidate = 0; candidate < allocationSlotCount; candidate += 1) {
        if (!takenSlots.has(candidate)) {
          slot = candidate;
          break;
        }
      }
      if (slot === -1) {
        slot = takenSlots.size;
      }
      takenSlots.add(slot);

      const placement = this.buildBrowserPlacement(this.resolvePlacementSettings(settings), slot);
      const page =
        !handle.primaryPage.isClosed()
          ? handle.primaryPage
          : handle.context.pages().find((entry) => !entry.isClosed());

      if (!page) {
        continue;
      }

      const boundsApplied = await this.applyPlacementToPage(
        page,
        placement,
        handle.launchedScale
      );
      this.mirrorViewportCache.delete(page);
      await this.updateContextBadges(
        handle.profileId,
        handle.context,
        placement,
        handle.launchedScale,
        handle.ipLabel
      ).catch(() => null);
      handle.primaryPage = page;
      handle.slotIndex = placement.slotIndex;
      handle.placement = placement;
      this.notify(
        profileId,
        "active",
        boundsApplied
          ? "Layout de tela aplicado ao navegador."
          : "Layout salvo, mas a janela aberta nao respondeu ao reposicionamento."
      );
    }
  }

  async navigate(
    action: RuntimeControlNavigationAction,
    targetSelection: RuntimeControlTargetSelection,
    searchTerm?: string
  ): Promise<void> {
    const targets = this.resolveTargetHandles(targetSelection);

    await Promise.allSettled(
      targets.map(async ([profileId, handle]) => {
        const page = await this.getRuntimePage(handle);

        if (!page) {
          return;
        }

        const navigationRunId = this.beginNavigationRun(handle);

        if (action === "refresh") {
          await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
          if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
            return;
          }
          await this.applyRuntimeStateToPage(handle, page);
          return;
        }

        if (action === "treasure-chests") {
          await this.navigateToTreasureChestsPage(profileId, handle, page, navigationRunId);
          if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
            return;
          }
          await this.applyRuntimeStateToPage(handle, page);
          return;
        }

        if (action === "bet-report") {
          await this.navigateToBetReportPage(profileId, handle, page, navigationRunId);
          if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
            return;
          }
          await this.applyRuntimeStateToPage(handle, page);
          return;
        }

        if (action === "slot-search") {
          await this.navigateToSlotSearchPage(profileId, handle, page, navigationRunId, searchTerm ?? "");
          if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
            return;
          }
          await this.applyRuntimeStateToPage(handle, page);
          return;
        }

        await this.navigateToHomePage(profileId, handle, page, navigationRunId);
        if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
          return;
        }
        await this.applyRuntimeStateToPage(handle, page);
      })
    );
  }

  async setSelectedWindows(selection: RuntimeControlSelectionState): Promise<void> {
    this.selectedWindowState = this.cloneSelectionState(selection);

    await Promise.allSettled(
      [...this.handles.values()].map((handle) =>
        this.updateContextBadges(
          handle.profileId,
          handle.context,
          handle.placement,
          handle.launchedScale,
          handle.ipLabel
        )
      )
    );
  }

  async setMirrorMode(enabled: boolean, selection: RuntimeControlSelectionState): Promise<void> {
    const requestId = this.mirrorRequestSequence + 1;
    this.mirrorRequestSequence = requestId;
    appendInputDiagnostic({
      kind: "mirror-transition-requested",
      requestId,
      enabled,
      requestedSelection: selection,
      handleCount: this.handles.size
    });

    const transition = this.mirrorTransition
      .catch(() => undefined)
      .then(() => this.performMirrorTransition(requestId, enabled, selection));
    this.mirrorTransition = transition;
    return transition;
  }

  private async performMirrorTransition(
    requestId: number,
    enabled: boolean,
    selection: RuntimeControlSelectionState
  ): Promise<void> {
    if (!enabled) {
      this.mirrorEnabled = false;
      this.mirrorReplayBlockedUntil.clear();
      await this.applyMirrorStateToAllPages(false, false);
      appendInputDiagnostic({
        kind: "mirror-transition-completed",
        requestId,
        enabled: false,
        targetCount: 0
      });
      return;
    }

    const targetSelection = this.requireTargetSelection(selection);
    const targets = this.resolveTargetHandles(targetSelection);
    const nextSelection = this.cloneTargetSelection(targetSelection);
    const nextSlots =
      nextSelection.mode === "windows"
        ? nextSelection.windows.map((windowRef) => windowRef.slotNumber)
        : [];

    try {
      await this.applyMirrorStateToAllPages(true, true);
      this.mirrorTargetSelection = nextSelection;
      this.mirrorSlotNumbers.clear();
      for (const slotNumber of nextSlots) {
        this.mirrorSlotNumbers.add(slotNumber);
      }
      this.mirrorEnabled = true;
      appendInputDiagnostic({
        kind: "mirror-transition-completed",
        requestId,
        enabled: true,
        targetCount: Math.max(0, targets.length - 1),
        selectedProfileIds: targets.map(([profileId]) => profileId),
        normalizedSlots: nextSlots
      });
    } catch (error) {
      this.mirrorEnabled = false;
      this.mirrorReplayBlockedUntil.clear();
      await this.applyMirrorStateToAllPages(false, false).catch(() => undefined);
      appendInputDiagnostic({
        kind: "mirror-transition-rollback",
        requestId,
        enabled: false,
        error: error instanceof Error ? error.message : String(error)
      });
      throw new Error(
        `Nao foi possivel ativar o Modo Espelho: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async applyMirrorStateToAllPages(enabled: boolean, strict: boolean): Promise<void> {
    const handles = [...this.handles.entries()];
    if (enabled) {
      await Promise.all(
        handles.map(([profileId, handle]) =>
          this.installMirrorBinding(profileId, handle.context)
        )
      );
    }

    const processedPages = new Set<Page>();
    const MAX_PASSES = 4;
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const pages = handles.flatMap(([, handle]) =>
        handle.context.pages().filter((page) => !page.isClosed())
      );
      const pendingPages = pages.filter((page) => !processedPages.has(page));
      if (pendingPages.length === 0 && pass >= 2) break;
      await Promise.all(
        pendingPages.map(async (page) => {
          await this.applyMirrorConfigToPage(page, enabled, strict);
          processedPages.add(page);
        })
      );
    }
  }

  private disableMirrorForUnavailableTargets(reason: string): void {
    if (!this.mirrorEnabled) {
      return;
    }

    const selectionUnavailable =
      this.handles.size === 0 ||
      (this.mirrorTargetSelection.mode === "windows" &&
        this.mirrorTargetSelection.windows.some((windowRef) => {
          const handle = this.handles.get(windowRef.profileId);
          return !handle || handle.slotIndex + 1 !== windowRef.slotNumber;
        }));
    if (!selectionUnavailable) {
      return;
    }

    this.mirrorEnabled = false;
    this.mirrorReplayBlockedUntil.clear();
    appendInputDiagnostic({
      kind: "mirror-runtime-auto-disabled",
      reason,
      handleCount: this.handles.size,
      targetSelection: this.mirrorTargetSelection
    });
    void this.applyMirrorStateToAllPages(false, false).catch((error) => {
      appendInputDiagnostic({
        kind: "mirror-runtime-auto-disable-error",
        reason,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  async setSpeed(rate: number, targetSelection: RuntimeControlTargetSelection): Promise<void> {
    const speedRate = this.clampNumber(rate, 1, 25);
    if (targetSelection.mode === "all") {
      this.defaultSpeedRate = speedRate;
    }
    const targets = this.resolveTargetHandles(targetSelection);

    await Promise.allSettled(
      targets.flatMap(([, handle]) => {
        handle.speedRate = speedRate;
        this.contextSpeedRates.set(handle.context, speedRate);
        return handle.context.pages().map((page) => this.applySpeedToPage(page, speedRate));
      })
    );
  }

  getActiveProfileIdsForSelection(targetSelection: RuntimeControlTargetSelection): string[] {
    return this.resolveTargetHandles(targetSelection).map(([profileId]) => profileId);
  }

  getRuntimeWindowTargets(profiles: ProfileSummary[]): RuntimeWindowTarget[] {
    return this.buildRuntimeWindowTargets([...this.handles.values()], profiles);
  }

  resolveRuntimeWindowTargets(
    targetSelection: RuntimeControlTargetSelection,
    profiles: ProfileSummary[]
  ): RuntimeWindowTarget[] {
    const targetHandles = this.resolveTargetHandles(targetSelection).map(([, handle]) => handle);
    return this.buildRuntimeWindowTargets(targetHandles, profiles);
  }

  getSlotIndexForProfile(profileId: string): number | undefined {
    const handle = this.handles.get(profileId);
    return handle?.slotIndex;
  }

  async setAutoClosePopupsDuringNavigation(enabled: boolean): Promise<void> {
    this.autoClosePopupsDuringNavigation = enabled;

    await Promise.allSettled(
      [...this.handles.values()].flatMap((handle) =>
        handle.context.pages().map((page) => this.applyPopupCloserConfigToPage(page))
      )
    );
  }

  // A automacao envolve o Page num Proxy (createLoggedPage). Normalizamos para o page
  // REAL antes de usar como chave de WeakMap/Map -- senao set/delete usam chaves
  // diferentes e o override/loop vaza. Proxy expoe target via __predatorRawPage.
  private unwrapPage(page: Page): Page {
    const raw = (page as unknown as { __predatorRawPage?: Page }).__predatorRawPage;
    return raw ?? page;
  }

  async setPageAutoClosePopups(page: Page, enabled: boolean | undefined): Promise<void> {
    const real = this.unwrapPage(page);
    if (enabled === undefined) {
      this.popupCloserPageOverrides.delete(real);
    } else {
      this.popupCloserPageOverrides.set(real, enabled);
    }

    await this.applyPopupCloserConfigToPage(real);
  }

  async getAutomationSession(profile: ProfileSummary, settings: AppSettings): Promise<AutomationSession> {
    if (!this.handles.has(profile.id)) {
      await this.launchProfile(profile, settings);
    }

    const handle = this.handles.get(profile.id);
    if (!handle) {
      throw new Error(`Profile ${profile.name} could not be launched for automation.`);
    }

    if (handle.pendingNavigation) {
      const targetUrl = handle.pendingNavigation.homeUrl;
      handle.pendingNavigation = undefined;
      const page =
        !handle.primaryPage.isClosed()
          ? handle.primaryPage
          : handle.context.pages().find((entry) => !entry.isClosed()) ?? (await handle.context.newPage());
      handle.primaryPage = page;
      this.attachRuntimePageHandlers(profile.id, page);
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
      await this.applyRuntimeStateToPage(handle, page);
      return {
        context: handle.context,
        page: this.wrapPageForSpeedScaling(handle, page),
        release: async (options) => {
          if (options?.closeBrowser && this.handles.get(profile.id)?.context === handle.context) {
            await this.stopProfile(profile.id);
          }
        }
      };
    }

    const page =
      !handle.primaryPage.isClosed()
        ? handle.primaryPage
        : handle.context.pages().find((entry) => !entry.isClosed()) ?? (await handle.context.newPage());

    handle.primaryPage = page;
    this.attachRuntimePageHandlers(profile.id, page);
    await this.applyRuntimeStateToPage(handle, page);

    return {
      context: handle.context,
      page: this.wrapPageForSpeedScaling(handle, page),
      // Reuse the visible page so the user sees the automation acting on the same
      // form that was just opened for the profile.
      release: async (options) => {
        if (options?.closeBrowser && this.handles.get(profile.id)?.context === handle.context) {
          await this.stopProfile(profile.id);
        }
      }
    };
  }

  // Envolve `waitForTimeout` no objeto Page retornado a automacao para que o
  // "Speed Time" do painel de controle tambem acelere as esperas feitas via
  // Patchright (que usa setTimeout do Node, nao do browser, e portanto nao e
  // afetado pelo speed hack injetado no init script).
  private wrapPageForSpeedScaling(handle: RuntimeHandle, page: Page): Page {
    const originalWaitForTimeout = page.waitForTimeout.bind(page);
    const speedAwarePage = page as Page;
    (speedAwarePage as unknown as {
      waitForTimeout: (timeout?: number) => Promise<void>;
    }).waitForTimeout = (timeout?: number) => {
      const raw = Math.max(0, Number(timeout) || 0);
      const rate = handle.speedRate > 1 ? handle.speedRate : 1;
      return originalWaitForTimeout(Math.round(raw / rate));
    };
    return speedAwarePage;
  }

  isActive(profileId: string): boolean {
    return this.handles.has(profileId);
  }

  async shutdown(): Promise<void> {
    const handles = [...this.handles.entries()];
    for (const [profileId, handle] of handles) {
      // Fecha todas as páginas primeiro
      try {
        const pages = handle.context.pages();
        await Promise.all(
          pages.map(page => page.close({ runBeforeUnload: false }).catch(() => null))
        );
      } catch {}

      // Timeout de 3 segundos para forçar encerramento se necessário. Kill
      // escopado ao user-data-dir deste perfil (nunca aos demais / ao Chrome do usuário).
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          forceKillProfileBrowser(handle.storagePath).catch(() => null);
          resolve();
        }, 3000);

        handle.context.close().finally(() => {
          clearTimeout(timeout);
          resolve();
        }).catch(() => {
          clearTimeout(timeout);
          forceKillProfileBrowser(handle.storagePath).catch(() => null);
          resolve();
        });
      });

      this.handles.delete(profileId);
      this.latestAccountInfoFields.delete(profileId);
      this.notify(profileId, "idle", "ðŸ§¹ Navegador fechado ao encerrar o Spider BOT.");
    }
  }

  async testProxy(proxy: ProxyConfig): Promise<ProxyConfig["status"]> {
    return (await this.probeProxy(proxy)).status;
  }

  // Igual a testProxy, mas devolve tambem o `detail` (codigo HTTP do upstream,
  // mensagem de timeout, etc.) para que o motivo real do "Instavel"/"Offline"
  // fique visivel no log de atividade em vez de sumir.
  async testProxyDetailed(proxy: ProxyConfig): Promise<ProxyProbeResult> {
    return this.probeProxy(proxy);
  }

  // Numero de tentativas do probe. Proxies rotativos pegam um exit diferente a
  // cada conexao: alguns devolvem a resposta CONNECT limpa (200), outros vem
  // malformada para o parser estrito do Node (ex.: 599/HPE_CR_EXPECTED) ou dao
  // timeout. Um probe de tiro unico pintava esses casos como "Instavel" mesmo
  // com o proxy utilizavel. Re-tentamos e aceitamos o primeiro sucesso.
  private static readonly PROXY_PROBE_MAX_ATTEMPTS = 3;
  private static readonly PROXY_PROBE_RETRY_DELAY_MS = 400;

  // Ordem dos protocolos tentados na auto-deteccao: o salvo primeiro, depois os
  // demais. O formato compacto `host:porta:user:senha` nao carrega protocolo e
  // assume "http", mas muitos gateways residenciais (ex.: NaProxy) so falam
  // SOCKS5 naquela porta -- mandar HTTP CONNECT devolve bytes binarios que o
  // parser do Node rejeita (599/HPE_CR_EXPECTED). Nao da para inferir pelo
  // host/porta (sem convencao universal), entao detectamos conectando.
  private static readonly PROXY_PROTOCOL_ORDER: ReadonlyArray<ProxyConfig["protocol"]> = [
    "http",
    "socks5",
    "https"
  ];

  private resolveProbeProtocolCandidates(configured: ProxyConfig["protocol"]): ProxyConfig["protocol"][] {
    return [
      configured,
      ...BrowserRuntimeService.PROXY_PROTOCOL_ORDER.filter((protocol) => protocol !== configured)
    ];
  }

  private async probeProxy(proxy: ProxyConfig, options: ProxyProbeOptions = {}): Promise<ProxyProbeResult> {
    const configured = proxy.protocol;
    const candidates = this.resolveProbeProtocolCandidates(configured);
    let primaryResult: ProxyProbeResult | undefined;

    for (const protocol of candidates) {
      let result = await this.probeProxyOnce(proxy, { ...options, protocolOverride: protocol });

      // Para o protocolo configurado, re-tenta algumas vezes: proxies rotativos
      // pegam um exit diferente a cada conexao e um deles pode falhar sozinho.
      if (protocol === configured) {
        for (
          let attempt = 2;
          attempt <= BrowserRuntimeService.PROXY_PROBE_MAX_ATTEMPTS && result.status !== "healthy";
          attempt++
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, BrowserRuntimeService.PROXY_PROBE_RETRY_DELAY_MS)
          );
          result = await this.probeProxyOnce(proxy, { ...options, protocolOverride: protocol });
        }
        primaryResult = result;
      }

      if (result.status === "healthy") {
        return { ...result, protocol };
      }
    }

    return (
      primaryResult ?? {
        status: "offline",
        detail: "Proxy nao testado.",
        protocol: configured
      }
    );
  }

  private async probeProxyOnce(proxy: ProxyConfig, options: ProxyProbeOptions = {}): Promise<ProxyProbeResult> {
    const protocol = options.protocolOverride ?? proxy.protocol;
    const target = this.resolveProxyProbeTarget(options.targetUrl);
    const proxyChain = new ProxyChainService({
      upstreamProtocol: protocol,
      upstreamHost: proxy.host,
      upstreamPort: proxy.port,
      username: this.resolveProxyUsername(proxy, options.profileId ?? "proxy-test"),
      password: proxy.password
    });

    try {
      await proxyChain.start();
      const response = await this.probeProxyConnect(proxyChain, target);
      if (response.statusCode === 200) {
        return { status: "healthy", protocol };
      }

      return {
        status: "degraded",
        detail: this.describeProxyProbeFailure(target, response, proxyChain.lastTunnelFailure),
        protocol
      };
    } catch (error) {
      return {
        status: "offline",
        detail: `Falha ao testar CONNECT para ${target.authority}: ${(error as Error).message}`,
        protocol
      };
    } finally {
      await proxyChain.stop().catch(() => undefined);
    }
  }

  private async probeProxyConnect(
    proxyChain: ProxyChainService,
    target: ProxyProbeTarget
  ): Promise<ProxyProbeResponse> {
    const socket = new Socket();

    return await new Promise<ProxyProbeResponse>((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let settled = false;
      const cleanup = () => {
        socket.removeListener("connect", onConnect);
        socket.removeListener("data", onData);
        socket.removeListener("timeout", onTimeout);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
      };
      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
        socket.destroy();
      };
      const onConnect = () => {
        socket.write(
          `CONNECT ${target.authority} HTTP/1.1\r\n` +
            `Host: ${target.authority}\r\n` +
            `Proxy-Connection: Keep-Alive\r\n` +
            `\r\n`
        );
      };
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }
        const header = buffer.subarray(0, headerEnd).toString("utf8");
        const statusLine = header.split("\r\n", 1)[0] ?? "";
        const parsed = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/i.exec(statusLine);
        if (!parsed?.[1]) {
          settle(() => reject(new Error(`resposta CONNECT invalida: ${statusLine || "sem status"}`)));
          return;
        }
        settle(() =>
          resolve({
            statusCode: Number.parseInt(parsed[1] ?? "0", 10),
            statusText: parsed[2]?.trim() ?? ""
          })
        );
      };
      const onTimeout = () => settle(() => reject(new Error("tempo esgotado")));
      const onError = (error: Error) => settle(() => reject(error));
      const onClose = () => {
        if (!settled) {
          settle(() => reject(new Error("conexao fechada antes da resposta CONNECT")));
        }
      };

      socket.setTimeout(10000);
      socket.once("connect", onConnect);
      socket.on("data", onData);
      socket.once("timeout", onTimeout);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.connect(proxyChain.localPort, "127.0.0.1");
    });
  }

  private resolveProxyUsername(proxy: ProxyConfig, profileId: string): string | undefined {
    if (!proxy.username) {
      return undefined;
    }

    return buildProxyUsername(proxy.username, {
      profileId,
      mode: this.resolveProxySessionMode(proxy),
      usernameSuffixTemplate: proxy.usernameSuffixTemplate,
      host: proxy.host
    });
  }

  private resolveProxySessionMode(proxy: ProxyConfig): ProxyConfig["mode"] {
    if (proxy.mode === "rotating-residential") {
      return "rotating-residential";
    }

    if (this.isKnownStickyGateway(proxy)) {
      return "rotating-residential";
    }

    return "static";
  }

  private isKnownStickyGateway(proxy: ProxyConfig): boolean {
    const host = proxy.host.trim().toLowerCase();
    return proxy.port === 823 && /(?:^|\.)dataimpulse\.com$/.test(host);
  }

  private resolveProxyProbeTarget(targetUrl?: string): ProxyProbeTarget {
    const fallback = "https://api.ipify.org/";
    let parsed: URL;
    try {
      parsed = new URL(targetUrl?.trim() || fallback);
    } catch {
      parsed = new URL(fallback);
    }

    const hostname = parsed.hostname;
    const port = parsed.port
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === "http:"
        ? 80
        : 443;
    const hostForAuthority = hostname.includes(":") ? `[${hostname}]` : hostname;

    return {
      hostname,
      port,
      authority: `${hostForAuthority}:${port}`
    };
  }

  private describeProxyProbeFailure(
    target: ProxyProbeTarget,
    response: ProxyProbeResponse,
    failure?: ProxyTunnelFailure
  ): string {
    const upstreamStatus = failure?.statusCode
      ? `${failure.statusCode}${failure.statusMessage ? ` ${failure.statusMessage}` : ""}`
      : `${response.statusCode}${response.statusText ? ` ${response.statusText}` : ""}`;
    const hint = this.describeDataImpulseProxyFailure(failure?.statusCode, failure?.statusMessage || response.statusText);
    return [`CONNECT ${target.authority} falhou no proxy upstream (${upstreamStatus}).`, hint].filter(Boolean).join(" ");
  }

  private describeDataImpulseProxyFailure(statusCode?: number, statusText?: string): string {
    const normalized = statusText?.toUpperCase() ?? "";
    if (statusCode === 403 && /SITE_PERMANENTLY_BLOCKED|HOST_BLOCKED/.test(normalized)) {
      return "A DataImpulse indica bloqueio do destino neste plano/provedor.";
    }
    if (statusCode === 407 && /TRAFFIC_EXHAUSTED/.test(normalized)) {
      return "A DataImpulse indica trafego esgotado no plano.";
    }
    if (statusCode === 407 && /THREADS_EXHAUSTED/.test(normalized)) {
      return "A DataImpulse indica limite de threads/conexoes esgotado.";
    }
    if (statusCode === 407 && /NO_USER|USER_BLOCKED|PORT_NOT_ALLOWED/.test(normalized)) {
      return "A DataImpulse rejeitou usuario, plano ou porta.";
    }
    if (statusCode === 502 && /NO_HOST_CONNECTION/.test(normalized)) {
      return "A DataImpulse nao conseguiu conectar ao host de destino.";
    }
    if (statusCode === 503 && /NO_RAY/.test(normalized)) {
      return "A DataImpulse nao encontrou IP disponivel para o targeting configurado.";
    }
    if (statusCode === 590 && /^UPSTREAM/.test(normalized)) {
      return "O proxy upstream recusou o CONNECT.";
    }
    if (statusCode === 597) {
      return "O proxy upstream rejeitou a autenticacao.";
    }
    return "";
  }

  private attachRuntimePageHandlers(profileId: string, page: Page): void {
    if (this.runtimePageHooks.has(page)) {
      return;
    }

    this.runtimePageHooks.add(page);
    appendInputDiagnostic({
      kind: "page-hooks-attached",
      profileId,
      pageUrl: sanitizeDiagnosticUrl(page.url())
    });

    const refreshRuntimeState = () => {
      const handle = this.handles.get(profileId);
      if (!handle || page.isClosed()) {
        return;
      }

      setTimeout(() => {
        void this.applyRuntimeStateToPage(handle, page);
      }, 80);
    };

    page.on("domcontentloaded", refreshRuntimeState);
    page.on("load", refreshRuntimeState);
    page.on("frameattached", refreshRuntimeState);
    page.on("framenavigated", refreshRuntimeState);
    page.on("close", () => {
      const handle = this.handles.get(profileId);
      if (!handle) {
        return;
      }
      handle.pageOrder = handle.pageOrder.filter(
        (candidate) => candidate !== page && !candidate.isClosed()
      );
      if (handle.primaryPage === page) {
        const fallback =
          [...handle.pageOrder].reverse().find((candidate) => !candidate.isClosed()) ??
          handle.context.pages().find((candidate) => !candidate.isClosed());
        if (fallback) {
          handle.primaryPage = fallback;
          this.markRuntimePageActive(profileId, fallback, "page-close-fallback");
        }
      }
    });

    // A emulacao de toque ("bolinha") e estado do processo renderer e o Chromium a
    // descarta em navegacoes cross-document (ex.: redirects durante o cadastro). O
    // cache em updateGameTouchEmulation continuaria achando que esta ativa e nunca
    // reaplicaria. Invalidamos o cache na navegacao do frame principal para que o
    // refreshRuntimeState (acima) reaplique os comandos CDP.
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        // NAO deletamos gameTouchEmulationSessions: o Chromium vincula o estado de
        // Emulation.* a sessao CDP que setou os flags; se essa sessao for GC'd,
        // a emulacao (bolinha) e revertida na pagina. Manter a referencia viva
        // garante que a emulacao persista atraves de navegacoes.
        this.gameTouchEmulationState.delete(page);
        // O viewport pode mudar entre documentos; descartamos o cache do espelho
        // para reconverter ratio->px corretamente no proximo replay.
        this.mirrorViewportCache.delete(page);
        this.mirrorTouchActive.delete(page);
        this.clearMirrorReplayMarker(page);
        // Forca re-registro do script de captura no proximo refreshRuntimeState.
        // Em navegacoes cross-process a sessao CDP morre; ao limpar o estado
        // salvo, installMirrorCaptureScript tenta registrar, falha na sessao
        // morta, invalida o cache (invalidateMirrorSessionCaches), e a proxima
        // tentativa (domcontentloaded/load) cria uma sessao fresca.
        this.mirrorCaptureEnabledState.delete(page);
      }
    });

    // Recuperacao de carga de jogo: quando um frame de jogo conhecido navega,
    // monitora se o canvas renderiza. Sob muitas janelas a saturacao trava o
    // loader do engine; aqui recarregamos o frame preso (bounded) e logamos o
    // motivo em vez de falhar calado. So age em frames de jogo reconhecidos --
    // nunca em telas de login/cadastro/deposito.
    page.on("framenavigated", (frame) => {
      const provider = resolveProviderByFrameUrl(frame.url());
      if (!shouldMonitorGameLoadFrame({
        isMainFrame: frame === page.mainFrame(),
        isKnownGameFrame: provider !== undefined,
        supportsAutomaticReload: provider?.supportsAutomaticFrameReload
      })) {
        return;
      }
      void this.monitorGameFrameLoad(profileId, page, frame);
    });
  }

  // Loop de recuperacao de carga de um frame de jogo. Faz polling do sinal
  // estrutural (canvas presente + loader do engine) e decide via
  // decideGameLoadRecovery: espera enquanto e carga normal, recarrega o frame
  // preso (ate maxReloadAttempts) e desiste com motivo logado. So recarrega
  // estados presos (canvas ausente / loader travado) -- nunca um jogo em
  // andamento (canvas presente e sem loader = ready).
  private async monitorGameFrameLoad(
    profileId: string,
    page: Page,
    frame: Frame
  ): Promise<void> {
    if (this.gameFrameLoadMonitors.has(frame)) {
      return;
    }
    this.gameFrameLoadMonitors.add(frame);
    const pollMs = 1500;
    const options = { stuckAfterMs: 12000, maxReloadAttempts: 2 };
    let attempts = 0;
    let startedAt = Date.now();
    try {
      while (!page.isClosed() && !frame.isDetached()) {
        // Usuario saiu do jogo (voltou ao lobby): encerra o monitor.
        const provider = resolveProviderByFrameUrl(frame.url());
        if (!shouldMonitorGameLoadFrame({
          isMainFrame: frame === page.mainFrame(),
          isKnownGameFrame: provider !== undefined,
          supportsAutomaticReload: provider?.supportsAutomaticFrameReload
        })) {
          return;
        }
        const probe = await frame
          .evaluate(
            ({ selector, loaderSource }) => {
              const runtimeDoc = (
                globalThis as unknown as {
                  document?: {
                    querySelector: (value: string) => unknown;
                    body?: { innerText?: string };
                  };
                }
              ).document;
              const canvasPresent = Boolean(runtimeDoc?.querySelector(selector));
              const text = String(runtimeDoc?.body?.innerText || "");
              let loaderVisible = false;
              try {
                loaderVisible = new RegExp(loaderSource, "i").test(text);
              } catch {
                loaderVisible = false;
              }
              return { canvasPresent, loaderVisible };
            },
            { selector: GAME_CANVAS_SELECTOR, loaderSource: GAME_LOADER_PATTERN.source }
          )
          .catch(() => null);

        // Frame em navegacao/destacado neste tick: trata como ainda-nao-pronto.
        const signal = probe ?? { canvasPresent: false, loaderVisible: false };
        const decision = decideGameLoadRecovery(
          { ...signal, elapsedMs: Date.now() - startedAt, attempts },
          options
        );

        if (decision.action === "ready") {
          appendInputDiagnostic({
            kind: "game-load-ready",
            profileId,
            frameUrl: sanitizeDiagnosticUrl(frame.url()),
            attempts
          });
          return;
        }
        if (decision.action === "giveup") {
          appendInputDiagnostic({
            kind: "game-load-giveup",
            profileId,
            frameUrl: sanitizeDiagnosticUrl(frame.url()),
            reason: decision.reason,
            attempts
          });
          this.notify(profileId, "active", `⚠️ Jogo nao carregou: ${decision.reason}.`);
          return;
        }
        if (decision.action === "reload") {
          attempts += 1;
          appendInputDiagnostic({
            kind: "game-load-reload",
            profileId,
            frameUrl: sanitizeDiagnosticUrl(frame.url()),
            reason: decision.reason,
            attempt: attempts
          });
          this.notify(profileId, "active", `🔄 Recarregando jogo (tentativa ${attempts}): ${decision.reason}.`);
          if (frame === page.mainFrame()) {
            await page
              .reload({ waitUntil: "domcontentloaded", timeout: 30000 })
              .catch(() => null);
          } else {
            await frame
              .evaluate(() => {
                try {
                  (globalThis as unknown as { location: { reload: () => void } }).location.reload();
                } catch {
                  // frame pode ter sido destacado no meio da recarga
                }
              })
              .catch(() => null);
          }
          startedAt = Date.now();
        }

        await page.waitForTimeout(pollMs).catch(() => null);
      }
    } finally {
      this.gameFrameLoadMonitors.delete(frame);
    }
  }

  private markRuntimePageActive(
    profileId: string,
    page: Page,
    reason: string
  ): void {
    const handle = this.handles.get(profileId);
    if (!handle || page.isClosed()) {
      return;
    }
    handle.pageOrder = [
      ...handle.pageOrder.filter(
        (candidate) => candidate !== page && !candidate.isClosed()
      ),
      page
    ];
    handle.primaryPage = page;
    appendInputDiagnostic({
      kind: "mirror-active-page-changed",
      profileId,
      reason,
      pageUrl: sanitizeDiagnosticUrl(page.url()),
      openPageCount: handle.pageOrder.length
    });
  }

  private buildInputDiagnosticsScript(): string {
    return `
(() => {
  if (window.__predatorInputDiagnosticsInstalled) return;
  window.__predatorInputDiagnosticsInstalled = true;
  const cleanUrl = () => {
    try { return location.origin + location.pathname; } catch { return ""; }
  };
  const describe = (element) => {
    if (!element || element.nodeType !== 1) return null;
    const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
    const style = window.getComputedStyle ? window.getComputedStyle(element) : null;
    return {
      tag: element.tagName || "",
      id: element.id || "",
      className: typeof element.className === "string" ? element.className.slice(0, 180) : "",
      pointerEvents: style ? style.pointerEvents : "",
      position: style ? style.position : "",
      zIndex: style ? style.zIndex : "",
      rect: rect ? [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)] : null
    };
  };
  const emit = (payload) => {
    try {
      const send = window.__spiderInputDiagnostic;
      if (typeof send === "function") {
        Promise.resolve(send(payload)).catch(() => undefined);
      }
    } catch {}
  };
  const metrics = () => ({
    href: cleanUrl(),
    title: document.title,
    topFrame: window.top === window,
    inner: [window.innerWidth, window.innerHeight],
    outer: [window.outerWidth, window.outerHeight],
    screen: [window.screen.width, window.screen.height],
    visualViewport: window.visualViewport
      ? [Math.round(window.visualViewport.width), Math.round(window.visualViewport.height), window.visualViewport.scale]
      : null,
    orientation: window.screen.orientation
      ? { type: window.screen.orientation.type, angle: window.screen.orientation.angle }
      : { legacy: window.orientation },
    portraitMedia: window.matchMedia ? window.matchMedia("(orientation: portrait)").matches : null,
    maxTouchPoints: navigator.maxTouchPoints,
    hasTouchEvent: "ontouchstart" in window,
    hasGameCanvas: Boolean(document.querySelector("#GameCanvas,canvas.gameCanvas,#gameCanvas,#Cocos2dGameContainer"))
  });
  const logBoot = (reason) => {
    const centerX = Math.max(0, Math.round(window.innerWidth / 2));
    const centerY = Math.max(0, Math.round(window.innerHeight / 2));
    emit({
      kind: "frame-state",
      reason,
      ...metrics(),
      centerStack: document.elementsFromPoint
        ? document.elementsFromPoint(centerX, centerY).slice(0, 8).map(describe)
        : []
    });
  };
  const eventNames = [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "click",
    "touchstart",
    "touchend"
  ];
  for (const eventName of eventNames) {
    window.addEventListener(eventName, (event) => {
      const touch = event.changedTouches && event.changedTouches[0];
      const x = Number.isFinite(event.clientX) ? event.clientX : touch ? touch.clientX : -1;
      const y = Number.isFinite(event.clientY) ? event.clientY : touch ? touch.clientY : -1;
      queueMicrotask(() => emit({
        kind: "input-event",
        event: event.type,
        pointerType: event.pointerType || "",
        isTrusted: event.isTrusted,
        defaultPrevented: event.defaultPrevented,
        cancelBubble: event.cancelBubble,
        buttons: typeof event.buttons === "number" ? event.buttons : null,
        button: typeof event.button === "number" ? event.button : null,
        x: Math.round(x),
        y: Math.round(y),
        target: describe(event.target),
        stack: x >= 0 && y >= 0 && document.elementsFromPoint
          ? document.elementsFromPoint(x, y).slice(0, 8).map(describe)
          : [],
        ...metrics()
      }));
    }, true);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => logBoot("domcontentloaded"), { once: true });
  } else {
    logBoot("installed");
  }
  window.addEventListener("load", () => logBoot("load"), { once: true });
  window.setTimeout(() => logBoot("delayed"), 1500);
})();
`;
  }

  private buildServiceWorkerCleanupScript(): string {
    return `
(() => {
  try {
    if (navigator.serviceWorker && typeof navigator.serviceWorker.getRegistrations === "function") {
      navigator.serviceWorker.getRegistrations()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
        .catch(() => undefined);
    }
  } catch {}
  try {
    if (window.caches && typeof window.caches.keys === "function") {
      window.caches.keys()
        .then((keys) => Promise.all(keys.map((key) => window.caches.delete(key))))
        .catch(() => undefined);
    }
  } catch {}
})();
`;
  }


  private async createPrimaryRuntimePage(context: BrowserContext, restoreSession: boolean): Promise<Page> {
    const initialPages = context.pages().filter((page) => !page.isClosed());
    const isBlankPage = (page: Page) => {
      const url = page.url();
      return url === "about:blank" || url === "chrome://new-tab-page/";
    };
    const restoredPage = restoreSession ? initialPages.find((page) => !isBlankPage(page)) : undefined;
    const primaryPage = restoredPage ?? initialPages.find(isBlankPage) ?? (await context.newPage());

    await Promise.allSettled(
      initialPages.map(async (page) => {
        if (page === primaryPage || page.isClosed()) {
          return;
        }

        await page.close({ runBeforeUnload: false }).catch(() => null);
      })
    );

    return primaryPage;
  }

  private async applyRuntimeStateToPage(handle: RuntimeHandle, page: Page): Promise<void> {
    if (page.isClosed()) {
      return;
    }

    await this.applyBadgeToPage(
      page,
      handle.profileId,
      handle.placement,
      handle.launchedScale,
      handle.ipLabel
    );
    await this.applySpeedToPage(page, handle.speedRate);
    await this.applyMirrorConfigToPage(page);
    await this.applyPopupCloserConfigToPage(page);
    await this.applyAccountInfoOverlayToPage(page, this.accountInfoOverlayEnabled);
    await this.updateGameTouchEmulation(page, handle.mobileLike);
    this.startTouchEmulationWatchdog(page, handle.mobileLike);
    // O init script re-roda a cada navegacao com os campos do launch; re-empurramos a versao
    // viva (ex.: senha de saque/chave PIX cadastradas depois) para nao reverter aos basicos.
    const liveFields = this.latestAccountInfoFields.get(handle.profileId);
    if (liveFields && liveFields.length > 0) {
      await this.applyAccountInfoFieldsToPage(page, liveFields);
    }
  }

  private resolveTargetHandles(targetSelection: RuntimeControlTargetSelection): Array<[string, RuntimeHandle]> {
    const handles = [...this.handles.values()].sort((left, right) => left.slotIndex - right.slotIndex);
    const runtimeWindows = this.buildRuntimeWindowTargets(handles, []);
    const resolvedWindows = resolveRuntimeWindowTargetsStrict(targetSelection, runtimeWindows);
    return resolvedWindows.map((windowTarget) => {
      const handle = this.handles.get(windowTarget.profileId);
      if (!handle) {
        throw new Error("A selecao de janelas ficou desatualizada. Aplique a selecao novamente.");
      }
      return [windowTarget.profileId, handle] satisfies [string, RuntimeHandle];
    });
  }

  private requireTargetSelection(selection: RuntimeControlSelectionState): RuntimeControlTargetSelection {
    if (selection.mode === "none") {
      throw new Error(selection.reason || "Selecao de janelas invalida.");
    }
    return selection;
  }

  private cloneSelectionState(selection: RuntimeControlSelectionState): RuntimeControlSelectionState {
    if (selection.mode === "windows") {
      return this.cloneTargetSelection(selection);
    }
    if (selection.mode === "all") {
      return { mode: "all" };
    }
    return { mode: "none", ...(selection.reason ? { reason: selection.reason } : {}) };
  }

  private cloneTargetSelection(selection: RuntimeControlTargetSelection): RuntimeControlTargetSelection {
    if (selection.mode === "all") {
      return { mode: "all" };
    }
    return {
      mode: "windows",
      windows: selection.windows.map((windowRef) => ({
        profileId: windowRef.profileId,
        slotNumber: windowRef.slotNumber
      }))
    };
  }

  private buildRuntimeWindowTargets(
    handles: RuntimeHandle[],
    profiles: ProfileSummary[]
  ): RuntimeWindowTarget[] {
    const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
    return [...handles]
      .sort((left, right) => left.slotIndex - right.slotIndex)
      .map((handle) => {
        const profile = profilesById.get(handle.profileId);
        return {
          profileId: handle.profileId,
          profileName: profile?.name ?? "Perfil",
          slotNumber: handle.slotIndex + 1,
          status: profile?.status ?? "active",
          automationActive: profile?.status === "running-automation",
          ...(profile?.account?.username ? { accountUsername: profile.account.username } : {}),
          ...(profile?.account?.phoneNumber ? { accountPhoneNumber: profile.account.phoneNumber } : {})
        };
      });
  }

  private isHandleIncludedInSelection(
    profileId: string,
    handle: RuntimeHandle,
    selection: RuntimeControlTargetSelection
  ): boolean {
    if (selection.mode === "all") {
      return true;
    }
    const slotNumber = handle.slotIndex + 1;
    return selection.windows.some(
      (windowRef) => windowRef.profileId === profileId && windowRef.slotNumber === slotNumber
    );
  }

  private async getRuntimePage(handle: RuntimeHandle): Promise<Page | undefined> {
    if (!handle.primaryPage.isClosed()) {
      return handle.primaryPage;
    }

    handle.pageOrder = handle.pageOrder.filter((page) => !page.isClosed());
    const openPage =
      [...handle.pageOrder].reverse().find((page) => !page.isClosed()) ??
      handle.context.pages().find((page) => !page.isClosed());
    if (openPage) {
      this.markRuntimePageActive(handle.profileId, openPage, "runtime-page-fallback");
      return openPage;
    }

    const page = await handle.context.newPage().catch(() => undefined);
    if (page) {
      this.attachRuntimePageHandlers(handle.profileId, page);
      this.markRuntimePageActive(handle.profileId, page, "runtime-page-created");
    }

    return page;
  }

  private buildNavigationUrl(currentUrl: string, fallbackUrl: string, path: string): string {
    const normalizedPath = path.replace(/^\/+/, "");

    for (const source of [currentUrl, fallbackUrl]) {
      try {
        const parsed = new URL(source);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          return `${parsed.origin}/${normalizedPath}`;
        }
      } catch {
        // Keep trying the fallback URL.
      }
    }

    return fallbackUrl;
  }

  private beginNavigationRun(handle: RuntimeHandle): number {
    handle.navigationRunId += 1;
    return handle.navigationRunId;
  }

  private isCurrentNavigationRun(handle: RuntimeHandle, navigationRunId: number): boolean {
    return handle.navigationRunId === navigationRunId;
  }

  private async pushClientRoute(
    page: Page,
    handle: RuntimeHandle,
    navigationRunId: number,
    kind: RouteKind,
    log: (message: string) => void,
    explicitTarget?: RouteTarget
  ): Promise<boolean> {
    for (const frame of this.getInspectableFrames(page)) {
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return false;
      }
      if (!(await hasSpaRouter(frame))) {
        continue;
      }

      const descriptor = await detectPlatformDescriptor(frame, page.url() || handle.homeUrl);
      const target = explicitTarget ?? (await resolveRouteTarget(frame, kind, descriptor));
      if (!target) {
        continue;
      }
      if (!(await routerPush(frame, target))) {
        continue;
      }

      log(`[NAV] Rota ${kind} acionada via router (${descriptor?.id ?? "descritor fuzzy"}).`);
      return true;
    }

    return false;
  }

  private async pushIframeClientRoute(
    page: Page,
    handle: RuntimeHandle,
    iframeAppUrl: string | undefined,
    kind: RouteKind,
    navigationRunId: number,
    log: (message: string) => void,
    explicitTarget?: RouteTarget
  ): Promise<boolean> {
    const appHomeUrl = this.buildIframeAppHomeUrl(page, handle, iframeAppUrl);
    const spaFrame = await this.ensureIframeSpaMounted(page, handle, appHomeUrl, navigationRunId);
    if (!spaFrame || !this.isCurrentNavigationRun(handle, navigationRunId)) {
      return false;
    }

    if (!(await hasSpaRouter(spaFrame))) {
      log(`[IFRAME-NAV] Router interno indisponivel para ${kind}.`);
      return false;
    }

    const descriptor = await detectPlatformDescriptor(spaFrame, iframeAppUrl ?? appHomeUrl ?? handle.homeUrl);
    const target = explicitTarget ?? (await resolveRouteTarget(spaFrame, kind, descriptor));
    if (!target) {
      log(`[IFRAME-NAV] Rota ${kind} nao resolvida (${descriptor?.id ?? "sem descritor"}).`);
      return false;
    }

    if (!(await routerPush(spaFrame, target))) {
      log(`[IFRAME-NAV] Router interno recusou rota ${kind} (${descriptor?.id ?? "descritor fuzzy"}).`);
      return false;
    }

    log(`[IFRAME-NAV] Rota ${kind} acionada via router interno (${descriptor?.id ?? "descritor fuzzy"}).`);
    return true;
  }

  private buildIframeAppHomeUrl(page: Page, handle: RuntimeHandle, iframeAppUrl?: string): string {
    if (iframeAppUrl) {
      try {
        return new URL(iframeAppUrl).href;
      } catch {
        // Build from the known platform origin below.
      }
    }

    // Usa a home salva como origem preferencial. Se a rota atual for /Tesouro?isredirect=1,
    // usar page.url() como base pode reabrir a home interna e parecer refresh na 2a navegacao.
    return this.buildNavigationUrl(handle.homeUrl, page.url(), "?isredirect=1");
  }

  private async navigateToHomePage(
    profileId: string,
    handle: RuntimeHandle,
    page: Page,
    navigationRunId: number
  ): Promise<void> {
    const log = (msg: string) => {
      this.notify(profileId, "active", msg);
      console.log(`[HOME][${profileId}] ${msg}`);
    };

    const iframeAppUrl = await this.readAppIframeUrl(page);
    const isIframePlatform = this.detectsIframePlatform(page, handle, iframeAppUrl);

    if (isIframePlatform) {
      const routed = await this.pushIframeClientRoute(
        page,
        handle,
        iframeAppUrl,
        "home",
        navigationRunId,
        log
      );
      if (routed) {
        return;
      }
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return;
      }

      const pushed = await this.pushIframeSpaRoute(
        page,
        handle,
        iframeAppUrl,
        "?isredirect=1",
        navigationRunId,
        log
      );
      if (pushed) {
        return;
      }
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return;
      }
    } else if (await this.pushClientRoute(page, handle, navigationRunId, "home", log)) {
      return;
    }

    log("[HOME] Router indisponivel; usando navegacao direta como fallback.");
    await page.goto(handle.homeUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
  }

  private async navigateToBetReportPage(
    profileId: string,
    handle: RuntimeHandle,
    page: Page,
    navigationRunId: number
  ): Promise<void> {
    const log = (msg: string) => {
      this.notify(profileId, "active", msg);
      console.log(`[RELATORIO][${profileId}] ${msg}`);
    };

    if (await this.isBetReportPageReady(page)) {
      return;
    }

    const iframeAppUrl = await this.readAppIframeUrl(page);
    const routeHint = await this.hasBetReportClientRouteHint(page);
    const isIframe = this.detectsIframePlatform(page, handle, iframeAppUrl);
    const candidatePaths = routeHint ? [] : [BET_REPORT_LEGACY_ROUTE];

    if (isIframe) {
      log("[RELATORIO] Plataforma iframe detectada; acionando navegacao interna do app.");
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return;
      }

      // Plataforma iframe: a rota do relatorio e /Report?type=3 (aba "Relatorio").
      // O type=2 abre "Apostas" (errado) e /home/report green-screia.
      const routed = await this.pushIframeClientRoute(
        page,
        handle,
        iframeAppUrl,
        "betReport",
        navigationRunId,
        log
      );
      if (routed) {
        if (await this.waitForBetReportPageReady(page, 8000)) {
          await this.selectReportRelatorioTab(page);
          log("[RELATORIO] Relatorio aberto via router interno (aba Relatorio).");
          return;
        }
        log("[RELATORIO] Router interno acionado, mas a tela nao confirmou; evitando fallback com refresh/clique.");
        return;
      }

      const pushed = await this.pushIframeSpaRoute(
        page,
        handle,
        iframeAppUrl,
        "Report?type=3&isredirect=1",
        navigationRunId,
        log
      );
      if (pushed && (await this.waitForBetReportPageReady(page, 8000))) {
        await this.selectReportRelatorioTab(page);
        log("[RELATORIO] Relatorio aberto via router interno (aba Relatorio).");
        return;
      }
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return;
      }
      if (pushed) {
        log("[RELATORIO] Router interno por pushState acionado, mas a tela nao confirmou; evitando fallback com refresh/clique.");
        return;
      }

      if (await this.openBetReportFromMountedApp(page, handle, iframeAppUrl, navigationRunId, log)) {
        await this.selectReportRelatorioTab(page);
        return;
      }
    } else {
      log("[RELATORIO] Tentando rota de relatorio via router.");
      if (await this.pushClientRoute(page, handle, navigationRunId, "betReport", log)) {
        if (await this.waitForBetReportPageReady(page, 8000)) {
          log("[RELATORIO] Relatorio aberto via router.");
          return;
        }
      }
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return;
      }

      if (routeHint && await this.openBetReportFromMountedApp(page, handle, iframeAppUrl, navigationRunId, log)) {
        return;
      }
      if (!routeHint) {
        log("[RELATORIO] Tentando rota legada de relatorio.");
      }
    }

    for (const path of candidatePaths) {
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return;
      }
      const targetUrl = this.buildNavigationUrl(iframeAppUrl ?? page.url(), handle.homeUrl, path);
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);

      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return;
      }

      if (await this.waitForBetReportPageReady(page, path === BET_REPORT_LEGACY_ROUTE ? 8000 : 10000)) {
        log(`[RELATORIO] Relatorio aberto em ${page.url()}`);
        return;
      }
    }

    if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
      return;
    }

    if (await this.clickBetReportEntryPoint(page)) {
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return;
      }
      if (await this.waitForBetReportPageReady(page, 6000)) {
        if (isIframe) {
          await this.selectReportRelatorioTab(page);
        }
        log(`[RELATORIO] Relatorio aberto por clique no app.`);
        return;
      }
    }

    log(`[RELATORIO] Nao consegui confirmar a tela de relatorio. URL final: ${page.url()}`);
  }

  // Seleciona a aba "Relatorio" na pagina /Report da plataforma iframe (o usuario quer
  // o relatorio resumido, nao a aba "Apostas" que abre por padrao em type=2).
  private async selectReportRelatorioTab(page: Page): Promise<boolean> {
    return this.clickClientTextEntryPoint(
      page,
      "report-relatorio-tab",
      ".van-tab,[role='tab']",
      /^relatorio$/,
      /conta|apostas|deposito|saque|login|registro/
    );
  }

  private async openBetReportFromMountedApp(
    page: Page,
    handle: RuntimeHandle,
    iframeAppUrl: string | undefined,
    navigationRunId: number,
    log: (message: string) => void
  ): Promise<boolean> {
    if (await this.clickBetReportEntryPoint(page)) {
      if (await this.waitForBetReportPageReady(page, 4500)) {
        log(`[RELATORIO] Relatorio aberto por navegacao interna.`);
        return true;
      }
    }

    if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
      return false;
    }

    const appHomeUrl = this.buildBetReportAppHomeUrl(page, handle, iframeAppUrl);
    log("[RELATORIO] Recarregando home interna antes de abrir relatorio.");
    await page.goto(appHomeUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(8000).catch(() => null);

    if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
      return false;
    }

    if (await this.clickBetReportEntryPoint(page)) {
      if (await this.waitForBetReportPageReady(page, 10000)) {
        log(`[RELATORIO] Relatorio aberto por navegacao interna apos boot da SPA.`);
        return true;
      }
    }

    if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
      return false;
    }

    if (await this.openBetReportFromProfileMenu(page)) {
      if (await this.waitForBetReportPageReady(page, 10000)) {
        log(`[RELATORIO] Relatorio aberto via Perfil > Meus Registros.`);
        return true;
      }
    }

    return false;
  }

  private buildBetReportAppHomeUrl(page: Page, handle: RuntimeHandle, iframeAppUrl: string | undefined): string {
    if (iframeAppUrl) {
      try {
        const parsed = new URL(iframeAppUrl);
        if (parsed.searchParams.get("isredirect") === "1") {
          return parsed.href;
        }
      } catch {
        // Build from the current app origin below.
      }
    }

    return this.buildIframeAppHomeUrl(page, handle, iframeAppUrl);
  }

  private async readAppIframeUrl(page: Page): Promise<string | undefined> {
    return page
      .evaluate(() => {
        type RuntimeElement = {
          getAttribute: (name: string) => string | null;
        };
        const runtimeWindow = globalThis as unknown as {
          document: { querySelector: (selector: string) => RuntimeElement | null };
          location: { href: string };
        };
        const source =
          runtimeWindow.document
            .querySelector("iframe#h5_iframe,iframe[src*='isredirect=1']")
            ?.getAttribute("src") ?? "";

        if (!source) {
          return "";
        }

        try {
          return new URL(source, runtimeWindow.location.href).href;
        } catch {
          return "";
        }
      })
      .then((value) => value || undefined)
      .catch(() => undefined);
  }

  private isIframeAppUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.searchParams.get("isredirect") === "1";
    } catch {
      return false;
    }
  }

  // Detecta (e memoiza na handle) se a plataforma usa o wrapper iframe. A deteccao
  // por DOM/URL so funciona quando o iframe esta montado (na home); ao navegar de uma
  // rota profunda ela falharia, entao lembramos o resultado pela sessao toda.
  private detectsIframePlatform(page: Page, handle: RuntimeHandle, iframeAppUrl?: string): boolean {
    const detected =
      Boolean(iframeAppUrl) ||
      this.isIframeAppUrl(page.url()) ||
      this.isIframeAppUrl(handle.homeUrl) ||
      handle.usesIframeApp === true;
    if (detected) {
      handle.usesIframeApp = true;
    }
    return detected;
  }

  // Navega a SPA de uma plataforma iframe para uma rota interna usando o router do Vue
  // (history.pushState + popstate) DENTRO do frame do iframe. Carregar a rota profunda
  // diretamente (page.goto/location.replace no frame de topo) recarrega a pagina e a
  // rota nao bootstrapa: o usuario ve so a "tela verde". Mantendo o iframe montado e
  // disparando popstate, o router renderiza a rota client-side normalmente.
  private async pushIframeSpaRoute(
    page: Page,
    handle: RuntimeHandle,
    iframeAppUrl: string | undefined,
    routePath: string,
    navigationRunId: number,
    log: (message: string) => void
  ): Promise<boolean> {
    const appHomeUrl = this.buildIframeAppHomeUrl(page, handle, iframeAppUrl);

    const spaFrame = await this.ensureIframeSpaMounted(page, handle, appHomeUrl, navigationRunId);
    if (!spaFrame || !this.isCurrentNavigationRun(handle, navigationRunId)) {
      return false;
    }

    const normalizedPath = `/${routePath.replace(/^\/+/, "")}`;
    const navigated = await spaFrame
      .evaluate((path) => {
        const runtimeWindow = globalThis as unknown as {
          history: { pushState: (state: unknown, title: string, url: string) => void };
          dispatchEvent: (event: unknown) => boolean;
          PopStateEvent: new (type: string) => unknown;
          location: { pathname: string; search: string };
        };
        runtimeWindow.history.pushState(null, "", path);
        runtimeWindow.dispatchEvent(new runtimeWindow.PopStateEvent("popstate"));
        return runtimeWindow.location.pathname + runtimeWindow.location.search;
      }, normalizedPath)
      .catch(() => null);

    if (navigated) {
      log(`[IFRAME-NAV] Rota interna acionada via router: ${navigated}`);
      return true;
    }

    return false;
  }

  // Garante que a SPA da plataforma iframe esteja montada dentro do iframe (estado
  // "home"), retornando o frame correspondente. Se nao houver iframe montado, boota a
  // home (?isredirect=1) para o wrapper criar o iframe e espera o app renderizar.
  private async ensureIframeSpaMounted(
    page: Page,
    handle: RuntimeHandle,
    appHomeUrl: string,
    navigationRunId: number
  ): Promise<Frame | Page | undefined> {
    const findSpaFrame = (): Frame | undefined => {
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame() && this.isIframeAppUrl(candidate.url()));
      if (frame) {
        handle.usesIframeApp = true;
      }
      return frame;
    };

    const waitForAppContent = async (frame: Frame | Page): Promise<void> => {
      for (let attempt = 0; attempt < 16; attempt++) {
        if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
          return;
        }
        if (await hasSpaRouter(frame)) {
          return;
        }
        const ready = await frame
          .evaluate(() => {
            const runtimeWindow = globalThis as unknown as {
              document: { querySelectorAll: (selector: string) => { length: number } };
            };
            return (
              runtimeWindow.document.querySelectorAll("[role=tab], .btn-all-inside, .van-tabbar-item").length > 0
            );
          })
          .catch(() => false);
        if (ready) {
          return;
        }
        await page.waitForTimeout(attempt < 4 ? 120 : 400).catch(() => null);
      }
    };

    let frame = findSpaFrame();
    if (frame) {
      await waitForAppContent(frame);
      return frame;
    }

    if (this.isIframeAppUrl(page.url())) {
      await waitForAppContent(page);
      if (await hasSpaRouter(page)) {
        handle.usesIframeApp = true;
        return page;
      }
    }

    await page.goto(appHomeUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);

    for (let attempt = 0; attempt < 20; attempt++) {
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return undefined;
      }
      frame = findSpaFrame();
      if (frame) {
        await waitForAppContent(frame);
        return frame;
      }
      await page.waitForTimeout(500).catch(() => null);
    }

    // Fallback: a SPA pode estar rodando no proprio frame de topo (sem wrapper iframe).
    if (this.isIframeAppUrl(page.url())) {
      await waitForAppContent(page);
      if (await hasSpaRouter(page)) {
        handle.usesIframeApp = true;
        return page;
      }
    }

    return undefined;
  }

  private async hasBetReportClientRouteHint(page: Page): Promise<boolean> {
    for (const frame of this.getInspectableFrames(page)) {
      const found = await frame
        .evaluate(() => {
          const runtimeWindow = globalThis as unknown as {
            document: { documentElement: { innerHTML: string } };
          };
          return /\/Report\?type=2|path\s*:\s*["']\/Report["']|recordesBtn/i.test(
            runtimeWindow.document.documentElement.innerHTML
          );
        })
        .catch(() => false);
      if (found) {
        return true;
      }
    }

    return false;
  }

  private getInspectableFrames(page: Page): Array<Page | Frame> {
    const frames = page.frames().filter((frame) => frame !== page.mainFrame());
    return [page, ...frames];
  }

  private async isBetReportPageReady(page: Page): Promise<boolean> {
    for (const frame of this.getInspectableFrames(page)) {
      const ready = await frame
        .evaluate(() => {
          type RuntimeElement = {
            getBoundingClientRect: () => {
              bottom: number;
              height: number;
              left: number;
              right: number;
              top: number;
              width: number;
            };
            textContent?: string | null;
          };
          const runtimeWindow = globalThis as unknown as {
            document: {
              body: { innerText?: string | null };
              querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
            };
            getComputedStyle: (element: RuntimeElement) => { display: string; opacity: string; visibility: string };
            innerHeight: number;
            innerWidth: number;
            location: { hash: string; pathname: string; search: string };
          };
          const normalize = (value: string | null | undefined) =>
            (value || "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const routeText = normalize(
            `${runtimeWindow.location.pathname}${runtimeWindow.location.search}${runtimeWindow.location.hash}`
          );
          const bodyText = normalize(runtimeWindow.document.body.innerText);
          const isVisible = (element: RuntimeElement) => {
            const rect = element.getBoundingClientRect();
            const style = runtimeWindow.getComputedStyle(element);
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0.01 &&
              rect.width > 8 &&
              rect.height > 8 &&
              rect.right > 0 &&
              rect.bottom > 0 &&
              rect.left < runtimeWindow.innerWidth &&
              rect.top < runtimeWindow.innerHeight
            );
          };
          const isReportRoute = /\/report\b|home\/report/.test(routeText);
          const activeTabText = normalize(
            Array.from(runtimeWindow.document.querySelectorAll(".van-tab--active,[aria-selected='true']"))
              .map((element) => element.textContent || "")
              .join(" ")
          );
          const hasActiveBetRecordsTab = /recordes? de apostas|apostas|betting records?|bet records?/.test(activeTabText);
          // A aba "Relatorio" (type=3) tambem e um estado valido da tela de relatorio.
          const hasActiveRelatorioTab = /^relatorio$|relatorio/.test(activeTabText);
          const isLegacyReportRoute = /home\/report/.test(routeText);
          const isBetRecordsRoute = /(?:[?&]|^)type=[23](?:&|$)/.test(routeText);
          const hasVisibleReportElement = Array.from(
            runtimeWindow.document.querySelectorAll(
              "[class*='report' i],[class*='record' i],[class*='indexContentTopTiem' i],[class*='indexFooter' i]"
            )
          ).some((element) => isVisible(element) && /relatorio|record|report|apostas|total|sem registros/i.test(element.textContent || ""));
          const hasReportSurface =
            /relatorio|detalhes da conta|recordes de apostas|registro de apostas|meus registros|sem registros|bet report|betting record|total valid bets|cumulative bet amount|total w\/l/.test(bodyText) ||
            hasVisibleReportElement;

          return (
            isReportRoute &&
            hasReportSurface &&
            (hasActiveBetRecordsTab || hasActiveRelatorioTab || isBetRecordsRoute || isLegacyReportRoute)
          );
        })
        .catch(() => false);
      if (ready) {
        return true;
      }
    }

    return false;
  }

  private async waitForBetReportPageReady(page: Page, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await this.isBetReportPageReady(page)) {
        return true;
      }
      await page.waitForTimeout(250).catch(() => null);
    }

    return this.isBetReportPageReady(page);
  }

  private async openBetReportFromProfileMenu(page: Page): Promise<boolean> {
    if (!(await this.clickProfileTabEntryPoint(page))) {
      return false;
    }

    await page.waitForTimeout(3000).catch(() => null);

    if (!(await this.clickProfileRecordsEntryPoint(page))) {
      return false;
    }

    await page.waitForTimeout(3000).catch(() => null);
    await this.selectBetRecordsReportTab(page);
    await page.waitForTimeout(2000).catch(() => null);
    return true;
  }

  private async clickProfileTabEntryPoint(page: Page): Promise<boolean> {
    return this.clickClientTextEntryPoint(
      page,
      "profile-tab",
      "button,a,[role='button'],[role='tab'],.tabbar_item,[class*='tabbar' i],[class*='nav' i],div,span",
      /^(perfil|profile|mine|user|usuario|minha conta)$/,
      /deposito|recarga|saque|withdraw|suporte|support|ofertas|promocao|comecar|home/
    );
  }

  private async clickProfileRecordsEntryPoint(page: Page): Promise<boolean> {
    return this.clickClientTextEntryPoint(
      page,
      "profile-records",
      "button,a,[role='button'],[role='tab'],[class*='menu' i],[class*='item' i],div,span",
      /meus registros|recordes?|registros?|relatorio|apostas|betting|records?/,
      /deposito|recarga|saque|withdraw|seguranca|security|faq|bonus|login|registro vinculativo/
    );
  }

  private async selectBetRecordsReportTab(page: Page): Promise<boolean> {
    return this.clickClientTextEntryPoint(
      page,
      "bet-records-tab",
      ".van-tab,[role='tab'],button,a,[role='button'],div,span",
      /^(recordes? de apostas|apostas|betting records?|bet records?)$/,
      /detalhes da conta|relatorio$|deposito|saque|withdraw|login|registro$/
    );
  }

  private async clickClientTextEntryPoint(
    page: Page,
    tokenPrefix: string,
    selector: string,
    include: RegExp,
    exclude: RegExp
  ): Promise<boolean> {
    const token = `${tokenPrefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    for (const frame of this.getInspectableFrames(page)) {
      const marked = await frame
        .evaluate(({ targetToken, selectorSource, includeSource, excludeSource }) => {
          type RuntimeElement = {
            click?: () => void;
            getAttribute?: (name: string) => string | null;
            getBoundingClientRect: () => {
              bottom: number;
              height: number;
              left: number;
              right: number;
              top: number;
              width: number;
            };
            setAttribute?: (name: string, value: string) => void;
            textContent?: string | null;
          };
          const runtimeWindow = globalThis as unknown as {
            RegExp: RegExpConstructor;
            document: { querySelectorAll: (selector: string) => Iterable<RuntimeElement> };
            getComputedStyle: (element: RuntimeElement) => { display: string; opacity: string; visibility: string };
            innerHeight: number;
            innerWidth: number;
          };
          const includePattern = new runtimeWindow.RegExp(includeSource, "i");
          const excludePattern = new runtimeWindow.RegExp(excludeSource, "i");
          const normalize = (value: string | null | undefined) =>
            (value || "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const isVisible = (element: RuntimeElement) => {
            const rect = element.getBoundingClientRect();
            const style = runtimeWindow.getComputedStyle(element);
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0.01 &&
              rect.width > 8 &&
              rect.height > 8 &&
              rect.right > 0 &&
              rect.bottom > 0 &&
              rect.left < runtimeWindow.innerWidth &&
              rect.top < runtimeWindow.innerHeight
            );
          };
          const candidates = Array.from(runtimeWindow.document.querySelectorAll(selectorSource))
            .filter(isVisible)
            .map((element) => {
              const text = normalize(element.textContent);
              const attrs = normalize(
                [
                  element.getAttribute?.("class"),
                  element.getAttribute?.("id"),
                  element.getAttribute?.("aria-label"),
                  element.getAttribute?.("title")
                ].join(" ")
              );
              const haystack = normalize(`${text} ${attrs}`);
              const rect = element.getBoundingClientRect();
              let score = 0;
              if (includePattern.test(text)) {
                score += 90;
              }
              if (includePattern.test(haystack)) {
                score += 30;
              }
              if (excludePattern.test(haystack)) {
                score -= 70;
              }
              if (text.length > 0 && text.length < 80) {
                score += 12;
              }
              if (rect.top > runtimeWindow.innerHeight * 0.55) {
                score += 8;
              }
              return { element, score, y: rect.top };
            })
            .filter((candidate) => candidate.score > 40)
            .sort((left, right) => right.score - left.score || right.y - left.y);

          const candidate = candidates[0];
          candidate?.element.setAttribute?.("data-predator-client-entry-target", targetToken);
          return Boolean(candidate);
        }, {
          targetToken: token,
          selectorSource: selector,
          includeSource: include.source,
          excludeSource: exclude.source
        })
        .catch(() => false);

      if (!marked) {
        continue;
      }

      const target = frame.locator(`[data-predator-client-entry-target="${token}"]`).first();
      await target.click({ timeout: 5000, force: true }).catch(async () => {
        await target
          .evaluate((element) => {
            (element as unknown as { click?: () => void }).click?.();
          })
          .catch(() => undefined);
      });
      await target.evaluate((element) => element.removeAttribute("data-predator-client-entry-target")).catch(() => undefined);
      return true;
    }

    return false;
  }

  private async clickBetReportEntryPoint(page: Page): Promise<boolean> {
    const token = `bet-report-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const frame = await this.markBetReportEntryPoint(page, token);
    if (!frame) {
      return false;
    }

    const target = frame.locator(`[data-predator-bet-report-target="${token}"]`).first();
    await target.click({ timeout: 5000, force: true }).catch(async () => {
      await target
        .evaluate((element) => {
          (element as unknown as { click?: () => void }).click?.();
        })
        .catch(() => undefined);
    });
    await target.evaluate((element) => element.removeAttribute("data-predator-bet-report-target")).catch(() => undefined);
    return true;
  }

  private async markBetReportEntryPoint(page: Page, token: string): Promise<Page | Frame | undefined> {
    for (const frame of this.getInspectableFrames(page)) {
      const marked = await frame
        .evaluate((targetToken) => {
          type RuntimeElement = {
            click?: () => void;
            getAttribute?: (name: string) => string | null;
            getBoundingClientRect: () => {
              bottom: number;
              height: number;
              left: number;
              right: number;
              top: number;
              width: number;
            };
            setAttribute?: (name: string, value: string) => void;
            textContent?: string | null;
          };
          const runtimeWindow = globalThis as unknown as {
            document: { querySelectorAll: (selector: string) => Iterable<RuntimeElement> };
            getComputedStyle: (element: RuntimeElement) => { display: string; opacity: string; visibility: string };
            innerHeight: number;
            innerWidth: number;
          };
          const normalize = (value: string | null | undefined) =>
            (value || "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const isVisible = (element: RuntimeElement) => {
            const rect = element.getBoundingClientRect();
            const style = runtimeWindow.getComputedStyle(element);
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0.01 &&
              rect.width > 8 &&
              rect.height > 8 &&
              rect.right > 0 &&
              rect.bottom > 0 &&
              rect.left < runtimeWindow.innerWidth &&
              rect.top < runtimeWindow.innerHeight
            );
          };
          const candidates = Array.from(
            runtimeWindow.document.querySelectorAll(
              "button,a,[role='button'],[role='tab'],[class*='record' i],[class*='report' i],[class*='bet' i]"
            )
          )
            .map((element) => {
              const text = normalize(
                [
                  element.textContent,
                  element.getAttribute?.("class"),
                  element.getAttribute?.("id"),
                  element.getAttribute?.("aria-label"),
                  element.getAttribute?.("title")
                ].join(" ")
              );
              const rect = element.getBoundingClientRect();
              let score = 0;
              if (/apostas|relatorio|report|record|betting/.test(text)) {
                score += 80;
              }
              if (/recordesbtn|bet/.test(text)) {
                score += 35;
              }
              if (/deposito|recarga|saque|withdraw|login|registro|suporte|support|perfil/.test(text)) {
                score -= 50;
              }
              if (isVisible(element)) {
                score += 20;
              } else if (/recordesbtn/.test(text)) {
                score += 10;
              } else {
                score -= 40;
              }

              return { element, score, y: rect.top };
            })
            .filter((candidate) => candidate.score > 45)
            .sort((left, right) => right.score - left.score || right.y - left.y);

          const candidate = candidates[0];
          candidate?.element.setAttribute?.("data-predator-bet-report-target", targetToken);
          return Boolean(candidate);
        }, token)
        .catch(() => false);

      if (marked) {
        return frame;
      }
    }

    return undefined;
  }

  private async navigateToSlotSearchPage(
    profileId: string,
    handle: RuntimeHandle,
    page: Page,
    navigationRunId: number,
    searchTerm: string
  ): Promise<void> {
    const log = (msg: string) => {
      this.notify(profileId, "active", msg);
      console.log(`[SLOT-SEARCH][${profileId}] ${msg}`);
    };

    log(`[SLOT-SEARCH] Navegando para pagina de slots...`);

    const iframeAppUrl = await this.readAppIframeUrl(page);
    const isIframePlatform = this.detectsIframePlatform(page, handle, iframeAppUrl);

    if (isIframePlatform) {
      await this.navigateToSlotSearchIframe(page, handle, iframeAppUrl, navigationRunId, log);
    } else {
      const openedByRouter = await this.navigateToSlotSearchClientRoute(page, handle, navigationRunId, log);
      if (!openedByRouter) {
        const targetUrl = this.buildNavigationUrl(page.url(), handle.homeUrl, "home/subgame?gameCategoryId=3");
        log("[SLOT-SEARCH] Router indisponivel; usando navegacao direta como fallback.");
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
        if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
          return;
        }
      }
    }

    if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
      return;
    }

    if (!searchTerm.trim()) {
      log(`[SLOT-SEARCH] Pagina de slots aberta (sem termo de busca).`);
      return;
    }

    let searchInput = await this.waitForSlotSearchInput(page, handle, navigationRunId);

    if (!searchInput) {
      log(`[SLOT-SEARCH] Input nao encontrado — reaplicando rota interna e tentando novamente...`);
      if (isIframePlatform) {
        await this.navigateToSlotSearchIframe(page, handle, iframeAppUrl, navigationRunId, log);
      } else {
        await this.navigateToSlotSearchClientRoute(page, handle, navigationRunId, log);
      }
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return;
      }
      searchInput = await this.waitForSlotSearchInput(page, handle, navigationRunId, 10000);
    }

    if (!searchInput) {
      log(`[SLOT-SEARCH] Input de busca nao encontrado apos 2 tentativas. URL: ${page.url()}`);
      return;
    }

    const filled = await this.fillSlotSearchInputInstant(searchInput, searchTerm);
    if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
      return;
    }
    if (!filled) {
      log(`[SLOT-SEARCH] Nao consegui preencher o input de busca. URL: ${page.url()}`);
      return;
    }

    await page.waitForTimeout(1500).catch(() => null);
    log(`[SLOT-SEARCH] Busca "${searchTerm}" realizada.`);
  }

  private async fillSlotSearchInputInstant(searchInput: Locator, searchTerm: string): Promise<boolean> {
    const value = searchTerm.trim();
    if (!value) {
      return true;
    }

    const applied = await searchInput
      .evaluate((element, nextValue) => {
        type RuntimeWindow = typeof globalThis & {
          Event: new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => unknown;
          InputEvent?: new (
            type: string,
            init?: { bubbles?: boolean; cancelable?: boolean; data?: string; inputType?: string }
          ) => unknown;
        };
        type RuntimeInput = {
          dispatchEvent: (event: unknown) => boolean;
          ownerDocument: { defaultView?: RuntimeWindow | null };
          removeAttribute?: (name: string) => void;
          textContent?: string | null;
          value?: string;
        };
        const target = element as RuntimeInput;
        const runtimeWindow = target.ownerDocument.defaultView ?? (globalThis as RuntimeWindow);
        const setValue = (input: RuntimeInput, valueToApply: string) => {
          const valueSetter = (
            Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value") as
              | { set?: (this: RuntimeInput, value: string) => void }
              | undefined
          )?.set;
          if (valueSetter) {
            valueSetter.call(input, valueToApply);
          } else if ("value" in input) {
            input.value = valueToApply;
          } else {
            input.textContent = valueToApply;
          }
        };

        target.removeAttribute?.("readonly");
        target.removeAttribute?.("disabled");
        setValue(target, nextValue);

        const inputEvent = typeof runtimeWindow.InputEvent === "function"
          ? new runtimeWindow.InputEvent("input", {
              bubbles: true,
              cancelable: true,
              data: nextValue,
              inputType: "insertText"
            })
          : new runtimeWindow.Event("input", { bubbles: true, cancelable: true });
        target.dispatchEvent(new runtimeWindow.Event("beforeinput", { bubbles: true, cancelable: true }));
        target.dispatchEvent(inputEvent);
        target.dispatchEvent(new runtimeWindow.Event("change", { bubbles: true }));
        target.dispatchEvent(new runtimeWindow.Event("compositionend", { bubbles: true }));

        const currentValue = "value" in target
          ? target.value
          : target.textContent ?? "";
        return currentValue === nextValue;
      }, value)
      .catch(() => false);

    if (applied) {
      return true;
    }

    return searchInput.fill(value, { timeout: 1500 }).then(() => true).catch(() => false);
  }

  private async navigateToSlotSearchClientRoute(
    page: Page,
    handle: RuntimeHandle,
    navigationRunId: number,
    log: (msg: string) => void
  ): Promise<boolean> {
    for (const frame of this.getInspectableFrames(page)) {
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return false;
      }
      if (!(await hasSpaRouter(frame))) {
        continue;
      }

      const descriptor = await detectPlatformDescriptor(frame, page.url() || handle.homeUrl);
      const target = await resolveRouteTarget(frame, "slotSearch", descriptor);
      if (!target) {
        continue;
      }

      if (!(await routerPush(frame, target))) {
        continue;
      }

      log(`[SLOT-SEARCH] Rota de slots acionada via router (${descriptor?.id ?? "descritor fuzzy"}).`);
      if (await this.waitForSlotSearchInput(page, handle, navigationRunId, 8000)) {
        return true;
      }
    }

    return false;
  }

  private async navigateToSlotSearchIframe(
    page: Page,
    handle: RuntimeHandle,
    iframeAppUrl: string | undefined,
    navigationRunId: number,
    log: (msg: string) => void
  ): Promise<void> {
    // A SPA da plataforma iframe usa um router em memoria (Vant/Vue). Navegar por URL
    // direta para /casino recarrega a pagina inteira e a rota nao bootstrapa: o usuario
    // ve so a "tela verde". Acionamos primeiro o $router interno da SPA.
    log("[SLOT-SEARCH] Plataforma iframe — navegando para slots via router interno.");
    const routed = await this.pushIframeClientRoute(
      page,
      handle,
      iframeAppUrl,
      "slotSearch",
      navigationRunId,
      log
    );
    if (routed && (await this.waitForSlotSearchInput(page, handle, navigationRunId, 8000))) {
      return;
    }
    if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
      return;
    }
    if (routed) {
      log("[SLOT-SEARCH] Router interno acionado, mas o input nao apareceu; tentando pushState interno.");
    }

    const pushed = await this.pushIframeSpaRoute(
      page,
      handle,
      iframeAppUrl,
      "casino?isredirect=1",
      navigationRunId,
      log
    );
    if (pushed && (await this.waitForSlotSearchInput(page, handle, navigationRunId, 8000))) {
      return;
    }
    if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
      return;
    }

    // Fallback: clicar o botao "Tudo" da secao de Slots na home (caso o router falhe).
    let clicked = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return;
      }
      if (await this.clickSlotSearchEntryPoint(page)) {
        log("[SLOT-SEARCH] Fallback: entrada de slots acionada via clique.");
        clicked = true;
        break;
      }
      await page.waitForTimeout(1000).catch(() => null);
    }

    if (clicked) {
      await this.waitForSlotSearchInput(page, handle, navigationRunId, 8000);
      return;
    }

    log("[SLOT-SEARCH] Nao consegui abrir a busca de slots.");
  }

  // Marca e clica o botao "Tudo" (.btn-all-inside) da secao de Slots na home da SPA
  // iframe. Prefere a secao cujo titulo comeca com "Slots"; senao usa o primeiro botao
  // disponivel (qualquer um leva a /casino, que tem o campo de busca global).
  private async clickSlotSearchEntryPoint(page: Page): Promise<boolean> {
    const token = `slot-search-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    for (const frame of this.getInspectableFrames(page)) {
      const marked = await frame
        .evaluate((targetToken) => {
          type RuntimeElement = {
            setAttribute?: (name: string, value: string) => void;
            parentElement: RuntimeElement | null;
            textContent?: string | null;
          };
          const runtimeWindow = globalThis as unknown as {
            document: { querySelectorAll: (selector: string) => Iterable<RuntimeElement> };
          };
          const normalize = (value: string | null | undefined) =>
            (value || "")
              .normalize("NFD")
              .replace(/[̀-ͯ]/g, "")
              .trim()
              .toLowerCase();

          const buttons = Array.from(runtimeWindow.document.querySelectorAll(".btn-all-inside"));
          if (buttons.length === 0) {
            return false;
          }

          const slotsButton = buttons.find((button) => {
            let node: RuntimeElement | null = button.parentElement;
            for (let up = 0; up < 8 && node; up++) {
              if (normalize(node.textContent).startsWith("slots")) {
                return true;
              }
              node = node.parentElement;
            }
            return false;
          });

          const target = slotsButton ?? buttons[0];
          if (!target) {
            return false;
          }
          target.setAttribute?.("data-predator-slot-search-target", targetToken);
          return true;
        }, token)
        .catch(() => false);

      if (!marked) {
        continue;
      }

      const target = frame.locator(`[data-predator-slot-search-target="${token}"]`).first();
      await target.click({ timeout: 5000, force: true }).catch(async () => {
        await target
          .evaluate((element) => {
            (element as unknown as { click?: () => void }).click?.();
          })
          .catch(() => undefined);
      });
      await target
        .evaluate((element) => element.removeAttribute("data-predator-slot-search-target"))
        .catch(() => undefined);
      return true;
    }

    return false;
  }

  private async findSlotSearchInput(page: Page): Promise<Locator | undefined> {
    for (const frame of this.getInspectableFrames(page)) {
      const locator = frame.locator(
        'input[placeholder*="Pesquisar" i], input[placeholder*="Porcurar" i], input[placeholder*="Procurar" i], input[placeholder*="Search" i], input[placeholder*="jogos" i]'
      );
      const count = await locator.count().catch(() => 0);
      if (count > 0) {
        const first = locator.first();
        const visible = await first.isVisible().catch(() => false);
        if (visible) {
          return first;
        }
      }
    }

    return undefined;
  }

  private async waitForSlotSearchInput(
    page: Page,
    handle: RuntimeHandle,
    navigationRunId: number,
    timeoutMs = 15000
  ): Promise<Locator | undefined> {
    const intervalMs = 500;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return undefined;
      }
      const input = await this.findSlotSearchInput(page);
      if (input) {
        return input;
      }
      await page.waitForTimeout(intervalMs).catch(() => null);
    }

    return undefined;
  }

  private async navigateToTreasureChestsPage(
    profileId: string,
    handle: RuntimeHandle,
    page: Page,
    navigationRunId: number
  ): Promise<void> {
    const log = (msg: string) => {
      this.notify(profileId, "active", msg);
      console.log(`[BAUS][${profileId}] ${msg}`);
    };

    if (await this.isTreasureDetailPageReady(page)) {
      return;
    }

    const iframeAppUrl = await this.readAppIframeUrl(page);
    const isIframePlatform = this.detectsIframePlatform(page, handle, iframeAppUrl);
    const redirectSuffix = isIframePlatform ? "&isredirect=1" : "";

    if (isIframePlatform) {
      const routed = await this.pushIframeClientRoute(
        page,
        handle,
        iframeAppUrl,
        "treasureChests",
        navigationRunId,
        log
      );
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return;
      }
      if (routed) {
        if (await this.waitForTreasureDetailPageReady(page, 1200)) {
          log("[BAUS] Pagina de baus aberta via router interno.");
          return;
        }
        log("[BAUS] Router interno abriu a pagina de eventos; buscando detalhe do bau.");
      }
    }

    log(`[BAUS] Buscando eventId na configuracao de eventos...`);
    const currentPageHtml = await this.readPageHtml(page);
    const categoryPayload = await this.readTreasureCategoryPayload(page, handle);
    if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
      return;
    }
    let eventId = this.extractTreasureChestEventId(categoryPayload?.text, currentPageHtml);

    if (eventId) {
      log(
        categoryPayload
          ? `[BAUS] eventId=${eventId} extraido de ${categoryPayload.source}`
          : `[BAUS] eventId=${eventId} extraido da pagina atual`
      );
    }

    if (!eventId) {
      log(`[BAUS] Indo para pagina de eventos...`);
      if (isIframePlatform) {
        const openedByRouter = await this.pushIframeClientRoute(
          page,
          handle,
          iframeAppUrl,
          "treasureChests",
          navigationRunId,
          log
        );
        if (openedByRouter) {
          if (await this.waitForTreasureDetailPageReady(page, 1200)) {
            log("[BAUS] Pagina de baus aberta via router interno.");
            return;
          }
        } else {
          // Router interno evita a "tela verde" do deep-link no frame de topo.
          await this.pushIframeSpaRoute(
            page,
            handle,
            iframeAppUrl,
            `home/event?eventCurrent=1${redirectSuffix}`,
            navigationRunId,
            log
          );
        }
      } else {
        const openedByRouter = await this.pushClientRoute(page, handle, navigationRunId, "treasureChests", log);
        if (!openedByRouter) {
          const eventPageUrl = this.buildTreasureNavigationUrl(page, handle, `home/event?eventCurrent=1${redirectSuffix}`);
          log("[BAUS] Router indisponivel; usando navegacao direta para eventos como fallback.");
          await page.goto(eventPageUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
        }
      }
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return;
      }

      const [eventPageHtml, categoryPayload] = await Promise.all([
        this.readPageHtml(page),
        this.readTreasureCategoryPayload(page, handle)
      ]);
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return;
      }
      eventId = this.extractTreasureChestEventId(categoryPayload?.text, eventPageHtml);

      const sourceDetail = categoryPayload ? `${categoryPayload.source}:${categoryPayload.text.length}b` : "sem API";
      log(eventId ? `[BAUS] eventId=${eventId} extraido (${sourceDetail})` : `[BAUS] eventId NAO encontrado (${sourceDetail})`);
    }

    if (eventId) {
      const opened = await this.openTreasureDetailUrl(page, handle, eventId, log, navigationRunId, redirectSuffix);
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return;
      }
      if (opened) {
        return;
      }

      log(`[BAUS] Todos os metodos de navegacao falharam. URL final: ${page.url()}`);
      return;
    }

    if (await this.tryTreasureNamedRoutes(page, handle, navigationRunId, log)) {
      return;
    }
    if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
      return;
    }

    if (!(await this.isTreasureDetailPageReady(page))) {
      if (isIframePlatform) {
        const openedByRouter = await this.pushIframeClientRoute(
          page,
          handle,
          iframeAppUrl,
          "treasureChests",
          navigationRunId,
          log
        );
        if (!openedByRouter) {
          await this.pushIframeSpaRoute(
            page,
            handle,
            iframeAppUrl,
            `home/event?eventCurrent=1${redirectSuffix}`,
            navigationRunId,
            log
          );
        }
      } else if (!(await this.pushClientRoute(page, handle, navigationRunId, "treasureChests", log))) {
        await page.goto(
          this.buildTreasureNavigationUrl(page, handle, `home/event?eventCurrent=1${redirectSuffix}`),
          { waitUntil: "domcontentloaded", timeout: 30000 }
        ).catch(() => null);
      }
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return;
      }
      await this.clickPromotionsTab(page).catch(() => null);
    }
  }

  private buildTreasureNavigationUrl(page: Page, handle: RuntimeHandle, path: string): string {
    return this.buildNavigationUrl(handle.homeUrl, page.url(), path);
  }

  private async openTreasureDetailUrl(
    page: Page,
    handle: RuntimeHandle,
    eventId: string,
    log: (message: string) => void,
    navigationRunId: number,
    redirectSuffix = ""
  ): Promise<boolean> {
    const detailPath = `home/event/detail?current=1&template=${TREASURE_TEMPLATE_ID}&eventId=${eventId}${redirectSuffix}`;

    // Plataforma iframe: o deep-link no frame de topo green-screia. Aciona a rota de
    // detalhe pelo router interno do Vue (pushState + popstate) dentro do iframe. Como o
    // pushState muda a URL do frame interno (e nao a do frame de topo), confirmamos pelo
    // proprio retorno do helper em vez de page.url().
    if (redirectSuffix !== "") {
      log(`[BAUS] Navegando (router): /${detailPath}`);
      if (await this.pushIframeSpaRoute(page, handle, undefined, detailPath, navigationRunId, log)) {
        await page.waitForTimeout(1500).catch(() => null);
        return true;
      }
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return false;
      }
      log(`[BAUS] Router interno falhou; tentando metodos legados.`);
    }

    if (redirectSuffix === "") {
      const routerTarget: RouteTarget = {
        path: "/home/event/detail",
        query: {
          current: "1",
          eventId,
          template: TREASURE_TEMPLATE_ID
        }
      };
      log(`[BAUS] Navegando (router): /home/event/detail?current=1&template=${TREASURE_TEMPLATE_ID}&eventId=${eventId}`);
      if (await this.pushClientRoute(page, handle, navigationRunId, "treasureChests", log, routerTarget)) {
        const waitingStartedAt = Date.now();
        while (Date.now() - waitingStartedAt < 8000) {
          if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
            return false;
          }
          if (await this.isTreasureDetailPageReady(page)) {
            return true;
          }
          await page.waitForTimeout(300).catch(() => null);
        }
        log(`[BAUS] Router nao confirmou destino (url atual: ${page.url()}).`);
      }
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return false;
      }
    }

    const detailUrl = this.buildTreasureNavigationUrl(page, handle, detailPath);

    const strategies: Array<{ name: string; run: () => Promise<void> }> = [
      {
        name: "page.goto",
        run: async () => {
          await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
        }
      },
      {
        name: "location.replace",
        run: async () => {
          await page
            .evaluate((url) => {
              (globalThis as unknown as { location: { replace: (u: string) => void } }).location.replace(url);
            }, detailUrl)
            .catch(() => null);
        }
      },
      {
        name: "link click",
        run: async () => {
          await page
            .evaluate((url) => {
              const w = globalThis as unknown as {
                document: {
                  body: { appendChild: (e: unknown) => void; removeChild: (e: unknown) => void };
                  createElement: (tag: string) => {
                    click: () => void;
                    href: string;
                    style: { display: string };
                  };
                };
              };
              const anchor = w.document.createElement("a");
              anchor.href = url;
              anchor.style.display = "none";
              w.document.body.appendChild(anchor);
              anchor.click();
              w.document.body.removeChild(anchor);
            }, detailUrl)
            .catch(() => null);
        }
      }
    ];

    log(`[BAUS] Navegando: ${detailUrl}`);

    for (const strategy of strategies) {
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return false;
      }
      await strategy.run();
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return false;
      }
      const waitingStartedAt = Date.now();
      const maxWaitMs = strategy.name === "page.goto" ? 8000 : 12000;
      while (Date.now() - waitingStartedAt < maxWaitMs) {
        if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
          return false;
        }
        if (await this.isTreasureDetailPageReady(page)) {
          return true;
        }
        await page.waitForTimeout(300).catch(() => null);
      }

      log(`[BAUS] ${strategy.name} nao confirmou destino (url atual: ${page.url()}).`);
    }

    return false;
  }

  private async tryTreasureNamedRoutes(
    page: Page,
    handle: RuntimeHandle,
    navigationRunId: number,
    log: (message: string) => void
  ): Promise<boolean> {
    const targets: RouteTarget[] = ["Tesouro", "Baus", "Treasure", "Chest"].map((name) => ({
      path: `/${name}`,
      query: { isredirect: "1" }
    }));

    for (const target of targets) {
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return false;
      }
      const targetPath = typeof target === "string" ? target : target.path ?? target.name ?? "rota nomeada";
      log(`[BAUS] Tentando rota nomeada via router: ${targetPath}`);
      const pushed = await this.pushClientRoute(page, handle, navigationRunId, "treasureChests", log, target);
      if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
        return false;
      }
      if (!pushed) {
        continue;
      }
      const namedWaitStartedAt = Date.now();
      while (Date.now() - namedWaitStartedAt < 8000) {
        if (!this.isCurrentNavigationRun(handle, navigationRunId)) {
          return false;
        }
        if (await this.isTreasureDetailPageReady(page)) {
          return true;
        }
        await page.waitForTimeout(300).catch(() => null);
      }
    }

    log("[BAUS] Rotas nomeadas nao confirmaram via router; evitando deep-link com refresh.");
    return false;
  }

  private isTreasureRouteText(routeText: string): boolean {
    return new RegExp(
      `(?:template\\s*=\\s*${TREASURE_TEMPLATE_ID}.*eventId\\s*=\\s*\\d+|eventId\\s*=\\s*\\d+.*template\\s*=\\s*${TREASURE_TEMPLATE_ID}|(?:^|[\\/#?&=\\s])(?:Tesouro|Baus|Treasure|Chest)\\b)`,
      "i"
    ).test(routeText);
  }

  private isTreasureDetailUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      const routeText = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      return this.isTreasureRouteText(routeText);
    } catch {
      return false;
    }
  }

  private async isTreasureDetailPageReady(page: Page): Promise<boolean> {
    if (this.isTreasureDetailUrl(page.url())) {
      return true;
    }

    for (const frame of this.getInspectableFrames(page)) {
      const routeText = await frame
        .evaluate(() => {
          const runtimeWindow = globalThis as unknown as {
            location: { hash: string; pathname: string; search: string };
          };
          return `${runtimeWindow.location.pathname}${runtimeWindow.location.search}${runtimeWindow.location.hash}`;
        })
        .catch(() => "");
      if (routeText && this.isTreasureRouteText(routeText)) {
        return true;
      }
      const route = await getCurrentRoute(frame).catch(() => null);
      const currentRouteText = [route?.name, route?.path, route?.fullPath].filter(Boolean).join(" ");
      if (currentRouteText && this.isTreasureRouteText(currentRouteText)) {
        return true;
      }
    }

    return false;
  }

  private async waitForTreasureDetailPageReady(page: Page, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await this.isTreasureDetailPageReady(page)) {
        return true;
      }
      await page.waitForTimeout(80).catch(() => null);
    }

    return this.isTreasureDetailPageReady(page);
  }

  private async readPageHtml(page: Page): Promise<string> {
    return page
      .evaluate(() => {
        const runtimeWindow = globalThis as unknown as {
          document: { documentElement: { innerHTML: string } };
        };
        return runtimeWindow.document.documentElement.innerHTML;
      })
      .catch(() => "");
  }

  private async readTreasureCategoryPayload(
    page: Page,
    handle: RuntimeHandle
  ): Promise<TreasureCategoryPayload | undefined> {
    const urls = await this.buildTreasureCategoryApiUrls(page, handle);

    for (const url of urls) {
      const payload = await this.fetchTreasureCategoryUrl(page, url);
      if (payload) {
        return payload;
      }
    }

    return undefined;
  }

  private async buildTreasureCategoryApiUrls(page: Page, handle: RuntimeHandle): Promise<string[]> {
    const pageHints = await this.readTreasureResourceHintsFromPage(page);
    const homeHints = await this.readTreasureResourceHintsFromHome(page, handle.homeUrl);
    const hints = this.mergeTreasureResourceHints([pageHints, homeHints]);
    const baseUrls = this.uniqueStrings([
      ...hints.baseUrls,
      this.originBaseUrl(page.url()),
      this.originBaseUrl(handle.homeUrl)
    ]);
    const currencyCodes = this.uniqueStrings([
      hints.currencyCode,
      DEFAULT_TREASURE_CURRENCY_CODE
    ]).filter((code) => /^[A-Z]{3}$/.test(code));
    const languageCodes = this.uniqueStrings([
      hints.languageCode,
      DEFAULT_TREASURE_LANGUAGE_CODE,
      "pt-BR"
    ]).filter((code) => /^[a-z]{2}(?:-[A-Z]{2})?$/i.test(code));
    const urls: string[] = [];

    for (const baseUrl of baseUrls) {
      for (const currencyCode of currencyCodes) {
        for (const languageCode of languageCodes) {
          const path = TREASURE_CATEGORY_API_PATH.replace("{currency}", currencyCode).replace("{language}", languageCode);
          const url = this.buildUrlFromBase(baseUrl, path);
          if (url) {
            urls.push(url);
          }
        }
      }
    }

    return this.uniqueStrings(urls);
  }

  private async fetchTreasureCategoryUrl(page: Page, url: string): Promise<TreasureCategoryPayload | undefined> {
    const response = await page.request
      .get(url, {
        headers: { Accept: "application/json,text/plain,*/*" },
        timeout: 8000
      })
      .catch(() => undefined);

    if (!response || response.status() >= 400) {
      return undefined;
    }

    const text = await response.text().catch(() => "");
    if (!text || !this.extractTreasureChestEventId(text)) {
      return undefined;
    }

    return {
      source: `api ${response.status()} ${url}`,
      text,
      url
    };
  }

  private async readTreasureResourceHintsFromPage(page: Page): Promise<TreasureResourceHints> {
    return page
      .evaluate(() => {
        type RuntimeElement = {
          getAttribute: (name: string) => string | null;
        };
        type RuntimeDocument = {
          querySelector: (selector: string) => RuntimeElement | null;
          querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
        };
        const runtimeWindow = globalThis as unknown as {
          LOBBY_SITE_CONFIG?: Record<string, unknown>;
          document: RuntimeDocument;
          location: { origin: string };
        };
        const parseObject = (value: string | null | undefined): Record<string, unknown> => {
          if (!value) {
            return {};
          }
          try {
            const parsed = JSON.parse(value) as unknown;
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : {};
          } catch {
            return {};
          }
        };
        const readString = (value: unknown) => (typeof value === "string" ? value : undefined);
        const siteInfo = parseObject(runtimeWindow.document.querySelector('meta[name="siteinfos"]')?.getAttribute("content"));
        const lobbyConfig = runtimeWindow.LOBBY_SITE_CONFIG ?? {};
        const baseKeys = [
          "ossBaseUrl",
          "ossBaseURL",
          "ossUrl",
          "ossDomain",
          "staticBaseUrl",
          "cdnBaseUrl",
          "resourceBaseUrl",
          "commonOssDomain",
          "commonOssBaseUrl"
        ];
        const baseUrls: string[] = [];

        for (const key of baseKeys) {
          const siteValue = readString(siteInfo[key]);
          const configValue = readString(lobbyConfig[key]);
          if (siteValue) {
            baseUrls.push(siteValue);
          }
          if (configValue) {
            baseUrls.push(configValue);
          }
        }

        const ossName = readString(lobbyConfig.ossName);
        const ossType = readString(lobbyConfig.ossType);
        if (ossName && ossType) {
          baseUrls.push(`https://${ossName}.${ossType}/`);
        }

        for (const link of runtimeWindow.document.querySelectorAll(
          'link[rel="preconnect"],link[rel="dns-prefetch"]'
        )) {
          const href = link.getAttribute("href");
          if (href) {
            baseUrls.push(href);
          }
        }

        return {
          baseUrls,
          currencyCode: readString(lobbyConfig.currencyCode),
          languageCode: readString(lobbyConfig.languageCode)
        };
      })
      .then((hints) => this.normalizeTreasureResourceHints(hints))
      .catch(() => ({ baseUrls: [] }));
  }

  private async readTreasureResourceHintsFromHome(page: Page, homeUrl: string): Promise<TreasureResourceHints> {
    const normalizedHomeUrl = this.buildNavigationUrl(homeUrl, page.url(), "");
    const response = await page.request.get(normalizedHomeUrl, { timeout: 8000 }).catch(() => undefined);
    if (!response || response.status() >= 400) {
      return { baseUrls: [] };
    }

    const html = await response.text().catch(() => "");
    return this.extractTreasureResourceHintsFromHtml(html);
  }

  private extractTreasureResourceHintsFromHtml(html: string): TreasureResourceHints {
    const baseUrls: string[] = [];
    const siteInfoTag = html.match(/<meta\b[^>]*\bname\s*=\s*["']?siteinfos["']?[^>]*>/i)?.[0];
    const siteInfoContent = siteInfoTag
      ?.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
      ?.slice(1)
      .find((value): value is string => Boolean(value));
    const siteInfo = this.parseJsonObject(this.decodeHtmlEntities(siteInfoContent ?? ""));

    for (const value of this.readTreasureBaseValues(siteInfo)) {
      baseUrls.push(value);
    }

    for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
      const tag = match[0] ?? "";
      if (!/\brel\s*=\s*["']?(?:preconnect|dns-prefetch)["']?/i.test(tag)) {
        continue;
      }

      const href = tag
        .match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
        ?.slice(1)
        .find((value): value is string => Boolean(value));
      if (href) {
        baseUrls.push(this.decodeHtmlEntities(href));
      }
    }

    return this.normalizeTreasureResourceHints({
      baseUrls,
      currencyCode: html.match(/["']?\bcurrencyCode\b["']?\s*:\s*["']([A-Z]{3})["']/)?.[1],
      languageCode: html.match(/["']?\blanguageCode\b["']?\s*:\s*["']([a-z]{2}(?:-[A-Z]{2})?)["']/i)?.[1]
    });
  }

  private normalizeTreasureResourceHints(hints: TreasureResourceHints): TreasureResourceHints {
    return {
      baseUrls: this.uniqueStrings(hints.baseUrls.map((url) => this.normalizeTreasureBaseUrl(url))),
      currencyCode: hints.currencyCode?.trim() || undefined,
      languageCode: hints.languageCode?.trim() || undefined
    };
  }

  private mergeTreasureResourceHints(hints: TreasureResourceHints[]): TreasureResourceHints {
    return this.normalizeTreasureResourceHints({
      baseUrls: hints.flatMap((entry) => entry.baseUrls),
      currencyCode: hints.find((entry) => entry.currencyCode)?.currencyCode,
      languageCode: hints.find((entry) => entry.languageCode)?.languageCode
    });
  }

  private readTreasureBaseValues(record: Record<string, unknown>): string[] {
    const baseKeys = [
      "ossBaseUrl",
      "ossBaseURL",
      "ossUrl",
      "ossDomain",
      "staticBaseUrl",
      "cdnBaseUrl",
      "resourceBaseUrl",
      "commonOssDomain",
      "commonOssBaseUrl"
    ];
    const baseUrls = baseKeys
      .map((key) => this.readStringish(record[key]))
      .filter((value): value is string => Boolean(value));
    const ossName = this.readStringish(record.ossName);
    const ossType = this.readStringish(record.ossType);

    if (ossName && ossType) {
      baseUrls.push(`https://${ossName}.${ossType}/`);
    }

    return baseUrls;
  }

  private parseJsonObject(value: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private decodeHtmlEntities(value: string): string {
    return value
      .replace(/&quot;/g, '"')
      .replace(/&#34;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }

  private normalizeTreasureBaseUrl(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) {
      return undefined;
    }

    const absoluteValue = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
    try {
      const parsed = new URL(absoluteValue);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return undefined;
      }
      return parsed.href.endsWith("/") ? parsed.href : `${parsed.href}/`;
    } catch {
      return undefined;
    }
  }

  private originBaseUrl(value: string): string | undefined {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? `${parsed.origin}/` : undefined;
    } catch {
      return undefined;
    }
  }

  private buildUrlFromBase(baseUrl: string, path: string): string | undefined {
    try {
      return new URL(path.replace(/^\/+/, ""), baseUrl).href;
    } catch {
      return undefined;
    }
  }

  private uniqueStrings(values: Array<string | undefined>): string[] {
    return [...new Set(values.filter((value): value is string => Boolean(value)))];
  }

  private async clickPromotionsTab(page: Page): Promise<void> {
    await page
      .evaluate(() => {
        type RuntimeElement = {
          click?: () => void;
          getBoundingClientRect: () => {
            bottom: number;
            height: number;
            right: number;
            top: number;
            width: number;
            y: number;
          };
          textContent?: string | null;
        };
        const runtimeWindow = globalThis as unknown as {
          document: { querySelectorAll: (selector: string) => Iterable<RuntimeElement> };
          innerHeight: number;
        };
        const normalize = (value: string | null | undefined) =>
          (value || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

        const candidates = Array.from(runtimeWindow.document.querySelectorAll("[role='tab'],button,[role='button'],div,span"))
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            const text = normalize(element.textContent);
            return (
              rect.width > 8 &&
              rect.height > 8 &&
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < runtimeWindow.innerHeight &&
              /^(ofertas?|promoc(?:ao|oes)|promotions?|eventos?|events?|atividad(?:e|es)|activit(?:y|ies)|bonus|promo)$/.test(text)
            );
          })
          .sort((left, right) => right.getBoundingClientRect().y - left.getBoundingClientRect().y);

        candidates[0]?.click?.();
      })
      .catch(() => null);
    await page.waitForTimeout(3000).catch(() => null);
  }

  private extractTreasureChestEventId(...sources: Array<string | undefined>): string | undefined {
    const candidates: TreasureEventCandidate[] = [];

    for (const source of sources) {
      if (!source) {
        continue;
      }

      this.collectTreasureCandidatesFromJson(source, candidates);
      this.collectTreasureCandidatesFromText(source, candidates);
    }

    return this.selectBestTreasureCandidate(candidates)?.id;
  }

  private collectTreasureCandidatesFromJson(
    source: string,
    candidates: TreasureEventCandidate[]
  ): void {
    try {
      this.walkTreasureCandidateTree(JSON.parse(source), candidates);
    } catch {
      // Some pages keep the same data embedded as JavaScript, not strict JSON.
    }
  }

  private walkTreasureCandidateTree(
    value: unknown,
    candidates: TreasureEventCandidate[],
    depth = 0
  ): void {
    if (depth > 8 || value === null || value === undefined) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        this.walkTreasureCandidateTree(item, candidates, depth + 1);
      }
      return;
    }

    if (typeof value === "string") {
      this.collectTreasureCandidatesFromJson(value, candidates);
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    const record = value as Record<string, unknown>;
    const template = this.readNumberish(
      record.template ?? record.location_template ?? record.locationTemplate
    );
    const id = this.readNumberish(
      record.activeId ??
        record.active_id ??
        record.eventId ??
        record.event_id ??
        record.location_value ??
        record.locationValue ??
        (template === TREASURE_TEMPLATE_ID ? record.id : undefined)
    );

    if (template === TREASURE_TEMPLATE_ID && id) {
      const status = this.readNumber(record.status);
      const startTime = this.readNumber(record.startTime ?? record.start_time ?? record.startShowTime);
      const endTime = this.readNumber(record.endTime ?? record.end_time ?? record.endShowTime);
      const recordText = JSON.stringify(record).slice(0, 3000);
      candidates.push({
        id,
        score: 100 + this.scoreTreasureCandidateText(recordText),
        source: "json",
        status,
        startTime,
        endTime
      });
    }

    for (const child of Object.values(record)) {
      this.walkTreasureCandidateTree(child, candidates, depth + 1);
    }
  }

  private collectTreasureCandidatesFromText(
    source: string,
    candidates: TreasureEventCandidate[]
  ): void {
    const detailUrlPattern =
      /home\/event\/detail\?[^"'<>\\\s]*(?:template=15[^"'<>\\\s]*eventId=(\d+)|eventId=(\d+)[^"'<>\\\s]*template=15)/gi;
    let detailMatch: RegExpExecArray | null;
    while ((detailMatch = detailUrlPattern.exec(source))) {
      const chunk = source.slice(Math.max(0, detailMatch.index - 400), Math.min(source.length, detailMatch.index + 900));
      const id = detailMatch[1] ?? detailMatch[2];
      if (id) {
        candidates.push({
          id,
          score: 115 + this.scoreTreasureCandidateText(chunk),
          source: "url"
        });
      }
    }

    const templatePattern =
      /[\\'"]*(?:template|location_template|locationTemplate)[\\'"]*\s*:\s*[\\'"]*15[\\'"]*/gi;
    let match: RegExpExecArray | null;

    while ((match = templatePattern.exec(source))) {
      const objectChunk = this.sliceObjectLikeChunk(source, match.index);
      const chunk =
        objectChunk ?? source.slice(match.index, Math.min(source.length, match.index + 700));
      const explicitIdMatch =
        chunk.match(
          /[\\'"]*(?:activeId|active_id|eventId|event_id|location_value|locationValue)[\\'"]*\s*:\s*[\\'"]*(\d+)/i
        ) ?? undefined;
      const plainIdMatch =
        explicitIdMatch ??
        chunk.match(/[\\'"]*id[\\'"]*\s*:\s*[\\'"]*(\d+)/i) ??
        undefined;

      if (!plainIdMatch?.[1]) {
        continue;
      }

      candidates.push({
        id: plainIdMatch[1],
        score: 100 + this.scoreTreasureCandidateText(chunk),
        source: objectChunk ? "object" : "near-template"
      });
    }
  }

  private selectBestTreasureCandidate(candidates: TreasureEventCandidate[]): TreasureEventCandidate | undefined {
    const now = Math.floor(Date.now() / 1000);
    return candidates
      .map((candidate) => ({
        ...candidate,
        score:
          candidate.score +
          this.scoreTreasureCandidateState(candidate.status, candidate.startTime, candidate.endTime, now)
      }))
      .sort((left, right) => right.score - left.score)
      .find((candidate) => candidate.score >= 100);
  }

  private scoreTreasureCandidateState(
    status: number | undefined,
    startTime: number | undefined,
    endTime: number | undefined,
    now = Math.floor(Date.now() / 1000)
  ): number {
    let score = 0;

    if (status === 1) {
      score += 35;
    } else if (status === 0) {
      score -= 40;
    }

    if (startTime !== undefined && startTime > now) {
      score -= 25;
    }
    if (endTime !== undefined && endTime < now) {
      score -= 25;
    }
    if (
      (startTime === undefined || startTime <= now) &&
      (endTime === undefined || endTime >= now) &&
      (startTime !== undefined || endTime !== undefined)
    ) {
      score += 15;
    }

    return score;
  }

  private sliceObjectLikeChunk(source: string, pivot: number): string | undefined {
    let start = -1;
    let depth = 0;

    for (let index = pivot; index >= Math.max(0, pivot - 1200); index -= 1) {
      const char = source[index];
      if (char === "}") {
        depth += 1;
      } else if (char === "{") {
        if (depth === 0) {
          start = index;
          break;
        }
        depth -= 1;
      }
    }

    if (start < 0) {
      return undefined;
    }

    depth = 0;
    for (let index = start; index < Math.min(source.length, start + 3000); index += 1) {
      const char = source[index];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const chunk = source.slice(start, index + 1);
          const normalized = this.normalizeSearchText(chunk);
          if (
            /(?:template|location_template|locationtemplate)\s*['"]?\s*:\s*['"]?15/.test(normalized) &&
            !/(?:template|location_template|locationtemplate)\s*['"]?\s*:\s*['"]?(?!15\b)\d+/.test(normalized)
          ) {
            return chunk;
          }
          return undefined;
        }
      }
    }

    return undefined;
  }

  private scoreTreasureCandidateText(source: string): number {
    const text = this.normalizeSearchText(source);
    let score = 0;

    if (/bau|baus|tesouro|treasure|chest|baoxiang/.test(text)) {
      score += 25;
    }
    if (/amigo|amigos|friend|friends|refer|invite|convite|convid|indique|recomende/.test(text)) {
      score += 12;
    }
    if (/indicacao|afiliad|promocao|promocoes|ofertas|bonus/.test(text)) {
      score += 10;
    }
    if (/premio|premios|reward|recompensa|recompensas/.test(text)) {
      score += 8;
    }

    return score;
  }

  private readNumberish(value: unknown): string | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(Math.trunc(value));
    }

    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      return value.trim();
    }

    return undefined;
  }

  private readNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.trunc(value);
    }

    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
      return Number.parseInt(value.trim(), 10);
    }

    return undefined;
  }

  private readStringish(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private normalizeSearchText(value: string): string {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  // Espelho: a janela FOCADA (a que o operador esta usando) captura os eventos
  // reais e os encaminha; o replay e feito via CDP nas demais janelas. Anti-eco e
  // geometrico-independente: so encaminha quem tem document.hasFocus() (a janela
  // de destino fica em segundo plano e nunca reflete de volta).
  private async handleMirrorEvent(
    sourceProfileId: string,
    sourcePage: Page,
    sourceFrame: Frame,
    payload: unknown
  ): Promise<void> {
    const kind =
      payload && typeof payload === "object" && "kind" in payload
        ? String((payload as { kind?: unknown }).kind)
        : "unknown";
    const loggable = kind !== "pointermove";

    if (!this.mirrorEnabled || !this.isMirrorEventPayload(payload)) {
      if (loggable) {
        appendInputDiagnostic({
          kind: "mirror-node-dropped",
          event: kind,
          reason: !this.mirrorEnabled ? "mirror-disabled" : "invalid-payload",
          sourceProfileId
        });
      }
      return;
    }

    const now = Date.now();
    if ((this.mirrorReplayBlockedUntil.get(sourceProfileId) ?? 0) > now) {
      if (loggable) {
        appendInputDiagnostic({
          kind: "mirror-node-dropped",
          event: kind,
          reason: "target-replay-lock",
          sourceProfileId
        });
      }
      return;
    }

    const sourceHandle = this.handles.get(sourceProfileId);
    if (!sourceHandle) {
      if (loggable) {
        appendInputDiagnostic({
          kind: "mirror-node-dropped",
          event: kind,
          reason: "source-handle-missing",
          sourceProfileId
        });
      }
      return;
    }

    const mirroredSlots = [...this.mirrorSlotNumbers];
    if (!this.isHandleIncludedInSelection(sourceProfileId, sourceHandle, this.mirrorTargetSelection)) {
      if (loggable) {
        appendInputDiagnostic({
          kind: "mirror-node-dropped",
          event: kind,
          reason: "source-slot-not-selected",
          sourceProfileId,
          sourceSlot: sourceHandle.slotIndex + 1,
          mirroredSlots
        });
      }
      return;
    }

    const normalizedPayload = await this.projectMirrorPayloadFromFrame(
      sourcePage,
      sourceFrame,
      payload
    );
    if (!normalizedPayload) {
      if (loggable) {
        appendInputDiagnostic({
          kind: "mirror-node-dropped",
          event: kind,
          reason: "source-frame-projection-failed",
          sourceProfileId,
          sourceFrameUrl: sanitizeDiagnosticUrl(sourceFrame.url())
        });
      }
      return;
    }

    const targets = this.resolveTargetHandles(this.mirrorTargetSelection).filter(([profileId]) => profileId !== sourceProfileId);
    if (loggable) {
      appendInputDiagnostic({
        kind: "mirror-node-received",
        event: kind,
        sourceProfileId,
        sourceSlot: sourceHandle.slotIndex + 1,
        mirroredSlots,
        targetCount: targets.length,
        targetProfileIds: targets.map(([profileId]) => profileId)
      });
    }

    for (const [, handle] of targets) {
      this.queueMirrorEventForHandle(handle, normalizedPayload);
    }
  }

  private queueMirrorEventForHandle(handle: RuntimeHandle, payload: MirrorEventPayload): void {
    const previous = this.mirrorReplayProfileChains.get(handle.profileId) ?? Promise.resolve();
    const nextInChain = previous
      .catch(() => undefined)
      .then(() => {
        if (!this.mirrorEnabled) {
          return undefined;
        }
        return this.replayMirrorEventToHandle(handle, payload);
      })
      .catch((error) => {
        if (payload.kind !== "pointermove") {
          appendInputDiagnostic({
            kind: "mirror-replay-error",
            event: payload.kind,
            targetProfileId: handle.profileId,
            method: "queue",
            error: error instanceof Error ? error.message : String(error)
          });
        }
      });
    this.mirrorReplayProfileChains.set(handle.profileId, nextInChain);
    void nextInChain.finally(() => {
      if (this.mirrorReplayProfileChains.get(handle.profileId) === nextInChain) {
        this.mirrorReplayProfileChains.delete(handle.profileId);
      }
    });
  }

  private async installMirrorBinding(profileId: string, context: BrowserContext): Promise<void> {
    if (this.mirrorBindingContexts.has(context)) {
      return;
    }

    try {
      await context.exposeBinding(
        "__predatorMirrorEvent",
        async (source, payload: unknown) => {
          await this.handleMirrorEvent(profileId, source.page, source.frame, payload);
        }
      );
      this.mirrorBindingContexts.add(context);
      appendInputDiagnostic({ kind: "mirror-binding-installed", profileId });
    } catch (error) {
      appendInputDiagnostic({
        kind: "mirror-binding-error",
        profileId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private async projectMirrorPayloadFromFrame(
    sourcePage: Page,
    sourceFrame: Frame,
    payload: MirrorEventPayload
  ): Promise<MirrorEventPayload | undefined> {
    if (
      sourceFrame === sourcePage.mainFrame() ||
      payload.kind === "keydown" ||
      payload.kind === "keyup"
    ) {
      return payload;
    }
    if (sourceFrame.isDetached()) {
      return undefined;
    }

    const [frameElement, sourceViewport] = await Promise.all([
      sourceFrame.frameElement().catch(() => undefined),
      this.getMirrorViewport(sourcePage)
    ]);
    const frameBox = await frameElement?.boundingBox().catch(() => null);
    await frameElement?.dispose().catch(() => undefined);
    if (!frameBox || !sourceViewport) {
      return undefined;
    }
    return projectMirrorFrameCoordinates(payload, { frameBox, sourceViewport });
  }

  private isMirrorEventPayload(payload: unknown): payload is MirrorEventPayload {
    if (!payload || typeof payload !== "object" || !("kind" in payload)) {
      return false;
    }

    const kind = (payload as { kind?: unknown }).kind;
    return (
      typeof kind === "string" &&
      ["pointerdown", "pointerup", "pointermove", "wheel", "keydown", "keyup"].includes(kind)
    );
  }

  // Registra (uma vez por pagina) o script de captura no MUNDO PRINCIPAL via CDP
  // Page.addScriptToEvaluateOnNewDocument: re-injetado automaticamente a cada
  // navegacao, sem trabalho do Node por navegacao nem evaluate por evento. O estado
  // enabled fica embutido no script (re-registrado so quando muda) e tambem e
  // empurrado no documento atual para refletir o toggle imediatamente.
  private async installMirrorCaptureScript(
    page: Page,
    enabled: boolean,
    strict = false
  ): Promise<void> {
    page = this.unwrapPage(page);
    if (page.isClosed()) {
      return;
    }

    const session = await this.getMirrorSession(page);
    appendInputDiagnostic({
      kind: "mirror-capture-install-start",
      enabled,
      hasSession: Boolean(session),
      pageUrl: sanitizeDiagnosticUrl(page.url())
    });
    if (!session) {
      if (strict) {
        throw new Error("Nao foi possivel criar a sessao de captura da pagina.");
      }
      return;
    }

    const captureScript = this.buildMirrorCaptureScript(enabled);
    const captureStateCurrent =
      this.mirrorCaptureEnabledState.get(page) === enabled &&
      this.mirrorCaptureScriptIds.has(page);
    if (!captureStateCurrent) {
      const existingScriptId = this.mirrorCaptureScriptIds.get(page);
      if (existingScriptId) {
        try {
          await session.send("Page.removeScriptToEvaluateOnNewDocument", {
            identifier: existingScriptId
          });
        } catch (error) {
          if (strict) {
            throw error;
          }
        }
        this.mirrorCaptureScriptIds.delete(page);
      }

      try {
        const response = await session.send("Page.addScriptToEvaluateOnNewDocument", {
          source: captureScript
        });
        const identifier = (response as { identifier?: string }).identifier;
        if (!identifier && strict) {
          throw new Error("O Chromium nao confirmou o script para novos frames.");
        }
        if (identifier) {
          this.mirrorCaptureScriptIds.set(page, identifier);
        }
        this.mirrorCaptureEnabledState.set(page, enabled);
        appendInputDiagnostic({
          kind: "mirror-capture-newdoc-registered",
          enabled,
          identifier: identifier ?? null,
          pageUrl: sanitizeDiagnosticUrl(page.url())
        });
      } catch (error) {
        this.invalidateMirrorSessionCaches(page);
        appendInputDiagnostic({
          kind: "mirror-capture-newdoc-error",
          enabled,
          pageUrl: sanitizeDiagnosticUrl(page.url()),
          error: error instanceof Error ? error.message : String(error)
        });
        if (strict) {
          throw error;
        }
      }
    }

    let lastFrameStates = new Map<Frame, boolean>();
    const passCount = strict ? 2 : 1;
    for (let pass = 1; pass <= passCount; pass += 1) {
      const frames = page.frames().filter((frame) => !frame.isDetached());
      const frameResults = await Promise.all(
        frames.map(async (frame): Promise<[Frame, boolean]> => {
          const frameUrl = sanitizeDiagnosticUrl(frame.url());
          try {
            await frame.evaluate(
              captureScript,
              undefined,
              PATCHRIGHT_INIT_SCRIPT_CONTEXT
            );
            const liveState = await frame.evaluate(
              () => {
                const w = globalThis as unknown as {
                  __predatorMirrorCaptureInstalled?: boolean;
                  __predatorMirrorEnabled?: boolean;
                  __predatorMirrorEvent?: unknown;
                  document?: { hasFocus?: () => boolean };
                };
                return {
                  installed: Boolean(w.__predatorMirrorCaptureInstalled),
                  enabled: Boolean(w.__predatorMirrorEnabled),
                  hasBinding: typeof w.__predatorMirrorEvent === "function",
                  focused: Boolean(w.document?.hasFocus?.())
                };
              },
              undefined,
              PATCHRIGHT_INIT_SCRIPT_CONTEXT
            );
            const ready =
              liveState.installed &&
              liveState.enabled === enabled &&
              (!enabled || liveState.hasBinding);
            appendInputDiagnostic({
              kind: "mirror-capture-frame-state",
              enabled,
              pass,
              ready,
              liveState,
              pageUrl: sanitizeDiagnosticUrl(page.url()),
              frameUrl
            });
            return [frame, ready];
          } catch (error) {
            appendInputDiagnostic({
              kind: "mirror-capture-frame-error",
              enabled,
              pass,
              pageUrl: sanitizeDiagnosticUrl(page.url()),
              frameUrl,
              error: error instanceof Error ? error.message : String(error)
            });
            return [frame, false];
          }
        })
      );
      lastFrameStates = new Map(frameResults);
    }

    if (strict) {
      const unreadyFrames = page
        .frames()
        .filter((frame) => !frame.isDetached() && lastFrameStates.get(frame) !== true);
      if (unreadyFrames.length > 0) {
        throw new Error(
          `O capturador nao foi instalado em ${unreadyFrames.length} frame(s) ativo(s).`
        );
      }
    }
  }

  private buildMirrorCaptureScript(enabled: boolean): string {
    return `
(() => {
  window.__predatorMirrorEnabled = ${enabled ? "true" : "false"};
  if (window.__predatorMirrorCaptureInstalled) return;
  window.__predatorMirrorCaptureInstalled = true;
  const diag = (payload) => {
    try { if (typeof window.__spiderInputDiagnostic === 'function') window.__spiderInputDiagnostic(payload); } catch (e) {}
  };
  const on = () => window.__predatorMirrorEnabled === true;
  const replaying = () => {
    try {
      return window.__predatorMirrorReplaying === true ||
        Date.now() < (Number(window.__predatorMirrorReplayUntil) || 0);
    } catch (e) {
      return false;
    }
  };
  diag({ kind: 'mirror-capture-installed', enabled: on(), hasBinding: typeof window.__predatorMirrorEvent === 'function' });
  const send = (p) => {
    const loggable = p.kind !== 'pointermove';
    const enabledNow = on();
    const replayingNow = replaying();
    let focused = false;
    try { focused = document.hasFocus(); } catch (e) { focused = false; }
    const hasBinding = typeof window.__predatorMirrorEvent === 'function';
    if (loggable) diag({ kind: 'mirror-capture-event', event: p.kind, enabled: enabledNow, replaying: replayingNow, focused, hasBinding });
    if (!enabledNow || replayingNow || !focused || !hasBinding) return;
    try { Promise.resolve(window.__predatorMirrorEvent(p)).catch(() => {}); } catch (e) {}
  };
  const ratio = (e, kind) => ({
    kind,
    xRatio: window.innerWidth > 0 ? e.clientX / window.innerWidth : 0.5,
    yRatio: window.innerHeight > 0 ? e.clientY / window.innerHeight : 0.5,
    button: typeof e.button === 'number' ? e.button : 0,
    buttons: typeof e.buttons === 'number' ? e.buttons : 0,
    pointerType: typeof e.pointerType === 'string' ? e.pointerType : ''
  });
  let lastMove = 0;
  window.addEventListener('pointerdown', (e) => send(ratio(e, 'pointerdown')), true);
  window.addEventListener('pointerup', (e) => send(ratio(e, 'pointerup')), true);
  window.addEventListener('pointermove', (e) => {
    if (!e.buttons) return;
    const t = e.timeStamp || 0;
    if (t - lastMove < 16) return;
    lastMove = t;
    send(ratio(e, 'pointermove'));
  }, true);
  window.addEventListener('wheel', (e) => { const p = ratio(e, 'wheel'); p.deltaX = e.deltaX; p.deltaY = e.deltaY; send(p); }, true);
  window.addEventListener('keydown', (e) => { if (e.key && e.key.length <= 32) send({ kind: 'keydown', key: e.key, code: e.code, keyCode: e.keyCode, text: e.key.length === 1 ? e.key : '' }); }, true);
  window.addEventListener('keyup', (e) => { if (e.key && e.key.length <= 32) send({ kind: 'keyup', key: e.key, code: e.code, keyCode: e.keyCode }); }, true);
})();
`;
  }

  private invalidateMirrorSessionCaches(page: Page): void {
    this.mirrorSessions.delete(page);
    this.mirrorCaptureScriptIds.delete(page);
    this.mirrorCaptureEnabledState.delete(page);
  }

  private async getMirrorSession(page: Page): Promise<CDPSession | undefined> {
    if (page.isClosed()) {
      return undefined;
    }
    const existing = this.mirrorSessions.get(page);
    if (existing) {
      return existing;
    }
    const session = await page.context().newCDPSession(page).catch(() => undefined);
    if (session) {
      this.mirrorSessions.set(page, session);
    }
    return session;
  }

  private async getMirrorViewport(page: Page): Promise<{ width: number; height: number } | undefined> {
    const cached = this.mirrorViewportCache.get(page);
    if (cached) {
      return cached;
    }
    const viewport = await page
      .evaluate(() => ({
        width: (globalThis as unknown as { innerWidth?: number }).innerWidth ?? 0,
        height: (globalThis as unknown as { innerHeight?: number }).innerHeight ?? 0
      }))
      .catch(() => undefined);
    if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
      return undefined;
    }
    this.mirrorViewportCache.set(page, viewport);
    return viewport;
  }

  private cdpMouseButton(button?: number): "left" | "middle" | "right" | "back" | "forward" {
    switch (button) {
      case 1:
        return "middle";
      case 2:
        return "right";
      case 3:
        return "back";
      case 4:
        return "forward";
      default:
        return "left";
    }
  }

  private clearMirrorReplayMarker(page: Page): void {
    this.mirrorReplayMarkedPages.delete(page);
    const timer = this.mirrorReplayClearTimers.get(page);
    if (timer) {
      clearTimeout(timer);
      this.mirrorReplayClearTimers.delete(page);
    }
  }

  private scheduleMirrorReplayMarkerClear(page: Page, session: CDPSession): void {
    const existingTimer = this.mirrorReplayClearTimers.get(page);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.mirrorReplayClearTimers.delete(page);
      this.mirrorReplayMarkedPages.delete(page);
      if (page.isClosed()) {
        return;
      }

      void session
        .send("Runtime.evaluate", {
          expression: `(() => {
            try {
              window.__predatorMirrorReplaying = false;
              window.__predatorMirrorReplayUntil = 0;
            } catch (e) {}
          })()`,
          awaitPromise: false,
          returnByValue: false
        })
        .catch(() => undefined);
    }, BrowserRuntimeService.MIRROR_REPLAY_CLEAR_DELAY_MS);
    const maybeNodeTimer = timer as { unref?: () => void };
    if (typeof maybeNodeTimer.unref === "function") {
      maybeNodeTimer.unref();
    }

    this.mirrorReplayClearTimers.set(page, timer);
  }

  private async markMirrorReplayWindow(page: Page, session: CDPSession): Promise<void> {
    if (page.isClosed()) {
      return;
    }

    this.scheduleMirrorReplayMarkerClear(page, session);
    if (this.mirrorReplayMarkedPages.has(page)) {
      return;
    }

    const marked = await session
      .send("Runtime.evaluate", {
        expression: `(() => {
          try {
            window.__predatorMirrorReplaying = true;
            window.__predatorMirrorReplayUntil = Date.now() + 1000;
          } catch (e) {}
        })()`,
        awaitPromise: false,
        returnByValue: false
      })
      .then(() => true)
      .catch(() => false);
    if (marked) {
      this.mirrorReplayMarkedPages.add(page);
    }
  }

  private buildMirrorTouchPoint(x: number, y: number): Record<string, unknown> {
    return {
      x,
      y,
      id: 1,
      radiusX: 2,
      radiusY: 2,
      force: 0.5
    };
  }

  private async dispatchTouchMirrorEvent(
    page: Page,
    dispatch: (method: string, params: Record<string, unknown>) => Promise<void>,
    payload: MirrorEventPayload,
    x: number,
    y: number
  ): Promise<void> {
    const touchPoint = this.buildMirrorTouchPoint(x, y);

    if (payload.kind === "pointerdown") {
      this.mirrorTouchActive.set(page, true);
      await dispatch("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [touchPoint]
      });
      return;
    }

    if (payload.kind === "pointermove") {
      if (!this.mirrorTouchActive.get(page)) {
        this.mirrorTouchActive.set(page, true);
        await dispatch("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [touchPoint]
        });
      }
      await dispatch("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [touchPoint]
      });
      return;
    }

    if (payload.kind === "pointerup") {
      if (!this.mirrorTouchActive.get(page)) {
        await dispatch("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [touchPoint]
        });
      }
      this.mirrorTouchActive.delete(page);
      await dispatch("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: []
      });
    }
  }

  // Replay via CDP Input.*: mouse continua auto-contido; touch guarda apenas se ha
  // um toque ativo por pagina para manter drag/scroll como touchStart -> touchMove -> touchEnd.
  // O CDP roteia a coordenada para o elemento/iframe correto na pagina de destino.
  private async replayMirrorEventToHandle(handle: RuntimeHandle, payload: MirrorEventPayload): Promise<void> {
    const page = await this.getRuntimePage(handle);
    if (!page || page.isClosed()) {
      if (payload.kind !== "pointermove") {
        appendInputDiagnostic({
          kind: "mirror-replay-dropped",
          event: payload.kind,
          reason: "no-page",
          targetProfileId: handle.profileId
        });
      }
      return;
    }

    // Encadeia o dispatch deste evento apos o anterior DA MESMA pagina, garantindo
    // que press/move/release cheguem ao CDP na ordem capturada (corrige drag/scroll).
    const previous = this.mirrorReplayChains.get(page) ?? Promise.resolve();
    const nextInChain = previous
      .catch(() => undefined)
      .then(() => this.dispatchMirrorEventToPage(page, handle.profileId, handle.mobileLike, payload));
    this.mirrorReplayChains.set(page, nextInChain);
    await nextInChain;
  }

  private async dispatchMirrorEventToPage(
    page: Page,
    targetProfileId: string,
    targetMobileLike: boolean,
    payload: MirrorEventPayload
  ): Promise<void> {
    const loggable = payload.kind !== "pointermove";
    if (page.isClosed()) {
      return;
    }
    this.mirrorReplayBlockedUntil.set(
      targetProfileId,
      Date.now() + BrowserRuntimeService.MIRROR_REPLAY_CLEAR_DELAY_MS
    );
    const session = await this.getMirrorSession(page);
    if (!session) {
      if (loggable) {
        appendInputDiagnostic({
          kind: "mirror-replay-dropped",
          event: payload.kind,
          reason: "no-session",
          targetProfileId,
          pageUrl: sanitizeDiagnosticUrl(page.url())
        });
      }
      return;
    }

    const dispatch = async (method: string, params: Record<string, unknown>): Promise<void> => {
      await this.markMirrorReplayWindow(page, session);
      await session
        .send(method as Parameters<typeof session.send>[0], params as never)
        .then(() => {
          if (loggable) {
            appendInputDiagnostic({
              kind: "mirror-replay-dispatched",
              event: payload.kind,
              targetProfileId,
              method,
              params
            });
          }
        })
        .catch((error) => {
          // So invalidamos o cache se o erro indica que a sessao morreu —
          // erros transientes nao devem zerar o cache (causa cascata e
          // intermitencia: pinga-pongue de re-criar sessao a cada evento).
          const msg = error instanceof Error ? error.message : String(error);
          if (
            msg.includes("Target page, context or browser has been closed") ||
            msg.includes("Session closed") ||
            msg.includes("Protocol error") ||
            msg.includes("Target closed")
          ) {
            this.invalidateMirrorSessionCaches(page);
          }
          appendInputDiagnostic({
            kind: "mirror-replay-error",
            event: payload.kind,
            targetProfileId,
            method,
            error: msg
          });
        });
    };

    if (payload.kind === "keydown" || payload.kind === "keyup") {
      if (!payload.key || payload.key.length > 32) {
        return;
      }
      const text = payload.kind === "keydown" && payload.text ? payload.text : undefined;
      await dispatch("Input.dispatchKeyEvent", {
        type: payload.kind === "keydown" ? "keyDown" : "keyUp",
        key: payload.key,
        ...(payload.code ? { code: payload.code } : {}),
        ...(typeof payload.keyCode === "number" ? { windowsVirtualKeyCode: payload.keyCode } : {}),
        ...(text ? { text, unmodifiedText: text } : {})
      });
      return;
    }

    const viewport = await this.getMirrorViewport(page);
    if (!viewport) {
      if (loggable) {
        appendInputDiagnostic({
          kind: "mirror-replay-dropped",
          event: payload.kind,
          reason: "no-viewport",
          targetProfileId,
          pageUrl: sanitizeDiagnosticUrl(page.url())
        });
      }
      return;
    }
    const x = Math.round(this.clampNumber(payload.xRatio ?? 0.5, 0, 1) * Math.max(1, viewport.width));
    const y = Math.round(this.clampNumber(payload.yRatio ?? 0.5, 0, 1) * Math.max(1, viewport.height));
    const buttons = typeof payload.buttons === "number" ? payload.buttons : 0;
    const replayAsTouch = targetMobileLike || payload.pointerType === "touch";

    if (payload.kind === "wheel") {
      await dispatch("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: payload.deltaX ?? 0,
        deltaY: payload.deltaY ?? 0
      });
      return;
    }

    if (replayAsTouch) {
      await this.dispatchTouchMirrorEvent(page, dispatch, payload, x, y);
      return;
    }

    if (payload.kind === "pointermove") {
      await dispatch("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons });
      return;
    }

    await dispatch("Input.dispatchMouseEvent", {
      type: payload.kind === "pointerdown" ? "mousePressed" : "mouseReleased",
      x,
      y,
      button: this.cdpMouseButton(payload.button),
      buttons,
      clickCount: 1
    });
  }

  private buildRuntimeControlsScript(): string {
    return `
(() => {
  // NUNCA definir __predatorRuntimeControlsInstalled - isso Ã© um sinal de automaÃ§Ã£o!
  // Sites de detecÃ§Ã£o como o que vocÃª testou procuram exatamente por essa variÃ¡vel
  // if (window.__predatorRuntimeControlsInstalled) return; <- REMOVIDO
  // window.__predatorRuntimeControlsInstalled = true; <- REMOVIDO
  if (typeof window.__predatorApplySpeedHack === "function") {
    return;
  }

  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeSetInterval = window.setInterval.bind(window);
  const nativeRequestAnimationFrame = window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : undefined;
  const nativeDateNow = Date.now.bind(Date);
  const realStart = nativeDateNow();
  const virtualStart = realStart;
  let speedRate = 1;
  let speedOverridesInstalled = false;

  const clampRate = (value) => Math.max(1, Math.min(25, Number.isFinite(Number(value)) ? Number(value) : 1));
  const scaledDelay = (delay) => Math.max(0, (Number(delay) || 0) / speedRate);

  const installSpeedOverrides = () => {
    if (speedOverridesInstalled) return;
    speedOverridesInstalled = true;

    window.setTimeout = (handler, timeout, ...args) => nativeSetTimeout(handler, scaledDelay(timeout), ...args);
    window.setInterval = (handler, timeout, ...args) => nativeSetInterval(handler, scaledDelay(timeout), ...args);

    if (nativeRequestAnimationFrame) {
      window.requestAnimationFrame = (callback) =>
        nativeRequestAnimationFrame((timestamp) => callback(virtualStart + (timestamp - realStart) * speedRate));
    }

    try {
      Date.now = () => Math.round(virtualStart + (nativeDateNow() - realStart) * speedRate);
    } catch {
      // Some engines may prevent Date.now reassignment.
    }

    try {
      const nativePerformanceNow = performance.now.bind(performance);
      const performanceStart = nativePerformanceNow();
      Object.defineProperty(performance, "now", {
        configurable: true,
        value: () => performanceStart + (nativePerformanceNow() - performanceStart) * speedRate
      });
    } catch {
      // Performance timing is best-effort.
    }
  };

  const restoreSpeedOverrides = () => {
    if (!speedOverridesInstalled) return;
    speedOverridesInstalled = false;

    try { window.setTimeout = nativeSetTimeout; } catch {}
    try { window.setInterval = nativeSetInterval; } catch {}
    if (nativeRequestAnimationFrame) {
      try { window.requestAnimationFrame = nativeRequestAnimationFrame; } catch {}
    }
    try {
      Object.defineProperty(Date, "now", { configurable: true, writable: true, value: nativeDateNow });
    } catch {}
    try {
      const nativePerformanceNow = performance.now.bind(performance);
      Object.defineProperty(performance, "now", {
        configurable: true,
        value: nativePerformanceNow
      });
    } catch {}
  };

  const applyPlaybackRate = () => {
    try {
      for (const media of document.querySelectorAll("video,audio")) {
        media.playbackRate = speedRate;
      }
      for (const animation of document.getAnimations ? document.getAnimations() : []) {
        animation.playbackRate = speedRate;
      }
    } catch {
      // Media and animation hooks are opportunistic.
    }
  };
  let playbackRateIntervalId = null;
  const updatePlaybackRateInterval = () => {
    if (speedRate === 1) {
      if (playbackRateIntervalId) {
        clearInterval(playbackRateIntervalId);
        playbackRateIntervalId = null;
      }
      return;
    }

    if (!playbackRateIntervalId) {
      playbackRateIntervalId = nativeSetInterval(applyPlaybackRate, 1000);
    }
  };

  window.__predatorApplySpeedHack = (rate) => {
    speedRate = clampRate(rate);
    if (speedRate > 1) {
      installSpeedOverrides();
    } else {
      restoreSpeedOverrides();
    }
    applyPlaybackRate();
    updatePlaybackRateInterval();
  };

  // O espelho NAO mora mais aqui: a captura roda no mundo principal (via CDP
  // Page.addScriptToEvaluateOnNewDocument) e encaminha pelo binding. Mantendo este
  // script so com o speed hack ele fica mais leve e sem dependencia de atributos.

  // Popup cleanup is Node-driven and uses only the device-encrypted server payload.

`;
  }

  // Speed/Mirror precisam rodar no MUNDO PRINCIPAL da pagina para sobrescrever os
  // timers reais (speed) e capturar eventos reais + usar o binding __predatorMirrorEvent
  // (mirror). A config (rate/mirror/replay) viaja por atributos no <html> -- o canal
  // compartilhado entre mundos -- lidos de forma lazy pelo script.
  private buildMainWorldControlsScript(
    initialSpeedRate = 1,
    options: { pgGameOnly?: boolean } = {}
  ): string {
    const safeInitialSpeedRate = this.clampNumber(initialSpeedRate, 1, 25);
    return `
(() => {
  const pgGameOnly = ${JSON.stringify(Boolean(options.pgGameOnly))};
  // Padroes de frame de jogo conhecidos (do registry de provedores). O speed so
  // ativa dentro de um iframe de jogo reconhecido — evita interferir em timers de
  // login/cadastro/deposito/saque.
  const gameFramePatterns = ${JSON.stringify(knownGameFramePatternSources())}.map((s) => {
    try { return new RegExp(s, "i"); } catch (e) { return null; }
  }).filter(Boolean);
  const cocosDirectorTickPatterns = ${JSON.stringify(cocosDirectorTickFramePatternSources())}.map((s) => {
    try { return new RegExp(s, "i"); } catch (e) { return null; }
  }).filter(Boolean);
  const uhtDeltaTimePatterns = ${JSON.stringify(uhtDeltaTimeFramePatternSources())}.map((s) => {
    try { return new RegExp(s, "i"); } catch (e) { return null; }
  }).filter(Boolean);
  // A assinatura de query identifica o documento do jogo JDB mesmo quando uma
  // variante o abre diretamente como pagina principal da nova aba.
  const isJdbGameDocument = () => {
    try {
      const params = new URLSearchParams(window.location.search || "");
      return params.has("gVer") && params.has("gameType") && params.has("mType");
    } catch (e) {
      return false;
    }
  };
  const jdbGameDocument = isJdbGameDocument();
  const isUhtDeltaTimeDocument = () => {
    try {
      const path = window.location.pathname || "";
      const href = window.location.href || "";
      return uhtDeltaTimePatterns.some((pattern) => pattern.test(path) || pattern.test(href));
    } catch (e) {
      return false;
    }
  };
  const uhtDeltaTimeDocument = isUhtDeltaTimeDocument();
  const isKnownGameFrame = () => {
    try {
      if (jdbGameDocument) return true;
      if (uhtDeltaTimeDocument) return true;
      if (window.top === window) return false;
      const path = window.location.pathname || "";
      const href = window.location.href || "";
      return gameFramePatterns.some((re) => re.test(path) || re.test(href));
    } catch (e) {
      return false;
    }
  };
  // Frame de jogo PG/Cocos especificamente: so a guarda de loading/interstitial
  // do Cocos (abaixo) depende disto; outros provedores nao sao gated por ela.
  const isPgCocosFrame = () => {
    try {
      if (window.top === window) return false;
      return /\\/\\d+\\/index\\.html$/i.test(window.location.pathname || "");
    } catch (e) {
      return false;
    }
  };
  const isCocosDirectorTickFrame = () => {
    try {
      if (window.top === window) return false;
      const path = window.location.pathname || "";
      const href = window.location.href || "";
      return cocosDirectorTickPatterns.some((re) => re.test(path) || re.test(href));
    } catch (e) {
      return false;
    }
  };
  if (pgGameOnly && !isKnownGameFrame()) return;
  const existingFullControls = () => {
    try {
      return Boolean(window.__predatorMWFull) ||
        Boolean(window.__predatorMW && document.documentElement && document.documentElement.getAttribute('data-rtc-init') === '1');
    } catch (e) {
      return Boolean(window.__predatorMWFull);
    }
  };
  if (existingFullControls()) return;
  window.__predatorMW = true;
  window.__predatorMWFull = true;
  const clamp = (v) => Math.max(1, Math.min(25, Number(v) || 1));
  const initialSpeedRate = ${JSON.stringify(safeInitialSpeedRate)};
  let root = null;
  const getRoot = () => {
    if (root && root.isConnected) return root;
    try { root = document.documentElement || null; } catch (e) { root = null; }
    return root;
  };
  const readAttr = (name) => {
    const currentRoot = getRoot();
    if (!currentRoot) return null;
    try { return currentRoot.getAttribute(name); } catch (e) { return null; }
  };
  const writeAttr = (name, value) => {
    const currentRoot = getRoot();
    if (!currentRoot) return false;
    try { currentRoot.setAttribute(name, value); return true; } catch (e) { return false; }
  };
  // Cache de loading PG: a tela pode reaparecer depois que o jogo ja iniciou.
  // Manter esse estado separado evita consultar DOM a cada frame/timer e permite
  // restaurar os relogios nativos durante reconexao, carregamento ou erro.
  let pgLoadingState = isPgCocosFrame();
  // Um canvas pode aparecer antes de o loader grafico ser montado. No primeiro
  // boot, so liberamos o Speed Time depois de observar um bloqueio sobre um
  // canvas e sua remocao. O clique no canvas e o fallback para jogos sem loader DOM.
  let pgSawBlockingLayerAfterCanvas = false;
  let pgUserConfirmedReady = false;
  // O shell JDB monta o painel antes de remover o loader. Mantemos 1x enquanto
  // esse loader estiver visivel e liberamos o speed quando os controles reais
  // aparecem, sem depender de host, texto traduzido ou clique de aposta.
  let jdbLoadingState = jdbGameDocument;
  const isElementVisible = (element) => {
    try {
      if (!element || typeof window.getComputedStyle !== "function") return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
    } catch (e) {
      return false;
    }
  };
  const isCanvasInteractiveAtCenter = (canvas) => {
    try {
      if (!canvas || typeof document.elementFromPoint !== "function") return false;
      const canvasRect = canvas.getBoundingClientRect();
      if (canvasRect.width < 1 || canvasRect.height < 1) return false;
      const x = canvasRect.left + canvasRect.width / 2;
      const y = canvasRect.top + canvasRect.height / 2;
      return document.elementFromPoint(x, y) === canvas;
    } catch (e) {
      return false;
    }
  };
  const refreshPgLoadingState = () => {
    if (!isPgCocosFrame()) return false;
    let nextState = true;
    try {
      const text = String(document.body && document.body.innerText || "");
      const loadingPattern = /A\\s*carregar|A\\s*iniciar\\s*sess[aã]o|INICIAR|Retorno\\s+para\\s+o\\s+Jogador|Internet\\s+est[aá]\\s+lenta|lig[aá]?[cç][aã]o\\s+[àa]\\s+Internet\\s+est[aá]\\s+lenta|Atualizar|Aguardar|Jogos\\s+PG\\s+Oficiais|Ignorar|Aceitar|verifica/i;
      const canvas = document.querySelector('#GameCanvas,canvas.gameCanvas,canvas');
      const canvasInteractive = Boolean(canvas && isCanvasInteractiveAtCenter(canvas));
      const loaderVisible = loadingPattern.test(text);
      const blockedAfterCanvas = Boolean(canvas) && (!canvasInteractive || loaderVisible);
      if (blockedAfterCanvas) {
        pgSawBlockingLayerAfterCanvas = true;
      }
      if (document.body && canvas && canvasInteractive && !loaderVisible && (pgSawBlockingLayerAfterCanvas || pgUserConfirmedReady)) {
        nextState = false;
      }
    } catch (e) {}
    const changed = pgLoadingState !== nextState;
    pgLoadingState = nextState;
    writeAttr('data-rtc-game-ready', nextState ? '0' : '1');
    return changed;
  };
  const refreshJdbLoadingState = () => {
    if (!jdbGameDocument) return false;
    let nextState = true;
    try {
      const controls = document.querySelector('#gameControlPanel,.spin-button');
      const loader = document.querySelector('.loading-wrapper');
      nextState = isElementVisible(loader) || !isElementVisible(controls);
    } catch (e) {}
    const changed = jdbLoadingState !== nextState;
    jdbLoadingState = nextState;
    return changed;
  };
  const isPgLoadingOrInterstitial = () => pgLoadingState;
  const isUhtLoading = () => uhtDeltaTimeDocument && globalThis.loaderIsVisible !== false;
  const readDesiredRate = () => clamp(readAttr('data-rtc-speed') || initialSpeedRate);
  const readRate = () => (
    isPgLoadingOrInterstitial() || jdbLoadingState || isUhtLoading()
      ? 1
      : readDesiredRate()
  );
  const syncGameSpeedRate = () => {
    try {
      window.__predatorGameSpeedRate = readRate();
      window.__predatorGameDesiredSpeedRate = readDesiredRate();
    } catch (e) {}
  };
  syncGameSpeedRate();

  // ---- SPEED ----
  const nST = window.setTimeout;
  const nSI = window.setInterval;
  const nCI = window.clearInterval;
  const nRAF = window.requestAnimationFrame;
  const NativeDate = window.Date;
  const nNow = NativeDate.now;
  const nPN = performance.now;
  const start = nNow();
  const scaled = (t) => Math.max(0, (Number(t) || 0) / readRate());
  const performanceStart = nPN.call(performance);
  const virtualDateNow = () => Math.round(start + (nNow() - start) * readRate());
  const ScaledDate = function(...args) {
    if (!new.target) return new NativeDate(virtualDateNow()).toString();
    return args.length === 0
      ? Reflect.construct(NativeDate, [virtualDateNow()], new.target)
      : Reflect.construct(NativeDate, args, new.target);
  };
  try {
    Object.setPrototypeOf(ScaledDate, NativeDate);
    ScaledDate.prototype = NativeDate.prototype;
    Object.defineProperty(ScaledDate, 'name', { configurable: true, value: 'Date' });
    Object.defineProperty(ScaledDate, 'now', { configurable: true, value: virtualDateNow });
  } catch (e) {}
  let speedInstalled = false;
  const installSpeed = () => {
    if (speedInstalled) return;
    speedInstalled = true;
    window.setTimeout = (h, t, ...a) => nST.call(window, h, scaled(t), ...a);
    window.setInterval = (h, t, ...a) => nSI.call(window, h, scaled(t), ...a);
    if (nRAF) {
      window.requestAnimationFrame = (cb) =>
        nRAF.call(window, (ts) => cb(performanceStart + (ts - performanceStart) * readRate()));
    }
    try {
      if (jdbGameDocument) window.Date = ScaledDate;
      else NativeDate.now = virtualDateNow;
    } catch (e) {}
    try {
      Object.defineProperty(performance, 'now', {
        configurable: true,
        value: () => performanceStart + (nPN.call(performance) - performanceStart) * readRate()
      });
    } catch (e) {}
  };
  const restoreSpeed = () => {
    if (!speedInstalled) return;
    speedInstalled = false;
    try { window.setTimeout = nST; } catch (e) {}
    try { window.setInterval = nSI; } catch (e) {}
    if (nRAF) {
      try { window.requestAnimationFrame = nRAF; } catch (e) {}
    }
    try {
      window.Date = NativeDate;
      NativeDate.now = nNow;
    } catch (e) {}
    try {
      Object.defineProperty(performance, 'now', { configurable: true, value: nPN });
    } catch (e) {}
  };
  const syncSpeed = () => {
    syncGameSpeedRate();
    // Para o candidato WG/Cocos o delta e escalado por Director.tick(). Nao
    // sobrescrevemos os timers/RAF aqui, pois isso faria o mesmo delta ser
    // acelerado uma segunda vez.
    if (isCocosDirectorTickFrame()) {
      restoreSpeed();
      return;
    }
    if (uhtDeltaTimeDocument) {
      restoreSpeed();
      return;
    }
    if (jdbGameDocument) installSpeed();
    else if (readRate() > 1) installSpeed();
    else restoreSpeed();
  };
  syncSpeed();

  if (jdbGameDocument) {
    const refreshAndSyncJdbSpeed = () => {
      if (refreshJdbLoadingState()) syncSpeed();
    };
    refreshAndSyncJdbSpeed();
    nSI.call(window, refreshAndSyncJdbSpeed, 300);
  }

  const installUhtDeltaTimeSpeed = () => {
    try {
      const time = globalThis.Time;
      if (!time || typeof time.deltaTime !== "number") return false;
      if (time.__predatorUhtDeltaTime) return true;
      const descriptor = Object.getOwnPropertyDescriptor(time, "deltaTime");
      if (!descriptor || !descriptor.configurable) return false;
      let rawDelta = time.deltaTime;
      Object.defineProperty(time, "deltaTime", {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() { return rawDelta * readRate(); },
        set(value) { rawDelta = Number(value) || 0; }
      });
      Object.defineProperty(time, "__predatorUhtDeltaTime", { value: true });
      return true;
    } catch (e) {
      return false;
    }
  };
  if (uhtDeltaTimeDocument) {
    let attempts = 0;
    const retryId = nSI.call(window, () => {
      attempts += 1;
      if (installUhtDeltaTimeSpeed() || attempts >= 300) {
        nCI.call(window, retryId);
      }
    }, 50);
    if (installUhtDeltaTimeSpeed()) {
      nCI.call(window, retryId);
    }
  }

  if (isPgCocosFrame()) {
    let refreshPending = false;
    const refreshAndSyncSpeed = () => {
      if (refreshPgLoadingState()) syncSpeed();
    };
    const confirmPgReadyFromCanvasInteraction = (event) => {
      try {
        const canvas = document.querySelector('#GameCanvas,canvas.gameCanvas,canvas');
        if (canvas && event.target === canvas && isCanvasInteractiveAtCenter(canvas)) {
          pgUserConfirmedReady = true;
          refreshAndSyncSpeed();
        }
      } catch (e) {}
    };
    const schedulePgLoadingRefresh = () => {
      if (refreshPending) return;
      refreshPending = true;
      nST.call(window, () => {
        refreshPending = false;
        refreshAndSyncSpeed();
      }, 80);
    };
    refreshAndSyncSpeed();
    try {
      new MutationObserver(schedulePgLoadingRefresh).observe(document.documentElement, {
        childList: true,
        characterData: true,
        subtree: true
      });
    } catch (e) {}
    try { document.addEventListener('pointerdown', confirmPgReadyFromCanvasInteraction, true); } catch (e) {}
    nSI.call(window, refreshAndSyncSpeed, 300);
  }

  // A rota /clientv3/index.html seleciona um candidato WG; a presenca de
  // cc.Director.prototype.tick confirma Cocos 3 antes de qualquer patch.
  // O WG alimenta sistemas, componentes e renderizacao pelo delta de tick().
  const installCocosDirectorTickSpeed = () => {
    try {
      const prototype = globalThis.cc && globalThis.cc.Director && globalThis.cc.Director.prototype;
      if (!prototype || typeof prototype.tick !== "function") return false;
      if (prototype.tick.__predatorCocosDirectorTick) return true;
      const originalTick = prototype.tick;
      const patchedTick = function(delta, ...rest) {
        const rate = readRate();
        const scaledDelta = typeof delta === "number" && Number.isFinite(delta) ? delta * rate : delta;
        return originalTick.call(this, scaledDelta, ...rest);
      };
      Object.defineProperty(patchedTick, "__predatorCocosDirectorTick", { value: true });
      prototype.tick = patchedTick;
      return prototype.tick === patchedTick;
    } catch (e) {
      return false;
    }
  };
  if (isCocosDirectorTickFrame()) {
    let attempts = 0;
    const retryId = nSI.call(window, () => {
      attempts += 1;
      if (installCocosDirectorTickSpeed() || attempts >= 200) {
        nCI.call(window, retryId);
      }
    }, 50);
    installCocosDirectorTickSpeed();
  }

  let observerInstalled = false;
  const bindRootControls = () => {
    const currentRoot = getRoot();
    if (!currentRoot) return;
    if (initialSpeedRate > 1 && !readAttr('data-rtc-speed')) {
      writeAttr('data-rtc-speed', String(initialSpeedRate));
      syncSpeed();
    }
    if (!observerInstalled) {
      observerInstalled = true;
      try {
        new MutationObserver((records) => {
          if (records.some((record) => record.attributeName === 'data-rtc-speed')) syncSpeed();
        }).observe(currentRoot, { attributes: true, attributeFilter: ['data-rtc-speed'] });
      } catch (e) {}
    }
    writeAttr('data-rtc-init', '1');
  };
  bindRootControls();
  if (!getRoot()) {
    try {
      document.addEventListener('DOMContentLoaded', bindRootControls, { once: true });
    } catch (e) {}
  }

  nSI.call(window, () => {
    const r = readRate();
    try {
      for (const m of document.querySelectorAll('video,audio')) m.playbackRate = r;
      for (const an of (document.getAnimations ? document.getAnimations() : [])) an.playbackRate = r;
    } catch (e) {}
  }, 1000);

  // O espelho NAO mora mais neste script (so speed). A captura de eventos do espelho
  // roda num script dedicado do mundo principal injetado via CDP quando o modo esta ligado.
})();
`;
  }

  // Injeta o script de controles no MUNDO PRINCIPAL. O evaluate principal cobre
  // paginas ja carregadas com CSP; a tag fica como fallback.
  private async installRuntimeControlsMainWorld(target: Page | Frame, speedRate = 1): Promise<void> {
    const src = this.buildMainWorldControlsScript(speedRate);
    const targetUrl = sanitizeDiagnosticUrl(target.url());
    const installedViaMainWorldEvaluate = await target
      .evaluate(() => {
        const runtimeWindow = globalThis as unknown as { __predatorMWFull?: boolean };
        return Boolean(runtimeWindow.__predatorMWFull);
      }, undefined, false)
      .catch(() => false);
    if (!installedViaMainWorldEvaluate) {
      await target
        .evaluate(src, undefined, false)
        .catch((error) => {
          appendInputDiagnostic({
            kind: "runtime-main-world-evaluate-error",
            pageUrl: targetUrl,
            error: error instanceof Error ? error.message : String(error)
          });
        });
    }

    const installed = await target
      .evaluate(() => {
        const runtimeWindow = globalThis as unknown as { __predatorMWFull?: boolean };
        return Boolean(runtimeWindow.__predatorMWFull);
      }, undefined, false)
      .catch(() => false);
    if (installed) {
      return;
    }

    await target
      .evaluate((code) => {
        const doc = (globalThis as unknown as { document?: {
          documentElement: { appendChild: (el: unknown) => void };
          head?: { appendChild: (el: unknown) => void };
          createElement: (tag: string) => {
            textContent: string;
            remove: () => void;
          };
        } }).document;
        try {
          if (!doc) return;
          const s = doc.createElement("script");
          s.textContent = code;
          (doc.head ?? (doc.documentElement as unknown as { appendChild: (el: unknown) => void })).appendChild(s);
          s.remove();
        } catch (e) {
          // best-effort
        }
      }, src)
      .catch((error) => {
        appendInputDiagnostic({
          kind: "runtime-main-world-tag-error",
          pageUrl: targetUrl,
          error: error instanceof Error ? error.message : String(error)
        });
      });

    const fallbackInstalled = await target
      .evaluate(() => {
        const runtimeWindow = globalThis as unknown as { __predatorMWFull?: boolean };
        return Boolean(runtimeWindow.__predatorMWFull);
      }, undefined, false)
      .catch(() => null);
    if (!fallbackInstalled) {
      appendInputDiagnostic({
        kind: "runtime-main-world-install-missed",
        pageUrl: targetUrl
      });
    }
  }

  private async installRuntimeControlsNewDocumentScript(page: Page, rate: number): Promise<void> {
    if (page.isClosed()) {
      return;
    }

    const speedRate = this.clampNumber(rate, 1, 25);
    const existingRate = this.runtimeNewDocumentRates.get(page);
    if (existingRate === speedRate) {
      return;
    }

    const existingSession = this.runtimeNewDocumentSessions.get(page);
    const session = existingSession ?? (await page.context().newCDPSession(page).catch(() => undefined));
    if (!session) {
      return;
    }

    const existingScriptId = this.runtimeNewDocumentScriptIds.get(page);
    if (existingScriptId) {
      await session
        .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: existingScriptId })
        .catch(() => undefined);
      this.runtimeNewDocumentScriptIds.delete(page);
    }

    this.runtimeNewDocumentSessions.set(page, session);
    this.runtimeNewDocumentRates.set(page, speedRate);

    try {
      const response = await session.send("Page.addScriptToEvaluateOnNewDocument", {
        source: this.buildMainWorldControlsScript(speedRate, { pgGameOnly: true })
      });
      const identifier = (response as { identifier?: string }).identifier;
      if (identifier) {
        this.runtimeNewDocumentScriptIds.set(page, identifier);
      }
      appendInputDiagnostic({
        kind: "runtime-new-document-speed",
        speedRate,
        pageUrl: sanitizeDiagnosticUrl(page.url()),
        installed: Boolean(identifier)
      });
    } catch (error) {
      appendInputDiagnostic({
        kind: "runtime-new-document-speed-error",
        speedRate,
        pageUrl: sanitizeDiagnosticUrl(page.url()),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // Seta um atributo no <html> (canal de config entre mundo isolado e principal).
  private async setRuntimeControlAttr(target: Page | Frame, name: string, value: string): Promise<void> {
    await target
      .evaluate(
        ({ attr, val }) => {
          const doc = (globalThis as unknown as { document?: {
            documentElement: { setAttribute: (n: string, v: string) => void };
          } }).document;
          try {
            doc?.documentElement.setAttribute(attr, val);
          } catch (e) {
            // best-effort
          }
        },
        { attr: name, val: value }
      )
      .catch(() => null);
  }

  private async applySpeedToPage(page: Page, rate: number): Promise<void> {
    if (page.isClosed()) {
      return;
    }
    const speedRate = this.clampNumber(rate, 1, 25);
    // O new-document script via CDP so aplica controles em iframes de jogos
    // reconhecidos em navegacoes futuras.
    await this.installRuntimeControlsNewDocumentScript(page, speedRate);
    const targets: Array<Page | Frame> = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
    await Promise.allSettled(
      targets.map(async (target) => {
        await this.setRuntimeControlAttr(target, "data-rtc-speed", String(speedRate));
        // Speed hack so em frames de jogos: evita interferir com timers de
        // login/cadastro/deposito/saque (anti-bot, animacoes, polling de QR).
        const isGameTarget = isKnownGameFrameUrl(target.url());
        if (isGameTarget && speedRate > 1) {
          await this.installRuntimeControlsMainWorld(target, speedRate);
        }
      })
    );
  }

  private async applyMirrorConfigToPage(
    page: Page,
    enabled = this.mirrorEnabled,
    strict = false
  ): Promise<void> {
    page = this.unwrapPage(page);
    if (page.isClosed()) {
      return;
    }

    // Navegacao normal sem espelho: nada a fazer (evita criar sessao CDP/registrar
    // script em paginas que nunca usaram o modo espelho).
    if (!enabled && !this.mirrorCaptureScriptIds.has(page)) {
      return;
    }

    // Captura roda so na janela top (mundo principal, via CDP). Sem varredura por
    // frame nem atributos por evento: o script de captura encaminha pelo binding e
    // o estado enabled e empurrado aqui (uma chamada leve por pagina por toggle).
    await this.installMirrorCaptureScript(page, enabled, strict);
  }

  private async applyPopupCloserConfigToPage(page: Page): Promise<void> {
    page = this.unwrapPage(page);
    if (page.isClosed()) {
      return;
    }

    const enabled = this.popupCloserPageOverrides.has(page)
      ? this.popupCloserPageOverrides.get(page)
      : this.autoClosePopupsDuringNavigation;

    // Mecanismo principal: loop Node-driven (confiavel, nao depende de injeccao).
    if (enabled) {
      this.startNodePopupKiller(page);
    } else {
      this.stopNodePopupKiller(page);
    }

    const dispatchConfig = (target: Page | Frame) =>
      target
        .evaluate((enabled) => {
          const runtimeWindow = globalThis as unknown as {
            CustomEvent: new (type: string, init?: { detail?: unknown }) => unknown;
            dispatchEvent: (event: unknown) => boolean;
            __predatorUpdatePopupCloserConfig?: (next: { enabled: boolean }) => void;
          };

          if (typeof runtimeWindow.__predatorUpdatePopupCloserConfig === "function") {
            runtimeWindow.__predatorUpdatePopupCloserConfig({ enabled });
            return;
          }

          runtimeWindow.dispatchEvent(
            new runtimeWindow.CustomEvent("predator:popup-closer-config", {
              detail: { enabled }
            })
          );
        }, Boolean(enabled), PATCHRIGHT_INIT_SCRIPT_CONTEXT)
        .catch(() => null);

    const targets: Array<Page | Frame> = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
    await Promise.allSettled(
      targets.map(async (target) => {
        await this.ensureRuntimeControlsScriptInstalled(target);
        await dispatchConfig(target);
      })
    );
  }

  // ===== POPUP KILLER NODE-DRIVEN =====
  // Varre e remove os popups via page.evaluate() a partir do Node, em loop. Roda
  // em todos os frames (popups podem estar em iframe). Auto-limpa quando a pagina
  // fecha. Sweep idempotente e barato (~400ms).
  private startNodePopupKiller(page: Page): void {
    if (this.nodePopupKillerTimers.has(page) || page.isClosed()) {
      return;
    }
    const sweep = async () => {
      if (page.isClosed()) {
        this.stopNodePopupKiller(page);
        return;
      }
      // Relê a cada ciclo: capta o payload servido que chega após o launch
      // (corrida de inicialização). Sem script servido, pula a varredura.
      const sweepScript = this.servedPopupSweepScript;
      if (!sweepScript) {
        return;
      }
      const targets: Array<Page | Frame> = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
      await Promise.allSettled(
        targets.map(async (target) => {
          if (await this.isGameDocument(target)) {
            return null;
          }
          return target.evaluate(sweepScript).catch(() => null);
        })
      );
    };
    const timer = setInterval(() => {
      void sweep();
    }, BrowserRuntimeService.NODE_POPUP_SWEEP_MS);
    this.nodePopupKillerTimers.set(page, timer);
    page.once("close", () => this.stopNodePopupKiller(page));
    void sweep();
  }

  private async isGameDocument(target: Page | Frame): Promise<boolean> {
    return target
      .evaluate(
        (selector) => {
          const runtimeDocument = (globalThis as unknown as {
            document?: { querySelector: (value: string) => unknown };
          }).document;
          return Boolean(runtimeDocument?.querySelector(selector));
        },
        "#GameCanvas,canvas.gameCanvas,#gameCanvas,#Cocos2dGameContainer,#Cocos2dGameContainer canvas"
      )
      .catch(() => false);
  }

  private hasPgGameFrame(page: Page): boolean {
    return page.frames().some((frame) => isKnownGameFrameUrl(frame.url()));
  }

  private isSessionDeadError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return (
      msg.includes("Target page, context or browser has been closed") ||
      msg.includes("Session closed") ||
      msg.includes("Target closed") ||
      msg.includes("Protocol error") ||
      msg.includes("Connection closed")
    );
  }

  private async sendTouchEmulationCommands(
    session: CDPSession,
    page: Page,
    shouldEnable: boolean
  ): Promise<void> {
    await session.send("Emulation.setTouchEmulationEnabled", {
      enabled: shouldEnable,
      maxTouchPoints: shouldEnable ? 5 : 1
    });
    await session
      .send("Emulation.setEmitTouchEventsForMouse", {
        enabled: shouldEnable,
        configuration: shouldEnable ? "mobile" : "desktop"
      })
      .catch((error) => {
        appendInputDiagnostic({
          kind: "game-touch-mouse-bridge-error",
          enabled: shouldEnable,
          pageUrl: sanitizeDiagnosticUrl(page.url()),
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  private async updateGameTouchEmulation(page: Page, mobileLike: boolean): Promise<void> {
    if (page.isClosed()) {
      return;
    }

    // Emulacao de toque ("bolinha" do modo mobile do DevTools): no modo mobile do painel,
    // cliques de mouse tambem emitem eventos touch. No modo desktop, mantemos apenas a
    // excecao antiga para frames de jogo que so respondem a touch.
    const hasGameFrame = this.hasPgGameFrame(page);
    const shouldEnable = mobileLike || hasGameFrame;
    if (this.gameTouchEmulationState.get(page) === shouldEnable) {
      return;
    }

    const existingSession = this.gameTouchEmulationSessions.get(page);
    let session = existingSession ?? (await page.context().newCDPSession(page).catch(() => undefined));
    if (!session) {
      return;
    }

    try {
      await this.sendTouchEmulationCommands(session, page, shouldEnable);
      this.gameTouchEmulationSessions.set(page, session);
      this.gameTouchEmulationState.set(page, shouldEnable);
      appendInputDiagnostic({
        kind: "game-touch-emulation",
        enabled: shouldEnable,
        universal: mobileLike,
        hadGameFrame: hasGameFrame,
        mobileLike,
        pageUrl: sanitizeDiagnosticUrl(page.url())
      });
    } catch (error) {
      // Se a sessao morreu (Patchright stealth detacha sessoes que combinaram
      // Emulation + outras operacoes), criamos uma nova e retentamos uma vez.
      if (existingSession && this.isSessionDeadError(error) && !page.isClosed()) {
        this.gameTouchEmulationSessions.delete(page);
        this.gameTouchEmulationState.delete(page);
        const fresh = await page.context().newCDPSession(page).catch(() => undefined);
        if (fresh) {
          try {
            await this.sendTouchEmulationCommands(fresh, page, shouldEnable);
            this.gameTouchEmulationSessions.set(page, fresh);
            this.gameTouchEmulationState.set(page, shouldEnable);
            appendInputDiagnostic({
              kind: "game-touch-emulation-recovered",
              enabled: shouldEnable,
              pageUrl: sanitizeDiagnosticUrl(page.url())
            });
            return;
          } catch (retryError) {
            appendInputDiagnostic({
              kind: "game-touch-emulation-retry-failed",
              enabled: shouldEnable,
              pageUrl: sanitizeDiagnosticUrl(page.url()),
              error: retryError instanceof Error ? retryError.message : String(retryError)
            });
          }
        }
        return;
      }
      // NAO deletamos a sessao cacheada para erros transitorios: dropar a referencia
      // faz o Chromium reverter a emulacao (sessao GC'd). So limpamos o ESTADO.
      this.gameTouchEmulationState.delete(page);
      appendInputDiagnostic({
        kind: "game-touch-emulation-error",
        enabled: shouldEnable,
        pageUrl: sanitizeDiagnosticUrl(page.url()),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // Watchdog: a cada ~1.5s, força re-aplicação de Emulation.setEmitTouchEventsForMouse
  // para combater o stealth do Patchright, que silenciosamente reverte o override
  // após certas operações CDP (page.click via automação).
  // Sem isso, a "bolinha" some e os teclados de senha / jogos param de funcionar.
  //
  // IMPORTANTE: PAUSAMOS o watchdog enquanto o mirror está ativo. A atividade CDP
  // constante (Emulation.* a cada 1.5s) interfere com as sessões do mirror via
  // stealth do Patchright, causando intermitência. Durante o mirror:
  //   - A janela fonte mantém a bolinha naturalmente (tem foco do SO)
  //   - Os targets recebem touch via Input.dispatchTouchEvent direto (não precisam
  //     da tradução mouse-to-touch)
  private startTouchEmulationWatchdog(page: Page, mobileLike: boolean): void {
    if (!mobileLike || page.isClosed()) return;
    if (this.touchEmulationWatchdogs.has(page)) return;
    const tick = async () => {
      if (page.isClosed()) {
        const existing = this.touchEmulationWatchdogs.get(page);
        if (existing) clearTimeout(existing);
        this.touchEmulationWatchdogs.delete(page);
        return;
      }
      // Skip se o mirror está ativo (evita interferência CDP).
      if (!this.mirrorEnabled) {
        // Limpa o estado cacheado para forçar updateGameTouchEmulation a re-enviar.
        this.gameTouchEmulationState.delete(page);
        await this.updateGameTouchEmulation(page, mobileLike).catch(() => undefined);
      }
      if (page.isClosed()) {
        this.touchEmulationWatchdogs.delete(page);
        return;
      }
      const next = setTimeout(tick, 1500);
      (next as unknown as { unref?: () => void }).unref?.();
      this.touchEmulationWatchdogs.set(page, next);
    };
    const first = setTimeout(tick, 1500);
    (first as unknown as { unref?: () => void }).unref?.();
    this.touchEmulationWatchdogs.set(page, first);
    page.on("close", () => {
      const existing = this.touchEmulationWatchdogs.get(page);
      if (existing) clearTimeout(existing);
      this.touchEmulationWatchdogs.delete(page);
    });
  }

  private stopNodePopupKiller(page: Page): void {
    const timer = this.nodePopupKillerTimers.get(page);
    if (timer) {
      clearInterval(timer);
      this.nodePopupKillerTimers.delete(page);
    }
  }

  /**
   * Frente B: define o script do popup-killer servido (decifrado por device).
   * `null` desliga a varredura. Lido a cada ciclo, então afeta também os killers
   * já em loop (captam o payload assim que ele chega).
   */
  setServedPopupSweepScript(script: string | null): void {
    this.servedPopupSweepScript = script && script.trim() ? script : null;
  }

  private async ensureRuntimeControlsScriptInstalled(target: Page | Frame): Promise<void> {
    await target
      .evaluate(this.buildRuntimeControlsScript(), undefined, PATCHRIGHT_INIT_SCRIPT_CONTEXT)
      .catch(() => null);
  }

  // Rota combinada: PG game speed patch + SW fingerprint injection.
  // Bloqueio de dominios e GSI agora e feito via --host-rules no launch
  // (zero IPC por request). A rota so intercepta o que precisa de body mod.
  private async installCombinedRoute(
    context: BrowserContext,
    fingerprintConfig: FingerprintConsistencyConfig
  ): Promise<void> {
    const prelude = this.buildFingerprintConsistencyScript(fingerprintConfig);

    await context.route("**/*", async (route: Route) => {
      const request = route.request();
      const url = request.url();

      // 1. Patch de speed no bundle do engine do jogo (por provedor). So
      // provedores com estrategia de patch de bundle (ex.: PG/Cocos) definem
      // scriptMatch e sao resolvidos aqui; provedores generic-timers aceleram
      // via overrides de timer no frame, sem tocar no bundle.
      const speedProvider = resolveProviderByScriptUrl(url);
      if (speedProvider) {
        try {
          const response = await route.fetch();
          const body = await response.text();
          const speedRate = this.contextSpeedRates.get(context) ?? this.defaultSpeedRate;
          if (bundleMatchesEngine(body, speedProvider)) {
            appendInputDiagnostic({
              kind: "pg-game-speed-script-candidate",
              url: sanitizeDiagnosticUrl(url),
              resourceType: request.resourceType(),
              frameUrl: sanitizeDiagnosticUrl(request.frame().url()),
              bodyLength: body.length,
              provider: speedProvider.id
            });
          }
          const patchedBody = patchGameSpeedScript(body, speedRate, speedProvider);
          if (patchedBody !== body) {
            const headers: Record<string, string> = {
              ...response.headers(),
              "content-type": response.headers()["content-type"] || "application/javascript; charset=utf-8"
            };
            delete headers["content-length"];
            await route.fulfill({ response, headers, body: patchedBody });
            appendInputDiagnostic({
              kind: "pg-game-speed-script-patched",
              url: sanitizeDiagnosticUrl(url),
              speedRate
            });
            return;
          }
        } catch (error) {
          appendInputDiagnostic({
            kind: "pg-game-speed-script-patch-error",
            url: sanitizeDiagnosticUrl(url),
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      // 2. Injetar prelude de fingerprint em scripts de Service Worker
      if (request.headers()["service-worker"] === "script") {
        try {
          const response = await route.fetch();
          const headers = {
            ...response.headers(),
            "content-type": response.headers()["content-type"] || "application/javascript; charset=utf-8"
          };
          const body = await response.text();
          await route.fulfill({ response, headers, body: `${prelude}\n${body}` });
          return;
        } catch {
          // fall through to continue
        }
      }

      await route.continue().catch(() => undefined);
    });
  }

  setDomainBlock(enabled: boolean, domains: string[]): void {
    this.domainBlockEnabled = enabled;
    this.blockedDomains = Array.isArray(domains) ? domains : [];
  }



  private buildFingerprintConsistencyScript(config: FingerprintConsistencyConfig): string {
    return `
(() => {
  const desiredFingerprint = ${JSON.stringify(config)};
  const globalObject = globalThis;
  const isEmbeddedGameRuntime = () => {
    try {
      if (globalObject.window !== globalObject) {
        return false;
      }
      if (globalObject.top === globalObject) {
        return false;
      }
      return /\\/\\d+\\/index\\.html$/i.test(String(globalObject.location && globalObject.location.pathname || ""));
    } catch (error) {
      return false;
    }
  };
  if (isEmbeddedGameRuntime()) {
    return;
  }

  const readWebGLFingerprint = () => {
    try {
      const canvas =
        globalObject.document && typeof globalObject.document.createElement === "function"
          ? globalObject.document.createElement("canvas")
          : typeof globalObject.OffscreenCanvas === "function"
            ? new globalObject.OffscreenCanvas(1, 1)
            : null;
      if (!canvas || typeof canvas.getContext !== "function") {
        return {};
      }

      const gl =
        canvas.getContext("webgl") ||
        canvas.getContext("experimental-webgl") ||
        canvas.getContext("webgl2");
      if (!gl || typeof gl.getExtension !== "function" || typeof gl.getParameter !== "function") {
        return {};
      }

      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      if (!debugInfo) {
        return {};
      }

      const vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
      const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      return {
        vendor: typeof vendor === "string" ? vendor : undefined,
        renderer: typeof renderer === "string" ? renderer : undefined
      };
    } catch (error) {
      return {};
    }
  };

  function applyFingerprintInGlobal(fingerprint) {
    const globalObject = globalThis;
    const navigatorObject = globalObject.navigator;
    if (!navigatorObject || !fingerprint) {
      return;
    }

    const asNumber = (value, fallback) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    };
    const languages = Array.isArray(fingerprint.languages) && fingerprint.languages.length > 0
      ? fingerprint.languages.map((language) => String(language))
      : [String(fingerprint.language || navigatorObject.language || "en-US")];
    const language = String(fingerprint.language || languages[0] || "en-US");
    const userAgent = String(fingerprint.userAgent || navigatorObject.userAgent || "");
    const appVersion = userAgent.replace(/^Mozilla\\//, "");
    const platform = String(fingerprint.platform || navigatorObject.platform || "Win32");
    const vendor = String(fingerprint.vendor || navigatorObject.vendor || "Google Inc.");
    const hardwareConcurrency = Math.max(1, Math.round(asNumber(fingerprint.hardwareConcurrency, navigatorObject.hardwareConcurrency || 8)));
    const deviceMemory = Math.max(1, Math.round(asNumber(fingerprint.deviceMemory, navigatorObject.deviceMemory || 8)));
    const maxTouchPoints = Math.max(0, Math.round(asNumber(fingerprint.maxTouchPoints, navigatorObject.maxTouchPoints || 0)));

    const defineGetter = (target, property, getter) => {
      if (!target) {
        return;
      }

      try {
        Object.defineProperty(target, property, {
          configurable: true,
          get: getter
        });
      } catch (error) {}
    };

    // IMPORTANTE: definir no Navigator.prototype (e nao na instancia navigator).
    // Em Chromium, navigator e um platform object: escrita de propriedades herdadas
    // do prototype na instancia e silenciosamente descartada. Substituir os getters
    // no prototype (configurable:true) e a unica forma de sobrescrever platform/vendor.
    const installNavigatorGetters = () => {
      const proto = navigatorObject.__proto__ || (typeof Navigator !== "undefined" ? Navigator.prototype : null);
      if (!proto) return;
      defineGetter(proto, "userAgent", () => userAgent);
      defineGetter(proto, "appVersion", () => appVersion);
      defineGetter(proto, "platform", () => platform);
      defineGetter(proto, "vendor", () => vendor);
      defineGetter(proto, "language", () => language);
      defineGetter(proto, "languages", () => languages.slice());
      defineGetter(proto, "hardwareConcurrency", () => hardwareConcurrency);
      defineGetter(proto, "deviceMemory", () => deviceMemory);
      defineGetter(proto, "maxTouchPoints", () => maxTouchPoints);
    };

    installNavigatorGetters();
    // Backup na instancia para casos onde algum codigo ja copiou para la antes do init.
    try { installNavigatorGetters(navigatorObject); } catch {}

    try {
      delete navigatorObject.webdriver;
    } catch (error) {}

    // Mascara o --force-device-scale-factor: reporta o devicePixelRatio real do monitor (em vez do valor
    // forcado < 1, que e um sinal incomum) e corrige screen.* para manter a resolucao coerente. So roda
    // no escopo de janela (workers nao possuem devicePixelRatio/screen).
    if (
      typeof fingerprint.devicePixelRatio === "number" &&
      fingerprint.devicePixelRatio > 0 &&
      "devicePixelRatio" in globalObject
    ) {
      const reportedDpr = fingerprint.devicePixelRatio;
      defineGetter(globalObject, "devicePixelRatio", () => reportedDpr);

      const dimensionScale =
        typeof fingerprint.screenDimensionScale === "number" && fingerprint.screenDimensionScale > 0
          ? fingerprint.screenDimensionScale
          : 1;
      const screenObject = globalObject.screen;
      if (screenObject && dimensionScale !== 1) {
        for (const dimension of ["width", "height", "availWidth", "availHeight"]) {
          try {
            const observed = Number(screenObject[dimension]);
            if (Number.isFinite(observed)) {
              const corrected = Math.round(observed * dimensionScale);
              defineGetter(screenObject, dimension, () => corrected);
            }
          } catch (error) {}
        }
      }
    }

    const inferUserAgentDataPlatform = () => {
      if (/android/i.test(userAgent) || platform.toLowerCase().includes("arm")) {
        return "Android";
      }
      if (/iphone|ipad|ios/i.test(userAgent) || platform === "iPhone" || platform === "iPad") {
        return "iOS";
      }
      if (/mac/i.test(platform) || /macintosh|mac os x/i.test(userAgent)) {
        return "macOS";
      }
      if (/linux/i.test(platform) || /linux/i.test(userAgent)) {
        return "Linux";
      }
      return "Windows";
    };

    const buildUserAgentData = () => {
      const nativeUserAgentData = navigatorObject.userAgentData || {};
      const metadata = fingerprint.userAgentMetadata || {};
      const brands = Array.isArray(metadata.brands) && metadata.brands.length > 0
        ? metadata.brands
        : Array.isArray(nativeUserAgentData.brands)
          ? nativeUserAgentData.brands
          : [];
      const fullVersionList = Array.isArray(metadata.fullVersionList) && metadata.fullVersionList.length > 0
        ? metadata.fullVersionList
        : Array.isArray(nativeUserAgentData.fullVersionList)
          ? nativeUserAgentData.fullVersionList
          : brands;
      const mobile = typeof metadata.mobile === "boolean"
        ? metadata.mobile
        : /android|mobile|iphone|ipad/i.test(userAgent);
      const uaPlatform = metadata.platform || inferUserAgentDataPlatform();
      const highEntropy = {
        architecture: metadata.architecture || (mobile ? "arm" : "x86"),
        bitness: metadata.bitness || (mobile ? "" : "64"),
        brands,
        fullVersionList,
        mobile,
        model: metadata.model || (uaPlatform === "Android" ? "SM-G991B" : ""),
        platform: uaPlatform,
        platformVersion: metadata.platformVersion || (uaPlatform === "Android" ? "13.0.0" : ""),
        uaFullVersion: fullVersionList[0] && fullVersionList[0].version ? fullVersionList[0].version : "",
        wow64: Boolean(metadata.wow64)
      };

      return {
        brands,
        mobile,
        platform: uaPlatform,
        getHighEntropyValues: async (hints) => {
          const result = {};
          for (const hint of Array.isArray(hints) ? hints : []) {
            if (Object.prototype.hasOwnProperty.call(highEntropy, hint)) {
              result[hint] = highEntropy[hint];
            }
          }
          return result;
        },
        toJSON: () => ({
          brands,
          mobile,
          platform: uaPlatform
        })
      };
    };

    if ("userAgentData" in navigatorObject || fingerprint.userAgentMetadata) {
      const userAgentData = buildUserAgentData();
      defineGetter(navigatorObject, "userAgentData", () => userAgentData);
    }

    const patchWebGLContextObject = (context) => {
      if (!context || typeof context.getParameter !== "function" || context.__predatorConsistentGetParameter) {
        return context;
      }

      try {
        const nativeGetParameter = context.getParameter.bind(context);
        Object.defineProperty(context, "__predatorConsistentGetParameter", {
          configurable: true,
          value: true
        });
        Object.defineProperty(context, "getParameter", {
          configurable: true,
          value: function(parameter) {
            if (parameter === 0x9245 && fingerprint.webglVendor) {
              return fingerprint.webglVendor;
            }
            if (parameter === 0x9246 && fingerprint.webglRenderer) {
              return fingerprint.webglRenderer;
            }
            return nativeGetParameter(parameter);
          }
        });
      } catch (error) {}

      return context;
    };

    const patchWebGLConstructor = (ContextConstructor) => {
      if (!ContextConstructor || !ContextConstructor.prototype || ContextConstructor.prototype.__predatorConsistentWebGL) {
        return;
      }

      const nativeGetParameter = ContextConstructor.prototype.getParameter;
      if (typeof nativeGetParameter !== "function") {
        return;
      }

      try {
        Object.defineProperty(ContextConstructor.prototype, "__predatorConsistentWebGL", {
          configurable: true,
          value: true
        });
        Object.defineProperty(ContextConstructor.prototype, "getParameter", {
          configurable: true,
          value: function(parameter) {
            if (parameter === 0x9245 && fingerprint.webglVendor) {
              return fingerprint.webglVendor;
            }
            if (parameter === 0x9246 && fingerprint.webglRenderer) {
              return fingerprint.webglRenderer;
            }
            return nativeGetParameter.call(this, parameter);
          }
        });
      } catch (error) {}
    };

    patchWebGLConstructor(globalObject.WebGLRenderingContext);
    patchWebGLConstructor(globalObject.WebGL2RenderingContext);

    const patchCanvasConstructor = (CanvasConstructor) => {
      if (!CanvasConstructor || !CanvasConstructor.prototype || CanvasConstructor.prototype.__predatorConsistentCanvas) {
        return;
      }

      const nativeGetContext = CanvasConstructor.prototype.getContext;
      if (typeof nativeGetContext !== "function") {
        return;
      }

      try {
        Object.defineProperty(CanvasConstructor.prototype, "__predatorConsistentCanvas", {
          configurable: true,
          value: true
        });
        Object.defineProperty(CanvasConstructor.prototype, "getContext", {
          configurable: true,
          value: function(...args) {
            return patchWebGLContextObject(nativeGetContext.apply(this, args));
          }
        });
      } catch (error) {}
    };

    patchCanvasConstructor(globalObject.HTMLCanvasElement);
    patchCanvasConstructor(globalObject.OffscreenCanvas);

    const buildWorkerPrelude = (snapshot) =>
      "(" + applyFingerprintInGlobal.toString() + ")(" + JSON.stringify(snapshot) + ");\\n";

    const normalizeWorkerUrl = (scriptURL) => {
      try {
        const baseUrl = globalObject.location && globalObject.location.href ? globalObject.location.href : undefined;
        return new URL(String(scriptURL), baseUrl).href;
      } catch (error) {
        return String(scriptURL);
      }
    };

    const isModuleWorker = (options) =>
      Boolean(options && typeof options === "object" && String(options.type || "").toLowerCase() === "module");

    const createWrappedWorkerUrl = (scriptURL, options) => {
      if (typeof globalObject.Blob !== "function" || !globalObject.URL || typeof globalObject.URL.createObjectURL !== "function") {
        return scriptURL;
      }

      const sourceUrl = normalizeWorkerUrl(scriptURL);
      const sourceLiteral = JSON.stringify(sourceUrl);
      const prelude = buildWorkerPrelude(fingerprint);
      const wrapperSource = isModuleWorker(options)
        ? prelude + "import(" + sourceLiteral + ").catch(function(error) { setTimeout(function() { throw error; }, 0); });"
        : prelude + "(function() { var __predatorWorkerScriptUrl = " + sourceLiteral + "; var __predatorNativeImportScripts = typeof importScripts === 'function' ? importScripts.bind(globalThis) : null; if (!__predatorNativeImportScripts) { return; } try { Object.defineProperty(globalThis, 'importScripts', { configurable: true, value: function() { var urls = Array.prototype.slice.call(arguments).map(function(url) { return new URL(String(url), __predatorWorkerScriptUrl).href; }); return __predatorNativeImportScripts.apply(globalThis, urls); } }); } catch (error) {} __predatorNativeImportScripts(__predatorWorkerScriptUrl); })();";

      return globalObject.URL.createObjectURL(new globalObject.Blob([wrapperSource], {
        type: "application/javascript"
      }));
    };

    const patchWorkerConstructor = (constructorName) => {
      const NativeWorkerConstructor = globalObject[constructorName];
      if (typeof NativeWorkerConstructor !== "function" || NativeWorkerConstructor.__predatorConsistentWorker) {
        return;
      }

      const WrappedWorkerConstructor = function(scriptURL, options) {
        if (!new.target) {
          throw new TypeError("Failed to construct '" + constructorName + "': Please use the 'new' operator.");
        }

        const wrappedUrl = createWrappedWorkerUrl(scriptURL, options);
        const worker = options === undefined
          ? new NativeWorkerConstructor(wrappedUrl)
          : new NativeWorkerConstructor(wrappedUrl, options);

        if (wrappedUrl !== scriptURL && globalObject.URL && typeof globalObject.URL.revokeObjectURL === "function") {
          setTimeout(() => {
            try {
              globalObject.URL.revokeObjectURL(wrappedUrl);
            } catch (error) {}
          }, 60000);
        }

        return worker;
      };

      try {
        Object.setPrototypeOf(WrappedWorkerConstructor, NativeWorkerConstructor);
      } catch (error) {}
      WrappedWorkerConstructor.prototype = NativeWorkerConstructor.prototype;
      try {
        Object.defineProperty(WrappedWorkerConstructor, "__predatorConsistentWorker", {
          configurable: true,
          value: true
        });
        Object.defineProperty(WrappedWorkerConstructor, "name", {
          configurable: true,
          value: constructorName
        });
      } catch (error) {}

      try {
        Object.defineProperty(globalObject, constructorName, {
          configurable: true,
          writable: true,
          value: WrappedWorkerConstructor
        });
      } catch (error) {}
    };

    patchWorkerConstructor("Worker");
    patchWorkerConstructor("SharedWorker");
  }

  const nativeNavigator = globalObject.navigator || {};
  const webglFingerprint = readWebGLFingerprint();

  const desiredLanguages = Array.isArray(desiredFingerprint.languages) && desiredFingerprint.languages.length > 0
    ? desiredFingerprint.languages.map((language) => String(language))
    : Array.isArray(nativeNavigator.languages) && nativeNavigator.languages.length > 0
      ? Array.from(nativeNavigator.languages).map((language) => String(language))
      : [String(nativeNavigator.language || "en-US")];
  const fingerprint = {
    userAgent: String(desiredFingerprint.userAgent || nativeNavigator.userAgent || ""),
    languages: desiredLanguages,
    language: String(desiredLanguages[0] || nativeNavigator.language || "en-US"),
    platform: String(desiredFingerprint.platform || nativeNavigator.platform || "Win32"),
    vendor: String(desiredFingerprint.vendor || nativeNavigator.vendor || "Google Inc."),
    hardwareConcurrency: desiredFingerprint.hardwareConcurrency || nativeNavigator.hardwareConcurrency || 8,
    deviceMemory: desiredFingerprint.deviceMemory || nativeNavigator.deviceMemory || 8,
    maxTouchPoints: typeof desiredFingerprint.maxTouchPoints === "number"
      ? desiredFingerprint.maxTouchPoints
      : nativeNavigator.maxTouchPoints || 0,
    webglVendor: webglFingerprint.vendor,
    webglRenderer: webglFingerprint.renderer,
    userAgentMetadata: desiredFingerprint.userAgentMetadata || null,
    devicePixelRatio: typeof desiredFingerprint.devicePixelRatio === "number"
      ? desiredFingerprint.devicePixelRatio
      : undefined,
    screenDimensionScale: typeof desiredFingerprint.screenDimensionScale === "number"
      ? desiredFingerprint.screenDimensionScale
      : undefined
  };

  applyFingerprintInGlobal(fingerprint);
  try { document.documentElement.setAttribute("data-fp-applied", "1"); } catch {}
})();
`;
  }

  private async applyPageEnvironmentOverride(
    page: Page,
    userAgentOverride: UserAgentOverrideConfig | undefined,
    mobileLike: boolean,
    languages: string[]
  ): Promise<void> {
    if ((!userAgentOverride && !mobileLike) || page.isClosed()) {
      return;
    }

    const existingSession = this.userAgentOverrideSessions.get(page);
    const session = existingSession ?? (await page.context().newCDPSession(page).catch(() => undefined));
    if (!session) {
      return;
    }

    let applied = false;

    if (userAgentOverride) {
      try {
        await session.send("Network.enable");
        await session.send("Network.setUserAgentOverride", {
          userAgent: userAgentOverride.userAgent,
          acceptLanguage: buildAcceptLanguageHeader(languages),
          userAgentMetadata: userAgentOverride.userAgentMetadata
        });
        applied = true;
      } catch {
        // Some Chromium channels may reject UA-CH metadata; launch args still cover userAgent.
      }
    }

    // `hasTouch` on the persistent context keeps trusted touchscreen actions available.
    // Do not enable CDP touch emulation: it converts physical mouse input into touch input.

    if (applied) {
      this.userAgentOverrideSessions.set(page, session);
      return;
    }

    if (!existingSession) {
      await session.detach().catch(() => undefined);
    }
  }

  private resolveNavigationMode(profile: ProfileSummary): NavigationMode {
    const marker = profile.persona.launchArgs.find((arg) => arg.startsWith(NAVIGATION_MODE_LAUNCH_ARG_PREFIX));
    const markerValue = marker?.slice(NAVIGATION_MODE_LAUNCH_ARG_PREFIX.length);
    if (this.isNavigationMode(markerValue)) {
      return markerValue;
    }

    const userAgent = profile.persona.userAgent.toLowerCase();
    if (/\b(android|iphone|ipad|mobile)\b/.test(userAgent)) {
      return "mobile-ios-android";
    }

    return DEFAULT_NAVIGATION_MODE;
  }

  private isNavigationMode(value: string | undefined): value is NavigationMode {
    return Boolean(value && (NAVIGATION_MODES as readonly string[]).includes(value));
  }

  private shouldUseMobileEmulation(mode: NavigationMode): boolean {
    return mode !== "desktop";
  }

  private buildMobileEmulationConfig(
    profile: ProfileSummary,
    mode: NavigationMode
  ): MobileEmulationConfig | undefined {
    if (!this.shouldUseMobileEmulation(mode)) {
      return undefined;
    }

    // 1) Respeita um UA mobile definido manualmente no perfil (iPhone/iPad/Android/Mobile).
    //    Antes um UA de iPhone era descartado pelo token "Mobile"; agora ele e preservado.
    const customUserAgent = resolveProfileUserAgent(profile.persona.userAgent);
    if (customUserAgent && /\b(android|iphone|ipad|ipod|mobile)\b/i.test(customUserAgent)) {
      const metadata = this.buildUserAgentMetadata(customUserAgent);
      return {
        userAgent: customUserAgent,
        userAgentMetadata: metadata,
        deviceLabel: "custom",
        hardware: {
          hardwareConcurrency: 8,
          deviceMemory: metadata.mobile ? 4 : 8,
          maxTouchPoints: metadata.mobile ? 5 : 0
        }
      };
    }

    // 2) Caso contrario, atribui deterministicamente um aparelho distinto por perfil,
    //    de modo que cada janela simule um dispositivo diferente.
    const device = selectMobileDevice(profile.id);
    return {
      userAgent: device.userAgent,
      userAgentMetadata: this.buildDeviceUserAgentMetadata(device),
      deviceLabel: device.label,
      hardware: {
        hardwareConcurrency: device.hardwareConcurrency,
        deviceMemory: device.deviceMemory,
        maxTouchPoints: device.maxTouchPoints
      }
    };
  }

  /** Monta os UA-Client-Hints a partir do aparelho do catalogo (sem parsing fragil do UA). */
  private buildDeviceUserAgentMetadata(device: DeviceProfile): UserAgentMetadataConfig {
    const brands = [
      { brand: "Chromium", version: device.chromeMajor },
      { brand: "Google Chrome", version: device.chromeMajor },
      { brand: "Not.A/Brand", version: "99" }
    ];
    return {
      architecture: "arm",
      bitness: "",
      brands,
      fullVersionList: brands.map((brand) => ({
        brand: brand.brand,
        version: brand.brand === "Not.A/Brand" ? "99.0.0.0" : device.chromeFull
      })),
      mobile: true,
      model: device.uaModel,
      platform: device.uaPlatform,
      platformVersion: device.uaPlatformVersion,
      wow64: false
    };
  }

  private buildUserAgentMetadata(userAgent: string): UserAgentMetadataConfig {
    const chromeVersion = userAgent.match(/\b(?:Chrome|CriOS|Edg|OPR)\/([\d.]+)/i)?.[1] ?? "150.0.7863.0";
    const majorVersion = chromeVersion.split(".")[0] || "150";
    const isAndroid = /\bAndroid\b/i.test(userAgent);
    const isiOS = /\b(iPhone|iPad|iPod)\b/i.test(userAgent);
    const isMobile = /\b(Mobile|Android|iPhone|iPad|iPod)\b/i.test(userAgent);
    const androidVersion = userAgent.match(/\bAndroid\s+([\d.]+)/i)?.[1] ?? "13";
    const androidModel = userAgent.match(/\bAndroid\s+[^;]+;\s*([^)]+)\)/i)?.[1]?.trim() ?? "SM-G991B";
    const platform = isAndroid
      ? "Android"
      : isiOS
        ? "iOS"
        : /\bMacintosh|Mac OS X\b/i.test(userAgent)
          ? "macOS"
          : /\bLinux\b/i.test(userAgent)
            ? "Linux"
            : "Windows";
    const platformVersion = platform === "Android"
      ? `${androidVersion}${androidVersion.split(".").length === 1 ? ".0.0" : ""}`
      : platform === "Windows"
        ? "10.0.0"
        : "";
    const brands = [
      { brand: "Chromium", version: majorVersion },
      { brand: "Google Chrome", version: majorVersion },
      { brand: "Not.A/Brand", version: "99" }
    ];

    return {
      architecture: isMobile ? "arm" : "x86",
      bitness: isMobile ? "" : "64",
      brands,
      fullVersionList: brands.map((brand) => ({
        brand: brand.brand,
        version: brand.brand === "Not.A/Brand" ? "99.0.0.0" : chromeVersion
      })),
      mobile: isMobile,
      model: platform === "Android" ? androidModel : "",
      platform,
      platformVersion,
      wow64: false
    };
  }

  private async resolveLaunchProxy(profile: ProfileSummary): Promise<LaunchProxyInfo> {
    const proxy = profile.proxy;
    if (!proxy) {
      return {
        ipLabel: "direto"
      };
    }

    const probe = await this.probeProxy(proxy, {
      profileId: profile.id,
      targetUrl: profile.homeUrl
    });
    if (probe.status !== "healthy") {
      throw new Error(
        `Proxy ${proxy.label} nao esta online (${probe.status}). ${probe.detail ?? ""} Corrija o proxy antes de abrir o perfil.`
      );
    }

    const config: {
      server: string;
      username?: string;
      password?: string;
    } = {
      server: `${proxy.protocol}://${proxy.host}:${proxy.port}`
    };

    config.username = this.resolveProxyUsername(proxy, profile.id);
    if (proxy.password) {
      config.password = proxy.password;
    }

    const proxyChain = new ProxyChainService({
      // Usa o protocolo que a auto-deteccao confirmou no probe (pode diferir do
      // salvo, ex.: http->socks5), para o tunel abrir igual ao que validou.
      upstreamProtocol: probe.protocol ?? proxy.protocol,
      upstreamHost: proxy.host,
      upstreamPort: proxy.port,
      username: config.username,
      password: config.password
    });
    try {
      await proxyChain.start();
    } catch (error) {
      await proxyChain.stop().catch(() => undefined);
      const detail = error instanceof Error ? error.message : String(error);
      const message =
        `Nao consegui iniciar o tunel local para o proxy ${proxy.label}: ${detail}. ` +
        "A janela nao sera aberta para evitar expor seu IP real.";
      this.notify(
        profile.id,
        "error",
        `🛡️ ${message}`
      );
      throw new Error(message, { cause: error });
    }
    config.server = proxyChain.localUrl;
    config.username = undefined;
    config.password = undefined;

    return {
      proxy: config,
      proxyChain,
      ipLabel: proxy.host
    };
  }

  private prepareBrowserPreferences(
    storagePath: string,
    webRtcMode: "default" | "relay-only" | "disabled"
  ): void {
    const defaultProfilePath = join(storagePath, "Default");
    const preferencesPath = join(defaultProfilePath, "Preferences");

    mkdirSync(defaultProfilePath, {
      recursive: true
    });

    const current = this.readPreferences(preferencesPath);
    const next = {
      ...current,
      credentials_enable_service: false,
      credentials_enable_autosignin: false,
      password_manager_enabled: false,
      autofill: {
        ...this.asRecord(current.autofill),
        credit_card_enabled: false,
        profile_enabled: false
      },
      profile: {
        ...this.asRecord(current.profile),
        password_manager_enabled: false,
        password_manager_leak_detection: false
      },
      // Anti-vazamento WebRTC. O flag --force-webrtc-ip-handling-policy sozinho e
      // ignorado por varios builds; o Chromium so respeita de forma confiavel estas
      // preferencias. Em "relay-only"/"disabled" forcamos a politica restritiva e
      // proibimos UDP nao-proxiado + rotas multiplas, eliminando o srflx (STUN
      // direto) que revela o IP real por fora do proxy.
      webrtc: webRtcMode === "default"
        ? this.asRecord(current.webrtc)
        : {
            ...this.asRecord(current.webrtc),
            ip_handling_policy: "disable_non_proxied_udp",
            multiple_routes_enabled: false,
            nonproxied_udp_enabled: false
          }
    };

    writeFileSync(preferencesPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  private readPreferences(preferencesPath: string): Record<string, unknown> {
    if (!existsSync(preferencesPath)) {
      return {};
    }

    try {
      const parsed = JSON.parse(readFileSync(preferencesPath, "utf8")) as unknown;
      return this.asRecord(parsed);
    } catch {
      return {};
    }
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private mergeDisableFeatureArgs(args: string[]): string[] {
    const disableFeatures = new Set<string>();
    const mergedArgs: string[] = [];

    for (const arg of args) {
      if (arg.startsWith("--disable-features=")) {
        const features = arg.replace("--disable-features=", "").split(",");
        for (const feature of features) {
          const trimmedFeature = feature.trim();
          if (trimmedFeature && !PRESERVE_NATIVE_FEATURES.has(trimmedFeature)) {
            disableFeatures.add(trimmedFeature);
          }
        }
        continue;
      }

      mergedArgs.push(arg);
    }

    if (disableFeatures.size > 0) {
      mergedArgs.push(`--disable-features=${Array.from(disableFeatures).join(",")}`);
    }

    return mergedArgs;
  }

  private resolvePlacementSettings(settings: AppSettings): AppSettings {
    if (!this.activeScreenLayout) {
      return settings;
    }

    return {
      ...settings,
      screenLayout: this.cloneScreenLayout(this.activeScreenLayout)
    };
  }

  private cloneScreenLayout(layout: ScreenLayoutSettings): ScreenLayoutSettings {
    return {
      ...layout,
      customSlots: layout.customSlots.map((slot) => ({ ...slot }))
    };
  }

  private async applyPlacementToPage(
    page: Page,
    placement: DpiAwarePlacement,
    effectiveScale: number
  ): Promise<boolean> {
    if (page.isClosed()) {
      return false;
    }

    const session = await page.context().newCDPSession(page).catch(() => undefined);
    if (!session) {
      return false;
    }

    try {
      const windowResult = (await session
        .send("Browser.getWindowForTarget")
        .catch(() => undefined)) as { windowId?: unknown } | undefined;
      const windowId = typeof windowResult?.windowId === "number" ? windowResult.windowId : undefined;

      if (windowId === undefined) {
        return false;
      }

      await session
        .send("Browser.setWindowBounds", {
          windowId,
          bounds: {
            windowState: "normal"
          }
        })
        .catch(() => undefined);

      const geometry = toChromiumWindowGeometry(
        placement,
        effectiveScale,
        () => appendInputDiagnostic({
          kind: "invalid-window-interface-scale",
          slotIndex: placement.slotIndex,
          effectiveScale
        })
      );
      await session.send("Browser.setWindowBounds", {
        windowId,
        bounds: {
          left: geometry.x,
          top: geometry.y,
          width: geometry.width,
          height: geometry.height
        }
      });
      await session.send("Emulation.clearDeviceMetricsOverride").catch(() => undefined);

      return true;
    } catch {
      return false;
    } finally {
      await session.detach().catch(() => undefined);
    }
  }

  async clearLayoutViewportOverride(page: Page): Promise<void> {
    if (page.isClosed()) {
      return;
    }
    const session = await page.context().newCDPSession(page).catch(() => undefined);
    if (!session) {
      return;
    }
    try {
      await session.send("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
    } finally {
      await session.detach().catch(() => undefined);
    }
  }

  private buildBrowserPlacement(
    settings: AppSettings,
    forcedSlotIndex?: number
  ): DpiAwarePlacement {
    const display = this.resolveLayoutDisplay(settings.screenLayout);
    const logical = buildLogicalLayout(display.workArea, settings.screenLayout);
    const slotCount = logical.slots.length;
    const slotIndex = forcedSlotIndex ?? this.allocateSlotIndex(slotCount);
    const template = logical.slots[slotIndex % slotCount];
    if (!template) {
      throw new Error("Layout sem slots disponíveis.");
    }
    const slot = { ...template, slotIndex };
    return buildDpiAwarePlacement(
      slot,
      logical.mode,
      display.bounds,
      display.workArea,
      (rect) => screen.dipToScreenRect(null, rect)
    );
  }

  getLayoutPreviewRects(settings: AppSettings): LayoutPreviewResult {
    const display = this.resolveLayoutDisplay(settings.screenLayout);
    const logical = buildLogicalLayout(display.workArea, settings.screenLayout);
    const slots = logical.slots.map((slot) => {
      const placement = buildDpiAwarePlacement(
        slot,
        logical.mode,
        display.bounds,
        display.workArea,
        (rect) => screen.dipToScreenRect(null, rect)
      );
      const preview = toPreviewDipRect(
        placement,
        (rect) => screen.screenToDipRect(null, rect)
      );
      return {
        label: String(slot.slotIndex + 1),
        ...preview,
        scale: placement.idealScale,
        overlaps: placement.overlaps,
        cutOff: placement.cutOff
      };
    });

    return { mode: logical.mode, workArea: display.workArea, slots };
  }

  private resolveLayoutDisplay(layout: ScreenLayoutSettings) {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();

    if (layout.monitorId !== "primary") {
      const selected = displays.find((display) => String(display.id) === layout.monitorId);
      if (selected) {
        return selected;
      }
    }

    return primary;
  }

  private allocateSlotIndex(slotCount: number): number {
    const occupiedSlots = new Set<number>();
    for (const handle of this.handles.values()) {
      if (handle.slotIndex >= 0) {
        occupiedSlots.add(handle.slotIndex);
      }
    }
    for (const idx of this.launchingSlotIndexes) {
      occupiedSlots.add(idx);
    }
    for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
      if (!occupiedSlots.has(slotIndex)) {
        return slotIndex;
      }
    }
    return occupiedSlots.size;
  }

  private clampNumber(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
  }

  async setAccountInfoOverlayEnabled(enabled: boolean): Promise<void> {
    this.accountInfoOverlayEnabled = enabled;
    await Promise.allSettled(
      [...this.handles.values()].flatMap((handle) =>
        handle.context.pages().map((page) => this.applyAccountInfoOverlayToPage(page, enabled))
      )
    );
  }

  async refreshAccountInfoForProfile(profileId: string, profile: ProfileSummary): Promise<void> {
    const handle = this.handles.get(profileId);
    if (!handle) return;
    const fields = this.buildAccountInfoFields(profile);
    // Guarda a versao viva p/ que navegacoes futuras nao revertam aos campos do launch.
    this.latestAccountInfoFields.set(profileId, fields);
    await Promise.allSettled(
      handle.context.pages().map((page) => this.applyAccountInfoFieldsToPage(page, fields))
    );
  }

  // Empurra os campos atuais para o overlay ja montado numa pagina (no-op se o init script
  // ainda nao expos a funcao). Usado tanto na atualizacao manual quanto apos cada navegacao.
  private async applyAccountInfoFieldsToPage(
    page: Page,
    fields: Array<{ label: string; value: string }>
  ): Promise<void> {
    if (page.isClosed()) return;
    await page
      .evaluate(
        (newFields) => {
          const w = globalThis as unknown as {
            __spiderAccountInfoSetFields?: (f: Array<{ label: string; value: string }>) => void;
          };
          if (typeof w.__spiderAccountInfoSetFields === "function") {
            w.__spiderAccountInfoSetFields(newFields);
          }
        },
        fields,
        PATCHRIGHT_INIT_SCRIPT_CONTEXT
      )
      .catch(() => null);
  }

  private async applyAccountInfoOverlayToPage(page: Page, enabled: boolean): Promise<void> {
    if (page.isClosed()) return;
    await page
      .evaluate(
        (visible) => {
          const w = globalThis as unknown as { __spiderAccountInfoSetVisible?: (v: boolean) => void };
          if (typeof w.__spiderAccountInfoSetVisible === "function") {
            w.__spiderAccountInfoSetVisible(visible);
            return;
          }
          const doc = (globalThis as unknown as { document: { getElementById: (id: string) => { style: { display: string } } | null } }).document;
          const wrap = doc.getElementById("spider-acct-info");
          if (wrap) {
            wrap.style.display = visible ? "block" : "none";
          }
        },
        enabled,
        PATCHRIGHT_INIT_SCRIPT_CONTEXT
      )
      .catch(() => null);
  }

  private buildAccountInfoFields(profile: ProfileSummary): Array<{ label: string; value: string }> {
    const account = profile.account;
    if (!account) return [];
    const fields: Array<{ label: string; value: string }> = [];
    if (account.username) fields.push({ label: "USUARIO", value: account.username });
    if (account.password) fields.push({ label: "SENHA LOGIN", value: account.password });
    if (account.withdrawalPassword) fields.push({ label: "SENHA SAQUE", value: account.withdrawalPassword });
    if (account.cpf) fields.push({ label: "CPF", value: account.cpf });
    if (account.pixPhoneKey) {
      fields.push({ label: "CHAVE PIX", value: account.pixPhoneKey });
    }
    if (account.phoneNumber) {
      fields.push({ label: "CELULAR", value: account.phoneNumber });
    }
    return fields;
  }

  private buildAccountInfoScript(profile: ProfileSummary): string {
    if (!profile.account) return "";
    const fields = this.buildAccountInfoFields(profile);
    if (fields.length === 0) return "";

    return `
(() => {
  if (window.top !== window) return;
  var WID = "spider-acct-info";
  var fields = ${JSON.stringify(fields)};
  var visible = false;
  var copyResetTimer = 0;

  function setCopyStatus(card, label, ok) {
    var status = card.querySelector("[data-spider-acct-copy-status]");
    if (!status) return;
    status.textContent = ok ? label + " copiado" : "Nao foi possivel copiar";
    status.style.opacity = "1";
    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(function() {
      status.style.opacity = "0";
    }, 1200);
  }

  function fallbackCopyText(value) {
    var textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "readonly");
    textarea.style.cssText = [
      "position:fixed",
      "left:-9999px",
      "top:0",
      "opacity:0"
    ].join(";");
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      return document.execCommand("copy");
    } catch (_) {
      return false;
    } finally {
      textarea.remove();
    }
  }

  function copyFieldValue(card, field) {
    var value = String(field && field.value ? field.value : "");
    if (!value) return;
    var done = function(ok) { setCopyStatus(card, field.label || "Dado", ok); };
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(value).then(
          function() { done(true); },
          function() { done(fallbackCopyText(value)); }
        );
        return;
      }
    } catch (_) {}
    done(fallbackCopyText(value));
  }

  function renderFieldsInto(card) {
    while (card.children.length > 1) { card.removeChild(card.lastChild); }
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var row = document.createElement("div");
      row.style.marginBottom = i < fields.length - 1 ? ".55em" : "0";
      row.style.cursor = "pointer";
      row.style.pointerEvents = "auto";
      row.setAttribute("title", "Clique para copiar");
      row.addEventListener("click", (function(field) {
        return function(event) {
          event.preventDefault();
          event.stopPropagation();
          copyFieldValue(card, field);
        };
      })(f));
      var lbl = document.createElement("div");
      lbl.textContent = f.label;
      lbl.style.cssText = "color:rgba(255,77,77,.5);font-size:.65em;font-weight:700;letter-spacing:.1em;margin-bottom:.12em;";
      var val = document.createElement("div");
      val.textContent = f.value;
      val.style.cssText = "color:rgba(255,255,255,.93);font-size:.98em;font-weight:700;word-break:break-all;line-height:1.3;user-select:text;";
      row.appendChild(lbl);
      row.appendChild(val);
      card.appendChild(row);
    }
  }

  function ensure() {
    if (!document.body) return;
    if (document.getElementById(WID)) { syncVisible(); return; }

    var wrap = document.createElement("div");
    wrap.id = WID;
    wrap.style.cssText = [
      "position:fixed",
      "left:0",
      "top:50%",
      "transform:translateY(-50%)",
      "z-index:2147483646",
      "display:none",
      "font-family:Arial,sans-serif",
      "user-select:none",
      "font-size:clamp(18px,3.2vw,30px)",
      "pointer-events:none"
    ].join(";");

    var card = document.createElement("div");
    card.style.cssText = [
      "background:rgba(8,4,4,.97)",
      "border:1px solid rgba(226,38,38,.55)",
      "border-left:none",
      "border-radius:0 .55em .55em 0",
      "padding:.9em 1.3em 1em .95em",
      "min-width:clamp(190px,26vw,330px)",
      "box-shadow:3px 0 22px rgba(0,0,0,.8),0 2px 12px rgba(0,0,0,.6)"
    ].join(";");

    var hdr = document.createElement("div");
    hdr.style.cssText = "padding-bottom:.45em;margin-bottom:.65em;border-bottom:1px solid rgba(226,38,38,.35);";
    var hdrTitle = document.createElement("div");
    hdrTitle.textContent = "\\u25C6 Dados da Conta \\u25C6";
    hdrTitle.style.cssText = "color:#ff4d4d;font-size:.75em;font-weight:700;letter-spacing:.09em;";
    var status = document.createElement("div");
    status.setAttribute("data-spider-acct-copy-status", "1");
    status.style.cssText = "color:rgba(255,255,255,.72);font-size:.58em;font-weight:700;margin-top:.35em;min-height:1em;opacity:0;transition:opacity .16s ease;";
    hdr.appendChild(hdrTitle);
    hdr.appendChild(status);
    card.appendChild(hdr);

    renderFieldsInto(card);
    wrap.appendChild(card);
    document.body.appendChild(wrap);
    syncVisible();
  }

  function syncVisible() {
    var wrap = document.getElementById(WID);
    if (!wrap) return;
    wrap.style.display = visible ? "block" : "none";
  }

  window.__spiderAccountInfoSetVisible = function(v) {
    visible = v;
    ensure();
    syncVisible();
  };

  window.__spiderAccountInfoSetFields = function(newFields) {
    fields = newFields;
    var wrap = document.getElementById(WID);
    if (wrap && wrap.firstElementChild) {
      renderFieldsInto(wrap.firstElementChild);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensure, { once: true });
  } else {
    ensure();
  }
  setTimeout(ensure, 400);
  setInterval(ensure, 15000);
})();
`;
  }

  async setSplashOverlay(profileId: string, active: boolean): Promise<void> {
    const handle = this.handles.get(profileId);
    if (!handle) {
      this.activeSplashes.delete(profileId);
      return;
    }
    if (active) {
      this.activeSplashes.set(profileId, "spider-bot-splash");
    } else {
      this.activeSplashes.delete(profileId);
    }
    const context = handle.context;
    const pages = context.pages();
    if (pages.length === 0) {
      return;
    }
    const logoDataUrl = getSplashLogoDataUrl();
    await Promise.allSettled(
      pages.map((page) =>
        page
          .evaluate(
            (payload) => {
              const { active, logoDataUrl } = payload;
              type RuntimeWindow = {
                __predatorSetSplashOverlay?: (next: { active: boolean }) => void;
              };
              const runtimeWindow = globalThis as unknown as RuntimeWindow;
              const setter = runtimeWindow.__predatorSetSplashOverlay;
              if (typeof setter === "function") {
                setter({ active });
                return;
              }
              // Fallback: injecao direta do overlay no DOM, sem depender do init script.
              // Necessario porque o init script pode nao ter rodado (ex.: paginas criadas
              // antes do registro, ou contextos onde addInitScript nao executa).
              const doc: any = (globalThis as any).document;
              const overlayId = "predator-splash-overlay";
              let overlay: any = doc.getElementById(overlayId);
              if (active) {
                if (!overlay) {
                  overlay = doc.createElement("div");
                  overlay.id = overlayId;
                  const img: any = doc.createElement("img");
                  img.id = overlayId + "-logo";
                  img.alt = "Spider BOT";
                  img.draggable = false;
                  if (logoDataUrl) {
                    img.setAttribute("src", logoDataUrl);
                  }
                  overlay.appendChild(img);
                  (doc.body || doc.documentElement).appendChild(overlay);
                }
                const root = [
                  "position:fixed",
                  "inset:0",
                  "z-index:2147483647",
                  "display:flex",
                  "align-items:center",
                  "justify-content:center",
                  "background:#000",
                  "padding:32px",
                  "box-sizing:border-box"
                ].join(";");
                const logo = [
                  "max-width:min(40vw, 280px)",
                  "max-height:min(40vh, 280px)",
                  "width:auto",
                  "height:auto",
                  "object-fit:contain",
                  "filter:drop-shadow(0 0 32px rgba(255,255,255,0.18))"
                ].join(";");
                overlay.setAttribute("style", root);
                const img = overlay.querySelector("img");
                if (img) img.setAttribute("style", logo);
              } else if (overlay && overlay.parentElement) {
                overlay.parentElement.removeChild(overlay);
              }
            },
            { active, logoDataUrl },
            PATCHRIGHT_INIT_SCRIPT_CONTEXT
          )
          .catch(() => null)
      )
    );
  }

  private buildSplashOverlayScript(logoDataUrl: string): string {
    const safeLogo = JSON.stringify(logoDataUrl);
    return `
(() => {
  if (window.top !== window) return;
  const overlayId = "predator-splash-overlay";
  const logoDataUrl = ${safeLogo};
  let active = false;

  const ensureOverlay = () => {
    let overlay = document.getElementById(overlayId);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = overlayId;
      const img = document.createElement("img");
      img.id = overlayId + "-logo";
      img.alt = "Spider BOT";
      img.draggable = false;
      overlay.appendChild(img);
      (document.body || document.documentElement).appendChild(overlay);
    }
    if (logoDataUrl) {
      const img = overlay.querySelector("img");
      if (img && img.getAttribute("src") !== logoDataUrl) {
        img.setAttribute("src", logoDataUrl);
      }
    }
    return overlay;
  };

  const render = () => {
    if (!document.body && !document.documentElement) return;
    const overlay = ensureOverlay();
    const root = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "background:#000",
      "padding:32px",
      "box-sizing:border-box"
    ].join(";");
    const logo = [
      "max-width:min(40vw, 280px)",
      "max-height:min(40vh, 280px)",
      "width:auto",
      "height:auto",
      "object-fit:contain",
      "filter:drop-shadow(0 0 32px rgba(255,255,255,0.18))"
    ].join(";");
    overlay.setAttribute("style", active ? root : root + ";display:none");
    const img = overlay.querySelector("img");
    if (img) img.setAttribute("style", logo);
  };

  window.__predatorSetSplashOverlay = (next) => {
    if (next && typeof next.active === "boolean") {
      active = next.active;
    }
    render();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render, { once: true });
  } else {
    render();
  }
})();
`;
  }

  // === DIAGNOSTICO TEMPORARIO (REMOVER APOS DEBUG) ===
  // Executa Runtime.evaluate no main + spawna um Web Worker para comparar
  // navigator.userAgent / platform / vendor / languages / webdriver entre os
  // dois contextos. Loga tudo no main process para identificarmos exatamente
  // qual campo esta inconsistente.
  private async diagnoseChromeAndWorker(
    profileId: string,
    page: Page
  ): Promise<void> {
    const log = (msg: string) => {
      try { console.log(`[DIAG ${profileId}] ${msg}`); } catch {}
    };

    const runOnce = async () => {
      // Esperar pagina estavel. `load` e mais robusto que domcontentloaded.
      try { await page.waitForLoadState("load", { timeout: 8000 }); } catch {}
      if (page.isClosed()) return;

      // Usar page.evaluate (Playwright) em vez de CDP direto: tem retry
      // automatico quando ha navegacao concorrente.
      const value = await page.evaluate(`(async () => {
        const safe = (v) => v === undefined ? 'undefined' : (v === null ? 'null' : String(v));
        const probe = (label) => {
          const n = navigator;
          // Inspecionar o descritor REAL de navigator.platform para ver
          // se foi sobrescrito pelo nosso init script.
          let platformDesc = 'no-descriptor';
          try {
            const d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
            platformDesc = d ? ('proto:' + JSON.stringify({ configurable: d.configurable, hasGetter: !!d.get })) : 'none-on-proto';
            const own = Object.getOwnPropertyDescriptor(n, 'platform');
            if (own) platformDesc += ' own:' + JSON.stringify({ configurable: own.configurable, hasGetter: !!own.get, value: own.value });
          } catch (e) { platformDesc = 'err:' + String(e); }
          return {
            label,
            ua: safe(n.userAgent),
            platform: safe(n.platform),
            vendor: safe(n.vendor),
            language: safe(n.language),
            languages: Array.isArray(n.languages) ? n.languages.join(',') : 'n/a',
            hw: safe(n.hardwareConcurrency),
            mem: safe(n.deviceMemory),
            maxTouch: safe(n.maxTouchPoints),
            webdriver: 'webdriver' in n ? safe(n.webdriver) : 'missing',
            uaData: 'userAgentData' in n ? safe(n.userAgentData && n.userAgentData.platform) : 'missing',
            chromeType: typeof window.chrome,
            chromeKeys: (window.chrome && typeof window.chrome === 'object') ? Object.keys(window.chrome).join(',') : 'n/a',
            fpApplied: (document.documentElement && document.documentElement.getAttribute('data-fp-applied')) || 'no',
            platformDesc
          };
        };
        const main = probe('MAIN');
        const workerData = await new Promise((resolve) => {
          let done = false;
          const finish = (d) => { if (!done) { done = true; resolve(d); } };
          try {
            const blob = new Blob([
              'self.onmessage = function() { try { var n = navigator; self.postMessage({ label: "WORKER", ua: String(n.userAgent), platform: String(n.platform), vendor: String(n.vendor), language: String(n.language), languages: Array.isArray(n.languages) ? n.languages.join(",") : "n/a", hw: String(n.hardwareConcurrency), mem: String(n.deviceMemory), maxTouch: String(n.maxTouchPoints), webdriver: "webdriver" in n ? String(n.webdriver) : "missing", chromeType: typeof self.chrome, chromeKeys: (self.chrome && typeof self.chrome === "object") ? Object.keys(self.chrome).join(",") : "n/a" }); } catch (e) { self.postMessage({ label: "WORKER", error: String(e) }); } };'
            ], { type: 'application/javascript' });
            const url = URL.createObjectURL(blob);
            const w = new Worker(url);
            const t = setTimeout(() => { try { w.terminate(); } catch {} finish({ error: 'timeout' }); }, 4000);
            w.onmessage = (ev) => { clearTimeout(t); try { URL.revokeObjectURL(url); } catch {} finish(ev.data || { error: 'no data' }); };
            w.onerror = (e) => { clearTimeout(t); try { URL.revokeObjectURL(url); } catch {} finish({ error: String((e && e.message) || e) }); };
          } catch (e) {
            finish({ error: String(e) });
          }
        });
        return { main, worker: workerData };
      })()`) as { main: Record<string, unknown>; worker: Record<string, unknown> | { error: string } };

      if (!value || typeof value !== "object") {
        log("no value returned: " + JSON.stringify(value));
        return;
      }
      log("MAIN    : " + JSON.stringify(value.main));
      log("WORKER  : " + JSON.stringify(value.worker));

      if (value.worker && !(value.worker as { error?: string }).error) {
        const w = value.worker as Record<string, unknown>;
        const m = value.main;
        const fields = ["ua", "platform", "vendor", "language", "languages", "hw", "mem", "maxTouch", "webdriver", "uaData", "chromeType", "chromeKeys", "fpApplied", "platformDesc"];
        const diffs: string[] = [];
        for (const f of fields) {
          if (String(m[f]) !== String(w[f])) diffs.push(f + ": MAIN=" + m[f] + " WORKER=" + w[f]);
        }
        log("DIFFS: " + (diffs.length ? diffs.join(" | ") : "NONE"));
      }
    };

    // Rodar em background com retry -- a pagina pode estar navegando
    // quando diagnosticamos. Ate 5 tentativas com 2s entre elas.
    (async () => {
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          await runOnce();
          return;
        } catch (error) {
          log("attempt " + attempt + " error: " + String((error as Error).message || error));
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      log("GAVE UP after 5 attempts");
    })();
  }

  private buildBadgesScript(
    profileId: string,
    placement: DpiAwarePlacement,
    effectiveScale: number,
    ipLabel: string
  ): string {
    const initialState = {
      screenLabel: this.buildScreenBadgeText(placement),
      ipLabel: this.buildIpBadgeText(ipLabel),
      selected: this.isPlacementSelected(profileId, placement)
    };
    const refreshIntervalMs = 6250;
    // Compensa o force-device-scale-factor para manter o badge sempre com o mesmo tamanho fisico ao
    // usuario, independente da escala. Em 0.8 -> 1.25, em 1.0 -> 1.0. Limitado a [1, 2] para evitar
    // badges absurdamente grandes se a escala for muito pequena.
    const compensation = Math.min(
      2,
      Math.max(1, 1 / (effectiveScale > 0 ? effectiveScale : 1))
    );
    const px = (value: number) => `${Math.max(1, Math.round(value * compensation * 100) / 100)}px`;

    return `
(() => {
  if (window.top !== window) return;
  const rootId = "predator-runtime-badges";
  const outlineId = "predator-runtime-selected-outline";
  const state = ${JSON.stringify(initialState)};
  const rootStyle = [
    "position:fixed",
    "right:${px(5)}",
    "bottom:${px(5)}",
    "z-index:2147483647",
    "display:flex",
    "align-items:center",
    "gap:${px(4)}",
    "pointer-events:none",
    "max-width:calc(100vw - ${px(10)})",
    "font:700 ${px(10)}/1.1 Arial, sans-serif"
  ].join(";");
  const badgeStyle = [
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "min-height:${px(15)}",
    "max-width:${px(130)}",
    "padding:${px(2)} ${px(5)}",
    "border:${px(1)} solid rgba(0,255,99,.38)",
    "border-radius:${px(3)}",
    "background:rgba(0,0,0,.9)",
    "color:#39ff72",
    "box-shadow:0 ${px(1)} ${px(6)} rgba(0,0,0,.35)",
    "white-space:nowrap",
    "overflow:hidden",
    "text-overflow:ellipsis",
    "letter-spacing:0"
  ].join(";");
  const outlineStyle = [
    "position:fixed",
    "inset:0",
    "z-index:2147483646",
    "pointer-events:none",
    "border:${px(3)} solid rgba(255,45,45,.95)",
    "box-shadow:inset 0 0 0 ${px(1)} rgba(0,0,0,.75),0 0 ${px(14)} rgba(255,0,0,.42)",
    "border-radius:${px(2)}"
  ].join(";");
  const render = () => {
    if (!document.body) {
      return;
    }
    let outline = document.getElementById(outlineId);
    if (!outline) {
      outline = document.createElement("div");
      outline.id = outlineId;
      document.body.appendChild(outline);
    }
    outline.setAttribute("style", state.selected ? outlineStyle : outlineStyle + ";display:none");

    let root = document.getElementById(rootId);
    if (!root) {
      root = document.createElement("div");
      root.id = rootId;
      document.body.appendChild(root);
    }
    root.setAttribute("style", rootStyle);
    root.replaceChildren();
    for (const text of [state.screenLabel, state.ipLabel]) {
      const badge = document.createElement("span");
      badge.setAttribute("style", badgeStyle);
      badge.textContent = text;
      root.appendChild(badge);
    }
  };
  window.__predatorUpdateRuntimeBadges = (next) => {
    if (next && typeof next.screenLabel === "string") {
      state.screenLabel = next.screenLabel;
    }
    if (next && typeof next.ipLabel === "string") {
      state.ipLabel = next.ipLabel;
    }
    if (next && typeof next.selected === "boolean") {
      state.selected = next.selected;
    }
    render();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render, { once: true });
  } else {
    render();
  }
  window.setTimeout(render, 400);
  window.setInterval(render, ${refreshIntervalMs});
})();
`;
  }

  private async updateContextBadges(
    profileId: string,
    context: BrowserContext,
    placement: DpiAwarePlacement,
    effectiveScale: number,
    ipLabel: string
  ): Promise<void> {
    await Promise.allSettled(
      context
        .pages()
        .map((page) =>
          this.applyBadgeToPage(
            page,
            profileId,
            placement,
            effectiveScale,
            ipLabel
          )
        )
    );
  }

  private async applyBadgeToPage(
    page: Page,
    profileId: string,
    placement: DpiAwarePlacement,
    _effectiveScale: number,
    ipLabel: string
  ): Promise<void> {
    if (page.isClosed()) {
      return;
    }

    await page
      .evaluate((payload) => {
        const updateBadges = (globalThis as unknown as {
          __predatorUpdateRuntimeBadges?: (next: {
            screenLabel: string;
            ipLabel: string;
            selected: boolean;
          }) => void;
        }).__predatorUpdateRuntimeBadges;

        if (typeof updateBadges === "function") {
          updateBadges(payload);
        }
      }, {
        screenLabel: this.buildScreenBadgeText(placement),
        ipLabel: this.buildIpBadgeText(ipLabel),
        selected: this.isPlacementSelected(profileId, placement)
      }, PATCHRIGHT_INIT_SCRIPT_CONTEXT)
      .catch(() => null);
  }

  private isPlacementSelected(profileId: string, placement: DpiAwarePlacement): boolean {
    if (this.selectedWindowState.mode === "all") {
      return false;
    }
    if (this.selectedWindowState.mode === "none") {
      return false;
    }
    return this.selectedWindowState.windows.some(
      (windowRef) => windowRef.profileId === profileId && windowRef.slotNumber === placement.slotIndex + 1
    );
  }

  private async resolveVisibleIp(page: Page, fallbackIp: string): Promise<string> {
    const normalizedFallback = this.normalizeIpLabel(fallbackIp);
    const requestIp = await page
      .context()
      .request.get("https://api.ipify.org?format=json", {
        timeout: 2500
      })
      .then(async (response) => {
        if (!response.ok()) {
          return "";
        }

        const data = (await response.json().catch(() => undefined)) as { ip?: unknown } | undefined;
        return typeof data?.ip === "string" ? data.ip : "";
      })
      .catch(() => "");

    if (requestIp) {
      return this.normalizeIpLabel(requestIp);
    }

    const visibleIp = await Promise.race([
      page
        .evaluate(async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 2500);

          try {
            const response = await fetch("https://api.ipify.org?format=json", {
              cache: "no-store",
              signal: controller.signal
            });
            const data = (await response.json()) as { ip?: unknown };
            return typeof data.ip === "string" ? data.ip : "";
          } finally {
            clearTimeout(timeout);
          }
        })
        .catch(() => ""),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve(""), 2800);
      })
    ]);

    return this.normalizeIpLabel(visibleIp || normalizedFallback);
  }

  private normalizeIpLabel(value: string): string {
    const normalized = value.trim().replace(/^ip\s*/i, "");
    return normalized || "direto";
  }

  private buildScreenBadgeText(placement: DpiAwarePlacement): string {
    return `Tela ${placement.slotIndex + 1}`;
  }

  private buildIpBadgeText(ipLabel: string): string {
    return `IP ${this.normalizeIpLabel(ipLabel)}`;
  }

  private buildHostRulesArgs(): string[] {
    const rules: string[] = [
      "MAP accounts.google.com 0.0.0.0"
    ];
    if (this.domainBlockEnabled && this.blockedDomains.length > 0) {
      for (const domain of this.blockedDomains) {
        rules.push(`MAP ${domain} 0.0.0.0`);
      }
    }
    return [`--host-rules=${rules.join(",")}`];
  }

  private buildFingerprintArgs(profile: ProfileSummary): string[] {
    const args = [
      // === DESABILITAR FEATURES QUE VAZAM INFORMAÃ‡ÃƒO ===
      "--disable-features=PasswordManagerOnboarding,PasswordCheck,AutofillServerCommunication,TranslateUI,OptimizationHints,MediaRouter,DialMediaRouteProvider,InterestFeedContentSuggestions,ReadLater",
      
      // === PRIVACIDADE E SEGURANÃ‡A ===
      "--disable-dev-shm-usage",
      
      // === DESABILITAR PASSWORD MANAGER ===
      "--disable-password-generation",
      "--disable-save-password-bubble",
      
      // === REDUZIR FINGERPRINTING ===
      "--disable-logging",
      "--disable-breakpad",
      "--disable-datasaver-prompt",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-hang-monitor",
      "--disable-prompt-on-repost",
      "--disable-sync",
      "--no-first-run",
      "--test-type",
      "--mute-audio",
      "--disable-speech-api",
      "--disk-cache-size=52428800",
      
      // === GPU E WEBGL - Usar GPU real quando disponÃ­vel ===
      "--use-angle=default",
      "--disable-gpu-compositing",
      "--gpu-no-context-lost",
      "--enable-webgl",
      "--enable-webgl2-compute-context",
      
      // === NETWORK ===
      // === EVITAR DETECÃ‡ÃƒO DE HEADLESS ===
      "--window-size=1920,1080",

      // === ANTI-THROTTLING (multiplas janelas em paralelo) ===
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-ipc-flooding-protection",
      "--disable-renderer-backgrounding",

    ];

    switch (profile.persona.webRtcMode) {
      case "relay-only":
        args.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
        break;
      case "disabled":
        args.push("--disable-webrtc");
        break;
      default:
        break;
    }

    if (profile.persona.dnsMode === "secure") {
      args.push("--enable-features=UseDnsHttpsSvcbAlpn");
    }

    return args;
  }
}

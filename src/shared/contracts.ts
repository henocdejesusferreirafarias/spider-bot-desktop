import type {
  LicenseActivateRequest,
  LicenseClientState
} from "@spider-bot/licensing-contracts";

export interface AppInfo {
  name: string;
  version: string;
  isPackaged: boolean;
  releaseUrl: string;
}

export interface AppWindowMode {
  cockpit: boolean;
  alwaysOnTop: boolean;
}

export type AppWindowKind = "manager" | "instance";
export type InstanceStatus = "stopped" | "running";

export interface InstanceRecord {
  id: string;
  name: string;
  status: InstanceStatus;
  profileCount: number;
  proxyCount: number;
  pixPhoneKeyCount: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
}

export type AppContext =
  | {
      kind: "manager";
    }
  | {
      kind: "instance";
      instance: InstanceRecord;
    };

export type UpdatePhase =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error";

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  downloadedVersion?: string;
  progressPercent?: number;
  message: string;
}

export type RuntimeStatus =
  | "idle"
  | "launching"
  | "active"
  | "stopping"
  | "running-automation"
  | "error";

export type ProxyStatus = "unknown" | "healthy" | "degraded" | "offline";
export const PROXY_MODES = ["static", "rotating-residential"] as const;
export type ProxyMode = (typeof PROXY_MODES)[number];
export type AutomationStatus =
  | "draft"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";
export type AutomationKind = "account-registration";
export type ProfileAccountStatus = "generated" | "registered" | "failed";
export type PixPhoneKeyStatus = "available" | "reserved" | "pending_confirmation" | "rejected" | "used";
export type PixRegistrationType = "PHONE";
export type ActivityLevel = "info" | "success" | "warning" | "error";
export type AppSection =
  | "dashboard"
  | "profiles"
  | "proxies"
  | "pix-keys"
  | "automations"
  | "screens"
  | "activity"
  | "settings";
export const NAVIGATION_MODES = ["mobile-ios-android", "desktop"] as const;
export type NavigationMode = (typeof NAVIGATION_MODES)[number];
export const NAVIGATION_MODE_LAUNCH_ARG_PREFIX = "--predator-navigation-mode=";
export const MAX_SCREEN_GRID_DIMENSION = 8;
export const MIN_BROWSER_WINDOW_WIDTH = 260;
export const MIN_BROWSER_WINDOW_HEIGHT = 220;
export const MIN_GRID_BROWSER_WINDOW_WIDTH = 420;
export const MIN_GRID_BROWSER_WINDOW_HEIGHT = 420;

export const ACCOUNT_REGISTRATION_KIND: AutomationKind = "account-registration";

export interface ViewportPreset {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface GeoLocationConfig {
  latitude: number;
  longitude: number;
  accuracy: number;
}

export interface PersonaConfig {
  id: string;
  profileId: string;
  version: number;
  name: string;
  userAgent: string;
  locale: string;
  timezone: string;
  viewport: ViewportPreset;
  geolocation: GeoLocationConfig;
  allowNotifications: boolean;
  allowClipboard: boolean;
  webRtcMode: "default" | "relay-only" | "disabled";
  dnsMode: "system" | "secure" | "proxy-first";
  leakProtection: "standard" | "strict";
  headers: Array<{ key: string; value: string }>;
  launchArgs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProxyConfig {
  id: string;
  label: string;
  protocol: "http" | "https" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
  status: ProxyStatus;
  mode: ProxyMode;
  usernameSuffixTemplate?: string;
  lastCheckedAt?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileRecord {
  id: string;
  name: string;
  codeName: string;
  notes: string;
  status: RuntimeStatus;
  storagePath: string;
  homeUrl: string;
  proxyId?: string;
  personaId: string;
  tags: string[];
  color: string;
  lastLaunchedAt?: string;
  lastAutomationAt?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileAccountRecord {
  id: string;
  profileId: string;
  platformId: string;
  username: string;
  password: string;
  phoneCountryCode: string;
  phoneNumber: string;
  realName: string;
  cpf?: string;
  withdrawalPassword?: string;
  pixPhoneKey?: string;
  pixKeyRegisteredOrigins: string[];
  pixKeyRegisteredAt?: string;
  status: ProfileAccountStatus;
  lastError?: string;
  generatedAt: string;
  registeredAt?: string;
  registeredOrigins: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProfileSummary extends ProfileRecord {
  persona: PersonaConfig;
  proxy?: ProxyConfig;
  account?: ProfileAccountRecord;
  automationCount: number;
  lastRunStatus?: AutomationStatus;
}

export interface PixPhoneKeyRecord {
  id: string;
  phoneNumber: string;
  status: PixPhoneKeyStatus;
  assignedProfileId?: string;
  assignedAt?: string;
  reservationRunId?: string;
  pendingProfileId?: string;
  pendingRunId?: string;
  pendingAt?: string;
  rejectedAt?: string;
  rejectionReason?: "withdrawal-account-already-linked";
  usedProfileId?: string;
  usedAccountId?: string;
  usedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomDepositAmountRecord {
  id: string;
  amount: string;
  source: "manual" | "generated";
  createdAt: string;
}

export interface PixPhoneKeyImportResult {
  created: PixPhoneKeyRecord[];
  skipped: string[];
  invalid: string[];
}

export type ScreenLayoutMode = "grid" | "cascade";
export type RuntimeControlNavigationAction = "home" | "bet-report" | "treasure-chests" | "slot-search" | "refresh";

export interface ScreenLayoutSlot {
  id: string;
  label: string;
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
}

export interface ScreenMonitorLayout {
  displayId: string;
  enabled: boolean;
  mode: ScreenLayoutMode;
  columns: number;
  rows: number;
}

export interface ScreenLayoutSettings {
  version: 2;
  monitors: ScreenMonitorLayout[];
}

export interface ScreenDisplayInfo {
  id: string;
  label: string;
  primary: boolean;
  scaleFactor: number;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  workArea: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface AutomationRecord {
  id: string;
  profileId: string;
  kind: AutomationKind;
  name: string;
  description: string;
  startUrl: string;
  params: Record<string, string>;
  status: AutomationStatus;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileLaunchOptions {
  triggerAutomation?: boolean;
  deferNavigation?: boolean;
}

export interface AutomationBatchRunRequest {
  automationIds: string[];
  delaySeconds: number;
}

export interface AutomationBatchRunResult {
  scheduled: number;
  delaySeconds: number;
}

export interface AutomationRunLogEntry {
  timestamp: string;
  level: ActivityLevel;
  message: string;
}

export interface AutomationRunRecord {
  id: string;
  automationId: string;
  profileId: string;
  status: AutomationStatus;
  startedAt: string;
  finishedAt?: string;
  logs: AutomationRunLogEntry[];
  metrics: Record<string, string | number | boolean>;
}

export interface ActivityLogRecord {
  id: string;
  scope: "app" | "profile" | "proxy" | "automation" | "runtime";
  scopeId?: string;
  level: ActivityLevel;
  message: string;
  details?: Record<string, string | number | boolean>;
  createdAt: string;
}

export interface AppSettings {
  browserChannel: "chromium";
  autoRestoreSessions: boolean;
  autoClosePopupsDuringNavigation: boolean;
  showAccountInfoOverlay: boolean;
  postRegistrationDepositEnabled: boolean;
  customDepositAmounts: CustomDepositAmountRecord[];
  reducedMotion: boolean;
  themeMode: "light" | "night";
  exportDirectory: string;
  screenLayout: ScreenLayoutSettings;
  automationStartDelaySeconds: number;
  // Bloqueio de dominios: corta requisicoes de fundo (ex.: transmissoes ao vivo) que
  // drenam o proxy. Casa por hostname (dominio + subdominios). Padrao ligado.
  domainBlockEnabled: boolean;
  blockedDomains: string[];
}

export const MIN_AUTOMATION_START_DELAY_SECONDS = 0;
export const MAX_AUTOMATION_START_DELAY_SECONDS = 600;
// Delay minimo recomendado entre inicios de sessao. Abaixo disso, varias instancias
// carregam SPAs pesadas ao mesmo tempo e a contencao de CPU/GPU trava janelas no
// carregamento, fazendo a automacao falhar. Usado como padrao e no aviso ao usuario.
export const RECOMMENDED_MIN_START_DELAY_SECONDS = 20;

export interface ExportRecord {
  id: string;
  type: "profiles";
  path: string;
  createdAt: string;
  metadata: Record<string, string | number | boolean>;
}

export interface ProfileDeletionItemResult {
  profileId: string;
  profileName: string;
  status: "deleted" | "failed";
  reason?: string;
}

export interface ProfileDeletionProgress {
  total: number;
  completed: number;
  deleted: number;
  failed: number;
}

export interface ProfileDeletionResult extends ProfileDeletionProgress {
  items: ProfileDeletionItemResult[];
}

export interface AppSnapshot {
  profiles: ProfileSummary[];
  proxies: ProxyConfig[];
  automations: AutomationRecord[];
  runs: AutomationRunRecord[];
  activity: ActivityLogRecord[];
  pixPhoneKeys: PixPhoneKeyRecord[];
  runtimeWindows: RuntimeWindowTarget[];
  settings: AppSettings;
  exports: ExportRecord[];
  license: LicenseClientState;
}

export interface ProfileDraft {
  name: string;
  notes: string;
  homeUrl: string;
  tags: string[];
  color: string;
  proxyId?: string;
  accountCpf?: string;
  withdrawalPassword?: string;
  persona?: Partial<PersonaConfig>;
}

export interface ProxyDraft {
  label: string;
  protocol: ProxyConfig["protocol"];
  host: string;
  port: number;
  username?: string;
  password?: string;
  mode?: ProxyConfig["mode"];
  usernameSuffixTemplate?: string;
  notes?: string;
}

export interface AutomationDraft {
  profileId: string;
  kind: AutomationKind;
  name?: string;
  description?: string;
  startUrl?: string;
  params?: Record<string, string>;
}

export interface NativeExportPayload {
  profiles: ProfileRecord[];
  personas: PersonaConfig[];
  proxies: ProxyConfig[];
  accounts: ProfileAccountRecord[];
  automations: AutomationRecord[];
  activity: ActivityLogRecord[];
  exportedAt: string;
}

export interface RuntimeWindowTarget {
  profileId: string;
  profileName: string;
  slotNumber: number;
  status: RuntimeStatus;
  automationActive: boolean;
  accountUsername?: string;
  accountPhoneNumber?: string;
}

export interface RuntimeControlWindowRef {
  slotNumber: number;
  profileId: string;
}

export type RuntimeControlTargetSelection =
  | { mode: "all" }
  | { mode: "windows"; windows: RuntimeControlWindowRef[] };

export type RuntimeControlSelectionState =
  | RuntimeControlTargetSelection
  | { mode: "none"; reason?: string };

export interface ManualDepositControlRequest {
  amounts: string[];
  targetSelection: RuntimeControlTargetSelection;
}

export interface ManualDepositControlResult {
  amount: string;
  error?: string;
  profileId: string;
  profileName: string;
  status: "succeeded" | "failed";
}

export interface PixKeyRegistrationControlRequest {
  pixType: PixRegistrationType;
  targetSelection: RuntimeControlTargetSelection;
}

export interface PixKeyRegistrationControlResult {
  error?: string;
  pixType: PixRegistrationType;
  profileId: string;
  profileName: string;
  status: "needs_withdrawal_password" | "withdrawal_password_filled" | "withdrawal_ready" | "pix_receiving_ready" | "withdrawal_password_required" | "withdrawal_password_entered" | "pix_add_form_ready" | "pix_add_form_filled" | "pix_already_registered" | "pix_key_registered" | "pix_key_pending_confirmation" | "pix_key_conflict" | "failed";
  step?: "profile" | "withdrawal-management" | "withdrawal-password" | "withdrawal-password-confirmation" | "pix-receiving-account" | "pix-preflight" | "pix-add-password" | "pix-enter-password" | "pix-password-confirmation" | "pix-add-form-fill" | "pix-submit" | "pix-submission-confirmation";
}

export interface WithdrawalPreparationControlRequest {
  targetSelection: RuntimeControlTargetSelection;
}

export interface WithdrawalPreparationControlResult {
  error?: string;
  profileId: string;
  profileName: string;
  status: "succeeded" | "failed";
}

export interface RuntimeEvent {
  type:
    | "snapshot-updated"
    | "instances-updated"
    | "license-status-changed"
    | "update-status-changed"
    | "profile-status-changed"
    | "profile-deletion-progress"
    | "automation-log"
    | "activity-log"
    | "run-status-changed";
  payload?: Record<string, unknown>;
}

export interface PredatorApi {
  app: {
    context: () => Promise<AppContext>;
    info: () => Promise<AppInfo>;
    snapshot: () => Promise<AppSnapshot>;
    getWindowMode: () => Promise<AppWindowMode>;
    setCockpitMode: (enabled: boolean) => Promise<AppWindowMode>;
    setCockpitAlwaysOnTop: (enabled: boolean) => Promise<AppWindowMode>;
    minimize: () => Promise<void>;
    close: () => Promise<void>;
    openReleases: () => Promise<void>;
  };
  instances: {
    list: () => Promise<InstanceRecord[]>;
    create: (name?: string) => Promise<InstanceRecord>;
    rename: (instanceId: string, name: string) => Promise<InstanceRecord>;
    delete: (instanceId: string) => Promise<void>;
    open: (instanceId: string) => Promise<InstanceRecord>;
    stop: (instanceId: string) => Promise<InstanceRecord | undefined>;
  };
  updates: {
    status: () => Promise<UpdateStatus>;
    check: () => Promise<UpdateStatus>;
    install: () => Promise<UpdateStatus>;
  };
  license: {
    status: () => Promise<LicenseClientState>;
    activate: (request: Pick<LicenseActivateRequest, "email" | "licenseKey">) => Promise<LicenseClientState>;
    revalidate: () => Promise<LicenseClientState>;
    clear: () => Promise<LicenseClientState>;
  };
  profiles: {
    list: () => Promise<ProfileSummary[]>;
    create: (draft: ProfileDraft) => Promise<ProfileSummary>;
    update: (profileId: string, draft: Partial<ProfileDraft>) => Promise<ProfileSummary>;
    delete: (profileId: string) => Promise<void>;
    deleteMany: (profileIds: string[]) => Promise<ProfileDeletionResult>;
    archive: (profileId: string) => Promise<void>;
    duplicate: (profileId: string) => Promise<ProfileSummary>;
    launch: (profileId: string, options?: ProfileLaunchOptions) => Promise<ProfileSummary>;
    stop: (profileId: string) => Promise<ProfileSummary>;
    restart: (profileId: string) => Promise<ProfileSummary>;
    bindProxy: (profileId: string, proxyId?: string) => Promise<ProfileSummary>;
    exportNative: (profileIds: string[]) => Promise<ExportRecord>;
    importNative: (importPath: string) => Promise<AppSnapshot>;
  };
  proxies: {
    list: () => Promise<ProxyConfig[]>;
    create: (draft: ProxyDraft) => Promise<ProxyConfig>;
    update: (proxyId: string, draft: Partial<ProxyDraft>) => Promise<ProxyConfig>;
    delete: (proxyId: string) => Promise<void>;
    test: (proxyId: string) => Promise<ProxyConfig>;
  };
  automations: {
    list: () => Promise<AutomationRecord[]>;
    create: (draft: AutomationDraft) => Promise<AutomationRecord>;
    update: (
      automationId: string,
      draft: Partial<AutomationDraft>
    ) => Promise<AutomationRecord>;
    runNow: (automationId: string) => Promise<AutomationRunRecord>;
    cancel: (runId: string) => Promise<void>;
    runBatch: (request: AutomationBatchRunRequest) => Promise<AutomationBatchRunResult>;
    cancelBatch: () => Promise<{ cancelled: boolean }>;
  };
  runs: {
    list: () => Promise<AutomationRunRecord[]>;
    clear: () => Promise<{ removed: number }>;
  };
  activity: {
    list: () => Promise<ActivityLogRecord[]>;
    clear: () => Promise<{ removed: number }>;
  };
  pixKeys: {
    list: () => Promise<PixPhoneKeyRecord[]>;
    addPhoneNumbers: (input: string) => Promise<PixPhoneKeyImportResult>;
    updatePhoneNumber: (pixKeyId: string, phoneNumber: string) => Promise<PixPhoneKeyRecord>;
    delete: (pixKeyId: string) => Promise<void>;
  };
  settings: {
    get: () => Promise<AppSettings>;
    update: (draft: Partial<AppSettings>) => Promise<AppSettings>;
  };
  screens: {
    listDisplays: () => Promise<ScreenDisplayInfo[]>;
    applyLayout: () => Promise<void>;
    previewLayout: () => Promise<void>;
  };
  controls: {
    deposit: (request: ManualDepositControlRequest) => Promise<ManualDepositControlResult[]>;
    registerPixKey: (request: PixKeyRegistrationControlRequest) => Promise<PixKeyRegistrationControlResult[]>;
    openWithdrawals: (
      request: WithdrawalPreparationControlRequest
    ) => Promise<WithdrawalPreparationControlResult[]>;
    navigate: (
      action: RuntimeControlNavigationAction,
      targetSelection: RuntimeControlTargetSelection,
      searchTerm?: string
    ) => Promise<void>;
    setMirrorMode: (enabled: boolean, selection: RuntimeControlSelectionState) => Promise<void>;
    setSelectedWindows: (selection: RuntimeControlSelectionState) => Promise<void>;
    setSpeed: (rate: number, targetSelection: RuntimeControlTargetSelection) => Promise<void>;
  };
  events: {
    subscribe: (listener: (event: RuntimeEvent) => void) => () => void;
  };
}

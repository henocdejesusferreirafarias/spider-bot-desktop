import electronUpdater from "electron-updater";
import type { UpdateStatus } from "../../shared/contracts.js";

interface DownloadProgress {
  percent?: number;
}

interface UpdateInfo {
  version: string;
}

export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates: () => Promise<unknown>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => UpdaterLike;
}

export interface UpdateServiceOptions {
  currentVersion: string;
  enabled: boolean;
  updater?: UpdaterLike;
  onStatusChange?: (status: UpdateStatus) => void;
}

export class UpdateService {
  private readonly updater: UpdaterLike;
  private readonly enabled: boolean;
  private checking = false;
  private downloaded = false;
  private status: UpdateStatus;

  constructor(private readonly options: UpdateServiceOptions) {
    this.enabled = options.enabled;
    this.updater = options.updater ?? getDefaultUpdater();
    this.status = this.enabled
      ? {
          phase: "idle",
          currentVersion: options.currentVersion,
          message: "Atualizacoes automaticas prontas."
        }
      : {
          phase: "disabled",
          currentVersion: options.currentVersion,
          message: "Atualizacoes automaticas ficam ativas no app instalado."
        };

    if (this.enabled) {
      this.configureUpdater();
    }
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    if (!this.enabled) {
      return this.getStatus();
    }
    if (this.checking || this.status.phase === "downloading") {
      return this.getStatus();
    }
    if (this.downloaded) {
      return this.getStatus();
    }

    this.checking = true;
    this.setStatus({
      phase: "checking",
      currentVersion: this.options.currentVersion,
      message: "Procurando atualizacoes..."
    });

    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.checking = false;
      this.setStatus({
        phase: "error",
        currentVersion: this.options.currentVersion,
        message: describeError(error)
      });
    }

    return this.getStatus();
  }

  installDownloadedUpdate(): UpdateStatus {
    if (!this.enabled) {
      return this.getStatus();
    }
    if (!this.downloaded) {
      return this.getStatus();
    }

    this.setStatus({
      ...this.status,
      message: "Reiniciando para instalar atualizacao..."
    });
    this.updater.quitAndInstall(false, true);
    return this.getStatus();
  }

  private configureUpdater(): void {
    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = false;

    this.updater.on("checking-for-update", () => {
      this.checking = true;
      this.setStatus({
        phase: "checking",
        currentVersion: this.options.currentVersion,
        message: "Procurando atualizacoes..."
      });
    });

    this.updater.on("update-available", (info: unknown) => {
      const updateInfo = info as Partial<UpdateInfo>;
      this.setStatus({
        phase: "available",
        currentVersion: this.options.currentVersion,
        availableVersion: updateInfo.version,
        message: `Atualizacao ${updateInfo.version ?? ""} encontrada.`
      });
    });

    this.updater.on("download-progress", (progress: unknown) => {
      const downloadProgress = progress as DownloadProgress;
      this.setStatus({
        ...this.status,
        phase: "downloading",
        progressPercent: Math.max(0, Math.min(100, downloadProgress.percent ?? 0)),
        message: "Baixando atualizacao..."
      });
    });

    this.updater.on("update-downloaded", (info: unknown) => {
      const updateInfo = info as Partial<UpdateInfo>;
      this.checking = false;
      this.downloaded = true;
      this.setStatus({
        phase: "downloaded",
        currentVersion: this.options.currentVersion,
        availableVersion: updateInfo.version,
        downloadedVersion: updateInfo.version,
        progressPercent: 100,
        message: "Atualizacao pronta para instalar."
      });
    });

    this.updater.on("update-not-available", () => {
      this.checking = false;
      this.setStatus({
        phase: "not-available",
        currentVersion: this.options.currentVersion,
        message: "Voce ja esta na versao mais recente."
      });
    });

    this.updater.on("error", (error: unknown) => {
      this.checking = false;
      this.setStatus({
        phase: "error",
        currentVersion: this.options.currentVersion,
        message: describeError(error)
      });
    });
  }

  private setStatus(status: UpdateStatus): void {
    this.status = status;
    this.options.onStatusChange?.(status);
  }
}

function getDefaultUpdater(): UpdaterLike {
  return (electronUpdater as { autoUpdater: UpdaterLike }).autoUpdater;
}

export function shouldEnableAutoUpdates(isPackaged: boolean): boolean {
  return isPackaged || process.env.PREDATOR_ENABLE_DEV_UPDATES === "true";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Nao foi possivel verificar atualizacoes.";
}

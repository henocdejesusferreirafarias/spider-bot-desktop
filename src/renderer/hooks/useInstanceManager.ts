import { useEffect, useState } from "react";
import type { LicenseActivateRequest, LicenseClientState } from "@spider-bot/licensing-contracts";
import type { AppInfo, InstanceRecord, UpdateStatus } from "../../shared/contracts.js";

const fallbackAppInfo: AppInfo = {
  name: "Spider BOT",
  version: "0.0.0",
  isPackaged: false,
  releaseUrl: "https://github.com/henocdejesusferreirafarias/spider-bot-releases/releases/latest"
};

const fallbackUpdateStatus: UpdateStatus = {
  phase: "disabled",
  currentVersion: fallbackAppInfo.version,
  message: "Atualizacoes automaticas ficam ativas no app instalado."
};

const fallbackLicenseState: LicenseClientState = {
  status: "unlicensed",
  operational: false,
  message: "Ative sua licenca para usar as operacoes do Spider BOT."
};

export function useInstanceManager() {
  const [instances, setInstances] = useState<InstanceRecord[]>([]);
  const [appInfo, setAppInfo] = useState<AppInfo>(fallbackAppInfo);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(fallbackUpdateStatus);
  const [licenseState, setLicenseState] = useState<LicenseClientState>(fallbackLicenseState);
  const [busyAction, setBusyAction] = useState<string>();

  useEffect(() => {
    void window.predator.app.info().then(setAppInfo).catch(() => undefined);
    void window.predator.updates.status().then(setUpdateStatus).catch(() => undefined);
    void window.predator.license.status().then(setLicenseState).catch(() => undefined);
    void window.predator.instances.list().then(setInstances).catch(() => undefined);

    return window.predator.events.subscribe((event) => {
      if (event.type === "instances-updated" && event.payload) {
        const next = event.payload.instances as InstanceRecord[] | undefined;
        if (next) {
          setInstances(next);
        }
      }
      if (event.type === "update-status-changed" && event.payload) {
        setUpdateStatus(event.payload as unknown as UpdateStatus);
      }
      if (event.type === "license-status-changed" && event.payload) {
        setLicenseState(event.payload as unknown as LicenseClientState);
      }
    });
  }, []);

  const mutate = async <T,>(key: string, operation: () => Promise<T>) => {
    setBusyAction(key);
    try {
      const result = await operation();
      setInstances(await window.predator.instances.list());
      return result;
    } finally {
      setBusyAction(undefined);
    }
  };

  return {
    appInfo,
    busyAction,
    instances,
    licenseState,
    updateStatus,
    checkForUpdates: () => mutate("updates:check", () => window.predator.updates.check()).then(setUpdateStatus),
    installUpdate: () => mutate("updates:install", () => window.predator.updates.install()).then(setUpdateStatus),
    openReleases: () => mutate("app:open-releases", () => window.predator.app.openReleases()),
    activateLicense: (request: Pick<LicenseActivateRequest, "email" | "licenseKey">) =>
      mutate("license:activate", () => window.predator.license.activate(request)).then(setLicenseState),
    revalidateLicense: () => mutate("license:revalidate", () => window.predator.license.revalidate()).then(setLicenseState),
    clearLicense: () => mutate("license:clear", () => window.predator.license.clear()).then(setLicenseState),
    createInstance: (name?: string) => mutate("instances:create", () => window.predator.instances.create(name)),
    deleteInstance: (instanceId: string) =>
      mutate(`instances:delete:${instanceId}`, () => window.predator.instances.delete(instanceId)),
    openInstance: (instanceId: string) =>
      mutate(`instances:open:${instanceId}`, () => window.predator.instances.open(instanceId)),
    renameInstance: (instanceId: string, name: string) =>
      mutate(`instances:rename:${instanceId}`, () => window.predator.instances.rename(instanceId, name)),
    stopInstance: (instanceId: string) =>
      mutate(`instances:stop:${instanceId}`, () => window.predator.instances.stop(instanceId))
  };
}

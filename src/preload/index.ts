import { contextBridge, ipcRenderer } from "electron";
import type { PredatorApi, RuntimeEvent } from "../shared/contracts.js";

const api: PredatorApi = {
  app: {
    context: () => ipcRenderer.invoke("app:context"),
    info: () => ipcRenderer.invoke("app:info"),
    snapshot: () => ipcRenderer.invoke("app:snapshot"),
    getWindowMode: () => ipcRenderer.invoke("app:get-window-mode"),
    setCockpitMode: (enabled) => ipcRenderer.invoke("app:set-cockpit-mode", enabled),
    setCockpitAlwaysOnTop: (enabled) => ipcRenderer.invoke("app:set-cockpit-always-on-top", enabled),
    minimize: () => ipcRenderer.invoke("app:minimize"),
    close: () => ipcRenderer.invoke("app:close"),
    openReleases: () => ipcRenderer.invoke("app:open-releases")
  },
  instances: {
    list: () => ipcRenderer.invoke("instances:list"),
    create: (name) => ipcRenderer.invoke("instances:create", name),
    rename: (instanceId, name) => ipcRenderer.invoke("instances:rename", instanceId, name),
    delete: (instanceId) => ipcRenderer.invoke("instances:delete", instanceId),
    open: (instanceId) => ipcRenderer.invoke("instances:open", instanceId),
    stop: (instanceId) => ipcRenderer.invoke("instances:stop", instanceId)
  },
  updates: {
    status: () => ipcRenderer.invoke("updates:status"),
    check: () => ipcRenderer.invoke("updates:check"),
    install: () => ipcRenderer.invoke("updates:install")
  },
  license: {
    status: () => ipcRenderer.invoke("license:status"),
    activate: (request) => ipcRenderer.invoke("license:activate", request),
    revalidate: () => ipcRenderer.invoke("license:revalidate"),
    clear: () => ipcRenderer.invoke("license:clear")
  },
  profiles: {
    list: () => ipcRenderer.invoke("profiles:list"),
    create: (draft) => ipcRenderer.invoke("profiles:create", draft),
    update: (profileId, draft) => ipcRenderer.invoke("profiles:update", profileId, draft),
    delete: (profileId) => ipcRenderer.invoke("profiles:delete", profileId),
    archive: (profileId) => ipcRenderer.invoke("profiles:archive", profileId),
    duplicate: (profileId) => ipcRenderer.invoke("profiles:duplicate", profileId),
    launch: (profileId, options) => ipcRenderer.invoke("profiles:launch", profileId, options),
    stop: (profileId) => ipcRenderer.invoke("profiles:stop", profileId),
    restart: (profileId) => ipcRenderer.invoke("profiles:restart", profileId),
    bindProxy: (profileId, proxyId) => ipcRenderer.invoke("profiles:bind-proxy", profileId, proxyId),
    exportNative: (profileIds) => ipcRenderer.invoke("profiles:export-native", profileIds),
    importNative: (importPath) => ipcRenderer.invoke("profiles:import-native", importPath)
  },
  proxies: {
    list: () => ipcRenderer.invoke("proxies:list"),
    create: (draft) => ipcRenderer.invoke("proxies:create", draft),
    update: (proxyId, draft) => ipcRenderer.invoke("proxies:update", proxyId, draft),
    delete: (proxyId) => ipcRenderer.invoke("proxies:delete", proxyId),
    test: (proxyId) => ipcRenderer.invoke("proxies:test", proxyId)
  },
  automations: {
    list: () => ipcRenderer.invoke("automations:list"),
    create: (draft) => ipcRenderer.invoke("automations:create", draft),
    update: (automationId, draft) => ipcRenderer.invoke("automations:update", automationId, draft),
    runNow: (automationId) => ipcRenderer.invoke("automations:run-now", automationId),
    cancel: (runId) => ipcRenderer.invoke("automations:cancel", runId),
    runBatch: (request) => ipcRenderer.invoke("automations:run-batch", request),
    cancelBatch: () => ipcRenderer.invoke("automations:cancel-batch")
  },
  runs: {
    list: () => ipcRenderer.invoke("runs:list"),
    clear: () => ipcRenderer.invoke("runs:clear")
  },
  activity: {
    list: () => ipcRenderer.invoke("activity:list"),
    clear: () => ipcRenderer.invoke("activity:clear")
  },
  pixKeys: {
    list: () => ipcRenderer.invoke("pix-keys:list"),
    addPhoneNumbers: (input) => ipcRenderer.invoke("pix-keys:add-phone-numbers", input),
    updatePhoneNumber: (pixKeyId, phoneNumber) =>
      ipcRenderer.invoke("pix-keys:update-phone-number", pixKeyId, phoneNumber),
    delete: (pixKeyId) => ipcRenderer.invoke("pix-keys:delete", pixKeyId)
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    update: (draft) => ipcRenderer.invoke("settings:update", draft)
  },
  screens: {
    listDisplays: () => ipcRenderer.invoke("screens:list-displays"),
    applyLayout: () => ipcRenderer.invoke("screens:apply-layout"),
    previewLayout: () => ipcRenderer.invoke("screens:preview-layout")
  },
  controls: {
    deposit: (request) => ipcRenderer.invoke("controls:deposit", request),
    registerPixKey: (request) => ipcRenderer.invoke("controls:register-pix-key", request),
    openWithdrawals: (request) => ipcRenderer.invoke("controls:open-withdrawals", request),
    navigate: (action, targetSelection, searchTerm) =>
      ipcRenderer.invoke("controls:navigate", action, targetSelection, searchTerm),
    setMirrorMode: (enabled, selection) =>
      ipcRenderer.invoke("controls:set-mirror-mode", enabled, selection),
    setSelectedWindows: (selection) => ipcRenderer.invoke("controls:set-selected-windows", selection),
    setSpeed: (rate, targetSelection) => ipcRenderer.invoke("controls:set-speed", rate, targetSelection)
  },
  events: {
    subscribe: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: RuntimeEvent) => {
        listener(payload);
      };

      ipcRenderer.on("predator:event", wrapped);
      return () => {
        ipcRenderer.removeListener("predator:event", wrapped);
      };
    }
  }
};

contextBridge.exposeInMainWorld("predator", api);

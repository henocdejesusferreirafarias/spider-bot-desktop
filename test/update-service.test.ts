import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldEnableAutoUpdates,
  UpdateService,
  type UpdaterLike
} from "../src/main/services/update-service.js";

class FakeUpdater implements UpdaterLike {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  installed = false;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): UpdaterLike {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  async checkForUpdates(): Promise<unknown> {
    this.emit("update-available", { version: "0.2.0" });
    this.emit("download-progress", { percent: 42 });
    this.emit("update-downloaded", { version: "0.2.0" });
    return undefined;
  }

  quitAndInstall(): void {
    this.installed = true;
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

test("downloads an available update and installs only when requested", async () => {
  const updater = new FakeUpdater();
  const changes: string[] = [];
  const service = new UpdateService({
    currentVersion: "0.1.0",
    enabled: true,
    updater,
    onStatusChange: (status) => changes.push(status.phase)
  });

  const status = await service.checkForUpdates();

  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(status.phase, "downloaded");
  assert.equal(status.downloadedVersion, "0.2.0");
  assert.deepEqual(changes, ["checking", "available", "downloading", "downloaded"]);
  assert.equal(updater.installed, false);

  service.installDownloadedUpdate();

  assert.equal(updater.installed, true);
});

test("does not check for updates when disabled", async () => {
  const updater = new FakeUpdater();
  const service = new UpdateService({
    currentVersion: "0.1.0",
    enabled: false,
    updater
  });

  const status = await service.checkForUpdates();

  assert.equal(status.phase, "disabled");
  assert.equal(updater.autoDownload, false);
});

test("enables auto update in packaged builds or explicit dev override", () => {
  const previous = process.env.PREDATOR_ENABLE_DEV_UPDATES;
  try {
    delete process.env.PREDATOR_ENABLE_DEV_UPDATES;
    assert.equal(shouldEnableAutoUpdates(false), false);
    assert.equal(shouldEnableAutoUpdates(true), true);

    process.env.PREDATOR_ENABLE_DEV_UPDATES = "true";
    assert.equal(shouldEnableAutoUpdates(false), true);
  } finally {
    process.env.PREDATOR_ENABLE_DEV_UPDATES = previous;
  }
});

import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import test from "node:test";
import { PredatorDatabase } from "../src/main/services/database.js";
import { InstanceRegistry } from "../src/main/services/instance-registry.js";
import { createPredatorInstancePaths, type PredatorGlobalPaths } from "../src/main/services/paths.js";
import type { SecureStore } from "../src/main/services/secure-store.js";

const plainStore = {
  encrypt: (value?: string) => value,
  decrypt: (value?: string) => value
} as SecureStore;

function createGlobalPaths(): PredatorGlobalPaths {
  const root = mkdtempSync(join(tmpdir(), "spider-instances-"));
  const instancesRoot = join(root, "instances");
  mkdirSync(instancesRoot);
  return {
    appData: root,
    instancesRoot,
    instanceRegistryFile: join(root, "instances.sqlite")
  };
}

test("instance registry creates, renames, marks, stops and deletes workspaces", () => {
  const paths = createGlobalPaths();
  const registry = new InstanceRegistry(paths);

  const created = registry.createInstance("Primeira");
  assert.equal(created.name, "Primeira");
  assert.equal(created.status, "stopped");
  assert.equal(existsSync(registry.getInstanceRoot(created.id)), true);

  const renamed = registry.renameInstance(created.id, "Operacao A");
  assert.equal(renamed.name, "Operacao A");

  const opened = registry.markOpened(created.id);
  assert.equal(opened.status, "running");
  assert.ok(opened.lastOpenedAt);

  const stopped = registry.markStopped(created.id);
  assert.equal(stopped?.status, "stopped");

  const root = registry.getInstanceRoot(created.id);
  registry.deleteInstance(created.id);
  assert.equal(existsSync(root), false);
  assert.equal(registry.listInstances().length, 0);

  registry.close();
});

test("instance registry rejects unsafe instance paths before deletion", () => {
  const paths = createGlobalPaths();
  const registry = new InstanceRegistry(paths);
  const db = new DatabaseSync(paths.instanceRegistryFile);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO instances (id, name, status, created_at, updated_at) VALUES (?, ?, 'stopped', ?, ?)"
  ).run("../outside", "Unsafe", now, now);
  db.close();

  assert.throws(() => registry.deleteInstance("../outside"), /invalido|inseguro/i);
  registry.close();
});

test("desktop instance data is isolated across sqlite workspaces", () => {
  const globalPaths = createGlobalPaths();
  const registry = new InstanceRegistry(globalPaths);
  const first = registry.createInstance("A");
  const second = registry.createInstance("B");
  const firstDb = new PredatorDatabase(createPredatorInstancePaths(globalPaths, first.id), plainStore);
  const secondDb = new PredatorDatabase(createPredatorInstancePaths(globalPaths, second.id), plainStore);

  firstDb.createProfile({
    name: "Perfil A",
    notes: "",
    homeUrl: "https://example.com/a",
    tags: ["a"],
    color: "#d6d6d6"
  });
  firstDb.createProxy({
    label: "Proxy A",
    protocol: "http",
    host: "127.0.0.1",
    port: 8080
  });
  firstDb.addPixPhoneKeys("11999999999");

  assert.equal(firstDb.listProfiles().length, 1);
  assert.equal(firstDb.listProxies().length, 1);
  assert.equal(firstDb.listPixPhoneKeys().length, 1);
  assert.equal(secondDb.listProfiles().length, 0);
  assert.equal(secondDb.listProxies().length, 0);
  assert.equal(secondDb.listPixPhoneKeys().length, 0);

  firstDb.close();
  secondDb.close();
  registry.close();
});

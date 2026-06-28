import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { App as ElectronApp } from "electron";

const require = createRequire(import.meta.url);

export interface PredatorPaths {
  appData: string;
  databaseFile: string;
  profilesRoot: string;
  exportsRoot: string;
  capturesRoot: string;
}

export interface PredatorGlobalPaths {
  appData: string;
  instancesRoot: string;
  instanceRegistryFile: string;
}

export function createPredatorGlobalPaths(): PredatorGlobalPaths {
  const appData = join(getElectronApp().getPath("userData"), "predator");
  const instancesRoot = join(appData, "instances");

  mkdirSync(appData, { recursive: true });
  mkdirSync(instancesRoot, { recursive: true });

  return {
    appData,
    instancesRoot,
    instanceRegistryFile: join(appData, "instances.sqlite")
  };
}

export function createPredatorPaths(): PredatorPaths {
  const appData = join(getElectronApp().getPath("userData"), "predator");
  const profilesRoot = join(appData, "profiles");
  const exportsRoot = join(appData, "exports");
  const capturesRoot = join(appData, "captures");

  mkdirSync(appData, { recursive: true });
  mkdirSync(profilesRoot, { recursive: true });
  mkdirSync(exportsRoot, { recursive: true });
  mkdirSync(capturesRoot, { recursive: true });

  return {
    appData,
    databaseFile: join(appData, "predator.sqlite"),
    profilesRoot,
    exportsRoot,
    capturesRoot
  };
}

export function createPredatorInstancePaths(globalPaths: PredatorGlobalPaths, instanceId: string): PredatorPaths {
  const appData = join(globalPaths.instancesRoot, instanceId);
  const profilesRoot = join(appData, "profiles");
  const exportsRoot = join(appData, "exports");
  const capturesRoot = join(appData, "captures");

  mkdirSync(appData, { recursive: true });
  mkdirSync(profilesRoot, { recursive: true });
  mkdirSync(exportsRoot, { recursive: true });
  mkdirSync(capturesRoot, { recursive: true });

  return {
    appData,
    databaseFile: join(appData, "predator.sqlite"),
    profilesRoot,
    exportsRoot,
    capturesRoot
  };
}

function getElectronApp(): ElectronApp {
  // Lazy CommonJS require so this module can be imported from non-electron contexts (tests, scripts).
  const { app } = require("electron") as typeof import("electron");
  return app;
}

function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function findRepoEnv(startDirs: string[]): string | null {
  for (const start of startDirs) {
    let dir = resolve(start);
    for (let i = 0; i < 6; i += 1) {
      const candidate = join(dir, ".env");
      if (existsSync(candidate)) {
        return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export function loadDotEnv(): string | null {
  let startDirs: string[];
  try {
    startDirs = [process.cwd(), getElectronApp().getAppPath()];
  } catch {
    startDirs = [process.cwd()];
  }
  return loadDotEnvFrom(startDirs);
}

export function loadDotEnvFrom(startDirs: string[]): string | null {
  const file = findRepoEnv(startDirs);
  if (!file) {
    return null;
  }
  let parsed: Record<string, string>;
  try {
    parsed = parseEnvText(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return file;
}

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const rootDir = process.cwd();
const distDir = join(rootDir, "dist-electron");
const stableMs = Number(process.env.DIST_STABLE_MS ?? 2500);
const timeoutMs = Number(process.env.DIST_STABLE_TIMEOUT_MS ?? 20000);

const requiredFiles = [
  "main/index.js",
  "preload/index.js",
  "main/services/automation-runtime.js",
  "main/services/browser-runtime.js",
  "main/services/database.js",
  "main/services/geetest-solver.js",
  "shared/contracts.js",
  "shared/defaults.js"
];

const toSystemPath = (path) => join(distDir, ...path.split("/"));

async function latestMtimeMs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  let latest = 0;

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      latest = Math.max(latest, await latestMtimeMs(fullPath));
      continue;
    }

    const info = await stat(fullPath);
    latest = Math.max(latest, info.mtimeMs);
  }

  return latest;
}

async function allRequiredFilesExist() {
  try {
    await Promise.all(requiredFiles.map((file) => stat(toSystemPath(file))));
    return true;
  } catch {
    return false;
  }
}

const startedAt = Date.now();
let lastObservedMtime = 0;
let quietSince = Date.now();

while (Date.now() - startedAt < timeoutMs) {
  if (!(await allRequiredFilesExist())) {
    lastObservedMtime = 0;
    quietSince = Date.now();
    await sleep(200);
    continue;
  }

  const currentMtime = await latestMtimeMs(distDir);

  if (currentMtime !== lastObservedMtime) {
    lastObservedMtime = currentMtime;
    quietSince = Date.now();
  }

  if (Date.now() - quietSince >= stableMs && Date.now() - startedAt >= stableMs) {
    process.exit(0);
  }

  await sleep(200);
}

console.error(`dist-electron did not stay quiet for ${stableMs}ms within ${timeoutMs}ms.`);
process.exit(1);

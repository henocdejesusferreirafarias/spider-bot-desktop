import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function isValidNineNums(value) {
  return Number.isInteger(value) && value >= 1 && value <= 9;
}

function recentEnough(mtimeMs, lockWindowMs) {
  return Date.now() - mtimeMs <= lockWindowMs;
}

function listDirectories(rawDir) {
  try {
    return readdirSync(rawDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export class JsonlWriter {
  constructor(file) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
  }

  append(value) {
    appendFileSync(this.file, `${JSON.stringify(value)}\n`);
  }
}

export class StateFile {
  constructor(file, { lockWindowMs = 5000 } = {}) {
    this.file = file;
    this.lockWindowMs = lockWindowMs;
    this.lastKnownMtimeMs = existsSync(file) ? statSync(file).mtimeMs : 0;
  }

  load() {
    if (!existsSync(this.file)) {
      return null;
    }
    this.lastKnownMtimeMs = statSync(this.file).mtimeMs;
    return readJson(this.file);
  }

  save(value, expectedMtimeMs = this.lastKnownMtimeMs) {
    if (existsSync(this.file)) {
      const currentMtimeMs = statSync(this.file).mtimeMs;
      if (currentMtimeMs !== expectedMtimeMs) {
        this.lastKnownMtimeMs = currentMtimeMs;
        if (recentEnough(currentMtimeMs, this.lockWindowMs)) {
          return {
            ok: false,
            reason: 'lock window exceeded: another writer may be active',
          };
        }
      }
    }

    mkdirSync(dirname(this.file), { recursive: true });
    const tmpFile = `${this.file}.tmp`;
    writeFileSync(tmpFile, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmpFile, this.file);
    this.lastKnownMtimeMs = statSync(this.file).mtimeMs;
    return { ok: true, mtimeMs: this.lastKnownMtimeMs };
  }
}

export function loadChallenges(rawDir) {
  const challenges = [];
  const skipLog = [];

  for (const entry of listDirectories(rawDir)) {
    const dir = join(rawDir, entry);
    const metaPath = join(dir, 'meta.json');
    const gridPath = join(dir, 'grid.jpg');
    const quesPath = join(dir, 'ques.png');

    if (!existsSync(metaPath) || !existsSync(gridPath) || !existsSync(quesPath)) {
      skipLog.push(`${entry}: missing meta.json, grid.jpg, or ques.png`);
      continue;
    }

    let meta;
    try {
      meta = readJson(metaPath);
    } catch {
      skipLog.push(`${entry}: meta.json invalid JSON`);
      continue;
    }

    if (
      typeof meta !== 'object' ||
      meta === null ||
      typeof meta.captchaId !== 'string' ||
      typeof meta.lotNumber !== 'string' ||
      !isValidNineNums(meta.nineNums)
    ) {
      skipLog.push(`${entry}: meta.json missing or invalid required fields`);
      continue;
    }

    challenges.push({
      id: entry,
      captchaId: meta.captchaId,
      lotNumber: meta.lotNumber,
      nineNums: meta.nineNums,
      gridPath,
      quesPath,
      targetClass: typeof meta.targetClass === 'string' ? meta.targetClass : null,
    });
  }

  return { challenges, skipLog };
}

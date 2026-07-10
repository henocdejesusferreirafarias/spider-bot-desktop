import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './captcha-nine-dataset-utils.mjs';

const IMAGE_NAME_GRID = 'grid.jpg';
const IMAGE_NAME_QUES = 'ques.png';

function isRemoteReference(value) {
  return /^(?:https?:|data:)/i.test(value);
}

function sanitizeSlug(value) {
  return String(value ?? 'capture')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'capture';
}

function listDirectories(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function nextIndex(outRoot, append) {
  if (!append || !existsSync(outRoot)) return 0;
  let max = -1;
  for (const name of listDirectories(outRoot)) {
    const match = name.match(/^(\d{6})-/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function assertLocalExistingFile(value, baseDir, fieldName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  if (isRemoteReference(value)) {
    throw new Error('remote image references are not supported by the offline importer');
  }
  const resolved = isAbsolute(value) ? value : resolve(baseDir, value);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`${fieldName} does not exist: ${resolved}`);
  }
  return resolved;
}

function readJsonFile(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readManifest(manifest) {
  const text = readFileSync(manifest, 'utf8');
  if (manifest.toLowerCase().endsWith('.jsonl')) {
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }
  const value = JSON.parse(text);
  return Array.isArray(value) ? value : [value];
}

function normalizeNineNums(value) {
  const number = Number(value ?? 3);
  if (!Number.isInteger(number) || number < 1 || number > 9) {
    throw new Error(`nineNums must be an integer from 1 to 9, got ${value}`);
  }
  return number;
}

function normalizeManifestRecord(record, baseDir, index) {
  if (!record || typeof record !== 'object') {
    throw new Error(`manifest record ${index} must be an object`);
  }
  const gridPath = assertLocalExistingFile(record.gridPath ?? record.grid, baseDir, `record ${index} gridPath`);
  const quesPath = assertLocalExistingFile(record.quesPath ?? record.ques, baseDir, `record ${index} quesPath`);
  return {
    ...record,
    sourceId: record.id ?? record.lotNumber ?? basename(gridPath, '.jpg') ?? `capture-${index}`,
    gridPath,
    quesPath,
    captchaType: record.captchaType ?? 'nine',
    captchaId: record.captchaId ?? 'authorized-local',
    lotNumber: record.lotNumber ?? `local-${index}`,
    nineNums: normalizeNineNums(record.nineNums),
  };
}

function findRequiredImage(dir, fileName, label) {
  const file = join(dir, fileName);
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`${label} missing ${fileName}`);
  }
  return file;
}

function normalizeDirectoryRecord(inputDir, entry, index) {
  const dir = join(inputDir, entry);
  const metaPath = join(dir, 'meta.json');
  const meta = existsSync(metaPath) ? readJsonFile(metaPath) : {};
  if (!meta || typeof meta !== 'object') {
    throw new Error(`${entry}: meta.json must contain an object`);
  }
  return {
    ...meta,
    sourceId: meta.id ?? entry,
    gridPath: findRequiredImage(dir, IMAGE_NAME_GRID, entry),
    quesPath: findRequiredImage(dir, IMAGE_NAME_QUES, entry),
    captchaType: meta.captchaType ?? 'nine',
    captchaId: meta.captchaId ?? 'authorized-local',
    lotNumber: meta.lotNumber ?? entry,
    nineNums: normalizeNineNums(meta.nineNums),
  };
}

function loadRecords({ manifest, inputDir }) {
  if (manifest && inputDir) {
    throw new Error('use either --manifest or --in, not both');
  }
  if (!manifest && !inputDir) {
    throw new Error('missing input: pass --manifest <file> or --in <directory>');
  }
  if (manifest) {
    const manifestPath = resolve(manifest);
    const baseDir = dirname(manifestPath);
    return readManifest(manifestPath).map((record, index) => normalizeManifestRecord(record, baseDir, index));
  }

  const resolvedInput = resolve(inputDir);
  return listDirectories(resolvedInput).map((entry, index) => normalizeDirectoryRecord(resolvedInput, entry, index));
}

function writeImportedRecord(record, outRoot, outputId) {
  const dir = join(outRoot, outputId);
  if (existsSync(dir)) {
    throw new Error(`output entry already exists: ${dir}`);
  }
  mkdirSync(dir, { recursive: true });
  copyFileSync(record.gridPath, join(dir, IMAGE_NAME_GRID));
  copyFileSync(record.quesPath, join(dir, IMAGE_NAME_QUES));

  const {
    gridPath,
    quesPath,
    sourceId,
    ...metadata
  } = record;
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify({
    ...metadata,
    id: outputId,
    sourceId,
    originalGridPath: gridPath,
    originalQuesPath: quesPath,
    importedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

export function importAuthorizedNineDataset(options = {}) {
  const manifest = options.manifest ? String(options.manifest) : null;
  const inputDir = options.inputDir ? String(options.inputDir) : null;
  const outRoot = resolve(String(options.outRoot ?? join('dataset', 'raw-authorized')));
  const append = Boolean(options.append);
  const records = loadRecords({ manifest, inputDir });
  const start = nextIndex(outRoot, append);
  const entries = [];

  mkdirSync(outRoot, { recursive: true });
  records.forEach((record, offset) => {
    const outputId = `${String(start + offset).padStart(6, '0')}-${sanitizeSlug(record.sourceId)}`;
    writeImportedRecord(record, outRoot, outputId);
    entries.push(outputId);
  });

  return {
    imported: entries.length,
    skipped: 0,
    outRoot,
    entries,
  };
}

function usage() {
  return [
    'Usage:',
    '  tsx scripts/captcha-import-authorized-nine-dataset.mjs --manifest captures.jsonl --out dataset/raw-authorized',
    '  tsx scripts/captcha-import-authorized-nine-dataset.mjs --in captures-dir --out dataset/raw-authorized --append',
    '',
    'Inputs are offline/local only. Records must point to local grid.jpg and ques.png files.',
  ].join('\n');
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || args.h) {
      console.log(usage());
      process.exitCode = 0;
    } else {
      const result = importAuthorizedNineDataset({
        manifest: args.manifest,
        inputDir: args.in,
        outRoot: args.out,
        append: Boolean(args.append),
      });
      console.log(`Imported ${result.imported} authorized nine challenges into ${result.outRoot}`);
      for (const entry of result.entries) console.log(entry);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('');
    console.error(usage());
    process.exitCode = 1;
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importAuthorizedNineDataset } from '../scripts/captcha-import-authorized-nine-dataset.mjs';

const fixtureGrid = join(process.cwd(), 'test', 'fixtures', 'captcha', 'nine', 'grid.jpg');
const fixtureQues = join(process.cwd(), 'test', 'fixtures', 'captcha', 'nine', 'ques.png');

function tempDir(name: string) {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

test('imports local manifest records into label-server dataset shape', () => {
  const dir = tempDir('captcha-authorized-manifest');
  const manifest = join(dir, 'captures.jsonl');
  const out = join(dir, 'raw');
  writeFileSync(manifest, `${JSON.stringify({
    id: 'first capture',
    gridPath: fixtureGrid,
    quesPath: fixtureQues,
    captchaType: 'nine',
    captchaId: 'local-captcha',
    lotNumber: 'lot-1',
    nineNums: 3,
    source: 'authorized-fixture',
    extra: { promptKind: 'nine_prompt' },
  })}\n`);

  const result = importAuthorizedNineDataset({ manifest, outRoot: out });

  assert.deepEqual(result, {
    imported: 1,
    skipped: 0,
    outRoot: out,
    entries: ['000000-first-capture'],
  });
  const entry = join(out, '000000-first-capture');
  assert.equal(readFileSync(join(entry, 'grid.jpg')).length, readFileSync(fixtureGrid).length);
  assert.equal(readFileSync(join(entry, 'ques.png')).length, readFileSync(fixtureQues).length);
  const meta = JSON.parse(readFileSync(join(entry, 'meta.json'), 'utf8'));
  assert.equal(meta.id, '000000-first-capture');
  assert.equal(meta.captchaType, 'nine');
  assert.equal(meta.captchaId, 'local-captcha');
  assert.equal(meta.lotNumber, 'lot-1');
  assert.equal(meta.nineNums, 3);
  assert.equal(meta.source, 'authorized-fixture');
  assert.equal(meta.extra.promptKind, 'nine_prompt');
});

test('imports local challenge directories and appends after existing numeric prefix', () => {
  const dir = tempDir('captcha-authorized-directory');
  const input = join(dir, 'captures');
  const out = join(dir, 'raw');
  mkdirSync(join(input, 'b'), { recursive: true });
  mkdirSync(join(input, 'a'), { recursive: true });
  mkdirSync(join(out, '000007-existing'), { recursive: true });
  for (const name of ['a', 'b']) {
    copyFileSync(fixtureGrid, join(input, name, 'grid.jpg'));
    copyFileSync(fixtureQues, join(input, name, 'ques.png'));
    writeFileSync(join(input, name, 'meta.json'), JSON.stringify({
      captchaId: `captcha-${name}`,
      lotNumber: `lot-${name}`,
      nineNums: 3,
    }));
  }

  const result = importAuthorizedNineDataset({ inputDir: input, outRoot: out, append: true });

  assert.equal(result.imported, 2);
  assert.deepEqual(result.entries, ['000008-a', '000009-b']);
  assert.deepEqual(readdirSync(out).sort(), ['000007-existing', '000008-a', '000009-b']);
});

test('rejects remote image references because importer is offline-only', () => {
  const dir = tempDir('captcha-authorized-remote');
  const manifest = join(dir, 'captures.json');
  writeFileSync(manifest, JSON.stringify([{
    id: 'remote',
    gridPath: 'https://static.example/grid.jpg',
    quesPath: fixtureQues,
  }]));

  assert.throws(
    () => importAuthorizedNineDataset({ manifest, outRoot: join(dir, 'raw') }),
    /remote image references are not supported/,
  );
});

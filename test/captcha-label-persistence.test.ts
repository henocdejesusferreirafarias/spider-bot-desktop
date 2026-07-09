import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlWriter, StateFile, loadChallenges } from '../scripts/captcha-label-persistence.mjs';

test('JsonlWriter appends one JSON object per line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'captcha-label-persist-'));
  const file = join(dir, 'sub', 'labels.jsonl');
  const writer = new JsonlWriter(file);
  writer.append({ a: 1 });
  writer.append({ b: 2 });
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]!), { a: 1 });
  assert.deepEqual(JSON.parse(lines[1]!), { b: 2 });
});

test('StateFile save and load roundtrip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'captcha-label-persist-'));
  const file = join(dir, 'state.json');
  const sf = new StateFile(file);
  const result = sf.save({ x: 1 });
  assert.equal(result.ok, true);
  if (result.ok) assert.ok(result.mtimeMs > 0);
  const loaded = sf.load();
  assert.deepEqual(loaded, { x: 1 });
});

test('StateFile detects external modification within lock window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'captcha-label-persist-'));
  const file = join(dir, 'state.json');
  const sf = new StateFile(file, { lockWindowMs: 5000 });
  const first = sf.save({ v: 1 });
  assert.equal(first.ok, true);
  setTimeout(() => {
    writeFileSync(file, JSON.stringify({ v: 'tampered' }));
  }, 50);
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      const second = sf.save({ v: 2 });
      assert.equal(second.ok, false);
      resolve();
    }, 200);
  });
});

test('loadChallenges reads valid challenges and skips malformed ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'captcha-label-load-'));
  const raw = join(dir, 'raw');
  const goodId = '000000-aaaa';
  const goodDir = join(raw, goodId);
  mkdirSync(goodDir, { recursive: true });
  writeFileSync(join(goodDir, 'grid.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  writeFileSync(join(goodDir, 'ques.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(goodDir, 'meta.json'), JSON.stringify({
    id: goodId,
    captchaId: 'cap',
    lotNumber: 'lot',
    targetClass: 'plane_d',
    nineNums: 3,
    gridPath: 'g',
    quesPath: 'q',
  }));
  const badDir = join(raw, '000001-bad');
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, 'grid.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  writeFileSync(join(badDir, 'ques.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const result = loadChallenges(raw);
  assert.equal(result.challenges.length, 1);
  assert.equal(result.challenges[0]?.id, goodId);
  assert.ok(result.skipLog.some((line) => line.includes('000001-bad')));
});

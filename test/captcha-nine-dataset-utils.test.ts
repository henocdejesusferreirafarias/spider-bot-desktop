import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitGridCells, writeJsonlLine, readJsonl } from '../scripts/captcha-nine-dataset-utils.mjs';

test('splitGridCells returns 9 1-indexed cells in reading order', () => {
  const w = 6;
  const h = 6;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cellId = Math.floor(y / 2) * 3 + Math.floor(x / 2) + 1;
      const i = (y * w + x) * 4;
      rgba[i] = cellId;
      rgba[i + 1] = cellId;
      rgba[i + 2] = cellId;
      rgba[i + 3] = 255;
    }
  }

  const cells = splitGridCells(rgba, w, h);
  assert.equal(cells.length, 9);
  assert.deepEqual(cells.map((c) => [c.row, c.col]), [
    [1, 1], [1, 2], [1, 3],
    [2, 1], [2, 2], [2, 3],
    [3, 1], [3, 2], [3, 3],
  ]);
  assert.equal(cells[0]?.width, 2);
  assert.equal(cells[0]?.height, 2);
  assert.equal(cells[8]?.data[0], 9);
});

test('jsonl helpers append and read deterministic objects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'captcha-nine-jsonl-'));
  const file = join(dir, 'labels.jsonl');
  writeJsonlLine(file, { id: 'b', score: 0.2 });
  writeJsonlLine(file, { id: 'a', score: 0.9 });
  assert.deepEqual(readJsonl(file), [{ id: 'b', score: 0.2 }, { id: 'a', score: 0.9 }]);
  assert.match(readFileSync(file, 'utf8'), /"id":"b"/);
});

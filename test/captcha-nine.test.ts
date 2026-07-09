import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findIconCells } from '../src/main/services/captcha/solvers/nine.js';

test('findIconCells devolve as células esperadas (fixture)', async () => {
  const expected = JSON.parse(readFileSync('test/fixtures/captcha/nine/expected.json','utf8')).cells;
  const grid = readFileSync('test/fixtures/captcha/nine/grid.jpg');
  const ques = readFileSync('test/fixtures/captcha/nine/ques.png');
  const cells = await findIconCells(grid, ques, 3);
  assert.deepEqual(cells.sort(), expected.sort());
});

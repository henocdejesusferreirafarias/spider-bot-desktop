import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { normalizeNineMatchPairForImageNet, normalizePhotoRgbForImageNet } from '../src/main/services/captcha/onnx-session.js';
import { findIconCellsPhoto, rankPhotoCellsForTarget } from '../src/main/services/captcha/solvers/nine-photo.js';

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgba[0];
    png.data[i + 1] = rgba[1];
    png.data[i + 2] = rgba[2];
    png.data[i + 3] = rgba[3];
  }
  return PNG.sync.write(png);
}

test('normalizePhotoRgbForImageNet returns CHW ImageNet-normalized 64x64 RGB', () => {
  const rgba = new Uint8Array(2 * 2 * 4);
  rgba.set([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255,
  ]);
  const out = normalizePhotoRgbForImageNet(rgba, 2, 2);
  assert.equal(out.length, 3 * 64 * 64);
  assert.ok(Number.isFinite(out[0]));
  assert.ok(Math.abs(out[0]! - ((1 - 0.485) / 0.229)) < 0.0001);
  assert.ok(Math.abs(out[64 * 64]! - ((0 - 0.456) / 0.224)) < 0.0001);
  assert.ok(Math.abs(out[2 * 64 * 64]! - ((0 - 0.406) / 0.225)) < 0.0001);
});

test('rankPhotoCellsForTarget prefers target score and keeps 1-indexed cells', () => {
  const ranked = rankPhotoCellsForTarget('plane_d', [
    { row: 1, col: 1, label: 'car_r', score: 0.9, targetScore: 0.1 },
    { row: 1, col: 2, label: 'plane_d', score: 0.7, targetScore: 0.7 },
    { row: 3, col: 3, label: 'plane_d', score: 0.5, targetScore: 0.8 },
  ], 2);
  assert.deepEqual(ranked, [[3, 3], [1, 2]]);
});

test('normalizeNineMatchPairForImageNet composites transparent prompt pixels over white', () => {
  const ques = new Uint8Array(64 * 64 * 4);
  const center = (32 * 64 + 32) * 4;
  ques[center] = 0;
  ques[center + 1] = 0;
  ques[center + 2] = 0;
  ques[center + 3] = 255;

  const cell = new Uint8Array(64 * 64 * 4);
  for (let i = 0; i < cell.length; i += 4) {
    cell[i] = 255;
    cell[i + 1] = 255;
    cell[i + 2] = 255;
    cell[i + 3] = 255;
  }

  const out = normalizeNineMatchPairForImageNet(ques, 64, 64, cell, 64, 64);
  assert.equal(out.length, 3 * 64 * 128);
  assert.ok(Math.abs(out[0]! - ((1 - 0.485) / 0.229)) < 0.0001);
  assert.ok(Math.abs(out[32 * 128 + 32]! - ((0 - 0.485) / 0.229)) < 0.0001);
  assert.ok(Math.abs(out[64]! - ((1 - 0.485) / 0.229)) < 0.0001);
});

test('findIconCellsPhoto ranks cells with the nine-match pair scorer', async () => {
  const grid = solidPng(9, 9, [255, 255, 255, 255]);
  const ques = solidPng(3, 3, [0, 0, 0, 255]);
  const scores = new Map([
    ['1,1', 0.1],
    ['1,2', 0.8],
    ['1,3', 0.2],
    ['2,1', 0.7],
    ['2,2', 0.3],
    ['2,3', 0.9],
    ['3,1', 0.4],
    ['3,2', 0.6],
    ['3,3', 0.5],
  ]);

  const cells = await findIconCellsPhoto(grid, ques, 3, {
    async score(_ques, cell) {
      return scores.get(`${cell.row},${cell.col}`) ?? 0;
    },
  });

  assert.deepEqual(cells, [[2, 3], [1, 2], [2, 1]]);
});

test('findIconCellsPhoto uses one batched scorer call when available', async () => {
  const grid = solidPng(9, 9, [255, 255, 255, 255]);
  const ques = solidPng(3, 3, [0, 0, 0, 255]);
  let singleCalls = 0;
  let batchCalls = 0;

  const cells = await findIconCellsPhoto(grid, ques, 2, {
    async score() {
      singleCalls += 1;
      return 0;
    },
    async scoreCells(_ques, batch) {
      batchCalls += 1;
      return batch.map((cell) => (cell.row === 3 && cell.col === 1 ? 1 : cell.row === 1 && cell.col === 3 ? 0.9 : 0.1));
    },
  });

  assert.equal(batchCalls, 1);
  assert.equal(singleCalls, 0);
  assert.deepEqual(cells, [[3, 1], [1, 3]]);
});

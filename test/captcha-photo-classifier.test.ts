import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhotoRgbForImageNet } from '../src/main/services/captcha/onnx-session.js';
import { rankPhotoCellsForTarget } from '../src/main/services/captcha/solvers/nine-photo.js';

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

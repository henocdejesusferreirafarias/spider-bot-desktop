import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePair } from '../scripts/captcha-label-suggestions.mjs';

const WIDTH = 128;
const HEIGHT = 64;
const MEAN_R = 0.485;
const STD_R = 0.229;

function normalizedRed(value: number): number {
  return (value / 255 - MEAN_R) / STD_R;
}

function channelAt(arr: Float32Array, ch: number, row: number, col: number): number {
  return arr[ch * WIDTH * HEIGHT + row * WIDTH + col] ?? Number.NaN;
}

test('normalizePair composites transparent prompt pixels over white before model input', () => {
  const prompt = {
    width: 64,
    height: 64,
    data: new Uint8Array(64 * 64 * 4),
  };
  prompt.data.fill(0);
  for (let i = 3; i < prompt.data.length; i += 4) prompt.data[i] = 0;

  const opaqueBlack = (32 * 64 + 32) * 4;
  prompt.data[opaqueBlack] = 0;
  prompt.data[opaqueBlack + 1] = 0;
  prompt.data[opaqueBlack + 2] = 0;
  prompt.data[opaqueBlack + 3] = 255;

  const cell = {
    width: 64,
    height: 64,
    data: new Uint8Array(64 * 64 * 4),
  };
  for (let i = 0; i < cell.data.length; i += 4) {
    cell.data[i] = 255;
    cell.data[i + 1] = 255;
    cell.data[i + 2] = 255;
    cell.data[i + 3] = 255;
  }

  const arr = normalizePair(prompt, cell);

  assert.equal(arr.length, 3 * WIDTH * HEIGHT);
  assert.ok(Math.abs(channelAt(arr, 0, 0, 0) - normalizedRed(255)) < 0.0001);
  assert.ok(Math.abs(channelAt(arr, 0, 32, 32) - normalizedRed(0)) < 0.0001);
  assert.ok(Math.abs(channelAt(arr, 0, 0, 64) - normalizedRed(255)) < 0.0001);
});

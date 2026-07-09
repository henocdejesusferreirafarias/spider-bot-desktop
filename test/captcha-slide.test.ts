import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findPuzzlePiecePosition } from '../src/main/services/captcha/solvers/slide.js';

test('findPuzzlePiecePosition = 81 (fixture, oráculo Python)', () => {
  const bg = readFileSync('test/fixtures/captcha/slide/bg.png');
  const pc = readFileSync('test/fixtures/captcha/slide/slice.png');
  const pos = findPuzzlePiecePosition(pc, bg);
  assert.ok(Math.abs(pos - 81) <= 3, `esperado ~81, obtido ${pos}`);
});

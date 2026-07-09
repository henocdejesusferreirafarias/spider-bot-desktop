import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodePng, toGray, matchTemplate, minMaxLoc } from '../src/main/services/captcha/image-utils.js';

test('decodePng decodifica bg.png para Mat 300x200', () => {
  const buf = readFileSync('test/fixtures/captcha/slide/bg.png');
  const m = decodePng(buf);
  assert.equal(m.cols, 300);
  assert.equal(m.rows, 200);
});

test('matchTemplate + minMaxLoc acham a peça', () => {
  const bg = decodePng(readFileSync('test/fixtures/captcha/slide/bg.png'));
  const pc = decodePng(readFileSync('test/fixtures/captcha/slide/slice.png'));
  const gbg = toGray(bg);
  const gpc = toGray(pc);
  const res = matchTemplate(gbg, gpc, 'TM_CCOEFF_NORMED');
  const mm = minMaxLoc(res);
  assert.ok(mm.maxVal > 0.3, `maxVal esperado >0.3, obtido ${mm.maxVal}`);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGcaptchaJs } from '../src/main/services/captcha/deobfuscate.js';

const sample = readFileSync('test/fixtures/captcha/gcaptcha4.sample.js', 'utf8');
const expected = JSON.parse(readFileSync('test/fixtures/captcha/deobfuscate.expected.json', 'utf8'));

test('parseGcaptchaJs extrai abo/mappings/deviceId do snapshot', () => {
  const got = parseGcaptchaJs(sample);
  assert.deepEqual(got, expected);
});

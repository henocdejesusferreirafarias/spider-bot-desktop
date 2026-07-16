import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('nine match trainer self-test covers pair and siamese model contracts', { timeout: 120_000 }, () => {
  const result = spawnSync('python', ['scripts/captcha-train-nine-match.py', '--self-test'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /arch=pair logit_shape=\(2, 1\)/);
  assert.match(result.stdout, /arch=siamese logit_shape=\(2, 1\)/);
  assert.match(result.stdout, /onnx_export=ok arch=siamese/);
  assert.match(result.stdout, /onnx_parity=ok arch=siamese/);
  assert.match(result.stdout, /prompt_alpha_composite=ok/);
  assert.match(result.stdout, /self_test=ok/);
});

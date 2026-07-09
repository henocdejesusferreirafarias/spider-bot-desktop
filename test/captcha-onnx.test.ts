import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import { getClassifier } from '../src/main/services/captcha/onnx-session.js';
import { decodeImage } from '../src/main/services/captcha/image-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = join(__dirname, '..', 'assets', 'captcha', 'geetest_v4_icon.onnx');

test('IconClassifier classifica o ques fixture no label esperado (oracle ddddocr)', async () => {
  const expected = JSON.parse(readFileSync('test/fixtures/captcha/nine/ques.expected.json','utf8')).label;
  const { data, width, height } = decodeImage(readFileSync('test/fixtures/captcha/nine/ques.png'));
  const { label } = await getClassifier().classify(data, width, height);
  assert.equal(label, expected, `esperado ${expected}, obtido ${label}`);
});

test('o output do ONNX é escalar [1] (confiança da classe predita, não 40 logits)', async () => {
  const sess = await ort.InferenceSession.create(MODEL_PATH);
  const inputName = sess.inputNames[0];
  if (!inputName) throw new Error('modelo não expõe entrada');
  const t = new ort.Tensor('float32', new Float32Array(64 * 64), [1, 1, 64, 64]);
  const out = await sess.run({ [inputName]: t });
  assert.ok(out['output'], 'modelo deve expor saída "output"');
  assert.ok(out['63'], 'modelo deve expor saída "63" (argmax)');
  assert.equal((out['output'] as ort.Tensor).data.length, 1, 'output deve ser escalar [1]');
  assert.equal((out['63'] as ort.Tensor).data.length, 1, '63 (argmax) deve ser escalar [1]');
});

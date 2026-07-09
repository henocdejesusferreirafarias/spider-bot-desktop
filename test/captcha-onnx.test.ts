import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getClassifier } from '../src/main/services/captcha/onnx-session.js';
import { decodeImage } from '../src/main/services/captcha/image-utils.js';

test('IconClassifier classifica o ques fixture no label esperado (oracle ddddocr)', async () => {
  const expected = JSON.parse(readFileSync('test/fixtures/captcha/nine/ques.expected.json','utf8')).label;
  const { data, width, height } = decodeImage(readFileSync('test/fixtures/captcha/nine/ques.png'));
  const { label } = await getClassifier().classify(data, width, height);
  assert.equal(label, expected, `esperado ${expected}, obtido ${label}`);
});

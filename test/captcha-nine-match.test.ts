import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import type { InferenceSession } from 'onnxruntime-node';
import { PNG } from 'pngjs';
import { NineMatchClassifier, NineMatchInferenceQueue, normalizeNineMatchPairForImageNet } from '../src/main/services/captcha/onnx-session.js';
import { findNineMatchCells } from '../src/main/services/captcha/solvers/nine-match.js';

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

test('NineMatchInferenceQueue limits concurrent inference work', async () => {
  const queue = new NineMatchInferenceQueue(1);
  let active = 0;
  let maxActive = 0;
  const releaseResolvers: Array<() => void> = [];
  const waitForStarted = async (count: number): Promise<void> => {
    for (let i = 0; i < 20 && releaseResolvers.length < count; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };

  const jobs = [1, 2, 3].map((value) => queue.run(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => releaseResolvers.push(resolve));
    active -= 1;
    return value * 10;
  }));

  await waitForStarted(1);
  assert.equal(active, 1);
  assert.equal(releaseResolvers.length, 1);
  releaseResolvers.shift()?.();

  await waitForStarted(1);
  assert.equal(active, 1);
  releaseResolvers.shift()?.();

  await waitForStarted(1);
  assert.equal(active, 1);
  releaseResolvers.shift()?.();

  assert.deepEqual(await Promise.all(jobs), [10, 20, 30]);
  assert.equal(maxActive, 1);
});

function fakeNineSession(): InferenceSession {
  return {
    async run() {
      return { logit: { data: new Float32Array([0]) } };
    },
  } as unknown as InferenceSession;
}

test('NineMatchClassifier shares initialization between warm-up and first inference', async () => {
  let createCalls = 0;
  let release: ((session: InferenceSession) => void) | undefined;
  const pendingSession = new Promise<InferenceSession>((resolve) => {
    release = resolve;
  });
  const classifier = new NineMatchClassifier(async () => {
    createCalls += 1;
    return pendingSession;
  });
  const image = { data: new Uint8Array(4), width: 1, height: 1 };

  const warming = classifier.warmup();
  const scoring = classifier.scoreCells(image, [image]);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.equal(createCalls, 1);
  release?.(fakeNineSession());
  await warming;
  assert.deepEqual(await scoring, [0.5]);
});

test('NineMatchClassifier retries initialization after warm-up failure', async () => {
  let createCalls = 0;
  const classifier = new NineMatchClassifier(async () => {
    createCalls += 1;
    if (createCalls === 1) throw new Error('warm-up failed');
    return fakeNineSession();
  });

  await assert.rejects(classifier.warmup(), /warm-up failed/);
  await classifier.warmup();

  assert.equal(createCalls, 2);
});

test('findNineMatchCells ranks cells with the nine-match pair scorer', async () => {
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

  const cells = await findNineMatchCells(grid, ques, 3, {
    async score(_ques, cell) {
      return scores.get(`${cell.row},${cell.col}`) ?? 0;
    },
  });

  assert.deepEqual(cells, [[2, 3], [1, 2], [2, 1]]);
});

test('findNineMatchCells uses one batched scorer call when available', async () => {
  const grid = solidPng(9, 9, [255, 255, 255, 255]);
  const ques = solidPng(3, 3, [0, 0, 0, 255]);
  let singleCalls = 0;
  let batchCalls = 0;

  const cells = await findNineMatchCells(grid, ques, 2, {
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

test('committed nine-match ONNX exposes the runtime tensor contract', async () => {
  const modelPath = join(process.cwd(), 'assets', 'captcha', 'nine_match.onnx');
  const session = await ort.InferenceSession.create(modelPath);
  assert.deepEqual(session.inputNames, ['input']);
  assert.deepEqual(session.outputNames, ['logit']);

  const input = new ort.Tensor(
    'float32',
    new Float32Array(2 * 3 * 64 * 128),
    [2, 3, 64, 128],
  );
  const output = await session.run({ input });
  assert.equal(output.logit?.data.length, 2);
  for (const value of output.logit?.data ?? []) {
    assert.equal(Number.isFinite(Number(value)), true);
  }

  const prompt = { data: new Uint8Array(64 * 64 * 4), width: 64, height: 64 };
  const cell = { data: new Uint8Array(64 * 64 * 4).fill(255), width: 64, height: 64 };
  const scores = await new NineMatchClassifier().scoreCells(prompt, [cell, cell]);
  assert.equal(scores.length, 2);
  assert.equal(scores.every((score) => Number.isFinite(score) && score >= 0 && score <= 1), true);
});

test('committed nine-match metadata describes the accepted training run', () => {
  const metadata = JSON.parse(
    readFileSync(
      join(process.cwd(), 'assets', 'captcha', 'nine_match.json'),
      'utf8',
    ),
  ) as {
    kind: string;
    input: { width: number; height: number; channels: number; layout: string };
    training: {
      samples: number;
      heldoutBinary: number;
      heldoutChallengeTopk: number;
    };
  };
  assert.equal(metadata.kind, 'nine_match_pair_binary');
  assert.deepEqual(
    [metadata.input.width, metadata.input.height, metadata.input.channels],
    [128, 64, 3],
  );
  assert.equal(
    metadata.input.layout,
    'prompt_64x64_left_cell_64x64_right',
  );
  assert.equal(metadata.training.samples, 4500);
  assert.ok(metadata.training.heldoutBinary >= 0.97);
  assert.ok(metadata.training.heldoutChallengeTopk >= 0.92);
});

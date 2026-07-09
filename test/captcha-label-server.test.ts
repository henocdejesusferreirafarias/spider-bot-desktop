import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { startLabelServer } from '../scripts/captcha-label-server.mjs';

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'captcha-label-server-'));
  const raw = join(dir, 'raw');
  const dataset = join(dir, 'dataset');
  mkdirSync(raw, { recursive: true });
  mkdirSync(dataset, { recursive: true });

  for (let i = 0; i < 2; i++) {
    const id = `00000${i}-test`;
    const cdir = join(raw, id);
    mkdirSync(cdir, { recursive: true });
    const image = new PNG({ width: 6, height: 6 });
    image.data.fill(255);
    const png = PNG.sync.write(image);
    writeFileSync(join(cdir, 'grid.jpg'), png);
    writeFileSync(join(cdir, 'ques.png'), png);
    writeFileSync(join(cdir, 'meta.json'), JSON.stringify({
      id,
      captchaId: 'cap',
      lotNumber: 'lot',
      nineNums: 2,
      gridPath: 'g',
      quesPath: 'q',
    }));
  }
  return { raw, dataset };
}

test('GET /api/challenge returns the first challenge with 9 cells', async () => {
  const fx = makeFixture();
  const srv = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/challenge`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.challengeId);
    assert.equal(body.nineNums, 2);
    assert.equal(body.cells.length, 9);
    assert.ok(body.cells[0].dataUrl.startsWith('data:image/'));
    assert.ok(body.quesDataUrl.startsWith('data:image/'));
  } finally {
    await srv.close();
  }
});

test('POST /api/label with valid cells writes JSONL and updates stats', async () => {
  const fx = makeFixture();
  const srv = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  try {
    await (await fetch(`http://127.0.0.1:${srv.port}/api/challenge`)).json();
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/label`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ round: 1, cells: [[1, 1], [2, 2]] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.saved, true);
    assert.equal(body.stats.labeledRounds, 1);
    const jsonl = readFileSync(join(fx.dataset, 'manual-labels.jsonl'), 'utf8');
    assert.match(jsonl, /"kind":"round"/);
    assert.match(jsonl, /"round":1/);
  } finally {
    await srv.close();
  }
});

test('POST /api/label with wrong cell count returns 400', async () => {
  const fx = makeFixture();
  const srv = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  try {
    await fetch(`http://127.0.0.1:${srv.port}/api/challenge`);
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/label`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ round: 1, cells: [[1, 1]] }),
    });
    assert.equal(res.status, 400);
  } finally {
    await srv.close();
  }
});

test('GET /api/stats reflects writes', async () => {
  const fx = makeFixture();
  const srv = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  try {
    await fetch(`http://127.0.0.1:${srv.port}/api/challenge`);
    await fetch(`http://127.0.0.1:${srv.port}/api/label`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ round: 1, cells: [[1, 1], [2, 2]] }),
    });
    const stats = await (await fetch(`http://127.0.0.1:${srv.port}/api/stats`)).json();
    assert.equal(stats.labeledRounds, 1);
    assert.equal(stats.totalChallenges, 2);
  } finally {
    await srv.close();
  }
});

test('GET / returns the HTML page', async () => {
  const fx = makeFixture();
  const srv = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Plan 2d/);
    assert.match(html, /class="grid"/);
  } finally {
    await srv.close();
  }
});

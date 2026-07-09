import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { startLabelServer } from '../scripts/captcha-label-server.mjs';

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'captcha-label-recovery-'));
  const raw = join(dir, 'raw');
  const dataset = join(dir, 'dataset');
  mkdirSync(raw, { recursive: true });
  mkdirSync(dataset, { recursive: true });
  const image = new PNG({ width: 6, height: 6 });
  image.data.fill(255);
  const png = PNG.sync.write(image);
  for (let i = 0; i < 3; i++) {
    const id = `00000${i}-recov`;
    const cdir = join(raw, id);
    mkdirSync(cdir, { recursive: true });
    writeFileSync(join(cdir, 'grid.jpg'), png);
    writeFileSync(join(cdir, 'ques.png'), png);
    writeFileSync(join(cdir, 'meta.json'), JSON.stringify({
      id, captchaId: 'c', lotNumber: 'l', nineNums: 2, gridPath: 'g', quesPath: 'q',
    }));
  }
  return { raw, dataset };
}

test('restarting the server resumes after the last labeled round', async () => {
  const fx = makeFixture();
  const a = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  try {
    for (let i = 0; i < 3; i++) {
      const ch = await (await fetch(`http://127.0.0.1:${a.port}/api/challenge`)).json();
      const res = await fetch(`http://127.0.0.1:${a.port}/api/label`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ round: ch.round, cells: [[1, 1], [2, 2]] }),
      });
      assert.equal(res.status, 200);
    }
    const stats = await (await fetch(`http://127.0.0.1:${a.port}/api/stats`)).json();
    assert.equal(stats.labeledRounds, 3);
    const expectedNext = await (await fetch(`http://127.0.0.1:${a.port}/api/challenge`)).json();
    assert.equal(expectedNext.challengeId, '000001-recov');
    assert.equal(expectedNext.round, 2);
  } finally {
    await a.close();
  }

  const b = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  try {
    const ch = await (await fetch(`http://127.0.0.1:${b.port}/api/challenge`)).json();
    assert.equal(ch.challengeId, '000001-recov');
    assert.equal(ch.round, 2);
    const stats = await (await fetch(`http://127.0.0.1:${b.port}/api/stats`)).json();
    assert.equal(stats.labeledRounds, 3);
    assert.equal(stats.remainingRounds, 3);
    const jsonl = readFileSync(join(fx.dataset, 'manual-labels.jsonl'), 'utf8');
    assert.equal(jsonl.split('\n').filter(Boolean).length, 4);
  } finally {
    await b.close();
  }
});

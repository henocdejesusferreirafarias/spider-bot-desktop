import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  let expectedResumePointer;
  try {
    const first = await (await fetch(`http://127.0.0.1:${a.port}/api/challenge`)).json();
    assert.ok(first.challengeId);
    const firstLabel = await fetch(`http://127.0.0.1:${a.port}/api/label`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: first.challengeId, round: first.round, cells: [[1, 1], [2, 2]] }),
    });
    assert.equal(firstLabel.status, 200);

    const second = await (await fetch(`http://127.0.0.1:${a.port}/api/challenge`)).json();
    assert.ok(second.challengeId);
    expectedResumePointer = {
      challengeId: second.challengeId,
      round: second.round,
    };

    const stats = await (await fetch(`http://127.0.0.1:${a.port}/api/stats`)).json();
    assert.equal(stats.labeledRounds, 1);
    assert.equal(stats.remainingRounds, 5);
  } finally {
    await a.close();
  }

  const b = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  try {
    const ch = await (await fetch(`http://127.0.0.1:${b.port}/api/challenge`)).json();
    assert.deepEqual(
      { challengeId: ch.challengeId, round: ch.round },
      expectedResumePointer,
    );
    const stats = await (await fetch(`http://127.0.0.1:${b.port}/api/stats`)).json();
    assert.equal(stats.labeledRounds, 1);
    assert.equal(stats.remainingRounds, 5);
  } finally {
    await b.close();
  }
});

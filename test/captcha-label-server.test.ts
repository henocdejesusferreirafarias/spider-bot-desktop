import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { startLabelServer } from '../scripts/captcha-label-server.mjs';

function makeFixture(challengeCount = 2) {
  const dir = mkdtempSync(join(tmpdir(), 'captcha-label-server-'));
  const raw = join(dir, 'raw');
  const dataset = join(dir, 'dataset');
  mkdirSync(raw, { recursive: true });
  mkdirSync(dataset, { recursive: true });

  for (let i = 0; i < challengeCount; i++) {
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

async function currentChallenge(port: number) {
  return (await (await fetch(`http://127.0.0.1:${port}/api/challenge`)).json()) as {
    challengeId: string;
    round: 1 | 2;
    done?: boolean;
  };
}

async function saveLabel(port: number, round: number, cells: number[][]) {
  return fetch(`http://127.0.0.1:${port}/api/label`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ round, cells }),
  });
}

function auditEntries(dataset: string) {
  const file = join(dataset, 'manual-labels.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function strictAuditEntries(dataset: string) {
  const file = join(dataset, 'manual-labels.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function expireStateLock(dataset: string) {
  const expired = new Date(Date.now() - 10_000);
  utimesSync(join(dataset, 'label-state.json'), expired, expired);
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

test('restart rehydrates unresolved disputes without emitting a duplicate final', async () => {
  const fx = makeFixture(1);
  let srv = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  try {
    const round1 = await currentChallenge(srv.port);
    assert.equal(round1.done, undefined);
    assert.equal((await saveLabel(srv.port, round1.round, [[1, 1], [1, 2]])).status, 200);
    const round2 = await currentChallenge(srv.port);
    assert.equal(round2.challengeId, round1.challengeId);
    assert.notEqual(round2.round, round1.round);
    assert.equal((await saveLabel(srv.port, round2.round, [[2, 1], [2, 2]])).status, 200);
  } finally {
    await srv.close();
  }

  expireStateLock(fx.dataset);
  srv = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  try {
    const disputes = await (await fetch(`http://127.0.0.1:${srv.port}/api/disputes`)).json();
    assert.equal(disputes.length, 1);
    assert.equal(disputes[0].challengeId, '000000-test');
    assert.deepEqual(await currentChallenge(srv.port), { done: true });
    assert.equal(auditEntries(fx.dataset).filter((entry) => entry.kind === 'final').length, 0);

    const resolved = await fetch(`http://127.0.0.1:${srv.port}/api/disputes/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: '000000-test', choice: 'round1' }),
    });
    assert.equal(resolved.status, 200);
  } finally {
    await srv.close();
  }

  expireStateLock(fx.dataset);
  srv = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  try {
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${srv.port}/api/disputes`)).json(), []);
    assert.equal(auditEntries(fx.dataset).filter((entry) => entry.kind === 'final').length, 1);
  } finally {
    await srv.close();
  }
});

test('restart rehydrates skipped rounds and does not create a final from the remaining round', async () => {
  const fx = makeFixture(1);
  let srv = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  let skipped;
  try {
    skipped = await currentChallenge(srv.port);
    const response = await fetch(`http://127.0.0.1:${srv.port}/api/skip`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ round: skipped.round }),
    });
    assert.equal(response.status, 200);
  } finally {
    await srv.close();
  }

  expireStateLock(fx.dataset);
  srv = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  try {
    const remaining = await currentChallenge(srv.port);
    assert.equal(remaining.challengeId, skipped?.challengeId);
    assert.notEqual(remaining.round, skipped?.round);
    assert.equal((await saveLabel(srv.port, remaining.round, [[1, 1], [2, 2]])).status, 200);
    assert.deepEqual(await currentChallenge(srv.port), { done: true });
    assert.equal(auditEntries(fx.dataset).filter((entry) => entry.kind === 'final').length, 0);
  } finally {
    await srv.close();
  }
});

test('restart repairs exactly one missing automatic final for matching completed rounds', async () => {
  const fx = makeFixture(1);
  const labelsFile = join(fx.dataset, 'manual-labels.jsonl');
  const cells = [[1, 1], [2, 2]];
  writeFileSync(labelsFile, [
    JSON.stringify({ kind: 'round', challengeId: '000000-test', round: 1, cells }),
    JSON.stringify({ kind: 'round', challengeId: '000000-test', round: 2, cells }),
    '',
  ].join('\n'));

  let srv = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  try {
    assert.deepEqual(await currentChallenge(srv.port), { done: true });
    const finals = auditEntries(fx.dataset).filter((entry) => entry.kind === 'final');
    assert.equal(finals.length, 1);
    assert.deepEqual(finals[0].cells, cells);
    assert.equal(finals[0].fromDispute, false);
  } finally {
    await srv.close();
  }

  srv = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  try {
    assert.equal(auditEntries(fx.dataset).filter((entry) => entry.kind === 'final').length, 1);
  } finally {
    await srv.close();
  }
});

test('restart removes a truncated trailing record before repairing exactly one final', async () => {
  const fx = makeFixture(1);
  const labelsFile = join(fx.dataset, 'manual-labels.jsonl');
  const cells = [[1, 1], [2, 2]];
  const truncatedFinal = '{"kind":"final"';
  writeFileSync(labelsFile, [
    JSON.stringify({ kind: 'round', challengeId: '000000-test', round: 1, cells }),
    JSON.stringify({ kind: 'round', challengeId: '000000-test', round: 2, cells }),
    truncatedFinal,
  ].join('\n'));

  let srv = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  try {
    const entries = strictAuditEntries(fx.dataset);
    const finals = entries.filter((entry) => entry.kind === 'final');
    assert.equal(finals.length, 1);
    assert.deepEqual(finals[0].cells, cells);
    assert.equal(readFileSync(labelsFile, 'utf8').includes(`${truncatedFinal}\n`), false);
  } finally {
    await srv.close();
  }

  srv = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  try {
    assert.equal(strictAuditEntries(fx.dataset).filter((entry) => entry.kind === 'final').length, 1);
  } finally {
    await srv.close();
  }
});

test('startup recovery retries on a later request after an active state reservation expires', async () => {
  const fx = makeFixture(1);
  const labelsFile = join(fx.dataset, 'manual-labels.jsonl');
  const cells = [[1, 1], [2, 2]];
  writeFileSync(labelsFile, [
    JSON.stringify({ kind: 'round', challengeId: '000000-test', round: 1, cells }),
    JSON.stringify({ kind: 'round', challengeId: '000000-test', round: 2, cells }),
    '',
  ].join('\n'));
  writeFileSync(join(fx.dataset, 'label-state.json'), JSON.stringify({ otherWriter: true }));

  let srv = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  try {
    assert.equal(auditEntries(fx.dataset).filter((entry) => entry.kind === 'final').length, 0);
    expireStateLock(fx.dataset);
    assert.equal((await fetch(`http://127.0.0.1:${srv.port}/api/stats`)).status, 200);
    assert.equal(strictAuditEntries(fx.dataset).filter((entry) => entry.kind === 'final').length, 1);
  } finally {
    await srv.close();
  }
});

test('GET /disputes provides an operator view with dispute resolution controls', async () => {
  const fx = makeFixture(1);
  const srv = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  try {
    const round1 = await currentChallenge(srv.port);
    assert.equal((await saveLabel(srv.port, round1.round, [[1, 1], [1, 2]])).status, 200);
    const round2 = await currentChallenge(srv.port);
    assert.equal((await saveLabel(srv.port, round2.round, [[2, 1], [2, 2]])).status, 200);

    const response = await fetch(`http://127.0.0.1:${srv.port}/disputes`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Disputas pendentes/);
    assert.match(html, /\/api\/disputes/);
    assert.match(html, /\/api\/disputes\/resolve/);
    assert.match(html, /round1/);
    assert.match(html, /round2/);
    assert.match(html, /relabel/);

    const completedPage = await (await fetch(`http://127.0.0.1:${srv.port}/`)).text();
    assert.match(completedPage, /href="\/disputes"/);
  } finally {
    await srv.close();
  }
});

test('second server rejects its first write during another server lock window', async () => {
  const fx = makeFixture(1);
  const first = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  let second;
  try {
    const firstChallenge = await currentChallenge(first.port);
    assert.equal((await saveLabel(first.port, firstChallenge.round, [[1, 1], [2, 2]])).status, 200);

    second = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
    const secondChallenge = await currentChallenge(second.port);
    const response = await saveLabel(second.port, secondChallenge.round, [[1, 1], [2, 2]]);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { saved: false, error: 'state file is locked by another writer' });
    assert.equal(auditEntries(fx.dataset).filter((entry) => entry.kind === 'round').length, 1);
  } finally {
    if (second) await second.close();
    await first.close();
  }
});

test('state lock conflicts reject labels before writing the audit or queue state', async () => {
  const fx = makeFixture(1);
  const srv = await startLabelServer({ port: 0, rawDir: fx.raw, datasetDir: fx.dataset });
  try {
    const challenge = await currentChallenge(srv.port);
    writeFileSync(join(fx.dataset, 'label-state.json'), JSON.stringify({ otherWriter: true }));

    const response = await saveLabel(srv.port, challenge.round, [[1, 1], [2, 2]]);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { saved: false, error: 'state file is locked by another writer' });
    assert.equal(existsSync(join(fx.dataset, 'manual-labels.jsonl')), false);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${srv.port}/api/stats`)).json(), {
      totalChallenges: 1,
      labeledRounds: 0,
      remainingRounds: 2,
      disputeCount: 0,
      skippedRounds: 0,
    });
    assert.deepEqual(await currentChallenge(srv.port), challenge);
  } finally {
    await srv.close();
  }
});

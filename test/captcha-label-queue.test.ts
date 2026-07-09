import test from 'node:test';
import assert from 'node:assert/strict';
import { LabelingQueue } from '../scripts/captcha-label-queue.mjs';

test('queue is deterministic for the same seed', () => {
  const a = new LabelingQueue(['c1', 'c2', 'c3'], 42);
  const b = new LabelingQueue(['c1', 'c2', 'c3'], 42);
  const orderA = [];
  const orderB = [];
  let p = a.next();
  while (p) {
    orderA.push(`${p.challengeId}:${p.round}`);
    p = a.next();
  }
  p = b.next();
  while (p) {
    orderB.push(`${p.challengeId}:${p.round}`);
    p = b.next();
  }
  assert.deepEqual(orderA, orderB);
  assert.equal(orderA.length, 6);
});

test('each challenge appears exactly twice', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const q = new LabelingQueue(ids, 7);
  const seen = new Map();
  let p = q.next();
  while (p) {
    seen.set(p.challengeId, (seen.get(p.challengeId) ?? 0) + 1);
    q.recordSkip(p.challengeId, p.round);
    p = q.next();
  }
  for (const id of ids) assert.equal(seen.get(id), 2, `${id} should appear twice`);
  assert.equal(q.getStats().skippedRounds, 10);
});

test('recordLabel marks a round labeled and does not mark dispute when rounds match', () => {
  const q = new LabelingQueue(['x'], 1);
  q.recordLabel('x', 1, [[1, 1], [2, 2], [3, 3]]);
  assert.equal(q.getStats().labeledRounds, 1);
  assert.equal(q.getStats().disputeCount, 0);
  q.recordLabel('x', 2, [[1, 1], [2, 2], [3, 3]]);
  assert.equal(q.getStats().labeledRounds, 2);
  assert.equal(q.getStats().disputeCount, 0);
});

test('disagreement between rounds creates a dispute', () => {
  const q = new LabelingQueue(['y'], 1);
  q.recordLabel('y', 1, [[1, 1], [2, 2], [3, 3]]);
  const result = q.recordLabel('y', 2, [[1, 2], [2, 1], [3, 3]]);
  assert.equal(result.isNewDispute, true);
  assert.equal(result.bothRoundsNowLabeled, true);
  assert.equal(q.getStats().disputeCount, 1);
  assert.deepEqual(q.getDisputes()[0]?.round1Cells, [[1, 1], [2, 2], [3, 3]]);
  assert.deepEqual(q.getDisputes()[0]?.round2Cells, [[1, 2], [2, 1], [3, 3]]);
});

test('resolveDispute accepts round1 and synchronizes both stored rounds', () => {
  const q = new LabelingQueue(['z'], 1);
  const round1Cells = [[1, 1]];
  const round2Cells = [[2, 2]];
  q.recordLabel('z', 1, round1Cells);
  q.recordLabel('z', 2, round2Cells);
  assert.equal(q.getStats().disputeCount, 1);
  q.resolveDispute('z', 'round1');
  assert.equal(q.getStats().disputeCount, 0);
  const result = q.recordLabel('z', 2, round2Cells);
  assert.equal(result.isNewDispute, true);
  assert.equal(q.getStats().disputeCount, 1);
});

test('resolveDispute accepts round2 and synchronizes both stored rounds', () => {
  const q = new LabelingQueue(['z'], 1);
  const round1Cells = [[1, 1]];
  const round2Cells = [[2, 2]];
  q.recordLabel('z', 1, round1Cells);
  q.recordLabel('z', 2, round2Cells);
  assert.equal(q.getStats().disputeCount, 1);
  q.resolveDispute('z', 'round2');
  assert.equal(q.getStats().disputeCount, 0);
  const result = q.recordLabel('z', 1, round1Cells);
  assert.equal(result.isNewDispute, true);
  assert.equal(q.getStats().disputeCount, 1);
});

test('loadLabeledKeys restores progress so next() resumes after the last labeled index', () => {
  const q = new LabelingQueue(['m', 'n'], 99);
  const first = q.next();
  assert.ok(first);
  q.recordLabel(first.challengeId, first.round, [[1, 1]]);
  const second = q.next();
  assert.ok(second);
  q.recordLabel(second.challengeId, second.round, [[1, 2]]);
  const third = q.next();
  assert.ok(third);
  q.recordLabel(third.challengeId, third.round, [[1, 3]]);

  const q2 = new LabelingQueue(['m', 'n'], 99);
  q2.loadLabeledKeys([
    `${first.challengeId}:${first.round}`,
    `${second.challengeId}:${second.round}`,
    `${third.challengeId}:${third.round}`,
  ]);
  assert.equal(q2.getStats().labeledRounds, 3);
  assert.equal(q2.getStats().remainingRounds, 1);
  const remaining = q2.next();
  assert.ok(remaining);
  assert.notEqual(`${remaining.challengeId}:${remaining.round}`, `${third.challengeId}:${third.round}`);
});

test('getStats counts add up to total rounds', () => {
  const q = new LabelingQueue(['p', 'q'], 1);
  const stats = q.getStats();
  assert.equal(stats.totalChallenges, 2);
  assert.equal(stats.labeledRounds + stats.remainingRounds + stats.skippedRounds, 4);
});

test('recordSkip excludes a round from labeled keys and stats', () => {
  const q = new LabelingQueue(['s'], 1);
  const pointer = q.next();
  assert.ok(pointer);
  q.recordSkip(pointer.challengeId, pointer.round);
  assert.equal(q.getStats().skippedRounds, 1);
  assert.equal(q.getLabeledKeys().length, 0);
});

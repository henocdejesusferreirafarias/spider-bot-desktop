function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(values, rand) {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = values[i];
    values[i] = values[j];
    values[j] = tmp;
  }
  return values;
}

function cloneCells(cells) {
  return cells.map(([row, col]) => [row, col]);
}

function cellsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (!left || !right || left[0] !== right[0] || left[1] !== right[1]) {
      return false;
    }
  }
  return true;
}

export class LabelingQueue {
  constructor(challengeIds, seed = 20260710) {
    this.seed = seed;
    this.challengeCount = challengeIds.length;
    this.order = [];
    for (const challengeId of challengeIds) {
      this.order.push({ challengeId, round: 1 });
      this.order.push({ challengeId, round: 2 });
    }
    shuffleInPlace(this.order, mulberry32(seed));
    this.index = 0;
    this.labeledKeys = new Set();
    this.skippedKeys = new Set();
    this.rounds = new Map();
    this.disputes = new Map();
  }

  _key(challengeId, round) {
    return `${challengeId}:${round}`;
  }

  _isProcessed(key) {
    return this.labeledKeys.has(key) || this.skippedKeys.has(key);
  }

  _advanceIndex() {
    while (this.index < this.order.length) {
      const entry = this.order[this.index];
      if (!this._isProcessed(this._key(entry.challengeId, entry.round))) {
        break;
      }
      this.index++;
    }
  }

  _syncDispute(challengeId) {
    const r1 = this.rounds.get(this._key(challengeId, 1));
    const r2 = this.rounds.get(this._key(challengeId, 2));
    if (!r1 || !r2) {
      this.disputes.delete(challengeId);
      return;
    }
    if (cellsEqual(r1, r2)) {
      this.disputes.delete(challengeId);
      return;
    }
    this.disputes.set(challengeId, { round1Cells: cloneCells(r1), round2Cells: cloneCells(r2) });
  }

  next() {
    this._advanceIndex();
    if (this.index >= this.order.length) {
      return null;
    }
    const entry = this.order[this.index];
    this.index++;
    return {
      challengeId: entry.challengeId,
      round: entry.round,
      totalRounds: this.order.length,
      currentIndex: this.index,
    };
  }

  recordLabel(challengeId, round, cells) {
    const key = this._key(challengeId, round);
    const hadDispute = this.disputes.has(challengeId);
    this.labeledKeys.add(key);
    this.skippedKeys.delete(key);
    this.rounds.set(key, cloneCells(cells));
    this._syncDispute(challengeId);
    this._advanceIndex();
    return {
      isNewDispute: !hadDispute && this.disputes.has(challengeId),
      bothRoundsNowLabeled: this.labeledKeys.has(this._key(challengeId, 1)) && this.labeledKeys.has(this._key(challengeId, 2)),
    };
  }

  recordSkip(challengeId, round) {
    const key = this._key(challengeId, round);
    this.skippedKeys.add(key);
    this.labeledKeys.delete(key);
    this.rounds.delete(key);
    this._syncDispute(challengeId);
    this._advanceIndex();
  }

  getDisputes() {
    const disputes = [];
    const seen = new Set();
    for (const { challengeId } of this.order) {
      if (seen.has(challengeId)) continue;
      seen.add(challengeId);
      if (!this.disputes.has(challengeId)) continue;
      const dispute = this.disputes.get(challengeId);
      if (!dispute) continue;
      disputes.push({
        challengeId,
        round1Cells: cloneCells(dispute.round1Cells),
        round2Cells: cloneCells(dispute.round2Cells),
      });
    }
    return disputes;
  }

  resolveDispute(challengeId, choice, cells) {
    const dispute = this.disputes.get(challengeId);
    if (!dispute) {
      return;
    }
    if (choice === 'round1' || choice === 'round2') {
      const resolvedCells = choice === 'round1' ? dispute.round1Cells : dispute.round2Cells;
      const cloned = cloneCells(resolvedCells);
      this.rounds.set(this._key(challengeId, 1), cloned);
      this.rounds.set(this._key(challengeId, 2), cloneCells(cloned));
    } else if (choice === 'relabel') {
      if (!cells) {
        throw new TypeError('relabel requires cells');
      }
      const cloned = cloneCells(cells);
      this.rounds.set(this._key(challengeId, 1), cloned);
      this.rounds.set(this._key(challengeId, 2), cloneCells(cloned));
    }
    this.disputes.delete(challengeId);
    this._advanceIndex();
  }

  getLabeledKeys() {
    const keys = [];
    for (const { challengeId, round } of this.order) {
      const key = this._key(challengeId, round);
      if (this.labeledKeys.has(key)) {
        keys.push(key);
      }
    }
    return keys;
  }

  loadLabeledKeys(labeledKeys) {
    for (const key of labeledKeys) {
      if (typeof key !== 'string') continue;
      if (key.endsWith(':skipped')) {
        this.skippedKeys.add(key.slice(0, -':skipped'.length));
        continue;
      }
      const sep = key.lastIndexOf(':');
      if (sep <= 0) continue;
      const challengeId = key.slice(0, sep);
      const round = Number(key.slice(sep + 1));
      if (round !== 1 && round !== 2) continue;
      this.labeledKeys.add(this._key(challengeId, round));
    }
    this._advanceIndex();
  }

  getStats() {
    const labeledRounds = this.labeledKeys.size;
    const skippedRounds = this.skippedKeys.size;
    return {
      totalChallenges: this.challengeCount,
      labeledRounds,
      remainingRounds: this.order.length - labeledRounds - skippedRounds,
      disputeCount: this.disputes.size,
      skippedRounds,
    };
  }
}

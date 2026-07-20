import assert from "node:assert/strict";
import test from "node:test";
import { SnapshotPublicationDeferral } from "../src/main/services/snapshot-publication-deferral.js";

test("snapshot publication stays deferred until the last overlapping operation releases", () => {
  const deferral = new SnapshotPublicationDeferral<object>();
  const session = {};
  const releaseFirst = deferral.defer(session);
  const releaseSecond = deferral.defer(session);

  assert.equal(deferral.isDeferred(session), true);
  assert.equal(releaseFirst(), false);
  assert.equal(deferral.isDeferred(session), true);
  assert.equal(releaseSecond(), true);
  assert.equal(deferral.isDeferred(session), false);
});

test("snapshot publication release is idempotent", () => {
  const deferral = new SnapshotPublicationDeferral<object>();
  const session = {};
  const release = deferral.defer(session);

  assert.equal(release(), true);
  assert.equal(release(), false);
  assert.equal(deferral.isDeferred(session), false);
});

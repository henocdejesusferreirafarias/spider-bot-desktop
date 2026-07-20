import assert from "node:assert/strict";
import test from "node:test";
import type { ProfileDeletionResult } from "../src/shared/contracts.js";
import {
  describeProfileDeletionFailures,
  failedProfileIds
} from "../src/renderer/lib/profile-deletion.js";

const partialResult: ProfileDeletionResult = {
  total: 3,
  completed: 3,
  deleted: 2,
  failed: 1,
  items: [
    { profileId: "a", profileName: "Perfil A", status: "deleted" },
    { profileId: "b", profileName: "Perfil B", status: "failed", reason: "disco ocupado" },
    { profileId: "c", profileName: "Perfil C", status: "deleted" }
  ]
};

test("failed profile ids remain available for another attempt", () => {
  assert.deepEqual(failedProfileIds(partialResult), ["b"]);
});

test("partial deletion summary names failures and reports counts", () => {
  const summary = describeProfileDeletionFailures(partialResult);

  assert.match(summary, /2 perfis excluidos/);
  assert.match(summary, /1 perfil nao foi excluido/);
  assert.match(summary, /Perfil B: disco ocupado/);
});

test("successful deletion does not create a failure summary", () => {
  assert.equal(
    describeProfileDeletionFailures({
      total: 1,
      completed: 1,
      deleted: 1,
      failed: 0,
      items: [{ profileId: "a", profileName: "Perfil A", status: "deleted" }]
    }),
    undefined
  );
});

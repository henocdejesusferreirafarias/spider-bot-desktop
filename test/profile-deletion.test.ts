import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteProfilesWithConcurrency,
  getSingleProfileDeletionError,
  type ProfileDeletionProgress
} from "../src/main/services/profile-deletion.js";

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

test("bulk profile deletion limits concurrent work to two and preserves input order", async () => {
  let active = 0;
  let peak = 0;
  const progressEvents: ProfileDeletionProgress[] = [];

  const result = await deleteProfilesWithConcurrency(
    ["slow", "fast", "last"],
    {
      getProfileName: (profileId) => `Profile ${profileId}`,
      isProfileActive: () => false,
      stopProfile: async () => undefined,
      deleteProfile: async (profileId) => {
        active += 1;
        peak = Math.max(peak, active);
        await delay(profileId === "slow" ? 30 : 5);
        active -= 1;
      },
      onProgress: (progress) => progressEvents.push(progress)
    },
    2
  );

  assert.equal(peak, 2);
  assert.deepEqual(result.items.map((item) => item.profileId), ["slow", "fast", "last"]);
  assert.equal(result.deleted, 3);
  assert.equal(result.failed, 0);
  assert.deepEqual(progressEvents.at(-1), {
    total: 3,
    completed: 3,
    deleted: 3,
    failed: 0
  });
});

test("one failed profile does not abort the remaining deletions", async () => {
  const attempted: string[] = [];

  const result = await deleteProfilesWithConcurrency(
    ["a", "b", "c"],
    {
      getProfileName: (profileId) => `Profile ${profileId.toUpperCase()}`,
      isProfileActive: (profileId) => profileId === "a",
      stopProfile: async (profileId) => {
        assert.equal(profileId, "a");
      },
      deleteProfile: async (profileId) => {
        attempted.push(profileId);
        if (profileId === "b") throw new Error("disk busy");
      }
    },
    2
  );

  assert.deepEqual(attempted.sort(), ["a", "b", "c"]);
  assert.equal(result.deleted, 2);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.items[1], {
    profileId: "b",
    profileName: "Profile B",
    status: "failed",
    reason: "disk busy"
  });
});

test("duplicate ids run once and missing profiles become explicit failures", async () => {
  const attempted: string[] = [];

  const result = await deleteProfilesWithConcurrency(
    ["a", "a", "missing"],
    {
      getProfileName: (profileId) => profileId === "missing" ? undefined : "Profile A",
      isProfileActive: () => false,
      stopProfile: async () => undefined,
      deleteProfile: async (profileId) => {
        attempted.push(profileId);
      }
    }
  );

  assert.deepEqual(attempted, ["a"]);
  assert.equal(result.total, 2);
  assert.equal(result.deleted, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.items[1], {
    profileId: "missing",
    profileName: "missing",
    status: "failed",
    reason: "Perfil nao encontrado."
  });
});

test("profile lookup errors stay isolated to their item", async () => {
  const attempted: string[] = [];

  const result = await deleteProfilesWithConcurrency(
    ["broken", "healthy"],
    {
      getProfileName: (profileId) => {
        if (profileId === "broken") throw new Error("sqlite read failed");
        return "Healthy";
      },
      isProfileActive: () => false,
      stopProfile: async () => undefined,
      deleteProfile: async (profileId) => {
        attempted.push(profileId);
      }
    },
    2
  );

  assert.deepEqual(attempted, ["healthy"]);
  assert.equal(result.deleted, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.items[0]?.reason, "sqlite read failed");
});

test("individual deletion keeps a missing profile as a successful no-op", () => {
  assert.equal(
    getSingleProfileDeletionError({
      total: 1,
      completed: 1,
      deleted: 0,
      failed: 1,
      items: [{
        profileId: "missing",
        profileName: "missing",
        status: "failed",
        reason: "Perfil nao encontrado."
      }]
    }),
    undefined
  );
});

test("individual deletion still rejects a real profile failure", () => {
  assert.equal(
    getSingleProfileDeletionError({
      total: 1,
      completed: 1,
      deleted: 0,
      failed: 1,
      items: [{
        profileId: "a",
        profileName: "Profile A",
        status: "failed",
        reason: "disk busy"
      }]
    }),
    "disk busy"
  );
});

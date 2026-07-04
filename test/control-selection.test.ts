import assert from "node:assert/strict";
import test from "node:test";
import { parseRuntimeWindowSelection, validateRuntimeWindowSelection } from "../src/renderer/lib/controlSelection.js";
import type { RuntimeWindowTarget } from "../src/shared/contracts.js";

const windows: RuntimeWindowTarget[] = [
  {
    automationActive: false,
    profileId: "profile-1",
    profileName: "Perfil 1",
    slotNumber: 1,
    status: "active"
  },
  {
    automationActive: false,
    profileId: "profile-2",
    profileName: "Perfil 2",
    slotNumber: 2,
    status: "active"
  },
  {
    automationActive: true,
    profileId: "profile-4",
    profileName: "Perfil 4",
    slotNumber: 4,
    status: "running-automation"
  }
];

test("empty controlled window input targets all active runtime windows", () => {
  const parsed = parseRuntimeWindowSelection("", windows);

  assert.deepEqual(parsed.state, { mode: "all" });
  assert.equal(parsed.message, "Todas: 1, 2, 4");
});

test("controlled window input resolves lists, ranges, reverse ranges and duplicates", () => {
  const list = parseRuntimeWindowSelection("1,2,4,2", windows);
  const range = parseRuntimeWindowSelection("1-2", windows);
  const reverseRange = parseRuntimeWindowSelection("2-1", windows);

  assert.deepEqual(list.state, {
    mode: "windows",
    windows: [
      { profileId: "profile-1", slotNumber: 1 },
      { profileId: "profile-2", slotNumber: 2 },
      { profileId: "profile-4", slotNumber: 4 }
    ]
  });
  assert.deepEqual(range.state, {
    mode: "windows",
    windows: [
      { profileId: "profile-1", slotNumber: 1 },
      { profileId: "profile-2", slotNumber: 2 }
    ]
  });
  assert.deepEqual(reverseRange.state, range.state);
});

test("controlled window input rejects invalid or inactive slots instead of falling back to all", () => {
  for (const input of ["abc", "0", "1.5", "99", "1-4"]) {
    const parsed = parseRuntimeWindowSelection(input, windows);
    assert.equal(parsed.state.mode, "none", input);
  }
});

test("controlled window validation marks reused slots as stale", () => {
  const current = validateRuntimeWindowSelection(
    {
      mode: "windows",
      windows: [{ profileId: "old-profile", slotNumber: 1 }]
    },
    windows
  );

  assert.equal(current.mode, "none");
  assert.match(current.mode === "none" ? current.reason ?? "" : "", /desatualizada/);
});

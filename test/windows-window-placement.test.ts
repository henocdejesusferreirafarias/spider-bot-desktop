import assert from "node:assert/strict";
import test from "node:test";

import {
  WINDOWS_WINDOW_PLACEMENT_SCRIPT,
  parseNativePlacementResults,
  validateNativePlacementTarget
} from "../src/main/services/windows-window-placement.js";

const target = {
  profileId: "profile-a",
  userDataDir: "C:\\Users\\tester\\Predator\\profiles\\profile-a",
  x: 1928,
  y: 8
};

test("accepts a specific target and rounds physical coordinates", () => {
  assert.deepEqual(
    validateNativePlacementTarget({ ...target, x: 1928.4, y: 7.6 }),
    target
  );
});

test("rejects an empty or short directory and non-finite coordinates", () => {
  assert.throws(() => validateNativePlacementTarget({ ...target, userDataDir: "" }));
  assert.throws(() => validateNativePlacementTarget({ ...target, userDataDir: "ab" }));
  assert.throws(() => validateNativePlacementTarget({ ...target, x: Number.NaN }));
});

test("parses one result or a result list without trusting extra fields", () => {
  const expected = [{
    profileId: "profile-a",
    status: "positioned" as const,
    actual: { x: 1928, y: 8 }
  }];
  assert.deepEqual(parseNativePlacementResults(JSON.stringify(expected)), expected);
  assert.deepEqual(parseNativePlacementResults(JSON.stringify(expected[0])), expected);
});

test("rejects empty, invalid or unknown helper output", () => {
  assert.throws(() => parseNativePlacementResults(""));
  assert.throws(() => parseNativePlacementResults("not-json"));
  assert.throws(() => parseNativePlacementResults(JSON.stringify({
    profileId: "profile-a",
    status: "moved"
  })));
});

test("PowerShell helper is position-only and associates windows fail-closed", () => {
  for (const required of [
    "SetWindowPos",
    "GetWindowRect",
    "SWP_NOSIZE",
    "SWP_NOZORDER",
    "SWP_NOACTIVATE",
    "Chrome_WidgetWin_1",
    "--user-data-dir"
  ]) {
    assert.match(WINDOWS_WINDOW_PLACEMENT_SCRIPT, new RegExp(required));
  }
  assert.doesNotMatch(WINDOWS_WINDOW_PLACEMENT_SCRIPT, /SetWindowText|ShowWindow|MainWindowTitle/);
});

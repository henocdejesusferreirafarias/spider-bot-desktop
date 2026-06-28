import assert from "node:assert/strict";
import test from "node:test";
import { resolveProfileWindowStatus } from "../src/renderer/lib/profileWindowStatus.js";

test("closed windows are stopped even when the persisted state is active", () => {
  assert.equal(resolveProfileWindowStatus("active", false), "idle");
  assert.equal(resolveProfileWindowStatus("running-automation", false), "idle");
  assert.equal(resolveProfileWindowStatus("stopping", false), "idle");
});

test("open windows expose their current runtime activity", () => {
  assert.equal(resolveProfileWindowStatus("idle", true), "active");
  assert.equal(resolveProfileWindowStatus("active", true), "active");
  assert.equal(resolveProfileWindowStatus("running-automation", true), "running-automation");
});

test("transitions and errors remain visible", () => {
  assert.equal(resolveProfileWindowStatus("launching", false), "launching");
  assert.equal(resolveProfileWindowStatus("stopping", true), "stopping");
  assert.equal(resolveProfileWindowStatus("error", false), "error");
});

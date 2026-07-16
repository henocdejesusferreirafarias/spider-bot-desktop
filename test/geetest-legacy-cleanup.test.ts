import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  build: { extraResources?: unknown[] };
};

test("desktop package has no legacy Python GeeTest runtime", () => {
  assert.equal(packageJson.scripts["setup:python"], undefined);
  assert.doesNotMatch(packageJson.scripts.postinstall ?? "", /setup-python/i);
  assert.doesNotMatch(
    JSON.stringify(packageJson.build.extraResources ?? []),
    /GeekedTest-main|geetest_solver_bridge|geetest_solver_worker/i,
  );
  for (const relativePath of [
    "GeekedTest-main",
    "scripts/geetest_solver_bridge.py",
    "scripts/geetest_solver_worker.py",
    "scripts/setup-python.mjs",
    "scripts/captcha-autolabel-clip.py",
    "scripts/clip-burn.py",
  ]) {
    assert.equal(existsSync(join(root, relativePath)), false, relativePath);
  }
  assert.equal(existsSync(join(root, "assets/captcha/GeekedTest-LICENSE.txt")), true);
  assert.match(packageJson.scripts["train:nine-match"] ?? "", /captcha-train-nine-match\.py/);
});

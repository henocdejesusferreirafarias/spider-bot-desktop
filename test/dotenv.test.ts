import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

void test("loadDotEnvFrom returns null when no .env file is present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spider-env-"));
  try {
    delete process.env.SPIDER_TEST_VAR;
    const { loadDotEnvFrom } = await import("../src/main/services/paths.js");
    const result = loadDotEnvFrom([dir]);
    assert.equal(result, null);
    assert.equal(process.env.SPIDER_TEST_VAR, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("loadDotEnvFrom loads variables from .env and does not override existing env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spider-env-"));
  writeFileSync(
    join(dir, ".env"),
    [
      "# comment line",
      "SPIDER_TEST_VAR=hello",
      'SPIDER_TEST_QUOTED="world"',
      "SPIDER_TEST_PREEXISTING=from-file"
    ].join("\n")
  );
  try {
    delete process.env.SPIDER_TEST_VAR;
    delete process.env.SPIDER_TEST_QUOTED;
    process.env.SPIDER_TEST_PREEXISTING = "from-env";

    const { loadDotEnvFrom } = await import("../src/main/services/paths.js");
    const result = loadDotEnvFrom([dir]);

    assert.equal(result, join(dir, ".env"));
    assert.equal(process.env.SPIDER_TEST_VAR, "hello");
    assert.equal(process.env.SPIDER_TEST_QUOTED, "world");
    assert.equal(process.env.SPIDER_TEST_PREEXISTING, "from-env");
  } finally {
    delete process.env.SPIDER_TEST_VAR;
    delete process.env.SPIDER_TEST_QUOTED;
    delete process.env.SPIDER_TEST_PREEXISTING;
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("loadDotEnvFrom walks up directories to find .env", async () => {
  const root = mkdtempSync(join(tmpdir(), "spider-env-"));
  const nested = join(root, "a", "b", "c");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, ".env"), "SPIDER_TEST_WALK=ok\n");
  try {
    delete process.env.SPIDER_TEST_WALK;
    const { loadDotEnvFrom } = await import("../src/main/services/paths.js");
    const result = loadDotEnvFrom([nested]);
    assert.equal(result, join(root, ".env"));
    assert.equal(process.env.SPIDER_TEST_WALK, "ok");
  } finally {
    delete process.env.SPIDER_TEST_WALK;
    rmSync(root, { recursive: true, force: true });
  }
});

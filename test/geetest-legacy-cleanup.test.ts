import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

test("captcha assets and source keep only the nine-match model pipeline", () => {
  const assetNames = readdirSync(join(root, "assets/captcha"), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(assetNames, [
    "GeekedTest-LICENSE.txt",
    "nine_match.json",
    "nine_match.onnx",
  ]);

  for (const relativePath of [
    "src/main/services/captcha/solvers/nine.ts",
    "scripts/captcha-oracle-ques.py",
    "scripts/captcha-train-photo.py",
    "scripts/captcha-gate3-nine.mjs",
    "test/captcha-onnx.test.ts",
    "test/captcha-nine.test.ts",
  ]) {
    assert.equal(existsSync(join(root, relativePath)), false, relativePath);
  }

  const onnxSource = readFileSync(
    join(root, "src/main/services/captcha/onnx-session.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    onnxSource,
    /IconClassifier|PhotoClassifier|getClassifier|getPhotoClassifier|nine_photo|geetest_v4_icon|charsets\.json/,
  );

  const collectorSource = readFileSync(
    join(root, "scripts/captcha-collect-nine-dataset.mjs"),
    "utf8",
  );
  assert.doesNotMatch(collectorSource, /getClassifier|targetClass|targetScore|useClassifier/);
});

test("active captcha visual solver uses nine-match naming only", () => {
  assert.equal(existsSync(join(root, "src/main/services/captcha/solvers/nine-match.ts")), true);
  assert.equal(existsSync(join(root, "src/main/services/captcha/solvers/nine-photo.ts")), false);
  assert.equal(existsSync(join(root, "test/captcha-nine-match.test.ts")), true);
  assert.equal(existsSync(join(root, "test/captcha-photo-classifier.test.ts")), false);

  const signer = readFileSync(join(root, "src/main/services/captcha/signer.ts"), "utf8");
  const matcher = readFileSync(
    join(root, "src/main/services/captcha/solvers/nine-match.ts"),
    "utf8",
  );
  assert.match(signer, /findNineMatchCells/);
  assert.doesNotMatch(
    `${signer}\n${matcher}`,
    /nine-photo|findIconCellsPhoto|rankPhotoCellsForTarget|RankedPhotoCell/,
  );
});

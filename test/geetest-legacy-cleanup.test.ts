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

test("runtime signer exposes only the nine visual challenge path", () => {
  for (const relativePath of [
    "src/main/services/captcha/solvers/slide.ts",
    "test/captcha-slide.test.ts",
    "test/captcha-image-utils.test.ts",
    "test/fixtures/captcha/slide",
  ]) {
    assert.equal(existsSync(join(root, relativePath)), false, relativePath);
  }

  const signer = readFileSync(join(root, "src/main/services/captcha/signer.ts"), "utf8");
  const imageUtils = readFileSync(
    join(root, "src/main/services/captcha/image-utils.ts"),
    "utf8",
  );
  const automationRuntime = readFileSync(
    join(root, "src/main/services/automation-runtime.ts"),
    "utf8",
  );
  assert.match(signer, /generateNineW/);
  assert.doesNotMatch(
    signer,
    /generateW\b|SlideSolverFn|riskType ===|findPuzzlePiecePosition|solvers\/slide/,
  );
  assert.doesNotMatch(
    imageUtils,
    /decodePng|cvtColor|toGray|canny|matchTemplate|minMaxLoc/,
  );
  assert.doesNotMatch(
    automationRuntime,
    /interactWithGeetestWidget|solution\.setLeft|solution\.userresponse/,
  );
  assert.equal(packageJson.scripts["captcha:gate1"], undefined);
});

test("repository excludes obsolete captcha spikes and generated diagnostics", () => {
  const obsoletePaths = [
    "scripts/captcha-gate1.mjs",
    "scripts/captcha-gate2-nine.mjs",
    "scripts/captcha-collect-dataset.mjs",
    "scripts/captcha-collect-ques.mjs",
    "scripts/captcha-analyze-catalog.mjs",
    "scripts/captcha-debug-ncc.mjs",
    "scripts/captcha-perceptual-dryrun.mjs",
    "scripts/captcha-perceptual-match.mjs",
    "scripts/captcha-spike-perceptual.mjs",
    "scripts/captcha-review-gallery.mjs",
    "scripts/inspect-pin.mjs",
    "scripts/measure-load.mjs",
    "scripts/validate-killer.ts",
    "test/fixtures/captcha/dataset/nine",
    "test/fixtures/captcha/nine/ques.expected.json",
  ];
  for (const relativePath of obsoletePaths) {
    assert.equal(existsSync(join(root, relativePath)), false, relativePath);
  }

  const generatedPinArtifacts = readdirSync(join(root, "scripts"))
    .filter((name) => name.startsWith("_pin-"));
  assert.deepEqual(generatedPinArtifacts, []);
});

# GeeTest Nine-Only Repository Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Leave one explicit GeeTest automatic path (`nine`), remove confirmed obsolete repository artifacts, and version the validated `nine_match` runtime model without committing its dataset.

**Architecture:** The runtime keeps the existing bounded nine-selection and answer-retry loop, but the signer and visual module expose nine-specific interfaces only. Protocol clients may still receive non-nine `captcha_type` values; those values are rejected by selection rather than routed to another solver. Obsolete source and local diagnostics are removed only after tests encode the retained boundaries, then the real ONNX asset is smoke-tested and committed with an ADR.

**Tech Stack:** TypeScript strict ESM, Node.js test runner through `tsx`, Electron, `onnxruntime-node`, `opencv-wasm`, `pngjs`, `jpeg-js`, Python/PyTorch only for offline training, Git on Windows/PowerShell.

## Global Constraints

- Preserve `dataset/` completely and never stage any path below it.
- Preserve `assets/captcha/GeekedTest-LICENSE.txt` in packaged assets.
- Preserve historical plans/specs already tracked in Git; delete only the two explicitly approved untracked ComumPG drafts.
- Keep retry constants unchanged: 10 nine-search attempts, 5 rejected-answer attempts, 180 ms retry delay, and 60-second total deadline.
- Keep nine-match inference concurrency at 1 by default and preserve model warm-up behavior.
- Keep the current collectors, authorized importer, label server, suggestions, persistence, queue, dataset utilities, and nine-match trainer.
- Do not run a live GeeTest acceptance gate during this work.
- Do not add Git LFS; the approximately 6.1 MB ONNX is a regular Git asset.
- The committed model metadata must report 4,500 samples, held-out binary accuracy approximately 0.9704, and held-out challenge top-k accuracy 0.92.
- Use `apply_patch` for manual source edits and PowerShell-native removal for verified local generated directories.

---

## File Map

### Runtime kept and changed

- `src/main/services/captcha/solvers/nine-match.ts`: decode prompt/grid, split the grid, batch-score nine cells, and return the top coordinates.
- `src/main/services/captcha/onnx-session.ts`: own ONNX path resolution, preprocessing, singleton session, warm-up, and inference queue.
- `src/main/services/captcha/signer.ts`: retain crypto/proof helpers and expose only `generateNineW` for visual answers.
- `src/main/services/geetest-solver.ts`: search only for usable nine challenges and verify one loaded nine challenge.
- `src/main/services/automation-runtime.ts`: capture captcha ID/base URL and run bounded nine selection regardless of the captured request's type.
- `src/main/services/captcha/image-utils.ts`: retain only decoding/resizing needed by nine-match.

### Tests kept and changed

- `test/captcha-nine-match.test.ts`: preprocessing, queue, singleton, ranking, batching, and real-model contract tests.
- `test/geetest-solver.test.ts`: bounded search and non-nine rejection.
- `test/automation-runtime.test.ts`: integration-level nine search/retry behavior.
- `test/geetest-legacy-cleanup.test.ts`: repository inventory and absence of superseded source.
- `test/captcha-signer.test.ts`: cryptographic characterization remains unchanged.

### Documentation created

- `docs/adr/0003-geetest-nine-only-e-modelo-versionado.md`: production decision and model versioning rationale.

---

### Task 1: Rename The Active Visual Solver To Nine Match

**Files:**
- Rename: `src/main/services/captcha/solvers/nine-photo.ts` -> `src/main/services/captcha/solvers/nine-match.ts`
- Rename: `test/captcha-photo-classifier.test.ts` -> `test/captcha-nine-match.test.ts`
- Modify: `src/main/services/captcha/signer.ts`
- Modify: `test/geetest-legacy-cleanup.test.ts`

**Interfaces:**
- Consumes: `getNineMatchClassifier(): NineMatchClassifier` and `NineMatchImage` from `onnx-session.ts`.
- Produces: `findNineMatchCells(gridBuf: Buffer, quesBuf: Buffer, nineNums: number, matcher?: NineMatchScorer): Promise<Array<[number, number]>>`.

- [ ] **Step 1: Extend the cleanup test to require nine-match naming**

In `test/geetest-legacy-cleanup.test.ts`, add this test before changing source:

```ts
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
```

- [ ] **Step 2: Run the RED test**

Run:

```powershell
npx tsx --test test/geetest-legacy-cleanup.test.ts
```

Expected: FAIL because `nine-match.ts` and `captcha-nine-match.test.ts` do not exist.

- [ ] **Step 3: Rename the files and narrow the matcher API**

Use Git-aware renames:

```powershell
git mv -- src/main/services/captcha/solvers/nine-photo.ts src/main/services/captcha/solvers/nine-match.ts
git mv -- test/captcha-photo-classifier.test.ts test/captcha-nine-match.test.ts
```

In `nine-match.ts`, delete `RankedPhotoCell` and `rankPhotoCellsForTarget` entirely. Rename the exported entry point while preserving its batching implementation:

```ts
export async function findNineMatchCells(
  gridBuf: Buffer,
  quesBuf: Buffer,
  nineNums: number,
  matcher: NineMatchScorer = getNineMatchClassifier(),
): Promise<Array<[number, number]>> {
  const grid = decodeImage(gridBuf);
  const ques = decodeImage(quesBuf);
  const cells: NineMatchCell[] = [];
  for (let row = 1; row <= 3; row++) {
    for (let col = 1; col <= 3; col++) {
      cells.push(cropCell(grid, row, col));
    }
  }
  const scores = matcher.scoreCells
    ? await matcher.scoreCells(ques, cells)
    : await Promise.all(cells.map((cell) => matcher.score(ques, cell)));
  if (scores.length !== cells.length) {
    throw new Error(
      `nine_match scorer returned ${scores.length} scores for ${cells.length} cells`,
    );
  }
  return rankNineMatchCells(
    cells.map((cell, index) => ({
      row: cell.row,
      col: cell.col,
      score: scores[index] ?? 0,
    })),
    nineNums,
  );
}
```

Update the dynamic import in `signer.ts`:

```ts
const { findNineMatchCells } = await import('./solvers/nine-match.js');
```

Update the renamed test import and test names to `findNineMatchCells`. Delete the test for `rankPhotoCellsForTarget`; retain all queue, warm-up, preprocessing, ranking, and batched scorer tests.

- [ ] **Step 4: Run focused GREEN tests**

Run:

```powershell
npx tsx --test test/captcha-nine-match.test.ts test/geetest-legacy-cleanup.test.ts
npm run check
```

Expected: both commands exit 0; no source imports `nine-photo.js`.

- [ ] **Step 5: Review and commit Task 1**

Run:

```powershell
rg -n -S "nine-photo|findIconCellsPhoto|rankPhotoCellsForTarget|RankedPhotoCell" src test scripts package.json README.md
git diff --check
git add -- src/main/services/captcha/solvers/nine-match.ts src/main/services/captcha/signer.ts test/captcha-nine-match.test.ts test/geetest-legacy-cleanup.test.ts
git commit -m "refactor(captcha): name nine match solver explicitly"
```

Expected: `rg` returns only the negative-regression regex in `geetest-legacy-cleanup.test.ts`; the commit does not contain model or dataset files.

---

### Task 2: Make Signer And Runtime Explicitly Nine-Only

**Files:**
- Modify: `src/main/services/captcha/signer.ts`
- Modify: `src/main/services/geetest-solver.ts`
- Modify: `src/main/services/automation-runtime.ts`
- Modify: `src/main/services/captcha/image-utils.ts`
- Modify: `test/geetest-solver.test.ts`
- Modify: `test/automation-runtime.test.ts`
- Modify: `test/geetest-legacy-cleanup.test.ts`
- Delete: `src/main/services/captcha/solvers/slide.ts`
- Delete: `scripts/captcha-gate1.mjs`
- Delete: `scripts/captcha-gate2-nine.mjs`
- Delete: `test/captcha-slide.test.ts`
- Delete: `test/captcha-image-utils.test.ts`
- Delete: `test/fixtures/captcha/slide/bg.png`
- Delete: `test/fixtures/captcha/slide/slice.png`
- Modify: `package.json`

**Interfaces:**
- Produces: `generateNineW(data, captchaId, fetchImage): Promise<string>`.
- Produces: `GenerateGeetestNineW = (data, captchaId, fetchImage) => Promise<string>`.
- Preserves: `findNineChallengeWithClient`, `solveLoadedNineGeetestWithClient`, all retry constants, and manual fallback behavior.

- [ ] **Step 1: Add RED repository and interface assertions**

Extend `test/geetest-legacy-cleanup.test.ts`:

```ts
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
  assert.match(signer, /generateNineW/);
  assert.doesNotMatch(
    signer,
    /generateW\b|SlideSolverFn|riskType ===|findPuzzlePiecePosition|solvers\/slide/,
  );
  assert.doesNotMatch(
    imageUtils,
    /decodePng|cvtColor|toGray|canny|matchTemplate|minMaxLoc/,
  );
  assert.equal(packageJson.scripts["captcha:gate1"], undefined);
});
```

- [ ] **Step 2: Run the RED test**

Run:

```powershell
npx tsx --test test/geetest-legacy-cleanup.test.ts
```

Expected: FAIL on the slide files, `generateW`, image utility exports, and `captcha:gate1`.

- [ ] **Step 3: Narrow `signer.ts` to `generateNineW`**

Remove `SlideSolverFn`, `slice`, and `bg` from the challenge type. Replace the generic function with:

```ts
export async function generateNineW(
  data: GeetestChallengeData,
  captchaId: string,
  fetchImage: (path: string) => Promise<Buffer>,
): Promise<string> {
  const lotNumber = data.lot_number;
  const pow = data.pow_detail;
  const gridBuf = await fetchImage(data.imgs!);
  const quesPaths = (data.ques as string[] | undefined) ?? [];
  const quesBuf = quesPaths[0]
    ? await fetchImage(quesPaths[0])
    : Buffer.alloc(0);
  const { findNineMatchCells } = await import('./solvers/nine-match.js');
  const cells = await findNineMatchCells(
    gridBuf,
    quesBuf,
    Number(data.nine_nums ?? 3),
  );

  const body: Record<string, unknown> = {
    ...CURRENT_CONSTANTS.abo,
    ...generatePow(
      lotNumber,
      captchaId,
      pow.hashfunc,
      pow.version,
      pow.bits,
      pow.datetime,
      '',
    ),
    ...lotParser.getDict(lotNumber),
    biht: '1426265548',
    device_id: CURRENT_CONSTANTS.deviceId,
    em: { cp: 0, ek: '11', nt: 0, ph: 0, sc: 0, si: 0, wd: 1 },
    gee_guard: {
      roe: { auh: '3', aup: '3', cdc: '3', egp: '3', res: '3', rew: '3', sep: '3', snh: '3' },
    },
    ep: '123',
    geetest: 'captcha',
    lang: 'zh',
    lot_number: lotNumber,
    passtime: humanPasstime(1000, 0, 400),
    userresponse: cells,
  };
  return encryptW(JSON.stringify(body), data.pt);
}
```

There must be no switch/branch for unsupported types in the signer.

- [ ] **Step 4: Narrow `geetest-solver.ts` and captured runtime data**

Replace the import and injected function type:

```ts
import { generateNineW, type GeetestChallengeData } from "./captcha/signer.js";

export interface GeetestCaptchaData {
  captchaId: string;
  baseUrl: string;
}

export type GenerateGeetestNineW = (
  data: GeetestChallengeData,
  captchaId: string,
  fetchImage: (path: string) => Promise<Buffer>,
) => Promise<string>;
```

Make the type predicate private and keep non-nine rejection:

```ts
function isNineCaptchaType(value?: string | null): boolean {
  return value?.trim().toLowerCase() === "nine";
}
```

Remove `shouldAttemptAutomaticGeetestSolve` from the public exports and remove
its direct unit test/import. Keep the `findNineChallengeWithClient` tests where
early `/load` responses use `captcha_type: "icon"`, because those tests cover
the retained behavior through the public search interface. Update injected
signer fakes in `geetest-solver.test.ts` to the three-argument
`GenerateGeetestNineW` signature.

Update `solveLoadedNineGeetestWithClient`:

```ts
export async function solveLoadedNineGeetestWithClient(
  client: GeetestNineClient,
  captchaId: string,
  data: GeetestChallengeData,
  generateGeetestNineW: GenerateGeetestNineW = generateNineW,
): Promise<GeetestSolution | null> {
  const w = await generateGeetestNineW(
    data,
    captchaId,
    (path) => client.fetchImage(path),
  );
  const result = await client.verify({
    captchaId,
    lotNumber: data.lot_number,
    payload: String(data.payload ?? ""),
    processToken: String(data.process_token ?? ""),
    w,
    riskType: "nine",
  });
  const seccode = result.seccode;
  if (!seccode?.pass_token || !seccode.lot_number) return null;
  return {
    captcha_id: seccode.captcha_id ?? captchaId,
    lot_number: seccode.lot_number,
    pass_token: seccode.pass_token,
    gen_time: seccode.gen_time,
    captcha_output: seccode.captcha_output,
  };
}
```

In `automation-runtime.ts`, remove `riskType` from `extractGeetestDataFromUrl`; keep `captchaId` and `baseUrl`. Update tests and fixtures that construct `GeetestCaptchaData`. Keep tests where `/load` returns `captcha_type: "icon"`, because they protect reroll behavior.

- [ ] **Step 5: Remove slide-only source and utilities**

Delete the slide solver, Gates 1 and 2, slide tests, and fixtures with `git rm`.
Gate 2 is deleted in the same task because renaming `generateW` would otherwise
leave it broken between commits. In
`image-utils.ts`, retain exactly the shared `Mat` interface, `decodeImage`, and
`resize`; remove the slide-only method/color types and functions.

Run:

```powershell
git rm -- scripts/captcha-gate1.mjs scripts/captcha-gate2-nine.mjs src/main/services/captcha/solvers/slide.ts test/captcha-slide.test.ts test/captcha-image-utils.test.ts
git rm -r -- test/fixtures/captcha/slide
```

Remove this script from `package.json`:

```json
"captcha:gate1": "tsx scripts/captcha-gate1.mjs"
```

Do not delete `opencv-wasm`, `pngjs`, or `jpeg-js` dependencies because the nine
pipeline still uses them.

- [ ] **Step 6: Run focused GREEN tests**

Run:

```powershell
npx tsx --test test/captcha-signer.test.ts test/captcha-nine-match.test.ts test/geetest-solver.test.ts test/automation-runtime.test.ts test/geetest-legacy-cleanup.test.ts
npm run check
```

Expected: both commands exit 0. Search/answer limits remain 10 and 5 in tests.

- [ ] **Step 7: Review and commit Task 2**

Run:

```powershell
rg -n -S "SlideSolverFn|findPuzzlePiecePosition|solvers/slide|captcha:gate1|captcha-gate2-nine|riskType === .(icon|slide|gobang|winlinze)." src test scripts package.json README.md
git diff --check
git add -- package.json src/main/services/captcha/signer.ts src/main/services/captcha/image-utils.ts src/main/services/geetest-solver.ts src/main/services/automation-runtime.ts test/geetest-solver.test.ts test/automation-runtime.test.ts test/geetest-legacy-cleanup.test.ts
git commit -m "refactor(captcha): make automatic signer nine only"
```

Expected: the search has no live-source matches; the cleanup test may contain
negative-regression names. The commit contains no model or dataset files.

---

### Task 3: Remove Obsolete Spikes, Fixtures, And Local Diagnostics

**Files:**
- Modify: `test/geetest-legacy-cleanup.test.ts`
- Delete: obsolete tracked scripts and fixtures listed below
- Delete locally: approved untracked probes/drafts and ignored build output

**Interfaces:**
- Preserves all package commands for current collection, import, labeling, training, build, test, and distribution.
- Produces a repository inventory test that prevents removed artifacts from returning.

- [ ] **Step 1: Add RED inventory coverage**

Extend the existing cleanup test's absent-path array with:

```ts
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
```

- [ ] **Step 2: Run the RED test**

Run:

```powershell
npx tsx --test test/geetest-legacy-cleanup.test.ts
```

Expected: FAIL listing obsolete scripts/fixtures and `_pin-*` files.

- [ ] **Step 3: Delete tracked obsolete artifacts**

Run one Git-aware removal command:

```powershell
git rm -- scripts/captcha-collect-dataset.mjs scripts/captcha-collect-ques.mjs scripts/captcha-analyze-catalog.mjs scripts/captcha-debug-ncc.mjs scripts/captcha-perceptual-dryrun.mjs scripts/captcha-perceptual-match.mjs scripts/captcha-spike-perceptual.mjs scripts/captcha-review-gallery.mjs scripts/inspect-pin.mjs scripts/measure-load.mjs scripts/validate-killer.ts test/fixtures/captcha/nine/ques.expected.json
git rm -r -- test/fixtures/captcha/dataset/nine
git rm -- scripts/_pin-*
```

Do not remove `scripts/captcha-capture-deobfuscate.mjs`, current dataset tools,
the real `test/fixtures/captcha/nine/grid.jpg` and `ques.png`, or historical
tracked docs.

- [ ] **Step 4: Delete approved local artifacts with path guards**

Run from repository root:

```powershell
$root = (Resolve-Path .).Path.TrimEnd('\')
$targets = @(
  'probe-captcha-type.mjs',
  'probe-dump-shapes.mjs',
  'docs/superpowers/plans/2026-07-10-comumpg-nine-extractor.md',
  'docs/superpowers/specs/2026-07-10-comumpg-nine-extractor-design.md',
  'dist-electron',
  'dist-renderer',
  'release'
)
foreach ($target in $targets) {
  if (-not (Test-Path -LiteralPath $target)) { continue }
  $resolved = (Resolve-Path -LiteralPath $target).Path
  if (-not $resolved.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove path outside repository: $resolved"
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
```

Then verify preservation:

```powershell
if (-not (Test-Path -LiteralPath dataset)) { throw 'dataset was removed' }
if (-not (Test-Path -LiteralPath node_modules)) { throw 'node_modules was removed' }
```

- [ ] **Step 5: Run GREEN inventory and source scans**

Run:

```powershell
npx tsx --test test/geetest-legacy-cleanup.test.ts
rg -n -S "captcha-gate2-nine|captcha-perceptual|captcha-review-gallery|inspect-pin|measure-load|validate-killer|_pin-" src test scripts package.json README.md
git status --short --ignored
```

Expected: test passes; search matches only negative-regression inventory text;
`dataset/` remains untracked, while approved probes/drafts/build outputs are absent.

- [ ] **Step 6: Review and commit Task 3**

Run:

```powershell
git diff --check
git add -- test/geetest-legacy-cleanup.test.ts
$staged = git diff --cached --name-only
if ($staged -match '^dataset/') { throw 'dataset staged' }
git commit -m "chore(repo): remove obsolete captcha and debug artifacts"
```

Expected: tracked deletions already staged by `git rm`; no dataset path is staged.

---

### Task 4: Validate And Version The Nine-Match Model

**Files:**
- Modify: `test/captcha-nine-match.test.ts`
- Modify: `test/geetest-legacy-cleanup.test.ts`
- Modify: `assets/captcha/nine_match.onnx`
- Modify: `assets/captcha/nine_match.json`
- Create: `docs/adr/0003-geetest-nine-only-e-modelo-versionado.md`

**Interfaces:**
- Consumes: default `NineMatchClassifier`, `NineMatchImage`, and committed ONNX/JSON assets.
- Produces: a versioned ONNX with input `input`, output `logit`, input shape `[N, 3, 64, 128]`, and metadata for the 4,500-sample training run.

- [ ] **Step 1: Add real model and metadata tests**

Add imports to `test/captcha-nine-match.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
```

Add these tests:

```ts
test('committed nine-match ONNX exposes the runtime tensor contract', async () => {
  const modelPath = join(process.cwd(), 'assets', 'captcha', 'nine_match.onnx');
  const session = await ort.InferenceSession.create(modelPath);
  assert.deepEqual(session.inputNames, ['input']);
  assert.deepEqual(session.outputNames, ['logit']);

  const input = new ort.Tensor(
    'float32',
    new Float32Array(2 * 3 * 64 * 128),
    [2, 3, 64, 128],
  );
  const output = await session.run({ input });
  assert.equal(output.logit?.data.length, 2);
  for (const value of output.logit?.data ?? []) {
    assert.equal(Number.isFinite(Number(value)), true);
  }
});

test('committed nine-match metadata describes the accepted training run', () => {
  const metadata = JSON.parse(
    readFileSync(
      join(process.cwd(), 'assets', 'captcha', 'nine_match.json'),
      'utf8',
    ),
  ) as {
    kind: string;
    input: { width: number; height: number; channels: number; layout: string };
    training: {
      samples: number;
      heldoutBinary: number;
      heldoutChallengeTopk: number;
    };
  };
  assert.equal(metadata.kind, 'nine_match_pair_binary');
  assert.deepEqual(
    [metadata.input.width, metadata.input.height, metadata.input.channels],
    [128, 64, 3],
  );
  assert.equal(
    metadata.input.layout,
    'prompt_64x64_left_cell_64x64_right',
  );
  assert.equal(metadata.training.samples, 4500);
  assert.ok(metadata.training.heldoutBinary >= 0.97);
  assert.ok(metadata.training.heldoutChallengeTopk >= 0.92);
});
```

The first test runs a real batch through the committed binary; it must not use a
fake session.

- [ ] **Step 2: Run model tests before staging**

Run:

```powershell
npx tsx --test test/captcha-nine-match.test.ts test/geetest-legacy-cleanup.test.ts
```

Expected: PASS against the current local trained model. If it fails, do not
stage the model; report the exact ONNX or metadata mismatch.

- [ ] **Step 3: Record ADR 0003**

Create `docs/adr/0003-geetest-nine-only-e-modelo-versionado.md` with this
structure and concrete decision:

```markdown
# ADR 0003: Solver GeeTest automatico apenas para nine

## Contexto

As plataformas podem entregar `icon` ou `nine` para o mesmo captcha ID. O
modelo pareado `nine_match.onnx` atingiu 0,92 de acuracia held-out por desafio,
enquanto os caminhos icon, matching perceptual e slide nao fazem parte da
estrategia automatica de producao.

## Causa raiz

Manter varios solvers aumentava tempo de instalacao, superficie de manutencao e
ambiguidade operacional. Novas chamadas `/load?risk_type=nine` normalmente
rerrolam um desafio nao-nine para nine.

## Decisao

O Captcha Killer busca no maximo 10 desafios por rodada, responde no maximo 5
desafios nine rejeitados e respeita prazo total de 60 segundos. Tipos nao-nine
nao sao resolvidos; eles consomem uma busca. Ao esgotar limites, o fluxo passa
para resolucao manual. O ONNX aprovado e seus metadados sao assets versionados;
o dataset de origem permanece local.

## Verificacao

- teste de selecao cobre respostas `icon` antes de `nine`;
- teste real do ONNX cobre nomes e lote do tensor;
- `npm run check` e `npm test` devem passar;
- o pacote inclui `assets/captcha/nine_match.onnx` e nao inclui dataset.
```

- [ ] **Step 4: Validate hash, asset inventory, and package inclusion**

Run:

```powershell
Get-FileHash assets/captcha/nine_match.onnx -Algorithm SHA256
Get-ChildItem assets/captcha | Select-Object Name,Length
Select-String -Path package.json -Pattern '"assets/\*\*"'
```

Expected: the ONNX hash prints successfully; assets contain only
`GeekedTest-LICENSE.txt`, `nine_match.json`, and `nine_match.onnx`; electron-builder
still includes `assets/**`.

- [ ] **Step 5: Stage only model, metadata, tests, and ADR**

Run:

```powershell
git add -- assets/captcha/nine_match.onnx assets/captcha/nine_match.json test/captcha-nine-match.test.ts test/geetest-legacy-cleanup.test.ts docs/adr/0003-geetest-nine-only-e-modelo-versionado.md
$staged = git diff --cached --name-only
if ($staged -match '^dataset/') { throw 'dataset staged' }
git diff --cached --check
git diff --cached --stat
```

Expected: both model files are staged, no dataset file appears, and the binary
is approximately 6.1 MB.

- [ ] **Step 6: Commit Task 4**

Run:

```powershell
git commit -m "feat(captcha): version accepted nine match model"
```

Expected: commit contains the real model, metadata, tests, and ADR only.

---

### Task 5: Full Verification And Final Repository Audit

**Files:**
- Modify only if a verification failure identifies a concrete issue.

**Interfaces:**
- Verifies the complete repository state produced by Tasks 1-4.

- [ ] **Step 1: Install and rebuild required local dependencies**

Run:

```powershell
npm install
```

Expected: exit 0; `patch-package` and native license-core build succeed. No
Python legacy solver setup runs.

- [ ] **Step 2: Run required gates**

Run:

```powershell
npm run check
npm test
```

Expected: both exit 0; test output has zero failures. One existing network test
may remain explicitly skipped.

- [ ] **Step 3: Run final source and filesystem scans**

Run:

```powershell
rg -n -S "nine-photo|findIconCellsPhoto|rankPhotoCellsForTarget|PhotoClassifier|SlideSolverFn|findPuzzlePiecePosition|captcha-gate2-nine|captcha-perceptual|captcha-review-gallery|inspect-pin|measure-load|validate-killer" src test scripts package.json README.md
Get-ChildItem assets/captcha | Select-Object Name,Length
git status --short --ignored
```

Expected:

- source scan returns only negative-regression text in cleanup tests;
- assets are the MIT notice, `nine_match.json`, and `nine_match.onnx`;
- `dataset/` remains present and untracked;
- approved local probes/drafts and generated build outputs are absent;
- no unexpected tracked modification remains.

- [ ] **Step 4: Review commits and staged safety**

Run:

```powershell
git log --oneline 0fe5780..HEAD
git diff 0fe5780..HEAD --stat
git diff --cached --name-only
```

Expected: this plan commit plus four implementation commits after the design
commit, no staged changes, and no dataset paths in commit history.

- [ ] **Step 5: Commit verification-only fixes if required**

If and only if a gate required a source/test correction, stage the exact files,
re-run the failing command and both required gates, then commit:

```powershell
git commit -m "fix(captcha): finish nine-only cleanup verification"
```

If no correction was needed, do not create an empty commit.

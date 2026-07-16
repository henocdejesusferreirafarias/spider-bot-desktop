# GeeTest nine-only runtime and repository hygiene

Date: 2026-07-16
Status: design approved, awaiting user spec review before implementation plan

## Context

The original captcha work intended to support both GeeTest `nine` and `icon`.
Production observation showed that requesting fresh challenges usually produces
a `nine` within a small bounded number of attempts. The runtime now searches up
to 10 times for `captcha_type=nine`, retries at most 5 rejected nine answers,
and falls back to manual solving when those limits or the 60-second deadline are
reached.

The repository still carries names, branches, scripts, fixtures, and generated
diagnostics from earlier approaches:

- `nine-photo.ts`, `findIconCellsPhoto`, and `rankPhotoCellsForTarget` describe
  the abandoned closed-class photo classifier rather than the active pair
  model;
- `generateW` still contains slide, invisible, AI, icon, gobang, and winlinze
  branches even though the automatic runtime selects only nine;
- Gate 1, Gate 2, perceptual matching, CLIP review, and fixture collectors are
  completed spikes with no active consumer;
- standalone-repository leftovers reference paths and packages from the former
  monorepo;
- generated PIN screenshots and local probes add noise without contributing to
  builds or tests;
- the latest trained `nine_match.onnx` and metadata are required at runtime but
  are not yet committed.

## Decision

Make the automatic GeeTest implementation explicitly nine-only, remove
confirmed obsolete artifacts, and commit the validated nine-match model as a
normal runtime asset. Keep only protocol-level knowledge of non-nine challenge
types where it is needed to reject them and continue searching.

## Goals

1. Make names and interfaces describe the active `nine_match` pair model.
2. Remove all automatic solver code for `icon`, slide, and other unsupported
   GeeTest challenge types.
3. Preserve bounded selection of nine challenges when GeeTest returns another
   type.
4. Remove obsolete spikes, fixtures, broken diagnostics, and generated local
   artifacts.
5. Commit and verify the latest trained model without committing the dataset.
6. Preserve historical design documents and the GeekedTest MIT notice.
7. Record the nine-only decision in an ADR.

## Non-goals

- Rewriting historical plans and specs to pretend earlier approaches did not
  exist.
- Removing the manual captcha fallback.
- Removing the data collection, manual labeling, suggestion, or nine-match
  training pipeline.
- Committing `dataset/` or any labeling runtime output.
- Solving `icon`, slide, gobang, winlinze, invisible, or AI challenge types.
- Changing retry limits, inference concurrency, preprocessing, or model
  architecture.
- Running a live GeeTest acceptance gate during repository hygiene.

## Runtime design

### Nine-only signer

Rename `generateW` to `generateNineW`. Its inputs are the loaded nine challenge,
captcha ID, and image fetcher. It always:

1. builds the shared GeeTest proof and encrypted payload fields;
2. fetches `imgs` and the first `ques` image;
3. scores the 3x3 cells with the nine-match classifier;
4. writes the selected cells to `userresponse`;
5. encrypts and returns `w`.

The signer no longer accepts a risk type or slide callback. Remove the branches
and data fields used only by slide, AI, invisible, icon, gobang, and winlinze.
The crypto helpers used by the nine signer and their characterization tests
remain unchanged.

### Nine-match naming

Rename:

- `solvers/nine-photo.ts` to `solvers/nine-match.ts`;
- `findIconCellsPhoto` to `findNineMatchCells`;
- `test/captcha-photo-classifier.test.ts` to
  `test/captcha-nine-match.test.ts`.

Delete `RankedPhotoCell` and `rankPhotoCellsForTarget`; they are leftovers from
the abandoned target-class classifier and have no runtime consumer. Keep the
pair-model scorer, batching, queue, preprocessing, and score ranking behavior.

### Challenge selection

The captured GeeTest request still supplies `captchaId` and `baseUrl`. Stop
storing its `risk_type`, because automatic solving always starts the bounded
nine selection loop.

The loaded response's `captcha_type` remains part of the HTTP contract. A
private nine predicate accepts only case-insensitive `nine`. Other values,
including `icon`, consume a search attempt and cause another `/load` request.
Tests must retain explicit non-nine examples to protect this behavior. Those
mentions do not constitute an icon solver.

### Image utilities

Removing slide makes the following OpenCV wrappers dead and they are deleted:

- `decodePng`;
- `cvtColor` and `toGray`;
- `canny`;
- `matchTemplate`;
- `minMaxLoc` and their slide-only types.

Keep `decodeImage`, `resize`, and `Mat`, which are required by nine-match
preprocessing. `opencv-wasm`, `pngjs`, and `jpeg-js` therefore remain runtime
dependencies.

## Source cleanup

Delete the following tracked captcha artifacts:

- `scripts/captcha-gate1.mjs` and the `captcha:gate1` package command;
- `scripts/captcha-gate2-nine.mjs`;
- `scripts/captcha-collect-dataset.mjs`;
- `scripts/captcha-collect-ques.mjs`;
- `scripts/captcha-analyze-catalog.mjs`;
- `scripts/captcha-debug-ncc.mjs`;
- `scripts/captcha-perceptual-dryrun.mjs`;
- `scripts/captcha-perceptual-match.mjs`;
- `scripts/captcha-spike-perceptual.mjs`;
- `scripts/captcha-review-gallery.mjs`;
- `src/main/services/captcha/solvers/slide.ts`;
- `test/captcha-slide.test.ts`;
- `test/captcha-image-utils.test.ts`;
- `test/fixtures/captcha/slide/**`;
- `test/fixtures/captcha/dataset/nine/**`;
- `test/fixtures/captcha/nine/ques.expected.json`.

Keep `scripts/captcha-capture-deobfuscate.mjs` and its fixtures because they
maintain and test the signer constants. Keep the current collectors, authorized
importer, label server, suggestions, persistence, queue, dataset utilities, and
nine-match trainer.

Delete the following confirmed standalone-repository leftovers:

- `scripts/inspect-pin.mjs`, which is marked disposable and contains a hardcoded
  path to the former monorepo;
- `scripts/measure-load.mjs`, which imports a package absent from this repo;
- `scripts/validate-killer.ts`, which imports the former sibling API source;
- all tracked `scripts/_pin-*` generated screenshots, HTML, and text dumps.

## Local cleanup

Delete these untracked investigation artifacts:

- `probe-captcha-type.mjs`;
- `probe-dump-shapes.mjs`;
- `docs/superpowers/plans/2026-07-10-comumpg-nine-extractor.md`;
- `docs/superpowers/specs/2026-07-10-comumpg-nine-extractor-design.md`.

Delete ignored generated output under `dist-electron/`, `dist-renderer/`, and
`release/` after verifying that every resolved path remains under the repository
root. Do not delete `node_modules/` or `dataset/`.

## Model artifact

Commit:

- `assets/captcha/nine_match.onnx`;
- `assets/captcha/nine_match.json`.

The approved metadata reports 4,500 pair samples, held-out binary accuracy of
approximately 0.9704, and held-out challenge top-k accuracy of 0.92. The model
is approximately 6.1 MB, below GitHub's regular-file limit, so Git LFS is not
needed.

Add automated asset checks that:

1. load the real ONNX session;
2. assert the expected `input` and `logit` names;
3. run one real prompt/cell batch and require finite probabilities;
4. validate the metadata kind, input layout, sample count, and acceptance
   threshold;
5. confirm that `nine_match.onnx` and `nine_match.json` are the only model
   artifacts in `assets/captcha/`.

The test dataset remains untracked and unstaged.

## Documentation

Add ADR 0003 documenting:

- production can reroll non-nine GeeTest challenges into nine;
- automatic solving is intentionally nine-only;
- search, answer, and deadline limits bound the approach;
- non-nine exhaustion falls back to manual solving;
- the trained ONNX is a versioned runtime dependency while its source dataset
  remains local.

Historical plans/specs remain unchanged. They are evidence for why discarded
approaches were removed, not live implementation instructions.

## Verification

Implementation is accepted when all of the following hold:

1. A source scan outside historical docs finds no `nine-photo`,
   `findIconCellsPhoto`, `rankPhotoCellsForTarget`, `PhotoClassifier`, slide
   solver, perceptual-matching spike, or old Gate references.
2. Runtime source contains no solver branch for `icon` or slide.
3. Retry and collector tests still prove that non-nine responses are skipped
   rather than solved.
4. The real committed ONNX passes its contract and inference smoke tests.
5. `npm install`, `npm run check`, and `npm test` exit successfully.
6. `git status` shows `dataset/` untouched and no investigation/build artifacts.
7. The final staged diff contains the model but no dataset files.

## Commit structure

Use small reviewable commits:

1. document the approved design;
2. make runtime and naming nine-only with tests;
3. remove obsolete tracked and local artifacts;
4. validate and commit the trained model plus ADR;
5. apply any final verification fixes without folding unrelated changes.

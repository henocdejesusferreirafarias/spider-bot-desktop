# Plan 2d Handoff Briefing

> Self-contained briefing for the next agent to pick up where this session stopped. Read this file, then open the implementation plan linked below.

## Background (read first)

You are continuing work on the GeeTest `nine` photo captcha solver in the SpiderBOT desktop client (Electron app, Windows). The branch is `feat/solver-captcha-ts`.

Plan 2c attempted to train a closed 40-class photo classifier (`nine_photo.onnx`) for the 3x3 photo grid that GeeTest `nine` challenges present. The plan was stopped before training because the live GeeTest `nine-popup-en` demo serves arbitrary icons (bird, zipper, gloves, mouse, pot, syringe, scissors, pencil, bus, etc.) that fall outside the assumed fixed universe (`car/butterfly/plane/fish/turtle × directions`). The existing `IconClassifier` therefore mislabels ~96% of prompts as `plane_d`, making `meta.targetClass` invalid as ground truth.

The blocker is documented in:
- `.superpowers/sdd/plan2c-live-data-blocker.md`
- Visual sample: `.superpowers/sdd/ques-sample-white.png`

Plan 2c landed code that is wired but unusable:
- `src/main/services/captcha/signer.ts` already imports `findIconCellsPhoto` from `./solvers/nine-photo.js` for `riskType === 'nine'`.
- `src/main/services/captcha/onnx-session.ts` exports `PhotoClassifier` and `normalizePhotoRgbForImageNet`.
- `src/main/services/captcha/solvers/nine-photo.ts` implements `findIconCellsPhoto`.
- `scripts/captcha-collect-nine-dataset.mjs` collected 192 raw challenges into `dataset/raw/<id>/{grid.jpg, ques.png, meta.json}`.

The `meta.json` files in `dataset/raw/` have `targetClass` values that you MUST NOT trust for ground truth. They are useful only for statistics.

## Your task

Execute the implementation plan in **subagent-driven mode**. The plan is committed at:

`docs/superpowers/plans/2026-07-10-captcha-manual-labeling-plan2d.md`

The design spec it implements is at:

`docs/superpowers/specs/2026-07-10-captcha-manual-labeling-plan2d-design.md`

## Required sub-skill

Use `superpowers:subagent-driven-development`. Dispatch a fresh subagent for each of the 5 tasks in the plan, in order. Review the result between tasks. Do not skip the review gates.

## Scope guardrails (do not violate)

- Do not modify any file under `src/main/services/captcha/**`.
- Do not modify `signer.ts`, `nine-photo.ts`, or `PhotoClassifier`.
- Do not run Gate 3 (`scripts/captcha-gate3-nine.mjs`) and do not write any success ADR.
- Do not collect more challenges. The 192 in `dataset/raw/` are the entire seed corpus.
- Do not commit `dataset/manual-labels.jsonl`, `dataset/label-state.json`, `dataset/label-disputes.jsonl`, or `dataset/label-skip.log`. They are runtime output of the labeling tool, not source.
- The default server port is 8765, the default seed is 20260710, the lock window is 5000 ms.

## Verification commands (run before declaring done)

```
npm run check
npm test
```

Both must pass. The pre-existing 156 tests + the 4 new test files added by the plan (queue, persistence, server, recovery) must all be green.

## After execution

When the plan is done and verified, hand control back to the user with:
- A summary of commits added on top of `5795991`.
- The status of `npm run check` and `npm test`.
- Confirmation that no runtime solver, signer, or ADR was touched.
- A reminder that Plan 3 (deciding what to do with the labels) is a separate design step the user must initiate explicitly.

## Repo quick facts

- Path: `C:\Users\henoc\OneDrive\Área de Trabalho\Projetos\SpiderBOT\spider-bot-desktop`
- Branch: `feat/solver-captcha-ts`
- Runtime: Node + Electron + TypeScript strict ESM (`noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`)
- Gate command: `npm run check`
- Test command: `npm test` (`tsx --test test/*.test.ts`)
- Existing helper to reuse: `splitGridCells` and `parseArgs` from `scripts/captcha-nine-dataset-utils.mjs`
- Existing image decoder: `decodeRgba` from `scripts/captcha-nine-dataset-utils.mjs` (handles JPEG and PNG)
- AGENTS.md rules live in `AGENTS.md` — read it before committing.

## Useful existing files to skim first

- `scripts/captcha-nine-dataset-utils.mjs` — helpers you will reuse (`splitGridCells`, `decodeRgba`, `parseArgs`)
- `test/captcha-nine-dataset-utils.test.ts` — test style reference
- `src/main/services/captcha/signer.ts` lines 177-184 — confirms `nine-photo` is the active solver path
- `dataset/raw/000000-*/meta.json` — example of the meta.json shape (do not trust `targetClass`)

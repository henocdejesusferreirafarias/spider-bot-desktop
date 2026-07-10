# Nine Active Learning Loop Design

Date: 2026-07-10

## Goal

Make the human labeling loop as automatic as possible without letting weak model predictions contaminate the dataset.

## Design

The operator works in batches:

1. Collect a new batch of GeeTest `nine` challenges into `dataset/raw` without overwriting existing folders.
2. Run the labeling UI. Previously labeled rounds are replayed from `dataset/manual-labels.jsonl`, so only newly added raw challenges are presented.
3. If an approved `assets/captcha/nine_match.onnx` exists, the UI may preselect suggested cells. The operator can press Enter to accept or correct the selection before saving.
4. Run `npm run train:nine-match`. The trainer exports/promotes a model only if the held-out challenge top-k threshold passes.

The model is not updated after every Enter. It improves in validated batches only.

## Components

- `scripts/captcha-collect-nine-dataset.mjs`
  - Adds `--append` so new challenges start after the highest existing numeric prefix.
  - Adds `--no-classifier` so collection does not depend on the legacy icon classifier. `targetClass` remains stats-only and may be null.

- `scripts/captcha-label-suggestions.mjs`
  - Optional helper for the label server.
  - Loads `assets/captcha/nine_match.onnx` and scores prompt/cell pairs when the model exists.
  - Returns no suggestions when the model is absent or fails to load.

- `scripts/captcha-label-server.mjs`
  - Includes optional `suggestedCells` in `/api/challenge`.
  - The browser preselects suggestions when present.

- `package.json`
  - Adds `collect:nine-batch` for append collection.
  - Keeps `label` and `train:nine-match` as the human-facing loop commands.

## Guardrails

- Never learn from GeeTest `fail` alone.
- Never promote a model without held-out validation.
- Do not modify the production solver wiring in this loop.
- Do not commit `dataset/` runtime output.

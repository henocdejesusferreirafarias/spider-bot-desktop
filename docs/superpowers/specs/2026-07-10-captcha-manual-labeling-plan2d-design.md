# Plan 2d — Manual Labeling UI for GeeTest nine challenges

Date: 2026-07-10
Status: design approved, awaiting user spec review before implementation plan

## Context

Plan 2c attempted to train a closed 40-class `nine_photo.onnx` to map the 3x3 photo grid to a fixed universe (`car/butterfly/plane/fish/turtle × directions`). The live GeeTest `nine-popup-en` demo serves arbitrary icons (bird, zipper, gloves, mouse, pot, pipe, syringe, scissors, pencil, bus, etc.) that fall outside that universe. The existing `IconClassifier` therefore mislabels ~96% of prompts as `plane_d`, making `meta.json.targetClass` unusable as training ground truth. See `.superpowers/sdd/plan2c-live-data-blocker.md` for the evidence (192 raw challenges collected, distribution `plane_d:185 / butterfly_ru:5 / butterfly_l:2`).

Plan 2c was stopped before training to avoid baking in false labels. The 192 raw challenges with valid `grid.jpg` and `ques.png` remain on disk and form the seed corpus for this plan.

## Goal

Produce a small, high-confidence set of per-challenge cell labels for the 192 raw challenges already collected, in a format that directly mirrors what GeeTest expects from the solver: an array of `[row, col]` 1-indexed pairs (length `nineNums`, typically 3).

Out of scope: training any new model, modifying `signer.ts` or `nine-photo.ts`, re-running Gate 3, collecting additional challenges (the 192 are sufficient for the first labeling batch).

## Architecture

A single Node script (`scripts/captcha-label-server.mjs`) that:

1. Reads every `dataset/raw/<id>/{grid.jpg, ques.png, meta.json}` on boot.
2. Builds a deterministic queue of 384 rounds (each of 192 challenges appears twice in random order, seeded for reproducibility).
3. Serves a single HTML page on `http://localhost:8765` that shows one challenge at a time and accepts N cell clicks (N = `meta.nineNums`).
4. Persists each accepted label by `POST /api/label` into `dataset/manual-labels.jsonl`.
5. Detects round-1 ≠ round-2 disagreements and exposes them on `/disputes` for the operator to resolve (accept round-1, accept round-2, or relabel).
6. Writes final resolution per challenge into `manual-labels.jsonl` with `round: "final"`.

The HTML, CSS, and JavaScript live inline in the server file as template strings. No frontend build step, no separate static assets, no new runtime dependencies. Only `node:http`, `node:fs`, `node:path`, plus the existing helpers from `scripts/captcha-nine-dataset-utils.mjs` (`splitGridCells`, `parseArgs`).

## Components

### `ChallengeLoader`

- Walks `dataset/raw/` at boot, expects `<id>/grid.jpg`, `<id>/ques.png`, `<id>/meta.json`.
- Builds `Map<challengeId, ChallengeRecord>` where:
  ```
  ChallengeRecord = {
    id: string,
    captchaId: string,
    lotNumber: string,
    nineNums: number,
    gridPath: string,
    quesPath: string,
    metaValid: boolean,           // false if meta.json malformed
    targetClass: string | null,   // captured from meta.json for statistics only; NEVER trusted as ground truth
  }
  ```
- Skips corrupt entries and writes them to `dataset/label-skip.log` with reason. Continues loading the rest.

### `LabelingQueue`

Pure, seedable, deterministic.

- Input: array of challenge IDs, seed (default `20260710`).
- Generates a shuffle where each ID appears exactly twice. Algorithm: shuffle a `[id, id, id, id, ...]` array (2 copies per ID) with a seeded PRNG; this guarantees each ID appears 2x and the order is reproducible.
- State (in-memory):
  ```
  index: number
  labeledKeys: Set<"challengeId:round"> where round in {1, 2}
  disputes: Set<challengeId>
  ```
- Methods:
  - `next(): { challengeId, round, totalRounds, currentIndex, isDispute } | null` — returns the next unlabeled round; `null` when the main queue is exhausted but disputes may remain.
  - `recordLabel(challengeId, round, cells): { isNewDispute: boolean, bothRoundsNowLabeled: boolean }` — stores the round-1 or round-2 cells; if both rounds exist and differ, adds the ID to `disputes`.
  - `getDisputes(): Array<{ challengeId, round1Cells, round2Cells }>` — used by `/api/disputes`.
  - `resolveDispute(challengeId, choice, cells?)` — accepts `choice: "round1" | "round2" | "relabel"`; for `relabel`, `cells` must be provided.
  - `getStats(): { totalChallenges, labeledRounds, remainingRounds, disputeCount }`.

### `HttpServer`

Uses `node:http` on port 8765. JSON in/out, no frameworks.

Routes:

- `GET /` — returns the inline HTML page.
- `GET /api/challenge` — returns the next challenge from the queue, with `ques.png` and the 9 cells of `grid.jpg` inlined as `data:image/png;base64,...` URIs (avoids CORS and filesystem serving).
- `POST /api/label` — body `{ round: 1|2, cells: [[r,c], ...] }` where `r,c` are 1-indexed and `cells.length === meta.nineNums`. Returns `{ saved: true, stats }`.
- `GET /api/disputes` — list of unresolved disputes.
- `POST /api/disputes/resolve` — body `{ challengeId, choice, cells? }`.
- `GET /api/stats` — debug header data.

Server validates that exactly `meta.nineNums` cells are sent and that each cell is in `1..3 × 1..3`. Validation errors return `400` with a JSON `{ error }` body.

### `Persistence`

Two small classes:

- `JsonlWriter` — appends a JSON line to a file with `mkdirSync({recursive: true})` on first write. Used for `manual-labels.jsonl` and `label-disputes.jsonl`.
- `StateFile` — reads/writes `label-state.json`. Writes are atomic (`writeFileSync` to `*.tmp`, then `renameSync`).

The state file is written on every `recordLabel` and `resolveDispute`, so a server crash loses at most the in-flight round.

## Data model

### `dataset/manual-labels.jsonl`

One line per accepted label. Three kinds of entries:

1. Round 1 of challenge X:
   ```json
   {"kind":"round","challengeId":"...","round":1,"cells":[[r,c],...],"labeledAt":"ISO"}
   ```
2. Round 2 of challenge X:
   ```json
   {"kind":"round","challengeId":"...","round":2,"cells":[[r,c],...],"labeledAt":"ISO"}
   ```
3. Final accepted label for challenge X (after dispute resolution, if any):
   ```json
   {"kind":"final","challengeId":"...","cells":[[r,c],...],"fromDispute":true|false,"disputeResolution":"round1"|"round2"|"relabel"|null,"labeledAt":"ISO"}
   ```

Consumers (Plan 3) read the last `final` entry per `challengeId`. The two `round` entries are kept for audit and inter-rater agreement statistics. A challenge with `kind: "skipped"` (operator pressed `→`) is recorded with no cells and never produces a `final` entry unless the operator relabels it later.

### Two-process lock

The server stores the in-memory mtime of `label-state.json` from the most recent successful read or write. On every `recordLabel` and `resolveDispute`:

1. `fs.statSync(labelStatePath).mtimeMs` is read.
2. If it differs from the in-memory value by more than `LOCK_WINDOW_MS = 5000`, the server returns `409 Conflict` with `{ error: "another session is active" }` and does not write.
3. Otherwise the server writes the new state, captures the new mtime, and proceeds.

The check is racy across processes on the same machine (two processes can both read the same mtime before either writes), but it covers the common "two browser tabs" case where both POSTs hit the same server.

### `dataset/label-state.json`

```json
{
  "version": 1,
  "seed": 20260710,
  "totalRounds": 384,
  "currentIndex": 47,
  "labeledKeys": ["000000-...:1", "000001-...:2", ...],
  "disputes": ["000017-..."],
  "lastSavedAt": "ISO"
}
```

### `dataset/label-disputes.jsonl`

One line per dispute resolution, for audit only:

```json
{"challengeId":"...","round1Cells":[[...]],"round2Cells":[[...]],"choice":"round2","finalCells":[[...]],"resolvedAt":"ISO"}
```

### `dataset/label-skip.log`

Plain text log of challenges that failed validation at boot. Format:
```
000099-...: meta.json missing nineNums
000100-...: grid.jpg unreadable (jpeg decode failed)
```

## UX

The page layout:

```
+----------------------------------------+
| Plan 2d — Manual Labeling              |
| Progress: 47 / 384 rounds | Disputes: 3|
+----------------------------------------+
|  [ques.png]                            |  ← silhouette question, ~120px tall
+----------------------------------------+
|  +-----+-----+-----+                   |
|  | (1,1)| (1,2)| (1,3)|                |  ← grid 3x3, clickable cells
|  +-----+-----+-----+                   |     selected cells get green border
|  | (2,1)| (2,2)| (2,3)|                |
|  +-----+-----+-----+                   |
|  | (3,1)| (3,2)| (3,3)|                |
|  +-----+-----+-----+                   |
+----------------------------------------+
| Selecione 3 células. Faltam 1.         |  ← live count
| [ Salvar (Enter) ]  [ Pular ]          |
+----------------------------------------+
```

Keyboard shortcuts:
- `1`..`9` toggle cells (numPad also works).
- `Enter` saves when count is correct.
- `Backspace` or `Esc` clears current selection.
- `→` skips — records `{"kind":"skipped","challengeId":"...","round":N,"labeledAt":"..."}` and advances to the next round. Skipped rounds count toward `currentIndex` but the challenge produces no `final` entry unless the operator later relabels it from the disputes view (skipped rounds do NOT enter the disputes queue, since both rounds being "skipped" is not a disagreement).

Click a selected cell to deselect. Save button is disabled until count matches `nineNums`.

After main queue finishes, the page shows a "Resolver disputas" link leading to `/disputes`. The disputes view shows each disagreement with both round-1 and round-2 selections highlighted, plus three buttons: "Manter round-1", "Manter round-2", "Rotular de novo".

## Error handling

| Scenario | Behavior |
|---|---|
| Click count ≠ nineNums | Save button disabled; live count text tells the operator how many are missing or extra. |
| POST /api/label fails (network or server error) | Browser shows inline retry banner; selection in the page is preserved. |
| Server crash mid-round | On restart, `label-state.json` is loaded, the in-flight round (whose POST never returned 200) is treated as unlabeled and reappears in the queue. |
| Two browser tabs open on the same URL | Server checks `label-state.json` mtime before each write; if it changed within the last 5s, returns 409 Conflict with `{ error: "another session is active" }`. |
| Operator closes Chrome mid-session | State file is unchanged for the in-flight round; on reopen, that round reappears. |
| Empty `dataset/raw/` at boot | Server exits 1 with clear message: `Nenhum desafio em dataset/raw/. Rode scripts/captcha-collect-nine-dataset.mjs primeiro.` |
| Corrupt `meta.json` or unreadable `grid.jpg` | Challenge skipped and logged to `dataset/label-skip.log`; rest of the queue unaffected. |
| Pressing Enter with no cells selected | No-op; same screen stays visible. |
| Pressing Esc/Backspace | Clears current selection (does not advance round). |

## Tests

Three test files, no browser required:

### `test/captcha-label-queue.test.ts`

Pure unit tests for `LabelingQueue` (extracted into a separate importable module within the server file or imported from a sibling `.mjs` helper):

- Deterministic order for fixed seed.
- Each challenge appears exactly twice across the full queue.
- `recordLabel` accepts a round and marks it labeled.
- Two rounds with different cells mark a dispute.
- Two rounds with identical cells do NOT mark a dispute.
- `getStats` counts add up to total.

### `test/captcha-label-server.test.ts`

Integration tests that boot the server on a random port (`httpServer.listen(0)`):

- `GET /api/challenge` returns the first challenge with valid base64 image data URIs.
- `POST /api/label` with valid body appends one line to a temp JSONL and updates state.
- `POST /api/label` with wrong cell count returns 400.
- `GET /api/stats` reflects the writes.
- A second server process trying to write within the lock window returns 409 (optional, low-priority).

### `test/captcha-label-recovery.test.ts`

Crash recovery:

- Boot server A on port 0, label 3 challenges.
- Forcibly close server A.
- Boot server B on the same `label-state.json`, confirm the next 3 challenges returned are the 4th–6th in the original queue order (not the first 3).

Tests do not require a browser. They use Node's built-in `fetch` and `node:test`.

## Acceptance criteria

Plan 2d is done when:

1. `npm run label` boots the server and prints the URL.
2. `npm run check` exits 0.
3. `npm test` exits 0, including the three new test files.
4. All 192 challenges can be labeled end-to-end through the UI without data loss.
5. After all rounds and dispute resolutions, `dataset/manual-labels.jsonl` contains exactly one `kind: "final"` entry per challenge that was not skipped. Skipped challenges count as completed rounds but do not produce a `final` entry.
6. `label-state.json` reports `currentIndex == totalRounds == 384` and `disputes` empty. If any challenge was skipped, its `kind: "skipped"` entries (one per round it appeared in) are present in `manual-labels.jsonl`.
7. Killing and restarting the server mid-session preserves labeled work and resumes on the next unlabeled round.

## Files

| File | Action | Purpose |
|---|---|---|
| `scripts/captcha-label-server.mjs` | create | Single-file HTTP server with inline HTML, queue, persistence |
| `test/captcha-label-queue.test.ts` | create | Pure unit tests for the queue |
| `test/captcha-label-server.test.ts` | create | HTTP integration tests |
| `test/captcha-label-recovery.test.ts` | create | Server crash and resume |
| `package.json` | modify | Add `"label": "tsx scripts/captcha-label-server.mjs"` script |

No changes to `src/main/services/captcha/**`, no changes to `signer.ts`, no changes to `nine-photo.ts`, no changes to runtime solvers.

## Roadmap fit

Plan 2d finishes what Plan 2c could not: it replaces the auto-generated `targetClass` ground truth with operator-verified cell selections. Plan 3 (separate design after Plan 2d lands) will choose what to do with these labels: a runtime matcher, a fresh training run, or a manual-assist operation mode. Plan 3 is intentionally not in scope here so the Plan 2d deliverable stays small and reviewable.
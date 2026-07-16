# GeeTest Captcha Solver — Plan 2c: Nine Photo Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Plan 2c pipeline that trains and integrates a lightweight `nine_photo.onnx` classifier for real GeeTest `nine` photo cells, replacing the failed icon-ONNX-on-cells path.

**Architecture:** Keep the proven `IconClassifier` for the black silhouette question and add a separate `PhotoClassifier` for real RGB photo cells. Offline scripts collect raw challenges, CLIP-label likely-positive cells, generate a human review gallery, train MobileNetV3-Small with ImageNet preprocessing, and export `assets/captcha/nine_photo.onnx` plus `assets/captcha/nine_classes.json`. Runtime `nine-photo.ts` classifies the question with `IconClassifier`, classifies the 9 grid cells with `PhotoClassifier`, then returns the `nineNums` cells with the strongest score for the target class.

**Tech Stack:** TypeScript ESM/NodeNext strict, `tsx`, `patchright`, `onnxruntime-node`, `pngjs`, `jpeg-js`, `node:test`; offline Python with `torch`, `torchvision`, `onnx`, `onnxruntime`, `Pillow`, and `GeekedTest-main/geeked/clip_shared.py` (`open_clip`).

## Global Constraints

- Repo is `C:\Users\henoc\OneDrive\Área de Trabalho\Projetos\SpiderBOT\spider-bot-desktop`, branch `feat/solver-captcha-ts`; do not switch to the monorepo.
- TS ESM, strict, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`; imports from TS source use `.js`.
- Scripts with `.mjs` run via `npx tsx scripts/<name>.mjs`; `.mjs` files must contain plain JavaScript, not TypeScript-only syntax.
- Gate command is `npm run check` (`tsc -p tsconfig.electron.json --noEmit && tsc -p tsconfig.renderer.json --noEmit`); tests are `npm test` (`tsx --test test/*.test.ts`).
- `IconClassifier` (`assets/captcha/geetest_v4_icon.onnx` + `charsets.json`) is proven for silhouette questions; do not retrain or replace it.
- Runtime Python/CLIP/torch are forbidden. Python is offline-only for labeling and training; no `postinstall` or packaged runtime dependency may be added for Plan 2c.
- Photo preprocessing must match train and runtime exactly: resize 64x64 bilinear, RGB, ImageNet normalization `mean=[0.485,0.456,0.406]`, `std=[0.229,0.224,0.225]`, values from `px/255`.
- Augmentation may not flip horizontally, flip vertically, or rotate; those invert direction labels. Allowed: color jitter plus mild scale/translation.
- Training must use weighted sampling or an equivalent class-balancing strategy; target is roughly 150-200 labeled photos per class.
- Offline acceptance before live Gate 3: held-out top-1 accuracy >=90% and PyTorch-vs-ONNX parity on 50 held-out samples with matching argmax and top-5 class sets.
- Live Gate 3 acceptance: `scripts/captcha-gate3-nine.mjs` with N=15 must reach >=90%.
- `src/main/services/captcha/solvers/nine.ts` is the failed Gate 2 solver and becomes dead after rewire; cleanup remains Plan 3.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/captcha-collect-nine-dataset.mjs` | Capture live `nine` challenges into `dataset/raw/<id>/` with `grid.jpg`, `ques.png`, and `meta.json` containing `targetClass` from `IconClassifier`, `nineNums`, source paths, and GeeTest IDs. |
| `scripts/captcha-nine-dataset-utils.mjs` | Shared JS helpers for dataset paths, 3x3 cell extraction, label manifest IO, and deterministic sorting. |
| `test/captcha-nine-dataset-utils.test.ts` | Fast tests for cell extraction and manifest sorting, without browser/network. |
| `scripts/captcha-autolabel-clip.py` | Offline CLIP autolabeler: score the 9 cells against the question silhouette, copy top `nineNums` cells to `dataset/labeled/<targetClass>/`, and write `dataset/labels.jsonl`. |
| `scripts/captcha-review-gallery.mjs` | Generate `dataset/review.html` sorted by ascending CLIP confidence; apply `review-decisions.json` by moving rejected cells to `dataset/flagged/`. |
| `scripts/captcha-train-photo.py` | Train MobileNetV3-Small on reviewed labels, export `assets/captcha/nine_photo.onnx` and `assets/captcha/nine_classes.json`, and validate ONNX parity. |
| `requirements-ml.txt` | Offline-only training/labeling dependencies. |
| `src/main/services/captcha/onnx-session.ts` | Add `PhotoClassifier`, ImageNet RGB preprocessing helpers, and model path resolution beside the existing `IconClassifier`. |
| `src/main/services/captcha/solvers/nine-photo.ts` | New `findIconCellsPhoto(gridBuf, quesBuf, nineNums)` runtime solver using `IconClassifier` + `PhotoClassifier`. |
| `test/captcha-photo-classifier.test.ts` | Tests pure RGB preprocessing and target-cell ranking without requiring the trained ONNX file. |
| `src/main/services/captcha/signer.ts` | Rewire `riskType === 'nine'` from `./solvers/nine.js` to `./solvers/nine-photo.js`. |
| `scripts/captcha-gate3-nine.mjs` | Live Gate 3 harness with model-file guard and `try/finally` browser cleanup. |
| `docs/adr/0003-solver-de-captcha-em-ts.md` and `docs/adr/README.md` | Record the Plan 2c result only after Gate 3 has evidence. |

---

### Task 1: Dataset Utilities And Collector

**Files:**
- Create: `scripts/captcha-nine-dataset-utils.mjs`
- Create: `scripts/captcha-collect-nine-dataset.mjs`
- Create: `test/captcha-nine-dataset-utils.test.ts`

**Interfaces:**
- Produces: `splitGridCells(rgba, width, height) -> Array<{ row, col, data, width, height }>` where `row`/`col` are 1-indexed.
- Produces: `writeJsonlLine(path, value)` and `readJsonl(path)` for later label metadata.
- Produces: `npx tsx scripts/captcha-collect-nine-dataset.mjs --count 2000 --out dataset/raw` writing one challenge directory per success.

- [ ] **Step 1: Write failing tests for utilities**

Create `test/captcha-nine-dataset-utils.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitGridCells, writeJsonlLine, readJsonl } from '../scripts/captcha-nine-dataset-utils.mjs';

test('splitGridCells returns 9 1-indexed cells in reading order', () => {
  const w = 6;
  const h = 6;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cellId = Math.floor(y / 2) * 3 + Math.floor(x / 2) + 1;
      const i = (y * w + x) * 4;
      rgba[i] = cellId;
      rgba[i + 1] = cellId;
      rgba[i + 2] = cellId;
      rgba[i + 3] = 255;
    }
  }

  const cells = splitGridCells(rgba, w, h);
  assert.equal(cells.length, 9);
  assert.deepEqual(cells.map((c) => [c.row, c.col]), [
    [1, 1], [1, 2], [1, 3],
    [2, 1], [2, 2], [2, 3],
    [3, 1], [3, 2], [3, 3],
  ]);
  assert.equal(cells[0]?.width, 2);
  assert.equal(cells[0]?.height, 2);
  assert.equal(cells[8]?.data[0], 9);
});

test('jsonl helpers append and read deterministic objects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'captcha-nine-jsonl-'));
  const file = join(dir, 'labels.jsonl');
  writeJsonlLine(file, { id: 'b', score: 0.2 });
  writeJsonlLine(file, { id: 'a', score: 0.9 });
  assert.deepEqual(readJsonl(file), [{ id: 'b', score: 0.2 }, { id: 'a', score: 0.9 }]);
  assert.match(readFileSync(file, 'utf8'), /"id":"b"/);
});
```

- [ ] **Step 2: Run failing test**

Run: `npx tsx --test test/captcha-nine-dataset-utils.test.ts`

Expected: FAIL with module-not-found for `captcha-nine-dataset-utils.mjs`.

- [ ] **Step 3: Implement dataset helpers**

Create `scripts/captcha-nine-dataset-utils.mjs`:

```js
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';

export function decodeRgba(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const decoded = jpeg.decode(buf, { useTArray: true });
    return { data: new Uint8Array(decoded.data), width: decoded.width, height: decoded.height };
  }
  const decoded = PNG.sync.read(buf);
  return { data: new Uint8Array(decoded.data), width: decoded.width, height: decoded.height };
}

export function splitGridCells(rgba, width, height) {
  const cellWidth = Math.floor(width / 3);
  const cellHeight = Math.floor(height / 3);
  const cells = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const data = new Uint8Array(cellWidth * cellHeight * 4);
      for (let y = 0; y < cellHeight; y++) {
        for (let x = 0; x < cellWidth; x++) {
          const source = ((row * cellHeight + y) * width + (col * cellWidth + x)) * 4;
          const dest = (y * cellWidth + x) * 4;
          data[dest] = rgba[source];
          data[dest + 1] = rgba[source + 1];
          data[dest + 2] = rgba[source + 2];
          data[dest + 3] = rgba[source + 3];
        }
      }
      cells.push({ row: row + 1, col: col + 1, data, width: cellWidth, height: cellHeight });
    }
  }
  return cells;
}

export function writeJsonlLine(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(value)}\n`);
}

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inline] = arg.slice(2).split('=');
    out[rawKey] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
  }
  return out;
}
```

- [ ] **Step 4: Run utility test green**

Run: `npx tsx --test test/captcha-nine-dataset-utils.test.ts`

Expected: PASS.

- [ ] **Step 5: Implement live collector**

Create `scripts/captcha-collect-nine-dataset.mjs`:

```js
import { chromium } from 'patchright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GeetestClient } from '../src/main/services/captcha/geetest-client.js';
import { getClassifier } from '../src/main/services/captcha/onnx-session.js';
import { decodeImage } from '../src/main/services/captcha/image-utils.js';
import { parseArgs } from './captcha-nine-dataset-utils.mjs';

const args = parseArgs(process.argv.slice(2));
const count = Number(args.count ?? 100);
const outRoot = String(args.out ?? 'dataset/raw');
const delayMs = Number(args.delayMs ?? 500);
const demoUrl = 'https://gt4.geetest.com/demov4/nine-popup-en.html';

async function captureCaptchaId(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let captchaId = null;
  page.on('request', (request) => {
    const match = request.url().match(/captcha_id=([a-f0-9]+)/);
    if (match) captchaId = match[1];
  });
  try {
    await page.goto(demoUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const button = await page.$('.geetest_btn_click, [class*="geetest_btn_click"]');
    if (button) await button.click();
    await page.waitForTimeout(2000);
    if (!captchaId) throw new Error('no captcha_id captured from demo page');
    return captchaId;
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  const captchaId = await captureCaptchaId(browser);
  const context = await browser.newContext();
  const client = new GeetestClient(context.request, 'https://gcaptcha4.geevisit.com');
  const classifier = getClassifier();
  mkdirSync(outRoot, { recursive: true });
  console.log(`captcha_id=${captchaId}`);

  for (let i = 0; i < count; i++) {
    const data = await client.load(captchaId, 'nine');
    const quesPaths = Array.isArray(data.ques) ? data.ques : [];
    const quesPath = typeof quesPaths[0] === 'string' ? quesPaths[0] : null;
    if (!data.imgs || !quesPath) throw new Error(`challenge ${i}: missing imgs or ques path`);
    const grid = await client.fetchImage(data.imgs);
    const ques = await client.fetchImage(quesPath);
    const decodedQues = decodeImage(ques);
    const target = await classifier.classify(decodedQues.data, decodedQues.width, decodedQues.height);
    const id = `${String(i).padStart(6, '0')}-${data.lot_number}`;
    const dir = join(outRoot, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'grid.jpg'), grid);
    writeFileSync(join(dir, 'ques.png'), ques);
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({
      id,
      captchaId,
      lotNumber: data.lot_number,
      targetClass: target.label,
      targetScore: target.score,
      nineNums: Number(data.nine_nums ?? 3),
      gridPath: data.imgs,
      quesPath,
      capturedAt: new Date().toISOString(),
    }, null, 2));
    console.log(`[${i + 1}/${count}] ${id} target=${target.label}`);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
} finally {
  await browser.close();
}
```

- [ ] **Step 6: Smoke the collector with one challenge**

Run: `npx tsx scripts/captcha-collect-nine-dataset.mjs --count 1 --out dataset/raw-smoke`

Expected: creates `dataset/raw-smoke/<id>/grid.jpg`, `ques.png`, `meta.json` with `targetClass` such as `plane_d`.

- [ ] **Step 7: Full verification**

Run: `npm run check && npm test`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/captcha-nine-dataset-utils.mjs scripts/captcha-collect-nine-dataset.mjs test/captcha-nine-dataset-utils.test.ts
git commit -m "feat(captcha): collect raw nine photo dataset"
```

---

### Task 2: CLIP Autolabeler And Review Gallery

**Files:**
- Create: `scripts/captcha-autolabel-clip.py`
- Create: `scripts/captcha-review-gallery.mjs`

**Interfaces:**
- Consumes: `dataset/raw/<id>/{grid.jpg,ques.png,meta.json}` from Task 1.
- Produces: `dataset/labeled/<class>/<challenge>__r<row>c<col>.jpg` and `dataset/labels.jsonl`.
- Produces: `dataset/review.html`; applying `review-decisions.json` moves rejected cells to `dataset/flagged/<class>/`.

- [ ] **Step 1: Implement CLIP autolabeler**

Create `scripts/captcha-autolabel-clip.py`:

```python
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "GeekedTest-main"))
from geeked.clip_shared import encode_images  # noqa: E402


def rgba_to_rgb_white(path: Path) -> np.ndarray:
    img = Image.open(path).convert("RGBA")
    rgba = np.asarray(img).astype(np.float32) / 255.0
    rgb = rgba[:, :, :3]
    alpha = rgba[:, :, 3:4]
    return ((rgb * alpha + np.ones_like(rgb) * (1.0 - alpha)) * 255.0).astype(np.uint8)


def grid_cells(path: Path) -> list[tuple[int, int, Image.Image, np.ndarray]]:
    img = Image.open(path).convert("RGB")
    w, h = img.size
    cw, ch = w // 3, h // 3
    cells = []
    for row in range(3):
        for col in range(3):
            crop = img.crop((col * cw, row * ch, (col + 1) * cw, (row + 1) * ch))
            cells.append((row + 1, col + 1, crop, np.asarray(crop)))
    return cells


def iter_challenges(raw_root: Path) -> Iterable[Path]:
    for child in sorted(raw_root.iterdir()):
        if child.is_dir() and (child / "grid.jpg").exists() and (child / "ques.png").exists() and (child / "meta.json").exists():
            yield child


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", default="dataset/raw")
    parser.add_argument("--out", default="dataset/labeled")
    parser.add_argument("--manifest", default="dataset/labels.jsonl")
    parser.add_argument("--min-score", type=float, default=-1.0)
    args = parser.parse_args()

    raw_root = Path(args.raw)
    out_root = Path(args.out)
    manifest = Path(args.manifest)
    out_root.mkdir(parents=True, exist_ok=True)
    manifest.parent.mkdir(parents=True, exist_ok=True)

    written = 0
    with manifest.open("w", encoding="utf-8") as mf:
        for challenge in iter_challenges(raw_root):
            meta = json.loads((challenge / "meta.json").read_text(encoding="utf-8"))
            target = meta["targetClass"]
            nine_nums = int(meta.get("nineNums", 3))
            ques_rgb = rgba_to_rgb_white(challenge / "ques.png")
            cells = grid_cells(challenge / "grid.jpg")
            embs = encode_images([ques_rgb] + [cell[3] for cell in cells])
            query = embs[0]
            scores = (embs[1:] @ query.T).flatten()
            ranked = sorted(
                [(float(scores[i]), cells[i][0], cells[i][1], cells[i][2]) for i in range(len(cells))],
                reverse=True,
                key=lambda item: item[0],
            )
            for rank, (score, row, col, crop) in enumerate(ranked[:nine_nums], start=1):
                if score < args.min_score:
                    continue
                class_dir = out_root / target
                class_dir.mkdir(parents=True, exist_ok=True)
                name = f"{challenge.name}__r{row}c{col}.jpg"
                rel = Path("dataset/labeled") / target / name
                crop.save(out_root / target / name, quality=95)
                mf.write(json.dumps({
                    "challengeId": challenge.name,
                    "targetClass": target,
                    "row": row,
                    "col": col,
                    "rank": rank,
                    "clipScore": score,
                    "cellPath": str(rel).replace("\\\\", "/"),
                    "gridPath": str(challenge / "grid.jpg").replace("\\\\", "/"),
                    "quesPath": str(challenge / "ques.png").replace("\\\\", "/"),
                }, separators=(",", ":")) + "\n")
                written += 1
    print(f"labeled_cells={written}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Smoke autolabeler on the Task 1 smoke dataset**

Run: `python scripts/captcha-autolabel-clip.py --raw dataset/raw-smoke --out dataset/labeled-smoke --manifest dataset/labels-smoke.jsonl`

Expected: writes three labeled JPGs for a normal `nineNums=3` smoke challenge. If Python dependencies are missing, report the exact missing import and continue to Task 2 Step 3; this script is offline-only.

- [ ] **Step 3: Implement review gallery**

Create `scripts/captcha-review-gallery.mjs`:

```js
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs, readJsonl } from './captcha-nine-dataset-utils.mjs';

const args = parseArgs(process.argv.slice(2));
const manifest = String(args.manifest ?? 'dataset/labels.jsonl');
const out = String(args.out ?? 'dataset/review.html');
const apply = args.apply ? String(args.apply) : null;

function rel(path) {
  return path.replaceAll('\\', '/');
}

if (apply) {
  const decisions = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(apply, 'utf8')));
  const rejected = new Set(decisions.rejected ?? []);
  for (const row of readJsonl(manifest)) {
    if (!rejected.has(row.cellPath)) continue;
    const target = join('dataset', 'flagged', row.targetClass, basename(row.cellPath));
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(row.cellPath)) renameSync(row.cellPath, target);
  }
  console.log(`flagged=${rejected.size}`);
  process.exit(0);
}

const rows = readJsonl(manifest).sort((a, b) => a.clipScore - b.clipScore);
const cards = rows.map((row) => `
  <article class="card" data-cell="${row.cellPath}">
    <label><input type="checkbox" class="reject" value="${row.cellPath}"> errado</label>
    <img src="../${rel(row.cellPath)}" alt="${row.targetClass} ${row.challengeId}">
    <p><b>${row.targetClass}</b> score=${row.clipScore.toFixed(4)} row=${row.row} col=${row.col}</p>
    <p><a href="../${rel(row.gridPath)}">grid</a> <a href="../${rel(row.quesPath)}">ques</a></p>
  </article>`).join('\n');

const html = `<!doctype html>
<meta charset="utf-8">
<title>GeeTest nine review</title>
<style>
body{font-family:system-ui,Segoe UI,sans-serif;margin:24px;background:#f6f7f9;color:#1f2328}
.toolbar{position:sticky;top:0;background:#fff;border:1px solid #d0d7de;padding:12px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px}
.card{background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:10px}
img{width:100%;aspect-ratio:1/1;object-fit:cover}
p{font-size:12px;line-height:1.35}
</style>
<div class="toolbar">
  <button id="download">Baixar review-decisions.json</button>
  <span id="count"></span>
</div>
<section class="grid">${cards}</section>
<script>
function update(){count.textContent=document.querySelectorAll('.reject:checked').length+' rejeitadas';}
document.addEventListener('change', update); update();
download.onclick=()=>{const rejected=[...document.querySelectorAll('.reject:checked')].map(x=>x.value);const blob=new Blob([JSON.stringify({rejected},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='review-decisions.json';a.click();}
</script>`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(out);
```

- [ ] **Step 4: Smoke review gallery**

Run: `npx tsx scripts/captcha-review-gallery.mjs --manifest dataset/labels-smoke.jsonl --out dataset/review-smoke.html`

Expected: creates an HTML gallery sorted from lowest CLIP score to highest.

- [ ] **Step 5: Full verification**

Run: `npm run check && npm test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/captcha-autolabel-clip.py scripts/captcha-review-gallery.mjs
git commit -m "feat(captcha): autolabel and review nine photo cells"
```

---

### Task 3: Photo Training Script

**Files:**
- Create: `scripts/captcha-train-photo.py`
- Create: `requirements-ml.txt`

**Interfaces:**
- Consumes: reviewed `dataset/labeled/<class>/*.jpg` after flagged cells have been moved out.
- Produces: `assets/captcha/nine_photo.onnx` and `assets/captcha/nine_classes.json`.
- Produces CLI: `python scripts/captcha-train-photo.py --data dataset/labeled --epochs 12 --batch-size 128 --device cuda`.

- [ ] **Step 1: Add offline requirements**

Create `requirements-ml.txt`:

```txt
torch
torchvision
onnx
onnxruntime
Pillow
numpy
open_clip_torch
```

- [ ] **Step 2: Implement training script**

Create `scripts/captcha-train-photo.py`:

```python
from __future__ import annotations

import argparse
import json
import random
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from PIL import Image
from torch import nn
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler
from torchvision import models, transforms

MEAN = [0.485, 0.456, 0.406]
STD = [0.229, 0.224, 0.225]


@dataclass(frozen=True)
class Sample:
    path: Path
    label: int


class NinePhotoDataset(Dataset):
    def __init__(self, samples: list[Sample], transform: transforms.Compose):
        self.samples = samples
        self.transform = transform

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int):
        sample = self.samples[idx]
        image = Image.open(sample.path).convert("RGB")
        return self.transform(image), sample.label


def load_classes(path: Path) -> list[str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    classes = data.get("charset", data)
    if not isinstance(classes, list) or len(classes) != 40:
        raise ValueError(f"{path} must contain 40 classes")
    return [str(c) for c in classes]


def collect_samples(data_root: Path, classes: list[str]) -> list[Sample]:
    class_to_idx = {name: idx for idx, name in enumerate(classes)}
    samples: list[Sample] = []
    for cls in classes:
        for path in sorted((data_root / cls).glob("*.jpg")):
            samples.append(Sample(path=path, label=class_to_idx[cls]))
    if not samples:
        raise ValueError(f"no jpg samples found under {data_root}")
    return samples


def stratified_split(samples: list[Sample], seed: int):
    by_class: dict[int, list[Sample]] = {}
    for sample in samples:
        by_class.setdefault(sample.label, []).append(sample)
    rng = random.Random(seed)
    train: list[Sample] = []
    val: list[Sample] = []
    test: list[Sample] = []
    for cls_samples in by_class.values():
        rng.shuffle(cls_samples)
        n = len(cls_samples)
        n_test = max(1, round(n * 0.10))
        n_val = max(1, round(n * 0.10))
        test.extend(cls_samples[:n_test])
        val.extend(cls_samples[n_test:n_test + n_val])
        train.extend(cls_samples[n_test + n_val:])
    return train, val, test


def make_model(num_classes: int) -> nn.Module:
    weights = models.MobileNet_V3_Small_Weights.IMAGENET1K_V1
    model = models.mobilenet_v3_small(weights=weights)
    in_features = model.classifier[-1].in_features
    model.classifier[-1] = nn.Linear(in_features, num_classes)
    return model


def transforms_for_train():
    return transforms.Compose([
        transforms.Resize((64, 64), interpolation=transforms.InterpolationMode.BILINEAR, antialias=True),
        transforms.ColorJitter(brightness=0.18, contrast=0.18, saturation=0.18),
        transforms.RandomAffine(degrees=0, translate=(0.06, 0.06), scale=(0.92, 1.08)),
        transforms.ToTensor(),
        transforms.Normalize(mean=MEAN, std=STD),
    ])


def transforms_for_eval():
    return transforms.Compose([
        transforms.Resize((64, 64), interpolation=transforms.InterpolationMode.BILINEAR, antialias=True),
        transforms.ToTensor(),
        transforms.Normalize(mean=MEAN, std=STD),
    ])


def weighted_sampler(samples: list[Sample]) -> WeightedRandomSampler:
    counts: dict[int, int] = {}
    for sample in samples:
        counts[sample.label] = counts.get(sample.label, 0) + 1
    weights = [1.0 / counts[sample.label] for sample in samples]
    return WeightedRandomSampler(weights, num_samples=len(samples), replacement=True)


@torch.inference_mode()
def accuracy(model: nn.Module, loader: DataLoader, device: torch.device) -> float:
    model.eval()
    good = 0
    total = 0
    for x, y in loader:
        x = x.to(device)
        y = y.to(device)
        pred = model(x).argmax(dim=1)
        good += int((pred == y).sum().item())
        total += int(y.numel())
    return good / max(total, 1)


def export_onnx(model: nn.Module, output: Path, device: torch.device):
    model.eval()
    dummy = torch.zeros(1, 3, 64, 64, device=device)
    output.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        dummy,
        output,
        input_names=["input"],
        output_names=["logits"],
        opset_version=17,
        dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}},
    )


@torch.inference_mode()
def verify_onnx_parity(model: nn.Module, onnx_path: Path, samples: list[Sample], transform, device: torch.device):
    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    chosen = samples[:50]
    for sample in chosen:
        tensor = transform(Image.open(sample.path).convert("RGB")).unsqueeze(0)
        torch_logits = model(tensor.to(device)).cpu().numpy()[0]
        onnx_logits = session.run(["logits"], {"input": tensor.numpy()})[0][0]
        if int(torch_logits.argmax()) != int(onnx_logits.argmax()):
            raise AssertionError(f"argmax parity failed for {sample.path}")
        if set(np.argsort(torch_logits)[-5:]) != set(np.argsort(onnx_logits)[-5:]):
            raise AssertionError(f"top5 parity failed for {sample.path}")
    print(f"onnx_parity=ok samples={len(chosen)}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="dataset/labeled")
    parser.add_argument("--classes", default="assets/captcha/charsets.json")
    parser.add_argument("--out-model", default="assets/captcha/nine_photo.onnx")
    parser.add_argument("--out-classes", default="assets/captcha/nine_classes.json")
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = parser.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    classes = load_classes(Path(args.classes))
    samples = collect_samples(Path(args.data), classes)
    train, val, test = stratified_split(samples, args.seed)
    device = torch.device(args.device)

    train_ds = NinePhotoDataset(train, transforms_for_train())
    val_ds = NinePhotoDataset(val, transforms_for_eval())
    test_ds = NinePhotoDataset(test, transforms_for_eval())
    train_loader = DataLoader(train_ds, batch_size=args.batch_size, sampler=weighted_sampler(train), num_workers=2)
    val_loader = DataLoader(val_ds, batch_size=args.batch_size, shuffle=False, num_workers=2)
    test_loader = DataLoader(test_ds, batch_size=args.batch_size, shuffle=False, num_workers=2)

    model = make_model(len(classes)).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    loss_fn = nn.CrossEntropyLoss()
    best_state = None
    best_val = -1.0
    for epoch in range(1, args.epochs + 1):
        model.train()
        for x, y in train_loader:
            x = x.to(device)
            y = y.to(device)
            optimizer.zero_grad(set_to_none=True)
            loss = loss_fn(model(x), y)
            loss.backward()
            optimizer.step()
        val_acc = accuracy(model, val_loader, device)
        print(f"epoch={epoch} val_acc={val_acc:.4f}")
        if val_acc > best_val:
            best_val = val_acc
            best_state = {k: v.detach().cpu() for k, v in model.state_dict().items()}
    if best_state is not None:
        model.load_state_dict(best_state)
    test_acc = accuracy(model, test_loader, device)
    print(f"heldout_top1={test_acc:.4f}")
    if test_acc < 0.90:
        raise SystemExit("held-out top1 below 0.90; collect/review more data before exporting")
    export_onnx(model, Path(args.out_model), device)
    Path(args.out_classes).write_text(json.dumps({
        "charset": classes,
        "input": {"width": 64, "height": 64, "channels": 3, "mean": MEAN, "std": STD, "resize": "bilinear"},
        "source": "Plan 2c MobileNetV3-Small ImageNet fine-tune",
    }, indent=2), encoding="utf-8")
    verify_onnx_parity(model, Path(args.out_model), test, transforms_for_eval(), device)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 3: Help smoke**

Run: `python scripts/captcha-train-photo.py --help`

Expected: prints CLI usage and exits 0.

- [ ] **Step 4: Full training command after dataset review**

Run after collecting and reviewing enough data:

```bash
python scripts/captcha-train-photo.py --data dataset/labeled --epochs 12 --batch-size 128 --device cuda
```

Expected: prints `heldout_top1=0.9000` or higher, writes `assets/captcha/nine_photo.onnx`, writes `assets/captcha/nine_classes.json`, and prints `onnx_parity=ok samples=50`.

- [ ] **Step 5: Commit script before training artifacts if full training is not yet available**

```bash
git add requirements-ml.txt scripts/captcha-train-photo.py
git commit -m "feat(captcha): train nine photo classifier"
```

- [ ] **Step 6: Commit trained artifacts after acceptance**

```bash
git add assets/captcha/nine_photo.onnx assets/captcha/nine_classes.json
git commit -m "feat(captcha): add trained nine photo ONNX model"
```

---

### Task 4: Runtime PhotoClassifier And Solver

**Files:**
- Modify: `src/main/services/captcha/onnx-session.ts`
- Create: `src/main/services/captcha/solvers/nine-photo.ts`
- Create: `test/captcha-photo-classifier.test.ts`

**Interfaces:**
- Produces: `normalizePhotoRgbForImageNet(rgba,w,h): Float32Array` with `[1,3,64,64]` CHW layout values.
- Produces: `class PhotoClassifier { classify(rgba,w,h): Promise<PhotoClassifyResult> }`.
- Produces: `findIconCellsPhoto(gridBuf, quesBuf, nineNums): Promise<Array<[number, number]>>`.
- Produces: pure `rankPhotoCellsForTarget(targetLabel, cells, nineNums)` for tests and deterministic ranking.

- [ ] **Step 1: Write failing tests**

Create `test/captcha-photo-classifier.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhotoRgbForImageNet } from '../src/main/services/captcha/onnx-session.js';
import { rankPhotoCellsForTarget } from '../src/main/services/captcha/solvers/nine-photo.js';

test('normalizePhotoRgbForImageNet returns CHW ImageNet-normalized 64x64 RGB', () => {
  const rgba = new Uint8Array(2 * 2 * 4);
  rgba.set([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255,
  ]);
  const out = normalizePhotoRgbForImageNet(rgba, 2, 2);
  assert.equal(out.length, 3 * 64 * 64);
  assert.ok(Number.isFinite(out[0]));
  assert.ok(Math.abs(out[0]! - ((1 - 0.485) / 0.229)) < 0.0001);
  assert.ok(Math.abs(out[64 * 64]! - ((0 - 0.456) / 0.224)) < 0.0001);
  assert.ok(Math.abs(out[2 * 64 * 64]! - ((0 - 0.406) / 0.225)) < 0.0001);
});

test('rankPhotoCellsForTarget prefers target score and keeps 1-indexed cells', () => {
  const ranked = rankPhotoCellsForTarget('plane_d', [
    { row: 1, col: 1, label: 'car_r', score: 0.9, targetScore: 0.1 },
    { row: 1, col: 2, label: 'plane_d', score: 0.7, targetScore: 0.7 },
    { row: 3, col: 3, label: 'plane_d', score: 0.5, targetScore: 0.8 },
  ], 2);
  assert.deepEqual(ranked, [[3, 3], [1, 2]]);
});
```

- [ ] **Step 2: Run failing tests**

Run: `npx tsx --test test/captcha-photo-classifier.test.ts`

Expected: FAIL because `normalizePhotoRgbForImageNet` and `nine-photo.ts` do not exist.

- [ ] **Step 3: Extend `onnx-session.ts`**

Add these exports while leaving `IconClassifier` behavior unchanged:

```ts
const PHOTO_MODEL = resolveCaptchaAsset('nine_photo.onnx');
const PHOTO_CLASSES_PATH = resolveCaptchaAsset('nine_classes.json');
const PHOTO_MEAN = [0.485, 0.456, 0.406] as const;
const PHOTO_STD = [0.229, 0.224, 0.225] as const;

function resolveCaptchaAsset(name: string): string {
  const r = process.resourcesPath;
  if (r) {
    const p = join(r, 'assets', 'captcha', name);
    try { readFileSync(p); return p; } catch {}
  }
  return join(__dirname, '..', '..', '..', '..', 'assets', 'captcha', name);
}

export function normalizePhotoRgbForImageNet(rgba: Uint8Array, w: number, h: number): Float32Array {
  const input = decodeToMat(rgba, w, h);
  const resized = resize(input, 64, 64, 'INTER_LINEAR');
  input.delete();
  try {
    const arr = new Float32Array(3 * 64 * 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const src = (y * 64 + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          arr[ch * 64 * 64 + y * 64 + x] = ((resized.data[src + ch]! / 255) - PHOTO_MEAN[ch]) / PHOTO_STD[ch];
        }
      }
    }
    return arr;
  } finally {
    resized.delete();
  }
}

function softmax(values: Float32Array): Float32Array {
  let max = -Infinity;
  for (const value of values) max = Math.max(max, value);
  let sum = 0;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    out[i] = Math.exp(values[i]! - max);
    sum += out[i]!;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / sum;
  return out;
}

export interface PhotoClassifyResult extends ClassifyResult {
  scores: Record<string, number>;
  scoreFor(label: string): number;
}

export class PhotoClassifier {
  private session: ort.InferenceSession | undefined;
  private classes: string[] | undefined;

  private async ensure(): Promise<ort.InferenceSession> {
    if (!this.session) this.session = await ort.InferenceSession.create(PHOTO_MODEL);
    return this.session;
  }

  private ensureClasses(): string[] {
    if (!this.classes) {
      const parsed = JSON.parse(readFileSync(PHOTO_CLASSES_PATH, 'utf8'));
      this.classes = parsed.charset;
    }
    return this.classes;
  }

  async classify(rgba: Uint8Array, w: number, h: number): Promise<PhotoClassifyResult> {
    const session = await this.ensure();
    const classes = this.ensureClasses();
    const tensor = new ort.Tensor('float32', normalizePhotoRgbForImageNet(rgba, w, h), [1, 3, 64, 64]);
    const out = await session.run({ input: tensor });
    const logits = out.logits?.data as Float32Array | undefined;
    if (!logits || logits.length !== classes.length) throw new Error(`nine_photo.onnx returned ${logits?.length ?? 0} logits for ${classes.length} classes`);
    const probs = softmax(logits);
    let best = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i]! > probs[best]!) best = i;
    const scores = Object.fromEntries(classes.map((label, idx) => [label, probs[idx] ?? 0]));
    return {
      label: classes[best]!,
      score: probs[best]!,
      scores,
      scoreFor(label: string) { return scores[label] ?? 0; },
    };
  }
}

let _photoClassifier: PhotoClassifier | undefined;
export function getPhotoClassifier(): PhotoClassifier { return _photoClassifier ??= new PhotoClassifier(); }
```

Also replace the existing icon `MODEL` calculation with `resolveCaptchaAsset('geetest_v4_icon.onnx')`, and calculate `CHARSET` with `resolveCaptchaAsset('charsets.json')`, so both classifiers share path resolution.

- [ ] **Step 4: Implement `nine-photo.ts`**

Create `src/main/services/captcha/solvers/nine-photo.ts`:

```ts
import { decodeImage } from '../image-utils.js';
import { getClassifier, getPhotoClassifier, type PhotoClassifyResult } from '../onnx-session.js';

export interface RankedPhotoCell {
  row: number;
  col: number;
  label: string;
  score: number;
  targetScore: number;
}

export function rankPhotoCellsForTarget(targetLabel: string, cells: RankedPhotoCell[], nineNums: number): Array<[number, number]> {
  return [...cells]
    .sort((a, b) => b.targetScore - a.targetScore || Number(b.label === targetLabel) - Number(a.label === targetLabel) || b.score - a.score)
    .slice(0, nineNums)
    .map((cell) => [cell.row, cell.col]);
}

function cropCell(grid: { data: Uint8Array; width: number; height: number }, row: number, col: number): { data: Uint8Array; width: number; height: number } {
  const width = Math.floor(grid.width / 3);
  const height = Math.floor(grid.height / 3);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = (((row - 1) * height + y) * grid.width + ((col - 1) * width + x)) * 4;
      const dest = (y * width + x) * 4;
      data[dest] = grid.data[source]!;
      data[dest + 1] = grid.data[source + 1]!;
      data[dest + 2] = grid.data[source + 2]!;
      data[dest + 3] = grid.data[source + 3]!;
    }
  }
  return { data, width, height };
}

export async function findIconCellsPhoto(gridBuf: Buffer, quesBuf: Buffer, nineNums: number): Promise<Array<[number, number]>> {
  const icon = getClassifier();
  const photo = getPhotoClassifier();
  const grid = decodeImage(gridBuf);
  const ques = decodeImage(quesBuf);
  const target = await icon.classify(ques.data, ques.width, ques.height);
  const cells: RankedPhotoCell[] = [];
  for (let row = 1; row <= 3; row++) {
    for (let col = 1; col <= 3; col++) {
      const cell = cropCell(grid, row, col);
      const result: PhotoClassifyResult = await photo.classify(cell.data, cell.width, cell.height);
      cells.push({ row, col, label: result.label, score: result.score, targetScore: result.scoreFor(target.label) });
    }
  }
  return rankPhotoCellsForTarget(target.label, cells, nineNums);
}
```

- [ ] **Step 5: Run focused test green**

Run: `npx tsx --test test/captcha-photo-classifier.test.ts`

Expected: PASS without requiring `assets/captcha/nine_photo.onnx`.

- [ ] **Step 6: Full verification**

Run: `npm run check && npm test`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/services/captcha/onnx-session.ts src/main/services/captcha/solvers/nine-photo.ts test/captcha-photo-classifier.test.ts
git commit -m "feat(captcha): add nine photo runtime classifier"
```

---

### Task 5: Rewire Nine And Add Gate 3 Harness

**Files:**
- Modify: `src/main/services/captcha/signer.ts`
- Create: `scripts/captcha-gate3-nine.mjs`

**Interfaces:**
- Consumes: `findIconCellsPhoto(gridBuf, quesBuf, nineNums)`.
- Produces: `npx tsx scripts/captcha-gate3-nine.mjs 15`; exits 0 only when rate >=90%.

- [ ] **Step 1: Rewire `signer.ts`**

In the `riskType === 'nine'` branch, replace:

```ts
const { findIconCells } = await import('./solvers/nine.js');
...
const cells = await findIconCells(gridBuf, qBuf, Number(data.nine_nums ?? 3));
```

with:

```ts
const { findIconCellsPhoto } = await import('./solvers/nine-photo.js');
...
const cells = await findIconCellsPhoto(gridBuf, qBuf, Number(data.nine_nums ?? 3));
```

- [ ] **Step 2: Implement Gate 3 harness**

Create `scripts/captcha-gate3-nine.mjs`:

```js
import { existsSync } from 'node:fs';
import { chromium } from 'patchright';
import { GeetestClient } from '../src/main/services/captcha/geetest-client.js';
import { generateW } from '../src/main/services/captcha/signer.js';

const N = Number(process.argv[2]) || 15;
const MODEL = 'assets/captcha/nine_photo.onnx';
const CLASSES = 'assets/captcha/nine_classes.json';
const DEMO = 'https://gt4.geetest.com/demov4/nine-popup-en.html';

if (!existsSync(MODEL) || !existsSync(CLASSES)) {
  console.log(`GATE3=BLOCKED missing ${MODEL} or ${CLASSES}; run scripts/captcha-train-photo.py first`);
  process.exit(2);
}

async function captureCaptchaId(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let captchaId = null;
  page.on('request', (request) => {
    const match = request.url().match(/captcha_id=([a-f0-9]+)/);
    if (match) captchaId = match[1];
  });
  try {
    await page.goto(DEMO, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const button = await page.$('.geetest_btn_click, [class*="geetest_btn_click"]');
    if (button) await button.click();
    await page.waitForTimeout(2000);
    if (!captchaId) throw new Error('no captcha_id captured');
    return captchaId;
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  const captchaId = await captureCaptchaId(browser);
  console.log(`nine captcha_id: ${captchaId}`);
  const context = await browser.newContext();
  const client = new GeetestClient(context.request, 'https://gcaptcha4.geevisit.com');
  let ok = 0;
  for (let i = 0; i < N; i++) {
    try {
      const data = await client.load(captchaId, 'nine');
      const w = await generateW(data, captchaId, 'nine', (path) => client.fetchImage(path), () => 0);
      const result = await client.verify({
        captchaId,
        lotNumber: data.lot_number,
        payload: String(data.payload ?? ''),
        processToken: String(data.process_token ?? ''),
        w,
        riskType: 'nine',
      });
      if (result.result === 'success' || result.seccode) {
        ok++;
        console.log(`[${i + 1}/${N}] OK`);
      } else {
        console.log(`[${i + 1}/${N}] FAIL result=${result.result ?? 'unknown'}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[${i + 1}/${N}] ERR ${message.slice(0, 160)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const rate = ok / N;
  console.log(`GATE3=nine-photo rate=${(rate * 100).toFixed(1)}% (${ok}/${N})`);
  console.log(rate >= 0.9 ? 'GATE3=SUCCESS' : 'GATE3=FAIL (<90%)');
  process.exit(rate >= 0.9 ? 0 : 1);
} finally {
  await browser.close();
}
```

- [ ] **Step 3: Model guard smoke**

If the trained model does not exist yet, run:

```bash
npx tsx scripts/captcha-gate3-nine.mjs 1
```

Expected: exits 2 and prints `GATE3=BLOCKED missing assets/captcha/nine_photo.onnx or assets/captcha/nine_classes.json`.

- [ ] **Step 4: Full verification**

Run: `npm run check && npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/captcha/signer.ts scripts/captcha-gate3-nine.mjs
git commit -m "test(captcha): add Gate 3 harness for nine photo solver"
```

---

### Task 6: Gate 3 Result And ADR

**Files:**
- Create or modify: `docs/adr/0003-solver-de-captcha-em-ts.md`
- Modify: `docs/adr/README.md`
- Modify: `.superpowers/sdd/progress.md`

**Interfaces:**
- Consumes: trained `assets/captcha/nine_photo.onnx`, `assets/captcha/nine_classes.json`, and Gate 3 output.
- Produces: ADR evidence and issue-ready summary. Do not mark Plan 2c GO unless Gate 3 output is >=90%.

- [ ] **Step 1: Run required verification**

Run:

```bash
npm run check
npm test
npx tsx scripts/captcha-gate3-nine.mjs 15
```

Expected for GO: check exits 0, tests exit 0, Gate 3 prints `GATE3=SUCCESS` with rate >=90%.

- [ ] **Step 2: Write ADR only with the actual result**

If Gate 3 is GO, create `docs/adr/0003-solver-de-captcha-em-ts.md`:

```md
# ADR 0003: Solver de captcha GeeTest em TypeScript com ONNX e patchright

## Contexto

A issue #3 pede um solver de captcha confiável e leve. O solver Python atual usa CLIP/torch para `nine` e `icon`, pesa centenas de MB e degrada a automação sob carga (#8). O Gate 1 validou transporte GeeTest via `patchright`/Chromium. O Gate 2 provou que `geetest_v4_icon.onnx` classifica a silhueta, mas falha em fotos reais do `nine`.

## Problema

O desafio `nine` mistura uma pergunta em silhueta preta com 9 fotos reais coloridas. Matching pixel/shape não fecha o gap semântico. O app precisa reconhecer objeto+direção nas fotos sem embarcar Python, torch ou CLIP.

## Decisão

Manter dois modelos especializados: `geetest_v4_icon.onnx` para a pergunta em silhueta e `nine_photo.onnx` (MobileNetV3-Small, 64x64 RGB, ImageNet-pretrained) para as fotos. O pipeline de coleta, auto-rotulagem CLIP, revisão humana e treino é offline. O runtime permanece TypeScript in-process via `onnxruntime-node`.

## Consequências

O runtime fica leve e sem Python. A precisão do `nine` passa a depender de dataset revisado e pode melhorar com mais dados sem trocar a integração. `src/main/services/captcha/solvers/nine.ts` fica morto até a limpeza do Plan 3.

## Verificação

- `npm run check`: PASS em YYYY-MM-DD.
- `npm test`: PASS em YYYY-MM-DD.
- Treino offline: held-out top-1 X%, PyTorch/ONNX parity 50/50.
- Gate 3: X/15 (Y%) em YYYY-MM-DD, `GATE3=SUCCESS`.
```

Replace `X`, `Y`, and dates with the exact command output from Step 1 and the training run.

If Gate 3 is NO-GO, write a short note in `.superpowers/sdd/progress.md` with the measured rate and do not create a success ADR.

- [ ] **Step 3: Update ADR index**

Add `0003` to `docs/adr/README.md` only after writing ADR 0003.

- [ ] **Step 4: Commit result**

For GO:

```bash
git add docs/adr/0003-solver-de-captcha-em-ts.md docs/adr/README.md .superpowers/sdd/progress.md
git commit -m "docs(captcha): record nine photo solver Gate 3 decision"
```

For NO-GO:

```bash
git add .superpowers/sdd/progress.md
git commit -m "docs(captcha): record nine photo Gate 3 no-go"
```

---

## Self-Review

**1. Spec coverage:** Spec sections 5/6 map to Tasks 1-5: collect, autolabel, review, train, integrate, measure. Spec section 7 constraints are in Global Constraints and Task 3/4 code: 64x64 RGB, ImageNet mean/std, bilinear resize, no flip/rotation, weighted sampler, ONNX parity. Spec section 8 maps to Task 5/6 Gate 3. ADR/issue result maps to Task 6.

**2. Placeholder scan:** No deferred-work markers remain. The only conditional path is evidence-based: Task 6 creates ADR only when Gate 3 has real GO output.

**3. Type consistency:** `splitGridCells` is JS-only and consumed by tests/autolabel ideas; runtime uses `decodeImage` plus its own crop. `PhotoClassifier.classify` returns `PhotoClassifyResult`, consumed by `nine-photo.ts`. `findIconCellsPhoto` is the exact function `signer.ts` imports. `normalizePhotoRgbForImageNet` is exported from `onnx-session.ts` and covered by tests.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-09-geetest-captcha-solver-plan2c-nine-photo.md`.

Execution mode for this handoff is already chosen by the user: **Subagent-Driven Development**. Execute Task 1 through Task 6 in order with a fresh implementer and task reviewer per task. Stop only if the offline model/data/GPU requirement blocks Task 3/6, or if verification fails repeatedly.

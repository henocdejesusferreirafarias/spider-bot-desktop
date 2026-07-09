# GeeTest Captcha Solver — Plan 2: Vision Gate (nine + ONNX) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pluguar o classificador ONNX `geetest_v4_icon.onnx` (já no repo, hoje não usado), construir o solver `nine` e validar (Gate 2) que ele resolve `nine` do demo GeeTest v4 com taxa de sucesso alta — o go/no-go da visão.

**Architecture:** `onnx-session.ts` envolve `onnxruntime-node` (carrega o ONNX 1×, mantém quente) com o preprocessing **exato do ddddocr** (resize 64×64, grayscale, `(x/255-0.456)/0.224`, tensor `[1,1,64,64]`). `nine.ts` classifica o ícone-pergunta + 9 células do grid (3×3) e devolve as `nine_nums` células de label igual ao da pergunta (por score). `image-utils.ts` ganha `decodeImage` (PNG via `pngjs` + JPEG via `jpeg-js`) e `resize` — o grid nine é **JPEG**, o ícone-pergunta é **PNG**. Um dataset collector (patchright) e um harness de acerto medem o Gate 2.

**Tech Stack:** TypeScript (NodeNext, strict), `onnxruntime-node@1.27.0`, `opencv-wasm@4.3.0-10` (já dep), `pngjs` (já dep) + `jpeg-js@0.4.4`, `patchright ^1.60.0`, `node:test`.

**Escopo deste plano:** Plan 2 (de 3). Cobre **só `nine`** (Gate 2) — o solver de visão mais simples (grid pré-dividido em 9 células, sem detecção de bbox). `icon` (Gate 3, bbox detection) fica no **Plan 2b**. Remoção do Python/rewiring do runtime ficam no **Plan 3**. YAGNI: não treinar CNN minúscula aqui — só se o Gate 2 falhar (<90%), o que vira um Plan 2c separado.

## Global Constraints

- TS ESM, strict, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`. `tsc -p tsconfig.electron.json --noEmit` limpo é o gate (`npm run check`).
- Source em `src/main` (incluído em `tsconfig.electron.json`); testes em `test/*.test.ts` (flat, `tsx --test`, **não** typechecked). `node:test` + `node:assert/strict`. Imports com `.js`.
- Branch `feat/solver-captcha-ts` (continuação do Plan 1). Issue #3.
- Scripts de spike/collect rodam via `tsx` (não `node` — importam source TS). Scripts `.mjs` **não podem** conter sintaxe TS (ex.: `!` assertions).
- O ONNX `geetest_v4_icon.onnx` (2,4 MB) + `charsets.json` são hoje os únicos ativos reaproveitados do `GeekedTest-main/`; o resto do Python permanece intocado até o Plan 3.
- **Preprocessing exato (controller-verificado via source do ddddocr `__init__.py:2613-2640`):** resize 64×64 **quadrado** (`INTER_AREA`), grayscale, `arr[i] = (px/255 - 0.456) / 0.224`, tensor `float32 [1,1,64,64]`, input name `'input1'`. Outputs: `'output'` (logits 40-class) + `'63'` (argmax int64). Label = `charset[idx]` de `charsets.json`.

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `src/main/services/captcha/onnx-session.ts` (novo) | Carrega `geetest_v4_icon.onnx` + `charsets.json` 1× (lazy, mantém quente); `classify(rgba, w, h): { label: string; score: number }` |
| `src/main/services/captcha/image-utils.ts` (modificar) | Adicionar `decodeImage(buf)` (PNG via pngjs + JPEG via jpeg-js por magic bytes) e `resize(src, w, h, interp)` |
| `src/main/services/captcha/solvers/nine.ts` (novo) | `findIconCells(gridBuf, quesBufs, nineNums): Array<[row, col]>` — classifica pergunta + 9 células, devolve as `nineNums` de label igual (por score) |
| `scripts/captcha-collect-dataset.mjs` (novo) | patchright captura N desafios `nine` do demo (`grid_url` + `ques` + `nine_nums`), baixa imagens + grava metadados em `test/fixtures/captcha/dataset/nine/` |
| `scripts/captcha-gate2-nine.mjs` (novo) | Spike Gate 2: roda o solver nine em N desafios capturados, faz `load`+`solve`+`verify` end-to-end, imprime `GATE2=SUCCESS rate=X%` |
| `test/captcha-onnx.test.ts` (novo) | Classifica um ícone-pergunta fixture → label esperado |
| `test/captcha-nine.test.ts` (novo) | Solver nine num desafio fixture → células esperadas |
| `test/fixtures/captcha/nine/{grid.jpg, ques.png, expected.json}` (novo) | Desafio nine fixo (capturado do demo) + células esperadas (oracle Python `NineSolver`) |
| `assets/captcha/geetest_v4_icon.onnx` + `assets/captcha/charsets.json` (mover) | Movidos de `GeekedTest-main/geeked/models/` (Plan 3 removerá o resto) |
| `docs/adr/0003-solver-de-captcha-em-ts.md` (novo) | Registra a decisão após Gate 2 GO |

---

### Task 1: Scaffold — deps ONNX, mover modelo, estender image-utils

**Files:**
- Modify: `package.json` (deps), `src/main/services/captcha/image-utils.ts`
- Move: `GeekedTest-main/geeked/models/{geetest_v4_icon.onnx,charsets.json}` → `assets/captcha/`

**Interfaces:**
- Produces: deps `onnxruntime-node@1.27.0`, `jpeg-js@0.4.4`, `@types/jpeg-js` (devDep); `assets/captcha/geetest_v4_icon.onnx` + `charsets.json`; `decodeImage(buf)→{data,width,height}`, `resize(src,w,h,interp)→Mat` em image-utils.

- [ ] **Step 1: Deps**
`npm install onnxruntime-node@1.27.0 jpeg-js@0.4.4 --save --ignore-scripts && npm install -D @types/jpeg-js --ignore-scripts`

- [ ] **Step 2: Mover modelo**
`mkdir -p assets/captcha && git mv GeekedTest-main/geeked/models/geetest_v4_icon.onnx assets/captcha/ && git mv GeekedTest-main/geeked/models/charsets.json assets/captcha/`
(Não remova `GeekedTest-main/` — Plan 3 fará isso. O `dddd_server.py` que aponta p/ o caminho antigo quebra, mas o solver Python já está deprecated/stale; não rodamos ele.)

- [ ] **Step 3: Estender image-utils.ts** — adicionar `decodeImage` (PNG+JPEG por magic bytes) e `resize`:
```ts
import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';
// ...existentes...
export function decodeImage(buf: Buffer): { data: Buffer; width: number; height: number } {
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const j = jpeg.decode(buf, { useTArray: true });
    return { data: Buffer.from(j.data), width: j.width, height: j.height };
  }
  const p = PNG.sync.read(buf);
  return { data: Buffer.from(p.data), width: p.width, height: p.height };
}
export function resize(src: Mat, w: number, h: number, interp: 'INTER_AREA' | 'INTER_LINEAR' = 'INTER_AREA'): Mat {
  const dst = new cv.Mat();
  cv.resize(src as unknown as InstanceType<typeof cv.Mat>, dst, new cv.Size(w, h), 0, 0, cv[interp]);
  return dst as unknown as Mat;
}
```

- [ ] **Step 4: Verificar**
`npm run check` limpo. `node -e "import('onnxruntime-node').then(async m=>{const s=await m.InferenceSession.create('assets/captcha/geetest_v4_icon.onnx');console.log('ONNX inputs',s.inputNames,'outputs',s.outputNames)})"` → `inputs [ 'input1' ] outputs [ 'output', '63' ]`.

- [ ] **Step 5: Commit**
`git add -A && git commit -m "chore(captcha): scaffold ONNX (onnxruntime-node/jpeg-js) + move modelo p/ assets/captcha + decodeImage/resize"`

---

### Task 2: `onnx-session.ts` — classificador de ícones

**Files:**
- Create: `src/main/services/captcha/onnx-session.ts`, `test/captcha-onnx.test.ts`
- Create: `test/fixtures/captcha/nine/ques.png` (capturar um ícone-pergunta do demo; label esperado via Python `ddddocr`)

**Interfaces:**
- Produces: `class IconClassifier { classify(rgba: Uint8Array, w: number, h: number): { label: string; score: number } }` e `getClassifier(): IconClassifier` (singleton lazy).

- [ ] **Step 1: Capturar fixture** (ícone-pergunta + label esperado)
`npx tsx scripts/captcha-collect-dataset.mjs --nine --count 1` (criado na Task 3 — se a Task 3 ainda não existe, capture manualmente via patchright: goto `gt4.geetest.com/demov4/nine-popup-en.html`, click `.geetest_btn_click`, colete o `ques[0]` URL da rede, baixe p/ `test/fixtures/captcha/nine/ques.png`). Rode `python -c "import ddddocr; d=ddddocr.DdddOcr(det=False,ocr=False,show_ad=False,import_onnx_path='assets/captcha/geetest_v4_icon.onnx',charsets_path='assets/captcha/charsets.json'); print(d.classification(open('test/fixtures/captcha/nine/ques.png','rb').read()))"` → anote o label (oracle Python). Grave em `test/fixtures/captcha/nine/ques.expected.json` como `{ "label": "<oracle>" }`.

- [ ] **Step 2: Teste que falha**
`test/captcha-onnx.test.ts`:
```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getClassifier } from '../src/main/services/captcha/onnx-session.js';
import { decodeImage } from '../src/main/services/captcha/image-utils.js';

test('IconClassifier classifica o ques fixture no label esperado (oracle ddddocr)', () => {
  const expected = JSON.parse(readFileSync('test/fixtures/captcha/nine/ques.expected.json','utf8')).label;
  const { data, width, height } = decodeImage(readFileSync('test/fixtures/captcha/nine/ques.png'));
  const { label } = getClassifier().classify(data, width, height);
  assert.equal(label, expected, `esperado ${expected}, obtido ${label}`);
});
```

- [ ] **Step 3: Rodar e ver falhar** — `npx tsx --test test/captcha-onnx.test.ts` → FAIL (módulo não existe).

- [ ] **Step 4: Implementar `onnx-session.ts`**
```ts
import * as ort from 'onnxruntime-node';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from 'opencv-wasm';
import { resize, toGray, type Mat } from './image-utils.js';
const cv = pkg.cv;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL = resolveModelPath(); // assets/captcha/geetest_v4_icon.onnx (dev) ou process.resourcesPath (packaged)
function resolveModelPath(): string {
  const r = process.resourcesPath;
  if (r) { const p = join(r, 'assets', 'captcha', 'geetest_v4_icon.onnx'); try { readFileSync(p); return p; } catch {}
  }
  return join(__dirname, '..', '..', '..', '..', 'assets', 'captcha', 'geetest_v4_icon.onnx');
}
const CHARSET: string[] = JSON.parse(readFileSync(MODEL.replace('geetest_v4_icon.onnx','charsets.json'),'utf8')).charset;

export interface ClassifyResult { label: string; score: number; }
export class IconClassifier {
  private session: ort.InferenceSession | undefined;
  private async ensure(): Promise<ort.InferenceSession> {
    if (!this.session) this.session = await ort.InferenceSession.create(MODEL);
    return this.session;
  }
  async classify(rgba: Uint8Array, w: number, h: number): Promise<ClassifyResult> {
    const gray = toGray(decodeToMat(rgba, w, h));
    const r = resize(gray, 64, 64, 'INTER_AREA');
    const arr = new Float32Array(64 * 64);
    for (let i = 0; i < 4096; i++) arr[i] = (r.data[i]! / 255 - 0.456) / 0.224;
    const t = new ort.Tensor('float32', arr, [1, 1, 64, 64]);
    const out = await (await this.ensure()).run({ input1: t });
    const idx = Number((out['63'] as ort.Tensor).data[0]);
    const logits = Array.from((out['output'] as ort.Tensor).data as Float32Array);
    const score = logits[idx]!;
    gray.delete(); r.delete();
    return { label: CHARSET[idx]!, score };
  }
}
function decodeToMat(rgba: Uint8Array, w: number, h: number): Mat {
  const m = new cv.Mat(h, w, cv.CV_8UC4);
  m.data.set(rgba);
  return m as unknown as Mat;
}
let _clf: IconClassifier | undefined;
export function getClassifier(): IconClassifier { return _clf ??= new IconClassifier(); }
```
(Nota: `classify` é `async` pq `InferenceSession.run` é async. O `nine.ts` fará `await`.)

- [ ] **Step 5: Rodar e ver passar** — `npx tsx --test test/captcha-onnx.test.ts` → PASS (label == oracle ddddocr). **Se o label diferir do oracle**, o preprocessing está errado — confira `(x/255-0.456)/0.224`, resize 64×64 quadrado, `INTER_AREA`, grayscale. (Controller-verificado: produces "plane_d" p/ um ques de demo.)

- [ ] **Step 6: `npm run check`** limpo.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(captcha): onnx-session (IconClassifier com preprocessing ddddocr-exato)"`

---

### Task 3: Dataset collector (nine)

**Files:**
- Create: `scripts/captcha-collect-dataset.mjs`

**Interfaces:**
- Produces: `scripts/captcha-collect-dataset.mjs --nine --count N` → escreve `test/fixtures/captcha/dataset/nine/<i>/{grid.jpg, ques.png, meta.json}` (meta = `{captchaId, lotNumber, powDetail, pt, nineNums, quesPaths}`).

- [ ] **Step 1: Escrever o script** (baseado no padrão `demo_nine.py`, controller-verificado):
```js
import { chromium } from 'patchright';
import { writeFileSync, mkdirSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map(a => a.startsWith('--') ? [a.slice(2), true] : ['count', a]));
const COUNT = Number(args.count) || 5;
const DEMO = 'https://gt4.geetest.com/demov4/nine-popup-en.html';
const out = 'test/fixtures/captcha/dataset/nine';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });

for (let i = 0; i < COUNT; i++) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let captchaId = null, gridPath = null, ques = [];
  page.on('request', (r) => {
    const u = r.url();
    const m = u.match(/captcha_id=([a-f0-9]+)/); if (m) captchaId = m[1];
    if (u.includes('static.geetest.com/') && u.includes('/nine/') && !u.includes('nine_prompt')) gridPath = u.split('static.geetest.com/')[1];
    if (u.includes('nine_prompt')) { const p = u.split('static.geetest.com/')[1]; if (!ques.includes(p)) ques.push(p); }
  });
  await page.goto(DEMO, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(4000);
  const btn = await page.$('.geetest_btn_click, [class*="geetest_btn_click"]'); if (btn) await btn.click();
  await page.waitForTimeout(4000);
  await page.close();
  if (!gridPath || !ques.length) { console.log(`[${i}] no capture, skip`); continue; }
  const dir = `${out}/${i}`; mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/grid.jpg`, Buffer.from(await (await fetch('https://static.geetest.com/'+gridPath)).arrayBuffer()));
  writeFileSync(`${dir}/ques.png`, Buffer.from(await (await fetch('https://static.geetest.com/'+ques[0])).arrayBuffer()));
  writeFileSync(`${dir}/meta.json`, JSON.stringify({ captchaId, gridPath, quesPaths: ques, nineNums: 3 }, null, 2));
  console.log(`[${i}] captured captchaId=${captchaId}`);
}
await browser.close();
console.log('done');
```

- [ ] **Step 2: Rodar** — `npx tsx scripts/captcha-collect-dataset.mjs --nine --count 5` → cria 5 desafios em `test/fixtures/captcha/dataset/nine/`.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat(captcha): dataset collector nine (patchright)"`

---

### Task 4: `nine.ts` — solver nine

**Files:**
- Create: `src/main/services/captcha/solvers/nine.ts`, `test/captcha-nine.test.ts`
- Create: `test/fixtures/captcha/nine/grid.jpg`, `test/fixtures/captcha/nine/ques.png`, `test/fixtures/captcha/nine/expected.json` (células esperadas via oracle Python `NineSolver`)

**Interfaces:**
- Consumes: `IconClassifier.classify` (Task 2), `decodeImage` (Task 1).
- Produces: `findIconCells(gridBuf: Buffer, quesBuf: Buffer, nineNums: number): Promise<Array<[number, number]>>` (lista de `[row,col]` 1-indexed).

- [ ] **Step 1: Capturar fixture + células esperadas (oracle Python)**
`npx tsx scripts/captcha-collect-dataset.mjs --nine --count 1`, copie o `grid.jpg`+`ques.png` do `dataset/nine/0/` p/ `test/fixtures/captcha/nine/`. Rode o oracle Python p/ obter as células esperadas:
```bash
python -c "
import sys; sys.path.insert(0,'GeekedTest-main')
from geeked.nine import NineSolver
s=NineSolver('test/fixtures/captcha/nine/grid.jpg'.replace('test/fixtures/captcha/nine/',''), ['test/fixtures/captcha/nine/ques.png'.replace('test/fixtures/captcha/nine/','')], 3)
" 2>/dev/null || true
# O NineSolver usa URLs (static.geetest.com/...); p/ fixture local, reimplemente o passo ou rode o solve.py contra o captcha_id capturado e anote as células que o CLIP+verify aceitou.
```
**Atalho prático:** rode `scripts/captcha-gate2-nine.mjs` (Task 5) contra o `captchaId` do `meta.json` do desafio capturado; se o verify retornar success com as células do solver TS, essas são as esperadas. Anote em `expected.json` como `{ "cells": [[r,c],...] }`.

- [ ] **Step 2: Teste que falha**
```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findIconCells } from '../src/main/services/captcha/solvers/nine.js';

test('findIconCells devolve as células esperadas (fixture)', async () => {
  const expected = JSON.parse(readFileSync('test/fixtures/captcha/nine/expected.json','utf8')).cells;
  const grid = readFileSync('test/fixtures/captcha/nine/grid.jpg');
  const ques = readFileSync('test/fixtures/captcha/nine/ques.png');
  const cells = await findIconCells(grid, ques, 3);
  assert.deepEqual(cells.sort(), expected.sort());
});
```

- [ ] **Step 3: Rodar e ver falhar** — `npx tsx --test test/captcha-nine.test.ts` → FAIL (módulo não existe).

- [ ] **Step 4: Implementar `nine.ts`**
```ts
import { decodeImage } from '../image-utils.js';
import { getClassifier } from '../onnx-session.js';

export async function findIconCells(gridBuf: Buffer, quesBuf: Buffer, nineNums: number): Promise<Array<[number, number]>> {
  const clf = getClassifier();
  const grid = decodeImage(gridBuf);   // {data: RGBA, width, height}
  const ques = decodeImage(quesBuf);
  const cw = Math.floor(grid.width / 3), ch = Math.floor(grid.height / 3);
  const qRes = await clf.classify(ques.data, ques.width, ques.height);
  const scored: Array<{ score: number; row: number; col: number }> = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const cell = new Uint8Array(cw * ch * 4);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        const si = ((r * ch + y) * grid.width + (c * cw + x)) * 4;
        const di = (y * cw + x) * 4;
        cell[di] = grid.data[si]!; cell[di+1] = grid.data[si+1]!; cell[di+2] = grid.data[si+2]!; cell[di+3] = grid.data[si+3]!;
      }
      const { label, score } = await clf.classify(cell, cw, ch);
      if (label === qRes.label) scored.push({ score, row: r + 1, col: c + 1 });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, nineNums).map(s => [s.row, s.col]);
}
```

- [ ] **Step 5: Rodar e ver passar** — `npx tsx --test test/captcha-nine.test.ts` → PASS. Se falhar (células diferem), pode ser que o ONNX errou a classe de alguma célula — **isso é exatamente o que o Gate 2 mede**; registre e siga p/ o harness.

- [ ] **Step 6: `npm run check`** limpo.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(captcha): solver nine (ONNX classify + label-match)"`

---

### Task 5: Gate 2 — harness de acerto end-to-end (nine)

**Files:**
- Create: `scripts/captcha-gate2-nine.mjs`

**Interfaces:**
- Consumes: `GeetestClient`, `generateW` (precisa do branch `nine` em `signer.generateW` — **adicione-o aqui**), `findIconCells`.

- [ ] **Step 1: Adicionar branch `nine` em `signer.ts` `generateW`** (o Plan 1 só implementou `slide`; `nine` lança). Em `signer.ts`, no `generateW`, após o branch `slide`:
```ts
  } else if (riskType === 'nine') {
    const { findIconCells } = await import('./solvers/nine.js');
    const gridBuf = await fetchImage(data.imgs!);
    const quesBufs = (data.ques as string[] | undefined) ?? [];
    const qBuf = quesBufs[0] ? await fetchImage(quesBufs[0]) : Buffer.alloc(0);
    const cells = await findIconCells(gridBuf, qBuf, Number(data.nine_nums ?? 3));
    base.passtime = humanPasstime(1000, 0, 400);
    base.userresponse = cells;
  } else if (riskType === 'icon' || riskType === 'gobang' || riskType === 'winlinze') {
    throw new Error(`generateW: risk_type "${riskType}" é Plan 2b/3`);
  }
```
(Nota: `nine` no GeeTest usa `data['imgs']` p/ o grid e `data['ques']` p/ os ícones-pergunta — ver `sign.py:243-247`.)

- [ ] **Step 2: Escrever o harness** `scripts/captcha-gate2-nine.mjs`:
```js
import { chromium } from 'patchright';
import { GeetestClient } from '../src/main/services/captcha/geetest-client.js';
import { generateW } from '../src/main/services/captcha/signer.js';
import { findIconCells } from '../src/main/services/captcha/solvers/nine.js';

const CAPTCHA_ID = '54088bb07d2df3c46b79f80300b0abbe'; // demo nine (use o captcha_id do demo nine; confirme em gt4.geetest.com/demov4)
const N = Number(process.argv[2]) || 10;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const client = new GeetestClient(ctx.request, 'https://gcaptcha4.geevisit.com');
let ok = 0;
for (let i = 0; i < N; i++) {
  try {
    const data = await client.load(CAPTCHA_ID, 'nine');
    const w = await generateW(data, CAPTCHA_ID, 'nine', (p) => client.fetchImage(p), () => 0);
    const res = await client.verify({ captchaId: CAPTCHA_ID, lotNumber: data.lot_number, payload: data.payload, processToken: data.process_token, w, riskType: 'nine' });
    if (res.result === 'success' || res.seccode) { ok++; console.log(`[${i}] OK`); } else { console.log(`[${i}] FAIL result=${res.result}`); }
  } catch (e) { console.log(`[${i}] ERR ${e.message.slice(0,100)}`); }
  await new Promise(r => setTimeout(r, 500));
}
await browser.close();
const rate = (ok / N * 100).toFixed(1);
console.log(`GATE2=nine rate=${rate}% (${ok}/${N})`);
console.log(rate >= 90 ? 'GATE2=SUCCESS' : 'GATE2=FAIL (<90% -> Plan 2c mini-CNN)');
process.exit(rate >= 90 ? 0 : 1);
```
(Nota: `generateW` p/ `nine` importa `findIconCells` dinamicamente e usa `data.imgs`/`data.ques`/`data.nine_nums`; o `solveSlide` arg (4º) é ignorado no branch nine — passe `() => 0`.)

- [ ] **Step 3: Rodar** — `npx tsx scripts/captcha-gate2-nine.mjs 10` → imprime `GATE2=nine rate=X%` + `GATE2=SUCCESS`/`FAIL`.

- [ ] **Step 4: `npm run check`** limpo.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "test(captcha): spike Gate 2 (nine end-to-end + branch nine no generateW)"`

---

### Task 6: ADR 0003 + atualizar issue #3

**Files:**
- Create: `docs/adr/0003-solver-de-captcha-em-ts.md`
- Modify: `docs/adr/README.md` (índice)

- [ ] **Step 1: Escrever ADR 0003** (formato do repo: Contexto → Problema → Decisão → Consequências → Verificação). Decisão: solver 100% TS in-process, `onnxruntime-node` + `opencv-wasm`, TLS via `APIRequestContext` do patchright; reusa o `geetest_v4_icon.onnx` (2,4 MB) em vez do CLIP (350 MB); Plano B (sidecar Python) descartado (Gate 1 GO). Contexto: issue #3 + #8. Verificação: Gate 1 SUCCESS (slide), Gate 2 rate (nine), `npm run check` limpo, 149+ testes.

- [ ] **Step 2: Atualizar índice** em `docs/adr/README.md` (adicionar linha 0003).

- [ ] **Step 3: Commit** — `git add -A && git commit -m "docs(captcha): ADR 0003 — solver de captcha em TS (ONNX + patchright)"`

- [ ] **Step 4: Push + comentar issue #3** — `git push` + `gh issue comment 3 --repo ... --body "Plan 2 (Gate 2 nine) done: rate=X%. ADR 0003 registrado. Próximo: Plan 2b (icon/Gate 3) + Plan 3 (build-out)."`

---

## Self-Review (feito após escrever)

**1. Spec coverage:** Spec §4 (decisão classificador ONNX existente primeiro) → Task 2. §5 (`onnx-session.ts`, `nine.ts`) → Tasks 2,4. §8 Gate 2 → Task 5. §9 ADR → Task 6. `icon`/Gate 3 e build-out explicitamente no Plan 2b/3 (YAGNI). ✅
**2. Placeholder scan:** O Task 4 Step 1 (células esperadas via oracle) tem um caminho de fallback prático (rodar o harness e anotar) — não é placeholder vago, é um procedimento concreto. Preprocessing e I/O do ONNX são valores reais verificados. ✅
**3. Type consistency:** `IconClassifier.classify(rgba,w,h)→Promise<{label,score}>` (Task 2) ↔ consumido em `nine.ts` (Task 4) e `generateW` nine branch (Task 5) — assinaturas batem. `decodeImage(buf)→{data,width,height}` (Task 1) ↔ usado em `onnx-session`/`nine`. `findIconCells(gridBuf,quesBuf,nineNums)→Promise<Array<[n,n]>>` ↔ `generateW` nine branch. ✅

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-09-geetest-captcha-solver-plan2-nine.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.

**2. Inline Execution** — batch execution with checkpoints.

**Which approach?**

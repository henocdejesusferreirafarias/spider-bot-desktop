// Dry-run offline: roda as técnicas de similaridade nos fixtures nine capturados.
// Não valida acerto (sem ground-truth), só valida que o código roda e as células são sane.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeRGBA, TECHNIQUES } from './captcha-perceptual-match.mjs';

const ROOT = resolve('test/fixtures/captcha/dataset/nine');
for (const id of [0, 1, 2, 3, 4]) {
  const dir = resolve(ROOT, String(id));
  const grid = decodeRGBA(readFileSync(resolve(dir, 'grid.jpg')));
  const ques = decodeRGBA(readFileSync(resolve(dir, 'ques.png')));
  const meta = JSON.parse(readFileSync(resolve(dir, 'meta.json'), 'utf8'));
  const nineNums = meta.nineNums ?? 3;
  console.log(`\n=== fixture ${id}  gw=${grid.width} gh=${grid.height}  qw=${ques.width} qh=${ques.height}  nineNums=${nineNums} ===`);
  for (const t of TECHNIQUES) {
    const cells = t.fn(grid.data, grid.width, grid.height, ques.data, ques.width, ques.height, nineNums);
    console.log(`  ${t.name.padEnd(16)} -> ${JSON.stringify(cells)}`);
  }
}

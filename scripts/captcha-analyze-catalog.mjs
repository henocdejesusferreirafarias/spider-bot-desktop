// Análise: as células do nine vêm de um catálogo fixo de ~40 imagens, ou são fotos arbitrárias?
// Extrai 9 células de cada fixture (45 total), calcula assinatura 16×16 cinza, agrupa por similaridade.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeRGBA } from './captcha-perceptual-match.mjs';

const ROOT = resolve('test/fixtures/captcha/dataset/nine');
const S = 16; // tamanho da assinatura (downsample)

function resizeGrayBilinearAvg(src, sw, sh, dw, dh) {
  // média de bloco (box filter) — robusto a re-encoding JPEG
  const dst = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sh / dh), y1 = Math.floor((y + 1) * sh / dh);
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sw / dw), x1 = Math.floor((x + 1) * sw / dw);
      let sum = 0, cnt = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const si = (yy * sw + xx) * 4;
        sum += 0.299 * src[si] + 0.587 * src[si + 1] + 0.114 * src[si + 2];
        cnt++;
      }
      dst[y * dw + x] = cnt > 0 ? sum / cnt : 0;
    }
  }
  return dst;
}
function dist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

const cells = []; // {fixture, r, c, sig}
for (const id of [0, 1, 2, 3, 4]) {
  const dir = resolve(ROOT, String(id));
  const grid = decodeRGBA(readFileSync(resolve(dir, 'grid.jpg')));
  const gw = grid.width, gh = grid.height, cw = Math.floor(gw / 3), ch = Math.floor(gh / 3);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const cellBuf = new Uint8Array(cw * ch * 4);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const si = ((r * ch + y) * gw + (c * cw + x)) * 4, di = (y * cw + x) * 4;
      cellBuf[di] = grid.data[si]; cellBuf[di+1] = grid.data[si+1]; cellBuf[di+2] = grid.data[si+2]; cellBuf[di+3] = grid.data[si+3];
    }
    const sig = resizeGrayBilinearAvg(cellBuf, cw, ch, S, S);
    cells.push({ fixture: id, r, c, sig });
  }
}

// threshold de "mesma imagem": distância euclidiana na assinatura 16×16 (valores 0-255)
const THRESH = 8.0;
// cluster por similaridade (guloso)
const clusters = [];
for (const cell of cells) {
  let placed = false;
  for (const cl of clusters) {
    if (dist(cl[0].sig, cell.sig) < THRESH) { cl.push(cell); placed = true; break; }
  }
  if (!placed) clusters.push([cell]);
}
clusters.sort((a, b) => b.length - a.length);

console.log(`Total de células: ${cells.length}`);
console.log(`Clusters distintos (thresh=${THRESH}): ${clusters.length}`);
console.log(`\nDistribuição de tamanhos: ${clusters.map(c => c.length).join(', ')}`);
console.log(`\nClusters com >1 célula (repetição entre fixtures):`);
for (const cl of clusters.filter(c => c.length > 1)) {
  console.log(`  [size=${cl.length}] ${cl.map(c => `f${c.fixture}[${c.r+1},${c.c+1}]`).join(' ')}`);
}

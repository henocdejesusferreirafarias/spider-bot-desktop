// Técnicas de similaridade de FORMA (silhueta) para o desafio "nine" do GeeTest v4.
// O ícone-pergunta é uma silhueta preta sólida (RGB 0,0,0) sobre fundo transparente,
// então carrega só o FORMATO — nenhum valor de cinza. Matching de cinza degenera.
// JS puro (sem opencv-wasm) — só pngjs/jpeg-js pra decodificar.
// Cada técnica: (gridRGBA, gw, gh, quesRGBA, qw, qh, nineNums) => Array<[row,col]>
// row/col em 1..3.

import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';

export function decodeRGBA(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const j = jpeg.decode(buf, { useTArray: true });
    return { data: Buffer.from(j.data), width: j.width, height: j.height };
  }
  const p = PNG.sync.read(buf);
  return { data: Buffer.from(p.data), width: p.width, height: p.height };
}

const T = 64; // tamanho canônico de normalização

function toGrayAlpha(rgba, w, h) {
  const gray = new Float32Array(w * h);
  const alpha = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    gray[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    alpha[i] = rgba[p + 3];
  }
  return { gray, alpha };
}

function resizeBilinear(src, sw, sh, dw, dh) {
  if (dw <= 0 || dh <= 0) return new Float32Array(0);
  const dst = new Float32Array(dw * dh);
  const xr = dw === 1 ? 0 : (sw - 1) / (dw - 1);
  const yr = dh === 1 ? 0 : (sh - 1) / (dh - 1);
  for (let y = 0; y < dh; y++) {
    const sy = y * yr, y0 = Math.floor(sy), y1 = Math.min(y0 + 1, sh - 1), fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = x * xr, x0 = Math.floor(sx), x1 = Math.min(x0 + 1, sw - 1), fx = sx - x0;
      dst[y * dw + x] = (1-fx)*(1-fy)*src[y0*sw+x0]+fx*(1-fy)*src[y0*sw+x1]+(1-fx)*fy*src[y1*sw+x0]+fx*fy*src[y1*sw+x1];
    }
  }
  return dst;
}

function resizeNearest(src, sw, sh, dw, dh) {
  const dst = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) { const sy = Math.min(sh - 1, Math.floor(y * sh / dh)); for (let x = 0; x < dw; x++) { const sx = Math.min(sw - 1, Math.floor(x * sw / dw)); dst[y * dw + x] = src[sy * sw + sx]; } }
  return dst;
}

function cropToAlpha(gray, alpha, w, h, thr = 128) {
  let minx = w, miny = h, maxx = -1, maxy = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x] >= thr) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
  if (maxx < 0) return { gray, alpha, w, h };
  const cw = maxx - minx + 1, ch = maxy - miny + 1;
  const cg = new Float32Array(cw * ch), ca = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const si = (miny + y) * w + (minx + x); cg[y * cw + x] = gray[si]; ca[y * cw + x] = alpha[si]; }
  return { gray: cg, alpha: ca, w: cw, h: ch };
}

function extractCellGray(gridRGBA, gw, r, c, cw, ch) {
  const cell = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const si = ((r * ch + y) * gw + (c * cw + x)) * 4; cell[y * cw + x] = 0.299 * gridRGBA[si] + 0.587 * gridRGBA[si + 1] + 0.114 * gridRGBA[si + 2]; }
  return cell;
}

function topN(scored, nineNums) {
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, nineNums).map((s) => [s.row, s.col]);
}

// ---------- silhueta binária da pergunta, normalizada p/ T×T ----------
function questionSilhouette(quesRGBA, qw, qh) {
  const q = toGrayAlpha(quesRGBA, qw, qh);
  const crop = cropToAlpha(q.gray, q.alpha, qw, qh, 128);
  const bin = new Float32Array(crop.w * crop.h);
  for (let i = 0; i < crop.w * crop.h; i++) bin[i] = crop.alpha[i] >= 128 ? 1 : 0;
  const mask = resizeNearest(bin, crop.w, crop.h, T, T).map((v) => (v >= 0.5 ? 1 : 0));
  let fill = 0; for (let i = 0; i < T * T; i++) fill += mask[i];
  return { mask, fill };
}

// ---------- Técnica 1: EdgeEnergy (Sobel vs contorno da silhueta) ----------
function sobelMag(gray, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -gray[i-w-1]-2*gray[i-1]-gray[i+w-1]+gray[i-w+1]+2*gray[i+1]+gray[i+w+1];
    const gy = -gray[i-w-1]-2*gray[i-w]-gray[i-w+1]+gray[i+w-1]+2*gray[i+w]+gray[i+w+1];
    out[i] = Math.sqrt(gx * gx + gy * gy);
  }
  return out;
}
function boundaryRing(mask, w, h, rad = 2) {
  const ring = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const m = mask[i];
    let edge = false;
    for (let dy = -rad; dy <= rad && !edge; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const yy = y + dy, xx = x + dx;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) { if (m) { edge = true; break; } continue; }
      if (mask[yy * w + xx] !== m) { edge = true; break; }
    }
    ring[i] = edge ? 1 : 0;
  }
  let nring = 0; for (let i = 0; i < w * h; i++) nring += ring[i];
  return { ring, nring };
}
export function findCellsEdgeEnergy(gridRGBA, gw, gh, quesRGBA, qw, qh, nineNums) {
  const { mask } = questionSilhouette(quesRGBA, qw, qh);
  const { ring, nring } = boundaryRing(mask, T, T, 2);
  if (nring === 0) return [];
  const cw = Math.floor(gw / 3), ch = Math.floor(gh / 3);
  const scored = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const cellGray = extractCellGray(gridRGBA, gw, r, c, cw, ch);
    const cgT = resizeBilinear(cellGray, cw, ch, T, T);
    const edge = sobelMag(cgT, T, T);
    let onRing = 0, all = 0;
    for (let i = 0; i < T * T; i++) { all += edge[i]; if (ring[i]) onRing += edge[i]; }
    const meanAll = all / (T * T);
    const score = meanAll > 1e-6 ? onRing / nring / meanAll : 0; // razão: borda-no-anel vs média
    scored.push({ score, row: r + 1, col: c + 1 });
  }
  return topN(scored, nineNums);
}

// ---------- Técnica 2: Dice sobre binarização Otsu ----------
function otsuThreshold(gray, n) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < n; i++) hist[Math.min(255, Math.max(0, Math.round(gray[i]))) & 255]++;
  let total = n, sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, maxVar = -1, thr = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; thr = i; }
  }
  return thr;
}
function dice(a, b, n) {
  let inter = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { if (a[i]) sa++; if (b[i]) sb++; if (a[i] && b[i]) inter++; }
  return sa + sb === 0 ? 0 : (2 * inter) / (sa + sb);
}
export function findCellsDiceOtsu(gridRGBA, gw, gh, quesRGBA, qw, qh, nineNums) {
  const { mask: qBin, fill: qFill } = questionSilhouette(quesRGBA, qw, qh);
  const cw = Math.floor(gw / 3), ch = Math.floor(gh / 3);
  const scored = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const cellGray = extractCellGray(gridRGBA, gw, r, c, cw, ch);
    const cgT = resizeBilinear(cellGray, cw, ch, T, T);
    const thr = otsuThreshold(cgT, T * T);
    // dois candidatos de foreground; escolhe o cuja área é mais próxima da silhueta
    const lo = new Uint8Array(T * T), hi = new Uint8Array(T * T);
    let nlo = 0, nhi = 0;
    for (let i = 0; i < T * T; i++) {
      if (cgT[i] < thr) { lo[i] = 1; nlo++; } else { hi[i] = 1; nhi++; }
    }
    const cellBin = Math.abs(nlo - qFill) <= Math.abs(nhi - qFill) ? lo : hi;
    const d = dice(qBin, cellBin, T * T);
    scored.push({ score: d, row: r + 1, col: c + 1 });
  }
  return topN(scored, nineNums);
}

// ---------- Técnica 3: controle aleatório (sanidade do signing) ----------
export function findCellsRandom(_g, _gw, _gh, _q, _qw, _qh, nineNums) {
  const cells = [[1,1],[1,2],[1,3],[2,1],[2,2],[2,3],[3,1],[3,2],[3,3]];
  for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
  return cells.slice(0, nineNums);
}

export const TECHNIQUES = [
  { name: 'edge-energy', fn: findCellsEdgeEnergy },
  { name: 'dice-otsu', fn: findCellsDiceOtsu },
  { name: 'random-control', fn: findCellsRandom },
];

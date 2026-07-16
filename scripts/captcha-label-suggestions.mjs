import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { PNG } from 'pngjs';
import { decodeRgba, splitGridCells } from './captcha-nine-dataset-utils.mjs';

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const MODEL_PATH = join(process.cwd(), 'assets', 'captcha', 'nine_match.onnx');

let sessionPromise;

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function rgbaToRgbOnBackground(rgba, background = [255, 255, 255]) {
  const out = new Uint8Array((rgba.length / 4) * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const alpha = rgba[i + 3] / 255;
    for (let ch = 0; ch < 3; ch++) {
      out[j + ch] = Math.round((rgba[i + ch] * alpha) + (background[ch] * (1 - alpha)));
    }
  }
  return out;
}

function resizeBilinearRgb(rgb, width, height, targetWidth, targetHeight) {
  const out = new Uint8Array(targetWidth * targetHeight * 3);
  for (let y = 0; y < targetHeight; y++) {
    const sourceY = Math.max(0, Math.min(height - 1, ((y + 0.5) * height / targetHeight) - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(height - 1, y0 + 1);
    const wy = sourceY - y0;
    for (let x = 0; x < targetWidth; x++) {
      const sourceX = Math.max(0, Math.min(width - 1, ((x + 0.5) * width / targetWidth) - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(width - 1, x0 + 1);
      const wx = sourceX - x0;
      const dest = (y * targetWidth + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const top = (rgb[(y0 * width + x0) * 3 + ch] * (1 - wx)) + (rgb[(y0 * width + x1) * 3 + ch] * wx);
        const bottom = (rgb[(y1 * width + x0) * 3 + ch] * (1 - wx)) + (rgb[(y1 * width + x1) * 3 + ch] * wx);
        out[dest + ch] = Math.round((top * (1 - wy)) + (bottom * wy));
      }
    }
  }
  return out;
}

export function normalizePair(ques, cell) {
  const left = resizeBilinearRgb(rgbaToRgbOnBackground(ques.data), ques.width, ques.height, 64, 64);
  const right = resizeBilinearRgb(rgbaToRgbOnBackground(cell.data), cell.width, cell.height, 64, 64);
  const width = 128;
  const height = 64;
  const arr = new Float32Array(3 * width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = x < 64 ? left : right;
      const sourceX = x < 64 ? x : x - 64;
      const sourceOffset = (y * 64 + sourceX) * 3;
      const dest = y * width + x;
      for (let ch = 0; ch < 3; ch++) {
        arr[ch * width * height + dest] = ((source[sourceOffset + ch] / 255) - MEAN[ch]) / STD[ch];
      }
    }
  }
  return arr;
}

async function getSession() {
  if (!existsSync(MODEL_PATH)) return null;
  sessionPromise ??= ort.InferenceSession.create(MODEL_PATH);
  return sessionPromise;
}

export async function suggestNineCells(gridPath, quesPath, nineNums) {
  const session = await getSession();
  if (!session) return null;

  const grid = decodeRgba(readFileSync(gridPath));
  const ques = decodeRgba(readFileSync(quesPath));
  const cells = splitGridCells(grid.data, grid.width, grid.height);
  const scored = [];
  for (const cell of cells) {
    const tensor = new ort.Tensor('float32', normalizePair(ques, cell), [1, 3, 64, 128]);
    const out = await session.run({ input: tensor });
    const data = out.logit?.data;
    if (!data || data.length < 1) return null;
    scored.push({ row: cell.row, col: cell.col, score: sigmoid(Number(data[0])) });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, nineNums)
    .map((cell) => [cell.row, cell.col]);
}

export function pngDataUrlForCell(cell) {
  const png = new PNG({ width: cell.width, height: cell.height });
  png.data = Buffer.from(cell.data);
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}

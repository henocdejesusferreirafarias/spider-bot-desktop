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

function resizeNearest(rgba, width, height, targetWidth, targetHeight) {
  const out = new Uint8Array(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y++) {
    const sourceY = Math.min(height - 1, Math.floor((y / targetHeight) * height));
    for (let x = 0; x < targetWidth; x++) {
      const sourceX = Math.min(width - 1, Math.floor((x / targetWidth) * width));
      const source = (sourceY * width + sourceX) * 4;
      const dest = (y * targetWidth + x) * 4;
      out[dest] = rgba[source];
      out[dest + 1] = rgba[source + 1];
      out[dest + 2] = rgba[source + 2];
      out[dest + 3] = rgba[source + 3];
    }
  }
  return out;
}

function normalizePair(ques, cell) {
  const left = resizeNearest(ques.data, ques.width, ques.height, 64, 64);
  const right = resizeNearest(cell.data, cell.width, cell.height, 64, 64);
  const width = 128;
  const height = 64;
  const arr = new Float32Array(3 * width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = x < 64 ? left : right;
      const sourceX = x < 64 ? x : x - 64;
      const sourceOffset = (y * 64 + sourceX) * 4;
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

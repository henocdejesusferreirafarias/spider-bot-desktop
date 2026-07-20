import * as ort from 'onnxruntime-node';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from 'opencv-wasm';
import { resize, type Mat } from './image-utils.js';
const cv = pkg.cv;

const __dirname = dirname(fileURLToPath(import.meta.url));
const NINE_MATCH_MODEL = resolveCaptchaAsset('nine_match.onnx');
const PHOTO_MEAN = [0.485, 0.456, 0.406] as const;
const PHOTO_STD = [0.229, 0.224, 0.225] as const;

function resolveCaptchaAsset(name: string): string {
  const r = process.resourcesPath;
  if (r) {
    for (const p of [
      join(r, 'assets', 'captcha', name),
      join(r, 'app.asar.unpacked', 'assets', 'captcha', name),
    ]) {
      if (existsSync(p)) return p;
    }
  }
  return join(__dirname, '..', '..', '..', '..', 'assets', 'captcha', name);
}
function opaqueOnWhite(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = (rgba[i + 3] ?? 255) / 255;
    out[i] = Math.round(((rgba[i] ?? 0) * alpha) + (255 * (1 - alpha)));
    out[i + 1] = Math.round(((rgba[i + 1] ?? 0) * alpha) + (255 * (1 - alpha)));
    out[i + 2] = Math.round(((rgba[i + 2] ?? 0) * alpha) + (255 * (1 - alpha)));
    out[i + 3] = 255;
  }
  return out;
}

function resizeOpaqueRgba(rgba: Uint8Array, w: number, h: number): Mat {
  const input = decodeToMat(opaqueOnWhite(rgba), w, h);
  const resized = resize(input, 64, 64, 'INTER_LINEAR');
  input.delete();
  return resized;
}

export function normalizeNineMatchPairForImageNet(
  quesRgba: Uint8Array,
  quesWidth: number,
  quesHeight: number,
  cellRgba: Uint8Array,
  cellWidth: number,
  cellHeight: number,
): Float32Array {
  const ques = resizeOpaqueRgba(quesRgba, quesWidth, quesHeight);
  const cell = resizeOpaqueRgba(cellRgba, cellWidth, cellHeight);
  try {
    const width = 128;
    const height = 64;
    const arr = new Float32Array(3 * width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const source = x < 64 ? ques : cell;
        const sourceX = x < 64 ? x : x - 64;
        const src = (y * 64 + sourceX) * 4;
        const dest = y * width + x;
        for (const ch of [0, 1, 2] as const) {
          arr[ch * width * height + dest] = (((source.data[src + ch] ?? 0) / 255) - PHOTO_MEAN[ch]) / PHOTO_STD[ch];
        }
      }
    }
    return arr;
  } finally {
    ques.delete();
    cell.delete();
  }
}

function decodeToMat(rgba: Uint8Array, w: number, h: number): Mat {
  const m = new cv.Mat(h, w, cv.CV_8UC4);
  m.data.set(rgba);
  return m as unknown as Mat;
}

export interface NineMatchImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export class NineMatchInferenceQueue {
  private active = 0;
  private readonly pending: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number = 1) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('NineMatchInferenceQueue maxConcurrent must be a positive integer');
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.pending.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.pending.shift()?.();
    }
  }
}

function resolveNineMatchInferenceConcurrency(): number {
  const parsed = Number(process.env.NINE_MATCH_INFERENCE_CONCURRENCY ?? 1);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

type NineMatchSessionFactory = () => Promise<ort.InferenceSession>;

export class NineMatchClassifier {
  private sessionPromise: Promise<ort.InferenceSession> | undefined;
  private readonly queue = new NineMatchInferenceQueue(resolveNineMatchInferenceConcurrency());

  constructor(
    private readonly createSession: NineMatchSessionFactory = () => ort.InferenceSession.create(NINE_MATCH_MODEL),
  ) {}

  private ensure(): Promise<ort.InferenceSession> {
    if (!this.sessionPromise) {
      this.sessionPromise = this.createSession().catch((error: unknown) => {
        this.sessionPromise = undefined;
        throw error;
      });
    }
    return this.sessionPromise;
  }

  async warmup(): Promise<void> {
    await this.ensure();
  }

  async score(ques: NineMatchImage, cell: NineMatchImage): Promise<number> {
    const [score] = await this.scoreCells(ques, [cell]);
    if (score === undefined) {
      throw new Error('nine_match.onnx did not score the cell');
    }
    return score;
  }

  async scoreCells(ques: NineMatchImage, cells: NineMatchImage[]): Promise<number[]> {
    if (cells.length === 0) return [];
    return this.queue.run(async () => {
      const session = await this.ensure();
      const sampleSize = 3 * 64 * 128;
      const batch = new Float32Array(cells.length * sampleSize);
      cells.forEach((cell, index) => {
        batch.set(
          normalizeNineMatchPairForImageNet(ques.data, ques.width, ques.height, cell.data, cell.width, cell.height),
          index * sampleSize,
        );
      });
      const tensor = new ort.Tensor('float32', batch, [cells.length, 3, 64, 128]);
      const out = await session.run({ input: tensor });
      const data = out.logit?.data;
      if (!data || data.length < cells.length) {
        throw new Error('nine_match.onnx did not return logit output');
      }
      return Array.from({ length: cells.length }, (_, index) => {
        const logit = Number(data[index]);
        return 1 / (1 + Math.exp(-logit));
      });
    });
  }
}

let _nineMatchClassifier: NineMatchClassifier | undefined;
export function getNineMatchClassifier(): NineMatchClassifier { return _nineMatchClassifier ??= new NineMatchClassifier(); }
export async function warmNineMatchClassifier(): Promise<void> { await getNineMatchClassifier().warmup(); }

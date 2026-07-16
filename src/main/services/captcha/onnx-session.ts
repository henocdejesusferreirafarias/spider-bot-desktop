import * as ort from 'onnxruntime-node';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from 'opencv-wasm';
import { resize, toGray, type Mat } from './image-utils.js';
const cv = pkg.cv;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL = resolveCaptchaAsset('geetest_v4_icon.onnx');
const CHARSET_PATH = resolveCaptchaAsset('charsets.json');
const PHOTO_MODEL = resolveCaptchaAsset('nine_photo.onnx');
const PHOTO_CLASSES_PATH = resolveCaptchaAsset('nine_classes.json');
const NINE_MATCH_MODEL = resolveCaptchaAsset('nine_match.onnx');
const PHOTO_MEAN = [0.485, 0.456, 0.406] as const;
const PHOTO_STD = [0.229, 0.224, 0.225] as const;

function resolveCaptchaAsset(name: string): string {
  const r = process.resourcesPath;
  if (r) {
    const p = join(r, 'assets', 'captcha', name);
    try {
      readFileSync(p);
      return p;
    } catch {}
  }
  return join(__dirname, '..', '..', '..', '..', 'assets', 'captcha', name);
}
const CHARSET: string[] = JSON.parse(readFileSync(CHARSET_PATH, 'utf8')).charset;

export interface ClassifyResult { label: string; score: number; }
export class IconClassifier {
  private session: ort.InferenceSession | undefined;
  private async ensure(): Promise<ort.InferenceSession> {
    if (!this.session) this.session = await ort.InferenceSession.create(MODEL);
    return this.session;
  }
  async classify(rgba: Uint8Array, w: number, h: number): Promise<ClassifyResult> {
    const input = decodeToMat(rgba, w, h);
    const gray = toGray(input);
    input.delete();
    const r = resize(gray, 64, 64, 'INTER_AREA');
    try {
      const arr = new Float32Array(64 * 64);
      for (let i = 0; i < 4096; i++) arr[i] = (r.data[i]! / 255 - 0.456) / 0.224;
      const t = new ort.Tensor('float32', arr, [1, 1, 64, 64]);
      const out = await (await this.ensure()).run({ input1: t });
      const idx = Number((out['63'] as ort.Tensor).data[0]);
      const outData = (out['output'] as ort.Tensor).data as Float32Array;
      const score = outData.length === 1 ? Number(outData[0]) : Number(outData[idx]!);
      return { label: CHARSET[idx]!, score };
    } finally {
      gray.delete();
      r.delete();
    }
  }
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
        for (const ch of [0, 1, 2] as const) {
          arr[ch * 64 * 64 + y * 64 + x] = ((resized.data[src + ch]! / 255) - PHOTO_MEAN[ch]) / PHOTO_STD[ch];
        }
      }
    }
    return arr;
  } finally {
    resized.delete();
  }
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

function decodeToMat(rgba: Uint8Array, w: number, h: number): Mat {
  const m = new cv.Mat(h, w, cv.CV_8UC4);
  m.data.set(rgba);
  return m as unknown as Mat;
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
      const parsed = JSON.parse(readFileSync(PHOTO_CLASSES_PATH, 'utf8')) as { charset: string[] };
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
    if (!logits || logits.length !== classes.length) {
      throw new Error(`nine_photo.onnx returned ${logits?.length ?? 0} logits for ${classes.length} classes`);
    }
    const probs = softmax(logits);
    let best = 0;
    for (let i = 1; i < probs.length; i++) {
      if (probs[i]! > probs[best]!) best = i;
    }
    const scores = Object.fromEntries(classes.map((label, idx) => [label, probs[idx] ?? 0]));
    return {
      label: classes[best]!,
      score: probs[best]!,
      scores,
      scoreFor(label: string) {
        return scores[label] ?? 0;
      },
    };
  }
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

let _clf: IconClassifier | undefined;
export function getClassifier(): IconClassifier { return _clf ??= new IconClassifier(); }
let _photoClassifier: PhotoClassifier | undefined;
export function getPhotoClassifier(): PhotoClassifier { return _photoClassifier ??= new PhotoClassifier(); }
let _nineMatchClassifier: NineMatchClassifier | undefined;
export function getNineMatchClassifier(): NineMatchClassifier { return _nineMatchClassifier ??= new NineMatchClassifier(); }
export async function warmNineMatchClassifier(): Promise<void> { await getNineMatchClassifier().warmup(); }

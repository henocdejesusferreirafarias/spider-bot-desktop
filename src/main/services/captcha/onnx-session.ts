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
    const score = Number((out['output'] as ort.Tensor).data[0]);
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

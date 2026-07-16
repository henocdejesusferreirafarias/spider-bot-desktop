import pkg from 'opencv-wasm';
import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';
const cv = pkg.cv;

export interface Mat {
  rows: number;
  cols: number;
  data: Uint8Array;
  channels(): number;
  delete(): void;
}

export function decodeImage(buf: Buffer): { data: Buffer; width: number; height: number } {
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const j = jpeg.decode(buf, { useTArray: true });
    return { data: Buffer.from(j.data), width: j.width, height: j.height };
  }
  const p = PNG.sync.read(buf);
  return { data: Buffer.from(p.data), width: p.width, height: p.height };
}

export function resize(
  src: Mat,
  w: number,
  h: number,
  interp: 'INTER_AREA' | 'INTER_LINEAR' = 'INTER_AREA',
): Mat {
  const dst = new cv.Mat();
  cv.resize(src as unknown as InstanceType<typeof cv.Mat>, dst, new cv.Size(w, h), 0, 0, cv[interp]);
  return dst as unknown as Mat;
}

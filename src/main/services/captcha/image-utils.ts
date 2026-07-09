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
type Method = 'TM_CCOEFF_NORMED' | 'TM_CCOEFF' | 'TM_SQDIFF_NORMED';
type ColorCode = 'COLOR_RGBA2GRAY' | 'COLOR_GRAY2RGB' | 'COLOR_BGRA2RGB';

export function decodePng(buf: Buffer): Mat {
  const png = PNG.sync.read(buf);
  const mat = new cv.Mat(png.height, png.width, cv.CV_8UC4);
  mat.data.set(png.data);
  return mat as unknown as Mat;
}

export function decodeImage(buf: Buffer): { data: Buffer; width: number; height: number } {
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const j = jpeg.decode(buf, { useTArray: true });
    return { data: Buffer.from(j.data), width: j.width, height: j.height };
  }
  const p = PNG.sync.read(buf);
  return { data: Buffer.from(p.data), width: p.width, height: p.height };
}

export function cvtColor(src: Mat, code: ColorCode): Mat {
  const dst = new cv.Mat();
  cv.cvtColor(src as unknown as InstanceType<typeof cv.Mat>, dst, cv[code]);
  return dst as unknown as Mat;
}

export function toGray(rgba: Mat): Mat {
  return cvtColor(rgba, 'COLOR_RGBA2GRAY');
}

export function canny(src: Mat, t1 = 100, t2 = 200): Mat {
  const dst = new cv.Mat();
  cv.Canny(src as unknown as InstanceType<typeof cv.Mat>, dst, t1, t2);
  return dst as unknown as Mat;
}

export function matchTemplate(img: Mat, templ: Mat, method: Method): Mat {
  const res = new cv.Mat();
  cv.matchTemplate(
    img as unknown as InstanceType<typeof cv.Mat>,
    templ as unknown as InstanceType<typeof cv.Mat>,
    res,
    cv[method],
  );
  return res as unknown as Mat;
}

export interface MinMaxLoc {
  minVal: number;
  maxVal: number;
  minLoc: { x: number; y: number };
  maxLoc: { x: number; y: number };
}

export function minMaxLoc(src: Mat): MinMaxLoc {
  return cv.minMaxLoc(src as unknown as InstanceType<typeof cv.Mat>) as unknown as MinMaxLoc;
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

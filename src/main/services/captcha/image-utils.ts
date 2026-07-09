import pkg from 'opencv-wasm';
import { PNG } from 'pngjs';
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

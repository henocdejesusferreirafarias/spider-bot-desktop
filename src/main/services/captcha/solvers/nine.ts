import { decodeImage } from '../image-utils.js';
import { getClassifier } from '../onnx-session.js';

export async function findIconCells(gridBuf: Buffer, quesBuf: Buffer, nineNums: number): Promise<Array<[number, number]>> {
  const clf = getClassifier();
  const grid = decodeImage(gridBuf);   // {data: RGBA, width, height}
  const ques = decodeImage(quesBuf);
  const cw = Math.floor(grid.width / 3), ch = Math.floor(grid.height / 3);
  const qRes = await clf.classify(ques.data, ques.width, ques.height);
  const scored: Array<{ score: number; row: number; col: number }> = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const cell = new Uint8Array(cw * ch * 4);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        const si = ((r * ch + y) * grid.width + (c * cw + x)) * 4;
        const di = (y * cw + x) * 4;
        cell[di] = grid.data[si]!; cell[di+1] = grid.data[si+1]!; cell[di+2] = grid.data[si+2]!; cell[di+3] = grid.data[si+3]!;
      }
      const { label, score } = await clf.classify(cell, cw, ch);
      if (label === qRes.label) scored.push({ score, row: r + 1, col: c + 1 });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, nineNums).map(s => [s.row, s.col]);
}

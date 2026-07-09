import { decodeImage } from '../image-utils.js';
import { getClassifier, getPhotoClassifier, type PhotoClassifyResult } from '../onnx-session.js';

export interface RankedPhotoCell {
  row: number;
  col: number;
  label: string;
  score: number;
  targetScore: number;
}

export function rankPhotoCellsForTarget(targetLabel: string, cells: RankedPhotoCell[], nineNums: number): Array<[number, number]> {
  return [...cells]
    .sort((a, b) => b.targetScore - a.targetScore || Number(b.label === targetLabel) - Number(a.label === targetLabel) || b.score - a.score)
    .slice(0, nineNums)
    .map((cell) => [cell.row, cell.col]);
}

function cropCell(grid: { data: Uint8Array; width: number; height: number }, row: number, col: number): { data: Uint8Array; width: number; height: number } {
  const width = Math.floor(grid.width / 3);
  const height = Math.floor(grid.height / 3);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = (((row - 1) * height + y) * grid.width + ((col - 1) * width + x)) * 4;
      const dest = (y * width + x) * 4;
      data[dest] = grid.data[source]!;
      data[dest + 1] = grid.data[source + 1]!;
      data[dest + 2] = grid.data[source + 2]!;
      data[dest + 3] = grid.data[source + 3]!;
    }
  }
  return { data, width, height };
}

export async function findIconCellsPhoto(gridBuf: Buffer, quesBuf: Buffer, nineNums: number): Promise<Array<[number, number]>> {
  const icon = getClassifier();
  const photo = getPhotoClassifier();
  const grid = decodeImage(gridBuf);
  const ques = decodeImage(quesBuf);
  const target = await icon.classify(ques.data, ques.width, ques.height);
  const cells: RankedPhotoCell[] = [];
  for (let row = 1; row <= 3; row++) {
    for (let col = 1; col <= 3; col++) {
      const cell = cropCell(grid, row, col);
      const result: PhotoClassifyResult = await photo.classify(cell.data, cell.width, cell.height);
      cells.push({ row, col, label: result.label, score: result.score, targetScore: result.scoreFor(target.label) });
    }
  }
  return rankPhotoCellsForTarget(target.label, cells, nineNums);
}

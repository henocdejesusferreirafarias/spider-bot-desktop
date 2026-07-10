import { decodeImage } from '../image-utils.js';
import { getNineMatchClassifier, type NineMatchImage } from '../onnx-session.js';

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

export interface RankedNineMatchCell {
  row: number;
  col: number;
  score: number;
}

export interface NineMatchCell extends NineMatchImage {
  row: number;
  col: number;
}

export interface NineMatchScorer {
  score(ques: NineMatchImage, cell: NineMatchCell): Promise<number>;
  scoreCells?(ques: NineMatchImage, cells: NineMatchCell[]): Promise<number[]>;
}

export function rankNineMatchCells(cells: RankedNineMatchCell[], nineNums: number): Array<[number, number]> {
  return [...cells]
    .sort((a, b) => b.score - a.score)
    .slice(0, nineNums)
    .map((cell) => [cell.row, cell.col]);
}

function cropCell(grid: { data: Uint8Array; width: number; height: number }, row: number, col: number): NineMatchCell {
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
  return { row, col, data, width, height };
}

export async function findIconCellsPhoto(
  gridBuf: Buffer,
  quesBuf: Buffer,
  nineNums: number,
  matcher: NineMatchScorer = getNineMatchClassifier(),
): Promise<Array<[number, number]>> {
  const grid = decodeImage(gridBuf);
  const ques = decodeImage(quesBuf);
  const cells: NineMatchCell[] = [];
  for (let row = 1; row <= 3; row++) {
    for (let col = 1; col <= 3; col++) {
      cells.push(cropCell(grid, row, col));
    }
  }
  const scores = matcher.scoreCells ? await matcher.scoreCells(ques, cells) : await Promise.all(cells.map((cell) => matcher.score(ques, cell)));
  if (scores.length !== cells.length) {
    throw new Error(`nine_match scorer returned ${scores.length} scores for ${cells.length} cells`);
  }
  const ranked = cells.map((cell, index) => ({ row: cell.row, col: cell.col, score: scores[index] ?? 0 }));
  return rankNineMatchCells(ranked, nineNums);
}

import { decodePng, canny, cvtColor, matchTemplate, minMaxLoc, toGray, type Mat } from '../image-utils.js';

interface MatchCandidate { score: number; topX: number; h: number; w: number; }

function matchOne(template: Mat, background: Mat): MatchCandidate {
  const res = matchTemplate(background, template, 'TM_CCOEFF_NORMED');
  try {
    const mm = minMaxLoc(res);
    return { score: mm.maxVal, topX: mm.maxLoc.x, h: template.rows, w: template.cols };
  } finally {
    res.delete();
  }
}

export function findPuzzlePiecePosition(pieceBuf: Buffer, bgBuf: Buffer): number {
  let puzzle: Mat | undefined;
  let background: Mat | undefined;
  let cannyPiece: Mat | undefined;
  let cannyBg: Mat | undefined;
  let edgePiece: Mat | undefined;
  let edgeBg: Mat | undefined;
  let grayPiece: Mat | undefined;
  let grayBg: Mat | undefined;
  try {
    puzzle = decodePng(pieceBuf);
    background = decodePng(bgBuf);

    // 1) match por bordas (Canny) — bom p/ fundos texturizados
    cannyPiece = canny(puzzle, 100, 200);
    edgePiece = cvtColor(cannyPiece, 'COLOR_GRAY2RGB');
    cannyBg = canny(background, 100, 200);
    edgeBg = cvtColor(cannyBg, 'COLOR_GRAY2RGB');
    const c1 = matchOne(edgePiece, edgeBg);

    // 2) match direto em tons de cinza — bom p/ fundos de baixo contraste
    grayPiece = toGray(puzzle);
    grayBg = toGray(background);
    const c2 = matchOne(grayPiece, grayBg);

    const best = [c1, c2].sort((a, b) => b.score - a.score)[0]!;
    const centerX = best.topX + Math.floor(best.w / 2);
    return centerX - 41;
  } finally {
    grayBg?.delete();
    grayPiece?.delete();
    edgeBg?.delete();
    edgePiece?.delete();
    cannyBg?.delete();
    cannyPiece?.delete();
    background?.delete();
    puzzle?.delete();
  }
}

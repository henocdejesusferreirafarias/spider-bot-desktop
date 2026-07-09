import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';

export function decodeRgba(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const decoded = jpeg.decode(buf, { useTArray: true });
    return { data: new Uint8Array(decoded.data), width: decoded.width, height: decoded.height };
  }
  const decoded = PNG.sync.read(buf);
  return { data: new Uint8Array(decoded.data), width: decoded.width, height: decoded.height };
}

export function splitGridCells(rgba, width, height) {
  const cellWidth = Math.floor(width / 3);
  const cellHeight = Math.floor(height / 3);
  const cells = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const data = new Uint8Array(cellWidth * cellHeight * 4);
      for (let y = 0; y < cellHeight; y++) {
        for (let x = 0; x < cellWidth; x++) {
          const source = ((row * cellHeight + y) * width + (col * cellWidth + x)) * 4;
          const dest = (y * cellWidth + x) * 4;
          data[dest] = rgba[source];
          data[dest + 1] = rgba[source + 1];
          data[dest + 2] = rgba[source + 2];
          data[dest + 3] = rgba[source + 3];
        }
      }
      cells.push({ row: row + 1, col: col + 1, data, width: cellWidth, height: cellHeight });
    }
  }
  return cells;
}

export function writeJsonlLine(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(value)}\n`);
}

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inline] = arg.slice(2).split('=');
    out[rawKey] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
  }
  return out;
}

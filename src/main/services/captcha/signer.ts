import crypto from 'node:crypto';
import { CURRENT_CONSTANTS, RSA_PUBKEY } from './constants.js';

// ---------- LotParser (porte de sign.py) ----------
export class LotParser {
  private readonly lot: number[][][];
  private readonly lotRes: number[][][];

  constructor(mapping: Record<string, string>) {
    const [key, val] = Object.entries(mapping)[0]!;
    this.lot = this.parse(key);
    this.lotRes = this.parse(val);
  }

  private static extract(part: string): string {
    const m = part.match(/\[(.*?)\]/);
    if (!m) throw new Error(`LotParser: sem slice em "${part}"`);
    return m[1]!;
  }
  private static parseSlice(s: string): number[] {
    return s.split(':').map(Number);
  }
  private parse(s: string): number[][][] {
    return s.split('+.').map((part) =>
      part.includes('+')
        ? part.split('+').map((sub) => LotParser.parseSlice(LotParser.extract(sub)))
        : [LotParser.parseSlice(LotParser.extract(part))],
    );
  }
  private static buildStr(parsed: number[][][], num: string): string {
    return parsed
      .map((p) =>
        p
          .map((s) => {
            const start = s[0]!;
            const end = s.length > 1 ? s[1]! + 1 : start + 1;
            return num.slice(start, end);
          })
          .join(''),
      )
      .join('.');
  }
  getDict(lotNumber: string): Record<string, unknown> {
    const i = LotParser.buildStr(this.lot, lotNumber);
    const r = LotParser.buildStr(this.lotRes, lotNumber);
    const parts = i.split('.');
    const a: Record<string, unknown> = {};
    let cur: Record<string, unknown> = a;
    parts.forEach((part, idx) => {
      if (idx === parts.length - 1) cur[part] = r;
      else {
        cur[part] = (cur[part] as Record<string, unknown>) ?? {};
        cur = cur[part] as Record<string, unknown>;
      }
    });
    return a;
  }
}

const lotParser = new LotParser(CURRENT_CONSTANTS.mapping);

// ---------- helpers de aleatoriedade ----------
export function randUid(): string {
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += Math.abs((65536 * (1 + Math.random())) | 0).toString(16).padStart(4, '0').slice(-4);
  }
  return out;
}

// ---------- AES-128-CBC (IV fixo "0"*16, PKCS7) ----------
export function encryptSymmetrical1(plainText: string, randomStr: string): Buffer {
  const key = Buffer.from(randomStr, 'utf8');
  const iv = Buffer.from('0000000000000000', 'utf8');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
}

// ---------- RSA PKCS1v1.5 (pubkey do GeeTest, via JWK) ----------
function intHexToB64url(hex: string): string {
  const padded = hex.length % 2 ? '0' + hex : hex;
  let buf = Buffer.from(padded, 'hex');
  while (buf.length > 1 && buf[0] === 0) buf = buf.subarray(1);
  return buf.toString('base64url');
}
let _pubKey: crypto.KeyObject | undefined;
export function getPubKey(): crypto.KeyObject {
  if (_pubKey) return _pubKey;
  _pubKey = crypto.createPublicKey({
    key: { kty: 'RSA', n: intHexToB64url(RSA_PUBKEY.n), e: intHexToB64url(RSA_PUBKEY.e) },
    format: 'jwk',
  });
  return _pubKey;
}
export function encryptAsymmetric1(message: string): string {
  const enc = crypto.publicEncrypt({ key: getPubKey(), padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(message, 'utf8'));
  return enc.toString('hex');
}

// ---------- PoW ----------
export interface PowResult { pow_msg: string; pow_sign: string; }
export function generatePow(
  lotNumberPow: string, captchaIdPow: string, hashFunc: string, hashVersion: string,
  bits: number, date: string, empty: string,
): PowResult {
  const bitRemainder = bits % 4;
  const bitDivision = Math.floor(bits / 4);
  const prefix = '0'.repeat(bitDivision);
  const powString = `${hashVersion}|${bits}|${hashFunc}|${date}|${captchaIdPow}|${lotNumberPow}|${empty}|`;
  for (;;) {
    const h = randUid();
    const combined = powString + h;
    let hashed: string | undefined;
    if (hashFunc === 'md5') hashed = crypto.createHash('md5').update(combined).digest('hex');
    else if (hashFunc === 'sha1') hashed = crypto.createHash('sha1').update(combined).digest('hex');
    else if (hashFunc === 'sha256') hashed = crypto.createHash('sha256').update(combined).digest('hex');
    if (!hashed) throw new Error(`hashfunc desconhecida: ${hashFunc}`);
    if (!hashed.startsWith(prefix)) continue;
    if (bitRemainder === 0) return { pow_msg: combined, pow_sign: hashed };
    const threshold = bitRemainder === 1 ? 7 : bitRemainder === 2 ? 3 : 1;
    if (parseInt(hashed[bitDivision]!, 16) <= threshold) return { pow_msg: combined, pow_sign: hashed };
  }
}

// ---------- encrypt_w / generate_w ----------
function humanPasstime(base = 600, perUnit = 0, spread = 150): number {
  const center = base + perUnit;
  const v = center + (Math.random() - 0.5) * 2 * spread;
  return Math.max(280, Math.min(4500, Math.round(v)));
}

export function encryptW(rawInput: string, pt: string | number | undefined): string {
  if (!pt || pt === '0') return encodeURIComponent(rawInput);
  if (pt !== '1') throw new Error(`pt=${pt} não implementado`);
  const randomUid = randUid();
  const encKey = encryptAsymmetric1(randomUid);
  const encInput = encryptSymmetrical1(rawInput, randomUid);
  return encInput.toString('hex') + encKey;
}

export interface GeetestChallengeData {
  lot_number: string;
  pow_detail: { hashfunc: string; version: string; bits: number; datetime: string };
  pt: string;
  slice?: string; bg?: string;
  ques?: unknown; imgs?: string; nine_nums?: number;
  [k: string]: unknown;
}
export type SlideSolverFn = (pieceBuf: Buffer, bgBuf: Buffer) => number;

export async function generateW(
  data: GeetestChallengeData, captchaId: string, riskType: string,
  fetchImage: (path: string) => Promise<Buffer>, solveSlide: SlideSolverFn,
): Promise<string> {
  const lotNumber = data.lot_number;
  const pow = data.pow_detail;
  const base: Record<string, unknown> = {
    ...CURRENT_CONSTANTS.abo,
    ...generatePow(lotNumber, captchaId, pow.hashfunc, pow.version, pow.bits, pow.datetime, ''),
    ...lotParser.getDict(lotNumber),
    biht: '1426265548',
    device_id: CURRENT_CONSTANTS.deviceId,
    em: { cp: 0, ek: '11', nt: 0, ph: 0, sc: 0, si: 0, wd: 1 },
    gee_guard: { roe: { auh: '3', aup: '3', cdc: '3', egp: '3', res: '3', rew: '3', sep: '3', snh: '3' } },
    ep: '123', geetest: 'captcha', lang: 'zh', lot_number: lotNumber,
  };

  if (riskType === 'ai' || riskType === 'invisible') {
    // sem userresponse
  } else if (riskType === 'slide') {
    const pieceBuf = await fetchImage(data.slice!);
    const bgBuf = await fetchImage(data.bg!);
    const left = solveSlide(pieceBuf, bgBuf) + Math.random() * 0.5;
    base.passtime = humanPasstime(320, left * 1.6, 140);
    base.setLeft = left;
    base.userresponse = left / 1.0059466666666665 + 2;
  } else if (riskType === 'nine') {
    const { findIconCells } = await import('./solvers/nine.js');
    const gridBuf = await fetchImage(data.imgs!);
    const quesBufs = (data.ques as string[] | undefined) ?? [];
    const qBuf = quesBufs[0] ? await fetchImage(quesBufs[0]) : Buffer.alloc(0);
    const cells = await findIconCells(gridBuf, qBuf, Number(data.nine_nums ?? 3));
    base.passtime = humanPasstime(1000, 0, 400);
    base.userresponse = cells;
  } else if (riskType === 'icon' || riskType === 'gobang' || riskType === 'winlinze') {
    throw new Error(`generateW: risk_type "${riskType}" é Plan 2b/3`);
  } else {
    throw new Error(`generateW: risk_type "${riskType}" não implementado neste plano (Plan 2/3)`);
  }
  return encryptW(JSON.stringify(base), data.pt);
}

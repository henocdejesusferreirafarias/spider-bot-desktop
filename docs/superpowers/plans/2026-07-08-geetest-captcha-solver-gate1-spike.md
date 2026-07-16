# GeeTest Captcha Solver — Gate 1 Spike (TLS/crypto core + slide) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Portar o núcleo de cripto/protocolo do solver GeeTest v4 para TypeScript e validar (Gate 1) que `load`+`verify` end-to-end funcionam via `APIRequestContext` do patchright — o go/no-go crítico da issue #3.

**Architecture:** Solver 100% TS in-process. `signer.ts` (porte de `sign.py`, `node:crypto`), `deobfuscate.ts` (porte de `deobfuscate.py`), `geetest-client.ts` (`load`/`verify` via patchright = JA3 Chrome genuíno), `slide.ts` (`opencv-wasm` + `pngjs`). Sem Python, sem torch, sem CLIP neste plano.

**Tech Stack:** TypeScript (NodeNext, strict, `noUncheckedIndexedAccess`), `node:crypto`, `node:test`, `patchright ^1.60.0` (já instalado), `opencv-wasm@4.3.0-10`, `pngjs`.

**Escopo deste plano:** Plan 1 de 3. Este plano cobre **só o Gate 1** (TLS) + o solver `slide` (necessário p/ validar o verify end-to-end). Plan 2 (Gates 2/3: visão ONNX + dataset) e Plan 3 (build-out: remover Python, rewiring, packaging) vêm após os gates respectivos. YAGNI: não planejar o build-out antes do gate validar.

## Global Constraints

- TS ESM, strict, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`. `tsc -p tsconfig.electron.json --noEmit` limpo é o gate (`npm run check`).
- Source em `src/main/` (incluído em `tsconfig.electron.json`); testes em `test/*.test.ts` (flat, rodam via `tsx --test`, **não** typechecked).
- Testes usam **`node:test`** + **`node:assert/strict`** (ver `test/database.test.ts` p/ convenção). Imports de source com extensão `.js` (NodeNext): `import { x } from "../src/main/services/captcha/signer.js"`.
- Commits convencionais atômicos: `feat(captcha): …`, `test(captcha): …`, `chore(captcha): …`.
- Branch: `feat/solver-captcha-ts` (já criado). Issue #3 aberta no repo `henocdejesusferreirafarias/spider-bot-desktop`.
- Python 3.12 + deps do `GeekedTest-main/` estão disponíveis em dev (usados como **oráculo** nos testes de caracterização; ausentes em `npm test` default).

---

## File Structure

| Arquivo (novo) | Responsabilidade |
|---|---|
| `src/main/services/captcha/constants.ts` | Constantes rotativas (`abo`, `mapping`, `deviceId`) + pubkey RSA. Consumido pelo `signer`. |
| `src/main/services/captcha/deobfuscate.ts` | `parseGcaptchaJs(script)` (puro, testável) + `fetchAndExtract()` (rede). Porte de `deobfuscate.py`. |
| `src/main/services/captcha/signer.ts` | `LotParser`, `randUid`, `encryptSymmetrical1` (AES), `encryptAsymmetric1` (RSA), `generatePow`, `encryptW`, `generateW` (slide). Porte de `sign.py`. |
| `src/main/services/captcha/image-utils.ts` | `decodePng(buf)→Mat`, `canny`, `cvtColor`, `matchTemplate`, `minMaxLoc`, `toGray`. Envolve `opencv-wasm` + `pngjs`. |
| `src/main/services/captcha/solvers/slide.ts` | `SlideSolver.findPosition(bgBuf, pieceBuf)`. Porte de `slide.py`. |
| `src/main/services/captcha/geetest-client.ts` | `load()`, `verify()`, `fetchImage()` via `APIRequestContext` do patchright. Porte de `geeked.py`. |
| `scripts/captcha-gate1.mjs` | Spike Gate 1: resolve 1 `slide` do demo end-to-end, imprime SUCCESS/FAIL. |
| `test/captcha-signer.test.ts` | LotParser + AES + PoW + RSA (offline). |
| `test/captcha-deobfuscate.test.ts` | `parseGcaptchaJs` contra fixture (offline). |
| `test/captcha-slide.test.ts` | `SlideSolver` contra imagens-fixture (offline). |
| `test/captcha-image-utils.test.ts` | decode/canny/matchTemplate sanity (offline). |
| `test/fixtures/captcha/slide/bg.png`, `slice.png` | Imagens-fixas do demo (slide). |
| `test/fixtures/captcha/gcaptcha4.sample.js` | Snapshot do `gcaptcha4.js` p/ teste do parser. |
| `test/fixtures/captcha/deobfuscate.expected.json` | Constantes esperadas do snapshot acima. |

---

### Task 1: Scaffold — deps, módulo, fixtures, scripts

**Files:**
- Modify: `package.json` (deps + scripts)
- Create: `src/main/services/captcha/.gitkeep`, `src/main/services/captcha/solvers/.gitkeep`
- Create: `test/fixtures/captcha/slide/bg.png`, `test/fixtures/captcha/slide/slice.png`

**Interfaces:**
- Produces: deps `opencv-wasm`, `pngjs` instalados; dir do módulo; script `captcha:gate1`; fixtures de slide baixadas.

- [ ] **Step 1: Adicionar deps e scripts**

Edite `package.json`: em `dependencies` adicione `"opencv-wasm": "^4.3.0-10"` e `"pngjs": "^7.0.0"`. Em `scripts` adicione `"captcha:gate1": "tsx scripts/captcha-gate1.mjs"` (use `tsx`, não `node` — o script importa source TS; `tsx` é devDep já presente). Não remova nada ainda (remoção do Python é Plan 3).

- [ ] **Step 2: Instalar**

Run: `npm install`
Expected: instala `opencv-wasm` + `pngjs` sem erros.

- [ ] **Step 3: Criar estrutura de dirs e .gitkeep**

```bash
mkdir -p src/main/services/captcha/solvers test/fixtures/captcha/slide
touch src/main/services/captcha/.gitkeep src/main/services/captcha/solvers/.gitkeep
```

- [ ] **Step 4: Baixar fixtures de slide (imagens-fixas do demo)**

```bash
curl -s -m 30 -o test/fixtures/captcha/slide/bg.png "https://static.geetest.com/captcha_v4/e70fbf1d77/slide/0af8d91d43/2022-04-21T09/bg/552119bd2af448b9a3af1ce95b887b90.png"
curl -s -m 30 -o test/fixtures/captcha/slide/slice.png "https://static.geetest.com/captcha_v4/e70fbf1d77/slide/0af8d91d43/2022-04-21T09/slice/552119bd2af448b9a3af1ce95b887b90.png"
```
Verifique: `ls -la test/fixtures/captcha/slide/` → `bg.png` (~51 KB) e `slice.png` (~9 KB). (Posição esperada validada: **81**, mesma do `SlideSolver` Python.)

- [ ] **Step 5: Verificar typecheck limpo**

Run: `npm run check`
Expected: PASS (nada novo em src ainda, só .gitkeep).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/main/services/captcha/.gitkeep src/main/services/captcha/solvers/.gitkeep test/fixtures/captcha/slide/
git commit -m "chore(captcha): scaffold modulo + deps opencv-wasm/pngjs + fixtures de slide"
```

---

### Task 2: `deobfuscate.ts` — porte do parser (offline, testável)

**Files:**
- Create: `src/main/services/captcha/deobfuscate.ts`
- Create: `src/main/services/captcha/constants.ts`
- Create: `test/captcha-deobfuscate.test.ts`
- Create: `test/fixtures/captcha/gcaptcha4.sample.js`, `test/fixtures/captcha/deobfuscate.expected.json`
- Create: `scripts/captcha-capture-deobfuscate.mjs`

**Interfaces:**
- Produces: `parseGcaptchaJs(script: string): { abo: string; mappings: string; deviceId: string }` (exportado de `deobfuscate.ts`); `CURRENT_CONSTANTS` (exportado de `constants.ts`).

- [ ] **Step 1: Capturar fixture (snapshot do gcaptcha4.js + constantes esperadas)**

Crie `scripts/captcha-capture-deobfuscate.mjs`:

```js
import { writeFileSync } from 'node:fs';
import { parseGcaptchaJs } from '../src/main/services/captcha/deobfuscate.js';

const params = new URLSearchParams({
  callback: 'geetest_1738850809870',
  captcha_id: '588a5218557e1eadf33d682a6958c31b',
  challenge: '00000000-0000-0000-0000-000000000000',
  client_type: 'web',
  lang: 'en',
});
const loadUrl = `https://gcaptcha4.geevisit.com/load?${params}`;
const raw = await (await fetch(loadUrl)).text();
const data = JSON.parse(raw.split('geetest_1738850809870(')[1].slice(0, -1));
const staticPath = data.data.static_path;
const js = await (await fetch(`https://static.geevisit.com${staticPath}/js/gcaptcha4.js`)).text();
writeFileSync('test/fixtures/captcha/gcaptcha4.sample.js', js);
const parsed = parseGcaptchaJs(js);
writeFileSync('test/fixtures/captcha/deobfuscate.expected.json', JSON.stringify(parsed, null, 2));
console.log('captured:', parsed);
```

- [ ] **Step 2: Escrever o teste que falha**

`test/captcha-deobfuscate.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGcaptchaJs } from '../src/main/services/captcha/deobfuscate.js';

const sample = readFileSync('test/fixtures/captcha/gcaptcha4.sample.js', 'utf8');
const expected = JSON.parse(readFileSync('test/fixtures/captcha/deobfuscate.expected.json', 'utf8'));

test('parseGcaptchaJs extrai abo/mappings/deviceId do snapshot', () => {
  const got = parseGcaptchaJs(sample);
  assert.deepEqual(got, expected);
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx tsx --test test/captcha-deobfuscate.test.ts`
Expected: FAIL — `Cannot find module '../src/main/services/captcha/deobfuscate.js'` (módulo não existe).

- [ ] **Step 4: Implementar `deobfuscate.ts` (porte direto do `deobfuscate.py`)**

`src/main/services/captcha/deobfuscate.ts`:

```ts
import { fetch } from 'node:undici';

export interface DeobfuscateResult {
  abo: string;
  mappings: string;
  deviceId: string;
}

function decryptTable(tableEncrypted: string, key: string): string[] {
  const keyLen = key.length;
  const out: string[] = [];
  let decrypted = '';
  for (let i = 0; i < tableEncrypted.length; i++) {
    decrypted += String.fromCharCode(tableEncrypted.charCodeAt(i) ^ key.charCodeAt(i % keyLen));
  }
  return decrypted.split('^');
}

export function parseGcaptchaJs(script: string): DeobfuscateResult {
  const tableEnc = decodeURIComponent(script.split('decodeURI("')[1]!.split('"')[0]!);
  const keyMatch = script.match(/}}}\("(.+?)"\)}/);
  if (!keyMatch) throw new Error('deobfuscate: chave da tabela não encontrada');
  const table = decryptTable(tableEnc, keyMatch[1]!);

  for (const m of script.matchAll(/(_.{4})\((\d+?)\)/g)) {
    script = script.replaceAll(`${m[1]}(${m[2]})`, JSON.stringify(table[Number(m[2])]));
  }

  const aboMatch = script.match(/\['_lib']=(.+?),/);
  if (!aboMatch) throw new Error('deobfuscate: abo não encontrado');
  let abo = aboMatch[1]!.replace(/'/g, '"');
  abo = abo.replace(/([{,])\s*([A-Za-z0-9_]+)\s*:/g, '$1"$2":');

  const mappingsMatch = script.match(/\['_abo']=(.+?)}\(\)/);
  if (!mappingsMatch) throw new Error('deobfuscate: mappings não encontrado');
  const mappings = mappingsMatch[1]!;

  const deviceIdMatch = script.match(/\['options']\['deviceId']='(.*?)'/);
  const deviceId = deviceIdMatch ? deviceIdMatch[1]! : '';

  return { abo, mappings, deviceId };
}

export async function fetchAndExtract(): Promise<DeobfuscateResult> {
  const params = new URLSearchParams({
    callback: 'geetest_1738850809870',
    captcha_id: '588a5218557e1eadf33d682a6958c31b',
    challenge: crypto.randomUUID(),
    client_type: 'web',
    lang: 'en',
  });
  const raw = await (await fetch(`https://gcaptcha4.geevisit.com/load?${params}`)).text();
  const data = JSON.parse(raw.split('geetest_1738850809870(')[1].slice(0, -1));
  const staticPath: string = data.data.static_path;
  const js = await (await fetch(`https://static.geevisit.com${staticPath}/js/gcaptcha4.js`)).text();
  return parseGcaptchaJs(js);
}
```

- [ ] **Step 5: Implementar `constants.ts` (valores atuais, capturados live)**

`src/main/services/captcha/constants.ts`:

```ts
export const CURRENT_CONSTANTS = {
  // Capturado em 2026-07-08 via parseGcaptchaJs. Rota quando o GeeTest atualiza
  // o gcaptcha4.js — rode `node scripts/captcha-capture-deobfuscate.mjs` e cole aqui.
  abo: { jCpk: 'yZ7D' },
  mapping: { 'n[20:20]+n[8:8]+n[11:11]+n[30:30]': 'n[16:21]' },
  deviceId: '',
} as const;

// Chave pública RSA do GeeTest (fixa, de sign.py).
export const RSA_PUBKEY = {
  n: '00C1E3934D1614465B33053E7F48EE4EC87B14B95EF88947713D25EECBFF7E74C7977D02DC1D9451F79DD5D1C10C29ACB6A9B4D6FB7D0A0279B6719E1772565F09AF627715919221AEF91899CAE08C0D686D748B20A3603BE2318CA6BC2B59706592A9219D0BF05C9F65023A21D2330807252AE0066D59CEEFA5F2748EA80BAB81',
  e: '10001',
} as const;
```

- [ ] **Step 6: Capturar o fixture (gera sample.js + expected.json)**

Run: `npx tsx scripts/captcha-capture-deobfuscate.mjs`
Expected: imprime `{ abo: '{"jCpk":"yZ7D"}', mappings: '...', deviceId: '' }` (ou valores atuais) e cria os 2 arquivos em `test/fixtures/captcha/`.

- [ ] **Step 7: Rodar teste e ver passar**

Run: `npx tsx --test test/captcha-deobfuscate.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main/services/captcha/deobfuscate.ts src/main/services/captcha/constants.ts test/captcha-deobfuscate.test.ts test/fixtures/captcha/gcaptcha4.sample.js test/fixtures/captcha/deobfuscate.expected.json scripts/captcha-capture-deobfuscate.mjs
git commit -m "feat(captcha): porte do deobfuscate.py para TS (parser + constants)"
```

---

### Task 3: `signer.ts` — porte de `sign.py` (crypto + lot-parser)

**Files:**
- Create: `src/main/services/captcha/signer.ts`
- Create: `test/captcha-signer.test.ts`

**Interfaces:**
- Consumes: `CURRENT_CONSTANTS`, `RSA_PUBKEY` de `constants.ts`; `SlideSolver` da Task 5 (apenas p/ `generateW` — injetado via `solveSlide`).
- Produces: `LotParser`, `randUid()`, `encryptSymmetrical1(plain, randomStr)`, `encryptAsymmetric1(msg)`, `generatePow(...)`, `encryptW(rawInput, pt)`, `generateW(data, captchaId, riskType, fetchImage)`.

- [ ] **Step 1: Escrever testes (offline, determinísticos) que falham**

`test/captcha-signer.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { LotParser, randUid, encryptSymmetrical1, encryptAsymmetric1, generatePow } from '../src/main/services/captcha/signer.js';
import { CURRENT_CONSTANTS } from '../src/main/services/captcha/constants.js';

test('LotParser.getDict produz o dict esperado (fixture)', () => {
  const lp = new LotParser(CURRENT_CONSTANTS.mapping);
  const lot = '0123456789abcdefghijklmnopqrstuvwxyz';
  assert.deepEqual(lp.getDict(lot), { k8bu: 'ghijkl' });
});

test('encryptSymmetrical1 (AES-128-CBC, IV "000...", PKCS7) bate com o oráculo Python', () => {
  const enc = encryptSymmetrical1('hello world', '1234567890123456');
  assert.equal(enc.toString('hex'), '36e6072bf816a299050795547fc6ef7f');
});

test('randUid tem 16 chars hex', () => {
  const uid = randUid();
  assert.equal(uid.length, 16);
  assert.match(uid, /^[0-9a-f]{16}$/);
});

test('generatePow produz solução válida (md5 com prefixo de bits)', () => {
  const r = generatePow('lot123', 'cap456', 'md5', '1', 4, '2026-07-08', '');
  const h = crypto.createHash('md5').update(r.pow_msg).digest('hex');
  assert.equal(h, r.pow_sign, 'pow_sign deve ser md5(pow_msg)');
  assert.ok(r.pow_msg.startsWith('1|4|md5|2026-07-08|cap456|lot123||'), 'pow_msg tem prefixo correto');
  assert.ok(r.pow_sign.startsWith('0'), 'bits=4 => prefixo "0" (1 nibble zero)');
});

test('encryptAsymmetric1 (RSA PKCS1v1.5) gera 128 bytes (256 hex)', () => {
  const enc = encryptAsymmetric1('test');
  assert.equal(enc.length, 256, '1024-bit RSA => 128 bytes => 256 hex');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx tsx --test test/captcha-signer.test.ts`
Expected: FAIL — `Cannot find module '../src/main/services/captcha/signer.js'`.

- [ ] **Step 3: Implementar `signer.ts`**

`src/main/services/captcha/signer.ts`:

```ts
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
  let buf = Buffer.from(hex, 'hex');
  while (buf.length > 1 && buf[0] === 0) buf = buf.subarray(1);
  return buf.toString('base64url');
}
let _pubKey: crypto.KeyObject | undefined;
function getPubKey(): crypto.KeyObject {
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
  } else {
    throw new Error(`generateW: risk_type "${riskType}" não implementado neste plano (Plan 2/3)`);
  }
  return encryptW(JSON.stringify(base), data.pt);
}
```

- [ ] **Step 4: Rodar testes e ver passar**

Run: `npx tsx --test test/captcha-signer.test.ts`
Expected: PASS (5 testes). Se `LotParser` falhar, verifique se `CURRENT_CONSTANTS.mapping` em `constants.ts` bate com o capturado (rode `node scripts/captcha-capture-deobfuscate.mjs`).

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/services/captcha/signer.ts test/captcha-signer.test.ts
git commit -m "feat(captcha): porte do signer (LotParser/AES/RSA/PoW/generateW slide)"
```

---

### Task 4: `image-utils.ts` — wrapper opencv-wasm + pngjs

**Files:**
- Create: `src/main/services/captcha/image-utils.ts`
- Create: `test/captcha-image-utils.test.ts`

**Interfaces:**
- Produces: `decodePng(buf) → Mat`, `canny(src)`, `toGray(src)`, `cvtColor(src, code)`, `matchTemplate(img, templ, method)`, `minMaxLoc(src)`.

- [ ] **Step 1: Escrever teste que falha**

`test/captcha-image-utils.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodePng, toGray, canny, matchTemplate, minMaxLoc } from '../src/main/services/captcha/image-utils.js';

test('decodePpng decodifica bg.png para Mat 300x200', () => {
  const buf = readFileSync('test/fixtures/captcha/slide/bg.png');
  const m = decodePng(buf);
  assert.equal(m.cols, 300);
  assert.equal(m.rows, 200);
});
test('matchTemplate + minMaxLoc acham a peça', () => {
  const bg = decodePng(readFileSync('test/fixtures/captcha/slide/bg.png'));
  const pc = decodePng(readFileSync('test/fixtures/captcha/slide/slice.png'));
  const gbg = toGray(bg); const gpc = toGray(pc);
  const res = matchTemplate(gbg, gpc, 'TM_CCOEFF_NORMED');
  const mm = minMaxLoc(res);
  assert.ok(mm.maxVal > 0.3, `maxVal esperado >0.3, obtido ${mm.maxVal}`);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx tsx --test test/captcha-image-utils.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar `image-utils.ts`**

`src/main/services/captcha/image-utils.ts`:

```ts
import pkg from 'opencv-wasm';
import { PNG } from 'pngjs';
const cv = pkg.cv;

export interface Mat { rows: number; cols: number; data: Uint8Array; channels(): number; delete(): void; }
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
  cv.matchTemplate(img as unknown as InstanceType<typeof cv.Mat>, templ as unknown as InstanceType<typeof cv.Mat>, res, cv[method]);
  return res as unknown as Mat;
}
export interface MinMaxLoc { minVal: number; maxVal: number; minLoc: { x: number; y: number }; maxLoc: { x: number; y: number }; }
export function minMaxLoc(src: Mat): MinMaxLoc {
  return cv.minMaxLoc(src as unknown as InstanceType<typeof cv.Mat>) as unknown as MinMaxLoc;
}
```

- [ ] **Step 4: Rodar testes e ver passar**

Run: `npx tsx --test test/captcha-image-utils.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/services/captcha/image-utils.ts test/captcha-image-utils.test.ts
git commit -m "feat(captcha): image-utils (opencv-wasm + pngjs)"
```

---

### Task 5: `slide.ts` — porte do `SlideSolver`

**Files:**
- Create: `src/main/services/captcha/solvers/slide.ts`
- Create: `test/captcha-slide.test.ts`

**Interfaces:**
- Produces: `findPuzzlePiecePosition(pieceBuf: Buffer, bgBuf: Buffer): number`.
- Consumes: `image-utils.ts`.

- [ ] **Step 1: Escrever teste que falha (posição esperada = 81)**

`test/captcha-slide.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findPuzzlePiecePosition } from '../src/main/services/captcha/solvers/slide.js';

test('findPuzzlePiecePosition = 81 (fixture, oráculo Python)', () => {
  const bg = readFileSync('test/fixtures/captcha/slide/bg.png');
  const pc = readFileSync('test/fixtures/captcha/slide/slice.png');
  const pos = findPuzzlePiecePosition(pc, bg);
  assert.ok(Math.abs(pos - 81) <= 3, `esperado ~81, obtido ${pos}`);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx tsx --test test/captcha-slide.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar `slide.ts`**

`src/main/services/captcha/solvers/slide.ts`:

```ts
import { decodePng, canny, cvtColor, matchTemplate, minMaxLoc, toGray, type Mat } from '../image-utils.js';

interface MatchCandidate { score: number; topX: number; h: number; w: number; }

function matchOne(template: Mat, background: Mat): MatchCandidate {
  const res = matchTemplate(background, template, 'TM_CCOEFF_NORMED');
  const mm = minMaxLoc(res);
  return { score: mm.maxVal, topX: mm.maxLoc.x, h: template.rows, w: template.cols };
}

export function findPuzzlePiecePosition(pieceBuf: Buffer, bgBuf: Buffer): number {
  const puzzle = decodePng(pieceBuf);
  const background = decodePng(bgBuf);

  // 1) match por bordas (Canny) — bom p/ fundos texturizados
  const edgePiece = cvtColor(canny(puzzle, 100, 200), 'COLOR_GRAY2RGB');
  const edgeBg = cvtColor(canny(background, 100, 200), 'COLOR_GRAY2RGB');
  const c1 = matchOne(edgePiece, edgeBg);

  // 2) match direto em tons de cinza — bom p/ fundos de baixo contraste
  const grayPiece = toGray(puzzle);
  const grayBg = toGray(background);
  const c2 = matchOne(grayPiece, grayBg);

  const best = [c1, c2].sort((a, b) => b.score - a.score)[0]!;
  const centerX = best.topX + Math.floor(best.w / 2);
  return centerX - 41;
}
```

- [ ] **Step 4: Rodar teste e ver passar**

Run: `npx tsx --test test/captcha-slide.test.ts`
Expected: PASS (posição ~81).

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/services/captcha/solvers/slide.ts test/captcha-slide.test.ts
git commit -m "feat(captcha): porte do SlideSolver (Canny + matchTemplate)"
```

---

### Task 6: `geetest-client.ts` — `load`/`verify` via patchright

**Files:**
- Create: `src/main/services/captcha/geetest-client.ts`
- Create: `test/captcha-geetest-client.test.ts`

**Interfaces:**
- Consumes: patchright `APIRequestContext`.
- Produces: `class GeetestClient { constructor(req: APIRequestContext); load(captchaId, riskType?): Promise<GeetestLoadData>; verify(captchaId, lotNumber, payload, processToken, w, riskType?): Promise<GeetestVerifyResult>; fetchImage(path): Promise<Buffer> }`.

- [ ] **Step 1: Escrever teste de integração (gated) que falha**

`test/captcha-geetest-client.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'patchright';
import { GeetestClient } from '../src/main/services/captcha/geetest-client.js';

const SLIDE_CAPTCHA_ID = '54088bb07d2df3c46b79f80300b0abbe'; // demo GeeTest v4

test('GeetestClient.load retorna lot_number para um slide do demo', { skip: !process.env.CAPTCHA_INTEGRATION }, async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const client = new GeetestClient(ctx.request, 'https://gcaptcha4.geevisit.com');
  const data = await client.load(SLIDE_CAPTCHA_ID, 'slide');
  assert.ok(data.lot_number, 'deve retornar lot_number');
  await browser.close();
});
```

- [ ] **Step 2: Rodar e ver falhar (skip por padrão; falha com a env)**

Run: `npx tsx --test test/captcha-geetest-client.test.ts`
Expected: PASS com `# SKIP` (sem `CAPTCHA_INTEGRATION`). Com `CAPTCHA_INTEGRATION=1` deve FAIL — módulo não existe.

- [ ] **Step 3: Implementar `geetest-client.ts`**

`src/main/services/captcha/geetest-client.ts`:

```ts
import type { APIRequestContext } from 'patchright';

export interface GeetestLoadData {
  lot_number: string;
  pow_detail: { hashfunc: string; version: string; bits: number; datetime: string };
  pt: string;
  captcha_type?: string;
  payload?: string;
  process_token?: string;
  slice?: string; bg?: string;
  ques?: unknown; imgs?: string; nine_nums?: number;
  [k: string]: unknown;
}
export interface GeetestVerifyResult {
  result?: string;
  seccode?: Record<string, unknown> & { captcha_id?: string; lot_number?: string; pass_token?: string; gen_time?: string; captcha_output?: string };
  [k: string]: unknown;
}

export class GeetestClient {
  private callback: string;
  constructor(
    private readonly req: APIRequestContext,
    private readonly baseUrl: string = 'https://gcaptcha4.geevisit.com',
  ) {
    this.callback = `geetest_${Math.floor(Math.random() * 10000) + Date.now()}`;
  }

  private static randomCallback(): string {
    return `geetest_${Math.floor(Math.random() * 10000) + Date.now()}`;
  }

  private parseJsonp(text: string, callback: string): Record<string, unknown> {
    const prefix = `${callback}(`;
    const start = text.indexOf(prefix);
    if (start < 0) throw new Error(`resposta não-JSONP: ${text.slice(0, 80)}`);
    return JSON.parse(text.slice(start + prefix.length, text.lastIndexOf(')')));
  }

  async load(captchaId: string, riskType?: string | null): Promise<GeetestLoadData> {
    this.callback = GeetestClient.randomCallback();
    const params: Record<string, string> = {
      captcha_id: captchaId,
      challenge: crypto.randomUUID(),
      client_type: 'web',
      lang: 'eng',
      callback: this.callback,
    };
    if (riskType) params.risk_type = riskType;
    const res = await this.req.get(`${this.baseUrl}/load`, { params });
    const data = this.parseJsonp(await res.text(), this.callback)['data'] as GeetestLoadData;
    return data;
  }

  async verify(args: {
    captchaId: string; lotNumber: string; payload: string; processToken: string;
    w: string; riskType?: string | null;
  }): Promise<GeetestVerifyResult> {
    this.callback = GeetestClient.randomCallback();
    const params: Record<string, string> = {
      callback: this.callback,
      captcha_id: args.captchaId,
      client_type: 'web',
      lot_number: args.lotNumber,
      payload: args.payload,
      process_token: args.processToken,
      payload_protocol: '1',
      pt: '1',
      w: args.w,
    };
    if (args.riskType) params.risk_type = args.riskType;
    const res = await this.req.get(`${this.baseUrl}/verify`, { params });
    return this.parseJsonp(await res.text(), this.callback) as unknown as GeetestVerifyResult;
  }

  async fetchImage(path: string): Promise<Buffer> {
    const url = path.startsWith('http') ? path : `https://static.geetest.com/${path}`;
    const res = await this.req.get(url);
    return Buffer.from(await res.body());
  }
}
```

- [ ] **Step 4: Rodar teste de integração (com a env)**

Run: `CAPTCHA_INTEGRATION=1 npx tsx --test test/captcha-geetest-client.test.ts`
Expected: PASS (retorna `lot_number`). Se falhar com erro de TLS/fingerprint, registrar — isso é exatamente o sinal de NO-GO do Gate 1.

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/services/captcha/geetest-client.ts test/captcha-geetest-client.test.ts
git commit -m "feat(captcha): geetest-client (load/verify via APIRequestContext patchright)"
```

---

### Task 7: Gate 1 — spike end-to-end + registro do resultado

**Files:**
- Create: `scripts/captcha-gate1.mjs`

**Interfaces:**
- Consumes: `GeetestClient`, `generateW`, `findPuzzlePiecePosition` (Tasks 3, 5, 6).

- [ ] **Step 1: Escrever o script do spike**

`scripts/captcha-gate1.mjs`:

```js
import { chromium } from 'patchright';
import { GeetestClient } from '../src/main/services/captcha/geetest-client.js';
import { generateW } from '../src/main/services/captcha/signer.js';
import { findPuzzlePiecePosition } from '../src/main/services/captcha/solvers/slide.js';

const CAPTCHA_ID = '54088bb07d2df3c46b79f80300b0abbe'; // demo slide
const RISK_TYPE = 'slide';
const MAX_RETRIES = 5;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const client = new GeetestClient(ctx.request, 'https://gcaptcha4.geevisit.com');

let lastErr;
for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  try {
    const data = await client.load(CAPTCHA_ID, RISK_TYPE);
    const w = await generateW(data, CAPTCHA_ID, RISK_TYPE, (p) => client.fetchImage(p), findPuzzlePiecePosition);
    const res = await client.verify({
      captchaId: CAPTCHA_ID, lotNumber: data.lot_number,
      payload: data.payload!, processToken: data.process_token!, w, riskType: RISK_TYPE,
    });
    if (res.result === 'success' || res.seccode) {
      console.log('GATE1=SUCCESS', JSON.stringify(res.seccode ?? res));
      process.exit(0);
    }
    lastErr = new Error(`result=${res.result ?? 'none'} msg=${res['msg'] ?? ''}`);
    console.log(`attempt ${attempt}: ${lastErr.message}`);
  } catch (e) {
    lastErr = e;
    console.log(`attempt ${attempt} erro: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log('GATE1=FAIL', lastErr?.message ?? 'unknown');
process.exit(1);
```

- [ ] **Step 2: Rodar o spike (Gate 1 — go/no-go)**

Run: `npm run captcha:gate1`
Expected: imprime `GATE1=SUCCESS {...seccode...}` (exit 0). **Se SUCCESS → GO**: o caminho 100% TS + patchright é viável; prossiga para Plan 2. **Se FAIL sistemático (erro de TLS/`msg` de fingerprint)** → **NO-GO**: registrar e acionar o Plano B (sidecar Python embarcado) — o `signer` e `slide` são reaproveitados.

- [ ] **Step 3: Commit do script**

```bash
git add scripts/captcha-gate1.mjs
git commit -m "test(captcha): spike Gate 1 (load+solve+verify slide end-to-end)"
```

- [ ] **Step 4: Registrar o resultado na issue #3**

Comente na issue #3 o outcome:
- Se GO: "Gate 1 (TLS/JA3 via patchright) validado — `load`+`verify` end-to-end de `slide` retorna `success`. Próximo: Plan 2 (Gates 2/3 de visão)."
- Se NO-GO: "Gate 1 falhou (<erro>). Acionando Plano B (sidecar Python embarcado, sem torch). `signer`/`slide` reaproveitados."

```bash
gh issue comment 3 --repo henocdejesusferreirafarias/spider-bot-desktop --body "<outcome do Gate 1>"
```

- [ ] **Step 5: Push**

Run: `git push`
Expected: branch `feat/solver-captcha-ts` atualizado no remoto.

---

## Self-Review (feito após escrever)

**1. Spec coverage:** A spec (seções 4, 8) exige validar o Gate 1 (TLS) e portar `deobfuscate`/`signer`/`slide`/`geetest-client`. As Tasks 2–7 cobrem cada um; a Task 7 é o Gate 1. Gates 2/3 (visão ONNX) e o build-out (remover Python/rewiring) estão explicitamente no Plan 2/3 (YAGNI). ✅
**2. Placeholder scan:** Sem TBD/TODO. Valores esperados são reais e capturados (`{"k8bu":"ghijkl"}`, `36e607…`, posição `81`, RSA 128 bytes). ✅
**3. Type consistency:** `GeetestLoadData` (Task 6) ↔ consumido por `generateW(data, …)` (Task 3) — campos `lot_number`, `pow_detail`, `pt`, `slice`, `bg` batem. `findPuzzlePiecePosition(pieceBuf, bgBuf)` (Task 5) ↔ `SlideSolverFn = (pieceBuf, bgBuf) => number` (Task 3) — assinatura bate. `decodePng`/`matchTemplate`/`minMaxLoc` (Task 4) ↔ usados em `slide.ts` (Task 5) — nomes batem. ✅

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-08-geetest-captcha-solver-gate1-spike.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**

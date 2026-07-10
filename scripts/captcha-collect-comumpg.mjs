import { parseArgs } from './captcha-nine-dataset-utils.mjs';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export { parseArgs };

export const DEFAULTS = {
  count: 100,
  out: 'dataset/raw',
  delayMs: 600,
  captchaId: '62c528ead784206de7e6db17765b9ac0',
  host: 'gcaptcha4-hrc.gsensebot.com',
  clientType: 'h5',
  lang: 'por',
  referer: 'https://www.comumpg.co/',
  userAgent:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
  append: false,
  saveRaw: false,
  withClassifier: false,
};

export function parseJsonp(text, callback) {
  const prefix = `${callback}(`;
  const start = text.indexOf(prefix);
  if (start < 0) throw new Error(`not JSONP: ${text.slice(0, 80)}`);
  return JSON.parse(text.slice(start + prefix.length, text.lastIndexOf(')')));
}

function buildHeaders({ referer, userAgent, secFetchDest, accept }) {
  return {
    Accept: accept,
    'Accept-Language': 'pt-BR,pt;q=0.7',
    Referer: referer,
    'User-Agent': userAgent,
    'Sec-Fetch-Dest': secFetchDest,
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'cross-site',
  };
}

export async function loadComumpg({
  fetchImpl,
  captchaId = DEFAULTS.captchaId,
  host = DEFAULTS.host,
  clientType = DEFAULTS.clientType,
  lang = DEFAULTS.lang,
  referer = DEFAULTS.referer,
  userAgent = DEFAULTS.userAgent,
}) {
  const fetchFn = fetchImpl ?? globalThis.fetch;
  const callback = `geetest_${Date.now()}`;
  const search = new URLSearchParams({
    callback,
    captcha_id: captchaId,
    challenge: crypto.randomUUID(),
    client_type: clientType,
    lang,
  });
  const url = `https://${host}/load?${search}`;
  const res = await fetchFn(url, {
    headers: buildHeaders({ referer, userAgent, secFetchDest: 'script', accept: '*/*' }),
  });
  const text = await res.text();
  const contentType = res.headers?.get?.('content-type') ?? '';
  if (!contentType.includes('javascript') || !text.startsWith(`${callback}(`)) {
    if (res.status === 403 || res.status === 412 || !contentType.includes('javascript')) {
      throw new Error(`blocked by EdgeOne WAF; pause and retry later (status=${res.status}, ct=${contentType.slice(0, 40)})`);
    }
    throw new Error(`load failed: status=${res.status} body=${text.slice(0, 160)}`);
  }
  const parsed = parseJsonp(text, callback);
  if (parsed.status !== 'success') throw new Error(`load non-success: ${JSON.stringify(parsed).slice(0, 200)}`);
  const data = parsed.data;
  data.__rawBody = text;
  return data;
}

export async function fetchComumpgImage({
  fetchImpl,
  path,
  referer = DEFAULTS.referer,
  userAgent = DEFAULTS.userAgent,
  accept = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
}) {
  const fetchFn = fetchImpl ?? globalThis.fetch;
  const target = path.startsWith('http') ? path : `https://static.geetest.com/${path}`;
  const res = await fetchFn(target, {
    headers: buildHeaders({ referer, userAgent, secFetchDest: 'image', accept }),
  });
  if (!res.ok) throw new Error(`image fetch ${res.status}: ${target}`);
  return Buffer.from(await res.arrayBuffer());
}

export function nextIndex(outRoot, append) {
  if (!append || !existsSync(outRoot)) return 0;
  let max = -1;
  for (const entry of readdirSync(outRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^(\d{6})-/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

export function writeChallenge({ outRoot, index, data, grid, ques, saveRaw, loadBody }) {
  const lotNumber = String(data.lot_number);
  const id = `${String(index).padStart(6, '0')}-${lotNumber}`;
  const dir = join(outRoot, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'grid.jpg'), grid);
  writeFileSync(join(dir, 'ques.png'), ques);
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    id,
    source: 'comumpg',
    captchaId: String(data.captcha_id ?? DEFAULTS.captchaId),
    host: DEFAULTS.host,
    clientType: DEFAULTS.clientType,
    lang: DEFAULTS.lang,
    lotNumber,
    nineNums: Number(data.nine_nums ?? 3),
    gridPath: String(data.imgs ?? ''),
    quesPath: Array.isArray(data.ques) && typeof data.ques[0] === 'string' ? data.ques[0] : '',
    targetClass: null,
    targetScore: null,
    capturedAt: new Date().toISOString(),
  }, null, 2));
  if (saveRaw && loadBody) writeFileSync(join(dir, 'load.json'), loadBody);
  return id;
}

export async function runCollect(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available; pass fetchImpl or run on Node 22+');
  mkdirSync(opts.out, { recursive: true });
  const startIndex = nextIndex(opts.out, opts.append);
  const collected = [];
  let skipped = 0;

  for (let i = 0; i < opts.count; i++) {
    const data = await loadComumpg({ fetchImpl, captchaId: opts.captchaId, host: opts.host, clientType: opts.clientType, lang: opts.lang, referer: opts.referer, userAgent: opts.userAgent });
    const lotNumber = String(data.lot_number);
    const alreadyExists = readdirSync(opts.out, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .some((e) => e.name.endsWith(`-${lotNumber}`));
    if (alreadyExists) {
      skipped += 1;
      console.log(`[${i + 1}/${opts.count}] dup=${lotNumber} skipped`);
      continue;
    }
    const grid = await fetchComumpgImage({ fetchImpl, path: String(data.imgs), referer: opts.referer, userAgent: opts.userAgent });
    const quesPaths = Array.isArray(data.ques) ? data.ques : [];
    const quesPath = typeof quesPaths[0] === 'string' ? quesPaths[0] : null;
    if (!data.imgs || !quesPath) throw new Error(`challenge ${i}: missing imgs or ques path`);
    const ques = await fetchComumpgImage({ fetchImpl, path: quesPath, referer: opts.referer, userAgent: opts.userAgent });
    const id = writeChallenge({ outRoot: opts.out, index: startIndex + collected.length, data, grid, ques, saveRaw: opts.saveRaw, loadBody: opts.saveRaw ? data.__rawBody : null });
    collected.push(id);
    console.log(`[${i + 1}/${opts.count}] ${id} nine=${Number(data.nine_nums ?? 3)}`);
    if (opts.delayMs > 0 && i < opts.count - 1) await new Promise((r) => setTimeout(r, opts.delayMs));
  }

  return { collected: collected.length, skipped, outRoot: opts.out, entries: collected };
}

function isMainModule() {
  return process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;
}

if (isMainModule()) {
  console.error('captcha-collect-comumpg: not implemented yet');
  process.exitCode = 1;
}
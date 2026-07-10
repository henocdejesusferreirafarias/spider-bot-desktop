import { parseArgs } from './captcha-nine-dataset-utils.mjs';

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
  return parsed.data;
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

export function runCollect(_options = {}) {
  throw new Error('not implemented');
}

function isMainModule() {
  return process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;
}

if (isMainModule()) {
  console.error('captcha-collect-comumpg: not implemented yet');
  process.exitCode = 1;
}
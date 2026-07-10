import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonp } from '../scripts/captcha-collect-comumpg.mjs';

const fixture = readFileSync(
  join(process.cwd(), 'test', 'fixtures', 'captcha', 'comumpg', 'load.jsonp'),
  'utf8',
);

test('parseJsonp extracts the data object from the recorded comumpg load response', () => {
  const parsed = parseJsonp(fixture, 'geetest_1783644449318');
  assert.equal(parsed.status, 'success');
  const data = parsed.data as Record<string, unknown>;
  assert.equal(data.lot_number, '45ed640cfa9640558baf7b42c11d018d');
  assert.equal(data.captcha_type, 'nine');
  assert.equal(data.nine_nums, 3);
  assert.equal(data.imgs, 'captcha_v4/15a082f210/nine/680eb6dc2f/2025-09-12T14/ac1979a2b9f94bb8beb53854643ac039.jpg');
  assert.deepEqual(data.ques, ['nerualpic/v4_pic/nine_prompt/74b865cec1369cc94e6749e164a54dcb.png']);
});

test('parseJsonp throws when the callback prefix is missing', () => {
  assert.throws(() => parseJsonp('not jsonp at all', 'geetest_1783644449318'), /not JSONP/);
});

import { loadComumpg } from '../scripts/captcha-collect-comumpg.mjs';

const FAKE_GRID = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]); // JPEG SOI + JFIF marker
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG 8-byte signature

function mockFetchLoad(loadBody: string) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    if (url.includes('/load')) {
      const sentCallback = new URL(url).searchParams.get('callback') ?? '';
      const echoedBody = sentCallback
        ? loadBody.replace(/^geetest_\d+\(/, `${sentCallback}(`)
        : loadBody;
      return {
        ok: true,
        status: 200,
        headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/javascript;charset=UTF-8' : null) },
        text: async () => echoedBody,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
      arrayBuffer: async () => FAKE_GRID.buffer.slice(FAKE_GRID.byteOffset, FAKE_GRID.byteOffset + FAKE_GRID.byteLength),
    } as unknown as Response;
  };
  return { fetchImpl, calls };
}

test('loadComumpg parses the recorded JSONP and returns the data object', async () => {
  const { fetchImpl } = mockFetchLoad(fixture);
  const data = (await loadComumpg({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    captchaId: '62c528ead784206de7e6db17765b9ac0',
  })) as Record<string, unknown>;
  assert.equal(data.lot_number, '45ed640cfa9640558baf7b42c11d018d');
  assert.equal(data.captcha_type, 'nine');
});

test('loadComumpg sends comumpg host, query params, and headers from the HAR', async () => {
  const { fetchImpl, calls } = mockFetchLoad(fixture);
  await loadComumpg({ fetchImpl: fetchImpl as unknown as typeof fetch });
  const call = calls[0]!;
  assert.match(call.url, /^https:\/\/gcaptcha4-hrc\.gsensebot\.com\/load\?/);
  assert.match(call.url, /captcha_id=62c528ead784206de7e6db17765b9ac0/);
  assert.match(call.url, /client_type=h5/);
  assert.match(call.url, /lang=por/);
  assert.match(call.url, /callback=geetest_\d+/);
  assert.match(call.url, /challenge=[0-9a-f-]{36}/);
  assert.equal(call.headers.Referer, 'https://www.comumpg.co/');
  assert.match(call.headers['User-Agent'], /Pixel 9/);
  assert.equal(call.headers['Sec-Fetch-Dest'], 'script');
});

test('loadComumpg throws a clear WAF message on a non-JSONP HTML response', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 403,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => '<html><title>blocked</title></html>',
    arrayBuffer: async () => new ArrayBuffer(0),
  }) as unknown as Response;
  await assert.rejects(
    () => loadComumpg({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    /blocked by EdgeOne WAF/,
  );
});

import { fetchComumpgImage } from '../scripts/captcha-collect-comumpg.mjs';

function mockFetchImage(buffer: Buffer) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    } as unknown as Response;
  };
  return { fetchImpl, calls };
}

test('fetchComumpgImage prefixes static.geetest.com for a relative path and returns the bytes', async () => {
  const { fetchImpl, calls } = mockFetchImage(FAKE_PNG);
  const buf = await fetchComumpgImage({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    path: 'nerualpic/v4_pic/nine_prompt/74b865cec1369cc94e6749e164a54dcb.png',
  });
  assert.deepEqual(Array.from(buf), Array.from(FAKE_PNG));
  assert.equal(calls[0]!.url, 'https://static.geetest.com/nerualpic/v4_pic/nine_prompt/74b865cec1369cc94e6749e164a54dcb.png');
  assert.equal(calls[0]!.headers.Referer, 'https://www.comumpg.co/');
  assert.equal(calls[0]!.headers['Sec-Fetch-Dest'], 'image');
});

test('fetchComumpgImage uses an absolute url verbatim when path starts with http', async () => {
  const { fetchImpl, calls } = mockFetchImage(FAKE_GRID);
  await fetchComumpgImage({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    path: 'https://cdn.example.com/x.jpg',
  });
  assert.equal(calls[0]!.url, 'https://cdn.example.com/x.jpg');
});

test('fetchComumpgImage throws on non-200 status', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response;
  await assert.rejects(
    () => fetchComumpgImage({ fetchImpl: fetchImpl as unknown as typeof fetch, path: 'x.jpg' }),
    /image fetch 404/,
  );
});

import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runCollect } from '../scripts/captcha-collect-comumpg.mjs';

function fullMockFetch(loadBody: string, grid: Buffer, ques: Buffer) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    if (url.includes('/load')) {
      const sentCallback = new URL(url).searchParams.get('callback') ?? '';
      const echoedBody = sentCallback
        ? loadBody.replace(/^geetest_\d+\(/, `${sentCallback}(`)
        : loadBody;
      return {
        ok: true,
        status: 200,
        headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/javascript;charset=UTF-8' : null) },
        text: async () => echoedBody,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }
    const buf = url.endsWith('.jpg') ? grid : ques;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    } as unknown as Response;
  };
  return { fetchImpl, calls };
}

test('runCollect writes grid.jpg, ques.png, and meta.json with comumpg provenance', async () => {
  const out = mkdtempSync(join(tmpdir(), 'comumpg-happy-'));
  const { fetchImpl } = fullMockFetch(fixture, FAKE_GRID, FAKE_PNG);
  const result = await runCollect({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    count: 1,
    out,
    delayMs: 0,
  });
  assert.equal(result.collected, 1);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.entries, ['000000-45ed640cfa9640558baf7b42c11d018d']);
  const dir = join(out, '000000-45ed640cfa9640558baf7b42c11d018d');
  assert.ok(existsSync(join(dir, 'grid.jpg')));
  assert.ok(existsSync(join(dir, 'ques.png')));
  assert.deepEqual(Array.from(readFileSync(join(dir, 'grid.jpg'))).slice(0, 4), [0xff, 0xd8, 0xff, 0xe0]);
  assert.deepEqual(Array.from(readFileSync(join(dir, 'ques.png')).slice(0, 8)), Array.from(FAKE_PNG));
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.id, '000000-45ed640cfa9640558baf7b42c11d018d');
  assert.equal(meta.source, 'comumpg');
  assert.equal(meta.captchaId, '62c528ead784206de7e6db17765b9ac0');
  assert.equal(meta.host, 'gcaptcha4-hrc.gsensebot.com');
  assert.equal(meta.clientType, 'h5');
  assert.equal(meta.lang, 'por');
  assert.equal(meta.lotNumber, '45ed640cfa9640558baf7b42c11d018d');
  assert.equal(meta.nineNums, 3);
  assert.equal(meta.gridPath, 'captcha_v4/15a082f210/nine/680eb6dc2f/2025-09-12T14/ac1979a2b9f94bb8beb53854643ac039.jpg');
  assert.equal(meta.quesPath, 'nerualpic/v4_pic/nine_prompt/74b865cec1369cc94e6749e164a54dcb.png');
  assert.equal(meta.targetClass, null);
  assert.equal(meta.targetScore, null);
  assert.match(meta.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('runCollect with append continues from the max existing numeric prefix', async () => {
  const out = mkdtempSync(join(tmpdir(), 'comumpg-append-'));
  mkdirSync(join(out, '000007-abc'), { recursive: true });
  writeFileSync(join(out, '000007-abc', 'meta.json'), '{}');
  const { fetchImpl } = fullMockFetch(fixture, FAKE_GRID, FAKE_PNG);
  const result = await runCollect({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    count: 1,
    out,
    append: true,
    delayMs: 0,
  });
  assert.deepEqual(result.entries, ['000008-45ed640cfa9640558baf7b42c11d018d']);
  const dirs = readdirSync(out).sort();
  assert.deepEqual(dirs, ['000007-abc', '000008-45ed640cfa9640558baf7b42c11d018d']);
});

test('runCollect skips a challenge whose lot_number directory already exists', async () => {
  const out = mkdtempSync(join(tmpdir(), 'comumpg-dedup-'));
  mkdirSync(join(out, '000000-45ed640cfa9640558baf7b42c11d018d'), { recursive: true });
  writeFileSync(join(out, '000000-45ed640cfa9640558baf7b42c11d018d', 'meta.json'), '{}');
  const { fetchImpl } = fullMockFetch(fixture, FAKE_GRID, FAKE_PNG);
  const result = await runCollect({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    count: 1,
    out,
    delayMs: 0,
  });
  assert.equal(result.collected, 0);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.entries, []);
  const dirs = readdirSync(out).sort();
  assert.deepEqual(dirs, ['000000-45ed640cfa9640558baf7b42c11d018d']);
});

test('runCollect fails fast on a WAF 403 response and writes no directory', async () => {
  const out = mkdtempSync(join(tmpdir(), 'comumpg-waf-'));
  const fetchImpl = async () => ({
    ok: true,
    status: 403,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    text: async () => '<html><title>blocked</title></html>',
    arrayBuffer: async () => new ArrayBuffer(0),
  }) as unknown as Response;
  await assert.rejects(
    () => runCollect({ fetchImpl: fetchImpl as unknown as typeof fetch, count: 1, out, delayMs: 0 }),
    /blocked by EdgeOne WAF/,
  );
  assert.deepEqual(readdirSync(out), []);
});

test('runCollect with saveRaw also writes load.json with the raw JSONP body', async () => {
  const out = mkdtempSync(join(tmpdir(), 'comumpg-saveraw-'));
  const { fetchImpl } = fullMockFetch(fixture, FAKE_GRID, FAKE_PNG);
  await runCollect({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    count: 1,
    out,
    delayMs: 0,
    saveRaw: true,
  });
  const dir = join(out, '000000-45ed640cfa9640558baf7b42c11d018d');
  const raw = readFileSync(join(dir, 'load.json'), 'utf8');
  assert.ok(raw.startsWith('geetest_'));
  assert.match(raw, /45ed640cfa9640558baf7b42c11d018d/);
});
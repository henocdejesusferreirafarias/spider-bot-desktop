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
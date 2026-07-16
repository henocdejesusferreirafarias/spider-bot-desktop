import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { LotParser, randUid, encryptSymmetrical1, encryptAsymmetric1, generatePow, generateNineW, getPubKey } from '../src/main/services/captcha/signer.js';
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

test('encryptAsymmetric1 usa chave RSA com exponent 65537 (e=AQAB)', () => {
  const jwk = getPubKey().export({ format: 'jwk' }) as { e: string };
  assert.equal(jwk.e, 'AQAB', 'e deve ser 65537 (AQAB em base64url), não 4096');
});

test('generateNineW starts grid and prompt downloads concurrently', async () => {
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const fetchImage = (path: string) => new Promise<Buffer>((resolve) => {
    started.push(path);
    releases.set(path, () => resolve(Buffer.from(path)));
  });
  const resultPromise = generateNineW(
    {
      lot_number: '0123456789abcdefghijklmnopqrstuvwxyz',
      pow_detail: { hashfunc: 'md5', version: '1', bits: 0, datetime: '2026-07-16' },
      pt: '0',
      imgs: 'grid.jpg',
      ques: ['ques.png'],
      nine_nums: 3,
    },
    'captcha-1',
    fetchImage,
    async () => [[1, 1], [2, 2], [3, 3]],
  );

  await Promise.resolve();
  assert.deepEqual(started, ['grid.jpg', 'ques.png']);
  releases.get('grid.jpg')?.();
  releases.get('ques.png')?.();
  assert.match(await resultPromise, /userresponse/);
});

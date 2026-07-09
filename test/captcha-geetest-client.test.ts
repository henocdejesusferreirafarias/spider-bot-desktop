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

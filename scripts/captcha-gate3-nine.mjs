import { existsSync } from 'node:fs';
import { chromium } from 'patchright';
import { GeetestClient } from '../src/main/services/captcha/geetest-client.js';
import { generateW } from '../src/main/services/captcha/signer.js';

const N = Number(process.argv[2]) || 15;
const MODEL = 'assets/captcha/nine_photo.onnx';
const CLASSES = 'assets/captcha/nine_classes.json';
const DEMO = 'https://gt4.geetest.com/demov4/nine-popup-en.html';

if (!existsSync(MODEL) || !existsSync(CLASSES)) {
  console.log(`GATE3=BLOCKED missing ${MODEL} or ${CLASSES}; run scripts/captcha-train-photo.py first`);
  process.exit(2);
}

async function captureCaptchaId(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let captchaId = null;
  page.on('request', (request) => {
    const match = request.url().match(/captcha_id=([a-f0-9]+)/);
    if (match) captchaId = match[1];
  });
  try {
    await page.goto(DEMO, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const button = await page.$('.geetest_btn_click, [class*="geetest_btn_click"]');
    if (button) await button.click();
    await page.waitForTimeout(2000);
    if (!captchaId) throw new Error('no captcha_id captured');
    return captchaId;
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  const captchaId = await captureCaptchaId(browser);
  console.log(`nine captcha_id: ${captchaId}`);
  const context = await browser.newContext();
  const client = new GeetestClient(context.request, 'https://gcaptcha4.geevisit.com');
  let ok = 0;
  for (let i = 0; i < N; i++) {
    try {
      const data = await client.load(captchaId, 'nine');
      const w = await generateW(data, captchaId, 'nine', (path) => client.fetchImage(path), () => 0);
      const result = await client.verify({
        captchaId,
        lotNumber: data.lot_number,
        payload: String(data.payload ?? ''),
        processToken: String(data.process_token ?? ''),
        w,
        riskType: 'nine',
      });
      if (result.result === 'success' || result.seccode) {
        ok++;
        console.log(`[${i + 1}/${N}] OK`);
      } else {
        console.log(`[${i + 1}/${N}] FAIL result=${result.result ?? 'unknown'}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[${i + 1}/${N}] ERR ${message.slice(0, 160)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const rate = ok / N;
  console.log(`GATE3=nine-photo rate=${(rate * 100).toFixed(1)}% (${ok}/${N})`);
  console.log(rate >= 0.9 ? 'GATE3=SUCCESS' : 'GATE3=FAIL (<90%)');
  process.exit(rate >= 0.9 ? 0 : 1);
} finally {
  await browser.close();
}

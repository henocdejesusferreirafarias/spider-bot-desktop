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
      payload: data.payload, processToken: data.process_token, w, riskType: RISK_TYPE,
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

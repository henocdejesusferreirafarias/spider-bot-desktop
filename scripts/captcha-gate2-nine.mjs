import { chromium } from 'patchright';
import { GeetestClient } from '../src/main/services/captcha/geetest-client.js';
import { generateW } from '../src/main/services/captcha/signer.js';

const N = Number(process.argv[2]) || 10;
const DEMO = 'https://gt4.geetest.com/demov4/nine-popup-en.html';
const browser = await chromium.launch({ headless: true });
const capPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let captchaId = null;
capPage.on('request', (r) => { const m = r.url().match(/captcha_id=([a-f0-9]+)/); if (m) captchaId = m[1]; });
await capPage.goto(DEMO, { waitUntil: 'domcontentloaded' }); await capPage.waitForTimeout(4000);
const btn = await capPage.$('.geetest_btn_click, [class*="geetest_btn_click"]'); if (btn) await btn.click();
await capPage.waitForTimeout(2000); await capPage.close();
if (!captchaId) { console.log('GATE2=FAIL no captcha_id captured'); process.exit(1); }
console.log('nine captcha_id:', captchaId);
const ctx = await browser.newContext();
const client = new GeetestClient(ctx.request, 'https://gcaptcha4.geevisit.com');
let ok = 0;
for (let i = 0; i < N; i++) {
  try {
    const data = await client.load(captchaId, 'nine');
    const w = await generateW(data, captchaId, 'nine', (p) => client.fetchImage(p), () => 0);
    const res = await client.verify({ captchaId, lotNumber: data.lot_number, payload: data.payload, processToken: data.process_token, w, riskType: 'nine' });
    if (res.result === 'success' || res.seccode) { ok++; console.log(`[${i}] OK`); } else { console.log(`[${i}] FAIL result=${res.result}`); }
  } catch (e) { console.log(`[${i}] ERR ${e.message.slice(0,100)}`); }
  await new Promise(r => setTimeout(r, 500));
}
await browser.close();
const rate = (ok / N * 100).toFixed(1);
console.log(`GATE2=nine rate=${rate}% (${ok}/${N})`);
console.log(rate >= 90 ? 'GATE2=SUCCESS' : 'GATE2=FAIL (<90% -> Plan 2c mini-CNN)');
process.exit(rate >= 90 ? 0 : 1);

// Spike vivo da Solução B (matching perceptual/shape) no desafio "nine" do GeeTest v4.
// Replica o branch nine do generateW, mas pluga células das técnicas de similaridade
// (não chama o solver ONNX). Documenta a taxa de acerto real (esperado ~0% — gap semântico).
import { chromium } from 'patchright';
import { GeetestClient } from '../src/main/services/captcha/geetest-client.js';
import { generatePow, encryptW, LotParser } from '../src/main/services/captcha/signer.js';
import { CURRENT_CONSTANTS } from '../src/main/services/captcha/constants.js';
import { decodeRGBA, TECHNIQUES } from './captcha-perceptual-match.mjs';

const N = Number(process.argv[2]) || 6;
const TECH_FILTER = process.argv[3] || null; // nome da técnica p/ isolar (ex: 'edge-energy')
const DEMO = 'https://gt4.geetest.com/demov4/nine-popup-en.html';

const lotParser = new LotParser(CURRENT_CONSTANTS.mapping);
function humanPasstime(base = 1000, perUnit = 0, spread = 400) {
  const v = base + perUnit + (Math.random() - 0.5) * 2 * spread;
  return Math.max(280, Math.min(4500, Math.round(v)));
}
function buildWNine(data, captchaId, cells) {
  const lotNumber = data.lot_number, pow = data.pow_detail;
  const base = {
    ...CURRENT_CONSTANTS.abo,
    ...generatePow(lotNumber, captchaId, pow.hashfunc, pow.version, pow.bits, pow.datetime, ''),
    ...lotParser.getDict(lotNumber),
    biht: '1426265548',
    device_id: CURRENT_CONSTANTS.deviceId,
    em: { cp: 0, ek: '11', nt: 0, ph: 0, sc: 0, si: 0, wd: 1 },
    gee_guard: { roe: { auh: '3', aup: '3', cdc: '3', egp: '3', res: '3', rew: '3', sep: '3', snh: '3' } },
    ep: '123', geetest: 'captcha', lang: 'zh', lot_number: lotNumber,
    passtime: humanPasstime(1000, 0, 400),
    userresponse: cells,
  };
  return encryptW(JSON.stringify(base), data.pt);
}

const browser = await chromium.launch({ headless: true });
const capPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let captchaId = null;
capPage.on('request', (r) => { const m = r.url().match(/captcha_id=([a-f0-9]+)/); if (m) captchaId = m[1]; });
await capPage.goto(DEMO, { waitUntil: 'domcontentloaded' });
await capPage.waitForTimeout(4000);
const btn = await capPage.$('.geetest_btn_click, [class*="geetest_btn_click"]');
if (btn) await btn.click();
await capPage.waitForTimeout(2000);
await capPage.close();
if (!captchaId) { console.log('SPIKE-B=FAIL no captcha_id captured'); process.exit(1); }
console.log('nine captcha_id:', captchaId);

const ctx = await browser.newContext();
const client = new GeetestClient(ctx.request, 'https://gcaptcha4.geevisit.com');

const results = {};
for (const tech of TECHNIQUES) {
  let ok = 0;
  for (let i = 0; i < N; i++) {
    try {
      const data = await client.load(captchaId, 'nine');
      const gridBuf = await client.fetchImage(data.imgs);
      const quesBufs = (data.ques ?? []);
      const qBuf = quesBufs[0] ? await client.fetchImage(quesBufs[0]) : Buffer.alloc(0);
      const grid = decodeRGBA(gridBuf);
      const ques = decodeRGBA(qBuf);
      const cells = tech.fn(grid.data, grid.width, grid.height, ques.data, ques.width, ques.height, Number(data.nine_nums ?? 3));
      const w = buildWNine(data, captchaId, cells);
      const res = await client.verify({ captchaId, lotNumber: data.lot_number, payload: data.payload, processToken: data.process_token, w, riskType: 'nine' });
      const pass = res.result === 'success' || res.seccode;
      if (pass) ok++;
      console.log(`[${tech.name} ${i}] ${pass ? 'OK' : 'FAIL result=' + res.result} cells=${JSON.stringify(cells)}`);
    } catch (e) {
      console.log(`[${tech.name} ${i}] ERR ${e.message.slice(0, 120)}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  results[tech.name] = { ok, N, rate: (ok / N * 100).toFixed(1) };
}

await browser.close();
console.log('\n=== SPIKE-B SUMMARY (solução perceptual/shape) ===');
for (const t of TECHNIQUES) console.log(`${t.name.padEnd(16)} ${results[t.name].rate}% (${results[t.name].ok}/${results[t.name].N})`);
const anySuccess = Object.values(results).some((r) => r.ok > 0);
console.log(anySuccess ? 'SPIKE-B=SOME-SUCCESS (reavaliar)' : 'SPIKE-B=DEAD (~0% — gap semântico confirmado, ir p/ modelo semântico leve)');
process.exit(anySuccess ? 0 : 1);

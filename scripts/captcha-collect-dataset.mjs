import { chromium } from 'patchright';
import { writeFileSync, mkdirSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map(a => a.startsWith('--') ? [a.slice(2), true] : ['count', a]));
const COUNT = Number(args.count) || 5;
const DEMO = 'https://gt4.geetest.com/demov4/nine-popup-en.html';
const out = 'test/fixtures/captcha/dataset/nine';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });

for (let i = 0; i < COUNT; i++) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let captchaId = null, gridPath = null, ques = [];
  page.on('request', (r) => {
    const u = r.url();
    const m = u.match(/captcha_id=([a-f0-9]+)/); if (m) captchaId = m[1];
    if (u.includes('static.geetest.com/') && u.includes('/nine/') && !u.includes('nine_prompt')) gridPath = u.split('static.geetest.com/')[1];
    if (u.includes('nine_prompt')) { const p = u.split('static.geetest.com/')[1]; if (!ques.includes(p)) ques.push(p); }
  });
  await page.goto(DEMO, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(4000);
  const btn = await page.$('.geetest_btn_click, [class*="geetest_btn_click"]'); if (btn) await btn.click();
  await page.waitForTimeout(4000);
  await page.close();
  if (!gridPath || !ques.length) { console.log(`[${i}] no capture, skip`); continue; }
  const dir = `${out}/${i}`; mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/grid.jpg`, Buffer.from(await (await fetch('https://static.geetest.com/'+gridPath)).arrayBuffer()));
  writeFileSync(`${dir}/ques.png`, Buffer.from(await (await fetch('https://static.geetest.com/'+ques[0])).arrayBuffer()));
  writeFileSync(`${dir}/meta.json`, JSON.stringify({ captchaId, gridPath, quesPaths: ques, nineNums: 3 }, null, 2));
  console.log(`[${i}] captured captchaId=${captchaId}`);
}
await browser.close();
console.log('done');

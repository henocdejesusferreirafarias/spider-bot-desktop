import { chromium } from 'patchright';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = 'test/fixtures/captcha/nine/ques.png';
const DEMO = 'https://gt4.geetest.com/demov4/nine-popup-en.html';
const MAX_RETRIES = 5;

mkdirSync('test/fixtures/captcha/nine', { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const quesUrls = [];
page.on('request', (req) => {
  const u = req.url();
  if (u.includes('nine_prompt') || u.includes('ques')) quesUrls.push(u);
});

let captured = false;
for (let attempt = 1; attempt <= MAX_RETRIES && !captured; attempt++) {
  try {
    await page.goto(DEMO, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const btn = page.locator('.geetest_btn_click');
    await btn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(4000);
    if (quesUrls.length > 0) {
      const url = quesUrls[0];
      const buf = await (await ctx.request.get(url)).body();
      writeFileSync(OUT, buf);
      console.log(`captured attempt ${attempt}: ${url} (${buf.length} bytes) -> ${OUT}`);
      captured = true;
    } else {
      console.log(`attempt ${attempt}: nenhum nine_prompt capturado`);
    }
  } catch (e) {
    console.log(`attempt ${attempt} erro: ${e.message}`);
  }
}

await browser.close();

if (!captured) {
  console.log('CAPTURE=FAIL');
  process.exit(1);
}
console.log('CAPTURE=OK');

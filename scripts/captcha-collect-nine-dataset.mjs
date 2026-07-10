import { chromium } from 'patchright';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GeetestClient } from '../src/main/services/captcha/geetest-client.js';
import { getClassifier } from '../src/main/services/captcha/onnx-session.js';
import { decodeImage } from '../src/main/services/captcha/image-utils.js';
import { parseArgs } from './captcha-nine-dataset-utils.mjs';

const args = parseArgs(process.argv.slice(2));
const count = Number(args.count ?? 100);
const outRoot = String(args.out ?? 'dataset/raw');
const delayMs = Number(args.delayMs ?? 500);
const append = Boolean(args.append);
const useClassifier = args.classifier !== false && args.classifier !== 'false' && !args['no-classifier'];
const demoUrl = 'https://gt4.geetest.com/demov4/nine-popup-en.html';

function nextIndex(root) {
  if (!append || !existsSync(root)) return 0;
  let max = -1;
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const match = name.name.match(/^(\d{6})-/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

async function captureCaptchaId(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let captchaId = null;
  page.on('request', (request) => {
    const match = request.url().match(/captcha_id=([a-f0-9]+)/);
    if (match) captchaId = match[1];
  });
  try {
    await page.goto(demoUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const button = await page.$('.geetest_btn_click, [class*="geetest_btn_click"]');
    if (button) await button.click();
    await page.waitForTimeout(2000);
    if (!captchaId) throw new Error('no captcha_id captured from demo page');
    return captchaId;
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  const captchaId = await captureCaptchaId(browser);
  const context = await browser.newContext();
  const client = new GeetestClient(context.request, 'https://gcaptcha4.geevisit.com');
  const classifier = useClassifier ? getClassifier() : null;
  const startIndex = nextIndex(outRoot);
  mkdirSync(outRoot, { recursive: true });
  console.log(`captcha_id=${captchaId}`);
  console.log(`out=${outRoot} startIndex=${startIndex} count=${count} classifier=${Boolean(classifier)}`);

  for (let i = 0; i < count; i++) {
    const data = await client.load(captchaId, 'nine');
    const quesPaths = Array.isArray(data.ques) ? data.ques : [];
    const quesPath = typeof quesPaths[0] === 'string' ? quesPaths[0] : null;
    if (!data.imgs || !quesPath) throw new Error(`challenge ${i}: missing imgs or ques path`);
    const grid = await client.fetchImage(data.imgs);
    const ques = await client.fetchImage(quesPath);
    let target = null;
    if (classifier) {
      const decodedQues = decodeImage(ques);
      target = await classifier.classify(decodedQues.data, decodedQues.width, decodedQues.height);
    }
    const id = `${String(startIndex + i).padStart(6, '0')}-${data.lot_number}`;
    const dir = join(outRoot, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'grid.jpg'), grid);
    writeFileSync(join(dir, 'ques.png'), ques);
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({
      id,
      captchaId,
      lotNumber: data.lot_number,
      targetClass: target?.label ?? null,
      targetScore: target?.score ?? null,
      nineNums: Number(data.nine_nums ?? 3),
      gridPath: data.imgs,
      quesPath,
      capturedAt: new Date().toISOString(),
    }, null, 2));
    console.log(`[${i + 1}/${count}] ${id} target=${target?.label ?? 'none'}`);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
} finally {
  await browser.close();
}

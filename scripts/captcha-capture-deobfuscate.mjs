import { writeFileSync } from 'node:fs';
import { parseGcaptchaJs } from '../src/main/services/captcha/deobfuscate.js';

const params = new URLSearchParams({
  callback: 'geetest_1738850809870',
  captcha_id: '588a5218557e1eadf33d682a6958c31b',
  challenge: '00000000-0000-0000-0000-000000000000',
  client_type: 'web',
  lang: 'en',
});
const loadUrl = `https://gcaptcha4.geevisit.com/load?${params}`;
const raw = await (await fetch(loadUrl)).text();
const data = JSON.parse(raw.split('geetest_1738850809870(')[1].slice(0, -1));
const staticPath = data.data.static_path;
const js = await (await fetch(`https://static.geevisit.com${staticPath}/js/gcaptcha4.js`)).text();
writeFileSync('test/fixtures/captcha/gcaptcha4.sample.js', js);
const parsed = parseGcaptchaJs(js);
writeFileSync('test/fixtures/captcha/deobfuscate.expected.json', JSON.stringify(parsed, null, 2));
console.log('captured:', parsed);

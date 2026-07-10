import { parseArgs } from './captcha-nine-dataset-utils.mjs';

export { parseArgs };

export const DEFAULTS = {
  count: 100,
  out: 'dataset/raw',
  delayMs: 600,
  captchaId: '62c528ead784206de7e6db17765b9ac0',
  host: 'gcaptcha4-hrc.gsensebot.com',
  clientType: 'h5',
  lang: 'por',
  referer: 'https://www.comumpg.co/',
  userAgent:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
  append: false,
  saveRaw: false,
  withClassifier: false,
};

export function runCollect(_options = {}) {
  throw new Error('not implemented');
}

function isMainModule() {
  return process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;
}

if (isMainModule()) {
  console.error('captcha-collect-comumpg: not implemented yet');
  process.exitCode = 1;
}
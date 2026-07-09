export const CURRENT_CONSTANTS = {
  // Capturado em 2026-07-08 via parseGcaptchaJs. Rota quando o GeeTest atualiza
  // o gcaptcha4.js — rode `npx tsx scripts/captcha-capture-deobfuscate.mjs` e cole aqui.
  abo: { jCpk: 'yZ7D' },
  mapping: { 'n[20:20]+n[8:8]+n[11:11]+n[30:30]': 'n[16:21]' },
  deviceId: '',
} as const;

// Chave pública RSA do GeeTest (fixa, de sign.py).
export const RSA_PUBKEY = {
  n: '00C1E3934D1614465B33053E7F48EE4EC87B14B95EF88947713D25EECBFF7E74C7977D02DC1D9451F79DD5D1C10C29ACB6A9B4D6FB7D0A0279B6719E1772565F09AF627715919221AEF91899CAE08C0D686D748B20A3603BE2318CA6BC2B59706592A9219D0BF05C9F65023A21D2330807252AE0066D59CEEFA5F2748EA80BAB81',
  e: '10001',
} as const;

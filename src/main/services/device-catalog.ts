// Catalogo de dispositivos moveis reais usado pela emulacao mobile do browser-runtime.
//
// Motivacao: antes existia UM unico dispositivo embutido (Samsung Galaxy S21 / SM-G991B)
// e qualquer UA de iPhone era descartado por um regex de "mobile". Agora cada perfil/janela
// recebe deterministicamente um dispositivo DISTINTO deste catalogo, variando UA,
// UA-Client-Hints (plataforma/versao/modelo), nucleos de CPU, memoria e pontos de toque.
//
// A selecao e estavel por perfil (hash do profileId): a mesma janela sempre se apresenta
// como o mesmo aparelho entre reinicios — requisito de anti-deteccao (um perfil que muda
// de telefone a cada login e sinal de bot).
//
// Apenas Android: o engine real e Chromium (Blink). UAs de iOS sobre Chromium deixam
// window.chrome presente, e deteccoes como deviceandbrowserinfo.com/are_you_a_bot
// marcam hasInconsistentChromeObject (o Safari no iOS nunca expoe window.chrome). Como
// o Patchright restaura window.chrome no nivel do engine quando a emulacao e iOS,
// nao da para suprimir via init script — entao iOS foi removido do catalogo.
//
// NOTA (tablets): nao incluimos UAs de tablet/iPad. A plataforma alvo serve um layout
// "largo" (desktop-like) para tablets, quebrando o encaixe da janela na grade de telas.
// Apenas telefones (layout mobile estreito) sao emulados.

export type DeviceOs = "android";

export interface DeviceProfile {
  /** Chave estavel (nao exibida). */
  readonly key: string;
  /** Rotulo legivel para logs/diagnostico (ex.: "Samsung Galaxy S23"). */
  readonly label: string;
  readonly os: DeviceOs;
  /** User-Agent completo enviado no header e em navigator.userAgent. */
  readonly userAgent: string;
  /** UA-CH: plataforma ("Android"). */
  readonly uaPlatform: string;
  /** UA-CH: versao da plataforma (ex.: "14.0.0"). */
  readonly uaPlatformVersion: string;
  /** UA-CH: modelo do aparelho (ex.: "SM-S911B"). */
  readonly uaModel: string;
  /** Versao major do Chrome usada nas brands UA-CH. */
  readonly chromeMajor: string;
  /** Versao completa do Chrome para fullVersionList. */
  readonly chromeFull: string;
  readonly hardwareConcurrency: number;
  /** navigator.deviceMemory (bucket: 0.25/0.5/1/2/4/8). */
  readonly deviceMemory: number;
  readonly maxTouchPoints: number;
}

// Versoes de Chrome variadas (usuarios atualizam em ritmos diferentes) — todas plausiveis
// e modernas. A UA Android usa a forma reduzida MAJOR.0.0.0.
const androidUA = (androidVersion: string, model: string, chromeMajor: string): string =>
  `Mozilla/5.0 (Linux; Android ${androidVersion}; ${model}) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Mobile Safari/537.36`;

const android = (
  key: string,
  label: string,
  androidVersion: string,
  model: string,
  chromeMajor: string,
  chromeFull: string,
  hardwareConcurrency: number,
  deviceMemory: number
): DeviceProfile => ({
  key,
  label,
  os: "android",
  userAgent: androidUA(androidVersion, model, chromeMajor),
  uaPlatform: "Android",
  uaPlatformVersion: `${androidVersion}.0.0`,
  uaModel: model,
  chromeMajor,
  chromeFull,
  hardwareConcurrency,
  deviceMemory,
  maxTouchPoints: 5
});

/**
 * Catalogo de aparelhos. Apenas Android (engine Chromium consistente).
 * Adicione novos aparelhos aqui — a selecao por perfil os distribui automaticamente.
 */
export const DEVICE_CATALOG: readonly DeviceProfile[] = [
  // === Samsung Galaxy ===
  android("galaxy-s21", "Samsung Galaxy S21", "13", "SM-G991B", "131", "131.0.6778.135", 8, 8),
  android("galaxy-s22", "Samsung Galaxy S22", "14", "SM-S901B", "130", "130.0.6723.103", 8, 8),
  android("galaxy-s23", "Samsung Galaxy S23", "14", "SM-S911B", "131", "131.0.6778.135", 8, 8),
  android("galaxy-s24", "Samsung Galaxy S24", "14", "SM-S921B", "129", "129.0.6668.100", 8, 8),
  android("galaxy-a54", "Samsung Galaxy A54", "14", "SM-A546B", "128", "128.0.6613.146", 8, 6),
  android("galaxy-a14", "Samsung Galaxy A14", "13", "SM-A145M", "130", "130.0.6723.103", 8, 4),
  android("galaxy-note20", "Samsung Galaxy Note 20", "13", "SM-N981B", "126", "126.0.6478.122", 8, 8),
  android("galaxy-s20", "Samsung Galaxy S20", "13", "SM-G980F", "127", "127.0.6533.103", 8, 8),
  android("galaxy-s25", "Samsung Galaxy S25", "15", "SM-S931B", "132", "132.0.6834.122", 8, 8),
  android("galaxy-zflip5", "Samsung Galaxy Z Flip5", "14", "SM-F731B", "131", "131.0.6778.135", 8, 8),
  android("galaxy-zfold5", "Samsung Galaxy Z Fold5", "14", "SM-F946B", "130", "130.0.6723.103", 8, 8),
  android("galaxy-a34", "Samsung Galaxy A34", "14", "SM-A346M", "129", "129.0.6668.100", 8, 6),
  android("galaxy-a15", "Samsung Galaxy A15", "14", "SM-A155M", "131", "131.0.6778.135", 8, 4),
  android("galaxy-m54", "Samsung Galaxy M54", "14", "SM-M546B", "128", "128.0.6613.146", 8, 6),
  // === Google Pixel ===
  android("pixel-5", "Google Pixel 5", "13", "Pixel 5", "127", "127.0.6533.103", 8, 8),
  android("pixel-6", "Google Pixel 6", "14", "Pixel 6", "130", "130.0.6723.103", 8, 8),
  android("pixel-7", "Google Pixel 7", "14", "Pixel 7", "131", "131.0.6778.135", 8, 8),
  android("pixel-8", "Google Pixel 8", "14", "Pixel 8", "131", "131.0.6778.135", 8, 8),
  android("pixel-8a", "Google Pixel 8a", "14", "Pixel 8a", "130", "130.0.6723.103", 8, 8),
  android("pixel-9", "Google Pixel 9", "15", "Pixel 9", "132", "132.0.6834.122", 8, 8),
  // === Xiaomi / Redmi / POCO ===
  android("redmi-note12", "Xiaomi Redmi Note 12", "13", "23021RAAEG", "129", "129.0.6668.100", 8, 6),
  android("redmi-note13", "Xiaomi Redmi Note 13 Pro", "14", "23090RA98G", "131", "131.0.6778.135", 8, 8),
  android("redmi-12", "Xiaomi Redmi 12", "13", "23053RN02A", "128", "128.0.6613.146", 8, 4),
  android("poco-x6", "Xiaomi POCO X6 Pro", "14", "23122PCD1G", "130", "130.0.6723.103", 8, 8),
  android("xiaomi-13", "Xiaomi 13", "14", "2211133G", "129", "129.0.6668.100", 8, 8),
  android("xiaomi-14", "Xiaomi 14", "14", "23127PN0CG", "132", "132.0.6834.122", 8, 8),
  android("mi-11", "Xiaomi Mi 11", "13", "M2011K2G", "128", "128.0.6613.146", 8, 8),
  // === Motorola ===
  android("moto-g84", "Motorola Moto G84", "14", "moto g84 5G", "130", "130.0.6723.103", 8, 8),
  android("moto-edge40", "Motorola Edge 40", "14", "motorola edge 40", "131", "131.0.6778.135", 8, 8),
  android("moto-g54", "Motorola Moto G54", "14", "moto g54 5G", "129", "129.0.6668.100", 8, 8),
  // === OnePlus / Realme / Oppo / Vivo ===
  android("oneplus-11", "OnePlus 11", "14", "CPH2449", "131", "131.0.6778.135", 8, 8),
  android("oneplus-nord3", "OnePlus Nord 3", "14", "CPH2493", "130", "130.0.6723.103", 8, 8),
  android("realme-11", "Realme 11 Pro", "14", "RMX3771", "129", "129.0.6668.100", 8, 8),
  android("oppo-reno10", "OPPO Reno10", "14", "CPH2531", "130", "130.0.6723.103", 8, 8),
  android("vivo-y36", "vivo Y36", "13", "V2247", "128", "128.0.6613.146", 8, 6),
  // === Outros (Nothing / Honor / Asus / Sony / Tecno / Infinix) ===
  android("nothing-2", "Nothing Phone (2)", "14", "A065", "131", "131.0.6778.135", 8, 8),
  android("honor-90", "Honor 90", "14", "REA-NX9", "130", "130.0.6723.103", 8, 8),
  android("asus-rog7", "Asus ROG Phone 7", "14", "ASUS_AI2205_C", "132", "132.0.6834.122", 8, 8),
  android("sony-xperia1v", "Sony Xperia 1 V", "14", "XQ-DQ72", "131", "131.0.6778.135", 8, 8),
  android("tecno-spark10", "Tecno Spark 10", "13", "TECNO KI5q", "127", "127.0.6533.103", 8, 4),
  android("infinix-hot30", "Infinix Hot 30", "13", "Infinix X6831", "128", "128.0.6613.146", 8, 4)
];

/**
 * Hash determinista FNV-1a (32 bits) sobre o profileId. Estavel entre processos,
 * sem dependencia de ordem de lancamento.
 */
const fnv1a = (value: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    // Multiplicacao FNV mantida em 32 bits sem estourar o Number.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

/**
 * Seleciona deterministicamente um aparelho para o perfil. A mesma chave sempre
 * mapeia para o mesmo aparelho — janelas diferentes (perfis diferentes) recebem,
 * na pratica, aparelhos diferentes, maximizando a variacao do fingerprint.
 */
export const selectMobileDevice = (profileId: string): DeviceProfile => {
  const pool = DEVICE_CATALOG;
  const index = fnv1a(profileId || "default") % pool.length;
  return pool[index] ?? pool[0]!;
};

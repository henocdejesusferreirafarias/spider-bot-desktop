export interface DeobfuscateResult {
  abo: string;
  mappings: string;
  deviceId: string;
}

function decryptTable(tableEncrypted: string, key: string): string[] {
  const keyLen = key.length;
  let decrypted = '';
  for (let i = 0; i < tableEncrypted.length; i++) {
    decrypted += String.fromCharCode(tableEncrypted.charCodeAt(i) ^ key.charCodeAt(i % keyLen));
  }
  return decrypted.split('^');
}

function pyRepr(value: string): string {
  const hasSingle = value.includes("'");
  const hasDouble = value.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";
  let escaped = value.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), '\\' + quote);
  escaped = escaped.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  return quote + escaped + quote;
}

export function parseGcaptchaJs(script: string): DeobfuscateResult {
  const tableEnc = decodeURIComponent(script.split('decodeURI("')[1]!.split('"')[0]!);
  const keyMatch = script.match(/}}}\("(.+?)"\)}/);
  if (!keyMatch) throw new Error('deobfuscate: chave da tabela não encontrada');
  const table = decryptTable(tableEnc, keyMatch[1]!);

  for (const m of script.matchAll(/(_.{4})\((\d+?)\)/g)) {
    script = script.replaceAll(`${m[1]}(${m[2]})`, () => pyRepr(table[Number(m[2])]!));
  }

  const aboMatch = script.match(/\['_lib']=(.+?),/);
  if (!aboMatch) throw new Error('deobfuscate: abo não encontrado');
  let abo = aboMatch[1]!.replace(/'/g, '"');
  abo = abo.replace(/([{,])\s*([A-Za-z0-9_]+)\s*:/g, '$1"$2":');

  const mappingsMatch = script.match(/\['_abo']=(.+?)}\(\)/);
  if (!mappingsMatch) throw new Error('deobfuscate: mappings não encontrado');
  const mappings = mappingsMatch[1]!;

  const deviceIdMatch = script.match(/\['options']\['deviceId']='(.*?)'/);
  const deviceId = deviceIdMatch ? deviceIdMatch[1]! : '';

  return { abo, mappings, deviceId };
}

export async function fetchAndExtract(): Promise<DeobfuscateResult> {
  const params = new URLSearchParams({
    callback: 'geetest_1738850809870',
    captcha_id: '588a5218557e1eadf33d682a6958c31b',
    challenge: crypto.randomUUID(),
    client_type: 'web',
    lang: 'en',
  });
  const raw = await (await fetch(`https://gcaptcha4.geevisit.com/load?${params}`)).text();
  const data = JSON.parse(raw.split('geetest_1738850809870(')[1]!.slice(0, -1));
  const staticPath: string = data.data.static_path;
  const js = await (await fetch(`https://static.geevisit.com${staticPath}/js/gcaptcha4.js`)).text();
  return parseGcaptchaJs(js);
}

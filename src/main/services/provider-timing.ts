// Registry de perfis de timing ("Speed Time") por PROVEDOR de jogo.
//
// O "Speed Time" e um time-scale hack: acelera o relogio do jogo (overrides de
// setTimeout/setInterval/requestAnimationFrame/Date.now/performance.now no frame
// do jogo) e, para engines que expoem um timeScale (Cocos/PG), patcha o bundle
// para ler o fator de velocidade. Antes isso era 100% amarrado ao PG/Cocos por
// heuristicas espalhadas em browser-runtime.ts. Aqui centralizamos a DETECCAO e
// os VALORES como DADO, e deixamos as poucas ESTRATEGIAS de patch como codigo
// selecionado por dado.
//
// == Como adicionar um provedor (dado, nao codigo) ==
// 1. Descubra a URL do iframe do jogo do provedor (abra um jogo, veja o src do
//    iframe). Extraia um padrao estavel para `gameFrameUrlPattern` (testado
//    contra o pathname da URL).
// 2. Adicione uma entrada em PROVIDER_TIMING_PROFILES com id/label, o padrao de
//    frame, e `speedStrategy: "generic-timers"` (acelera via overrides de timer,
//    funciona para a maioria dos engines HTML5). `speedRange` normalmente {1,25}.
// 3. Rode um jogo do provedor com Speed>1 e confirme que acelera.
// 4. SO se os timers genericos nao acelerarem aquele engine: adicione o padrao do
//    bundle (`scriptMatch`) + `engineBundleTokens` e uma nova EngineSpeedStrategy
//    com sua funcao de patch (codigo) em patchGameSpeedScript(). Ver "cocos-timescale".

import type { Frame, Page } from "patchright";

export type EngineSpeedStrategy =
  | "cocos-timescale"
  | "cocos-director-tick"
  | "uht-delta-time"
  | "generic-timers";

export interface ProviderTimingProfile {
  readonly id: string;
  readonly label: string;
  // Reconhece o iframe do jogo (gate para injetar o speed no mundo principal).
  // Testado contra o pathname da URL (com fallback para a string inteira).
  readonly gameFrameUrlPattern: RegExp;
  // Reconhece o bundle do engine a ser interceptado/patchado na rede. So e
  // necessario para estrategias que reescrevem o bundle (ex.: cocos-timescale).
  readonly scriptMatch?: {
    readonly hostPattern?: RegExp;
    readonly pathPattern?: RegExp;
  };
  // Tokens que confirmam o engine dentro do corpo do bundle (evita patchar JS
  // aleatorio que so casou o padrao de URL).
  readonly engineBundleTokens?: readonly string[];
  readonly speedStrategy: EngineSpeedStrategy;
  readonly speedRange: { readonly min: number; readonly max: number };
  // Alguns launchers usam tokens de navegacao descartaveis. Neles, recarregar
  // automaticamente o frame nao recupera a carga e pode invalidar a sessao.
  readonly supportsAutomaticFrameReload?: boolean;
}

const DEFAULT_SPEED_RANGE = { min: 1, max: 25 } as const;

// PG SOFT (engine Cocos) — comportamento historico, migrado 1:1.
const PG_PROFILE: ProviderTimingProfile = {
  id: "pg",
  label: "PG Soft (Cocos)",
  // iframe do jogo servido sob /<gameId>/index.html.
  gameFrameUrlPattern: /\/\d+\/index\.html$/i,
  // bundle Cocos: CDN classico (host "static.*") OU pack /<gameId>/*.js.
  scriptMatch: {
    hostPattern: /(^|\.)static\./i,
    pathPattern: /^\/\d+\//
  },
  engineBundleTokens: ["_timeScale", "Director", "requestAnimationFrame"],
  speedStrategy: "cocos-timescale",
  speedRange: DEFAULT_SPEED_RANGE
};

// Hosts do WG variam entre sessoes; a rota e so uma candidata. O runtime ainda
// exige cc.Director.prototype.tick antes de aplicar a estrategia Cocos.
const WG_PROFILE: ProviderTimingProfile = {
  id: "wg",
  label: "WG (Cocos 3)",
  gameFrameUrlPattern: /\/clientv3\/index\.html$/i,
  speedStrategy: "cocos-director-tick",
  speedRange: DEFAULT_SPEED_RANGE
};

// JDB abre o launcher em uma nova aba e o jogo em um iframe com hosts dinamicos.
// A combinacao de parametros pertence ao launcher interno e foi observada em
// jogos distintos (mType 8001 e 8048), sem depender do dominio de entrega.
const JDB_PROFILE: ProviderTimingProfile = {
  id: "jdb",
  label: "JDB (HTML5/WebGL)",
  gameFrameUrlPattern: /(?=[^#]*[?&]gVer=[^&#]+)(?=[^#]*[?&]gameType=\d+)(?=[^#]*[?&]mType=\d+)/i,
  speedStrategy: "generic-timers",
  speedRange: DEFAULT_SPEED_RANGE,
  supportsAutomaticFrameReload: false
};

// PP usa hosts dinamicos, mas o documento real do engine UHT conserva este
// pathname. O wrapper /gs2c/playGame.do fica fora do gate de Speed Time.
const PP_PROFILE: ProviderTimingProfile = {
  id: "pp",
  label: "Pragmatic Play (UHT)",
  gameFrameUrlPattern: /\/gs2c\/html5Game\.do$/i,
  speedStrategy: "uht-delta-time",
  speedRange: DEFAULT_SPEED_RANGE
};

// Fallback: nenhum provedor casou. Usa timers genericos e uma faixa padrao. Nao
// tem gameFrameUrlPattern proprio (nao e usado para detectar, so como default de
// configuracao quando ja se sabe que e um game frame).
export const DEFAULT_PROVIDER_TIMING_PROFILE: ProviderTimingProfile = {
  id: "default",
  label: "Generico",
  gameFrameUrlPattern: /$a/, // nunca casa (usado so como default de config)
  speedStrategy: "generic-timers",
  speedRange: DEFAULT_SPEED_RANGE
};

export const PROVIDER_TIMING_PROFILES: readonly ProviderTimingProfile[] = [
  PG_PROFILE,
  WG_PROFILE,
  JDB_PROFILE,
  PP_PROFILE
];

function urlPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// Resolve o provedor pelo URL do iframe do jogo. undefined = nao e game frame.
export function resolveProviderByFrameUrl(url: string): ProviderTimingProfile | undefined {
  const pathname = urlPathname(url);
  return PROVIDER_TIMING_PROFILES.find(
    (p) => p.gameFrameUrlPattern.test(pathname) || p.gameFrameUrlPattern.test(url)
  );
}

// Qualquer provedor conhecido reconhece este frame como um jogo? (gate de speed)
export function isKnownGameFrameUrl(url: string): boolean {
  return resolveProviderByFrameUrl(url) !== undefined;
}

// Resolve o provedor pelo URL de um script/bundle (para o patch de rede). So
// casa provedores com scriptMatch (estrategias que reescrevem bundle).
export function resolveProviderByScriptUrl(url: string): ProviderTimingProfile | undefined {
  let host = "";
  let pathname = "";
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    pathname = parsed.pathname;
  } catch {
    pathname = url;
  }
  const isJs = /\.js(?:$|[?#])/i.test(pathname) || /\.js(?:$|[?#])/i.test(url);
  if (!isJs) {
    return undefined;
  }
  return PROVIDER_TIMING_PROFILES.find((p) => {
    if (!p.scriptMatch) {
      return false;
    }
    const { hostPattern, pathPattern } = p.scriptMatch;
    return Boolean((hostPattern && hostPattern.test(host)) || (pathPattern && pathPattern.test(pathname)));
  });
}

// O corpo do bundle contem os tokens que confirmam o engine do provedor?
export function bundleMatchesEngine(body: string, profile: ProviderTimingProfile): boolean {
  if (!profile.engineBundleTokens || profile.engineBundleTokens.length === 0) {
    return false;
  }
  return profile.engineBundleTokens.every((token) => body.includes(token));
}

function clampToRange(rate: number, profile: ProviderTimingProfile): number {
  const { min, max } = profile.speedRange;
  const n = Number(rate);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
}

// Estrategia Cocos/PG: substitui `this._timeScale = 1` por um getter que le o
// fator de velocidade somente depois que o script do mundo principal marca o
// frame como pronto. O bundle falha fechado em 1x enquanto o loading existir.
function patchCocosTimeScale(body: string, rate: number, profile: ProviderTimingProfile): string {
  const speedRate = clampToRange(rate, profile);
  const { min, max } = profile.speedRange;
  if (
    !body.includes("_timeScale") ||
    !body.includes("requestAnimationFrame") ||
    !/(?:cc\[["']Director["']\]|["']Director["'])/.test(body)
  ) {
    return body;
  }

  const gameSpeedGetter =
    `Object.defineProperty(this,"_timeScale",{configurable:true,get:function(){try{var d=globalThis.document;var root=d&&d.documentElement;if(!root||root.getAttribute("data-rtc-game-ready")!=="1")return 1;var v=root.getAttribute("data-rtc-speed")||root.getAttribute("data-pg-speed-rate");if(!v&&globalThis.localStorage)v=globalThis.localStorage.getItem("__pg_speed_rate");var n=Number(v);return Math.max(${min},Math.min(${max},Number.isFinite(n)?n:${JSON.stringify(speedRate)}))}catch(e){return 1}},set:function(v){try{this.__predatorOriginalTimeScale=v}catch(e){}}})`;
  const patched = body
    .replace(/this\["_timeScale"\]\s*=\s*1/g, gameSpeedGetter)
    .replace(/this\['_timeScale'\]\s*=\s*1/g, gameSpeedGetter)
    .replace(/this\._timeScale\s*=\s*1/g, gameSpeedGetter);

  if (patched === body) {
    return body;
  }

  return patched;
}

// Aplica a estrategia de aceleracao do provedor ao corpo do bundle. Para
// "generic-timers" nao ha patch de bundle (os overrides de timer no frame do
// jogo cuidam da aceleracao) — retorna o body intacto.
export function patchGameSpeedScript(body: string, rate: number, profile: ProviderTimingProfile): string {
  switch (profile.speedStrategy) {
    case "cocos-timescale":
      return patchCocosTimeScale(body, rate, profile);
    case "cocos-director-tick":
    case "uht-delta-time":
    case "generic-timers":
    default:
      return body;
  }
}

// Serializa os padroes de frame conhecidos (regex sources) para injetar no script
// do mundo principal, que precisa reconhecer "e um game frame?" no contexto da
// pagina (sem acesso ao registry Node).
export function knownGameFramePatternSources(): string[] {
  return PROVIDER_TIMING_PROFILES.map((p) => p.gameFrameUrlPattern.source);
}

// Padroes que usam o loop publico do Director do Cocos, em vez de patch de bundle.
export function cocosDirectorTickFramePatternSources(): string[] {
  return PROVIDER_TIMING_PROFILES
    .filter((profile) => profile.speedStrategy === "cocos-director-tick")
    .map((profile) => profile.gameFrameUrlPattern.source);
}

// Padroes cujo runtime expoe o delta global do engine UHT.
export function uhtDeltaTimeFramePatternSources(): string[] {
  return PROVIDER_TIMING_PROFILES
    .filter((profile) => profile.speedStrategy === "uht-delta-time")
    .map((profile) => profile.gameFrameUrlPattern.source);
}

// Tipo utilitario para consumidores que ja tem um Page/Frame.
export type SpeedTarget = Page | Frame;

import type { Frame, Page } from "patchright";

// Ponte de navegacao com a SPA da plataforma (Vue 2 ou Vue 3).
//
// Em vez de imitar cliques de tabbar (fragil sob carga), navegamos chamando o
// router da propria SPA (`$router.push`). Isso troca a navegacao linear por
// salto direto de rota, mantendo as janelas visiveis (a tela muda ao vivo).
//
// IMPORTANTE: o patchright roda `evaluate` num mundo ISOLADO por padrao (stealth),
// onde `window.$router` e os expandos `__vue__`/`__vue_app__` NAO sao visiveis.
// Para acessar o router temos que rodar no MAIN world: o 3o argumento de
// `evaluate(fn, arg, isolatedContext)` controla isso; `false` = main world.
//
// O patchright serializa cada callback de `evaluate` isoladamente (sem closures),
// entao o localizador do router (`findRouter`) e embutido inline em cada callback.
const MAIN_WORLD = false;

export const MAJORITY_WITHDRAWAL_PASSWORD_SETUP_ROUTE =
  "/home/security?active=5&redirect=%257B%2522name%2522%253A%2522withdraw%2522%252C%2522query%2522%253A%257B%2522active%2522%253A20%257D%257D";

export type SpaHandle = Page | Frame;

export type RouteKind = "withdrawal" | "passwordSetup" | "profile" | "home" | "slotSearch" | "betReport" | "treasureChests";

export interface RouteInfo {
  name: string | null;
  path: string | null;
  fullPath: string | null;
  query: Record<string, string>;
}

// Alvo aceito pelo `router.push`: string de path (com query) ou objeto.
export type RouteTarget = string | { name?: string; path?: string; query?: Record<string, string> };

export interface PlatformDescriptor {
  id: string;
  hostPattern: RegExp;
  // Onde a SPA vive. "top" = documento principal; { frameMatch } = iframe cujo
  // url/name casa o padrao (reservado para a plataforma do iframe).
  appRoot: "top" | { frameMatch: RegExp };
  // Override explicito de rota observada (path + query) por tela. Quando ausente,
  // cai na resolucao fuzzy pela tabela viva do router.
  routes: Partial<Record<RouteKind, RouteTarget>>;
}

// GameCancer e o template padrao da maioria das plataformas. Excecoes entram no
// mapa por host abaixo; host desconhecido cai neste descritor em vez de usar fuzzy.
const MAJORITY_PLATFORM_DESCRIPTOR: PlatformDescriptor = {
  id: "gamecancer-majority",
  hostPattern: /(^|\.)gamecancer\.com$/i,
  appRoot: "top",
  routes: {
    home: "/",
    betReport: { path: "/home/report", query: { reportCurrent: "1" } },
    profile: { path: "/home/mine" },
    slotSearch: { path: "/home/subgame", query: { gameCategoryId: "3" } },
    treasureChests: { path: "/home/event", query: { eventCurrent: "1" } },
    withdrawal: { path: "/home/withdraw", query: { active: "20" } },
    // URL EXATA usada pela propria plataforma ao redirecionar quem nao tem senha
    // (capturada no probe). O parametro `redirect` (JSON duplo-encodado de
    // {name:withdraw,query:{active:20}}) faz a plataforma SALVAR a senha e voltar
    // sozinha ao saque com o estado atualizado. Sem ele, o "Confirmar" nao persiste
    // e o passo de recebimento manda de volta para o setup (loop).
    passwordSetup: MAJORITY_WITHDRAWAL_PASSWORD_SETUP_ROUTE
  }
};

// Descritores por plataforma fora do template majority. A query `active=N`
// seleciona sub-aba.
const PLATFORM_DESCRIPTORS: PlatformDescriptor[] = [
  MAJORITY_PLATFORM_DESCRIPTOR,
  {
    id: "777clube-outlier",
    hostPattern: /(^|\.)467win\.top$/i,
    appRoot: "top",
    routes: {
      home: { path: "/", query: { isredirect: "1" } },
      profile: { path: "/User", query: { isredirect: "1" } },
      slotSearch: { path: "/casino", query: { isredirect: "1" } },
      betReport: { path: "/Report", query: { type: "3", isredirect: "1" } },
      treasureChests: { path: "/Tesouro", query: { isredirect: "1" } },
      withdrawal: { path: "/withdrawal", query: { isredirect: "1" } },
      passwordSetup: { path: "/addPassword", query: { isredirect: "1" } }
    }
  }
];

// Padroes de reconhecimento de rota (fallback fuzzy e classificacao de rota atual).
const ROUTE_KIND_PATTERNS: Record<RouteKind, RegExp> = {
  withdrawal: /withdraw|saque|cash.?out/i,
  passwordSetup: /add.?password|set.?password|security|pay.?pass|senha/i,
  profile: /mine|user|perfil|member|usercenter|personalcenter|account/i,
  home: /^(\/|home|index|game)$/i,
  slotSearch: /sub.?game|casino|slot|slots|game.?category/i,
  betReport: /report|record|registro|aposta|bet/i,
  treasureChests: /event|treasure|tesouro|chest|bau|baus|promo/i
};

export function resolvePlatformDescriptor(homeUrl: string | undefined): PlatformDescriptor | undefined {
  if (!homeUrl) {
    return undefined;
  }
  let host = "";
  try {
    host = new URL(homeUrl).hostname;
  } catch {
    return undefined;
  }
  return PLATFORM_DESCRIPTORS.find((descriptor) => descriptor.hostPattern.test(host)) ?? MAJORITY_PLATFORM_DESCRIPTOR;
}

interface RouterRouteEntry {
  name: string | null;
  path: string;
}

const normalizeRoutePath = (path: string): string => {
  const [withoutQuery = ""] = path.split(/[?#]/, 1);
  const normalized = withoutQuery.trim().replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return normalized || "/";
};

const targetRoutePath = (target: RouteTarget | undefined): string | undefined => {
  if (!target) {
    return undefined;
  }
  if (typeof target === "string") {
    return normalizeRoutePath(target);
  }
  if (target.path) {
    return normalizeRoutePath(target.path);
  }
  return undefined;
};

async function listRouterRoutes(spa: SpaHandle): Promise<RouterRouteEntry[]> {
  return spa
    .evaluate(() => {
      const findRouter = (): unknown => {
        const w = globalThis as { [key: string]: unknown; document?: unknown };
        const direct = w["$router"] as { push?: unknown } | undefined;
        if (direct && typeof direct.push === "function") return direct;
        const doc = w.document as { querySelectorAll?: (s: string) => ArrayLike<unknown> } | undefined;
        const els = doc?.querySelectorAll ? doc.querySelectorAll("body, body *") : [];
        for (let i = 0; i < els.length; i += 1) {
          const el = els[i] as { __vue_app__?: { config?: { globalProperties?: { $router?: unknown } } }; __vue__?: { $router?: unknown } };
          const gp = el.__vue_app__?.config?.globalProperties;
          if (gp?.$router) return gp.$router;
          if (el.__vue__?.$router) return el.__vue__.$router;
        }
        return null;
      };
      const router = findRouter() as { options?: { routes?: unknown[] } } | null;
      const routes = router?.options?.routes || [];
      const flat: Array<{ name: string | null; path: string }> = [];
      const normalizePath = (value: string) => {
        const [withoutQuery = ""] = value.split(/[?#]/, 1);
        const normalized = withoutQuery.trim().replace(/\/{2,}/g, "/").replace(/\/$/, "");
        return normalized || "/";
      };
      const joinPath = (base: string, segment: string) => {
        if (!segment) return normalizePath(base || "/");
        if (segment.charAt(0) === "/") return normalizePath(segment);
        return normalizePath(`${base.replace(/\/$/, "")}/${segment}`);
      };
      const walk = (list: unknown[], base: string): void => {
        for (const raw of list || []) {
          const entry = (raw || {}) as { alias?: unknown; name?: unknown; path?: unknown; children?: unknown[] };
          const seg = entry.path != null ? String(entry.path) : "";
          const full = joinPath(base, seg);
          flat.push({ name: entry.name != null ? String(entry.name) : null, path: full });
          if (typeof entry.alias === "string") {
            flat.push({ name: entry.name != null ? String(entry.name) : null, path: joinPath(base, entry.alias) });
          } else if (Array.isArray(entry.alias)) {
            for (const alias of entry.alias) {
              if (typeof alias === "string") {
                flat.push({ name: entry.name != null ? String(entry.name) : null, path: joinPath(base, alias) });
              }
            }
          }
          if (Array.isArray(entry.children)) walk(entry.children, full);
        }
      };
      walk(routes as unknown[], "");
      return flat.filter((entry, index, entries) => entries.findIndex((other) => other.name === entry.name && other.path === entry.path) === index);
    }, undefined, MAIN_WORLD)
    .catch(() => []);
}

function scoreDescriptorFromRoutes(descriptor: PlatformDescriptor, routes: RouterRouteEntry[]): { exactMatches: number; score: number } {
  const routePaths = new Set(routes.map((route) => normalizeRoutePath(route.path)));
  const routeNames = new Set(routes.map((route) => (route.name || "").toLowerCase()).filter(Boolean));
  let exactMatches = 0;
  let score = 0;

  const routeWeights: Partial<Record<RouteKind, number>> = {
    passwordSetup: 120,
    profile: 100,
    withdrawal: 100
  };

  for (const kind of Object.keys(routeWeights) as RouteKind[]) {
    const target = descriptor.routes[kind];
    const path = targetRoutePath(target);
    if (!path || path === "/") {
      continue;
    }

    if (routePaths.has(path)) {
      exactMatches += 1;
      score += routeWeights[kind] ?? 0;
      continue;
    }

    if (target && typeof target !== "string" && target.name && routeNames.has(String(target.name).toLowerCase())) {
      exactMatches += 1;
      score += routeWeights[kind] ?? 0;
      continue;
    }

    const expectedTail = path.split("/").filter(Boolean).slice(-1)[0];
    if (expectedTail && routes.some((route) => normalizeRoutePath(route.path).split("/").filter(Boolean).slice(-1)[0] === expectedTail)) {
      score += Math.floor((routeWeights[kind] ?? 0) * 0.35);
    }
  }

  return { exactMatches, score };
}

export async function detectPlatformDescriptor(spa: SpaHandle, fallbackUrl: string | undefined): Promise<PlatformDescriptor | undefined> {
  const routes = await listRouterRoutes(spa);
  const best = PLATFORM_DESCRIPTORS
    .map((descriptor) => ({ descriptor, ...scoreDescriptorFromRoutes(descriptor, routes) }))
    .filter((candidate) => candidate.score >= 100)
    .sort((left, right) => right.exactMatches - left.exactMatches || right.score - left.score)[0];

  return best?.descriptor ?? resolvePlatformDescriptor(fallbackUrl);
}

// Retorna true se a SPA expoe um router acessivel no main world.
export async function hasSpaRouter(spa: SpaHandle): Promise<boolean> {
  return spa
    .evaluate(() => {
      const findRouter = (): unknown => {
        const w = globalThis as { [key: string]: unknown; document?: unknown };
        const direct = w["$router"] as { push?: unknown } | undefined;
        if (direct && typeof direct.push === "function") return direct;
        const doc = w.document as { querySelectorAll?: (s: string) => ArrayLike<unknown> } | undefined;
        const els = doc?.querySelectorAll ? doc.querySelectorAll("body, body *") : [];
        for (let i = 0; i < els.length; i += 1) {
          const el = els[i] as { __vue_app__?: { config?: { globalProperties?: { $router?: unknown } } }; __vue__?: { $router?: unknown } };
          const gp = el.__vue_app__?.config?.globalProperties;
          if (gp?.$router) return gp.$router;
          if (el.__vue__?.$router) return el.__vue__.$router;
        }
        return null;
      };
      return Boolean(findRouter());
    }, undefined, MAIN_WORLD)
    .catch(() => false);
}

export async function getCurrentRoute(spa: SpaHandle): Promise<RouteInfo | null> {
  return spa
    .evaluate(() => {
      const findRouter = (): unknown => {
        const w = globalThis as { [key: string]: unknown; document?: unknown };
        const direct = w["$router"] as { push?: unknown } | undefined;
        if (direct && typeof direct.push === "function") return direct;
        const doc = w.document as { querySelectorAll?: (s: string) => ArrayLike<unknown> } | undefined;
        const els = doc?.querySelectorAll ? doc.querySelectorAll("body, body *") : [];
        for (let i = 0; i < els.length; i += 1) {
          const el = els[i] as { __vue_app__?: { config?: { globalProperties?: { $router?: unknown } } }; __vue__?: { $router?: unknown } };
          const gp = el.__vue_app__?.config?.globalProperties;
          if (gp?.$router) return gp.$router;
          if (el.__vue__?.$router) return el.__vue__.$router;
        }
        return null;
      };
      const router = findRouter() as { currentRoute?: { value?: unknown } } | null;
      if (!router) return null;
      // Vue Router 4 expoe um ref (.value); Vue Router 3 expoe o objeto direto.
      const current = router.currentRoute;
      const route = (current && (current as { value?: unknown }).value) || current;
      const r = (route || {}) as {
        name?: unknown;
        path?: unknown;
        fullPath?: unknown;
        query?: Record<string, unknown>;
      };
      const query: Record<string, string> = {};
      if (r.query && typeof r.query === "object") {
        for (const key of Object.keys(r.query)) {
          query[key] = String(r.query[key]);
        }
      }
      return {
        name: r.name != null ? String(r.name) : null,
        path: r.path != null ? String(r.path) : null,
        fullPath: r.fullPath != null ? String(r.fullPath) : null,
        query
      };
    }, undefined, MAIN_WORLD)
    .catch(() => null);
}

// Empurra a SPA para uma rota via `router.push`. Retorna false se nao houver router.
export async function routerPush(spa: SpaHandle, target: RouteTarget): Promise<boolean> {
  return spa
    .evaluate(
      (t) => {
        const findRouter = (): unknown => {
          const w = globalThis as { [key: string]: unknown; document?: unknown };
          const direct = w["$router"] as { push?: unknown } | undefined;
          if (direct && typeof direct.push === "function") return direct;
          const doc = w.document as { querySelectorAll?: (s: string) => ArrayLike<unknown> } | undefined;
          const els = doc?.querySelectorAll ? doc.querySelectorAll("body, body *") : [];
          for (let i = 0; i < els.length; i += 1) {
            const el = els[i] as { __vue_app__?: { config?: { globalProperties?: { $router?: unknown } } }; __vue__?: { $router?: unknown } };
            const gp = el.__vue_app__?.config?.globalProperties;
            if (gp?.$router) return gp.$router;
            if (el.__vue__?.$router) return el.__vue__.$router;
          }
          return null;
        };
        const router = findRouter() as { push?: (to: unknown) => unknown } | null;
        if (!router || typeof router.push !== "function") return false;
        try {
          // `push` pode rejeitar (NavigationDuplicated em VR3); ignoramos.
          const result = router.push(t) as { catch?: (cb: () => void) => void } | undefined;
          if (result && typeof result.catch === "function") result.catch(() => undefined);
        } catch {
          /* noop */
        }
        return true;
      },
      target,
      MAIN_WORLD
    )
    .catch(() => false);
}

// Resolve o alvo de navegacao para uma tela: primeiro o override do descritor;
// senao, casa por padrao a tabela viva `$router.options.routes` (so path, sem query).
export async function resolveRouteTarget(
  spa: SpaHandle,
  kind: RouteKind,
  descriptor: PlatformDescriptor | undefined
): Promise<RouteTarget | null> {
  const override = descriptor?.routes?.[kind];
  if (override) {
    return override;
  }
  const pattern = ROUTE_KIND_PATTERNS[kind];
  const path = await spa
    .evaluate(
      (args) => {
        const findRouter = (): unknown => {
          const w = globalThis as { [key: string]: unknown; document?: unknown };
          const direct = w["$router"] as { push?: unknown } | undefined;
          if (direct && typeof direct.push === "function") return direct;
          const doc = w.document as { querySelectorAll?: (s: string) => ArrayLike<unknown> } | undefined;
          const els = doc?.querySelectorAll ? doc.querySelectorAll("body, body *") : [];
          for (let i = 0; i < els.length; i += 1) {
            const el = els[i] as { __vue_app__?: { config?: { globalProperties?: { $router?: unknown } } }; __vue__?: { $router?: unknown } };
            const gp = el.__vue_app__?.config?.globalProperties;
            if (gp?.$router) return gp.$router;
            if (el.__vue__?.$router) return el.__vue__.$router;
          }
          return null;
        };
        const router = findRouter() as { options?: { routes?: unknown[] } } | null;
        const routes = router?.options?.routes || [];
        const rx = new RegExp(args.source, args.flags);
        const flat: Array<{ name: string | null; path: string }> = [];
        const walk = (list: unknown[], base: string): void => {
          for (const raw of list || []) {
            const entry = (raw || {}) as { name?: unknown; path?: unknown; children?: unknown[] };
            const seg = entry.path != null ? String(entry.path) : "";
            const full = seg.charAt(0) === "/" ? seg : `${base.replace(/\/$/, "")}/${seg}`;
            flat.push({ name: entry.name != null ? String(entry.name) : null, path: full });
            if (Array.isArray(entry.children)) walk(entry.children, full);
          }
        };
        walk(routes as unknown[], "");
        const hit = flat.find((r) => (r.name && rx.test(r.name)) || rx.test(r.path));
        return hit ? hit.path : null;
      },
      { source: pattern.source, flags: pattern.flags },
      MAIN_WORLD
    )
    .catch(() => null);
  return path;
}

export interface WaitForRouteOptions {
  timeoutMs: number;
  pollMs?: number;
}

// Aguarda (no Node, sem sleeps fixos no browser) a rota atual casar um padrao,
// testando name e path. Retorna a RouteInfo casada ou null no timeout.
export async function waitForRouteMatch(
  spa: SpaHandle,
  pattern: RegExp,
  options: WaitForRouteOptions
): Promise<RouteInfo | null> {
  const pollMs = options.pollMs ?? 150;
  const startedAt = Date.now();
  while (Date.now() - startedAt < options.timeoutMs) {
    const route = await getCurrentRoute(spa);
    if (route && ((route.name && pattern.test(route.name)) || (route.path && pattern.test(route.path)))) {
      return route;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

export function routeMatchesKind(route: RouteInfo | null, kind: RouteKind): boolean {
  if (!route) {
    return false;
  }
  const rx = ROUTE_KIND_PATTERNS[kind];
  return Boolean((route.name && rx.test(route.name)) || (route.path && rx.test(route.path)));
}

export function routeKindPattern(kind: RouteKind): RegExp {
  return ROUTE_KIND_PATTERNS[kind];
}

// Snapshot curto para diagnostico de falha (sem fallback: precisamos enxergar onde parou).
export async function describeSpaState(spa: SpaHandle): Promise<string> {
  const route = await getCurrentRoute(spa);
  if (!route) {
    const hasRouter = await hasSpaRouter(spa);
    return `router=${hasRouter ? "presente" : "ausente"} rota=desconhecida`;
  }
  const query = Object.keys(route.query).length ? `?${new URLSearchParams(route.query).toString()}` : "";
  return `router=presente rota.name=${route.name ?? "-"} rota.path=${route.path ?? "-"}${query}`;
}

export interface ProgrammaticDepositResult {
  ok: boolean;
  stack?: "pinia" | "vuex";
  orderNo?: string;
  amount?: string;
  copiaECola?: string;
  reason?: string;
  diag?: string;
}

// Deposito por INJECAO no estado da SPA, com verificacao anti "QR falso".
//
// Pinia (maioria): abre o dialog de recarga e usa a action real da variante
// encontrada (`recharge-with-form.submit('online')` ou `recharge-wallet.submit()`).
// A ordem resultante e lida em `recharge-qrcode.info`.
// Vuex (outlier 467win.top): acha o componente `Wallet`, seta `rechargeNumber`,
// chama `payWayEvent(0)` (monta `payInfo` com o roleid da PROPRIA plataforma) e
// `sendPay()`; le a ordem em `localStorage.szOrderInfo`.
//
// RISCO ZERO de QR falso: so retorna ok se (a) a ordem for NOVA (orderNo/registro
// mudou apos submeter), (b) o valor BATER com o pedido e (c) houver copia-e-cola.
// Tudo lido do estado autoritativo, NUNCA raspando pixel/DOM. Sem dado de pagador
// fabricado (no Vuex o roleid vem do payWayEvent da plataforma). Poll in-page, sem
// esperas fixas. Roda no MAIN world porque Pinia/Vue vivem la (stealth isola o resto).
export async function programmaticDeposit(
  spa: SpaHandle,
  amount: string,
  timeoutMs = 20000
): Promise<ProgrammaticDepositResult> {
  return spa
    .evaluate(
      async (arg: { amount: string; timeoutMs: number }): Promise<ProgrammaticDepositResult> => {
        type Rec = Record<PropertyKey, unknown>;
        const isObj = (v: unknown): v is Rec => Boolean(v) && (typeof v === "object" || typeof v === "function");
        const read = (t: unknown, k: PropertyKey): unknown => {
          if (!isObj(t)) return undefined;
          try {
            return t[k];
          } catch {
            return undefined;
          }
        };
        const num = (v: unknown): number => Number(String(v ?? "").replace(/\s/g, "").replace(",", "."));
        const reqAmount = num(arg.amount);
        const until = async (fn: () => unknown, ms: number, step = 100): Promise<unknown> => {
          const startedAt = Date.now();
          while (Date.now() - startedAt < ms) {
            let value: unknown;
            try {
              value = fn();
            } catch {
              value = undefined;
            }
            if (value) return value;
            await new Promise((resolve) => setTimeout(resolve, step));
          }
          return undefined;
        };
        const runtime = globalThis as unknown as {
          document: { querySelectorAll: (selector: string) => ArrayLike<unknown> };
          localStorage?: { getItem: (key: string) => string | null };
        };
        const els = Array.from(runtime.document.querySelectorAll("body, body *")) as Array<
          Rec & { __vue_app__?: unknown; __vue__?: unknown; __vueParentComponent?: unknown }
        >;

        // ---- Pinia (Vue3 / maioria) ----
        const appEl = els.find((el) => isObj(el.__vue_app__));
        if (appEl) {
          const piniaCandidates: unknown[] = [];
          const seenPinia = new Set<unknown>();
          const addPinia = (value: unknown) => {
            if (!isObj(value) || seenPinia.has(value)) return;
            seenPinia.add(value);
            piniaCandidates.push(value);
          };
          const addProvidesPinia = (provides: unknown) => {
            if (!isObj(provides)) return;
            for (const key of Reflect.ownKeys(provides)) {
              if (String(key).toLowerCase().includes("pinia")) {
                addPinia(read(provides, key));
              }
            }
          };
          const addAppPinia = (appLike: unknown) => {
            if (!isObj(appLike)) return;
            addPinia(read(read(read(appLike, "config"), "globalProperties"), "$pinia"));
            const context = read(appLike, "_context");
            addPinia(read(read(read(context, "config"), "globalProperties"), "$pinia"));
            addProvidesPinia(read(context, "provides"));
            addProvidesPinia(read(appLike, "provides"));
          };
          for (const el of els) {
            addAppPinia(el.__vue_app__);
            const component = el.__vueParentComponent;
            if (isObj(component)) {
              addAppPinia(read(component, "appContext"));
            }
          }
          const scoredStores = piniaCandidates
            .map((pinia) => {
              const candidateStores = read(pinia, "_s") as Map<string, Rec> | undefined;
              if (!candidateStores || typeof candidateStores.get !== "function" || typeof candidateStores.keys !== "function") {
                return undefined;
              }
              const keys = Array.from(candidateStores.keys());
              const score =
                keys.length +
                (candidateStores.has("dialog") ? 1000 : 0) +
                (candidateStores.has("recharge-with-form") ? 1000 : 0) +
                (candidateStores.has("recharge-wallet") ? 1000 : 0) +
                (candidateStores.has("recharge-qrcode") ? 1000 : 0);
              return { stores: candidateStores, score };
            })
            .filter((candidate): candidate is { stores: Map<string, Rec>; score: number } => Boolean(candidate))
            .sort((left, right) => right.score - left.score);
          const stores = scoredStores[0]?.stores;
          if (!stores || typeof stores.get !== "function") {
            return { ok: false, reason: "pinia-nao-localizado" };
          }
          let rw = stores.get("recharge-with-form");
          let wallet = stores.get("recharge-wallet");
          let dialog = stores.get("dialog");
          let qr = stores.get("recharge-qrcode");
          let rechargeDialogOpened = false;
          const openRechargeDialog = async (): Promise<string | null> => {
            dialog = stores.get("dialog");
            if (!dialog) return "dialog-ausente";
            const open = read(dialog, "open");
            if (typeof open !== "function") return "dialog-open-ausente";
            try {
              await (open as (a: string, b: unknown) => unknown).call(dialog, "recharge", { openType: "overlay" });
              rechargeDialogOpened = true;
              return null;
            } catch (error) {
              return `dialog-open-falhou:${String(error)}`;
            }
          };
          // `recharge-qrcode` e lazy em algumas variantes: a propria action de
          // submit instancia essa store. Exigi-la aqui cria um deadlock circular
          // (nao submetemos porque nao ha QR store, e ela nao nasce porque nao
          // submetemos). Antes do submit basta a store do formulario estar pronta.
          if (dialog && !rw && !wallet) {
            const openFailure = await openRechargeDialog();
            if (openFailure) {
              return { ok: false, reason: openFailure.split(":", 1)[0], diag: openFailure };
            }
            await until(() => {
              rw = stores.get("recharge-with-form");
              wallet = stores.get("recharge-wallet");
              return rw || wallet ? true : null;
            }, Math.min(arg.timeoutMs, 8000));
          }
          rw = stores.get("recharge-with-form");
          wallet = stores.get("recharge-wallet");
          dialog = stores.get("dialog");
          qr = stores.get("recharge-qrcode");
          if (!rw && !wallet) {
            const storeKeys = Array.from(stores.keys());
            return {
              ok: false,
              reason: "stores-recharge-ausentes",
              diag: `form=0 wallet=0 qr=${qr ? 1 : 0} keys=${storeKeys.slice(-24).join(",").slice(0, 500)}`
            };
          }
          const beforeOrder = String(read(read(qr, "info"), "orderNo") ?? "");
          if (!rechargeDialogOpened && dialog) {
            const openFailure = await openRechargeDialog();
            if (openFailure) {
              return { ok: false, reason: openFailure.split(":", 1)[0], diag: openFailure };
            }
          }
          if (rw) {
            const channelReady = await until(() => {
              const channelId = read(read(read(rw, "activeChannelItem"), "online"), "id");
              return channelId && !read(rw, "pageLoading") ? true : null;
            }, arg.timeoutMs);
            if (!channelReady) return { ok: false, reason: "canal-nao-carregou" };
            const formOnline = read(read(rw, "formModel"), "online");
            if (!isObj(formOnline)) return { ok: false, reason: "formModel-online-ausente" };
            try {
              formOnline.amount = String(arg.amount);
            } catch (error) {
              return { ok: false, reason: "set-amount-falhou", diag: String(error) };
            }
            await until(() => (!read(rw, "submitLoading") && !read(rw, "exchangeRateLoading") ? true : null), 3000);
            const submit = read(rw, "submit");
            if (typeof submit !== "function") return { ok: false, reason: "submit-ausente" };
            try {
              await (submit as (a: string) => unknown).call(rw, "online");
            } catch (error) {
              return { ok: false, reason: "submit-lancou", diag: String(error) };
            }
          } else if (wallet) {
            const channelReady = await until(() => {
              const activeChannel = read(wallet, "activeChannelItem");
              const activeChannelInfo = read(wallet, "activeChannelInfo");
              return isObj(activeChannel) && isObj(activeChannelInfo) && !read(wallet, "pageLoading") ? true : null;
            }, arg.timeoutMs);
            if (!channelReady) return { ok: false, reason: "wallet-canal-nao-carregou" };
            const formModel = read(wallet, "formModel");
            if (!isObj(formModel)) return { ok: false, reason: "wallet-formModel-ausente" };
            try {
              formModel.amount = String(arg.amount);
            } catch (error) {
              return { ok: false, reason: "wallet-set-amount-falhou", diag: String(error) };
            }
            const amountApplied = await until(
              () => String(read(read(wallet, "formModel"), "amount") ?? "") === String(arg.amount),
              1200
            );
            if (!amountApplied) return { ok: false, reason: "wallet-valor-nao-aplicado" };
            await until(() => (!read(wallet, "submitLoading") && !read(wallet, "exchangeRateLoading") ? true : null), 3000);
            const submit = read(wallet, "submit");
            if (typeof submit !== "function") return { ok: false, reason: "wallet-submit-ausente" };
            try {
              await (submit as () => unknown).call(wallet);
            } catch (error) {
              return { ok: false, reason: "wallet-submit-lancou", diag: String(error) };
            }
          }
          const info = (await until(() => {
            // A store pode ser registrada somente dentro de submit(). Rele o
            // Map a cada poll em vez de manter o valor capturado antes da ordem.
            qr = stores.get("recharge-qrcode");
            const current = read(qr, "info");
            if (!isObj(current)) return null;
            const orderNo = String(read(current, "orderNo") ?? "");
            return read(current, "qrCode") && orderNo && orderNo !== beforeOrder ? current : null;
          }, arg.timeoutMs)) as Rec | undefined;
          if (!info) {
            return {
              ok: false,
              reason: "qr-sem-ordem-nova",
              diag: `store=${qr ? 1 : 0} before=${beforeOrder} cur=${String(read(read(qr, "info"), "orderNo") ?? "")}`
            };
          }
          const gotAmount = num(read(info, "money"));
          if (!Number.isFinite(gotAmount) || gotAmount !== reqAmount) {
            return { ok: false, reason: "valor-divergente", diag: `pedido=${reqAmount} ordem=${String(read(info, "money"))}` };
          }
          return {
            ok: true,
            stack: "pinia",
            orderNo: String(read(info, "orderNo")),
            amount: String(read(info, "money")),
            copiaECola: String(read(info, "qrCode"))
          };
        }

        // ---- Vuex (Vue2 / outlier) ----
        const v2El = els.find((el) => isObj(el.__vue__));
        const root = read(v2El?.__vue__, "$root");
        const store = read(root, "$store");
        if (isObj(root) && isObj(store)) {
          let wallet: Rec | undefined;
          const visit = (vm: unknown): void => {
            if (!isObj(vm)) return;
            if (String(read(read(vm, "$options"), "name") ?? "") === "Wallet") wallet = vm;
            const children = read(vm, "$children");
            if (Array.isArray(children)) {
              for (const child of children) visit(child);
            }
          };
          visit(root);
          if (!wallet) return { ok: false, reason: "wallet-vm-nao-montado" };
          const beforeOrder = runtime.localStorage?.getItem("szOrderInfo") ?? "";
          const commit = read(store, "commit");
          if (typeof commit === "function") {
            try {
              (commit as (a: string, b: unknown) => unknown).call(store, "walletShowEvent", { isShow: true, active: 0, type: "" });
            } catch {
              /* abrir e idempotente; segue */
            }
          }
          let payWayEventSubmits = false;
          let payWayEventSourceKnown = false;
          try {
            (wallet as Rec).rechargeNumber = reqAmount;
            const rechargeNumberChange = read(wallet, "rechargeNumberChange");
            if (typeof rechargeNumberChange === "function") (rechargeNumberChange as () => unknown).call(wallet);
            const payWayEvent = read(wallet, "payWayEvent");
            if (typeof payWayEvent !== "function") return { ok: false, reason: "payWayEvent-ausente" };
            const rawPayWayEvent = read(read(read(wallet, "$options"), "methods"), "payWayEvent");
            let payWayEventSource = "";
            try {
              payWayEventSource = Function.prototype.toString.call(
                typeof rawPayWayEvent === "function" ? rawPayWayEvent : payWayEvent
              );
            } catch {
              /* tratado abaixo como modo de submissao indeterminado */
            }
            payWayEventSubmits = /\bthis\s*\.\s*sendPay\s*\(/.test(payWayEventSource);
            payWayEventSourceKnown = Boolean(payWayEventSource) && !/\[native code\]/.test(payWayEventSource);
            (payWayEvent as (index: number) => unknown).call(wallet, 0);
          } catch (error) {
            return { ok: false, reason: "montar-payInfo-falhou", diag: String(error) };
          }
          const payInfoReady = await until(() => {
            const payInfo = read(wallet, "payInfo");
            return isObj(payInfo) && read(payInfo, "channelID") && num(read(payInfo, "amount")) === reqAmount ? true : null;
          }, arg.timeoutMs);
          if (!payInfoReady) {
            return { ok: false, reason: "payInfo-nao-ficou-pronto", diag: JSON.stringify(read(wallet, "payInfo") ?? {}).slice(0, 200) };
          }
          if (!payWayEventSubmits) {
            if (!payWayEventSourceKnown) {
              return { ok: false, reason: "modo-submit-vuex-indeterminado" };
            }
            const sendPay = read(wallet, "sendPay");
            if (typeof sendPay !== "function") return { ok: false, reason: "sendPay-ausente" };
            try {
              (sendPay as () => unknown).call(wallet);
            } catch (error) {
              return { ok: false, reason: "sendPay-lancou", diag: String(error) };
            }
          }
          const doneRaw = (await until(() => {
            const config = read(read(store, "state"), "config");
            const raw = runtime.localStorage?.getItem("szOrderInfo") ?? "";
            return read(config, "depositeIsShow") && read(config, "rechargeLink") && raw && raw !== beforeOrder ? raw : null;
          }, arg.timeoutMs)) as string | undefined;
          if (!doneRaw) return { ok: false, reason: "ordem-nao-confirmou" };
          const lsAmount = num(runtime.localStorage?.getItem("rechargeNumber"));
          if (!Number.isFinite(lsAmount) || lsAmount !== reqAmount) {
            return { ok: false, reason: "valor-divergente", diag: `pedido=${reqAmount} ls=${runtime.localStorage?.getItem("rechargeNumber")}` };
          }
          let order: Rec = {};
          try {
            order = JSON.parse(doneRaw) as Rec;
          } catch {
            /* mantem {} */
          }
          const copia = String(read(order, "qrcode") ?? "");
          if (!copia) return { ok: false, reason: "copia-e-cola-vazio" };
          return {
            ok: true,
            stack: "vuex",
            orderNo: String(read(order, "orderid") ?? read(order, "order3rd") ?? ""),
            amount: String(reqAmount),
            copiaECola: copia
          };
        }

        return { ok: false, reason: "framework-nao-detectado" };
      },
      { amount, timeoutMs },
      MAIN_WORLD
    )
    .catch(
      (error): ProgrammaticDepositResult => ({
        ok: false,
        reason: "evaluate-falhou",
        diag: error instanceof Error ? error.message : String(error)
      })
    );
}

export interface ProgrammaticWithdrawalPasswordResult {
  ok: boolean;
  fieldsSet: string[];
  reason?: string;
  diag?: string;
}

export type ProgrammaticPixUiAction =
  | "openReceivingAccount"
  | "openAddPix"
  | "selectPhone"
  | "submit";

export interface ProgrammaticPixUiResult {
  ok: boolean;
  action: ProgrammaticPixUiAction;
  reason?: string;
  diag?: string;
}

// Aciona o cadastro PIX pelo estado, handlers e eventos direcionados da SPA, sem
// hit-test, coordenadas de tela, viewport ou HTMLElement.click(). As skins usam:
// - Pinia `withdraw.tabsActive = 10` para "Conta para recebimento";
// - prop Vue `addAccountModal(data)` ou o listener Vue vivo no card PIX;
// - `onUpdate:modelValue("PHONE")` no seletor do tipo de chave;
// - submit nativo do form Vue para validar e enviar.
//
// Os expandos Vue/Pinia so existem no MAIN world do Patchright.
export async function programmaticPixUiAction(
  spa: SpaHandle,
  action: ProgrammaticPixUiAction
): Promise<ProgrammaticPixUiResult> {
  return spa
    .evaluate(
      async (requestedAction: ProgrammaticPixUiAction): Promise<ProgrammaticPixUiResult> => {
        type Rec = Record<PropertyKey, unknown>;
        type RuntimeElement = Rec & {
          __vue_app__?: unknown;
          __vueParentComponent?: unknown;
          closest?: (selector: string) => RuntimeElement | null;
          dispatchEvent?: (event: unknown) => boolean;
          getBoundingClientRect?: () => { height: number; left?: number; top?: number; width: number };
          querySelector?: (selector: string) => RuntimeElement | null;
          querySelectorAll?: (selector: string) => ArrayLike<RuntimeElement>;
          requestSubmit?: () => void;
          textContent?: string | null;
        };
        const isObj = (value: unknown): value is Rec =>
          Boolean(value) && (typeof value === "object" || typeof value === "function");
        const read = (target: unknown, key: PropertyKey): unknown => {
          if (!isObj(target)) return undefined;
          try {
            return target[key];
          } catch {
            return undefined;
          }
        };
        const unwrap = (value: unknown): unknown => {
          if (!isObj(value)) return value;
          const rawValue = read(value, "value");
          return rawValue === undefined ? value : rawValue;
        };
        const normalize = (value: unknown) =>
          String(value ?? "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        const runtime = globalThis as unknown as {
          document: {
            body?: RuntimeElement;
            querySelectorAll: (selector: string) => ArrayLike<RuntimeElement>;
          };
        };
        const elements = Array.from(runtime.document.querySelectorAll("body,body *"));
        const until = async (predicate: () => unknown, timeoutMs: number, stepMs = 80) => {
          const startedAt = Date.now();
          while (Date.now() - startedAt < timeoutMs) {
            try {
              const value = predicate();
              if (value) return value;
            } catch {
              // A SPA pode trocar a arvore Vue durante o poll.
            }
            await new Promise((resolve) => setTimeout(resolve, stepMs));
          }
          return undefined;
        };

        // Vue 3 de producao nem sempre deixa `__vueParentComponent` no elemento,
        // mas necessariamente conserva os listeners registrados pelo renderer em
        // um Map privado (normalmente Symbol("_vei")). Chamamos o valor vivo do
        // listener diretamente: nao ha dispatch de evento, click DOM ou coordenada.
        const invokeHandlerValue = async (
          handler: unknown,
          owner: RuntimeElement,
          args: unknown[] = []
        ): Promise<boolean> => {
          if (Array.isArray(handler)) {
            let invoked = false;
            for (const entry of handler) {
              if (typeof entry !== "function") continue;
              await Reflect.apply(entry, owner, args);
              invoked = true;
            }
            return invoked;
          }
          if (typeof handler !== "function") return false;
          await Reflect.apply(handler, owner, args);
          return true;
        };
        const invokeVueListener = async (
          element: RuntimeElement,
          eventName: string,
          event?: unknown
        ): Promise<{ invoked: boolean; key?: string }> => {
          for (const ownKey of Reflect.ownKeys(element)) {
            const eventMap = read(element, ownKey);
            if (!isObj(eventMap)) continue;
            const invoker = read(eventMap, eventName);
            if (typeof invoker !== "function") continue;
            const liveHandler = read(invoker, "value");
            if (await invokeHandlerValue(
              liveHandler === undefined ? invoker : liveHandler,
              element,
              event === undefined ? [] : [event]
            )) {
              return { invoked: true, key: String(ownKey) };
            }
          }
          const directHandler = read(element, eventName.toLowerCase());
          if (await invokeHandlerValue(
            directHandler,
            element,
            event === undefined ? [] : [event]
          )) {
            return { invoked: true, key: eventName.toLowerCase() };
          }
          return { invoked: false };
        };
        const invokeSemanticVueClick = async (
          include: RegExp,
          exclude?: RegExp
        ): Promise<{ invoked: boolean; label?: string; listenerKey?: string; candidates: number }> => {
          const candidates = Array.from(
            runtime.document.querySelectorAll(
              "#addAccountClick,[data-sensors-click],button,[role='button'],[role='option'],li,a,div,span"
            )
          )
            .map((element) => {
              const text = normalize(element.textContent);
              const attrs = normalize(
                [
                  read(element, "id"),
                  read(element, "className"),
                  read(element, "role"),
                  read(element, "title"),
                  read(element, "ariaLabel")
                ].join(" ")
              );
              const combined = `${text} ${attrs}`;
              const rect = element.getBoundingClientRect?.();
              return {
                element,
                text,
                combined,
                area: (rect?.width ?? 0) * (rect?.height ?? 0),
                score:
                  (include.test(text) ? 100 : include.test(combined) ? 60 : 0) +
                  (String(read(element, "id")) === "addAccountClick" ? 80 : 0) +
                  (/button|option|sensors-click/.test(attrs) ? 20 : 0) -
                  (exclude?.test(combined) ? 300 : 0)
              };
            })
            .filter((candidate) => candidate.score > 0)
            .sort((left, right) => right.score - left.score || left.area - right.area);
          for (const candidate of candidates) {
            const result = await invokeVueListener(candidate.element, "onClick");
            if (result.invoked) {
              return {
                invoked: true,
                label: candidate.text.slice(0, 100),
                listenerKey: result.key,
                candidates: candidates.length
              };
            }
          }
          return { invoked: false, candidates: candidates.length };
        };

        const collectPiniaStores = (): Map<string, Rec> | undefined => {
          const piniaCandidates: unknown[] = [];
          const seenPinia = new Set<unknown>();
          const addPinia = (value: unknown) => {
            if (!isObj(value) || seenPinia.has(value)) return;
            seenPinia.add(value);
            piniaCandidates.push(value);
          };
          const addProvides = (provides: unknown) => {
            if (!isObj(provides)) return;
            for (const key of Reflect.ownKeys(provides)) {
              if (String(key).toLowerCase().includes("pinia")) addPinia(read(provides, key));
            }
          };
          const addApp = (appLike: unknown) => {
            if (!isObj(appLike)) return;
            addPinia(read(read(read(appLike, "config"), "globalProperties"), "$pinia"));
            const context = read(appLike, "_context");
            addPinia(read(read(read(context, "config"), "globalProperties"), "$pinia"));
            addProvides(read(context, "provides"));
            addProvides(read(appLike, "provides"));
          };
          for (const element of elements) {
            addApp(element.__vue_app__);
            const component = element.__vueParentComponent;
            if (isObj(component)) addApp(read(component, "appContext"));
          }
          return piniaCandidates
            .map((pinia) => read(pinia, "_s") as Map<string, Rec> | undefined)
            .filter((stores): stores is Map<string, Rec> =>
              Boolean(stores && typeof stores.get === "function" && typeof stores.keys === "function")
            )
            .sort((left, right) => right.size - left.size)[0];
        };

        const collectComponents = (scopeElements: RuntimeElement[]): Rec[] => {
          const components: Rec[] = [];
          const seen = new Set<Rec>();
          for (const element of scopeElements) {
            let component = element.__vueParentComponent;
            for (let depth = 0; depth < 10 && isObj(component); depth += 1) {
              if (!seen.has(component)) {
                seen.add(component);
                components.push(component);
              }
              component = read(component, "parent");
            }
          }
          return components;
        };

        const componentOwners = (component: Rec): Rec[] =>
          [
            component,
            read(component, "props"),
            read(read(component, "vnode"), "props"),
            read(component, "setupState"),
            read(component, "ctx"),
            read(component, "proxy"),
            read(component, "exposed")
          ].filter(isObj);

        const findPixModalRoot = (): RuntimeElement | undefined => {
          const roots: RuntimeElement[] = [];
          const seen = new Set<RuntimeElement>();
          for (const element of elements) {
            if (!/adicionar\s+pix/.test(normalize(element.textContent))) continue;
            const popup = element.closest?.(
              ".ui-popup,.ui-dialog,.van-popup,.van-dialog,[role='dialog'],[aria-modal='true'],.modal,.popup"
            );
            if (!popup) continue;
            const rect = popup.getBoundingClientRect?.();
            if (rect && (rect.width <= 8 || rect.height <= 8)) continue;
            if (!seen.has(popup)) {
              seen.add(popup);
              roots.push(popup);
            }
          }
          return roots.sort((left, right) => {
            const leftHasForm = left.querySelector?.("form") ? 1 : 0;
            const rightHasForm = right.querySelector?.("form") ? 1 : 0;
            if (leftHasForm !== rightHasForm) return rightHasForm - leftHasForm;
            const leftRect = left.getBoundingClientRect?.();
            const rightRect = right.getBoundingClientRect?.();
            return (leftRect?.width ?? 0) * (leftRect?.height ?? 0) -
              (rightRect?.width ?? 0) * (rightRect?.height ?? 0);
          })[0];
        };

        if (requestedAction === "openReceivingAccount") {
          const stores = collectPiniaStores();
          const withdraw = stores?.get("withdraw");
          if (!withdraw) {
            return {
              ok: false,
              action: requestedAction,
              reason: "withdraw-store-ausente",
              diag: `stores=${stores ? Array.from(stores.keys()).slice(-30).join(",") : "nenhuma"}`
            };
          }
          const patch = read(withdraw, "$patch");
          try {
            if (typeof patch === "function") {
              Reflect.apply(patch, withdraw, [{ tabsActive: 10 }]);
            }
            withdraw.tabsActive = 10;
          } catch (error) {
            return { ok: false, action: requestedAction, reason: "tabsActive-falhou", diag: String(error) };
          }
          const applied = await until(() => Number(unwrap(read(withdraw, "tabsActive"))) === 10, 1500);
          return applied
            ? { ok: true, action: requestedAction }
            : {
                ok: false,
                action: requestedAction,
                reason: "tabsActive-nao-aplicou",
                diag: `valor=${String(unwrap(read(withdraw, "tabsActive")))}`
              };
        }

        if (requestedAction === "openAddPix") {
          const components = collectComponents(elements);
          const methodNames = new Set<string>();
          for (const component of components) {
            const owners = componentOwners(component);
            for (const owner of owners) {
              for (const key of Reflect.ownKeys(owner).slice(0, 160)) {
                const keyText = String(key);
                const candidate = read(owner, key);
                if (typeof candidate === "function" && /add.*account.*modal|addaccountmodal/i.test(keyText)) {
                  methodNames.add(keyText);
                  const props = read(component, "props");
                  const vnodeProps = read(read(component, "vnode"), "props");
                  const dataCandidates = [
                    read(owner, "data"),
                    read(props, "data"),
                    read(vnodeProps, "data"),
                    read(owner, "accountInfo"),
                    read(owner, "addAccountInfo")
                  ].map(unwrap);
                  const pixData = dataCandidates.find((data) => {
                    if (!isObj(data)) return false;
                    const typeId = Number(unwrap(read(data, "typeId")));
                    const semantic = normalize(
                      [read(data, "typeName"), read(data, "addTypeName"), read(data, "accountType")].join(" ")
                    );
                    return typeId === 5 || /(^|\s)pix($|\s)/.test(semantic);
                  });
                  if (!isObj(pixData)) continue;
                  try {
                    await Reflect.apply(candidate, owner, [pixData]);
                    return { ok: true, action: requestedAction, diag: `method=${keyText}` };
                  } catch (error) {
                    return {
                      ok: false,
                      action: requestedAction,
                      reason: "addAccountModal-lancou",
                      diag: String(error)
                    };
                  }
                }
              }
            }
          }
          const listenerResult = await invokeSemanticVueClick(
            /pix.*(adicionar|add|vincular|cadastrar)|(adicionar|add|vincular|cadastrar).*pix/
          );
          if (listenerResult.invoked) {
            return {
              ok: true,
              action: requestedAction,
              diag: `vue-listener=${listenerResult.listenerKey ?? "onClick"} label=${listenerResult.label ?? "PIX"}`
            };
          }
          const eventRuntimeAdd = globalThis as unknown as {
            MouseEvent?: new (type: string, init?: Rec) => unknown;
          };
          const addCandidates = Array.from(
            runtime.document.querySelectorAll("#addAccountClick,span,button,div,a,[role='button']")
          ).filter((el) => {
            const text = normalize(el.textContent);
            const rect = el.getBoundingClientRect?.();
            return (
              /^adicionar$|^add$/.test(text) &&
              (rect?.width ?? 0) > 4 &&
              (rect?.height ?? 0) > 4
            );
          });
          for (const candidate of addCandidates) {
            const parent = read(candidate, "parentElement") as RuntimeElement | undefined;
            const siblingText = normalize(parent?.textContent ?? "");
            if (!/pix/.test(siblingText)) continue;
            if (typeof candidate.dispatchEvent === "function") {
              const clickEvt = eventRuntimeAdd.MouseEvent
                ? new eventRuntimeAdd.MouseEvent("click", {
                    bubbles: true, cancelable: true, composed: true, view: globalThis
                  })
                : { type: "click" };
              candidate.dispatchEvent(clickEvt as unknown as Event);
              return { ok: true, action: requestedAction, diag: "dom-click-adicionar" };
            }
          }
          return {
            ok: false,
            action: requestedAction,
            reason: "addAccountModal-ausente",
            diag:
              `components=${components.length} methods=${Array.from(methodNames).join(",") || "nenhum"} ` +
              `listenerCandidates=${listenerResult.candidates}`
          };
        }

        if (requestedAction === "selectPhone") {
          const modalRoot = findPixModalRoot();
          if (!modalRoot) return { ok: false, action: requestedAction, reason: "modal-pix-ausente" };
          const scopedElements = [modalRoot, ...Array.from(modalRoot.querySelectorAll?.("*") ?? [])];
          const components = collectComponents(scopedElements);
          for (const component of components) {
            const propsOwners = [read(component, "props"), read(read(component, "vnode"), "props")].filter(isObj);
            for (const props of propsOwners) {
              const modelValue = normalize(unwrap(read(props, "modelValue")));
              const update = read(props, "onUpdate:modelValue");
              if (!/^(cpf|phone|telefone|email|evp|cnpj|slry|svgs|cacc|tran)$/.test(modelValue)) continue;
              if (modelValue === "phone" || modelValue === "telefone") {
                return { ok: true, action: requestedAction, diag: "already=PHONE" };
              }
              if (typeof update !== "function") continue;
              try {
                await Reflect.apply(update, props, ["PHONE"]);
                await Promise.resolve();
                return { ok: true, action: requestedAction, diag: `from=${modelValue}` };
              } catch (error) {
                return {
                  ok: false,
                  action: requestedAction,
                  reason: "modelValue-phone-falhou",
                  diag: String(error)
                };
              }
            }
          }

          // Nas skins mobile em producao, o seletor conserva o onClick no
          // `.ui-popover__wrapper`, mas cada opcao e escolhida exclusivamente
          // por touchstart/touchend. Um onClick generico pode atingir o card PIX
          // por tras do Teleport e reabrir a confirmacao da senha de saque.
          const selector = modalRoot.querySelector?.(".ui-popover__wrapper");
          if (selector && /^(phone|telefone)$/.test(normalize(selector.textContent))) {
            return { ok: true, action: requestedAction, diag: "already=PHONE" };
          }
          const eventRuntime = globalThis as unknown as {
            MouseEvent?: new (type: string, init?: Rec) => unknown;
            Touch?: new (init: Rec) => unknown;
            TouchEvent?: new (type: string, init?: Rec) => unknown;
            scrollX?: number;
            scrollY?: number;
          };
          const openEvent = eventRuntime.MouseEvent
            ? new eventRuntime.MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                composed: true,
                view: globalThis
              })
            : { type: "click" };
          let opened = selector
            ? await invokeVueListener(selector, "onClick", openEvent)
            : { invoked: false };
          if (!opened.invoked && selector && typeof selector.dispatchEvent === "function") {
            selector.dispatchEvent(openEvent);
            opened = { invoked: true, key: "dom-dispatchEvent" };
          }
          if (opened.invoked) {
            const phoneOption = await until(
              () =>
                Array.from(runtime.document.querySelectorAll(".ui-options__option"))
                  .find((element) => normalize(element.textContent) === "phone"),
              1500,
              60
            ) as RuntimeElement | undefined;
            if (phoneOption) {
              const rect = phoneOption.getBoundingClientRect?.();
              const touch = eventRuntime.Touch && rect
                ? new eventRuntime.Touch({
                    identifier: Date.now(),
                    target: phoneOption,
                    clientX: (rect.left ?? 0) + rect.width / 2,
                    clientY: (rect.top ?? 0) + rect.height / 2,
                    screenX: (rect.left ?? 0) + rect.width / 2,
                    screenY: (rect.top ?? 0) + rect.height / 2,
                    pageX: (rect.left ?? 0) + rect.width / 2 + (eventRuntime.scrollX ?? 0),
                    pageY: (rect.top ?? 0) + rect.height / 2 + (eventRuntime.scrollY ?? 0),
                    radiusX: 1,
                    radiusY: 1,
                    force: 1
                  })
                : { target: phoneOption };
              const makeTouchEvent = (type: "touchstart" | "touchend") =>
                eventRuntime.TouchEvent
                  ? new eventRuntime.TouchEvent(type, {
                      bubbles: true,
                      cancelable: true,
                      composed: true,
                      touches: type === "touchstart" ? [touch] : [],
                      targetTouches: type === "touchstart" ? [touch] : [],
                      changedTouches: [touch]
                    })
                  : { type, target: phoneOption };
              const startEvent = makeTouchEvent("touchstart");
              const endEvent = makeTouchEvent("touchend");
              if (typeof phoneOption.dispatchEvent === "function" && eventRuntime.TouchEvent) {
                phoneOption.dispatchEvent(startEvent);
                await new Promise((resolve) => setTimeout(resolve, 80));
                phoneOption.dispatchEvent(endEvent);
              } else {
                const started = await invokeVueListener(phoneOption, "onTouchstart", startEvent);
                await new Promise((resolve) => setTimeout(resolve, 80));
                const ended = await invokeVueListener(phoneOption, "onTouchend", endEvent);
                if (!started.invoked || !ended.invoked) {
                  return {
                    ok: false,
                    action: requestedAction,
                    reason: "opcao-phone-touch-ausente"
                  };
                }
              }
              const applied = await until(
                () => /^(phone|telefone)$/.test(normalize(selector?.textContent)),
                1500
              );
              if (applied) {
                return {
                  ok: true,
                  action: requestedAction,
                  diag: `vue-touch=PHONE opener=${opened.key ?? "onClick"}`
                };
              }
            }
          }
          return {
            ok: false,
            action: requestedAction,
            reason: "seletor-pix-vue-ausente",
            diag: `components=${components.length} selector=${selector ? normalize(selector.textContent) : "ausente"}`
          };
        }

        const modalRoot = findPixModalRoot();
        if (!modalRoot) return { ok: false, action: requestedAction, reason: "modal-pix-ausente" };
        const confirmButton =
          modalRoot.querySelector?.("#bindWithdrawAccountNextClick") ??
          Array.from(modalRoot.querySelectorAll?.("button") ?? [])
            .find((element) => normalize(element.textContent) === "confirmar");
        if (confirmButton && typeof confirmButton.dispatchEvent === "function") {
          const eventRuntime = globalThis as unknown as {
            MouseEvent?: new (type: string, init?: Rec) => unknown;
          };
          const clickEvent = eventRuntime.MouseEvent
            ? new eventRuntime.MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                composed: true,
                view: globalThis
              })
            : { type: "click" };
          try {
            confirmButton.dispatchEvent(clickEvent);
            return { ok: true, action: requestedAction, diag: "confirm.dispatchEvent(click)" };
          } catch (error) {
            return { ok: false, action: requestedAction, reason: "confirm-click-falhou", diag: String(error) };
          }
        }
        const form = modalRoot.querySelector?.("form") ?? modalRoot.closest?.("form");
        if (form && typeof form.requestSubmit === "function") {
          try {
            form.requestSubmit();
            return { ok: true, action: requestedAction, diag: "form.requestSubmit" };
          } catch (error) {
            return { ok: false, action: requestedAction, reason: "requestSubmit-falhou", diag: String(error) };
          }
        }
        const scopedElements = [modalRoot, ...Array.from(modalRoot.querySelectorAll?.("*") ?? [])];
        const components = collectComponents(scopedElements);
        for (const component of components) {
          for (const props of [read(component, "props"), read(read(component, "vnode"), "props")].filter(isObj)) {
            const submit = read(props, "onSubmit");
            if (typeof submit !== "function") continue;
            try {
              await Reflect.apply(submit, props, []);
              return { ok: true, action: requestedAction, diag: "vue:onSubmit" };
            } catch (error) {
              return { ok: false, action: requestedAction, reason: "vue-submit-falhou", diag: String(error) };
            }
          }
        }
        return { ok: false, action: requestedAction, reason: "form-submit-ausente" };
      },
      action,
      MAIN_WORLD
    )
    .catch(
      (error): ProgrammaticPixUiResult => ({
        ok: false,
        action,
        reason: "evaluate-falhou",
        diag: error instanceof Error ? error.message : String(error)
      })
    );
}

// DEPRECATED (NAO USAR): confirmado em runtime que NAO funciona nesta plataforma -- o
// componente do PIN tem modelo LOCAL proprio e o "Confirmar" valida esse modelo, nao a
// store; setar `security.state.form` (mesmo via $patch) nao move os dots nem deixa submeter.
// Mantido so como referencia historica. A senha de saque e preenchida pelo teclado via
// dispatch SINTETICO in-page (clickNumberKeyboardKey em automation-runtime).
//
// Escreve a senha de saque DIRETO no estado Pinia (store `security`), eliminando o
// teclado virtual clicado tecla-a-tecla (fragil em PC fraco -- ver [PASS-DIAG]). Descoberto
// por probe em runtime: a store `security` expoe `state.form` com os campos de senha
// (`withdrawPass`/`confirmWithdrawPass` no modo "bind"/criacao; campo unico no modo
// verificacao). Seta TODOS os campos cujo nome casa /pass/i e confirma por readback no
// proprio estado.
//
// IMPORTANTE: ok=true significa apenas que o ESTADO foi escrito. O CHAMADOR ainda deve
// confirmar que a UI refletiu (dots do PIN no DOM) antes de submeter e cair no teclado
// virtual se nao refletiu -- assim um set na store errada/variante diferente nunca passa
// batido. Mesmo padrao seguro do programmaticDeposit. Roda no MAIN world (Pinia vive la).
export async function programmaticWithdrawalPassword(
  spa: SpaHandle,
  password: string,
  timeoutMs = 6000
): Promise<ProgrammaticWithdrawalPasswordResult> {
  return spa
    .evaluate(
      async (arg: { password: string; timeoutMs: number }): Promise<ProgrammaticWithdrawalPasswordResult> => {
        type Rec = Record<PropertyKey, unknown>;
        const isObj = (v: unknown): v is Rec => Boolean(v) && (typeof v === "object" || typeof v === "function");
        const read = (t: unknown, k: PropertyKey): unknown => {
          if (!isObj(t)) return undefined;
          try {
            return (t as Rec)[k];
          } catch {
            return undefined;
          }
        };
        const until = async (fn: () => unknown, ms: number, step = 100): Promise<unknown> => {
          const startedAt = Date.now();
          while (Date.now() - startedAt < ms) {
            let value: unknown;
            try {
              value = fn();
            } catch {
              value = undefined;
            }
            if (value) return value;
            await new Promise((resolve) => setTimeout(resolve, step));
          }
          return undefined;
        };
        const runtime = globalThis as unknown as {
          document: { querySelectorAll: (selector: string) => ArrayLike<unknown> };
        };
        const els = Array.from(runtime.document.querySelectorAll("body, body *")) as Array<
          Rec & { __vue_app__?: unknown; __vueParentComponent?: unknown }
        >;

        // Descoberta de Pinia identica a programmaticDeposit.
        const piniaCandidates: unknown[] = [];
        const seen = new Set<unknown>();
        const addPinia = (value: unknown) => {
          if (!isObj(value) || seen.has(value)) return;
          seen.add(value);
          piniaCandidates.push(value);
        };
        const addProvidesPinia = (provides: unknown) => {
          if (!isObj(provides)) return;
          for (const key of Reflect.ownKeys(provides)) {
            if (String(key).toLowerCase().includes("pinia")) addPinia(read(provides, key));
          }
        };
        const addAppPinia = (appLike: unknown) => {
          if (!isObj(appLike)) return;
          addPinia(read(read(read(appLike, "config"), "globalProperties"), "$pinia"));
          const ctx = read(appLike, "_context");
          addPinia(read(read(read(ctx, "config"), "globalProperties"), "$pinia"));
          addProvidesPinia(read(ctx, "provides"));
          addProvidesPinia(read(appLike, "provides"));
        };
        for (const el of els) {
          addAppPinia(el.__vue_app__);
          const component = el.__vueParentComponent;
          if (isObj(component)) addAppPinia(read(component, "appContext"));
        }
        let stores: Map<string, Rec> | undefined;
        for (const candidate of piniaCandidates) {
          const s = read(candidate, "_s") as Map<string, Rec> | undefined;
          if (s && typeof s.get === "function" && (!stores || s.size > stores.size)) stores = s;
        }
        if (!stores || typeof stores.get !== "function") {
          return { ok: false, fieldsSet: [], reason: "pinia-nao-localizado" };
        }

        const security = stores.get("security");
        if (!security) return { ok: false, fieldsSet: [], reason: "security-store-ausente" };

        // `security.state` e o objeto { type, form, loading }. Pode vir desembrulhado
        // (Pinia expoe assim) ou como ref (.value) -- tratamos os dois.
        const getForm = (): Rec | undefined => {
          let st = read(security, "state");
          if (isObj(st) && !isObj(read(st, "form")) && isObj(read(st, "value"))) {
            st = read(st, "value");
          }
          const form = read(st, "form");
          return isObj(form) ? (form as Rec) : undefined;
        };
        const form = (await until(() => getForm(), arg.timeoutMs)) as Rec | undefined;
        if (!form) return { ok: false, fieldsSet: [], reason: "security-form-ausente" };

        const passKeys = Object.keys(form).filter((k) => /pass/i.test(k));
        if (passKeys.length === 0) {
          return { ok: false, fieldsSet: [], reason: "campos-pass-ausentes", diag: Object.keys(form).join(",") };
        }

        const setInForm = (formObj: unknown): void => {
          if (!isObj(formObj)) return;
          for (const key of Object.keys(formObj)) {
            if (!/pass/i.test(key)) continue;
            try {
              (formObj as Rec)[key] = arg.password;
            } catch {
              /* campo somente-leitura; ignora */
            }
          }
        };
        // 1) Via $patch: mutacao REATIVA canonica do Pinia. Set direto no objeto lido pode
        //    escapar da reatividade (a UI nao re-renderiza -> dots=0, visto no log real).
        const patch = read(security, "$patch");
        if (typeof patch === "function") {
          try {
            (patch as (cb: (s: Rec) => void) => void).call(security, (s) => {
              let st = read(s, "state");
              if (isObj(st) && !isObj(read(st, "form")) && isObj(read(st, "value"))) st = read(st, "value");
              setInForm(read(st, "form"));
            });
          } catch {
            /* cai no set direto abaixo */
          }
        }
        // 2) Set direto na referencia viva (cobre stores sem $patch util).
        setInForm(getForm());

        // Confirma por readback no estado vivo.
        const finalForm = getForm();
        const fieldsSet = passKeys.filter((key) => String(read(finalForm, key)) === arg.password);
        if (fieldsSet.length === 0) return { ok: false, fieldsSet: [], reason: "set-nao-aplicou" };
        return { ok: true, fieldsSet };
      },
      { password, timeoutMs },
      MAIN_WORLD
    )
    .catch(
      (error): ProgrammaticWithdrawalPasswordResult => ({
        ok: false,
        fieldsSet: [],
        reason: "evaluate-falhou",
        diag: error instanceof Error ? error.message : String(error)
      })
    );
}

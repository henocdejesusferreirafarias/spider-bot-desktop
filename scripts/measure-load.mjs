// measure-load.mjs — perfil de carregamento das plataformas-alvo usando o MESMO
// motor stealth do bot (@spider-bot/browser-stealth) + patchright.
//
// Sonda injetada via addInitScript ANTES da navegacao => mede tempos VERDADEIROS
// desde navStart (input/button/dialog/geetest visiveis), long tasks e JANK da
// main-thread (timer de 100ms: quanto ele atrasa = quanto a thread ficou travada).
//
// Uso:
//   node apps/desktop/scripts/measure-load.mjs baseline        (1 plataforma por vez)
//   node apps/desktop/scripts/measure-load.mjs concurrent      (todas ao mesmo tempo)
//   node apps/desktop/scripts/measure-load.mjs concurrent 3    (N copias da lista)
import { chromium } from "patchright";
import {
  STEALTH_INIT_SCRIPT,
  STEALTH_CONTEXT_BASE_OPTIONS,
  buildStealthLaunchArgs
} from "@spider-bot/browser-stealth";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const URLS = [
  "https://d391jvf3lh43ph.cloudfront.net/",
  "https://gamecancer.com/",
  "https://467win.com/",
  "https://467win.top/",
  "https://457win.cc/"
];

const BUDGET_MS = 25000; // tempo maximo observando cada carregamento

// Medicao COMPLETA num unico page.evaluate async (mundo principal, mesmo contexto
// que escreve e le). Recebe o budget (ms). Instala observers cedo (logo apos commit),
// faz polling ate os pontos-chave aparecerem (ou budget), e retorna tudo.
// anyVisibleDeep tambem desce em iframes same-origin (467win.top roda em iframe).
function buildMeasureFn(budgetMs) {
  return `(async () => {
    const BUDGET = ${budgetMs};
    const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
    const visible = (el)=>{ try{ if(!el||el.nodeType!==1) return false; const r=el.getBoundingClientRect(); if(r.width<6||r.height<6) return false; const s=(el.ownerDocument.defaultView||window).getComputedStyle(el); return s.visibility!=='hidden'&&s.display!=='none'&&s.opacity!=='0'; }catch(e){ return false; } };
    const docs = ()=>{ const ds=[document]; const ifr=document.querySelectorAll('iframe'); for(let i=0;i<ifr.length;i++){ try{ const d=ifr[i].contentDocument; if(d) ds.push(d); }catch(e){} } return ds; };
    const anyVisibleDeep = (sel)=>{ for(const d of docs()){ try{ const n=d.querySelectorAll(sel); for(let i=0;i<n.length;i++) if(visible(n[i])) return true; }catch(e){} } return false; };
    const targets = {
      input:   "input:not([type=hidden])",
      button:  "button,[role=button]",
      dialog:  ".ui-dialog,.ui-popup,.van-popup,.van-dialog,[role=dialog],[aria-modal=true]",
      geetest: "[class*=geetest i],iframe[src*=geetest i],iframe[src*=captcha i],[class*=captcha i]"
    };
    const marks = {};
    const longTasks = [];
    try { const po=new PerformanceObserver(l=>{ for(const e of l.getEntries()) longTasks.push(Math.round(e.duration)); }); po.observe({type:'longtask',buffered:true}); } catch(e){}
    let maxJank=0, jankSum=0, last=performance.now();
    const jt=setInterval(()=>{ const now=performance.now(); const gap=now-last-100; last=now; if(gap>maxJank)maxJank=Math.round(gap); if(gap>40)jankSum+=Math.round(gap); },100);
    const check=()=>{ for(const k in targets){ if(marks[k]===undefined && anyVisibleDeep(targets[k])) marks[k]=Math.round(performance.now()); } };
    const t0=performance.now();
    while(performance.now()-t0 < BUDGET){
      check();
      const keyReady = marks.input!==undefined || marks.dialog!==undefined || marks.geetest!==undefined;
      if(keyReady && performance.now()-t0 > 5000) break;
      await sleep(150);
    }
    check();
    clearInterval(jt);
    const nav=performance.getEntriesByType('navigation')[0]||{};
    const res=performance.getEntriesByType('resource'); let b=0; for(const r of res) b+=(r.transferSize||0);
    longTasks.sort((a,b)=>b-a);
    return { marks, evalStart_ms:Math.round(t0), frames:docs().length,
      nav:{ responseEnd:Math.round(nav.responseEnd||0), dcl:Math.round(nav.domContentLoadedEventEnd||0), load:Math.round(nav.loadEventEnd||0) },
      longtasks:{ count:longTasks.length, totalMs:longTasks.reduce((a,b)=>a+b,0), maxMs:longTasks[0]||0 },
      jank:{ maxMs:maxJank, sumMs:jankSum },
      res:{ count:res.length, kb:Math.round(b/1024) } };
  })()`;
}

function makeArgs() {
  return buildStealthLaunchArgs({ locale: "pt-BR", languages: ["pt-BR", "pt"] });
}

async function makeContext(tag) {
  const profileDir = path.join(os.tmpdir(), "spider-measure-" + tag);
  fs.mkdirSync(profileDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(profileDir, {
    ...STEALTH_CONTEXT_BASE_OPTIONS,
    args: makeArgs(),
    hasTouch: true,
    isMobile: true,
    viewport: { width: 412, height: 900 },
    locale: "pt-BR"
  });
  await ctx.addInitScript(STEALTH_INIT_SCRIPT); // stealth como no bot (mundo isolado)
  return ctx;
}

// goto(commit) retorna logo apos a navegacao commitar (cedo); o evaluate async
// instala observers em ms e mede tudo no MESMO contexto/mundo (evita a armadilha
// addInitScript=isolado vs evaluate=principal do patchright).
async function loadAndMeasure(page, url) {
  await page.goto(url, { waitUntil: "commit", timeout: 45000 }).catch(() => null);
  let r = await page.evaluate(buildMeasureFn(BUDGET_MS)).catch((e) => ({ error: String(e) }));
  // 467win.top e shells com redirect client-side destroem o contexto -> reinjeta apos a 2a navegacao.
  if (r && r.error && /context was destroyed|navigation/i.test(r.error)) {
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => null);
    await new Promise((res) => setTimeout(res, 500));
    r = await page.evaluate(buildMeasureFn(BUDGET_MS)).catch((e) => ({ error: String(e), redirected: true }));
    if (r && !r.error) r.redirected = true;
  }
  return r;
}

function fmt(url, r) {
  if (!r || r.error) return `${url}\n   ERRO: ${r && r.error}`;
  const m = r.marks || {};
  const mk = (k) => (m[k] === undefined ? "  --  " : String(m[k]).padStart(5) + "ms");
  return [
    url,
    `   nav: responseEnd=${r.nav.responseEnd}ms DCL=${r.nav.dcl}ms load=${r.nav.load}ms`,
    `   PRONTO(visivel desde navStart): input=${mk("input")}  button=${mk("button")}  dialog=${mk("dialog")}  geetest=${mk("geetest")}`,
    `   longtasks: n=${r.longtasks.count} total=${r.longtasks.totalMs}ms max=${r.longtasks.maxMs}ms`,
    `   JANK main-thread: max=${r.jank.maxMs}ms  soma=${r.jank.sumMs}ms`,
    `   recursos: ${r.res.count} reqs, ${r.res.kb}KB`
  ].join("\n");
}

async function runBaseline() {
  console.log("=== BASELINE (1 plataforma por vez, navegador stealth headed) ===\n");
  const ctx = await makeContext("baseline");
  for (const url of URLS) {
    const page = (await ctx.pages())[0] || (await ctx.newPage());
    const r = await loadAndMeasure(page, url);
    console.log(fmt(url, r) + "\n");
    await page.close().catch(() => null);
  }
  await ctx.close().catch(() => null);
}

async function runConcurrent(copies) {
  const list = [];
  for (let c = 0; c < copies; c++) for (const u of URLS) list.push(u);
  console.log(`=== CONCORRENTE (${list.length} telas ao mesmo tempo) ===\n`);
  const t0 = Date.now();
  const ctxs = await Promise.all(list.map((_, i) => makeContext("conc-" + i)));
  const results = await Promise.all(
    ctxs.map(async (ctx, i) => {
      const page = (await ctx.pages())[0] || (await ctx.newPage());
      const r = await loadAndMeasure(page, list[i]);
      return { url: list[i], r };
    })
  );
  console.log(`(carga simultanea de ${list.length} contextos; wall-clock total ${Math.round((Date.now() - t0) / 1000)}s)\n`);
  for (const { url, r } of results) console.log(fmt(url, r) + "\n");
  // agregados
  const jankMax = Math.max(...results.map((x) => x.r?.jank?.maxMs || 0));
  const jankSum = results.reduce((a, x) => a + (x.r?.jank?.sumMs || 0), 0);
  const ltMax = Math.max(...results.map((x) => x.r?.longtasks?.maxMs || 0));
  console.log(`--- AGREGADO: pior JANK=${jankMax}ms | soma JANK=${jankSum}ms | pior longtask=${ltMax}ms ---`);
  await Promise.all(ctxs.map((c) => c.close().catch(() => null)));
}

const mode = process.argv[2] || "baseline";
const copies = Number(process.argv[3] || 1);
(async () => {
  if (mode === "concurrent") await runConcurrent(copies);
  else await runBaseline();
  process.exit(0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});

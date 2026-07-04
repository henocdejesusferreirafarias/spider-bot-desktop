// Debug descartavel: inspeciona o DOM real do dialog "Senha de Saque" para
// entender por que o popup killer o fecha. NAO faz saque/transacao.
// Uso: PIN_USER=.. PIN_PASS=.. node scripts/inspect-pin.mjs
import { chromium } from "patchright";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL = "https://gamecancer.com/";
const USER = process.env.PIN_USER || "";
const PASS = process.env.PIN_PASS || "";
const DIR = "C:/Users/henoc/OneDrive/Área de Trabalho/Projetos/SpiderBOT/spider-bot/apps/desktop/scripts/";

const dumpInteractiveSrc = `(() => {
  const out = []; const seen = new Set();
  for (const el of document.querySelectorAll("button,a,[role='button'],input,[class*='btn' i],[class*='login' i],[class*='nav' i],[class*='menu' i],[class*='tab' i],[class*='item' i]")) {
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const txt = (el.textContent || "").trim().slice(0, 36);
    if (!txt && el.tagName !== "INPUT") continue;
    const key = el.tagName + "|" + txt + "|" + Math.round(r.x) + "|" + Math.round(r.y);
    if (seen.has(key)) continue; seen.add(key);
    out.push({ t: el.tagName.toLowerCase(), txt, type: el.getAttribute("type")||"", ph: el.getAttribute("placeholder")||"", x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) });
  }
  return out.slice(0, 90);
})()`;

// Procura, em TODOS os frames, um dialog cujo texto indica senha de saque/PIN.
const scanPinSrc = `(() => {
  const hit = (root) => {
    const sel = "[class*='dialog' i],[class*='popup' i],[role='dialog'],[aria-modal='true'],.ui-overlay,.van-popup,.van-dialog";
    for (const d of root.querySelectorAll(sel)) {
      const t = (d.textContent||"").toLowerCase();
      if (/senha de saque|inserir pin|introduza a senha|senha para saque|password de saque|withdraw.{0,6}password/.test(t)) {
        const ov = d.closest(".ui-overlay,[class*='overlay' i],[class*='mask' i]") || d;
        return ov.outerHTML;
      }
    }
    return null;
  };
  return hit(document);
})()`;

// Headed + persistent context = recomendacao do Patchright e ambiente do bot
// (stealth, praticamente indetectavel). Sem channel -> usa o Chromium patcheado
// que o Patchright empacota (derivado do Chrome for Testing).
const userDataDir = mkdtempSync(join(tmpdir(), "pin-inspect-"));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport: { width: 412, height: 900 },
  locale: "pt-BR",
  isMobile: true,
  hasTouch: true
});
const page = ctx.pages()[0] || (await ctx.newPage());
const log = (...a) => console.log(...a);

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => log("goto err", e.message));
await page.waitForTimeout(4500);

// ---- LOGIN ----
log("== abrindo login ==");
await page.touchscreen.tap(243, 43);
await page.waitForTimeout(2200);
// trocar para a aba LOGIN (o dialog abre em Registro)
await page.touchscreen.tap(295, 240);
await page.waitForTimeout(1500);
try {
  await page.fill("input[placeholder*='Conta']", USER, { timeout: 6000 });
  await page.fill("input[placeholder*='senha']", PASS, { timeout: 6000 });
  log("preenchido user/pass (login)");
} catch (e) { log("fill err:", e.message); }
await page.screenshot({ path: DIR + "_pin-1login.png" }).catch(() => {});
// submeter: clique REAL nas coordenadas do botao primario "Login" (W1 ignora .click() sintetico)
const findBtn = (labels) => page.evaluate(`(() => {
  const want = ${JSON.stringify(labels)};
  for (const b of document.querySelectorAll("button,[role='button'],[class*='btn' i],[class*='button' i],div,span,li")) {
    const t = (b.textContent||"").trim().toLowerCase(); const r = b.getBoundingClientRect();
    if (r.width < 30 || r.height < 14) continue;
    const cs = getComputedStyle(b); if (cs.display==="none"||cs.visibility==="hidden") continue;
    if (want.includes(t)) return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), t };
  }
  return null;
})()`);
const clickLabel = async (labels, waitMs = 2500) => {
  const b = await findBtn(labels);
  if (b) { await page.touchscreen.tap(b.x, b.y); await page.waitForTimeout(waitMs); return b.t; }
  return null;
};
const loginBtn = await page.evaluate(`(() => { for (const b of document.querySelectorAll("button,[class*='btn' i],[class*='button' i]")) { const t=(b.textContent||"").trim().toLowerCase(); const r=b.getBoundingClientRect(); if (t==="login" && r.width>150 && r.height>28) return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; } return null; })()`);
if (loginBtn) { await page.touchscreen.tap(loginBtn.x, loginBtn.y); }
await page.waitForTimeout(6000);
log("URL pos-login:", page.url());
const balance = await page.evaluate(`(document.body.textContent.match(/saldo|R\\$\\s*[0-9]/i)||[])[0]||"?"`);
log("logado? sinal de saldo:", balance);
await page.screenshot({ path: DIR + "_pin-2home.png" }).catch(() => {});

// fecha nags (Encontre-nos etc.): X circular no rodape + botoes close
async function dismissNags(times = 4) {
  for (let i = 0; i < times; i++) {
    const c = await page.evaluate(`(() => {
      for (const e of document.querySelectorAll("[class*='close' i],.ui-popup__close,.van-popup__close-icon,[aria-label*='close' i],[aria-label*='fechar' i],svg[class*='close' i],i[class*='close' i]")) {
        const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
        if (cs.display==="none"||cs.visibility==="hidden") continue;
        if (r.width>8 && r.width<80 && r.height>8 && r.height<80) return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) };
      }
      return null;
    })()`);
    if (c) { await page.touchscreen.tap(c.x, c.y); await page.waitForTimeout(1000); continue; }
    // fallback: X circular no rodape (nags W1)
    await page.touchscreen.tap(206, 837); await page.waitForTimeout(900);
    break;
  }
}

const dumpLeavesSrc = `(() => {
  const out = []; const seen = new Set();
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width < 12 || r.height < 10 || r.bottom < 0 || r.top > innerHeight) continue;
    const cs = getComputedStyle(el);
    if (cs.display==="none"||cs.visibility==="hidden"||+cs.opacity===0) continue;
    let direct = ""; for (const n of el.childNodes) if (n.nodeType===3) direct += n.textContent;
    direct = direct.trim();
    if (!direct || direct.length > 28) continue;
    const key = direct + "|" + Math.round(r.x);
    if (seen.has(key)) continue; seen.add(key);
    out.push({ txt: direct, x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) });
  }
  return out.slice(0, 140);
})()`;

async function leaves(label, shotName) {
  await page.screenshot({ path: DIR + shotName }).catch(() => {});
  const pin = await page.evaluate(scanPinSrc);
  if (pin) { writeFileSync(DIR + "_pin-DIALOG.html", pin); log("### PIN CAPTURADO em " + label + " (" + pin.length + " chars)"); return true; }
  const ls = await page.evaluate(dumpLeavesSrc);
  writeFileSync(DIR + "_pin-leaves-" + label + ".txt", "URL=" + page.url() + "\n" + ls.map((e) => e.txt + "  @ " + e.x + "," + e.y).join("\n"));
  log("[" + label + "] URL=" + page.url() + " -> _pin-leaves-" + label + ".txt (" + ls.length + " folhas)");
  return false;
}
async function clickText(t, waitMs = 2800) {
  const b = await page.evaluate(`(() => {
    const want = ${JSON.stringify(t.toLowerCase())};
    let best = null;
    for (const el of document.querySelectorAll("body *")) {
      let direct=""; for (const n of el.childNodes) if (n.nodeType===3) direct+=n.textContent;
      direct = direct.trim().toLowerCase();
      if (direct !== want) continue;
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      if (r.width<8||r.height<8||cs.display==="none"||cs.visibility==="hidden") continue;
      best = { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }; break;
    }
    return best;
  })()`);
  if (b) { await page.touchscreen.tap(b.x, b.y); await page.waitForTimeout(waitMs); log("  clicado '" + t + "' @", b.x, b.y); return true; }
  log("  '" + t + "' nao encontrado"); return false;
}

// ---- CAPTURA INTERATIVA: voce navega ate o dialog de senha de saque ----
await dismissNags(3);
await page.keyboard.press("Escape").catch(() => {});
await clickText("Não mostrar novamente hoje", 1200);
await clickText("Ocultar permanentemente", 1200);
await dismissNags(2);
log("==================================================================");
log(">> JANELA ABERTA E LOGADA. Na janela do Chromium, navegue ate o");
log(">> dialog 'Senha de Saque' (cadastrar chave PIX / saque).");
log(">> Vou capturar o DOM automaticamente assim que ele aparecer.");
log("==================================================================");

async function scanAllFrames() {
  for (const f of page.frames()) {
    try { const h = await f.evaluate(scanPinSrc); if (h) return h; } catch (e) {}
  }
  return null;
}

let captured = null;
for (let i = 0; i < 160; i++) {
  await page.waitForTimeout(1000);
  captured = await scanAllFrames().catch(() => null);
  if (captured) {
    writeFileSync(DIR + "_pin-DIALOG.html", captured);
    await page.screenshot({ path: DIR + "_pin-DIALOG.png" }).catch(() => {});
    log("### PIN DIALOG CAPTURADO (" + captured.length + " chars) -> _pin-DIALOG.html");
    break;
  }
  if (i % 10 === 0) log("...aguardando (" + i + "s)");
}
if (!captured) log("Tempo esgotado (160s) sem capturar o dialog.");
await ctx.close();

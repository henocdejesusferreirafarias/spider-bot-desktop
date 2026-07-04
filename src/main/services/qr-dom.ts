import type { Page } from "patchright";
import { resolveContentFrame } from "./automation-dom.js";

export const QR_DETECT_SELECTOR = [
  "#qrcode1 canvas", "#qrcode1 img", "#qrcode1 svg", "#qrcode1 table",
  ".codeimg canvas", ".codeimg img", ".codeimg svg",
  "[class*='qrcode' i]", "[id*='qrcode' i]",
  "[class*='qr-code' i]", "[id*='qr-code' i]",
  "canvas[class*='qr' i]", "img[class*='qr' i]", "img[src*='qr' i]", "svg[class*='qr' i]"
].join(",");

// Primitivas puras de QR (DOM): assinatura, extracao do payload e tema do overlay.

// Extrai o QR Code do DOM usando MutationObserver eficiente.
// Tenta direto primeiro (QR pode ja estar visivel) e, se nao encontrar,
// observa mudancas no DOM por ate deadline ms.
export async function extractQrCode(_runId: string, page: Page, deadline: number, _profileName: string): Promise<string | null> {
  const result = await resolveContentFrame(page).evaluate((deadlineMs) => {
    type RuntimeElement = {
      toDataURL?: (type?: string) => string;
      src?: string;
      tagName?: string;
      width?: number;
      height?: number;
      getBoundingClientRect?: () => { width: number; height: number };
    };

    const runtimeWindow = globalThis as unknown as {
      document: {
        querySelectorAll: (s: string) => Iterable<RuntimeElement>;
        createElement: (tag: string) => RuntimeElement;
        body?: Node | null;
        documentElement?: Node | null;
      };
      getComputedStyle: (element: RuntimeElement) => { display: string; visibility: string; opacity: string };
      MutationObserver: new (cb: () => void) => {
        observe: (n: Node, o: MutationObserverInit) => void;
        disconnect: () => void;
      };
      setTimeout: (cb: () => void, ms: number) => void;
    };

    // Deteccao AMPLA, igual a waitForDepositQrCode (inclui variantes com hifen,
    // <table> e svg). Antes esta lista era menor e nao casava com a plataforma —
    // por isso o overlay nunca aparecia mesmo com o QR visivel na tela.
    const QR_SELECTORS = [
      "#qrcode1 canvas", "#qrcode1 img", "#qrcode1 svg", "#qrcode1 table",
      ".codeimg canvas", ".codeimg img", ".codeimg svg",
      "[class*='qrcode' i]", "[id*='qrcode' i]",
      "[class*='qr-code' i]", "[id*='qr-code' i]",
      "canvas[class*='qr' i]", "img[class*='qr' i]", "img[src*='qr' i]", "svg[class*='qr' i]"
    ].join(",");

    const isVisible = (el: Element): boolean => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") > 0.01 &&
        // O CSS da plataforma reduz o canvas conforme a janela, mas a resolucao
        // interna continua alta (ex.: canvas 270x270 exibido com poucos rem).
        rect.width > 8 &&
        rect.height > 8
      );
    };

    // Valida o canvas inteiro em uma grade reduzida. O QR desta plataforma possui
    // uma margem branca larga; olhar apenas os 24px do canto superior esquerdo
    // confundia essa margem com um canvas vazio.
    const hasQrContrast = (
      source: CanvasImageSource,
      sourceWidth: number,
      sourceHeight: number
    ): boolean => {
      if (sourceWidth < 40 || sourceHeight < 40) return false;
      const aspect = sourceWidth / Math.max(1, sourceHeight);
      if (aspect < 0.72 || aspect > 1.38) return false;
      const probe = document.createElement("canvas");
      probe.width = 64;
      probe.height = 64;
      const probeContext = probe.getContext("2d");
      if (!probeContext) return false;
      probeContext.imageSmoothingEnabled = false;
      probeContext.fillStyle = "#fff";
      probeContext.fillRect(0, 0, probe.width, probe.height);
      probeContext.drawImage(source, 0, 0, probe.width, probe.height);
      const data = probeContext.getImageData(0, 0, probe.width, probe.height).data;
      let dark = 0;
      let light = 0;
      for (let i = 0; i < data.length; i += 4) {
        if ((data[i + 3] ?? 0) <= 10) continue;
        const luminance = ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0)) / 3;
        if (luminance < 96) dark += 1;
        else if (luminance > 176) light += 1;
      }
      return dark >= 32 && light >= 32;
    };

    // Extrai o QR como data URL AUTO-CONTIDO (nunca um src remoto/blob, que pode
    // re-renderizar em branco no overlay) e rejeita imagens em branco/placeholder.
    // Se for um wrapper (div/table), mergulha atras de um canvas/img/svg.
    const extractFrom = (el: Element): string | null => {
      const tag = el.tagName.toLowerCase();
      if (tag === "canvas") {
        const canvas = el as HTMLCanvasElement;
        try {
          if (!hasQrContrast(canvas, canvas.width, canvas.height)) return null;
          const dataUrl = canvas.toDataURL("image/png");
          return dataUrl.startsWith("data:image/png;base64,") && dataUrl.length > 200
            ? dataUrl
            : null;
        } catch {
          return null; // tainted — cai no fallback de screenshot (Node)
        }
      }
      if (tag === "img") {
        const img = el as HTMLImageElement;
        if (img.naturalWidth < 8 || img.naturalHeight < 8) return null;
        try {
          const c = document.createElement("canvas");
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const cx = c.getContext("2d");
          if (!cx) return img.currentSrc || img.src || null;
          cx.drawImage(img, 0, 0);
          if (!hasQrContrast(c, c.width, c.height)) return null;
          return c.toDataURL("image/png"); // re-encodado, auto-contido
        } catch {
          return null; // cross-origin/tainted — cai no fallback de screenshot (Node)
        }
      }
      if (tag === "svg") {
        // NAO serializamos o SVG: nesta plataforma o QR depende de CSS/raster
        // externo que nao sobrevive ao data URL (renderiza BRANCO). Retorna null
        // para cair no fallback de screenshot (captura os pixels reais, em alta
        // resolucao via ampliacao temporaria do elemento).
        return null;
      }
      const inner = el.querySelector("canvas,img,svg");
      return inner ? extractFrom(inner) : null;
    };

    const tryExtract = (): string | null => {
      // Maiores primeiro: o QR real costuma ser o maior quadrado visivel.
      const visible = (Array.from(document.querySelectorAll(QR_SELECTORS)) as Element[])
        .filter(isVisible)
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        });
      for (const el of visible) {
        const src = extractFrom(el);
        if (src) return src;
      }
      (window as unknown as { __debugQr?: (msg: string) => void }).__debugQr?.(
        `tryExtract: ${visible.length} candidatos visiveis, nenhum extraido`
      );
      return null;
    };

    // Tenta direto (QR pode ja estar visivel)
    const immediate = tryExtract();
    if (immediate) return immediate;

    // MutationObserver - aguarda aparecimento do QR no DOM
    return new Promise<string | null>((resolve) => {
      let resolved = false;
      const remainingTime = Math.max(0, deadlineMs - Date.now());
      (window as unknown as { __debugQr?: (msg: string) => void }).__debugQr?.(`MutationObserver armado, tempo restante: ${remainingTime}ms`);

      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          observer.disconnect();
          (window as unknown as { __debugQr?: (msg: string) => void }).__debugQr?.("MutationObserver desconectado");
        }
      };
      const observer = new runtimeWindow.MutationObserver(() => {
        if (resolved || Date.now() > deadlineMs) {
          cleanup();
          resolve(null);
          return;
        }
        const src = tryExtract();
        if (src) {
          cleanup();
          resolve(src);
        }
      });
      observer.observe(runtimeWindow.document.body || runtimeWindow.document.documentElement || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "style"]
      });
      runtimeWindow.setTimeout(() => {
        cleanup();
        resolve(null);
      }, remainingTime);
    });
  }, deadline);

  return result;
}

// Tema (CSS inline) do overlay de QR — fonte unica usada pelos dois caminhos
// (programatico e deposito manual), evitando duplicar ~50 linhas de estilo.
// E passado para o contexto da pagina via payload do evaluate.
export function qrOverlayTheme(): {
  backdropStyle: string;
  qrImgStyle: string;
  barStyle: string;
  closeStyle: string;
  reopenStyle: string;
} {
  // Vermelho da identidade SpiderBOT
  const RED = "#ff4d4d";
  const RED_LINE = "rgba(226,38,38,.62)";
  const RED_GLOW = "rgba(226,38,38,.5)";

  return {
    backdropStyle: [
      "position:fixed", "inset:0", "z-index:2147483647",
      "display:flex", "flex-direction:column",
      "align-items:center", "justify-content:center",
      "gap:2.4vmin", "padding:3vmin", "box-sizing:border-box",
      "background:rgba(8,4,4,.97)", "pointer-events:auto",
      "font:700 4vmin/1.1 Arial, sans-serif"
    ].join(";"),
    qrImgStyle: [
      "width:min(92vw,68vh)", "height:min(92vw,68vh)",
      "max-width:92vw", "max-height:68vh",
      "object-fit:contain", "image-rendering:pixelated",
      "image-rendering:crisp-edges", "background:#fff",
      "padding:2.4vmin", "border-radius:2vmin",
      `box-shadow:0 0 0 .5vmin ${RED_GLOW},0 1vmin 4vmin rgba(0,0,0,.6)`
    ].join(";"),
    barStyle: [
      "display:inline-flex", "align-items:center", "justify-content:center",
      "max-width:92vw", "padding:1.5vmin 3.4vmin",
      `border:.4vmin solid ${RED_LINE}`, "border-radius:1.4vmin",
      "background:#000", `color:${RED}`,
      "font:800 8vmin/1 Arial, sans-serif",
      "letter-spacing:.04vmin", "white-space:nowrap",
      "box-shadow:0 1vmin 4vmin rgba(0,0,0,.5)"
    ].join(";"),
    closeStyle: [
      "position:absolute", "top:2vmin", "right:2vmin",
      "width:7vmin", "height:7vmin", "min-width:34px", "min-height:34px",
      "display:flex", "align-items:center", "justify-content:center",
      `border:.3vmin solid ${RED_LINE}`, "border-radius:50%",
      "background:rgba(0,0,0,.85)", `color:${RED}`, "cursor:pointer",
      "font:700 4.4vmin/1 Arial, sans-serif"
    ].join(";"),
    reopenStyle: [
      "position:fixed", "left:1.5vmin", "bottom:1.5vmin",
      "z-index:2147483647", "align-items:center", "gap:1vmin",
      "padding:1.1vmin 2.2vmin", `border:.3vmin solid ${RED_LINE}`,
      "border-radius:1.2vmin", "background:rgba(0,0,0,.9)",
      `color:${RED}`, "cursor:pointer", "pointer-events:auto",
      "font:700 3.2vmin/1 Arial, sans-serif"
    ].join(";")
  };
}

// Lista de seletores de QR partilhada pelos helpers que rodam no contexto da pagina.
// Assinatura do QR atual na pagina (tag + tamanho/posicao + dica de conteudo) ou null
// se nao houver QR. Muda quando um novo deposito gera outro QR. Ignora nosso overlay.
export async function detectQrSignature(page: Page): Promise<string | null> {
  return resolveContentFrame(page)
    .evaluate((selector) => {
      const rawCandidates = Array.from(document.querySelectorAll(selector)) as Element[];
      const candidates = rawCandidates.flatMap((candidate) => {
        const tag = candidate.tagName.toLowerCase();
        if (["canvas", "img", "svg", "table"].includes(tag)) return [candidate];
        return Array.from(candidate.querySelectorAll("canvas,img,svg,table"));
      });
      const cand = candidates
        .filter((candidate, index, all) => all.indexOf(candidate) === index)
        .filter((el) => {
          if (el.closest("#predator-deposit-qr-overlay")) return false; // ignora nosso overlay
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          const aspect = r.width / Math.max(1, r.height);
          return (
            s.display !== "none" &&
            s.visibility !== "hidden" &&
            Number(s.opacity || "1") > 0.01 &&
            r.width > 8 &&
            r.height > 8 &&
            aspect > 0.6 &&
            aspect < 1.7
          );
        })
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        })[0];
      if (!cand) return null;
      const r = cand.getBoundingClientRect();
      const tag = cand.tagName.toLowerCase();
      let hint = "";
      if (tag === "img") hint = ((cand as HTMLImageElement).currentSrc || (cand as HTMLImageElement).src || "").slice(-40);
      else if (tag === "canvas") {
        const canvas = cand as HTMLCanvasElement;
        const sourceHint = canvas.title || canvas.getAttribute("aria-label") || "";
        let hash = 2166136261;
        for (let index = 0; index < sourceHint.length; index += 1) {
          hash ^= sourceHint.charCodeAt(index);
          hash = Math.imul(hash, 16777619);
        }
        hint = `${canvas.width}x${canvas.height}:${(hash >>> 0).toString(16)}`;
      }
      else hint = String((cand as HTMLElement).innerHTML?.length ?? 0);
      return `${tag}|${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}|${hint}`;
    }, QR_DETECT_SELECTOR)
    .catch(() => null);
}

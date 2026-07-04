import type { Frame, Page } from "patchright";

// Vocabulario DOM compartilhado + utilitarios de frame usados pela automacao.
// Extraido de automation-runtime.ts para permitir que a camada de deteccao de
// telas (screen-detection.ts) e o runtime compartilhem os mesmos tipos e a
// resolucao de frame sem duplicacao.

// Quando true, os page.evaluate() rodam no main world (necessario p/ tocar
// Pinia/__vue_app__). Mantido em false por padrao.
export const PATCHRIGHT_MAIN_WORLD = false;

export type BrowserRuntimeRect = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
};

export type BrowserRuntimeElement = {
  className?: string;
  click?: () => void;
  closest?: (selector: string) => BrowserRuntimeElement | null;
  compareDocumentPosition?: (other: BrowserRuntimeElement) => number;
  disabled?: boolean;
  dispatchEvent?: (event: unknown) => boolean;
  getAttribute?: (name: string) => string | null;
  getBoundingClientRect: () => BrowserRuntimeRect;
  id?: string;
  innerText?: string;
  name?: string;
  placeholder?: string;
  querySelector?: (selector: string) => BrowserRuntimeElement | null;
  querySelectorAll?: (selector: string) => Iterable<BrowserRuntimeElement>;
  readOnly?: boolean;
  removeAttribute?: (name: string) => void;
  setAttribute?: (name: string, value: string) => void;
  textContent?: string | null;
  type?: string;
  value?: string;
};

export type BrowserRuntimeInputElement = BrowserRuntimeElement & {
  value: string;
};

export type BrowserRuntimeWindow = {
  Event?: new (type: string, init?: { bubbles?: boolean }) => unknown;
  HTMLInputElement?: { prototype: object };
  document: {
    body?: BrowserRuntimeElement;
    querySelectorAll: (selector: string) => Iterable<BrowserRuntimeElement>;
  };
  getComputedStyle: (element: BrowserRuntimeElement) => {
    display: string;
    opacity?: string;
    visibility: string;
    zIndex?: string;
  };
  innerHeight: number;
  innerWidth: number;
};

// Resolve o frame que hospeda o conteudo da SPA (h5_iframe/redirect), caindo de
// volta para a propria pagina quando nao ha frame filho relevante. Puro: depende
// somente da page recebida.
export function resolveContentFrame(page: Page): Page | Frame {
  const frames = page.frames();
  const childFrames = frames.filter((f) => f !== page.mainFrame());

  if (childFrames.length === 0) {
    return page;
  }

  const readFrameTarget = (frame: Frame) => {
    const url = (() => { try { return frame.url(); } catch { return ""; } })();
    const name = (() => { try { return frame.name(); } catch { return ""; } })();
    return `${url} ${name}`;
  };

  const isBlankFrame = (target: string) => /^about:(blank|srcdoc)(\s|$)/.test(target);
  const appFrame = childFrames.find((frame) => {
    const target = readFrameTarget(frame);
    return !isBlankFrame(target) && /h5_iframe|isredirect=1|\/home\/|\/home\b|game/i.test(target);
  });
  if (appFrame) {
    return appFrame;
  }

  const contentFrame = childFrames.find((frame) => {
    const target = readFrameTarget(frame);
    return !isBlankFrame(target) && !/captcha|recaptcha|hcaptcha|turnstile|geetest|gcaptcha/i.test(target);
  });

  return contentFrame ?? page;
}

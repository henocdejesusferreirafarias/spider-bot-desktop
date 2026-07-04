import type { Frame, Page } from "patchright";
import {
  PATCHRIGHT_MAIN_WORLD,
  resolveContentFrame,
  type BrowserRuntimeElement,
  type BrowserRuntimeInputElement,
  type BrowserRuntimeWindow
} from "./automation-dom.js";

// Camada de deteccao de telas: predicados puros sobre uma Page/Frame que
// respondem "que tela/superficie estou vendo?" (sessao ativa, form de login,
// dialogs de erro, superficies de saque/senha/deposito/perfil, familia de UI
// de cadastro). Extraido de automation-runtime.ts. Cada funcao e stateless e
// depende apenas de resolveContentFrame/PATCHRIGHT_MAIN_WORLD de automation-dom,
// o que as torna testaveis isoladamente.

export async function hasActiveSession(page: Page): Promise<boolean> {
  const primary = resolveContentFrame(page);
  const candidates: Array<{ target: Page | Frame; allowWeakNoEntry: boolean }> = [
    { target: primary, allowWeakNoEntry: true }
  ];

  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || (frame as unknown) === primary) {
      continue;
    }
    candidates.push({ target: frame, allowWeakNoEntry: false });
  }

  if ((primary as unknown) !== page) {
    candidates.push({ target: page, allowWeakNoEntry: false });
  }

  const states = await Promise.all(
    candidates.map(({ target, allowWeakNoEntry }) =>
      detectActiveSessionInFrame(target, allowWeakNoEntry)
    )
  );
  return states.includes("active");
}

export async function detectActiveSessionInFrame(
  target: Page | Frame,
  allowWeakNoEntry: boolean
): Promise<"active" | "anonymous" | "unknown"> {
  return target
    .evaluate((allowWeak) => {
      type RuntimeElement = {
        className?: string;
        getAttribute?: (name: string) => string | null;
        getBoundingClientRect: () => {
          bottom: number; height: number; left: number; right: number; top: number; width: number;
        };
        id?: string;
        innerText?: string;
        tagName?: string;
        textContent?: string | null;
        querySelectorAll?: (selector: string) => Iterable<RuntimeElement>;
      };
      const runtimeWindow = globalThis as unknown as {
        document: {
          body?: { innerText: string };
          querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
        };
        getComputedStyle: (element: RuntimeElement) => { display: string; opacity: string; visibility: string };
        innerHeight: number;
        innerWidth: number;
        location: { pathname: string; search: string; hash: string };
      };
      const normalize = (value: string | null | undefined) =>
        (value || "")
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      const attr = (el: RuntimeElement, name: string) => {
        try {
          return el.getAttribute?.(name) || "";
        } catch {
          return "";
        }
      };
      const readAttrs = (el: RuntimeElement) =>
        normalize([
          el.id || "",
          typeof el.className === "string" ? el.className : "",
          attr(el, "id"),
          attr(el, "class"),
          attr(el, "aria-label"),
          attr(el, "title"),
          attr(el, "role"),
          attr(el, "href"),
          attr(el, "name"),
          attr(el, "placeholder"),
          attr(el, "data-testid"),
          attr(el, "data-test")
        ].join(" "));
      const readSemantic = (el: RuntimeElement) =>
        normalize([
          el.textContent || el.innerText || "",
          attr(el, "aria-label"),
          attr(el, "title"),
          attr(el, "role"),
          attr(el, "href"),
          attr(el, "name"),
          attr(el, "placeholder"),
          attr(el, "data-testid"),
          attr(el, "data-test")
        ].join(" "));
      const isVisible = (el: RuntimeElement) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 18 || rect.height < 8 || rect.bottom <= 0 || rect.right <= 0) return false;
        if (rect.top >= runtimeWindow.innerHeight || rect.left >= runtimeWindow.innerWidth) return false;
        const style = runtimeWindow.getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.01;
      };
      const injectedOverlaySelector =
        "#spider-acct-info,#predator-splash-overlay,#predator-deposit-qr-overlay,#predator-deposit-qr-reopen";
      let rawBodyText = runtimeWindow.document.body?.innerText || "";
      for (const overlay of Array.from(runtimeWindow.document.querySelectorAll(injectedOverlaySelector))) {
        const overlayText = overlay.textContent || "";
        if (overlayText) {
          rawBodyText = rawBodyText.split(overlayText).join(" ");
        }
      }
      const bodyText = normalize(rawBodyText);
      const isLoadingOnly = /carregando|loading|aguarde|please wait|skeleton/.test(bodyText) && bodyText.length < 80;
      const path = normalize(
        `${runtimeWindow.location.pathname} ${runtimeWindow.location.search} ${runtimeWindow.location.hash}`
      );
      const hasLoginDialog = Array.from(
        runtimeWindow.document.querySelectorAll(
          ".ui-overlay .ui-popup,.ui-overlay .ui-dialog,[class*='login' i][class*='dialog' i],[class*='login' i][class*='popup' i]"
        )
      ).some((el) => {
        if (!isVisible(el)) return false;
        const inputs = Array.from(el.querySelectorAll?.("input") ?? []);
        const hasPassword = inputs.some((i) => (i.getAttribute?.("type") || "").toLowerCase() === "password");
        if (!hasPassword) return false;
        const text = normalize(el.textContent);
        return /login|entrar|senha|password|iniciar sess/.test(text);
      });
      if (hasLoginDialog) return "anonymous";
      const loginEntryKeywords = /\blogin\b|\bentrar\b|\biniciar sess|\blog in\b|\bsign in\b/;
      const registerEntryKeywords = /\bregistro\b|\bregistrar\b|\bcadastro\b|\bcadastrar\b|\bregister\b|\bsign up\b|\bsignup\b/;
      const allClickable = Array.from(
        runtimeWindow.document.querySelectorAll(
          "button,a,[role='button'],[role='tab'],input[type='button'],input[type='submit']," +
          "span[id*='login' i],span[class*='login' i],span[id*='register' i],span[class*='register' i]," +
          "div[role='button'],[id*='login' i],[class*='login' i],[id*='signin' i],[class*='signin' i]," +
          "[id*='regist' i],[class*='regist' i],[class*='cadastro' i],[id*='signup' i],[class*='signup' i]"
        )
      ).filter(isVisible);
      const isInteractiveEntry = (el: RuntimeElement) => {
        const tag = normalize(el.tagName);
        const attrs = readAttrs(el);
        return /^(a|button|input)$/.test(tag) || /\b(button|tab)\b|btn|nav|item|login|signin|regist|register|signup|cadastro/.test(attrs);
      };
      const hasLoginEntry = allClickable.some((el) => {
        if (!isInteractiveEntry(el)) return false;
        const elText = readSemantic(el);
        const haystack = `${elText} ${readAttrs(el)}`;
        return (elText.length < 36 || /login|signin|entrar/.test(readAttrs(el))) && loginEntryKeywords.test(haystack);
      });
      const hasRegisterEntry = allClickable.some((el) => {
        if (!isInteractiveEntry(el)) return false;
        const elText = readSemantic(el);
        const haystack = `${elText} ${readAttrs(el)}`;
        return (elText.length < 36 || /regist|register|signup|cadastro/.test(readAttrs(el))) && registerEntryKeywords.test(haystack);
      });
      const sessionSignals = new Set<string>();
      const collectSessionSignals = (semantic: string, interactive: boolean) => {
        if (/\bsaldo\b|\bbalance\b/.test(semantic)) sessionSignals.add("balance");
        if (/depositar|deposito|recarga|recharge/.test(semantic)) sessionSignals.add("deposit");
        if (/saque|withdraw|retirada/.test(semantic)) sessionSignals.add("withdraw");
        if (/carteira|wallet/.test(semantic)) sessionSignals.add("wallet");
        if (/minha conta|meu perfil|\bperfil\b|\bprofile\b|\bmine\b/.test(semantic)) sessionSignals.add("profile");
        if (interactive && /^(eu|me)$/.test(semantic)) sessionSignals.add("profile");
        if (/\bsair\b|\blogout\b|sign out/.test(semantic)) sessionSignals.add("logout");
      };
      collectSessionSignals(bodyText, false);
      for (const el of allClickable) {
        if (!isInteractiveEntry(el)) continue;
        const semantic = readSemantic(el);
        if (loginEntryKeywords.test(semantic) || registerEntryKeywords.test(semantic)) continue;
        collectSessionSignals(`${semantic} ${readAttrs(el)}`, true);
      }
      const isLoggedRoute = /home\/mine|\/mine(?:\/|$)|\/profile(?:\/|$)|\/account(?:\/|$)|\/usercenter|\/personalcenter|\/membercenter|\/wallet(?:\/|$)/.test(path);
      const hasLoggedAffordance = sessionSignals.size >= 1;
      const strongLoggedAffordance = sessionSignals.size >= 2;
      const isHomeLandingWithoutSession =
        /^\/$|^\/home\/?$|^\/index/.test(runtimeWindow.location.pathname) &&
        (/registro|registrar|cadastro|sign up|signup|register/.test(bodyText) || hasLoginEntry || hasRegisterEntry) &&
        !hasLoggedAffordance;
      if (isHomeLandingWithoutSession) return "anonymous";
      if (hasLoginEntry && hasRegisterEntry) return "anonymous";
      if (!isLoadingOnly && strongLoggedAffordance) return "active";
      if (!isLoadingOnly && isLoggedRoute && !hasLoginEntry && !hasRegisterEntry) return "active";
      if (!isLoadingOnly && !hasLoginEntry && !hasRegisterEntry && hasLoggedAffordance) return "active";
      if (!isLoadingOnly && allowWeak && !hasLoginEntry && !hasRegisterEntry && bodyText.length > 60) return "active";
      if (hasLoginEntry) return "anonymous";
      return "unknown";
    }, allowWeakNoEntry, PATCHRIGHT_MAIN_WORLD)
    .catch(() => "unknown");
}

export async function isLoginFormVisible(page: Page): Promise<boolean> {
  const frame = resolveContentFrame(page);
  return frame
    .evaluate(() => {
      const runtimeWindow = globalThis as unknown as {
        document: { querySelectorAll: (selector: string) => Iterable<{
          getBoundingClientRect: () => { bottom: number; height: number; right: number; top: number; width: number };
          getAttribute?: (name: string) => string | null;
          textContent?: string | null;
        }> };
        getComputedStyle: (element: unknown) => { display: string; visibility: string; opacity: string };
        innerHeight: number;
        innerWidth: number;
      };
      const normalize = (value: string | null | undefined) =>
        (value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
      type RuntimeElement = {
        getBoundingClientRect: () => { bottom: number; height: number; right: number; top: number; width: number };
        getAttribute?: (name: string) => string | null;
        textContent?: string | null;
        querySelectorAll?: (selector: string) => Iterable<RuntimeElement>;
      };
      const isVisible = (el: RuntimeElement) => {
        const style = runtimeWindow.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0.01 && rect.width > 30 && rect.height > 30;
      };
      const dialogSelector =
        ".ui-overlay .ui-popup,.ui-overlay .ui-dialog,[class*='login' i][class*='dialog' i]," +
        "[class*='login' i][class*='popup' i],[class*='_login_' i],.login_content,.m_sign_in," +
        ".sign_in_body,.form_box,form[class*='login' i]";
      for (const el of runtimeWindow.document.querySelectorAll(dialogSelector)) {
        if (!isVisible(el as RuntimeElement)) continue;
        const text = normalize((el as RuntimeElement).textContent);
        const inputs = Array.from((el as RuntimeElement).querySelectorAll?.("input") ?? []);
        const passwordInputs = inputs.filter((i) => normalize(i.getAttribute?.("type")) === "password");
        if (passwordInputs.length === 1 && /login|entrar|senha|password/.test(text)) {
          return true;
        }
      }
      return false;
    })
    .catch(() => false);
}

export async function detectLoginErrorMessage(page: Page): Promise<string | undefined> {
  return detectPlatformErrorDialog(page);
}

export async function detectRegistrationErrorMessage(page: Page): Promise<string | undefined> {
  const dialogError = await detectPlatformErrorDialog(page);
  if (dialogError) return dialogError;

  return resolveContentFrame(page)
    .evaluate(() => {
      const runtimeWindow = globalThis as unknown as {
        document: { querySelectorAll: (selector: string) => Iterable<{
          getBoundingClientRect: () => { width: number; height: number };
          textContent?: string | null;
        }> };
        getComputedStyle: (element: unknown) => { display: string; visibility: string; opacity: string };
      };
      const normalize = (v: string | null | undefined) =>
        (v || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
      // W1 inline: "Conta de membro já existente" (seção _texts_ com sugestões)
      for (const el of runtimeWindow.document.querySelectorAll("[class*='_texts_'],[class*='explain-text'],[class*='explain_text']")) {
        const style = runtimeWindow.getComputedStyle(el);
        if (style.display === "none") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 5) continue;
        const text = normalize(el.textContent);
        if (text && /exist|ja exist|already|membro.*exist|conta.*exist/.test(text)) {
          return text;
        }
      }
      // W1 inline: validation errors (formato da conta, senha fraca, etc.)
      for (const el of runtimeWindow.document.querySelectorAll(".lobby-form-item__explain-text__error,[class*='error'][class*='explain']")) {
        const style = runtimeWindow.getComputedStyle(el);
        if (style.display === "none") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 5) continue;
        const text = normalize(el.textContent);
        if (text && text.length > 3 && text.length < 200) {
          return text;
        }
      }
      return undefined;
    })
    .catch(() => undefined);
}

export async function detectPlatformErrorDialog(page: Page): Promise<string | undefined> {
  return resolveContentFrame(page)
    .evaluate(() => {
      type RuntimeOverlay = {
        getAttribute: (name: string) => string | null;
        querySelector: (selector: string) => { textContent?: string | null } | null;
      };
      const runtimeWindow = globalThis as unknown as {
        document: { querySelectorAll: (selector: string) => Iterable<RuntimeOverlay> };
        getComputedStyle: (element: unknown) => { display: string; zIndex: string };
      };
      const normalize = (v: string | null | undefined) =>
        (v || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
      // W1 "Lembrete" dialog: .ui-overlay (z > 2001) contendo .ui-dialog com .ui-dialog__message
      for (const overlay of runtimeWindow.document.querySelectorAll(".ui-overlay")) {
        const style = runtimeWindow.getComputedStyle(overlay);
        if (style.display === "none") continue;
        const z = parseInt(style.zIndex || "0");
        if (z <= 2001) continue;
        if (overlay.getAttribute("data-hidden") === "1") continue;
        const msg = overlay.querySelector(".ui-dialog__message");
        if (!msg) continue;
        const text = normalize(msg.textContent);
        if (text && text.length > 3) return text;
      }
      return undefined;
    })
    .catch(() => undefined);
}

export async function hasWithdrawalPasswordSetupSurface(page: Page): Promise<boolean> {
  return resolveContentFrame(page)
    .evaluate(() => {
      const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
      const normalize = (value: string | null | undefined) =>
        (value || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      const isVisible = (element: BrowserRuntimeElement) => {
        const rect = element.getBoundingClientRect();
        const style = runtimeWindow.getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 8 &&
          rect.height > 8
        );
      };
      // O form de CRIAR e o modal de ENTRAR vivem ambos num dialog/popup/overlay. Conta
      // os PIN-grids DENTRO do dialog ativo: CRIAR tem 2 (nova + confirmar), ENTRAR tem 1.
      // Isso distingue as telas SEM depender da copy e evita o falso-positivo com o campo
      // de senha INLINE da propria tela de saque (que somava 2 no documento todo e fazia o
      // modal de ENTRAR ser tratado como CRIAR -> fillWithdrawalPasswordSetup achava 1
      // campo e falhava com "campos para criar senha de saque nao encontrados").
      const inDialog = (element: BrowserRuntimeElement) =>
        Boolean(
          (element as unknown as { closest?: (s: string) => unknown }).closest?.(
            "[class*='dialog' i],[class*='popup' i],[class*='overlay' i],[class*='modal' i],[role='dialog'],.ui-overlay"
          )
        );
      const dialogFields = Array.from(
        runtimeWindow.document.querySelectorAll(".ui-password-input,[class*='password-input' i]")
      ).filter((el) => isVisible(el) && inDialog(el));
      const text = normalize(runtimeWindow.document.body?.innerText || "");
      // Guard: o modal de ENTRAR senha existente ("Inserir PIN", "Esqueceu a senha",
      // "introduza a senha") NUNCA e a tela de criar -- mesmo que algo conte 2 campos.
      const looksLikeEnterModal =
        /inserir (?:senha|pin)|esqueceu a senha|introduza a senha/.test(text);
      if (looksLikeEnterModal) {
        return false;
      }
      // Sinal ESTRUTURAL: 2+ PIN-grids no MESMO dialog = form de criar.
      if (dialogFields.length >= 2) {
        return true;
      }
      // Sinal TEXTUAL (fallback p/ setup em ROTA/pagina cheia, sem dialog): verbo de
      // criacao perto de "senha" (sem "adicionar", que aparece por toda a UI de saque).
      return (
        /senha de saque/.test(text) &&
        /(definir|defina|cadastr|criar|crie|configurar|configure)\b(?:\s+\w+){0,2}\s+senha/.test(text)
      );
    })
    .catch(() => false);
}

export async function hasWithdrawalPasswordRequiredCallToAction(page: Page): Promise<boolean> {
  return resolveContentFrame(page)
    .evaluate(() => {
      const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
      const normalize = (value: string | null | undefined) =>
        (value || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      const isVisible = (element: BrowserRuntimeElement) => {
        const rect = element.getBoundingClientRect();
        const style = runtimeWindow.getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0.01 &&
          rect.width > 8 &&
          rect.height > 8 &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < runtimeWindow.innerWidth &&
          rect.top < runtimeWindow.innerHeight
        );
      };
      const controls = Array.from(
        runtimeWindow.document.querySelectorAll("button,[role='button'],a,.ui-button,.ui-cell,div,span,li")
      );
      return controls.some((element) => {
        if (!isVisible(element)) {
          return false;
        }
        const text = normalize(element.textContent);
        if (!text || text.length > 90) {
          return false;
        }
        return /adicionar|cadastrar|definir|configurar/.test(text) && /senha/.test(text) && /saque/.test(text);
      });
    })
    .catch(() => false);
}

export async function hasWithdrawalAccountSurface(page: Page): Promise<boolean> {
  return resolveContentFrame(page)
    .evaluate(() => {
      const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
      const normalize = (value: string | null | undefined) =>
        (value || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      const text = normalize(runtimeWindow.document.body?.innerText || "");
      return /solicitar saque|conta para recebimento|registro de saques/.test(text) && /pix|adicionar conta para saque|valor do saque/.test(text);
    })
    .catch(() => false);
}

export async function hasWithdrawalRequestSurface(page: Page): Promise<boolean> {
  return resolveContentFrame(page)
    .evaluate(() => {
      const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow & {
        location: { pathname: string; search: string };
      };
      const normalize = (value: string | null | undefined) =>
        (value || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      const isVisible = (element: BrowserRuntimeElement) => {
        const rect = element.getBoundingClientRect();
        const style = runtimeWindow.getComputedStyle(element);
        return (
          rect.width > 8 &&
          rect.height > 8 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < runtimeWindow.innerHeight &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      };
      const bodyText = normalize(runtimeWindow.document.body?.innerText || "");
      const route = normalize(`${runtimeWindow.location.pathname} ${runtimeWindow.location.search}`);
      const withdrawalRoots = Array.from(
        runtimeWindow.document.querySelectorAll(
          "#withdrawal,[class*='withdraw' i],[id*='withdraw' i],[class*='saque' i],[id*='saque' i],[class*='retirada' i],[id*='retirada' i]"
        )
      ).filter(isVisible);
      const root = withdrawalRoots[0] ?? runtimeWindow.document.body;
      const amountInputs = Array.from(
        runtimeWindow.document.querySelectorAll(
          "[data-item-name='amount'] input,input[placeholder*='minimo' i],input[placeholder*='minimum' i],input[placeholder*='valor' i],input[placeholder*='retirada' i],input[placeholder*='saque' i],input[name*='amount' i],input[name*='withdraw' i],input[name*='money' i]"
        )
      ).concat(Array.from(root?.querySelectorAll?.("input,textarea") ?? []))
        .filter((element, index, list) => list.indexOf(element) === index)
        .filter((element) => {
          const input = element as BrowserRuntimeInputElement;
          const text = normalize(
            [
              input.getAttribute?.("type"),
              input.getAttribute?.("placeholder"),
              input.getAttribute?.("name"),
              input.getAttribute?.("id"),
              input.getAttribute?.("class")
            ].join(" ")
          );
          return !/password|senha|hidden|checkbox|radio|file/.test(text);
        });
      const passwordControls = Array.from(
        runtimeWindow.document.querySelectorAll(
          "[data-item-name='passwd'],.ui-password-input,.ui-password-input__security,.van-password-input,.passwordInput,input[maxlength='6'],input[type='password']"
        )
      );
      const activeTabText = normalize(
        Array.from(runtimeWindow.document.querySelectorAll(".van-tab--active,[aria-selected='true'],[class*='active' i]"))
          .map((element) => (element as BrowserRuntimeElement).textContent || "")
          .join(" ")
      );
      const hasAmountCopy =
        /solicitar saque|solicitacao de saque|withdrawal request|quantia da retirada|valor do saque|valor de retirada|withdrawal amount|retirada/.test(
          bodyText
        );
      const hasPasswordCopy = /senha de saque|withdrawal password|verificar senha|senha para saque/.test(bodyText);
      const hasConfirmCopy = /confirmar retirada|confirmar saque|confirm withdrawal/.test(bodyText);
      const hasAllControl = /(^|\s)(tudo|tudos|todos|all)(\s|$)/.test(bodyText);
      const requestTabActive =
        !activeTabText ||
        /(^|\s)saque(\s|$)|solicitar saque/.test(activeTabText) ||
        (hasConfirmCopy && hasAmountCopy && hasPasswordCopy);
      const hasManualControls =
        hasPasswordCopy &&
        hasConfirmCopy &&
        (hasAllControl || /valor de retirada|valor do saque|quantia da retirada|withdrawal amount/.test(bodyText));

      return (
        /withdraw|saque/.test(route) &&
        requestTabActive &&
        hasAmountCopy &&
        hasManualControls &&
        amountInputs.some(isVisible) &&
        passwordControls.some(isVisible)
      );
    })
    .catch(() => false);
}

export async function hasExistingWithdrawalPasswordModal(page: Page): Promise<boolean> {
  return resolveContentFrame(page)
    .evaluate(() => {
      const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
      const normalize = (value: string | null | undefined) =>
        (value || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      const isVisible = (element: BrowserRuntimeElement) => {
        const rect = element.getBoundingClientRect();
        const style = runtimeWindow.getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 8 &&
          rect.height > 8
        );
      };
      // Sinal ESTRUTURAL (robusto entre plataformas, sem depender da copy): o gate de
      // confirmar a senha de saque e um dialog com EXATAMENTE 1 PIN-grid visivel
      // (.ui-password-input). O form de CRIAR senha tem 2 (nova + confirmar) e e tratado
      // por hasWithdrawalPasswordSetupSurface; o modal "Adicionar PIX" nao tem PIN-grid.
      // Confirmado em runtime na GameCancer: .ui-password-input dentro de .ui-dialog.
      const inDialog = (element: BrowserRuntimeElement) =>
        Boolean(
          (element as unknown as { closest?: (s: string) => unknown }).closest?.(
            "[class*='dialog' i],[class*='popup' i],[class*='overlay' i],[class*='modal' i],[role='dialog'],.ui-overlay"
          )
        );
      const dialogFields = Array.from(
        runtimeWindow.document.querySelectorAll(".ui-password-input,[class*='password-input' i]")
      ).filter((el) => isVisible(el) && inDialog(el));
      if (dialogFields.length === 1) {
        return true;
      }
      // Fallback TEXTUAL (compat): "inserir senha/pin" + "senha de saque" + "proximo".
      const text = normalize(runtimeWindow.document.body?.innerText || "");
      return /inserir (?:senha|pin)/.test(text) && /senha de saque/.test(text) && /proximo/.test(text);
    })
    .catch(() => false);
}

export async function hasVisibleNumberKeyboard(page: Page): Promise<boolean> {
  const frame = resolveContentFrame(page);
  return frame
    .evaluate(() => {
      const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
      const isKeyboardOrKey = (element: BrowserRuntimeElement) => {
        const rect = element.getBoundingClientRect();
        const style = runtimeWindow.getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 20 &&
          rect.height > 20
        );
      };
      return Array.from(
        runtimeWindow.document.querySelectorAll(
          ".ui-number-keyboard,.ui-number-keyboard-key,.van-number-keyboard,.van-key,[class*='number-keyboard' i],[class*='numberKeyboard' i],[class*='keyboard-key' i],[class*='keyboard_key' i]"
        )
      ).some(isKeyboardOrKey);
    })
    .catch(() => false);
}

export async function hasDepositSurface(page: Page): Promise<boolean> {
  return resolveContentFrame(page)
    .evaluate(() => {
      const runtimeWindow = globalThis as unknown as {
        document: {
          body: { innerText: string };
          querySelectorAll: (selector: string) => Iterable<{
            getAttribute?: (name: string) => string | null;
            getBoundingClientRect: () => { bottom: number; height: number; right: number; top: number; width: number };
            innerText?: string;
            querySelector?: (selector: string) => unknown;
            textContent?: string | null;
          }>;
        };
        innerHeight: number;
        location: { pathname: string; search: string };
      };
      const normalize = (value: string | null | undefined) =>
        (value || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      // O overlay "Dados da Conta" que injetamos no body adiciona "SENHA LOGIN"/"SENHA SAQUE"
      // ao innerText; sem remover, o guard hasRegistrationPrompt (registro+login+senha) dispara
      // e o deposito ABERTO e reportado como "modal nao abriu". Subtraimos o texto dos overlays.
      const injectedOverlaySelector =
        "#spider-acct-info,#predator-splash-overlay,#predator-deposit-qr-overlay,#predator-deposit-qr-reopen";
      let rawBodyText = runtimeWindow.document.body.innerText || "";
      for (const overlay of Array.from(runtimeWindow.document.querySelectorAll(injectedOverlaySelector))) {
        const overlayText = overlay.innerText || "";
        if (overlayText) {
          rawBodyText = rawBodyText.split(overlayText).join(" ");
        }
      }
      const bodyText = normalize(rawBodyText);
      const hasRegistrationPrompt =
        /suporta apenas conta|fazer login|registro vinculativo/.test(bodyText) ||
        (/registro/.test(bodyText) && /login/.test(bodyText) && /senha/.test(bodyText));

      const isVisible = (element: { getBoundingClientRect: () => { bottom: number; height: number; right: number; top: number; width: number } }) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 10 && rect.height > 10 && rect.bottom > 0 && rect.right > 0 && rect.top < runtimeWindow.innerHeight;
      };
      const paymentFieldSelector =
        "input[placeholder*='valor' i],input[placeholder*='amount' i],input[placeholder*='pix' i],input[name*='amount' i],input[id*='amount' i],input[class*='amount' i],input[class*='recharge' i],input[class*='deposit' i],input[data-valid*='amount' i],textarea[placeholder*='valor' i],textarea[placeholder*='amount' i],[contenteditable='true'][class*='amount' i],[role='textbox'][class*='amount' i],[class*='pay-channel' i],[class*='recharge-channel' i],[class*='deposit-channel' i]";
      const qrResultSelector =
        "#qrcode1 canvas,#qrcode1 img,#qrcode1 svg,#qrcode1 table,.codeimg canvas,.codeimg img,.codeimg svg,[class*='qrcode' i],[id*='qrcode' i],[class*='qr-code' i],[id*='qr-code' i],canvas[class*='qr' i],img[class*='qr' i],img[src*='qr' i],svg[class*='qr' i]";
      const popupRootSelector =
        ".ui-popup,.ui-dialog,.van-popup,.van-dialog,[role='dialog'],[aria-modal='true'],.modal,.popup";
      const strongDepositContainerSelector =
        "[class*='recharge' i],[id*='recharge' i],[class*='deposit' i],[id*='deposit' i],[class*='cashier' i],[id*='cashier' i],[class*='wallet' i],[id*='wallet' i]";
      const roots = Array.from(
        runtimeWindow.document.querySelectorAll(`${popupRootSelector},${strongDepositContainerSelector}`)
      ).filter(isVisible);
      const path = normalize(`${runtimeWindow.location.pathname} ${runtimeWindow.location.search}`);
      const isRechargeRoute = /home\/recharge|rechargecurrent|deposit|m_recharge|wallet|recharge/.test(path);

      const isDepositContainer = (root: {
        getAttribute?: (name: string) => string | null;
        querySelector?: (selector: string) => unknown;
        querySelectorAll?: (selector: string) => Iterable<{
          getBoundingClientRect: () => { bottom: number; height: number; right: number; top: number; width: number };
        }>;
        textContent?: string | null;
      }) => {
        const marker = normalize(
          [
            root.getAttribute?.("id"),
            root.getAttribute?.("class"),
            root.getAttribute?.("aria-label"),
            root.getAttribute?.("title")
          ].join(" ")
        );
        const text = normalize(root.textContent);
        const combined = `${marker} ${text}`;
        const hasStrongDepositMarker =
          /(^|\s|_|-|\/)(deposit|deposito|recharge|recarga|cashier|wallet|carteira|m_recharge)(\s|_|-|\/|$)|walletshow|payway|submittable/.test(
            marker
          );
        const hasActionableField = Array.from(root.querySelectorAll?.(paymentFieldSelector) ?? []).some(isVisible);
        const hasQrResult = Array.from(root.querySelectorAll?.(qrResultSelector) ?? []).some(isVisible);
        if (hasActionableField || hasQrResult) {
          return (
            hasStrongDepositMarker ||
            /deposito|depositar|recarga|recarregar|recharge|cashier|carteira|wallet|pix|brl-pix/.test(combined)
          );
        }

        return (
          hasStrongDepositMarker &&
          /deposito|depositar|recarga|recarregar|recharge|cashier|carteira|wallet/.test(combined) &&
          /pix|valor|amount|canal|channel|pagamento|payment|metodo|method|qrcode|qr code|brl-pix|deposite agora|deposit now/.test(
            text
          )
        );
      };

      if (hasRegistrationPrompt) {
        return false;
      }

      if (roots.some(isDepositContainer)) {
        return true;
      }

      const visiblePaymentField = Array.from(runtimeWindow.document.querySelectorAll(paymentFieldSelector)).some(isVisible);
      const visibleQrResult = Array.from(runtimeWindow.document.querySelectorAll(qrResultSelector)).some(isVisible);
      const hasDepositBody =
        /deposito|depositar|recarga|recarregar|recharge|cashier|carteira|wallet/.test(bodyText) &&
        /pix|valor|amount|canal|channel|pagamento|payment|metodo|method|qrcode|qr code|brl-pix|deposite agora|deposit now/.test(
          bodyText
        );

      return visibleQrResult || (visiblePaymentField && (isRechargeRoute || hasDepositBody)) || (isRechargeRoute && hasDepositBody);
    })
    .catch(() => false);
}

// Detecta se a area de Perfil ja renderizou. O bug do "as vezes nao abre o
// deposito" era exatamente isto: depois do clique em Perfil, o codigo tentava
// clicar em Deposito imediatamente (6 tentativas em ~1.8s), e como o SPA ainda
// estava animando/carregando a tela de perfil, o botao nao aparecia a tempo.
// Sinais (mobile UI W1): rota com mine/profile/account, conteudo classico do
// perfil (saque/sair/saldo) e botao de Deposito visivel dentro da pagina.
export async function hasProfileSurface(page: Page): Promise<boolean> {
  return resolveContentFrame(page)
    .evaluate(() => {
      const runtimeWindow = globalThis as unknown as {
        document: {
          body: { innerText: string };
          querySelectorAll: (selector: string) => Iterable<{
            getBoundingClientRect: () => { bottom: number; height: number; right: number; top: number; width: number };
            innerText?: string;
            textContent?: string | null;
            getAttribute?: (name: string) => string | null;
          }>;
        };
        innerHeight: number;
        location: { pathname: string; search: string; hash: string };
      };
      const normalize = (value: string | null | undefined) =>
        (value || "")
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      // Remove o texto dos nossos overlays injetados (o "SENHA SAQUE" do overlay adiciona
      // "saque" ao innerText e inflaria profileKeywordsInBody — falso "perfil pronto").
      const injectedOverlaySelector =
        "#spider-acct-info,#predator-splash-overlay,#predator-deposit-qr-overlay,#predator-deposit-qr-reopen";
      let rawBodyText = runtimeWindow.document.body.innerText || "";
      for (const overlay of Array.from(runtimeWindow.document.querySelectorAll(injectedOverlaySelector))) {
        const overlayText = overlay.innerText || "";
        if (overlayText) {
          rawBodyText = rawBodyText.split(overlayText).join(" ");
        }
      }
      const bodyText = normalize(rawBodyText);
      const path = normalize(
        `${runtimeWindow.location.pathname} ${runtimeWindow.location.search} ${runtimeWindow.location.hash}`
      );
      const isProfileRoute =
        /home\/mine|\/mine|\/profile|\/account|\/usercenter|\/personalcenter|\/membercenter|mycenter|personalinfo|usercenter|membercenter/.test(
          path
        );
      const isVisible = (element: { getBoundingClientRect: () => { bottom: number; height: number; right: number; top: number; width: number } }) => {
        const r = element.getBoundingClientRect();
        return r.width > 10 && r.height > 10 && r.bottom > 0 && r.right > 0 && r.top < runtimeWindow.innerHeight;
      };
      const hasDepositCta = Array.from(
        runtimeWindow.document.querySelectorAll(
          "[class*='deposit' i],[class*='recharge' i],[class*='wallet' i],[class*='cashier' i],[id*='deposit' i],[id*='recharge' i],[href*='recharge' i],[href*='deposit' i],[to*='recharge' i],[to*='deposit' i]"
        )
      ).some((element) => {
        if (!isVisible(element)) return false;
        const text = normalize(element.textContent);
        const attrs = normalize(
          [
            element.getAttribute?.("id"),
            element.getAttribute?.("class"),
            element.getAttribute?.("aria-label"),
            element.getAttribute?.("title"),
            element.getAttribute?.("href"),
            element.getAttribute?.("to")
          ].join(" ")
        );
        return /deposito|depositar|recarga|recarregar|recharge|deposit|cashier|wallet|carteira/.test(
          text + " " + attrs
        );
      });
      const profileKeywordsInBody =
        (/sair|logout|sign out/.test(bodyText) ? 1 : 0) +
        (/saldo|balance|carteira|wallet/.test(bodyText) ? 1 : 0) +
        (/saque|withdraw|retirada/.test(bodyText) ? 1 : 0) +
        (/perfil|profile|minha conta|meu perfil|conta pessoal|centro pessoal/.test(bodyText) ? 1 : 0);
      if (isProfileRoute && (hasDepositCta || profileKeywordsInBody >= 2)) return true;
      if (hasDepositCta && profileKeywordsInBody >= 2) return true;
      return false;
    })
    .catch(() => false);
}

export async function detectRegistrationUiFamily(page: Page): Promise<string | undefined> {
  const signals = await page
    .evaluate(() => {
      type RuntimeElement = unknown;
      const runtimeWindow = globalThis as unknown as {
        document: {
          documentElement: { innerHTML: string };
          querySelector: (selector: string) => RuntimeElement | null;
        };
      };
      const html = runtimeWindow.document.documentElement.innerHTML.toLowerCase().slice(0, 250000);
      return {
        hasLegacyVue: /\/home\/js\/app\.|\/webapi\/client\/|\/invite\/index|activitylist/.test(html),
        hasModernSubmit: Boolean(runtimeWindow.document.querySelector("#insideRegisterSubmitClick")),
        hasVant: /van-popup|van-tabs|van-field|van-tab/.test(html)
      };
    })
    .catch(() => undefined);

  if (!signals) {
    return undefined;
  }

  if (signals.hasModernSubmit) {
    return "whitelabel moderno";
  }

  if (signals.hasLegacyVue && signals.hasVant) {
    return "vue/vant legado";
  }

  if (signals.hasVant) {
    return "vant generico";
  }

  return "generico";
}

export function isDetachedDepositRouteState(state: { body: string; url: string }): boolean {
  let path = "";
  try {
    const parsed = new URL(state.url);
    path = `${parsed.pathname}${parsed.search}${parsed.hash}`.toLowerCase();
  } catch {
    path = state.url.toLowerCase();
  }

  const isDetachedRechargePath = /(^|\/)(m_recharge|firstrecharge)(\/|\?|#|$)/i.test(path);
  if (!isDetachedRechargePath) {
    return false;
  }

  const hasUsableDepositContent =
    /deposito|depositar|recarga|recarregar|recharge|pix|valor|amount|canal|channel|pagamento|payment|metodo|method|qrcode|qr code/.test(
      state.body
    );
  return state.body.length < 120 || !hasUsableDepositContent;
}

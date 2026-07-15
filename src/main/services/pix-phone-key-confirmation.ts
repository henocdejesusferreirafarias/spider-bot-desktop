import type { SpaHandle } from "./spa-navigation.js";
import {
  decidePixPhonePreflight,
  type PixReceivingAccount,
} from "./pix-phone-key-lifecycle.js";

const MAIN_WORLD = false;
const POLL_INTERVAL_MS = 180;

export interface PixReceivingAccountSnapshot {
  routeActive10: boolean;
  visiblePixFormModals: number;
  sourceActions: number;
  modalIndex?: number;
  buttonIndex?: number;
  accounts: PixReceivingAccount[];
  hasError: boolean;
}

export interface PixPhoneSubmissionResult {
  actionAttempted: boolean;
  clickRejected: boolean;
  result: "confirmed" | "conflict" | "pending" | "error";
  reason?: string;
}

const emptySnapshot = (): PixReceivingAccountSnapshot => ({
  routeActive10: false,
  visiblePixFormModals: 0,
  sourceActions: 0,
  accounts: [],
  hasError: false,
});

export async function inspectPixReceivingAccounts(surface: SpaHandle): Promise<PixReceivingAccountSnapshot> {
  return surface.evaluate(() => {
    type Rec = Record<PropertyKey, unknown>;
    const isObject = (value: unknown): value is Rec => Boolean(value) && (typeof value === "object" || typeof value === "function");
    const read = (value: unknown, key: PropertyKey): unknown => {
      if (!isObject(value)) return undefined;
      try {
        return value[key];
      } catch {
        return undefined;
      }
    };
    const unwrap = (value: unknown): unknown => isObject(value) && "value" in value ? read(value, "value") : value;
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = globalThis.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 8 && rect.height > 8;
    };
    const normalize = (value: unknown): string => String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const maskPhone = (value: unknown): string | undefined => {
      const text = String(value ?? "").trim();
      if (!text) return undefined;
      if (text.includes("*")) return text;
      const digits = text.replace(/\D/g, "");
      return digits.length >= 5 ? `${digits.slice(0, 2)}***${digits.slice(-3)}` : undefined;
    };
    const document = globalThis.document;
    const roots = Array.from(document.querySelectorAll<HTMLElement>(".ui-popup.ui-dialog"));
    const dialogSources = roots.flatMap((root, modalIndex) => {
      if (!visible(root) || !normalize(root.textContent).includes("pix")) return [];
      const hasVisiblePin = Array.from(root.querySelectorAll<HTMLElement>(".ui-password-input, .ui-number-keyboard"))
        .some((element) => visible(element));
      if (hasVisiblePin) return [];
      const buttons = Array.from(root.querySelectorAll<HTMLElement>(".ui-button, button"));
      const confirmIndexes = buttons
        .map((button, buttonIndex) => ({ button, buttonIndex }))
        .filter(({ button }) => visible(button))
        .filter(({ button }) => !button.hasAttribute("disabled"))
        .filter(({ button }) => normalize(button.textContent) === "confirmar")
        .map(({ buttonIndex }) => buttonIndex);
      return [{ modalIndex, confirmIndexes }];
    });
    const visiblePixFormModals = dialogSources.length;
    const sourceActions = dialogSources.reduce((total, source) => total + source.confirmIndexes.length, 0);
    const source = visiblePixFormModals === 1 && sourceActions === 1 ? dialogSources[0] : undefined;

    const rootsForStores = Array.from(document.querySelectorAll("body, body *")) as unknown as Array<Rec & {
      __vue_app__?: unknown;
      __vueParentComponent?: unknown;
    }>;
    const piniaCandidates = new Set<unknown>();
    const addAppPinia = (app: unknown): void => {
      piniaCandidates.add(read(read(read(app, "config"), "globalProperties"), "$pinia"));
      piniaCandidates.add(read(read(read(read(app, "_context"), "config"), "globalProperties"), "$pinia"));
    };
    for (const root of rootsForStores) {
      addAppPinia(root.__vue_app__);
      addAppPinia(read(root.__vueParentComponent, "appContext"));
    }

    const accounts: PixReceivingAccount[] = [];
    const accountIds = new Set<string>();
    const addAccount = (kind: PixReceivingAccount["kind"], rawPhone?: unknown): void => {
      const maskedPhone = kind === "pix-phone" ? maskPhone(rawPhone) : undefined;
      const id = `${kind}:${maskedPhone ?? ""}`;
      if (accountIds.has(id)) return;
      accountIds.add(id);
      accounts.push(maskedPhone ? { kind, maskedPhone } : { kind });
    };
    const inspectAccount = (candidate: unknown): void => {
      if (!isObject(candidate)) return;
      const text = Object.values(candidate).map((value) => String(unwrap(value) ?? "")).join(" ");
      const normalized = normalize(text);
      const kind: PixReceivingAccount["kind"] = /pix/.test(normalized) ? "pix-phone" : "other";
      const accountValue = unwrap(read(candidate, "account"))
        ?? unwrap(read(candidate, "phone"))
        ?? unwrap(read(candidate, "phoneNumber"));
      addAccount(kind, accountValue);
    };
    for (const candidate of piniaCandidates) {
      const stores = read(candidate, "_s") as Map<unknown, unknown> | undefined;
      if (!stores || typeof stores.values !== "function") continue;
      for (const store of stores.values()) {
        for (const key of ["accountList", "withdrawAccountList", "withdrawBankAccountList"]) {
          const list = unwrap(read(store, key));
          if (!Array.isArray(list)) continue;
          for (const item of list) inspectAccount(item);
        }
      }
    }
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("[class*='account'], [class*='Account']"))) {
      if (!visible(element)) continue;
      const text = element.textContent ?? "";
      if (!/pix/i.test(text)) continue;
      const masked = text.match(/\d{2,}[^\d]*\*+[^\d]*\d{3,}/)?.[0];
      addAccount("pix-phone", masked);
    }

    const runtime = globalThis as unknown as Rec;
    const directRouter = read(runtime, "$router");
    const route = unwrap(read(directRouter, "currentRoute"));
    const query = read(route, "query") as Rec | undefined;
    const path = String(read(route, "path") ?? "");
    const routeActive10 = String(read(query, "active") ?? "") === "10" && /withdraw/i.test(path);
    const bodyText = normalize(document.body?.textContent);
    const hasError = /(erro|falha|invalid|inval|nao foi|failed|denied|recus)/.test(bodyText)
      && !/(sucesso|success)/.test(bodyText);

    return {
      routeActive10,
      visiblePixFormModals,
      sourceActions,
      modalIndex: source?.modalIndex,
      buttonIndex: source?.confirmIndexes[0],
      accounts,
      hasError,
    };
  }, undefined, MAIN_WORLD).catch(emptySnapshot);
}

function hasUniqueSource(snapshot: PixReceivingAccountSnapshot): boolean {
  return snapshot.routeActive10
    && snapshot.visiblePixFormModals === 1
    && snapshot.sourceActions === 1
    && snapshot.modalIndex !== undefined
    && snapshot.buttonIndex !== undefined;
}

function sameSource(left: PixReceivingAccountSnapshot, right: PixReceivingAccountSnapshot): boolean {
  return hasUniqueSource(left)
    && hasUniqueSource(right)
    && left.modalIndex === right.modalIndex
    && left.buttonIndex === right.buttonIndex;
}

export async function confirmPixPhoneSubmission(
  surface: SpaHandle,
  phoneNumber: string,
  timeoutMs: number,
): Promise<PixPhoneSubmissionResult> {
  const first = await inspectPixReceivingAccounts(surface);
  if (!hasUniqueSource(first)) {
    return { actionAttempted: false, clickRejected: false, result: "error", reason: "source-invalid" };
  }
  await surface.waitForTimeout(POLL_INTERVAL_MS).catch(() => undefined);
  const second = await inspectPixReceivingAccounts(surface);
  if (!sameSource(first, second)) {
    return { actionAttempted: false, clickRejected: false, result: "error", reason: "source-unstable" };
  }

  let clickRejected = false;
  try {
    await surface
      .locator(".ui-popup.ui-dialog")
      .nth(second.modalIndex!)
      .locator(".ui-button, button")
      .nth(second.buttonIndex!)
      .click({ timeout: 1_500 });
  } catch {
    clickRejected = true;
  }

  const startedAt = Date.now();
  do {
    const current = await inspectPixReceivingAccounts(surface);
    if (current.hasError) {
      return { actionAttempted: true, clickRejected, result: "error", reason: "error-surface" };
    }
    const decision = decidePixPhonePreflight({
      pendingKeyId: "submitted",
      phoneNumber,
      accounts: current.accounts,
    });
    if (current.visiblePixFormModals === 0 && decision === "pending-used") {
      return { actionAttempted: true, clickRejected, result: "confirmed" };
    }
    if (current.visiblePixFormModals === 0 && decision === "conflict") {
      return { actionAttempted: true, clickRejected, result: "conflict", reason: "different-account" };
    }
    if (Date.now() - startedAt >= timeoutMs) break;
    await surface.waitForTimeout(POLL_INTERVAL_MS).catch(() => undefined);
  } while (true);

  return { actionAttempted: true, clickRejected, result: "pending", reason: "destination-unconfirmed" };
}

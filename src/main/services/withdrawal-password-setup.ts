import type { SpaHandle } from "./spa-navigation.js";
import { PATCHRIGHT_MAIN_WORLD } from "./automation-dom.js";

export type WithdrawalPasswordSetupStage = "first-field-filled" | "second-field-filled";

export interface WithdrawalPasswordSetupResult {
  ok: boolean;
  firstFieldFilled: boolean;
  secondFieldFilled: boolean;
  reason?: "surface-invalid" | "field-not-focused" | "field-partially-filled" | "digit-unconfirmed";
  diag?: string;
}

type FieldResult = {
  ok: boolean;
  filled: boolean;
  reason?: WithdrawalPasswordSetupResult["reason"];
  diag?: string;
};

async function activateFirstWithdrawalPasswordField(spa: SpaHandle): Promise<FieldResult> {
  const isReady = () => spa.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = globalThis.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 8 && rect.height > 8;
    };
    const fields = Array.from(globalThis.document.querySelectorAll<HTMLElement>(".ui-password-input"))
      .filter((element): element is HTMLElement => visible(element));
    const keyboard = Array.from(globalThis.document.querySelectorAll<HTMLElement>(".ui-number-keyboard"))
      .find((element) => visible(element));
    return fields.length === 2 && Boolean(keyboard && visible(keyboard)) && Boolean(
      fields[0]?.querySelector(".ui-password-input__item--focus")
    );
  }, undefined, PATCHRIGHT_MAIN_WORLD).catch(() => false);

  if (await isReady()) return { ok: true, filled: false };

  const firstCell = spa
    .locator(".ui-password-input")
    .first()
    .locator(".ui-password-input__item")
    .first();
  const tapped = await firstCell.tap({ timeout: 1500 }).then(() => true).catch(() => false);
  if (!tapped) {
    return { ok: false, filled: false, reason: "field-not-focused", diag: "first-field-tap-failed" };
  }

  const deadline = Date.now() + 1800;
  while (Date.now() < deadline) {
    if (await isReady()) return { ok: true, filled: false };
    await spa.waitForTimeout(80).catch(() => undefined);
  }
  return { ok: false, filled: false, reason: "field-not-focused", diag: "first-field-focus-or-keyboard-not-confirmed" };
}

async function fillFocusedField(
  spa: SpaHandle,
  expectedFieldIndex: number,
  password: string,
): Promise<FieldResult> {
  const readState = () => spa.evaluate(
    (): { ok: boolean; activeIndex: number; filledCounts: number[]; reason?: FieldResult["reason"]; diag?: string } => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = globalThis.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 8 && rect.height > 8;
      };
      const fields = Array.from(globalThis.document.querySelectorAll<HTMLElement>(".ui-password-input"))
        .filter((element): element is HTMLElement => visible(element));
      const keyboard = Array.from(globalThis.document.querySelectorAll<HTMLElement>(".ui-number-keyboard"))
        .find((element) => visible(element));
      if (!keyboard || !visible(keyboard) || fields.length !== 2) {
        return { ok: false, activeIndex: -1, filledCounts: [], reason: "surface-invalid", diag: `fields=${fields.length} keyboard=${Boolean(keyboard)}` };
      }
      const cells = fields.map((field) => Array.from(field.querySelectorAll<HTMLElement>(".ui-password-input__item")));
      if (cells.some((items) => items.length !== 6)) {
        return { ok: false, activeIndex: -1, filledCounts: [], reason: "surface-invalid", diag: `cells=${cells.map((items) => items.length).join(",")}` };
      }
      const filledCount = (items: HTMLElement[]) => items.filter((item) => {
        if (item.textContent?.trim()) return true;
        const marker = item.querySelector<HTMLElement>("i");
        return Boolean(marker && globalThis.getComputedStyle(marker).visibility !== "hidden");
      }).length;
      const activeIndex = cells.findIndex((items) => items.some((item) => item.classList.contains("ui-password-input__item--focus")));
      return { ok: true, activeIndex, filledCounts: cells.map(filledCount) };
    },
    PATCHRIGHT_MAIN_WORLD,
  ).catch((error): { ok: false; activeIndex: number; filledCounts: number[]; reason: "surface-invalid"; diag: string } => ({
    ok: false, activeIndex: -1, filledCounts: [], reason: "surface-invalid", diag: String(error)
  }));

  const dispatchDigit = (digit: string, identifier: number) => spa.evaluate(
    ({ digit, identifier }): FieldResult => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = globalThis.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 8 && rect.height > 8;
      };
      const keyboard = Array.from(globalThis.document.querySelectorAll<HTMLElement>(".ui-number-keyboard"))
        .find((element) => visible(element));
      if (!keyboard) return { ok: false, filled: false, reason: "surface-invalid", diag: "visible-keyboard-absent" };
      const key = Array.from(keyboard.querySelectorAll<HTMLElement>(".ui-number-keyboard-key__wrapper"))
        .find((element) => element.textContent?.trim() === digit);
      if (!key) return { ok: false, filled: false, reason: "surface-invalid", diag: `digit-key=${digit}` };
      const rect = key.getBoundingClientRect();
      const touch = new Touch({ identifier, target: key, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
      key.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
      key.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [touch] }));
      return { ok: true, filled: false };
    },
    { digit, identifier },
    PATCHRIGHT_MAIN_WORLD,
  ).catch((error): FieldResult => ({ ok: false, filled: false, reason: "surface-invalid", diag: String(error) }));

  for (let digitIndex = 0; digitIndex < password.length; digitIndex += 1) {
    const before = await readState();
    if (!before.ok) return { ok: false, filled: false, reason: before.reason, diag: before.diag };
    if (before.activeIndex !== expectedFieldIndex) {
      return { ok: false, filled: false, reason: "field-not-focused", diag: `active=${before.activeIndex} expected=${expectedFieldIndex}` };
    }
    if (before.filledCounts[expectedFieldIndex] !== digitIndex) {
      return { ok: false, filled: false, reason: "field-partially-filled", diag: `filled=${before.filledCounts[expectedFieldIndex]} expected=${digitIndex}` };
    }

    const dispatched = await dispatchDigit(password[digitIndex]!, digitIndex + 1);
    if (!dispatched.ok) return dispatched;

    const deadline = Date.now() + 1800;
    let accepted = false;
    while (Date.now() < deadline) {
      const after = await readState();
      if (!after.ok) return { ok: false, filled: false, reason: after.reason, diag: after.diag };
      if (after.filledCounts[expectedFieldIndex] === digitIndex + 1) {
        accepted = true;
        break;
      }
      await spa.waitForTimeout(80).catch(() => undefined);
    }
    if (!accepted) return { ok: false, filled: false, reason: "digit-unconfirmed", diag: `digit-index=${digitIndex}` };
  }

  return { ok: true, filled: true };
}

export async function fillWithdrawalPasswordSetup(
  spa: SpaHandle,
  password: string,
  onStage: (stage: WithdrawalPasswordSetupStage) => Promise<void>,
): Promise<WithdrawalPasswordSetupResult> {
  if (!/^\d{6}$/.test(password)) {
    return { ok: false, firstFieldFilled: false, secondFieldFilled: false, reason: "surface-invalid", diag: "password-format" };
  }
  const activation = await activateFirstWithdrawalPasswordField(spa);
  if (!activation.ok) {
    return { ok: false, firstFieldFilled: false, secondFieldFilled: false, reason: activation.reason, diag: activation.diag };
  }
  const first = await fillFocusedField(spa, 0, password);
  if (!first.ok) return { ok: false, firstFieldFilled: false, secondFieldFilled: false, reason: first.reason, diag: first.diag };
  await onStage("first-field-filled");
  const second = await fillFocusedField(spa, 1, password);
  if (!second.ok) return { ok: false, firstFieldFilled: true, secondFieldFilled: false, reason: second.reason, diag: second.diag };
  await onStage("second-field-filled");
  return { ok: true, firstFieldFilled: true, secondFieldFilled: true };
}

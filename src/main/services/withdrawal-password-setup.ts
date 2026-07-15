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
    const keyboard = globalThis.document.querySelector<HTMLElement>(".ui-number-keyboard");
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
  return spa.evaluate(
    ({ expectedFieldIndex, password }): FieldResult => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = globalThis.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 8 && rect.height > 8;
      };
      const fields = Array.from(globalThis.document.querySelectorAll<HTMLElement>(".ui-password-input"))
        .filter((element): element is HTMLElement => visible(element));
      const keyboard = globalThis.document.querySelector<HTMLElement>(".ui-number-keyboard");
      if (!keyboard || !visible(keyboard) || fields.length !== 2) {
        return { ok: false, filled: false, reason: "surface-invalid", diag: `fields=${fields.length} keyboard=${Boolean(keyboard)}` };
      }
      const cells = fields.map((field) => Array.from(field.querySelectorAll<HTMLElement>(".ui-password-input__item")));
      if (cells.some((items) => items.length !== 6)) {
        return { ok: false, filled: false, reason: "surface-invalid", diag: `cells=${cells.map((items) => items.length).join(",")}` };
      }
      const filledCount = (items: HTMLElement[]) => items.filter((item) => {
        if (item.textContent?.trim()) return true;
        const marker = item.querySelector<HTMLElement>("i");
        return Boolean(marker && globalThis.getComputedStyle(marker).visibility !== "hidden");
      }).length;
      const activeIndex = cells.findIndex((items) => items.some((item) => item.classList.contains("ui-password-input__item--focus")));
      if (activeIndex !== expectedFieldIndex) {
        return { ok: false, filled: false, reason: "field-not-focused", diag: `active=${activeIndex} expected=${expectedFieldIndex}` };
      }
      if (filledCount(cells[expectedFieldIndex]!) !== 0) {
        return { ok: false, filled: false, reason: "field-partially-filled" };
      }
      for (let digitIndex = 0; digitIndex < password.length; digitIndex += 1) {
        const digit = password[digitIndex]!;
        const key = Array.from(keyboard.querySelectorAll<HTMLElement>(".ui-number-keyboard-key__wrapper"))
          .find((element) => element.textContent?.trim() === digit);
        if (!key) return { ok: false, filled: false, reason: "surface-invalid", diag: `digit-key=${digit}` };
        const rect = key.getBoundingClientRect();
        const touch = new Touch({ identifier: 1, target: key, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
        key.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
        if (filledCount(cells[expectedFieldIndex]!) < digitIndex + 1) {
          return { ok: false, filled: false, reason: "digit-unconfirmed" };
        }
      }
      return { ok: filledCount(cells[expectedFieldIndex]!) === 6, filled: filledCount(cells[expectedFieldIndex]!) === 6 };
    },
    { expectedFieldIndex, password },
    PATCHRIGHT_MAIN_WORLD,
  ).catch((error): FieldResult => ({ ok: false, filled: false, reason: "surface-invalid", diag: String(error) }));
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

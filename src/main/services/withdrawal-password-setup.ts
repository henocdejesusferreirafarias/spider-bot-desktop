import type { SpaHandle } from "./spa-navigation.js";

// O terceiro argumento de `evaluate` e `isolatedContext`: `false` executa no
// contexto principal, onde o componente Vue e o teclado virtual realmente vivem.
const WITHDRAWAL_PASSWORD_MAIN_WORLD = false;

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
  }, undefined, WITHDRAWAL_PASSWORD_MAIN_WORLD).catch(() => false);

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
  // Uma transacao por PIN, deliberadamente igual ao probe que funcionou no
  // DevTools. Separar cada tecla em varios evaluate() cruzava mundos/turnos do
  // Vue e fazia o segundo campo perder a continuidade do teclado virtual.
  return spa.evaluate(
    async ({ expectedFieldIndex: fieldIndex, password: pin }): Promise<FieldResult> => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = globalThis.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 8 && rect.height > 8;
      };
      const fields = Array.from(globalThis.document.querySelectorAll<HTMLElement>(".ui-password-input"))
        .filter((element): element is HTMLElement => visible(element));
      const keyboards = Array.from(globalThis.document.querySelectorAll<HTMLElement>(".ui-number-keyboard"));
      const keyboardIndex = keyboards.findIndex((element) => visible(element));
      const field = fields[fieldIndex];
      if (!field || fields.length !== 2 || keyboards.length === 0) {
        return { ok: false, filled: false, reason: "surface-invalid", diag: `fields=${fields.length} keyboards=${keyboards.length} visibleKeyboard=${keyboardIndex} field=${fieldIndex}` };
      }
      const cells = Array.from(field.querySelectorAll<HTMLElement>(".ui-password-input__item"));
      if (cells.length !== pin.length) {
        return { ok: false, filled: false, reason: "surface-invalid", diag: `field=${fieldIndex} cells=${cells.length}` };
      }
      const filledCount = () => cells.filter((item) => {
        if (item.textContent?.trim()) return true;
        const marker = item.querySelector<HTMLElement>("i");
        return Boolean(marker && globalThis.getComputedStyle(marker).visibility !== "hidden");
      }).length;
      if (filledCount() !== 0) {
        return { ok: false, filled: false, reason: "field-partially-filled", diag: `field=${fieldIndex} filled=${filledCount()}` };
      }
      const focusedFieldIndex = fields.findIndex((candidate) => Boolean(candidate.querySelector(".ui-password-input__item--focus")));
      if (focusedFieldIndex !== fieldIndex) {
        return { ok: false, filled: false, reason: "field-not-focused", diag: `field=${fieldIndex} focused=${focusedFieldIndex}` };
      }

      let preferredKeyboardIndex: number | undefined;
      for (const [digitIndex, digit] of [...pin].entries()) {
        // Algumas skins mantem duas arvores do teclado: a visivel e uma clonada
        // (oculta) que conserva o listener Vue ativo. A visibilidade nao e um
        // criterio de autoridade; a unica confirmacao segura e a bolinha surgir.
        const orderedKeyboards = keyboards.map((keyboard, rootIndex) => ({ keyboard, rootIndex }));
        if (preferredKeyboardIndex !== undefined) {
          orderedKeyboards.sort((left, right) => Number(right.rootIndex === preferredKeyboardIndex) - Number(left.rootIndex === preferredKeyboardIndex));
        }
        const candidates = orderedKeyboards.flatMap(({ keyboard, rootIndex }) =>
          Array.from(keyboard.querySelectorAll<HTMLElement>(".ui-number-keyboard-key__wrapper"))
            .filter((element) => element.textContent?.trim() === digit)
            .map((key) => ({ key, rootIndex })),
        );
        if (candidates.length === 0) {
          return { ok: false, filled: false, reason: "surface-invalid", diag: `field=${fieldIndex} digit-key-absent keyboards=${keyboards.length}` };
        }
        const before = filledCount();
        const attempts: string[] = [];
        let accepted = false;
        for (const { key, rootIndex } of candidates) {
          const rect = key.getBoundingClientRect();
          const touch = new Touch({
            identifier: digitIndex + 1,
            target: key,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          });
          const startDispatched = key.dispatchEvent(new TouchEvent("touchstart", {
            bubbles: true,
            cancelable: true,
            touches: [touch],
            targetTouches: [touch],
            changedTouches: [touch],
          }));
          const endDispatched = key.dispatchEvent(new TouchEvent("touchend", {
            bubbles: true,
            cancelable: true,
            touches: [],
            targetTouches: [],
            changedTouches: [touch],
          }));
          await new Promise((resolve) => setTimeout(resolve, 180));
          const after = filledCount();
          attempts.push(`${rootIndex}:${startDispatched ? 1 : 0}/${endDispatched ? 1 : 0}:${after}`);
          if (after === before + 1) {
            preferredKeyboardIndex = rootIndex;
            accepted = true;
            break;
          }
          if (after !== before) {
            return {
              ok: false,
              filled: false,
              reason: "digit-unconfirmed",
              diag: `field=${fieldIndex} digit=${digitIndex} before=${before} after=${after} attempts=${attempts.join(",")}`,
            };
          }
        }
        if (!accepted) {
          return {
            ok: false,
            filled: false,
            reason: "digit-unconfirmed",
            diag: `field=${fieldIndex} digit=${digitIndex} before=${before} after=${filledCount()} focused=${fields.findIndex((candidate) => Boolean(candidate.querySelector(".ui-password-input__item--focus")))} keyboards=${keyboards.length} visibleKeyboard=${keyboardIndex} attempts=${attempts.join(",")}`,
          };
        }
      }
      return filledCount() === pin.length
        ? { ok: true, filled: true }
        : { ok: false, filled: false, reason: "digit-unconfirmed", diag: `field=${fieldIndex} final=${filledCount()}` };
    },
    { expectedFieldIndex, password },
    WITHDRAWAL_PASSWORD_MAIN_WORLD,
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

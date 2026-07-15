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

export interface WithdrawalPasswordEntryResult {
  ok: boolean;
  passwordEntered: boolean;
  reason?: WithdrawalPasswordSetupResult["reason"];
  diag?: string;
}

export interface WithdrawalPasswordConfirmationResult {
  ok: boolean;
  actionRejected?: boolean;
  reason?: "surface-invalid" | "confirm-action-absent" | "confirm-action-ambiguous" | "confirm-action-failed" | "destination-not-confirmed";
  diag?: string;
}

type FieldResult = {
  ok: boolean;
  filled: boolean;
  reason?: WithdrawalPasswordSetupResult["reason"];
  diag?: string;
};

type FieldReadiness = {
  ready: boolean;
  diag: string;
};

async function readWithdrawalPasswordFieldReadiness(
  spa: SpaHandle,
  expectedFieldCount: number,
): Promise<FieldReadiness> {
  return spa.evaluate((fieldCount: number) => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = globalThis.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 8 && rect.height > 8;
    };
    const fields = Array.from(globalThis.document.querySelectorAll<HTMLElement>(".ui-password-input"))
      .filter((element): element is HTMLElement => visible(element));
    const cells = fields.flatMap((field) => Array.from(
      field.querySelectorAll<HTMLElement>(".ui-password-input__item"),
    ));
    const filled = cells.filter((cell) => {
      if (cell.textContent?.trim()) return true;
      const marker = cell.querySelector<HTMLElement>("i");
      return Boolean(marker && globalThis.getComputedStyle(marker).visibility !== "hidden");
    }).length;
    const focused = cells.filter((cell) => cell.classList.contains("ui-password-input__item--focus")).length;
    const keyboards = Array.from(globalThis.document.querySelectorAll<HTMLElement>(".ui-number-keyboard"));
    const visibleKeyboards = keyboards.filter((element) => visible(element));
    const keyboardKeys = Math.max(
      0,
      ...visibleKeyboards.map((keyboard) => keyboard.querySelectorAll(".ui-number-keyboard-key__wrapper").length),
    );
    return {
      ready: fields.length === fieldCount && focused >= 1 && visibleKeyboards.length >= 1,
      diag: `fields=${fields.length} cells=${cells.length} filled=${filled} focused=${focused} keyboards=${keyboards.length} visibleKeyboards=${visibleKeyboards.length} keyboardKeys=${keyboardKeys}`,
    };
  }, expectedFieldCount, WITHDRAWAL_PASSWORD_MAIN_WORLD).catch(() => ({
    ready: false,
    diag: "readiness-evaluate-error",
  }));
}

async function activateFirstWithdrawalPasswordField(
  spa: SpaHandle,
  expectedFieldCount: number,
): Promise<FieldResult> {
  const initial = await readWithdrawalPasswordFieldReadiness(spa, expectedFieldCount);

  if (initial.ready) return { ok: true, filled: false };

  const firstCell = spa
    .locator(".ui-password-input")
    .first()
    .locator(".ui-password-input__item")
    .first();
  const tapped = await firstCell.tap({ timeout: 1500 }).then(() => true).catch(() => false);
  if (!tapped) {
    return { ok: false, filled: false, reason: "field-not-focused", diag: `first-field-tap-failed; ${initial.diag}` };
  }

  const deadline = Date.now() + 1800;
  while (Date.now() < deadline) {
    if ((await readWithdrawalPasswordFieldReadiness(spa, expectedFieldCount)).ready) {
      return { ok: true, filled: false };
    }
    await spa.waitForTimeout(80).catch(() => undefined);
  }
  const latest = await readWithdrawalPasswordFieldReadiness(spa, expectedFieldCount);
  return {
    ok: false,
    filled: false,
    reason: "field-not-focused",
    diag: `first-field-focus-or-keyboard-not-confirmed; ${latest.diag}`,
  };
}

async function fillFocusedField(
  spa: SpaHandle,
  expectedFieldIndex: number,
  password: string,
  expectedFieldCount: number,
): Promise<FieldResult> {
  // Uma transacao por PIN, deliberadamente igual ao probe que funcionou no
  // DevTools. Separar cada tecla em varios evaluate() cruzava mundos/turnos do
  // Vue e fazia o segundo campo perder a continuidade do teclado virtual.
  return spa.evaluate(
    async ({ expectedFieldIndex: fieldIndex, password: pin, expectedFieldCount }): Promise<FieldResult> => {
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
      if (!field || fields.length !== expectedFieldCount || keyboards.length === 0) {
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
    { expectedFieldIndex, password, expectedFieldCount },
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
  const activation = await activateFirstWithdrawalPasswordField(spa, 2);
  if (!activation.ok) {
    return { ok: false, firstFieldFilled: false, secondFieldFilled: false, reason: activation.reason, diag: activation.diag };
  }
  const first = await fillFocusedField(spa, 0, password, 2);
  if (!first.ok) return { ok: false, firstFieldFilled: false, secondFieldFilled: false, reason: first.reason, diag: first.diag };
  await onStage("first-field-filled");
  const second = await fillFocusedField(spa, 1, password, 2);
  if (!second.ok) return { ok: false, firstFieldFilled: true, secondFieldFilled: false, reason: second.reason, diag: second.diag };
  await onStage("second-field-filled");
  return { ok: true, firstFieldFilled: true, secondFieldFilled: true };
}

// Preenche somente o PIN solicitado pelo modal de inclusao de chave PIX. A
// proxima acao continua fora desta funcao para que o envio seja uma etapa
// verificavel e idempotente por si so.
export async function fillExistingWithdrawalPassword(
  spa: SpaHandle,
  password: string,
): Promise<WithdrawalPasswordEntryResult> {
  if (!/^\d{6}$/.test(password)) {
    return { ok: false, passwordEntered: false, reason: "surface-invalid", diag: "password-format" };
  }

  const activation = await activateFirstWithdrawalPasswordField(spa, 1);
  if (!activation.ok) {
    return { ok: false, passwordEntered: false, reason: activation.reason, diag: activation.diag };
  }

  const filled = await fillFocusedField(spa, 0, password, 1);
  return filled.ok
    ? { ok: true, passwordEntered: true }
    : { ok: false, passwordEntered: false, reason: filled.reason, diag: filled.diag };
}

// Confirma uma unica vez a tela de definicao ja preenchida. A persistencia na
// plataforma e deliberadamente confirmada pelo chamador, depois da transicao.
export async function confirmWithdrawalPasswordSetup(
  spa: SpaHandle,
): Promise<WithdrawalPasswordConfirmationResult> {
  return spa.evaluate(
    async (): Promise<WithdrawalPasswordConfirmationResult> => {
      type RecordLike = Record<PropertyKey, unknown>;
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = globalThis.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 8 && rect.height > 8;
      };
      const normalize = (value: string | null | undefined) => (value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      const fields = Array.from(globalThis.document.querySelectorAll<HTMLElement>(".ui-password-input"))
        .filter((element): element is HTMLElement => visible(element));
      const filledCount = (field: HTMLElement) => Array.from(
        field.querySelectorAll<HTMLElement>(".ui-password-input__item"),
      ).filter((item) => {
        if (item.textContent?.trim()) return true;
        const marker = item.querySelector<HTMLElement>("i");
        return Boolean(marker && globalThis.getComputedStyle(marker).visibility !== "hidden");
      }).length;
      if (
        fields.length !== 2 ||
        fields.some((field) => field.querySelectorAll(".ui-password-input__item").length !== 6) ||
        fields.some((field) => filledCount(field) !== 6)
      ) {
        return {
          ok: false,
          reason: "surface-invalid",
          diag: `fields=${fields.length} filled=${fields.map(filledCount).join(",")}`,
        };
      }

      const controls = Array.from(globalThis.document.querySelectorAll<HTMLElement>(
        "button,[role='button'],.ui-button,input[type='submit'],div,span",
      )).filter((element) => {
        if (!visible(element)) return false;
        const label = normalize(element.getAttribute("aria-label") || element.textContent);
        return label === "confirmar" || label === "confirm";
      });
      // Um botao costuma ter wrappers com o mesmo texto. Conservamos somente os
      // nos-folha; dois controles independentes continuam sendo ambiguidade.
      const leafControls = controls.filter((candidate) => !controls.some((other) =>
        other !== candidate && candidate.contains(other),
      ));
      if (leafControls.length === 0) {
        return { ok: false, reason: "confirm-action-absent", diag: "controls=0" };
      }
      if (leafControls.length !== 1) {
        return { ok: false, reason: "confirm-action-ambiguous", diag: `controls=${leafControls.length}` };
      }

      const control = leafControls[0]!;
      const record = (value: unknown): RecordLike | undefined => (
        value && (typeof value === "object" || typeof value === "function") ? value as RecordLike : undefined
      );
      const component = record((control as unknown as { __vueParentComponent?: unknown }).__vueParentComponent);
      const vnode = record(component?.vnode);
      const props = [record(component?.props), record(vnode?.props)].filter(
        (value): value is RecordLike => Boolean(value),
      );
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true });
      for (const propSet of props) {
        const listener = propSet.onClick ?? propSet.onclick;
        if (typeof listener !== "function") continue;
        try {
          await Reflect.apply(listener, propSet, [event]);
          return { ok: true };
        } catch (error) {
          return { ok: true, actionRejected: true, diag: `action-rejected=${String(error).length > 0}` };
        }
      }
      try {
        control.dispatchEvent(event);
        return { ok: true };
      } catch (error) {
        return { ok: true, actionRejected: true, diag: `action-rejected=${String(error).length > 0}` };
      }
    },
    undefined,
    WITHDRAWAL_PASSWORD_MAIN_WORLD,
  ).catch((error): WithdrawalPasswordConfirmationResult => ({
    ok: false,
    reason: "surface-invalid",
    diag: String(error),
  }));
}

export async function confirmAndVerifyWithdrawalPasswordSetup(
  spa: SpaHandle,
  waitForDestination: () => Promise<"needs_withdrawal_password" | "withdrawal_ready" | "unknown">,
): Promise<WithdrawalPasswordConfirmationResult> {
  const confirmation = await confirmWithdrawalPasswordSetup(spa);
  if (!confirmation.ok) return confirmation;

  try {
    const destination = await waitForDestination();
    if (destination === "withdrawal_ready") return { ok: true };
    return { ok: false, reason: "destination-not-confirmed", diag: `destination=${destination}` };
  } catch (error) {
    return { ok: false, reason: "destination-not-confirmed", diag: `wait-error=${String(error)}` };
  }
}

import { programmaticPixUiAction, type SpaHandle } from "./spa-navigation.js";

export interface PixPhoneInputDescriptor {
  index: number;
  precedesSelector: boolean;
  followsSelector: boolean;
  writable: boolean;
}

export function normalizePixDigits(value: string): string {
  return value.replace(/\D/g, "");
}

export function normalizePixIdentity(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function resolvePixPhoneFormRoles(
  inputs: PixPhoneInputDescriptor[],
): { nameIndex?: number; phoneIndex?: number; cpfIndex?: number } {
  const name = inputs.filter((input) => input.precedesSelector).at(-1);
  const followingWritable = inputs.filter((input) => input.followsSelector && input.writable);
  return {
    nameIndex: name?.index,
    phoneIndex: followingWritable[0]?.index,
    cpfIndex: followingWritable[1]?.index,
  };
}

export interface PixPhoneFormData {
  realName: string;
  phoneNumber: string;
  cpf: string;
}

export interface PixPhoneFormFillResult {
  ok: boolean;
  nameMode?: "filled" | "validated-disabled";
  reason?: "surface-invalid" | "phone-type-not-confirmed" | "name-mismatch" | "field-not-writable" | "field-not-confirmed";
  diag?: string;
}

export async function fillPixPhoneAddForm(
  surface: SpaHandle,
  data: PixPhoneFormData,
): Promise<PixPhoneFormFillResult> {
  const phoneDigits = normalizePixDigits(data.phoneNumber);
  const cpfDigits = normalizePixDigits(data.cpf);
  if (!data.realName.trim() || phoneDigits.length < 10 || cpfDigits.length !== 11) {
    return { ok: false, reason: "surface-invalid", diag: "profile-data-invalid" };
  }

  const phoneType = await programmaticPixUiAction(surface, "selectPhone");
  if (!phoneType.ok) {
    return {
      ok: false,
      reason: "phone-type-not-confirmed",
      diag: phoneType.reason ?? "select-phone-failed",
    };
  }

  return surface.evaluate(async (input: PixPhoneFormData): Promise<PixPhoneFormFillResult> => {
    type RecordLike = Record<PropertyKey, unknown>;
    const runtime = globalThis as unknown as {
      Event?: new (type: string, init?: { bubbles?: boolean }) => Event;
      HTMLInputElement?: { prototype: object };
      document: { querySelectorAll: (selector: string) => NodeListOf<HTMLElement> };
      getComputedStyle: (element: Element) => CSSStyleDeclaration;
    };
    const normalize = (value: string | null | undefined) => (value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const digits = (value: string | null | undefined) => (value ?? "").replace(/\D/g, "");
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = runtime.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 8 && rect.height > 8;
    };
    const record = (value: unknown): RecordLike | undefined => (
      value && (typeof value === "object" || typeof value === "function") ? value as RecordLike : undefined
    );
    const dialogs = Array.from(runtime.document.querySelectorAll(".ui-popup.ui-dialog"))
      .filter((dialog) => visible(dialog) && normalize(dialog.textContent).includes("pix"));
    const pins = Array.from(runtime.document.querySelectorAll(".ui-password-input")).filter(visible);
    const keyboards = Array.from(runtime.document.querySelectorAll(".ui-number-keyboard")).filter(visible);
    const form = dialogs.length === 1 && pins.length === 0 && keyboards.length === 0 ? dialogs[0] : undefined;
    if (!form) return { ok: false, reason: "surface-invalid", diag: "modal=0-or-ambiguous" };

    const selector = form.querySelector<HTMLElement>(".ui-select__reference");
    if (!selector || normalize(selector.textContent) !== "phone") {
      return { ok: false, reason: "phone-type-not-confirmed", diag: "type=not-phone" };
    }
    const inputs = Array.from(form.querySelectorAll<HTMLInputElement>("input")).filter(visible);
    if (inputs.length !== 3) return { ok: false, reason: "surface-invalid", diag: `inputs=${inputs.length}` };
    const [nameInput, phoneInput, cpfInput] = inputs;
    if (!nameInput || !phoneInput || !cpfInput || phoneInput.disabled || phoneInput.readOnly || cpfInput.disabled || cpfInput.readOnly) {
      return { ok: false, reason: "field-not-writable", diag: "phone-or-cpf-readonly" };
    }

    const setValue = (field: HTMLInputElement, value: string) => {
      const component = record((field as unknown as { __vueParentComponent?: unknown }).__vueParentComponent);
      const vnode = record(component?.vnode);
      const propSets = [record(component?.props), record(vnode?.props)].filter((props): props is RecordLike => Boolean(props));
      for (const props of propSets) {
        const update = props["onUpdate:modelValue"] ?? props.onUpdateModelValue;
        if (typeof update === "function") {
          Reflect.apply(update, props, [value]);
          break;
        }
      }
      if (field.value !== value) {
        const setter = runtime.HTMLInputElement
          ? Object.getOwnPropertyDescriptor(runtime.HTMLInputElement.prototype, "value")?.set
          : undefined;
        if (setter) setter.call(field, value);
        else field.value = value;
        if (runtime.Event) {
          field.dispatchEvent(new runtime.Event("input", { bubbles: true }));
          field.dispatchEvent(new runtime.Event("change", { bubbles: true }));
        }
      }
    };

    let nameMode: PixPhoneFormFillResult["nameMode"];
    if (nameInput.disabled || nameInput.readOnly) {
      if (normalize(nameInput.value) !== normalize(input.realName)) {
        return { ok: false, reason: "name-mismatch", diag: "name=disabled-mismatch" };
      }
      nameMode = "validated-disabled";
    } else {
      if (nameInput.value.trim() && normalize(nameInput.value) !== normalize(input.realName)) {
        return { ok: false, reason: "name-mismatch", diag: "name=editable-mismatch" };
      }
      if (!nameInput.value.trim()) setValue(nameInput, input.realName);
      if (normalize(nameInput.value) !== normalize(input.realName)) {
        return { ok: false, reason: "field-not-confirmed", diag: "field=name" };
      }
      nameMode = "filled";
    }

    setValue(phoneInput, input.phoneNumber);
    if (digits(phoneInput.value) !== digits(input.phoneNumber)) {
      return { ok: false, reason: "field-not-confirmed", diag: "field=phone" };
    }
    setValue(cpfInput, input.cpf);
    if (digits(cpfInput.value) !== digits(input.cpf)) {
      return { ok: false, reason: "field-not-confirmed", diag: "field=cpf" };
    }
    return { ok: true, nameMode };
  }, data, false).catch(() => ({ ok: false, reason: "surface-invalid", diag: "evaluate-error" }));
}

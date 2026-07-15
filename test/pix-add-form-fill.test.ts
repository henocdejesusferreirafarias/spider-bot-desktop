import assert from "node:assert/strict";
import test from "node:test";
import {
  fillPixPhoneAddForm,
  normalizePixDigits,
  normalizePixIdentity,
  resolvePixPhoneFormRoles,
} from "../src/main/services/pix-add-form-fill.js";
import type { PixPhoneFormData, PixPhoneFormFillResult } from "../src/main/services/pix-add-form-fill.js";
import type { SpaHandle } from "../src/main/services/spa-navigation.js";

interface FakeInput {
  disabled: boolean;
  readOnly: boolean;
  value: string;
  getBoundingClientRect: () => { width: number; height: number };
  dispatchEvent: (event: unknown) => boolean;
}

interface FakePixSurface {
  surface: SpaHandle;
  selector: { textContent: string; dispatchEvent: (event: unknown) => boolean };
  name: FakeInput;
  phone: FakeInput;
  cpf: FakeInput;
  submitClicks: () => number;
  restore: () => void;
}

function fakePixSurface(options: { name: string; nameDisabled: boolean }): FakePixSurface {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  const install = (key: string, value: unknown) => {
    saved.set(key, globals[key]);
    globals[key] = value;
  };
  const restore = () => {
    for (const [key, value] of saved) globals[key] = value;
  };
  const visible = () => ({ width: 100, height: 40 });
  const input = (value: string, disabled = false): FakeInput => ({
    disabled,
    readOnly: false,
    value,
    getBoundingClientRect: visible,
    dispatchEvent: () => true,
  });
  const name = input(options.name, options.nameDisabled);
  const phone = input("");
  const cpf = input("");
  let pixType = "CPF";
  let menuOpen = false;
  let submits = 0;
  const selector = {
    get textContent() { return pixType; },
    dispatchEvent: () => { menuOpen = true; return true; },
  };
  const phoneOption = {
    textContent: "PHONE",
    getBoundingClientRect: visible,
    dispatchEvent: () => { pixType = "PHONE"; menuOpen = false; return true; },
  };
  const modal = {
    textContent: "Adicionar PIX",
    getBoundingClientRect: visible,
    querySelector: (query: string) => query === ".ui-select__reference" ? selector : null,
    querySelectorAll: (query: string) => {
      if (query === "input") return pixType === "PHONE" ? [name, phone, cpf] : [name, cpf];
      if (query === ".ui-button") return [{ dispatchEvent: () => { submits += 1; return true; } }];
      return [];
    },
  };
  install("getComputedStyle", () => ({ display: "block", visibility: "visible" }));
  install("MouseEvent", class { constructor(_type: string, _init?: unknown) {} });
  install("document", {
    querySelectorAll: (query: string) => {
      if (query === ".ui-popup.ui-dialog") return [modal];
      if (query === ".ui-password-input" || query === ".ui-number-keyboard") return [];
      if (query === ".ui-options__option,[role='option']") return menuOpen ? [phoneOption] : [];
      return [];
    },
  });
  const surface = {
    evaluate: async (
      callback: (data: PixPhoneFormData) => Promise<PixPhoneFormFillResult>,
      data: PixPhoneFormData | "selectPhone",
    ) => {
      if (data === "selectPhone") {
        pixType = "PHONE";
        return { ok: true, action: "selectPhone" };
      }
      return callback(data);
    },
  } as unknown as SpaHandle;
  return { surface, selector, name, phone, cpf, submitClicks: () => submits, restore };
}

test("PIX PHONE roles resolve nome antes e telefone e CPF depois do seletor", () => {
  assert.deepEqual(resolvePixPhoneFormRoles([
    { index: 0, precedesSelector: true, followsSelector: false, writable: true },
    { index: 1, precedesSelector: false, followsSelector: true, writable: true },
    { index: 2, precedesSelector: false, followsSelector: true, writable: true },
  ]), { nameIndex: 0, phoneIndex: 1, cpfIndex: 2 });
});

test("normaliza telefone e CPF somente por digitos", () => {
  assert.equal(normalizePixDigits("(11) 98888-7777"), "11988887777");
  assert.equal(normalizePixDigits("123.456.789-01"), "12345678901");
});

test("normaliza identidade sem diferenciar acento, espaco ou caixa", () => {
  assert.equal(
    normalizePixIdentity("Eduardo Vargas Pinto"),
    normalizePixIdentity("  eduardo  várgas  pinto "),
  );
});

test("seleciona PHONE no modal vivo e preenche sem submeter", async () => {
  const fake = fakePixSurface({ name: "", nameDisabled: false });
  try {
    const result = await fillPixPhoneAddForm(fake.surface, {
      realName: "Eduardo Vargas Pinto",
      phoneNumber: "(11) 98888-7777",
      cpf: "123.456.789-01",
    });

    assert.deepEqual(result, { ok: true, nameMode: "filled" });
    assert.equal(fake.selector.textContent, "PHONE");
    assert.equal(fake.name.value, "Eduardo Vargas Pinto");
    assert.equal(fake.phone.value, "(11) 98888-7777");
    assert.equal(fake.cpf.value, "123.456.789-01");
    assert.equal(fake.submitClicks(), 0);
  } finally {
    fake.restore();
  }
});

test("valida o nome bloqueado antes de preencher os dados PIX", async () => {
  const fake = fakePixSurface({ name: "Eduardo Vargas Pinto", nameDisabled: true });
  try {
    const result = await fillPixPhoneAddForm(fake.surface, {
      realName: " eduardo  várgas pinto ",
      phoneNumber: "11988887777",
      cpf: "12345678901",
    });

    assert.deepEqual(result, { ok: true, nameMode: "validated-disabled" });
    assert.equal(fake.name.value, "Eduardo Vargas Pinto");
    assert.equal(fake.phone.value, "11988887777");
    assert.equal(fake.cpf.value, "12345678901");
    assert.equal(fake.submitClicks(), 0);
  } finally {
    fake.restore();
  }
});

test("recusa nome bloqueado divergente sem preencher telefone ou CPF", async () => {
  const fake = fakePixSurface({ name: "Outro titular", nameDisabled: true });
  try {
    const result = await fillPixPhoneAddForm(fake.surface, {
      realName: "Eduardo Vargas Pinto",
      phoneNumber: "11988887777",
      cpf: "12345678901",
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "name-mismatch");
    assert.equal(fake.phone.value, "");
    assert.equal(fake.cpf.value, "");
    assert.equal(fake.submitClicks(), 0);
  } finally {
    fake.restore();
  }
});

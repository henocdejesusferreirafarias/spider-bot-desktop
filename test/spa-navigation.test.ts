import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "patchright";
import {
  programmaticDeposit,
  programmaticPixUiAction,
  waitForSpaRouter
} from "../src/main/services/spa-navigation.js";

type VuexDepositHarness = {
  page: Page;
  sendPayCalls: () => number;
};

type PiniaDepositHarness = {
  openCalls: () => number;
  page: Page;
  submitCalls: () => number;
};

function withRuntimeDocument<T>(elements: unknown[], callback: () => T): T {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { querySelectorAll: () => elements }
  });
  try {
    return callback();
  } finally {
    if (originalDocument) {
      Object.defineProperty(globalThis, "document", originalDocument);
    } else {
      delete (globalThis as { document?: unknown }).document;
    }
  }
}

function createPiniaLazyDepositHarness(): PiniaDepositHarness {
  const emptyStores = new Map<string, Record<PropertyKey, unknown>>();
  const stores = new Map<string, Record<PropertyKey, unknown>>();
  let openCalls = 0;
  let submitCalls = 0;
  const qr = {
    info: {
      money: "43",
      orderNo: "old-order",
      qrCode: "old-pix-code"
    }
  };
  const rechargeForm = {
    activeChannelItem: { online: { id: 7 } },
    exchangeRateLoading: false,
    formModel: { online: { amount: "" } },
    pageLoading: false,
    submit(kind: string) {
      assert.equal(kind, "online");
      assert.equal(this.formModel.online.amount, "43");
      submitCalls += 1;
      // Esta variante so instancia a store de QR dentro da submissao.
      // O fluxo nao pode exigi-la antes de chamar submit().
      stores.set("recharge-qrcode", qr);
      qr.info = {
        money: "43",
        orderNo: `pinia-order-${submitCalls}`,
        qrCode: `pinia-pix-code-${submitCalls}`
      };
    },
    submitLoading: false
  };
  const dialog = {
    open(name: string, options: unknown) {
      openCalls += 1;
      assert.equal(name, "recharge");
      assert.deepEqual(options, { openType: "overlay" });
      stores.set("recharge-with-form", rechargeForm);
    }
  };
  stores.set("dialog", dialog);
  const emptyPinia = { _s: emptyStores };
  const realPinia = { _s: stores };
  const piniaSymbol = Symbol("pinia");
  const provides: Record<PropertyKey, unknown> = {};
  provides[piniaSymbol] = realPinia;
  const app = {
    _context: { provides },
    config: { globalProperties: { $pinia: emptyPinia } }
  };
  const element = { __vue_app__: app };
  const page = {
    evaluate: async (
      callback: (arg: { amount: string; timeoutMs: number }) => unknown,
      arg: { amount: string; timeoutMs: number }
    ) => withRuntimeDocument([element], () => callback(arg))
  } as unknown as Page;

  return {
    openCalls: () => openCalls,
    page,
    submitCalls: () => submitCalls
  };
}

function createPiniaWalletDepositHarness(): PiniaDepositHarness {
  const stores = new Map<string, Record<PropertyKey, unknown>>();
  let openCalls = 0;
  let submitCalls = 0;
  const qr = {
    info: {
      money: "46",
      orderNo: "old-wallet-order",
      qrCode: "old-wallet-code"
    }
  };
  const wallet = {
    activeChannelInfo: { isScoreMode: false },
    activeChannelItem: { channelId: 9, payCurrency: "BRL" },
    exchangeRateLoading: false,
    formModel: { amount: "" },
    pageLoading: false,
    submit() {
      assert.equal(this.formModel.amount, "46");
      submitCalls += 1;
      qr.info = {
        money: "46",
        orderNo: `wallet-order-${submitCalls}`,
        qrCode: `wallet-pix-code-${submitCalls}`
      };
    },
    submitLoading: false
  };
  const dialog = {
    open(name: string, options: unknown) {
      openCalls += 1;
      assert.equal(name, "recharge");
      assert.deepEqual(options, { openType: "overlay" });
    }
  };
  stores.set("dialog", dialog);
  stores.set("recharge-wallet", wallet);
  stores.set("recharge-qrcode", qr);
  const app = {
    config: { globalProperties: { $pinia: { _s: stores } } }
  };
  const element = { __vue_app__: app };
  const page = {
    evaluate: async (
      callback: (arg: { amount: string; timeoutMs: number }) => unknown,
      arg: { amount: string; timeoutMs: number }
    ) => withRuntimeDocument([element], () => callback(arg))
  } as unknown as Page;

  return {
    openCalls: () => openCalls,
    page,
    submitCalls: () => submitCalls
  };
}

function createVuexDepositHarness(payWayEventSubmits: boolean): VuexDepositHarness {
  const storage = new Map<string, string>([
    ["szOrderInfo", JSON.stringify({ orderid: "old-order", qrcode: "old-code" })]
  ]);
  const config = {
    depositeIsShow: false,
    rechargeLink: "",
    walletShow: { active: 0 }
  };
  let calls = 0;
  const createOrder = () => {
    calls += 1;
    const order = {
      order3rd: `merchant-${calls}`,
      orderid: `new-order-${calls}`,
      qrcode: `pix-code-${calls}`
    };
    storage.set("rechargeNumber", "43");
    storage.set("szOrderInfo", JSON.stringify(order));
    config.rechargeLink = `https://payment.example/${calls}`;
    config.depositeIsShow = true;
  };
  const methods = payWayEventSubmits
    ? {
        payWayEvent(this: { payInfo?: Record<string, unknown>; sendPay: () => void }, _index: number) {
          this.payInfo = { amount: 43, channelID: 7 };
          this.sendPay();
        }
      }
    : {
        payWayEvent(this: { payInfo?: Record<string, unknown> }, _index: number) {
          this.payInfo = { amount: 43, channelID: 7 };
        }
      };
  const wallet = {
    $options: { methods, name: "Wallet" },
    payInfo: undefined as Record<string, unknown> | undefined,
    payWayEvent: methods.payWayEvent,
    rechargeNumber: 0,
    rechargeNumberChange() {
      this.rechargeNumber = Math.floor(this.rechargeNumber);
    },
    sendPay: createOrder
  };
  const store = {
    commit: () => undefined,
    state: { config }
  };
  const root = {
    $children: [wallet],
    $store: store
  };
  const element = {
    __vue__: { $root: root }
  };
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const page = {
    evaluate: async (
      callback: (arg: { amount: string; timeoutMs: number }) => unknown,
      arg: { amount: string; timeoutMs: number }
    ) => {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
          getItem: (key: string) => storage.get(key) ?? null
        }
      });
      try {
        return await withRuntimeDocument([element], () => callback(arg));
      } finally {
        if (originalLocalStorage) {
          Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
        } else {
          delete (globalThis as { localStorage?: unknown }).localStorage;
        }
      }
    }
  } as unknown as Page;

  return {
    page,
    sendPayCalls: () => calls
  };
}

test("Pinia deposit allows the QR store to be created by submit", async () => {
  const harness = createPiniaLazyDepositHarness();

  const result = await programmaticDeposit(harness.page, "43", 100);

  assert.equal(result.ok, true);
  assert.equal(result.stack, "pinia");
  assert.equal(result.orderNo, "pinia-order-1");
  assert.equal(result.copiaECola, "pinia-pix-code-1");
  assert.equal(harness.openCalls(), 1);
  assert.equal(harness.submitCalls(), 1);
});

test("Pinia deposit supports recharge-wallet when recharge-with-form is absent", async () => {
  const harness = createPiniaWalletDepositHarness();

  const result = await programmaticDeposit(harness.page, "46", 100);

  assert.equal(result.ok, true);
  assert.equal(result.stack, "pinia");
  assert.equal(result.orderNo, "wallet-order-1");
  assert.equal(result.copiaECola, "wallet-pix-code-1");
  assert.equal(harness.openCalls(), 1);
  assert.equal(harness.submitCalls(), 1);
});

test("Vuex deposit does not call sendPay twice when payWayEvent already submits", async () => {
  const harness = createVuexDepositHarness(true);

  const result = await programmaticDeposit(harness.page, "43", 100);

  assert.equal(result.ok, true);
  assert.equal(result.stack, "vuex");
  assert.equal(result.orderNo, "new-order-1");
  assert.equal(harness.sendPayCalls(), 1);
});

test("Vuex deposit calls sendPay once when payWayEvent only prepares payInfo", async () => {
  const harness = createVuexDepositHarness(false);

  const result = await programmaticDeposit(harness.page, "43", 100);

  assert.equal(result.ok, true);
  assert.equal(result.stack, "vuex");
  assert.equal(result.orderNo, "new-order-1");
  assert.equal(harness.sendPayCalls(), 1);
});

test("PIX receiving tab is selected through the withdraw Pinia store", async () => {
  const withdraw = {
    tabsActive: 20,
    $patch(value: { tabsActive: number }) {
      this.tabsActive = value.tabsActive;
    }
  };
  const stores = new Map<string, Record<PropertyKey, unknown>>([["withdraw", withdraw]]);
  const element = {
    __vue_app__: { config: { globalProperties: { $pinia: { _s: stores } } } }
  };
  const page = {
    evaluate: async (callback: (action: "openReceivingAccount") => unknown, action: "openReceivingAccount") =>
      withRuntimeDocument([element], () => callback(action))
  } as unknown as Page;

  const result = await programmaticPixUiAction(page, "openReceivingAccount");

  assert.equal(result.ok, true);
  assert.equal(withdraw.tabsActive, 10);
});

test("PIX add modal invokes the Vue addAccountModal prop without a DOM click", async () => {
  let calls = 0;
  const pixData = { typeId: 5, typeName: "PIX" };
  const component = {
    parent: null,
    props: {
      addAccountModal(data: unknown) {
        assert.equal(data, pixData);
        calls += 1;
      },
      data: pixData
    }
  };
  const element = { __vueParentComponent: component };
  const page = {
    evaluate: async (callback: (action: "openAddPix") => unknown, action: "openAddPix") =>
      withRuntimeDocument([element], () => callback(action))
  } as unknown as Page;

  const result = await programmaticPixUiAction(page, "openAddPix");

  assert.equal(result.ok, true);
  assert.equal(calls, 1);
});

test("PIX add modal invokes Vue's production event listener when component expandos are absent", async () => {
  let calls = 0;
  const invoker = Object.assign(() => undefined, {
    value: () => {
      calls += 1;
    }
  });
  const vueEventMap = Symbol("_vei");
  const element = {
    [vueEventMap]: { onClick: invoker },
    getBoundingClientRect: () => ({ height: 44, width: 320 }),
    id: "addAccountClick",
    textContent: "PIX Adicionar"
  };
  const page = {
    evaluate: async (callback: (action: "openAddPix") => unknown, action: "openAddPix") =>
      withRuntimeDocument([element], () => callback(action))
  } as unknown as Page;

  const result = await programmaticPixUiAction(page, "openAddPix");

  assert.equal(result.ok, true);
  assert.match(result.diag ?? "", /vue-listener/);
  assert.equal(calls, 1);
});

test("PIX PHONE type is written through the Vue model update handler", async () => {
  let selectedType = "CPF";
  const selectComponent = {
    parent: null,
    props: {
      modelValue: "CPF",
      "onUpdate:modelValue": (value: string) => {
        selectedType = value;
      }
    }
  };
  const selectElement = { __vueParentComponent: selectComponent };
  const modalRoot = {
    closest: () => modalRoot,
    getBoundingClientRect: () => ({ height: 400, width: 300 }),
    querySelectorAll: () => [selectElement],
    textContent: "Adicionar PIX"
  };
  const page = {
    evaluate: async (callback: (action: "selectPhone") => unknown, action: "selectPhone") =>
      withRuntimeDocument([modalRoot, selectElement], () => callback(action))
  } as unknown as Page;

  const result = await programmaticPixUiAction(page, "selectPhone");

  assert.equal(result.ok, true);
  assert.equal(selectedType, "PHONE");
});

test("PIX PHONE type opens the production selector and chooses PHONE through touch handlers", async () => {
  let selectedType = "CPF";
  const vueEventMap = Symbol("_vei");
  const elements: Array<Record<PropertyKey, unknown>> = [];
  let touchStarted = false;
  const phoneStartInvoker = Object.assign(() => undefined, {
    value: () => {
      touchStarted = true;
    }
  });
  const phoneEndInvoker = Object.assign(() => undefined, {
    value: () => {
      assert.equal(touchStarted, true);
      selectedType = "PHONE";
      currentType.textContent = "PHONE";
    }
  });
  const phoneOption = {
    [vueEventMap]: {
      onTouchstart: phoneStartInvoker,
      onTouchend: phoneEndInvoker
    },
    getBoundingClientRect: () => ({ height: 40, width: 220 }),
    className: "ui-options__option",
    textContent: "PHONE"
  };
  const currentTypeInvoker = Object.assign(() => undefined, {
    value: () => {
      elements.push(phoneOption);
    }
  });
  const currentType = {
    [vueEventMap]: { onClick: currentTypeInvoker },
    className: "select-control",
    getBoundingClientRect: () => ({ height: 40, width: 220 }),
    textContent: "CPF"
  };
  const modalRoot = {
    closest: () => modalRoot,
    getBoundingClientRect: () => ({ height: 400, width: 300 }),
    querySelector: (selector: string) =>
      selector === ".ui-popover__wrapper" ? currentType : null,
    querySelectorAll: () => [currentType],
    textContent: "Adicionar PIX"
  };
  elements.push(modalRoot, currentType);
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const page = {
    evaluate: async (callback: (action: "selectPhone") => unknown, action: "selectPhone") => {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: { querySelectorAll: () => elements }
      });
      try {
        return await callback(action);
      } finally {
        if (originalDocument) {
          Object.defineProperty(globalThis, "document", originalDocument);
        } else {
          delete (globalThis as { document?: unknown }).document;
        }
      }
    }
  } as unknown as Page;

  const result = await programmaticPixUiAction(page, "selectPhone");

  assert.equal(result.ok, true);
  assert.match(result.diag ?? "", /vue-touch=PHONE/);
  assert.equal(selectedType, "PHONE");
});

test("PIX registration dispatches a synthetic click on the live confirm button", async () => {
  let submitted = false;
  const button = {
    dispatchEvent(event: { type?: string }) {
      assert.equal(event.type, "click");
      submitted = true;
      return true;
    },
    textContent: "Confirmar"
  };
  const modalRoot = {
    closest: () => modalRoot,
    getBoundingClientRect: () => ({ height: 400, width: 300 }),
    querySelector: (selector: string) =>
      selector === "#bindWithdrawAccountNextClick" ? button : null,
    querySelectorAll: () => [],
    textContent: "Adicionar PIX"
  };
  const page = {
    evaluate: async (callback: (action: "submit") => unknown, action: "submit") =>
      withRuntimeDocument([modalRoot], () => callback(action))
  } as unknown as Page;

  const result = await programmaticPixUiAction(page, "submit");

  assert.equal(result.ok, true);
  assert.match(result.diag ?? "", /dispatchEvent/);
  assert.equal(submitted, true);
});

test("PIX registration submits its form without pressing the confirm button", async () => {
  let submitCalls = 0;
  const form = {
    requestSubmit() {
      submitCalls += 1;
    }
  };
  const modalRoot = {
    closest: () => modalRoot,
    getBoundingClientRect: () => ({ height: 400, width: 300 }),
    querySelector: (selector: string) => selector === "form" ? form : null,
    querySelectorAll: () => [],
    textContent: "Adicionar PIX"
  };
  const page = {
    evaluate: async (callback: (action: "submit") => unknown, action: "submit") =>
      withRuntimeDocument([modalRoot], () => callback(action))
  } as unknown as Page;

  const result = await programmaticPixUiAction(page, "submit");

  assert.equal(result.ok, true);
  assert.equal(submitCalls, 1);
});

// waitForSpaRouter substitui os loops de probe inline (waitForTimeout fixo) por uma
// espera condicional no router acessivel. hasSpaRouter roda `spa.evaluate(fn, undefined,
// MAIN_WORLD)` e retorna Boolean(findRouter()); aqui fingimos apenas o retorno do evaluate.

test("waitForSpaRouter: retorna true assim que o router fica acessivel", async () => {
  let calls = 0;
  const spa = {
    // Router aparece so na 3a checagem: exercita o loop de polling.
    evaluate: async () => {
      calls += 1;
      return calls >= 3;
    }
  } as unknown as Page;

  const ready = await waitForSpaRouter(spa, 2000, 1);
  assert.equal(ready, true);
  assert.ok(calls >= 3);
});

test("waitForSpaRouter: retorna a checagem final (false) ao esgotar o teto, sem lancar", async () => {
  const spa = {
    evaluate: async () => false
  } as unknown as Page;

  const ready = await waitForSpaRouter(spa, 30, 1);
  assert.equal(ready, false);
});

test("waitForSpaRouter: evaluate que rejeita e tratado como router ausente (guard do catch)", async () => {
  const spa = {
    evaluate: async () => {
      throw new Error("frame detached");
    }
  } as unknown as Page;

  const ready = await waitForSpaRouter(spa, 30, 1);
  assert.equal(ready, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { SpaHandle } from "../src/main/services/spa-navigation.js";
import {
  confirmPixPhoneSubmission,
  inspectPixReceivingAccounts,
  type PixReceivingAccountSnapshot,
} from "../src/main/services/pix-phone-key-confirmation.js";

function snapshot(overrides: Partial<PixReceivingAccountSnapshot> = {}): PixReceivingAccountSnapshot {
  return {
    routeActive10: true,
    visiblePixFormModals: 1,
    sourceActions: 1,
    modalIndex: 0,
    buttonIndex: 0,
    accounts: [],
    hasError: false,
    ...overrides,
  };
}

function fakeSurface(states: PixReceivingAccountSnapshot[]) {
  let inspections = 0;
  let clicks = 0;
  const surface = {
    evaluate: async () => states[Math.min(inspections++, states.length - 1)]!,
    locator: () => ({
      nth: () => ({
        locator: () => ({
          nth: () => ({
            click: async () => { clicks += 1; },
          }),
        }),
      }),
    }),
    waitForTimeout: async () => undefined,
  } as unknown as SpaHandle;
  return { surface, clicks: () => clicks, inspections: () => inspections };
}

test("inspection returns structural account state without a full phone number", async () => {
  const fake = fakeSurface([
    snapshot({ accounts: [{ kind: "pix-phone", maskedPhone: "41***690" }] }),
  ]);

  const inspected = await inspectPixReceivingAccounts(fake.surface);

  assert.equal(inspected.accounts[0]?.maskedPhone, "41***690");
  assert.equal(inspected.visiblePixFormModals, 1);
});

test("confirmation waits for modal disappearance and a compatible PIX PHONE card", async () => {
  const fake = fakeSurface([
    snapshot(),
    snapshot(),
    snapshot({
      visiblePixFormModals: 0,
      sourceActions: 0,
      modalIndex: undefined,
      buttonIndex: undefined,
      accounts: [{ kind: "pix-phone", maskedPhone: "41***690" }],
    }),
  ]);

  const result = await confirmPixPhoneSubmission(fake.surface, "41980042690", 300);

  assert.equal(result.result, "confirmed");
  assert.equal(result.actionAttempted, true);
  assert.equal(fake.clicks(), 1);
});

test("confirmation makes one scoped click and leaves ambiguous output pending", async () => {
  const fake = fakeSurface([
    snapshot(),
    snapshot(),
    snapshot({
      visiblePixFormModals: 0,
      sourceActions: 0,
      modalIndex: undefined,
      buttonIndex: undefined,
    }),
  ]);

  const result = await confirmPixPhoneSubmission(fake.surface, "41980042690", 0);

  assert.equal(result.result, "pending");
  assert.equal(result.actionAttempted, true);
  assert.equal(fake.clicks(), 1);
});

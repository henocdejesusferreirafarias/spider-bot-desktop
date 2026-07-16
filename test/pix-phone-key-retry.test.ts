import assert from "node:assert/strict";
import test from "node:test";
import { retryRejectedPixPhoneKeys } from "../src/main/services/pix-phone-key-retry.js";

test("submete a proxima chave somente depois de uma recusa explicita", async () => {
  const attempted: string[] = [];
  const outcome = await retryRejectedPixPhoneKeys(
    "primeira",
    async (key) => {
      attempted.push(key);
      return key === "primeira" ? "rejected" : "confirmed";
    },
    () => "segunda"
  );

  assert.deepEqual(attempted, ["primeira", "segunda"]);
  assert.deepEqual(outcome, { key: "segunda", result: "confirmed", rejectedAttempts: 1 });
});

test("nao busca outra chave para pendencia ou conflito", async () => {
  let reserveCalls = 0;
  const outcome = await retryRejectedPixPhoneKeys("primeira", async () => "pending", () => {
    reserveCalls += 1;
    return "segunda";
  });

  assert.deepEqual(outcome, { key: "primeira", result: "pending", rejectedAttempts: 0 });
  assert.equal(reserveCalls, 0);
});

test("encerra quando uma recusa esgota o estoque", async () => {
  const outcome = await retryRejectedPixPhoneKeys("ultima", async () => "rejected", () => undefined);

  assert.deepEqual(outcome, { key: "ultima", result: "error", rejectedAttempts: 1 });
});

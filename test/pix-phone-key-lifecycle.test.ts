import assert from "node:assert/strict";
import test from "node:test";
import {
  decidePixPhonePreflight,
  matchesMaskedPixPhone,
  pixResultForPreflight,
} from "../src/main/services/pix-phone-key-lifecycle.js";

test("mask requires preserved prefix and suffix", () => {
  assert.equal(matchesMaskedPixPhone("41***690", "41980042690"), true);
  assert.equal(matchesMaskedPixPhone("41***690", "41980041690"), true);
  assert.equal(matchesMaskedPixPhone("4***90", "41980042690"), false);
});

test("clean profile with a manual PIX account never reserves inventory", () => {
  assert.equal(
    decidePixPhonePreflight({
      accounts: [{ kind: "pix-phone", maskedPhone: "41***690" }],
    }),
    "manual-account",
  );
});

test("pending key resolves as used, resume, or conflict", () => {
  assert.equal(
    decidePixPhonePreflight({
      pendingKeyId: "key-1",
      phoneNumber: "41980042690",
      accounts: [{ kind: "pix-phone", maskedPhone: "41***690" }],
    }),
    "pending-used",
  );
  assert.equal(
    decidePixPhonePreflight({ pendingKeyId: "key-1", phoneNumber: "41980042690", accounts: [] }),
    "resume-pending",
  );
  assert.equal(
    decidePixPhonePreflight({
      pendingKeyId: "key-1",
      phoneNumber: "41980042690",
      accounts: [{ kind: "pix-phone", maskedPhone: "55***123" }],
    }),
    "conflict",
  );
});

test("pending key with an insufficient mask remains pending for review", () => {
  assert.equal(
    decidePixPhonePreflight({
      pendingKeyId: "key-1",
      phoneNumber: "41980042690",
      accounts: [{ kind: "pix-phone", maskedPhone: "4***90" }],
    }),
    "insufficient-evidence",
  );
});

test("preflight maps manual, used pending, and conflict outcomes without a new reservation", () => {
  assert.deepEqual(pixResultForPreflight("manual-account"), {
    status: "pix_already_registered",
    reservation: "none",
  });
  assert.deepEqual(pixResultForPreflight("pending-used"), {
    status: "pix_key_registered",
    reservation: "consume-pending",
  });
  assert.deepEqual(pixResultForPreflight("conflict"), {
    status: "pix_key_conflict",
    reservation: "keep-pending",
  });
});

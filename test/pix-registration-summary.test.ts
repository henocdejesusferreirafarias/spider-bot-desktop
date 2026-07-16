import assert from "node:assert/strict";
import test from "node:test";
import type { PixKeyRegistrationControlResult } from "../src/shared/contracts.js";
import { summarizePixRegistrationResults } from "../src/renderer/lib/pix-registration-summary.js";

function result(status: PixKeyRegistrationControlResult["status"]): PixKeyRegistrationControlResult {
  return {
    pixType: "phone",
    profileId: "profile-1",
    profileName: "Perfil",
    status
  };
}

test("resume o cadastro PIX por resultado final sem expor microetapas", () => {
  assert.equal(
    summarizePixRegistrationResults([
      result("pix_key_registered"),
      result("pix_already_registered"),
      result("pix_key_pending_confirmation"),
      result("pix_key_conflict"),
      result("failed")
    ]),
    "Cadastro PIX: 2 concluídos · 1 aguardando confirmação · 2 para revisão"
  );
});

test("resume estados intermediarios como em andamento", () => {
  assert.equal(
    summarizePixRegistrationResults([result("withdrawal_password_entered")]),
    "Cadastro PIX: 1 em andamento"
  );
});

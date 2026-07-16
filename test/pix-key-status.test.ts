import assert from "node:assert/strict";
import test from "node:test";
import {
  canDeletePixKey,
  canEditPixKey,
  canManagePixKey,
  countAvailablePixKeys,
  pixKeyStatusLabel
} from "../src/renderer/lib/pix-key-status.js";

test("maps internal PIX key states to Portuguese UI labels", () => {
  assert.equal(pixKeyStatusLabel("available"), "Disponível");
  assert.equal(pixKeyStatusLabel("reserved"), "Em cadastro");
  assert.equal(pixKeyStatusLabel("pending_confirmation"), "Aguardando confirmação");
  assert.equal(pixKeyStatusLabel("rejected"), "Recusada");
  assert.equal(pixKeyStatusLabel("used"), "Cadastrada");
  assert.equal(canManagePixKey("available"), true);
  assert.equal(canManagePixKey("reserved"), false);
  assert.equal(canManagePixKey("pending_confirmation"), false);
  assert.equal(canEditPixKey("rejected"), false);
  assert.equal(canDeletePixKey("rejected"), true);
  assert.equal(canManagePixKey("used"), false);
});

test("counts only available PIX keys as automation stock", () => {
  assert.equal(countAvailablePixKeys(["available", "reserved", "pending_confirmation", "rejected", "used"]), 1);
});

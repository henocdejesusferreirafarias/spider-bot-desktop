import assert from "node:assert/strict";
import test from "node:test";
import { maskPixPhoneKey } from "../src/renderer/lib/mask-sensitive-value.js";

test("mascara a chave PIX telefone sem exibir o numero completo", () => {
  assert.equal(maskPixPhoneKey("41980042690"), "41***690");
});

test("nao inventa uma chave PIX quando o valor esta ausente", () => {
  assert.equal(maskPixPhoneKey(undefined), "—");
});

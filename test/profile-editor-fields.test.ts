import assert from "node:assert/strict";
import test from "node:test";
import { profileEditorPixKeyValue } from "../src/renderer/lib/profile-editor-fields.js";

test("expoe a chave PIX completa no editor", () => {
  assert.equal(profileEditorPixKeyValue({ pixPhoneKey: "41980042690" }), "41980042690");
});

test("mantem o campo PIX vazio sem chave confirmada", () => {
  assert.equal(profileEditorPixKeyValue(undefined), "");
});

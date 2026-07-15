import assert from "node:assert/strict";
import test from "node:test";
import type { SpaHandle } from "../src/main/services/spa-navigation.js";
import { selectUniqueWithdrawalPasswordModalSurface } from "../src/main/services/withdrawal-password-modal-context.js";

const eligibleInspection = {
  visibleGrids: 1,
  gridCells: 6,
  filledCells: 0,
  focusedCells: 1,
  visibleKeyboards: 1,
  keyboardKeys: 12,
};

test("seleciona o modal elegivel da pagina principal", () => {
  const top = {} as SpaHandle;
  const staleFrame = {} as SpaHandle;

  const result = selectUniqueWithdrawalPasswordModalSurface([
    { surface: top, inspection: eligibleInspection },
    { surface: staleFrame, inspection: { ...eligibleInspection, focusedCells: 0 } },
  ]);

  assert.deepEqual(result, { ok: true, surface: top });
});

test("seleciona o modal elegivel em frame vivo", () => {
  const top = {} as SpaHandle;
  const modalFrame = {} as SpaHandle;

  const result = selectUniqueWithdrawalPasswordModalSurface([
    { surface: top, inspection: { ...eligibleInspection, visibleGrids: 0 } },
    { surface: modalFrame, inspection: eligibleInspection },
  ]);

  assert.deepEqual(result, { ok: true, surface: modalFrame });
});

test("recusa dois modais igualmente acionaveis", () => {
  const result = selectUniqueWithdrawalPasswordModalSurface([
    { surface: {} as SpaHandle, inspection: eligibleInspection },
    { surface: {} as SpaHandle, inspection: eligibleInspection },
  ]);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "surface-ambiguous");
});

test("recusa grid parcial como alvo do PIN", () => {
  const result = selectUniqueWithdrawalPasswordModalSurface([
    { surface: {} as SpaHandle, inspection: { ...eligibleInspection, filledCells: 1 } },
  ]);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "surface-absent");
});

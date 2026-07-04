import assert from "node:assert/strict";
import test from "node:test";
import { resolveRuntimeWindowTargetsStrict } from "../src/main/services/runtime-window-selection.js";
import type { RuntimeWindowTarget } from "../src/shared/contracts.js";

const runtimeWindows: RuntimeWindowTarget[] = [
  {
    automationActive: true,
    profileId: "profile-2",
    profileName: "Perfil 2",
    slotNumber: 2,
    status: "running-automation"
  },
  {
    automationActive: false,
    profileId: "profile-1",
    profileName: "Perfil 1",
    slotNumber: 1,
    status: "active"
  }
];

test("strict runtime window selection all resolves windows ordered by slot", () => {
  assert.deepEqual(resolveRuntimeWindowTargetsStrict({ mode: "all" }, runtimeWindows).map((target) => target.profileId), [
    "profile-1",
    "profile-2"
  ]);
});

test("strict runtime window selection requires profile and slot to still match", () => {
  assert.deepEqual(
    resolveRuntimeWindowTargetsStrict(
      {
        mode: "windows",
        windows: [{ profileId: "profile-2", slotNumber: 2 }]
      },
      runtimeWindows
    ).map((target) => target.profileId),
    ["profile-2"]
  );

  assert.throws(
    () =>
      resolveRuntimeWindowTargetsStrict(
        {
          mode: "windows",
          windows: [{ profileId: "profile-2", slotNumber: 1 }]
        },
        runtimeWindows
      ),
    /desatualizada/
  );
});

test("strict runtime window selection rejects empty target sets", () => {
  assert.throws(() => resolveRuntimeWindowTargetsStrict({ mode: "all" }, []), /Nenhuma janela ativa/);
  assert.throws(
    () => resolveRuntimeWindowTargetsStrict({ mode: "windows", windows: [] }, runtimeWindows),
    /Nenhuma janela selecionada/
  );
});

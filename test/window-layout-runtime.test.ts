import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("runtime separa escala ideal da escala lançada e não pede relaunch", async () => {
  const source = await readFile(
    new URL("../src/main/services/browser-runtime.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /launchedScale: number;/);
  assert.match(source, /placement\.idealScale/);
  assert.match(source, /handle\.launchedScale/);
  assert.doesNotMatch(
    source,
    /Reabra este navegador para ajustar a escala da interface/
  );
  assert.doesNotMatch(
    source,
    /handle\.placement = \{ \.\.\.placement, scale: previousScale \}/
  );
});

test("preview e launch resolvem métricas atuais do monitor em cada ação", async () => {
  const source = await readFile(
    new URL("../src/main/services/browser-runtime.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /getLayoutPreviewRects\(settings: AppSettings\)[\s\S]*?this\.resolveLayoutDisplay\(settings\.screenLayout\)/
  );
  assert.match(
    source,
    /private buildBrowserPlacement\([\s\S]*?settings: AppSettings[\s\S]*?this\.resolveLayoutDisplay\(settings\.screenLayout\)/
  );
});

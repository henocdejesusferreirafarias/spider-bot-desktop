import { test } from "node:test";
import assert from "node:assert/strict";

import { selectPidsForUserDataDir } from "../src/main/services/browser-process-kill.js";

const profileA = "C:\\Users\\henoc\\AppData\\Local\\spider\\profiles\\aaaa-1111";
const profileB = "C:\\Users\\henoc\\AppData\\Local\\spider\\profiles\\bbbb-2222";

// Cada processo do Chromium (principal + renderers/gpu) carrega --user-data-dir.
const processes = [
  { pid: 100, commandLine: `chrome.exe --user-data-dir="${profileA}"` },
  { pid: 101, commandLine: `chrome.exe --type=renderer --user-data-dir="${profileA}"` },
  { pid: 200, commandLine: `chrome.exe --user-data-dir="${profileB}"` },
  { pid: 201, commandLine: `chrome.exe --type=gpu-process --user-data-dir="${profileB}"` },
  { pid: 999, commandLine: "chrome.exe" } // Chrome pessoal do usuario, sem nosso dir
];

test("seleciona apenas o processo-arvore do perfil alvo", () => {
  assert.deepEqual(selectPidsForUserDataDir(processes, profileA).sort(), [100, 101]);
});

test("nao vaza para o outro perfil nem para o Chrome do usuario", () => {
  const pids = selectPidsForUserDataDir(processes, profileA);
  assert.ok(!pids.includes(200));
  assert.ok(!pids.includes(201));
  assert.ok(!pids.includes(999));
});

test("case-insensitive (paths do Windows)", () => {
  assert.deepEqual(selectPidsForUserDataDir(processes, profileA.toUpperCase()).sort(), [100, 101]);
});

// Fail-safe: um user-data-dir vazio/curto NAO pode casar com todos os processos —
// esse era exatamente o bug (taskkill /IM global fechando todas as janelas).
test("fail-safe: dir vazio nao mata nada", () => {
  assert.deepEqual(selectPidsForUserDataDir(processes, ""), []);
});

test("fail-safe: dir de espacos/curto nao mata nada", () => {
  assert.deepEqual(selectPidsForUserDataDir(processes, "  "), []);
  assert.deepEqual(selectPidsForUserDataDir(processes, "ab"), []);
});

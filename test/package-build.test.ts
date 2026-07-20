import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

// Guarda de regressao: o build empacotado NAO deve incluir source maps (.map),
// que expoem a fonte legivel do processo main/preload dentro do asar.
void test("electron-builder files config excludes source maps", () => {
  const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
    build?: { files?: string[] };
  };
  const files = pkg.build?.files ?? [];
  assert.ok(
    files.includes("!**/*.map"),
    "build.files deve conter \"!**/*.map\" para nao empacotar source maps."
  );
});

void test("electron-builder unpacks the ONNX captcha model for native runtime loading", () => {
  const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
    build?: { asarUnpack?: string[] };
  };
  const asarUnpack = pkg.build?.asarUnpack ?? [];
  assert.ok(
    asarUnpack.includes("assets/captcha/*.onnx"),
    "onnxruntime-node precisa carregar o modelo de app.asar.unpacked, nao de dentro do app.asar."
  );
});

void test("captcha ONNX resolver checks app.asar.unpacked before falling back to app.asar", () => {
  const sourcePath = fileURLToPath(new URL("../src/main/services/captcha/onnx-session.ts", import.meta.url));
  const source = readFileSync(sourcePath, "utf-8");
  assert.match(
    source,
    /app\.asar\.unpacked['"],\s*['"]assets['"],\s*['"]captcha['"]/,
    "resolver deve procurar o modelo ONNX no caminho fisico app.asar.unpacked."
  );
});

void test("desktop bootstrap keeps platform automation on the local adaptive runtime", () => {
  const mainSourcePath = fileURLToPath(new URL("../src/main/index.ts", import.meta.url));
  const source = readFileSync(mainSourcePath, "utf-8");
  const constructorCall = source.match(
    /new AutomationRuntimeService\(([\s\S]*?)\n\s*\);/
  )?.[1];

  assert.ok(constructorCall, "bootstrap deve criar o AutomationRuntimeService");
  assert.doesNotMatch(
    constructorCall,
    /\blicenseService\b/,
    "licenseService nao deve ser injetado no runtime de automacao; workflows de plataforma sao locais"
  );
});

void test("desktop bootstrap waits for the compiled Win32 placement service", () => {
  const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
    scripts?: { "dev:electron"?: string };
  };
  assert.match(
    pkg.scripts?.["dev:electron"] ?? "",
    /file:dist-electron\/main\/services\/windows-window-placement\.js/
  );
});

void test("a profile with a configured proxy fails closed when its local tunnel cannot start", () => {
  const runtimeSourcePath = fileURLToPath(
    new URL("../src/main/services/browser-runtime.ts", import.meta.url)
  );
  const source = readFileSync(runtimeSourcePath, "utf-8");
  const resolveLaunchProxy = source.match(
    /private async resolveLaunchProxy[\s\S]*?(?=\n  private prepareBrowserPreferences)/
  )?.[0];

  assert.ok(resolveLaunchProxy, "resolveLaunchProxy deve existir no runtime do navegador");
  assert.equal(
    resolveLaunchProxy.match(/ipLabel:\s*"direto"/g)?.length ?? 0,
    1,
    "somente um perfil sem proxy pode usar conexao direta"
  );
  assert.match(
    resolveLaunchProxy,
    /catch \(error\)[\s\S]*?throw new Error\(/,
    "falha ao iniciar o tunel deve impedir a abertura da janela"
  );
  assert.doesNotMatch(
    resolveLaunchProxy,
    /abrindo sem proxy/i,
    "um perfil com proxy nunca deve cair silenciosamente para conexao direta"
  );
});

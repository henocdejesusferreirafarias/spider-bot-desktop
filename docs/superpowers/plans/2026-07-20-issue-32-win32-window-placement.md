# Issue 32 Win32 Window Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir definitivamente a invasão entre monitores posicionando cada janela Chromium no `x/y` físico do slot por Win32, sem alterar tamanho, escala interna ou foco.

**Architecture:** O CDP continua normalizando estado e dimensões, enquanto um serviço Windows-only agrupa posições por perfil e executa um único helper PowerShell/Win32 transitório. O helper associa `user-data-dir` completo → PID → `HWND`, chama `SetWindowPos` apenas para posição e confirma o resultado com `GetWindowRect`; o runtime só confirma o slot após CDP e Win32 passarem.

**Tech Stack:** TypeScript ESM estrito, Electron 42, Patchright/CDP, Node `child_process.spawn`, Windows PowerShell 5+, C# P/Invoke (`user32.dll`), Node `node:test` + `assert`.

## Global Constraints

- Trabalhar somente no worktree `spider-bot-desktop-issue-32`, branch `feat/issue-32-multimonitor-layout`.
- O produto permanece exclusivo para Windows; não criar abstração macOS/Linux.
- Não remover ou alterar `--force-device-scale-factor`, fingerprint, zoom ou conteúdo das páginas.
- Win32 altera somente `x/y`; tamanho e escala permanecem sob responsabilidade do Chromium/CDP.
- Usar `SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE`; nunca roubar foco ou mudar z-order.
- Nunca selecionar janela por título ou apenas pelo nome `chrome.exe`; exigir `user-data-dir` completo, PID pertencente e classe `Chrome_WidgetWin_1`.
- Zero ou múltiplos candidatos são fail-closed; nunca escolher arbitrariamente.
- Uma falha individual não fecha navegador nem impede outras janelas.
- Não adicionar addon ou dependência nativa Node/Electron.
- Não criar processo residente nem polling; usar helper transitório, debounce de 350 ms, no máximo um lote ativo por serviço e três tentativas para `window-not-ready`.
- Timeout de cada helper: 5 segundos. Tolerância física: 2 pixels.
- O helper recebe JSON via `stdin`, devolve JSON via `stdout` e roda oculto com `-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand`.
- O teste manual multimonitor visual final permanece com o usuário; automatizar toda validação que não dependa do hardware físico.
- Gates obrigatórios: `npm test`, `npm run check`, `npm run build`, `git diff --check`.

## File Map

- Create `src/main/services/windows-window-placement.ts`: contratos, script PowerShell, runner, fila coalescida, retry, cancelamento e shutdown.
- Create `test/windows-window-placement.test.ts`: validação, parsing, batching, concorrência, retries, cancelamento e isolamento.
- Modify `package.json`: incluir o novo JS compilado na barreira `wait-on` do modo dev.
- Modify `test/package-build.test.ts`: proteger a presença do novo serviço na barreira de boot.
- Modify `src/main/services/browser-runtime.ts`: integrar posição nativa em launch, `Aplicar Agora`, stop/context-close e shutdown.
- Modify `test/window-layout-runtime.test.ts`: provar que o runtime entrega `targetPhysicalRect.x/y`, mantém tamanho no CDP e só confirma sucesso nativo.
- Modify `test/window-geometry.test.ts`: remover a falsa prova `geometry * scale = posição física` e manter testes de tamanho/CDP aproximado.
- Create `docs/adr/0012-posicionamento-fisico-win32.md`: registrar Win32 como autoridade final da posição.
- Modify `docs/adr/README.md`: indexar ADR 0012.
- Modify `docs/superpowers/reports/2026-07-20-issue-32-multimonitor-manual-qa.md`: acrescentar checklist Win32 sem inventar resultado manual.

---

### Task 1: Criar o helper Win32 seguro e seu runner transitório

**Files:**
- Create: `src/main/services/windows-window-placement.ts`
- Create: `test/windows-window-placement.test.ts`
- Modify: `package.json:15`
- Modify: `test/package-build.test.ts`

**Interfaces:**
- Produces: `NativeWindowPlacementTarget`, `NativeWindowPlacementResult`, `NativePlacementRunner`, `runWindowsWindowPlacement()` e `parseNativePlacementResults()`.
- Consumes: JSON de alvos com `profileId`, `userDataDir`, `x`, `y`.

- [ ] **Step 1: Escrever testes falhando de validação e parsing**

Criar `test/windows-window-placement.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseNativePlacementResults,
  validateNativePlacementTarget
} from "../src/main/services/windows-window-placement.js";

const target = {
  profileId: "profile-a",
  userDataDir: "C:\\Users\\tester\\Predator\\profiles\\profile-a",
  x: 1928,
  y: 8
};

test("aceita alvo específico e arredonda coordenadas físicas", () => {
  assert.deepEqual(validateNativePlacementTarget({ ...target, x: 1928.4, y: 7.6 }), target);
});

test("rejeita diretório vazio, curto ou coordenada não finita", () => {
  assert.throws(() => validateNativePlacementTarget({ ...target, userDataDir: "" }));
  assert.throws(() => validateNativePlacementTarget({ ...target, userDataDir: "ab" }));
  assert.throws(() => validateNativePlacementTarget({ ...target, x: Number.NaN }));
});

test("parseia resultado único e lista sem confiar em campos extras", () => {
  const expected = [{
    profileId: "profile-a",
    status: "positioned" as const,
    actual: { x: 1928, y: 8 }
  }];
  assert.deepEqual(parseNativePlacementResults(JSON.stringify(expected)), expected);
  assert.deepEqual(parseNativePlacementResults(JSON.stringify(expected[0])), expected);
});

test("rejeita stdout vazio, inválido ou status desconhecido", () => {
  assert.throws(() => parseNativePlacementResults(""));
  assert.throws(() => parseNativePlacementResults("not-json"));
  assert.throws(() => parseNativePlacementResults(JSON.stringify({ profileId: "a", status: "moved" })));
});

test("bootstrap espera o serviço Win32 compilado antes de iniciar Electron", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: { "dev:electron": string };
  };
  assert.match(packageJson.scripts["dev:electron"], /file:dist-electron\/main\/services\/windows-window-placement\.js/);
});
```

Adicionar `readFile` de `node:fs/promises` ao teste apropriado ou manter esta asserção em `test/package-build.test.ts`, seguindo a estrutura já existente naquele arquivo.

- [ ] **Step 2: Executar o teste e confirmar a falha**

```powershell
npx tsx --test test/windows-window-placement.test.ts
```

Expected: FAIL com `Cannot find module '../src/main/services/windows-window-placement.js'`.

- [ ] **Step 3: Criar contratos, validação e parser estrito**

No novo serviço, definir exatamente:

```ts
export const NATIVE_POSITION_TOLERANCE = 2;
export const NATIVE_PLACEMENT_TIMEOUT_MS = 5000;
export const NATIVE_PLACEMENT_DEBOUNCE_MS = 350;
export const NATIVE_PLACEMENT_MAX_ATTEMPTS = 3;

export interface NativeWindowPlacementTarget {
  profileId: string;
  userDataDir: string;
  x: number;
  y: number;
}

export type NativeWindowPlacementStatus = "positioned" | "window-not-ready" | "failed";

export interface NativeWindowPlacementResult {
  profileId: string;
  status: NativeWindowPlacementStatus;
  actual?: { x: number; y: number };
  error?: string;
}

export type NativePlacementRunner = (
  targets: readonly NativeWindowPlacementTarget[]
) => Promise<NativeWindowPlacementResult[]>;

export function validateNativePlacementTarget(
  value: NativeWindowPlacementTarget
): NativeWindowPlacementTarget {
  const profileId = value.profileId.trim();
  const userDataDir = value.userDataDir.trim();
  if (!profileId) throw new Error("Native placement requires profileId.");
  if (userDataDir.length < 3) throw new Error("Native placement requires a specific userDataDir.");
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new Error("Native placement requires finite coordinates.");
  }
  return { profileId, userDataDir, x: Math.round(value.x), y: Math.round(value.y) };
}
```

`parseNativePlacementResults()` deve aceitar objeto ou array, exigir `profileId`, um dos três status e `actual.x/y` finitos quando presente. Não converter status desconhecido em sucesso.

- [ ] **Step 4: Escrever o script PowerShell completo e exportá-lo para teste estrutural**

Adicionar `export const WINDOWS_WINDOW_PLACEMENT_SCRIPT = String.raw\`...\``. O script deve:

```powershell
$ErrorActionPreference = 'Stop'
$targets = @((([Console]::In.ReadToEnd() | ConvertFrom-Json)))

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class NativeWindowInfo {
  public long Handle { get; set; }
  public int ProcessId { get; set; }
  public string ClassName { get; set; } = "";
}

public static class SpiderWindowApi {
  private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int length);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  private const uint SWP_NOSIZE = 0x0001;
  private const uint SWP_NOZORDER = 0x0004;
  private const uint SWP_NOACTIVATE = 0x0010;

  public static NativeWindowInfo[] Enumerate() {
    var windows = new List<NativeWindowInfo>();
    EnumWindows((hwnd, _) => {
      if (!IsWindowVisible(hwnd)) return true;
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      var name = new StringBuilder(256);
      GetClassName(hwnd, name, name.Capacity);
      windows.Add(new NativeWindowInfo { Handle = hwnd.ToInt64(), ProcessId = (int)pid, ClassName = name.ToString() });
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }

  public static RECT Position(long handle, int x, int y) {
    var hwnd = new IntPtr(handle);
    if (!SetWindowPos(hwnd, IntPtr.Zero, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    RECT rect;
    if (!GetWindowRect(hwnd, out rect)) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    return rect;
  }
}
'@

function Normalize-Path([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return '' }
  return $value.Trim().TrimEnd('\\').ToLowerInvariant()
}

function Read-UserDataDir([string]$commandLine) {
  if ([string]::IsNullOrWhiteSpace($commandLine)) { return '' }
  $match = [regex]::Match($commandLine, '(?i)(?:^|\s)--user-data-dir(?:=|\s+)(?:"([^"]+)"|([^\s]+))')
  if (-not $match.Success) { return '' }
  $value = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
  return Normalize-Path $value
}

$processes = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='chromium.exe'" | Select-Object ProcessId, CommandLine)
$windows = @([SpiderWindowApi]::Enumerate())
$results = foreach ($target in $targets) {
  try {
    $wanted = Normalize-Path ([string]$target.userDataDir)
    if ($wanted.Length -lt 3) { throw 'unsafe-user-data-dir' }
    $pids = @($processes | Where-Object { (Read-UserDataDir $_.CommandLine) -eq $wanted } | ForEach-Object { [int]$_.ProcessId })
    $candidates = @($windows | Where-Object { $_.ClassName -eq 'Chrome_WidgetWin_1' -and $pids -contains $_.ProcessId })
    if ($candidates.Count -eq 0) {
      [pscustomobject]@{ profileId = [string]$target.profileId; status = 'window-not-ready'; error = 'window-not-found' }
      continue
    }
    if ($candidates.Count -ne 1) { throw 'ambiguous-window' }
    $rect = [SpiderWindowApi]::Position($candidates[0].Handle, [int]$target.x, [int]$target.y)
    $dx = [Math]::Abs($rect.Left - [int]$target.x)
    $dy = [Math]::Abs($rect.Top - [int]$target.y)
    if ($dx -gt 2 -or $dy -gt 2) { throw "position-mismatch:$($rect.Left),$($rect.Top)" }
    [pscustomobject]@{ profileId = [string]$target.profileId; status = 'positioned'; actual = [pscustomobject]@{ x = $rect.Left; y = $rect.Top } }
  } catch {
    [pscustomobject]@{ profileId = [string]$target.profileId; status = 'failed'; error = $_.Exception.Message }
  }
}
@($results) | ConvertTo-Json -Compress -Depth 4
```

Adicionar testes que procurem no script `SWP_NOSIZE`, `SWP_NOZORDER`, `SWP_NOACTIVATE`, `Chrome_WidgetWin_1`, `GetWindowRect` e a correspondência completa de `--user-data-dir`; também provar que não existe `SetWindowText`, `ShowWindow` ou filtro por título.

- [ ] **Step 5: Implementar o runner sem shell interpolation**

`runWindowsWindowPlacement()` deve usar `spawn("powershell.exe", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })`, codificar o script em UTF-16LE/Base64 e escrever `JSON.stringify(targets.map(validateNativePlacementTarget))` no stdin. Acumular stdout/stderr, matar o processo após 5 segundos e rejeitar em exit code não zero, timeout, stdout inválido ou resultado ausente para algum perfil.

Não usar `exec`, interpolação de caminhos no comando ou arquivos temporários.

- [ ] **Step 6: Rodar teste focado e typecheck**

Antes dos testes, acrescentar `file:dist-electron/main/services/windows-window-placement.js` à lista do script `dev:electron` em `package.json`. Isso impede o Electron de iniciar com import ainda não emitido pelo `tsc --watch`.

```powershell
npx tsx --test test/windows-window-placement.test.ts test/package-build.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 7: Commit atômico**

```powershell
git add src/main/services/windows-window-placement.ts test/windows-window-placement.test.ts test/package-build.test.ts package.json
git commit -m "feat: add safe Win32 window placement helper"
```

---

### Task 2: Agrupar solicitações, serializar lotes e limitar retries

**Files:**
- Modify: `src/main/services/windows-window-placement.ts`
- Modify: `test/windows-window-placement.test.ts`

**Interfaces:**
- Consumes: `NativePlacementRunner` da Task 1.
- Produces: `WindowsWindowPlacementService.enqueue()`, `enqueueMany()`, `cancel()` e `shutdown()`.

- [ ] **Step 1: Escrever testes falhando com runner injetado**

Usar um runner controlado:

```ts
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
};

test("coalesce vinte perfis em uma invocacao", async () => {
  const batches: NativeWindowPlacementTarget[][] = [];
  const service = new WindowsWindowPlacementService({
    debounceMs: 0,
    retryDelayMs: 0,
    runner: async (targets) => {
      batches.push([...targets]);
      return targets.map(({ profileId, x, y }) => ({ profileId, status: "positioned", actual: { x, y } }));
    }
  });
  const results = await service.enqueueMany(Array.from({ length: 20 }, (_, index) => ({
    profileId: `p${index}`,
    userDataDir: `C:\\Predator\\profiles\\p${index}`,
    x: 100 + index,
    y: 8
  })));
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.length, 20);
  assert.ok(results.every((result) => result.status === "positioned"));
  await service.shutdown();
});
```

Adicionar casos para: último alvo substitui coordenadas antigas do mesmo perfil; lote novo espera o ativo; somente `window-not-ready` repete até três vezes; `failed` não repete; `cancel(profileId)` impede alvo pendente; `shutdown()` resolve pendências como `failed` e não inicia novo helper.

- [ ] **Step 2: Executar e confirmar a falha**

```powershell
npx tsx --test test/windows-window-placement.test.ts
```

Expected: FAIL porque `WindowsWindowPlacementService` ainda não existe.

- [ ] **Step 3: Implementar a fila coalescida**

Adicionar:

```ts
interface PlacementRequest {
  target: NativeWindowPlacementTarget;
  waiters: Array<(result: NativeWindowPlacementResult) => void>;
}

export interface WindowsWindowPlacementServiceOptions {
  runner?: NativePlacementRunner;
  debounceMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
}

export class WindowsWindowPlacementService {
  private readonly pending = new Map<string, PlacementRequest>();
  private readonly runner: NativePlacementRunner;
  private readonly debounceMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private timer?: NodeJS.Timeout;
  private active: Promise<void> = Promise.resolve();
  private running = false;
  private closed = false;

  constructor(options: WindowsWindowPlacementServiceOptions = {}) {
    this.runner = options.runner ?? runWindowsWindowPlacement;
    this.debounceMs = options.debounceMs ?? NATIVE_PLACEMENT_DEBOUNCE_MS;
    this.retryDelayMs = options.retryDelayMs ?? 150;
    this.maxAttempts = options.maxAttempts ?? NATIVE_PLACEMENT_MAX_ATTEMPTS;
  }

  enqueue(target: NativeWindowPlacementTarget): Promise<NativeWindowPlacementResult>;
  enqueueMany(targets: readonly NativeWindowPlacementTarget[]): Promise<NativeWindowPlacementResult[]>;
  cancel(profileId: string): void;
  shutdown(): Promise<void>;
}
```

`enqueue()` valida o alvo, agrega o waiter ao registro existente e substitui apenas `target`. `schedule()` cria um único timer. `drain()` retira snapshot, marca `running`, chama `runWithRetries()`, resolve todos os waiters pelo `profileId` e agenda o próximo snapshot se chegaram pedidos durante o lote.

`runWithRetries()` mantém um mapa dos resultados, repete somente os `window-not-ready` e converte exceção do runner em `failed` para todos os alvos daquela tentativa. Resultado ausente também vira `failed` com `missing-helper-result`.

- [ ] **Step 4: Implementar cancelamento e shutdown sem promises penduradas**

`cancel(profileId)` remove somente o pedido ainda pendente e resolve seus waiters com `{ profileId, status: "failed", error: "cancelled" }`. Não tenta interromper um lote já entregue ao PowerShell.

`shutdown()` marca `closed`, limpa timer, resolve todo pending como `failed/shutdown` e aguarda `active`. Chamadas posteriores a `enqueue()` retornam imediatamente `failed/service-shutdown`.

- [ ] **Step 5: Rodar testes focados e verificar handles abertos**

```powershell
npx tsx --test test/windows-window-placement.test.ts
npm run check
```

Expected: PASS; o runner falso registra um único lote para vinte alvos e nenhuma promise permanece aberta ao final.

- [ ] **Step 6: Commit atômico**

```powershell
git add src/main/services/windows-window-placement.ts test/windows-window-placement.test.ts
git commit -m "feat: batch native browser window placement"
```

---

### Task 3: Integrar confirmação Win32 ao launch e ao Aplicar Agora

**Files:**
- Modify: `src/main/services/browser-runtime.ts:248-270, 1027-1100, 1129-1492, 1511-1586, 1944-1975, 7713-7785`
- Modify: `test/window-layout-runtime.test.ts`
- Modify: `test/window-geometry.test.ts:226-257`

**Interfaces:**
- Consumes: `WindowsWindowPlacementService` e `NativeWindowPlacementTarget`.
- Preserves: `toChromiumWindowGeometry()` para tamanho e posição aproximada de abertura; `targetPhysicalRect` é a autoridade para posição nativa.

- [ ] **Step 1: Escrever testes falhando da integração**

Criar um fake:

```ts
class FakeNativePlacementService {
  readonly batches: NativeWindowPlacementTarget[][] = [];
  readonly cancelled: string[] = [];
  nextStatus: NativeWindowPlacementStatus = "positioned";

  async enqueue(target: NativeWindowPlacementTarget): Promise<NativeWindowPlacementResult> {
    const [result] = await this.enqueueMany([target]);
    if (!result) throw new Error("missing fake result");
    return result;
  }

  async enqueueMany(targets: readonly NativeWindowPlacementTarget[]): Promise<NativeWindowPlacementResult[]> {
    this.batches.push([...targets]);
    return targets.map(({ profileId, x, y }) => ({
      profileId,
      status: this.nextStatus,
      ...(this.nextStatus === "positioned" ? { actual: { x, y } } : { error: "fake-failure" })
    }));
  }

  cancel(profileId: string): void { this.cancelled.push(profileId); }
  async shutdown(): Promise<void> {}
}
```

Atualizar o harness para injetar o fake no construtor. Testar que:

- o alvo usa `placement.targetPhysicalRect.x/y`, não `toChromiumWindowGeometry().x/y`;
- `applyPlacementToPage()` ainda envia `width/height` compensados pelo CDP;
- dois handles em `applyLayout()` geram um `enqueueMany()` com dois alvos;
- status nativo `failed` impede atualização de `slotIndex/placement`, mas não impede o próximo perfil;
- `stopProfile()` e context-close chamam `cancel(profileId)`;
- `shutdown()` chama `nativePlacement.shutdown()`.

- [ ] **Step 2: Executar e confirmar a falha**

```powershell
npx tsx --test test/window-layout-runtime.test.ts test/window-geometry.test.ts
```

Expected: FAIL porque o runtime não aceita o serviço nativo nem agenda alvos.

- [ ] **Step 3: Injetar o serviço e criar o alvo nativo**

Importar os tipos e alterar o construtor sem quebrar chamadores:

```ts
constructor(
  private readonly notify: RuntimeNotifier,
  private readonly nativeWindowPlacement = new WindowsWindowPlacementService()
) {
  appendInputDiagnostic({ kind: "diagnostic-session-start", pid: process.pid });
}

private buildNativePlacementTarget(
  profileId: string,
  storagePath: string,
  placement: DpiAwarePlacement
): NativeWindowPlacementTarget {
  return {
    profileId,
    userDataDir: storagePath,
    x: placement.targetPhysicalRect.x,
    y: placement.targetPhysicalRect.y
  };
}
```

Tipar a dependência por uma interface mínima exportada pelo módulo para o fake implementar sem cast.

- [ ] **Step 4: Confirmar nativamente o lançamento sem torná-lo fatal**

Depois do último `applyPlacementToPage()` e após registrar o handle, aguardar:

```ts
const nativeResult = await this.nativeWindowPlacement.enqueue(
  this.buildNativePlacementTarget(profile.id, profile.storagePath, placement)
);
appendInputDiagnostic({
  kind: "native-window-placement",
  profileId: profile.id,
  slotIndex: placement.slotIndex,
  requested: placement.targetPhysicalRect,
  result: nativeResult
});
```

`failed` ou `window-not-ready` não lança e não fecha o contexto; a notificação final continua `Navegador aberto e pronto`, com diagnóstico técnico preservado. O handle continua disponível para novo `Aplicar Agora`.

- [ ] **Step 5: Reestruturar Aplicar Agora em duas fases**

Primeira fase, sequencial: calcular placement, localizar page e aplicar CDP; guardar candidatos bem-sucedidos em:

```ts
interface PendingAppliedPlacement {
  profileId: string;
  handle: RuntimeHandle;
  page: Page;
  placement: BrowserPlacement;
}
```

Segunda fase: chamar uma única vez:

```ts
const nativeResults = await this.nativeWindowPlacement.enqueueMany(
  pending.map(({ profileId, handle, placement }) =>
    this.buildNativePlacementTarget(profileId, handle.storagePath, placement)
  )
);
const nativeByProfile = new Map(nativeResults.map((result) => [result.profileId, result]));
```

Atualizar badges, `primaryPage`, `slotIndex` e `placement` somente para `status === "positioned"`. Emitir a mensagem de sucesso somente nesses casos. Falha CDP ou nativa mantém a mensagem existente de janela que não respondeu e não impede as demais.

- [ ] **Step 6: Cancelar pendências e encerrar o serviço**

Chamar `cancel(profileId)` tanto em `attachContextCloseHandler()` antes de apagar o handle quanto no início de `stopProfile()`. Ao final de `shutdown()`, depois de fechar os handles, aguardar `nativeWindowPlacement.shutdown()`.

- [ ] **Step 7: Corrigir o teste que criou falsa confiança**

Substituir o teste `grade 5x2 compensa a escala na origem global do monitor à direita` por dois testes explícitos:

```ts
test("grade 5x2 preserva o retangulo físico para posicionamento nativo", () => {
  // construir primeiro e último placement do monitor direito
  assert.deepEqual(firstPlacement.targetPhysicalRect, { x: 1928, y: 8, width: 470, height: 504 });
  assert.equal(lastPlacement.targetPhysicalRect.x + lastPlacement.targetPhysicalRect.width, 4310);
});

test("geometria CDP mantém tamanho compensado sem provar posição Win32", () => {
  const geometry = toChromiumWindowGeometry(firstPlacement, firstPlacement.idealScale);
  assert.equal(Math.round(geometry.width * firstPlacement.idealScale), 470);
  assert.equal(Math.round(geometry.height * firstPlacement.idealScale), 504);
});
```

Não voltar a derivar posição física com `geometry.x * scale`.

- [ ] **Step 8: Rodar testes focados e typecheck**

```powershell
npx tsx --test test/windows-window-placement.test.ts test/window-layout-runtime.test.ts test/window-geometry.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 9: Commit atômico**

```powershell
git add src/main/services/browser-runtime.ts test/window-layout-runtime.test.ts test/window-geometry.test.ts
git commit -m "fix: enforce multimonitor positions through Win32"
```

---

### Task 4: Registrar decisão, verificar pacote e fechar evidência automatizada

**Files:**
- Create: `docs/adr/0012-posicionamento-fisico-win32.md`
- Modify: `docs/adr/README.md`
- Modify: `docs/superpowers/reports/2026-07-20-issue-32-multimonitor-manual-qa.md`

- [ ] **Step 1: Criar ADR 0012**

Registrar contexto, decisão e consequências com estes pontos obrigatórios:

- CDP e `Browser.getWindowBounds` compartilham o espaço interno do Chromium e não confirmam a posição Win32;
- `screen.dipToScreenRect()` continua produzindo o alvo físico;
- CDP controla estado/tamanho e Win32 controla `x/y` final;
- associação fail-closed por `user-data-dir` completo → PID → classe/`HWND`;
- PowerShell é transitório, em lote, sem dependência nativa e sem polling;
- falha degrada para o posicionamento aproximado sem fechar o navegador;
- produto Windows-only por decisão explícita.

- [ ] **Step 2: Indexar ADR e atualizar relatório sem inventar QA**

Adicionar `0012-posicionamento-fisico-win32.md` ao índice. No relatório existente, acrescentar:

```md
## Correção Win32 da origem do monitor

| Verificação | Resultado | Evidência |
| --- | --- | --- |
| Testes do helper e batching | PENDENTE | |
| Typecheck e build | PENDENTE | |
| 5x2 no monitor direito com escala interna < 1 | PENDENTE (usuário) | |
| Monitor à esquerda/acima | PENDENTE (usuário) | |
| Chrome pessoal não é movido | PENDENTE (usuário) | |
| Nenhum PowerShell residual | PENDENTE (usuário) | |
```

Preencher somente as duas primeiras linhas com evidência automatizada observada nesta execução. As linhas físicas permanecem pendentes para o usuário.

- [ ] **Step 3: Rodar todos os gates**

```powershell
npm test
npm run check
npm run build
git diff --check
```

Expected: todos PASS. Registrar contagem/duração real no relatório.

- [ ] **Step 4: Verificar segurança e ausência de processo residual**

```powershell
rg -n "SetWindowPos|SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE|Chrome_WidgetWin_1|user-data-dir" src/main/services/windows-window-placement.ts
rg -n "SetWindowText|ShowWindow|MainWindowTitle|taskkill /IM" src/main/services/windows-window-placement.ts
Get-Process powershell -ErrorAction SilentlyContinue | Select-Object Id,StartTime,Path
git status --short
git diff --check origin/main...HEAD
```

Expected: primeira busca encontra as proteções; segunda não encontra APIs proibidas; nenhum PowerShell criado pelo teste permanece; worktree limpo após commit.

- [ ] **Step 5: Commit da decisão e evidência**

```powershell
git add docs/adr/0012-posicionamento-fisico-win32.md docs/adr/README.md docs/superpowers/reports/2026-07-20-issue-32-multimonitor-manual-qa.md
git commit -m "docs: record native Windows placement decision"
```

---

## Final Review Checklist

- [ ] O helper nunca usa título, posição atual ou nome do executável como associação suficiente.
- [ ] O argumento completo `--user-data-dir` é comparado case-insensitivamente.
- [ ] Ambiguidade é fail-closed.
- [ ] Win32 altera somente posição e valida com `GetWindowRect` em tolerância de 2 pixels.
- [ ] Vinte alvos próximos produzem uma invocação do runner nos testes.
- [ ] Não há processo residente, polling, arquivo temporário ou addon nativo.
- [ ] Launch e `Aplicar Agora` usam `targetPhysicalRect.x/y`.
- [ ] Tamanho continua sob CDP e a escala interna não muda.
- [ ] Stop, context-close e shutdown limpam solicitações.
- [ ] O teste antigo não deriva mais posição física com `geometry.x * scale`.
- [ ] Falhas não fecham contexto nem bloqueiam os outros perfis.
- [ ] `npm test`, `npm run check`, `npm run build` e `git diff --check` passam.
- [ ] QA física permanece explicitamente pendente para o usuário.

import { spawn } from "node:child_process";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function validateNativePlacementTarget(
  value: NativeWindowPlacementTarget
): NativeWindowPlacementTarget {
  const profileId = value.profileId.trim();
  const userDataDir = value.userDataDir.trim();
  if (!profileId) {
    throw new Error("Native placement requires profileId.");
  }
  if (userDataDir.length < 3) {
    throw new Error("Native placement requires a specific userDataDir.");
  }
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new Error("Native placement requires finite coordinates.");
  }
  return {
    profileId,
    userDataDir,
    x: Math.round(value.x),
    y: Math.round(value.y)
  };
}

function parseNativePlacementResult(value: unknown): NativeWindowPlacementResult {
  if (!isRecord(value) || typeof value.profileId !== "string" || !value.profileId.trim()) {
    throw new Error("Native placement helper returned an invalid profileId.");
  }
  if (
    value.status !== "positioned" &&
    value.status !== "window-not-ready" &&
    value.status !== "failed"
  ) {
    throw new Error("Native placement helper returned an invalid status.");
  }
  const result: NativeWindowPlacementResult = {
    profileId: value.profileId.trim(),
    status: value.status
  };
  if (value.actual !== undefined) {
    if (
      !isRecord(value.actual) ||
      typeof value.actual.x !== "number" ||
      !Number.isFinite(value.actual.x) ||
      typeof value.actual.y !== "number" ||
      !Number.isFinite(value.actual.y)
    ) {
      throw new Error("Native placement helper returned invalid physical coordinates.");
    }
    result.actual = { x: value.actual.x, y: value.actual.y };
  }
  if (typeof value.error === "string" && value.error) {
    result.error = value.error;
  }
  return result;
}

export function parseNativePlacementResults(stdout: string): NativeWindowPlacementResult[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Native placement helper returned no output.");
  }
  const parsed = JSON.parse(trimmed) as unknown;
  const values = Array.isArray(parsed) ? parsed : [parsed];
  if (values.length === 0) {
    throw new Error("Native placement helper returned an empty result.");
  }
  return values.map(parseNativePlacementResult);
}

export const WINDOWS_WINDOW_PLACEMENT_SCRIPT = String.raw`
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
  public string ClassName { get; set; }
}

public static class SpiderWindowApi {
  private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int length);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  private const uint SWP_NOSIZE = 0x0001;
  private const uint SWP_NOZORDER = 0x0004;
  private const uint SWP_NOACTIVATE = 0x0010;

  public static void EnablePerMonitorDpiAwareness() {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
  }

  public static NativeWindowInfo[] Enumerate() {
    var windows = new List<NativeWindowInfo>();
    EnumWindows((hwnd, ignored) => {
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
  return $value.Trim().TrimEnd('\').ToLowerInvariant()
}

function Read-UserDataDir([string]$commandLine) {
  if ([string]::IsNullOrWhiteSpace($commandLine)) { return '' }
  $match = [regex]::Match($commandLine, '(?i)(?:^|\s)--user-data-dir(?:=|\s+)(?:"([^"]+)"|([^\s]+))')
  if (-not $match.Success) { return '' }
  $value = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
  return Normalize-Path $value
}

[SpiderWindowApi]::EnablePerMonitorDpiAwareness()
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
    if ($dx -gt ${NATIVE_POSITION_TOLERANCE} -or $dy -gt ${NATIVE_POSITION_TOLERANCE}) {
      throw "position-mismatch:$($rect.Left),$($rect.Top)"
    }
    [pscustomobject]@{
      profileId = [string]$target.profileId
      status = 'positioned'
      actual = [pscustomobject]@{ x = $rect.Left; y = $rect.Top }
    }
  } catch {
    [pscustomobject]@{ profileId = [string]$target.profileId; status = 'failed'; error = $_.Exception.Message }
  }
}
@($results) | ConvertTo-Json -Compress -Depth 4
`;

export async function runWindowsWindowPlacement(
  targets: readonly NativeWindowPlacementTarget[]
): Promise<NativeWindowPlacementResult[]> {
  if (targets.length === 0) {
    return [];
  }
  if (process.platform !== "win32") {
    throw new Error("Native window placement is available only on Windows.");
  }
  const validated = targets.map(validateNativePlacementTarget);
  const encodedScript = Buffer.from(WINDOWS_WINDOW_PLACEMENT_SCRIPT, "utf16le").toString("base64");

  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      encodedScript
    ], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, NATIVE_PLACEMENT_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`Native placement helper timed out after ${NATIVE_PLACEMENT_TIMEOUT_MS}ms.`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Native placement helper exited with code ${String(code)}: ${stderr.trim()}`));
        return;
      }
      try {
        const results = parseNativePlacementResults(stdout);
        const expectedIds = new Set(validated.map(({ profileId }) => profileId));
        const returnedIds = new Set(results.map(({ profileId }) => profileId));
        if (returnedIds.size !== results.length || expectedIds.size !== returnedIds.size) {
          throw new Error("Native placement helper returned duplicate or missing profiles.");
        }
        for (const profileId of expectedIds) {
          if (!returnedIds.has(profileId)) {
            throw new Error(`Native placement helper omitted ${profileId}.`);
          }
        }
        resolve(results);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(validated));
  });
}

interface PlacementRequest {
  target: NativeWindowPlacementTarget;
  waiters: Array<(result: NativeWindowPlacementResult) => void>;
}

export interface NativeWindowPlacementCoordinator {
  enqueue(target: NativeWindowPlacementTarget): Promise<NativeWindowPlacementResult>;
  enqueueMany(
    targets: readonly NativeWindowPlacementTarget[]
  ): Promise<NativeWindowPlacementResult[]>;
  cancel(profileId: string): void;
  shutdown(): Promise<void>;
}

export interface WindowsWindowPlacementServiceOptions {
  runner?: NativePlacementRunner;
  debounceMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
}

const failureResult = (profileId: string, error: string): NativeWindowPlacementResult => ({
  profileId,
  status: "failed",
  error
});

export class WindowsWindowPlacementService implements NativeWindowPlacementCoordinator {
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
    this.debounceMs = Math.max(0, options.debounceMs ?? NATIVE_PLACEMENT_DEBOUNCE_MS);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 150);
    this.maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? NATIVE_PLACEMENT_MAX_ATTEMPTS));
  }

  enqueue(target: NativeWindowPlacementTarget): Promise<NativeWindowPlacementResult> {
    const validated = validateNativePlacementTarget(target);
    if (this.closed) {
      return Promise.resolve(failureResult(validated.profileId, "service-shutdown"));
    }
    const promise = new Promise<NativeWindowPlacementResult>((resolve) => {
      const existing = this.pending.get(validated.profileId);
      if (existing) {
        existing.target = validated;
        existing.waiters.push(resolve);
      } else {
        this.pending.set(validated.profileId, {
          target: validated,
          waiters: [resolve]
        });
      }
    });
    this.schedule();
    return promise;
  }

  enqueueMany(
    targets: readonly NativeWindowPlacementTarget[]
  ): Promise<NativeWindowPlacementResult[]> {
    return Promise.all(targets.map((target) => this.enqueue(target)));
  }

  cancel(profileId: string): void {
    const request = this.pending.get(profileId);
    if (!request) {
      return;
    }
    this.pending.delete(profileId);
    this.resolveRequest(request, failureResult(profileId, "cancelled"));
    if (this.pending.size === 0 && this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      await this.active;
      return;
    }
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const [profileId, request] of this.pending) {
      this.resolveRequest(request, failureResult(profileId, "shutdown"));
    }
    this.pending.clear();
    await this.active;
  }

  private schedule(): void {
    if (this.closed || this.running || this.timer || this.pending.size === 0) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.startDrain();
    }, this.debounceMs);
  }

  private startDrain(): void {
    if (this.closed || this.running || this.pending.size === 0) {
      return;
    }
    const snapshot = [...this.pending.values()];
    this.pending.clear();
    this.running = true;
    this.active = this.processSnapshot(snapshot).finally(() => {
      this.running = false;
      this.schedule();
    });
  }

  private async processSnapshot(snapshot: PlacementRequest[]): Promise<void> {
    const results = await this.runWithRetries(snapshot.map(({ target }) => target));
    const resultByProfile = new Map(results.map((result) => [result.profileId, result]));
    for (const request of snapshot) {
      const result = resultByProfile.get(request.target.profileId) ??
        failureResult(request.target.profileId, "missing-helper-result");
      this.resolveRequest(request, result);
    }
  }

  private async runWithRetries(
    targets: NativeWindowPlacementTarget[]
  ): Promise<NativeWindowPlacementResult[]> {
    const completed = new Map<string, NativeWindowPlacementResult>();
    let remaining = targets;

    for (let attempt = 1; attempt <= this.maxAttempts && remaining.length > 0; attempt += 1) {
      let attemptResults: NativeWindowPlacementResult[];
      try {
        attemptResults = await this.runner(remaining);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        for (const target of remaining) {
          completed.set(target.profileId, failureResult(target.profileId, detail));
        }
        break;
      }

      const byProfile = new Map(attemptResults.map((result) => [result.profileId, result]));
      const retry: NativeWindowPlacementTarget[] = [];
      for (const target of remaining) {
        const result = byProfile.get(target.profileId) ??
          failureResult(target.profileId, "missing-helper-result");
        if (result.status === "window-not-ready" && attempt < this.maxAttempts) {
          retry.push(target);
        } else {
          completed.set(target.profileId, result);
        }
      }
      remaining = retry;
      if (remaining.length > 0 && this.retryDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }

    return targets.map(({ profileId }) =>
      completed.get(profileId) ?? failureResult(profileId, "missing-helper-result")
    );
  }

  private resolveRequest(
    request: PlacementRequest,
    result: NativeWindowPlacementResult
  ): void {
    for (const resolve of request.waiters) {
      resolve(result);
    }
  }
}

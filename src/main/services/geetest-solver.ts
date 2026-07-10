import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { generateW, type GeetestChallengeData } from "./captcha/signer.js";
import type { GeetestVerifyResult } from "./captcha/geetest-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, "../../..");
const RESOURCE_ROOT = resolveResourceRoot();
const BRIDGE_SCRIPT = join(RESOURCE_ROOT, "scripts", "geetest_solver_bridge.py");
const WORKER_SCRIPT = join(RESOURCE_ROOT, "scripts", "geetest_solver_worker.py");
const SOLVE_TIMEOUT_MS = 60_000;
const WORKER_IDLE_STOP_MS = Number(process.env.GEETEST_WORKER_IDLE_MS ?? 120_000);
const WORKER_STOP_GRACE_MS = 3_000;

export interface GeetestCaptchaData {
  captchaId: string;
  baseUrl: string;
  riskType?: string;
}

export interface GeetestSolution {
  captcha_id?: string;
  lot_number?: string;
  pass_token?: string;
  gen_time?: string;
  captcha_output?: string;
  userresponse?: string | number | Array<[number, number]>;
  setLeft?: number;
}

interface GeetestSolverPayload {
  captcha_id: string;
  risk_type: string | null;
  base_url: string;
  proxy: string | null;
  verify: boolean;
  max_retries: number;
}

interface WorkerResponse {
  id?: string;
  ok?: boolean;
  result?: GeetestSolution;
  error?: string;
  type?: string;
}

interface WorkerSolveOutcome {
  result: GeetestSolution | null;
  workerFailed: boolean;
}

interface PendingWorkerRequest {
  resolve: (outcome: WorkerSolveOutcome) => void;
  timer: NodeJS.Timeout;
}

export function shouldAttemptAutomaticGeetestSolve(riskType?: string | null): boolean {
  return riskType?.trim().toLowerCase() === "nine";
}

export interface GeetestNineClient {
  load(captchaId: string, riskType?: string | null): Promise<GeetestChallengeData & { captcha_type?: string }>;
  fetchImage(path: string): Promise<Buffer>;
  verify(args: {
    captchaId: string;
    lotNumber: string;
    payload: string;
    processToken: string;
    w: string;
    riskType?: string | null;
  }): Promise<GeetestVerifyResult>;
}

export type GenerateGeetestW = (
  data: GeetestChallengeData,
  captchaId: string,
  riskType: string,
  fetchImage: (path: string) => Promise<Buffer>,
) => Promise<string>;

export async function solveNineGeetestWithClient(
  client: GeetestNineClient,
  captchaId: string,
  riskType?: string | null,
  generateGeetestW: GenerateGeetestW = (data, id, type, fetchImage) => generateW(data, id, type, fetchImage, () => 0),
): Promise<GeetestSolution | null> {
  if (!shouldAttemptAutomaticGeetestSolve(riskType)) {
    return null;
  }

  const data = await client.load(captchaId, "nine");
  if (data.captcha_type && !shouldAttemptAutomaticGeetestSolve(data.captcha_type)) {
    return null;
  }

  const w = await generateGeetestW(data, captchaId, "nine", (path) => client.fetchImage(path));
  const result = await client.verify({
    captchaId,
    lotNumber: data.lot_number,
    payload: String(data.payload ?? ""),
    processToken: String(data.process_token ?? ""),
    w,
    riskType: "nine",
  });
  const seccode = result.seccode;
  if (!seccode?.pass_token || !seccode.lot_number) {
    return null;
  }

  return {
    captcha_id: seccode.captcha_id ?? captchaId,
    lot_number: seccode.lot_number,
    pass_token: seccode.pass_token,
    gen_time: seccode.gen_time,
    captcha_output: seccode.captcha_output,
  };
}

function findPython(): string | null {
  for (const candidate of ["python", "python3", "py"]) {
    try {
      execSync(`"${candidate}" --version`, { stdio: "ignore", timeout: 5000 });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function resolveResourceRoot(): string {
  const resourcesPath = process.resourcesPath;
  if (resourcesPath && existsSync(join(resourcesPath, "scripts", "geetest_solver_bridge.py"))) {
    return resourcesPath;
  }
  return PROJECT_ROOT;
}

let _pythonPath: string | null | undefined;

function getPythonPath(): string | null {
  if (_pythonPath === undefined) {
    _pythonPath = findPython();
  }
  return _pythonPath;
}

export class GeetestSolverService {
  private worker: ChildProcessWithoutNullStreams | undefined;
  private workerBuffer = "";
  private workerStarting: Promise<boolean> | undefined;
  private readonly pendingWorkerRequests = new Map<string, PendingWorkerRequest>();
  private warmSessionDepth = 0;
  private idleStopTimer: NodeJS.Timeout | undefined;

  beginWarmSession(): void {
    this.warmSessionDepth += 1;
    this.clearIdleStopTimer();
    void this.ensureWorker();
  }

  releaseWarmSession(): void {
    this.warmSessionDepth = Math.max(0, this.warmSessionDepth - 1);
    if (this.warmSessionDepth === 0) {
      this.scheduleIdleStop();
    }
  }

  async stopIfIdle(): Promise<void> {
    if (this.workerStarting) {
      await this.workerStarting.catch(() => false);
    }
    if (this.warmSessionDepth > 0 || this.pendingWorkerRequests.size > 0) {
      return;
    }
    await this.stopWorker();
  }

  async solve(captchaId: string, riskType?: string | null, baseUrl?: string, proxy?: string, maxRetries?: number): Promise<GeetestSolution | null> {
    if (!shouldAttemptAutomaticGeetestSolve(riskType)) {
      return null;
    }

    const payload = this.buildPayload(captchaId, riskType, baseUrl, proxy, maxRetries);

    if (this.warmSessionDepth > 0 || this.worker) {
      const workerOutcome = await this.solveWithWorker(payload);
      if (!workerOutcome.workerFailed) {
        return workerOutcome.result;
      }
    }

    return this.solveOnce(payload);
  }

  private buildPayload(
    captchaId: string,
    riskType?: string | null,
    baseUrl?: string,
    proxy?: string,
    maxRetries?: number
  ): GeetestSolverPayload {
    return {
      captcha_id: captchaId,
      risk_type: riskType || null,
      base_url: baseUrl || "https://gcaptcha4.geevisit.com",
      proxy: proxy || null,
      verify: true,
      max_retries: maxRetries ?? 5
    };
  }

  private async solveOnce(payload: GeetestSolverPayload): Promise<GeetestSolution | null> {
    const python = getPythonPath();
    if (!python) {
      return null;
    }

    const payloadJson = JSON.stringify(payload);

    return new Promise((resolve) => {
      const proc = spawn(python, [BRIDGE_SCRIPT], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: SOLVE_TIMEOUT_MS
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      proc.on("error", () => {
        resolve(null);
      });

      proc.on("close", (code: number | null) => {
        if (code !== 0) {
          resolve(null);
          return;
        }

        try {
          const result = JSON.parse(stdout.trim());
          if (result.error) {
            resolve(null);
            return;
          }
          resolve(result as GeetestSolution);
        } catch {
          resolve(null);
        }
      });

      proc.stdin?.write(payloadJson);
      proc.stdin?.end();
    });
  }

  private async solveWithWorker(payload: GeetestSolverPayload): Promise<WorkerSolveOutcome> {
    if (!(await this.ensureWorker()) || !this.worker) {
      return { result: null, workerFailed: true };
    }

    this.clearIdleStopTimer();

    return new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pendingWorkerRequests.delete(id);
        resolve({ result: null, workerFailed: false });
      }, SOLVE_TIMEOUT_MS);

      this.pendingWorkerRequests.set(id, { resolve, timer });

      try {
        this.worker?.stdin.write(`${JSON.stringify({ id, type: "solve", payload })}\n`);
      } catch {
        clearTimeout(timer);
        this.pendingWorkerRequests.delete(id);
        resolve({ result: null, workerFailed: true });
      }
    });
  }

  private async ensureWorker(): Promise<boolean> {
    if (this.worker && this.worker.exitCode === null && !this.worker.killed) {
      return true;
    }

    if (this.workerStarting) {
      return this.workerStarting;
    }

    const python = getPythonPath();
    if (!python) {
      return false;
    }

    this.workerStarting = new Promise((resolve) => {
      let settled = false;
      const settle = (ready: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        this.workerStarting = undefined;
        resolve(ready);
      };

      try {
        const proc = spawn(python, [WORKER_SCRIPT], {
          stdio: ["pipe", "pipe", "pipe"]
        });

        this.worker = proc;
        this.workerBuffer = "";

        proc.stdout.on("data", (chunk: Buffer) => {
          this.handleWorkerStdout(chunk);
        });

        proc.stderr.on("data", () => {
          // Keep the pipe drained; solver diagnostics are not part of the JSON protocol.
        });

        proc.once("spawn", () => settle(true));
        proc.once("error", () => {
          this.clearWorker(proc, true);
          settle(false);
        });
        proc.once("close", () => {
          this.clearWorker(proc, true);
        });
      } catch {
        settle(false);
      }
    });

    return this.workerStarting;
  }

  private handleWorkerStdout(chunk: Buffer): void {
    this.workerBuffer += chunk.toString("utf-8");

    while (true) {
      const newlineIndex = this.workerBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      const line = this.workerBuffer.slice(0, newlineIndex).trim();
      this.workerBuffer = this.workerBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      let message: WorkerResponse;
      try {
        message = JSON.parse(line) as WorkerResponse;
      } catch {
        continue;
      }

      if (message.type === "shutdown") {
        continue;
      }

      const id = message.id;
      if (!id) {
        continue;
      }

      const pending = this.pendingWorkerRequests.get(id);
      if (!pending) {
        continue;
      }

      clearTimeout(pending.timer);
      this.pendingWorkerRequests.delete(id);
      pending.resolve({
        result: message.ok && !message.error ? message.result ?? null : null,
        workerFailed: false
      });
    }
  }

  private clearWorker(proc: ChildProcessWithoutNullStreams, failed: boolean): void {
    if (this.worker !== proc) {
      return;
    }

    this.worker = undefined;
    this.workerBuffer = "";
    this.clearIdleStopTimer();

    for (const [id, pending] of this.pendingWorkerRequests) {
      clearTimeout(pending.timer);
      this.pendingWorkerRequests.delete(id);
      pending.resolve({ result: null, workerFailed: failed });
    }
  }

  private scheduleIdleStop(): void {
    this.clearIdleStopTimer();
    if (!this.worker || WORKER_IDLE_STOP_MS <= 0) {
      void this.stopWorker();
      return;
    }

    this.idleStopTimer = setTimeout(() => {
      void this.stopWorker();
    }, WORKER_IDLE_STOP_MS);
    this.idleStopTimer.unref?.();
  }

  private clearIdleStopTimer(): void {
    if (!this.idleStopTimer) {
      return;
    }
    clearTimeout(this.idleStopTimer);
    this.idleStopTimer = undefined;
  }

  private async stopWorker(): Promise<void> {
    this.clearIdleStopTimer();

    const proc = this.worker;
    if (!proc) {
      return;
    }

    this.worker = undefined;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill();
        resolve();
      }, WORKER_STOP_GRACE_MS);

      proc.once("close", () => {
        clearTimeout(timer);
        resolve();
      });

      try {
        proc.stdin.write(`${JSON.stringify({ id: randomUUID(), type: "shutdown" })}\n`);
        proc.stdin.end();
      } catch {
        clearTimeout(timer);
        proc.kill();
        resolve();
      }
    });
  }
}

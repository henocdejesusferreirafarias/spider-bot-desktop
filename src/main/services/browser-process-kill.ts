import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// O user-data-dir precisa de um minimo de especificidade antes de virar filtro de
// kill. Um valor vazio/curto casaria com QUALQUER processo e reintroduziria o bug
// que este modulo existe para consertar (matar todos os navegadores da maquina).
const MIN_USER_DATA_DIR_LENGTH = 3;

export interface BrowserProcessInfo {
  pid: number;
  commandLine: string;
}

/**
 * Seleciona os PIDs cujo command line referencia o `userDataDir` do perfil.
 *
 * Cada perfil abre via `launchPersistentContext(storagePath)`, e TODO processo
 * daquele Chromium (principal + renderers/gpu/etc.) carrega `--user-data-dir=...`
 * na linha de comando. Filtrar por esse diretorio isola o processo-arvore de um
 * unico perfil sem tocar nos demais.
 *
 * Puro e fail-safe: um `userDataDir` vazio/curto retorna `[]` (nao mata nada) em
 * vez de casar com todos os processos.
 */
export function selectPidsForUserDataDir(
  processes: BrowserProcessInfo[],
  userDataDir: string
): number[] {
  if (!userDataDir || userDataDir.trim().length < MIN_USER_DATA_DIR_LENGTH) {
    return [];
  }
  // Paths no Windows sao case-insensitive; normalizamos os dois lados.
  const needle = userDataDir.toLowerCase();
  return processes
    .filter((proc) => proc.commandLine && proc.commandLine.toLowerCase().includes(needle))
    .map((proc) => proc.pid);
}

async function listBrowserProcesses(): Promise<BrowserProcessInfo[]> {
  // Get-CimInstance expoe o CommandLine (o tasklist nao). Cobrimos os dois nomes
  // de imagem possiveis: chrome.exe (build empacotado do Patchright) e
  // chromium.exe (snapshot baixado).
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='chromium.exe'\" " +
    "| Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script
  ]);
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  const parsed = JSON.parse(trimmed) as
    | { ProcessId: number; CommandLine: string | null }
    | Array<{ ProcessId: number; CommandLine: string | null }>;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({
    pid: row.ProcessId,
    commandLine: row.CommandLine ?? ""
  }));
}

/**
 * Mata SOMENTE a arvore de processos do navegador cujo `user-data-dir` casa com
 * `userDataDir`. Rede de seguranca para quando `context.close()` trava; substitui
 * o antigo `taskkill /IM chrome.exe` (machine-wide, que fechava todas as janelas
 * — e ate o Chrome pessoal do usuario). Windows-only; no-op nas outras plataformas.
 */
export async function forceKillProfileBrowser(userDataDir: string): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }
  if (!userDataDir || userDataDir.trim().length < MIN_USER_DATA_DIR_LENGTH) {
    return;
  }
  const processes = await listBrowserProcesses().catch(() => [] as BrowserProcessInfo[]);
  const pids = selectPidsForUserDataDir(processes, userDataDir);
  await Promise.all(
    pids.map((pid) =>
      execFileAsync("taskkill", ["/F", "/PID", String(pid), "/T"]).catch(() => null)
    )
  );
}

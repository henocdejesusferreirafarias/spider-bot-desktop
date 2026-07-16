import { cpus } from "node:os";

// Semaforo assincrono simples (contagem justa/FIFO): limita quantas operacoes
// pesadas rodam ao mesmo tempo. Usado para ESCALONAR o lancamento de navegadores
// -- abrir N janegadores headed com GPU/WebGL de uma vez satura CPU/GPU/event-loop
// e faz os jogos "travarem carregando". Com o semaforo, as janelas sobem em ondas.
export class AsyncSemaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    // Pelo menos 1 permit -- 0/negativo travaria tudo.
    this.available = Math.max(1, Math.floor(permits));
  }

  get permits(): number {
    return this.available;
  }

  get pending(): number {
    return this.waiters.length;
  }

  // Adquire um permit. Resolve com uma funcao de release que devolve o permit
  // (idempotente: chamar duas vezes nao libera dois). Sempre libere num finally.
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return this.makeReleaser();
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    // Ao ser acordado, o permit ja foi transferido para este waiter em release().
    return this.makeReleaser();
  }

  private makeReleaser(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.release();
    };
  }

  private release(): void {
    const nextWaiter = this.waiters.shift();
    if (nextWaiter) {
      // Transfere o permit direto para o proximo da fila (mantem a contagem
      // consistente e evita corrida entre release e um acquire concorrente).
      nextWaiter();
      return;
    }
    this.available += 1;
  }
}

// Limite padrao de lancamentos simultaneos de navegador. Jogos Cocos/WebGL headed
// sao pesados em GPU; o gargalo no pico e a abertura em massa. Deriva do numero de
// nucleos (deixando folga p/ o processo main/Electron) e e sobrescrivivel por env
// para operadores ajustarem a maquina-alvo sem rebuild.
export function resolveMaxConcurrentLaunches(
  env: Record<string, string | undefined> = process.env,
  cpuCount: number = cpus().length
): number {
  const raw = env.SPIDER_MAX_CONCURRENT_LAUNCHES;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.min(parsed, 64);
    }
  }
  const cores = Number.isFinite(cpuCount) && cpuCount > 0 ? Math.floor(cpuCount) : 4;
  // clamp(cores - 1, 2, 4): maquinas fracas abrem de 2 em 2; nunca mais que 4
  // launches pesados concorrentes por padrao.
  return Math.max(2, Math.min(cores - 1, 4));
}

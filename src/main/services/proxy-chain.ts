import { Server as ProxyChainServer } from "proxy-chain";

export type ProxyChainUpstreamProtocol = "http" | "https" | "socks5";

export interface ProxyChainOptions {
  upstreamProtocol?: ProxyChainUpstreamProtocol;
  upstreamHost: string;
  upstreamPort: number;
  username?: string;
  password?: string;
}

export interface ProxyTunnelFailure {
  statusCode?: number;
  statusMessage: string;
  headers: Record<string, string | string[] | undefined>;
}

export class ProxyChainService {
  private readonly upstreamUrl: string;
  private server: ProxyChainServer | undefined;
  private port: number | null = null;
  private tunnelFailure: ProxyTunnelFailure | undefined;

  constructor(options: ProxyChainOptions) {
    this.upstreamUrl = buildUpstreamProxyUrl(options);
  }

  async start(): Promise<number> {
    if (this.port !== null) {
      return this.port;
    }

    const server = new ProxyChainServer({
      port: 0,
      host: "127.0.0.1",
      // Diagnostico opt-in: SPIDER_PROXY_VERBOSE=1 faz o proxy-chain logar o caminho
      // usado (chainSocks/forward), erros de socket origem/destino e motivos de
      // fechamento do tunel no terminal. Util para investigar ERR_CONNECTION_CLOSED.
      verbose: process.env.SPIDER_PROXY_VERBOSE === "1",
      prepareRequestFunction: () => ({
        requestAuthentication: false,
        upstreamProxyUrl: this.upstreamUrl,
        ignoreUpstreamProxyCertificate: true
      })
    });
    server.on("tunnelConnectFailed", ({ response }: { response?: { statusCode?: number; statusMessage?: string; headers?: Record<string, string | string[] | undefined> } }) => {
      this.tunnelFailure = {
        statusCode: response?.statusCode,
        statusMessage: response?.statusMessage ?? "",
        headers: response?.headers ?? {}
      };
    });

    await server.listen();
    this.server = server;
    this.port = server.port;
    return server.port;
  }

  get localPort(): number {
    if (this.port === null) {
      throw new Error("ProxyChainService has not been started");
    }
    return this.port;
  }

  get localUrl(): string {
    return `http://127.0.0.1:${this.localPort}`;
  }

  get lastTunnelFailure(): ProxyTunnelFailure | undefined {
    return this.tunnelFailure;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = null;
    await server?.close(true);
  }
}

function buildUpstreamProxyUrl(options: ProxyChainOptions): string {
  const protocol = normalizeUpstreamProtocol(options);
  const url = new URL(`${protocol}://${options.upstreamHost}:${options.upstreamPort}`);
  if (options.username) {
    url.username = options.username;
  }
  if (options.password) {
    url.password = options.password;
  }
  return url.toString();
}

function normalizeUpstreamProtocol(options: ProxyChainOptions): ProxyChainUpstreamProtocol {
  const protocol = options.upstreamProtocol ?? "http";
  if (protocol === "https" && isDataImpulseHttpGateway(options.upstreamHost, options.upstreamPort)) {
    return "http";
  }
  return protocol;
}

function isDataImpulseHttpGateway(host: string, port: number): boolean {
  return port === 823 && /(?:^|\.)dataimpulse\.com$/i.test(host.trim());
}

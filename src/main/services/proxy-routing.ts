import { createHash } from "node:crypto";
import type { ProxyConfig } from "../../shared/contracts.js";

// Default voltado a gateways estilo DataImpulse (separador `;sessid.`).
export const DEFAULT_ROTATING_USERNAME_SUFFIX_TEMPLATE = ";sessid.{profileId}";
// NaProxy separa os parametros do usuario por UNDERSCORE, nao por traco. O
// formato oficial e `proxy-<id>_area-<pais>_state-<estado>_session-<id>_life-<min>`
// (confirmado na doc/exemplo: `proxy-A12345678_area-US_state-alabama`). O traco
// faz parte do *valor* de cada parametro (ex.: `area-US`), entao um sufixo com
// `-session-` era lido como parte do nome do sub-user -> username invalido: a
// NaProxy aceitava o handshake SOCKS5 e o CONNECT, mas FECHAVA o canal de dados
// sem trafegar nada (target->client=0B -> ERR_CONNECTION_CLOSED no browser). O
// separador correto e `_`, fixando o IP por sessao sticky. `_life-` usa minutos;
// 1440 e o limite de 24 horas oferecido pela NaProxy. Sem esse token, a sessao
// pode expirar rapidamente (inclusive enquanto a janela ainda esta aberta).
export const DEFAULT_NAPROXY_STICKY_LIFE_MINUTES = 1440;
export const DEFAULT_NAPROXY_USERNAME_SUFFIX_TEMPLATE =
  `_session-{profileId}_life-${DEFAULT_NAPROXY_STICKY_LIFE_MINUTES}`;

const NAPROXY_HOST_PATTERN = /(?:^|\.)naproxy\.(?:net|com|io)$/i;

export interface BuildProxyUsernameOptions {
  profileId: string;
  mode: ProxyConfig["mode"];
  usernameSuffixTemplate?: string;
  // Host do upstream: usado para escolher o template padrao por provedor quando
  // nenhum `usernameSuffixTemplate` explicito foi configurado para o proxy.
  host?: string;
}

// Detecta um token de sessao sticky ja presente no usuario, em qualquer das
// sintaxes que suportamos (`;sessid.` da DataImpulse ou `_session-` da NaProxy),
// para nao duplicar o sufixo quando o usuario ja o traz embutido.
const SESSION_TOKEN_PATTERN = /(?:[;]sessid\.|_session-)[^;@\s/]+/i;
const NAPROXY_SESSION_TOKEN_PATTERN = /_session-/i;
const NAPROXY_LIFE_TOKEN_PATTERN = /_life-[^_\s@/;]+/i;

function isNaProxyHost(host?: string): boolean {
  return NAPROXY_HOST_PATTERN.test(host?.trim().toLowerCase() ?? "");
}

export function resolveDefaultSuffixTemplate(host?: string): string {
  if (isNaProxyHost(host)) {
    return DEFAULT_NAPROXY_USERNAME_SUFFIX_TEMPLATE;
  }
  return DEFAULT_ROTATING_USERNAME_SUFFIX_TEMPLATE;
}

function buildStableProxySessionId(profileId: string): string {
  return createHash("sha256").update(profileId).digest("hex").slice(0, 20);
}

export function buildProxyUsername(
  baseUsername: string | undefined,
  options: BuildProxyUsernameOptions
): string {
  const username = baseUsername?.trim() ?? "";

  if (options.mode !== "rotating-residential") {
    return username;
  }

  if (!username) {
    return username;
  }

  if (SESSION_TOKEN_PATTERN.test(username)) {
    // Um login NaProxy pode vir do painel ja com `_session-...`. Nesse caso nao
    // duplicamos a sessao, mas ainda completamos a duracao sticky quando ausente.
    if (
      isNaProxyHost(options.host) &&
      NAPROXY_SESSION_TOKEN_PATTERN.test(username) &&
      !NAPROXY_LIFE_TOKEN_PATTERN.test(username)
    ) {
      return `${username}_life-${DEFAULT_NAPROXY_STICKY_LIFE_MINUTES}`;
    }
    return username;
  }

  const template = options.usernameSuffixTemplate?.trim() || resolveDefaultSuffixTemplate(options.host);

  if (!template.includes("{profileId}")) {
    return `${username}${template}`;
  }

  return `${username}${template.replace(/\{profileId\}/g, buildStableProxySessionId(options.profileId))}`;
}

export function previewProxyUsername(
  baseUsername: string | undefined,
  options: BuildProxyUsernameOptions
): string {
  return buildProxyUsername(baseUsername, options);
}

import { useEffect, useMemo, useState } from "react";
import type { ProxyConfig, ProxyDraft } from "../../shared/contracts.js";
import { Modal } from "./Modal.js";

type ProxyProtocol = ProxyDraft["protocol"];

interface ParsedProxyUrl {
  host: string;
  password?: string;
  port: number;
  protocol: ProxyProtocol;
  raw: string;
  username?: string;
}

interface ProxyParseResult {
  error?: string;
  line: number;
  proxy?: ParsedProxyUrl;
  raw: string;
}

const SUPPORTED_PROTOCOLS = new Set<ProxyProtocol>(["http", "https", "socks5"]);

function decodeProxyPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeProtocol(value?: string): ProxyProtocol | undefined {
  const protocol = value?.replace(/:$/, "").trim().toLowerCase();
  return SUPPORTED_PROTOCOLS.has(protocol as ProxyProtocol) ? (protocol as ProxyProtocol) : undefined;
}

function parsePort(value: string): number | undefined {
  if (!/^\d+$/.test(value.trim())) {
    return undefined;
  }

  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

function stripUrlProtocol(input: string): { body: string; protocol?: ProxyProtocol } {
  const match = input.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (!match) {
    return { body: input };
  }

  return {
    body: input.slice(match[0]?.length ?? 0),
    protocol: normalizeProtocol(match[1])
  };
}

function parseStandardProxyUrl(input: string): ParsedProxyUrl | undefined {
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `http://${input}`;

  try {
    const url = new URL(withProtocol);
    const protocol = normalizeProtocol(url.protocol);
    const port = parsePort(url.port);

    if (!protocol || !url.hostname || !port) {
      return undefined;
    }

    return {
      host: url.hostname.replace(/^\[(.*)]$/, "$1"),
      password: url.password ? decodeProxyPart(url.password) : undefined,
      port,
      protocol,
      raw: input,
      username: url.username ? decodeProxyPart(url.username) : undefined
    };
  } catch {
    return undefined;
  }
}

function parseAtFormat(input: string, fallbackProtocol?: ProxyProtocol): ParsedProxyUrl | undefined {
  const [credentials, endpoint] = input.split("@");
  if (!credentials || !endpoint || input.split("@").length !== 2) {
    return undefined;
  }

  const endpointParts = endpoint.split(":");
  const port = parsePort(endpointParts.at(-1) ?? "");
  const host = endpointParts.slice(0, -1).join(":").replace(/^\[(.*)]$/, "$1").trim();

  if (!host || !port) {
    return undefined;
  }

  const credentialParts = credentials.split(":");
  const username = credentialParts.shift()?.trim();
  const password = credentialParts.join(":");

  return {
    host,
    password: password ? decodeProxyPart(password) : undefined,
    port,
    protocol: fallbackProtocol ?? "http",
    raw: input,
    username: username ? decodeProxyPart(username) : undefined
  };
}

function parseCompactFormat(input: string, fallbackProtocol?: ProxyProtocol): ParsedProxyUrl | undefined {
  const pieces = input.split(":").map((piece) => piece.trim());
  if (pieces.length < 2) {
    return undefined;
  }

  const firstPort = parsePort(pieces[1] ?? "");
  if (firstPort && pieces[0]) {
    return {
      host: pieces[0],
      password: pieces.slice(3).join(":") || undefined,
      port: firstPort,
      protocol: fallbackProtocol ?? "http",
      raw: input,
      username: pieces[2] ? decodeProxyPart(pieces[2]) : undefined
    };
  }

  const lastPort = parsePort(pieces[3] ?? "");
  if (lastPort && pieces[2]) {
    return {
      host: pieces[2],
      password: pieces[1] ? decodeProxyPart(pieces[1]) : undefined,
      port: lastPort,
      protocol: fallbackProtocol ?? "http",
      raw: input,
      username: pieces[0] ? decodeProxyPart(pieces[0]) : undefined
    };
  }

  return undefined;
}

function parseProxyLine(raw: string, line: number): ProxyParseResult {
  const input = raw.trim();
  if (!input) {
    return { line, raw };
  }

  const standard = parseStandardProxyUrl(input);
  if (standard) {
    return { line, proxy: standard, raw };
  }

  const stripped = stripUrlProtocol(input);
  const parsed = parseAtFormat(stripped.body, stripped.protocol) ?? parseCompactFormat(stripped.body, stripped.protocol);
  if (parsed) {
    return { line, proxy: parsed, raw };
  }

  return {
    error: "Formato invalido. Use protocolo://usuario:senha@host:porta ou host:porta:usuario:senha.",
    line,
    raw
  };
}

function parseProxyInput(input: string): ProxyParseResult[] {
  return input
    .split(/\r?\n/)
    .map((line, index) => parseProxyLine(line, index + 1))
    .filter((result) => result.raw.trim());
}

function formatProxyUrl(proxy: ProxyConfig): string {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}${proxy.password ? `:${encodeURIComponent(proxy.password)}` : ""}@`
    : "";
  const host = proxy.host.includes(":") && !proxy.host.startsWith("[") ? `[${proxy.host}]` : proxy.host;
  return `${proxy.protocol}://${auth}${host}:${proxy.port}`;
}

function buildProxyLabel(parsed: ParsedProxyUrl, index: number, existingLabel?: string): string {
  if (existingLabel?.trim()) {
    return existingLabel.trim();
  }

  return `Proxy ${index + 1} - ${parsed.host}:${parsed.port}`;
}

function buildProxyDraft(parsed: ParsedProxyUrl, index: number, proxy?: ProxyConfig): ProxyDraft {
  const mode = parsed.username ? "rotating-residential" : "static";
  return {
    label: buildProxyLabel(parsed, index, proxy?.label),
    protocol: parsed.protocol,
    host: parsed.host,
    port: parsed.port,
    username: parsed.username ?? "",
    password: parsed.password ?? "",
    mode,
    usernameSuffixTemplate: proxy?.usernameSuffixTemplate,
    notes: proxy?.notes
  };
}

export function ProxyEditorModal({
  open,
  proxy,
  busy,
  onClose,
  onSubmit
}: {
  open: boolean;
  proxy?: ProxyConfig;
  busy?: boolean;
  onClose: () => void;
  onSubmit: (drafts: ProxyDraft[]) => Promise<unknown>;
}) {
  const [proxyInput, setProxyInput] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setProxyInput(proxy ? formatProxyUrl(proxy) : "");
      setError("");
      setSubmitting(false);
    }
  }, [open, proxy]);

  const parseResults = useMemo(() => parseProxyInput(proxyInput), [proxyInput]);
  const validResults = parseResults.filter((result): result is ProxyParseResult & { proxy: ParsedProxyUrl } =>
    Boolean(result.proxy)
  );
  const invalidResults = parseResults.filter((result) => result.error);
  const editing = Boolean(proxy);
  const canSubmit = validResults.length > 0 && invalidResults.length === 0 && (!editing || validResults.length === 1);

  const submit = async () => {
    setError("");
    if (!canSubmit) {
      setError(editing && validResults.length > 1 ? "Edicao aceita apenas uma URL de proxy." : "Revise as linhas invalidas antes de salvar.");
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(validResults.map((result, index) => buildProxyDraft(result.proxy, index, proxy)));
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nao foi possivel salvar os proxies.");
    } finally {
      setSubmitting(false);
    }
  };

  const textareaRows = editing ? 4 : 9;

  return (
    <Modal
      footer={
        <>
          <button className="ghost-button" onClick={onClose} type="button">
            Cancelar
          </button>
          <button
            className="primary-button"
            disabled={busy || submitting || !canSubmit}
            onClick={() => void submit()}
            type="button"
          >
            {submitting
              ? "Salvando..."
              : editing
                ? "Salvar proxy"
                : validResults.length > 1
                  ? `Criar ${validResults.length} proxies`
                  : "Criar proxy"}
          </button>
        </>
      }
      onClose={onClose}
      open={open}
      subtitle="Cole uma URL por linha. Credenciais ficam protegidas no banco local."
      title={editing ? "Editar proxy" : "Novo proxy"}
    >
      <div className="modal-form-grid proxy-url-form">
        <label className="span-2">
          <span>{editing ? "URL do proxy" : "URLs dos proxies"}</span>
          <textarea
            autoFocus
            onChange={(event) => {
              setProxyInput(event.target.value);
              setError("");
            }}
            placeholder={[
              "http://usuario:senha@proxy.exemplo.com:8080",
              "socks5://usuario:senha@1.2.3.4:1080",
              "proxy.exemplo.com:8080:usuario:senha",
              "usuario:senha:proxy.exemplo.com:8080"
            ].join("\n")}
            rows={textareaRows}
            value={proxyInput}
          />
        </label>

        {parseResults.length ? (
          <div className="span-2 proxy-preview">
            <span>Reconhecimento</span>
            {parseResults.map((result) => (
              <code className={result.error ? "danger" : ""} key={`${result.line}-${result.raw}`}>
                Linha {result.line}:{" "}
                {result.proxy
                  ? `${result.proxy.protocol}://${result.proxy.username ? `${result.proxy.username}:***@` : ""}${result.proxy.host}:${result.proxy.port}`
                  : result.error}
              </code>
            ))}
          </div>
        ) : null}

        {error || invalidResults.length ? (
          <p className="modal-error span-2">
            {error || `Linha ${invalidResults[0]?.line ?? ""}: ${invalidResults[0]?.error ?? "Formato invalido."}`}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

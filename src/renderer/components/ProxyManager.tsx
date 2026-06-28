import { useState } from "react";
import type { ProxyConfig } from "../../shared/contracts.js";
import { formatRelativeTime } from "../lib/format.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { Icon } from "./Icon.js";

export type ProxyModalTab = "proxy-create" | "proxy-edit";

const PROXY_MODE_LABEL: Record<ProxyConfig["mode"], string> = {
  static: "Estatico",
  "rotating-residential": "Rotativo"
};

const PROXY_STATUS_LABEL: Record<ProxyConfig["status"], string> = {
  degraded: "Instavel",
  healthy: "Online",
  offline: "Offline",
  unknown: "Nao testado"
};

function proxyStatusTone(status: ProxyConfig["status"]): "success" | "warning" | "danger" | "neutral" {
  if (status === "healthy") return "success";
  if (status === "offline") return "danger";
  if (status === "degraded") return "warning";
  return "neutral";
}

function formatProxyTestTime(value?: string): string {
  return value ? formatRelativeTime(value) : "Nunca";
}

export function ProxyManager({
  proxies,
  busyAction,
  onCreateClick,
  onEdit,
  onDelete,
  onTest
}: {
  proxies: ProxyConfig[];
  busyAction?: string;
  onCreateClick: () => void;
  onEdit: (proxy: ProxyConfig) => void;
  onDelete: (proxyId: string) => Promise<unknown>;
  onTest: (proxyId: string) => Promise<unknown>;
}) {
  const [deleteTarget, setDeleteTarget] = useState<ProxyConfig>();

  return (
    <div className="manager-stack">
      <div className="manager-toolbar">
        <span>{proxies.length} proxy(s) cadastrados</span>
        <div className="manager-toolbar-actions">
          <button className="primary-button" onClick={onCreateClick} type="button">
            <Icon name="plus" size={14} />
            Novo proxy
          </button>
        </div>
      </div>

      <div className="table-wrap">
        <table className="profiles-table proxy-table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Endereco</th>
              <th>Usuario</th>
              <th>Modo</th>
              <th>Status</th>
              <th>Ultimo teste</th>
              <th>Acoes</th>
            </tr>
          </thead>
          <tbody>
            {proxies.map((proxy) => (
              <tr key={proxy.id}>
                <td><strong>{proxy.label}</strong></td>
                <td className="token">{proxy.protocol}://{proxy.host}:{proxy.port}</td>
                <td>{proxy.username || <span className="token">—</span>}</td>
                <td>
                  <span className={`status-pill ${proxy.mode === "rotating-residential" ? "success" : "neutral"}`}>
                    {PROXY_MODE_LABEL[proxy.mode]}
                  </span>
                </td>
                <td>
                  <span className={`status-pill ${proxyStatusTone(proxy.status)}`}>
                    {PROXY_STATUS_LABEL[proxy.status]}
                  </span>
                </td>
                <td>{formatProxyTestTime(proxy.lastCheckedAt)}</td>
                <td>
                  <div className="act-cell">
                    <button className="table-action-button" onClick={() => onEdit(proxy)} type="button">
                      Editar
                    </button>
                    <button
                      className="table-action-button"
                      disabled={busyAction === `proxy:test:${proxy.id}`}
                      onClick={() => void onTest(proxy.id)}
                      type="button"
                    >
                      {busyAction === `proxy:test:${proxy.id}` ? "Testando..." : "Testar"}
                    </button>
                    <button
                      className="table-action-button danger"
                      onClick={() => setDeleteTarget(proxy)}
                      type="button"
                    >
                      Excluir
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!proxies.length ? (
              <tr>
                <td colSpan={7}>
                  <div className="empty-state inline" style={{ minHeight: 88 }}>
                    <Icon name="proxies" size={18} />
                    <p>Nenhum proxy ainda. Cadastre um endpoint para vincular aos perfis.</p>
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        busy={busyAction === `proxy:delete:${deleteTarget?.id}`}
        confirmLabel="Sim, excluir proxy"
        message={`O proxy "${deleteTarget?.label ?? ""}" sera removido. Perfis vinculados ficarao sem proxy.`}
        onCancel={() => setDeleteTarget(undefined)}
        onConfirm={() => {
          if (deleteTarget) void onDelete(deleteTarget.id);
          setDeleteTarget(undefined);
        }}
        open={Boolean(deleteTarget)}
        title="Excluir proxy"
      />
    </div>
  );
}

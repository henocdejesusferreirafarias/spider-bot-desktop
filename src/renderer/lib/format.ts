export function formatRelativeTime(value?: string): string {
  if (!value) {
    return "Never";
  }

  const target = new Date(value).getTime();
  const diffMinutes = Math.round((Date.now() - target) / 60000);

  if (diffMinutes < 1) {
    return "just now";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

export function titleCase(value: string): string {
  return value
    .split(/[\s-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function profileStatusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  switch (status) {
    case "active":
      return "success";
    case "running-automation":
    case "launching":
      return "info";
    case "stopping":
      return "warning";
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}

const PROFILE_STATUS_LABELS: Record<string, string> = {
  idle: "Parada",
  launching: "Iniciando",
  active: "Rodando",
  stopping: "Parando",
  "running-automation": "Em automação",
  error: "Erro"
};

export function profileStatusLabel(status: string): string {
  return PROFILE_STATUS_LABELS[status] ?? titleCase(status);
}

const PLAN_TYPE_LABELS: Record<string, string> = {
  daily: "Diário",
  monthly: "Mensal",
  lifetime: "Vitalício"
};

export function planTypeLabel(planType: string | undefined): string {
  if (!planType) return "—";
  return PLAN_TYPE_LABELS[planType] ?? titleCase(planType);
}

const LICENSE_STATUS_LABELS: Record<string, string> = {
  unlicensed: "Não ativada",
  active: "Ativa",
  expired: "Expirada",
  revoked: "Revogada",
  device_mismatch: "Outro dispositivo",
  offline_expired: "Tolerância expirada",
  invalid: "Inválida",
  network_error: "Erro de rede",
  update_required: "Atualizacao exigida"
};

const LICENSE_STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  active: "success",
  expired: "warning",
  device_mismatch: "warning",
  network_error: "info",
  update_required: "warning",
  offline_expired: "danger",
  revoked: "danger",
  invalid: "danger",
  unlicensed: "neutral"
};

export function licenseStatusLabel(status: string): string {
  return LICENSE_STATUS_LABELS[status] ?? titleCase(status);
}

export function licenseStatusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  return LICENSE_STATUS_TONE[status] ?? "neutral";
}

export function formatDateTime(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

/*
 * Formato compacto para a tabela "Contas": hora antes da data, sem segundos e
 * sem ano (a tabela lista contas recentes; o ano economiza ~3 chars por linha
 * e ajuda na largura da coluna). Ex.: "13h45 16/06".
 * O ano continua acessivel via `title=` na <td>, que recebe o ISO original.
 */
export function formatTimeFirstDate(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const time = date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false }).replace(":", "h");
  const dateStr = date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  return `${time} ${dateStr}`;
}

import type { PixPhoneKeyStatus } from "../../shared/contracts.js";

const PIX_KEY_STATUS_LABEL: Record<PixPhoneKeyStatus, string> = {
  available: "Disponível",
  reserved: "Em cadastro",
  pending_confirmation: "Aguardando confirmação",
  rejected: "Recusada",
  used: "Cadastrada",
};

export function pixKeyStatusLabel(status: PixPhoneKeyStatus): string {
  return PIX_KEY_STATUS_LABEL[status];
}

export function canEditPixKey(status: PixPhoneKeyStatus): boolean {
  return status === "available";
}

export function canDeletePixKey(status: PixPhoneKeyStatus): boolean {
  return status === "available" || status === "rejected";
}

export const canManagePixKey = canEditPixKey;

export function countAvailablePixKeys(statuses: readonly PixPhoneKeyStatus[]): number {
  return statuses.filter((status) => status === "available").length;
}

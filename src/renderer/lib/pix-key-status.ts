import type { PixPhoneKeyStatus } from "../../shared/contracts.js";

const PIX_KEY_STATUS_LABEL: Record<PixPhoneKeyStatus, string> = {
  available: "Disponível",
  reserved: "Em cadastro",
  pending_confirmation: "Aguardando confirmação",
  used: "Cadastrada",
};

export function pixKeyStatusLabel(status: PixPhoneKeyStatus): string {
  return PIX_KEY_STATUS_LABEL[status];
}

export function canManagePixKey(status: PixPhoneKeyStatus): boolean {
  return status === "available";
}

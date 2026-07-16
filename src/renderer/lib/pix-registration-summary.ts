import type { PixKeyRegistrationControlResult } from "../../shared/contracts.js";

export function summarizePixRegistrationResults(results: PixKeyRegistrationControlResult[]): string {
  const completed = results.filter(
    (result) => result.status === "pix_key_registered" || result.status === "pix_already_registered"
  ).length;
  const pendingConfirmation = results.filter((result) => result.status === "pix_key_pending_confirmation").length;
  const reviewRequired = results.filter(
    (result) => result.status === "pix_key_conflict" || result.status === "failed"
  ).length;
  const inProgress = results.length - completed - pendingConfirmation - reviewRequired;
  const parts = [
    completed > 0 ? `${completed} concluído${completed === 1 ? "" : "s"}` : undefined,
    pendingConfirmation > 0
      ? `${pendingConfirmation} aguardando confirmação`
      : undefined,
    reviewRequired > 0 ? `${reviewRequired} para revisão` : undefined,
    inProgress > 0 ? `${inProgress} em andamento` : undefined
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? `Cadastro PIX: ${parts.join(" · ")}` : "Cadastro PIX concluído.";
}

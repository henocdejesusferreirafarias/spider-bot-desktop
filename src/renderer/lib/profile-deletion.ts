import type {
  ProfileDeletionProgress,
  ProfileDeletionResult
} from "../../shared/contracts.js";

export function formatProfileDeletionProgress(
  progress: ProfileDeletionProgress
): string {
  return `Excluindo ${progress.completed} de ${progress.total}...`;
}

export function failedProfileIds(result: ProfileDeletionResult): string[] {
  return result.items
    .filter((item) => item.status === "failed")
    .map((item) => item.profileId);
}

export function describeProfileDeletionFailures(
  result: ProfileDeletionResult
): string | undefined {
  const failures = result.items.filter((item) => item.status === "failed");
  if (failures.length === 0) return undefined;

  const deletedLabel = `${result.deleted} ${result.deleted === 1 ? "perfil excluido" : "perfis excluidos"}`;
  const failedLabel = `${result.failed} ${result.failed === 1 ? "perfil nao foi excluido" : "perfis nao foram excluidos"}`;
  const details = failures
    .map((item) => `${item.profileName}: ${item.reason ?? "erro desconhecido"}`)
    .join("\n");
  return `${deletedLabel}. ${failedLabel}.\n\n${details}`;
}

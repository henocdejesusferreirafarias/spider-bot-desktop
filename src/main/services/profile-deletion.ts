import type {
  ProfileDeletionItemResult,
  ProfileDeletionProgress,
  ProfileDeletionResult
} from "../../shared/contracts.js";

export type {
  ProfileDeletionItemResult,
  ProfileDeletionProgress,
  ProfileDeletionResult
} from "../../shared/contracts.js";

export interface ProfileDeletionDependencies {
  getProfileName: (profileId: string) => string | undefined;
  isProfileActive: (profileId: string) => boolean;
  stopProfile: (profileId: string) => Promise<void>;
  deleteProfile: (profileId: string) => Promise<void>;
  onProgress?: (progress: ProfileDeletionProgress) => void;
}

export const PROFILE_NOT_FOUND_REASON = "Perfil nao encontrado.";

export function getSingleProfileDeletionError(
  result: ProfileDeletionResult
): string | undefined {
  const item = result.items[0];
  if (!item) return "Nao foi possivel excluir o perfil.";
  if (item.status === "deleted" || item.reason === PROFILE_NOT_FOUND_REASON) {
    return undefined;
  }
  return item.reason ?? "Nao foi possivel excluir o perfil.";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function deleteProfilesWithConcurrency(
  profileIds: string[],
  dependencies: ProfileDeletionDependencies,
  concurrency = 2
): Promise<ProfileDeletionResult> {
  const uniqueProfileIds = [...new Set(profileIds)];
  const items = new Array<ProfileDeletionItemResult>(uniqueProfileIds.length);
  const workerCount = Math.min(
    uniqueProfileIds.length,
    Math.max(1, Math.floor(concurrency))
  );
  let nextIndex = 0;
  let completed = 0;
  let deleted = 0;
  let failed = 0;

  const reportProgress = () => {
    dependencies.onProgress?.({
      total: uniqueProfileIds.length,
      completed,
      deleted,
      failed
    });
  };

  const runWorker = async () => {
    while (nextIndex < uniqueProfileIds.length) {
      const index = nextIndex;
      nextIndex += 1;
      const profileId = uniqueProfileIds[index];
      if (!profileId) continue;

      let profileName = profileId;
      try {
        const resolvedProfileName = dependencies.getProfileName(profileId);
        if (!resolvedProfileName) {
          items[index] = {
            profileId,
            profileName,
            status: "failed",
            reason: PROFILE_NOT_FOUND_REASON
          };
          failed += 1;
          completed += 1;
          reportProgress();
          continue;
        }
        profileName = resolvedProfileName;
        if (dependencies.isProfileActive(profileId)) {
          await dependencies.stopProfile(profileId);
        }
        await dependencies.deleteProfile(profileId);
        items[index] = {
          profileId,
          profileName,
          status: "deleted"
        };
        deleted += 1;
      } catch (error) {
        items[index] = {
          profileId,
          profileName,
          status: "failed",
          reason: describeError(error)
        };
        failed += 1;
      }

      completed += 1;
      reportProgress();
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return {
    total: uniqueProfileIds.length,
    completed,
    deleted,
    failed,
    items
  };
}

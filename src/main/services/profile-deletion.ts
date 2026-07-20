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

      const profileName = dependencies.getProfileName(profileId);
      if (!profileName) {
        items[index] = {
          profileId,
          profileName: profileId,
          status: "failed",
          reason: "Perfil nao encontrado."
        };
        failed += 1;
        completed += 1;
        reportProgress();
        continue;
      }

      try {
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

import {
  NAVIGATION_MODE_LAUNCH_ARG_PREFIX,
  type NavigationMode,
  type ProfileSummary,
} from "../../shared/contracts.js";

interface ReusableProfileRequest {
  homeUrl: string;
  navigationMode: NavigationMode;
  proxyId?: string;
  claimedProfileIds?: ReadonlySet<string>;
}

function canonicalizeProfileUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

function profileNavigationMode(profile: ProfileSummary): NavigationMode | undefined {
  const argument = profile.persona.launchArgs.find((value) =>
    value.startsWith(NAVIGATION_MODE_LAUNCH_ARG_PREFIX),
  );
  const mode = argument?.slice(NAVIGATION_MODE_LAUNCH_ARG_PREFIX.length);
  return mode === "desktop" || mode === "mobile-ios-android" ? mode : undefined;
}

function profileRecency(profile: ProfileSummary): number {
  const value = profile.lastLaunchedAt ?? profile.updatedAt ?? profile.createdAt;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Reuses only a stopped automatic profile with the same isolation settings.
 * Its persistent storage is what keeps cookies/localStorage between launches.
 */
export function selectReusableAutomaticProfile(
  profiles: readonly ProfileSummary[],
  request: ReusableProfileRequest,
): ProfileSummary | undefined {
  const requestedUrl = canonicalizeProfileUrl(request.homeUrl);

  return profiles
    .filter(
      (profile) =>
        profile.status === "idle" &&
        !profile.archivedAt &&
        profile.tags.includes("auto") &&
        !request.claimedProfileIds?.has(profile.id) &&
        canonicalizeProfileUrl(profile.homeUrl) === requestedUrl &&
        profile.proxyId === request.proxyId &&
        profileNavigationMode(profile) === request.navigationMode,
    )
    .sort((left, right) => profileRecency(right) - profileRecency(left))[0];
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  NAVIGATION_MODE_LAUNCH_ARG_PREFIX,
  type NavigationMode,
  type ProfileSummary,
} from "../src/shared/contracts.js";
import { selectReusableAutomaticProfile } from "../src/renderer/lib/profile-reuse.js";

function profile(
  overrides: Partial<ProfileSummary> & Pick<ProfileSummary, "id">,
): ProfileSummary {
  const navigationMode: NavigationMode = "mobile-ios-android";
  return {
    id: overrides.id,
    name: "Auto Profile",
    codeName: "auto-profile",
    notes: "",
    status: "idle",
    storagePath: `/profiles/${overrides.id}`,
    homeUrl: "https://dashboard.example.com/",
    personaId: `persona-${overrides.id}`,
    tags: ["auto"],
    color: "#d6d6d6",
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
    persona: {
      id: `persona-${overrides.id}`,
      profileId: overrides.id,
      version: 1,
      name: "Automatic persona",
      userAgent: "",
      locale: "pt-BR",
      timezone: "America/Sao_Paulo",
      viewport: { width: 390, height: 844, deviceScaleFactor: 2.75 },
      geolocation: { latitude: 0, longitude: 0, accuracy: 0 },
      allowNotifications: true,
      allowClipboard: true,
      webRtcMode: "default",
      dnsMode: "system",
      leakProtection: "standard",
      headers: [],
      launchArgs: [`${NAVIGATION_MODE_LAUNCH_ARG_PREFIX}${navigationMode}`],
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-20T10:00:00.000Z",
    },
    automationCount: 1,
    ...overrides,
  };
}

test("reuses the most recently launched compatible automatic profile", () => {
  const older = profile({
    id: "older",
    lastLaunchedAt: "2026-10-21T10:00:00.000Z",
  });
  const newer = profile({
    id: "newer",
    homeUrl: "https://dashboard.example.com",
    lastLaunchedAt: "2026-10-22T10:00:00.000Z",
  });

  assert.equal(
    selectReusableAutomaticProfile([older, newer], {
      homeUrl: "https://dashboard.example.com",
      navigationMode: "mobile-ios-android",
    })?.id,
    "newer",
  );
});

test("keeps concurrently requested profiles isolated", () => {
  const reusable = profile({ id: "claimed" });

  assert.equal(
    selectReusableAutomaticProfile([reusable], {
      homeUrl: reusable.homeUrl,
      navigationMode: "mobile-ios-android",
      claimedProfileIds: new Set([reusable.id]),
    }),
    undefined,
  );
});

test("does not reuse profiles with incompatible runtime isolation", () => {
  const candidates = [
    profile({ id: "active", status: "active" }),
    profile({ id: "manual", tags: [] }),
    profile({ id: "proxy", proxyId: "proxy-1" }),
    profile({
      id: "desktop",
      persona: {
        ...profile({ id: "desktop-persona" }).persona,
        launchArgs: [`${NAVIGATION_MODE_LAUNCH_ARG_PREFIX}desktop`],
      },
    }),
    profile({ id: "other-url", homeUrl: "https://other.example.com" }),
  ];

  assert.equal(
    selectReusableAutomaticProfile(candidates, {
      homeUrl: "https://dashboard.example.com",
      navigationMode: "mobile-ios-android",
    }),
    undefined,
  );
});

test("matches the requested proxy exactly", () => {
  const proxied = profile({ id: "proxied", proxyId: "proxy-1" });

  assert.equal(
    selectReusableAutomaticProfile([proxied], {
      homeUrl: proxied.homeUrl,
      navigationMode: "mobile-ios-android",
      proxyId: "proxy-1",
    })?.id,
    proxied.id,
  );
});

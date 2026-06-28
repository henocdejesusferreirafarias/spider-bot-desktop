import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProxyUsername,
  previewProxyUsername
} from "../src/main/services/proxy-routing.js";

const PROFILE_ID = "11111111-2222-3333-4444-555555555555";
const SESSION_ID = "666ff6ccaa5b3c07feaa";

test("static mode returns the base username unchanged", () => {
  const result = buildProxyUsername("login__cr.us", {
    profileId: PROFILE_ID,
    mode: "static"
  });
  assert.equal(result, "login__cr.us");
});

test("static mode with no username returns empty string", () => {
  const result = buildProxyUsername(undefined, {
    profileId: PROFILE_ID,
    mode: "static"
  });
  assert.equal(result, "");
});

test("rotating-residential appends ;sessid.{profileId} by default (DataImpulse format)", () => {
  const result = buildProxyUsername("login__cr.us", {
    profileId: PROFILE_ID,
    mode: "rotating-residential"
  });
  assert.equal(result, `login__cr.us;sessid.${SESSION_ID}`);
  assert.ok(result.endsWith(`;sessid.${SESSION_ID}`));
});

test("rotating-residential default template uses the dot separator that residential gateways require", () => {
  const result = buildProxyUsername("login__cr.us", {
    profileId: PROFILE_ID,
    mode: "rotating-residential"
  });
  assert.doesNotMatch(result, /sessid=/);
  assert.match(result, /sessid\./);
});

test("rotating-residential does not duplicate ;sessid. when already present", () => {
  const result = buildProxyUsername("login__cr.us;sessid.abc123", {
    profileId: PROFILE_ID,
    mode: "rotating-residential"
  });
  assert.equal(result, "login__cr.us;sessid.abc123");
});

test("rotating-residential does not duplicate ;sessid. case-insensitively", () => {
  const result = buildProxyUsername("login__cr.us;SESSID.xyz", {
    profileId: PROFILE_ID,
    mode: "rotating-residential"
  });
  assert.equal(result, "login__cr.us;SESSID.xyz");
});

test("rotating-residential honors a custom usernameSuffixTemplate", () => {
  const result = buildProxyUsername("login__cr.us", {
    profileId: PROFILE_ID,
    mode: "rotating-residential",
    usernameSuffixTemplate: ";sessttl.10;sessid.{profileId}"
  });
  assert.equal(result, `login__cr.us;sessttl.10;sessid.${SESSION_ID}`);
});

test("rotating-residential with a template that lacks {profileId} appends it verbatim", () => {
  const result = buildProxyUsername("login__cr.us", {
    profileId: PROFILE_ID,
    mode: "rotating-residential",
    usernameSuffixTemplate: ";sessttl.10"
  });
  assert.equal(result, "login__cr.us;sessttl.10");
});

test("rotating-residential with empty base username returns empty string", () => {
  const result = buildProxyUsername("", {
    profileId: PROFILE_ID,
    mode: "rotating-residential"
  });
  assert.equal(result, "");
});

test("rotating-residential with a template that contains {profileId} multiple times substitutes all occurrences", () => {
  const result = buildProxyUsername("login", {
    profileId: PROFILE_ID,
    mode: "rotating-residential",
    usernameSuffixTemplate: ";sessid.{profileId}-group-{profileId}"
  });
  assert.equal(result, `login;sessid.${SESSION_ID}-group-${SESSION_ID}`);
});

test("previewProxyUsername mirrors buildProxyUsername", () => {
  const a = buildProxyUsername("login", {
    profileId: PROFILE_ID,
    mode: "rotating-residential"
  });
  const b = previewProxyUsername("login", {
    profileId: PROFILE_ID,
    mode: "rotating-residential"
  });
  assert.equal(a, b);
});

test("rotating-residential on a NaProxy host appends a 24-hour sticky session", () => {
  const result = buildProxyUsername("proxy-k8uo33pk9cn2", {
    profileId: PROFILE_ID,
    mode: "rotating-residential",
    host: "us.naproxy.net"
  });
  // NaProxy separa parametros por underscore: `-session-` (traco) seria lido como
  // parte do nome do sub-user e quebraria o roteamento (canal de dados fechado).
  assert.equal(result, `proxy-k8uo33pk9cn2_session-${SESSION_ID}_life-1440`);
  assert.doesNotMatch(result, /;sessid\./);
  assert.doesNotMatch(result, /-session-/);
});

test("rotating-residential on a NaProxy subdomain is detected case-insensitively", () => {
  const result = buildProxyUsername("proxy-k8uo33pk9cn2", {
    profileId: PROFILE_ID,
    mode: "rotating-residential",
    host: "GW.NAPROXY.COM"
  });
  assert.match(result, /_session-/);
  assert.match(result, /_life-1440$/);
});

test("NaProxy reuses the same sticky username when the same profile is reopened", () => {
  const options = {
    profileId: PROFILE_ID,
    mode: "rotating-residential" as const,
    host: "us.naproxy.net"
  };
  const firstLaunch = buildProxyUsername("proxy-k8uo33pk9cn2", options);
  const reopenedLaunch = buildProxyUsername("proxy-k8uo33pk9cn2", options);

  assert.equal(reopenedLaunch, firstLaunch);
  assert.equal(reopenedLaunch, `proxy-k8uo33pk9cn2_session-${SESSION_ID}_life-1440`);
});

test("rotating-residential keeps the DataImpulse default for non-NaProxy hosts", () => {
  const result = buildProxyUsername("login__cr.us", {
    profileId: PROFILE_ID,
    mode: "rotating-residential",
    host: "gw.dataimpulse.com"
  });
  assert.equal(result, `login__cr.us;sessid.${SESSION_ID}`);
});

test("rotating-residential completes an existing NaProxy session with the default lifetime", () => {
  const result = buildProxyUsername("proxy-k8uo33pk9cn2_session-abc123", {
    profileId: PROFILE_ID,
    mode: "rotating-residential",
    host: "us.naproxy.net"
  });
  assert.equal(result, "proxy-k8uo33pk9cn2_session-abc123_life-1440");
});

test("rotating-residential preserves an existing NaProxy session lifetime", () => {
  const result = buildProxyUsername("proxy-k8uo33pk9cn2_session-abc123_life-30", {
    profileId: PROFILE_ID,
    mode: "rotating-residential",
    host: "us.naproxy.net"
  });
  assert.equal(result, "proxy-k8uo33pk9cn2_session-abc123_life-30");
});

test("an explicit usernameSuffixTemplate overrides the NaProxy host default", () => {
  const result = buildProxyUsername("proxy-k8uo33pk9cn2", {
    profileId: PROFILE_ID,
    mode: "rotating-residential",
    host: "us.naproxy.net",
    usernameSuffixTemplate: "_session-{profileId}_life-30"
  });
  assert.equal(result, `proxy-k8uo33pk9cn2_session-${SESSION_ID}_life-30`);
});

test("Proxy-Authorization basic token preserves ;sessid. and profileId without URL-encoding", () => {
  const username = buildProxyUsername("login__cr.us", {
    profileId: PROFILE_ID,
    mode: "rotating-residential"
  });
  const password = "p4ssw0rd";
  const token = Buffer.from(`${username}:${password}`).toString("base64");
  const decoded = Buffer.from(token, "base64").toString("utf8");

  assert.equal(decoded, `${username}:${password}`);
  assert.match(decoded, /;sessid\./);
  assert.ok(decoded.includes(SESSION_ID));
});

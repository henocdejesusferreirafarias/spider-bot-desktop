import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { PredatorDatabase } from "../src/main/services/database.js";
import type { PredatorPaths } from "../src/main/services/paths.js";
import type { SecureStore } from "../src/main/services/secure-store.js";

const plainStore = {
  encrypt: (value?: string) => value,
  decrypt: (value?: string) => value
} as SecureStore;

function createPaths(): PredatorPaths {
  const root = mkdtempSync(join(tmpdir(), "spider-database-"));
  const profilesRoot = join(root, "profiles");
  const exportsRoot = join(root, "exports");
  const capturesRoot = join(root, "captures");
  mkdirSync(profilesRoot);
  mkdirSync(exportsRoot);
  mkdirSync(capturesRoot);
  return {
    appData: root,
    databaseFile: join(root, "predator.sqlite"),
    profilesRoot,
    exportsRoot,
    capturesRoot
  };
}

test("clearActivityLogs wipes activity rows and reports the count", () => {
  const db = new PredatorDatabase(createPaths(), plainStore);
  db.logActivity({
    id: "act-1",
    scope: "runtime",
    level: "info",
    message: "Browser launched.",
    createdAt: new Date().toISOString()
  });
  db.logActivity({
    id: "act-2",
    scope: "proxy",
    level: "warning",
    message: "Proxy degraded.",
    createdAt: new Date().toISOString()
  });

  assert.equal(db.listActivity().length >= 2, true);

  const removed = db.clearActivityLogs();
  assert.equal(removed >= 2, true);
  assert.equal(db.listActivity().length, 0);
});

test("clearRuns wipes automation_runs rows and reports the count", () => {
  const db = new PredatorDatabase(createPaths(), plainStore);
  const profile = db.createProfile({
    name: "Test Profile",
    notes: "",
    homeUrl: "https://example.com",
    tags: [],
    color: "#d6d6d6"
  });
  const automation = db.createAutomation({
    profileId: profile.id,
    kind: "account-registration"
  });
  const run = db.createRun(automation.id, profile.id);
  db.appendRunLog(run.id, {
    timestamp: new Date().toISOString(),
    level: "info",
    message: "Automation kicked off."
  });

  assert.equal(db.listRuns().length >= 1, true);

  const removed = db.clearRuns();
  assert.equal(removed >= 1, true);
  assert.equal(db.listRuns().length, 0);
});

test("appendRunLog buffers in memory and persists lazily on read", () => {
  const db = new PredatorDatabase(createPaths(), plainStore);
  const profile = db.createProfile({
    name: "Test Profile",
    notes: "",
    homeUrl: "https://example.com",
    tags: [],
    color: "#d6d6d6"
  });
  const automation = db.createAutomation({
    profileId: profile.id,
    kind: "account-registration"
  });
  const run = db.createRun(automation.id, profile.id);

  db.appendRunLog(run.id, { timestamp: new Date().toISOString(), level: "info", message: "primeira" });
  db.appendRunLog(run.id, { timestamp: new Date().toISOString(), level: "info", message: "segunda" });

  // getRun deve refletir os logs bufferizados (flush na leitura).
  const viaGetRun = db.getRun(run.id);
  assert.deepEqual(viaGetRun.logs.map((entry) => entry.message), ["primeira", "segunda"]);

  // listRuns (caminho do snapshot) tambem deve enxergar os logs.
  const viaList = db.listRuns().find((item) => item.id === run.id);
  assert.deepEqual(viaList?.logs.map((entry) => entry.message), ["primeira", "segunda"]);

  // Apos finalizar e bufferizar uma nova sessao, os logs continuam intactos.
  db.updateRun(run.id, { status: "succeeded", finishedAt: new Date().toISOString() });
  db.appendRunLog(run.id, { timestamp: new Date().toISOString(), level: "info", message: "terceira" });
  assert.deepEqual(
    db.getRun(run.id).logs.map((entry) => entry.message),
    ["primeira", "segunda", "terceira"]
  );
});

test("createProfile leaves the account phoneNumber empty so the automation must use a user-provided PIX key", () => {
  const db = new PredatorDatabase(createPaths(), plainStore);
  const profile = db.createProfile({
    name: "No Random Phone",
    notes: "",
    homeUrl: "https://example.com",
    tags: [],
    color: "#d6d6d6"
  });

  const account = db.getProfile(profile.id).account;
  assert.ok(account);
  assert.equal(account.phoneNumber, "");
  assert.equal(account.status, "generated");
});

test("reservePixPhoneKey returns undefined when no user-provided keys are available", () => {
  const db = new PredatorDatabase(createPaths(), plainStore);
  const profile = db.createProfile({
    name: "Empty Pix Pool",
    notes: "",
    homeUrl: "https://example.com",
    tags: [],
    color: "#d6d6d6"
  });

  const reserved = db.reservePixPhoneKey(profile.id, "run-empty");
  assert.equal(reserved, undefined);
});

test("reservePixPhoneKey returns a user-provided key when the pool has one and marks it as reserved", () => {
  const db = new PredatorDatabase(createPaths(), plainStore);
  const profile = db.createProfile({
    name: "With Pix Pool",
    notes: "",
    homeUrl: "https://example.com",
    tags: [],
    color: "#d6d6d6"
  });

  const imported = db.addPixPhoneKeys("11988887777");
  assert.equal(imported.created.length, 1);
  assert.equal(imported.invalid.length, 0);

  const reserved = db.reservePixPhoneKey(profile.id, "run-first");
  assert.ok(reserved);
  assert.equal(reserved.status, "reserved");
  assert.equal(reserved.phoneNumber, "11988887777");
  assert.equal(reserved.assignedProfileId, profile.id);

  const second = db.reservePixPhoneKey(profile.id, "run-first");
  assert.ok(second);
  assert.equal(second.id, reserved.id);
});

test("reabrir o banco libera uma reserva PIX vinculada a uma execucao interrompida", () => {
  const paths = createPaths();
  const db = new PredatorDatabase(paths, plainStore);
  const profile = db.createProfile({
    name: "Persistent Pix Reservation",
    notes: "",
    homeUrl: "https://example.com",
    tags: [],
    color: "#d6d6d6"
  });
  const secondProfile = db.createProfile({
    name: "Other Pix Reservation",
    notes: "",
    homeUrl: "https://example.com",
    tags: [],
    color: "#d6d6d6"
  });
  db.addPixPhoneKeys("11988887777\n11988886666");
  const reserved = db.reservePixPhoneKey(profile.id, "run-interrupted");
  assert.ok(reserved);
  db.close();

  const reopened = new PredatorDatabase(paths, plainStore);
  const otherReservation = reopened.reservePixPhoneKey(secondProfile.id, "run-next");
  assert.ok(otherReservation);
  assert.equal(otherReservation.id, reserved.id);
  const resumed = reopened.reservePixPhoneKey(profile.id, "run-resumed");

  assert.ok(resumed);
  assert.notEqual(resumed.id, reserved.id);
  assert.equal(resumed.status, "reserved");
  assert.equal(resumed.assignedProfileId, profile.id);
  reopened.close();
});

test("PIX key releases a run-scoped reservation after an unsubmitted failure", () => {
  const db = new PredatorDatabase(createPaths(), plainStore);
  const profile = db.createProfile({
    name: "Released Pix Reservation",
    notes: "",
    homeUrl: "https://example.com",
    tags: [],
    color: "#d6d6d6"
  });
  db.addPixPhoneKeys("11988887777");

  const key = db.reservePixPhoneKey(profile.id, "run-a");
  assert.equal(key?.status, "reserved");
  db.releasePixPhoneKeyReservation(key!.id, "run-other");
  assert.equal(db.listPixPhoneKeys().find((candidate) => candidate.id === key!.id)?.status, "reserved");
  db.releasePixPhoneKeyReservation(key!.id, "run-a");

  assert.equal(db.listPixPhoneKeys().find((candidate) => candidate.id === key!.id)?.status, "available");
});

test("PIX key survives an ambiguous final click as pending and leaves the stock only after confirmation", () => {
  const db = new PredatorDatabase(createPaths(), plainStore);
  const profile = db.createProfile({
    name: "Pending Pix Confirmation",
    notes: "",
    homeUrl: "https://example.com",
    tags: [],
    color: "#d6d6d6"
  });
  db.addPixPhoneKeys("11988887777");

  const key = db.reservePixPhoneKey(profile.id, "run-a");
  assert.ok(key);
  assert.equal(db.markPixPhoneKeyPendingConfirmation(key.id, { profileId: profile.id, runId: "run-a" }), true);
  assert.equal(db.findPendingPixPhoneKey(profile.id)?.status, "pending_confirmation");
  assert.equal(db.confirmPixPhoneKeyRegistration(key.id, { profileId: profile.id, origin: "Telefone" }), true);
  assert.equal(db.listPixPhoneKeys().find((candidate) => candidate.id === key.id), undefined);
  assert.equal(db.getOrCreateProfileAccount(profile.id).pixPhoneKey, "11988887777");
});

test("confirma chave PIX no perfil e a remove do estoque", () => {
  const db = new PredatorDatabase(createPaths(), plainStore);
  const profile = db.createProfile({
    name: "Confirmed Pix Profile",
    notes: "",
    homeUrl: "https://example.com",
    tags: [],
    color: "#d6d6d6"
  });
  db.addPixPhoneKeys("41980042690");
  const key = db.reservePixPhoneKey(profile.id, "run-a");
  assert.ok(key);
  assert.equal(db.markPixPhoneKeyPendingConfirmation(key.id, { profileId: profile.id, runId: "run-a" }), true);

  assert.equal(
    db.confirmPixPhoneKeyRegistration(key.id, { profileId: profile.id, origin: "Telefone" }),
    true
  );
  assert.equal(db.getOrCreateProfileAccount(profile.id).pixPhoneKey, "41980042690");
  assert.equal(db.listPixPhoneKeys().some((candidate) => candidate.id === key.id), false);
});

test("marca uma chave PIX pendente como recusada sem vincula-la ao perfil", () => {
  const db = new PredatorDatabase(createPaths(), plainStore);
  const profile = db.createProfile({
    name: "Rejected Pix Key",
    notes: "",
    homeUrl: "https://example.com",
    tags: [],
    color: "#d6d6d6"
  });
  db.addPixPhoneKeys("41980042690");
  const key = db.reservePixPhoneKey(profile.id, "run-a");
  assert.ok(key);
  assert.equal(db.markPixPhoneKeyPendingConfirmation(key.id, { profileId: profile.id, runId: "run-a" }), true);

  assert.equal(
    db.rejectPixPhoneKey(key.id, {
      profileId: profile.id,
      reason: "withdrawal-account-already-linked"
    }),
    true
  );

  const rejected = db.getPixPhoneKey(key.id);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.pendingProfileId, undefined);
  assert.equal(rejected.rejectionReason, "withdrawal-account-already-linked");
  assert.ok(rejected.rejectedAt);
  assert.equal(db.getOrCreateProfileAccount(profile.id).pixPhoneKey, undefined);
  assert.equal(db.reservePixPhoneKey(profile.id, "run-b"), undefined);
  assert.throws(() => db.updatePixPhoneKeyPhoneNumber(key.id, "11988887777"), /disponiveis/);

  db.deletePixPhoneKey(key.id);
  assert.equal(db.listPixPhoneKeys().some((candidate) => candidate.id === key.id), false);
});

test("nao consome chave PIX pendente de outro perfil", () => {
  const db = new PredatorDatabase(createPaths(), plainStore);
  const owner = db.createProfile({
    name: "Pix Key Owner",
    notes: "",
    homeUrl: "https://example.com",
    tags: [],
    color: "#d6d6d6"
  });
  const other = db.createProfile({
    name: "Other Pix Profile",
    notes: "",
    homeUrl: "https://example.com",
    tags: [],
    color: "#d6d6d6"
  });
  db.addPixPhoneKeys("41980042690");
  const key = db.reservePixPhoneKey(owner.id, "run-a");
  assert.ok(key);
  assert.equal(db.markPixPhoneKeyPendingConfirmation(key.id, { profileId: owner.id, runId: "run-a" }), true);

  assert.equal(
    db.confirmPixPhoneKeyRegistration(key.id, { profileId: other.id, origin: "Telefone" }),
    false
  );
  assert.equal(db.findPendingPixPhoneKey(owner.id)?.id, key.id);
  assert.equal(db.getOrCreateProfileAccount(other.id).pixPhoneKey, undefined);
});

test("migra chave PIX usada para o perfil e remove a linha legada", () => {
  const db = new PredatorDatabase(createPaths(), plainStore);
  const profile = db.createProfile({
    name: "Legacy Pix Profile",
    notes: "",
    homeUrl: "https://example.com",
    tags: [],
    color: "#d6d6d6"
  });
  db.addPixPhoneKeys("41980042690");
  const key = db.reservePixPhoneKey(profile.id, "run-a");
  assert.ok(key);
  assert.equal(db.markPixPhoneKeyPendingConfirmation(key.id, { profileId: profile.id, runId: "run-a" }), true);
  const raw = (db as unknown as { db: DatabaseSync }).db;
  raw.prepare(`
    UPDATE pix_phone_keys
    SET status = 'used', pending_profile_id = NULL, used_profile_id = ?, used_at = ?
    WHERE id = ?
  `).run(profile.id, new Date().toISOString(), key.id);

  assert.equal(db.migrateLegacyUsedPixPhoneKeys(), 1);
  assert.equal(db.getOrCreateProfileAccount(profile.id).pixPhoneKey, "41980042690");
  assert.equal(db.listPixPhoneKeys().some((candidate) => candidate.id === key.id), false);
});

test("recovery releases only inactive reserved PIX keys and keeps pending keys", () => {
  const db = new PredatorDatabase(createPaths(), plainStore);
  const profile = db.createProfile({
    name: "Pix Recovery",
    notes: "",
    homeUrl: "https://example.com",
    tags: [],
    color: "#d6d6d6"
  });
  const pendingProfile = db.createProfile({
    name: "Pending Pix Recovery",
    notes: "",
    homeUrl: "https://example.com",
    tags: [],
    color: "#d6d6d6"
  });
  db.addPixPhoneKeys("11988887777\n11988886666");

  const reserved = db.reservePixPhoneKey(profile.id, "run-reserved");
  assert.ok(reserved);
  const pending = db.reservePixPhoneKey(pendingProfile.id, "run-pending");
  assert.ok(pending);
  assert.equal(db.markPixPhoneKeyPendingConfirmation(pending.id, { profileId: pendingProfile.id, runId: "run-pending" }), true);

  db.recoverInactivePixPhoneKeyReservations([]);

  const records = db.listPixPhoneKeys();
  assert.equal(records.find((candidate) => candidate.id === reserved.id)?.status, "available");
  assert.equal(records.find((candidate) => candidate.id === pending.id)?.status, "pending_confirmation");
});

test("reimporting a confirmed PIX key creates a new available stock entry", () => {
  const db = new PredatorDatabase(createPaths(), plainStore);
  const profile = db.createProfile({
    name: "Used Pix Audit",
    notes: "",
    homeUrl: "https://example.com",
    tags: [],
    color: "#d6d6d6"
  });
  db.addPixPhoneKeys("11988887777");
  const key = db.reservePixPhoneKey(profile.id, "run-a");
  assert.ok(key);
  assert.equal(db.markPixPhoneKeyPendingConfirmation(key.id, { profileId: profile.id, runId: "run-a" }), true);
  assert.equal(db.confirmPixPhoneKeyRegistration(key.id, { profileId: profile.id, origin: "Telefone" }), true);

  const imported = db.addPixPhoneKeys("11988887777");

  assert.equal(imported.created.length, 1);
  assert.equal(imported.skipped.length, 0);
  assert.equal(db.listPixPhoneKeys()[0]?.status, "available");
});

test("ensureProfileWithdrawalPassword reuses a persisted password containing zero", () => {
  const db = new PredatorDatabase(createPaths(), plainStore);
  const profile = db.createProfile({
    name: "Recovery-safe password",
    notes: "",
    homeUrl: "https://example.com",
    tags: [],
    color: "#d6d6d6"
  });

  db.setProfileWithdrawalPassword(profile.id, "102345");

  assert.equal(db.ensureProfileWithdrawalPassword(profile.id), "102345");
});

test("getPersistedProfileWithdrawalPassword nao gera senha quando ela esta ausente", () => {
  const db = new PredatorDatabase(createPaths(), plainStore);
  const profile = db.createProfile({
    name: "Missing persisted withdrawal password",
    notes: "",
    homeUrl: "https://example.com",
    tags: [],
    color: "#d6d6d6"
  });

  assert.equal(db.getPersistedProfileWithdrawalPassword(profile.id), undefined);
  assert.equal(db.getPersistedProfileWithdrawalPassword(profile.id), undefined);
});

test("createProxy round-trips mode and usernameSuffixTemplate", () => {
  const db = new PredatorDatabase(createPaths(), plainStore);

  const created = db.createProxy({
    label: "DataImpulse US",
    protocol: "http",
    host: "gw.dataimpulse.com",
    port: 823,
    username: "login__cr.us",
    password: "secret",
    mode: "rotating-residential",
    usernameSuffixTemplate: ";sessid={profileId}",
    notes: ""
  });

  assert.equal(created.mode, "rotating-residential");
  assert.equal(created.usernameSuffixTemplate, ";sessid={profileId}");

  const fetched = db.getProxy(created.id);
  assert.equal(fetched.mode, "rotating-residential");
  assert.equal(fetched.usernameSuffixTemplate, ";sessid={profileId}");
});

test("createProxy defaults mode to static and clears the suffix template when omitted", () => {
  const db = new PredatorDatabase(createPaths(), plainStore);

  const created = db.createProxy({
    label: "Static proxy",
    protocol: "http",
    host: "127.0.0.1",
    port: 8888,
    username: "user",
    password: "pass",
    notes: ""
  });

  assert.equal(created.mode, "static");
  assert.equal(created.usernameSuffixTemplate, undefined);
});

test("updateProxy persists changes to mode and usernameSuffixTemplate", () => {
  const db = new PredatorDatabase(createPaths(), plainStore);
  const created = db.createProxy({
    label: "Mutating",
    protocol: "http",
    host: "gw.example.com",
    port: 9000,
    username: "user",
    password: "pass",
    notes: ""
  });

  const updated = db.updateProxy(created.id, {
    mode: "rotating-residential",
    usernameSuffixTemplate: ";sessid={profileId}"
  });

  assert.equal(updated.mode, "rotating-residential");
  assert.equal(updated.usernameSuffixTemplate, ";sessid={profileId}");

  const refetched = db.getProxy(created.id);
  assert.equal(refetched.mode, "rotating-residential");
  assert.equal(refetched.usernameSuffixTemplate, ";sessid={profileId}");
});

test("initializeSchema adds mode and username_suffix_template to a legacy proxies table", () => {
  const paths = createPaths();
  const raw = new DatabaseSync(paths.databaseFile);
  raw.exec(`
    CREATE TABLE proxies (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      protocol TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username_enc TEXT,
      password_enc TEXT,
      status TEXT NOT NULL,
      last_checked_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  raw.prepare(`
    INSERT INTO proxies (id, label, protocol, host, port, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "legacy-1",
    "Legacy",
    "http",
    "127.0.0.1",
    8888,
    "unknown",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z"
  );
  raw.exec("PRAGMA user_version = 1;");
  raw.close();

  const db = new PredatorDatabase(paths, plainStore);
  const fetched = db.getProxy("legacy-1");
  assert.equal(fetched.mode, "static");
  assert.equal(fetched.usernameSuffixTemplate, undefined);

  db.createProxy({
    label: "After-migration",
    protocol: "http",
    host: "127.0.0.1",
    port: 8889,
    username: "u",
    password: "p",
    mode: "rotating-residential",
    usernameSuffixTemplate: ";sessid={profileId}",
    notes: ""
  });

  const after = db.listProxies();
  assert.equal(after.length, 2);
  const legacy = after.find((proxy) => proxy.id === "legacy-1");
  const fresh = after.find((proxy) => proxy.label === "After-migration");
  assert.ok(legacy);
  assert.ok(fresh);
  assert.equal(legacy.mode, "static");
  assert.equal(legacy.usernameSuffixTemplate, undefined);
  assert.equal(fresh.mode, "rotating-residential");
  assert.equal(fresh.usernameSuffixTemplate, ";sessid={profileId}");
});

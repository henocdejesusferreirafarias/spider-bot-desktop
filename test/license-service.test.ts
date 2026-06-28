import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  type KeyObject
} from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  LICENSE_JWT_ACTIVE_KID,
  type LicenseClientState,
  type LicensePayloadEnvelope,
  type LicenseTokenClaims
} from "@spider-bot/licensing-contracts";
import { LicenseService } from "../src/main/services/license-service.js";
import { loadNativeLicenseCore } from "../src/main/services/license-core-native.js";
import { SecureStore } from "../src/main/services/secure-store.js";
import type { PredatorPaths } from "../src/main/services/paths.js";

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signToken(claims: LicenseTokenClaims, privateKeyPem: string): string {
  const header = base64Url(JSON.stringify({
    alg: "EdDSA",
    kid: LICENSE_JWT_ACTIVE_KID,
    typ: "JWT"
  }));
  const payload = base64Url(JSON.stringify(claims));
  const input = `${header}.${payload}`;
  const signature = cryptoSign(null, Buffer.from(input), createPrivateKey(privateKeyPem));
  return `${input}.${base64Url(signature)}`;
}

function createPaths(): PredatorPaths {
  const root = mkdtempSync(join(tmpdir(), "spider-license-"));
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

const plainStore = {
  encrypt: (value?: string) => value,
  decrypt: (value?: string) => value
} as SecureStore;

const developmentPayloadPrivateKey = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEINjraRIN0Q1SrUHRuLSXpl1pBw0GCBX28xPen86Xo8/d
-----END PRIVATE KEY-----`;

function signPayloadArtifact(payloadId: string, version: number, content: string) {
  const contentSha256 = createHash("sha256").update(content).digest("hex");
  const message = ["spider-bot-payload-v1", payloadId, String(version), contentSha256].join("\n");
  return {
    payloadId,
    version,
    content,
    contentSha256,
    signatureKid: "payload-45d0ae62f25498b8",
    signature: cryptoSign(
      null,
      Buffer.from(message),
      createPrivateKey(developmentPayloadPrivateKey)
    ).toString("base64url"),
    active: true
  };
}

function createKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }) as string
  };
}

function activeState(overrides: Partial<LicenseClientState> = {}): LicenseClientState {
  return {
    status: "active",
    operational: true,
    email: "user@example.com",
    planType: "monthly",
    offlineUntil: "2026-06-04T12:00:00.000Z",
    lastValidatedAt: "2026-06-01T12:00:00.000Z",
    message: "Licença ativa.",
    ...overrides
  };
}

test("accepts a valid activation token and keeps the app operational", async () => {
  const keys = createKeys();
  const now = new Date("2026-06-01T12:00:00.000Z");
  let token = "";
  const service = new LicenseService(createPaths(), plainStore, {
    apiBaseUrl: "http://license.test",
    appVersion: "0.1.0",
    developmentPublicKeyPem: keys.publicKeyPem,
    clock: () => now,
    fetchImpl: async () =>
      ({
        ok: true,
        json: async () => ({ token, state: activeState() })
      }) as Response
  });
  await service.initialize();
  const cache = JSON.parse(JSON.stringify((service as unknown as { cache: { installId: string } }).cache));
  token = signToken(
    {
      iss: "spider-bot-api",
      aud: "spider-bot-desktop",
      sub: randomUUID(),
      email: "user@example.com",
      planType: "monthly",
      deviceId: randomUUID(),
      fingerprintHash: (service as unknown as { createFingerprintHash: (installId: string) => string }).createFingerprintHash(cache.installId),
      exp: Math.floor(new Date("2026-06-04T12:00:00.000Z").getTime() / 1000),
      iat: Math.floor(now.getTime() / 1000),
      jti: randomUUID()
    },
    keys.privateKeyPem
  );

  const state = await service.activate({ email: "user@example.com", licenseKey: "SPDR-AAAA-BBBB-CCCC-DDDD" });
  assert.equal(state.operational, true);
  service.ensureOperational();
});

test("uses cached token when online revalidation fails", async () => {
  const keys = createKeys();
  const now = new Date("2026-06-01T12:00:00.000Z");
  let online = true;
  let token = "";
  const service = new LicenseService(createPaths(), plainStore, {
    apiBaseUrl: "http://license.test",
    appVersion: "0.1.0",
    developmentPublicKeyPem: keys.publicKeyPem,
    clock: () => now,
    fetchImpl: async () => {
      if (!online) {
        throw new Error("network down");
      }
      return { ok: true, json: async () => ({ token, state: activeState() }) } as Response;
    }
  });
  await service.initialize();
  const installId = (service as unknown as { cache: { installId: string } }).cache.installId;
  token = signToken(
    {
      iss: "spider-bot-api",
      aud: "spider-bot-desktop",
      sub: randomUUID(),
      email: "user@example.com",
      planType: "monthly",
      deviceId: randomUUID(),
      fingerprintHash: (service as unknown as { createFingerprintHash: (installId: string) => string }).createFingerprintHash(installId),
      exp: Math.floor(new Date("2026-06-04T12:00:00.000Z").getTime() / 1000),
      iat: Math.floor(now.getTime() / 1000),
      jti: randomUUID()
    },
    keys.privateKeyPem
  );
  await service.activate({ email: "user@example.com", licenseKey: "SPDR-AAAA-BBBB-CCCC-DDDD" });

  online = false;
  const state = await service.revalidate();
  assert.equal(state.operational, true);
  assert.match(state.message, /Tentando novamente/i);
});

test("blocks cached license when the system clock moves backwards", async () => {
  const keys = createKeys();
  let now = new Date("2026-06-01T12:00:00.000Z");
  let token = "";
  const service = new LicenseService(createPaths(), plainStore, {
    apiBaseUrl: "http://license.test",
    appVersion: "0.1.0",
    developmentPublicKeyPem: keys.publicKeyPem,
    clock: () => now,
    fetchImpl: async () => ({ ok: true, json: async () => ({ token, state: activeState() }) }) as Response
  });
  await service.initialize();
  const installId = (service as unknown as { cache: { installId: string } }).cache.installId;
  token = signToken(
    {
      iss: "spider-bot-api",
      aud: "spider-bot-desktop",
      sub: randomUUID(),
      email: "user@example.com",
      planType: "monthly",
      deviceId: randomUUID(),
      fingerprintHash: (service as unknown as { createFingerprintHash: (installId: string) => string }).createFingerprintHash(installId),
      exp: Math.floor(new Date("2026-06-04T12:00:00.000Z").getTime() / 1000),
      iat: Math.floor(now.getTime() / 1000),
      jti: randomUUID()
    },
    keys.privateKeyPem
  );
  await service.activate({ email: "user@example.com", licenseKey: "SPDR-AAAA-BBBB-CCCC-DDDD" });

  now = new Date("2026-05-30T12:00:00.000Z");
  const next = await service.revalidate();
  assert.equal(next.operational, false);
  assert.equal(next.status, "invalid");
});

// ---------------------------------------------------------------------------
// Red team — adulteracao do cache e replay de token (WS5/WS1)
// ---------------------------------------------------------------------------

test("red team: editing license-cache.json state.operational does not unlock", async () => {
  const keys = createKeys();
  const paths = createPaths();
  // Cache adulterado a mao: operational=true porem SEM token de licenca.
  writeFileSync(
    join(paths.appData, "license-cache.json"),
    JSON.stringify({
      installId: randomUUID(),
      state: { status: "active", operational: true, message: "hacked" }
    }),
    "utf-8"
  );
  const service = new LicenseService(paths, plainStore, {
    apiBaseUrl: "http://license.test",
    appVersion: "0.1.0",
    developmentPublicKeyPem: keys.publicKeyPem,
    fetchImpl: async () => {
      throw new Error("offline");
    }
  });
  const state = await service.initialize();
  // A fonte da verdade e o token assinado; sem ele, operational e ignorado.
  assert.equal(state.operational, false);
  assert.throws(() => service.ensureOperational());
});

test("red team: a leaked token bound to another machine is rejected (device_mismatch)", async () => {
  const keys = createKeys();
  const now = new Date("2026-06-01T12:00:00.000Z");
  const paths = createPaths();
  let token = "";
  const online: { fetchImpl: typeof fetch } = {
    fetchImpl: async () => ({ ok: true, json: async () => ({ token, state: activeState() }) }) as Response
  };
  const service = new LicenseService(paths, plainStore, {
    apiBaseUrl: "http://license.test",
    appVersion: "0.1.0",
    developmentPublicKeyPem: keys.publicKeyPem,
    clock: () => now,
    fetchImpl: (...args) => online.fetchImpl(...args)
  });
  await service.initialize();
  // Token valido (assinado), mas com fingerprint de OUTRA maquina.
  token = signToken(
    {
      iss: "spider-bot-api",
      aud: "spider-bot-desktop",
      sub: randomUUID(),
      email: "user@example.com",
      planType: "monthly",
      deviceId: randomUUID(),
      fingerprintHash: "v2$" + "f".repeat(64),
      exp: Math.floor(new Date("2026-06-04T12:00:00.000Z").getTime() / 1000),
      iat: Math.floor(now.getTime() / 1000),
      jti: randomUUID()
    },
    keys.privateKeyPem
  );
  await service.activate({ email: "user@example.com", licenseKey: "SPDR-AAAA-BBBB-CCCC-DDDD" });

  // Reabrir o app offline (copia do cache levada para outra maquina): a avaliacao
  // local recoleta o hardware desta maquina e detecta que o token nao pertence a ela.
  online.fetchImpl = async () => {
    throw new Error("offline");
  };
  const reopened = new LicenseService(paths, plainStore, {
    apiBaseUrl: "http://license.test",
    appVersion: "0.1.0",
    developmentPublicKeyPem: keys.publicKeyPem,
    clock: () => now,
    fetchImpl: async () => {
      throw new Error("offline");
    }
  });
  const state = await reopened.initialize();
  assert.equal(state.operational, false);
  assert.equal(state.status, "device_mismatch");
});

test("production fail-closed: refuses installId fallback when no hardware is collectable", () => {
  const keys = createKeys();
  const service = new LicenseService(createPaths(), plainStore, {
    apiBaseUrl: "http://license.test",
    appVersion: "0.1.0",
    developmentPublicKeyPem: keys.publicKeyPem,
    requireNativeCore: true
  });
  const internals = service as unknown as {
    native: unknown;
    collectHardwareComponents: () => string[];
    createFingerprintHash: (installId: string) => string;
    hardwareIdMemo?: string;
  };
  // Nativo presente porem sem hardware coletavel; coleta JS tambem vazia.
  internals.native = { verifyLicenseToken: () => "{}", computeFingerprint: () => null };
  internals.collectHardwareComponents = () => [];
  internals.hardwareIdMemo = undefined;
  assert.throws(() => internals.createFingerprintHash("install-id-123"), /hardware/i);
});

// ---------------------------------------------------------------------------
// Frente B — núcleo nativo: decapsulate decifra um envelope no formato do servidor
// (paridade com apps/api/src/security/payload-envelope.ts). Pula se o .node não
// estiver disponível ou se a máquina não tiver hardware coletável.
// ---------------------------------------------------------------------------

function sealForDevice(
  devicePublicKeyB64Url: string,
  payloadId: string,
  version: number,
  plaintext: string
): LicensePayloadEnvelope {
  const deviceRaw = Buffer.from(devicePublicKeyB64Url, "base64url");
  const devicePublic: KeyObject = createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: deviceRaw.toString("base64url") },
    format: "jwk"
  });
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralRaw = Buffer.from((ephemeral.publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: devicePublic });
  const salt = Buffer.concat([ephemeralRaw, deviceRaw]);
  const key = Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from("spider-bot-payload-v1", "utf-8"), 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${payloadId}:${version}`, "utf-8"));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf-8")), cipher.final()]);
  return {
    payloadId,
    version,
    alg: "x25519-hkdf-sha256-aes256gcm",
    ephemeralPublicKey: ephemeralRaw.toString("base64url"),
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url")
  };
}

test("native trust anchor rejects a JWT signed by an attacker even with the active kid", () => {
  const native = loadNativeLicenseCore();
  if (!native) {
    return;
  }
  const attacker = createKeys();
  const forged = signToken(
    {
      iss: "spider-bot-api",
      aud: "spider-bot-desktop",
      sub: randomUUID(),
      email: "attacker@example.com",
      planType: "lifetime",
      deviceId: randomUUID(),
      fingerprintHash: "v2$" + "a".repeat(64),
      exp: Math.floor(Date.now() / 1000) + 86_400,
      iat: Math.floor(Date.now() / 1000),
      jti: randomUUID()
    },
    attacker.privateKeyPem
  );
  assert.throws(() => native.verifyLicenseToken(forged), /assinatura/i);
});

test("strict secure store rejects plaintext cache injection", () => {
  const store = new SecureStore();
  assert.equal(store.decrypt("plain::forged-license-token"), undefined);
  assert.equal(store.decrypt("forged-license-token"), undefined);
});

test("Frente B native: signed payload round-trips and rejects tampering", () => {
  const native = loadNativeLicenseCore();
  if (!native?.getDeviceIdentity || !native.decapsulateSignedPayload) {
    return;
  }
  const paths = createPaths();
  const identityPath = join(paths.appData, "device-identity.bin");
  const identity = JSON.parse(native.getDeviceIdentity(identityPath)) as {
    encryptionPublicKey: string;
  };
  const artifact = signPayloadArtifact("popup-killer", 7, "SWEEP_SCRIPT_SECRET()");
  const envelope = sealForDevice(
    identity.encryptionPublicKey,
    artifact.payloadId,
    artifact.version,
    JSON.stringify(artifact)
  );
  assert.equal(
    native.decapsulateSignedPayload(identityPath, JSON.stringify(envelope)),
    "SWEEP_SCRIPT_SECRET()"
  );

  const tampered = { ...envelope, tag: Buffer.alloc(16, 0).toString("base64url") };
  assert.throws(() => native.decapsulateSignedPayload!(identityPath, JSON.stringify(tampered)));

  const otherDevice = generateKeyPairSync("x25519");
  const otherPublic = (otherDevice.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const foreign = sealForDevice(otherPublic, artifact.payloadId, artifact.version, JSON.stringify(artifact));
  assert.throws(() => native.decapsulateSignedPayload!(identityPath, JSON.stringify(foreign)));

  const forgedArtifact = { ...artifact, content: "ATTACKER_SCRIPT()" };
  const forgedEnvelope = sealForDevice(
    identity.encryptionPublicKey,
    artifact.payloadId,
    artifact.version,
    JSON.stringify(forgedArtifact)
  );
  assert.throws(
    () => native.decapsulateSignedPayload!(identityPath, JSON.stringify(forgedEnvelope)),
    /integridade/i
  );

  const crossWiredEnvelope = sealForDevice(
    identity.encryptionPublicKey,
    "workflow:account-registration:0",
    artifact.version,
    JSON.stringify(artifact)
  );
  assert.throws(
    () => native.decapsulateSignedPayload!(identityPath, JSON.stringify(crossWiredEnvelope)),
    /integridade/i
  );
});

test("Frente B client: fetchPayload fetches and decrypts a served envelope end-to-end", async () => {
  const native = loadNativeLicenseCore();
  if (!native?.getDeviceIdentity || !native.decapsulateSignedPayload) {
    return;
  }
  const keys = createKeys();
  const now = new Date("2026-06-01T12:00:00.000Z");
  const paths = createPaths();
  const identityPath = join(paths.appData, "device-identity.bin");
  const identity = JSON.parse(native.getDeviceIdentity(identityPath)) as {
    encryptionPublicKey: string;
  };
  let token = "";
  let envelope: LicensePayloadEnvelope | null = null;
  const service = new LicenseService(paths, plainStore, {
    apiBaseUrl: "http://license.test",
    appVersion: "0.1.0",
    developmentPublicKeyPem: keys.publicKeyPem,
    clock: () => now,
    fetchImpl: async (url) =>
      (String(url).endsWith("/v1/license/payload")
        ? { ok: true, json: async () => envelope }
        : { ok: true, json: async () => ({ token, state: activeState() }) }) as Response
  });
  await service.initialize();
  const installId = (service as unknown as { cache: { installId: string } }).cache.installId;
  const fingerprintHash = (service as unknown as { createFingerprintHash: (id: string) => string }).createFingerprintHash(installId);
  token = signToken(
    {
      iss: "spider-bot-api",
      aud: "spider-bot-desktop",
      sub: randomUUID(),
      email: "user@example.com",
      planType: "monthly",
      deviceId: randomUUID(),
      fingerprintHash,
      exp: Math.floor(new Date("2026-06-04T12:00:00.000Z").getTime() / 1000),
      iat: Math.floor(now.getTime() / 1000),
      jti: randomUUID()
    },
    keys.privateKeyPem
  );
  await service.activate({ email: "user@example.com", licenseKey: "SPDR-AAAA-BBBB-CCCC-DDDD" });
  const artifact = signPayloadArtifact("popup-killer", 2, "SERVED_SWEEP()");
  envelope = sealForDevice(
    identity.encryptionPublicKey,
    artifact.payloadId,
    artifact.version,
    JSON.stringify(artifact)
  );
  const script = await service.fetchPayload("popup-killer");
  assert.equal(script, "SERVED_SWEEP()");
});

test("offline_expired state persists across app restarts", async () => {
  const keys = createKeys();
  let now = new Date("2026-06-01T12:00:00.000Z");
  const paths = createPaths();
  let token = "";
  let online = true;
  const service = new LicenseService(paths, plainStore, {
    apiBaseUrl: "http://license.test",
    appVersion: "1.0.0",
    developmentPublicKeyPem: keys.publicKeyPem,
    clock: () => now,
    fetchImpl: async () => {
      if (!online) {
        throw new Error("network down");
      }
      return { ok: true, json: async () => ({ token, state: activeState() }) } as Response;
    }
  });
  await service.initialize();
  const installId = (service as unknown as { cache: { installId: string } }).cache.installId;
  token = signToken(
    {
      iss: "spider-bot-api",
      aud: "spider-bot-desktop",
      sub: randomUUID(),
      email: "user@example.com",
      planType: "monthly",
      deviceId: randomUUID(),
      fingerprintHash: (service as unknown as { createFingerprintHash: (id: string) => string }).createFingerprintHash(installId),
      exp: Math.floor(new Date("2026-06-01T12:05:00.000Z").getTime() / 1000),
      iat: Math.floor(now.getTime() / 1000),
      jti: randomUUID()
    },
    keys.privateKeyPem
  );
  await service.activate({ email: "user@example.com", licenseKey: "SPDR-AAAA-BBBB-CCCC-DDDD" });

  // Go offline and move clock past token expiry (now 12:06 > exp 12:05)
  online = false;
  now = new Date("2026-06-01T12:06:00.000Z");
  const state1 = await service.revalidate();
  assert.equal(state1.status, "offline_expired");
  assert.equal(state1.operational, false);

  // Simulate app restart — create a new service instance reading the same cache disk
  const restarted = new LicenseService(paths, plainStore, {
    apiBaseUrl: "http://license.test",
    appVersion: "1.0.0",
    developmentPublicKeyPem: keys.publicKeyPem,
    clock: () => now,
    fetchImpl: async () => {
      throw new Error("still offline");
    }
  });
  const state2 = await restarted.initialize();
  assert.equal(state2.status, "offline_expired");
  assert.equal(state2.operational, false);
});

test("dev fallback: installId is still used when no hardware is collectable and native is optional", () => {
  const keys = createKeys();
  const service = new LicenseService(createPaths(), plainStore, {
    apiBaseUrl: "http://license.test",
    appVersion: "0.1.0",
    developmentPublicKeyPem: keys.publicKeyPem,
    requireNativeCore: false
  });
  const internals = service as unknown as {
    native: unknown;
    collectHardwareComponents: () => string[];
    createFingerprintHash: (installId: string) => string;
    hardwareIdMemo?: string;
  };
  internals.native = null;
  internals.collectHardwareComponents = () => [];
  internals.hardwareIdMemo = undefined;
  const fingerprint = internals.createFingerprintHash("install-id-123");
  assert.match(fingerprint, /^v2\$/);
});

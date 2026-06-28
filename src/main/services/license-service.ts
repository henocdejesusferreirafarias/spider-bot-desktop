import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { join } from "node:path";
import { arch, platform, release, type } from "node:os";
import {
  LICENSE_JWT_ACTIVE_KID,
  automationRunResponseSchema,
  automationStepSchema,
  canonicalJson,
  deviceIdentitySchema,
  licenseErrorResponseSchema,
  licensePayloadEnvelopeSchema,
  licenseTokenResponseSchema,
  publicAutomationRoutes,
  publicLicenseRoutes,
  type AutomationReceipt,
  type AutomationRunAbortRequest,
  type AutomationRunNextRequest,
  type AutomationRunStartRequest,
  type AutomationStep,
  type LicenseActivateRequest,
  type LicenseClientState,
  type DeviceIdentity,
  type DeviceProof,
  type LicensePayloadEnvelope,
  type LicensePayloadRequest,
  type LicenseRevalidateRequest,
  type LicenseTokenClaims
} from "@spider-bot/licensing-contracts";
import type { PredatorPaths } from "./paths.js";
import type { SecureStore } from "./secure-store.js";
import { loadNativeLicenseCore, type NativeLicenseCore } from "./license-core-native.js";

interface LicenseCacheFile {
  installId: string;
  encryptedToken?: string;
  state?: LicenseClientState;
  lastSeenAt?: string;
}

interface LicenseServiceOptions {
  apiBaseUrl: string;
  appVersion: string;
  developmentPublicKeyPem?: string;
  /**
   * Exige o nucleo nativo (Frente C): quando true e o modulo nativo nao carrega,
   * a verificacao falha (fail-closed) em vez de cair para o JS patchavel. Deve
   * ser `app.isPackaged` — nativo obrigatorio em producao, fallback so em dev.
   */
  requireNativeCore?: boolean;
  clock?: () => Date;
  fetchImpl?: typeof fetch;
  nativeCore?: NativeLicenseCore | null;
}

export interface RemoteAutomationCheckpoint {
  runId: string;
  runNonce: string;
  complete: boolean;
  step?: AutomationStep;
  stepNonce?: string;
  stepSha256?: string;
}

const noLicenseState: LicenseClientState = {
  status: "unlicensed",
  operational: false,
  message: "Ative sua licença para usar as operações do Spider BOT."
};

export class LicenseRequiredError extends Error {
  constructor(readonly state: LicenseClientState) {
    super(state.message);
  }
}

export class LicenseService {
  private readonly cacheFile: string;
  private readonly deviceIdentityFile: string;
  private state: LicenseClientState = noLicenseState;
  private cache: LicenseCacheFile | undefined;
  private hardwareIdMemo?: string;
  private readonly native: NativeLicenseCore | null;

  constructor(
    paths: Pick<PredatorPaths, "appData">,
    private readonly secureStore: SecureStore,
    private readonly options: LicenseServiceOptions
  ) {
    this.cacheFile = join(paths.appData, "license-cache.json");
    this.deviceIdentityFile = join(paths.appData, "device-identity.bin");
    this.native = options.nativeCore === undefined ? loadNativeLicenseCore() : options.nativeCore;
  }

  async initialize(): Promise<LicenseClientState> {
    this.cache = this.loadCache();
    this.state = this.evaluateCachedToken();
    if (this.cache.encryptedToken) {
      await this.revalidate().catch(() => {
        this.state = this.evaluateCachedToken();
      });
    }
    return this.state;
  }

  getState(): LicenseClientState {
    return this.state;
  }

  ensureOperational(): void {
    if (!this.state.operational) {
      throw new LicenseRequiredError(this.state);
    }
  }

  async activate(input: Pick<LicenseActivateRequest, "email" | "licenseKey">): Promise<LicenseClientState> {
    const cache = this.ensureCache();
    const deviceIdentity = this.getDeviceIdentity();
    const body = {
      email: input.email,
      licenseKey: input.licenseKey,
      fingerprintHash: this.createFingerprintHash(cache.installId),
      deviceLabel: this.createDeviceLabel(),
      appVersion: this.options.appVersion,
      deviceIdentity
    };
    const request: LicenseActivateRequest = {
      ...body,
      deviceProof: this.createDeviceProof("license.activate", publicLicenseRoutes.activate, body)
    };
    const response = await this.postLicense(publicLicenseRoutes.activate, request);
    return this.acceptToken(response.token, response.state);
  }

  /**
   * Frente B: busca um payload de automação cifrado para ESTE device, decifra-o
   * no núcleo nativo (a privada nunca toca o JS) e retorna o texto em claro.
   * Lança quando offline/sem licença/sem suporte nativo — o chamador degrada
   * apenas o recurso servido (nunca derruba o app).
   */
  async fetchPayload(payloadId: string): Promise<string> {
    const token = this.requireToken();
    const cache = this.ensureCache();
    const body = {
      token,
      fingerprintHash: this.createFingerprintHash(cache.installId),
      payloadId,
      appVersion: this.options.appVersion
    };
    const request: LicensePayloadRequest = {
      ...body,
      deviceProof: this.createDeviceProof("license.payload", publicLicenseRoutes.payload, body)
    };
    const envelope = await this.postPayload(request);
    return this.decryptEnvelope(envelope);
  }

  async startAutomationRun(workflowId: string): Promise<RemoteAutomationCheckpoint> {
    return this.withAutomationBackoff(() => {
      const token = this.requireToken();
      const cache = this.ensureCache();
      const body = {
        token,
        fingerprintHash: this.createFingerprintHash(cache.installId),
        appVersion: this.options.appVersion,
        workflowId
      };
      const request: AutomationRunStartRequest = {
        ...body,
        deviceProof: this.createDeviceProof("automation.start", publicAutomationRoutes.start, body)
      };
      return this.postAutomation(publicAutomationRoutes.start, request);
    });
  }

  async nextAutomationRun(
    runId: string,
    receipt: AutomationReceipt
  ): Promise<RemoteAutomationCheckpoint> {
    return this.withAutomationBackoff(() => {
      const token = this.requireToken();
      const cache = this.ensureCache();
      const route = publicAutomationRoutes.next(runId);
      const body = {
        token,
        fingerprintHash: this.createFingerprintHash(cache.installId),
        appVersion: this.options.appVersion,
        receipt
      };
      const request: AutomationRunNextRequest = {
        ...body,
        deviceProof: this.createDeviceProof("automation.next", route, body)
      };
      return this.postAutomation(route, request);
    });
  }

  async abortAutomationRun(runId: string, reason: string): Promise<void> {
    await this.withAutomationBackoff(async () => {
      const token = this.requireToken();
      const cache = this.ensureCache();
      const route = publicAutomationRoutes.abort(runId);
      const body = {
        token,
        fingerprintHash: this.createFingerprintHash(cache.installId),
        appVersion: this.options.appVersion,
        reason
      };
      const request: AutomationRunAbortRequest = {
        ...body,
        deviceProof: this.createDeviceProof("automation.abort", route, body)
      };
      await this.postAutomation(route, request);
    });
  }

  private async withAutomationBackoff<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof LicenseRequiredError) {
          throw error;
        }
        lastError = error;
        if (attempt === 2) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt + Math.floor(Math.random() * 150)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Falha temporaria na automacao remota.");
  }

  private async postAutomation(
    route: string,
    request: AutomationRunStartRequest | AutomationRunNextRequest | AutomationRunAbortRequest
  ): Promise<RemoteAutomationCheckpoint> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${this.options.apiBaseUrl.replace(/\/$/, "")}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    const body = await response.json();
    if (!response.ok) {
      const error = licenseErrorResponseSchema.safeParse(body);
      if (error.success) {
        throw new LicenseRequiredError(error.data.state);
      }
      throw new Error(`Servidor de automacao respondeu HTTP ${response.status}.`);
    }
    const parsed = automationRunResponseSchema.parse(body);
    if (!parsed.step) {
      return {
        runId: parsed.runId,
        runNonce: parsed.runNonce,
        complete: parsed.complete
      };
    }
    const content = this.decryptEnvelope(parsed.step);
    return {
      ...parsed,
      step: automationStepSchema.parse(JSON.parse(content)),
      stepNonce: parsed.stepNonce,
      stepSha256: createHash("sha256").update(content).digest("hex")
    };
  }

  private getDeviceIdentity(): DeviceIdentity {
    const native = this.requireNativeOrThrow();
    if (!native?.getDeviceIdentity) {
      throw new Error("Núcleo nativo sem identidade criptografica. Reinstale o Spider BOT.");
    }
    return deviceIdentitySchema.parse(JSON.parse(native.getDeviceIdentity(this.deviceIdentityFile)));
  }

  private createDeviceProof(purpose: string, route: string, body: unknown): DeviceProof {
    const native = this.requireNativeOrThrow();
    if (!native?.signDeviceProof) {
      throw new Error("Núcleo nativo sem prova de dispositivo. Reinstale o Spider BOT.");
    }
    const identity = this.getDeviceIdentity();
    const proof = {
      version: 1 as const,
      keyId: identity.keyId,
      jti: randomUUID(),
      issuedAt: Math.floor(this.now().getTime() / 1000)
    };
    const fields = canonicalJson({
      bodySha256: createHash("sha256").update(canonicalJson(body)).digest("hex"),
      issuedAt: proof.issuedAt,
      jti: proof.jti,
      keyId: proof.keyId,
      route
    });
    return {
      ...proof,
      signature: native.signDeviceProof(this.deviceIdentityFile, purpose, fields)
    };
  }

  private requireToken(): string {
    const token = this.getToken();
    if (!token) {
      throw new LicenseRequiredError(this.state);
    }
    return token;
  }

  private async postPayload(request: LicensePayloadRequest): Promise<LicensePayloadEnvelope> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${this.options.apiBaseUrl.replace(/\/$/, "")}${publicLicenseRoutes.payload}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    const body = await response.json();
    if (!response.ok) {
      const parsed = licenseErrorResponseSchema.safeParse(body);
      if (parsed.success) {
        throw new LicenseRequiredError(parsed.data.state);
      }
      throw new Error(`Servidor de payload respondeu HTTP ${response.status}.`);
    }
    return licensePayloadEnvelopeSchema.parse(body);
  }

  private decryptEnvelope(envelope: LicensePayloadEnvelope): string {
    const native = this.requireNativeOrThrow();
    if (!native?.decapsulateSignedPayload) {
      throw new Error("Núcleo nativo sem suporte a payloads (Frente B). Reinstale o Spider BOT.");
    }
    return native.decapsulateSignedPayload(this.deviceIdentityFile, JSON.stringify(envelope));
  }

  async revalidate(): Promise<LicenseClientState> {
    const token = this.getToken();
    if (!token) {
      this.state = noLicenseState;
      return this.state;
    }
    if (this.hasClockRollback()) {
      this.state = this.evaluateCachedToken();
      return this.state;
    }
    const cache = this.ensureCache();
    const body = {
      token,
      fingerprintHash: this.createFingerprintHash(cache.installId),
      appVersion: this.options.appVersion
    };
    const request: LicenseRevalidateRequest = {
      ...body,
      deviceProof: this.createDeviceProof("license.revalidate", publicLicenseRoutes.revalidate, body)
    };
    try {
      const response = await this.postLicense(publicLicenseRoutes.revalidate, request);
      return this.acceptToken(response.token, response.state);
    } catch (error) {
      if (error instanceof LicenseRequiredError) {
        this.clearToken(error.state);
        return this.state;
      }
      this.state = this.evaluateCachedToken("Não foi possível validar online. Tentando novamente...");
      return this.state;
    }
  }

  clear(): LicenseClientState {
    this.clearToken(noLicenseState);
    return this.state;
  }

  private async postLicense(path: string, payload: LicenseActivateRequest | LicenseRevalidateRequest) {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${this.options.apiBaseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const body = await response.json();
    if (!response.ok) {
      const parsed = licenseErrorResponseSchema.safeParse(body);
      if (parsed.success) {
        throw new LicenseRequiredError(parsed.data.state);
      }
      throw new Error(`Servidor de licença respondeu HTTP ${response.status}.`);
    }
    return licenseTokenResponseSchema.parse(body);
  }

  private acceptToken(token: string, nextState: LicenseClientState): LicenseClientState {
    this.verifyToken(token);
    const cache = this.ensureCache();
    cache.encryptedToken = this.secureStore.encrypt(token);
    cache.state = nextState;
    cache.lastSeenAt = this.now().toISOString();
    this.writeCache(cache);
    this.state = nextState;
    return this.state;
  }

  private evaluateCachedToken(message?: string): LicenseClientState {
    const token = this.getToken();
    const cache = this.ensureCache();
    const now = this.now();
    if (cache.lastSeenAt && now.getTime() + 5 * 60 * 1000 < Date.parse(cache.lastSeenAt)) {
      return {
        status: "invalid",
        operational: false,
        message: "O relógio do sistema parece estar incorreto. Valide a licença online novamente."
      };
    }
    if (!token) {
      return cache.state?.operational ? noLicenseState : cache.state ?? noLicenseState;
    }

    try {
      const claims = this.verifyToken(token);
      const fingerprintHash = this.createFingerprintHash(cache.installId);
      if (claims.fingerprintHash !== fingerprintHash) {
        return {
          status: "device_mismatch",
          operational: false,
          message: "A licença local não pertence a este dispositivo."
        };
      }
      if (claims.exp * 1000 <= now.getTime()) {
        const offlineState: LicenseClientState = {
          status: "offline_expired",
          operational: false,
          email: claims.email,
          planType: claims.planType,
          expiresAt: claims.licenseExpiresAt,
          offlineUntil: new Date(claims.exp * 1000).toISOString(),
          lastValidatedAt: cache.state?.lastValidatedAt,
          message: "Conecte-se à internet para validar a licença."
        };
        cache.state = offlineState;
        this.writeCache(cache);
        return offlineState;
      }
      const state: LicenseClientState = {
        status: "active",
        operational: true,
        email: claims.email,
        planType: claims.planType,
        expiresAt: claims.licenseExpiresAt,
        offlineUntil: new Date(claims.exp * 1000).toISOString(),
        lastValidatedAt: cache.state?.lastValidatedAt,
        message: message ?? "Licença ativa."
      };
      cache.state = state;
      cache.lastSeenAt = now.toISOString();
      this.writeCache(cache);
      return state;
    } catch (error) {
      return {
        status: "invalid",
        operational: false,
        message: error instanceof Error ? error.message : "Licença local inválida."
      };
    }
  }

  private hasClockRollback(): boolean {
    const lastSeenAt = this.ensureCache().lastSeenAt;
    return Boolean(lastSeenAt && this.now().getTime() + 5 * 60 * 1000 < Date.parse(lastSeenAt));
  }

  private verifyToken(token: string): LicenseTokenClaims {
    const native = this.requireNativeOrThrow();
    if (native && this.options.requireNativeCore) {
      // Verificacao EdDSA + checagem alg/iss/aud no codigo compilado (Frente C).
      const claims = JSON.parse(native.verifyLicenseToken(token)) as LicenseTokenClaims;
      if (claims.iss !== "spider-bot-api" || claims.aud !== "spider-bot-desktop") {
        throw new Error("Token de licença não pertence ao Spider BOT.");
      }
      return claims;
    }
    // Verificador injetavel existe somente para desenvolvimento/testes. Builds
    // empacotados sempre usam a ancora compilada no nucleo nativo.
    const developmentPublicKeyPem = this.options.developmentPublicKeyPem?.trim() ?? "";
    if (!developmentPublicKeyPem) {
      if (native) {
        return JSON.parse(native.verifyLicenseToken(token)) as LicenseTokenClaims;
      }
      throw new Error("Chave publica de desenvolvimento nao configurada.");
    }
    const [headerPart, payloadPart, signaturePart] = token.split(".");
    if (!headerPart || !payloadPart || !signaturePart) {
      throw new Error("Token de licença malformado.");
    }
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf-8")) as {
      alg?: string;
      kid?: string;
      typ?: string;
    };
    if (
      header.alg !== "EdDSA"
      || header.typ !== "JWT"
      || header.kid !== LICENSE_JWT_ACTIVE_KID
    ) {
      throw new Error("Token de licença usa algoritmo inválido.");
    }
    const signingInput = `${headerPart}.${payloadPart}`;
    const ok = cryptoVerify(
      null,
      Buffer.from(signingInput),
      createPublicKey(developmentPublicKeyPem),
      Buffer.from(signaturePart, "base64url")
    );
    if (!ok) {
      throw new Error("Assinatura da licença inválida.");
    }
    const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf-8")) as LicenseTokenClaims;
    if (claims.iss !== "spider-bot-api" || claims.aud !== "spider-bot-desktop") {
      throw new Error("Token de licença não pertence ao Spider BOT.");
    }
    return claims;
  }

  private clearToken(nextState: LicenseClientState): void {
    const cache = this.ensureCache();
    cache.encryptedToken = undefined;
    cache.state = nextState;
    cache.lastSeenAt = this.now().toISOString();
    this.writeCache(cache);
    this.state = nextState;
  }

  private getToken(): string | undefined {
    return this.cache?.encryptedToken ? this.secureStore.decrypt(this.cache.encryptedToken) : undefined;
  }

  private ensureCache(): LicenseCacheFile {
    if (!this.cache) {
      this.cache = this.loadCache();
    }
    if (!this.cache.installId) {
      this.cache.installId = randomUUID();
      this.writeCache(this.cache);
    }
    return this.cache;
  }

  private loadCache(): LicenseCacheFile {
    if (!existsSync(this.cacheFile)) {
      const cache = { installId: randomUUID() };
      this.writeCache(cache);
      return cache;
    }

    try {
      const parsed = JSON.parse(readFileSync(this.cacheFile, "utf-8")) as LicenseCacheFile;
      return {
        ...parsed,
        installId: parsed.installId || randomUUID()
      };
    } catch {
      const cache = { installId: randomUUID() };
      this.writeCache(cache);
      return cache;
    }
  }

  private writeCache(cache: LicenseCacheFile): void {
    writeFileSync(this.cacheFile, `${JSON.stringify(cache, null, 2)}\n`, "utf-8");
  }

  /**
   * Retorna o nucleo nativo, ou lanca quando ele e obrigatorio (producao) e
   * nao esta disponivel. Em dev retorna null para permitir o fallback JS.
   */
  private requireNativeOrThrow(): NativeLicenseCore | null {
    if (!this.native && this.options.requireNativeCore) {
      throw new Error("Núcleo nativo de licença indisponível. Reinstale o Spider BOT.");
    }
    return this.native;
  }

  private createFingerprintHash(installId: string): string {
    const native = this.requireNativeOrThrow();
    if (native) {
      const fingerprint = native.computeFingerprint();
      if (fingerprint) {
        return fingerprint;
      }
      // nativo sem componentes de hardware -> usa o fallback por instalacao (JS).
    }
    const hardwareId = this.resolveHardwareId(installId);
    return "v2$" + createHash("sha256")
      .update("spider-bot-device-v2")
      .update(":")
      .update(hardwareId)
      .digest("hex");
  }

  /**
   * Identificador estavel da maquina, derivado de hardware/instalacao do SO.
   * Memoizado por processo e NAO persistido em disco: copiar o
   * license-cache.json para outra maquina nao transfere o vinculo, porque a
   * outra maquina recoleta o proprio hardware e gera um fingerprint diferente.
   */
  private resolveHardwareId(installId: string): string {
    if (this.hardwareIdMemo) {
      return this.hardwareIdMemo;
    }
    const components = this.collectHardwareComponents();
    if (components.length === 0 && this.options.requireNativeCore) {
      // Fail-closed em producao: sem NENHUM componente de hardware real nao
      // caimos para o vinculo por instalacao (installId). Esse fallback amarra o
      // device a um UUID guardado no license-cache.json — copiar o cache para
      // outra maquina levaria o vinculo junto. Em producao exigimos >= 1
      // componente de hardware (MachineGuid basta e existe em todo Windows).
      throw new Error(
        "Nao foi possivel identificar o hardware deste dispositivo. Verifique se o Spider BOT tem permissao para ler as informacoes do sistema e tente ativar novamente."
      );
    }
    // Fallback (apenas dev): se a coleta falhar, cai para o vinculo por
    // instalacao para nao travar o desenvolvimento em ambientes restritos.
    const base = components.length > 0
      ? components.join("|")
      : [platform(), arch(), release(), type(), installId].join("|");
    this.hardwareIdMemo = createHash("sha256")
      .update("spider-bot-hw-v2")
      .update(":")
      .update(base)
      .digest("hex");
    return this.hardwareIdMemo;
  }

  private collectHardwareComponents(): string[] {
    if (platform() !== "win32") {
      return [];
    }
    const parts: string[] = [];
    const machineGuid = this.readCommand("reg", [
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
      "/v",
      "MachineGuid"
    ]).match(/MachineGuid\s+REG_SZ\s+([0-9a-f-]+)/i);
    if (machineGuid?.[1]) {
      parts.push(`mg:${machineGuid[1].toLowerCase()}`);
    }
    const csProductUuid = this.readCommand("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID"
    ]).trim().toUpperCase();
    if (
      csProductUuid &&
      !csProductUuid.startsWith("00000000-") &&
      csProductUuid !== "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"
    ) {
      parts.push(`csp:${csProductUuid}`);
    }
    return parts;
  }

  private readCommand(command: string, args: string[]): string {
    try {
      return execFileSync(command, args, {
        timeout: 4000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      }).toString("utf-8");
    } catch {
      return "";
    }
  }

  private createDeviceLabel(): string {
    return `${type()} ${arch()}`;
  }

  private now(): Date {
    return this.options.clock?.() ?? new Date();
  }
}

export function normalizePemFromEnv(value?: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  if (trimmed.includes("-----BEGIN")) {
    return trimmed.replace(/\\n/g, "\n");
  }
  return Buffer.from(trimmed, "base64").toString("utf-8").trim();
}

import { createRequire } from "node:module";

/**
 * Interface do modulo nativo de licenciamento (Frente C).
 * Implementado em Rust em apps/desktop/native/license-core.
 */
export interface NativeLicenseCore {
  /**
   * Verifica a assinatura EdDSA do JWT de licenca e devolve o payload (claims)
   * como string JSON. Lanca em caso de token/assinatura/iss/aud invalidos.
   */
  verifyLicenseToken(token: string): string;
  /**
   * Fingerprint atado a hardware, ou `null` quando nao ha componentes de
   * hardware coletaveis (o chamador entao aplica o fallback por instalacao).
   */
  computeFingerprint(): string | null;
  getDeviceIdentity?(storagePath: string): string;
  signDeviceProof?(storagePath: string, purpose: string, fieldsJson: string): string;
  decapsulate?(storagePath: string, envelopeJson: string): string;
  decapsulateSignedPayload?(storagePath: string, envelopeJson: string): string;
}

let cached: NativeLicenseCore | null | undefined;

/**
 * Carrega o modulo nativo uma unica vez. Retorna `null` se indisponivel
 * (ex.: ainda nao compilado em dev). O chamador decide a politica de fallback:
 * em desenvolvimento pode cair para a implementacao JS; em producao deve
 * exigir o nativo (fail-closed) para nao reabrir a superficie patchavel.
 */
export function loadNativeLicenseCore(): NativeLicenseCore | null {
  if (cached !== undefined) {
    return cached;
  }
  try {
    const require = createRequire(import.meta.url);
    const native = require("@spider-bot/license-core") as Partial<NativeLicenseCore>;
    if (
      typeof native.verifyLicenseToken !== "function" ||
      typeof native.computeFingerprint !== "function"
    ) {
      throw new Error("Modulo nativo de licenca incompleto.");
    }
    cached = native as NativeLicenseCore;
  } catch (error) {
    console.warn(
      "[license-core] modulo nativo indisponivel, usando fallback JS:",
      error instanceof Error ? error.message : error
    );
    cached = null;
  }
  return cached;
}

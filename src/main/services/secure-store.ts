import { createRequire } from "node:module";
import type { safeStorage as ElectronSafeStorage } from "electron";

const PLAIN_PREFIX = "plain::";
const ENC_PREFIX = "enc::";

export interface SecureStoreOptions {
  allowPlaintext?: boolean;
}

function getSafeStorage(): typeof ElectronSafeStorage | undefined {
  const electron = createRequire(import.meta.url)("electron") as
    | { safeStorage?: typeof ElectronSafeStorage }
    | string;
  return typeof electron === "object" ? electron.safeStorage : undefined;
}

export class SecureStore {
  constructor(private readonly options: SecureStoreOptions = {}) {}

  encrypt(value?: string): string | undefined {
    if (!value) {
      return value;
    }

    const safeStorage = getSafeStorage();
    if (!safeStorage?.isEncryptionAvailable()) {
      if (this.options.allowPlaintext) {
        return `${PLAIN_PREFIX}${value}`;
      }
      throw new Error("Armazenamento seguro do Windows indisponivel.");
    }

    const encrypted = safeStorage.encryptString(value).toString("base64");
    return `${ENC_PREFIX}${encrypted}`;
  }

  decrypt(value?: string): string | undefined {
    if (!value) {
      return value;
    }

    if (value.startsWith(ENC_PREFIX)) {
      try {
        const safeStorage = getSafeStorage();
        if (!safeStorage?.isEncryptionAvailable()) {
          return undefined;
        }
        const raw = Buffer.from(value.slice(ENC_PREFIX.length), "base64");
        return safeStorage.decryptString(raw);
      } catch {
        return undefined;
      }
    }

    if (value.startsWith(PLAIN_PREFIX)) {
      return this.options.allowPlaintext ? value.slice(PLAIN_PREFIX.length) : undefined;
    }

    return this.options.allowPlaintext ? value : undefined;
  }
}

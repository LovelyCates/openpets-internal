import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { decryptPrivateDocument, type PrivateStorageEncryption } from "../../src/private-storage-encryption.js";

/** Isolated process-only test key; no platform keychain or real user profile is touched. */
export function createTestPrivateStorageEncryption(): PrivateStorageEncryption {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(value) {
      const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
}

export const testPrivateStorageEncryption = createTestPrivateStorageEncryption();

export function readPrivateTestDocument(path: string, purpose: "provider-settings" | "assistant-history"): string {
  return decryptPrivateDocument(readFileSync(path, "utf8"), purpose, testPrivateStorageEncryption).value;
}

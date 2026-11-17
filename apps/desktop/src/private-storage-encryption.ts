/** Electron safeStorage is supplied by the main process; pure owners stay testable without Electron. */
export interface PrivateStorageEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export function requirePrivateStorageEncryption(encryption: PrivateStorageEncryption | undefined): PrivateStorageEncryption {
  if (!encryption?.isEncryptionAvailable() || process.platform === "linux" && encryption.getSelectedStorageBackend?.() === "basic_text") {
    throw new Error("OS encrypted storage is unavailable. Unlock the system keychain and restart OpenPets; existing data has been preserved.");
  }
  return encryption;
}

export function encryptPrivateDocument(value: string, purpose: string, encryption: PrivateStorageEncryption | undefined): string {
  const cipher = requirePrivateStorageEncryption(encryption);
  try {
    const ciphertext = cipher.encryptString(JSON.stringify({ purpose, value })).toString("base64");
    return `${JSON.stringify({ format: "openpets.safe-storage", version: 1, purpose, ciphertext })}\n`;
  } catch {
    throw new Error("OS encrypted storage could not encrypt local data. Existing data has been preserved; check system keychain access and restart OpenPets.");
  }
}

export function decryptPrivateDocument(contents: string, purpose: string, encryption: PrivateStorageEncryption | undefined): { value: string; legacy: boolean } {
  const cipher = requirePrivateStorageEncryption(encryption);
  let envelope: unknown;
  try {
    envelope = JSON.parse(contents);
  } catch {
    // JSON.parse errors may include a plaintext preview of the damaged document.
    throw new Error("Local data document is invalid; existing data has been preserved.");
  }
  if (!isRecord(envelope)) return { value: contents, legacy: true };
  const hasEnvelopeMarkers = "format" in envelope || "ciphertext" in envelope || "purpose" in envelope;
  if (!hasEnvelopeMarkers) return { value: contents, legacy: true };
  if (envelope.format !== "openpets.safe-storage") throw new Error("Encrypted local data format is invalid; existing data has been preserved.");
  if (envelope.version !== 1 || envelope.purpose !== purpose || typeof envelope.ciphertext !== "string"
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.ciphertext)
    || envelope.ciphertext.length === 0) throw new Error("Encrypted local data is invalid; existing data has been preserved.");
  try {
    const decoded: unknown = JSON.parse(cipher.decryptString(Buffer.from(envelope.ciphertext, "base64")));
    if (!isRecord(decoded) || decoded.purpose !== purpose || typeof decoded.value !== "string") throw new Error("Invalid encrypted document.");
    return { value: decoded.value, legacy: false };
  } catch {
    throw new Error("Encrypted local data could not be unlocked. Unlock the original system keychain and restart OpenPets; existing data has been preserved.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import electron from "electron";
import { encryptPrivateDocument, requirePrivateStorageEncryption, type PrivateStorageEncryption } from "./private-storage-encryption.js";

/**
 * Encrypted per-plugin credential store (§13.3): values are encrypted with
 * Electron `safeStorage` (OS keychain-backed where available) and persisted as
 * base64 ciphertext, scoped per plugin id. Values are returned only to the
 * owning plugin (the bridge passes the plugin id).
 */

type SecretsFile = Record<string, Record<string, string>>;
export type PluginSecretStatus = "missing" | "available" | "unavailable";

export class PluginSecretsStore {
  readonly #path: string;
  #data: SecretsFile;
  readonly #encryption: PrivateStorageEncryption | undefined;
  readonly #persist?: (path: string, contents: string) => void;
  #loadFailure: string | undefined;
  #recoveryCreated = false;

  constructor(userDataPath: string, options: {
    readonly encryption?: PrivateStorageEncryption;
    /** Test seam for an atomic ciphertext write failure. */
    readonly persist?: (path: string, contents: string) => void;
  } = {}) {
    this.#path = join(userDataPath, "plugin-secrets.json");
    this.#encryption = options.encryption ?? electron?.safeStorage;
    this.#persist = options.persist;
    this.#data = this.#read();
  }

  async get(pluginId: string, key: string): Promise<string | undefined> {
    return this.#decrypt(pluginId, key);
  }

  /** Readability is distinct from raw ciphertext presence after an OS-key migration. */
  async getStatus(pluginId: string, key: string): Promise<PluginSecretStatus> {
    if (this.#loadFailure) return "unavailable";
    if (this.#data[pluginId]?.[key] === undefined) return "missing";
    return this.#decrypt(pluginId, key) === undefined ? "unavailable" : "available";
  }

  #decrypt(pluginId: string, key: string): string | undefined {
    const encrypted = this.#data[pluginId]?.[key];
    if (encrypted === undefined) return undefined;
    try {
      return requirePrivateStorageEncryption(this.#encryption).decryptString(Buffer.from(encrypted, "base64"));
    } catch {
      return undefined;
    }
  }

  async set(pluginId: string, key: string, value: string): Promise<void> {
    const encrypted = requirePrivateStorageEncryption(this.#encryption).encryptString(value).toString("base64");
    const next = { ...this.#data, [pluginId]: { ...(this.#data[pluginId] ?? {}), [key]: encrypted } };
    this.#write(next);
    this.#data = next;
  }

  async delete(pluginId: string, key: string): Promise<void> {
    const plugin = { ...(this.#data[pluginId] ?? {}) };
    delete plugin[key];
    const next = { ...this.#data, [pluginId]: plugin };
    this.#write(next);
    this.#data = next;
  }

  async has(pluginId: string, key: string): Promise<boolean> {
    return await this.getStatus(pluginId, key) === "available";
  }

  /** Remove every secret a plugin owns (uninstall). */
  async clearPlugin(pluginId: string): Promise<void> {
    const next = { ...this.#data };
    delete next[pluginId];
    this.#write(next);
    this.#data = next;
  }

  #read(): SecretsFile {
    try {
      if (!existsSync(this.#path)) return {};
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
      if (!isRecord(parsed)) throw new Error("Invalid secret store.");
      const entries: [string, Record<string, string>][] = [];
      for (const [pluginId, secrets] of Object.entries(parsed)) {
        if (!isRecord(secrets) || Object.values(secrets).some((value) => typeof value !== "string")) throw new Error("Invalid secret store.");
        entries.push([pluginId, Object.fromEntries(Object.entries(secrets).map(([key, value]) => [key, String(value)]))]);
      }
      return Object.fromEntries(entries);
    } catch {
      this.#loadFailure = "The credential store could not be read. Existing data has been preserved; restore the original credential file before changing credentials.";
      return {};
    }
  }

  #write(data: SecretsFile): void {
    if (this.#loadFailure) throw new Error(this.#loadFailure);
    requirePrivateStorageEncryption(this.#encryption);
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    // An explicit re-entry/delete may replace unreadable ciphertext from an old
    // mock keychain. Wrap its original bytes in real OS encryption before any
    // mutation, without ever decoding those historical credentials.
    if (!this.#recoveryCreated && existsSync(this.#path)
      && Object.entries(this.#data).some(([pluginId, values]) => Object.keys(values).some((key) => this.#decrypt(pluginId, key) === undefined))) {
      const recovery = encryptPrivateDocument(readFileSync(this.#path, "utf8"), "credential-recovery", this.#encryption);
      writeFileSync(`${this.#path}.unreadable-${randomUUID()}`, recovery, { mode: 0o600, flag: "wx" });
      this.#recoveryCreated = true;
    }
    const contents = JSON.stringify(data, null, 2);
    if (this.#persist) {
      this.#persist(this.#path, contents);
      return;
    }
    const tmp = `${this.#path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, contents, { mode: 0o600, flag: "wx" });
      renameSync(tmp, this.#path);
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

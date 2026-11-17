import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { decryptPrivateDocument, encryptPrivateDocument, requirePrivateStorageEncryption, type PrivateStorageEncryption } from "./private-storage-encryption.js";
import { retryWindowsLockedRename } from "./state-file-rename.js";

export const PET_ASSISTANT_CONVERSATION_ID = "openpets-control-center-current";
export const PET_ASSISTANT_ARCHIVE_FILE_NAME = "openpets-conversation-history.json";
export const LOCAL_CONVERSATION_ARCHIVE_MAX_MESSAGES = 200;
export const LOCAL_CONVERSATION_ARCHIVE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const LOCAL_CONVERSATION_ARCHIVE_MAX_BYTES = 512 * 1024;
export const LOCAL_CONVERSATION_ARCHIVE_MAX_MESSAGE_BYTES = 64 * 1024;
export const PET_ASSISTANT_ARCHIVED_CONTEXT_MAX_MESSAGES = 24;
export const PET_ASSISTANT_ARCHIVED_CONTEXT_MAX_BYTES = 128 * 1024;

export type PetAssistantArchivedMessage = {
  readonly id: string;
  readonly conversationId: typeof PET_ASSISTANT_CONVERSATION_ID;
  readonly turnId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: number;
};

export type PetAssistantArchiveMessageInput = {
  readonly turnId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
};

export type PetAssistantConversationArchiveOptions = {
  readonly userDataPath?: string;
  readonly archivePath?: string;
  readonly now?: () => number;
  readonly encryption?: PrivateStorageEncryption;
  readonly onDiagnostic?: (message: string, fields?: Record<string, unknown>) => void;
  /** Test seam for simulating an atomic persistence failure. */
  readonly persist?: (path: string, contents: string) => void;
};

export interface PetAssistantConversationArchive {
  list(now?: number): readonly PetAssistantArchivedMessage[];
  append(messages: readonly PetAssistantArchiveMessageInput[], now?: number): void;
  deleteMessage(id: string): boolean;
  clear(): void;
}

/** Open local history without making archive availability a prerequisite for the assistant host. */
export function openLocalPetAssistantConversationArchive(options: PetAssistantConversationArchiveOptions): PetAssistantConversationArchive | undefined {
  try {
    return new LocalPetAssistantConversationArchive(options);
  } catch (error) {
    options.onDiagnostic?.("Pet Assistant conversation archive is unavailable for this session.", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return undefined;
  }
}

type ArchiveFile = {
  readonly version: 1;
  readonly messages: readonly PetAssistantArchivedMessage[];
};

export class LocalPetAssistantConversationArchive implements PetAssistantConversationArchive {
  readonly path: string;
  readonly #now: () => number;
  readonly #persist: (path: string, contents: string) => void;
  readonly #encryption: PrivateStorageEncryption;
  #messages: readonly PetAssistantArchivedMessage[] = [];

  constructor(options: PetAssistantConversationArchiveOptions) {
    if ((options.userDataPath === undefined) === (options.archivePath === undefined)) {
      throw new Error("Conversation archive requires exactly one path source.");
    }
    this.path = options.archivePath ?? join(options.userDataPath!, PET_ASSISTANT_ARCHIVE_FILE_NAME);
    this.#now = options.now ?? Date.now;
    this.#persist = options.persist ?? persistArchiveFile;
    this.#encryption = requirePrivateStorageEncryption(options.encryption);

    const loaded = readArchiveFile(this.path, this.#encryption);
    if (loaded.corrupt) {
      throw new Error("Pet Assistant conversation archive is invalid. Existing messages have been preserved; repair or restore the file before restarting OpenPets.");
    }

    const retained = retainMessages(loaded.messages, this.#now());
    if (loaded.missing || loaded.legacy || !sameMessages(loaded.messages, retained)) this.#persistMessages(retained);
    this.#messages = retained;
  }

  list(now = this.#now()): readonly PetAssistantArchivedMessage[] {
    requirePrivateStorageEncryption(this.#encryption);
    const retained = retainMessages(this.#messages, now);
    if (!sameMessages(this.#messages, retained)) {
      this.#persistMessages(retained);
      this.#messages = retained;
    }
    return this.#messages.map((message) => Object.freeze({ ...message }));
  }

  append(messages: readonly PetAssistantArchiveMessageInput[], now = this.#now()): void {
    if (!Number.isSafeInteger(now) || now < 1) throw new Error("Conversation archive timestamp is invalid.");
    const appended = messages.map((message) => {
      validateInput(message);
      const entry: PetAssistantArchivedMessage = {
        id: randomUUID(),
        conversationId: PET_ASSISTANT_CONVERSATION_ID,
        turnId: message.turnId,
        role: message.role,
        text: message.text,
        createdAt: now,
      };
      return Object.freeze(entry);
    });
    if (appended.length === 0) return;
    const retained = retainMessages([...this.#messages, ...appended], now);
    this.#persistMessages(retained);
    this.#messages = retained;
  }

  deleteMessage(id: string): boolean {
    if (typeof id !== "string" || id.trim() === "") return false;
    const retained = this.#messages.filter((message) => message.id !== id);
    if (retained.length === this.#messages.length) return false;
    this.#persistMessages(retained);
    this.#messages = retained;
    return true;
  }

  clear(): void {
    this.#persistMessages([]);
    this.#messages = [];
  }

  #persistMessages(messages: readonly PetAssistantArchivedMessage[]): void {
    this.#persist(this.path, encryptPrivateDocument(serializeMessages(messages), "assistant-history", this.#encryption));
  }
}

function persistArchiveFile(path: string, contents: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    retryWindowsLockedRename(() => renameSync(tempPath, path));
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Preserve the write error; cleanup can be retried after a transient lock clears.
    }
    throw error;
  }
}

function readArchiveFile(path: string, encryption: PrivateStorageEncryption): { readonly messages: readonly PetAssistantArchivedMessage[]; readonly missing: boolean; readonly corrupt: boolean; readonly legacy: boolean } {
  if (!existsSync(path)) return { messages: [], missing: true, corrupt: false, legacy: false };
  const document = decryptPrivateDocument(readFileSync(path, "utf8"), "assistant-history", encryption);
  try {
    const parsed = JSON.parse(document.value) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.messages)) return { messages: [], missing: false, corrupt: true, legacy: document.legacy };
    const ids = new Set<string>();
    const messages = parsed.messages.map((value) => normalizeMessage(value, ids));
    if (messages.some((message) => message === null)) return { messages: [], missing: false, corrupt: true, legacy: document.legacy };
    return { messages: messages as PetAssistantArchivedMessage[], missing: false, corrupt: false, legacy: document.legacy };
  } catch {
    return { messages: [], missing: false, corrupt: true, legacy: document.legacy };
  }
}

function normalizeMessage(value: unknown, ids: Set<string>): PetAssistantArchivedMessage | null {
  if (!isRecord(value)
    || typeof value.id !== "string" || value.id.trim() === "" || value.id.length > 256 || ids.has(value.id)
    || value.conversationId !== PET_ASSISTANT_CONVERSATION_ID
    || typeof value.turnId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.turnId)
    || (value.role !== "user" && value.role !== "assistant")
    || typeof value.text !== "string" || value.text.trim() === ""
    || Buffer.byteLength(value.text, "utf8") > LOCAL_CONVERSATION_ARCHIVE_MAX_MESSAGE_BYTES
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 1) return null;
  ids.add(value.id);
  return Object.freeze({
    id: value.id,
    conversationId: PET_ASSISTANT_CONVERSATION_ID,
    turnId: value.turnId,
    role: value.role,
    text: value.text,
    createdAt: value.createdAt,
  });
}

function validateInput(value: PetAssistantArchiveMessageInput): void {
  if (!value || typeof value !== "object" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.turnId)
    || (value.role !== "user" && value.role !== "assistant")
    || typeof value.text !== "string" || value.text.trim() === ""
    || Buffer.byteLength(value.text, "utf8") > LOCAL_CONVERSATION_ARCHIVE_MAX_MESSAGE_BYTES) {
    throw new Error("Conversation archive message is invalid.");
  }
}

function retainMessages(messages: readonly PetAssistantArchivedMessage[], now: number): readonly PetAssistantArchivedMessage[] {
  if (!Number.isSafeInteger(now) || now < 1) throw new Error("Conversation archive timestamp is invalid.");
  const cutoff = now - LOCAL_CONVERSATION_ARCHIVE_MAX_AGE_MS;
  const retained = messages.filter((message) => message.createdAt >= cutoff).slice(-LOCAL_CONVERSATION_ARCHIVE_MAX_MESSAGES);
  while (retained.length > 0 && byteLength(serializeMessages(retained)) > LOCAL_CONVERSATION_ARCHIVE_MAX_BYTES) retained.shift();
  return retained;
}

function serializeMessages(messages: readonly PetAssistantArchivedMessage[]): string {
  const value: ArchiveFile = { version: 1, messages };
  return JSON.stringify(value, null, 2);
}

function byteLength(value: string): number { return Buffer.byteLength(value, "utf8"); }

function sameMessages(left: readonly PetAssistantArchivedMessage[], right: readonly PetAssistantArchivedMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => message.id === right[index]?.id);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

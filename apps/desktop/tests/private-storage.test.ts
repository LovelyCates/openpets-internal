import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestPrivateStorageEncryption, readPrivateTestDocument, testPrivateStorageEncryption } from "./helpers/private-storage.js";
import {
  buildProviderControlCenterSnapshot, createProviderProfile, getPluginPlatformSettings,
  initializePluginPlatformSettings, saveProviderConfiguration, updatePluginPlatformSettings,
  updateProviderProfile,
} from "../src/plugin-platform-settings.js";
import { LocalPetAssistantConversationArchive, openLocalPetAssistantConversationArchive, PET_ASSISTANT_CONVERSATION_ID } from "../src/pet-assistant-archive.js";
import { PetAssistantMemory } from "../src/pet-assistant-memory.js";
import { PluginSecretsStore } from "../src/plugin-secrets.js";
import { decryptPrivateDocument } from "../src/private-storage-encryption.js";

const root = mkdtempSync(join(tmpdir(), "openpets-private-storage-"));
const fakeCredential = "isolated-fake-api-key-NEVER-USE";
const fakeMessage = "isolated-private-conversation-NEVER-USE";
const unavailable = { ...testPrivateStorageEncryption, isEncryptionAvailable: () => false };
try {
  // Existing X-Api-Key and ordinary routing headers remain functional, encrypted at rest and redacted in UI.
  const settingsRoot = join(root, "settings");
  initializePluginPlatformSettings(settingsRoot, { encryption: testPrivateStorageEncryption });
  createProviderProfile({ id: "custom-provider", label: "Custom", adapter: "openai-compatible-text", model: "test-model", baseUrl: "https://example.invalid/v1", headers: [{ name: "X-Api-Key", value: fakeCredential }, { name: "X-Route", value: "test-route" }] });
  const settingsPath = join(settingsRoot, "openpets-plugin-platform.json");
  assert.equal(readFileSync(settingsPath, "utf8").includes(fakeCredential), false, "static credentials must never be written as plaintext JSON");
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).format, "openpets.safe-storage");
  assert.deepEqual(initializePluginPlatformSettings(settingsRoot, { encryption: testPrivateStorageEncryption }).profiles["custom-provider"]?.headers, [{ name: "X-Api-Key", value: fakeCredential }, { name: "X-Route", value: "test-route" }]);
  updateProviderProfile("custom-provider", { headerPatch: [{ op: "replace", oldName: "X-Route", name: "X-Route", value: "next-route" }] });
  const snapshot = buildProviderControlCenterSnapshot(getPluginPlatformSettings(), () => false);
  assert.deepEqual(snapshot.profiles[0]?.headerNames, ["X-Api-Key", "X-Route"]);
  assert.equal(JSON.stringify(snapshot).includes(fakeCredential), false);
  assert.equal(JSON.stringify(snapshot).includes("next-route"), false);
  if (process.platform !== "win32") assert.equal(statSync(settingsPath).mode & 0o777, 0o600);

  // Legacy plaintext migration preserves custom headers, roles and quarantined recovery data without a plaintext backup.
  const legacy = JSON.stringify({ version: 1, profiles: { old: { id: "old", label: "Old", adapter: "openai-compatible-text", model: "old-model", baseUrl: "https://example.invalid/v1", headers: [{ name: "X-Api-Key", value: fakeCredential }] } }, quarantinedProfiles: { broken: { reason: "old invalid configuration", value: { headers: [{ name: "X-Token", value: fakeCredential }] } } }, selections: { text: "old" } });
  writeFileSync(settingsPath, legacy);
  const migrated = initializePluginPlatformSettings(settingsRoot, { encryption: testPrivateStorageEncryption });
  assert.equal(migrated.profiles.old?.headers?.[0]?.value, fakeCredential);
  assert.equal(migrated.selections.text, "old");
  assert.ok(JSON.stringify(migrated.quarantinedProfiles).includes(fakeCredential));
  assert.equal(readFileSync(settingsPath, "utf8").includes(fakeCredential), false);
  assert.deepEqual(readdirSync(settingsRoot), ["openpets-plugin-platform.json"]);

  // Migration never replaces original bytes on encryption, keychain or atomic-write failure.
  for (const options of [
    { encryption: unavailable },
    { encryption: { ...testPrivateStorageEncryption, encryptString: () => { throw new Error("test encryption unavailable"); } } },
    { encryption: testPrivateStorageEncryption, persist: () => { throw new Error("test atomic write failed"); } },
  ]) {
    writeFileSync(settingsPath, legacy);
    const blocked = initializePluginPlatformSettings(settingsRoot, options);
    assert.equal(readFileSync(settingsPath, "utf8"), legacy);
    assert.equal(buildProviderControlCenterSnapshot(blocked, () => false).statuses.text.code, "provider.storage.unavailable");
    assert.throws(() => updatePluginPlatformSettings({ allowPluginAudio: false }));
    assert.equal(readFileSync(settingsPath, "utf8"), legacy);
  }
  initializePluginPlatformSettings(settingsRoot, { encryption: testPrivateStorageEncryption });
  const durableSettings = readFileSync(settingsPath, "utf8");
  const damagedEnvelope = JSON.parse(durableSettings);
  damagedEnvelope.format = "openpets.safe-storagX";
  const damagedSettings = JSON.stringify(damagedEnvelope);
  writeFileSync(settingsPath, damagedSettings);
  const damaged = initializePluginPlatformSettings(settingsRoot, { encryption: testPrivateStorageEncryption });
  assert.equal(buildProviderControlCenterSnapshot(damaged, () => false).statuses.text.code, "provider.storage.unavailable");
  assert.equal(readFileSync(settingsPath, "utf8"), damagedSettings, "a damaged envelope must never be migrated as empty legacy settings");
  writeFileSync(settingsPath, durableSettings);
  const locked = initializePluginPlatformSettings(settingsRoot, { encryption: createTestPrivateStorageEncryption() });
  assert.equal(locked.selections.text, null);
  assert.equal(readFileSync(settingsPath, "utf8"), durableSettings, "a different OS key cannot erase the original encrypted settings");

  // A settings-write failure rolls back canonical credential changes and keeps memory aligned with disk.
  initializePluginPlatformSettings(settingsRoot, { encryption: testPrivateStorageEncryption });
  const before = getPluginPlatformSettings();
  initializePluginPlatformSettings(settingsRoot, { encryption: testPrivateStorageEncryption, persist: () => { throw new Error("test disk failure"); } });
  const credentials = new Map<string, string>();
  await assert.rejects(() => saveProviderConfiguration({ isEditing: true, profileId: "old", payload: { label: "Unsaved" }, credentialValue: fakeCredential, activatedRoles: [], deactivatedRoles: [] }, {
    get: async (ref) => credentials.get(ref),
    set: async (ref, value) => { credentials.set(ref, value); },
    delete: async (ref) => { credentials.delete(ref); },
  }), /test disk failure/);
  assert.equal(credentials.size, 0);
  assert.deepEqual(getPluginPlatformSettings(), before);
  assert.equal(readFileSync(settingsPath, "utf8"), durableSettings);

  // Terminal assistant text is encrypted on disk, survives reopen and remains under the existing owner.
  const historyPath = join(root, "history.json");
  const archive = new LocalPetAssistantConversationArchive({ archivePath: historyPath, encryption: testPrivateStorageEncryption, now: () => 1_000_000 });
  archive.append([{ turnId: "test-turn", role: "user", text: fakeMessage }]);
  assert.equal(readFileSync(historyPath, "utf8").includes(fakeMessage), false, "archive text must never be written as plaintext JSON");
  assert.equal(new LocalPetAssistantConversationArchive({ archivePath: historyPath, encryption: testPrivateStorageEncryption, now: () => 1_000_000 }).list()[0]?.text, fakeMessage);
  if (process.platform !== "win32") assert.equal(statSync(historyPath).mode & 0o777, 0o600);

  const legacyHistory = JSON.stringify({ version: 1, messages: [{ id: "00000000-0000-4000-8000-000000000001", conversationId: PET_ASSISTANT_CONVERSATION_ID, turnId: "test-turn", role: "user", text: fakeMessage, createdAt: 1_000_000 }] });
  const invalidHistory = `{"private-text":"${fakeMessage}"`;
  writeFileSync(historyPath, invalidHistory);
  const diagnostics: unknown[] = [];
  assert.equal(openLocalPetAssistantConversationArchive({ archivePath: historyPath, encryption: testPrivateStorageEncryption, onDiagnostic: (message, fields) => diagnostics.push({ message, fields }) }), undefined);
  assert.equal(JSON.stringify(diagnostics).includes(fakeMessage), false, "invalid JSON previews must never leak private conversation text to diagnostics");
  assert.equal(readFileSync(historyPath, "utf8"), invalidHistory);
  for (const options of [
    { encryption: unavailable },
    { encryption: { ...testPrivateStorageEncryption, encryptString: () => { throw new Error("test encryption unavailable"); } } },
    { encryption: testPrivateStorageEncryption, persist: () => { throw new Error("test migration write failed"); } },
  ]) {
    writeFileSync(historyPath, legacyHistory);
    assert.equal(openLocalPetAssistantConversationArchive({ archivePath: historyPath, now: () => 1_000_000, ...options }), undefined);
    assert.equal(readFileSync(historyPath, "utf8"), legacyHistory, "failed migration preserves every original message");
  }
  const migratedArchive = new LocalPetAssistantConversationArchive({ archivePath: historyPath, encryption: testPrivateStorageEncryption, now: () => 1_000_000 });
  assert.equal(migratedArchive.list()[0]?.text, fakeMessage);
  assert.equal(readFileSync(historyPath, "utf8").includes(fakeMessage), false);
  assert.equal(JSON.parse(readPrivateTestDocument(historyPath, "assistant-history")).messages[0].text, fakeMessage);
  const durableHistory = readFileSync(historyPath, "utf8");
  assert.throws(() => new LocalPetAssistantConversationArchive({ archivePath: historyPath, encryption: createTestPrivateStorageEncryption() }), /could not be unlocked/);
  assert.equal(readFileSync(historyPath, "utf8"), durableHistory);
  const memory = new PetAssistantMemory(2);
  assert.throws(() => memory.getConversationHistory(), /Encrypted conversation history is unavailable/);
  assert.throws(() => memory.clearConversationHistory(), /Existing messages have been preserved/);
  assert.throws(() => memory.deleteConversationHistoryMessage("test"), /unavailable/);
  let available = true;
  const toggledArchive = new LocalPetAssistantConversationArchive({ archivePath: historyPath, encryption: { ...testPrivateStorageEncryption, isEncryptionAvailable: () => available }, now: () => 1_000_000 });
  available = false;
  assert.throws(() => toggledArchive.list(), /OS encrypted storage is unavailable/);
  assert.throws(() => toggledArchive.append([{ turnId: "unsaved", role: "assistant", text: "must stay in memory only" }]), /unavailable/);
  assert.throws(() => toggledArchive.clear(), /unavailable/);
  assert.equal(readFileSync(historyPath, "utf8"), durableHistory, "losing the backend mid-session cannot overwrite existing encrypted messages");
  // Older mock-keychain credentials are unreadable under a real OS key, never silently ready or discarded.
  const secretsRoot = join(root, "credentials");
  const secretPath = join(secretsRoot, "plugin-secrets.json");
  const originalStore = new PluginSecretsStore(secretsRoot, { encryption: testPrivateStorageEncryption });
  await originalStore.set("host", "provider-key", fakeCredential);
  const originalCiphertext = readFileSync(secretPath, "utf8");
  assert.equal(originalCiphertext.includes(fakeCredential), false);
  const migratedEncryption = createTestPrivateStorageEncryption();
  const migratedStore = new PluginSecretsStore(secretsRoot, { encryption: migratedEncryption });
  assert.equal(await migratedStore.getStatus("host", "provider-key"), "unavailable");
  assert.equal(await migratedStore.has("host", "provider-key"), false);
  assert.equal(await migratedStore.get("host", "provider-key"), undefined);
  assert.equal(readFileSync(secretPath, "utf8"), originalCiphertext);
  assert.deepEqual(readdirSync(secretsRoot), ["plugin-secrets.json"], "reading an unavailable key does not mutate the credential file");
  const unavailableSnapshot = buildProviderControlCenterSnapshot({ ...before, profiles: { old: { id: "old", label: "Unavailable", adapter: "openai-compatible-text", model: "test", baseUrl: "https://example.invalid/v1", secretRef: "provider-key" } } }, () => false, () => true);
  assert.equal(unavailableSnapshot.statuses.text.code, "provider.credential.unavailable");
  assert.match(unavailableSnapshot.statuses.text.message, /re-enter/);
  await migratedStore.set("host", "provider-key", "isolated replacement credential");
  assert.equal(await migratedStore.getStatus("host", "provider-key"), "available");
  assert.equal(await migratedStore.get("host", "provider-key"), "isolated replacement credential");
  const recoveryFile = readdirSync(secretsRoot).find((name) => name.startsWith("plugin-secrets.json.unreadable-"));
  assert.ok(recoveryFile);
  const recoveryContents = readFileSync(join(secretsRoot, recoveryFile), "utf8");
  assert.equal(recoveryContents.includes(JSON.parse(originalCiphertext).host["provider-key"]), false, "a new recovery file must not expose historical weak-key ciphertext");
  assert.equal(JSON.parse(recoveryContents).purpose, "credential-recovery");
  assert.equal(decryptPrivateDocument(recoveryContents, "credential-recovery", migratedEncryption).value, originalCiphertext, "the OS-encrypted recovery document preserves the exact original file without weak-key decoding");
  if (process.platform !== "win32") assert.equal(statSync(join(secretsRoot, recoveryFile)).mode & 0o777, 0o600);
  assert.equal(readFileSync(secretPath, "utf8").includes("isolated replacement credential"), false);
  writeFileSync(secretPath, originalCiphertext);
  const failedWriteStore = new PluginSecretsStore(secretsRoot, { encryption: testPrivateStorageEncryption, persist: () => { throw new Error("test credential write failed"); } });
  await assert.rejects(() => failedWriteStore.set("host", "provider-key", "unsaved fake credential"), /test credential write failed/);
  await assert.rejects(() => failedWriteStore.delete("host", "provider-key"), /test credential write failed/);
  assert.equal(await failedWriteStore.get("host", "provider-key"), fakeCredential);
  assert.equal(readFileSync(secretPath, "utf8"), originalCiphertext);
  const invalidSecrets = "{invalid original credential file";
  writeFileSync(secretPath, invalidSecrets);
  const invalidStore = new PluginSecretsStore(secretsRoot, { encryption: testPrivateStorageEncryption });
  assert.equal(await invalidStore.getStatus("host", "provider-key"), "unavailable");
  await assert.rejects(() => invalidStore.set("host", "new-key", "fake"), /could not be read/);
  await assert.rejects(() => invalidStore.clearPlugin("host"), /could not be read/);
  assert.equal(readFileSync(secretPath, "utf8"), invalidSecrets);
  assert.deepEqual(readdirSync(root).sort(), ["credentials", "history.json", "settings"]);
  console.log("Encrypted provider headers/history, safe legacy migration, unavailable-keychain status and rollback verified.");
} finally {
  rmSync(root, { recursive: true, force: true });
}

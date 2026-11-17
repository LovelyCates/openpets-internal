import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readPrivateTestDocument, testPrivateStorageEncryption } from "./helpers/private-storage.js";

const testGlobal = globalThis as typeof globalThis & {
  __openPetsWindowsPrivateRenameTest: { targetPath: string; failuresRemaining: number };
};
testGlobal.__openPetsWindowsPrivateRenameTest = { targetPath: "", failuresRemaining: 0 };

const fsMock = `data:text/javascript,${encodeURIComponent(`
  export * from "node:fs";
  import { renameSync as realRenameSync } from "node:fs";
  export function renameSync(from, to) {
    const test = globalThis.__openPetsWindowsPrivateRenameTest;
    if (String(to) === test.targetPath && test.failuresRemaining > 0) {
      test.failuresRemaining -= 1;
      const error = new Error("The destination is temporarily locked.");
      error.code = "EPERM";
      throw error;
    }
    return realRenameSync(from, to);
  }
`)}`;
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "node:fs" && (
      context.parentURL?.endsWith("/src/plugin-sdk-bridge.js")
      || context.parentURL?.endsWith("/src/pet-assistant-archive.js")
    )) return { url: ${JSON.stringify(fsMock)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);

const { JsonPluginStorageStore } = await import("../src/plugin-sdk-bridge.js");
const { LocalPetAssistantConversationArchive } = await import("../src/pet-assistant-archive.js");

test("Windows plugin storage commits through a brief lock and preserves its prior value on lasting failure", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "openpets-plugin-storage-rename-"));
  try {
    const store = new JsonPluginStorageStore(root);
    const path = join(root, "example.plugin.json");
    store.set("example.plugin", "counter", 1);
    testGlobal.__openPetsWindowsPrivateRenameTest = { targetPath: path, failuresRemaining: 2 };
    store.set("example.plugin", "counter", 2);
    assert.equal(store.get("example.plugin", "counter"), 2);
    const committed = readFileSync(path);

    testGlobal.__openPetsWindowsPrivateRenameTest.failuresRemaining = 6;
    assert.throws(() => store.set("example.plugin", "counter", 3), { code: "EPERM" });
    assert.deepEqual(readFileSync(path), committed);
    assert.equal(store.get("example.plugin", "counter"), 2);
    assert.equal(readdirSync(root).some((name) => name.endsWith(".tmp")), false);
  } finally {
    testGlobal.__openPetsWindowsPrivateRenameTest = { targetPath: "", failuresRemaining: 0 };
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows assistant history keeps encrypted disk and memory state on lasting rename failure", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "openpets-history-rename-"));
  try {
    const path = join(root, "history.json");
    const archive = new LocalPetAssistantConversationArchive({
      archivePath: path,
      encryption: testPrivateStorageEncryption,
      now: () => 3_500_000,
    });
    archive.append([{ turnId: "first", role: "user", text: "First" }]);
    testGlobal.__openPetsWindowsPrivateRenameTest = { targetPath: path, failuresRemaining: 2 };
    archive.append([{ turnId: "second", role: "assistant", text: "Second" }]);
    assert.deepEqual(archive.list().map((message) => message.text), ["First", "Second"]);
    const committed = readFileSync(path);
    assert.equal(JSON.parse(readPrivateTestDocument(path, "assistant-history")).messages.length, 2);

    testGlobal.__openPetsWindowsPrivateRenameTest.failuresRemaining = 6;
    assert.throws(() => archive.append([{ turnId: "third", role: "user", text: "Never committed" }]), { code: "EPERM" });
    assert.deepEqual(readFileSync(path), committed);
    assert.deepEqual(archive.list().map((message) => message.text), ["First", "Second"]);
    assert.equal(readdirSync(root).some((name) => name.endsWith(".tmp")), false);
  } finally {
    testGlobal.__openPetsWindowsPrivateRenameTest = { targetPath: "", failuresRemaining: 0 };
    rmSync(root, { recursive: true, force: true });
  }
});

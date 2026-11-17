import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { testPrivateStorageEncryption } from "./helpers/private-storage.js";

const testGlobal = globalThis as typeof globalThis & {
  __openPetsSecretsFileTest: { renameFailuresRemaining: number };
};
testGlobal.__openPetsSecretsFileTest = { renameFailuresRemaining: 0 };
const fsMock = `data:text/javascript,${encodeURIComponent(`
  export * from "node:fs";
  import { renameSync as realRenameSync } from "node:fs";
  export function renameSync(from, to) {
    const test = globalThis.__openPetsSecretsFileTest;
    if (String(to).endsWith("plugin-secrets.json") && test.renameFailuresRemaining > 0) {
      test.renameFailuresRemaining -= 1;
      const error = new Error("Credential file is temporarily locked.");
      error.code = "EPERM";
      throw error;
    }
    return realRenameSync(from, to);
  }
`)}`;
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "node:fs" && context.parentURL?.endsWith("/src/plugin-secrets.js")) {
      return { url: ${JSON.stringify(fsMock)}, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);

test("Windows encrypted plugin credentials survive brief file contention and roll back a failed save", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "openpets-secrets-retry-"));
  try {
    const { PluginSecretsStore } = await import("../src/plugin-secrets.js");
    const store = new PluginSecretsStore(root, { encryption: testPrivateStorageEncryption });
    await store.set("local-plugin", "token", "first-secret");
    testGlobal.__openPetsSecretsFileTest.renameFailuresRemaining = 2;
    await store.set("local-plugin", "token", "second-secret");
    const path = join(root, "plugin-secrets.json");
    const committed = readFileSync(path);
    assert.equal(committed.toString("utf8").includes("second-secret"), false);
    assert.equal(await store.get("local-plugin", "token"), "second-secret");

    testGlobal.__openPetsSecretsFileTest.renameFailuresRemaining = 6;
    await assert.rejects(() => store.set("local-plugin", "token", "unsaved-secret"), { code: "EPERM" });
    assert.deepEqual(readFileSync(path), committed);
    assert.equal(await store.get("local-plugin", "token"), "second-secret");
    assert.equal(await new PluginSecretsStore(root, { encryption: testPrivateStorageEncryption }).get("local-plugin", "token"), "second-secret");
    assert.deepEqual(readdirSync(root), ["plugin-secrets.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

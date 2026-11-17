import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPrivateTestDocument, testPrivateStorageEncryption } from "./helpers/private-storage.js";

const testGlobal = globalThis as typeof globalThis & {
  __openPetsProviderSettingsFileTest: { renameFailuresRemaining: number };
};
testGlobal.__openPetsProviderSettingsFileTest = { renameFailuresRemaining: 0 };
const fsMock = `data:text/javascript,${encodeURIComponent(`
  export * from "node:fs";
  import { renameSync as realRenameSync } from "node:fs";
  export function renameSync(from, to) {
    const test = globalThis.__openPetsProviderSettingsFileTest;
    if (String(to).endsWith("openpets-plugin-platform.json") && test.renameFailuresRemaining > 0) {
      test.renameFailuresRemaining -= 1;
      const error = new Error("Provider settings file is temporarily locked.");
      error.code = "EPERM";
      throw error;
    }
    return realRenameSync(from, to);
  }
`)}`;
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "node:fs" && context.parentURL?.endsWith("/src/plugin-platform-settings.js")) {
      return { url: ${JSON.stringify(fsMock)}, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);

const { createProviderProfile, getPluginPlatformSettings, initializePluginPlatformSettings, updateProviderProfile } = await import("../src/plugin-platform-settings.js");
const userData = mkdtempSync(join(tmpdir(), "openpets-provider-settings-file-"));

try {
  initializePluginPlatformSettings(userData, { encryption: testPrivateStorageEncryption });
  createProviderProfile({
    id: "persist-check",
    label: "Before",
    adapter: "openai-compatible-text",
    model: "model",
    baseUrl: "https://example.test/v1",
  });
  const statePath = join(userData, "openpets-plugin-platform.json");

  if (process.platform === "win32") testGlobal.__openPetsProviderSettingsFileTest.renameFailuresRemaining = 2;
  updateProviderProfile("persist-check", { label: "After" });
  const committed = readFileSync(statePath);
  const disk = JSON.parse(readPrivateTestDocument(statePath, "provider-settings")) as {
    profiles: Record<string, { label: string }>;
  };
  assert.equal(disk.profiles["persist-check"].label, "After");
  assert.equal(getPluginPlatformSettings().profiles["persist-check"].label, "After");

  testGlobal.__openPetsProviderSettingsFileTest.renameFailuresRemaining = process.platform === "win32" ? 6 : 1;
  assert.throws(() => updateProviderProfile("persist-check", { label: "Never committed" }), { code: "EPERM" });
  assert.deepEqual(readFileSync(statePath), committed);
  assert.equal(getPluginPlatformSettings().profiles["persist-check"].label, "After");
  assert.equal(readdirSync(userData).some((name) => name.endsWith(".tmp")), false);
  assert.equal(existsSync(statePath), true);
} finally {
  rmSync(userData, { recursive: true, force: true });
}

console.error("Provider settings atomic file validation passed.");

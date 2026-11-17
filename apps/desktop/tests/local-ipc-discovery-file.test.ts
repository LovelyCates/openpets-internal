import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const testGlobal = globalThis as typeof globalThis & {
  __openPetsDiscoveryFileTest: { renameFailuresRemaining: number };
};
testGlobal.__openPetsDiscoveryFileTest = { renameFailuresRemaining: 0 };
const fsMock = `data:text/javascript,${encodeURIComponent(`
  export * from "node:fs";
  import { renameSync as realRenameSync } from "node:fs";
  export function renameSync(from, to) {
    const test = globalThis.__openPetsDiscoveryFileTest;
    if (String(to).endsWith("ipc.json") && test.renameFailuresRemaining > 0) {
      test.renameFailuresRemaining -= 1;
      const error = new Error("Discovery file is temporarily locked.");
      error.code = "EPERM";
      throw error;
    }
    return realRenameSync(from, to);
  }
`)}`;
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "node:fs" && context.parentURL?.endsWith("/src/local-ipc-paths.js")) {
      return { url: ${JSON.stringify(fsMock)}, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);

test("Windows IPC discovery survives brief file contention and preserves the last usable file on failure", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "openpets-discovery-retry-"));
  const previousAppData = process.env.APPDATA;
  process.env.APPDATA = root;
  try {
    const { getDiscoveryFilePath, writeDiscoveryFile } = await import("../src/local-ipc-paths.js");
    const path = getDiscoveryFilePath();
    writeDiscoveryFile("\\\\.\\pipe\\openpets-first", "first-token", "4.1.0-internal.15");
    testGlobal.__openPetsDiscoveryFileTest.renameFailuresRemaining = 2;
    writeDiscoveryFile("\\\\.\\pipe\\openpets-second", "second-token", "4.1.0-internal.15");
    const committed = readFileSync(path);
    assert.equal(JSON.parse(committed.toString("utf8")).token, "second-token");

    testGlobal.__openPetsDiscoveryFileTest.renameFailuresRemaining = 6;
    assert.throws(() => writeDiscoveryFile("\\\\.\\pipe\\openpets-third", "unsaved-token", "4.1.0-internal.15"), { code: "EPERM" });
    assert.deepEqual(readFileSync(path), committed);
    assert.equal(existsSync(`${path}.${process.pid}.tmp`), false);
  } finally {
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
    rmSync(root, { recursive: true, force: true });
  }
});

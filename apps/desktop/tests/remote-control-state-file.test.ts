import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testGlobal = globalThis as typeof globalThis & {
  __openPetsRemoteStateFileTest: { renameFailuresRemaining: number };
};
testGlobal.__openPetsRemoteStateFileTest = { renameFailuresRemaining: 0 };
const fsMock = `data:text/javascript,${encodeURIComponent(`
  export * from "node:fs";
  import { renameSync as realRenameSync } from "node:fs";
  export function renameSync(from, to) {
    const test = globalThis.__openPetsRemoteStateFileTest;
    if (String(to).endsWith("remote-state.json") && test.renameFailuresRemaining > 0) {
      test.renameFailuresRemaining -= 1;
      const error = new Error("Remote control state is temporarily locked.");
      error.code = "EPERM";
      throw error;
    }
    return realRenameSync(from, to);
  }
`)}`;
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "node:fs" && context.parentURL?.endsWith("/src/remote-control-state.js")) {
      return { url: ${JSON.stringify(fsMock)}, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);

const { RemoteControlService } = await import("../src/remote-control-service.js");
const directory = mkdtempSync(join(tmpdir(), "openpets-remote-state-file-"));
const statePath = join(directory, "remote-state.json");

try {
  const service = new RemoteControlService({
    statePath,
    getStatusSnapshot: () => ({
      ok: true,
      appRunning: true,
      protocolVersion: 1,
      defaultPet: { id: "builtin", builtIn: true, broken: false },
      paused: false,
      defaultPetVisible: true,
      openDefaultPetOnLaunch: true,
      speechBubblesEnabled: true,
    }),
    applyReaction: () => ({ shown: true }),
    applySay: () => ({ shown: true }),
  });

  if (process.platform === "win32") testGlobal.__openPetsRemoteStateFileTest.renameFailuresRemaining = 2;
  service.pairClient({ name: "First client", scopes: ["status", "react", "say"] });
  const committed = readFileSync(statePath);
  const disk = JSON.parse(committed.toString("utf8")) as { clients: Array<{ name: string }> };
  assert.equal(disk.clients.length, 1);
  assert.equal(disk.clients[0]?.name, "First client");
  assert.equal(service.listClients().length, 1);

  testGlobal.__openPetsRemoteStateFileTest.renameFailuresRemaining = process.platform === "win32" ? 6 : 1;
  assert.throws(() => service.pairClient({ name: "Never committed", scopes: ["status", "react", "say"] }),
    /Remote control state could not be saved/);
  assert.deepEqual(readFileSync(statePath), committed);
  assert.equal(service.listClients().length, 1);
  assert.equal(service.listClients()[0]?.name, "First client");
  assert.equal(readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.error("Remote control state file atomic save validation passed.");

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { win32 } from "node:path";

import type { PluginService } from "../src/plugin-service.js";
import type { PluginStateRecord, PluginStateStore } from "../src/plugin-state.js";

// Exercise the real prune operation under Windows path rules on every host.
// Filesystem effects are recorded, so an invalid root/sibling decision cannot
// delete a real directory while reproducing the Windows separator regression.
const userData = "C:\\Fixture\\User";
const devRoot = win32.join(userData, "plugins-dev");
const scanRoot = "C:\\Fixture\\Source";
const records = new Map<string, PluginStateRecord>();
const realPaths = new Map<string, string>([[scanRoot, scanRoot], [devRoot, devRoot]]);
const removed: string[] = [];
const reloaded: string[] = [];

function add(id: string, installPath: string, realPath?: string): void {
  records.set(id, { id, version: "1.0.0", source: "local", installPath, manifestPath: win32.join(installPath, "openpets.plugin.json"), enabled: true, approvedPermissions: [], config: {} });
  if (realPath !== undefined) realPaths.set(installPath, realPath);
}
add("inside", win32.join(devRoot, "inside"), win32.join(devRoot, "inside"));
add("missing-inside", win32.join(devRoot, "missing-inside"));
add("case-and-separator", "c:/fixture/user/PLUGINS-DEV/case", "c:\\fixture\\user\\PLUGINS-DEV\\case");
add("dot-prefixed-name", win32.join(devRoot, "..safe"), win32.join(devRoot, "..safe"));
add("same-root", devRoot, devRoot);
add("sibling", `${devRoot}-backup\\keep`, `${devRoot}-backup\\keep`);
add("missing-sibling", `${devRoot}-backup\\missing`);
add("parent-escape", `${devRoot}\\..\\plugins\\keep`, win32.join(userData, "plugins", "keep"));
add("missing-parent-escape", `${devRoot}\\..\\plugins\\missing`);
add("other-drive", "D:\\Fixture\\User\\plugins-dev\\keep", "D:\\Fixture\\User\\plugins-dev\\keep");
add("junction-escape", win32.join(devRoot, "linked"), "D:\\Outside\\linked");
add("unc-outside", "\\\\server\\share\\plugins-dev\\keep", "\\\\server\\share\\plugins-dev\\keep");

const testGlobal = globalThis as typeof globalThis & {
  __pluginServiceWinPathFixture?: { realPaths: typeof realPaths; removed: string[]; scanRoot: string };
};
testGlobal.__pluginServiceWinPathFixture = { realPaths, removed, scanRoot };
const moduleUrl = new URL("../src/plugin-service.js?win32-boundaries", import.meta.url).href;
const mockModule = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`;
const windowsPathModule = mockModule(`
  import { win32 } from 'node:path';
  export const { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } = win32;
`);
const filesystemModule = mockModule(`
  import * as native from 'node:fs';
  export const { existsSync, mkdirSync } = native;
  export const promises = {
    ...native.promises,
    async realpath(path) {
      const value = globalThis.__pluginServiceWinPathFixture.realPaths.get(path);
      if (value !== undefined) return value;
      throw Object.assign(new Error('Missing fixture path'), { code: 'ENOENT' });
    },
    async readdir(path) {
      if (path !== globalThis.__pluginServiceWinPathFixture.scanRoot) throw new Error('Unexpected fixture scan');
      return [];
    },
    async rm(path) { globalThis.__pluginServiceWinPathFixture.removed.push(path); },
  };
`);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === moduleUrl) {
      if (specifier === "node:path") return { url: windowsPathModule, shortCircuit: true };
      if (specifier === "node:fs") return { url: filesystemModule, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
try {
  const { PluginService: WindowsPluginService } = await import(moduleUrl) as { PluginService: typeof PluginService };
  const service = new WindowsPluginService({
    userDataPath: userData,
    stateStore: { listRecords: () => [...records.values()], removeRecord: (id: string) => records.delete(id) } as unknown as PluginStateStore,
    runtime: { async reloadPlugin(id: string) { reloaded.push(id); } } as PluginService["runtime"],
  });
  await service.loadLocalRoots([scanRoot], { pruneStale: true });
  assert.deepEqual(reloaded.sort(), ["inside", "missing-inside", "case-and-separator", "dot-prefixed-name"].sort());
  for (const id of ["same-root", "sibling", "missing-sibling", "parent-escape", "missing-parent-escape", "other-drive", "junction-escape", "unc-outside"]) {
    assert.ok(records.has(id), `${id} must remain outside the strict dev-child pruning boundary`);
  }
  assert.equal(removed.includes(devRoot), false);
  assert.equal(removed.some((path) => path.startsWith("D:") || path.startsWith("\\\\")), false);
  console.log("Windows stale-dev pruning respects descendants, missing paths, drive boundaries and canonical junction escapes.");
} finally {
  hooks.deregister();
  delete testGlobal.__pluginServiceWinPathFixture;
}

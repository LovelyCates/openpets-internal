import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";

import { commitPluginInstall } from "../src/plugin-install-transaction.js";
import { PluginStateStore, type PluginStateRecord } from "../src/plugin-state.js";

const id = "durability-plugin";
const manifestName = "openpets.plugin.json";
const assetBytes = Buffer.from([0, 255, 12, 83, 0, 144]);

async function fixture() {
  const userDataPath = await fs.mkdtemp(join(tmpdir(), "openpets-plugin-flush-"));
  const root = join(userDataPath, "plugins");
  const target = join(root, id);
  const stage = join(root, `.tmp-${id}-durability`);
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(stage);
  const store = new PluginStateStore({ userDataPath });
  store.initialize();
  const old: PluginStateRecord = {
    id, version: "1.0.0", source: "catalog", installPath: target,
    manifestPath: join(target, manifestName), enabled: false,
    approvedPermissions: ["timer"], config: { preserved: "existing configuration" },
  };
  const next: PluginStateRecord = { ...old, version: "2.0.0", approvedPermissions: ["timer", "pet:speak"], config: { replacement: true } };
  const manifest = (record: PluginStateRecord) => JSON.stringify({
    manifestVersion: 1, id, name: "Durability fixture", version: record.version,
    runtime: "declarative", permissions: record.approvedPermissions,
    triggers: [{ on: "timer", everyMinutes: 5, actions: [] }],
  });
  await fs.writeFile(join(target, manifestName), manifest(old));
  await fs.writeFile(join(stage, manifestName), manifest(next));
  const asset = join(stage, "binary-asset.bin");
  await fs.writeFile(asset, assetBytes, { mode: 0o600 });
  store.upsertRecord(old);
  return { userDataPath, root, target, stage, asset, store, old, next };
}

// Model the documented Windows FlushFileBuffers access requirement around
// real temporary files. A read-only handle fails its flush, not the initial
// read, so a passing test proves the transaction still performs real syncs.
async function withWindowsFileAccess(
  failure: "none" | "state-flush" | "readonly-stage",
  run: (instance: Awaited<ReturnType<typeof fixture>>, flushed: string[]) => Promise<void>,
): Promise<void> {
  const f = await fixture();
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(originalPlatform);
  const open = fs.open.bind(fs);
  const flushed: string[] = [];
  let stateFailurePending = failure === "state-flush";
  Object.defineProperty(process, "platform", { value: "win32" });
  const interception = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const [path, flags] = args;
    if (failure === "readonly-stage" && path === f.asset && flags === "r+") {
      throw Object.assign(new Error("Fixture staged file is read-only."), { code: "EACCES" });
    }
    const handle = await open(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      if (flags === "r") throw Object.assign(new Error("Windows flush requires write access."), { code: "EBADF" });
      if (path === f.store.statePath && stateFailurePending) {
        stateFailurePending = false;
        throw Object.assign(new Error("Fixture state flush failed."), { code: "EIO" });
      }
      await sync();
      flushed.push(String(path));
    };
    return handle;
  });
  try {
    await run(f, flushed);
  } finally {
    interception.mock.restore();
    Object.defineProperty(process, "platform", originalPlatform);
    await fs.rm(f.userDataPath, { recursive: true, force: true });
  }
}

await withWindowsFileAccess("none", async (f, flushed) => {
  await commitPluginInstall({
    userDataPath: f.userDataPath, id, stagePath: f.stage, previous: f.old, store: f.store,
    activate: async () => { f.store.upsertRecord(f.next); },
  });
  assert.deepEqual(await fs.readFile(join(f.target, "binary-asset.bin")), assetBytes, "flushing must not truncate package bytes");
  assert.equal(f.store.getRecord(id)?.version, "2.0.0");
  assert.equal(JSON.parse(await fs.readFile(f.store.statePath, "utf8")).plugins[id].version, "2.0.0");
  assert.ok(flushed.includes(f.asset), "staged content must be durably flushed before promotion");
  assert.ok(flushed.includes(f.store.statePath), "committed state must be durably flushed");
  assert.deepEqual(await fs.readdir(f.root), [id]);
});

for (const failure of ["state-flush", "readonly-stage"] as const) {
  await withWindowsFileAccess(failure, async (f) => {
    let activated = false;
    await assert.rejects(() => commitPluginInstall({
      userDataPath: f.userDataPath, id, stagePath: f.stage, previous: f.old, store: f.store,
      activate: async () => { activated = true; f.store.upsertRecord(f.next); },
    }), failure === "state-flush" ? /Fixture state flush failed/ : /Fixture staged file is read-only/);
    assert.equal(activated, failure === "state-flush");
    assert.deepEqual(f.store.getRecord(id), f.old, "a write/flush failure must retain the prior configuration and permissions");
    assert.equal(JSON.parse(await fs.readFile(join(f.target, manifestName), "utf8")).version, "1.0.0");
    assert.equal(JSON.parse(await fs.readFile(f.store.statePath, "utf8")).plugins[id].version, "1.0.0");
    assert.deepEqual(await fs.readdir(f.root), [id]);
  });
}

if (process.platform !== "win32") {
  const f = await fixture();
  try {
    await fs.chmod(f.asset, 0o400);
    await commitPluginInstall({
      userDataPath: f.userDataPath, id, stagePath: f.stage, previous: f.old, store: f.store,
      activate: async () => { f.store.upsertRecord(f.next); },
    });
    assert.deepEqual(await fs.readFile(join(f.target, "binary-asset.bin")), assetBytes);
    assert.equal(f.store.getRecord(id)?.version, "2.0.0");
  } finally {
    await fs.rm(f.userDataPath, { recursive: true, force: true });
  }
}
console.log("Plugin durability preserves bytes, flushes with Windows write access, rolls back failures and retains POSIX read-only support.");

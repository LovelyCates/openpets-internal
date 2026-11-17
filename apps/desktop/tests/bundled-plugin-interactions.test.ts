import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createContext, Script } from "node:vm";
import type { WebContents } from "electron";
import type { OpenPetsContext, OpenPetsPluginDefinition } from "@open-pets/plugin-sdk";

import { bundledOfficialPluginIds } from "../src/bundled-plugins.js";
import { installControlCenterPluginIpcHandlers, type ControlCenterPluginIpcHandler } from "../src/control-center-plugin-ipc.js";
import type { PluginJsHost, PluginJsHostStartOptions } from "../src/plugin-js-host.js";
import { PluginService } from "../src/plugin-service.js";
import { createDefaultPluginHostCapabilities, type PluginCommand, type PluginSdkApi } from "../src/plugin-sdk-bridge.js";
import { isPluginSdkRoute } from "../src/plugin-sdk-routes.js";

// Execute both shipped preloads and the actual SDK dispatch table. Only the
// Electron transport and final host effects are replaced; validation, plugin
// code, command forms, storage, lifecycle and bundled-marketplace policy run.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "electron" && context.parentURL?.endsWith("/plugin-js-host.js")) {
      return { url: "data:text/javascript,export const app={},BrowserWindow={},ipcMain={},session={};", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { sdkCallHandlers, serializePluginSdkError } = await import("../src/plugin-js-host.js");
const desktopRoot = process.env.OPENPETS_DESKTOP_ROOT ?? fileURLToPath(new URL("../..", import.meta.url));
const pluginPreload = await readFile(join(desktopRoot, "plugin-sdk-preload.cjs"), "utf8");
const controlCenterPreload = await readFile(join(desktopRoot, "control-center-preload.cjs"), "utf8");
const root = await mkdtemp(join(tmpdir(), "openpets-bundled-interactions-"));
const stops: Promise<unknown>[] = [];
const warnings: unknown[] = [];
let generation = 0;
let commandsExecuted = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Bundled plugin controls must not fetch external data."); };

function createPluginContext(hostSdk: PluginSdkApi): OpenPetsContext {
  const exposed: Record<string, unknown> = {};
  const context = createContext({});
  const contents = {
    executeJavaScript(code: string) { return Promise.resolve(new Script(code).runInContext(context)); },
  } as unknown as WebContents;
  const dispatch = (path: string, args: unknown[]) => {
    assert.ok(isPluginSdkRoute(path), `Unexpected SDK route ${path}`);
    const callback = (id: unknown) => typeof id === "string"
      ? (...values: unknown[]) => (exposed.__openPetsRunCallback as (id: string, values: unknown[]) => Promise<unknown>)(id, structuredClone(values))
      : undefined;
    return sdkCallHandlers[path](hostSdk, structuredClone(args), callback, contents);
  };
  context.require = (id: string) => {
    assert.equal(id, "electron");
    return {
      contextBridge: { exposeInMainWorld(name: string, value: unknown) { exposed[name] = value; } },
      ipcRenderer: {
        async invoke(_channel: string, path: string, args: unknown[]) {
          try { return structuredClone(await dispatch(path, args)); }
          catch (error) { return serializePluginSdkError(error); }
        },
        sendSync(_channel: string, path: string, args: unknown[]) {
          try { return structuredClone(dispatch(path, args)); }
          catch (error) { return serializePluginSdkError(error); }
        },
      },
    };
  };
  context.process = { argv: ["node", "plugin-sdk-preload.cjs", "--openpets-plugin-token=isolated-bundled-test"] };
  new Script(pluginPreload, { filename: "plugin-sdk-preload.cjs" }).runInContext(context);
  context.__openPetsRunCallback = exposed.__openPetsRunCallback;
  return exposed.__openPetsSdk as OpenPetsContext;
}

const jsHost: PluginJsHost = {
  async startPlugin(options: PluginJsHostStartOptions) {
    assert.ok(options.sdk);
    let definition: OpenPetsPluginDefinition | undefined;
    const entry = await import(`${pathToFileURL(options.entryPath).href}?isolated-generation=${++generation}`) as {
      register(api: { register(value: OpenPetsPluginDefinition): void }): void;
    };
    entry.register({ register(value) { definition = value; } });
    assert.ok(definition);
    await definition.start(createPluginContext(options.sdk));
    const registered = definition;
    return { stop() { stops.push(Promise.resolve(registered.stop?.())); } };
  },
};
const petApi = { speak() {}, react() {}, moveBy() {}, wander() {}, moveToHome() {} };
const capabilities = createDefaultPluginHostCapabilities(petApi);
capabilities.system.metrics = async () => ({ cpuPercent: 22, memUsedPercent: 44, gpuPercent: 12, diskUsedPercent: 33 });
const service = new PluginService({
  userDataPath: root,
  bundledPluginSourceDirs: [resolve(desktopRoot, "../../plugins/official")],
  petApi,
  capabilities,
  jsHost,
  scheduler: { setTimeout: () => ({ cancel() {} }) },
  runtimeLogger(level, message, fields) { if (level === "warn" || level === "error") warnings.push({ message, fields }); },
  showSoundOpenDialog: async () => ({ canceled: true, filePaths: [] }),
});
type ControlCenterApi = {
  getPluginsSnapshot: PluginService["getSnapshot"];
  getMarketplacePlugins: PluginService["getMarketplacePlugins"];
  getMarketplacePlugin: PluginService["getMarketplacePlugin"];
  setPluginEnabled: PluginService["setEnabled"];
  savePluginConfig: PluginService["saveConfig"];
  pickPluginConfigSound: PluginService["pickConfigSound"];
  executePluginCommand: PluginService["executeCommand"];
};
const handlers = new Map<string, ControlCenterPluginIpcHandler>();
installControlCenterPluginIpcHandlers({
  registerHandle: (channel, handler) => handlers.set(channel, handler),
  authorizeSender: (event) => assert.equal(event.sender.id, 123),
  getPluginService: () => service,
  logger: { debug() {}, warn() {}, error() {} },
});
let api: ControlCenterApi | undefined;
const context = createContext({
  require(id: string) {
    assert.equal(id, "electron");
    return {
      contextBridge: { exposeInMainWorld(name: string, value: ControlCenterApi) { if (name === "openPetsControlCenter") api = value; } },
      ipcRenderer: {
        async invoke(channel: string, ...args: unknown[]) {
          const handler = handlers.get(channel);
          assert.ok(handler, `Unexpected Control Center channel ${channel}`);
          return structuredClone(await handler({ sender: { id: 123 } }, ...structuredClone(args)));
        },
      },
    };
  },
});
new Script(controlCenterPreload, { filename: "control-center-preload.cjs" }).runInContext(context);
assert.ok(api);
const controls = api;

function commandValues(command: PluginCommand): Record<string, unknown> {
  return Object.fromEntries((command.form?.fields ?? []).map((field) => {
    let value = field.default;
    if (value === undefined) {
      if (field.type === "number") value = Math.max(1, field.min ?? 0);
      else if (field.type === "boolean") value = false;
      else if (field.type === "select") value = field.options?.[0]?.value ?? "";
      else if (field.type === "time") value = "23:59";
      else if (field.type === "date") value = "2026-12-01";
      else if (field.type === "list" || field.type === "multiSelect") value = [];
      else value = field.required ? "Isolated reminder" : "";
    }
    return [field.id, value];
  }));
}

try {
  await service.start();
  const page = await controls.getMarketplacePlugins({ limit: 24, sort: "name" });
  assert.deepEqual(page.plugins.map((plugin) => plugin.id).sort(), [...bundledOfficialPluginIds].sort());
  for (const id of bundledOfficialPluginIds) {
    const detail = await controls.getMarketplacePlugin(id);
    assert.equal(detail.source, "bundled");
    assert.equal((await controls.setPluginEnabled(id, false)).ok, true);
    assert.equal(service.runtime.isPluginActive(id, detail.version), false);
    assert.equal((await controls.setPluginEnabled(id, true)).ok, true);
    assert.equal(service.runtime.isPluginActive(id, detail.version), true);
    let record = (await controls.getPluginsSnapshot()).plugins.find((plugin) => plugin.id === id)!;
    assert.equal(record.brokenReason, undefined, id);
    assert.equal((await controls.savePluginConfig(id, record.effectiveConfig ?? {})).ok, true);
    assert.equal(service.runtime.isPluginActive(id, detail.version), true);
    if (Object.values(record.configSchema ?? {}).some((field) => field.type === "sound")) {
      const picked = await controls.pickPluginConfigSound(id);
      assert.ok(picked.ok && "canceled" in picked && picked.canceled);
    }
    const exercised = new Set<string>();
    for (let step = 0; step < 32; step += 1) {
      record = (await controls.getPluginsSnapshot()).plugins.find((plugin) => plugin.id === id)!;
      const command = record.commands?.find((item) => !exercised.has(item.id));
      if (!command) break;
      const result = await controls.executePluginCommand(id, command.id, commandValues(command));
      assert.equal(result.ok, true, `${id}/${command.id}: ${!result.ok ? result.error : ""}`);
      exercised.add(command.id);
      commandsExecuted += 1;
    }
    assert.ok(exercised.size > 0, `${id} must expose working controls after activation`);
    assert.equal(record.commands?.some((command) => !exercised.has(command.id)), false, `${id} has an unexercised visible control`);
  }
  assert.deepEqual(warnings, [], "Bundled controls must not produce hidden runtime/permission errors");
  console.log(`Bundled controls passed through both shipped preloads: ${bundledOfficialPluginIds.length} plugins, ${commandsExecuted} visible/dynamic commands.`);
} finally {
  await service.stop();
  await Promise.allSettled(stops);
  await rm(root, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  hooks.deregister();
}

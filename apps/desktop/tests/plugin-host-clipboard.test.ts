import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "openpets-host-clipboard-"));
const electronMock = `data:text/javascript,${encodeURIComponent(`
  export const state = { text: "x".repeat(70 * 1024), writes: [], finishWrite: undefined, failWrite: undefined, readError: undefined };
  export const clipboard = {
    async readText() { if (state.readError) throw state.readError; return state.text; },
    async writeText(value) { state.writes.push(value); await new Promise((resolve, reject) => { state.finishWrite = resolve; state.failWrite = reject; }); }
  };
  export class BrowserWindow { webContents = { on() {}, off() {}, send() {} }; isDestroyed() { return false; } once() {} }
  export const app = { on() {}, once() {}, off() {}, getVersion: () => "test", getPath: () => ${JSON.stringify(root)}, getAppPath: () => ${JSON.stringify(root)} };
  export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
  export const globalShortcut = { register: () => true, unregister() {}, unregisterAll() {} };
  export const ipcMain = { on() {}, off() {}, removeListener() {}, handle() {} };
  export const Menu = { buildFromTemplate: (template) => ({ popup() {} }) };
  export const nativeImage = { createEmpty: () => ({ isEmpty: () => true }) };
  export const nativeTheme = { themeSource: "system" };
  export const net = {};
  export const Notification = class { show() {} };
  export const powerMonitor = { on() {}, getSystemIdleTime: () => 0 };
  export const protocol = { registerSchemesAsPrivileged() {}, handle() {} };
  export const safeStorage = { isEncryptionAvailable: () => false };
  export const screen = { on() {}, getAllDisplays: () => [], getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }), getDisplayMatching: () => ({ scaleFactor: 1 }) };
  export const session = { defaultSession: { webRequest: { onHeadersReceived() {} } } };
  export const shell = { openPath: async () => "" };
  export const systemPreferences = { isTrustedAccessibilityClient: () => false };
  export const Tray = class { setToolTip() {} setContextMenu() {} };
  export default { BrowserWindow, app, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, net, Notification, powerMonitor, protocol, safeStorage, screen, session, shell, systemPreferences, Tray };
`)}`;
const sourcesUrl = new URL("../src/plugin-events-source.js", import.meta.url).href;
const mocks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "electron" ? { url: electronMock, shortCircuit: true } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url !== sourcesUrl) return nextLoad(url, context);
    return { format: "module", shortCircuit: true, source: "export function startPluginEventSources() {} export function stopPluginEventSources() {} export function subscribePluginEvent() {} export function emitPluginEvent() {} export function publishPluginPetEvent() {} export function publishPluginAgentActivity() {} export function readDroppedFileText() {}" };
  },
});

try {
  const { createElectronPluginHostCapabilities } = await import("../src/plugin-host-capabilities.js");
  const { state } = await import(electronMock);
  const capabilities = createElectronPluginHostCapabilities(root);
  try {
    assert.equal((await capabilities.system.readClipboardText()).length, 64 * 1024, "async clipboard reads are awaited before applying the existing size limit");
    state.readError = new Error("mock read denied");
    await assert.rejects(() => capabilities.system.readClipboardText(), /mock read denied/);
    let settled = false;
    const write = capabilities.system.writeClipboardText("isolated fake clipboard text").then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, "the SDK must not report a pending native write as completed");
    assert.deepEqual(state.writes, ["isolated fake clipboard text"]);
    state.finishWrite();
    await write;
    assert.equal(settled, true);
    const rejectedWrite = assert.rejects(capabilities.system.writeClipboardText("isolated denied write"), /mock write denied/);
    state.failWrite(new Error("mock write denied"));
    await rejectedWrite;
  } finally {
    capabilities.shutdown();
  }
  console.log("Async clipboard completion, errors and read size limit verified without native clipboard access.");
} finally {
  mocks.deregister();
  rmSync(root, { recursive: true, force: true });
}

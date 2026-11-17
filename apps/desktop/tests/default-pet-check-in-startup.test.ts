import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BrowserWindow } from "electron";

import { getManagerCheckInPetSnapshot, getManagerCheckInService, initializeManagerCheckInService } from "../src/manager-check-in-service.js";
import { ManagerCheckInStateStore } from "../src/manager-check-in-state.js";
import type { ManagerCheckInPetSnapshot } from "../src/manager-check-in-service.js";

type Handler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
Object.assign(globalThis, { __checkInStartupHandlers: handlers });
const moduleUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const mocks = new Map([
  ["electron", moduleUrl(`
    export class BrowserWindow {}
    export const screen = {};
    export const ipcMain = { on() {}, handle(channel, handler) { globalThis.__checkInStartupHandlers.set(channel, handler); } };
  `)],
  ["./logger.js", moduleUrl("export function debug() {} export function warn() {} export function error() {}")],
  ["./pet-assistant-host.js", moduleUrl("export function getPetAssistantConversationController(){return null} export function onPetAssistantConversationControllerReady(){return ()=>{}}")],
  ["./pet-assistant-conversation.js", moduleUrl("export function createEmptyPetAssistantConversationSnapshot(){return {}} export function validateConversationMessageInput(){return ''}")],
  ["./voice-assistant-host.js", moduleUrl(`
    export function endVoiceAssistant() {} export function getVoiceAssistantSnapshot() { return {}; }
    export function interruptVoiceAssistant() {} export function muteVoiceAssistant() {}
    export function onVoiceAssistantEvent() { return () => {}; } export function retryVoiceAssistant() {}
    export function startVoiceAssistant() {} export function toggleVoiceAssistant() {} export function unmuteVoiceAssistant() {}
  `)],
  ["./app-state.js", moduleUrl("export function getAppStateSnapshot(){return {preferences:{petScale:1}}}")],
  ["./pet-activities.js", moduleUrl("export function interruptPetActivity() {}")],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const replacement = context.parentURL?.endsWith("/default-pet-chat.js") ? mocks.get(specifier) : undefined;
    return replacement ? { url: replacement, shortCircuit: true } : nextResolve(specifier, context);
  },
});
const chat = await import("../src/default-pet-chat.js");

test("the first pet reads an empty check-in until the existing service publishes its ready snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openpets-check-in-startup-"));
  const sent: Array<{ channel: string; payload: unknown }> = [];
  class Window extends EventEmitter {
    readonly webContents = {
      id: 1,
      isDestroyed: () => false,
      send(channel: string, payload: unknown) { sent.push({ channel, payload }); },
    };
    isDestroyed() { return false; }
  }
  const window = new Window();
  let service: ReturnType<typeof initializeManagerCheckInService> | undefined;
  let unsubscribe: (() => void) | undefined;
  const invoke = (channel: string, senderId = 1, input?: unknown) => {
    const handler = handlers.get(channel);
    assert.ok(handler, `Missing ${channel} handler`);
    return handler({ sender: { id: senderId } }, input);
  };
  try {
    const empty = { pendingCount: 0, activeItem: null };
    assert.deepEqual(getManagerCheckInPetSnapshot(), empty);
    assert.throws(() => getManagerCheckInService(), /not been initialized/);
    chat.installDefaultPetChatIpcHandlers();
    chat.bindDefaultPetChatWindow(window as unknown as BrowserWindow);
    assert.deepEqual(invoke("openpets:default-pet-check-in-get-snapshot"), empty);
    const initial = sent.find(message => message.channel === "openpets:default-pet-check-in-event");
    assert.deepEqual((initial?.payload as { snapshot: ManagerCheckInPetSnapshot }).snapshot, empty);
    assert.throws(() => invoke("openpets:default-pet-check-in-get-snapshot", 2), /unexpected window/);
    await assert.rejects(async () => invoke("openpets:default-pet-check-in-submit", 1, {}), /not been initialized/);

    service = initializeManagerCheckInService({
      teamStateStore: { snapshot: () => ({ version: 1, installationId: "installation", organizationId: "organization", deviceId: "device", pendingRevision: 0, appliedRevision: 0 }) },
      credentialStore: { load: () => "credential", save() {}, clear() {} },
      stateStore: new ManagerCheckInStateStore({ statePath: join(directory, "state.json") }),
      now: () => new Date("2026-09-14T12:00:00"),
      apiClient: {
        getManagerCheckInSync: async () => ({
          employee: { id: "employee", displayName: "Employee" },
          visibilityNotice: { version: 1, text: "Shared check-ins are visible to the organization." },
          history: [], nextCursor: null,
          schedules: [{ id: "due", revision: 1, name: "Due", enabled: true,
            recurrence: { kind: "daily", intervalDays: 1, startsOn: "2026-09-14" },
            title: "Check in", introduction: "Optional", acknowledgement: "Thanks", notePlaceholder: "Note",
            labels: { good: "Good", steady: "Steady", stretched: "Stretched", struggling: "Struggling", need_support: "Need support" } }],
        }),
        createManagerCheckInSubmissionReceipt: async () => { throw new Error("Read-only test must not submit"); },
        submitManagerCheckIn: async () => { throw new Error("Read-only test must not submit"); },
      },
    });
    unsubscribe = service.subscribe(chat.broadcastDefaultPetManagerCheckInSnapshot);
    await service.start();
    const ready = invoke("openpets:default-pet-check-in-get-snapshot") as ManagerCheckInPetSnapshot;
    assert.equal(ready.pendingCount, 1);
    assert.equal(ready.activeItem?.scheduleId, "due");
    const latest = sent.filter(message => message.channel === "openpets:default-pet-check-in-event").at(-1);
    assert.deepEqual((latest?.payload as { snapshot: ManagerCheckInPetSnapshot }).snapshot, ready);
  } finally {
    unsubscribe?.();
    await service?.stop();
    chat.unbindDefaultPetChatWindow();
    hooks.deregister();
    Reflect.deleteProperty(globalThis, "__checkInStartupHandlers");
    await rm(directory, { recursive: true, force: true });
  }
});

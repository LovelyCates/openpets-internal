import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpenPetsClient, OpenPetsReaction } from "@open-pets/client";

import { createOpenPetsOpenCodeV1Hooks } from "./opencode-plugin-v1-runtime.js";
import { createOpenPetsOpenCodeRuntime, type OpenCodePluginRuntime } from "./opencode-plugin-runtime.js";

const calls: Array<readonly unknown[]> = [];
const runtime: OpenCodePluginRuntime = {
  event: (event) => { calls.push(["event", event]); },
  prompt: () => { calls.push(["prompt"]); },
  toolBefore: (tool, input) => { calls.push(["toolBefore", tool, input]); },
  toolAfter: (event) => { calls.push(["toolAfter", event]); },
  reportError: (scope) => { calls.push(["reportError", scope]); },
  cleanup: async () => { calls.push(["cleanup"]); },
};

const hooks = createOpenPetsOpenCodeV1Hooks(runtime);
await hooks["chat.message"]();
await hooks["tool.execute.before"]({ tool: "edit" }, { args: { filePath: "private.ts" } });
await hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "pnpm test" } });
await hooks["permission.ask"]({}, { status: "ask" });
await hooks["permission.ask"]({}, { status: "allow" });
await hooks.event({ event: { type: "session.status", properties: { status: { type: "busy" } } } });
await hooks.event({ event: { type: "session.status", properties: { status: { type: "idle" } } } });
await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s" } } });
await hooks.event({ event: { type: "session.error", properties: { error: { message: "private error" } } } });
const usageEvent = { type: "message.updated", properties: { info: { role: "assistant", sessionID: "s", tokens: { output: 7 }, time: { completed: 123 } } } };
await hooks.event({ event: usageEvent });
await hooks.event({ event: { type: "file.edited", properties: { file: "private.ts" } } });
await hooks.event({ event: null });

assert.deepEqual(calls, [
  ["prompt"],
  ["toolBefore", "edit", { filePath: "private.ts" }],
  ["toolBefore", "bash", { command: "pnpm test" }],
  ["event", { type: "permission.asked", data: { resources: [] } }],
  ["prompt"],
  ["event", { type: "session.idle" }],
  ["event", { type: "session.idle", data: { sessionID: "s" } }],
  ["event", { type: "session.execution.failed" }],
  ["event", usageEvent],
]);

// OpenCode v1.2.27 PermissionService.ask publishes this bus event without
// calling the legacy permission.ask hook. Only identity/action may leave it.
calls.length = 0;
const permissionRequest = {
  type: "permission.asked",
  properties: {
    id: "per_request",
    sessionID: "ses_permission",
    permission: "edit",
    patterns: ["/private/project/file.ts"],
    metadata: { diff: "private code and arguments" },
    always: ["/private/project/*"],
    tool: { messageID: "msg_private", callID: "call_private" },
  },
};
await hooks.event({ event: permissionRequest });
await hooks["permission.ask"]({ type: "bash", sessionID: "ses_legacy", metadata: { command: "private args" } }, { status: "ask" });
assert.deepEqual(calls, [
  ["event", { type: "permission.asked", data: { sessionID: "ses_permission", action: "edit", resources: [] } }],
  ["event", { type: "permission.asked", data: { sessionID: "ses_legacy", action: "bash", resources: [] } }],
]);
calls.length = 0;
for (const tool of ["openpets_status", "openpets_openpets_say", "mcp_openpets_react"]) {
  await hooks.event({ event: { ...permissionRequest, properties: { ...permissionRequest.properties, permission: tool } } });
  await hooks["permission.ask"]({ type: tool, sessionID: "ses_permission" }, { status: "ask" });
}
await hooks["permission.ask"]({ type: "edit", sessionID: "ses_permission" }, { status: "allow" });
await hooks["permission.ask"]({ type: "edit", sessionID: "ses_permission" }, { status: "deny" });
await hooks.event({ event: { type: "permission.updated", properties: { sessionID: "ses_permission", type: "edit" } } });
await hooks.event({ event: { type: "permission.asked", properties: { sessionID: "ses_permission" } } });
await hooks.event({ event: { type: "permission.replied", properties: { requestID: "per_request", reply: "once" } } });
await hooks.event({ event: { type: "permission.replied", properties: { sessionID: "", reply: "once" } } });
await hooks.event({ event: { type: "permission.replied", properties: { sessionID: "s".repeat(257), reply: "once" } } });
assert.deepEqual(calls, [], "pet MCP feedback, unscoped replies and unsupported old update events must not fabricate activity");
await hooks.event({ event: { type: "permission.replied", properties: {
  sessionID: "ses_permission", requestID: "per_request", reply: "once", metadata: { command: "private args" },
} } });
await hooks.event({ event: { type: "permission.replied", properties: { sessionID: "ses_foreign", requestID: "per_other", reply: "reject" } } });
assert.deepEqual(calls, [
  ["event", { type: "permission.replied", data: { sessionID: "ses_permission" } }],
  ["event", { type: "permission.replied", data: { sessionID: "ses_foreign" } }],
], "permission replies carry only their bounded session identity, never a waiting request or private fields");

const tempRoot = mkdtempSync(join(tmpdir(), "openpets-v1-permission-"));
const scheduled: Array<() => Promise<void>> = [];
const reactions: OpenPetsReaction[] = [];
const telemetry: unknown[] = [];
const behavior = createOpenPetsOpenCodeRuntime({
  clientFactory: () => ({
    react: async (reaction: OpenPetsReaction) => { reactions.push(reaction); },
    say: async (_message: string, options?: { readonly reaction?: OpenPetsReaction }) => {
      if (options?.reaction) reactions.push(options.reaction);
    },
    tokenRate: async (update: unknown) => { telemetry.push(update); },
  }) as OpenPetsClient,
  schedule: (work) => { scheduled.push(work); },
  throttlePath: join(tempRoot, "speech.json"),
  now: () => 100_000,
  timers: { setInterval: () => 1, clearInterval: () => {} },
});
const behaviorHooks = createOpenPetsOpenCodeV1Hooks(behavior);
const flush = async (): Promise<void> => {
  while (scheduled.length > 0) await scheduled.shift()?.();
};
try {
  await behaviorHooks["chat.message"]({ sessionID: "ses_permission" });
  await flush();
  await behaviorHooks["tool.execute.before"]({ tool: "edit", sessionID: "ses_permission", callID: "call_edit" }, { args: {} });
  await flush();
  await behaviorHooks.event({ event: permissionRequest });
  await flush();
  assert.deepEqual(reactions, ["thinking", "editing", "waiting"], "the real 1.2.27 bus payload must put the pet into waiting without the legacy hook");
  await behaviorHooks.event({ event: { type: "message.updated", properties: { info: { role: "assistant", sessionID: "ses_foreign", tokens: { output: 999 }, time: { completed: 123 } } } } });
  await behaviorHooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_foreign" } } });
  await flush();
  assert.deepEqual(telemetry, [], "permission identity keeps another session's reported usage isolated");
  await behaviorHooks.event({ event: { type: "permission.replied", properties: { sessionID: "ses_foreign", requestID: "per_other", reply: "once" } } });
  await flush();
  assert.deepEqual(reactions, ["thinking", "editing", "waiting"], "another session's terminal event or reply cannot dismiss the wait");
  await behaviorHooks.event({ event: { type: "permission.replied", properties: { sessionID: "ses_permission", requestID: "per_request", reply: "once" } } });
  await flush();
  await behaviorHooks.event({ event: { type: "permission.replied", properties: { sessionID: "ses_permission", requestID: "per_request", reply: "once" } } });
  await flush();
  assert.deepEqual(reactions, ["thinking", "editing", "waiting", "editing"], "a matching reply resumes the tracked tool once instead of staying in waiting");
  await behaviorHooks["tool.execute.after"]({ tool: "edit", sessionID: "ses_permission", callID: "call_edit" }, { output: "done" });
  await flush();
  await behaviorHooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_permission" } } });
  await flush();
  assert.deepEqual(reactions, ["thinking", "editing", "waiting", "editing", "thinking", "success"]);
} finally {
  await behavior.cleanup();
  rmSync(tempRoot, { recursive: true, force: true });
}

const entry = await import("./plugin-v1.js");
assert.deepEqual(Object.keys(entry), ["default"]);
assert.equal(typeof entry.default, "function");
const created = await entry.default();
assert.deepEqual(Object.keys(created).sort(), ["chat.message", "event", "permission.ask", "tool.execute.after", "tool.execute.before"]);

console.log("OpenCode V1 adapter checks passed.");

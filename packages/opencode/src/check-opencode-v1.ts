import assert from "node:assert/strict";

import { createOpenPetsOpenCodeV1Hooks } from "./opencode-plugin-v1-runtime.js";
import type { OpenCodePluginRuntime } from "./opencode-plugin-runtime.js";

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
  ["event", { type: "permission.asked" }],
  ["prompt"],
  ["event", { type: "session.idle" }],
  ["event", { type: "session.idle", data: { sessionID: "s" } }],
  ["event", { type: "session.execution.failed" }],
  ["event", usageEvent],
]);

const entry = await import("./plugin-v1.js");
assert.deepEqual(Object.keys(entry), ["default"]);
assert.equal(typeof entry.default, "function");
const created = await entry.default();
assert.deepEqual(Object.keys(created).sort(), ["chat.message", "event", "permission.ask", "tool.execute.before"]);

console.log("OpenCode V1 adapter checks passed.");

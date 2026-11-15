import assert from "node:assert/strict";

import type { OpenPetsClient, OpenPetsTokenRateUpdate } from "@open-pets/client";

import { createOpenPetsOpenCodeRuntime } from "./opencode-plugin-runtime.js";
import { createOpenCodeTokenRateTracker } from "./opencode-token-rate.js";

{
  let now = 1_000;
  const tracker = createOpenCodeTokenRateTracker(() => now);
  const delta = (text: string) => ({ type: "session.text.delta", data: { sessionID: "ses_v2", delta: text } });

  assert.equal(tracker.ingest(delta("abcd")), undefined);
  now = 1_500;
  assert.equal(tracker.ingest(delta("abcd")), undefined);
  now = 2_000;
  assert.deepEqual(tracker.ingest(delta("abcd")), {
    sessionId: "ses_v2", tokensPerSecond: 3, source: "estimated",
  });
  now = 2_500;
  assert.equal(tracker.ingest(delta("abcd")), undefined, "live updates are limited to once per second");
  assert.equal(tracker.ingest({ type: "session.usage.updated", data: { sessionID: "ses_v2", tokens: { output: 12 } } }), undefined, "usage refreshes during streaming do not hide the live rate");
  now = 4_100;
  assert.deepEqual(tracker.ingest({ type: "session.usage.updated", data: { sessionID: "ses_v2", tokens: { output: 12 } } }), {
    sessionId: "ses_v2", tokensPerSecond: null, outputTokens: 12, source: "reported",
  });
  assert.equal(tracker.ingest({ type: "session.idle", data: { sessionID: "ses_v2" } }), undefined, "successful idle leaves the final count visible for the host TTL");
  assert.equal(tracker.ingest({ type: "session.idle", data: { sessionID: "ses_v2" } }), undefined);
  assert.deepEqual(tracker.ingest({ type: "session.step.ended", data: { sessionID: "ses_v2", tokens: { output: 14 } } }), {
    sessionId: "ses_v2", tokensPerSecond: null, outputTokens: 14, source: "reported",
  });
  assert.deepEqual(tracker.ingest({ type: "session.execution.failed", data: { sessionID: "ses_v2" } }), {
    sessionId: "ses_v2", tokensPerSecond: null, source: "estimated",
  }, "failures clear even a recent reported count");
}

{
  let now = 5_000;
  const tracker = createOpenCodeTokenRateTracker(() => now);
  const updated = (delta: string) => ({
    type: "message.part.updated",
    properties: { part: { id: "prt_v1", sessionID: "ses_v1", type: "text" }, delta },
  });
  assert.equal(tracker.ingest(updated("abcd")), undefined);
  now = 6_000;
  assert.deepEqual(tracker.ingest(updated("abcd")), {
    sessionId: "ses_v1", tokensPerSecond: 2, source: "estimated",
  });
  assert.deepEqual(tracker.ingest({
    type: "message.updated",
    properties: { info: { role: "assistant", sessionID: "ses_v1", time: { completed: now }, tokens: { output: 8 } } },
  }), { sessionId: "ses_v1", tokensPerSecond: null, outputTokens: 8, source: "reported" });
  assert.equal(tracker.ingest({ type: "message.updated", properties: { info: { role: "user", sessionID: "ses_v1", tokens: { output: 99 } } } }), undefined);
  assert.equal(tracker.ingest({ type: "message.part.delta", properties: { sessionID: "../../bad", field: "text", delta: "private prompt" } }), undefined);
  now = 7_000;
  const fallback = tracker.ingest({ type: "message.part.delta", properties: { sessionID: "../../bad", field: "text", delta: "private prompt" } });
  assert.match(fallback?.sessionId ?? "", /^oc-[a-z0-9]+-\d+$/);
  assert.equal(JSON.stringify(fallback).includes("private prompt"), false, "stream content never leaves the tracker");
  assert.equal(tracker.ingest({ type: "message.part.delta", properties: { sessionID: "ses_v1", field: "tool", delta: "private tool output" } }), undefined);
  assert.equal(tracker.ingest({ type: "message.updated", properties: { info: { role: "assistant", sessionID: "ses_v1", finish: "stop", tokens: { output: -1 } } } }), undefined);
}

{
  let now = 8_000;
  const tracker = createOpenCodeTokenRateTracker(() => now);
  const delta = { type: "message.part.delta", properties: { sessionID: "ses_new_v1", partID: "prt_new_v1", field: "text", delta: "abcd" } };
  assert.equal(tracker.ingest(delta), undefined);
  now += 1_000;
  assert.deepEqual(tracker.ingest(delta), {
    sessionId: "ses_new_v1", tokensPerSecond: 2, source: "estimated",
  });
  assert.deepEqual(tracker.ingest({
    type: "message.updated",
    properties: { info: { role: "assistant", sessionID: "ses_new_v1", metadata: { time: { completed: now }, assistant: { tokens: { output: 9 } } } } },
  }), { sessionId: "ses_new_v1", tokensPerSecond: null, outputTokens: 9, source: "reported" });
}

{
  let now = 10_000;
  const calls: OpenPetsTokenRateUpdate[] = [];
  const scheduled: Array<() => Promise<void>> = [];
  const client = {
    tokenRate: async (update: OpenPetsTokenRateUpdate) => { calls.push(update); },
    react: async () => {},
  } as unknown as OpenPetsClient;
  const runtime = createOpenPetsOpenCodeRuntime({
    clientFactory: () => client,
    now: () => now,
    schedule: (work) => { scheduled.push(work); },
  });

  runtime.event({ type: "session.text.delta", data: { sessionID: "ses_runtime", delta: "abcd" } });
  now += 1_000;
  runtime.event({ type: "session.text.delta", data: { sessionID: "ses_runtime", delta: "abcd" } });
  while (scheduled.length) await scheduled.shift()?.();
  assert.deepEqual(calls, [{ sessionId: "ses_runtime", tokensPerSecond: 2, source: "estimated", leaseId: undefined }]);

  runtime.event({ type: "session.idle", data: { sessionID: "ses_runtime" } });
  while (scheduled.length) await scheduled.shift()?.();
  assert.deepEqual(calls.at(-1), { sessionId: "ses_runtime", tokensPerSecond: null, source: "estimated", leaseId: undefined });

  runtime.event({ type: "session.text.delta", data: { sessionID: "ses_cleanup", delta: "abcd" } });
  now += 1_000;
  runtime.event({ type: "session.text.delta", data: { sessionID: "ses_cleanup", delta: "abcd" } });
  while (scheduled.length) await scheduled.shift()?.();
  runtime.event({ type: "session.step.ended", data: { sessionID: "ses_cleanup", tokens: { output: 22 } } });
  runtime.event({ type: "session.idle", data: { sessionID: "ses_cleanup" } });
  while (scheduled.length) await scheduled.shift()?.();
  assert.deepEqual(calls.at(-1), { sessionId: "ses_cleanup", tokensPerSecond: null, outputTokens: 22, source: "reported", leaseId: undefined });
  await runtime.cleanup();
  assert.deepEqual(calls.at(-1), { sessionId: "ses_cleanup", tokensPerSecond: null, outputTokens: 22, source: "reported", leaseId: undefined });
  assert.equal(calls.length, 4, "cleanup leaves a reported count for the desktop expiry");
}

{
  const calls: OpenPetsTokenRateUpdate[] = [];
  const runtime = createOpenPetsOpenCodeRuntime({
    clientFactory: () => ({ tokenRate: async (update: OpenPetsTokenRateUpdate) => { calls.push(update); } }) as OpenPetsClient,
    schedule: () => { throw new Error("terminal reports must not depend on deferred scheduling"); },
  });
  runtime.event({ type: "session.step.ended", data: { sessionID: "ses_one_shot", tokens: { output: 41 } } });
  await runtime.cleanup();
  assert.deepEqual(calls, [{ sessionId: "ses_one_shot", tokensPerSecond: null, outputTokens: 41, source: "reported", leaseId: undefined }],
    "one-shot plugin teardown must deliver and preserve the final count");
}

{
  let now = 20_000;
  const calls: OpenPetsTokenRateUpdate[] = [];
  const scheduled: Array<() => Promise<void>> = [];
  const runtime = createOpenPetsOpenCodeRuntime({
    clientFactory: () => ({ tokenRate: async (update: OpenPetsTokenRateUpdate) => { calls.push(update); } }) as OpenPetsClient,
    now: () => now,
    schedule: (work) => { scheduled.push(work); },
  });
  runtime.event({ type: "session.text.delta", data: { sessionID: "ses_estimate_only", delta: "abcd" } });
  now += 1_000;
  runtime.event({ type: "session.text.delta", data: { sessionID: "ses_estimate_only", delta: "abcd" } });
  while (scheduled.length) await scheduled.shift()?.();
  await runtime.cleanup();
  assert.deepEqual(calls.at(-1), { sessionId: "ses_estimate_only", tokensPerSecond: null, source: "estimated", leaseId: undefined },
    "cleanup clears a live estimate without a final report");
}

console.log("OpenCode token rate checks passed.");

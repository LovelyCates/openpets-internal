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
    sessionId: "ses_v2", tokensPerSecond: 3, averageTokensPerSecond: 3, source: "estimated",
  });
  now = 2_500;
  assert.equal(tracker.ingest(delta("abcd")), undefined, "live updates are limited to once per second");
  assert.equal(tracker.ingest({ type: "session.usage.updated", data: { sessionID: "ses_v2", tokens: { output: 12 } } }), undefined, "usage refreshes during streaming do not hide the live rate");
  now = 4_100;
  assert.deepEqual(tracker.ingest({ type: "session.usage.updated", data: { sessionID: "ses_v2", tokens: { output: 12 } } }), {
    sessionId: "ses_v2", tokensPerSecond: null, averageTokensPerSecond: 2.7, outputTokens: 12, source: "reported",
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
    sessionId: "ses_v1", tokensPerSecond: 2, averageTokensPerSecond: 2, source: "estimated",
  });
  assert.deepEqual(tracker.ingest({
    type: "message.updated",
    properties: { info: { role: "assistant", sessionID: "ses_v1", time: { completed: now }, tokens: { output: 8 } } },
  }), { sessionId: "ses_v1", tokensPerSecond: null, averageTokensPerSecond: 2, outputTokens: 8, source: "reported" });
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
    sessionId: "ses_new_v1", tokensPerSecond: 2, averageTokensPerSecond: 2, source: "estimated",
  });
  assert.deepEqual(tracker.ingest({
    type: "message.updated",
    properties: { info: { role: "assistant", sessionID: "ses_new_v1", metadata: { time: { completed: now }, assistant: { tokens: { output: 9 } } } } },
  }), { sessionId: "ses_new_v1", tokensPerSecond: null, averageTokensPerSecond: 2, outputTokens: 9, source: "reported" });
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
  assert.deepEqual(calls, [{ sessionId: "ses_runtime", tokensPerSecond: 2, averageTokensPerSecond: 2, source: "estimated", leaseId: undefined }]);

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
  assert.deepEqual(calls.at(-1), { sessionId: "ses_cleanup", tokensPerSecond: null, averageTokensPerSecond: 2, outputTokens: 22, source: "reported", leaseId: undefined });
  await runtime.cleanup();
  assert.deepEqual(calls.at(-1), { sessionId: "ses_cleanup", tokensPerSecond: null, averageTokensPerSecond: 2, outputTokens: 22, source: "reported", leaseId: undefined });
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

// A final report/clear can be enqueued before an earlier estimate's scheduled
// callback runs. That estimate must not revive or overwrite the final display.
for (const final of ["clear", "reported"] as const) {
  let now = 30_000;
  const calls: OpenPetsTokenRateUpdate[] = [];
  const scheduled: Array<() => Promise<void>> = [];
  const runtime = createOpenPetsOpenCodeRuntime({
    clientFactory: () => ({
      tokenRate: async (update: OpenPetsTokenRateUpdate) => { calls.push(update); },
      react: async () => {},
    }) as unknown as OpenPetsClient,
    now: () => now,
    schedule: (work) => { scheduled.push(work); },
  });
  const delta = { type: "session.text.delta", data: { sessionID: "pending-estimate", delta: "abcd" } };
  runtime.event(delta);
  now += 1_000;
  runtime.event(delta);
  runtime.event(final === "clear"
    ? { type: "session.idle", data: { sessionID: "pending-estimate" } }
    : { type: "session.step.ended", data: { sessionID: "pending-estimate", tokens: { output: 12 } } });
  while (scheduled.length) await scheduled.shift()?.();
  await runtime.cleanup();
  assert.deepEqual(calls, [{
    sessionId: "pending-estimate",
    tokensPerSecond: null,
    ...(final === "reported" ? { outputTokens: 12, averageTokensPerSecond: 2 } : {}),
    source: final === "reported" ? "reported" : "estimated",
    leaseId: undefined,
  }], "an unsent estimate cannot overtake the terminal token display");
}

{
  let now = 1_000;
  const tracker = createOpenCodeTokenRateTracker(() => now);
  const delta = (sessionID: string, length: number) => ({ type: "session.text.delta", data: { sessionID, delta: "x".repeat(length) } });
  assert.equal(tracker.ingest(delta("weighted", 100)), undefined);
  now = 2_000;
  assert.equal(tracker.ingest(delta("weighted", 100))?.averageTokensPerSecond, 50);
  now = 6_000;
  const later = tracker.ingest(delta("weighted", 400));
  assert.equal(later?.tokensPerSecond, 33.3, "the instantaneous estimate still uses its rolling window");
  assert.equal(later?.averageTokensPerSecond, 30, "AVG is all 150 observed tokens divided by the actual five-second span, not a mean of rate samples");
  now = 9_000;
  const final = tracker.ingest({ type: "session.step.ended", data: { sessionID: "weighted", tokens: { output: 500 } } });
  assert.equal(final?.averageTokensPerSecond, 30, "reporting delay after the last delta is excluded from the observed output span");
  assert.equal(final?.source, "reported", "provider count accuracy does not change the estimated meaning of AVG");
  now = 9_100;
  assert.equal(tracker.ingest({ type: "message.updated", properties: { info: { role: "assistant", sessionID: "weighted", finish: "stop", tokens: { output: 500 } } } })?.averageTokensPerSecond, 30,
    "a repeated final report preserves the completed segment's AVG");

  now = 10_000;
  assert.equal(tracker.ingest(delta("weighted", 4)), undefined, "output after a report starts a new segment");
  now = 11_000;
  assert.equal(tracker.ingest(delta("weighted", 4))?.averageTokensPerSecond, 2, "a new segment cannot inherit the prior count or elapsed time");
  now = 12_000;
  assert.equal(tracker.ingest(delta("other", 4)), undefined);
  now = 13_000;
  assert.equal(tracker.ingest(delta("other", 4))?.averageTokensPerSecond, 2, "switching sessions resets the cumulative mean");
  assert.equal(tracker.ingest({ type: "session.step.ended", data: { sessionID: "weighted", tokens: { output: 999 } } })?.averageTokensPerSecond, undefined,
    "a historical report without observed output for its current segment cannot borrow another session's AVG");
  assert.deepEqual(tracker.clear(), { sessionId: "weighted", tokensPerSecond: null, source: "estimated" }, "clears never carry a stale AVG");
  assert.equal(tracker.ingest({ type: "session.step.ended", data: { sessionID: "weighted", tokens: { output: 999 } } })?.averageTokensPerSecond, undefined);
}

{
  let now = 2_000;
  const tracker = createOpenCodeTokenRateTracker(() => now);
  const historical = "x".repeat(4_000);
  const snapshot = (text: string) => ({ type: "message.part.updated", properties: { part: {
    id: "average-part", sessionID: "v1-average", type: "text", text, time: { start: 1_000 },
  } } });
  assert.equal(tracker.ingest(snapshot(historical)), undefined);
  now = 3_000;
  assert.equal(tracker.ingest(snapshot(historical + "abcd")), undefined);
  now = 4_000;
  assert.equal(tracker.ingest(snapshot(historical + "abcdabcd"))?.averageTokensPerSecond, 2,
    "only observed V1 full-text growth contributes to AVG, never the historical first snapshot");
  const final = tracker.ingest({ type: "message.updated", properties: { info: {
    role: "assistant", sessionID: "v1-average", finish: "stop", tokens: { output: 1_002 },
  } } });
  assert.equal(final?.averageTokensPerSecond, 2);
  now += 8_001;
  assert.equal(tracker.ingest({ type: "session.step.ended", data: { sessionID: "v1-average", tokens: { output: 1_002 } } })?.averageTokensPerSecond, undefined,
    "an expired report cache cannot attach an old segment AVG to a later history refresh");
}

{
  let now = 1_000;
  const tracker = createOpenCodeTokenRateTracker(() => now);
  const delta = { type: "session.reasoning.delta", data: { sessionID: "short-segment", delta: "abcd" } };
  tracker.ingest(delta);
  now += 500;
  tracker.ingest(delta);
  assert.equal(tracker.ingest({ type: "session.step.ended", data: { sessionID: "short-segment", tokens: { output: 8 } } })?.averageTokensPerSecond, undefined,
    "less than one second of observations does not fabricate a reliable AVG");
  tracker.clear();
  now += 1_000;
  const large = { type: "session.text.delta", data: { sessionID: "large-segment", delta: "x".repeat(32_768) } };
  tracker.ingest(large);
  now += 1_000;
  assert.equal(tracker.ingest(large)?.averageTokensPerSecond, 10_000, "AVG respects the same finite telemetry ceiling as live speed");
  const final = tracker.ingest({ type: "session.step.ended", data: { sessionID: "large-segment", tokens: { output: 20_000 } } });
  assert.equal(final?.averageTokensPerSecond, 10_000);
}

console.log("OpenCode token rate checks passed.");

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpenPetsClient, OpenPetsReaction, OpenPetsTokenRateUpdate } from "@open-pets/client";
import { hookSpeechPools } from "@open-pets/agent-events";

import { createOpenPetsOpenCodeRuntime, type OpenCodePluginRuntimeOptions } from "./opencode-plugin-runtime.js";
import { createOpenPetsOpenCodeV1Hooks } from "./opencode-plugin-v1-runtime.js";

const root = mkdtempSync(join(tmpdir(), "openpets-opencode-realtime-"));
const throttlePath = join(root, "speech.json");
type Call = { readonly method: "react" | "say"; readonly reaction: OpenPetsReaction | undefined };

function fixture(clientOverrides: Partial<OpenPetsClient> = {}, runtimeOptions: Partial<OpenCodePluginRuntimeOptions> = {}) {
  const calls: Call[] = [];
  const speech: Array<{ readonly message: string; readonly reaction?: OpenPetsReaction }> = [];
  const scheduled: Array<() => Promise<void>> = [];
  const client = {
    react: async (reaction: OpenPetsReaction) => { calls.push({ method: "react", reaction }); },
    say: async (message: string, options?: { readonly reaction?: OpenPetsReaction }) => {
      calls.push({ method: "say", reaction: options?.reaction });
      speech.push({ message, reaction: options?.reaction });
    },
    ...clientOverrides,
  } as OpenPetsClient;
  const runtime = createOpenPetsOpenCodeRuntime({
    clientFactory: () => client,
    schedule: (work) => { scheduled.push(work); },
    throttlePath,
    now: () => 100_000,
    ...runtimeOptions,
  });
  return {
    runtime,
    calls,
    speech,
    scheduled,
    flush: async () => {
      while (scheduled.length) await scheduled.shift()?.();
    },
  };
}

try {
  // Returning to a prior state within ten seconds is a real transition.
  const rapid = fixture();
  rapid.runtime.prompt("rapid");
  await rapid.flush();
  rapid.runtime.toolBefore("edit", {}, "rapid");
  await rapid.flush();
  rapid.runtime.prompt("rapid");
  await rapid.flush();
  rapid.runtime.prompt("rapid");
  await rapid.flush();
  assert.deepEqual(rapid.calls.map((call) => call.reaction), ["thinking", "editing", "thinking"]);
  await rapid.runtime.cleanup();

  // Two integrations sharing speech persistence cannot suppress one another's
  // first state, and a failed IPC attempt must remain retryable.
  const independent = fixture();
  independent.runtime.prompt("independent");
  await independent.flush();
  assert.deepEqual(independent.calls.map((call) => call.reaction), ["thinking"]);
  await independent.runtime.cleanup();
  let attempts = 0;
  const retry = fixture({
    react: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("desktop unavailable");
    },
  });
  retry.runtime.prompt("retry");
  await retry.flush();
  retry.runtime.prompt("retry");
  await retry.flush();
  assert.equal(attempts, 2, "a failed state send must not suppress an immediate retry");
  await retry.runtime.cleanup();

  // Only the newest state that has not reached IPC should be presented.
  const burst = fixture();
  burst.runtime.prompt("burst");
  burst.runtime.toolBefore("edit", {}, "burst");
  burst.runtime.toolBefore("bash", { command: "pnpm test" }, "burst");
  burst.runtime.event({ type: "session.idle", data: { sessionID: "burst" } });
  await burst.flush();
  assert.deepEqual(burst.calls.map((call) => call.reaction), ["success"]);
  await burst.runtime.cleanup();

  // A slow in-flight request cannot make old pending tool states replay.
  let releaseRequest: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { releaseRequest = resolve; });
  const slowCalls: OpenPetsReaction[] = [];
  const slow = fixture({
    react: async (reaction) => {
      slowCalls.push(reaction);
      if (reaction === "thinking") await blocked;
    },
  });
  slow.runtime.prompt("slow");
  const inFlight = slow.scheduled.shift()?.();
  await Promise.resolve();
  slow.runtime.toolBefore("edit", {}, "slow");
  slow.runtime.toolBefore("bash", { command: "pnpm test" }, "slow");
  slow.runtime.event({ type: "session.idle", data: { sessionID: "slow" } });
  releaseRequest?.();
  await inFlight;
  await slow.flush();
  assert.deepEqual(slowCalls, ["thinking", "success"]);
  await slow.runtime.cleanup();

  // Stream activity resumes thinking after tools, but late/unscoped deltas
  // and another session's completion cannot replace the current state.
  const stream = fixture();
  stream.runtime.event({ type: "session.execution.started", data: { sessionID: "stream" } });
  await stream.flush();
  stream.runtime.toolBefore("edit", {}, "stream");
  await stream.flush();
  stream.runtime.event({ type: "session.text.delta", data: { sessionID: "stream", delta: "a" } });
  await stream.flush();
  stream.runtime.event({ type: "session.idle", data: { sessionID: "stream" } });
  await stream.flush();
  stream.runtime.event({ type: "session.text.delta", data: { sessionID: "stream", delta: "late" } });
  await stream.flush();
  assert.deepEqual(stream.calls.map((call) => call.reaction), ["thinking", "editing", "thinking", "success"]);
  stream.runtime.prompt("next");
  await stream.flush();
  stream.runtime.toolBefore("edit", {}, "next");
  await stream.flush();
  const beforeForeignEvents = stream.calls.length;
  stream.runtime.event({ type: "session.reasoning.delta", data: { sessionID: "stream", delta: "late" } });
  stream.runtime.event({ type: "session.text.delta", data: { delta: "unscoped" } });
  stream.runtime.event({ type: "session.idle", data: { sessionID: "stream" } });
  await stream.flush();
  assert.equal(stream.calls.length, beforeForeignEvents);
  stream.runtime.event({ type: "session.execution.started", data: { sessionID: "next" } });
  await stream.flush();
  assert.equal(stream.calls.at(-1)?.reaction, "thinking");
  await stream.runtime.cleanup();

  // Both public V1 stream forms carry the same immediate state semantics.
  const v1 = fixture();
  const hooks = createOpenPetsOpenCodeV1Hooks(v1.runtime);
  await hooks["chat.message"]({ sessionID: "v1" });
  await v1.flush();
  await hooks["tool.execute.before"]({ tool: "edit", sessionID: "v1" }, { args: {} });
  await v1.flush();
  await hooks.event({ event: {
    type: "message.part.updated",
    properties: { part: { sessionID: "v1", type: "text" }, delta: "a" },
  } });
  await v1.flush();
  await hooks["tool.execute.before"]({ tool: "edit", sessionID: "v1" }, { args: {} });
  await v1.flush();
  await hooks.event({ event: {
    type: "message.part.delta",
    properties: { sessionID: "v1", field: "reasoning", delta: "a" },
  } });
  await v1.flush();
  assert.deepEqual(v1.calls.map((call) => call.reaction), ["thinking", "editing", "thinking", "editing", "thinking"]);
  await v1.runtime.cleanup();

  // A matching successful after hook ends tool activity immediately. Parallel
  // tools keep their remaining state, and late/foreign completions do nothing.
  const tools = fixture();
  tools.runtime.prompt("tools");
  await tools.flush();
  tools.runtime.toolBefore("edit", {}, "tools", "edit-call");
  await tools.flush();
  tools.runtime.toolBefore("bash", { command: "pnpm test" }, "tools", "test-call");
  await tools.flush();
  tools.runtime.toolAfter({ tool: "edit", sessionID: "tools", id: "edit-call", status: "completed" });
  await tools.flush();
  assert.equal(tools.calls.at(-1)?.reaction, "testing");
  const parallelCount = tools.calls.length;
  tools.runtime.event({ type: "session.text.delta", data: { sessionID: "tools", delta: "parallel" } });
  tools.runtime.toolAfter({ tool: "bash", sessionID: "other", id: "test-call", status: "completed" });
  await tools.flush();
  assert.equal(tools.calls.length, parallelCount);
  tools.runtime.toolAfter({ tool: "bash", sessionID: "tools", id: "test-call", status: "completed" });
  await tools.flush();
  assert.equal(tools.calls.at(-1)?.reaction, "thinking", "the last tool completion does not wait for a model token");
  tools.runtime.toolBefore("edit", {}, "tools", "late-call");
  await tools.flush();
  tools.runtime.event({ type: "session.idle", data: { sessionID: "tools" } });
  await tools.flush();
  const terminalCount = tools.calls.length;
  tools.runtime.toolAfter({ tool: "edit", sessionID: "tools", id: "late-call", status: "completed" });
  tools.runtime.event({ type: "session.execution.failed", data: { sessionID: "another-session" } });
  await tools.flush();
  assert.equal(tools.calls.length, terminalCount);
  await tools.runtime.cleanup();

  const v1After = fixture();
  const afterHooks = createOpenPetsOpenCodeV1Hooks(v1After.runtime);
  await afterHooks["chat.message"]({ sessionID: "v1-after" });
  await v1After.flush();
  await afterHooks["tool.execute.before"]({ tool: "edit", sessionID: "v1-after", callID: "v1-call" }, { args: {} });
  await v1After.flush();
  await afterHooks["tool.execute.after"]({ tool: "edit", sessionID: "v1-after", callID: "v1-call" }, { title: "Done", output: "private output", metadata: {} });
  await v1After.flush();
  assert.deepEqual(v1After.calls.map((call) => call.reaction), ["thinking", "editing", "thinking"]);
  await v1After.runtime.cleanup();

  // Full historical V1 snapshots need observed unfinished-part growth. The
  // initial, unchanged, and completed snapshots never fabricate live activity.
  const snapshots = fixture();
  snapshots.runtime.prompt("snapshots");
  await snapshots.flush();
  snapshots.runtime.toolBefore("edit", {}, "snapshots");
  await snapshots.flush();
  const snapshot = (text: string, ended = false) => ({
    type: "message.part.updated",
    properties: { part: {
      id: "snapshot-part", sessionID: "snapshots", type: "text", text,
      time: { start: 100_000, ...(ended ? { end: 100_001 } : {}) },
    } },
  });
  snapshots.runtime.event(snapshot("history"));
  snapshots.runtime.event(snapshot("history"));
  const completedHistory = snapshot("completed history", true);
  completedHistory.properties.part.id = "completed-history-part";
  snapshots.runtime.event(completedHistory);
  await snapshots.flush();
  assert.equal(snapshots.calls.at(-1)?.reaction, "editing");
  snapshots.runtime.event(snapshot("history grows"));
  await snapshots.flush();
  assert.equal(snapshots.calls.at(-1)?.reaction, "thinking");
  await snapshots.runtime.cleanup();

  // A quiet tool has no deltas. Fake keepalive ticks must refresh its status
  // and renew the 15-second lease for longer than the host's busy badge TTL.
  let clock = 200_000;
  let timerCallback: (() => void) | undefined;
  let liveTimers = 0;
  let leaseExpires = 0;
  const refreshes: Array<{ readonly at: number; readonly reaction: OpenPetsReaction }> = [];
  const quiet = fixture({
    acquireLease: async () => {
      leaseExpires = clock + 15_000;
      return { leaseId: "quiet-lease", expiresAt: leaseExpires, targetKind: "explicit", actualTargetPetId: "fixer", actualTargetPetName: "Fixer", usingDefaultPet: false, leaseActive: true };
    },
    releaseLease: async () => ({ released: true }),
    react: async (reaction) => { refreshes.push({ at: clock, reaction }); },
  }, {
    pet: "fixer",
    now: () => clock,
    timers: {
      setInterval: (callback) => { timerCallback = callback; liveTimers += 1; return 1; },
      clearInterval: () => { liveTimers -= 1; },
    },
  });
  quiet.runtime.prompt("quiet");
  await quiet.flush();
  quiet.runtime.toolBefore("edit", {}, "quiet", "long-tool");
  await quiet.flush();
  for (let tick = 1; tick <= 27; tick += 1) {
    clock += 5_000;
    timerCallback?.();
    await quiet.flush();
    assert.ok(leaseExpires > clock, "a quiet active tool must retain its explicit pet lease");
  }
  const editingRefreshes = refreshes.filter((entry) => entry.reaction === "editing");
  assert.equal(editingRefreshes.length, 14, "continuous state refreshes every ten seconds, not every tick");
  assert.equal(editingRefreshes.at(-1)?.at, 330_000);
  quiet.runtime.toolBefore("bash", { command: "pnpm test" }, "quiet", "failed-parallel-tool");
  await quiet.flush();
  quiet.runtime.toolAfter({ tool: "bash", sessionID: "quiet", id: "failed-parallel-tool", status: "error" });
  await quiet.flush();
  const errorSpeechCount = quiet.calls.filter((call) => call.method === "say" && call.reaction === "error").length;
  clock += 5_000;
  timerCallback?.();
  await quiet.flush();
  assert.equal(refreshes.at(-1)?.reaction, "editing", "a failed parallel tool must not erase the remaining quiet tool's ongoing state");
  assert.ok(leaseExpires > clock);
  assert.equal(quiet.calls.filter((call) => call.method === "say" && call.reaction === "error").length, errorSpeechCount);
  quiet.runtime.prompt("different-session");
  await quiet.flush();
  quiet.runtime.prompt("another-session");
  await quiet.flush();
  assert.deepEqual(refreshes.slice(-2).map((entry) => entry.reaction), ["thinking", "thinking"], "another session's same state must be immediate");
  quiet.runtime.event({ type: "session.idle", data: { sessionID: "another-session" } });
  await quiet.flush();
  assert.equal(liveTimers, 0);
  const afterTerminal = refreshes.length;
  timerCallback?.();
  await quiet.flush();
  assert.equal(refreshes.length, afterTerminal);
  await quiet.runtime.cleanup();
  assert.equal(liveTimers, 0);

  const telemetryCalls: unknown[] = [];
  const ownedTelemetry = fixture({
    tokenRate: async (update) => { telemetryCalls.push(update); },
  });
  ownedTelemetry.runtime.prompt("owner");
  await ownedTelemetry.flush();
  const beforeForeignTelemetry = ownedTelemetry.calls.length;
  for (const event of [
    { type: "session.text.delta", data: { sessionID: "foreign", delta: "private" } },
    { type: "session.usage.updated", data: { sessionID: "foreign", tokens: { output: 999 } } },
    { type: "session.step.ended", data: { sessionID: "foreign", tokens: { output: 999 } } },
    { type: "message.updated", properties: { info: { role: "assistant", sessionID: "foreign", time: { completed: 100_000 }, tokens: { output: 999 } } } },
  ]) ownedTelemetry.runtime.event(event);
  await ownedTelemetry.flush();
  assert.equal(ownedTelemetry.calls.length, beforeForeignTelemetry);
  assert.deepEqual(telemetryCalls, [], "foreign streams and final reports must not overwrite the selected session's token badge");
  await ownedTelemetry.runtime.cleanup();

  // Permission speech keeps its cooldown, while returning to waiting remains
  // immediate. A failed speech request must not start that cooldown.
  let speechAttempts = 0;
  const permissionCalls: Call[] = [];
  const permission = fixture({
    say: async (_message, options) => {
      speechAttempts += 1;
      if (speechAttempts === 1) throw new Error("desktop unavailable");
      permissionCalls.push({ method: "say", reaction: options?.reaction });
    },
    react: async (reaction) => { permissionCalls.push({ method: "react", reaction }); },
  });
  const ask = { type: "permission.asked", data: { sessionID: "permission", action: "edit" } };
  permission.runtime.event(ask);
  await permission.flush();
  permission.runtime.event(ask);
  await permission.flush();
  permission.runtime.event(ask);
  await permission.flush();
  permission.runtime.toolBefore("edit", {}, "permission");
  await permission.flush();
  permission.runtime.event(ask);
  await permission.flush();
  assert.equal(speechAttempts, 2);
  assert.deepEqual(permissionCalls, [
    { method: "say", reaction: "waiting" },
    { method: "react", reaction: "editing" },
    { method: "react", reaction: "waiting" },
  ]);
  await permission.runtime.cleanup();

  // A granted V1 permission resumes the still-running test immediately,
  // including when a later parallel tool has no visible reaction of its own.
  let waitingClock = 400_000;
  let waitingTick: (() => void) | undefined;
  const resumed = fixture({}, {
    now: () => waitingClock,
    timers: { setInterval: (callback) => { waitingTick = callback; return 1; }, clearInterval: () => {} },
  });
  const resumedHooks = createOpenPetsOpenCodeV1Hooks(resumed.runtime);
  await resumedHooks["chat.message"]({ sessionID: "waiting-test" });
  await resumed.flush();
  await resumedHooks["tool.execute.before"]({ tool: "bash", sessionID: "waiting-test", callID: "test" }, { args: { command: "node --test" } });
  await resumed.flush();
  resumed.runtime.toolBefore("bash", { command: "sleep 2" }, "waiting-test", "silent");
  await resumedHooks.event({ event: { type: "permission.asked", properties: { sessionID: "waiting-test", permission: "bash" } } });
  await resumed.flush();
  assert.equal(resumed.calls.at(-1)?.reaction, "waiting");
  assert.ok(hookSpeechPools.permission.includes(resumed.speech.at(-1)?.message ?? ""));
  const waitingCount = resumed.calls.length;
  await resumedHooks.event({ event: { type: "permission.replied", properties: { sessionID: "foreign", reply: "once" } } });
  await resumedHooks.event({ event: { type: "permission.replied", properties: { reply: "once" } } });
  await resumed.flush();
  assert.equal(resumed.calls.length, waitingCount);
  await resumedHooks.event({ event: { type: "permission.replied", properties: { sessionID: "waiting-test", reply: "once" } } });
  await resumed.flush();
  assert.equal(resumed.calls.at(-1)?.reaction, "testing", "permission grant resumes testing before bash completes");
  assert.equal(resumed.calls.at(-1)?.method, "say", "resuming replaces the obsolete explicit permission body");
  assert.ok(hookSpeechPools.thinking.includes(resumed.speech.at(-1)?.message ?? ""));
  waitingClock += 10_000;
  waitingTick?.();
  await resumed.flush();
  assert.equal(resumed.calls.at(-1)?.reaction, "testing", "quiet granted work keeps refreshing its tool state");
  const resumedCount = resumed.calls.length;
  await resumedHooks.event({ event: { type: "permission.replied", properties: { sessionID: "waiting-test", reply: "once" } } });
  await resumed.flush();
  assert.equal(resumed.calls.length, resumedCount, "a duplicate reply does not create another transition");
  resumed.runtime.toolAfter({ tool: "bash", sessionID: "waiting-test", id: "silent", status: "completed" });
  resumed.runtime.toolAfter({ tool: "bash", sessionID: "waiting-test", id: "test", status: "completed" });
  await resumed.flush();
  assert.equal(resumed.calls.at(-1)?.reaction, "thinking");
  await resumed.runtime.cleanup();

  const permissionFallback = fixture();
  permissionFallback.runtime.prompt("waiting-no-tool");
  permissionFallback.runtime.event({ type: "permission.asked", data: { sessionID: "waiting-no-tool", action: "edit" } });
  await permissionFallback.flush();
  permissionFallback.runtime.event({ type: "permission.replied", data: { sessionID: "waiting-no-tool" } });
  await permissionFallback.flush();
  assert.equal(permissionFallback.calls.at(-1)?.reaction, "thinking", "a permission with no tracked tool resumes thinking");
  assert.equal(permissionFallback.calls.at(-1)?.method, "say");
  const beforeOwnPermission = permissionFallback.calls.length;
  permissionFallback.runtime.event({ type: "permission.asked", data: { sessionID: "waiting-no-tool", action: "openpets_openpets_status" } });
  permissionFallback.runtime.event({ type: "permission.replied", data: { sessionID: "waiting-no-tool" } });
  await permissionFallback.flush();
  assert.equal(permissionFallback.calls.length, beforeOwnPermission, "OpenPets' own permission never starts a resumable wait");
  for (const terminal of ["session.idle", "session.error"]) {
    permissionFallback.runtime.prompt("waiting-no-tool");
    permissionFallback.runtime.event({ type: "permission.asked", data: { sessionID: "waiting-no-tool", action: "edit" } });
    await permissionFallback.flush();
    permissionFallback.runtime.event({ type: terminal, data: { sessionID: "waiting-no-tool" } });
    permissionFallback.runtime.event({ type: "permission.replied", data: { sessionID: "waiting-no-tool" } });
    await permissionFallback.flush();
    assert.equal(permissionFallback.calls.at(-1)?.reaction, terminal === "session.idle" ? "success" : "error",
      "late permission replies cannot revive completed or failed work");
  }
  await permissionFallback.runtime.cleanup();

  // The old permission body must be replaced even if another integration just
  // sent thinking speech. This exception belongs only to leaving this wait.
  const resumeThrottlePath = join(root, "resume-cooldown.json");
  writeFileSync(resumeThrottlePath, JSON.stringify({ thinking: 499_999 }));
  const cooldownResume = fixture({}, { now: () => 500_000, throttlePath: resumeThrottlePath });
  cooldownResume.runtime.prompt("cooldown-resume");
  await cooldownResume.flush();
  cooldownResume.runtime.event({ type: "permission.asked", data: { sessionID: "cooldown-resume", action: "edit" } });
  await cooldownResume.flush();
  cooldownResume.runtime.event({ type: "permission.replied", data: { sessionID: "cooldown-resume" } });
  await cooldownResume.flush();
  assert.deepEqual(cooldownResume.calls.at(-1), { method: "say", reaction: "thinking" });
  assert.ok(hookSpeechPools.thinking.includes(cooldownResume.speech.at(-1)?.message ?? ""));
  const afterResume = cooldownResume.calls.length;
  cooldownResume.runtime.event({ type: "permission.replied", data: { sessionID: "cooldown-resume" } });
  cooldownResume.runtime.event({ type: "permission.replied", data: { sessionID: "foreign" } });
  await cooldownResume.flush();
  assert.equal(cooldownResume.calls.length, afterResume);
  await cooldownResume.runtime.cleanup();

  // A later state in the same microtask/acquisition window must inherit the
  // replacement intent while coalescing away the outdated reaction itself.
  for (const nextState of ["delta", "tool"] as const) {
    const coalescedResume = fixture();
    const sessionID = `coalesced-resume-${nextState}`;
    coalescedResume.runtime.prompt(sessionID);
    await coalescedResume.flush();
    coalescedResume.runtime.event({ type: "permission.asked", data: { sessionID, action: "edit" } });
    await coalescedResume.flush();
    coalescedResume.runtime.event({ type: "permission.replied", data: { sessionID } });
    if (nextState === "delta") {
      coalescedResume.runtime.event({ type: "session.text.delta", data: { sessionID, delta: "continued answer" } });
    } else {
      coalescedResume.runtime.toolBefore("edit", {}, sessionID, "continued-tool");
    }
    await coalescedResume.flush();
    assert.deepEqual(coalescedResume.calls.at(-1), { method: "say", reaction: nextState === "delta" ? "thinking" : "editing" },
      "the latest same-activity state replaces approval text even when the initial resume decision was coalesced away");
    await coalescedResume.runtime.cleanup();
  }

  let leaseResumeClock = 700_000;
  let resumeLeaseRequests = 0;
  let finishResumeLease: ((lease: { leaseId: string; expiresAt: number }) => void) | undefined;
  const leaseResume = fixture({
    acquireLease: async () => {
      resumeLeaseRequests += 1;
      const result = resumeLeaseRequests === 1
        ? { leaseId: "resume-old-lease", expiresAt: leaseResumeClock + 15_000 }
        : await new Promise<{ leaseId: string; expiresAt: number }>((resolve) => { finishResumeLease = resolve; });
      return { ...result, targetKind: "explicit", actualTargetPetId: "fixer", actualTargetPetName: "Fixer", usingDefaultPet: false, leaseActive: true };
    },
    releaseLease: async () => ({ released: true }),
  }, { pet: "fixer", now: () => leaseResumeClock });
  leaseResume.runtime.prompt("lease-resume");
  await leaseResume.flush();
  leaseResume.runtime.event({ type: "permission.asked", data: { sessionID: "lease-resume", action: "edit" } });
  await leaseResume.flush();
  const callsBeforeLeaseResume = leaseResume.calls.length;
  leaseResumeClock += 4_000;
  leaseResume.runtime.event({ type: "permission.replied", data: { sessionID: "lease-resume" } });
  const pendingResumeLease = leaseResume.scheduled.shift()?.();
  for (let turn = 0; turn < 10 && !finishResumeLease; turn += 1) await Promise.resolve();
  assert.ok(finishResumeLease, "resuming waits on the required lease renewal");
  leaseResume.runtime.toolBefore("edit", {}, "lease-resume", "latest-edit");
  finishResumeLease({ leaseId: "resume-new-lease", expiresAt: leaseResumeClock + 15_000 });
  await pendingResumeLease;
  await leaseResume.flush();
  assert.deepEqual(leaseResume.calls.slice(callsBeforeLeaseResume), [{ method: "say", reaction: "editing" }],
    "a slow acquisition sends only the latest state and still replaces stale approval text");
  await leaseResume.runtime.cleanup();

  let finishOldResume: (() => void) | undefined;
  const inFlightResumes: Call[] = [];
  const overlappingResume = fixture({
    say: async (_message, options) => {
      inFlightResumes.push({ method: "say", reaction: options?.reaction });
      if (options?.reaction === "thinking") {
        await new Promise<void>((resolve) => { finishOldResume = resolve; });
      }
    },
  });
  overlappingResume.runtime.prompt("overlapping-resume");
  await overlappingResume.flush();
  overlappingResume.runtime.event({ type: "permission.asked", data: { sessionID: "overlapping-resume", action: "edit" } });
  await overlappingResume.flush();
  overlappingResume.runtime.event({ type: "permission.replied", data: { sessionID: "overlapping-resume" } });
  const oldResumeSend = overlappingResume.scheduled.shift()?.();
  for (let turn = 0; turn < 10 && !finishOldResume; turn += 1) await Promise.resolve();
  assert.ok(finishOldResume);
  overlappingResume.runtime.event({ type: "permission.asked", data: { sessionID: "overlapping-resume", action: "edit" } });
  overlappingResume.runtime.event({ type: "permission.replied", data: { sessionID: "overlapping-resume" } });
  overlappingResume.runtime.toolBefore("edit", {}, "overlapping-resume", "new-wait-edit");
  finishOldResume();
  await oldResumeSend;
  await overlappingResume.flush();
  assert.deepEqual(inFlightResumes.at(-1), { method: "say", reaction: "editing" },
    "an older say acknowledgement cannot consume a newer permission wait's replacement intent");
  await overlappingResume.runtime.cleanup();

  for (const boundary of ["session.idle", "new-activity", "new-wait"] as const) {
    const canceledResume = fixture();
    canceledResume.runtime.prompt("canceled-resume");
    await canceledResume.flush();
    canceledResume.runtime.event({ type: "permission.asked", data: { sessionID: "canceled-resume", action: "edit" } });
    await canceledResume.flush();
    canceledResume.runtime.event({ type: "permission.replied", data: { sessionID: "canceled-resume" } });
    const speechBeforeBoundary = canceledResume.speech.length;
    if (boundary === "session.idle") {
      canceledResume.runtime.event({ type: boundary, data: { sessionID: "canceled-resume" } });
    } else if (boundary === "new-activity") {
      canceledResume.runtime.prompt("different-resume-session");
    } else {
      canceledResume.runtime.event({ type: "permission.asked", data: { sessionID: "canceled-resume", action: "edit" } });
    }
    await canceledResume.flush();
    assert.equal(canceledResume.speech.length, speechBeforeBoundary,
      `${boundary} must cancel the superseded permission-resume replacement`);
    await canceledResume.runtime.cleanup();
  }

  let resumeAttempts = 0;
  const retryResumePath = join(root, "resume-retry.json");
  writeFileSync(retryResumePath, JSON.stringify({ thinking: 599_999 }));
  const retryResume = fixture({
    say: async (_message, options) => {
      if (options?.reaction !== "thinking") return;
      resumeAttempts += 1;
      if (resumeAttempts === 1) throw new Error("desktop unavailable");
    },
  }, { now: () => 600_000, throttlePath: retryResumePath });
  retryResume.runtime.prompt("retry-resume");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt === 0) {
      retryResume.runtime.event({ type: "permission.asked", data: { sessionID: "retry-resume", action: "edit" } });
      await retryResume.flush();
      retryResume.runtime.event({ type: "permission.replied", data: { sessionID: "retry-resume" } });
    } else {
      retryResume.runtime.event({ type: "session.text.delta", data: { sessionID: "retry-resume", delta: "retrying state" } });
    }
    await retryResume.flush();
    const persisted = JSON.parse(readFileSync(retryResumePath, "utf8")) as { thinking?: number };
    assert.equal(persisted.thinking, attempt === 0 ? 599_999 : 600_000,
      "failed permission-resume speech must not count as successfully delivered");
  }
  assert.equal(resumeAttempts, 2);
  await retryResume.runtime.cleanup();

  const excludedResume = fixture({}, { excludeReactions: ["thinking"] });
  excludedResume.runtime.prompt("excluded-resume");
  excludedResume.runtime.event({ type: "permission.asked", data: { sessionID: "excluded-resume", action: "edit" } });
  await excludedResume.flush();
  const beforeExcludedResume = excludedResume.calls.length;
  excludedResume.runtime.event({ type: "permission.replied", data: { sessionID: "excluded-resume" } });
  await excludedResume.flush();
  assert.equal(excludedResume.calls.length, beforeExcludedResume, "excluded resume reactions also suppress their replacement speech");
  await excludedResume.runtime.cleanup();

  // OpenCode 1.2.27 emits error, both idle forms, then a failed assistant
  // completion with output=0 in one burst. Idle must not replace that error,
  // and the failed completion must not recreate the cleared token badge.
  const failedReadings: OpenPetsTokenRateUpdate[] = [];
  const failed = fixture({ tokenRate: async (update) => { failedReadings.push(update); } });
  const failedHooks = createOpenPetsOpenCodeV1Hooks(failed.runtime);
  const completedMessage = (sessionID: string, output: number) => ({
    type: "message.updated",
    properties: { info: {
      role: "assistant", sessionID, time: { completed: 100_000 },
      tokens: { output }, error: { name: "APIError", data: { message: "local mock failure" } },
    } },
  });
  await failedHooks["chat.message"]({ sessionID: "failed-v1" });
  await failed.flush();
  failed.runtime.event({ type: "session.step.ended", data: { sessionID: "failed-v1", tokens: { output: 19 } } });
  await failedHooks.event({ event: { type: "session.idle", properties: { sessionID: "failed-v1" } } });
  await failed.flush();
  assert.equal(failedReadings.at(-1)?.outputTokens, 19);
  await failedHooks["chat.message"]({ sessionID: "failed-v1" });
  await failed.flush();
  await failedHooks.event({ event: { type: "session.error", properties: { sessionID: "failed-v1" } } });
  await failedHooks.event({ event: { type: "session.status", properties: { sessionID: "failed-v1", status: { type: "idle" } } } });
  await failedHooks.event({ event: { type: "session.idle", properties: { sessionID: "failed-v1" } } });
  await failedHooks.event({ event: completedMessage("failed-v1", 0) });
  await failedHooks.event({ event: { type: "session.idle", properties: { sessionID: "failed-v1" } } });
  await failed.flush();
  assert.deepEqual(failed.calls.map((call) => call.reaction), ["thinking", "success", "thinking", "error"]);
  assert.deepEqual(failedReadings.at(-1), { sessionId: "failed-v1", tokensPerSecond: null, source: "estimated", leaseId: undefined },
    "failure clears a previous reported badge even after successful idle emptied the tracker");
  const failedReactionCount = failed.calls.length;
  const failedReadingCount = failedReadings.length;
  await failedHooks.event({ event: completedMessage("failed-v1", 0) });
  failed.runtime.event({ type: "session.execution.succeeded", data: { sessionID: "failed-v1" } });
  failed.runtime.event({ type: "session.usage.updated", data: { sessionID: "failed-v1", tokens: { output: 77 } } });
  failed.runtime.event({ type: "session.text.delta", data: { sessionID: "failed-v1", delta: "late" } });
  failed.runtime.toolBefore("edit", {}, "failed-v1", "late-tool");
  failed.runtime.event({ type: "permission.asked", data: { sessionID: "failed-v1", action: "bash" } });
  await failed.flush();
  assert.equal(failed.calls.length, failedReactionCount, "delayed terminal/tool/permission events cannot unlock a failed turn");
  assert.equal(failedReadings.length, failedReadingCount, "delayed usage must not resurrect the failed badge");
  for (const restart of ["prompt", "busy", "started"]) {
    if (restart === "prompt") await failedHooks["chat.message"]({ sessionID: "failed-v1" });
    else if (restart === "busy") await failedHooks.event({ event: { type: "session.status", properties: { sessionID: "failed-v1", status: { type: "busy" } } } });
    else failed.runtime.event({ type: "session.execution.started", data: { sessionID: "failed-v1" } });
    await failed.flush();
    assert.equal(failed.calls.at(-1)?.reaction, "thinking", `${restart} explicitly begins another turn in the same session`);
    failed.runtime.event({ type: "session.step.ended", data: { sessionID: "failed-v1", tokens: { output: 23 } } });
    failed.runtime.event({ type: "session.idle", data: { sessionID: "failed-v1" } });
    await failed.flush();
    assert.equal(failed.calls.at(-1)?.reaction, "success");
    assert.equal(failedReadings.at(-1)?.outputTokens, 23);
    failed.runtime.event({ type: "session.execution.failed", data: { sessionID: "failed-v1" } });
    await failed.flush();
  }
  await failed.runtime.cleanup();

  // A report already in flight can acknowledge after failure. The clear must
  // follow it even though idle already emptied the estimator's state.
  let acknowledgeReport: (() => void) | undefined;
  let reportStarted: (() => void) | undefined;
  const reportInFlight = new Promise<void>((resolve) => { reportStarted = resolve; });
  const reportGate = new Promise<void>((resolve) => { acknowledgeReport = resolve; });
  const delayedReadings: OpenPetsTokenRateUpdate[] = [];
  const delayedFailure = fixture({ tokenRate: async (update) => {
    delayedReadings.push(update);
    if (update.outputTokens !== undefined) {
      reportStarted?.();
      await reportGate;
    }
  } });
  delayedFailure.runtime.prompt("delayed-failure");
  await delayedFailure.flush();
  delayedFailure.runtime.event({ type: "session.step.ended", data: { sessionID: "delayed-failure", tokens: { output: 17 } } });
  delayedFailure.runtime.event({ type: "session.idle", data: { sessionID: "delayed-failure" } });
  await reportInFlight;
  delayedFailure.runtime.event({ type: "session.error", properties: { sessionID: "delayed-failure" } });
  delayedFailure.runtime.event({ type: "session.idle", properties: { sessionID: "delayed-failure" } });
  acknowledgeReport?.();
  await delayedFailure.flush();
  assert.equal(delayedFailure.calls.at(-1)?.reaction, "error");
  assert.deepEqual(delayedReadings.at(-1), { sessionId: "delayed-failure", tokensPerSecond: null, source: "estimated", leaseId: undefined });
  await delayedFailure.runtime.cleanup();

  // Legacy unscoped errors still own an anonymous turn. Token-only telemetry
  // must not give a delayed completion permission to revive the badge.
  const anonymousReadings: OpenPetsTokenRateUpdate[] = [];
  const anonymousFailure = fixture({ tokenRate: async (update) => { anonymousReadings.push(update); } });
  anonymousFailure.runtime.event({ type: "session.step.ended", data: { sessionID: "token-only", tokens: { output: 11 } } });
  anonymousFailure.runtime.event({ type: "session.idle", data: { sessionID: "token-only" } });
  await anonymousFailure.flush();
  anonymousFailure.runtime.event({ type: "session.error" });
  anonymousFailure.runtime.event(completedMessage("token-only", 0));
  anonymousFailure.runtime.event({ type: "session.idle" });
  await anonymousFailure.flush();
  assert.equal(anonymousFailure.calls.at(-1)?.reaction, "error");
  assert.equal(anonymousReadings.at(-1)?.outputTokens, undefined);
  assert.equal(anonymousReadings.at(-1)?.tokensPerSecond, null);
  anonymousFailure.runtime.prompt("token-only");
  anonymousFailure.runtime.event({ type: "session.step.ended", data: { sessionID: "token-only", tokens: { output: 7 } } });
  anonymousFailure.runtime.event({ type: "session.idle", data: { sessionID: "token-only" } });
  await anonymousFailure.flush();
  assert.equal(anonymousFailure.calls.at(-1)?.reaction, "success");
  assert.equal(anonymousReadings.at(-1)?.outputTokens, 7);
  await anonymousFailure.runtime.cleanup();

  // Foreign failures never clear the owner's telemetry. Bounded terminal
  // history retains the current failed owner while evicting old foreign IDs.
  const isolatedReadings: OpenPetsTokenRateUpdate[] = [];
  const terminalHistory = fixture({ tokenRate: async (update) => { isolatedReadings.push(update); } });
  terminalHistory.runtime.prompt("history-owner");
  terminalHistory.runtime.event({ type: "session.step.ended", data: { sessionID: "history-owner", tokens: { output: 13 } } });
  await terminalHistory.flush();
  const ownerReadingCount = isolatedReadings.length;
  terminalHistory.runtime.event({ type: "session.error", properties: { sessionID: "foreign-failure" } });
  await terminalHistory.flush();
  assert.equal(terminalHistory.calls.at(-1)?.reaction, "thinking");
  assert.equal(isolatedReadings.length, ownerReadingCount);
  terminalHistory.runtime.event({ type: "session.error", properties: { sessionID: "history-owner" } });
  await terminalHistory.flush();
  const ownerFailureCount = terminalHistory.calls.length;
  for (let index = 0; index < 128; index += 1) {
    terminalHistory.runtime.event({ type: "session.error", properties: { sessionID: `foreign-${index}` } });
  }
  terminalHistory.runtime.event({ type: "session.idle", properties: { sessionID: "history-owner" } });
  await terminalHistory.flush();
  assert.equal(terminalHistory.calls.length, ownerFailureCount, "foreign terminal churn must not evict the current failure latch");
  terminalHistory.runtime.prompt("different-owner");
  await terminalHistory.flush();
  terminalHistory.runtime.toolBefore("edit", {}, "foreign-0", "old-foreign");
  await terminalHistory.flush();
  assert.equal(terminalHistory.calls.at(-1)?.reaction, "editing", "old foreign terminal history is evicted rather than growing without bound");
  const beforeRecentFailure = terminalHistory.calls.length;
  terminalHistory.runtime.toolBefore("edit", {}, "foreign-127", "recent-foreign");
  await terminalHistory.flush();
  assert.equal(terminalHistory.calls.length, beforeRecentFailure, "recent foreign failures remain closed to implicit tool activity");
  terminalHistory.runtime.event({ type: "session.idle", data: { sessionID: "foreign-0" } });
  await terminalHistory.flush();
  terminalHistory.runtime.event({ type: "session.idle", data: { sessionID: "foreign-0" } });
  await terminalHistory.flush();
  assert.deepEqual(terminalHistory.calls.slice(-2).map((call) => call.reaction), ["success", "success"],
    "ordinary repeated success keeps its existing delivery semantics");
  await terminalHistory.runtime.cleanup();

  // Failure to acquire an explicit pet must never redirect activity to the
  // desktop default pet without its requested lease.
  let fallbackCalls = 0;
  const scopedWork: Array<() => Promise<void>> = [];
  const scoped = createOpenPetsOpenCodeRuntime({
    pet: "fixer",
    clientFactory: () => ({
      acquireLease: async () => { throw new Error("lease unavailable"); },
      react: async () => { fallbackCalls += 1; },
    }) as unknown as OpenPetsClient,
    schedule: (work) => { scopedWork.push(work); },
  });
  scoped.prompt("scoped");
  while (scopedWork.length) await scopedWork.shift()?.();
  await scoped.cleanup();
  assert.equal(fallbackCalls, 0);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("OpenCode realtime state checks passed.");

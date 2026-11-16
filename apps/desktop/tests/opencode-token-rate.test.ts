import assert from "node:assert/strict";

import { formatOpenCodeTokenRate, OpenCodeTokenRateStore, type OpenCodeTokenRateDisplay } from "../src/opencode-token-rate.js";

let now = 1_000;
const store = new OpenCodeTokenRateStore(() => now);
const defaultTarget = { kind: "default" } as const;
const explicitTarget = { kind: "explicit", petId: "gpt-niang" } as const;

assert.equal(store.readDisplay(defaultTarget), null, "a pet with no real usage does not gain a disconnected empty panel");
store.update("unknown-clear", undefined, defaultTarget, { tokensPerSecond: null, source: "estimated" });
assert.equal(store.readDisplay(defaultTarget), null, "a clear is not proof that any usage was received");

store.update("session-a", undefined, defaultTarget, { tokensPerSecond: 20, source: "estimated" });
store.update("session-b", undefined, defaultTarget, { tokensPerSecond: 30, source: "estimated" });
assert.equal(store.read(defaultTarget)?.tokensPerSecond, 30);

store.update("session-b", undefined, defaultTarget, { tokensPerSecond: null, source: "estimated" });
assert.equal(store.read(defaultTarget)?.tokensPerSecond, 20, "clearing one session keeps another session visible");

store.update("session-c", "lease-c", explicitTarget, { tokensPerSecond: 12.5, source: "estimated" });
assert.equal(store.read(explicitTarget)?.tokensPerSecond, 12.5);
store.clearLease("lease-c");
assert.equal(store.read(explicitTarget), null, "released leases do not leave a badge behind");
assert.deepEqual(store.readDisplay(explicitTarget), { state: "idle", tokensPerSecond: null, source: "estimated" }, "lease release keeps only an idle panel, never the released rate");
assert.equal(store.reportedFinalRemainingMs(explicitTarget), 0, "idle history cannot hold an explicit window open");

let finalNow = 1_000;
const finalStore = new OpenCodeTokenRateStore(() => finalNow);
finalStore.update("session-estimate", "lease-estimate", explicitTarget, { tokensPerSecond: 12, source: "estimated" });
finalStore.update("session-final", "lease-final", explicitTarget, { tokensPerSecond: 9, source: "estimated" });
finalStore.update("session-final", "lease-final", explicitTarget, { tokensPerSecond: null, outputTokens: 480, source: "reported" });
finalStore.clearLease("lease-estimate");
finalStore.clearLease("lease-final");
assert.deepEqual(finalStore.read(explicitTarget), { tokensPerSecond: null, outputTokens: 480, source: "reported" }, "lease release keeps a fresh final count visible");
assert.equal(finalStore.reportedFinalRemainingMs(explicitTarget), 8_000);
assert.deepEqual(finalStore.readDisplay(explicitTarget), { state: "summary", tokensPerSecond: null, outputTokens: 480, source: "reported" });
finalNow += 7_999;
assert.equal(finalStore.read(explicitTarget)?.outputTokens, 480);
finalNow += 1;
finalStore.sweepExpired();
assert.equal(finalStore.read(explicitTarget), null, "final count disappears after its brief grace period");
assert.deepEqual(finalStore.readDisplay(explicitTarget), { state: "idle", tokensPerSecond: null, outputTokens: 480, source: "reported" }, "the last reported total remains historical after the live summary expires");
assert.equal(finalStore.reportedFinalRemainingMs(explicitTarget), 0, "history does not extend the eight-second explicit window grace");

finalStore.update("session-old", "lease-old", explicitTarget, { tokensPerSecond: null, outputTokens: 100, source: "reported" });
finalStore.clearLease("lease-old");
finalStore.clearTarget(explicitTarget);
assert.equal(finalStore.read(explicitTarget), null, "a new explicit lease clears the prior session's final count");
assert.equal(finalStore.readDisplay(explicitTarget), null, "clearTarget resets the panel's seen/last-output history too");

now += 5_001;
store.sweepExpired();
assert.equal(store.read(defaultTarget), null, "estimated rate disappears when events stop");
assert.deepEqual(store.readDisplay(defaultTarget), { state: "idle", tokensPerSecond: null, source: "estimated" }, "expired estimates never remain visible as live speed");

store.update("session-d", undefined, defaultTarget, { tokensPerSecond: null, outputTokens: 480, source: "reported" });
assert.deepEqual(store.read(defaultTarget), { tokensPerSecond: null, outputTokens: 480, source: "reported" });
now += 8_001;
store.sweepExpired();
assert.equal(store.read(defaultTarget), null, "final token total is brief");
assert.deepEqual(store.readDisplay(defaultTarget), { state: "idle", tokensPerSecond: null, outputTokens: 480, source: "reported" });

{
  let clock = 10_000;
  const persistent = new OpenCodeTokenRateStore(() => clock);
  const displays: Array<OpenCodeTokenRateDisplay | null> = [];
  persistent.subscribe((target) => displays.push(persistent.readDisplay(target)));
  persistent.update("last-output", undefined, defaultTarget, { tokensPerSecond: null, outputTokens: 27, source: "reported" });
  clock += 8_000;
  assert.equal(persistent.read(defaultTarget), null);
  assert.deepEqual(persistent.readDisplay(defaultTarget), { state: "idle", tokensPerSecond: null, outputTokens: 27, source: "reported" }, "display reads honor expiry even before the expiry sweep");
  persistent.sweepExpired();
  assert.equal(displays.at(-1)?.state, "idle", "expiry notifies the UI to replace the summary with an idle panel");

  persistent.update("new-turn", undefined, defaultTarget, { tokensPerSecond: 18, source: "estimated" });
  assert.deepEqual(persistent.readDisplay(defaultTarget), { state: "live", tokensPerSecond: 18, outputTokens: undefined, source: "estimated" });
  persistent.update("new-turn", undefined, defaultTarget, { tokensPerSecond: null, source: "estimated" });
  assert.deepEqual(persistent.readDisplay(defaultTarget), { state: "idle", tokensPerSecond: null, outputTokens: 27, source: "reported" }, "an error clear keeps the prior real total without inventing output zero");
  assert.deepEqual(formatOpenCodeTokenRate(persistent.readDisplay(defaultTarget), "输出", "空闲", "上次输出"), {
    state: "idle", rateText: "— tk/s", rateLabel: "空闲", outputText: "上次输出 27 tokens",
    averageText: "— tk/s", averageLabel: "AVG", rateTier: "unknown", averageTier: "unknown",
  });
  assert.deepEqual(formatOpenCodeTokenRate(persistent.readDisplay(defaultTarget), "Output"), {
    state: "idle", rateText: "— tk/s", rateLabel: "Idle", outputText: "Last output 27 tokens",
    averageText: "— tk/s", averageLabel: "AVG", rateTier: "unknown", averageTier: "unknown",
  });

  persistent.update("other-target", "other-lease", explicitTarget, { tokensPerSecond: null, outputTokens: 91, source: "reported" });
  clock += 8_000;
  persistent.sweepExpired();
  assert.equal(persistent.readDisplay(defaultTarget)?.outputTokens, 27);
  assert.equal(persistent.readDisplay(explicitTarget)?.outputTokens, 91, "target histories never leak into each other");
  persistent.clearTarget(explicitTarget);
  assert.equal(persistent.readDisplay(explicitTarget), null);
  assert.equal(persistent.readDisplay(defaultTarget)?.outputTokens, 27);
  assert.equal(displays.at(-1), null, "clearing an idle-only target still notifies the UI to remove it");
  persistent.clearAll();
  assert.equal(persistent.readDisplay(defaultTarget), null);
  assert.equal(persistent.readDisplay(explicitTarget), null);
  assert.equal(displays.at(-1), null, "clearAll also removes idle-only history");
  persistent.update("clear-after-reset", undefined, defaultTarget, { tokensPerSecond: null, source: "estimated" });
  assert.equal(persistent.readDisplay(defaultTarget), null);
}

{
  const fresh = new OpenCodeTokenRateStore();
  fresh.update("error-before-usage", undefined, defaultTarget, { tokensPerSecond: null, source: "estimated" });
  assert.equal(fresh.readDisplay(defaultTarget), null, "an initial error does not fabricate a zero-speed or zero-output panel");
  fresh.update("real-zero", undefined, defaultTarget, { tokensPerSecond: 0, source: "estimated" });
  assert.equal(fresh.readDisplay(defaultTarget)?.state, "live", "an actual numeric zero is a valid sample");
  fresh.update("real-zero", undefined, defaultTarget, { tokensPerSecond: null, source: "estimated" });
  assert.deepEqual(formatOpenCodeTokenRate(fresh.readDisplay(defaultTarget), "输出", "空闲", "上次输出"), {
    state: "idle", rateText: "— tk/s", rateLabel: "空闲", outputText: "",
    averageText: "— tk/s", averageLabel: "AVG", rateTier: "unknown", averageTier: "unknown",
  });
}

{
  let clock = 1_000;
  const bounded = new OpenCodeTokenRateStore(() => clock);
  const targets = Array.from({ length: 65 }, (_, index) => ({ kind: "explicit" as const, petId: `pet-${index}` }));
  for (const [index, target] of targets.entries()) {
    bounded.update(`session-${index}`, undefined, target, { tokensPerSecond: index + 1, source: "estimated" });
    clock += 5_000;
    bounded.sweepExpired();
  }
  assert.equal(targets.filter((target) => bounded.readDisplay(target) !== null).length, 64, "expired target history remains bounded independently of active entries");
  assert.equal(bounded.readDisplay(targets[0]!), null, "the least recent target is evicted");
  assert.equal(bounded.readDisplay(targets.at(-1)!)?.state, "idle");
  bounded.clearAll();
  assert.equal(targets.filter((target) => bounded.readDisplay(target) !== null).length, 0);
}

assert.deepEqual(formatOpenCodeTokenRate({ tokensPerSecond: 12.5, source: "estimated" }, "输出"), {
  state: "live", rateText: "≈12.5 tk/s", rateLabel: "Live", outputText: "",
  averageText: "— tk/s", averageLabel: "AVG", rateTier: "slow", averageTier: "unknown",
}, "the formatter still accepts existing active-reading callers");
assert.equal(formatOpenCodeTokenRate(null, "输出"), null);

// Both metrics classify the actual numeric speed at the requested boundaries;
// a slow or zero speed is a gray measurement, never an error/unknown state.
for (const [rate, tier] of [[0, "slow"], [20, "slow"], [20.1, "medium"], [40, "medium"], [40.1, "fast"]] as const) {
  const display = formatOpenCodeTokenRate({
    tokensPerSecond: rate,
    averageTokensPerSecond: rate,
    source: "estimated",
  }, "输出", "待机", "上次", "实时");
  assert.equal(display?.rateTier, tier);
  assert.equal(display?.averageTier, tier);
  assert.equal(display?.rateLabel, "实时");
}

{
  const unknownAverage = formatOpenCodeTokenRate({ tokensPerSecond: 30, source: "estimated" }, "输出");
  assert.equal(unknownAverage?.averageText, "— tk/s", "missing AVG is unavailable rather than fabricated zero");
  assert.equal(unknownAverage?.averageTier, "unknown");
  const reported = formatOpenCodeTokenRate({
    tokensPerSecond: null,
    outputTokens: 240,
    averageTokensPerSecond: 30,
    source: "reported",
  }, "输出", "待机", "上次", "实时");
  assert.equal(reported?.rateText, "— tk/s", "the output count never substitutes for real-time speed");
  assert.equal(reported?.rateTier, "unknown");
  assert.equal(reported?.averageText, "≈30.0 tk/s", "AVG remains estimated even when the final token count is reported");
  assert.equal(reported?.averageTier, "medium");
  assert.equal(reported?.averageLabel, "AVG");
  assert.equal(reported?.outputText, "输出 240 tokens");
}

{
  let clock = 1_000;
  const averages = new OpenCodeTokenRateStore(() => clock);
  averages.update("first-output", undefined, defaultTarget, {
    tokensPerSecond: 45,
    averageTokensPerSecond: 30,
    source: "estimated",
  });
  assert.equal(averages.readDisplay(defaultTarget)?.averageTokensPerSecond, 30, "live AVG travels with its current output segment");
  averages.update("first-output", undefined, defaultTarget, {
    tokensPerSecond: null,
    outputTokens: 240,
    averageTokensPerSecond: 30,
    source: "reported",
  });
  assert.equal(averages.readDisplay(defaultTarget)?.state, "summary");
  assert.equal(averages.readDisplay(defaultTarget)?.averageTokensPerSecond, 30);
  clock += 8_000;
  averages.sweepExpired();
  const historical = averages.readDisplay(defaultTarget);
  assert.equal(historical?.state, "idle");
  assert.equal(historical?.tokensPerSecond, null, "historical AVG does not resurrect an expired real-time speed");
  assert.equal(historical?.averageTokensPerSecond, 30, "final AVG survives the short summary TTL as history");
  const historicalText = formatOpenCodeTokenRate(historical, "输出", "待机", "上次", "实时");
  assert.equal(historicalText?.averageLabel, "上次 AVG");
  assert.equal(historicalText?.averageText, "≈30.0 tk/s");
  assert.equal(historicalText?.rateText, "— tk/s");

  averages.update("next-output", undefined, defaultTarget, { tokensPerSecond: 10, source: "estimated" });
  assert.equal(averages.readDisplay(defaultTarget)?.averageTokensPerSecond, undefined, "a new live segment cannot inherit another segment's AVG");
  averages.update("next-output", undefined, defaultTarget, { tokensPerSecond: null, source: "estimated" });
  assert.equal(averages.readDisplay(defaultTarget)?.averageTokensPerSecond, 30, "an error clear retains only the previously completed segment's historical AVG");

  averages.update("short-output", undefined, defaultTarget, { tokensPerSecond: null, outputTokens: 5, source: "reported" });
  assert.equal(averages.readDisplay(defaultTarget)?.averageTokensPerSecond, undefined, "a final result with no AVG clears the older segment's AVG immediately");
  clock += 8_000;
  averages.sweepExpired();
  assert.equal(averages.readDisplay(defaultTarget)?.averageTokensPerSecond, undefined, "missing final AVG does not reappear from history after expiry");
  assert.equal(formatOpenCodeTokenRate(averages.readDisplay(defaultTarget), "输出")?.averageText, "— tk/s");
  averages.clearTarget(defaultTarget);
  assert.equal(averages.readDisplay(defaultTarget), null);
}

console.log("OpenCode token rate lifecycle passed.");

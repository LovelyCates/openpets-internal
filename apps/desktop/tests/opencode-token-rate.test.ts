import assert from "node:assert/strict";

import { OpenCodeTokenRateStore } from "../src/opencode-token-rate.js";

let now = 1_000;
const store = new OpenCodeTokenRateStore(() => now);
const defaultTarget = { kind: "default" } as const;
const explicitTarget = { kind: "explicit", petId: "gpt-niang" } as const;

store.update("session-a", undefined, defaultTarget, { tokensPerSecond: 20, source: "estimated" });
store.update("session-b", undefined, defaultTarget, { tokensPerSecond: 30, source: "estimated" });
assert.equal(store.read(defaultTarget)?.tokensPerSecond, 30);

store.update("session-b", undefined, defaultTarget, { tokensPerSecond: null, source: "estimated" });
assert.equal(store.read(defaultTarget)?.tokensPerSecond, 20, "clearing one session keeps another session visible");

store.update("session-c", "lease-c", explicitTarget, { tokensPerSecond: 12.5, source: "estimated" });
assert.equal(store.read(explicitTarget)?.tokensPerSecond, 12.5);
store.clearLease("lease-c");
assert.equal(store.read(explicitTarget), null, "released leases do not leave a badge behind");

let finalNow = 1_000;
const finalStore = new OpenCodeTokenRateStore(() => finalNow);
finalStore.update("session-estimate", "lease-estimate", explicitTarget, { tokensPerSecond: 12, source: "estimated" });
finalStore.update("session-final", "lease-final", explicitTarget, { tokensPerSecond: 9, source: "estimated" });
finalStore.update("session-final", "lease-final", explicitTarget, { tokensPerSecond: null, outputTokens: 480, source: "reported" });
finalStore.clearLease("lease-estimate");
finalStore.clearLease("lease-final");
assert.deepEqual(finalStore.read(explicitTarget), { tokensPerSecond: null, outputTokens: 480, source: "reported" }, "lease release keeps a fresh final count visible");
assert.equal(finalStore.reportedFinalRemainingMs(explicitTarget), 8_000);
finalNow += 7_999;
assert.equal(finalStore.read(explicitTarget)?.outputTokens, 480);
finalNow += 1;
finalStore.sweepExpired();
assert.equal(finalStore.read(explicitTarget), null, "final count disappears after its brief grace period");

finalStore.update("session-old", "lease-old", explicitTarget, { tokensPerSecond: null, outputTokens: 100, source: "reported" });
finalStore.clearLease("lease-old");
finalStore.clearTarget(explicitTarget);
assert.equal(finalStore.read(explicitTarget), null, "a new explicit lease clears the prior session's final count");

now += 5_001;
store.sweepExpired();
assert.equal(store.read(defaultTarget), null, "estimated rate disappears when events stop");

store.update("session-d", undefined, defaultTarget, { tokensPerSecond: null, outputTokens: 480, source: "reported" });
assert.deepEqual(store.read(defaultTarget), { tokensPerSecond: null, outputTokens: 480, source: "reported" });
now += 8_001;
store.sweepExpired();
assert.equal(store.read(defaultTarget), null, "final token total is brief");

console.log("OpenCode token rate lifecycle passed.");

import assert from "node:assert/strict";
import { PetActivityService, type PetActivityCarrier } from "../src/pet-activity-service.js";
import { normalizePetActivityPreferences } from "../src/pet-activity-policy.js";

const activities = ["read", "stretch"].map((id) => ({ id, displayName: id, durationMs: 2000 }));

function fixture(enabled: readonly string[] = ["read", "stretch"], classicIdle = false, random = 0) {
  let now = 0;
  let busy: string | null = null;
  const played: Array<{ id: string; generation: number; windowId: number }> = [];
  const stopped: number[] = [];
  const failed: string[] = [];
  const gestures: number[] = [];
  const stoppedGestures: number[] = [];
  let variations = 0;
  const service = new PetActivityService({
    now: () => now, random: () => random, enabledIds: () => enabled,
    onFailure: (_pet, id, outfit, revision) => failed.push(`${id}:${outfit}:${revision}`),
  });
  const carrier = (id = 1, outfitId = "default", revision = "v1"): PetActivityCarrier => ({
    id, petId: "cat", outfitId, revision, failureRevision: revision,
    activities: outfitId === "pajamas" ? [activities[1]!] : activities,
    availabilityReason: () => busy,
    play: (activity, generation) => played.push({ id: activity.id, generation, windowId: id }),
    stop: (_activity, generation) => stopped.push(generation),
    variation: () => { variations += 1; },
    ...(classicIdle ? {
      classicIdle: {
        durationMs: 1680,
        play: () => gestures.push(id),
        stop: () => stoppedGestures.push(id),
      },
    } : {}),
  });
  service.register(carrier());
  return {
    service, played, stopped, failed, carrier, gestures, stoppedGestures,
    at(value: number) { now = value; service.tick(); },
    busy(value: string | null) { busy = value; },
    get variations() { return variations; },
    result(index: number, outcome: "started" | "completed" | "cancelled" | "failed") {
      const item = played[index]!;
      service.result(item.windowId, item.generation, item.id, outcome);
    },
  };
}

// A Classic V1 companion is visibly alive without opting artwork activities in.
// The scheduler's two random extremes bound the gesture gap to 15–30 seconds.
for (const [random, gap] of [[0, 15_000], [1, 30_000]] as const) {
  const f = fixture([], true, random);
  f.at(0); f.at(gap - 1);
  assert.deepEqual(f.gestures, []);
  f.at(gap);
  assert.deepEqual(f.gestures, [1]);
  f.at(gap * 2 - 1);
  assert.deepEqual(f.gestures, [1]);
  f.at(gap * 2);
  assert.deepEqual(f.gestures, [1, 1]);
  assert.deepEqual(f.played, [], "cosmetic gestures cannot opt activities in");
}

// Busy interruptions cancel the current gesture and require a fresh quiet gap.
{
  const f = fixture([], true);
  f.at(0); f.at(15_000);
  f.busy("working"); f.at(15_100);
  assert.deepEqual(f.stoppedGestures, [1]);
  f.busy(null); f.at(15_200); f.at(30_199);
  assert.deepEqual(f.gestures, [1]);
  f.at(30_200);
  assert.deepEqual(f.gestures, [1, 1]);
}

// Native opt-in timing remains unchanged; an automatic or manual activity
// preempts cosmetic playback instead of competing for the same pet's budget.
{
  const f = fixture(["read"], true);
  f.at(0); f.at(15_000);
  assert.deepEqual(f.played, []);
  f.service.play("cat", "read", 1);
  assert.deepEqual(f.stoppedGestures, [1]);
  f.result(0, "started"); f.result(0, "completed");
  f.at(15_001); f.at(135_000);
  assert.equal(f.played.length, 1);
  f.at(135_001);
  assert.equal(f.played.length, 1, "read is still on its existing five-minute cooldown");
  assert.deepEqual(f.failed, []);
}
{
  const f = fixture(["read"], true);
  f.at(0); f.at(119_999);
  assert.equal(f.played.length, 0);
  f.at(120_000);
  assert.equal(f.played[0]?.id, "read", "fast V1 gestures do not accelerate automatic activities");
}

// Two visible windows share the same pet's 15–30s cadence, so opening more
// carriers cannot multiply the number of gestures or bypass the quiet gap.
{
  const f = fixture([], true);
  f.service.register(f.carrier(2));
  f.at(0); f.at(15_000); f.at(16_679);
  assert.equal(f.gestures.length, 1);
  f.at(16_680);
  assert.equal(f.gestures.length, 1);
  f.at(29_999);
  assert.equal(f.gestures.length, 1);
  f.at(30_000);
  assert.equal(f.gestures.length, 2);
  f.service.play("cat", "read", 1);
  assert.equal(f.stoppedGestures.length, 1);
  f.at(45_000);
  assert.equal(f.gestures.length, 2, "native activity reserves all carriers of this pet");
}

// Appearance replacement and window teardown cancel without leaving a future
// cosmetic offer behind; HUD-only registration preserves the current slot.
{
  const f = fixture([], true);
  f.at(0); f.at(15_000);
  f.service.register(f.carrier());
  assert.deepEqual(f.stoppedGestures, []);
  f.service.register(f.carrier(1, "pajamas"));
  assert.deepEqual(f.stoppedGestures, [1]);
  f.at(15_100); f.at(30_100);
  assert.deepEqual(f.gestures, [1, 1]);
  f.service.remove(1);
  assert.deepEqual(f.stoppedGestures, [1, 1]);
  f.at(90_000);
  assert.deepEqual(f.gestures, [1, 1]);
}

// Quiet opportunities are opt-in, bounded, and can trigger neutral variation.
{
  const f = fixture([]);
  f.at(0); f.at(119_999); assert.equal(f.played.length, 0);
  f.at(120_000); assert.equal(f.played.length, 0); assert.equal(f.variations, 1);
}

// Busy interruption resets the opportunity and does not quarantine an asset.
{
  const f = fixture();
  f.at(0); f.at(120_000); assert.equal(f.played[0]?.id, "read");
  f.busy("working"); f.at(120_001);
  assert.equal(f.service.getPlayingActivityId("cat"), null);
  assert.deepEqual(f.failed, []); assert.equal(f.stopped.length, 1);
  f.busy(null); f.at(120_002); f.at(240_001); assert.equal(f.played.length, 1);
}

// Only a first-frame acknowledgement consumes cooldown; cancellation before it does not.
{
  const f = fixture();
  f.service.play("cat", "read", 1);
  assert.throws(() => f.service.play("cat", "stretch", 1), /already playing/);
  f.service.cancel(1);
  f.result(0, "started");
  f.at(0); f.at(120_000); assert.equal(f.played[1]?.id, "read");
  f.result(1, "started"); f.result(1, "completed");
  f.service.register(f.carrier(1, "pajamas"));
  f.at(120_000); f.at(240_000); assert.equal(f.played[2]?.id, "stretch");
  f.result(2, "started"); f.result(2, "completed");
  f.service.register(f.carrier());
  f.at(240_000); f.at(360_000); assert.equal(f.played.length, 3);
  f.at(480_000); assert.equal(f.played[3]?.id, "read");
}

// Wrong identity and stale generations cannot complete or fail a replacement.
{
  const f = fixture();
  f.service.play("cat", "read", 1);
  const first = f.played[0]!;
  f.service.register(f.carrier()); // HUD-only refresh retains the active reservation.
  assert.equal(f.service.isCurrent(1, first.generation), true);
  f.service.result(1, first.generation, "stretch", "failed");
  assert.deepEqual(f.failed, []);
  f.service.register(f.carrier(1, "pajamas"));
  f.service.play("cat", "stretch", 1);
  f.result(0, "failed");
  assert.equal(f.service.getPlayingActivityId("cat"), "stretch");
  f.result(1, "failed");
  assert.deepEqual(f.failed, ["stretch:pajamas:v1"]);
  assert.throws(() => f.service.play("cat", "stretch", 1), /unavailable/);
  f.service.register(f.carrier(1, "default", "v2"));
  f.service.play("cat", "stretch", 1);
}

// A nonresponsive renderer cannot retain the reservation indefinitely.
{
  const f = fixture();
  f.service.play("cat", "read", 1);
  f.at(7001);
  assert.equal(f.service.getPlayingActivityId("cat"), null);
  assert.deepEqual(f.failed, ["read:default:v1"]);
}

assert.deepEqual(normalizePetActivityPreferences({ cat: ["read", "read", "cat_nap", false, "../bad"], dog: [] }), { cat: ["read", "cat_nap"] });

import assert from "node:assert/strict";
import { it } from "node:test";
import type { MotionBodyDescriptor, PetBodySnapshot } from "../src/pet-body-contract.js";
import { createPetBodyState, createPetBodyVisibility, effectivePetBodyContext, isCurrentPetContentCommit, readPetMotionPreference, replacePluginSpriteWithReaction, updateLoadedPetDocument } from "../src/pet-body-state.js";

it("accepts the motion preference only from the ready current document", () => {
  const snapshots: PetBodySnapshot[] = [];
  const state = createPetBodyState((snapshot) => snapshots.push(snapshot), () => {});
  state.ready();
  const epoch = snapshots.at(-1)!.input.epoch;
  assert.equal(readPetMotionPreference({ epoch, reducedMotion: false }, true, state.isCurrentEpoch), false);
  assert.equal(readPetMotionPreference({ epoch, reducedMotion: true }, true, state.isCurrentEpoch), true);
  assert.equal(readPetMotionPreference({ epoch, reducedMotion: true }, false, state.isCurrentEpoch), null);
  assert.equal(readPetMotionPreference({ epoch, reducedMotion: "true" }, true, state.isCurrentEpoch), null);
  state.documentLost();
  assert.equal(readPetMotionPreference({ epoch, reducedMotion: true }, true, state.isCurrentEpoch), null);
});

function setMotion(state: ReturnType<typeof createPetBodyState>, assets: MotionBodyDescriptor): void {
  const candidate = state.prepareMotionAppearance(assets, "default", "initial", false);
  state.publishMotionAppearance(candidate);
}

function sendResult(state: ReturnType<typeof createPetBodyState>, snapshots: PetBodySnapshot[], result: { readonly epoch: string; readonly snapshotId: string; readonly playbackId: number; readonly intentId?: string; readonly outcome: "started" | "completed" | "cancelled" | "failed" }): void {
  const appearance = [...snapshots].reverse().find((snapshot) => snapshot.motion?.assets.snapshotId === result.snapshotId)?.motion;
  state.result({ ...result, presentationId: appearance?.presentationId ?? "missing", outfitId: appearance?.outfitId ?? "default" });
}

it("retains Classic work timing through presentation refreshes and separates it from Motion intent", () => {
  const snapshots: PetBodySnapshot[] = [];
  const state = createPetBodyState((snapshot) => snapshots.push(snapshot), () => {});
  // Semantic ingress can precede selection of the first artwork.
  state.react("waiting", "waiting", 2200);
  state.clearMotion();
  state.ready();
  assert.deepEqual(snapshots.at(-1)!.input.classic, {
    reaction: "waiting", spriteState: "waiting", cycleDurationMs: 2200,
  });
  state.setPaused(true);
  state.clearMotion();
  state.setPaused(false);
  assert.equal(snapshots.at(-1)!.input.classic?.cycleDurationMs, 2200);
  state.react("success", "jumping", 840);
  assert.equal(snapshots.at(-1)!.input.classic?.reaction, "success", "a terminal event replaces the busy presentation without falsifying context");
  assert.equal(snapshots.at(-1)!.input.context, "waiting");
  setMotion(state, { snapshotId: "motion" } as MotionBodyDescriptor);
  assert.equal(snapshots.at(-1)!.input.classic, undefined);
  state.react("editing", "running", 820);
  assert.equal(snapshots.at(-1)!.input.classic, undefined, "Motion never inherits Classic's three-cycle policy");
  assert.equal(snapshots.at(-1)!.input.context, "editing");
});

it("applies animation settings during ongoing Classic work without minting another semantic event", () => {
  const snapshots: PetBodySnapshot[] = [];
  const state = createPetBodyState((snapshot) => snapshots.push(snapshot), () => {});
  state.clearMotion();
  state.react("thinking", "review", 1030);
  state.configureClassicAnimation({ thinking: "waiting" }, 2200);
  assert.deepEqual(snapshots.at(-1)!.input.classic, {
    reaction: "thinking", spriteState: "waiting", cycleDurationMs: 2200,
  });
  assert.equal(snapshots.at(-1)!.input.context, "thinking");
  assert.equal(snapshots.at(-1)!.input.event, undefined);
  const count = snapshots.length;
  state.configureClassicAnimation({ thinking: "waiting" }, 2200);
  assert.equal(snapshots.length, count, "HUD/content commits with unchanged settings do not publish another intent");
  state.configureClassicAnimation({ thinking: "waiting" }, 1010);
  assert.equal(snapshots.at(-1)!.input.classic?.cycleDurationMs, 1010, "speed changes do not wait for an integration heartbeat");
  state.configureClassicAnimation({ thinking: "jumping" }, 1010);
  assert.equal(snapshots.at(-1)!.input.classic?.spriteState, "jumping");
  assert.equal(snapshots.at(-1)!.input.event, undefined, "a settings edit is not a new finite semantic reaction");
});

it("preserves an event before the first Motion appearance is selected", () => {
  const snapshots: PetBodySnapshot[] = [];
  const state = createPetBodyState((snapshot) => snapshots.push(snapshot), () => {});
  state.react("success");
  const event = snapshots.at(-1)!.input.event;
  assert.ok(event);
  setMotion(state, { snapshotId: "motion" } as MotionBodyDescriptor);
  assert.equal(snapshots.at(-1)!.input.event?.id, event.id);
});

it("treats a lost Classic document as unknown until its replacement is selected", () => {
  const snapshots: PetBodySnapshot[] = [];
  const state = createPetBodyState((snapshot) => snapshots.push(snapshot), () => {});
  state.clearMotion();
  state.documentLost();
  state.react("waving");
  const eventId = snapshots.at(-1)!.input.event?.id;
  assert.ok(eventId);
  setMotion(state, { snapshotId: "replacement" } as MotionBodyDescriptor);
  assert.equal(snapshots.at(-1)!.input.event?.id, eventId);
});

it("keeps Classic finite event identity through content commits without leaking it into Motion", () => {
  const snapshots: PetBodySnapshot[] = [];
  const state = createPetBodyState((snapshot) => snapshots.push(snapshot), () => {});
  state.react("success");
  assert.ok(snapshots.at(-1)!.input.event);
  state.clearMotion();
  assert.equal(snapshots.at(-1)!.input.event, undefined);
  const afterClassic = snapshots.length;
  state.react("error");
  assert.equal(snapshots.length, afterClassic + 1);
  const classicEvent = snapshots.at(-1)!.input.event;
  assert.equal(classicEvent?.classicSpriteState, "failed");
  state.ready();
  state.clearMotion();
  assert.equal(snapshots.at(-1)!.input.event?.id, classicEvent?.id, "HUD/content commits retain the event identity");
  state.react("error");
  assert.notEqual(snapshots.at(-1)!.input.event?.id, classicEvent?.id, "a real repeated finite react is a new event");
  state.react("working");
  assert.equal(snapshots.at(-1)!.input.context, "working");
  assert.equal(snapshots.at(-1)!.input.event, undefined);

  setMotion(state, { snapshotId: "motion" } as MotionBodyDescriptor);
  state.react("success");
  const snapshot = snapshots.at(-1)!;
  const event = snapshot.input.event;
  assert.ok(event);
  assert.equal(event.classicSpriteState, undefined, "Motion retains its existing semantic event path");
  sendResult(state, snapshots, { epoch: snapshot.input.epoch, snapshotId: "motion", playbackId: 1, intentId: event.id, outcome: "started" });
  sendResult(state, snapshots, { epoch: snapshot.input.epoch, snapshotId: "motion", playbackId: 1, intentId: event.id, outcome: "completed" });
  assert.equal(snapshots.at(-1)!.input.event, undefined);
  assert.equal(snapshots.at(-1)!.input.context, "working");
});

it("Classic events follow resolved finite overrides rather than the semantic reaction name", () => {
  const snapshots: PetBodySnapshot[] = [];
  const state = createPetBodyState((snapshot) => snapshots.push(snapshot), () => {});
  state.clearMotion();
  state.react("thinking", "jumping");
  const first = snapshots.at(-1)!.input;
  assert.equal(first.context, "thinking");
  assert.equal(first.event?.reaction, "thinking");
  assert.equal(first.event?.classicSpriteState, "jumping");
  state.react("thinking", "jumping");
  assert.notEqual(snapshots.at(-1)!.input.event?.id, first.event?.id);
  state.react("success", "review");
  assert.equal(snapshots.at(-1)!.input.event, undefined, "a looping override is not forcibly restarted");
  state.react("thinking", "jumping");
  setMotion(state, { snapshotId: "motion" } as MotionBodyDescriptor);
  assert.equal(snapshots.at(-1)!.input.event, undefined, "a Classic-only override cannot become a Motion event");
});

it("suspends a hidden pet, discards events, and resumes its latest context", () => {
  const snapshots: PetBodySnapshot[] = [];
  const commits: string[] = [];
  const state = createPetBodyState((snapshot) => snapshots.push(snapshot), (appearance) => commits.push(appearance.assets.snapshotId));
  setMotion(state, { snapshotId: "one" } as MotionBodyDescriptor);
  state.react("working");
  state.react("success");
  const previous = snapshots.at(-1)!.input;
  state.setSuspended(true);
  assert.equal(snapshots.at(-1)!.input.suspended, true);
  assert.equal(snapshots.at(-1)!.input.event, undefined);
  state.react("waiting");
  state.react("error");
  sendResult(state, snapshots, { epoch: previous.epoch, snapshotId: "one", playbackId: 1, outcome: "started" });
  state.setSuspended(false);
  assert.equal(snapshots.at(-1)!.input.suspended, false);
  assert.equal(snapshots.at(-1)!.input.context, "waiting");
  assert.equal(snapshots.at(-1)!.input.event, undefined);
  assert.deepEqual(commits, []);
});

it("uses logical layer visibility even when its offscreen document is hidden", () => {
  const changes: boolean[] = [];
  const offscreen = { documentHidden: true };
  const visibility = createPetBodyVisibility(false, (suspended) => changes.push(suspended));
  visibility.setVisible(true);
  assert.equal(offscreen.documentHidden, true);
  assert.equal(changes.at(-1), false);
  visibility.setSystemSuspended(true);
  assert.equal(changes.at(-1), true);
  visibility.setVisible(false);
  visibility.setSystemSuspended(false);
  assert.equal(changes.at(-1), true);
  visibility.setVisible(true);
  assert.equal(changes.at(-1), false);
});

it("tracks host show and hide, not a native occlusion notification", () => {
  const snapshots: PetBodySnapshot[] = [];
  const state = createPetBodyState((snapshot) => snapshots.push(snapshot), () => {});
  const visibility = createPetBodyVisibility(false, (suspended) => state.setSuspended(suspended));
  state.ready();
  assert.equal(snapshots.at(-1)!.input.suspended, true, "unshown gated window remains suspended");
  let shown = false;
  visibility.show(() => { shown = true; });
  assert.equal(shown, true);
  assert.equal(snapshots.at(-1)!.input.suspended, false);
  visibility.syncNative(() => ({ visible: true, minimized: false }), "native-hide");
  assert.equal(snapshots.at(-1)!.input.suspended, false, "occlusion does not hide a visible pet");
  visibility.hide(() => { shown = false; });
  assert.equal(shown, false);
  assert.equal(snapshots.at(-1)!.input.suspended, true);
});

it("does not mark a pet shown when the native show fails", () => {
  const changes: boolean[] = [];
  const visibility = createPetBodyVisibility(false, (suspended) => changes.push(suspended));
  assert.throws(() => visibility.show(() => { throw new Error("show failed"); }));
  assert.deepEqual(changes, [true]);
});

it("admits a named reaction when it replaces a plugin sprite", () => {
  let pluginSpriteActive = true;
  let admitted = false;
  replacePluginSpriteWithReaction(
    () => { pluginSpriteActive = false; },
    () => { admitted = !pluginSpriteActive; },
  );
  assert.equal(admitted, true);
});

it("updates loaded documents rather than navigating for appearance changes", () => {
  const applied: string[] = [];
  let navigations = 0;
  for (const change of ["pause", "scale", "motion replacement"]) {
    if (!updateLoadedPetDocument(true, 4, 4, "file:///pet.html", () => applied.push(change))) navigations += 1;
  }
  assert.deepEqual(applied, ["pause", "scale", "motion replacement"]);
  assert.equal(navigations, 0);
  assert.equal(updateLoadedPetDocument(true, 5, 4, "file:///pet.html", () => assert.fail("stale update")), false);
  assert.equal(updateLoadedPetDocument(true, 4, 4, "https://example.com", () => assert.fail("untrusted document")), false);
  assert.equal(updateLoadedPetDocument(false, 4, 4, "file:///pet.html", () => assert.fail("unready document")), false);
});

it("rejects stale content acknowledgements", () => {
  const pending = { token: "2:5", sequence: 5, presentationId: "p", outfitId: "night" };
  const valid = { token: "2:5", presentationId: "p", outfitId: "night" };
  assert.equal(isCurrentPetContentCommit(pending, 5, valid), true);
  assert.equal(isCurrentPetContentCommit(pending, 6, valid), false);
  assert.equal(isCurrentPetContentCommit(pending, 5, { ...valid, token: "2:4" }), false);
  assert.equal(isCurrentPetContentCommit(pending, 5, { ...valid, presentationId: "old" }), false);
  assert.equal(isCurrentPetContentCommit(pending, 5, { ...valid, outfitId: "default" }), false);
  const classic = { ...pending, presentationId: null, outfitId: null };
  assert.equal(isCurrentPetContentCommit(classic, 5, { token: "2:5", presentationId: null, outfitId: null }), true);
  assert.equal(isCurrentPetContentCommit(classic, 5, { token: "2:5" }), false);
});

it("restores the underlying work context after voice clears", () => {
  assert.equal(effectivePetBodyContext("working", "waiting"), "waiting");
  assert.equal(effectivePetBodyContext("working", null), "working");
});

it("invalidates playback after navigation without replaying the event", () => {
  const snapshots: PetBodySnapshot[] = [];
  const commits: string[] = [];
  const state = createPetBodyState((snapshot) => snapshots.push(snapshot), (appearance) => commits.push(appearance.assets.snapshotId));
  setMotion(state, { snapshotId: "one" } as MotionBodyDescriptor);
  state.react("working");
  state.react("success");
  const old = snapshots.at(-1)!.input;
  state.documentLost();
  sendResult(state, snapshots, { epoch: old.epoch, snapshotId: "one", playbackId: 1, outcome: "started", intentId: old.event?.id });
  state.ready();
  assert.notEqual(snapshots.at(-1)!.input.epoch, old.epoch);
  assert.equal(snapshots.at(-1)!.input.context, "working");
  assert.equal(snapshots.at(-1)!.input.event, undefined);
  assert.deepEqual(commits, []);
});

it("does not mint a new event during an appearance or pause refresh", () => {
  const snapshots: PetBodySnapshot[] = [];
  const state = createPetBodyState((snapshot) => snapshots.push(snapshot), () => {});
  const motion = { snapshotId: "one" } as MotionBodyDescriptor;
  setMotion(state, motion);
  state.react("success");
  const event = snapshots.at(-1)!.input.event!;
  setMotion(state, motion);
  state.setPaused(true);
  state.ready();
  assert.equal(snapshots.at(-1)!.input.event?.id, event.id);
});

it("retains context through transient event completion and ignores stale playback", () => {
  const snapshots: PetBodySnapshot[] = [];
  const commits: string[] = [];
  const state = createPetBodyState((snapshot) => snapshots.push(snapshot), (appearance) => commits.push(appearance.assets.snapshotId));
  const motion = { snapshotId: "package-1" } as MotionBodyDescriptor;
  setMotion(state, motion);
  state.react("working");
  state.react("success");
  const event = snapshots.at(-1)!.input.event!;
  const epoch = snapshots.at(-1)!.input.epoch;
  state.react("waiting");
  sendResult(state, snapshots, { epoch, snapshotId: "package-1", playbackId: 3, outcome: "started", intentId: event.id });
  sendResult(state, snapshots, { epoch, snapshotId: "package-1", playbackId: 2, outcome: "completed", intentId: "older-event" });
  assert.equal(snapshots.at(-1)!.input.event?.id, event.id);
  sendResult(state, snapshots, { epoch, snapshotId: "package-1", playbackId: 3, outcome: "completed", intentId: event.id });
  assert.equal(snapshots.at(-1)!.input.context, "waiting");
  assert.equal(snapshots.at(-1)!.input.event, undefined);
  assert.deepEqual(commits, ["package-1"]);
});

it("commits a presented frame after a newer event attempt was declined", () => {
  const snapshots: PetBodySnapshot[] = [];
  const commits: string[] = [];
  const state = createPetBodyState((snapshot) => snapshots.push(snapshot), (appearance) => commits.push(appearance.assets.snapshotId));
  setMotion(state, { snapshotId: "one" } as MotionBodyDescriptor);
  state.react("success");
  const input = snapshots.at(-1)!.input;
  sendResult(state, snapshots, { epoch: input.epoch, snapshotId: "one", playbackId: 2, intentId: input.event!.id, outcome: "cancelled" });
  assert.equal(snapshots.at(-1)!.input.event, undefined);
  sendResult(state, snapshots, { epoch: "old-epoch", snapshotId: "one", playbackId: 1, outcome: "started" });
  sendResult(state, snapshots, { epoch: input.epoch, snapshotId: "old-snapshot", playbackId: 1, outcome: "started" });
  assert.deepEqual(commits, []);
  sendResult(state, snapshots, { epoch: input.epoch, snapshotId: "one", playbackId: 1, outcome: "started" });
  assert.deepEqual(commits, ["one"]);
});

it("does not let a stale package or event clear a newer event", () => {
  const snapshots: PetBodySnapshot[] = [];
  const state = createPetBodyState((snapshot) => snapshots.push(snapshot), () => {});
  setMotion(state, { snapshotId: "one" } as MotionBodyDescriptor);
  state.react("success");
  const old = snapshots.at(-1)!.input.event!;
  state.react("error");
  const current = snapshots.at(-1)!.input;
  setMotion(state, { snapshotId: "two" } as MotionBodyDescriptor);
  state.react("waving");
  const replacement = snapshots.at(-1)!.input.event!;
  sendResult(state, snapshots, { epoch: current.epoch, snapshotId: "one", playbackId: 1, intentId: old.id, outcome: "cancelled" });
  assert.equal(snapshots.at(-1)!.input.event?.id, replacement.id);
  sendResult(state, snapshots, { epoch: current.epoch, snapshotId: "two", playbackId: 2, intentId: replacement.id, outcome: "cancelled" });
  assert.equal(snapshots.at(-1)!.input.event, undefined);
});

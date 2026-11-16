import assert from "node:assert/strict";
import { test } from "node:test";
import { getPetSpriteLayout, getPetSpritePosition } from "../dist/sprite-layout.js";
import { defaultPetSprite, getConfiguredSpriteCacheKey, getConfiguredSpriteStates, getSpriteFrameOffsets, resolveEffectiveSpriteState, resolveReactionSpriteState } from "../dist/animation.js";

test("V1 and V2 retain their atlas and neutral preview behavior", () => {
  const v1 = getPetSpriteLayout({});
  const v2 = getPetSpriteLayout({ spriteVersionNumber: 2 });
  assert.equal(v1.rows, 9);
  assert.equal(v2.rows, 11);
  assert.deepEqual(getPetSpritePosition(v2, defaultPetSprite.states.idle, true), {
    row: 0, startColumn: 6, endColumn: 6, animated: false,
  });
  assert.equal(getPetSpritePosition(v1, defaultPetSprite.states.idle, true).animated, true);
  assert.throws(() => getPetSpriteLayout({ spriteVersionNumber: 1 }));
});

test("reaction overrides and finite badges preserve their playback behavior", () => {
  assert.equal(resolveReactionSpriteState("thinking", { thinking: "waving" }), "waving");
  assert.equal(resolveEffectiveSpriteState(undefined, "success"), "idle");
  assert.equal(resolveEffectiveSpriteState(undefined, "thinking"), "review");
  assert.equal(getConfiguredSpriteStates(2200).waiting.durationMs, 2200);
  assert.equal(defaultPetSprite.states.waiting.durationMs, 1010);
});

test("V1 frame holds preserve the quiet idle cadence and each action's final pose", () => {
  const states = getConfiguredSpriteStates(1010, 1);
  assert.deepEqual(states.idle.frameDurationsMs, [1680, 660, 660, 840, 840, 1920]);
  assert.equal(states.idle.durationMs, 6600);
  const actionHolds = {
    "running-right": [120, 220], "running-left": [120, 220],
    waving: [140, 280], jumping: [140, 280], failed: [140, 240],
    waiting: [150, 260], running: [120, 220], review: [150, 280],
  };
  for (const [name, [movingHold, lastHold]] of Object.entries(actionHolds)) {
    const state = states[name];
    assert.equal(state.durationMs, defaultPetSprite.states[name].durationMs, `${name} keeps its full action duration`);
    assert.deepEqual(state.frameDurationsMs, [...Array(state.frames - 1).fill(movingHold), lastHold]);
    const offsets = getSpriteFrameOffsets(state);
    assert.equal(offsets.length, state.frames, `${name} visits only valid authored frames`);
    assert.equal(offsets[0], 0);
    assert.ok(offsets.at(-1) < 1);
    assert.ok(Math.abs((1 - offsets.at(-1)) * state.durationMs - lastHold) < 0.001, `${name} actually holds the last pose`);
    assert.equal(state.iterations, defaultPetSprite.states[name].iterations, `${name} preserves finite or looping playback`);
  }
  assert.notEqual(getConfiguredSpriteCacheKey(1010, 1), getConfiguredSpriteCacheKey(1010, 2));
});

test("relaxed V1 waiting scales frame boundaries without flattening the final hold", () => {
  const normal = getConfiguredSpriteStates(1010, 1).waiting;
  const relaxed = getConfiguredSpriteStates(2200, 1).waiting;
  assert.equal(relaxed.durationMs, 2200);
  assert.equal(relaxed.frameDurationsMs.reduce((sum, duration) => sum + duration, 0), 2200);
  const originalOffsets = getSpriteFrameOffsets(normal);
  const scaledOffsets = getSpriteFrameOffsets(relaxed);
  for (let index = 0; index < normal.frames; index += 1) {
    assert.ok(Math.abs(scaledOffsets[index] - originalOffsets[index]) * 2200 <= 0.5, "scaled boundaries stay within integer-millisecond rounding");
  }
  assert.ok(relaxed.frameDurationsMs.at(-1) > relaxed.frameDurationsMs[0], "relaxing waiting preserves its longer final pose");
});

test("V2 keeps its existing uniform contract and neutral preview", () => {
  const states = getConfiguredSpriteStates(1010, 2);
  assert.equal(states.idle.durationMs, 5500);
  assert.equal(states.idle.frameDurationsMs, undefined);
  assert.deepEqual(getSpriteFrameOffsets(states.idle), [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6]);
  assert.deepEqual(getConfiguredSpriteStates(), states);
  assert.equal(getPetSpritePosition(getPetSpriteLayout({ spriteVersionNumber: 2 }), states.idle, true).animated, false);
});

test("invalid frame-hold definitions cannot produce a partial or out-of-range timeline", () => {
  for (const frameDurationsMs of [[100], [100, -100], [100, Number.NaN], [100, 150]]) {
    assert.throws(() => getSpriteFrameOffsets({ frames: 2, durationMs: 200, frameDurationsMs }));
  }
});

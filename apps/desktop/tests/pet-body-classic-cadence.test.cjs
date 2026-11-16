const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPetBodyCoordinator, createClassicBusyReadiness } = require('../src/pet-body-coordinator.cjs');

function fixture(options = {}) {
  let now = 0;
  let revision = 0;
  let row = 'idle';
  let rest = false;
  let mounts = 0;
  let input = { epoch: 'epoch', revision, context: 'idle', paused: false, suspended: false };
  const timers = new Map();
  const history = [];
  const events = [];
  const gestures = [];
  const results = [];
  const coordinator = createPetBodyCoordinator({
    player: { stop() {}, clear() {}, mount() { mounts++; }, dispose() {} },
    now: () => now,
    random: () => 0,
    setTimeout(callback, delay) {
      const timer = { callback, at: now + delay };
      timers.set(timer, timer);
      return timer;
    },
    clearTimeout: timer => timers.delete(timer),
    canPresentClassicBusy: state => row === state,
    // Deliberately permissive: semantic busy must independently block idle
    // offers, even if another presentation adapter reports visual idle.
    canPlayClassicIdle: () => true,
    onClassicRest(value) { rest = value; history.push(value); },
    onClassicEvent: event => events.push(event),
    onClassicIdleVariation: state => gestures.push(state),
    onResult: result => results.push(result),
    onActivityResult: result => results.push(result),
    ...options,
  });
  function update(patch = {}, motion = null) {
    input = { ...input, ...patch, revision: ++revision };
    coordinator.update({ input, motion });
  }
  update();
  return {
    coordinator, history, events, gestures, results, update,
    get rest() { return rest; },
    get input() { return input; },
    get timerCount() { return timers.size; },
    get mounts() { return mounts; },
    present(state) { row = state; coordinator.refresh(); },
    busy(reaction, spriteState, cycleDurationMs) {
      row = spriteState;
      update({ context: reaction, classic: { reaction, spriteState, cycleDurationMs }, event: undefined });
    },
    advance(ms) {
      const until = now + ms;
      while (true) {
        const next = [...timers.values()].filter(timer => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        timers.delete(next);
        next.callback();
      }
      now = until;
    },
  };
}

function pendingAnimation() {
  let resolve;
  const animation = {
    animationName: 'pet-frames-review', pending: true, startTime: null, playState: 'running',
    ready: new Promise(done => { resolve = done; }),
  };
  return {
    animation,
    start() {
      animation.pending = false;
      animation.startTime = 1000;
      resolve();
    },
  };
}

test('pending CSS keeps busy admission closed but consumes no budget until its clock is ready', async () => {
  const pending = pendingAnimation();
  const sprite = { hasAttribute: () => false, getAnimations: () => [pending.animation] };
  let coordinator;
  const isClassicBusyReady = createClassicBusyReadiness(() => sprite, () => coordinator.refresh());
  const f = fixture({ isClassicBusyReady });
  coordinator = f.coordinator;
  f.busy('thinking', 'review', 1030);
  f.update();
  f.coordinator.refresh();
  f.advance(10_000);
  assert.equal(f.timerCount, 0, 'a DOM row alone cannot start accounting before its CSS clock');
  assert.equal(f.rest, false);
  assert.equal(f.coordinator.offerClassicIdleVariation(), false);
  f.coordinator.setClassicHover(true);
  assert.deepEqual(f.gestures, []);
  assert.equal(f.coordinator.startActivity({ kind: 'play', format: 'classic', generation: 1,
    activityId: 'idle', imageUrl: 'data:image/webp;base64,AA==', frameCount: 4, fps: 4, scale: 1 }), false);
  pending.start();
  await Promise.resolve();
  assert.equal(f.timerCount, 1, 'the existing single timer begins after readiness');
  f.advance(3089);
  assert.equal(f.rest, false);
  f.advance(1);
  assert.equal(f.rest, true, 'CSS readiness receives the complete three-cycle budget');
  f.coordinator.dispose();
});

test('a reused CSS animation can await a new resume-ready promise without losing remaining time', async () => {
  const pending = pendingAnimation();
  const sprite = { hasAttribute: () => false, getAnimations: () => [pending.animation] };
  let coordinator;
  const isClassicBusyReady = createClassicBusyReadiness(() => sprite, () => coordinator.refresh());
  const f = fixture({ isClassicBusyReady });
  coordinator = f.coordinator;
  f.busy('thinking', 'review', 1030);
  pending.start();
  await Promise.resolve();
  f.advance(1000);
  f.update({ paused: true });
  const resumed = pendingAnimation();
  pending.animation.pending = true;
  pending.animation.startTime = null;
  pending.animation.ready = resumed.animation.ready;
  f.update({ paused: false });
  f.coordinator.refresh();
  f.advance(10_000);
  assert.equal(f.timerCount, 0);
  pending.animation.pending = false;
  pending.animation.startTime = 12000;
  resumed.start();
  await Promise.resolve();
  f.advance(2089);
  assert.equal(f.rest, false);
  f.advance(1);
  assert.equal(f.rest, true, 'resume readiness preserves the previously consumed eligible time');
  f.coordinator.dispose();
});

test('late animation readiness after disposal cannot mount or arm an abandoned body', async () => {
  const pending = pendingAnimation();
  const sprite = { hasAttribute: () => false, getAnimations: () => [pending.animation] };
  let coordinator;
  const isClassicBusyReady = createClassicBusyReadiness(() => sprite, () => coordinator.refresh());
  const f = fixture({ isClassicBusyReady });
  coordinator = f.coordinator;
  f.busy('thinking', 'review', 1030);
  f.coordinator.dispose();
  const mounts = f.mounts;
  pending.start();
  await Promise.resolve();
  f.advance(10_000);
  assert.equal(f.mounts, mounts);
  assert.equal(f.timerCount, 0);
  assert.equal(f.rest, false);
});

test('Classic busy rows rest after three configured cycles without changing semantic intent', () => {
  for (const [reaction, state, duration] of [
    ['thinking', 'review', 1030], ['editing', 'running', 820],
    ['testing', 'waiting', 1010], ['waiting', 'waiting', 2200],
  ]) {
    const f = fixture();
    f.busy(reaction, state, duration);
    f.advance(duration * 3 - 1);
    assert.equal(f.rest, false);
    f.advance(1);
    assert.equal(f.rest, true);
    assert.equal(f.input.context, reaction, 'visual rest never sends a false idle reaction');
    assert.equal(f.input.classic.spriteState, state);
    assert.deepEqual(f.results, []);
    assert.equal(f.coordinator.offerClassicIdleVariation(), false);
    f.coordinator.setClassicHover(true);
    assert.equal(f.coordinator.startActivity({ kind: 'play', format: 'classic', generation: 1,
      activityId: 'idle', imageUrl: 'data:image/webp;base64,AA==', frameCount: 4, fps: 4, scale: 1 }), false);
    f.coordinator.dispose();
  }
});

test('same busy heartbeats and HUD/content refreshes retain both running and settled budgets', () => {
  const f = fixture();
  f.busy('thinking', 'review', 1030);
  f.advance(2000);
  f.update();
  f.busy('thinking', 'review', 1030);
  f.coordinator.refresh();
  f.advance(1090);
  assert.equal(f.rest, true, 'same-state updates cannot grant another three cycles');
  for (let i = 0; i < 10; i++) {
    f.update();
    f.busy('thinking', 'review', 1030);
    f.coordinator.refresh();
    f.advance(10_000);
  }
  assert.deepEqual(f.history, [true], 'a settled state stays at idle through HUD and long-task refreshes');
  assert.equal(f.timerCount, 0);
  f.coordinator.dispose();
});

test('only a new effective row or configured duration rearms the three-cycle budget', () => {
  const f = fixture();
  f.busy('working', 'running', 820);
  f.advance(2460);
  assert.equal(f.rest, true);
  f.busy('editing', 'running', 820);
  assert.equal(f.rest, true, 'a raw semantic change sharing the same row retains settled rest');
  f.busy('working', 'running', 820);
  assert.equal(f.rest, true, 'editing to working updates status without restarting the same row');
  f.busy('thinking', 'review', 1030);
  assert.equal(f.rest, false);
  f.advance(460);
  assert.equal(f.rest, false, 'the old running timeout cannot settle the new state');
  f.advance(2630);
  assert.equal(f.rest, true);
  f.busy('thinking', 'waiting', 1010);
  f.advance(3030);
  assert.equal(f.rest, true);
  f.busy('thinking', 'waiting', 2200);
  f.advance(6599);
  assert.equal(f.rest, false);
  f.advance(1);
  assert.equal(f.rest, true);
  f.update({ context: 'idle', classic: { reaction: 'idle', spriteState: 'idle', cycleDurationMs: 6600 } });
  f.busy('thinking', 'waiting', 2200);
  assert.equal(f.rest, false, 'returning from genuine idle grants a new busy budget');
  f.advance(6600);
  assert.equal(f.rest, true);
  f.coordinator.dispose();
});

test('body intent waits for the actual Classic content and visual expiry does not fake busy idle', () => {
  const f = fixture();
  f.update({ context: 'testing', classic: { reaction: 'testing', spriteState: 'waiting', cycleDurationMs: 1010 } });
  f.advance(10_000);
  assert.equal(f.timerCount, 0, 'body IPC can arrive before the matching content document');
  f.present('waiting');
  f.advance(1000);
  f.present('idle');
  f.advance(10_000);
  assert.equal(f.rest, false);
  assert.equal(f.coordinator.offerClassicIdleVariation(), true, 'an expired actual reaction can use normal quiet idle');
  f.present('waiting');
  assert.deepEqual(f.gestures, ['waving', null], 'matching busy content cancels an old quiet gesture');
  f.advance(2030);
  assert.equal(f.rest, true, 'returning same-state content retains its remaining budget');
  f.coordinator.dispose();
});

test('pause, reduced motion, manipulation and plugin ownership freeze rather than reset the budget', () => {
  for (const [block, release] of [
    [f => f.update({ paused: true }), f => f.update({ paused: false })],
    [f => f.coordinator.setReducedMotion(true), f => f.coordinator.setReducedMotion(false)],
    [f => f.coordinator.setDragDirection('run-left'), f => f.coordinator.setDragDirection(null)],
    [f => f.coordinator.setMotionState('run-right'), f => f.coordinator.setMotionState('idle')],
    [f => f.coordinator.setPlugin(true), f => f.coordinator.setPlugin(false)],
  ]) {
    const f = fixture();
    f.busy('editing', 'running', 820);
    f.advance(1000);
    block(f);
    f.advance(10_000);
    assert.equal(f.rest, false);
    assert.equal(f.timerCount, 0);
    release(f);
    f.advance(1459);
    assert.equal(f.rest, false);
    f.advance(1);
    assert.equal(f.rest, true, 'resume consumes only the remaining budget');
    block(f);
    assert.equal(f.rest, false, 'higher-priority presentation can take over settled rest');
    release(f);
    assert.equal(f.rest, true, 'release does not replay a settled busy state');
    f.coordinator.dispose();
  }
});

test('finite reactions and finite/idle overrides keep their authored playback contract', () => {
  const f = fixture();
  f.busy('thinking', 'review', 1030);
  f.advance(3090);
  const event = { id: 'complete', reaction: 'success', classicSpriteState: 'jumping' };
  f.update({ classic: { reaction: 'success', spriteState: 'jumping', cycleDurationMs: 840 }, event });
  assert.equal(f.rest, false);
  assert.deepEqual(f.events, [event]);
  f.advance(100_000);
  assert.equal(f.rest, false);
  f.busy('thinking', 'jumping', 840);
  f.advance(100_000);
  assert.equal(f.timerCount, 0);
  f.busy('thinking', 'idle', 6600);
  f.advance(100_000);
  assert.equal(f.rest, false);
  f.update({ classic: { reaction: 'success', spriteState: 'review', cycleDurationMs: 1030 } });
  f.advance(100_000);
  assert.equal(f.timerCount, 0, 'terminal reactions mapped to looping rows are not treated as busy work');
  f.coordinator.dispose();
});

test('epoch replacement, suspension and disposal invalidate old Classic timeouts', () => {
  const f = fixture();
  f.busy('working', 'running', 820);
  f.advance(2000);
  f.update({ epoch: 'new-document', suspended: true });
  f.advance(20_000);
  assert.equal(f.rest, false);
  f.update({ suspended: false });
  f.advance(2459);
  assert.equal(f.rest, false, 'a replacement document has a new bounded playback lifecycle');
  f.advance(1);
  assert.equal(f.rest, true);
  f.update({ epoch: 'third-document' });
  assert.equal(f.rest, false);
  f.coordinator.dispose();
  f.advance(20_000);
  assert.equal(f.rest, false);
  assert.equal(f.timerCount, 0);
});

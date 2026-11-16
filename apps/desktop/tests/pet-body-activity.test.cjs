const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPetBodyCoordinator, restartClassicFiniteAnimation } = require('../src/pet-body-coordinator.cjs');

function fixture(classic = false) {
  let now = 0;
  let random = 0;
  let classicIdleAllowed = classic;
  let nextTimer = 0;
  const timers = new Map();
  const idleGestures = [];
  const classicEvents = [];
  const calls = [];
  const bodyResults = [];
  const activityResults = [];
  const visibility = [];
  const external = [];
  const stops = [];
  const player = {
    play(appearance, clip, callbacks) { calls.push({ appearance, clip, callbacks }); },
    stop() {}, clear() {}, setPaused() {}, remaining: () => 1000, mount() {}, hitTest: () => true, dispose() {},
  };
  const coordinator = createPetBodyCoordinator({
    player, now: () => now, random: () => random, onResult: result => bodyResults.push(result),
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    canPlayClassicIdle: () => classicIdleAllowed,
    onClassicIdleVariation: state => idleGestures.push(state),
    onClassicEvent: event => classicEvents.push(event),
    onActivityResult: result => activityResults.push(result),
    playExternalActivity: (command, callback) => external.push({ command, callback }),
    stopExternalActivity: generation => stops.push(generation),
    onVisibility: state => visibility.push(state),
    getBindings: metadata => metadata.bindings,
  });
  const appearance = {
    presentationId: 'presentation', outfitId: 'default', reason: 'initial',
    assets: { snapshotId: 'snapshot', metadata: {
      animations: { idle: { play: 'loop', loop: 'idle' }, alternate: { play: 'loop', loop: 'alternate' }, wave: { play: 'once', intro: 'intro', clip: 'wave', outro: 'outro' }, run: { play: 'loop', loop: 'run' }, work: { play: 'loop', loop: 'work' } },
      bindings: { idle: [{ animation: 'idle' }, { animation: 'alternate' }], contexts: { working: [{ animation: 'work' }] }, movement: { left: 'run', right: 'run' }, events: {} }, clips: {},
      activities: [{ id: 'test', outfitId: 'default', animation: 'wave' }],
    }, verifiedClips: {} },
  };
  const input = { epoch: 'epoch', revision: 1, context: 'idle', paused: false, suspended: false };
  coordinator.update({ input, motion: classic ? null : appearance });
  if (!classic) calls.at(-1).callbacks.onStarted();
  const target = { epoch: 'epoch', snapshotId: 'snapshot', presentationId: 'presentation', outfitId: 'default' };
  const motion = generation => ({ kind: 'play', format: 'motion', generation, activityId: 'test', target, animation: 'wave' });
  const strip = generation => ({ kind: 'play', format: 'classic', generation, activityId: 'test', imageUrl: 'data:image/webp;base64,AA==', frameCount: 4, fps: 4, scale: 1 });
  const update = (revision, overrides = {}, nextAppearance = classic ? null : appearance) => coordinator.update({ input: { ...input, revision, ...overrides }, motion: nextAppearance });
  return {
    coordinator, calls, bodyResults, activityResults, visibility, external, stops, motion, strip, update, appearance, idleGestures, classicEvents,
    setClassicIdleAllowed(value) { classicIdleAllowed = value; },
    setRandom(value) { random = value; },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now && timers.delete(id)) timer.callback();
      }
    },
  };
}

test('Classic replays each new finite semantic event while snapshots and HUD refreshes retain its phase', () => {
  const f = fixture(true);
  const first = { id: 'first', reaction: 'success', classicSpriteState: 'jumping' };
  f.update(2, { event: first });
  f.update(3, { event: first });
  f.coordinator.refresh();
  assert.deepEqual(f.classicEvents, [first]);
  const second = { ...first, id: 'second' };
  f.update(4, { event: second });
  f.update(4, { event: { ...second, id: 'stale-revision' } });
  assert.deepEqual(f.classicEvents, [first, second]);
  const overridden = { id: 'thinking-finite', reaction: 'thinking', classicSpriteState: 'jumping' };
  f.update(5, { context: 'thinking', event: overridden });
  assert.equal(f.classicEvents.at(-1), overridden);
  f.update(6, { event: { id: 'loop', reaction: 'success', classicSpriteState: 'review' } });
  assert.equal(f.classicEvents.length, 3);
  f.coordinator.dispose();
});

test('Classic finite events obey pause, visibility, interaction and renderer lifecycle guards', () => {
  for (const blocker of ['pause', 'suspend', 'reduced', 'drag', 'movement', 'plugin', 'disposed']) {
    const f = fixture(true);
    if (blocker === 'reduced') f.coordinator.setReducedMotion(true);
    if (blocker === 'drag') f.coordinator.setDragDirection('run-left');
    if (blocker === 'movement') f.coordinator.setMotionState('run-right');
    if (blocker === 'plugin') f.coordinator.setPlugin(true);
    if (blocker === 'disposed') f.coordinator.dispose();
    const event = { id: `blocked-${blocker}`, reaction: 'waving', classicSpriteState: 'waving' };
    f.update(2, { paused: blocker === 'pause', suspended: blocker === 'suspend', event });
    assert.deepEqual(f.classicEvents, [], `${blocker} blocks replay`);
    f.coordinator.setReducedMotion(false);
    f.coordinator.setDragDirection(null);
    f.coordinator.setMotionState('idle');
    f.coordinator.setPlugin(false);
    f.update(3, { event });
    assert.deepEqual(f.classicEvents, [], 'unblocking cannot replay an already observed event');
    if (blocker !== 'disposed') {
      f.update(4, { event: { ...event, id: `fresh-${blocker}` } });
      assert.equal(f.classicEvents.length, 1);
    }
    f.coordinator.dispose();
  }
});

test('Classic WebAnimations replay targets only a matching finite unpaused sprite clock', () => {
  const animation = (animationName, iterations, playState = 'running') => ({
    animationName, currentTime: 1200, playState, plays: 0,
    effect: { getTiming: () => ({ iterations }) },
    play() { this.plays += 1; },
  });
  const loop = animation('pet-frames-review', Infinity);
  const bubble = animation('bubble-in', 1);
  const finite = animation('pet-frames-jumping', 2, 'finished');
  const sprite = { getAnimations: () => [loop, bubble, finite] };
  assert.equal(restartClassicFiniteAnimation(sprite, 'review'), false);
  assert.equal(restartClassicFiniteAnimation(sprite, 'waving'), false);
  assert.equal(restartClassicFiniteAnimation(sprite, 'jumping'), true);
  assert.equal(finite.currentTime, 0);
  assert.equal(finite.plays, 1);
  assert.equal(loop.currentTime, 1200);
  assert.equal(bubble.currentTime, 1200);
  finite.currentTime = 900;
  finite.playState = 'paused';
  assert.equal(restartClassicFiniteAnimation(sprite, 'jumping'), false);
  assert.equal(finite.currentTime, 900);
});

test('a finished finite CSS animation can replay without selecting a looping or unrelated rule', () => {
  const declarations = new Map([['animation-name', 'pet-frames-jumping']]);
  const writes = [];
  let flushes = 0;
  const computed = { animationName: 'pet-frames-jumping', animationIterationCount: '2', animationPlayState: 'running' };
  const sprite = {
    getAnimations() { flushes += 1; return []; },
    ownerDocument: { defaultView: { getComputedStyle: () => computed } },
    style: {
      getPropertyValue: name => declarations.get(name) || '',
      getPropertyPriority: () => 'important',
      setProperty(name, value, priority = '') { declarations.set(name, value); writes.push({ name, value, priority }); },
      removeProperty(name) { declarations.delete(name); },
    },
  };
  assert.equal(restartClassicFiniteAnimation(sprite, 'jumping'), true);
  assert.equal(flushes, 2, 'the none state is flushed before the existing CSS rule is restored');
  assert.equal(declarations.get('animation-name'), 'pet-frames-jumping');
  assert.equal(writes.at(-1).priority, 'important');
  const afterFinite = writes.length;
  computed.animationIterationCount = 'infinite';
  assert.equal(restartClassicFiniteAnimation(sprite, 'jumping'), false);
  computed.animationIterationCount = '2';
  computed.animationPlayState = 'paused';
  assert.equal(restartClassicFiniteAnimation(sprite, 'jumping'), false);
  computed.animationPlayState = 'running';
  assert.equal(restartClassicFiniteAnimation(sprite, 'waving'), false);
  assert.equal(writes.length, afterFinite);
});

test('V1 idle waves and short jumps finish without emitting semantic or activity results', () => {
  const f = fixture(true);
  assert.equal(f.coordinator.offerClassicIdleVariation(), true);
  assert.deepEqual(f.idleGestures, ['waving']);
  assert.equal(f.coordinator.offerClassicIdleVariation(), false);
  f.advance(1399);
  assert.deepEqual(f.idleGestures, ['waving']);
  f.advance(1);
  assert.deepEqual(f.idleGestures, ['waving', null]);
  f.setRandom(0.99);
  assert.equal(f.coordinator.offerClassicIdleVariation(), true);
  assert.deepEqual(f.idleGestures, ['waving', null, 'jumping']);
  f.advance(1680);
  assert.equal(f.idleGestures.at(-1), null);
  assert.deepEqual(f.bodyResults, []);
  assert.deepEqual(f.activityResults, []);
  assert.deepEqual(f.external, []);
  f.coordinator.dispose();
});

test('V1 idle hover jumps once per entry and leaving cancels only the hover-owned gesture', () => {
  const f = fixture(true);
  f.coordinator.setClassicHover(true, false);
  assert.deepEqual(f.idleGestures, [], 'a transparent frame corner cannot start hover feedback');
  f.coordinator.setClassicHover(true);
  assert.deepEqual(f.idleGestures, ['jumping']);
  f.coordinator.setClassicHover(true);
  f.coordinator.setClassicHover(true, false);
  f.update(2);
  f.coordinator.refresh();
  assert.deepEqual(f.idleGestures, ['jumping'], 'changing frame alpha, child mouseover and HUD updates do not retrigger hover');
  f.advance(1680);
  f.coordinator.setClassicHover(true);
  assert.deepEqual(f.idleGestures, ['jumping', null], 'staying hovered does not loop the finite gesture');
  f.coordinator.setClassicHover(false);
  assert.equal(f.coordinator.offerClassicIdleVariation(), true);
  f.coordinator.setClassicHover(true);
  f.coordinator.setClassicHover(false);
  assert.deepEqual(f.idleGestures, ['jumping', null, 'waving'], 'leaving hover preserves a naturally scheduled quiet gesture');
  f.advance(1400);
  f.coordinator.setClassicHover(true);
  assert.equal(f.idleGestures.at(-1), 'jumping');
  f.advance(100);
  f.coordinator.setClassicHover(false);
  assert.equal(f.idleGestures.at(-1), null);
  f.advance(2000);
  assert.deepEqual(f.bodyResults, []);
  assert.deepEqual(f.activityResults, []);
  f.coordinator.dispose();
});

test('a stationary body press preserves the admitted hover gesture and its original completion time', () => {
  const f = fixture(true);
  f.coordinator.setClassicHover(true);
  f.advance(400);
  // Body left-press and a delayed host quiet-stop both release only the
  // host's quiet gesture, not the renderer's currently admitted hover.
  f.coordinator.cancelIdleVariation('quiet');
  f.coordinator.setClassicHover(true, false);
  f.update(2);
  f.coordinator.refresh();
  assert.deepEqual(f.idleGestures, ['jumping'], 'press/jitter within the stable body frame must not switch to idle');
  f.advance(1279);
  assert.deepEqual(f.idleGestures, ['jumping']);
  f.advance(1);
  assert.deepEqual(f.idleGestures, ['jumping', null], 'the original finite gesture completes without restarting');
  f.coordinator.dispose();
});

test('press preservation still cancels quiet gestures and yields hover to real manipulation or terminal intent', () => {
  const quiet = fixture(true);
  quiet.coordinator.offerClassicIdleVariation();
  quiet.coordinator.cancelIdleVariation('quiet');
  assert.deepEqual(quiet.idleGestures, ['waving', null]);
  quiet.coordinator.dispose();
  for (const interrupt of [
    f => f.coordinator.setDragDirection('run-right'),
    f => f.coordinator.setMotionState('run-left'),
    f => f.update(2, { event: { id: 'complete', reaction: 'success', classicSpriteState: 'jumping' } }),
    f => f.coordinator.cancelIdleVariation(), // right/contextmenu or a panel/control press
    f => f.coordinator.setClassicHover(false),
  ]) {
    const f = fixture(true);
    f.coordinator.setClassicHover(true);
    f.coordinator.cancelIdleVariation('quiet');
    interrupt(f);
    assert.deepEqual(f.idleGestures, ['jumping', null]);
    f.advance(10_000);
    assert.deepEqual(f.idleGestures, ['jumping', null], 'cancelled hover cannot resume from its old timer');
    f.coordinator.dispose();
  }
});

test('V1 hover feedback yields to busy rendering, direct manipulation and lifecycle gates', () => {
  for (const interrupt of [
    f => { f.setClassicIdleAllowed(false); f.update(2, { context: 'working' }); },
    f => f.coordinator.setDragDirection('run-left'),
    f => f.coordinator.setMotionState('run-right'),
    f => f.coordinator.setPlugin(true),
    f => f.update(2, { paused: true }),
    f => f.update(2, { suspended: true }),
    f => f.coordinator.setReducedMotion(true),
    f => f.coordinator.dispose(),
  ]) {
    const f = fixture(true);
    f.coordinator.setClassicHover(true);
    interrupt(f);
    assert.deepEqual(f.idleGestures, ['jumping', null]);
    f.coordinator.setClassicHover(false);
    f.coordinator.setClassicHover(true);
    assert.deepEqual(f.idleGestures, ['jumping', null], 'blocked hover cannot override the current owner');
    f.coordinator.dispose();
  }
  const motion = fixture();
  motion.coordinator.setClassicHover(true);
  assert.deepEqual(motion.idleGestures, []);
  motion.coordinator.dispose();
});

test('V1 idle gestures yield immediately to interaction, live intent and lifecycle changes', () => {
  for (const interrupt of [
    f => f.update(2, { context: 'working' }),
    f => f.update(2, { event: { id: 'success', reaction: 'success' } }),
    f => f.coordinator.setDragDirection('run-left'),
    f => f.coordinator.setMotionState('run-right'),
    f => f.coordinator.setPlugin(true),
    f => f.update(2, { paused: true }),
    f => f.update(2, { suspended: true }),
    f => f.update(2, { epoch: 'new-window' }),
    f => f.update(2, {}, f.appearance),
    f => f.coordinator.setReducedMotion(true),
    f => f.coordinator.cancelIdleVariation(),
    f => f.coordinator.dispose(),
  ]) {
    const f = fixture(true);
    assert.equal(f.coordinator.offerClassicIdleVariation(), true);
    interrupt(f);
    assert.deepEqual(f.idleGestures, ['waving', null]);
    f.advance(10_000);
    assert.deepEqual(f.idleGestures, ['waving', null], 'cancelled timers cannot clear a later body state');
    f.coordinator.dispose();
  }
});

test('a cancelled gesture timer cannot clear a later cosmetic animation', () => {
  const f = fixture(true);
  f.coordinator.offerClassicIdleVariation();
  f.advance(700);
  f.coordinator.cancelIdleVariation();
  f.setRandom(0.99);
  f.coordinator.offerClassicIdleVariation();
  f.advance(700);
  assert.deepEqual(f.idleGestures, ['waving', null, 'jumping']);
  f.advance(980);
  assert.deepEqual(f.idleGestures, ['waving', null, 'jumping', null]);
  f.coordinator.dispose();
});

test('V1 current presentation gates cosmetic playback while stale Classic context does not', () => {
  const f = fixture(true);
  f.update(2, { context: 'working' });
  f.setClassicIdleAllowed(false);
  assert.equal(f.coordinator.offerClassicIdleVariation(), false, 'busy or V2 artwork never plays V1 gestures');
  f.setClassicIdleAllowed(true);
  assert.equal(f.coordinator.offerClassicIdleVariation(), true, 'expired Classic display may be idle with retained body context');
  f.update(3, { context: 'working' });
  assert.deepEqual(f.idleGestures, ['waving'], 'a HUD-only update does not restart or cancel a gesture');
  f.coordinator.cancelIdleVariation();
  f.coordinator.setReducedMotion(true);
  assert.equal(f.coordinator.offerClassicIdleVariation(), false);
  f.coordinator.dispose();
  assert.equal(f.coordinator.offerClassicIdleVariation(), false);
});

test('native Classic activities preempt cosmetic gestures and Motion keeps its own idle variation', () => {
  const classic = fixture(true);
  classic.coordinator.offerClassicIdleVariation();
  assert.equal(classic.coordinator.startActivity(classic.strip(1)), true);
  assert.deepEqual(classic.idleGestures, ['waving', null]);
  assert.equal(classic.coordinator.offerClassicIdleVariation(), false);
  classic.external[0].callback('started');
  classic.external[0].callback('completed');
  assert.equal(classic.coordinator.offerClassicIdleVariation(), true);
  classic.coordinator.dispose();
  const motion = fixture();
  assert.equal(motion.coordinator.offerClassicIdleVariation(), false);
  assert.equal(motion.coordinator.offerVariation(), true);
  motion.calls.at(-1).callbacks.onEnd();
  assert.equal(motion.calls.at(-1).clip, 'alternate');
  assert.deepEqual(motion.idleGestures, []);
  motion.coordinator.dispose();
});

test('motion reports first frame and completes only after all finite phases', () => {
  const f = fixture(); const initial = f.bodyResults.length;
  assert.equal(f.coordinator.startActivity(f.motion(1)), true);
  assert.equal(f.calls.at(-1).clip, 'intro'); assert.deepEqual(f.activityResults, []);
  f.calls.at(-1).callbacks.onStarted();
  assert.equal(f.activityResults.at(-1).outcome, 'started');
  f.calls.at(-1).callbacks.onEnd(); assert.equal(f.calls.at(-1).clip, 'wave');
  f.calls.at(-1).callbacks.onStarted(); f.calls.at(-1).callbacks.onEnd(); assert.equal(f.calls.at(-1).clip, 'outro');
  f.calls.at(-1).callbacks.onStarted(); assert.equal(f.activityResults.length, 1);
  f.calls.at(-1).callbacks.onEnd(); assert.deepEqual(f.activityResults.map(x => x.outcome), ['started', 'completed']);
  assert.deepEqual(f.activityResults[1], { format: 'motion', generation: 1, activityId: 'test', target: f.motion(1).target, outcome: 'completed' });
  assert.equal(f.bodyResults.slice(initial).some(x => x.presentationId === 'presentation' && x.outcome === 'completed'), false);
  assert.equal(f.visibility.some(x => x.activity === 'motion'), true);
  f.coordinator.dispose();
});

test('new scheduled appearance cancels before candidate starts; late callbacks ignored', () => {
  const f = fixture(); f.coordinator.startActivity(f.motion(1)); const callbacks = f.calls.at(-1).callbacks;
  callbacks.onStarted(); const replacement = { ...f.appearance, presentationId: 'new', reason: 'scheduled' };
  f.update(2, {}, replacement); callbacks.onEnd(); callbacks.onFailed(new Error('late'));
  assert.deepEqual(f.activityResults.map(x => x.outcome), ['started', 'cancelled']);
  assert.equal(f.bodyResults.some(x => x.presentationId === 'new' && x.outcome === 'deferred'), true);
  f.coordinator.dispose();
});

test('failed appearance refresh preserves retained activity; fresh retry cancels it before commit', () => {
  const f = fixture();
  const failed = { ...f.appearance, presentationId: 'failed', reason: 'manual' };
  f.update(2, {}, failed);
  assert.equal(f.calls.at(-1).appearance.presentationId, 'failed');
  f.calls.at(-1).callbacks.onFailed(new Error('decode'));
  assert.equal(f.bodyResults.at(-1).outcome, 'failed');

  assert.equal(f.coordinator.startActivity(f.motion(1)), true);
  f.calls.at(-1).callbacks.onStarted();
  const callsBeforeRefresh = f.calls.length;
  const bodyResultsBeforeRefresh = f.bodyResults.length;
  f.update(3, {}, failed);
  assert.equal(f.calls.length, callsBeforeRefresh);
  assert.equal(f.bodyResults.length, bodyResultsBeforeRefresh);
  assert.deepEqual(f.activityResults.map(x => [x.generation, x.outcome]), [[1, 'started']]);

  f.calls.at(-1).callbacks.onEnd();
  assert.equal(f.calls.at(-1).clip, 'wave');
  f.calls.at(-1).callbacks.onStarted();
  f.calls.at(-1).callbacks.onEnd();
  assert.equal(f.calls.at(-1).clip, 'outro');
  f.calls.at(-1).callbacks.onStarted();
  f.calls.at(-1).callbacks.onEnd();
  assert.deepEqual(f.activityResults.map(x => [x.generation, x.outcome]), [[1, 'started'], [1, 'completed']]);

  assert.equal(f.coordinator.startActivity(f.motion(2)), true);
  f.calls.at(-1).callbacks.onStarted();
  const retry = { ...failed, presentationId: 'retry' };
  f.update(4, {}, retry);
  assert.deepEqual(f.activityResults.map(x => [x.generation, x.outcome]), [[1, 'started'], [1, 'completed'], [2, 'started'], [2, 'cancelled']]);
  assert.equal(f.calls.at(-1).appearance.presentationId, 'retry');
  assert.equal(f.bodyResults.some(x => x.presentationId === 'retry' && x.outcome === 'started'), false);
  f.calls.at(-1).callbacks.onStarted();
  assert.equal(f.bodyResults.at(-1).presentationId, 'retry');
  assert.equal(f.bodyResults.at(-1).outcome, 'started');
  f.coordinator.dispose();
});

test('wrong target and cancelled generations cannot start', () => {
  const f = fixture(); f.coordinator.cancelActivity(2);
  assert.equal(f.coordinator.startActivity(f.motion(2)), false);
  assert.equal(f.coordinator.startActivity({ ...f.motion(3), target: { ...f.motion(3).target, outfitId: 'wrong' } }), false);
  assert.deepEqual(f.activityResults.map(x => x.outcome), ['cancelled']);
  assert.equal(f.coordinator.startActivity(f.motion(4)), true); f.coordinator.cancelActivity(4);
  f.calls.at(-2).callbacks.onStarted();
  assert.deepEqual(f.activityResults.map(x => x.outcome), ['cancelled', 'cancelled']);
  f.coordinator.dispose();
});

test('motion activity identity must resolve to the requested outfit animation', () => {
  const f = fixture();
  f.appearance.assets.metadata.animations.other = { play: 'once', clip: 'wave' };
  assert.equal(f.coordinator.startActivity({ ...f.motion(1), activityId: 'missing' }), false);
  assert.equal(f.coordinator.startActivity({ ...f.motion(2), animation: 'other' }), false);
  assert.deepEqual(f.activityResults.map(x => x.outcome), ['cancelled', 'cancelled']);
  assert.equal(f.coordinator.startActivity(f.motion(3)), true);
  f.coordinator.dispose();
});

test('motion activity uses exact outfit variant without default fallback', () => {
  const f = fixture();
  f.appearance.assets.metadata.activities[0].outfitVariants = [{ outfitId: 'coat', animation: 'coatWave' }];
  f.appearance.assets.metadata.animations.coatWave = { play: 'once', clip: 'wave' };
  const coat = { ...f.appearance, outfitId: 'coat', presentationId: 'coat-presentation' };
  f.update(2, {}, coat); f.calls.at(-1).callbacks.onStarted();
  const target = { ...f.motion(1).target, outfitId: 'coat', presentationId: 'coat-presentation' };
  assert.equal(f.coordinator.startActivity({ ...f.motion(1), target }), false);
  assert.equal(f.coordinator.startActivity({ ...f.motion(2), target, animation: 'coatWave' }), true);
  f.coordinator.dispose();
});

test('classic uses same arbiter and ignores stale external callbacks', () => {
  const f = fixture(true); assert.equal(f.coordinator.startActivity(f.strip(1)), true);
  const first = f.external[0].callback; first('started'); f.coordinator.setMotionState('run-left');
  assert.deepEqual(f.activityResults.map(x => x.outcome), ['started', 'cancelled']);
  f.coordinator.setMotionState('idle'); assert.equal(f.coordinator.startActivity(f.strip(2)), true);
  first('completed'); assert.equal(f.activityResults.length, 2);
  f.external[1].callback('started'); f.external[1].callback('completed');
  assert.deepEqual(f.activityResults.map(x => x.outcome), ['started', 'cancelled', 'started', 'completed']);
  assert.deepEqual(f.stops, [1, 2]); f.coordinator.dispose();
});

test('Classic admits activity after a stale working context and cancels on a new busy interruption', () => {
  const f = fixture(true);
  f.update(2, { context: 'working' });
  // The host has since cleared the transient display and badge; body context
  // remains persistent and does not represent Classic's current presentation.
  assert.equal(f.coordinator.startActivity(f.strip(1)), true);
  f.external[0].callback('started');
  f.update(3, { context: 'working' });
  assert.deepEqual(f.activityResults.map(x => x.outcome), ['started']);
  // The host cancels its reservation when a new busy presentation arrives,
  // including another reaction with the same persistent context.
  f.coordinator.cancelActivity(1);
  f.external[0].callback('completed');
  assert.deepEqual(f.activityResults.map(x => x.outcome), ['started', 'cancelled']);
  assert.deepEqual(f.stops, [1]);
  f.coordinator.dispose();
});

test('reduced motion cancels Classic activity and rejects subsequent activities', () => {
  const f = fixture(true);
  assert.equal(f.coordinator.startActivity(f.strip(1)), true);
  f.external[0].callback('started');
  f.coordinator.setReducedMotion(true);
  f.external[0].callback('completed');
  assert.deepEqual(f.activityResults.map(x => x.outcome), ['started', 'cancelled']);
  assert.equal(f.coordinator.startActivity(f.strip(2)), false);
  assert.deepEqual(f.activityResults.map(x => x.outcome), ['started', 'cancelled', 'cancelled']);
  assert.equal(f.coordinator.offerVariation(), false);
  f.coordinator.dispose();
});

test('body updates report acceptance for Classic epochs and reject stale revisions', () => {
  const f = fixture(true);
  const body = { epoch: 'epoch', revision: 1, context: 'idle', paused: false, suspended: false };
  assert.equal(f.coordinator.update({ input: body, motion: null }), false);
  assert.equal(f.coordinator.update({ input: { ...body, revision: 2 }, motion: null }), true);
  assert.equal(f.coordinator.update({ input: { ...body, epoch: 'next', revision: 0 }, motion: null }), true);
  f.coordinator.dispose();
});

test('reduced motion cancels a Motion activity and does not route its result as a body event', () => {
  const f = fixture();
  assert.equal(f.coordinator.startActivity(f.motion(1)), true);
  const old = f.calls.at(-1).callbacks;
  old.onStarted();
  f.coordinator.setReducedMotion(true);
  old.onEnd(); old.onFailed(new Error('stale'));
  assert.deepEqual(f.activityResults.map(x => x.outcome), ['started', 'cancelled']);
  assert.equal(f.bodyResults.some(x => x.intentId === 'test'), false);
  assert.equal(f.coordinator.startActivity(f.motion(2)), false);
  f.coordinator.dispose();
});

test('context preemption cancels activity and restores newest context', () => {
  const f = fixture(); f.coordinator.startActivity(f.motion(1));
  f.update(2, { context: 'working' });
  assert.equal(f.activityResults.at(-1).outcome, 'cancelled'); assert.equal(f.calls.at(-1).clip, 'work');
  f.coordinator.dispose();
});

test('variation waits for one loop boundary and is discarded by movement', () => {
  const f = fixture(); const idle = f.calls.at(-1).callbacks;
  assert.equal(f.coordinator.offerVariation(), true); assert.equal(f.coordinator.offerVariation(), false);
  idle.onEnd(); assert.equal(f.calls.at(-1).clip, 'alternate');
  assert.equal(f.coordinator.offerVariation(), true); f.coordinator.setMotionState('run-left');
  f.coordinator.setMotionState('idle'); const restored = f.calls.at(-1); restored.callbacks.onEnd();
  assert.equal(f.calls.at(-1).clip, 'alternate'); f.coordinator.dispose();
});

test('drag, plugin, pause and suspension cancel without reporting asset failure', () => {
  for (const interrupt of [
    f => f.coordinator.setDragDirection('run-left'),
    f => f.coordinator.setPlugin(true),
    f => f.update(2, { paused: true }),
    f => f.update(2, { suspended: true }),
  ]) {
    const f = fixture(); f.coordinator.startActivity(f.motion(1));
    const old = f.calls.at(-1).callbacks;
    interrupt(f); old.onStarted(); old.onFailed(new Error('stale decode'));
    assert.deepEqual(f.activityResults.map(x => x.outcome), ['cancelled']);
    f.coordinator.dispose();
  }
});

test('event preempts activity and decode failure does not poison later activity', () => {
  const f = fixture(); f.coordinator.startActivity(f.motion(1));
  f.calls.at(-1).callbacks.onFailed(new Error('decode'));
  assert.equal(f.activityResults.at(-1).outcome, 'failed');
  assert.equal(f.coordinator.startActivity(f.motion(2)), true);
  f.update(2, { event: { id: 'event', reaction: 'waving' } });
  assert.deepEqual(f.activityResults.map(x => x.outcome), ['failed', 'cancelled']);
  f.coordinator.dispose();
});

test('stale cancellation cannot stop a newer external generation', () => {
  const f = fixture(true); f.coordinator.startActivity(f.strip(1));
  f.coordinator.startActivity(f.strip(2)); f.coordinator.cancelActivity(1);
  f.external[1].callback('started'); f.external[1].callback('completed');
  assert.deepEqual(f.activityResults.map(x => [x.generation, x.outcome]), [[1, 'cancelled'], [2, 'started'], [2, 'completed']]);
  f.coordinator.dispose();
});

test('pending appearance blocks activity admission', () => {
  const f = fixture();
  f.update(2, {}, { ...f.appearance, presentationId: 'other', reason: 'scheduled' });
  assert.equal(f.coordinator.startActivity(f.motion(1)), false);
  assert.equal(f.activityResults.at(-1).outcome, 'cancelled');
  f.coordinator.dispose();
});

test('event decode failure does not disable an unrelated activity', () => {
  const f = fixture();
  f.appearance.assets.metadata.bindings.events.waving = [{ animation: 'wave' }];
  f.update(2, { event: { id: 'event', reaction: 'waving' } });
  f.calls.at(-1).callbacks.onFailed(new Error('event decode'));
  assert.equal(f.coordinator.startActivity(f.motion(1)), true);
  f.calls.at(-1).callbacks.onStarted();
  assert.equal(f.activityResults.at(-1).outcome, 'started');
  f.coordinator.dispose();
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { animationClockAdvanced, findStableIdleWindow, keyframeBackgroundPosition, makeSyntheticV1Pixels, parseRenderingArguments, sharesAnimationClock, summarizeFrameIntervals } from './windows-pet-rendering-core.mjs';
import { drainCollectorExpression, installCollectorExpression, observationExpression, stopCollectorExpression } from './windows-pet-rendering-sampling.mjs';

function idleObservation(observedAt, time = observedAt, animationIdentity = 1, overrides = {}) {
  return {
    observedAt, documentTimeOrigin: 1000, documentIdentity: 'cold-document', semanticEpoch: 0,
    visibility: 'visible', reaction: 'idle', motion: 'idle', paused: 'false', reducedMotion: false,
    idleAnimation: null, sprite: { identity: 1 },
    animations: [{ identity: animationIdentity, name: 'idle', time, startTime: 0,
      playbackRate: 1, state: 'running', pending: false, changesBackgroundPosition: true }],
    ...overrides,
  };
}

test('the actual CDP observation programs parse before requiring a Windows runner', () => {
  for (const expression of [observationExpression, installCollectorExpression, drainCollectorExpression, stopCollectorExpression]) {
    assert.doesNotThrow(() => new Script(expression));
  }
});

test('computed keyframes identify sprite positions from Chromium longhands or a shorthand', () => {
  assert.equal(keyframeBackgroundPosition({ backgroundPositionX: '-192px', backgroundPositionY: '0px' }), '-192px 0px');
  assert.equal(keyframeBackgroundPosition({ backgroundPosition: '0px 0px' }), '0px 0px');
  assert.equal(keyframeBackgroundPosition({ opacity: '1' }), null);
});

test('rendering validation requires an explicit app and output, without a profile override', () => {
  assert.equal(parseRenderingArguments(['--help']).help, true);
  assert.deepEqual(parseRenderingArguments(['app', '--output', 'reports']), { appDirectory: 'app', outputDirectory: 'reports', help: false, withPublicYukino: false });
  assert.equal(parseRenderingArguments(['app', '--output', 'reports', '--with-public-yukino']).withPublicYukino, true);
  assert.throws(() => parseRenderingArguments([]));
  assert.throws(() => parseRenderingArguments(['app', '--profile', 'user-data']));
  assert.throws(() => parseRenderingArguments(['app', '--output', 'reports', '--profile', 'user-data']));
  assert.throws(() => parseRenderingArguments(['--profile', '--output', 'reports']));
});

test('frame observations expose a stalled callback rather than claiming a screen refresh rate', () => {
  const stats = summarizeFrameIntervals([16, 17, 16, 250, NaN, -2]);
  assert.equal(stats.intervalCount, 4);
  assert.equal(stats.over100ms, 1);
  assert.equal(stats.longestMs, 250);
  assert.equal(stats.medianMs, 16);
  assert.equal(summarizeFrameIntervals([]).p95Ms, null);
});

test('an existing CSS animation must advance, not merely exist or be pending', () => {
  const first = idleObservation(100);
  assert.equal(animationClockAdvanced(first, idleObservation(600)), true);
  assert.equal(animationClockAdvanced(first, idleObservation(600, 600, 2)), false);
  assert.equal(animationClockAdvanced(first, first), false);
  assert.equal(animationClockAdvanced({ ...first, animations: [{ ...first.animations[0], pending: true }] }, idleObservation(600)), false);
  assert.equal(sharesAnimationClock(first, idleObservation(600), 'idle'), true);
  assert.equal(sharesAnimationClock(first, idleObservation(600, 600, 1, { documentIdentity: 'new-document' }), 'idle'), false);
});

test('a startup greeting restarts the stable idle observation instead of comparing unrelated same-name clocks', () => {
  const cold = [idleObservation(0), idleObservation(1000), idleObservation(2000, 0, 2, { reaction: 'waving' })];
  const resumed = Array.from({ length: 9 }, (_, index) => idleObservation(4000 + index * 1000, index * 1000, 3));
  assert.equal(findStableIdleWindow([...cold, ...resumed.slice(0, -1)]), null);
  const result = findStableIdleWindow([...cold, ...resumed]);
  assert.equal(result.first.observedAt, 4000);
  assert.equal(result.elapsedMs, 8000);
  assert.equal(result.advanceMs, 8000);
});

test('continued callbacks cannot pass a stalled clock or repeated idle replacements', () => {
  const stalled = Array.from({ length: 12 }, (_, index) => idleObservation(index * 1000, 250));
  const replaced = stalled.map((snapshot, index) => ({ ...snapshot,
    animations: [{ ...snapshot.animations[0], identity: index + 1, time: 100 }] }));
  assert.equal(findStableIdleWindow(stalled), null);
  assert.equal(findStableIdleWindow(replaced), null);
});

test('navigation and a short semantic interruption cannot be hidden by matching endpoint values', () => {
  const first = Array.from({ length: 8 }, (_, index) => idleObservation(index * 1000));
  assert.equal(findStableIdleWindow([...first, idleObservation(8000, 8000, 1, { documentIdentity: 'new-context' })]), null);
  assert.equal(findStableIdleWindow([...first, idleObservation(8000, 8000, 1, { semanticEpoch: 1 })]), null);
});

test('paused, reduced-motion and invalid rate observations cannot prove an active idle window', () => {
  const continuous = Array.from({ length: 9 }, (_, index) => idleObservation(index * 1000));
  for (const state of [{ paused: 'true' }, { reducedMotion: true }, { visibility: 'hidden' }]) {
    assert.equal(findStableIdleWindow(continuous.map(snapshot => ({ ...snapshot, ...state }))), null);
  }
  for (const rate of [0, Infinity, NaN]) {
    assert.equal(findStableIdleWindow(continuous.map(snapshot => ({ ...snapshot,
      animations: [{ ...snapshot.animations[0], playbackRate: rate }] }))), null);
  }
});

test('owned synthetic V1 has transparent margins and distinguishable frames', () => {
  const { pixels, width, height } = makeSyntheticV1Pixels();
  assert.equal(pixels.length, width * height * 4);
  assert.equal(pixels[3], 0);
  const sample = (column) => pixels.subarray(((28 * width) + column * 192 + 55) * 4, ((28 * width) + column * 192 + 55) * 4 + 4);
  assert.equal(sample(0)[3], 255);
  assert.notDeepEqual(sample(0), sample(1));
});

test('help works without opening Electron or any Windows profile', () => {
  const script = fileURLToPath(new URL('./validate-windows-pet-rendering.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /native Windows/);
});

test('non-Windows invocation fails before inspecting any app or profile', { skip: process.platform === 'win32' }, () => {
  const script = fileURLToPath(new URL('./validate-windows-pet-rendering.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '/definitely-missing-app', '--output', '/definitely-missing-output'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires native Windows/);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { animationClockAdvanced, makeSyntheticV1Pixels, parseRenderingArguments, summarizeFrameIntervals } from './windows-pet-rendering-core.mjs';

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
  const first = { animations: [{ name: 'idle', time: 100 }, { name: 'pending', time: null }] };
  assert.equal(animationClockAdvanced(first, { animations: [{ name: 'idle', time: 600 }] }), true);
  assert.equal(animationClockAdvanced(first, { animations: [{ name: 'other', time: 600 }] }), false);
  assert.equal(animationClockAdvanced(first, first), false);
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

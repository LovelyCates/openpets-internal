#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { release as osRelease } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { animationClockAdvanced, makeSyntheticV1Pixels, parseRenderingArguments, summarizeFrameIntervals } from './windows-pet-rendering-core.mjs';

const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const deadline = (milliseconds) => Date.now() + milliseconds;
const scriptRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const desktopRequire = createRequire(join(scriptRoot, 'apps', 'desktop', 'package.json'));
// Public catalog + previously verified unmodified ZIP, never copied from a user profile.
const publicYukino = {
  url: 'https://zip.openpets.dev/pets/yukino-yukinoshita-66c31309/yukino-yukinoshita.zip',
  bytes: 1139788,
  sha256: '0021e18df93dbb4afd2215c03ef3c2a81d60fcde9340662907e816da6f441e1e',
};

class PageConnection {
  constructor(url) {
    assert.equal(new URL(url).hostname, '127.0.0.1', 'DevTools must stay on loopback.');
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.ready = new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.socket.close();
        reject(new Error('DevTools connection did not open.'));
      }, 10_000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); done(); }, { once: true });
      this.socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('DevTools connection failed.'));
      }, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.method === 'Runtime.exceptionThrown' && this.exceptions.length < 20) {
        this.exceptions.push(String(message.params?.exceptionDetails?.text ?? 'Renderer exception').slice(0, 512));
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`DevTools ${pending.method}: ${message.error.message}`));
      else pending.done(message.result);
    });
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('DevTools connection closed.'));
      }
      this.pending.clear();
    });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.nextId;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools ${method} exceeded its deadline.`));
      }, 45_000);
      this.pending.set(id, { done, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`Renderer observation failed: ${result.exceptionDetails.text}`);
    return result.result.value;
  }
  close() { this.socket.close(); }
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

async function regularFile(path) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `Expected a regular file: ${path}`);
}

async function realDirectory(path) {
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `Expected a real directory: ${path}`);
}

async function poll(description, read, milliseconds = 45_000) {
  const until = deadline(milliseconds);
  let lastError;
  while (Date.now() < until) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) { lastError = error; }
    await sleep(200);
  }
  throw new Error(`${description} was not ready${lastError ? `: ${lastError.message}` : '.'}`);
}

const observationExpression = `(() => {
  const root = document.documentElement;
  const sprite = document.querySelector('.pet-shell .installed-sprite, .pet-shell .sprite');
  const style = sprite && getComputedStyle(sprite);
  const rect = sprite && sprite.getBoundingClientRect();
  return {
    observedAt: performance.now(), userAgent: navigator.userAgent,
    visibility: document.visibilityState, focused: document.hasFocus(),
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    devicePixelRatio, readyState: document.readyState,
    spriteVersion: root.dataset.codexSpriteVersion,
    reaction: root.dataset.reactionState, motion: root.dataset.motionState,
    paused: root.dataset.paused, classicRest: root.dataset.classicRest || null,
    idleAnimation: root.dataset.idleAnimation || null,
    sprite: sprite ? { display: style.display, visibility: style.visibility,
      opacity: style.opacity, backgroundPosition: style.backgroundPosition,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      backgroundImagePresent: style.backgroundImage !== 'none' } : null,
    viewport: { width: innerWidth, height: innerHeight },
    animations: sprite ? sprite.getAnimations().map(animation => ({
      name: animation.animationName || animation.id || 'unnamed',
      time: typeof animation.currentTime === 'number' ? animation.currentTime : null,
      state: animation.playState, pending: animation.pending,
      duration: animation.effect?.getComputedTiming().duration,
    })) : [],
  };
})()`;

async function observe(page) { return page.evaluate(observationExpression); }

async function verifyImage(page) {
  return page.evaluate(`(async () => {
    const sprite = document.querySelector('.pet-shell .installed-sprite, .pet-shell .sprite');
    if (!sprite) throw new Error('Pet sprite is absent.');
    const background = getComputedStyle(sprite).backgroundImage;
    const match = /^url\\(["']?(.*?)["']?\\)$/.exec(background);
    if (!match) throw new Error('Pet background image URL is absent.');
    const image = new Image(); image.src = match[1]; await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight, loaded: image.naturalWidth > 0 && image.naturalHeight > 0 };
  })()`);
}

async function measureCallbacks(page) {
  const first = await poll('Running CSS animation', async () => {
    const snapshot = await observe(page);
    return snapshot.animations.some((animation) => animation.state === 'running'
      && Number.isFinite(animation.time)) ? snapshot : null;
  });
  const intervals = await page.evaluate(`new Promise((done) => {
    const values = []; const start = performance.now(); let previous = start;
    function tick(now) {
      values.push(now - previous); previous = now;
      if (now - start >= 4000) done(values); else requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  })`);
  const last = await observe(page);
  return { first, last, cssClockAdvanced: animationClockAdvanced(first, last), raf: summarizeFrameIntervals(intervals) };
}

async function screenshot(page, sharp, output, name) {
  const snapshot = await observe(page);
  const rect = snapshot.sprite?.rect;
  assert.ok(rect && rect.width > 0 && rect.height > 0, 'Pet has no drawable geometry.');
  assert.ok(snapshot.sprite.display !== 'none' && snapshot.sprite.visibility === 'visible'
    && Number(snapshot.sprite.opacity) > 0, 'Pet sprite is hidden.');
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const width = Math.min(rect.x + rect.width, snapshot.viewport.width) - x;
  const height = Math.min(rect.y + rect.height, snapshot.viewport.height) - y;
  assert.ok(width > 0 && height > 0, 'Pet sprite lies outside its viewport.');
  const result = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false,
    clip: { x, y, width, height, scale: 1 } });
  const bytes = Buffer.from(result.data, 'base64');
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let opaquePixels = 0;
  const colors = new Set();
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] <= 8) continue;
    opaquePixels++;
    if (colors.size < 1024) colors.add(`${data[index]},${data[index + 1]},${data[index + 2]},${data[index + 3]}`);
  }
  await writeFile(join(output, name), bytes);
  return { name, width: info.width, height: info.height, opaquePixels, distinctColorsCapped1024: colors.size,
    totalPixels: info.width * info.height, sha256: createHash('sha256').update(bytes).digest('hex'),
    pixelSha256: createHash('sha256').update(data).digest('hex'), snapshot };
}

async function captureBuiltinIdleFrames(page, sharp, output) {
  const authored = await page.evaluate(`(() => {
    const sprite = document.querySelector('.pet-shell .sprite');
    const animation = sprite?.getAnimations().find(item => item.animationName === 'pet-builtin-idle');
    if (!animation) throw new Error('Bundled pet authored idle animation is absent.');
    const duration = animation.effect.getComputedTiming().duration;
    const keyframes = animation.effect.getKeyframes();
    return { duration, holds: keyframes.slice(0, -1).map((frame, index) => ({
      position: frame.backgroundPosition,
      start: frame.computedOffset * duration,
      end: keyframes[index + 1].computedOffset * duration,
    })) };
  })()`);
  assert.ok(Number.isFinite(authored.duration) && authored.duration > 0, 'Bundled idle has no finite authored period.');
  // Observe the two longest actual authored holds. The 110ms blink is too short
  // to attribute a screenshot reliably on a shared runner; no CSS clock is forced.
  const holds = authored.holds.filter((hold) => typeof hold.position === 'string'
    && Number.isFinite(hold.start) && Number.isFinite(hold.end) && hold.end - hold.start >= 500)
    .sort((left, right) => (right.end - right.start) - (left.end - left.start)).slice(0, 2);
  assert.equal(new Set(holds.map(hold => hold.position)).size, 2, 'Bundled idle needs two distinct drawable authored holds.');
  const images = [];
  for (const [index, hold] of holds.entries()) {
    const until = deadline(Math.min(30_000, authored.duration * 3));
    let captured;
    while (Date.now() < until) {
      const state = await observe(page);
      const clock = state.animations.find(item => item.name === 'pet-builtin-idle');
      const phase = Number.isFinite(clock?.time) ? clock.time % authored.duration : -1;
      if (state.reaction === 'idle' && state.motion === 'idle' && !state.idleAnimation
        && state.sprite.backgroundPosition === hold.position
        && phase >= hold.start + 150 && phase < hold.end - 350) {
        const image = await screenshot(page, sharp, output, `builtin-v2-idle-${index}.png`);
        const after = await observe(page);
        if (image.snapshot.sprite.backgroundPosition === hold.position
          && after.sprite.backgroundPosition === hold.position) {
          captured = image;
          break;
        }
      }
      await sleep(50);
    }
    assert.ok(captured, `Bundled V2 did not naturally present authored hold ${hold.position}.`);
    images.push(captured);
  }
  assert.ok(images.every(image => image.opaquePixels > 0 && image.distinctColorsCapped1024 > 1), 'Bundled V2 idle capture is empty.');
  assert.equal(new Set(images.map(image => image.pixelSha256)).size, 2, 'Bundled V2 authored idle holds did not change visible sprite pixels.');
  return { authored, sampledHolds: holds, visiblePixelsChanged: true, screenshots: images };
}

async function getPage(port, expectedFile) {
  const expected = resolve(expectedFile).toLowerCase();
  const target = await poll('Actual pet document', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
    const targets = await response.json();
    return targets.find((candidate) => {
      if (candidate.type !== 'page' || !candidate.url?.startsWith('file:')) return false;
      try { return resolve(fileURLToPath(candidate.url)).toLowerCase() === expected; } catch { return false; }
    });
  });
  const address = new URL(target.webSocketDebuggerUrl);
  assert.equal(address.hostname, '127.0.0.1');
  assert.equal(Number(address.port), port);
  const page = new PageConnection(address.href);
  try {
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await poll('Visible decoded pet document', async () => {
      const state = await observe(page);
      return state.visibility === 'visible' && state.readyState === 'complete' && state.sprite ? state : null;
    });
    return page;
  } catch (error) {
    page.close();
    throw error;
  }
}

async function setMotionTestMedia(page) {
  const actual = await observe(page);
  if (actual.reducedMotion) {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await poll('No-preference test media', async () => !(await observe(page)).reducedMotion);
    await sleep(250);
  }
  return { observedSystemReducedMotion: actual.reducedMotion,
    testMediaOverride: actual.reducedMotion ? 'no-preference (test-only renderer emulation)' : null,
    actualSystemObservation: actual };
}

async function waitQuietGesture(page, sharp, output, heartbeatFailure, prefix = 'v1') {
  await page.evaluate(`(() => {
    globalThis.__openPetsNativeQuiet = { gestures: [], baseline: performance.now() };
    const root = document.documentElement;
    globalThis.__openPetsNativeQuietObserver = new MutationObserver(() => {
      const state = root.dataset.idleAnimation;
      if (state && globalThis.__openPetsNativeQuiet.gestures.length < 20) {
        globalThis.__openPetsNativeQuiet.gestures.push({ state, at: performance.now(), reaction: root.dataset.reactionState });
      }
    });
    globalThis.__openPetsNativeQuietObserver.observe(root, { attributes: true, attributeFilter: ['data-idle-animation'] });
  })()`);
  const until = deadline(35_000);
  let gesture;
  while (Date.now() < until) {
    if (heartbeatFailure()) throw heartbeatFailure();
    const observed = await observe(page);
    if (observed.idleAnimation) { gesture = observed; break; }
    await sleep(100);
  }
  assert.ok(gesture, 'V1 did not present a quiet idle gesture within 35 seconds under no-preference media.');
  assert.equal(gesture.reaction, 'idle', 'Lease heartbeat must not manufacture a busy reaction.');
  const images = [];
  for (const [index, delay] of [0, 140, 310].entries()) {
    if (delay) await sleep(delay);
    images.push(await screenshot(page, sharp, output, `${prefix}-quiet-${index}.png`));
  }
  const events = await page.evaluate(`(() => {
    globalThis.__openPetsNativeQuietObserver.disconnect();
    return globalThis.__openPetsNativeQuiet;
  })()`);
  assert.ok(images.every((image) => image.opaquePixels > 0), 'V1 quiet gesture rendered an empty sprite.');
  assert.ok(new Set(images.map((image) => image.pixelSha256)).size > 1, 'V1 quiet gesture did not change visible sprite pixels.');
  const cssClockAdvanced = animationClockAdvanced(images[0].snapshot, images.at(-1).snapshot);
  assert.ok(cssClockAdvanced, 'V1 quiet gesture CSS clock did not advance.');
  return { firstGesture: gesture, cssClockAdvanced, events, screenshots: images };
}

async function downloadPublicYukino(destination) {
  const response = await fetch(publicYukino.url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, `Public test asset returned ${response.status}.`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      assert.ok(size <= publicYukino.bytes, 'Public test asset exceeded its pinned size.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = Buffer.concat(chunks);
  assert.equal(size, publicYukino.bytes, 'Public test asset size changed.');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), publicYukino.sha256, 'Public test asset SHA-256 changed.');
  await writeFile(destination, bytes, { flag: 'wx' });
}

async function captureIdleColumns(page, sharp, output) {
  const images = [];
  const seen = new Set();
  const until = deadline(8500);
  while (Date.now() < until && seen.size < 6) {
    const state = await observe(page);
    if (state.reaction === 'idle' && state.motion === 'idle' && !state.idleAnimation
      && !seen.has(state.sprite.backgroundPosition)) {
      seen.add(state.sprite.backgroundPosition);
      images.push(await screenshot(page, sharp, output, `yukino-idle-${images.length}.png`));
    }
    await sleep(100);
  }
  assert.equal(seen.size, 6, 'Public Yukino did not expose all six authored idle columns.');
  assert.ok(images.every((image) => image.opaquePixels > 0 && image.distinctColorsCapped1024 > 1), 'Public Yukino idle capture is empty.');
  return { positions: [...seen], screenshots: images };
}

async function main() {
  const options = parseRenderingArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node internal/validate-windows-pet-rendering.mjs <packaged-app-directory> --output <report-directory> [--with-public-yukino]\n\nRuns actual native Windows x64 packaged GUI in an exclusively new GitHub-hosted\nrunner profile. Refuses an existing profile and never runs on a user workstation.\nChecks Builtin V2 and a synthetic V1 imported through real local IPC. The optional\npublic Yukino reference has a pinned URL, size and SHA-256; unavailable downloads\nare reported separately from product failures. Screenshots are only of the test\npet; callback timing is not a physical DWM frame-rate claim.');
    return;
  }
  assert.equal(process.platform, 'win32', 'The rendering gate requires native Windows.');
  assert.equal(process.arch, 'x64', 'The rendering gate requires Windows x64.');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'The gate is restricted to an ephemeral GitHub runner.');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'The gate refuses persistent/self-hosted workstations.');
  assert.ok(process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP));
  assert.ok(process.env.APPDATA && isAbsolute(process.env.APPDATA));
  const appDirectory = await realpath(resolve(options.appDirectory));
  const output = resolve(options.outputDirectory);
  const runnerTemp = await realpath(process.env.RUNNER_TEMP);
  assert.ok(relative(runnerTemp, appDirectory) && !relative(runnerTemp, appDirectory).startsWith('..')
    && !isAbsolute(relative(runnerTemp, appDirectory)), 'The application must be the payload extracted into this runner temporary directory.');
  assert.notEqual(output.toLowerCase(), runnerTemp.toLowerCase(), 'Use a dedicated report directory.');
  assert.ok(!relative(runnerTemp, output).startsWith('..') && !isAbsolute(relative(runnerTemp, output)), 'Reports must stay inside this runner temporary directory.');
  const knownFolderResult = spawnSync('pwsh', ['-NoProfile', '-Command', '[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)'], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(knownFolderResult.status, 0, knownFolderResult.stderr);
  const appData = await realpath(knownFolderResult.stdout.trim());
  assert.equal(appData.toLowerCase(), (await realpath(process.env.APPDATA)).toLowerCase(), 'APPDATA must match the actual native Windows known folder.');
  await realDirectory(appData);
  const profile = join(appData, 'OpenPets Internal');
  try {
    await lstat(profile);
    throw new Error('An existing OpenPets profile is present; refusing to use or remove it.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const executable = join(appDirectory, 'openpets-internal.exe');
  const asarPath = join(appDirectory, 'resources', 'app.asar');
  const unpacked = join(appDirectory, 'resources', 'app.asar.unpacked');
  await regularFile(executable);
  await regularFile(asarPath);
  const requirePackaged = createRequire(join(unpacked, 'package.json'));
  const sharp = requirePackaged('sharp');
  const asar = desktopRequire('@electron/asar');
  const packageMetadata = JSON.parse(asar.extractFile(asarPath, 'package.json').toString());
  const { createOpenPetsClient } = await import(pathToFileURL(requirePackaged.resolve('@open-pets/client')).href);
  await mkdir(output);
  await mkdir(profile);
  const ownership = JSON.stringify({ purpose: 'native-rendering-validation', nonce: randomUUID() });
  const ownershipPath = join(profile, '.render-validation-owner.json');
  await writeFile(ownershipPath, ownership, { flag: 'wx' });
  const report = {
    schemaVersion: 1, startedAt: new Date().toISOString(), status: 'incomplete',
    appVersion: packageMetadata.version, actualProductExecutable: true, testCarrier: false,
    executableSha256: await hashFile(executable), appAsarSha256: await hashFile(asarPath),
    platform: process.platform, arch: process.arch, windowsKernelVersion: osRelease(),
    profile: 'Exclusively created empty hosted-runner Internal profile',
    realUserProfilesRead: false, screenshots: 'Only this test pet window, not the desktop',
    comparisonReference: { macAppVersion: '4.1.0-internal.12', macElectronVersion: '42.0.0',
      scope: 'User-approved Mac baseline reported separately; this script does not execute that Mac app.' },
    limitation: 'Native hosted Windows renderer evidence; not the user GPU/DPI, physical DWM frame presentation, installed shortcuts, or a full cross-platform GUI equivalence proof.',
  };
  const connections = [];
  let child;
  let lease;
  let heartbeat;
  let heartbeatError;
  let client;
  let fixture;
  let logs = '';
  try {
    const environment = { ...process.env, OPENPETS_LOG_LEVEL: 'info', OPENPETS_LOG_CONSOLE: '1' };
    delete environment.ELECTRON_RUN_AS_NODE;
    const testFlags = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'];
    report.testFlags = testFlags;
    child = spawn(executable, testFlags, {
      cwd: appDirectory, env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const appendLog = (bytes) => { if (logs.length < 2 * 1024 * 1024) logs += bytes.toString().slice(0, 2 * 1024 * 1024 - logs.length); };
    child.stdout.on('data', appendLog);
    child.stderr.on('data', appendLog);
    child.on('error', (error) => { logs += `\nStartup error: ${error.message}`; });
    const discoveryPath = join(profile, 'runtime', 'ipc.json');
    const discovery = await poll('Own product discovery', async () => {
      if (child.exitCode !== null) throw new Error(`Product exited before ready (${child.exitCode}).`);
      const value = JSON.parse(await readFile(discoveryPath, 'utf8'));
      assert.equal(value.pid, child.pid, 'A different application owns discovery.');
      assert.equal(value.appVersion, packageMetadata.version);
      return value;
    });
    report.processIdMatchesDiscovery = discovery.pid === child.pid;
    const activePort = await poll('Loopback DevTools', async () => {
      let value;
      try { [value] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      // Some Electron versions report the ephemeral port only on stderr.
      value ??= /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(logs)?.[1];
      const port = Number(value);
      return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
    });
    const listenerResult = spawnSync('pwsh', ['-NoProfile', '-Command',
      `@(Get-NetTCPConnection -State Listen -LocalPort ${activePort} -ErrorAction Stop | Select-Object LocalAddress,OwningProcess) | ConvertTo-Json -Compress`],
      { encoding: 'utf8', timeout: 15_000 });
    assert.equal(listenerResult.status, 0, 'Could not verify the DevTools listener.');
    const listeners = [JSON.parse(listenerResult.stdout.trim())].flat();
    assert.ok(listeners.length > 0 && listeners.every((listener) => listener.LocalAddress === '127.0.0.1'
      && listener.OwningProcess === child.pid), 'DevTools is not exclusively owned by this process on IPv4 loopback.');
    report.devToolsListener = listeners;
    client = createOpenPetsClient({ discoveryPath, remote: false, responseTimeoutMs: 30_000 });
    await client.hello();
    const builtin = await getPage(activePort, join(profile, 'rendered-pets', 'default.html'));
    connections.push(builtin);
    report.browser = await builtin.send('Browser.getVersion');
    report.builtinV2 = { media: await setMotionTestMedia(builtin), image: await verifyImage(builtin) };
    const callbacks = await measureCallbacks(builtin);
    report.builtinV2.callbacks = callbacks;
    assert.ok(report.builtinV2.image.loaded && callbacks.last.spriteVersion === '2', 'Actual Builtin V2 artwork did not load.');
    assert.ok(callbacks.cssClockAdvanced, 'Actual Builtin V2 CSS animation clock did not advance.');
    assert.ok(callbacks.raf.intervalCount > 0, 'Native page received no animation callbacks.');
    report.builtinV2.screenshot = await screenshot(builtin, sharp, output, 'builtin-v2.png');
    assert.ok(report.builtinV2.screenshot.opaquePixels > 0
      && report.builtinV2.screenshot.distinctColorsCapped1024 > 1, 'Builtin V2 sprite capture is empty or a flat blank surface.');
    report.builtinV2.idle = await captureBuiltinIdleFrames(builtin, sharp, output);

    fixture = join(runnerTemp, `openpets-render-v1-${randomUUID()}`);
    await mkdir(fixture);
    const raw = makeSyntheticV1Pixels();
    const atlas = await sharp(raw.pixels, { raw: { width: raw.width, height: raw.height, channels: raw.channels } })
      .webp({ lossless: true }).toBuffer();
    await writeFile(join(fixture, 'spritesheet.webp'), atlas);
    await writeFile(join(fixture, 'pet.json'), JSON.stringify({ id: 'native-render-v1', displayName: 'Native rendering V1 fixture', description: 'Public synthetic atlas; no user artwork.', spritesheetPath: 'spritesheet.webp' }));
    report.fixture = { rawPixelSha256: createHash('sha256').update(raw.pixels).digest('hex'), encodedSha256: createHash('sha256').update(atlas).digest('hex') };
    const installed = await client.installLocalPet(fixture, { kind: 'folder' });
    lease = await client.acquireLease({ requestedPetId: installed.petId });
    assert.equal(lease.targetKind, 'explicit');
    assert.equal(lease.actualTargetPetId, installed.petId);
    assert.equal(lease.usingDefaultPet, false);
    assert.equal(lease.fallbackReason, undefined);
    report.fixture.importedThroughProductIpc = true;
    heartbeat = setInterval(() => { void client.heartbeatLease(lease.leaseId).catch((error) => { heartbeatError = error; }); }, 5000);
    const v1 = await getPage(activePort, join(profile, 'rendered-pets', `explicit-${installed.petId}.html`));
    connections.push(v1);
    report.v1 = { media: await setMotionTestMedia(v1), image: await verifyImage(v1) };
    const v1Callbacks = await measureCallbacks(v1);
    report.v1.callbacks = v1Callbacks;
    assert.equal(v1Callbacks.last.spriteVersion, '1');
    assert.ok(report.v1.image.loaded && v1Callbacks.cssClockAdvanced, 'Actual imported V1 atlas/CSS clock is unavailable.');
    report.v1.quietGesture = await waitQuietGesture(v1, sharp, output, () => heartbeatError);
    report.v1.exceptions = v1.exceptions;
    report.builtinV2.exceptions = builtin.exceptions;
    assert.equal(v1.exceptions.length + builtin.exceptions.length, 0, 'The pet renderer reported an uncaught exception.');
    report.requiredSyntheticGate = 'passed';
    report.publicYukino = { requested: options.withPublicYukino, status: 'not-requested', source: publicYukino };
    if (options.withPublicYukino) {
      clearInterval(heartbeat);
      await client.releaseLease(lease.leaseId);
      lease = undefined;
      const zip = join(fixture, 'public-yukino.zip');
      try {
        await downloadPublicYukino(zip);
        report.publicYukino.status = 'source-verified';
      } catch (error) {
        report.publicYukino.status = 'source-unavailable-or-changed';
        report.publicYukino.error = error instanceof Error ? error.message : String(error);
      }
      if (report.publicYukino.status === 'source-verified') {
        const imported = await client.installLocalPet(zip, { kind: 'zip' });
        assert.equal(imported.petId, 'yukino-yukinoshita');
        lease = await client.acquireLease({ requestedPetId: imported.petId });
        assert.equal(lease.actualTargetPetId, imported.petId);
        assert.equal(lease.usingDefaultPet, false);
        heartbeatError = undefined;
        heartbeat = setInterval(() => { void client.heartbeatLease(lease.leaseId).catch((error) => { heartbeatError = error; }); }, 5000);
        const yukino = await getPage(activePort, join(profile, 'rendered-pets', `explicit-${imported.petId}.html`));
        connections.push(yukino);
        report.publicYukino.media = await setMotionTestMedia(yukino);
        report.publicYukino.image = await verifyImage(yukino);
        report.publicYukino.callbacks = await measureCallbacks(yukino);
        assert.equal(report.publicYukino.callbacks.last.spriteVersion, '1');
        assert.ok(report.publicYukino.callbacks.cssClockAdvanced, 'Public Yukino CSS clock did not advance.');
        report.publicYukino.idle = await captureIdleColumns(yukino, sharp, output);
        report.publicYukino.quietGesture = await waitQuietGesture(yukino, sharp, output, () => heartbeatError, 'yukino');
        report.publicYukino.exceptions = yukino.exceptions;
        assert.equal(yukino.exceptions.length, 0, 'Public Yukino renderer reported an uncaught exception.');
        report.publicYukino.status = 'passed';
      }
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : String(error);
    if (report.publicYukino?.status === 'source-verified') {
      report.publicYukino.status = 'failed';
      report.publicYukino.error = report.error;
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
    if (lease && client) await client.releaseLease(lease.leaseId).catch(() => {});
    if (connections.length && child?.exitCode === null) await connections[0].send('Browser.close').catch(() => {});
    for (const connection of connections) connection.close();
    if (child?.exitCode === null) {
      const until = deadline(7000);
      while (child.exitCode === null && Date.now() < until) await sleep(100);
      if (child.exitCode === null) {
        const terminated = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 15_000 });
        report.forcedTermination = { successful: terminated.status === 0 };
        const until = deadline(3000);
        while (child.exitCode === null && Date.now() < until) await sleep(100);
      }
    }
    report.finishedAt = new Date().toISOString();
    try {
      assert.ok(!child || child.exitCode !== null, 'Own application is still running; refusing profile removal.');
      assert.equal(await readFile(ownershipPath, 'utf8'), ownership, 'Profile ownership marker changed; refusing cleanup.');
      await realDirectory(profile);
      await rm(profile, { recursive: true, force: false, maxRetries: 5, retryDelay: 200 });
      report.ownedProfileRemoved = true;
    } catch (error) {
      report.ownedProfileRemoved = false;
      report.cleanupError = error instanceof Error ? error.message : String(error);
      report.status = 'incomplete';
    }
    if (fixture) {
      try {
        await realDirectory(fixture);
        await rm(fixture, { recursive: true, force: false, maxRetries: 3, retryDelay: 200 });
        report.fixtureRemoved = true;
      } catch (error) {
        report.fixtureRemoved = false;
        report.fixtureCleanupError = error instanceof Error ? error.message : String(error);
        report.status = 'incomplete';
      }
    }
    await writeFile(join(output, 'product-startup.log'), logs);
    await writeFile(join(output, 'WINDOWS-PET-RENDERING.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, appVersion: report.appVersion,
      publicYukinoStatus: report.publicYukino?.status ?? 'not-reached', actualProductExecutable: true,
      report: join(output, 'WINDOWS-PET-RENDERING.json') }));
  }
  assert.equal(report.status, 'passed', 'Native rendering validation or private-profile cleanup was incomplete.');
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

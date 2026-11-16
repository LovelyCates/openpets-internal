import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as moduleApi from "node:module";
import { after, test } from "node:test";
import type { BrowserWindow } from "electron";
import type { PetContentRender } from "../src/pet-window-types.js";

const host = {
  cursor: { x: 0, y: 0 },
  enabled: true,
  screenReads: 0,
};
const testGlobals = globalThis as typeof globalThis & { __petGazeBehavior?: typeof host };
testGlobals.__petGazeBehavior = host;

const sourceExtension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const mockModule = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`;
const mocks: Record<string, string> = {
  electron: mockModule(`
    export const screen = {
      getCursorScreenPoint() {
        const host = globalThis.__petGazeBehavior;
        host.screenReads += 1;
        return { ...host.cursor };
      }
    };
  `),
  "./app-state.js": mockModule(`
    export const isIdleCursorGazeEnabled = () => globalThis.__petGazeBehavior.enabled;
  `),
  "./app-state-core.js": mockModule("export const defaultPetScale = 1;"),
  "./pet-window-shape.js": mockModule("export const getPetWindowSpriteBottomInset = () => 0;"),
  "./codex-pets-core.js": new URL(`../src/codex-pets-core${sourceExtension}`, import.meta.url).href,
  "@open-pets/pet-format/sprite-layout": import.meta.resolve("@open-pets/pet-format/sprite-layout"),
};
const hooks = typeof moduleApi.registerHooks === "function" ? moduleApi.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes("pet-window-gaze.") && mocks[specifier]) {
      return { url: mocks[specifier], shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
}) : undefined;
if (!hooks) moduleApi.register(mockModule(`
  const mocks = ${JSON.stringify(mocks)};
  export async function resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes("pet-window-gaze.") && mocks[specifier]) {
      return { url: mocks[specifier], shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`), import.meta.url);

const runtime: typeof import("../src/pet-window-gaze.js") = await import(
  new URL(`../src/pet-window-gaze${sourceExtension}`, import.meta.url).href
);
after(() => {
  hooks?.deregister();
  delete testGlobals.__petGazeBehavior;
});

interface TimerHandle {
  readonly id: number;
  unref(): TimerHandle;
}

interface Timer {
  readonly handle: TimerHandle;
  readonly callback: () => void;
  readonly interval: number | null;
  due: number;
}

class Clock {
  now = 10_000;
  private nextId = 1;
  private readonly timers = new Map<number, Timer>();
  private readonly original = {
    now: Date.now,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };

  install(): void {
    Date.now = () => this.now;
    const schedule = (interval: boolean) => (callback: () => void, delay = 0): TimerHandle => {
      const handle: TimerHandle = { id: this.nextId++, unref() { return this; } };
      const duration = Math.max(1, delay);
      this.timers.set(handle.id, { handle, callback, interval: interval ? duration : null, due: this.now + duration });
      return handle;
    };
    const clear = (handle: unknown): void => {
      if (typeof handle === "object" && handle !== null && "id" in handle && typeof handle.id === "number") {
        this.timers.delete(handle.id);
      }
    };
    // These handles model the timer methods used by the owner, without creating
    // native timers or allowing a failed test to keep the process alive.
    globalThis.setTimeout = schedule(false) as unknown as typeof globalThis.setTimeout;
    globalThis.setInterval = schedule(true) as unknown as typeof globalThis.setInterval;
    globalThis.clearTimeout = clear;
    globalThis.clearInterval = clear;
  }

  restore(): void {
    Date.now = this.original.now;
    globalThis.setTimeout = this.original.setTimeout;
    globalThis.clearTimeout = this.original.clearTimeout;
    globalThis.setInterval = this.original.setInterval;
    globalThis.clearInterval = this.original.clearInterval;
  }

  get intervals(): number {
    return [...this.timers.values()].filter((timer) => timer.interval !== null).length;
  }

  get pending(): number {
    return this.timers.size;
  }

  advance(duration: number): void {
    const target = this.now + duration;
    for (;;) {
      const next = [...this.timers.values()]
        .filter((timer) => timer.due <= target)
        .sort((left, right) => left.due - right.due || left.handle.id - right.handle.id)[0];
      if (!next) break;
      this.now = next.due;
      if (next.interval === null) this.timers.delete(next.handle.id);
      else next.due += next.interval;
      next.callback();
    }
    this.now = target;
  }

  sample(x: number, y: number): void {
    host.cursor = { x, y };
    this.advance(50);
  }
}

interface GazeMessage {
  readonly index: number | null;
  readonly at: number;
}

class Contents extends EventEmitter {
  readonly gaze: GazeMessage[] = [];
  isDestroyed(): boolean { return false; }
  send(channel: string, payload: unknown): void {
    if (channel !== "openpets:pet-gaze") return;
    assert.ok(payload && typeof payload === "object" && "index" in payload);
    assert.ok(payload.index === null || typeof payload.index === "number");
    this.gaze.push({ index: payload.index, at: Date.now() });
  }
}

class Window extends EventEmitter {
  readonly contents = new Contents();
  visible = true;
  destroyed = false;
  get webContents(): Contents {
    if (this.destroyed) throw new Error("Object has been destroyed");
    return this.contents;
  }
  isDestroyed(): boolean { return this.destroyed; }
  isVisible(): boolean { return this.visible; }
  getContentBounds() { return { x: -96, y: -104, width: 192, height: 208 }; }
  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }
  get native(): BrowserWindow { return this as unknown as BrowserWindow; }
  get latest(): number | null { return this.contents.gaze.at(-1)?.index ?? null; }
}

const render: PetContentRender = {
  renderedPetId: "cat",
  renderedOutfitId: "default",
  activities: [],
  html: "",
  bodyHtml: "",
  displayName: "Cat",
  assetName: "Cat",
  reactionState: "idle",
  codexSpriteVersion: 2,
  gazeAnchor: { x: 0.5, y: 0.5 },
  petScale: 1,
  gazeSpriteBottomInset: 0,
  paused: false,
  flipped: false,
  cacheKey: "cat",
};

function scenario(run: (clock: Clock, createWindow: (reportMotion?: boolean) => Window) => void): void {
  const clock = new Clock();
  const windows: Window[] = [];
  host.cursor = { x: 0, y: 0 };
  host.enabled = true;
  host.screenReads = 0;
  clock.install();
  const createWindow = (reportMotion = true): Window => {
    const window = new Window();
    windows.push(window);
    runtime.registerPetGazeWindow(window.native);
    runtime.updatePetGazeConfiguration(window.native, render, false);
    runtime.setPetGazeRendererReady(window.native);
    if (reportMotion) runtime.setPetGazeReducedMotion(window.native, false);
    return window;
  };
  try {
    run(clock, createWindow);
  } finally {
    for (const window of windows) window.close();
    clock.restore();
  }
}

function beginGlance(clock: Clock, window: Window, x = 0, y = -100): void {
  clock.sample(0, 0);
  clock.advance(50);
  clock.sample(x, y);
  if (window.latest === null) clock.advance(50);
  assert.notEqual(window.latest, null, "meaningful movement starts an eligible pet's glance");
}

test("continuous mouse use leaves a breathing interval, including same-pet HUD refreshes", () => {
  scenario((clock, createWindow) => {
    const window = createWindow();
    beginGlance(clock, window);
    const startedAt = clock.now;
    for (let tick = 1; tick <= 18; tick += 1) {
      if (tick === 8) runtime.updatePetGazeConfiguration(window.native, { ...render, bodyHtml: "updated HUD" }, false);
      clock.sample(tick * 4, -100);
    }
    assert.equal(window.latest, null, "a glance ends within 900ms even if the cursor keeps moving");
    const finishedAt = window.contents.gaze.at(-1)!.at;
    assert.ok(finishedAt <= startedAt + 900, "HUD refreshes do not extend the active glance");
    const count = window.contents.gaze.length;
    for (let tick = 1; tick < 32; tick += 1) clock.sample(72 + tick * 4, -100);
    assert.equal(window.contents.gaze.length, count, "continued movement cannot interrupt the 1.6s breathing rest");
    clock.sample(204, -100);
    assert.notEqual(window.latest, null, "continued meaningful movement may start a later glance after rest");
  });
});

test("one-pixel mouse jitter does not create a glance", () => {
  scenario((clock, createWindow) => {
    host.cursor = { x: 100, y: 0 };
    const window = createWindow();
    clock.sample(100, 0);
    clock.advance(50);
    for (let tick = 0; tick < 15; tick += 1) {
      clock.sample(100 + tick % 2, 0);
      clock.advance(50);
    }
    assert.deepEqual(window.contents.gaze, [], "sub-threshold jitter does not count as renewed cursor attention");
  });
});

test("nearby angle and dead-zone samples retain a stable gaze pose", () => {
  scenario((clock, createWindow) => {
    const window = createWindow();
    beginGlance(clock, window, 9, -50);
    assert.equal(window.latest, 0);
    for (const x of [10, 9, 10, 9, 10]) {
      clock.sample(x, -50);
      clock.advance(50);
    }
    assert.equal(window.contents.gaze.length, 1, "neighboring sector boundary jitter does not flip the head");
    clock.sample(14, -50);
    assert.equal(window.latest, 1, "intentional movement beyond the margin changes the pose");
    clock.sample(9, -50);
    assert.equal(window.latest, 1, "the return journey has its own retention margin");
    clock.sample(5, -50);
    assert.equal(window.latest, 0);
  });
  scenario((clock, createWindow) => {
    const window = createWindow();
    beginGlance(clock, window, 30, 0);
    for (const x of [24, 25, 24, 25]) {
      clock.sample(x, 0);
      clock.advance(50);
    }
    assert.equal(window.contents.gaze.length, 1, "nearby dead-zone samples do not alternate gaze and breathing");
    clock.sample(19, 0);
    assert.equal(window.latest, null, "moving clearly inside the exit radius returns to breathing");
    clock.advance(1_600);
    clock.sample(27, 0);
    assert.equal(window.latest, null, "a new glance waits until the larger entry radius is crossed");
    clock.sample(30, 0);
    assert.equal(window.latest, 4);
  });
});

test("body ownership and motion preferences cancel gaze and stop polling", () => {
  const gates = [
    { name: "busy", enable: (window: Window) => runtime.setPetGazeReactionState(window.native, "running") },
    { name: "movement", enable: (window: Window) => runtime.setPetGazeMotionState(window.native, "run-left") },
    { name: "drag", enable: (window: Window) => runtime.setPetGazeDragging(window.native, true) },
    { name: "plugin", enable: (window: Window) => runtime.setPetGazePluginOverride(window.native, true) },
    { name: "activity", enable: (window: Window) => runtime.setPetGazeActivityOverride(window.native, true) },
    { name: "reduced motion", enable: (window: Window) => runtime.setPetGazeReducedMotion(window.native, true) },
    { name: "paused", enable: (window: Window) => runtime.updatePetGazeConfiguration(window.native, { ...render, paused: true }, false) },
    { name: "hidden", enable: (window: Window) => { window.visible = false; window.emit("hide"); } },
    { name: "disabled", enable: () => { host.enabled = false; runtime.refreshPetGazePreference(); } },
  ];
  for (const gate of gates) {
    scenario((clock, createWindow) => {
      const window = createWindow();
      beginGlance(clock, window);
      gate.enable(window);
      assert.equal(window.latest, null, `${gate.name} returns the body to its owner`);
      assert.equal(clock.pending, 0, `${gate.name} leaves no cursor polling or movement timer`);
      const messages = window.contents.gaze.length;
      const reads = host.screenReads;
      clock.sample(80, -100);
      clock.advance(2_000);
      assert.equal(window.contents.gaze.length, messages, `${gate.name} cannot receive a late gaze update`);
      assert.equal(host.screenReads, reads, `${gate.name} stops sampling the global cursor`);
    });
  }
});

test("navigation clears pending movement and waits for the new renderer's motion preference", () => {
  scenario((clock, createWindow) => {
    const window = createWindow(false);
    assert.equal(clock.pending, 0, "an unknown motion preference cannot enable initial gaze");
    runtime.setPetGazeReducedMotion(window.native, false);
    beginGlance(clock, window);
    runtime.suspendPetGazeForMovement(window.native);
    assert.equal(clock.pending, 1, "carrier movement owns a finite resume timer");
    window.contents.emit("did-start-navigation");
    assert.equal(clock.pending, 0, "navigation removes the previous renderer's resume timer");
    const messages = window.contents.gaze.length;
    clock.advance(1_000);
    assert.equal(window.contents.gaze.length, messages, "an expired movement callback cannot revive the old renderer");
    window.contents.emit("did-finish-load");
    assert.equal(clock.pending, 0, "renderer-ready alone does not reuse the previous motion preference");
    runtime.setPetGazeReducedMotion(window.native, true);
    assert.equal(clock.pending, 0);
    runtime.setPetGazeReducedMotion(window.native, false);
    assert.equal(clock.intervals, 1);
    window.contents.emit("render-process-gone");
    assert.equal(clock.pending, 0, "a renderer crash also revokes motion readiness");
  });
});

test("multiple carriers share one cursor ticker and close without destroyed-window access", () => {
  scenario((clock, createWindow) => {
    const first = createWindow();
    const second = createWindow();
    assert.equal(clock.intervals, 1, "eligible carriers share one global cursor sampler");
    const reads = host.screenReads;
    clock.sample(0, 0);
    assert.equal(host.screenReads, reads + 1, "one tick reads the cursor once for all carriers");
    clock.sample(0, -100);
    assert.notEqual(first.latest, null);
    assert.notEqual(second.latest, null);
    first.close();
    assert.equal(clock.intervals, 1, "closing one carrier preserves another carrier's gaze");
    assert.equal(first.listenerCount("show"), 0);
    assert.equal(first.contents.listenerCount("did-finish-load"), 0);
    runtime.suspendPetGazeForMovement(second.native);
    assert.equal(clock.pending, 1);
    second.close();
    assert.equal(clock.pending, 0, "closing the last carrier removes polling and movement recovery");
    clock.advance(5_000);
    assert.equal(clock.pending, 0, "no late recovery recreates a closed carrier's ticker");
  });
});

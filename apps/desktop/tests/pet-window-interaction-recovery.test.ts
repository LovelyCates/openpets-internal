import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { after, mock, test } from "node:test";
import type { BrowserWindow } from "electron";

// Losing a mouse-up during display recovery or renderer teardown must not
// leave native movement, gaze or automatic activities permanently blocked.
const state = {
  ipc: new EventEmitter(),
  activities: new WeakMap<object, boolean>(),
  gaze: new WeakMap<object, boolean>(),
  activityUpdates: 0,
  throws: 0,
};
Object.assign(globalThis, { __petInteractionRecoveryTest: state });
const moduleUrl = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`;
const mocks = new Map([
  ["electron", moduleUrl(`
    export const ipcMain = globalThis.__petInteractionRecoveryTest.ipc;
    export const screen = { getCursorScreenPoint: () => ({ x: -1000, y: -1000 }) };
  `)],
  ["./logger.js", moduleUrl("export function debug() {}")],
  ["./pet-sprite-bytes.js", moduleUrl("export function trackPetSpriteBytesWebContents() {}")],
  ["./pet-throw.js", moduleUrl(`
    export function cancelPetThrow() {}
    export function startPetThrow() { globalThis.__petInteractionRecoveryTest.throws++; }
  `)],
  ["./pet-motion-engine.js", moduleUrl("export function motionCancelMoveForDrag() { return false; }")],
  ["./pet-window-gaze.js", moduleUrl(`
    export function resetPetGazeWindow() {}
    export function setPetGazeDragging(window, dragging) { globalThis.__petInteractionRecoveryTest.gaze.set(window, dragging); }
    export function setPetGazeRendererReady() {}
    export function suspendPetGazeForMovement() {}
  `)],
  ["./pet-activities.js", moduleUrl(`
    export function finishPetActivitySpeech() {}
    export function interruptPetActivity() {}
    export function setPetActivityDragging(window, dragging) {
      const state = globalThis.__petInteractionRecoveryTest;
      state.activities.set(window, dragging);
      state.activityUpdates++;
    }
  `)],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = context.parentURL?.endsWith("/pet-window-interaction.js") ? mocks.get(specifier) : undefined;
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});
after(() => hooks.deregister());
const runtime = await import("../src/pet-window-interaction.js");
let nextId = 1;

class Contents extends EventEmitter {
  destroyed = false;
  failSends = false;
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  isDestroyed(): boolean { return this.destroyed; }
  send(channel: string, payload: unknown): void {
    if (this.failSends) throw new Error("Renderer main frame is unavailable");
    this.sent.push({ channel, payload });
  }
}

class Window extends EventEmitter {
  readonly id = nextId++;
  readonly contents = new Contents();
  destroyed = false;
  bounds = { x: 100, y: 100, width: 340, height: 420 };
  get webContents(): Contents {
    if (this.destroyed) throw new Error("Object has been destroyed");
    return this.contents;
  }
  isDestroyed(): boolean { return this.destroyed; }
  getBounds(): typeof this.bounds { return { ...this.bounds }; }
  getContentBounds(): typeof this.bounds { return this.getBounds(); }
  setBounds(bounds: typeof this.bounds): void { this.bounds = { ...bounds }; }
  setIgnoreMouseEvents(): void {}
}

async function withWindow(
  platform: NodeJS.Platform,
  run: (fixture: { window: Window; native: BrowserWindow; start(): string; move(token?: string): void; end(token?: string): void }) => void,
  nativeDrag = false,
): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(descriptor);
  Object.defineProperty(process, "platform", { value: platform });
  const window = new Window();
  const native = window as unknown as BrowserWindow;
  const event = { sender: window.contents };
  let dragSequence = 0;
  let currentToken = "";
  state.throws = 0;
  try {
    runtime.installPetWindowInteraction(native, {
      useWaylandNativeDrag: nativeDrag,
      readWindowPosition: () => ({ x: window.bounds.x, y: window.bounds.y }),
      getThrowPhysics: () => ({ gravityEnabled: false, bounciness: 0, floorFriction: 0 }),
    });
    run({
      window,
      native,
      start: () => {
        currentToken = `drag-${window.id}-${++dragSequence}`;
        state.ipc.emit("openpets:pet-drag-start", event, { screenX: 100, screenY: 100, dragToken: currentToken });
        return currentToken;
      },
      move: (token = currentToken) => {
        mock.timers.tick(20);
        state.ipc.emit("openpets:pet-drag-move", event, { screenX: 140, screenY: 100, dragToken: token });
      },
      end: (token = currentToken) => state.ipc.emit("openpets:pet-drag-end", event, token),
    });
  } finally {
    window.emit("closed");
    Object.defineProperty(process, "platform", descriptor);
  }
}

function assertReleased(window: Window, native: BrowserWindow): void {
  assert.equal(runtime.isPetWindowDragging(native), false, "movement must no longer be blocked by dragging");
  assert.equal(state.activities.get(window), false, "automatic activities must no longer be held by dragging");
  assert.equal(state.gaze.get(window), false, "idle gaze must no longer be held by dragging");
}

for (const platform of ["win32", "darwin"] as const) {
  test(`${platform} unavailable renderer cannot interrupt drag cleanup or a replacement drag`, async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000 });
    try {
      await withWindow(platform, ({ window, native, start, move, end }) => {
        start();
        move();
        window.contents.failSends = true;
        assert.doesNotThrow(() => runtime.recoverPetMouseInterop(native, "renderer-unavailable"));
        assertReleased(window, native);
        window.contents.failSends = false;
        start();
        move();
        end();
        assertReleased(window, native);
        assert.equal(state.throws, 1);
      });
    } finally {
      mock.timers.reset();
    }
  });

  test(`${platform} cancellation reaches the matching renderer without ending a newer drag`, async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000 });
    try {
      await withWindow(platform, ({ window, native, start, move, end }) => {
        const cancelledToken = start();
        move();
        runtime.recoverPetMouseInterop(native, "display-metrics-changed");
        const cancellations = () => window.contents.sent.filter((message) => message.channel === "openpets:pet-drag-cancel");
        assert.deepEqual(cancellations().map((message) => message.payload), [cancelledToken]);
        const newToken = start();
        const beforeStaleMove = { ...window.bounds };
        move(cancelledToken);
        end(cancelledToken);
        assert.deepEqual(window.bounds, beforeStaleMove, "late movement belongs to the cancelled transaction");
        assert.equal(runtime.isPetWindowDragging(native), true);
        move(newToken);
        end(newToken);
        assertReleased(window, native);
        assert.equal(state.throws, 1, "the replacement drag still releases normally");
        assert.equal(cancellations().length, 1, "normal release does not echo a renderer cancellation");
      });
    } finally {
      mock.timers.reset();
    }
  });

  test(`${platform} recovery cancels drag ownership and stale release without blocking a new drag`, async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000 });
    try {
      await withWindow(platform, ({ window, native, start, move, end }) => {
        start();
        move();
        assert.equal(runtime.isPetWindowDragging(native), true);
        runtime.recoverPetMouseInterop(native, "display-metrics-changed");
        assertReleased(window, native);
        window.contents.emit("did-fail-load");
        assertReleased(window, native);
        end();
        assert.equal(state.throws, 0, "a cancelled drag must not become a throw on a delayed mouse-up");
        start();
        end();
        assertReleased(window, native);
        assert.equal(state.throws, 0, "new stationary presses must not inherit cancelled velocity");
        start();
        move();
        end();
        assertReleased(window, native);
        assert.equal(state.throws, 1, "an intentional new moving drag still releases normally");
      });
    } finally {
      mock.timers.reset();
    }
  });

  test(`${platform} renderer and window terminal paths release drag ownership`, async () => {
    for (const event of ["did-start-navigation", "did-start-loading", "did-finish-load", "did-fail-load", "render-process-gone", "hide", "closed"]) {
      await withWindow(platform, ({ window, native, start, end }) => {
        start();
        if (event === "closed") {
          window.destroyed = true;
          window.contents.destroyed = true;
        }
        (event === "hide" || event === "closed" ? window : window.contents).emit(event);
        assertReleased(window, native);
        end();
        assert.equal(state.throws, 0);
      });
    }
  });

  test(`${platform} recovery without a drag preserves an idle activity's opportunity`, async () => {
    await withWindow(platform, ({ window, native }) => {
      const before = state.activityUpdates;
      runtime.recoverPetMouseInterop(native, "display-metrics-changed");
      window.contents.emit("did-start-loading");
      window.contents.emit("did-fail-load");
      window.emit("hide");
      assert.equal(state.activityUpdates, before, "repeated cancellation must not restart an idle opportunity");
    });
  });
}

test("native dragging releases activity and gaze ownership on recovery", async () => {
  await withWindow("linux", ({ window, native, start, end }) => {
    start();
    assert.equal(state.activities.get(window), true);
    assert.equal(state.gaze.get(window), true);
    runtime.recoverPetMouseInterop(native, "power-resume");
    assertReleased(window, native);
    end();
    assert.equal(state.throws, 0);
  }, true);
});

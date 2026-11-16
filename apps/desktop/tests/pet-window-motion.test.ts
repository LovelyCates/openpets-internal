import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it } from "node:test";

import type { PetMotionState } from "@open-pets/pet-format/animation";
import { installPetWindowMotionPublisher } from "../src/pet-window-motion.js";

function fixture() {
  const contents = new EventEmitter();
  class Window extends EventEmitter {
    x = 0;
    y = 0;
    destroyed = false;

    get webContents(): EventEmitter {
      if (this.destroyed) throw new Error("Object has been destroyed");
      return contents;
    }

    getPosition(): readonly number[] { return [this.x, this.y]; }
    isDestroyed(): boolean { return this.destroyed; }

    moveTo(x: number, y: number): void {
      this.x = x;
      this.y = y;
      this.emit("move");
    }
  }
  const window = new Window();
  const states: PetMotionState[] = [];
  let movements = 0;
  const cleanup = installPetWindowMotionPublisher(window, {
    onMove: () => { movements += 1; },
    onMotion: (state) => { states.push(state); },
  });
  return { window, contents, states, cleanup, get movements() { return movements; } };
}

it("accumulates slow horizontal movement and changes direction only after actual travel", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pet = fixture();
  context.after(pet.cleanup);
  pet.window.moveTo(1, 0);
  pet.window.moveTo(2, 0);
  assert.deepEqual(pet.states, []);
  pet.window.moveTo(3, 0);
  assert.deepEqual(pet.states, ["run-right"]);
  pet.window.moveTo(4, 0);
  pet.window.moveTo(6, 0);
  assert.deepEqual(pet.states, ["run-right"], "continued travel does not restart the run animation");
  pet.window.moveTo(5, 0);
  pet.window.moveTo(4, 0);
  assert.deepEqual(pet.states, ["run-right"]);
  pet.window.moveTo(3, 0);
  assert.deepEqual(pet.states, ["run-right", "run-left"]);
});

it("gives vertical travel a stable locomotion direction", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pet = fixture();
  context.after(pet.cleanup);
  pet.window.moveTo(0, 1);
  pet.window.moveTo(0, 2);
  pet.window.moveTo(0, 3);
  assert.deepEqual(pet.states, ["run-right"]);
  pet.window.moveTo(-3, 3);
  assert.deepEqual(pet.states, ["run-right", "run-left"]);
  context.mock.timers.tick(180);
  pet.window.moveTo(-3, 2);
  pet.window.moveTo(-3, 0);
  assert.deepEqual(pet.states, ["run-right", "run-left", "idle", "run-left"],
    "vertical travel keeps the last horizontal facing after a rest");
});

it("ignores duplicate native events and becomes idle after 180ms without movement", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pet = fixture();
  context.after(pet.cleanup);
  pet.window.moveTo(3, 0);
  context.mock.timers.tick(179);
  pet.window.emit("moved");
  pet.window.emit("move");
  assert.equal(pet.movements, 1);
  assert.deepEqual(pet.states, ["run-right"]);
  context.mock.timers.tick(1);
  assert.deepEqual(pet.states, ["run-right", "idle"]);
});

it("does not combine tiny movements separated by a rest into a new run", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pet = fixture();
  context.after(pet.cleanup);
  pet.window.moveTo(2, 0);
  context.mock.timers.tick(180);
  pet.window.moveTo(3, 0);
  assert.deepEqual(pet.states, []);
  pet.window.moveTo(5, 0);
  assert.deepEqual(pet.states, ["run-right"]);
});

it("clears old movement on navigation and synchronizes the fresh document", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pet = fixture();
  context.after(pet.cleanup);
  pet.window.moveTo(3, 0);
  pet.contents.emit("did-start-loading");
  assert.deepEqual(pet.states, ["run-right", "idle"]);
  pet.window.x = 100;
  pet.contents.emit("did-finish-load");
  assert.deepEqual(pet.states, ["run-right", "idle", "idle"]);
  context.mock.timers.tick(180);
  assert.equal(pet.states.length, 3, "the old document's idle timer was cancelled");
  pet.window.moveTo(101, 0);
  assert.equal(pet.states.length, 3, "loading reanchors position rather than treating layout as travel");
  pet.window.moveTo(103, 0);
  assert.equal(pet.states.at(-1), "run-right");
});

it("removes listeners and pending idle work after the native window is closed", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pet = fixture();
  pet.window.moveTo(3, 0);
  pet.window.destroyed = true;
  assert.doesNotThrow(() => pet.window.emit("closed"));
  assert.equal(pet.window.listenerCount("move"), 0);
  assert.equal(pet.window.listenerCount("moved"), 0);
  assert.equal(pet.contents.listenerCount("did-start-loading"), 0);
  assert.equal(pet.contents.listenerCount("did-finish-load"), 0);
  context.mock.timers.tick(180);
  pet.contents.emit("did-finish-load");
  assert.deepEqual(pet.states, ["run-right"]);
  pet.cleanup();
});

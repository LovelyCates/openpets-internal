import type { PetMotionState } from "@open-pets/pet-format/animation";

interface MotionEventSource {
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

interface PetMotionWindow extends MotionEventSource {
  readonly webContents: MotionEventSource;
  getPosition(): readonly number[];
  isDestroyed(): boolean;
}

/** Publish one movement state without restarting it for every native move event. */
export function installPetWindowMotionPublisher(window: PetMotionWindow, callbacks: {
  readonly onMove: () => void;
  readonly onMotion: (state: PetMotionState) => void;
}): () => void {
  const contents = window.webContents;
  let [lastX = 0, lastY = 0] = window.getPosition();
  let anchorX = lastX;
  let anchorY = lastY;
  let direction: PetMotionState = "run-right";
  let lastSent: PetMotionState = "idle";
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const clearIdleTimer = (): void => {
    if (idleTimer === undefined) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const sendMotion = (state: PetMotionState, force = false): void => {
    if (disposed || window.isDestroyed() || (!force && lastSent === state)) return;
    lastSent = state;
    callbacks.onMotion(state);
  };

  const resetPosition = (): void => {
    [lastX = 0, lastY = 0] = window.getPosition();
    anchorX = lastX;
    anchorY = lastY;
  };

  const onMove = (): void => {
    if (disposed || window.isDestroyed()) return;
    const [x = 0, y = 0] = window.getPosition();
    // Electron can emit both move and moved for the same position. Neither a
    // duplicate state nor a duplicate position should extend its animation.
    if (x === lastX && y === lastY) return;
    lastX = x;
    lastY = y;
    callbacks.onMove();

    const deltaX = x - anchorX;
    const deltaY = y - anchorY;
    if (Math.abs(deltaX) >= 3 || Math.abs(deltaY) >= 3) {
      // Preserve the last horizontal facing for vertical travel; the existing
      // sprite and Motion contracts expose left/right locomotion only.
      if (Math.abs(deltaX) >= 3) direction = deltaX > 0 ? "run-right" : "run-left";
      sendMotion(direction);
      anchorX = x;
      anchorY = y;
    }

    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      anchorX = lastX;
      anchorY = lastY;
      sendMotion("idle");
    }, 180);
  };

  const onLoading = (): void => {
    clearIdleTimer();
    if (disposed || window.isDestroyed()) return;
    resetPosition();
    sendMotion("idle");
  };

  const onLoaded = (): void => {
    clearIdleTimer();
    if (disposed || window.isDestroyed()) return;
    resetPosition();
    // A fresh document has not received the state sent to the old renderer.
    sendMotion("idle", true);
  };

  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    clearIdleTimer();
    window.removeListener("move", onMove);
    window.removeListener("moved", onMove);
    window.removeListener("closed", cleanup);
    contents.removeListener("did-start-loading", onLoading);
    contents.removeListener("did-finish-load", onLoaded);
  };

  window.on("move", onMove);
  window.on("moved", onMove);
  window.on("closed", cleanup);
  contents.on("did-start-loading", onLoading);
  contents.on("did-finish-load", onLoaded);
  return cleanup;
}

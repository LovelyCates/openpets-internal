import { screen, type BrowserWindow } from "electron";

import { isIdleCursorGazeEnabled } from "./app-state.js";
import { defaultPetScale } from "./app-state-core.js";
import { codexV2SpriteLayout } from "@open-pets/pet-format/sprite-layout";
import { type CodexPetGazeAnchor } from "@open-pets/pet-format/metadata";
import { codexV2GazeMaxGlanceMs, codexV2GazeRestMs, getCodexV2GazeAnchorPoint, getCodexV2GazeSpritePosition, isCodexV2GazeActive, mirrorCodexV2GazeIndex, resolveCodexV2GazeDirection, shouldTrackCodexV2Gaze } from "./codex-pets-core.js";
import type { Point } from "./display.js";
import { getPetWindowSpriteBottomInset } from "./pet-window-shape.js";
import type { PetContentRender } from "./pet-window-types.js";
import type { PetMotionState, UniversalSpriteState } from "@open-pets/pet-format/animation";

interface PetGazeEntry {
  readonly window: BrowserWindow;
  codexSpriteVersion: 1 | 2;
  paused: boolean;
  reactionState: UniversalSpriteState;
  motionState: PetMotionState;
  flipped: boolean;
  gazeAnchor: CodexPetGazeAnchor | undefined;
  layoutPetScale: number;
  petScaleOverride: number | null;
  gazeSpriteBottomInset: number;
  pluginSpriteOverride: boolean;
  activityOverride: boolean;
  rendererReady: boolean;
  reducedMotion: boolean | null;
  dragging: boolean;
  movementSuspended: boolean;
  movementTimer: NodeJS.Timeout | null;
  movementGeneration: number;
  lastBounds: Electron.Rectangle | null;
  lastDirection: number | null;
  trackedDirection: number | null;
  glanceStartedAt: number | null;
  nextGlanceAt: number;
}

const petGazeEntries = new Map<BrowserWindow, PetGazeEntry>();
let petGazeTicker: NodeJS.Timeout | null = null;
const petGazeTickerIntervalMs = 50;
let petGazeCursorPoint: Point | null = null;
let petGazeLastCursorMovedAt: number | null = null;

export function registerPetGazeWindow(window: BrowserWindow): void {
  if (petGazeEntries.has(window)) return;
  const entry: PetGazeEntry = {
    window,
    codexSpriteVersion: 1,
    paused: false,
    reactionState: "idle",
    motionState: "idle",
    flipped: false,
    gazeAnchor: undefined,
    layoutPetScale: defaultPetScale,
    petScaleOverride: null,
    gazeSpriteBottomInset: getPetWindowSpriteBottomInset(false),
    pluginSpriteOverride: false,
    activityOverride: false,
    rendererReady: false,
    reducedMotion: null,
    dragging: false,
    movementSuspended: false,
    movementTimer: null,
    movementGeneration: 0,
    lastBounds: null,
    lastDirection: null,
    trackedDirection: null,
    glanceStartedAt: null,
    nextGlanceAt: 0,
  };
  petGazeEntries.set(window, entry);

  const resetForNavigation = (): void => resetPetGazeWindow(window);
  const handleLoad = (): void => setPetGazeRendererReady(window);
  const handleRendererGone = (): void => resetPetGazeWindow(window);
  const handleHide = (): void => {
    const current = petGazeEntries.get(window);
    if (!current) return;
    if (current.movementTimer) {
      clearTimeout(current.movementTimer);
      current.movementTimer = null;
    }
    current.movementGeneration += 1;
    current.movementSuspended = false;
    current.dragging = false;
    current.lastBounds = null;
    resetPetGazeDirection(current);
    syncPetGazeTicker();
  };
  const handleShow = (): void => forcePetGazeEvaluation(window);
  // Held directly: `closed` fires after destroy(), when the
  // `window.webContents` getter throws "Object has been destroyed".
  const webContents = window.webContents;
  webContents.on("did-start-navigation", resetForNavigation);
  webContents.on("did-start-loading", resetForNavigation);
  webContents.on("did-finish-load", handleLoad);
  webContents.on("did-fail-load", resetForNavigation);
  webContents.on("render-process-gone", handleRendererGone);
  window.on("hide", handleHide);
  window.on("show", handleShow);
  const remove = (): void => {
    const current = petGazeEntries.get(window);
    if (!current) return;
    if (current.movementTimer) clearTimeout(current.movementTimer);
    if (!webContents.isDestroyed()) {
      webContents.off("did-start-navigation", resetForNavigation);
      webContents.off("did-start-loading", resetForNavigation);
      webContents.off("did-finish-load", handleLoad);
      webContents.off("did-fail-load", resetForNavigation);
      webContents.off("render-process-gone", handleRendererGone);
    }
    window.off("hide", handleHide);
    window.off("show", handleShow);
    petGazeEntries.delete(window);
    syncPetGazeTicker();
  };
  window.once("closed", remove);
}

function stopPetGazeTicker(): void {
  if (petGazeTicker) clearInterval(petGazeTicker);
  petGazeTicker = null;
  petGazeCursorPoint = null;
  petGazeLastCursorMovedAt = null;
}

function syncPetGazeTicker(): void {
  const needsTicker = [...petGazeEntries.values()].some(isPetGazeEligible);
  if (!needsTicker) {
    stopPetGazeTicker();
    return;
  }
  if (petGazeTicker) return;
  petGazeTicker = setInterval(tickPetGaze, petGazeTickerIntervalMs);
  petGazeTicker.unref?.();
}

function isPetGazeEligible(entry: PetGazeEntry): boolean {
  return shouldTrackCodexV2Gaze({
    spriteVersion: entry.codexSpriteVersion,
    idleCursorGazeEnabled: isIdleCursorGazeEnabled(),
    paused: entry.paused,
    reactionState: entry.reactionState,
    motionState: entry.motionState,
    pluginSpriteOverride: entry.pluginSpriteOverride,
  })
    && !entry.dragging
    && !entry.activityOverride
    && !entry.movementSuspended
    && entry.reducedMotion === false
    && entry.rendererReady
    && !entry.window.isDestroyed()
    && entry.window.isVisible()
    && !entry.window.webContents.isDestroyed();
}

/** Apply an idle cursor-gaze preference change without waiting for the ticker. */
export function refreshPetGazePreference(): void {
  const enabled = isIdleCursorGazeEnabled();
  for (const entry of petGazeEntries.values()) {
    resetPetGazeDirection(entry);
    if (enabled) forcePetGazeEvaluation(entry.window);
  }
  syncPetGazeTicker();
}

function sendPetGaze(entry: PetGazeEntry, direction: number | null): void {
  if (!entry.rendererReady || entry.window.isDestroyed() || entry.window.webContents.isDestroyed()) return;
  if (entry.lastDirection === direction) return;
  entry.lastDirection = direction;
  entry.window.webContents.send("openpets:pet-gaze", { index: direction });
}

function resetPetGazeDirection(entry: PetGazeEntry): void {
  const hadDirection = entry.lastDirection !== null;
  entry.lastDirection = null;
  entry.trackedDirection = null;
  entry.glanceStartedAt = null;
  entry.nextGlanceAt = 0;
  if (!hadDirection || !entry.rendererReady || entry.window.isDestroyed() || entry.window.webContents.isDestroyed()) return;
  entry.window.webContents.send("openpets:pet-gaze", { index: null });
}

function finishPetGazeGlance(entry: PetGazeEntry, now: number): void {
  if (entry.glanceStartedAt !== null) {
    entry.nextGlanceAt = now + codexV2GazeRestMs;
  }
  entry.glanceStartedAt = null;
  entry.trackedDirection = null;
  sendPetGaze(entry, null);
}

function evaluatePetGaze(entry: PetGazeEntry, cursor: Point, now = Date.now()): void {
  if (!isPetGazeEligible(entry)) {
    if (!entry.rendererReady || entry.window.isDestroyed() || entry.window.webContents.isDestroyed()) entry.lastDirection = null;
    else resetPetGazeDirection(entry);
    return;
  }
  if (!isCodexV2GazeActive(petGazeLastCursorMovedAt, now)
    || now < entry.nextGlanceAt
    || (entry.glanceStartedAt !== null && now - entry.glanceStartedAt >= codexV2GazeMaxGlanceMs)) {
    finishPetGazeGlance(entry, now);
    return;
  }
  let bounds: Electron.Rectangle;
  try {
    bounds = entry.window.getContentBounds();
  } catch {
    resetPetGazeDirection(entry);
    return;
  }
  const direction = resolveCodexV2GazeDirection(
    cursor,
    getCodexV2GazeAnchorPoint(
      bounds,
      { width: codexV2SpriteLayout.frameWidth, height: codexV2SpriteLayout.frameHeight },
      entry.layoutPetScale,
      entry.petScaleOverride,
      entry.gazeAnchor,
      entry.flipped,
      entry.gazeSpriteBottomInset,
    ),
    entry.trackedDirection,
  );
  if (direction === null) {
    finishPetGazeGlance(entry, now);
    return;
  }
  if (entry.glanceStartedAt === null) entry.glanceStartedAt = now;
  entry.trackedDirection = direction;
  const selected = getCodexV2GazeSpritePosition(direction, entry.flipped);
  const selectedDirection = entry.flipped ? mirrorCodexV2GazeIndex(direction) : direction;
  sendPetGaze(entry, selected ? selectedDirection : null);
}

function updatePetGazeCursor(cursor: Point, now: number): void {
  if (!petGazeCursorPoint) {
    petGazeCursorPoint = cursor;
    return;
  }
  if (Math.hypot(petGazeCursorPoint.x - cursor.x, petGazeCursorPoint.y - cursor.y) < 3) return;
  petGazeCursorPoint = cursor;
  petGazeLastCursorMovedAt = now;
}

function tickPetGaze(): void {
  if (![...petGazeEntries.values()].some(isPetGazeEligible)) {
    for (const entry of petGazeEntries.values()) evaluatePetGaze(entry, { x: 0, y: 0 });
    syncPetGazeTicker();
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  const now = Date.now();
  updatePetGazeCursor(cursor, now);
  for (const entry of petGazeEntries.values()) {
    if (!entry.window.isDestroyed() && !entry.window.webContents.isDestroyed() && entry.window.isVisible()) {
      try {
        const bounds = entry.window.getContentBounds();
        const previous = entry.lastBounds;
        entry.lastBounds = bounds;
        if (previous && (previous.x !== bounds.x || previous.y !== bounds.y || previous.width !== bounds.width || previous.height !== bounds.height)) {
          suspendPetGazeForMovement(entry.window);
        }
      } catch {
        entry.lastBounds = null;
      }
    }
    evaluatePetGaze(entry, cursor, now);
  }
}

function forcePetGazeEvaluation(window: BrowserWindow): void {
  const entry = petGazeEntries.get(window);
  if (!entry || !entry.rendererReady || window.isDestroyed() || window.webContents.isDestroyed() || !window.isVisible()) return;
  evaluatePetGaze(entry, screen.getCursorScreenPoint());
  syncPetGazeTicker();
}

export function resetPetGazeWindow(window: BrowserWindow): void {
  const entry = petGazeEntries.get(window);
  if (!entry) return;
  if (entry.movementTimer) {
    clearTimeout(entry.movementTimer);
    entry.movementTimer = null;
  }
  entry.movementGeneration += 1;
  entry.rendererReady = false;
  entry.reducedMotion = null;
  entry.dragging = false;
  entry.motionState = "idle";
  entry.movementSuspended = false;
  entry.lastBounds = null;
  resetPetGazeDirection(entry);
  syncPetGazeTicker();
}

export function setPetGazeRendererReady(window: BrowserWindow): void {
  const entry = petGazeEntries.get(window);
  if (!entry || window.isDestroyed() || window.webContents.isDestroyed()) return;
  entry.rendererReady = true;
  if (entry.petScaleOverride !== null) {
    window.webContents.send("openpets:pet-scale-override", entry.petScaleOverride);
  }
  forcePetGazeEvaluation(window);
}

/** Only the current renderer's validated motion-preference report may enable gaze. */
export function setPetGazeReducedMotion(window: BrowserWindow, reducedMotion: boolean | null): void {
  const entry = petGazeEntries.get(window);
  if (!entry || entry.reducedMotion === reducedMotion) return;
  entry.reducedMotion = reducedMotion;
  resetPetGazeDirection(entry);
  if (reducedMotion === false) forcePetGazeEvaluation(window);
  syncPetGazeTicker();
}

export function updatePetGazeConfiguration(window: BrowserWindow, render: PetContentRender, flipped: boolean): void {
  const entry = petGazeEntries.get(window);
  if (!entry) return;
  const changed = entry.codexSpriteVersion !== render.codexSpriteVersion
    || entry.paused !== render.paused
    || entry.reactionState !== render.reactionState
    || entry.flipped !== flipped
    || entry.gazeAnchor?.x !== render.gazeAnchor?.x
    || entry.gazeAnchor?.y !== render.gazeAnchor?.y
    || entry.layoutPetScale !== render.petScale
    || entry.gazeSpriteBottomInset !== render.gazeSpriteBottomInset;
  entry.codexSpriteVersion = render.codexSpriteVersion;
  entry.paused = render.paused;
  entry.reactionState = render.reactionState;
  entry.flipped = flipped;
  entry.gazeAnchor = render.gazeAnchor;
  entry.layoutPetScale = render.petScale;
  entry.gazeSpriteBottomInset = render.gazeSpriteBottomInset;
  if (changed) resetPetGazeDirection(entry);
  syncPetGazeTicker();
}

/** Keep the gaze target in sync with the transient renderer scale override. */
export function setPetGazeScale(window: BrowserWindow, scale: number): void {
  const entry = petGazeEntries.get(window);
  if (!entry || !Number.isFinite(scale) || scale <= 0) return;
  entry.petScaleOverride = scale;
  resetPetGazeDirection(entry);
  forcePetGazeEvaluation(window);
}

export function setPetGazeMotionState(window: BrowserWindow, state: PetMotionState): void {
  const entry = petGazeEntries.get(window);
  if (!entry) return;
  entry.motionState = state;
  if (state !== "idle") resetPetGazeDirection(entry);
  syncPetGazeTicker();
  if (state === "idle") forcePetGazeEvaluation(window);
}

export function setPetGazeDragging(window: BrowserWindow, dragging: boolean): void {
  const entry = petGazeEntries.get(window);
  if (!entry) return;
  entry.dragging = dragging;
  if (dragging) resetPetGazeDirection(entry);
  syncPetGazeTicker();
}

export function suspendPetGazeForMovement(window: BrowserWindow): void {
  const entry = petGazeEntries.get(window);
  if (!entry) return;
  entry.movementSuspended = true;
  entry.lastBounds = null;
  resetPetGazeDirection(entry);
  if (entry.movementTimer) clearTimeout(entry.movementTimer);
  const movementGeneration = ++entry.movementGeneration;
  entry.movementTimer = setTimeout(() => {
    if (entry.movementGeneration !== movementGeneration) return;
    entry.movementTimer = null;
    entry.movementSuspended = false;
    syncPetGazeTicker();
    forcePetGazeEvaluation(window);
  }, 180);
  entry.movementTimer.unref?.();
  syncPetGazeTicker();
}

export function setPetGazeReactionState(window: BrowserWindow, state: UniversalSpriteState): void {
  const entry = petGazeEntries.get(window);
  if (!entry) return;
  entry.reactionState = state;
  if (state !== "idle") resetPetGazeDirection(entry);
  syncPetGazeTicker();
}

export function setPetGazePluginOverride(window: BrowserWindow, active: boolean): void {
  const entry = petGazeEntries.get(window);
  if (!entry) return;
  entry.pluginSpriteOverride = active;
  resetPetGazeDirection(entry);
  syncPetGazeTicker();
}

export function setPetGazeActivityOverride(window: BrowserWindow, active: boolean): void {
  const entry = petGazeEntries.get(window);
  if (!entry) return;
  entry.activityOverride = active;
  resetPetGazeDirection(entry);
  syncPetGazeTicker();
}

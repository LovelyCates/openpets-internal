import { randomBytes } from "node:crypto";
import net from "node:net";

import { app, Notification, shell, systemPreferences, type BrowserWindow } from "electron";

import { applyAgentPetReaction, applyAgentPetSay, applyAgentPetShowMedia, clearAgentPetLeaseState, getAgentPetWindow, refreshAgentPetContent, repositionConfinedPet, showAgentPet } from "./agent-pet-controller.js";
import { getAppStateSnapshot, isOpenCodeTokenRateDisplayEnabled, recordOpenPetsActivity } from "./app-state.js";
import { builtInPet } from "./built-in-pet.js";
import { applyExternalPetReaction, applyExternalPetSay, applyExternalPetShowMedia, getDefaultPetPaused, getDefaultPetWindowForPlugins, isDefaultPetVisible, refreshDefaultPetContent } from "./default-pet-controller.js";
import { LeaseManager } from "./lease-manager.js";
import { debug, error as logError, info } from "./logger.js";
import { cleanupUnixSocket, getDiscoveryFilePath, getIpcEndpointConfig, parseIpcEndpoint, protectUnixSocket, removeDiscoveryFile, writeDiscoveryFile, type IpcEndpoint, type IpcEndpointConfig, type OpenPetsDiscoveryFile } from "./local-ipc-paths.js";
import { stat } from "node:fs/promises";
import { installPet, installPetFromFolderWithResult, installPetFromZipFileWithResult } from "./pet-installation.js";
import { clearConfinementState, setConfinementState } from "./confinement-manager.js";
import { isConfinementSupported } from "./capabilities.js";
import { findTerminalWindowForPid, subscribeWindowTracking } from "./window-tracker.js";
import { warnPetFallback } from "./pet-fallback-notify.js";
import { getEligiblePoolPetIds, resolvePoolAssignment } from "./pet-pool.js";
import { t } from "./i18n/index.js";
import { broadcastLanPetActivity } from "./lan-controller.js";
import { createLocalIpcRequestHandler } from "./local-ipc-request-handler.js";
import { handleLocalIpcSocket } from "./local-ipc-transport.js";
import { createLocalIpcConfinementCoordinator, type LocalIpcConfinementCoordinator } from "./local-ipc-confinement.js";
import { formatOpenCodeTokenRate, openCodeTokenRateStore } from "./opencode-token-rate.js";

let ipcServer: net.Server | null = null;
let ipcDiscovery: OpenPetsDiscoveryFile | null = null;
let leaseCleanupTimer: NodeJS.Timeout | null = null;
let tokenRateCleanupTimer: NodeJS.Timeout | null = null;
const tokenRateFinalHoldTimers = new Map<string, NodeJS.Timeout>();
const tokenDockVisibility = new WeakMap<BrowserWindow, boolean>();
/** leaseId → window-tracking unsubscribe function (for confined agent pets). */
let confinementCoordinator: LocalIpcConfinementCoordinator;
const leaseManager = new LeaseManager({
  resolveTarget: resolveLeaseTarget,
  getDefaultPetId: () => getCurrentDefaultPet().id,
  getPetDisplayName: (petId, targetKind) => targetKind === "default" ? getCurrentDefaultPet().displayName : getPetDisplayName(petId),
  onFirstExplicitLease: handleFirstExplicitLease,
  onLastExplicitLease: handleLastExplicitLease,
  onLeaseReleased: (lease) => {
    confinementCoordinator.stopLease(lease.leaseId);
    openCodeTokenRateStore.clearLease(lease.leaseId);
  },
  onLog: (level, message, fields) => level === "debug" ? debug("lease", message, fields) : info("lease", message, fields),
  isPetEligible,
});

openCodeTokenRateStore.subscribe((target) => {
  const window = target.kind === "default"
    ? getDefaultPetWindowForPlugins()
    : getAgentPetWindow(target.petId);
  if (!window || window.webContents.isDestroyed()) return;
  const display = formatOpenCodeTokenRate(
    openCodeTokenRateStore.readDisplay(target),
    t("pet.tokenRate.output"),
    t("pet.tokenRate.idle"),
    t("pet.tokenRate.lastOutput"),
    t("pet.tokenRate.live"),
  );
  const hasTokenDock = isOpenCodeTokenRateDisplayEnabled() && display !== null;
  const hadTokenDock = tokenDockVisibility.get(window) ?? false;
  tokenDockVisibility.set(window, hasTokenDock);
  if (hadTokenDock !== hasTokenDock) {
    // Presence changes the pet, gaze and Linux-mask geometry. Numeric updates
    // stay on the lightweight DOM path and do not restart the sprite clock.
    debug("ipc", "OpenCode usage dock visibility changed", { windowId: window.id, visible: hasTokenDock, targetKind: target.kind });
    if (target.kind === "default") refreshDefaultPetContent();
    else refreshAgentPetContent(target.petId);
  }
  window.webContents.send("openpets:pet-token-rate", display);
});

/** Tracks requestedPetIds for which we have already shown a fallback warning notification. */
const warnedFallbackPets = new Set<string>();

/** PIDs of sessions that had pool pets when pool was disabled. Used to respawn on re-enable. */
const suspendedPoolSessions = new Map<number, string | undefined>();

const safePetIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

confinementCoordinator = createLocalIpcConfinementCoordinator({
  getRawLease: (leaseId) => leaseManager.getRawLease(leaseId),
  findTerminalWindow: findTerminalWindowForPid,
  subscribeWindowTracking,
  setTerminalIdentity: (leaseId, terminalInfo) => leaseManager.setTerminalIdentity(leaseId, {
    terminalOwnerPid: terminalInfo.terminalPid,
    terminalAppName: terminalInfo.appName,
    terminalWindowId: terminalInfo.window?.id,
  }),
  setConfinementState,
  repositionConfinedPet,
  clearConfinementState,
  getScreenPermissionStatus: () =>
    process.platform === "darwin"
      ? systemPreferences.getMediaAccessStatus("screen")
      : "granted",
  promptScreenPermission: () => {
    if (process.platform === "darwin") {
      void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    }
  },
  notifyScreenPermission: (leaseId, onAction) => {
    if (process.platform !== "darwin") return;
    info("ipc", "Screen Recording permission not granted — showing notification", {
      leaseId,
      status: systemPreferences.getMediaAccessStatus("screen"),
    });
    if (!Notification.isSupported()) return;
    const title = t("confinement.screenPermission.title");
    const body = t("confinement.screenPermission.body");
    const notification = new Notification({ title, body, silent: true });
    notification.on("click", onAction);
    notification.show();
  },
  log: (message, fields) => info("ipc", message, fields),
});

const handleRawRequest = createLocalIpcRequestHandler({
  getAppVersion: () => ipcDiscovery?.appVersion ?? "0.0.0",
  getAppStateSnapshot,
  builtInPet,
  getDefaultPetPaused,
  isDefaultPetVisible,
  installPet,
  installPetFromFolderWithResult,
  installPetFromZipFileWithResult,
  stat,
  acquireLease: (requestedPetId, clientPid, sessionNonce) => leaseManager.acquire(requestedPetId, clientPid, sessionNonce),
  getLease: (leaseId) => leaseManager.get(leaseId),
  heartbeatLease: (leaseId) => leaseManager.heartbeat(leaseId),
  releaseLease: (leaseId) => leaseManager.release(leaseId),
  onLeaseAcquired: (requestedPetId, lease, clientPid) => {
    warnPetFallback(requestedPetId, lease.fallbackReason, warnedFallbackPets);
    // Resolve terminal window identity asynchronously (non-blocking).
    // Only attempt on macOS where window-bounds polling is supported.
    if (clientPid !== undefined && isConfinementSupported()) {
      void confinementCoordinator.trackLease(lease.leaseId, clientPid);
    }
  },
  applyAgentPetReaction,
  applyAgentPetSay,
  applyAgentPetShowMedia,
  applyExternalPetReaction,
  applyExternalPetSay,
  applyExternalPetShowMedia,
  updateTokenRate: (sessionId, leaseId, target, reading) => openCodeTokenRateStore.update(sessionId, leaseId, target, reading),
  broadcastLanPetActivity,
  recordOpenPetsActivity,
  debug: (message, fields) => debug("ipc", message, fields),
  logError: (error, requestId) => logError("ipc", "request failed", error instanceof Error ? error : { requestId, error }),
});

export async function startLocalIpcServer(): Promise<void> {
  if (ipcServer) {
    debug("ipc", "start skipped", { reason: "already-started" });
    return;
  }

  const endpointConfig = getIpcEndpointConfig();
  const token = randomBytes(32).toString("base64url");
  cleanupUnixSocket(endpointConfig.advertisedEndpoint);

  const server = net.createServer((socket) => handleSocket(socket, token, endpointConfig));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    listenOnEndpoint(server, endpointConfig.bindEndpoint, () => {
      server.off("error", reject);
      protectUnixSocket(endpointConfig.advertisedEndpoint);
      resolve();
    });
  });
  server.on("error", (error) => {
    logError("ipc", "server error", error);
    console.error("OpenPets local IPC server error.", error);
  });

  ipcServer = server;
  const listeningEndpoint = getListeningEndpoint(server, endpointConfig);
  ipcDiscovery = writeDiscoveryFile(listeningEndpoint, token, app.getVersion());
  leaseCleanupTimer = setInterval(() => {
    leaseManager.cleanupExpired();
    leaseManager.checkPidLiveness();
  }, 5_000);
  leaseCleanupTimer.unref?.();
  tokenRateCleanupTimer = setInterval(() => openCodeTokenRateStore.sweepExpired(), 1_000);
  tokenRateCleanupTimer.unref?.();
  info("ipc", "server started", { endpointKind: endpointConfig.bindEndpoint.kind, bindEndpoint: formatEndpoint(endpointConfig.bindEndpoint), advertisedEndpoint: listeningEndpoint, discoveryPath: getDiscoveryFilePath() });
  console.log(`OpenPets local IPC listening at ${listeningEndpoint}.`);
}

export function stopLocalIpcServer(): void {
  const server = ipcServer;
  const discovery = ipcDiscovery;
  ipcServer = null;
  ipcDiscovery = null;
  info("ipc", "server stopping", { hadServer: Boolean(server), discoveryPath: discovery ? getDiscoveryFilePath() : undefined, endpoint: discovery?.endpoint });
  if (leaseCleanupTimer) clearInterval(leaseCleanupTimer);
  leaseCleanupTimer = null;
  if (tokenRateCleanupTimer) clearInterval(tokenRateCleanupTimer);
  tokenRateCleanupTimer = null;
  for (const [petId, timer] of tokenRateFinalHoldTimers) {
    clearTimeout(timer);
    clearAgentPetLeaseState(petId);
  }
  tokenRateFinalHoldTimers.clear();
  openCodeTokenRateStore.clearAll();
  removeDiscoveryFile(discovery);

  if (server) {
    server.close();
  }

  if (discovery) {
    cleanupUnixSocket(discovery.endpoint);
  }
}

/**
 * Handle petPoolEnabled toggle: despawn all active pool pets on disable,
 * respawn pets for still-alive sessions on re-enable.
 * Must be called AFTER the preference has been updated in app state.
 */
export function dispatchPoolToggle(enabled: boolean): void {
  if (!enabled) {
    // Despawn all active pool pets and remember their PIDs for respawn.
    const explicitLeases = leaseManager.getExplicitLeaseSnapshots();
    for (const lease of explicitLeases) {
      const rawLease = leaseManager.getRawLease(lease.leaseId);
      if (!rawLease || rawLease.requestedPetId !== undefined) continue;
      if (lease.clientPid && lease.clientPid > 0) {
        suspendedPoolSessions.set(lease.clientPid, rawLease.sessionNonce);
      }
      leaseManager.release(lease.leaseId);
    }
  } else {
    // Re-enable: spawn pets for suspended sessions whose PIDs are still alive.
    const sessionsToRespawn = [...suspendedPoolSessions];
    suspendedPoolSessions.clear();
    for (const [pid, sessionNonce] of sessionsToRespawn) {
      try {
        process.kill(pid, 0);
      } catch {
        continue; // Dead process — skip.
      }
      try {
        leaseManager.acquire(undefined, pid, sessionNonce);
        info("ipc", "respawned pool pet for suspended session", { pid });
      } catch (err) {
        debug("ipc", "pool respawn acquire failed", { pid, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}

function handleSocket(socket: net.Socket, token: string, endpointConfig: IpcEndpointConfig): void {
  const bindEndpoint = endpointConfig.bindEndpoint;
  if (bindEndpoint.kind === "tcp" && !isAllowedRemoteAddress(socket.remoteAddress, bindEndpoint.host)) {
    info("ipc", "socket rejected", { reason: "unauthorized-remote", remoteAddress: socket.remoteAddress, bindHost: bindEndpoint.host });
    socket.destroy();
    return;
  }

  debug("ipc", "socket accepted", { endpointKind: bindEndpoint.kind, remoteAddress: socket.remoteAddress });

  handleLocalIpcSocket(socket, token, handleRawRequest, (bytes) => {
    info("ipc", "request rejected", { reason: "too-large", bytes });
  });

  socket.on("error", (error) => {
    if (isBenignSocketCloseError(error)) return;
    logError("ipc", "client socket error", error);
    console.error("OpenPets local IPC client socket error.", error);
  });
}

function listenOnEndpoint(server: net.Server, endpoint: IpcEndpoint, callback: () => void): void {
  if (endpoint.kind === "tcp") {
    server.listen({ host: endpoint.host, port: endpoint.port }, callback);
    return;
  }

  server.listen(endpoint.path, callback);
}

function getListeningEndpoint(server: net.Server, endpointConfig: IpcEndpointConfig): string {
  const bindEndpoint = endpointConfig.bindEndpoint;
  if (bindEndpoint.kind !== "tcp") return bindEndpoint.path;

  const address = server.address();
  const actualPort = (!address || typeof address === "string") ? bindEndpoint.port : address.port;

  // Use the advertised endpoint if it's different from bind endpoint
  const advertisedParsed = parseIpcEndpoint(endpointConfig.advertisedEndpoint, { allowPortZero: true, allowNonLoopback: true });
  if (advertisedParsed.kind === "tcp" && advertisedParsed.host !== bindEndpoint.host) {
    // Use advertised host with actual port (in case bind used port 0)
    return `tcp://${advertisedParsed.host}:${actualPort}`;
  }

  return `tcp://${bindEndpoint.host}:${actualPort}`;
}

function formatEndpoint(endpoint: IpcEndpoint): string {
  if (endpoint.kind === "tcp") return `tcp://${endpoint.host}:${endpoint.port}`;
  return endpoint.path;
}

function isAllowedRemoteAddress(address: string | undefined, bindHost: string): boolean {
  if (!address) return false;

  // Always allow loopback
  if (address === "::1" || isLoopbackAddress(address)) {
    return true;
  }

  // If binding to 0.0.0.0 or non-loopback, allow private/local addresses
  if (bindHost === "0.0.0.0" || bindHost !== "127.0.0.1") {
    return isPrivateOrLocalAddress(address);
  }

  return false;
}

function isLoopbackAddress(address: string): boolean {
  if (address.startsWith("::ffff:")) {
    address = address.slice(7);
  }

  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts[0] === 127 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
}

function isPrivateOrLocalAddress(address: string): boolean {
  // Handle IPv4-mapped IPv6 addresses
  if (address.startsWith("::ffff:")) {
    address = address.slice(7);
  }

  const parts = address.split(".").map(Number);
  if (parts.length !== 4) return false;

  // Loopback: 127.0.0.0/8
  if (parts[0] === 127) return true;

  // Private: 10.0.0.0/8
  if (parts[0] === 10) return true;

  // Private: 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;

  // Private: 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;

  // Link-local: 169.254.0.0/16
  if (parts[0] === 169 && parts[1] === 254) return true;

  return false;
}

function handleFirstExplicitLease(petId: string): void {
  const pendingHold = tokenRateFinalHoldTimers.get(petId);
  if (pendingHold) {
    clearTimeout(pendingHold);
    tokenRateFinalHoldTimers.delete(petId);
  }
  openCodeTokenRateStore.clearTarget({ kind: "explicit", petId });
  showAgentPet(petId);
}

function handleLastExplicitLease(petId: string): void {
  info("ipc", "last explicit lease ended", { petId });
  confinementCoordinator.clearPetConfinement(petId);

  const holdMs = getAgentPetWindow(petId)
    ? openCodeTokenRateStore.reportedFinalRemainingMs({ kind: "explicit", petId })
    : 0;
  if (holdMs <= 0) {
    clearAgentPetLeaseState(petId);
    return;
  }

  const timer = setTimeout(() => {
    tokenRateFinalHoldTimers.delete(petId);
    if (leaseManager.countExplicitLeases(petId) === 0) {
      clearAgentPetLeaseState(petId);
    }
  }, Math.ceil(holdMs));
  timer.unref?.();
  tokenRateFinalHoldTimers.set(petId, timer);
}

function isBenignSocketCloseError(error: NodeJS.ErrnoException): boolean {
  return error.code === "EPIPE" || error.code === "ECONNRESET" || error.code === "ERR_STREAM_DESTROYED";
}

function resolveLeaseTarget(requestedPetId: string | undefined): { readonly targetKind: "default" | "explicit"; readonly actualPetId: string; readonly fallbackReason?: "invalid_pet_id" | "pet_not_installed" | "pet_broken" | "default_broken_fallback_builtin" } {
  const defaultPet = getCurrentDefaultPetWithFallback();

  if (!requestedPetId) {
    // No explicit pet requested — check pool before falling back to default.
    // INVARIANT: tryResolveFromPool() and the subsequent lease registration in
    // LeaseManager.acquire() MUST remain synchronous (no await between them);
    // otherwise two concurrent acquire(undefined) calls could claim the same slot.
    const poolResult = tryResolveFromPool();
    if (poolResult) return { targetKind: "explicit", actualPetId: poolResult.petId };
    return { targetKind: "default", actualPetId: defaultPet.id, fallbackReason: defaultPet.fallbackReason };
  }

  // Explicit request for the built-in or the current default: honour it directly
  // without consulting the pool (pre-pool semantics, "explicit always wins").
  if (requestedPetId === builtInPet.id || requestedPetId === defaultPet.id) {
    return { targetKind: "default", actualPetId: defaultPet.id };
  }

  if (!safePetIdPattern.test(requestedPetId)) {
    return { targetKind: "default", actualPetId: defaultPet.id, fallbackReason: "invalid_pet_id" };
  }
  const pet = getAppStateSnapshot().pets.installed.find((candidate) => candidate.id === requestedPetId);
  if (!pet) return { targetKind: "default", actualPetId: defaultPet.id, fallbackReason: "pet_not_installed" };
  if (pet.broken) return { targetKind: "default", actualPetId: defaultPet.id, fallbackReason: "pet_broken" };
  return { targetKind: "explicit", actualPetId: pet.id };
}

function tryResolveFromPool(): { readonly petId: string } | null {
  const state = getAppStateSnapshot();
  // Master toggle: when disabled, ignore the pool entirely (legacy shared-default behaviour).
  // Platform-independent — this resolution path runs identically on macOS, Windows and Linux,
  // and for any MCP client (Claude Code CLI, opencode, Cursor, …) that acquires a no-pet lease.
  if (!state.preferences.petPoolEnabled) return null;
  const pool = state.preferences.petPoolOrder;
  if (!pool || pool.length === 0) return null;

  const defaultPet = getCurrentDefaultPet();
  // A pinned pet already owns a persistent window, so the pool must not assign it to a
  // session as well — that would draw the same pet in two windows. When every eligible
  // pet is pinned the pool resolves to null and the session falls back to the default pet.
  const pinnedPets = new Set(state.preferences.pinnedPets ?? []);
  const eligiblePetIds = getEligiblePoolPetIds(state.pets.installed, builtInPet.id, defaultPet.id).filter((petId) => !pinnedPets.has(petId));
  return resolvePoolAssignment({
    orderedPool: pool,
    eligiblePetIds,
    countActiveExplicit: (petId) => leaseManager.countExplicitLeases(petId),
  });
}

function getCurrentDefaultPet(): { readonly id: string; readonly displayName: string } {
  const pet = getCurrentDefaultPetWithFallback();
  return { id: pet.id, displayName: pet.displayName };
}

function getCurrentDefaultPetWithFallback(): { readonly id: string; readonly displayName: string; readonly fallbackReason?: "default_broken_fallback_builtin" } {
  const state = getAppStateSnapshot();
  const configuredDefault = state.pets.installed.find((pet) => pet.id === state.preferences.defaultPetId);
  if (configuredDefault && !configuredDefault.broken) return configuredDefault;
  return { ...builtInPet, fallbackReason: "default_broken_fallback_builtin" };
}

function getPetDisplayName(petId: string): string {
  return getAppStateSnapshot().pets.installed.find((pet) => pet.id === petId)?.displayName ?? petId;
}

function isPetEligible(petId: string): boolean {
  return getAppStateSnapshot().pets.installed.some((pet) => pet.id === petId && !pet.broken);
}

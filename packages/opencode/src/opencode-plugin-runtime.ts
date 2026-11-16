import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { createOpenPetsClient, type OpenPetsClient, type OpenPetsReaction } from "@open-pets/client";
import { pickHookSpeech, type HookSpeechCategory, validateHookSpeech } from "@open-pets/agent-events";

import { sanitizeOpenCodeExcludedReactions, validateOpenPetsPetArg } from "./opencode-previews.js";
import { createOpenCodeTokenRateTracker, type OpenCodeTokenRateUpdate } from "./opencode-token-rate.js";

export interface OpenCodePluginOptions {
  readonly pet?: string;
  readonly debug?: boolean;
  /** Reactions the user wants suppressed. Excluded reactions are silently dropped before any IPC or throttle work. */
  readonly excludeReactions?: readonly OpenPetsReaction[];
}

export interface OpenCodePluginRuntimeOptions extends OpenCodePluginOptions {
  readonly clientFactory?: () => OpenPetsClient;
  readonly schedule?: (work: () => Promise<void>) => void;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly throttlePath?: string;
  readonly debugLog?: (message: string) => void;
  readonly timers?: {
    readonly setInterval: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval> | number;
    readonly clearInterval: (handle: ReturnType<typeof setInterval> | number) => void;
  };
}

export interface OpenCodePluginDecision {
  readonly reaction?: OpenPetsReaction;
  readonly speechCategory?: HookSpeechCategory;
}

export interface OpenCodePluginRuntime {
  readonly event: (event: unknown) => void;
  readonly prompt: (sessionId?: string) => void;
  readonly toolBefore: (tool: string, input: unknown, sessionId?: string, callId?: string) => void;
  readonly toolAfter: (event: unknown) => void;
  readonly reportError: (scope: string, error: unknown) => void;
  readonly cleanup: () => Promise<void>;
}

const speechCooldownMs = 20_000;
const permissionCooldownMs = 3_000;
const continuousReactionRefreshMs = 10_000;

export function isReactionExcluded(reaction: OpenPetsReaction, excludedSet: ReadonlySet<string>): boolean {
  return excludedSet.has(reaction);
}

export function createOpenPetsOpenCodeRuntime(options: OpenCodePluginRuntimeOptions = {}): OpenCodePluginRuntime {
  const pet = options.pet === undefined ? undefined : validateOpenPetsPetArg(options.pet);
  const clientFactory = options.clientFactory ?? (() => createOpenPetsClient({ remote: false, connectTimeoutMs: 500, responseTimeoutMs: 500 }));
  const schedule = options.schedule ?? defaultSchedule;
  const debug = options.debug === true || process.env.OPENPETS_DEBUG === "1";
  const debugLog = options.debugLog ?? ((message) => { if (debug) process.stderr.write(`${message}\n`); });
  const excludedReactions = buildExcludedReactionsSet(options.excludeReactions);
  const tokenRateTracker = createOpenCodeTokenRateTracker(options.now);
  let client: OpenPetsClient | undefined;
  let lease: { readonly leaseId: string; readonly expiresAt?: number } | undefined;
  let tokenRateSessionToClear: string | undefined;
  let tokenRateFinalReported = false;
  let closed = false;
  let cleanupPromise: Promise<void> | undefined;
  let dispatchTail: Promise<void> = Promise.resolve();
  const activeWork = new Set<Promise<void>>();
  let reactionGeneration = 0;
  let tokenRateGeneration = 0;
  let lastSentReaction: OpenPetsReaction | undefined;
  let lastSentAt: number | undefined;
  let activityGeneration = 0;
  let pendingPermissionResume: { readonly activity: number } | undefined;
  let lastSentActivity = -1;
  let activeSessionId: string | undefined;
  let executionActive = false;
  const completedSessions = new Map<string | undefined, "succeeded" | "failed">();
  const activeTools = new Map<string, OpenPetsReaction | undefined>();
  let toolTrackingOverflow = false;
  const now = () => options.now?.() ?? Date.now();
  const timers = options.timers ?? {
    setInterval: (callback: () => void, delayMs: number) => setInterval(callback, delayMs),
    clearInterval: (handle: ReturnType<typeof setInterval> | number) => clearInterval(handle),
  };
  let keepaliveTimer: ReturnType<typeof setInterval> | number | undefined;
  let currentActivityReaction: OpenPetsReaction | undefined;

  const stopKeepalive = (): void => {
    if (keepaliveTimer === undefined) return;
    timers.clearInterval(keepaliveTimer);
    keepaliveTimer = undefined;
  };

  const beginActivity = (sessionId?: string, explicitStart = false): boolean => {
    const ownerFailed = completedSessions.get(activeSessionId) === "failed";
    const sessionFailed = completedSessions.get(sessionId ?? activeSessionId) === "failed";
    if (!explicitStart && (ownerFailed || sessionFailed)) return false;
    if (explicitStart) completedSessions.delete(undefined);
    if (!executionActive || (sessionId && sessionId !== activeSessionId)) {
      activityGeneration += 1;
      pendingPermissionResume = undefined;
      activeTools.clear();
      toolTrackingOverflow = false;
      currentActivityReaction = undefined;
    }
    executionActive = true;
    if (sessionId) activeSessionId = sessionId;
    completedSessions.delete(activeSessionId);
    if (keepaliveTimer === undefined && !closed) {
      keepaliveTimer = timers.setInterval(() => {
        if (closed || !executionActive) return;
        if (currentActivityReaction && !excludedReactions.has(currentActivityReaction)) run({ reaction: currentActivityReaction });
        else if (pet && client && lease) {
          const activity = activityGeneration;
          const hit = client;
          const pending = enqueue(async () => {
            if (!closed && executionActive && activity === activityGeneration) {
              await getLeaseId(hit, pet, false, true);
            }
          });
          activeWork.add(pending);
          void pending.finally(() => activeWork.delete(pending));
        }
      }, 5_000);
      if (typeof keepaliveTimer === "object") keepaliveTimer.unref();
    }
    return true;
  };

  const completeSession = (sessionId: string | undefined, outcome: "succeeded" | "failed"): boolean => {
    const completedId = sessionId ?? activeSessionId;
    if (completedSessions.get(completedId) === "failed" && outcome === "succeeded") return false;
    completedSessions.set(completedId, outcome);
    if (completedSessions.size > 64) {
      for (const candidate of completedSessions.keys()) {
        // Foreign terminal churn must not evict the current owner's failure.
        if (candidate === activeSessionId) continue;
        completedSessions.delete(candidate);
        break;
      }
    }
    if (sessionId && activeSessionId && sessionId !== activeSessionId) return false;
    executionActive = false;
    pendingPermissionResume = undefined;
    stopKeepalive();
    activeTools.clear();
    toolTrackingOverflow = false;
    return true;
  };

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const run = dispatchTail.then(task, task);
    dispatchTail = run.then(() => undefined, () => undefined);
    return run;
  };

  const run = (decision: OpenCodePluginDecision | undefined): void => {
    if (closed || !decision?.reaction) return;
    const reaction = decision.reaction;
    if (reaction === "waiting" || reaction === "success" || reaction === "error") {
      pendingPermissionResume = undefined;
    }
    if (reaction === "thinking" || reaction === "editing" || reaction === "testing" || reaction === "waiting") {
      currentActivityReaction = reaction;
    } else {
      currentActivityReaction = undefined;
    }
    const generation = ++reactionGeneration;
    const activity = activityGeneration;
    if (isReactionExcluded(reaction, excludedReactions)) return;
    try {
      schedule(() => {
        if (closed || generation !== reactionGeneration) return Promise.resolve();
        const pending = enqueue(() => dispatchReaction(decision, reaction, generation, activity));
        activeWork.add(pending);
        void pending.finally(() => activeWork.delete(pending));
        return pending;
      });
    } catch (error) {
      debugLog(`OpenPets OpenCode plugin scheduling ignored error: ${sanitizeDebugError(error)}`);
    }
  };

  const dispatchReaction = async (decision: OpenCodePluginDecision, reaction: OpenPetsReaction, generation: number, activity: number): Promise<void> => {
    if (closed || generation !== reactionGeneration) return;
    try {
      const permissionResume = pendingPermissionResume?.activity === activity ? pendingPermissionResume : undefined;
      const speechCategory = permissionResume ? "thinking" : decision.speechCategory;
      const shouldSpeak = speechCategory !== undefined
        && (permissionResume !== undefined || shouldSendSpeech(speechCategory, options));
      const shouldReact = reaction === "success" || reaction === "error"
        || reaction !== lastSentReaction || activity !== lastSentActivity
        || lastSentAt === undefined || now() - lastSentAt >= continuousReactionRefreshMs;
      if (!shouldSpeak && !shouldReact) return;

      client ??= clientFactory();
      const leaseId = pet ? await getLeaseId(client, pet, false, true) : undefined;
      if (closed || generation !== reactionGeneration || (pet && !leaseId)) return;
      if (speechCategory && shouldSpeak) {
        await client.say(validateHookSpeech(pickHookSpeech(speechCategory, options.random)), { reaction, leaseId });
        recordSentSpeech(speechCategory, options);
        // A newer permission wait/reply may have installed another intent while
        // this request was in flight. Its replacement still needs delivery.
        if (pendingPermissionResume === permissionResume) pendingPermissionResume = undefined;
        lastSentReaction = reaction;
        lastSentAt = now();
        lastSentActivity = activity;
        return;
      }
      await client.react(reaction, { leaseId });
      lastSentReaction = reaction;
      lastSentAt = now();
      lastSentActivity = activity;
    } catch (error) {
      debugLog(`OpenPets OpenCode plugin ignored error: ${sanitizeDebugError(error)}`);
    }
  };

  const dispatchTokenRate = async (update: OpenCodeTokenRateUpdate, generation: number, allowDuringCleanup = false): Promise<void> => {
    if ((closed && !allowDuringCleanup) || generation !== tokenRateGeneration) return;
    try {
      client ??= clientFactory();
      if (!client.tokenRate) return;
      const leaseId = pet ? await getLeaseId(client, pet, allowDuringCleanup) : undefined;
      if ((closed && !allowDuringCleanup) || generation !== tokenRateGeneration || (pet && !leaseId)) return;
      await client.tokenRate({ ...update, leaseId });
      if (generation !== tokenRateGeneration) return;
      tokenRateSessionToClear = update.tokensPerSecond === null && update.outputTokens === undefined
        ? undefined
        : update.sessionId;
      tokenRateFinalReported = update.source === "reported" && update.outputTokens !== undefined;
    } catch (error) {
      debugLog(`OpenPets OpenCode token rate ignored error: ${sanitizeDebugError(error)}`);
    }
  };

  const runTokenRate = (update: OpenCodeTokenRateUpdate | undefined): void => {
    if (closed || !update) return;
    const generation = ++tokenRateGeneration;
    if (update.tokensPerSecond !== null || update.outputTokens !== undefined) {
      // Remember queued/in-flight readings too: a terminal idle may already
      // have emptied the tracker before a failure needs to clear their badge.
      tokenRateSessionToClear = update.sessionId;
    }
    try {
      if (update.tokensPerSecond === null) {
        // Terminal reports and clears must finish before a short-lived OpenCode
        // process unloads the plugin. Only live estimates are cancellable.
        const pending = enqueue(() => dispatchTokenRate(update, generation, true));
        activeWork.add(pending);
        void pending.finally(() => activeWork.delete(pending));
        return;
      }
      schedule(() => {
        if (closed || generation !== tokenRateGeneration) return Promise.resolve();
        const pending = enqueue(() => dispatchTokenRate(update, generation));
        activeWork.add(pending);
        void pending.finally(() => activeWork.delete(pending));
        return pending;
      });
    } catch (error) {
      debugLog(`OpenPets OpenCode token rate scheduling ignored error: ${sanitizeDebugError(error)}`);
    }
  };

  const getLeaseId = async (hit: OpenPetsClient, requestedPetId: string, allowDuringCleanup = false, coverActivityRefresh = false): Promise<string | undefined> => {
    if (closed && !allowDuringCleanup) return undefined;
    const renewalBuffer = coverActivityRefresh ? continuousReactionRefreshMs + 2_000 : 2_000;
    if (lease && (!lease.expiresAt || lease.expiresAt - now() > renewalBuffer)) return lease.leaseId;
    const previous = lease;
    let next: { readonly leaseId: string; readonly expiresAt?: number };
    try {
      next = await hit.acquireLease({ requestedPetId });
    } catch (error) {
      debugLog(`OpenPets OpenCode lease unavailable: ${sanitizeDebugError(error)}`);
      return undefined;
    }
    lease = { leaseId: next.leaseId, expiresAt: next.expiresAt };
    if (previous && previous.leaseId !== next.leaseId) {
      await releaseLease(hit, previous.leaseId);
    }
    if (closed && !allowDuringCleanup) return undefined;
    return next.leaseId;
  };

  const releaseLease = async (hit: OpenPetsClient, leaseId: string): Promise<void> => {
    try {
      await hit.releaseLease(leaseId);
    } catch (error) {
      debugLog(`OpenPets OpenCode lease release failed: ${sanitizeDebugError(error)}`);
    }
  };

  const finishCleanup = async (): Promise<void> => {
    await Promise.allSettled([...activeWork]);
    await dispatchTail;
    const activeLease = lease;
    const activeClient = client;
    const displayedSession = tokenRateSessionToClear;
    const leaveFinalUntilExpiry = tokenRateFinalReported;
    lease = undefined;
    tokenRateSessionToClear = undefined;
    tokenRateFinalReported = false;
    if (displayedSession && !leaveFinalUntilExpiry && activeClient?.tokenRate) {
      try {
        await activeClient.tokenRate({ sessionId: displayedSession, tokensPerSecond: null, source: "estimated", leaseId: activeLease?.leaseId });
      } catch (error) {
        debugLog(`OpenPets OpenCode token rate cleanup ignored error: ${sanitizeDebugError(error)}`);
      }
    }
    if (!activeLease || !activeClient) return;
    await releaseLease(activeClient, activeLease.leaseId);
  };

  return {
    event(event) {
      try {
        const type = getEventType(event);
        const sessionId = getEventSessionId(event);
        const outcome = isFailureEvent(type) ? "failed" : "succeeded";
        const sessionFailed = completedSessions.get(sessionId ?? activeSessionId) === "failed";
        const anonymousOwnerFailed = !activeSessionId && completedSessions.get(undefined) === "failed";
        if (type !== "session.execution.started" && (sessionFailed || anonymousOwnerFailed)) return;
        if (isStreamEventType(type) && sessionId && completedSessions.has(sessionId)) return;
        if (activeSessionId && sessionId && sessionId !== activeSessionId) {
          if (isTokenRateEvent(type)) return;
          if (isTerminalEvent(type)) {
            completeSession(sessionId, outcome);
            return;
          }
        }
        if (isFailureEvent(type)) {
          // Invalidate queued reports even when idle already cleared the
          // tracker, then follow any in-flight report with an explicit clear.
          tokenRateGeneration += 1;
          const clear = tokenRateTracker.clear() ?? (tokenRateSessionToClear
            ? { sessionId: tokenRateSessionToClear, tokensPerSecond: null, source: "estimated" } as const
            : undefined);
          runTokenRate(clear);
        } else {
          runTokenRate(tokenRateTracker.ingest(event));
        }
        if (isStreamEventType(type)) {
          // Stream content is activity only inside an explicitly started turn.
          // A late delta must not revive a completed or different session.
          if (!tokenRateTracker.hadStreamActivity() || !executionActive || !sessionId || completedSessions.has(sessionId)) return;
          if (activeSessionId && activeSessionId !== sessionId) return;
          if (activeTools.size > 0 || toolTrackingOverflow) return;
          activeSessionId = sessionId;
          run({ reaction: "thinking" });
          return;
        } else if (type === "session.execution.started") {
          beginActivity(sessionId, true);
        } else if (type === "permission.asked") {
          if (!beginActivity(sessionId)) return;
        } else if (type === "permission.replied") {
          if (!executionActive || !sessionId || sessionId !== activeSessionId
            || currentActivityReaction !== "waiting" || completedSessions.has(sessionId)) return;
          const visibleTools = [...activeTools.values()].filter((reaction) => reaction !== undefined);
          // Retain this activity's replacement across coalesced state changes
          // and slow lease acquisition, until a neutral say actually succeeds.
          pendingPermissionResume = { activity: activityGeneration };
          run({ reaction: visibleTools.at(-1) ?? "thinking" });
          return;
        } else if (isTerminalEvent(type)) {
          if (!completeSession(sessionId, outcome)) return;
        }
        run(classifyOpenCodeBusEvent(event));
      } catch (error) {
        debugLog(`OpenPets OpenCode event ignored error: ${sanitizeDebugError(error)}`);
      }
    },
    prompt(sessionId) {
      beginActivity(sessionId, true);
      run({ reaction: "thinking" });
    },
    toolBefore(tool, input, sessionId, callId) {
      if (shouldIgnoreOpenPetsTool(tool)) return;
      if (!beginActivity(sessionId)) return;
      const reaction = classifyOpenCodeToolReaction(tool, input);
      if (callId && callId.length <= 256) {
        if (activeTools.size < 256 || activeTools.has(callId)) activeTools.set(callId, reaction);
        else toolTrackingOverflow = true;
      }
      run({ reaction });
    },
    toolAfter(event) {
      if (!isRecord(event) || (event.status !== "error" && event.status !== "completed")) return;
      const tool = typeof event.tool === "string" ? event.tool : "";
      if (tool && shouldIgnoreOpenPetsTool(tool)) return;
      const sessionId = getEventSessionId(event);
      if (sessionId && activeSessionId && sessionId !== activeSessionId) return;
      if (completedSessions.has(sessionId ?? activeSessionId)) return;
      if (!executionActive && activeSessionId) return;
      const callId = typeof event.id === "string" ? event.id : undefined;
      const tracked = callId !== undefined && activeTools.has(callId);
      if (tracked && callId) activeTools.delete(callId);
      if (event.status === "completed") {
        if (!executionActive || !tracked || toolTrackingOverflow) return;
        const remaining = [...activeTools.values()];
        run({ reaction: remaining.length ? remaining.at(-1) ?? "thinking" : "thinking" });
        return;
      }
      run({ reaction: "error", speechCategory: "error" });
      if (activeTools.size > 0 && !toolTrackingOverflow) {
        // The error is transient feedback; a different known tool still owns
        // ongoing work and must remain refreshable without repeating speech.
        currentActivityReaction = [...activeTools.values()].at(-1) ?? "thinking";
      }
    },
    reportError(scope, error) {
      process.stderr.write(`OpenPets OpenCode ${scope}: ${sanitizeDebugError(error)}\n`);
    },
    cleanup() {
      if (cleanupPromise) return cleanupPromise;
      closed = true;
      pendingPermissionResume = undefined;
      stopKeepalive();
      tokenRateTracker.clear();
      cleanupPromise = finishCleanup();
      return cleanupPromise;
    },
  };
}

export function classifyOpenCodeToolReaction(toolName: string, args?: unknown): OpenPetsReaction | undefined {
  const normalized = toolName.toLowerCase();
  if (/edit|write|patch|apply_patch/.test(normalized)) return "editing";
  if (/bash|shell|terminal/.test(normalized)) return isTestLikeToolArgs(args) ? "testing" : undefined;
  return undefined;
}

export function classifyOpenCodeBusEvent(event: unknown): OpenCodePluginDecision | undefined {
  const type = getEventType(event);
  if (type === "session.execution.started" || isStreamingEvent(event)) return { reaction: "thinking" };
  if (type === "permission.asked") return getEventPermissions(event).some(shouldIgnoreOpenPetsTool) ? undefined : { reaction: "waiting", speechCategory: "permission" };
  if (type === "session.execution.failed" || type === "session.error") return { reaction: "error", speechCategory: "error" };
  if (type === "session.execution.succeeded" || type === "session.idle") return { reaction: "success" };
  return undefined;
}

export function shouldIgnoreOpenPetsTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9_:-]+/g, "_");
  return /(?:^|[_:-])openpets_(?:openpets_)?(?:status|say|react)$/.test(normalized) || /^openpets_(?:status|say|react)$/.test(normalized);
}

export function getDefaultOpenCodeThrottlePath(): string {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "OpenPets", "opencode-hook-throttle.json");
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  if (stateHome) return join(stateHome, "openpets", "opencode-hook-throttle.json");
  return join(tmpdir(), `openpets-${safeUid()}`, "opencode-hook-throttle.json");
}

function shouldSendSpeech(category: HookSpeechCategory, options: OpenCodePluginRuntimeOptions): boolean {
  const now = options.now?.() ?? Date.now();
  const cooldown = category === "permission" ? permissionCooldownMs : speechCooldownMs;
  const state = readThrottleState(options.throttlePath ?? getDefaultOpenCodeThrottlePath());
  const previous = state[category];
  return previous === undefined || now - previous >= cooldown;
}

function recordSentSpeech(category: HookSpeechCategory, options: OpenCodePluginRuntimeOptions): void {
  const now = options.now?.() ?? Date.now();
  const path = options.throttlePath ?? getDefaultOpenCodeThrottlePath();
  const state = readThrottleState(path);
  state[category] = now;
  writeThrottleState(path, state);
}

function buildExcludedReactionsSet(excludeReactions?: readonly OpenPetsReaction[]): ReadonlySet<string> {
  const valid = sanitizeOpenCodeExcludedReactions(excludeReactions);
  return valid.length > 0 ? new Set(valid) : emptySet;
}

const emptySet: ReadonlySet<string> = new Set();

function isTestLikeToolArgs(args: unknown): boolean {
  const command = isRecord(args) && typeof args.command === "string" ? args.command.slice(0, 300) : "";
  return /\b(test|vitest|jest|pytest|npm\s+test|pnpm\s+test|yarn\s+test|cargo\s+test|go\s+test)\b/i.test(command);
}

function getEventType(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  if (typeof event.type === "string") return event.type;
  return undefined;
}

function getEventSessionId(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  const data = isRecord(event.data) ? event.data : undefined;
  const properties = isRecord(event.properties) ? event.properties : undefined;
  const part = isRecord(properties?.part) ? properties.part : undefined;
  const info = isRecord(properties?.info) ? properties.info : undefined;
  const sessionId = event.sessionID ?? data?.sessionID ?? properties?.sessionID ?? part?.sessionID ?? info?.sessionID;
  return typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 256 ? sessionId : undefined;
}

function isTerminalEvent(type: string | undefined): boolean {
  return type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.idle" || type === "session.error";
}

function isFailureEvent(type: string | undefined): boolean {
  return type === "session.execution.failed" || type === "session.error";
}

function isStreamEventType(type: string | undefined): boolean {
  return type === "session.text.delta" || type === "session.reasoning.delta"
    || type === "message.part.delta" || type === "message.part.updated";
}

function isTokenRateEvent(type: string | undefined): boolean {
  return isStreamEventType(type) || type === "session.usage.updated"
    || type === "session.step.ended" || type === "message.updated";
}

function isStreamingEvent(event: unknown): boolean {
  if (!isRecord(event)) return false;
  const data = isRecord(event.data) ? event.data : undefined;
  if (event.type === "session.text.delta" || event.type === "session.reasoning.delta") {
    return typeof data?.delta === "string" && data.delta.length > 0;
  }
  const properties = isRecord(event.properties) ? event.properties : undefined;
  if (typeof properties?.delta !== "string" || properties.delta.length === 0) return false;
  if (event.type === "message.part.delta") return properties.field === "text" || properties.field === "reasoning";
  const part = isRecord(properties.part) ? properties.part : undefined;
  return event.type === "message.part.updated" && (part?.type === "text" || part?.type === "reasoning");
}

function getEventPermissions(event: unknown): readonly string[] {
  if (!isRecord(event)) return [];
  const data = isRecord(event.data) ? event.data : undefined;
  const permissions = typeof data?.action === "string" ? [data.action] : [];
  if (Array.isArray(data?.resources)) {
    permissions.push(...data.resources.filter((resource): resource is string => typeof resource === "string"));
  }
  return permissions;
}

function readThrottleState(path: string): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) return {};
    const state: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if ((key === "thinking" || key === "success" || key === "error" || key === "permission") && typeof value === "number" && Number.isFinite(value)) state[key] = value;
    }
    return state;
  } catch {
    return {};
  }
}

function writeThrottleState(path: string, state: Record<string, number>): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tempPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, path);
  } catch {
    // Best effort only; throttling must never break hooks.
  }
}

function defaultSchedule(work: () => Promise<void>): void {
  queueMicrotask(() => { void work(); });
}

function sanitizeDebugError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(?:[A-Za-z]:)?[\\/][^\s"']{2,}/g, "<path>")
    .replace(/\b(api[_-]?key|secret|password|token)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .slice(0, 200);
}

function safeUid(): string {
  try { return String(userInfo().uid); } catch { return "user"; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

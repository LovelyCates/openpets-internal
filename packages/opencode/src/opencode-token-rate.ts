/**
 * OpenCode usage events contain session IDs and token counts, but stream events
 * contain model text. Only derived numbers cross the OpenPets IPC boundary.
 * Live token/s is an estimate (stream characters / 4), never a provider count.
 */
export interface OpenCodeTokenRateUpdate {
  readonly sessionId: string;
  readonly tokensPerSecond: number | null;
  /** Cumulative observed output-segment mean; always an estimate, including on reports. */
  readonly averageTokensPerSecond?: number;
  readonly outputTokens?: number;
  readonly source: "estimated" | "reported";
}

export interface OpenCodeTokenRateTracker {
  readonly ingest: (event: unknown) => OpenCodeTokenRateUpdate | undefined;
  readonly clear: () => OpenCodeTokenRateUpdate | undefined;
  /** Whether the last ingested event contained a live text/reasoning change. */
  readonly hadStreamActivity: () => boolean;
}

const sessionIdPattern = /^[A-Za-z0-9._:-]{1,80}$/;
const estimateWindowMs = 3_000;
const minEstimateDurationMs = 1_000;
const usageDuringStreamGraceMs = 1_500;
const reportedDisplayMs = 8_000;
const maxDeltaChars = 32_768;
const maxReportedTokens = 1_000_000_000;
const maxFallbackSessionIds = 16;

export function createOpenCodeTokenRateTracker(now: () => number = Date.now): OpenCodeTokenRateTracker {
  let activeSessionId: string | undefined;
  let startedAt: number | undefined;
  let lastDeltaAt = 0;
  let lastEstimatedAt = 0;
  let reportedAt: number | undefined;
  let segmentTokens = 0;
  let reportedAverage: number | undefined;
  let samples: Array<{ readonly at: number; readonly tokens: number }> = [];
  let streamActivity = false;
  const partLengths = new Map<string, number>();
  const fallbackSessionIds = new Map<string, string>();
  const fallbackPrefix = Math.floor(Math.random() * 0x1_0000_0000).toString(36).padStart(7, "0");
  let fallbackSequence = 0;

  const readSessionId = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    if (sessionIdPattern.test(value)) return value;
    if (!value || value.length > 256) return undefined;
    const existing = fallbackSessionIds.get(value);
    if (existing) return existing;
    const safeId = `oc-${fallbackPrefix}-${++fallbackSequence}`;
    fallbackSessionIds.set(value, safeId);
    if (fallbackSessionIds.size > maxFallbackSessionIds) {
      const oldest = fallbackSessionIds.keys().next().value;
      if (oldest !== undefined) fallbackSessionIds.delete(oldest);
    }
    return safeId;
  };

  const clear = (): OpenCodeTokenRateUpdate | undefined => {
    const sessionId = activeSessionId;
    activeSessionId = undefined;
    startedAt = undefined;
    lastDeltaAt = 0;
    lastEstimatedAt = 0;
    reportedAt = undefined;
    segmentTokens = 0;
    reportedAverage = undefined;
    samples = [];
    partLengths.clear();
    return sessionId ? { sessionId, tokensPerSecond: null, source: "estimated" } : undefined;
  };

  const average = (): number | undefined => {
    if (startedAt === undefined) return undefined;
    const durationMs = lastDeltaAt - startedAt;
    if (durationMs < minEstimateDurationMs) return undefined;
    return Math.round(Math.min(10_000, segmentTokens * 1_000 / durationMs) * 10) / 10;
  };

  const estimate = (sessionId: string, delta: string): OpenCodeTokenRateUpdate | undefined => {
    if (!delta || delta.length > maxDeltaChars) return undefined;
    const at = now();
    if (!Number.isFinite(at)) return undefined;
    if (activeSessionId !== sessionId || startedAt === undefined) {
      activeSessionId = sessionId;
      startedAt = at;
      lastDeltaAt = 0;
      lastEstimatedAt = 0;
      reportedAt = undefined;
      segmentTokens = 0;
      reportedAverage = undefined;
      samples = [];
    }
    if (at < lastDeltaAt) return undefined;
    lastDeltaAt = at;
    segmentTokens += delta.length / 4;
    samples.push({ at, tokens: delta.length / 4 });
    const cutoff = Math.max(startedAt, at - estimateWindowMs);
    samples = samples.filter((sample) => sample.at >= cutoff);
    const durationMs = at - cutoff;
    if (durationMs < minEstimateDurationMs || (lastEstimatedAt && at - lastEstimatedAt < minEstimateDurationMs)) return undefined;
    const tokenCount = samples.reduce((sum, sample) => sum + sample.tokens, 0);
    lastEstimatedAt = at;
    return {
      sessionId,
      tokensPerSecond: Math.round(Math.min(10_000, tokenCount * 1_000 / durationMs) * 10) / 10,
      averageTokensPerSecond: average(),
      source: "estimated",
    };
  };

  const reported = (sessionId: string, outputTokens: number): OpenCodeTokenRateUpdate => {
    const at = now();
    let averageTokensPerSecond: number | undefined;
    if (sessionId === activeSessionId) {
      averageTokensPerSecond = average();
      if (startedAt === undefined && reportedAt !== undefined && at >= reportedAt && at - reportedAt <= reportedDisplayMs) {
        averageTokensPerSecond = reportedAverage;
      }
    }
    activeSessionId = sessionId;
    startedAt = undefined;
    lastDeltaAt = 0;
    lastEstimatedAt = 0;
    reportedAt = at;
    segmentTokens = 0;
    reportedAverage = averageTokensPerSecond;
    samples = [];
    return {
      sessionId,
      tokensPerSecond: null,
      ...(averageTokensPerSecond === undefined ? {} : { averageTokensPerSecond }),
      outputTokens,
      source: "reported",
    };
  };

  return {
    ingest(event) {
      streamActivity = false;
      const item = isRecord(event) ? event : undefined;
      const type = typeof item?.type === "string" ? item.type : undefined;
      const data = isRecord(item?.data) ? item.data : undefined;
      const properties = isRecord(item?.properties) ? item.properties : undefined;

      if (type === "session.text.delta" || type === "session.reasoning.delta") {
        const sessionId = readSessionId(data?.sessionID);
        streamActivity = Boolean(sessionId && typeof data?.delta === "string" && data.delta.length > 0);
        return sessionId && typeof data?.delta === "string" ? estimate(sessionId, data.delta) : undefined;
      }

      if (type === "session.usage.updated" || type === "session.step.ended") {
        const sessionId = readSessionId(data?.sessionID);
        const outputTokens = readOutputTokens(data?.tokens);
        if (type === "session.usage.updated" && sessionId === activeSessionId && lastDeltaAt && now() - lastDeltaAt < usageDuringStreamGraceMs) {
          return undefined;
        }
        return sessionId && outputTokens !== undefined ? reported(sessionId, outputTokens) : undefined;
      }

      if (type === "message.part.delta" && (properties?.field === "text" || properties?.field === "reasoning")) {
        const sessionId = readSessionId(properties.sessionID);
        streamActivity = Boolean(sessionId && typeof properties.delta === "string" && properties.delta.length > 0);
        return sessionId && typeof properties.delta === "string" ? estimate(sessionId, properties.delta) : undefined;
      }

      if (type === "message.part.updated") {
        const part = isRecord(properties?.part) ? properties.part : undefined;
        const sessionId = readSessionId(part?.sessionID);
        if ((part?.type !== "text" && part?.type !== "reasoning") || !sessionId) return undefined;
        if (typeof properties?.delta === "string") {
          streamActivity = properties.delta.length > 0;
          return estimate(sessionId, properties.delta);
        }
        const time = isRecord(part.time) ? part.time : undefined;
        if (typeof part.id !== "string" || part.id.length > 256
          || typeof part.text !== "string" || part.text.length > 1_048_576
          || typeof time?.start !== "number" || time.end !== undefined) return undefined;
        const key = sessionId + "\u0000" + part.id;
        const previousLength = partLengths.get(key);
        partLengths.set(key, part.text.length);
        if (partLengths.size > 64) {
          const oldest = partLengths.keys().next().value;
          if (oldest !== undefined) partLengths.delete(oldest);
        }
        // The first full snapshot may be loaded history. Only observed growth
        // of the same unfinished part is evidence of a live stream.
        if (previousLength === undefined || part.text.length <= previousLength) return undefined;
        const delta = part.text.slice(previousLength);
        streamActivity = delta.length > 0;
        return estimate(sessionId, delta);
      }

      if (type === "message.updated") {
        const info = isRecord(properties?.info) ? properties.info : undefined;
        if (info?.role !== "assistant") return undefined;
        const sessionId = readSessionId(info.sessionID);
        const time = isRecord(info.time) ? info.time : undefined;
        const metadata = isRecord(info.metadata) ? info.metadata : undefined;
        const metadataTime = isRecord(metadata?.time) ? metadata.time : undefined;
        if (typeof time?.completed !== "number" && typeof metadataTime?.completed !== "number" && typeof info.finish !== "string") return undefined;
        const assistant = isRecord(metadata?.assistant) ? metadata.assistant : undefined;
        const outputTokens = readOutputTokens(info.tokens) ?? readOutputTokens(assistant?.tokens);
        return sessionId && outputTokens !== undefined ? reported(sessionId, outputTokens) : undefined;
      }

      if (type === "session.idle" || type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.error") {
        const eventSessionId = readSessionId(data?.sessionID ?? properties?.sessionID);
        if (eventSessionId && eventSessionId !== activeSessionId) return undefined;
        if (type === "session.idle" || type === "session.execution.succeeded") {
          const age = reportedAt === undefined ? undefined : now() - reportedAt;
          if (age !== undefined && age >= 0 && age <= reportedDisplayMs) {
            // Keep the final provider count in the host until its short TTL.
            clear();
            return undefined;
          }
        }
        return clear();
      }

      return undefined;
    },
    clear,
    hadStreamActivity: () => streamActivity,
  };
}

function readOutputTokens(value: unknown): number | undefined {
  const tokens = isRecord(value) ? value : undefined;
  const output = tokens?.output;
  return typeof output === "number" && Number.isSafeInteger(output) && output >= 0 && output <= maxReportedTokens ? output : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

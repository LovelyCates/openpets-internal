/** Local-only OpenCode usage: expiring live readings and bounded in-run display history. */
export type OpenCodeTokenRateTarget =
  | { readonly kind: "default" }
  | { readonly kind: "explicit"; readonly petId: string };

export type OpenCodeTokenRateReading = {
  readonly tokensPerSecond: number | null;
  readonly averageTokensPerSecond?: number;
  readonly outputTokens?: number;
  readonly source: "estimated" | "reported";
};

export type OpenCodeTokenRateDisplay =
  | (OpenCodeTokenRateReading & { readonly state: "live"; readonly tokensPerSecond: number })
  | (OpenCodeTokenRateReading & { readonly state: "summary"; readonly tokensPerSecond: null; readonly outputTokens: number })
  | (OpenCodeTokenRateReading & { readonly state: "idle"; readonly tokensPerSecond: null });
export type OpenCodeTokenRateText = {
  readonly state: OpenCodeTokenRateDisplay["state"];
  readonly rateText: string;
  readonly rateLabel: string;
  readonly outputText: string;
  readonly averageText: string;
  readonly averageLabel: string;
  readonly rateTier: TokenRateTier;
  readonly averageTier: TokenRateTier;
};

type TokenRateTier = "fast" | "medium" | "slow" | "unknown";

export function formatOpenCodeTokenRate(
  reading: OpenCodeTokenRateReading | OpenCodeTokenRateDisplay | null,
  outputLabel: string,
  idleLabel = "Idle",
  lastOutputLabel = "Last output",
  liveLabel = "Live",
): OpenCodeTokenRateText | null {
  if (!reading) return null;
  let state: OpenCodeTokenRateDisplay["state"];
  if ("state" in reading) {
    state = reading.state;
  } else {
    state = reading.tokensPerSecond === null ? "summary" : "live";
  }
  const approximate = reading.source === "estimated" ? "≈" : "";
  const rate = state === "live" ? reading.tokensPerSecond : null;
  const average = reading.averageTokensPerSecond;
  const rateText = formatSpeed(rate, reading.source === "estimated");
  const averageText = formatSpeed(average, true);
  const rateLabel = state === "idle" ? idleLabel : liveLabel;
  const averageLabel = state === "idle" && isKnownSpeed(average) ? `${lastOutputLabel} AVG` : "AVG";
  const outputText = reading.outputTokens === undefined
    ? ""
    : `${state === "idle" ? lastOutputLabel : outputLabel} ${approximate}${reading.outputTokens.toLocaleString("en-US")} tokens`;
  return {
    state,
    rateText,
    rateLabel,
    outputText,
    averageText,
    averageLabel,
    rateTier: speedTier(rate),
    averageTier: speedTier(average),
  };
}

function isKnownSpeed(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function formatSpeed(value: number | null | undefined, estimated: boolean): string {
  if (!isKnownSpeed(value)) return "— tk/s";
  return `${estimated ? "≈" : ""}${value.toFixed(1)} tk/s`;
}

function speedTier(value: number | null | undefined): TokenRateTier {
  if (!isKnownSpeed(value)) return "unknown";
  if (value > 40) return "fast";
  if (value > 20) return "medium";
  return "slow";
}

type Entry = OpenCodeTokenRateReading & {
  readonly key: string;
  readonly leaseId?: string;
  readonly target: OpenCodeTokenRateTarget;
  readonly expiresAt: number;
  readonly sequence: number;
};

type TargetHistory = {
  readonly target: OpenCodeTokenRateTarget;
  readonly lastOutputTokens?: number;
  readonly lastAverageTokensPerSecond?: number;
  readonly sequence: number;
};

const estimatedTtlMs = 5_000;
const reportedTtlMs = 8_000;
const maxEntries = 64;

export class OpenCodeTokenRateStore {
  readonly #entries = new Map<string, Entry>();
  readonly #history = new Map<string, TargetHistory>();
  readonly #listeners = new Set<(target: OpenCodeTokenRateTarget) => void>();
  #sequence = 0;

  constructor(private readonly now: () => number = Date.now) {}

  subscribe(listener: (target: OpenCodeTokenRateTarget) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  update(
    sessionId: string,
    leaseId: string | undefined,
    target: OpenCodeTokenRateTarget,
    reading: OpenCodeTokenRateReading,
  ): void {
    this.sweepExpired();
    const key = `${leaseId ?? ""}\u0000${sessionId}`;
    const previous = this.#entries.get(key);
    if (reading.tokensPerSecond === null && reading.outputTokens === undefined) {
      if (previous) {
        this.#entries.delete(key);
        this.#emit(previous.target);
      }
      return;
    }

    const sequence = ++this.#sequence;
    const historyKey = targetKey(target);
    const lastOutputTokens = isReportedFinal(reading)
      ? reading.outputTokens
      : this.#history.get(historyKey)?.lastOutputTokens;
    const lastAverageTokensPerSecond = isReportedFinal(reading)
      ? reading.averageTokensPerSecond
      : this.#history.get(historyKey)?.lastAverageTokensPerSecond;
    this.#history.set(historyKey, { target, lastOutputTokens, lastAverageTokensPerSecond, sequence });
    const expiresAt = this.now() + (reading.source === "reported" ? reportedTtlMs : estimatedTtlMs);
    this.#entries.set(key, { ...reading, key, leaseId, target, expiresAt, sequence });
    if (previous && !sameTarget(previous.target, target)) this.#emit(previous.target);
    this.#emit(target);

    while (this.#entries.size > maxEntries) {
      const oldest = [...this.#entries.values()].reduce((a, b) => a.sequence < b.sequence ? a : b);
      this.#entries.delete(oldest.key);
      this.#emit(oldest.target);
    }
    while (this.#history.size > maxEntries) {
      const oldest = [...this.#history.values()].reduce((a, b) => a.sequence < b.sequence ? a : b);
      this.#history.delete(targetKey(oldest.target));
      this.#emit(oldest.target);
    }
  }

  read(target: OpenCodeTokenRateTarget): OpenCodeTokenRateReading | null {
    const now = this.now();
    let newest: Entry | null = null;
    for (const entry of this.#entries.values()) {
      if (entry.expiresAt <= now || !sameTarget(entry.target, target)) continue;
      if (!newest || entry.sequence > newest.sequence) newest = entry;
    }
    return newest
      ? {
        tokensPerSecond: newest.tokensPerSecond,
        ...(newest.averageTokensPerSecond === undefined ? {} : { averageTokensPerSecond: newest.averageTokensPerSecond }),
        outputTokens: newest.outputTokens,
        source: newest.source,
      }
      : null;
  }

  readDisplay(target: OpenCodeTokenRateTarget): OpenCodeTokenRateDisplay | null {
    const reading = this.read(target);
    if (reading && reading.tokensPerSecond !== null) {
      return { ...reading, state: "live", tokensPerSecond: reading.tokensPerSecond };
    }
    if (reading?.outputTokens !== undefined) {
      return { ...reading, state: "summary", tokensPerSecond: null, outputTokens: reading.outputTokens };
    }
    const history = this.#history.get(targetKey(target));
    if (!history) return null;
    return {
      state: "idle",
      tokensPerSecond: null,
      ...(history.lastOutputTokens === undefined ? {} : { outputTokens: history.lastOutputTokens }),
      ...(history.lastAverageTokensPerSecond === undefined ? {} : { averageTokensPerSecond: history.lastAverageTokensPerSecond }),
      source: history.lastOutputTokens === undefined ? "estimated" : "reported",
    };
  }

  clearLease(leaseId: string): void {
    for (const entry of [...this.#entries.values()]) {
      if (entry.leaseId !== leaseId) continue;
      if (isReportedFinal(entry) && entry.expiresAt > this.now()) continue;
      this.#entries.delete(entry.key);
      this.#emit(entry.target);
    }
  }

  reportedFinalRemainingMs(target: OpenCodeTokenRateTarget): number {
    const now = this.now();
    let newest: Entry | null = null;
    for (const entry of this.#entries.values()) {
      if (!sameTarget(entry.target, target) || entry.expiresAt <= now) continue;
      if (!newest || entry.sequence > newest.sequence) newest = entry;
    }
    return newest && isReportedFinal(newest) ? newest.expiresAt - now : 0;
  }

  clearTarget(target: OpenCodeTokenRateTarget): void {
    let changed = this.#history.delete(targetKey(target));
    for (const entry of [...this.#entries.values()]) {
      if (!sameTarget(entry.target, target)) continue;
      this.#entries.delete(entry.key);
      changed = true;
    }
    if (changed) this.#emit(target);
  }

  clearAll(): void {
    const targets = new Map<string, OpenCodeTokenRateTarget>();
    for (const item of [...this.#entries.values(), ...this.#history.values()]) {
      targets.set(targetKey(item.target), item.target);
    }
    this.#entries.clear();
    this.#history.clear();
    for (const target of targets.values()) this.#emit(target);
  }

  sweepExpired(): void {
    const now = this.now();
    for (const entry of [...this.#entries.values()]) {
      if (entry.expiresAt > now) continue;
      this.#entries.delete(entry.key);
      this.#emit(entry.target);
    }
  }

  #emit(target: OpenCodeTokenRateTarget): void {
    for (const listener of this.#listeners) listener(target);
  }
}

function sameTarget(a: OpenCodeTokenRateTarget, b: OpenCodeTokenRateTarget): boolean {
  return a.kind === b.kind && (a.kind === "default" || (b.kind === "explicit" && a.petId === b.petId));
}

function targetKey(target: OpenCodeTokenRateTarget): string {
  return target.kind === "default" ? "default" : `explicit\u0000${target.petId}`;
}

function isReportedFinal(entry: OpenCodeTokenRateReading): boolean {
  return entry.source === "reported" && entry.tokensPerSecond === null && entry.outputTokens !== undefined;
}

export const openCodeTokenRateStore = new OpenCodeTokenRateStore();

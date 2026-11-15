/** Short-lived, local-only OpenCode usage shown beside a pet. */
export type OpenCodeTokenRateTarget =
  | { readonly kind: "default" }
  | { readonly kind: "explicit"; readonly petId: string };

export type OpenCodeTokenRateReading = {
  readonly tokensPerSecond: number | null;
  readonly outputTokens?: number;
  readonly source: "estimated" | "reported";
};

export type OpenCodeTokenRateDisplay = OpenCodeTokenRateReading;
export type OpenCodeTokenRateText = { readonly rateText: string; readonly outputText: string };

export function formatOpenCodeTokenRate(reading: OpenCodeTokenRateDisplay | null, outputLabel: string): OpenCodeTokenRateText | null {
  if (!reading) return null;
  const approximate = reading.source === "estimated" ? "≈" : "";
  const rateText = reading.tokensPerSecond === null
    ? ""
    : `${approximate}${reading.tokensPerSecond.toFixed(1)} token/s`;
  const outputText = reading.outputTokens === undefined
    ? ""
    : `${outputLabel} ${approximate}${reading.outputTokens.toLocaleString("en-US")} tokens`;
  return { rateText, outputText };
}

type Entry = OpenCodeTokenRateReading & {
  readonly key: string;
  readonly leaseId?: string;
  readonly target: OpenCodeTokenRateTarget;
  readonly expiresAt: number;
  readonly sequence: number;
};

const estimatedTtlMs = 5_000;
const reportedTtlMs = 8_000;
const maxEntries = 64;

export class OpenCodeTokenRateStore {
  readonly #entries = new Map<string, Entry>();
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

    const expiresAt = this.now() + (reading.source === "reported" ? reportedTtlMs : estimatedTtlMs);
    this.#entries.set(key, { ...reading, key, leaseId, target, expiresAt, sequence: ++this.#sequence });
    if (previous && !sameTarget(previous.target, target)) this.#emit(previous.target);
    this.#emit(target);

    while (this.#entries.size > maxEntries) {
      const oldest = [...this.#entries.values()].reduce((a, b) => a.sequence < b.sequence ? a : b);
      this.#entries.delete(oldest.key);
      this.#emit(oldest.target);
    }
  }

  read(target: OpenCodeTokenRateTarget): OpenCodeTokenRateDisplay | null {
    const now = this.now();
    let newest: Entry | null = null;
    for (const entry of this.#entries.values()) {
      if (entry.expiresAt <= now || !sameTarget(entry.target, target)) continue;
      if (!newest || entry.sequence > newest.sequence) newest = entry;
    }
    return newest
      ? { tokensPerSecond: newest.tokensPerSecond, outputTokens: newest.outputTokens, source: newest.source }
      : null;
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
    for (const entry of [...this.#entries.values()]) {
      if (!sameTarget(entry.target, target)) continue;
      this.#entries.delete(entry.key);
      this.#emit(target);
    }
  }

  clearAll(): void {
    const targets = [...this.#entries.values()].map((entry) => entry.target);
    this.#entries.clear();
    for (const target of targets) this.#emit(target);
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

function isReportedFinal(entry: Entry): boolean {
  return entry.source === "reported" && entry.tokensPerSecond === null && entry.outputTokens !== undefined;
}

export const openCodeTokenRateStore = new OpenCodeTokenRateStore();

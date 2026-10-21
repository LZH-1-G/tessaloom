/** Token bucket: at most `perMinute` acquisitions per rolling minute (continuous refill). */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    this.tokens = perMinute;
    this.last = now();
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new Error("aborted");
      const t = this.now();
      this.tokens = Math.min(
        this.perMinute,
        this.tokens + ((t - this.last) * this.perMinute) / 60_000,
      );
      this.last = t;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(
        Math.ceil(((1 - this.tokens) * 60_000) / this.perMinute),
      );
    }
  }
}

/** Counting semaphore for the per-worker harness concurrency limit. */
export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit)
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  get inFlight(): number {
    return this.active;
  }
}

/** Small in-memory TTL cache (process lifetime only; nothing is persisted). */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }
}

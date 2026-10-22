/**
 * Sliding-window limiter: at most `limit` acquisitions in any `windowMs` window.
 * Callers await `acquire()`; waiters are served FIFO.
 */
export class SlidingWindowLimiter {
  private readonly stamps: number[] = [];
  private readonly waiters: Array<() => void> = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    readonly limit: number,
    readonly windowMs = 1000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('limit must be a positive integer');
  }

  acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.drain();
    });
  }

  /** Number of callers waiting for a slot. */
  get pending(): number {
    return this.waiters.length;
  }

  /** Reject nothing, just forget queued waiters' timing (used on shutdown). */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private drain(): void {
    const now = this.now();
    while (this.stamps.length > 0 && now - this.stamps[0]! >= this.windowMs) this.stamps.shift();
    while (this.waiters.length > 0 && this.stamps.length < this.limit) {
      this.stamps.push(now);
      this.waiters.shift()!();
    }
    if (this.waiters.length > 0 && !this.timer) {
      const wait = Math.max(1, this.windowMs - (now - this.stamps[0]!));
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.drain();
      }, wait);
    }
  }
}

/**
 * Documented limits (help.ctrader.com/open-api): 50 req/s for non-historical
 * and 5 req/s for historical data requests, per connection. We keep a margin.
 */
export const DEFAULT_LIMITS = { nonHistorical: 45, historical: 4 } as const;

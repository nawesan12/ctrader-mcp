/**
 * Rolling spread statistics per symbol, fed by spot events.
 * "Session average" = mean of samples over the last `windowMs` (default 2 h),
 * sampled at most once per `sampleEveryMs` per symbol. Not valid until
 * `minSamples` samples exist (e.g. right after start-up).
 */
export class SpreadTracker {
  private readonly samples = new Map<number, Array<{ t: number; spread: number }>>();

  constructor(
    private readonly windowMs = 2 * 60 * 60_000,
    private readonly sampleEveryMs = 1_000,
    readonly minSamples = 60,
  ) {}

  record(symbolId: number, spread: number, t = Date.now()): void {
    if (!(spread >= 0) || !Number.isFinite(spread)) return;
    let arr = this.samples.get(symbolId);
    if (!arr) {
      arr = [];
      this.samples.set(symbolId, arr);
    }
    const last = arr.at(-1);
    if (last && t - last.t < this.sampleEveryMs) return;
    arr.push({ t, spread });
    const cutoff = t - this.windowMs;
    while (arr.length > 0 && arr[0]!.t < cutoff) arr.shift();
  }

  /** Mean spread over the window, or undefined if there are not enough samples. */
  average(symbolId: number, now = Date.now()): number | undefined {
    const arr = (this.samples.get(symbolId) ?? []).filter((s) => s.t >= now - this.windowMs);
    if (arr.length < this.minSamples) return undefined;
    return arr.reduce((acc, s) => acc + s.spread, 0) / arr.length;
  }

  sampleCount(symbolId: number): number {
    return this.samples.get(symbolId)?.length ?? 0;
  }
}

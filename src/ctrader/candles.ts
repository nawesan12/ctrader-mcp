import type { CTraderClient } from './client.js';
import { trendbarsToCandles, type Candle } from './normalize.js';
import { PT, TrendbarPeriod, type Timeframe } from './payloadTypes.js';
import { TrendbarsResSchema } from './schemas.js';
import type { SymbolInfo } from './symbols.js';

export const PERIOD_MS: Record<Timeframe, number> = {
  M1: 60_000,
  M2: 120_000,
  M3: 180_000,
  M4: 240_000,
  M5: 300_000,
  M10: 600_000,
  M15: 900_000,
  M30: 1_800_000,
  H1: 3_600_000,
  H4: 14_400_000,
  H12: 43_200_000,
  D1: 86_400_000,
  W1: 604_800_000,
  MN1: 31 * 86_400_000,
};

export const MAX_CANDLES = 500;

export interface CandleRequest {
  count: number;
  /** Drop the bar still forming (default true): analysis must not repaint. */
  closedOnly?: boolean;
}

type CandleClient = Pick<CTraderClient, 'callAccount'>;

/** Fetches trendbars with backwards pagination and a short cache. */
export class CandleService {
  private readonly cache = new Map<string, { at: number; candles: Candle[] }>();

  constructor(
    private readonly client: CandleClient,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 20_000,
  ) {}

  async get(symbol: SymbolInfo, tf: Timeframe, req: CandleRequest): Promise<Candle[]> {
    const count = Math.min(Math.max(1, Math.floor(req.count)), MAX_CANDLES);
    const closedOnly = req.closedOnly ?? true;
    const now = this.now();
    const key = `${symbol.symbolId}:${tf}`;
    let all = this.cache.get(key);
    if (!all || now - all.at > this.ttlMs || all.candles.length < count + 1) {
      all = { at: now, candles: await this.fetch(symbol, tf, count + 1, now) };
      this.cache.set(key, all);
    }
    const bars = closedOnly ? all.candles.filter((c) => isClosed(c, tf, now)) : all.candles;
    return bars.slice(-count);
  }

  private async fetch(symbol: SymbolInfo, tf: Timeframe, count: number, now: number): Promise<Candle[]> {
    const period = PERIOD_MS[tf];
    const byTime = new Map<number, Candle>();
    let to = now;
    for (let page = 0; page < 6 && byTime.size < count; page++) {
      const missing = count - byTime.size;
      // Markets close on weekends: ask for a window ~2x wider than the bar count.
      const from = Math.max(0, to - Math.ceil(missing * period * 2 + 3 * 86_400_000));
      const res = await this.client.callAccount(
        PT.GET_TRENDBARS_REQ,
        { symbolId: symbol.symbolId, period: TrendbarPeriod[tf], fromTimestamp: from, toTimestamp: to, count: missing },
        PT.GET_TRENDBARS_RES,
        TrendbarsResSchema,
      );
      const candles = trendbarsToCandles(res.trendbar, symbol.digits);
      for (const c of candles) byTime.set(c.t, c);
      if (candles.length === 0) {
        if (from === 0) break;
        to = from; // nothing in this window (long holiday): step further back
        continue;
      }
      to = candles[0]!.t - 1;
    }
    return [...byTime.values()].sort((a, b) => a.t - b.t);
  }
}

export function isClosed(c: Candle, tf: Timeframe, now: number): boolean {
  if (tf === 'MN1') {
    const a = new Date(c.t);
    const b = new Date(now);
    return a.getUTCFullYear() !== b.getUTCFullYear() || a.getUTCMonth() !== b.getUTCMonth();
  }
  return c.t + PERIOD_MS[tf] <= now;
}

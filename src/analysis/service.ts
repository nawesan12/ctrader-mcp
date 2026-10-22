import type { CandleService } from '../ctrader/candles.js';
import { pipSize, roundTo } from '../ctrader/normalize.js';
import type { Timeframe } from '../ctrader/payloadTypes.js';
import type { SymbolInfo, SymbolService } from '../ctrader/symbols.js';
import { analyze, keyLevels, killzoneAt, nextKillzone, type SmcOptions } from './smc.js';
import { computeBias, summarizeTimeframe, type Bias, type TimeframeSummary } from './summary.js';

export interface SmcContext {
  symbol: string;
  at: string;
  price: number;
  spreadPips: number | null;
  killzone: { current: string | null; next: string; startsInMin: number };
  levels: {
    pdh: number | null;
    pdl: number | null;
    pwh: number | null;
    pwl: number | null;
    midnightOpen: number | null;
    todayHigh: number | null;
    todayLow: number | null;
    adrPips: number | null;
    adrUsedPct: number | null;
  };
  timeframes: TimeframeSummary[];
  bias: Bias;
}

export interface SmcServiceOptions {
  symbols: Pick<SymbolService, 'get' | 'ensureQuotes' | 'getQuote' | 'waitForQuote'>;
  candles: Pick<CandleService, 'get'>;
  tz: string;
  now?: () => number;
  barsPerTimeframe?: number;
  smc?: Partial<SmcOptions>;
}

export class SmcService {
  private readonly now: () => number;

  constructor(private readonly o: SmcServiceOptions) {
    this.now = o.now ?? Date.now;
  }

  async context(symbolName: string, timeframes: Timeframe[] = ['H4', 'H1', 'M15']): Promise<SmcContext> {
    const now = this.now();
    const symbol = await this.o.symbols.get(symbolName);
    const fmt = { digits: symbol.digits, pip: pipSize(symbol.pipPosition) };
    const r = (x: number | undefined) => (x === undefined ? null : roundTo(x, symbol.digits));

    const series = await Promise.all(
      timeframes.map(async (tf) => ({ tf, bars: await this.o.candles.get(symbol, tf, { count: this.o.barsPerTimeframe ?? 300 }) })),
    );
    // Levels need today's forming bars too.
    const h1 = await this.o.candles.get(symbol, 'H1', { count: 500, closedOnly: false });

    const quote = await this.quote(symbol);
    const lastClose = h1.at(-1)?.close ?? series.find((s) => s.bars.length > 0)?.bars.at(-1)?.close;
    const price = quote?.mid ?? lastClose;
    if (price === undefined) throw new Error(`No price data for ${symbol.name}`);

    const summaries = series.map(({ tf, bars }) => summarizeTimeframe(tf, bars, analyze(bars, this.o.smc), price, fmt));
    const lv = keyLevels(h1, now, this.o.tz);
    const nk = nextKillzone(now, this.o.tz);

    return {
      symbol: symbol.key,
      at: new Date(now).toISOString(),
      price: roundTo(price, symbol.digits),
      spreadPips: quote ? roundTo(quote.spread / fmt.pip, 1) : null,
      killzone: { current: killzoneAt(now, this.o.tz) ?? null, next: nk.name, startsInMin: nk.inMinutes },
      levels: {
        pdh: r(lv.pdh),
        pdl: r(lv.pdl),
        pwh: r(lv.pwh),
        pwl: r(lv.pwl),
        midnightOpen: r(lv.midnightOpen),
        todayHigh: r(lv.todayHigh),
        todayLow: r(lv.todayLow),
        adrPips: lv.adr === undefined ? null : roundTo(lv.adr / fmt.pip, 1),
        adrUsedPct: lv.adrUsedPct === undefined ? null : Math.round(lv.adrUsedPct),
      },
      timeframes: summaries,
      bias: computeBias(summaries),
    };
  }

  private async quote(symbol: SymbolInfo) {
    await this.o.symbols.ensureQuotes([symbol.symbolId]);
    return this.o.symbols.getQuote(symbol.symbolId) ?? (await this.o.symbols.waitForQuote(symbol.symbolId, 3_000).catch(() => undefined));
  }
}

import { describe, expect, it } from 'vitest';
import { SmcService } from '../../src/analysis/service.js';
import {
  analyze,
  atrSeries,
  findSwings,
  keyLevels,
  killzoneAt,
  nextKillzone,
  nyWeekKey,
  premiumDiscount,
  type Bar,
  type Swing,
} from '../../src/analysis/smc.js';
import { computeBias, summarizeTimeframe, type TimeframeSummary } from '../../src/analysis/summary.js';
import { CandleService, isClosed } from '../../src/ctrader/candles.js';
import { PT } from '../../src/ctrader/payloadTypes.js';
import type { SymbolInfo } from '../../src/ctrader/symbols.js';

const H1 = 3_600_000;
const T0 = Date.parse('2026-10-19T00:00:00Z');

/** Bars from closes: open = previous close, wicks 0.1 beyond the body. */
function fromCloses(closes: number[], start = T0, step = H1, first = closes[0]!): Bar[] {
  return closes.map((c, i) => {
    const o = i === 0 ? first : closes[i - 1]!;
    return { t: start + i * step, open: o, close: c, high: Math.max(o, c) + 0.1, low: Math.min(o, c) - 0.1 };
  });
}

function bar(i: number, o: number, h: number, l: number, c: number): Bar {
  return { t: T0 + i * H1, open: o, high: h, low: l, close: c };
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomWalk(n: number, seed: number): Bar[] {
  const r = rng(seed);
  const bars: Bar[] = [];
  let price = 1.08;
  for (let i = 0; i < n; i++) {
    const o = price;
    const c = o + (r() - 0.5) * 0.004;
    const h = Math.max(o, c) + r() * 0.0015;
    const l = Math.min(o, c) - r() * 0.0015;
    bars.push({ t: T0 + i * H1, open: o, high: h, low: l, close: c });
    price = c;
  }
  return bars;
}

// up 10->13, down to 10, up to 15, down to 9
const ZIGZAG = [10, 11, 12, 13, 12, 11, 10, 11, 12, 13, 14, 15, 14, 13, 12, 11, 10, 9];

describe('swings', () => {
  it('finds pivots and confirms them len bars later', () => {
    const s = findSwings(fromCloses(ZIGZAG), 2);
    const highs = s.filter((x) => x.kind === 'high').map((x) => [x.index, x.price, x.confirmedAt]);
    const lows = s.filter((x) => x.kind === 'low').map((x) => [x.index, x.price, x.confirmedAt]);
    expect(highs).toEqual([
      [3, 13.1, 5],
      [11, 15.1, 13],
    ]);
    expect(lows).toEqual([[6, 9.9, 8]]);
  });

  it('a tie on the left is not a pivot, a tie on the right is', () => {
    const bars = [bar(0, 1, 1.5, 0.9, 1), bar(1, 1, 2, 0.9, 1), bar(2, 1, 1.2, 0.9, 1), bar(3, 1, 2, 0.9, 1), bar(4, 1, 1.1, 0.9, 1)];
    // len 1: bars 1 and 3 are both local maxima (their neighbours are lower)
    expect(findSwings(bars, 1).filter((s) => s.kind === 'high').map((s) => s.index)).toEqual([1, 3]);
    const tied = [bar(0, 1, 1, 0.9, 1), bar(1, 1, 2, 0.9, 1), bar(2, 1, 2, 0.9, 1), bar(3, 1, 1, 0.9, 1)];
    expect(findSwings(tied, 1).filter((s) => s.kind === 'high').map((s) => s.index)).toEqual([1]);
  });
});

describe('structure, order blocks', () => {
  const bars = fromCloses(ZIGZAG);
  const s = analyze(bars, { swingLength: 2 });

  it('BOS on the first close beyond a swing, CHoCH when the break goes against the trend', () => {
    expect(s.breaks.map((b) => [b.type, b.dir, b.index, b.level])).toEqual([
      ['BOS', 'bull', 10, 13.1],
      ['CHoCH', 'bear', 17, 9.9],
    ]);
    expect(s.trend).toBe('bear');
  });

  it('a wick beyond the swing is not a break (close required)', () => {
    const b = fromCloses(ZIGZAG.slice(0, 10));
    b.push(bar(10, 13, 13.5, 12.9, 13.05)); // high above 13.1, close below
    expect(analyze(b, { swingLength: 2 }).breaks).toEqual([]);
  });

  it('OB = last opposite candle before the break; bull OB invalidated by a close below it', () => {
    // bull break @10 -> last bearish candle before it is bar 6 (11 -> 10)
    // bear break @17 -> last bullish candle before it is bar 11 (14 -> 15)
    const all = analyze(bars.slice(0, 17), { swingLength: 2 });
    expect(all.orderBlocks.map((o) => [o.dir, o.index, o.bottom, o.top, o.mitigated])).toEqual([['bull', 6, 9.9, 11.1, true]]);
    // after bar 17 closes at 9 (< 9.9) the bull OB is gone and the bear OB exists
    expect(s.orderBlocks.map((o) => [o.dir, o.index, o.bottom, o.top])).toEqual([['bear', 11, 13.9, 15.1]]);
  });

  it('keeps only the last N active OBs per side', () => {
    const many = analyze(randomWalk(500, 7), { maxOrderBlocks: 2 });
    expect(many.orderBlocks.filter((o) => o.dir === 'bull').length).toBeLessThanOrEqual(2);
    expect(many.orderBlocks.filter((o) => o.dir === 'bear').length).toBeLessThanOrEqual(2);
    expect(many.orderBlocks.every((o) => o.invalidatedAt === undefined)).toBe(true);
  });
});

describe('fair value gaps', () => {
  it('bullish when low[i] > high[i-2]; shrinks with wicks; filled when a wick reaches the far edge', () => {
    const bars = [
      bar(0, 1.0, 1.1, 0.95, 1.05),
      bar(1, 1.05, 1.4, 1.04, 1.38),
      bar(2, 1.38, 1.5, 1.2, 1.45), // low 1.2 > high[0] 1.1 -> FVG [1.1, 1.2]
      bar(3, 1.45, 1.46, 1.15, 1.4), // wick into the gap -> remaining [1.1, 1.15]
    ];
    let s = analyze(bars);
    expect(s.fvgs).toEqual([{ dir: 'bull', top: 1.2, bottom: 1.1, index: 2, t: bars[2]!.t, remainingTop: 1.15, remainingBottom: 1.1 }]);
    bars.push(bar(4, 1.4, 1.41, 1.1, 1.3)); // wick to 1.1 -> filled
    s = analyze(bars);
    expect(s.fvgs).toEqual([]);
  });

  it('bearish when high[i] < low[i-2]', () => {
    const bars = [bar(0, 2, 2.05, 1.9, 1.95), bar(1, 1.95, 1.96, 1.6, 1.62), bar(2, 1.62, 1.8, 1.55, 1.6)];
    expect(analyze(bars).fvgs.map((g) => [g.dir, g.bottom, g.top])).toEqual([['bear', 1.8, 1.9]]);
  });
});

describe('liquidity (EQH/EQL)', () => {
  // two highs at 2.00 and 2.004 with ATR ~0.2 => tolerance 0.02 -> equal
  const shape = [1.5, 1.7, 1.9, 1.7, 1.5, 1.4, 1.5, 1.7, 1.904, 1.7, 1.5, 1.4];
  const bars = fromCloses(shape);

  it('marks equal highs within 10% ATR and reports them unswept', () => {
    const s = analyze(bars, { swingLength: 2 });
    const eqh = s.liquidity.filter((p) => p.kind === 'EQH');
    expect(eqh).toHaveLength(1);
    expect(eqh[0]!.price).toBeCloseTo(2.004, 10);
    expect(eqh[0]!.sweptAt).toBeUndefined();
  });

  it('is swept by a later wick above', () => {
    const b = [...bars, bar(12, 1.4, 2.1, 1.39, 1.5)];
    const eqh = analyze(b, { swingLength: 2 }).liquidity.filter((p) => p.kind === 'EQH');
    expect(eqh[0]!.sweptAt).toBe(12);
  });

  it('not equal when farther apart than the tolerance', () => {
    const far = fromCloses([1.5, 1.7, 1.9, 1.7, 1.5, 1.4, 1.5, 1.7, 1.96, 1.7, 1.5, 1.4]);
    expect(analyze(far, { swingLength: 2 }).liquidity.filter((p) => p.kind === 'EQH')).toEqual([]);
  });
});

describe('no repainting', () => {
  it('every prefix agrees with the full run on all events it can already know', () => {
    const bars = randomWalk(300, 42);
    const full = analyze(bars);
    expect(full.breaks.length).toBeGreaterThan(5);
    for (let n = 20; n <= bars.length; n += 7) {
      const part = analyze(bars.slice(0, n));
      expect(part.breaks).toEqual(full.breaks.filter((b) => b.index < n));
      expect(part.swings).toEqual(full.swings.filter((s) => s.confirmedAt < n));
    }
  });

  it('ATR is causal (prefix values never change)', () => {
    const bars = randomWalk(100, 3);
    expect(atrSeries(bars.slice(0, 50))).toEqual(atrSeries(bars).slice(0, 50));
  });
});

describe('premium / discount and OTE', () => {
  const sw = (kind: 'high' | 'low', index: number, price: number): Swing => ({ kind, index, price, t: 0, confirmedAt: index + 5 });

  it('bull leg (low first): OTE is the 62–79% retracement from the high', () => {
    const pd = premiumDiscount(sw('high', 20, 1.1), sw('low', 10, 1.0), 1.03)!;
    expect(pd.leg).toBe('bull');
    expect(pd.equilibrium).toBeCloseTo(1.05, 10);
    expect(pd.zone).toBe('discount');
    expect(pd.ote.from).toBeCloseTo(1.021, 10);
    expect(pd.ote.to).toBeCloseTo(1.038, 10);
    expect(pd.inOte).toBe(true);
  });

  it('bear leg (high first): OTE is the 62–79% retracement up from the low', () => {
    const pd = premiumDiscount(sw('high', 10, 1.1), sw('low', 20, 1.0), 1.09)!;
    expect(pd.leg).toBe('bear');
    expect(pd.zone).toBe('premium');
    expect(pd.ote.from).toBeCloseTo(1.062, 10);
    expect(pd.ote.to).toBeCloseTo(1.079, 10);
    expect(pd.inOte).toBe(false);
  });

  it('equilibrium band and missing swings', () => {
    expect(premiumDiscount(sw('high', 20, 1.1), sw('low', 10, 1.0), 1.0505)!.zone).toBe('equilibrium');
    expect(premiumDiscount(undefined, sw('low', 10, 1.0), 1)).toBeUndefined();
  });
});

describe('killzones (NY time, DST aware)', () => {
  it('maps NY wall-clock times in summer (EDT) and winter (EST)', () => {
    expect(killzoneAt(Date.parse('2026-07-15T07:00:00Z'))).toBe('London'); // 03:00 EDT
    expect(killzoneAt(Date.parse('2026-01-15T08:00:00Z'))).toBe('London'); // 03:00 EST
    expect(killzoneAt(Date.parse('2026-07-15T12:00:00Z'))).toBe('NY AM'); // 08:00
    expect(killzoneAt(Date.parse('2026-07-15T17:30:00Z'))).toBe('NY PM'); // 13:30
    expect(killzoneAt(Date.parse('2026-07-15T20:00:00Z'))).toBeUndefined(); // 16:00 end-exclusive
    expect(killzoneAt(Date.parse('2026-07-16T01:00:00Z'))).toBe('Asia'); // 21:00
    expect(killzoneAt(Date.parse('2026-07-16T04:00:00Z'))).toBeUndefined(); // 00:00
  });

  it('next killzone wraps around midnight', () => {
    expect(nextKillzone(Date.parse('2026-07-15T21:00:00Z'))).toEqual({ name: 'Asia', inMinutes: 180 }); // 17:00 -> 20:00
    expect(nextKillzone(Date.parse('2026-07-16T02:00:00Z'))).toEqual({ name: 'London', inMinutes: 240 }); // 22:00 -> 02:00
  });
});

describe('key levels', () => {
  // Hourly bars from Mon 2026-10-12 00:00 NY (04:00Z) to Wed 2026-10-21 12:00 NY, range grows by day
  const start = Date.parse('2026-10-12T04:00:00Z');
  const bars: Bar[] = [];
  for (let i = 0; i < 24 * 9 + 13; i++) {
    const t = start + i * H1;
    const day = Math.floor(i / 24);
    const base = 1 + day * 0.01;
    bars.push({ t, open: base + 0.001, high: base + 0.002 * (1 + (i % 24 === 12 ? day : 0)), low: base - 0.002, close: base });
  }
  const now = bars.at(-1)!.t + 30 * 60_000;

  it('forex week starts with Sunday', () => {
    expect(nyWeekKey(Date.parse('2026-10-18T22:00:00Z'))).toBe('2026-10-19'); // Sunday 18:00 NY
    expect(nyWeekKey(Date.parse('2026-10-17T15:00:00Z'))).toBe('2026-10-12'); // Saturday
  });

  it('PDH/PDL, PWH/PWL, midnight open, ADR', () => {
    const lv = keyLevels(bars, now);
    // yesterday = Tue 2026-10-20 = day index 8
    expect(lv.pdl).toBeCloseTo(1.08 - 0.002, 10);
    expect(lv.pdh).toBeCloseTo(1.08 + 0.002 * 9, 10);
    // previous week = Mon 12 .. Sat 17 (day indexes 0..5); Sunday 18 already belongs to the new week
    expect(lv.pwh).toBeCloseTo(1.05 + 0.002 * 6, 10);
    expect(lv.pwl).toBeCloseTo(1 - 0.002, 10);
    expect(lv.midnightOpen).toBeCloseTo(1.091, 10); // day 9 first bar open
    // ADR over weekdays only (Sat 17 / Sun 18 excluded): Mon..Fri (0..4) + Mon 19, Tue 20 (7, 8)
    const ranges = [0, 1, 2, 3, 4, 7, 8].map((d) => 0.002 * (1 + d) + 0.002);
    expect(lv.adrDays).toBe(7);
    expect(lv.adr).toBeCloseTo(ranges.reduce((a, b) => a + b, 0) / ranges.length, 10);
    expect(lv.adrUsedPct).toBeGreaterThan(0);
  });
});

describe('summary and bias', () => {
  const fmt = { digits: 5, pip: 0.0001 };

  it('summarises a timeframe compactly with distances in pips', () => {
    const scale = (x: number) => 1 + x / 100;
    const bars = fromCloses(ZIGZAG).map((b) => ({ t: b.t, open: scale(b.open), high: scale(b.high), low: scale(b.low), close: scale(b.close) }));
    const s = analyze(bars, { swingLength: 2 });
    const sum = summarizeTimeframe('H1', bars, s, 1.095, fmt);
    expect(sum.trend).toBe('bear');
    expect(sum.lastBreak).toMatchObject({ type: 'CHoCH', dir: 'bear', barsAgo: 0 });
    expect(sum.ob.above).toMatchObject({ dir: 'bear', bottom: 1.139, top: 1.151, distPips: 440 });
    expect(JSON.stringify(sum).length).toBeLessThan(1200);
  });

  const tf = (tfName: TimeframeSummary['tf'], trend: TimeframeSummary['trend'], extra: Partial<TimeframeSummary> = {}): TimeframeSummary => ({
    tf: tfName,
    trend,
    lastBreak: null,
    swingHigh: null,
    swingLow: null,
    ob: { above: null, below: null, inside: null },
    fvg: { above: null, below: null, inside: null },
    liquidity: { eqhAbove: [], eqlBelow: [] },
    pd: null,
    ...extra,
  });
  const pd = (zone: 'premium' | 'discount') => ({ zone, posPct: zone === 'discount' ? 30 : 70, eq: 1, range: [0.9, 1.1] as [number, number], leg: 'bull' as const, ote: [0.95, 0.97] as [number, number], inOte: false });

  it('aligned trends + discount => bullish with high confidence', () => {
    const b = computeBias([tf('H4', 'bull', { pd: pd('discount') }), tf('H1', 'bull'), tf('M15', 'bull')]);
    expect(b.bias).toBe('bullish');
    expect(b.confidence).toBe(1);
    expect(b.reasons.join(' | ')).toMatch(/H4 structure bull.*H4 price in discount/);
  });

  it('conflicting trends => neutral; LTF CHoCH against HTF is flagged', () => {
    const b = computeBias([
      tf('H4', 'bull', { pd: pd('premium') }),
      tf('H1', 'bear'),
      tf('M15', 'bear', { lastBreak: { type: 'CHoCH', dir: 'bear', level: 1, barsAgo: 2, at: '' } }),
    ]);
    // H4 +2, premium -1, H1 -1.5, M15 -1 => -1.5 of 5.5 (< 35% threshold)
    expect(b.bias).toBe('neutral');
    expect(b.score).toBe(-1.5);
    expect(b.reasons.some((r) => r.startsWith('warning: M15 CHoCH bear against H4 bull'))).toBe(true);
  });

  it('HTF bear + premium dominates a single LTF bull => bearish', () => {
    expect(computeBias([tf('H4', 'bear', { pd: pd('premium') }), tf('H1', 'bear'), tf('M15', 'bull')]).bias).toBe('bearish');
  });
});

describe('CandleService', () => {
  const SYM = { symbolId: 1, digits: 5 } as SymbolInfo;

  function fakeClient(total: number, pageSize: number, now: number) {
    const calls: Array<Record<string, number>> = [];
    const client = {
      callAccount: (pt: number, p: Record<string, number>, _e: number, schema: { parse: (x: unknown) => unknown }) => {
        expect(pt).toBe(PT.GET_TRENDBARS_REQ);
        calls.push(p);
        const all = Array.from({ length: total }, (_, i) => now - (total - i) * H1 + H1); // last bar is forming
        const inRange = all.filter((t) => t >= p.fromTimestamp! && t <= p.toTimestamp!).slice(-Math.min(p.count!, pageSize));
        return Promise.resolve(
          schema.parse({ period: 9, trendbar: inRange.map((t) => ({ volume: 1, low: 108_000, deltaHigh: 10, utcTimestampInMinutes: t / 60_000 })) }),
        );
      },
    };
    return { client, calls };
  }

  it('paginates backwards, drops the forming bar and returns exactly count', async () => {
    const now = Date.parse('2026-10-22T14:30:00Z');
    const { client, calls } = fakeClient(1000, 200, Date.parse('2026-10-22T14:00:00Z'));
    const svc = new CandleService(client as never, () => now);
    const bars = await svc.get(SYM, 'H1', { count: 450 });
    expect(bars).toHaveLength(450);
    expect(calls.length).toBeGreaterThan(1);
    expect(bars.at(-1)!.t + H1).toBeLessThanOrEqual(now);
    for (let i = 1; i < bars.length; i++) expect(bars[i]!.t - bars[i - 1]!.t).toBe(H1);
    // cache hit
    await svc.get(SYM, 'H1', { count: 100 });
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it('caps at 500 and can include the forming bar', async () => {
    const now = Date.parse('2026-10-22T14:30:00Z');
    const { client } = fakeClient(1000, 1000, Date.parse('2026-10-22T14:00:00Z'));
    const svc = new CandleService(client as never, () => now);
    expect(await svc.get(SYM, 'H1', { count: 9999 })).toHaveLength(500);
    const withOpen = await svc.get(SYM, 'H1', { count: 10, closedOnly: false });
    expect(withOpen.at(-1)!.t).toBe(Date.parse('2026-10-22T14:00:00Z'));
  });

  it('isClosed', () => {
    expect(isClosed({ t: 0 } as never, 'M15', 900_000)).toBe(true);
    expect(isClosed({ t: 0 } as never, 'M15', 899_999)).toBe(false);
  });
});

describe('SmcService (end to end with fixed data)', () => {
  it('returns compact context without raw candles', async () => {
    const now = T0 + 300 * H1;
    const walk = randomWalk(300, 11);
    const sym = { symbolId: 1, name: 'EURUSD', key: 'EURUSD', digits: 5, pipPosition: 4 } as SymbolInfo;
    const svc = new SmcService({
      symbols: {
        get: () => Promise.resolve(sym),
        ensureQuotes: () => Promise.resolve(),
        getQuote: () => ({ bid: walk.at(-1)!.close, ask: walk.at(-1)!.close + 0.0001, mid: walk.at(-1)!.close + 0.00005, spread: 0.0001, at: now }),
        waitForQuote: () => Promise.reject(new Error('x')),
      },
      candles: { get: (_s, _tf, req) => Promise.resolve(walk.slice(-req.count).map((b) => ({ ...b, time: new Date(b.t).toISOString(), volume: 1 }))) },
      tz: 'America/New_York',
      now: () => now,
    });
    const ctx = await svc.context('EURUSD');
    expect(ctx.timeframes.map((t) => t.tf)).toEqual(['H4', 'H1', 'M15']);
    expect(ctx.spreadPips).toBe(1);
    expect(['bullish', 'bearish', 'neutral']).toContain(ctx.bias.bias);
    expect(ctx.levels.adrPips).toBeGreaterThan(0);
    const json = JSON.stringify(ctx);
    expect(json).not.toMatch(/"open"/);
    expect(json.length).toBeLessThan(5000);
  });
});

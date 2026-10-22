/**
 * Deterministic Smart Money Concepts analysis on closed candles.
 * Every function is pure; the same input always produces the same output and
 * nothing is evaluated with information from the future (no repainting):
 * a swing at bar i is only usable from bar i + len, when it is confirmed.
 */
import { zonedDayKey, zonedMinuteOfDay, zonedParts, startOfZonedDay } from '../time.js';

export interface Bar {
  /** Open time, Unix ms. */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type Dir = 'bull' | 'bear';

export interface Swing {
  kind: 'high' | 'low';
  index: number;
  price: number;
  t: number;
  /** Bar index at which the pivot became known. */
  confirmedAt: number;
}

export interface StructureBreak {
  type: 'BOS' | 'CHoCH';
  dir: Dir;
  /** Swing level broken by a close. */
  level: number;
  swingIndex: number;
  index: number;
  t: number;
}

export interface OrderBlock {
  dir: Dir;
  top: number;
  bottom: number;
  /** Index of the OB candle. */
  index: number;
  t: number;
  /** Index of the break that created it. */
  createdAt: number;
  /** Price has traded back into the block since creation. */
  mitigated: boolean;
  invalidatedAt?: number | undefined;
}

export interface FairValueGap {
  dir: Dir;
  top: number;
  bottom: number;
  /** Index of the third candle (the one that completes the gap). */
  index: number;
  t: number;
  /** Unfilled part of the gap (shrinks as wicks enter it). */
  remainingTop: number;
  remainingBottom: number;
  filledAt?: number | undefined;
}

export interface LiquidityPool {
  kind: 'EQH' | 'EQL';
  price: number;
  indices: [number, number];
  t: number;
  sweptAt?: number | undefined;
}

export interface SmcOptions {
  /** Pivot length on each side (default 5). */
  swingLength: number;
  /** Bars before the break searched for the OB candle (default 20). */
  obLookback: number;
  /** Active OBs kept per side (default 3). */
  maxOrderBlocks: number;
  /** Active FVGs kept per side (default 5). */
  maxFvgs: number;
  /** EQH/EQL tolerance as a fraction of ATR (default 0.1). */
  eqTolerance: number;
  atrLength: number;
  /** Previous swings compared when looking for equal highs/lows. */
  eqLookbackSwings: number;
}

export const DEFAULT_SMC: SmcOptions = {
  swingLength: 5,
  obLookback: 20,
  maxOrderBlocks: 3,
  maxFvgs: 5,
  eqTolerance: 0.1,
  atrLength: 14,
  eqLookbackSwings: 5,
};

export interface SmcState {
  swings: Swing[];
  breaks: StructureBreak[];
  /** Direction of the last structure break, undefined before the first one. */
  trend: Dir | undefined;
  orderBlocks: OrderBlock[];
  fvgs: FairValueGap[];
  liquidity: LiquidityPool[];
  atr: number[];
  lastSwingHigh: Swing | undefined;
  lastSwingLow: Swing | undefined;
}

// ------------------------------------------------------------------ indicators

/** Wilder ATR. Before `length` bars it is the simple mean of the available TRs. */
export function atrSeries(bars: Bar[], length = 14): number[] {
  const out: number[] = [];
  let atr = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const prevClose = i > 0 ? bars[i - 1]!.close : b.close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
    atr = i < length ? (atr * i + tr) / (i + 1) : (atr * (length - 1) + tr) / length;
    out.push(atr);
  }
  return out;
}

/**
 * Pivot high at i: high[i] is strictly greater than the `len` highs to the left
 * and greater or equal to the `len` highs to the right (pivot low mirrored).
 * Confirmed at i + len.
 */
export function findSwings(bars: Bar[], len: number): Swing[] {
  const swings: Swing[] = [];
  for (let i = len; i + len < bars.length; i++) {
    const b = bars[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = i - len; j <= i + len && (isHigh || isLow); j++) {
      if (j === i) continue;
      const o = bars[j]!;
      if (j < i ? o.high >= b.high : o.high > b.high) isHigh = false;
      if (j < i ? o.low <= b.low : o.low < b.low) isLow = false;
    }
    if (isHigh) swings.push({ kind: 'high', index: i, price: b.high, t: b.t, confirmedAt: i + len });
    if (isLow) swings.push({ kind: 'low', index: i, price: b.low, t: b.t, confirmedAt: i + len });
  }
  return swings.sort((a, b) => a.confirmedAt - b.confirmedAt || a.index - b.index);
}

// ------------------------------------------------------------------ main pass

export function analyze(bars: Bar[], options: Partial<SmcOptions> = {}): SmcState {
  const o = { ...DEFAULT_SMC, ...options };
  const atr = atrSeries(bars, o.atrLength);
  const swings = findSwings(bars, o.swingLength);
  const breaks: StructureBreak[] = [];
  const obs: OrderBlock[] = [];
  const fvgs: FairValueGap[] = [];
  const pools: LiquidityPool[] = [];

  let trend: Dir | undefined;
  let lastHigh: Swing | undefined;
  let lastLow: Swing | undefined;
  let highBroken = true;
  let lowBroken = true;
  const recentHighs: Swing[] = [];
  const recentLows: Swing[] = [];
  let si = 0;

  for (let k = 0; k < bars.length; k++) {
    const bar = bars[k]!;

    // 1) swings confirmed on this bar become usable now
    while (si < swings.length && swings[si]!.confirmedAt === k) {
      const s = swings[si++]!;
      if (s.kind === 'high') {
        lastHigh = s;
        highBroken = false;
        addEqualPool(bars, pools, recentHighs, s, atr[s.index] ?? 0, o, 'EQH');
      } else {
        lastLow = s;
        lowBroken = false;
        addEqualPool(bars, pools, recentLows, s, atr[s.index] ?? 0, o, 'EQL');
      }
    }

    // 2) update existing zones with this bar (before creating new ones on it)
    for (const ob of obs) {
      if (ob.invalidatedAt !== undefined || k <= ob.createdAt) continue;
      if (ob.dir === 'bull') {
        if (bar.close < ob.bottom) ob.invalidatedAt = k;
        else if (bar.low <= ob.top) ob.mitigated = true;
      } else {
        if (bar.close > ob.top) ob.invalidatedAt = k;
        else if (bar.high >= ob.bottom) ob.mitigated = true;
      }
    }
    for (const g of fvgs) {
      if (g.filledAt !== undefined || k <= g.index) continue;
      if (g.dir === 'bull') {
        if (bar.low <= g.bottom) g.filledAt = k;
        else g.remainingTop = Math.min(g.remainingTop, bar.low);
      } else {
        if (bar.high >= g.top) g.filledAt = k;
        else g.remainingBottom = Math.max(g.remainingBottom, bar.high);
      }
    }
    for (const p of pools) {
      if (p.sweptAt !== undefined || k <= p.indices[1]) continue;
      if (p.kind === 'EQH' ? bar.high > p.price : bar.low < p.price) p.sweptAt = k;
    }

    // 3) structure breaks by CLOSE beyond the last confirmed swing
    if (lastHigh && !highBroken && bar.close > lastHigh.price) {
      highBroken = true;
      breaks.push({ type: trend === 'bear' ? 'CHoCH' : 'BOS', dir: 'bull', level: lastHigh.price, swingIndex: lastHigh.index, index: k, t: bar.t });
      trend = 'bull';
      const ob = findObCandle(bars, k, o.obLookback, 'bull');
      if (ob !== undefined) obs.push(makeOb(bars, ob, k, 'bull'));
    }
    if (lastLow && !lowBroken && bar.close < lastLow.price) {
      lowBroken = true;
      breaks.push({ type: trend === 'bull' ? 'CHoCH' : 'BOS', dir: 'bear', level: lastLow.price, swingIndex: lastLow.index, index: k, t: bar.t });
      trend = 'bear';
      const ob = findObCandle(bars, k, o.obLookback, 'bear');
      if (ob !== undefined) obs.push(makeOb(bars, ob, k, 'bear'));
    }

    // 4) FVG completed by this bar
    if (k >= 2) {
      const a = bars[k - 2]!;
      if (bar.low > a.high) fvgs.push({ dir: 'bull', top: bar.low, bottom: a.high, index: k, t: bar.t, remainingTop: bar.low, remainingBottom: a.high });
      else if (bar.high < a.low) fvgs.push({ dir: 'bear', top: a.low, bottom: bar.high, index: k, t: bar.t, remainingTop: a.low, remainingBottom: bar.high });
    }
  }

  return {
    swings,
    breaks,
    trend,
    orderBlocks: keepLastActive(obs, (x) => x.invalidatedAt === undefined, o.maxOrderBlocks),
    fvgs: keepLastActive(fvgs, (x) => x.filledAt === undefined, o.maxFvgs),
    liquidity: pools,
    atr,
    lastSwingHigh: lastHigh,
    lastSwingLow: lastLow,
  };
}

/** Last opposite-colour candle among the `lookback` bars before the break bar. */
function findObCandle(bars: Bar[], breakIndex: number, lookback: number, dir: Dir): number | undefined {
  for (let i = breakIndex - 1; i >= Math.max(0, breakIndex - lookback); i--) {
    const b = bars[i]!;
    if (dir === 'bull' ? b.close < b.open : b.close > b.open) return i;
  }
  return undefined;
}

function makeOb(bars: Bar[], i: number, createdAt: number, dir: Dir): OrderBlock {
  const b = bars[i]!;
  return { dir, top: b.high, bottom: b.low, index: i, t: b.t, createdAt, mitigated: false };
}

function addEqualPool(bars: Bar[], pools: LiquidityPool[], recent: Swing[], s: Swing, atr: number, o: SmcOptions, kind: 'EQH' | 'EQL'): void {
  const tol = atr * o.eqTolerance;
  for (let j = recent.length - 1; j >= 0; j--) {
    const prev = recent[j]!;
    if (Math.abs(prev.price - s.price) > tol) continue;
    // Not "equal" liquidity if a wick between the two swings already took out the first one.
    if (takenOutBetween(bars, prev, s.index, kind)) continue;
    pools.push({ kind, price: kind === 'EQH' ? Math.max(prev.price, s.price) : Math.min(prev.price, s.price), indices: [prev.index, s.index], t: s.t });
    break;
  }
  recent.push(s);
  if (recent.length > o.eqLookbackSwings) recent.shift();
}

function takenOutBetween(bars: Bar[], prev: Swing, until: number, kind: 'EQH' | 'EQL'): boolean {
  for (let i = prev.index + 1; i < until; i++) {
    const b = bars[i]!;
    if (kind === 'EQH' ? b.high > prev.price : b.low < prev.price) return true;
  }
  return false;
}

function keepLastActive<T extends { dir: Dir }>(items: T[], active: (x: T) => boolean, n: number): T[] {
  const bull = items.filter((x) => x.dir === 'bull' && active(x)).slice(-n);
  const bear = items.filter((x) => x.dir === 'bear' && active(x)).slice(-n);
  return [...bull, ...bear];
}

// ------------------------------------------------------------------ premium / discount

export interface PremiumDiscount {
  rangeHigh: number;
  rangeLow: number;
  equilibrium: number;
  zone: 'premium' | 'discount' | 'equilibrium';
  /** Position of price in the range, 0 = low, 1 = high. */
  position: number;
  /** Direction of the leg: bull if the low came before the high. */
  leg: Dir;
  /** Optimal trade entry band (62–79 % retracement of the leg). */
  ote: { from: number; to: number };
  inOte: boolean;
}

export function premiumDiscount(high: Swing | undefined, low: Swing | undefined, price: number): PremiumDiscount | undefined {
  if (!high || !low || high.price <= low.price) return undefined;
  const range = high.price - low.price;
  const eq = low.price + range / 2;
  const leg: Dir = low.index < high.index ? 'bull' : 'bear';
  // Bull leg: retrace down from the high. Bear leg: retrace up from the low.
  const ote =
    leg === 'bull'
      ? { from: high.price - 0.79 * range, to: high.price - 0.62 * range }
      : { from: low.price + 0.62 * range, to: low.price + 0.79 * range };
  const position = (price - low.price) / range;
  const zone = Math.abs(price - eq) <= range * 0.02 ? 'equilibrium' : price > eq ? 'premium' : 'discount';
  return { rangeHigh: high.price, rangeLow: low.price, equilibrium: eq, zone, position, leg, ote, inOte: price >= ote.from && price <= ote.to };
}

// ------------------------------------------------------------------ killzones (NY time)

export interface Killzone {
  name: 'Asia' | 'London' | 'NY AM' | 'NY PM';
  /** Minutes from NY midnight. */
  start: number;
  end: number;
}

export const KILLZONES: Killzone[] = [
  { name: 'Asia', start: 20 * 60, end: 24 * 60 },
  { name: 'London', start: 2 * 60, end: 5 * 60 },
  { name: 'NY AM', start: 7 * 60, end: 10 * 60 },
  { name: 'NY PM', start: 13 * 60 + 30, end: 16 * 60 },
];

export function killzoneAt(t: number, tz = 'America/New_York'): Killzone['name'] | undefined {
  const m = zonedMinuteOfDay(t, tz);
  return KILLZONES.find((k) => m >= k.start && m < k.end)?.name;
}

/** Next killzone to start after t, and minutes until it starts. */
export function nextKillzone(t: number, tz = 'America/New_York'): { name: Killzone['name']; inMinutes: number } {
  const m = zonedMinuteOfDay(t, tz);
  const sorted = [...KILLZONES].sort((a, b) => a.start - b.start);
  const next = sorted.find((k) => k.start > m) ?? sorted[0]!;
  const inMinutes = next.start > m ? next.start - m : 24 * 60 - m + next.start;
  return { name: next.name, inMinutes };
}

// ------------------------------------------------------------------ daily / weekly levels (NY calendar)

export interface KeyLevels {
  pdh?: number | undefined;
  pdl?: number | undefined;
  pwh?: number | undefined;
  pwl?: number | undefined;
  midnightOpen?: number | undefined;
  todayHigh?: number | undefined;
  todayLow?: number | undefined;
  /** Average daily range of the last `adrDays` complete NY days. */
  adr?: number | undefined;
  adrDays: number;
  /** Today's range as % of ADR. */
  adrUsedPct?: number | undefined;
}

/**
 * Week key for the forex week: Sunday's session belongs to the week that
 * starts on the following Monday.
 */
export function nyWeekKey(t: number, tz = 'America/New_York'): string {
  const p = zonedParts(t, tz);
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dow = date.getUTCDay(); // 0 = Sunday
  const toMonday = dow === 0 ? 1 : 1 - dow;
  date.setUTCDate(date.getUTCDate() + toMonday);
  return date.toISOString().slice(0, 10);
}

export function keyLevels(bars: Bar[], now: number, tz = 'America/New_York', adrDays = 10): KeyLevels {
  type Agg = { high: number; low: number };
  const days = new Map<string, Agg>();
  const weeks = new Map<string, Agg>();
  const merge = (m: Map<string, Agg>, k: string, b: Bar) => {
    const a = m.get(k);
    if (a) {
      a.high = Math.max(a.high, b.high);
      a.low = Math.min(a.low, b.low);
    } else m.set(k, { high: b.high, low: b.low });
  };
  for (const b of bars) {
    merge(days, zonedDayKey(b.t, tz), b);
    merge(weeks, nyWeekKey(b.t, tz), b);
  }
  const todayKey = zonedDayKey(now, tz);
  const weekKey = nyWeekKey(now, tz);
  const dayKeys = [...days.keys()].sort().filter((k) => k < todayKey);
  const weekKeys = [...weeks.keys()].sort().filter((k) => k < weekKey);
  const prevDay = days.get(dayKeys.at(-1) ?? '');
  const prevWeek = weeks.get(weekKeys.at(-1) ?? '');
  const today = days.get(todayKey);

  const midnight = startOfZonedDay(now, tz);
  const midnightBar = bars.find((b) => b.t >= midnight && zonedDayKey(b.t, tz) === todayKey);

  // Weekend days (no full session) would drag the ADR down: skip tiny Sunday stubs.
  const complete = dayKeys
    .map((k) => ({ k, d: days.get(k)! }))
    .filter(({ k }) => new Date(`${k}T12:00:00Z`).getUTCDay() !== 0 && new Date(`${k}T12:00:00Z`).getUTCDay() !== 6)
    .slice(-adrDays);
  const adr = complete.length > 0 ? complete.reduce((acc, { d }) => acc + (d.high - d.low), 0) / complete.length : undefined;

  return {
    pdh: prevDay?.high,
    pdl: prevDay?.low,
    pwh: prevWeek?.high,
    pwl: prevWeek?.low,
    midnightOpen: midnightBar?.open,
    todayHigh: today?.high,
    todayLow: today?.low,
    adr,
    adrDays: complete.length,
    adrUsedPct: adr && today ? ((today.high - today.low) / adr) * 100 : undefined,
  };
}

/**
 * Compact, token-cheap summaries of an SmcState for the MCP tool output.
 * Prices are rounded to the symbol digits and distances are in pips.
 */
import { roundTo } from '../ctrader/normalize.js';
import type { Timeframe } from '../ctrader/payloadTypes.js';
import { premiumDiscount, type Bar, type Dir, type SmcState } from './smc.js';

export interface PriceFmt {
  digits: number;
  pip: number;
}

interface Zone {
  dir: Dir;
  top: number;
  bottom: number;
  t: number;
}

export interface ZoneOut {
  dir: Dir;
  top: number;
  bottom: number;
  distPips: number;
  since: string;
}

export interface TimeframeSummary {
  tf: Timeframe;
  trend: Dir | 'range';
  lastBreak: { type: 'BOS' | 'CHoCH'; dir: Dir; level: number; barsAgo: number; at: string } | null;
  swingHigh: number | null;
  swingLow: number | null;
  ob: { above: ZoneOut | null; below: ZoneOut | null; inside: ZoneOut | null };
  fvg: { above: ZoneOut | null; below: ZoneOut | null; inside: ZoneOut | null };
  liquidity: { eqhAbove: Array<{ price: number; distPips: number }>; eqlBelow: Array<{ price: number; distPips: number }> };
  pd: {
    zone: 'premium' | 'discount' | 'equilibrium';
    posPct: number;
    eq: number;
    range: [number, number];
    leg: Dir;
    ote: [number, number];
    inOte: boolean;
  } | null;
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 16) + 'Z';

function nearestZones(zones: Zone[], price: number, f: PriceFmt) {
  const out = (z: Zone, dist: number): ZoneOut => ({
    dir: z.dir,
    top: roundTo(z.top, f.digits),
    bottom: roundTo(z.bottom, f.digits),
    distPips: roundTo(dist / f.pip, 1),
    since: iso(z.t),
  });
  let above: ZoneOut | null = null;
  let below: ZoneOut | null = null;
  let inside: ZoneOut | null = null;
  for (const z of zones) {
    if (z.bottom > price) {
      const d = z.bottom - price;
      if (!above || d / f.pip < above.distPips) above = out(z, d);
    } else if (z.top < price) {
      const d = price - z.top;
      if (!below || d / f.pip < below.distPips) below = out(z, d);
    } else if (!inside || z.t > Date.parse(inside.since)) {
      inside = out(z, 0);
    }
  }
  return { above, below, inside };
}

export function summarizeTimeframe(tf: Timeframe, bars: Bar[], s: SmcState, price: number, f: PriceFmt): TimeframeSummary {
  const last = s.breaks.at(-1);
  const pd = premiumDiscount(s.lastSwingHigh, s.lastSwingLow, price);
  const r = (x: number) => roundTo(x, f.digits);
  const pips = (x: number) => roundTo(x / f.pip, 1);
  const fvgZones = s.fvgs.map((g) => ({ dir: g.dir, top: g.remainingTop, bottom: g.remainingBottom, t: g.t }));
  const unswept = s.liquidity.filter((p) => p.sweptAt === undefined);
  return {
    tf,
    trend: s.trend ?? 'range',
    lastBreak: last ? { type: last.type, dir: last.dir, level: r(last.level), barsAgo: bars.length - 1 - last.index, at: iso(last.t) } : null,
    swingHigh: s.lastSwingHigh ? r(s.lastSwingHigh.price) : null,
    swingLow: s.lastSwingLow ? r(s.lastSwingLow.price) : null,
    ob: nearestZones(s.orderBlocks, price, f),
    fvg: nearestZones(fvgZones, price, f),
    liquidity: {
      eqhAbove: unswept
        .filter((p) => p.kind === 'EQH' && p.price > price)
        .sort((a, b) => a.price - b.price)
        .slice(0, 2)
        .map((p) => ({ price: r(p.price), distPips: pips(p.price - price) })),
      eqlBelow: unswept
        .filter((p) => p.kind === 'EQL' && p.price < price)
        .sort((a, b) => b.price - a.price)
        .slice(0, 2)
        .map((p) => ({ price: r(p.price), distPips: pips(price - p.price) })),
    },
    pd: pd
      ? {
          zone: pd.zone,
          posPct: Math.round(pd.position * 100),
          eq: r(pd.equilibrium),
          range: [r(pd.rangeLow), r(pd.rangeHigh)],
          leg: pd.leg,
          ote: [r(pd.ote.from), r(pd.ote.to)],
          inOte: pd.inOte,
        }
      : null,
  };
}

const TF_WEIGHT: Partial<Record<Timeframe, number>> = { MN1: 4, W1: 3.5, D1: 3, H12: 2.5, H4: 2, H1: 1.5, M30: 1.2, M15: 1, M10: 0.8, M5: 0.7, M1: 0.5 };

export interface Bias {
  bias: 'bullish' | 'bearish' | 'neutral';
  /** 0..1, share of the maximum possible score. */
  confidence: number;
  score: number;
  reasons: string[];
}

/**
 * Transparent scoring: each TF trend adds ±weight (higher TF weighs more), the
 * highest TF's premium/discount adds ±1 (discount favours longs), and a CHoCH
 * on the lowest TF against the higher-TF trend is reported as a warning.
 */
export function computeBias(summaries: TimeframeSummary[]): Bias {
  const reasons: string[] = [];
  let score = 0;
  let max = 0;
  const ordered = [...summaries].sort((a, b) => (TF_WEIGHT[b.tf] ?? 1) - (TF_WEIGHT[a.tf] ?? 1));
  for (const s of ordered) {
    const w = TF_WEIGHT[s.tf] ?? 1;
    max += w;
    if (s.trend === 'bull') score += w;
    if (s.trend === 'bear') score -= w;
    const lb = s.lastBreak ? ` (last ${s.lastBreak.type} ${s.lastBreak.dir} ${s.lastBreak.barsAgo} bars ago)` : '';
    reasons.push(`${s.tf} structure ${s.trend}${lb}`);
  }
  const htf = ordered.find((s) => s.pd);
  if (htf?.pd) {
    max += 1;
    if (htf.pd.zone === 'discount') score += 1;
    if (htf.pd.zone === 'premium') score -= 1;
    reasons.push(`${htf.tf} price in ${htf.pd.zone} (${htf.pd.posPct}% of range)${htf.pd.inOte ? ', inside OTE' : ''}`);
  }
  const top = ordered[0];
  const low = ordered.at(-1);
  if (top && low && top !== low && low.lastBreak?.type === 'CHoCH' && top.trend !== 'range' && low.lastBreak.dir !== top.trend) {
    reasons.push(`warning: ${low.tf} CHoCH ${low.lastBreak.dir} against ${top.tf} ${top.trend} trend`);
  }
  const threshold = max * 0.35;
  const bias = score >= threshold ? 'bullish' : score <= -threshold ? 'bearish' : 'neutral';
  return { bias, confidence: max > 0 ? roundTo(Math.abs(score) / max, 2) : 0, score: roundTo(score, 2), reasons };
}

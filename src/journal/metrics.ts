import type { Trade } from './trades.js';

/**
 * Performance metrics computed ONLY from the journal (closed trades).
 * R = realized P&L / risk planned at entry. A trade is a win when pnl > 0.
 */

export interface GroupStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  /** Mean R per trade (= expectancy in R). */
  avgR: number | null;
  /** Mean P&L per trade in account currency. */
  expectancy: number | null;
  totalPnl: number;
  totalR: number;
  profitFactor: number | null;
}

export interface Performance extends GroupStats {
  avgWinR: number | null;
  avgLossR: number | null;
  bestR: number | null;
  worstR: number | null;
  maxDrawdown: number;
  maxDrawdownR: number;
  maxConsecutiveLosses: number;
  /** Warnings about sample size, so nobody over-reads 12 trades. */
  notes: string[];
  bySymbol: Record<string, GroupStats>;
  byKillzone: Record<string, GroupStats>;
  bySetup: Record<string, GroupStats>;
}

export const MIN_SAMPLE = 30;

const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function closed(trades: Trade[]): Array<Trade & { pnl: number }> {
  return trades
    .filter((t): t is Trade & { pnl: number } => t.status === 'closed' && t.pnl !== null)
    .sort((a, b) => (a.closedAt ?? '').localeCompare(b.closedAt ?? '') || a.id - b.id);
}

export function groupStats(trades: Array<Trade & { pnl: number }>): GroupStats {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const withR = trades.filter((t) => t.rMultiple !== null);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const totalR = withR.reduce((a, t) => a + (t.rMultiple ?? 0), 0);
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: n > 0 ? r3(wins.length / n) : null,
    avgR: withR.length > 0 ? r3(totalR / withR.length) : null,
    expectancy: n > 0 ? r2(totalPnl / n) : null,
    totalPnl: r2(totalPnl),
    totalR: r2(totalR),
    // Undefined (null) with no losing trades: an infinite profit factor says nothing useful.
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
  };
}

function groupBy(trades: Array<Trade & { pnl: number }>, key: (t: Trade) => string): Record<string, GroupStats> {
  const groups = new Map<string, Array<Trade & { pnl: number }>>();
  for (const t of trades) {
    const k = key(t);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  return Object.fromEntries([...groups].sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, groupStats(v)]));
}

export function computePerformance(all: Trade[]): Performance {
  const trades = closed(all);
  const base = groupStats(trades);
  const rs = trades.map((t) => t.rMultiple).filter((r): r is number => r !== null);
  const winRs = trades.filter((t) => t.pnl > 0 && t.rMultiple !== null).map((t) => t.rMultiple!);
  const lossRs = trades.filter((t) => t.pnl <= 0 && t.rMultiple !== null).map((t) => t.rMultiple!);
  const mean = (xs: number[]) => (xs.length > 0 ? r3(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

  // Drawdown on the cumulative P&L (and cumulative R) curve, in close order.
  let cum = 0, peak = 0, maxDd = 0, cumR = 0, peakR = 0, maxDdR = 0, streak = 0, maxStreak = 0;
  for (const t of trades) {
    cum += t.pnl;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
    cumR += t.rMultiple ?? 0;
    peakR = Math.max(peakR, cumR);
    maxDdR = Math.max(maxDdR, peakR - cumR);
    streak = t.pnl <= 0 ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }

  const notes: string[] = [];
  if (trades.length < MIN_SAMPLE) notes.push(`only ${trades.length} closed trades: below ${MIN_SAMPLE}, results are not statistically meaningful yet`);
  const bySetup = groupBy(trades, (t) => t.setup ?? 'untagged');
  for (const [setup, s] of Object.entries(bySetup)) {
    if (s.trades >= 10 && s.avgR !== null && s.avgR < 0) notes.push(`setup "${setup}" has negative expectancy (${s.avgR}R over ${s.trades} trades)`);
  }

  return {
    ...base,
    avgWinR: mean(winRs),
    avgLossR: mean(lossRs),
    bestR: rs.length > 0 ? Math.max(...rs) : null,
    worstR: rs.length > 0 ? Math.min(...rs) : null,
    maxDrawdown: r2(maxDd),
    maxDrawdownR: r2(maxDdR),
    maxConsecutiveLosses: maxStreak,
    notes,
    bySymbol: groupBy(trades, (t) => t.symbol),
    byKillzone: groupBy(trades, (t) => t.killzone ?? 'outside killzones'),
    bySetup,
  };
}

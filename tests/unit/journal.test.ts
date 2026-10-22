/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument --
   Tool results are untyped JSON parsed from the MCP response. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PT } from '../../src/ctrader/payloadTypes.js';
import { openDatabase } from '../../src/db/database.js';
import { DailyStats } from '../../src/journal/dailyStats.js';
import { computePerformance, groupStats, MIN_SAMPLE } from '../../src/journal/metrics.js';
import { TradeStore, type Trade } from '../../src/journal/trades.js';
import { harness, type Harness } from '../helpers/harness.js';

let n = 0;
function trade(over: Partial<Trade>): Trade {
  n++;
  return {
    id: n, idempotencyKey: `k${n}`, orderId: n, positionId: n, symbol: 'EURUSD', side: 'BUY', orderType: 'LIMIT', status: 'closed',
    entryPlanned: 1.08, entry: 1.08, stopLoss: 1.078, takeProfit: 1.084, initialStopLoss: 1.078, units: 25_000, riskAmount: 50,
    depositCurrency: 'USD', thesis: 'x'.repeat(20), setup: 'OB', killzone: 'London', label: null,
    createdAt: `2026-10-${String(1 + (n % 28)).padStart(2, '0')}T10:00:00.000Z`, openedAt: null,
    closedAt: `2026-10-01T${String(n % 24).padStart(2, '0')}:00:00.000Z`, exitPrice: null, pnl: 0, rMultiple: 0,
    closeReason: null, rejectReason: null, ...over,
  };
}
const closedAt = (i: number) => new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();

describe('metrics', () => {
  // +2R, -1R, -1R, +2R, -1R, +1.5R = +2.5R  (risk $50)
  const rs = [2, -1, -1, 2, -1, 1.5];
  const trades = rs.map((r, i) => trade({ pnl: r * 50, rMultiple: r, closedAt: closedAt(i), setup: i < 3 ? 'OB' : 'FVG', killzone: i % 2 ? 'NY AM' : 'London', symbol: i < 4 ? 'EURUSD' : 'GBPUSD' }));

  it('core stats', () => {
    const p = computePerformance(trades);
    expect(p).toMatchObject({
      trades: 6, wins: 3, losses: 3, winRate: 0.5,
      avgR: 0.417, // 2.5 / 6
      expectancy: 20.83,
      totalPnl: 125, totalR: 2.5,
      profitFactor: 1.83, // 275 / 150
      avgWinR: 1.833, avgLossR: -1, bestR: 2, worstR: -1,
      maxConsecutiveLosses: 2,
    });
  });

  it('drawdown on the cumulative R curve 2,1,0,2,1,2.5: peak 2R, trough 0 => 2R / $100', () => {
    const p = computePerformance(trades);
    expect(p.maxDrawdown).toBe(100);
    expect(p.maxDrawdownR).toBe(2);
  });

  it('breakdowns by symbol, killzone and setup', () => {
    const p = computePerformance(trades);
    expect(p.bySetup.OB).toMatchObject({ trades: 3, totalR: 0 });
    expect(p.bySetup.FVG).toMatchObject({ trades: 3, totalR: 2.5 });
    expect(p.byKillzone.London!.trades).toBe(3);
    expect(p.bySymbol.GBPUSD).toMatchObject({ trades: 2, totalR: 0.5 });
  });

  it('ignores non-closed trades and orders by close time', () => {
    const p = computePerformance([...trades, trade({ status: 'open', pnl: null, rMultiple: null }), trade({ status: 'rejected', pnl: null })]);
    expect(p.trades).toBe(6);
  });

  it('warns on small samples and on setups with negative expectancy', () => {
    const p = computePerformance(trades);
    expect(p.notes[0]).toMatch(new RegExp(`below ${MIN_SAMPLE}`));
    const losers = Array.from({ length: 12 }, (_, i) => trade({ pnl: -50, rMultiple: -1, setup: 'bad', closedAt: closedAt(100 + i) }));
    expect(computePerformance(losers).notes.join()).toMatch(/setup "bad" has negative expectancy \(-1R over 12 trades\)/);
  });

  it('empty and no-loss edge cases', () => {
    expect(groupStats([])).toMatchObject({ trades: 0, winRate: null, avgR: null, profitFactor: null });
    expect(computePerformance([trade({ pnl: 50, rMultiple: 1 })]).profitFactor).toBeNull();
  });
});

describe('DailyStats', () => {
  it('records start/end balances per NY day and rebuilds counters from the journal', () => {
    const db = openDatabase(':memory:');
    const daily = new DailyStats(db, 'America/New_York');
    // 2026-10-22 03:00Z is still 2026-10-21 in New York
    daily.recordBalance(10_000, Date.parse('2026-10-22T03:00:00Z'));
    daily.recordBalance(10_050, Date.parse('2026-10-22T03:59:00Z'));
    daily.recordBalance(10_050, Date.parse('2026-10-22T05:00:00Z'));
    const store = new TradeStore(db, () => Date.parse('2026-10-22T14:00:00Z'));
    const id = store.insert({ idempotencyKey: 'a', symbol: 'EURUSD', side: 'BUY', orderType: 'LIMIT', entryPlanned: 1.08, stopLoss: 1.078, takeProfit: 1.084, units: 1, riskAmount: 50, depositCurrency: 'USD', thesis: 'x'.repeat(20), setup: null, killzone: null, label: null });
    store.update(id, { status: 'closed', openedAt: '2026-10-22T14:00:00.000Z', closedAt: '2026-10-22T15:00:00.000Z', pnl: -50, rMultiple: -1 });
    db.prepare("INSERT INTO events (ts, kind, data) VALUES ('2026-10-22T16:00:00.000Z', 'risk_rejected', '{}')").run();
    daily.rebuild();
    const rows = daily.list();
    expect(rows.find((r) => r.day === '2026-10-21')).toMatchObject({ startBalance: 10_000, endBalance: 10_050 });
    expect(rows.find((r) => r.day === '2026-10-22')).toMatchObject({ startBalance: 10_050, tradesOpened: 1, tradesClosed: 1, losses: 1, pnl: -50, rSum: -1, rejections: 1 });
  });
});

describe('journal reconciliation and tools (simulated broker)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.close();
  });

  const thesis = 'Reconciliation test: limit at H1 order block, invalidation below the block.';
  let key = 0;
  const k = () => `journal-${Date.now()}-${++key}`;

  it('a limit filled and then stopped out while events were lost is fixed from broker history', async () => {
    const placed = await h.call('place_limit_order', { symbol: 'EURUSD', side: 'BUY', entry: 1.079, stopLoss: 1.077, takeProfit: 1.083, thesis, setup: 'OB', idempotencyKey: k() });
    const tradeId = placed.data.tradeId as number;
    const positionId = h.sim.fillLimit(placed.data.order.orderId, true); // fill event lost
    h.sim.hitLevel(positionId, 1.077, true); // SL hit, event lost too
    expect(h.app.trades.get(tradeId)!.status).toBe('pending');

    const sentBefore = h.sim.count(PT.ORDER_DETAILS_REQ);
    await h.app.client.reconcile(); // what the client does on connect and every 5 min
    await vi.waitFor(() => expect(h.app.trades.get(tradeId)!.status).toBe('closed'));
    // first pass: pending -> open via ORDER_DETAILS; position is gone -> closed via deals
    expect(h.sim.count(PT.ORDER_DETAILS_REQ)).toBe(sentBefore + 1);
    const t = h.app.trades.get(tradeId)!;
    expect(t).toMatchObject({ positionId, entry: 1.079, exitPrice: 1.077, closeReason: 'stop_loss' });
    // 25k * -20 pips = -$50, plus $3 open + $3 close commission
    expect(t.pnl).toBeCloseTo(-56, 6);
    expect(t.rMultiple).toBeCloseTo(-1.12, 2);
  });

  it('a pending order cancelled outside the server is marked cancelled', async () => {
    const placed = await h.call('place_limit_order', { symbol: 'EURUSD', side: 'BUY', entry: 1.079, stopLoss: 1.077, takeProfit: 1.083, thesis, idempotencyKey: k() });
    const orderId = placed.data.order.orderId as number;
    h.sim.orders.delete(orderId);
    h.sim.orderHistory.set(orderId, { ...h.sim.orderHistory.get(orderId), orderStatus: 5 });
    await h.app.client.reconcile();
    await vi.waitFor(() => expect(h.app.trades.get(placed.data.tradeId)!.status).toBe('cancelled'));
  });

  it('costs no broker requests when nothing disagrees', async () => {
    await h.call('place_limit_order', { symbol: 'EURUSD', side: 'BUY', entry: 1.079, stopLoss: 1.077, takeProfit: 1.083, thesis, idempotencyKey: k() });
    const before = h.sim.count(PT.ORDER_DETAILS_REQ) + h.sim.count(PT.DEAL_LIST_BY_POSITION_ID_REQ);
    expect(await h.app.journalReconciler.run()).toBe(0);
    expect(h.sim.count(PT.ORDER_DETAILS_REQ) + h.sim.count(PT.DEAL_LIST_BY_POSITION_ID_REQ)).toBe(before);
  });

  it('get_journal and get_performance over a real lifecycle', async () => {
    // win: market BUY closed at TP; loss: market BUY stopped out
    const a = await h.call('place_market_order', { symbol: 'EURUSD', side: 'BUY', stopLoss: 1.07808, takeProfit: 1.08408, thesis, setup: 'sweep', idempotencyKey: k() });
    h.sim.hitLevel(a.data.position.positionId, 1.08408);
    await vi.waitFor(() => expect(h.app.trades.get(a.data.tradeId)!.status).toBe('closed'));
    const b = await h.call('place_market_order', { symbol: 'EURUSD', side: 'BUY', stopLoss: 1.07808, takeProfit: 1.08408, thesis, setup: 'sweep', idempotencyKey: k() });
    h.sim.hitLevel(b.data.position.positionId, 1.07808);
    await vi.waitFor(() => expect(h.app.trades.get(b.data.tradeId)!.status).toBe('closed'));

    const j = await h.call('get_journal', { limit: 5 });
    expect(j.isError).toBe(false);
    expect(j.data).toHaveLength(2);
    expect(j.data[0]).toMatchObject({ id: b.data.tradeId, status: 'closed', closeReason: 'stop_loss', setup: 'sweep', thesis });
    expect(j.data[1]).toMatchObject({ closeReason: 'take_profit' });
    const noThesis = await h.call('get_journal', { includeThesis: false, status: 'closed' });
    expect(noThesis.data[0]).not.toHaveProperty('thesis');

    const p = await h.call('get_performance', {});
    expect(p.isError).toBe(false);
    // +$100 -$6 = 94 => 1.88R ; -$50 -$6 = -56 => -1.12R
    expect(p.data).toMatchObject({ trades: 2, wins: 1, losses: 1, winRate: 0.5, totalPnl: 38, totalR: 0.76, profitFactor: 1.68 });
    expect(p.data.bySetup.sweep.trades).toBe(2);
    expect(p.data.notes[0]).toMatch(/not statistically meaningful/);
    expect(p.data.daily[0]).toMatchObject({ tradesClosed: 2, wins: 1, losses: 1 });
    const filtered = await h.call('get_performance', { setup: 'nope' });
    expect(filtered.data.trades).toBe(0);
  });
});

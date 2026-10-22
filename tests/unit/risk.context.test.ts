import { describe, expect, it } from 'vitest';
import { AccountState } from '../../src/ctrader/accountState.js';
import { PT } from '../../src/ctrader/payloadTypes.js';
import { DealSchema, ReconcileResSchema, type Deal } from '../../src/ctrader/schemas.js';
import { SpreadTracker } from '../../src/risk/spread.js';
import type { SymbolInfo } from '../../src/ctrader/symbols.js';
import { openDatabase } from '../../src/db/database.js';
import { EventLog } from '../../src/journal/events.js';
import { exposureRisk, pendingOrdersSince, positionsOpenedToday, realizedFromDeals, RiskService } from '../../src/risk/context.js';
import { DEFAULT_RULES } from '../../src/risk/engine.js';
import { startOfZonedDay, zonedDayKey, zonedTimeToUtc } from '../../src/time.js';

const deal = (over: Record<string, unknown>): Deal =>
  DealSchema.parse({
    dealId: 1,
    orderId: 1,
    positionId: 1,
    volume: 100_000,
    filledVolume: 100_000,
    symbolId: 1,
    createTimestamp: 0,
    executionTimestamp: 0,
    tradeSide: 1,
    dealStatus: 2,
    moneyDigits: 2,
    ...over,
  });

const EURUSD: SymbolInfo = {
  symbolId: 1, name: 'EURUSD', key: 'EURUSD', baseAssetId: 2, quoteAssetId: 1, baseAsset: 'EUR', quoteAsset: 'USD',
  digits: 5, pipPosition: 4, minVolume: 100_000, maxVolume: 1e10, stepVolume: 100_000, lotSize: 10_000_000,
};

describe('deals -> P&L and counts', () => {
  it('realized = closing gross + swap + commissions (opening and closing) + conversion fee', () => {
    const deals = [
      deal({ dealId: 1, commission: -300 }), // opening, -$3.00
      deal({ dealId: 2, closePositionDetail: { entryPrice: 1.08, grossProfit: 5000, swap: -50, commission: -300, balance: 0, pnlConversionFee: -10, moneyDigits: 2 } }),
      deal({ dealId: 3, dealStatus: 4, commission: -999 }), // rejected: ignored
    ];
    expect(realizedFromDeals(deals)).toBeCloseTo(-3 + 50 - 0.5 - 3 - 0.1, 10);
  });

  it('counts distinct positions opened on a symbol (partial fills count once)', () => {
    const deals = [deal({ dealId: 1, positionId: 10 }), deal({ dealId: 2, positionId: 10, dealStatus: 3 }), deal({ dealId: 3, positionId: 11 }), deal({ dealId: 4, positionId: 12, symbolId: 2 })];
    expect(positionsOpenedToday(deals, 1)).toBe(2);
  });

  it('counts pending orders created since the day start', () => {
    const order = (id: number, ts: number, symbolId = 1) => ({ orderId: id, tradeData: { symbolId, volume: 1, tradeSide: 1, openTimestamp: ts }, orderType: 2, orderStatus: 1 });
    const s = new AccountState();
    s.applyReconcile(ReconcileResSchema.parse({ ctidTraderAccountId: 1, order: [order(1, 100), order(2, 50), order(3, 200, 2)] }));
    expect(pendingOrdersSince(s.getOrders(), 1, 100)).toBe(1);
  });
});

describe('exposureRisk', () => {
  const base = { id: 'p', symbol: EURUSD, units: 10_000, pipValuePerUnit: 0.0001 };
  it('BUY 10k, 20 pips to SL = $20', () => {
    expect(exposureRisk({ ...base, side: 'BUY', entry: 1.08, stopLoss: 1.078 })).toBeCloseTo(20, 8);
  });
  it('SL at/above entry on a BUY = 0 risk (locked)', () => {
    expect(exposureRisk({ ...base, side: 'BUY', entry: 1.08, stopLoss: 1.081 })).toBe(0);
  });
  it('no SL = Infinity', () => {
    expect(exposureRisk({ ...base, side: 'SELL', entry: 1.08, stopLoss: undefined })).toBe(Infinity);
  });
});

describe('New York day boundaries', () => {
  it('midnight NY in EDT (UTC-4) and EST (UTC-5)', () => {
    expect(new Date(startOfZonedDay(Date.parse('2026-10-22T14:00:00Z'), 'America/New_York')).toISOString()).toBe('2026-10-22T04:00:00.000Z');
    expect(new Date(startOfZonedDay(Date.parse('2026-12-01T03:00:00Z'), 'America/New_York')).toISOString()).toBe('2026-11-30T05:00:00.000Z');
  });
  it('day key flips at NY midnight, not UTC midnight', () => {
    expect(zonedDayKey(Date.parse('2026-10-23T03:59:00Z'), 'America/New_York')).toBe('2026-10-22');
    expect(zonedDayKey(Date.parse('2026-10-23T04:00:00Z'), 'America/New_York')).toBe('2026-10-23');
  });
  it('handles the DST switch day', () => {
    // 2026-03-08: clocks jump 02:00 -> 03:00 EST->EDT. Midnight is still EST.
    expect(new Date(zonedTimeToUtc(2026, 3, 8, 0, 0, 'America/New_York')).toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(new Date(zonedTimeToUtc(2026, 3, 8, 7, 0, 'America/New_York')).toISOString()).toBe('2026-03-08T11:00:00.000Z');
  });
});

describe('SpreadTracker', () => {
  it('needs minSamples, samples at most once per interval and averages a rolling window', () => {
    const t = new SpreadTracker(10_000, 1_000, 3);
    t.record(1, 0.0001, 0);
    t.record(1, 0.0009, 500); // ignored: < 1 s since last sample
    t.record(1, 0.0002, 1_000);
    expect(t.average(1, 1_000)).toBeUndefined();
    t.record(1, 0.0003, 2_000);
    expect(t.average(1, 2_000)).toBeCloseTo(0.0002, 12);
    t.record(1, 0.0004, 11_500); // first sample (t=0) and t=1000 drop out of the window
    expect(t.average(1, 11_500)).toBeUndefined(); // only 2 left
  });
});

describe('RiskService', () => {
  function fakeDeps(opts: { balanceCents: number; unrealizedCents: number; deals?: unknown[] }) {
    const state = new AccountState();
    const client = {
      state,
      refreshTrader: () => Promise.resolve({ ctidTraderAccountId: 1, balance: opts.balanceCents, depositAssetId: 1, moneyDigits: 2 }),
      callAccount: (pt: number, _p: object, _e: number, schema: { parse: (x: unknown) => unknown }) => {
        if (pt === PT.GET_POSITION_UNREALIZED_PNL_REQ)
          return Promise.resolve(schema.parse({ positionUnrealizedPnL: [{ positionId: 1, grossUnrealizedPnL: 0, netUnrealizedPnL: opts.unrealizedCents }], moneyDigits: 2 }));
        if (pt === PT.DEAL_LIST_REQ) return Promise.resolve(schema.parse({ deal: opts.deals ?? [], hasMore: false }));
        return Promise.reject(new Error(`unexpected ${pt}`));
      },
    };
    const spreads = new SpreadTracker(3_600_000, 1, 1);
    spreads.record(1, 0.00008, Date.parse('2026-10-22T13:59:00Z'));
    const symbols = {
      spreads,
      get: () => Promise.resolve(EURUSD),
      getById: () => Promise.resolve(EURUSD),
      pipValuePerUnit: () => Promise.resolve(0.0001),
      ensureQuotes: () => Promise.resolve(),
      getQuote: () => ({ bid: 1.08, ask: 1.08008, mid: 1.08004, spread: 0.00008, at: 0 }),
      waitForQuote: () => Promise.reject(new Error('no')),
      assetName: () => 'USD',
    };
    const db = openDatabase(':memory:');
    const events = new EventLog(db);
    const svc = new RiskService({
      client: client as never,
      symbols: symbols,
      events,
      tz: 'America/New_York',
      now: () => Date.parse('2026-10-22T14:00:00Z'),
      limits: { riskPerTradePct: 0.5, maxOpenRiskPct: 2, maxTradesPerSymbolPerDay: 3, dailyLossLimitPct: 2, allowedSymbols: ['EURUSD'], ...DEFAULT_RULES },
    });
    return { svc, events };
  }

  const intent = { symbol: 'EURUSD', side: 'BUY' as const, orderType: 'LIMIT' as const, entry: 1.079, stopLoss: 1.077, takeProfit: 1.083 };

  it('builds the context from the broker and sizes on equity (balance + floating)', async () => {
    const { svc } = fakeDeps({ balanceCents: 1_000_000, unrealizedCents: 0 });
    const d = await svc.evaluate(intent, { record: 'preview' });
    expect(d.ok).toBe(true);
    expect(d.sizing?.units).toBe(25_000);
    expect(d.ctx?.dayStartBalance).toBe(10_000);
  });

  it('daily loss from realized deals + floating blocks and the rejection is journaled', async () => {
    const { svc, events } = fakeDeps({
      balanceCents: 985_000, // after -$150 realized today
      unrealizedCents: -6_000,
      deals: [{ dealId: 9, orderId: 9, positionId: 9, volume: 1, filledVolume: 1, symbolId: 1, createTimestamp: 0, executionTimestamp: 0, tradeSide: 1, dealStatus: 2, closePositionDetail: { entryPrice: 1, grossProfit: -15_000, swap: 0, commission: 0, balance: 985_000, moneyDigits: 2 } }],
    });
    const d = await svc.evaluate(intent, { idempotencyKey: 'k1' });
    expect(d.ok).toBe(false);
    expect(d.reasons.join()).toMatch(/daily_loss_limit/);
    const rows = events.list({ kind: 'risk_rejected' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: 'EURUSD', idempotencyKey: 'k1' });
    expect((rows[0]!.data as { reasons: string[] }).reasons[0]).toMatch(/daily_loss_limit/);
  });

  it('fails closed when the context cannot be built', async () => {
    const { svc, events } = fakeDeps({ balanceCents: 1_000_000, unrealizedCents: 0 });
    (svc as unknown as { o: { symbols: { get: () => Promise<never> } } }).o.symbols.get = () => Promise.reject(new Error('Unknown symbol XYZ'));
    const d = await svc.evaluate({ ...intent, symbol: 'XYZ' });
    expect(d.ok).toBe(false);
    expect(d.reasons[0]).toMatch(/context_unavailable: Unknown symbol XYZ/);
    expect(events.list({ kind: 'risk_rejected' })).toHaveLength(1);
  });
});

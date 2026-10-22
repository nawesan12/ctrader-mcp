/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call --
   Tool results are untyped JSON parsed from the MCP response; assertions check their shape. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type App } from '../../src/app.js';
import { CTraderClient } from '../../src/ctrader/client.js';
import { PT } from '../../src/ctrader/payloadTypes.js';
import { openDatabase, type DB } from '../../src/db/database.js';
import { registerTools } from '../../src/mcp/tools.js';
import { SpreadTracker } from '../../src/risk/spread.js';
import { IdempotencyStore } from '../../src/trading/idempotency.js';
import { MemoryTokens, silentLogger } from '../helpers/fakeBroker.js';
import { SimBroker } from '../helpers/simBroker.js';

interface Harness {
  sim: SimBroker;
  app: App;
  db: DB;
  mcp: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; data: any }>;
  close: () => Promise<void>;
}

const CONFIG = {
  TZ_SESSIONS: 'America/New_York',
  ALLOWED_SYMBOLS: ['EURUSD', 'USDJPY', 'EURGBP', 'GBPUSD'],
  RISK_PER_TRADE_PCT: 0.5,
  MAX_OPEN_RISK_PCT: 2,
  MAX_TRADES_PER_SYMBOL_PER_DAY: 3,
  DAILY_LOSS_LIMIT_PCT: 2,
};

async function harness(over: Partial<typeof CONFIG> = {}, confirmTimeoutMs = 2_000): Promise<Harness> {
  const sim = new SimBroker();
  const db = openDatabase(':memory:');
  const client = new CTraderClient({
    clientId: 'id',
    clientSecret: 's',
    transportFactory: sim.transportFactory,
    tokens: new MemoryTokens(),
    logger: silentLogger,
    heartbeatIntervalMs: 60_000,
  });
  const app = createApp({
    config: { ...CONFIG, ...over },
    client,
    db,
    logger: silentLogger,
    // one sample is enough for a baseline in tests
    spreads: new SpreadTracker(2 * 3_600_000, 1, 1),
    confirmTimeoutMs,
  });
  await client.start();
  await app.symbols.refreshLists();

  const server = new McpServer({ name: 'ctrader-mcp', version: 'test' });
  registerTools(server, app);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: 'test', version: '1' });
  await mcp.connect(b);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    const text = r.content[0]?.text ?? 'null';
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { isError: r.isError === true, data };
  };
  return {
    sim, app, db, mcp, call,
    close: async () => {
      await mcp.close();
      await server.close();
      await client.stop();
      db.close();
    },
  };
}

const THESIS = 'H1 bullish BOS, price back in discount at H1 OB + FVG; invalidation below the OB low.';
let key = 0;
const k = () => `test-key-${Date.now()}-${++key}`;

// EURUSD sim: bid 1.08000 / ask 1.08008. $10k account, 0.5% = $50.
const limitArgs = (over: Record<string, unknown> = {}) => ({
  symbol: 'EURUSD', side: 'BUY', entry: 1.079, stopLoss: 1.077, takeProfit: 1.083, thesis: THESIS, setup: 'OB+FVG H1', idempotencyKey: k(), ...over,
});

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

describe('tool catalogue', () => {
  it('exposes every tool with an input schema', async () => {
    const { tools } = await h.mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'amend_order', 'amend_position_sl_tp', 'cancel_order', 'close_position', 'get_account', 'get_candles', 'get_orders',
        'get_positions', 'get_smc_context', 'get_symbol_info', 'place_limit_order', 'place_market_order', 'preview_order',
      ].sort(),
    );
    const place = tools.find((t) => t.name === 'place_limit_order')!;
    expect(place.inputSchema.required).toEqual(expect.arrayContaining(['symbol', 'side', 'entry', 'stopLoss', 'takeProfit', 'thesis', 'idempotencyKey']));
    expect(place.annotations?.readOnlyHint).toBe(false);
  });

  it('rejects invalid input before reaching the handler (no SL, short thesis)', async () => {
    const r1 = await h.call('place_limit_order', { ...limitArgs(), stopLoss: undefined });
    expect(r1.isError).toBe(true);
    const r2 = await h.call('place_limit_order', limitArgs({ thesis: 'too short' }));
    expect(r2.isError).toBe(true);
    expect(h.sim.count(PT.NEW_ORDER_REQ)).toBe(0);
  });
});

describe('read tools', () => {
  it('get_account', async () => {
    const r = await h.call('get_account');
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({
      currency: 'USD',
      balance: 10_000,
      equity: 10_000,
      risk: { openRisk: 0, openRiskPct: 0, unprotected: [] },
      limits: { openRiskRemainingPct: 2, dailyLossRemainingPct: 2, newOrdersBlocked: false, tradesLeftToday: { EURUSD: 3, USDJPY: 3 } },
    });
  });

  it('get_symbol_info: pip value per lot for EURUSD ($10) and USDJPY (~$6.67)', async () => {
    const eu = await h.call('get_symbol_info', { symbol: 'EUR/USD' });
    expect(eu.data).toMatchObject({ symbol: 'EURUSD', digits: 5, pipPosition: 4, units: { lot: 100_000, min: 1_000, step: 1_000 }, spreadPips: 0.8 });
    expect(eu.data.pipValue.perLot).toBeCloseTo(10, 6);
    const uj = await h.call('get_symbol_info', { symbol: 'USDJPY' });
    expect(uj.data.pipValue.perLot).toBeCloseTo(1000 / 150.006, 3);
  });

  it('get_candles is columnar and capped', async () => {
    const r = await h.call('get_candles', { symbol: 'EURUSD', timeframe: 'H1', count: 50 });
    expect(r.data.count).toBe(50);
    expect(r.data.c).toHaveLength(50);
    expect(r.data).not.toHaveProperty('candles');
    expect((await h.call('get_candles', { symbol: 'EURUSD', timeframe: 'H1', count: 501 })).isError).toBe(true);
  });

  it('get_smc_context returns a compact context', async () => {
    const r = await h.call('get_smc_context', { symbol: 'EURUSD' });
    expect(r.isError).toBe(false);
    expect(r.data.timeframes.map((t: { tf: string }) => t.tf)).toEqual(['H4', 'H1', 'M15']);
    expect(['bullish', 'bearish', 'neutral']).toContain(r.data.bias.bias);
    expect(JSON.stringify(r.data).length).toBeLessThan(6000);
  });
});

describe('preview_order', () => {
  it('sizes and approves without sending anything', async () => {
    const r = await h.call('preview_order', { symbol: 'EURUSD', side: 'BUY', orderType: 'LIMIT', entry: 1.079, stopLoss: 1.077, takeProfit: 1.083 });
    expect(r.data).toMatchObject({ ok: true, sizing: { units: 25_000, riskAmount: 50, rewardRisk: 2 } });
    expect(h.sim.count(PT.NEW_ORDER_REQ)).toBe(0);
  });

  it('reports failing rules and journals the rejection', async () => {
    const r = await h.call('preview_order', { symbol: 'EURUSD', side: 'BUY', orderType: 'LIMIT', entry: 1.079, stopLoss: 1.077, takeProfit: 1.081 });
    expect(r.isError).toBe(true);
    expect(r.data.reasons[0]).toMatch(/^reward_risk/);
    expect(h.app.events.list({ kind: 'risk_rejected' })).toHaveLength(1);
  });
});

describe('limit order lifecycle: place -> amend -> cancel', () => {
  it('places a confirmed limit, journals it, and is idempotent', async () => {
    const args = limitArgs({ expiresAt: new Date(Date.now() + 3_600_000).toISOString(), label: 'test' });
    const r = await h.call('place_limit_order', args);
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ ok: true, status: 'accepted', order: { symbol: 'EURUSD', side: 'BUY', type: 'LIMIT', units: 25_000, price: 1.079, stopLoss: 1.077, takeProfit: 1.083 } });

    const sent = h.sim.lastSent(PT.NEW_ORDER_REQ)!;
    expect(sent).toMatchObject({ orderType: 2, tradeSide: 1, volume: 2_500_000, limitPrice: 1.079, stopLoss: 1.077, takeProfit: 1.083, timeInForce: 1, clientOrderId: args.idempotencyKey });

    const trade = h.app.trades.get(r.data.tradeId)!;
    expect(trade).toMatchObject({ status: 'pending', thesis: THESIS, setup: 'OB+FVG H1', riskAmount: 50, orderId: r.data.order.orderId });

    // same key -> same result, nothing sent twice
    const again = await h.call('place_limit_order', args);
    expect(again.data).toMatchObject({ ok: true, duplicate: true, tradeId: r.data.tradeId });
    expect(h.sim.count(PT.NEW_ORDER_REQ)).toBe(1);

    // same key, different request -> error
    const conflict = await h.call('place_limit_order', { ...args, entry: 1.0785 });
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict.data)).toMatch(/already used for a different request/);

    const orders = await h.call('get_orders');
    expect(orders.data).toHaveLength(1);
    expect(orders.data[0]).toMatchObject({ orderId: r.data.order.orderId, riskAmount: 50, setup: 'OB+FVG H1', pipsFromMarket: 10.8 });
  });

  it('amend_order re-runs risk and never increases size', async () => {
    const placed = await h.call('place_limit_order', limitArgs());
    const orderId = placed.data.order.orderId as number;
    // tighter SL (15 pips) would allow 33k units, but the order stays at 25k
    const r = await h.call('amend_order', { orderId, stopLoss: 1.0775, takeProfit: 1.083, reason: 'tighter invalidation', idempotencyKey: k() });
    expect(r.data).toMatchObject({ ok: true, status: 'replaced', order: { stopLoss: 1.0775, units: 25_000 } });
    // wider SL (40 pips) -> 12.5k units -> shrinks to 12k
    const r2 = await h.call('amend_order', { orderId, stopLoss: 1.075, takeProfit: 1.085, reason: 'wider structure', idempotencyKey: k() });
    expect(r2.data.order.units).toBe(12_000);
    expect(h.app.trades.byOrder(orderId)).toMatchObject({ stopLoss: 1.075, units: 12_000 });
    // a bad R:R is rejected and nothing is sent
    const before = h.sim.count(PT.AMEND_ORDER_REQ);
    const bad = await h.call('amend_order', { orderId, takeProfit: 1.08, reason: 'test', idempotencyKey: k() });
    expect(bad.isError).toBe(true);
    expect(h.sim.count(PT.AMEND_ORDER_REQ)).toBe(before);
  });

  it('cancel_order cancels and the journal marks it', async () => {
    const placed = await h.call('place_limit_order', limitArgs());
    const orderId = placed.data.order.orderId as number;
    const r = await h.call('cancel_order', { orderId, reason: 'setup invalidated', idempotencyKey: k() });
    expect(r.data).toMatchObject({ ok: true, status: 'cancelled' });
    await vi.waitFor(() => expect(h.app.trades.get(placed.data.tradeId)?.status).toBe('cancelled'));
    expect((await h.call('get_orders')).data).toEqual([]);
  });

  it('a later fill of the resting limit opens the trade in the journal', async () => {
    const placed = await h.call('place_limit_order', limitArgs());
    const positionId = h.sim.fillLimit(placed.data.order.orderId);
    await vi.waitFor(() => expect(h.app.trades.get(placed.data.tradeId)).toMatchObject({ status: 'open', positionId, entry: 1.079 }));
  });
});

describe('market order lifecycle: place -> breakeven -> partial close -> close', () => {
  const marketArgs = (over: Record<string, unknown> = {}) => ({
    symbol: 'EURUSD', side: 'BUY', stopLoss: 1.07808, takeProfit: 1.08408, thesis: THESIS, setup: 'sweep', idempotencyKey: k(), ...over,
  });

  it('fills with relative SL/TP and returns the confirmed position', async () => {
    const r = await h.call('place_market_order', marketArgs());
    expect(r.data).toMatchObject({ ok: true, status: 'filled', position: { side: 'BUY', units: 25_000, entry: 1.08008, stopLoss: 1.07808, takeProfit: 1.08408 } });
    const sent = h.sim.lastSent(PT.NEW_ORDER_REQ)!;
    expect(sent).toMatchObject({ orderType: 1, relativeStopLoss: 200, relativeTakeProfit: 400 });
    expect(sent).not.toHaveProperty('stopLoss');
    expect(h.app.trades.get(r.data.tradeId)).toMatchObject({ status: 'open', entry: 1.08008, positionId: r.data.position.positionId });
  });

  it('full lifecycle with journal P&L and R', async () => {
    const opened = await h.call('place_market_order', marketArgs());
    const positionId = opened.data.position.positionId as number;
    h.sim.setPrice(1, 1.0821, 1.08218); // +20.2 pips on bid
    h.sim.unrealized.set(positionId, 50.5);

    const pos = await h.call('get_positions');
    expect(pos.data[0]).toMatchObject({ positionId, pnl: 50.5, r: 1.01, pipsToSL: 40.2, pipsToTP: 19.8, setup: 'sweep' });

    // move SL to breakeven: allowed
    const be = await h.call('amend_position_sl_tp', { positionId, stopLoss: 1.08008, takeProfit: 1.08408, reason: 'move to BE at +1R', idempotencyKey: k() });
    expect(be.data).toMatchObject({ ok: true, status: 'replaced', position: { stopLoss: 1.08008 } });
    // widening back is rejected without touching the broker
    const sent = h.sim.count(PT.AMEND_POSITION_SLTP_REQ);
    const wide = await h.call('amend_position_sl_tp', { positionId, stopLoss: 1.079, takeProfit: 1.08408, reason: 'try to widen the stop', idempotencyKey: k() });
    expect(wide.isError).toBe(true);
    expect(wide.data.reasons[0]).toMatch(/^sl_not_wider/);
    expect(h.sim.count(PT.AMEND_POSITION_SLTP_REQ)).toBe(sent);

    // partial close 10k
    const part = await h.call('close_position', { positionId, units: 10_000, reason: 'scale out at 1R', idempotencyKey: k() });
    expect(part.data).toMatchObject({ ok: true, status: 'partially_closed' });
    // close the rest
    const all = await h.call('close_position', { positionId, reason: 'target structure reached', idempotencyKey: k() });
    expect(all.data).toMatchObject({ ok: true, status: 'closed' });

    await vi.waitFor(() => expect(h.app.trades.get(opened.data.tradeId)?.status).toBe('closed'));
    const t = h.app.trades.get(opened.data.tradeId)!;
    // (1.0821-1.08008)*10k = 20.20 and *15k = 30.30, minus 3 commissions of $3
    expect(t.pnl).toBeCloseTo(20.2 + 30.3 - 9, 6);
    expect(t.rMultiple).toBeCloseTo((20.2 + 30.3 - 9) / 50, 2);
    expect(t.closeReason).toBe('target structure reached');
    expect((await h.call('get_positions')).data).toEqual([]);
  });

  it('an SL hit by the market closes the trade with an inferred reason', async () => {
    const opened = await h.call('place_market_order', marketArgs());
    h.sim.hitLevel(opened.data.position.positionId, 1.07808);
    await vi.waitFor(() => expect(h.app.trades.get(opened.data.tradeId)?.status).toBe('closed'));
    const t = h.app.trades.get(opened.data.tradeId)!;
    expect(t.closeReason).toBe('stop_loss');
    expect(t.rMultiple).toBeCloseTo((-50 - 6) / 50, 2);
  });

  it('market orders are blocked by the news window', async () => {
    const r = await h.call('place_market_order', marketArgs({ newsEvents: [{ currency: 'USD', time: new Date(Date.now() + 5 * 60_000).toISOString(), impact: 'high', title: 'CPI' }] }));
    expect(r.isError).toBe(true);
    expect(r.data.reasons.join()).toMatch(/news_window/);
    expect(h.sim.count(PT.NEW_ORDER_REQ)).toBe(0);
  });
});

describe('broker failures', () => {
  it('broker rejection -> rejected result and journal row', async () => {
    h.sim.rejectNextOrder = 'TRADING_BAD_VOLUME';
    const r = await h.call('place_limit_order', limitArgs());
    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({ ok: false, status: 'rejected', reasons: ['TRADING_BAD_VOLUME: simulated rejection'] });
    expect(h.app.trades.get(r.data.tradeId)).toMatchObject({ status: 'rejected' });
  });

  it('no answer -> unconfirmed after reconcile, never auto-retried', async () => {
    await h.close();
    h = await harness({}, 200);
    h.sim.silentNext = true;
    const reconciles = h.sim.count(PT.RECONCILE_REQ);
    const r = await h.call('place_limit_order', limitArgs());
    expect(r.data).toMatchObject({ ok: false, status: 'unconfirmed' });
    expect(h.sim.count(PT.RECONCILE_REQ)).toBe(reconciles + 1);
    expect(h.sim.count(PT.NEW_ORDER_REQ)).toBe(1);
  });
});

describe('risk limits across tools', () => {
  it('concurrent orders are serialised: only the ones within the daily trade limit pass', async () => {
    await h.close();
    h = await harness({ MAX_TRADES_PER_SYMBOL_PER_DAY: 2, MAX_OPEN_RISK_PCT: 5 });
    const results = await Promise.all([1, 2, 3, 4].map((i) => h.call('place_limit_order', limitArgs({ entry: 1.079 - i * 0.0001, stopLoss: 1.077 - i * 0.0001 }))));
    expect(results.filter((r) => r.data.ok === true)).toHaveLength(2);
    expect(results.filter((r) => r.data.ok === false).every((r) => r.data.reasons.join().includes('trades_per_symbol_today'))).toBe(true);
    expect(h.sim.count(PT.NEW_ORDER_REQ)).toBe(2);
  });

  it('get_account reflects open risk and exposure after an order', async () => {
    await h.call('place_limit_order', limitArgs());
    const r = await h.call('get_account');
    expect(r.data.risk).toMatchObject({ openRisk: 50, openRiskPct: 0.5, exposurePct: { EUR: 0.5, USD: -0.5 } });
    expect(r.data.limits.tradesLeftToday.EURUSD).toBe(2);
  });
});

describe('IdempotencyStore', () => {
  it('forgets keys after 10 minutes and releases unsent claims', () => {
    let now = 0;
    const store = new IdempotencyStore(openDatabase(':memory:'), () => now);
    expect(store.claim('k1', 't', { a: 1 }).kind).toBe('new');
    expect(store.claim('k1', 't', { a: 1 }).kind).toBe('in_progress');
    store.complete('k1', { ok: true });
    expect(store.claim('k1', 't', { a: 1 })).toEqual({ kind: 'duplicate', result: { ok: true } });
    // key order does not matter
    expect(store.claim('k1', 't', { a: 1, b: undefined }).kind).toBe('duplicate');
    now = 10 * 60_000 + 1;
    expect(store.claim('k1', 't', { a: 2 }).kind).toBe('new');
    store.release('k1');
    expect(store.claim('k1', 't', { a: 3 }).kind).toBe('new');
  });
});

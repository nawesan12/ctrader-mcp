import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { AccountState } from '../../src/ctrader/accountState.js';
import { SlidingWindowLimiter } from '../../src/ctrader/rateLimiter.js';
import { ExecutionEventSchema, ReconcileResSchema, int64 } from '../../src/ctrader/schemas.js';
import { openDatabase } from '../../src/db/database.js';
import { TokenStore } from '../../src/db/tokenStore.js';
import { createLogger } from '../../src/logger.js';
import { position } from '../helpers/fakeBroker.js';

describe('SlidingWindowLimiter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lets at most `limit` through per window and queues the rest FIFO', async () => {
    const lim = new SlidingWindowLimiter(3, 1000);
    const order: number[] = [];
    const all = [1, 2, 3, 4, 5].map((i) => lim.acquire().then(() => order.push(i)));
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([1, 2, 3]);
    await vi.advanceTimersByTimeAsync(999);
    expect(order).toEqual([1, 2, 3]);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    await Promise.all(all);
  });

  it('historical limit (4/s) spreads 10 requests over > 2 s', async () => {
    const lim = new SlidingWindowLimiter(4, 1000);
    let done = 0;
    for (let i = 0; i < 10; i++) void lim.acquire().then(() => done++);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(4);
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(8);
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(10);
  });
});

describe('TokenStore', () => {
  it('round-trips the pair and stores only ciphertext', () => {
    const db = openDatabase(':memory:');
    const store = new TokenStore(db, 'client-secret');
    store.save({ accessToken: 'ACCESS-123', refreshToken: 'REFRESH-456', expiresAt: 42 });
    expect(store.load()).toEqual({ accessToken: 'ACCESS-123', refreshToken: 'REFRESH-456', expiresAt: 42 });
    const row = db.prepare('SELECT ciphertext FROM tokens').get() as { ciphertext: Buffer };
    expect(row.ciphertext.toString('utf8')).not.toContain('ACCESS-123');
  });

  it('cannot be decrypted with another secret', () => {
    const db = openDatabase(':memory:');
    new TokenStore(db, 'right').save({ accessToken: 'a', refreshToken: 'b' });
    expect(() => new TokenStore(db, 'wrong').load()).toThrow();
  });

  it('bootstraps from env only when empty; afterwards the stored pair wins', () => {
    const db = openDatabase(':memory:');
    const store = new TokenStore(db, 's');
    expect(store.loadOrBootstrap({ accessToken: 'ENV_A', refreshToken: 'ENV_R' })).toEqual({ accessToken: 'ENV_A', refreshToken: 'ENV_R' });
    store.save({ accessToken: 'NEW_A', refreshToken: 'NEW_R' });
    expect(store.loadOrBootstrap({ accessToken: 'ENV_A', refreshToken: 'ENV_R' }).accessToken).toBe('NEW_A');
  });

  it('fails clearly when empty and no env tokens', () => {
    const store = new TokenStore(openDatabase(':memory:'), 's');
    expect(() => store.loadOrBootstrap({})).toThrow(/CTRADER_ACCESS_TOKEN/);
  });
});

describe('schemas', () => {
  it('int64 accepts numbers and numeric strings, rejects unsafe values', () => {
    expect(int64.parse(12)).toBe(12);
    expect(int64.parse('1700000000000')).toBe(1_700_000_000_000);
    expect(() => int64.parse('9223372036854775807')).toThrow();
  });

  it('enums accept numeric values or proto names', () => {
    const ev = ExecutionEventSchema.parse({
      ctidTraderAccountId: '1001',
      executionType: 'ORDER_FILLED',
      position: { ...position(1), positionStatus: 'POSITION_STATUS_OPEN', tradeData: { symbolId: 1, volume: 100, tradeSide: 'SELL' } },
    });
    expect(ev.executionType).toBe(3);
    expect(ev.position?.positionStatus).toBe(1);
    expect(ev.position?.tradeData.tradeSide).toBe(2);
    expect(() => ExecutionEventSchema.parse({ ctidTraderAccountId: 1, executionType: 99 })).toThrow();
  });
});

describe('AccountState', () => {
  it('tracks pending orders and drops filled/cancelled ones', () => {
    const s = new AccountState();
    const order = (status: number, orderType = 2) => ({
      orderId: 10,
      tradeData: { symbolId: 1, volume: 100, tradeSide: 1 },
      orderType,
      orderStatus: status,
      limitPrice: 1.1,
    });
    s.applyExecution(ExecutionEventSchema.parse({ ctidTraderAccountId: 1, executionType: 2, order: order(1) }));
    expect(s.getOrder(10)).toBeDefined();
    s.applyExecution(ExecutionEventSchema.parse({ ctidTraderAccountId: 1, executionType: 5, order: order(5) }));
    expect(s.getOrder(10)).toBeUndefined();
    s.applyExecution(ExecutionEventSchema.parse({ ctidTraderAccountId: 1, executionType: 2, order: order(1, 1) }));
    expect(s.getOrder(10)).toBeUndefined(); // market orders never rest
  });

  it('reconcile replaces state and reports the drift', () => {
    const s = new AccountState();
    s.applyReconcile(ReconcileResSchema.parse({ ctidTraderAccountId: 1, position: [position(1), position(2)] }));
    const diff = s.applyReconcile(ReconcileResSchema.parse({ ctidTraderAccountId: 1, position: [position(2), position(3)] }));
    expect(s.getPositions().map((p) => p.positionId)).toEqual([2, 3]);
    expect(diff.positionsChanged).toBe(2);
  });
});

describe('config', () => {
  const base = { CTRADER_CLIENT_ID: 'id', CTRADER_CLIENT_SECRET: 'secret', CTRADER_ENV: 'demo' };

  it('parses defaults and lists', () => {
    const c = loadConfig({ ...base, ALLOWED_SYMBOLS: 'eurusd, USDJPY,,' });
    expect(c.ALLOWED_SYMBOLS).toEqual(['EURUSD', 'USDJPY']);
    expect(c.RISK_PER_TRADE_PCT).toBe(0.5);
    expect(c.CTRADER_ACCOUNT_ID).toBeUndefined();
  });

  it('refuses anything but demo', () => {
    expect(() => loadConfig({ ...base, CTRADER_ENV: 'live' })).toThrow(/CTRADER_ENV/);
  });

  it('never echoes secret values in errors', () => {
    try {
      loadConfig({ CTRADER_CLIENT_SECRET: 'SUPER-SECRET', CTRADER_ENV: 'demo', PORT: 'x' });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('SUPER-SECRET');
    }
  });
});

describe('logger', () => {
  it('redacts tokens and secrets', () => {
    let out = '';
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        out += chunk.toString();
        cb();
      },
    });
    const log = createLogger('info', sink);
    log.info({ accessToken: 'AAA', payload: { refreshToken: 'RRR', clientSecret: 'SSS' } }, 'msg');
    expect(out).not.toMatch(/AAA|RRR|SSS/);
    expect(out).toContain('[REDACTED]');
  });
});

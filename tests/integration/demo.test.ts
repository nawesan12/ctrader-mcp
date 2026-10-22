/**
 * Integration tests against the REAL cTrader demo environment.
 *   INTEGRATION=1 npm run test:integration
 * Optional (rotates the token pair, persisted in DATA_DIR):
 *   INTEGRATION=1 INTEGRATION_REFRESH=1 npm run test:integration
 *
 * Uses the same SQLite file as the app so a refreshed pair is never lost.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CTRADER_DEMO_JSON_URL, loadConfig } from '../../src/config.js';
import { CTraderClient } from '../../src/ctrader/client.js';
import { trendbarsToCandles } from '../../src/ctrader/normalize.js';
import { PT, TrendbarPeriod } from '../../src/ctrader/payloadTypes.js';
import { AccountListResSchema, TrendbarsResSchema } from '../../src/ctrader/schemas.js';
import { SymbolService } from '../../src/ctrader/symbols.js';
import { JsonWsTransport } from '../../src/ctrader/transport.js';
import { openDatabase, type DB } from '../../src/db/database.js';
import { TokenStore } from '../../src/db/tokenStore.js';
import { SmcService } from '../../src/analysis/service.js';
import { CandleService } from '../../src/ctrader/candles.js';
import { EventLog } from '../../src/journal/events.js';
import { createLogger } from '../../src/logger.js';
import { RiskService } from '../../src/risk/context.js';
import { riskLimitsFromConfig } from '../../src/risk/limits.js';

const enabled = process.env.INTEGRATION === '1';

describe.skipIf(!enabled)('cTrader demo (integration)', () => {
  let client: CTraderClient;
  let symbols: SymbolService;
  let store: TokenStore;
  let db: DB;
  let risk: RiskService;
  let candles: CandleService;

  beforeAll(async () => {
    if (existsSync('.env')) process.loadEnvFile('.env');
    const config = loadConfig();
    db = openDatabase(join(config.DATA_DIR, 'ctrader-mcp.db'));
    store = new TokenStore(db, config.CTRADER_CLIENT_SECRET);
    store.loadOrBootstrap({ accessToken: config.CTRADER_ACCESS_TOKEN, refreshToken: config.CTRADER_REFRESH_TOKEN });
    const log = createLogger(process.env.LOG_LEVEL ?? 'warn');
    client = new CTraderClient({
      clientId: config.CTRADER_CLIENT_ID,
      clientSecret: config.CTRADER_CLIENT_SECRET,
      accountId: config.CTRADER_ACCOUNT_ID,
      transportFactory: () => new JsonWsTransport({ url: CTRADER_DEMO_JSON_URL }),
      tokens: store,
      logger: log,
    });
    symbols = new SymbolService(client, db, log);
    risk = new RiskService({ client, symbols, events: new EventLog(db), limits: riskLimitsFromConfig(config), tz: config.TZ_SESSIONS });
    candles = new CandleService(client);
    await client.start();
  }, 60_000);

  afterAll(async () => {
    await client?.stop();
    db?.close();
  });

  it('authenticates a DEMO account', async () => {
    expect(client.status).toBe('ready');
    const list = await client.call(
      PT.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ,
      { accessToken: store.load()!.accessToken },
      PT.GET_ACCOUNTS_BY_ACCESS_TOKEN_RES,
      AccountListResSchema,
    );
    const acc = list.ctidTraderAccount.find((a) => a.ctidTraderAccountId === client.accountId);
    expect(acc?.isLive).toBe(false);
    // eslint-disable-next-line no-console
    console.log('demo accounts:', list.ctidTraderAccount.map((a) => ({ id: a.ctidTraderAccountId, isLive: a.isLive, broker: a.brokerTitleShort })));
  });

  it('loads symbols and EURUSD details', async () => {
    await symbols.refreshLists();
    const eurusd = await symbols.get('EURUSD');
    expect(eurusd.digits).toBeGreaterThan(0);
    expect(eurusd.pipPosition).toBeGreaterThan(0);
    expect(eurusd.minVolume).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log('EURUSD:', eurusd);
  }, 30_000);

  it('fetches H1 EURUSD candles and rebuilds OHLC', async () => {
    const eurusd = await symbols.get('EURUSD');
    const to = Date.now();
    const res = await client.callAccount(
      PT.GET_TRENDBARS_REQ,
      { symbolId: eurusd.symbolId, period: TrendbarPeriod.H1, fromTimestamp: to - 7 * 24 * 3600_000, toTimestamp: to, count: 50 },
      PT.GET_TRENDBARS_RES,
      TrendbarsResSchema,
    );
    const candles = trendbarsToCandles(res.trendbar, eurusd.digits);
    expect(candles.length).toBeGreaterThan(0);
    for (const c of candles) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
    }
    // eslint-disable-next-line no-console
    console.log(`got ${candles.length} H1 bars (hasMore=${String(res.hasMore)}), last:`, candles.at(-1));
  }, 30_000);

  it('computes pip values for EURUSD, USDJPY and EURGBP in the deposit currency', async () => {
    const deposit = client.trader!.depositAssetId;
    for (const name of ['EURUSD', 'USDJPY', 'EURGBP']) {
      const s = await symbols.get(name);
      const perUnit = await symbols.pipValuePerUnit(s, deposit);
      // eslint-disable-next-line no-console
      console.log(`${name}: pip value per 100k = ${(perUnit * 100_000).toFixed(4)} ${symbols.assetName(deposit)}`);
      expect(perUnit).toBeGreaterThan(0);
    }
  }, 30_000);

  it('risk engine: evaluates a far-away EURUSD limit against the live account (nothing is sent)', async () => {
    const eurusd = await symbols.get('EURUSD');
    await symbols.ensureQuotes([eurusd.symbolId]);
    const q = await symbols.waitForQuote(eurusd.symbolId, 10_000);
    const entry = q.bid - 0.02; // 200 pips below
    const d = await risk.evaluate(
      { symbol: 'EURUSD', side: 'BUY', orderType: 'LIMIT', entry, stopLoss: entry - 0.002, takeProfit: entry + 0.004 },
      { record: 'preview' },
    );
    // eslint-disable-next-line no-console
    console.log('preview:', { ok: d.ok, reasons: d.reasons, sizing: d.sizing, equity: d.ctx?.equity, avgSpread: d.ctx?.avgSpread });
    expect(d.sizing?.slPips).toBeCloseTo(20, 0);
    expect(d.sizing?.riskAmount).toBeGreaterThan(0);
  }, 30_000);

  it('fetches 500 closed H1 candles (paginating if the broker caps count)', async () => {
    const eurusd = await symbols.get('EURUSD');
    const bars = await candles.get(eurusd, 'H1', { count: 500 });
    expect(bars).toHaveLength(500);
    expect(bars.at(-1)!.t + 3_600_000).toBeLessThanOrEqual(Date.now());
  }, 60_000);

  it('get_smc_context for EURUSD (H4/H1/M15)', async () => {
    const smc = new SmcService({ symbols, candles, tz: 'America/New_York' });
    const ctx = await smc.context('EURUSD');
    const json = JSON.stringify(ctx);
    // eslint-disable-next-line no-console
    console.log(`smc context (${json.length} chars):`, JSON.stringify(ctx, null, 1));
    expect(ctx.timeframes).toHaveLength(3);
    expect(json.length).toBeLessThan(6000);
  }, 60_000);

  it('recovers after a manual socket drop: reconnects, re-auths and reconciles', async () => {
    const before = client.state.lastReconcileAt ?? 0;
    const ready = new Promise((r) => client.once('ready', r));
    client.dropConnection();
    await ready;
    expect(client.status).toBe('ready');
    expect(client.state.lastReconcileAt!).toBeGreaterThan(before);
  }, 60_000);

  it.skipIf(process.env.INTEGRATION_REFRESH !== '1')('refreshes the token pair and persists it', async () => {
    const old = store.load()!;
    await client.refreshTokens();
    const fresh = store.load()!;
    expect(fresh.accessToken).not.toBe(old.accessToken);
    expect(fresh.refreshToken).not.toBe(old.refreshToken);
    // the new pair must work for a full re-auth
    const ready = new Promise((r) => client.once('ready', r));
    client.dropConnection();
    await ready;
    expect(client.status).toBe('ready');
  }, 60_000);
});

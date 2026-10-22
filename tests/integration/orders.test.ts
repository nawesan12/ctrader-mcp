/**
 * Order lifecycle against the REAL cTrader demo, through the MCP tools:
 * place a LIMIT far from the market -> amend it -> cancel it -> check the journal.
 *   INTEGRATION=1 npm run test:integration
 * The order is ~300 pips away and cancelled at the end; nothing should fill.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, no-console --
   Tool results are untyped JSON; this test prints them for manual inspection. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../../src/app.js';
import { CTRADER_DEMO_JSON_URL, loadConfig } from '../../src/config.js';
import { CTraderClient } from '../../src/ctrader/client.js';
import { JsonWsTransport } from '../../src/ctrader/transport.js';
import { openDatabase, type DB } from '../../src/db/database.js';
import { TokenStore } from '../../src/db/tokenStore.js';
import { createLogger } from '../../src/logger.js';
import { registerTools } from '../../src/mcp/tools.js';

describe.skipIf(process.env.INTEGRATION !== '1')('order lifecycle on demo via MCP tools (integration)', () => {
  let app: App;
  let db: DB;
  let mcp: Client;
  const run = Date.now();

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    const data = JSON.parse(r.content[0]?.text ?? 'null');
    console.log(`${name} ->`, JSON.stringify(data));
    return { isError: r.isError === true, data };
  };

  beforeAll(async () => {
    if (existsSync('.env')) process.loadEnvFile('.env');
    const config = loadConfig();
    db = openDatabase(join(config.DATA_DIR, 'ctrader-mcp.db'));
    const tokens = new TokenStore(db, config.CTRADER_CLIENT_SECRET);
    tokens.loadOrBootstrap({ accessToken: config.CTRADER_ACCESS_TOKEN, refreshToken: config.CTRADER_REFRESH_TOKEN });
    const log = createLogger(process.env.LOG_LEVEL ?? 'warn');
    const client = new CTraderClient({
      clientId: config.CTRADER_CLIENT_ID,
      clientSecret: config.CTRADER_CLIENT_SECRET,
      accountId: config.CTRADER_ACCOUNT_ID,
      transportFactory: () => new JsonWsTransport({ url: CTRADER_DEMO_JSON_URL }),
      tokens,
      logger: log,
    });
    app = createApp({ config, client, db, logger: log });
    await client.start();
    await app.symbols.refreshLists();
    const server = new McpServer({ name: 'ctrader-mcp', version: 'integration' });
    registerTools(server, app);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    mcp = new Client({ name: 'integration', version: '1' });
    await mcp.connect(b);
  }, 60_000);

  afterAll(async () => {
    await mcp?.close();
    await app?.client.stop();
    db?.close();
  });

  it('read tools answer', async () => {
    expect((await call('get_account')).isError).toBe(false);
    expect((await call('get_positions')).isError).toBe(false);
    expect((await call('get_orders')).isError).toBe(false);
    expect((await call('get_symbol_info', { symbol: 'EURUSD' })).isError).toBe(false);
  }, 60_000);

  it('place far limit -> amend -> cancel, confirmed by execution events and journaled', async () => {
    const info = (await call('get_symbol_info', { symbol: 'EURUSD' })).data;
    const entry = Math.round((info.bid - 0.03) * 1e5) / 1e5; // ~300 pips below
    const placed = await call('place_limit_order', {
      symbol: 'EURUSD', side: 'BUY', entry, stopLoss: entry - 0.002, takeProfit: entry + 0.004,
      expiresAt: new Date(Date.now() + 2 * 3_600_000).toISOString(), label: 'mcp-integration',
      thesis: 'Integration test order, far from market; will be cancelled immediately.', setup: 'integration-test',
      idempotencyKey: `it-place-${run}`,
    });
    expect(placed.data).toMatchObject({ ok: true, status: 'accepted' });
    const orderId = placed.data.order.orderId as number;

    const dup = await call('place_limit_order', {
      symbol: 'EURUSD', side: 'BUY', entry, stopLoss: entry - 0.002, takeProfit: entry + 0.004,
      expiresAt: placed.data.order.expiresAt, label: 'mcp-integration',
      thesis: 'Integration test order, far from market; will be cancelled immediately.', setup: 'integration-test',
      idempotencyKey: `it-place-${run}`,
    });
    // expiresAt string may differ in formatting -> either duplicate or conflict, never a second order
    expect(dup.data.duplicate === true || dup.isError).toBe(true);

    const amended = await call('amend_order', { orderId, entry: entry - 0.0005, stopLoss: entry - 0.0025, takeProfit: entry + 0.0035, reason: 'integration amend', idempotencyKey: `it-amend-${run}` });
    expect(amended.data).toMatchObject({ ok: true, status: 'replaced' });

    const cancelled = await call('cancel_order', { orderId, reason: 'integration cleanup', idempotencyKey: `it-cancel-${run}` });
    expect(cancelled.data).toMatchObject({ ok: true, status: 'cancelled' });

    await new Promise((r) => setTimeout(r, 500));
    const trade = app.trades.get(placed.data.tradeId)!;
    console.log('journal row:', trade);
    expect(trade).toMatchObject({ status: 'cancelled', setup: 'integration-test', orderId });
    expect(app.events.list({ since: new Date(run) }).map((e) => e.kind)).toEqual(expect.arrayContaining(['order_request', 'execution', 'amend_request', 'cancel_request']));
  }, 120_000);
});

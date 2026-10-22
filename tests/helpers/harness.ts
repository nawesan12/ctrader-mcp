/* eslint-disable @typescript-eslint/no-explicit-any --
   Tool results are untyped JSON parsed from the MCP response. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createApp, type App } from '../../src/app.js';
import { CTraderClient } from '../../src/ctrader/client.js';
import { openDatabase, type DB } from '../../src/db/database.js';
import { registerTools } from '../../src/mcp/tools.js';
import { SpreadTracker } from '../../src/risk/spread.js';
import { MemoryTokens, silentLogger } from './fakeBroker.js';
import { SimBroker } from './simBroker.js';

export interface Harness {
  sim: SimBroker;
  app: App;
  db: DB;
  mcp: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; data: any }>;
  close: () => Promise<void>;
}

export const CONFIG = {
  TZ_SESSIONS: 'America/New_York',
  ALLOWED_SYMBOLS: ['EURUSD', 'USDJPY', 'EURGBP', 'GBPUSD'],
  RISK_PER_TRADE_PCT: 0.5,
  MAX_OPEN_RISK_PCT: 2,
  MAX_TRADES_PER_SYMBOL_PER_DAY: 3,
  DAILY_LOSS_LIMIT_PCT: 2,
};

export async function harness(over: Partial<typeof CONFIG> = {}, confirmTimeoutMs = 2_000): Promise<Harness> {
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


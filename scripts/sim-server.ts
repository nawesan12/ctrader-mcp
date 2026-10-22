/**
 * Runs the real HTTP MCP server backed by the SIMULATED broker (no cTrader
 * connection). For trying the tools with the MCP Inspector or Claude Code
 * without touching the demo account:
 *   npm run sim            # http://127.0.0.1:8788/mcp, bearer = SIM_TOKEN
 */
import { createApp } from '../src/app.js';
import { CTraderClient } from '../src/ctrader/client.js';
import { openDatabase } from '../src/db/database.js';
import { createHttpApp, listen } from '../src/http/server.js';
import { createLogger } from '../src/logger.js';
import { SpreadTracker } from '../src/risk/spread.js';
import { MemoryTokens } from '../tests/helpers/fakeBroker.js';
import { SimBroker } from '../tests/helpers/simBroker.js';

const port = Number(process.env.SIM_PORT ?? 8788);
const token = process.env.SIM_TOKEN ?? 'sim-token-sim-token-sim-token-sim-token';
const log = createLogger(process.env.LOG_LEVEL ?? 'info');
const sim = new SimBroker();
const db = openDatabase(':memory:');
const client = new CTraderClient({ clientId: 'sim', clientSecret: 'sim', transportFactory: sim.transportFactory, tokens: new MemoryTokens(), logger: log });
const app = createApp({
  config: {
    TZ_SESSIONS: 'America/New_York',
    ALLOWED_SYMBOLS: ['EURUSD', 'USDJPY', 'EURGBP', 'GBPUSD'],
    RISK_PER_TRADE_PCT: 0.5,
    MAX_OPEN_RISK_PCT: 2,
    MAX_TRADES_PER_SYMBOL_PER_DAY: 3,
    DAILY_LOSS_LIMIT_PCT: 2,
  },
  client,
  db,
  logger: log,
  spreads: new SpreadTracker(2 * 3_600_000, 1, 1),
});
await client.start();
await app.symbols.refreshLists();
const { http } = createHttpApp({
  app,
  db,
  logger: log,
  version: 'sim',
  config: {
    MCP_AUTH_TOKEN: token, OAUTH_OWNER_PASSWORD: undefined, PUBLIC_URL: undefined, OAUTH_EXTRA_REDIRECT_URIS: [],
    TRUST_PROXY: false, MCP_ALLOWED_ORIGINS: [], RATE_LIMIT_PER_MIN: 1000, PORT: port,
  },
});
const server = await listen(http, port, '127.0.0.1');
log.info({ url: `http://127.0.0.1:${port}/mcp`, token }, 'SIMULATED broker MCP server ready');
const stop = () => void server.close().then(() => client.stop()).then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

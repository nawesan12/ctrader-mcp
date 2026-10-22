import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.js';
import { CTRADER_DEMO_JSON_URL, loadConfig } from './config.js';
import { CTraderClient } from './ctrader/client.js';
import { JsonWsTransport } from './ctrader/transport.js';
import { openDatabase } from './db/database.js';
import { TokenStore } from './db/tokenStore.js';
import { createLogger } from './logger.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const db = openDatabase(join(config.DATA_DIR, 'ctrader-mcp.db'));
const tokens = new TokenStore(db, config.CTRADER_CLIENT_SECRET);
tokens.loadOrBootstrap({ accessToken: config.CTRADER_ACCESS_TOKEN, refreshToken: config.CTRADER_REFRESH_TOKEN });

const client = new CTraderClient({
  clientId: config.CTRADER_CLIENT_ID,
  clientSecret: config.CTRADER_CLIENT_SECRET,
  accountId: config.CTRADER_ACCOUNT_ID,
  transportFactory: () => new JsonWsTransport({ url: CTRADER_DEMO_JSON_URL }),
  tokens,
  logger: log,
});
export const app = createApp({ config, client, db, logger: log });

client.on('fatal', (err) => {
  log.fatal({ err: err.message }, 'aborting');
  void shutdown(1);
});

let shuttingDown = false;
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down');
  await client.stop();
  db.close();
  log.flush();
  process.exit(code);
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

try {
  await client.start();
  await app.symbols.refreshLists();
  // Spots for allowed symbols from the start, so the spread baseline builds up.
  const allowed = await Promise.all(config.ALLOWED_SYMBOLS.map((name) => app.symbols.get(name)));
  await app.symbols.ensureQuotes(allowed.map((s) => s.symbolId));
  log.info({ accountId: client.accountId, depositAssetId: client.trader?.depositAssetId }, 'cTrader client up (MCP HTTP server arrives in phase 6)');
} catch (err) {
  log.fatal({ err: (err as Error).message }, 'startup failed');
  await shutdown(1);
}

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.js';
import { CTRADER_DEMO_JSON_URL, loadConfig } from './config.js';
import { CTraderClient } from './ctrader/client.js';
import { JsonWsTransport } from './ctrader/transport.js';
import { openDatabase } from './db/database.js';
import { TokenStore } from './db/tokenStore.js';
import { assertAuthConfig, createHttpApp, listen } from './http/server.js';
import { createLogger } from './logger.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
assertAuthConfig(config); // fail fast, before touching the broker
const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

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
const app = createApp({ config, client, db, logger: log });
const { http } = createHttpApp({ app, db, config, logger: log, version });
// /health answers while the broker connection is still coming up.
const server = await listen(http, config.PORT, config.HOST);
log.info(
  { port: config.PORT, publicUrl: config.PUBLIC_URL ?? null, oauth: Boolean(config.OAUTH_OWNER_PASSWORD), staticToken: Boolean(config.MCP_AUTH_TOKEN), version },
  'http server listening',
);

let shuttingDown = false;
async function shutdown(code: number, reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ reason }, 'shutting down');
  await server.close(); // stop accepting, let in-flight tool calls finish
  await client.stop(); // close the WebSocket
  db.close(); // checkpoints the WAL: journal is flushed
  log.flush();
  process.exit(code);
}
client.on('fatal', (err) => void shutdown(1, `fatal: ${err.message}`));
process.on('SIGINT', () => void shutdown(0, 'SIGINT'));
process.on('SIGTERM', () => void shutdown(0, 'SIGTERM'));

try {
  await client.start();
  await app.symbols.refreshLists();
  // Spots for allowed symbols from the start, so the spread baseline builds up.
  const allowed = await Promise.all(config.ALLOWED_SYMBOLS.map((name) => app.symbols.get(name)));
  await app.symbols.ensureQuotes(allowed.map((s) => s.symbolId));
  log.info({ accountId: client.accountId, depositAssetId: client.trader?.depositAssetId }, 'cTrader session ready');
} catch (err) {
  await shutdown(1, `startup failed: ${(err as Error).message}`);
}

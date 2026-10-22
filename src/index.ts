import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CTRADER_DEMO_JSON_URL, loadConfig } from './config.js';
import { SmcService } from './analysis/service.js';
import { CandleService } from './ctrader/candles.js';
import { CTraderClient } from './ctrader/client.js';
import { SymbolService } from './ctrader/symbols.js';
import { JsonWsTransport } from './ctrader/transport.js';
import { openDatabase } from './db/database.js';
import { TokenStore } from './db/tokenStore.js';
import { EventLog } from './journal/events.js';
import { createLogger } from './logger.js';
import { RiskService } from './risk/context.js';
import { riskLimitsFromConfig } from './risk/limits.js';

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
const symbols = new SymbolService(client, db, log);
const events = new EventLog(db);
const candles = new CandleService(client);
export const smc = new SmcService({ symbols, candles, tz: config.TZ_SESSIONS });
export const risk = new RiskService({ client, symbols, events, limits: riskLimitsFromConfig(config), tz: config.TZ_SESSIONS });

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
  await symbols.refreshLists();
  // Spots for allowed symbols from the start, so the spread baseline builds up.
  const allowed = await Promise.all(config.ALLOWED_SYMBOLS.map((name) => symbols.get(name)));
  await symbols.ensureQuotes(allowed.map((s) => s.symbolId));
  log.info({ accountId: client.accountId, depositAssetId: client.trader?.depositAssetId }, 'phase 1 client up');
} catch (err) {
  log.fatal({ err: (err as Error).message }, 'startup failed');
  await shutdown(1);
}

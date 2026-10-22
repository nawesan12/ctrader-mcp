import { SmcService } from './analysis/service.js';
import type { Config } from './config.js';
import { CandleService } from './ctrader/candles.js';
import type { CTraderClient } from './ctrader/client.js';
import { SymbolService } from './ctrader/symbols.js';
import type { DB } from './db/database.js';
import { EventLog } from './journal/events.js';
import { TradeStore } from './journal/trades.js';
import type { Logger } from './logger.js';
import { RiskService } from './risk/context.js';
import { riskLimitsFromConfig } from './risk/limits.js';
import type { SpreadTracker } from './risk/spread.js';
import { IdempotencyStore } from './trading/idempotency.js';
import { OrderService } from './trading/orders.js';
import { Views } from './trading/views.js';

export type AppConfig = Pick<
  Config,
  'TZ_SESSIONS' | 'ALLOWED_SYMBOLS' | 'RISK_PER_TRADE_PCT' | 'MAX_OPEN_RISK_PCT' | 'MAX_TRADES_PER_SYMBOL_PER_DAY' | 'DAILY_LOSS_LIMIT_PCT'
>;

export interface AppDeps {
  config: AppConfig;
  client: CTraderClient;
  db: DB;
  logger: Logger;
  now?: () => number;
  spreads?: SpreadTracker;
  confirmTimeoutMs?: number;
}

/** Wires every service on top of a (not necessarily started) cTrader client. */
export function createApp(d: AppDeps) {
  const now = d.now ?? Date.now;
  const symbols = new SymbolService(d.client, d.db, d.logger, { spreads: d.spreads });
  const candles = new CandleService(d.client, now);
  const events = new EventLog(d.db);
  const trades = new TradeStore(d.db, now);
  const idempotency = new IdempotencyStore(d.db, now);
  const risk = new RiskService({ client: d.client, symbols, events, limits: riskLimitsFromConfig(d.config), tz: d.config.TZ_SESSIONS, now });
  const smc = new SmcService({ symbols, candles, tz: d.config.TZ_SESSIONS, now });
  const orders = new OrderService({
    client: d.client, risk, symbols, trades, events, idempotency, logger: d.logger, tz: d.config.TZ_SESSIONS, now,
    confirmTimeoutMs: d.confirmTimeoutMs,
  });
  const views = new Views({ client: d.client, symbols, candles, risk, trades, now });

  // Keep the journal in sync with every execution (fills of resting limits, SL/TP hits, expiries...).
  d.client.on('execution', (ev) => {
    try {
      trades.onExecution(ev, (id) => symbols.cached(id));
    } catch (err) {
      d.logger.error({ err: (err as Error).message }, 'journal update failed');
    }
  });

  return { client: d.client, symbols, candles, events, trades, idempotency, risk, smc, orders, views, config: d.config };
}

export type App = ReturnType<typeof createApp>;

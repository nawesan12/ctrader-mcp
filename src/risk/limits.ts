import type { Config } from '../config.js';
import { DEFAULT_RULES, type RiskLimits } from './engine.js';

export function riskLimitsFromConfig(
  c: Pick<Config, 'RISK_PER_TRADE_PCT' | 'MAX_OPEN_RISK_PCT' | 'MAX_TRADES_PER_SYMBOL_PER_DAY' | 'DAILY_LOSS_LIMIT_PCT' | 'ALLOWED_SYMBOLS'>,
): RiskLimits {
  return {
    riskPerTradePct: c.RISK_PER_TRADE_PCT,
    maxOpenRiskPct: c.MAX_OPEN_RISK_PCT,
    maxTradesPerSymbolPerDay: c.MAX_TRADES_PER_SYMBOL_PER_DAY,
    dailyLossLimitPct: c.DAILY_LOSS_LIMIT_PCT,
    allowedSymbols: c.ALLOWED_SYMBOLS,
    ...DEFAULT_RULES,
  };
}

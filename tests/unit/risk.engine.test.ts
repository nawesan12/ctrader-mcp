import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, evaluateAmend, evaluateOrder, type OrderIntent, type RiskContext, type RiskLimits } from '../../src/risk/engine.js';
import { currencyBreaches, netCurrencyRisk } from '../../src/risk/exposure.js';

const NOW = Date.parse('2026-10-22T14:00:00Z');

const limits: RiskLimits = {
  riskPerTradePct: 0.5,
  maxOpenRiskPct: 2,
  maxTradesPerSymbolPerDay: 3,
  dailyLossLimitPct: 2,
  allowedSymbols: ['EURUSD', 'USDJPY', 'EURGBP', 'GBPUSD', 'XAUUSD'],
  ...DEFAULT_RULES,
};

const EURUSD = { key: 'EURUSD', baseAsset: 'EUR', quoteAsset: 'USD', digits: 5, pipPosition: 4, minVolume: 100_000, maxVolume: 1e10, stepVolume: 100_000, lotSize: 10_000_000 };

function ctx(over: Partial<RiskContext> = {}): RiskContext {
  return {
    now: NOW,
    equity: 10_000,
    balance: 10_000,
    depositAsset: 'USD',
    dayStartBalance: 10_000,
    realizedPnlToday: 0,
    unrealizedPnl: 0,
    symbol: EURUSD,
    pipValuePerUnit: 0.0001, // $10 per pip per 100k
    quote: { bid: 1.08, ask: 1.08008 },
    avgSpread: 0.00008,
    openExposures: [],
    tradesTodayForSymbol: 0,
    ...over,
  };
}

// BUY limit 1.0790, SL 20 pips, TP 40 pips -> R:R 2
const buyLimit: OrderIntent = { symbol: 'EURUSD', side: 'BUY', orderType: 'LIMIT', entry: 1.079, stopLoss: 1.077, takeProfit: 1.083 };

const failed = (d: ReturnType<typeof evaluateOrder>) => d.checks.filter((c) => !c.ok).map((c) => c.rule);

describe('position sizing', () => {
  it('sizes to riskPct of equity: $50 / (20 pips * $0.0001) = 25,000 units', () => {
    const d = evaluateOrder(buyLimit, ctx(), limits);
    expect(d.ok).toBe(true);
    expect(d.sizing).toMatchObject({ units: 25_000, volume: 2_500_000, lots: 0.25, slPips: 20, tpPips: 40, rewardRisk: 2, riskAmount: 50, riskPct: 0.5, rewardAmount: 100 });
  });

  it('rounds DOWN to stepVolume so risk never exceeds the target', () => {
    // 17 pip SL -> 29,411.76 units -> 29,000
    const d = evaluateOrder({ ...buyLimit, stopLoss: 1.0773, takeProfit: 1.084 }, ctx(), limits);
    expect(d.sizing?.units).toBe(29_000);
    expect(d.sizing!.riskAmount).toBeLessThanOrEqual(50);
  });

  it('rejects when the size falls below minVolume', () => {
    // 600 pip SL on a $10k account -> 833 units < 1,000 min
    const d = evaluateOrder({ ...buyLimit, stopLoss: 1.019, takeProfit: 1.2 }, ctx(), limits);
    expect(d.ok).toBe(false);
    expect(failed(d)).toContain('position_size');
  });

  it('uses the pip value for crosses (USDJPY, $6.67 per pip per 100k)', () => {
    const usdjpy = { key: 'USDJPY', baseAsset: 'USD', quoteAsset: 'JPY', digits: 3, pipPosition: 2, minVolume: 100_000, stepVolume: 100_000 };
    const d = evaluateOrder(
      { symbol: 'USDJPY', side: 'SELL', orderType: 'LIMIT', entry: 150.5, stopLoss: 150.75, takeProfit: 150 },
      ctx({ symbol: usdjpy, pipValuePerUnit: 0.01 / 150, quote: { bid: 150.2, ask: 150.21 }, avgSpread: 0.01 }),
      limits,
    );
    // $50 / (25 pips * 0.0000667) = 30,000 units
    expect(d.ok).toBe(true);
    expect(d.sizing?.units).toBe(30_000);
  });

  it('allows a lower riskPct but never a higher one', () => {
    expect(evaluateOrder({ ...buyLimit, riskPct: 0.25 }, ctx(), limits).sizing?.units).toBe(12_000);
    const d = evaluateOrder({ ...buyLimit, riskPct: 1 }, ctx(), limits);
    expect(failed(d)).toContain('risk_pct');
  });
});

describe('SL/TP and R:R', () => {
  it('rejects missing SL or TP', () => {
    expect(failed(evaluateOrder({ ...buyLimit, stopLoss: undefined }, ctx(), limits))).toContain('stop_loss_present');
    expect(failed(evaluateOrder({ ...buyLimit, takeProfit: undefined }, ctx(), limits))).toContain('take_profit_present');
  });

  it('rejects SL/TP on the wrong side', () => {
    expect(failed(evaluateOrder({ ...buyLimit, stopLoss: 1.08, takeProfit: 1.083 }, ctx(), limits))).toContain('protection_sides');
    expect(failed(evaluateOrder({ ...buyLimit, side: 'SELL', entry: 1.082 }, ctx(), limits))).toContain('protection_sides');
  });

  it('accepts R:R exactly 1.5 and rejects 1.49', () => {
    expect(evaluateOrder({ ...buyLimit, takeProfit: 1.082 }, ctx(), limits).ok).toBe(true); // 30/20
    const d = evaluateOrder({ ...buyLimit, takeProfit: 1.08198 }, ctx(), limits); // 29.8/20
    expect(failed(d)).toEqual(['reward_risk']);
  });
});

describe('symbol and order type', () => {
  it('rejects symbols outside ALLOWED_SYMBOLS', () => {
    expect(failed(evaluateOrder({ ...buyLimit, symbol: 'BTCUSD' }, ctx(), limits))).toContain('symbol_allowed');
  });

  it('rejects a marketable limit', () => {
    expect(failed(evaluateOrder({ ...buyLimit, entry: 1.081, stopLoss: 1.079, takeProfit: 1.085 }, ctx(), limits))).toContain('limit_side');
  });

  it('market BUY uses the ask as entry', () => {
    const d = evaluateOrder({ symbol: 'EURUSD', side: 'BUY', orderType: 'MARKET', stopLoss: 1.07808, takeProfit: 1.08408 }, ctx(), limits);
    expect(d.ok).toBe(true);
    expect(d.sizing?.entry).toBe(1.08008);
    expect(d.sizing?.slPips).toBe(20);
  });

  it('market order without a live quote is rejected', () => {
    const d = evaluateOrder({ symbol: 'EURUSD', side: 'BUY', orderType: 'MARKET', stopLoss: 1.078, takeProfit: 1.084 }, ctx({ quote: undefined }), limits);
    expect(failed(d)).toContain('live_quote');
  });
});

describe('open risk limit', () => {
  const pos = (risk: number, side: 'BUY' | 'SELL' = 'SELL', base = 'AUD', quote = 'NZD') => ({ id: `position:${risk}`, symbol: base + quote, baseAsset: base, quoteAsset: quote, side, risk });

  it('accepts up to MAX_OPEN_RISK_PCT (150 existing + 50 = 2%)', () => {
    expect(evaluateOrder(buyLimit, ctx({ openExposures: [pos(150)] }), limits).ok).toBe(true);
  });

  it('rejects above MAX_OPEN_RISK_PCT', () => {
    expect(failed(evaluateOrder(buyLimit, ctx({ openExposures: [pos(151)] }), limits))).toContain('max_open_risk');
  });

  it('rejects new risk while a position has no SL', () => {
    expect(failed(evaluateOrder(buyLimit, ctx({ openExposures: [pos(Infinity)] }), limits))).toContain('open_positions_protected');
  });
});

describe('currency exposure', () => {
  it('long USDJPY + short EURUSD = long USD', () => {
    const net = netCurrencyRisk([
      { baseAsset: 'USD', quoteAsset: 'JPY', side: 'BUY', risk: 50 },
      { baseAsset: 'EUR', quoteAsset: 'USD', side: 'SELL', risk: 50 },
    ]);
    expect(net.get('USD')).toBe(100);
    expect(net.get('JPY')).toBe(-50);
    expect(net.get('EUR')).toBe(-50);
  });

  it('rejects when one currency exceeds 1.5% (3rd trade long USD with 0.5% each => 1.5% ok, 4th => 2%)', () => {
    const longUsd = (n: number) => ({ id: `p${n}`, symbol: 'USDJPY', baseAsset: 'USD', quoteAsset: 'JPY', side: 'BUY' as const, risk: 50 });
    const sellEur = { symbol: 'EURUSD', side: 'SELL' as const, orderType: 'LIMIT' as const, entry: 1.0815, stopLoss: 1.0835, takeProfit: 1.0775 };
    // raise open-risk cap so only the currency rule is exercised
    const l = { ...limits, maxOpenRiskPct: 5 };
    expect(evaluateOrder(sellEur, ctx({ openExposures: [longUsd(1), longUsd(2)] }), l).ok).toBe(true);
    const d = evaluateOrder(sellEur, ctx({ openExposures: [longUsd(1), longUsd(2), longUsd(3)] }), l);
    expect(failed(d)).toEqual(['currency_exposure']);
    expect(d.reasons[0]).toMatch(/USD net risk would be 2\.000%/);
  });

  it('allows a trade that reduces an existing large exposure', () => {
    const existing = [1, 2, 3, 4].map((i) => ({ baseAsset: 'USD', quoteAsset: 'JPY', side: 'BUY' as const, risk: 50 + i }));
    expect(currencyBreaches(existing, { baseAsset: 'EUR', quoteAsset: 'USD', side: 'BUY', risk: 50 }, 150)).toEqual([]);
  });
});

describe('trades per symbol per day', () => {
  it('accepts the 3rd and rejects the 4th', () => {
    expect(evaluateOrder(buyLimit, ctx({ tradesTodayForSymbol: 2 }), limits).ok).toBe(true);
    expect(failed(evaluateOrder(buyLimit, ctx({ tradesTodayForSymbol: 3 }), limits))).toEqual(['trades_per_symbol_today']);
  });
});

describe('daily loss limit', () => {
  it('counts realized + floating against the NY-day start balance', () => {
    expect(evaluateOrder(buyLimit, ctx({ realizedPnlToday: -150, unrealizedPnl: -49 }), limits).ok).toBe(true); // 1.99%
    const d = evaluateOrder(buyLimit, ctx({ realizedPnlToday: -150, unrealizedPnl: -50 }), limits); // 2%
    expect(failed(d)).toEqual(['daily_loss_limit']);
    expect(d.reasons[0]).toMatch(/next NY day/);
  });

  it('floating profit offsets realized loss', () => {
    expect(evaluateOrder(buyLimit, ctx({ realizedPnlToday: -250, unrealizedPnl: 100 }), limits).ok).toBe(true);
  });
});

describe('spread', () => {
  const market: OrderIntent = { symbol: 'EURUSD', side: 'SELL', orderType: 'MARKET', stopLoss: 1.082, takeProfit: 1.077 };

  it('accepts spread at 2x average, rejects above', () => {
    expect(evaluateOrder(market, ctx({ quote: { bid: 1.08, ask: 1.08016 } }), limits).ok).toBe(true);
    expect(failed(evaluateOrder(market, ctx({ quote: { bid: 1.08, ask: 1.08017 } }), limits))).toEqual(['spread']);
  });

  it('without a baseline: market rejected, limit allowed', () => {
    expect(failed(evaluateOrder(market, ctx({ avgSpread: undefined }), limits))).toEqual(['spread']);
    expect(evaluateOrder(buyLimit, ctx({ avgSpread: undefined }), limits).ok).toBe(true);
  });
});

describe('news window', () => {
  const market: OrderIntent = { symbol: 'EURUSD', side: 'SELL', orderType: 'MARKET', stopLoss: 1.082, takeProfit: 1.077 };
  const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

  it('rejects market orders within ±15 min of high-impact news on base or quote', () => {
    expect(failed(evaluateOrder({ ...market, newsEvents: [{ currency: 'USD', time: at(10), impact: 'high' }] }, ctx(), limits))).toEqual(['news_window']);
    expect(failed(evaluateOrder({ ...market, newsEvents: [{ currency: 'EUR', time: at(-15) }] }, ctx(), limits))).toEqual(['news_window']);
  });

  it('accepts outside the window, other currencies, or lower impact', () => {
    expect(evaluateOrder({ ...market, newsEvents: [{ currency: 'USD', time: at(16) }] }, ctx(), limits).ok).toBe(true);
    expect(evaluateOrder({ ...market, newsEvents: [{ currency: 'JPY', time: at(1) }] }, ctx(), limits).ok).toBe(true);
    expect(evaluateOrder({ ...market, newsEvents: [{ currency: 'USD', time: at(1), impact: 'medium' }] }, ctx(), limits).ok).toBe(true);
  });

  it('does not apply to limit orders', () => {
    expect(evaluateOrder({ ...buyLimit, newsEvents: [{ currency: 'USD', time: at(1) }] }, ctx(), limits).ok).toBe(true);
  });

  it('honours blockedUntil for market orders', () => {
    expect(failed(evaluateOrder({ ...market, blockedUntil: at(5) }, ctx(), limits))).toEqual(['blocked_until']);
    expect(evaluateOrder({ ...market, blockedUntil: at(-1) }, ctx(), limits).ok).toBe(true);
    expect(failed(evaluateOrder({ ...market, blockedUntil: 'not a date' }, ctx(), limits))).toEqual(['blocked_until']);
  });
});

describe('every rejection has a readable reason', () => {
  it('collects all failing rules at once', () => {
    const d = evaluateOrder({ ...buyLimit, symbol: 'BTCUSD', takeProfit: 1.08 }, ctx({ tradesTodayForSymbol: 9 }), limits);
    expect(d.ok).toBe(false);
    expect(d.reasons.length).toBe(failed(d).length);
    for (const r of d.reasons) expect(r).toMatch(/^[a-z_]+: .{5,}/);
  });
});

describe('amend SL/TP', () => {
  const base = { side: 'BUY' as const, currentStopLoss: 1.077, newTakeProfit: 1.085, bid: 1.081, ask: 1.0811 };

  it('accepts moving a BUY SL up (to breakeven)', () => {
    expect(evaluateAmend({ ...base, newStopLoss: 1.079 }).ok).toBe(true);
  });

  it('rejects widening the SL', () => {
    expect(evaluateAmend({ ...base, newStopLoss: 1.076 }).reasons[0]).toMatch(/^sl_not_wider/);
    expect(evaluateAmend({ ...base, side: 'SELL', currentStopLoss: 1.083, newStopLoss: 1.084, newTakeProfit: 1.07 }).ok).toBe(false);
  });

  it('rejects removing SL/TP or placing them through the market', () => {
    expect(evaluateAmend({ ...base, newStopLoss: undefined }).ok).toBe(false);
    expect(evaluateAmend({ ...base, newStopLoss: 1.079, newTakeProfit: undefined }).ok).toBe(false);
    expect(evaluateAmend({ ...base, newStopLoss: 1.0815 }).reasons.join()).toMatch(/sl_vs_market/);
  });
});

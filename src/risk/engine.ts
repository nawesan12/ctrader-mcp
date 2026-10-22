import { normalizeVolume, pipSize, roundTo } from '../ctrader/normalize.js';
import { currencyBreaches, type RiskExposure, type Side } from './exposure.js';

/**
 * Server-side risk engine. Pure: every input comes in the context, so each
 * rule is unit-testable and the agent cannot bypass it (all order tools call
 * evaluateOrder before anything is sent to the broker).
 */

export interface RiskLimits {
  riskPerTradePct: number;
  maxOpenRiskPct: number;
  maxTradesPerSymbolPerDay: number;
  dailyLossLimitPct: number;
  maxCurrencyRiskPct: number;
  minRewardRisk: number;
  allowedSymbols: string[];
  maxSpreadMultiple: number;
  newsWindowMinutes: number;
}

export const DEFAULT_RULES = { maxCurrencyRiskPct: 1.5, minRewardRisk: 1.5, maxSpreadMultiple: 2, newsWindowMinutes: 15 } as const;

export interface NewsEvent {
  currency: string;
  /** ISO-8601 time of the release. */
  time: string;
  impact?: 'high' | 'medium' | 'low' | undefined;
  title?: string | undefined;
}

export interface OrderIntent {
  /** Normalised symbol key, e.g. "EURUSD". */
  symbol: string;
  side: Side;
  orderType: 'MARKET' | 'LIMIT';
  /** Limit price (required for LIMIT; ignored for MARKET, which uses the live quote). */
  entry?: number | undefined;
  stopLoss?: number | undefined;
  takeProfit?: number | undefined;
  /** Optional lower risk for this trade; can never exceed RISK_PER_TRADE_PCT. */
  riskPct?: number | undefined;
  /** ISO time until which the agent says market orders are blocked (news). */
  blockedUntil?: string | undefined;
  /** High-impact events the agent read from the calendar. */
  newsEvents?: NewsEvent[] | undefined;
}

export interface SymbolSpec {
  key: string;
  baseAsset: string;
  quoteAsset: string;
  digits: number;
  pipPosition: number;
  minVolume?: number | undefined;
  maxVolume?: number | undefined;
  stepVolume?: number | undefined;
  lotSize?: number | undefined;
}

export interface OpenExposure extends RiskExposure {
  /** "position:123" or "order:456". */
  id: string;
  symbol: string;
}

export interface RiskContext {
  now: number;
  equity: number;
  balance: number;
  depositAsset: string;
  /** Balance at the start of the NY day (denominator of the daily loss %). */
  dayStartBalance: number;
  realizedPnlToday: number;
  unrealizedPnl: number;
  symbol: SymbolSpec;
  /** Value of one pip for one unit, in deposit currency. */
  pipValuePerUnit: number;
  quote?: { bid: number; ask: number } | undefined;
  /** Session-average spread (price units), undefined until enough samples. */
  avgSpread?: number | undefined;
  /** Risk of every open position and pending order (Infinity when no SL). */
  openExposures: OpenExposure[];
  /** Positions opened + pending orders placed today (NY day) on this symbol. */
  tradesTodayForSymbol: number;
}

export interface Check {
  rule: string;
  ok: boolean;
  detail: string;
}

export interface Sizing {
  entry: number;
  stopLoss: number;
  takeProfit: number;
  slPips: number;
  tpPips: number;
  rewardRisk: number;
  units: number;
  /** Protocol volume (cents of a unit). */
  volume: number;
  lots: number | undefined;
  riskAmount: number;
  riskPct: number;
  rewardAmount: number;
}

export interface Decision {
  ok: boolean;
  reasons: string[];
  checks: Check[];
  sizing?: Sizing | undefined;
}

const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : String(n));

export function evaluateOrder(intent: OrderIntent, ctx: RiskContext, limits: RiskLimits): Decision {
  const checks: Check[] = [];
  const check = (rule: string, ok: boolean, detail: string) => checks.push({ rule, ok, detail });
  const s = ctx.symbol;

  // --- symbol allowed
  const allowed = limits.allowedSymbols.includes(intent.symbol);
  check('symbol_allowed', allowed, allowed ? `${intent.symbol} is allowed` : `${intent.symbol} is not in ALLOWED_SYMBOLS (${limits.allowedSymbols.join(', ')})`);

  // --- account sanity
  check('equity_positive', ctx.equity > 0, `equity ${fmt(ctx.equity)} ${ctx.depositAsset}`);

  // --- entry price
  let entry: number | undefined;
  if (intent.orderType === 'MARKET') {
    if (ctx.quote) entry = intent.side === 'BUY' ? ctx.quote.ask : ctx.quote.bid;
    check('live_quote', ctx.quote !== undefined, ctx.quote ? `bid ${ctx.quote.bid} / ask ${ctx.quote.ask}` : 'no live quote for a market order');
  } else {
    entry = intent.entry !== undefined && intent.entry > 0 ? roundTo(intent.entry, s.digits) : undefined;
    check('limit_price', entry !== undefined, entry !== undefined ? `limit at ${entry}` : 'LIMIT order needs a positive entry price');
    if (entry !== undefined && ctx.quote) {
      const ok = intent.side === 'BUY' ? entry < ctx.quote.ask : entry > ctx.quote.bid;
      check(
        'limit_side',
        ok,
        ok
          ? `limit is on the passive side of the market`
          : `${intent.side} LIMIT at ${entry} would be marketable (bid ${ctx.quote.bid} / ask ${ctx.quote.ask}); use a market order or move the price`,
      );
    }
  }

  // --- SL / TP mandatory and on the correct side
  const sl = intent.stopLoss !== undefined && intent.stopLoss > 0 ? roundTo(intent.stopLoss, s.digits) : undefined;
  const tp = intent.takeProfit !== undefined && intent.takeProfit > 0 ? roundTo(intent.takeProfit, s.digits) : undefined;
  check('stop_loss_present', sl !== undefined, sl !== undefined ? `SL ${sl}` : 'stop loss is mandatory');
  check('take_profit_present', tp !== undefined, tp !== undefined ? `TP ${tp}` : 'take profit is mandatory');

  let sizing: Sizing | undefined;
  if (entry !== undefined && sl !== undefined && tp !== undefined) {
    const dir = intent.side === 'BUY' ? 1 : -1;
    // Prices live on the symbol's digit grid: snap distances to it to kill float noise.
    const slDist = roundTo((entry - sl) * dir, s.digits);
    const tpDist = roundTo((tp - entry) * dir, s.digits);
    const sidesOk = slDist > 0 && tpDist > 0;
    check(
      'protection_sides',
      sidesOk,
      sidesOk
        ? 'SL and TP are on the correct sides of entry'
        : intent.side === 'BUY'
          ? `BUY needs SL < entry < TP (SL ${sl}, entry ${entry}, TP ${tp})`
          : `SELL needs TP < entry < SL (TP ${tp}, entry ${entry}, SL ${sl})`,
    );

    if (sidesOk) {
      const rr = tpDist / slDist;
      check('reward_risk', rr >= limits.minRewardRisk - 1e-9, `R:R ${fmt(rr)} (min ${limits.minRewardRisk})`);

      const riskPct = intent.riskPct ?? limits.riskPerTradePct;
      const riskPctOk = riskPct > 0 && riskPct <= limits.riskPerTradePct;
      check('risk_pct', riskPctOk, riskPctOk ? `risking ${riskPct}% per trade` : `riskPct ${riskPct} must be in (0, ${limits.riskPerTradePct}]`);

      const slPips = roundTo(slDist / pipSize(s.pipPosition), 6);
      const lossPerUnit = slPips * ctx.pipValuePerUnit;
      if (riskPctOk && ctx.equity > 0 && lossPerUnit > 0) {
        const targetRisk = (ctx.equity * riskPct) / 100;
        const rawUnits = targetRisk / lossPerUnit;
        const vol = normalizeVolume(Math.floor(rawUnits * 100 * (1 + 1e-12)), s);
        const units = vol.volume / 100;
        const riskAmount = units * lossPerUnit;
        sizing = {
          entry,
          stopLoss: sl,
          takeProfit: tp,
          slPips: roundTo(slPips, 1),
          tpPips: roundTo(tpDist / pipSize(s.pipPosition), 1),
          rewardRisk: roundTo(rr, 2),
          units,
          volume: vol.volume,
          lots: s.lotSize ? vol.volume / s.lotSize : undefined,
          riskAmount: roundTo(riskAmount, 2),
          riskPct: roundTo((riskAmount / ctx.equity) * 100, 3),
          rewardAmount: roundTo(units * (tpDist / pipSize(s.pipPosition)) * ctx.pipValuePerUnit, 2),
        };
        check(
          'position_size',
          vol.ok,
          vol.ok
            ? `${units} units (${vol.volume} volume), risk ${fmt(riskAmount)} ${ctx.depositAsset}`
            : `size for ${riskPct}% risk is ${fmt(rawUnits, 0)} units: ${vol.reason} (SL too wide for this account size)`,
        );
      }
    }
  }

  // --- open risk
  const unprotected = ctx.openExposures.filter((e) => !Number.isFinite(e.risk));
  check(
    'open_positions_protected',
    unprotected.length === 0,
    unprotected.length === 0 ? 'all open positions/orders have a SL' : `without SL: ${unprotected.map((e) => e.id).join(', ')}; fix them before opening new risk`,
  );
  if (sizing && unprotected.length === 0 && ctx.equity > 0) {
    const existing = ctx.openExposures.reduce((acc, e) => acc + e.risk, 0);
    const totalPct = ((existing + sizing.riskAmount) / ctx.equity) * 100;
    check('max_open_risk', totalPct <= limits.maxOpenRiskPct + 1e-9, `open risk after this trade ${fmt(totalPct, 3)}% (max ${limits.maxOpenRiskPct}%)`);

    const breaches = currencyBreaches(
      ctx.openExposures,
      { baseAsset: s.baseAsset, quoteAsset: s.quoteAsset, side: intent.side, risk: sizing.riskAmount },
      (ctx.equity * limits.maxCurrencyRiskPct) / 100,
    );
    check(
      'currency_exposure',
      breaches.length === 0,
      breaches.length === 0
        ? `net risk per currency stays within ${limits.maxCurrencyRiskPct}%`
        : breaches
            .map((b) => `${b.currency} net risk would be ${fmt((b.after / ctx.equity) * 100, 3)}% (max ${limits.maxCurrencyRiskPct}%)`)
            .join('; '),
    );
  }

  // --- trades per symbol per day
  check(
    'trades_per_symbol_today',
    ctx.tradesTodayForSymbol < limits.maxTradesPerSymbolPerDay,
    `${ctx.tradesTodayForSymbol} trade(s) on ${intent.symbol} today (max ${limits.maxTradesPerSymbolPerDay})`,
  );

  // --- daily loss limit (realized + floating, vs NY-day start balance)
  const dayPnl = ctx.realizedPnlToday + ctx.unrealizedPnl;
  const lossPct = ctx.dayStartBalance > 0 ? (Math.max(0, -dayPnl) / ctx.dayStartBalance) * 100 : 0;
  check(
    'daily_loss_limit',
    lossPct < limits.dailyLossLimitPct,
    lossPct < limits.dailyLossLimitPct
      ? `day P&L ${fmt(dayPnl)} ${ctx.depositAsset} (${fmt(lossPct, 3)}% loss, limit ${limits.dailyLossLimitPct}%)`
      : `daily loss ${fmt(lossPct, 3)}% reached the ${limits.dailyLossLimitPct}% limit; new orders blocked until the next NY day`,
  );

  // --- spread
  if (ctx.quote) {
    const spread = ctx.quote.ask - ctx.quote.bid;
    if (ctx.avgSpread === undefined) {
      const ok = intent.orderType === 'LIMIT';
      check('spread', ok, ok ? 'spread baseline not ready yet (limit order allowed)' : 'spread baseline not ready yet; market orders wait until it is');
    } else {
      const maxSpread = ctx.avgSpread * limits.maxSpreadMultiple;
      const ok = spread <= maxSpread + 1e-12;
      const pip = pipSize(s.pipPosition);
      check('spread', ok, `spread ${fmt(spread / pip, 1)} pips vs session avg ${fmt(ctx.avgSpread / pip, 1)} (max ${limits.maxSpreadMultiple}x)`);
    }
  } else if (intent.orderType === 'LIMIT') {
    check('spread', false, 'no live quote: cannot verify spread');
  }

  // --- news window (market orders only)
  if (intent.orderType === 'MARKET') {
    const blocked = intent.blockedUntil ? Date.parse(intent.blockedUntil) : NaN;
    if (intent.blockedUntil !== undefined) {
      const ok = Number.isFinite(blocked) && ctx.now >= blocked;
      check('blocked_until', ok, ok ? `blockedUntil ${intent.blockedUntil} has passed` : `market orders blocked until ${intent.blockedUntil}`);
    }
    const ccys = new Set([s.baseAsset.toUpperCase(), s.quoteAsset.toUpperCase()]);
    const windowMs = limits.newsWindowMinutes * 60_000;
    const hits = (intent.newsEvents ?? []).filter((ev) => {
      const t = Date.parse(ev.time);
      return (ev.impact ?? 'high') === 'high' && ccys.has(ev.currency.toUpperCase()) && Number.isFinite(t) && Math.abs(ctx.now - t) <= windowMs;
    });
    check(
      'news_window',
      hits.length === 0,
      hits.length === 0
        ? `no high-impact ${[...ccys].join('/')} news within ±${limits.newsWindowMinutes} min`
        : `high-impact news within ±${limits.newsWindowMinutes} min: ${hits.map((h) => `${h.currency} ${h.title ?? ''} @ ${h.time}`.replace(/\s+/g, ' ')).join('; ')}`,
    );
  }

  const reasons = checks.filter((c) => !c.ok).map((c) => `${c.rule}: ${c.detail}`);
  return { ok: reasons.length === 0, reasons, checks, sizing };
}

/**
 * Amending SL/TP of an open position: the new SL may only reduce risk
 * (move towards / past entry), and TP stays mandatory.
 */
export function evaluateAmend(
  p: { side: Side; currentStopLoss: number | undefined; newStopLoss: number | undefined; newTakeProfit: number | undefined; bid: number; ask: number },
): Decision {
  const checks: Check[] = [];
  const check = (rule: string, ok: boolean, detail: string) => checks.push({ rule, ok, detail });
  check('stop_loss_present', p.newStopLoss !== undefined && p.newStopLoss > 0, 'the new stop loss is mandatory');
  check('take_profit_present', p.newTakeProfit !== undefined && p.newTakeProfit > 0, 'the take profit is mandatory');
  if (p.newStopLoss !== undefined && p.newStopLoss > 0) {
    if (p.currentStopLoss !== undefined) {
      const ok = p.side === 'BUY' ? p.newStopLoss >= p.currentStopLoss : p.newStopLoss <= p.currentStopLoss;
      check('sl_not_wider', ok, ok ? `SL ${p.currentStopLoss} -> ${p.newStopLoss} does not increase risk` : `SL ${p.currentStopLoss} -> ${p.newStopLoss} would increase risk`);
    }
    // Closing side price: a BUY closes at bid, a SELL at ask.
    const ok = p.side === 'BUY' ? p.newStopLoss < p.bid : p.newStopLoss > p.ask;
    check('sl_vs_market', ok, ok ? 'SL is beyond the current price' : `SL ${p.newStopLoss} is already through the market (bid ${p.bid} / ask ${p.ask}); close the position instead`);
  }
  if (p.newTakeProfit !== undefined && p.newTakeProfit > 0) {
    const ok = p.side === 'BUY' ? p.newTakeProfit > p.bid : p.newTakeProfit < p.ask;
    check('tp_vs_market', ok, ok ? 'TP is beyond the current price' : `TP ${p.newTakeProfit} is already through the market`);
  }
  const reasons = checks.filter((c) => !c.ok).map((c) => `${c.rule}: ${c.detail}`);
  return { ok: reasons.length === 0, reasons, checks };
}

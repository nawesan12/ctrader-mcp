import type { CandleService } from '../ctrader/candles.js';
import type { CTraderClient } from '../ctrader/client.js';
import { moneyFromProto, pipSize, roundTo } from '../ctrader/normalize.js';
import { PT, TradeSide, type Timeframe } from '../ctrader/payloadTypes.js';
import { UnrealizedPnlResSchema } from '../ctrader/schemas.js';
import type { SymbolInfo, SymbolService } from '../ctrader/symbols.js';
import type { TradeStore } from '../journal/trades.js';
import type { RiskService } from '../risk/context.js';
import { positionsOpenedToday, pendingOrdersSince } from '../risk/context.js';
import { netCurrencyRisk } from '../risk/exposure.js';

export interface ViewDeps {
  client: Pick<CTraderClient, 'callAccount' | 'state'>;
  symbols: Pick<SymbolService, 'get' | 'getById' | 'getQuote' | 'ensureQuotes' | 'waitForQuote' | 'pipValuePerUnit' | 'spreads'>;
  candles: Pick<CandleService, 'get'>;
  risk: Pick<RiskService, 'snapshot' | 'limits'>;
  trades: Pick<TradeStore, 'byPosition' | 'byOrder'>;
  now?: () => number;
}

const r2 = (x: number) => roundTo(x, 2);
const pct = (x: number) => roundTo(x, 3);

export class Views {
  private readonly now: () => number;

  constructor(private readonly d: ViewDeps) {
    this.now = d.now ?? Date.now;
  }

  async account() {
    const s = await this.d.risk.snapshot();
    const l = this.d.risk.limits;
    const positions = this.d.client.state.getPositions();
    const usedMargin = positions.reduce((acc, p) => acc + moneyFromProto(p.usedMargin ?? 0, p.moneyDigits), 0);
    const unprotected = s.exposures.filter((e) => !Number.isFinite(e.risk)).map((e) => e.id);
    const openRisk = s.exposures.reduce((acc, e) => acc + (Number.isFinite(e.risk) ? e.risk : 0), 0);
    const dayPnl = s.realizedPnlToday + s.unrealizedPnl;
    const lossPct = s.dayStartBalance > 0 ? (Math.max(0, -dayPnl) / s.dayStartBalance) * 100 : 0;
    const exposure = Object.fromEntries(
      [...netCurrencyRisk(s.exposures.filter((e) => Number.isFinite(e.risk)))]
        .filter(([, v]) => Math.abs(v) > 1e-9)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .map(([ccy, v]) => [ccy, pct((v / s.equity) * 100)]),
    );
    const tradesLeft: Record<string, number> = {};
    for (const name of l.allowedSymbols) {
      try {
        const sym = await this.d.symbols.get(name);
        const used = positionsOpenedToday(s.deals, sym.symbolId) + pendingOrdersSince(this.d.client.state.getOrders(), sym.symbolId, s.dayStart);
        tradesLeft[name] = Math.max(0, l.maxTradesPerSymbolPerDay - used);
      } catch {
        // symbol not offered by this broker: omit
      }
    }
    return {
      currency: s.depositAsset,
      balance: r2(s.balance),
      equity: r2(s.equity),
      usedMargin: r2(usedMargin),
      freeMargin: r2(s.equity - usedMargin),
      marginLevelPct: usedMargin > 0 ? Math.round((s.equity / usedMargin) * 100) : null,
      today: {
        realized: r2(s.realizedPnlToday),
        floating: r2(s.unrealizedPnl),
        total: r2(dayPnl),
        dayStart: new Date(s.dayStart).toISOString(),
      },
      risk: {
        openRisk: r2(openRisk),
        openRiskPct: pct((openRisk / s.equity) * 100),
        unprotected,
        exposurePct: exposure,
      },
      limits: {
        riskPerTradePct: l.riskPerTradePct,
        openRiskRemainingPct: pct(Math.max(0, l.maxOpenRiskPct - (openRisk / s.equity) * 100)),
        dailyLossUsedPct: pct(lossPct),
        dailyLossRemainingPct: pct(Math.max(0, l.dailyLossLimitPct - lossPct)),
        newOrdersBlocked: lossPct >= l.dailyLossLimitPct || unprotected.length > 0,
        tradesLeftToday: tradesLeft,
      },
    };
  }

  async positions() {
    const positions = this.d.client.state.getPositions();
    if (positions.length === 0) return [];
    const pnl = await this.d.client.callAccount(PT.GET_POSITION_UNREALIZED_PNL_REQ, {}, PT.GET_POSITION_UNREALIZED_PNL_RES, UnrealizedPnlResSchema);
    const pnlById = new Map(pnl.positionUnrealizedPnL.map((p) => [p.positionId, moneyFromProto(p.netUnrealizedPnL, pnl.moneyDigits)]));
    const now = this.now();
    const out = [];
    for (const p of positions) {
      const sym = await this.d.symbols.getById(p.tradeData.symbolId);
      const q = await this.quote(sym);
      const buy = p.tradeData.tradeSide === TradeSide.BUY;
      const exitPrice = q ? (buy ? q.bid : q.ask) : undefined;
      const pip = pipSize(sym.pipPosition);
      const trade = this.d.trades.byPosition(p.positionId);
      const net = pnlById.get(p.positionId) ?? null;
      // Pips the market still has to travel to reach each level (positive = not reached).
      const pipsTo = (level: number | undefined, kind: 'sl' | 'tp') => {
        if (level === undefined || exitPrice === undefined) return null;
        const towardsLoss = buy ? exitPrice - level : level - exitPrice;
        return roundTo((kind === 'sl' ? towardsLoss : -towardsLoss) / pip, 1);
      };
      out.push({
        positionId: p.positionId,
        tradeId: trade?.id ?? null,
        symbol: sym.key,
        side: buy ? 'BUY' : 'SELL',
        units: p.tradeData.volume / 100,
        entry: p.price ?? null,
        price: exitPrice ?? null,
        stopLoss: p.stopLoss ?? null,
        takeProfit: p.takeProfit ?? null,
        pnl: net === null ? null : r2(net),
        /** P&L in multiples of the risk planned at entry (journal), else of the current risk to SL. */
        r: net !== null && trade && trade.riskAmount > 0 ? r2(net / trade.riskAmount) : null,
        pipsToSL: pipsTo(p.stopLoss, 'sl'),
        pipsToTP: pipsTo(p.takeProfit, 'tp'),
        hoursOpen: p.tradeData.openTimestamp ? roundTo((now - p.tradeData.openTimestamp) / 3_600_000, 1) : null,
        setup: trade?.setup ?? null,
        label: p.tradeData.label ?? null,
      });
    }
    return out;
  }

  async orders() {
    const now = this.now();
    const out = [];
    for (const o of this.d.client.state.getOrders()) {
      const sym = await this.d.symbols.getById(o.tradeData.symbolId);
      const q = await this.quote(sym);
      const buy = o.tradeData.tradeSide === TradeSide.BUY;
      const price = o.limitPrice ?? o.stopPrice;
      const trade = this.d.trades.byOrder(o.orderId);
      out.push({
        orderId: o.orderId,
        tradeId: trade?.id ?? null,
        symbol: sym.key,
        side: buy ? 'BUY' : 'SELL',
        type: o.orderType === 2 ? 'LIMIT' : o.orderType === 3 ? 'STOP' : String(o.orderType),
        units: o.tradeData.volume / 100,
        price: price ?? null,
        stopLoss: o.stopLoss ?? null,
        takeProfit: o.takeProfit ?? null,
        // distance the market must travel to fill (BUY fills on ask, SELL on bid)
        pipsFromMarket: q && price !== undefined ? roundTo(Math.abs((buy ? q.ask : q.bid) - price) / pipSize(sym.pipPosition), 1) : null,
        riskAmount: trade?.riskAmount ?? null,
        expiresAt: o.expirationTimestamp ? new Date(o.expirationTimestamp).toISOString() : null,
        hoursOld: o.tradeData.openTimestamp ? roundTo((now - o.tradeData.openTimestamp) / 3_600_000, 1) : null,
        setup: trade?.setup ?? null,
        label: o.tradeData.label ?? null,
      });
    }
    return out;
  }

  async symbolInfo(name: string, depositAssetId: number, depositAsset: string) {
    const sym = await this.d.symbols.get(name);
    const q = await this.quote(sym);
    const pip = pipSize(sym.pipPosition);
    const pipValuePerUnit = await this.d.symbols.pipValuePerUnit(sym, depositAssetId);
    const lotUnits = sym.lotSize ? sym.lotSize / 100 : undefined;
    const avg = this.d.symbols.spreads.average(sym.symbolId);
    return {
      symbol: sym.key,
      name: sym.name,
      base: sym.baseAsset,
      quote: sym.quoteAsset,
      digits: sym.digits,
      pipPosition: sym.pipPosition,
      pipSize: pip,
      pipValue: { perUnit: pipValuePerUnit, perLot: lotUnits ? roundTo(pipValuePerUnit * lotUnits, 4) : null, currency: depositAsset },
      units: {
        lot: lotUnits ?? null,
        min: sym.minVolume !== undefined ? sym.minVolume / 100 : null,
        max: sym.maxVolume !== undefined ? sym.maxVolume / 100 : null,
        step: sym.stepVolume !== undefined ? sym.stepVolume / 100 : null,
      },
      bid: q?.bid ?? null,
      ask: q?.ask ?? null,
      spreadPips: q ? roundTo(q.spread / pip, 1) : null,
      avgSpreadPips: avg !== undefined ? roundTo(avg / pip, 2) : null,
      spreadSamples: this.d.symbols.spreads.sampleCount(sym.symbolId),
    };
  }

  /** Columnar OHLC: far fewer tokens than an array of objects. */
  async candles(name: string, tf: Timeframe, count: number, includeForming: boolean) {
    const sym = await this.d.symbols.get(name);
    const bars = await this.d.candles.get(sym, tf, { count, closedOnly: !includeForming });
    return {
      symbol: sym.key,
      timeframe: tf,
      count: bars.length,
      from: bars[0]?.time ?? null,
      to: bars.at(-1)?.time ?? null,
      t: bars.map((b) => Math.round(b.t / 60_000)),
      o: bars.map((b) => b.open),
      h: bars.map((b) => b.high),
      l: bars.map((b) => b.low),
      c: bars.map((b) => b.close),
      note: 't = Unix minutes (UTC) of the bar open',
    };
  }

  private async quote(sym: SymbolInfo) {
    await this.d.symbols.ensureQuotes([sym.symbolId]);
    return this.d.symbols.getQuote(sym.symbolId) ?? (await this.d.symbols.waitForQuote(sym.symbolId, 2_000).catch(() => undefined));
  }
}

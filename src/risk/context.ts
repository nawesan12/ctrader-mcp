import type { CTraderClient } from '../ctrader/client.js';
import { moneyFromProto, PRICE_FACTOR, pipSize } from '../ctrader/normalize.js';
import { OrderType, PT, TradeSide } from '../ctrader/payloadTypes.js';
import { DealListResSchema, UnrealizedPnlResSchema, type Deal, type Order } from '../ctrader/schemas.js';
import type { SymbolInfo, SymbolService } from '../ctrader/symbols.js';
import type { EventLog } from '../journal/events.js';
import { startOfZonedDay } from '../time.js';
import { evaluateOrder, type Decision, type OpenExposure, type OrderIntent, type RiskContext, type RiskLimits } from './engine.js';

/** Deal statuses (proto ProtoOADealStatus) that moved money. */
const FILLED_DEAL = new Set<number | string>([2, 3, 'FILLED', 'PARTIALLY_FILLED']);

/** Realized P&L (deposit ccy) of deals: closing P&L + swaps + all commissions + conversion fees. */
export function realizedFromDeals(deals: Deal[]): number {
  let total = 0;
  for (const d of deals) {
    if (!FILLED_DEAL.has(d.dealStatus)) continue;
    const md = d.closePositionDetail?.moneyDigits ?? d.moneyDigits;
    if (d.closePositionDetail) {
      const c = d.closePositionDetail;
      total += moneyFromProto(c.grossProfit + c.swap + c.commission + (c.pnlConversionFee ?? 0), md);
    } else if (d.commission !== undefined) {
      total += moneyFromProto(d.commission, md);
    }
  }
  return total;
}

/** Distinct positions opened today on a symbol (opening deals have no closePositionDetail). */
export function positionsOpenedToday(deals: Deal[], symbolId: number): number {
  const ids = new Set<number>();
  for (const d of deals) {
    if (d.symbolId === symbolId && !d.closePositionDetail && FILLED_DEAL.has(d.dealStatus)) ids.add(d.positionId);
  }
  return ids.size;
}

/** Pending orders on a symbol created since `since` (Unix ms). */
export function pendingOrdersSince(orders: Order[], symbolId: number, since: number): number {
  return orders.filter((o) => o.tradeData.symbolId === symbolId && (o.tradeData.openTimestamp ?? o.utcLastUpdateTimestamp ?? 0) >= since).length;
}

export interface ExposureInput {
  id: string;
  symbol: SymbolInfo;
  side: 'BUY' | 'SELL';
  units: number;
  entry: number | undefined;
  stopLoss: number | undefined;
  pipValuePerUnit: number;
}

/** Risk to SL in deposit ccy; 0 if the SL already locks profit; Infinity if no SL. */
export function exposureRisk(e: ExposureInput): number {
  if (e.stopLoss === undefined || e.entry === undefined) return Number.POSITIVE_INFINITY;
  const dist = e.side === 'BUY' ? e.entry - e.stopLoss : e.stopLoss - e.entry;
  if (dist <= 0) return 0;
  return (dist / pipSize(e.symbol.pipPosition)) * e.pipValuePerUnit * e.units;
}

function sideOf(n: number): 'BUY' | 'SELL' {
  return n === TradeSide.BUY ? 'BUY' : 'SELL';
}

function orderEntry(o: Order): number | undefined {
  return o.limitPrice ?? o.stopPrice;
}

function orderStopLoss(o: Order, entry: number | undefined): number | undefined {
  if (o.stopLoss !== undefined) return o.stopLoss;
  if (o.relativeStopLoss !== undefined && entry !== undefined) {
    const d = o.relativeStopLoss / PRICE_FACTOR;
    return o.tradeData.tradeSide === TradeSide.BUY ? entry - d : entry + d;
  }
  return undefined;
}

export type RiskClient = Pick<CTraderClient, 'refreshTrader' | 'callAccount' | 'state'>;
export type RiskSymbols = Pick<SymbolService, 'get' | 'getById' | 'pipValuePerUnit' | 'ensureQuotes' | 'getQuote' | 'waitForQuote' | 'assetName' | 'spreads'>;

export interface RiskServiceOptions {
  client: RiskClient;
  symbols: RiskSymbols;
  events: EventLog;
  limits: RiskLimits;
  /** Time zone of the trading day (TZ_SESSIONS). */
  tz: string;
  now?: () => number;
}

export interface AccountSnapshot {
  now: number;
  balance: number;
  equity: number;
  unrealizedPnl: number;
  realizedPnlToday: number;
  dayStartBalance: number;
  depositAsset: string;
  depositAssetId: number;
  dayStart: number;
  deals: Deal[];
  exposures: OpenExposure[];
}

export class RiskService {
  private readonly now: () => number;

  constructor(private readonly o: RiskServiceOptions) {
    this.now = o.now ?? Date.now;
  }

  get limits(): RiskLimits {
    return this.o.limits;
  }

  /** Account-wide numbers shared by every order decision and by get_account. */
  async snapshot(): Promise<AccountSnapshot> {
    const now = this.now();
    const trader = await this.o.client.refreshTrader();
    const balance = moneyFromProto(trader.balance, trader.moneyDigits);
    const pnl = await this.o.client.callAccount(PT.GET_POSITION_UNREALIZED_PNL_REQ, {}, PT.GET_POSITION_UNREALIZED_PNL_RES, UnrealizedPnlResSchema);
    const unrealizedPnl = pnl.positionUnrealizedPnL.reduce((acc, p) => acc + moneyFromProto(p.netUnrealizedPnL, pnl.moneyDigits), 0);
    const dayStart = startOfZonedDay(now, this.o.tz);
    const deals = await this.dealsSince(dayStart, now);
    const realizedPnlToday = realizedFromDeals(deals);
    const depositAsset = this.o.symbols.assetName(trader.depositAssetId) ?? String(trader.depositAssetId);
    const exposures = await this.exposures(trader.depositAssetId);
    return {
      now,
      balance,
      equity: balance + unrealizedPnl,
      unrealizedPnl,
      realizedPnlToday,
      // Assumes no deposits/withdrawals during the day (see docs/DECISIONS.md).
      dayStartBalance: balance - realizedPnlToday,
      depositAsset,
      depositAssetId: trader.depositAssetId,
      dayStart,
      deals,
      exposures,
    };
  }

  /**
   * `excludeOrderId`: when re-evaluating an existing pending order (amend), its
   * own risk and its own slot in today's trade count are not counted twice.
   */
  async buildContext(intent: OrderIntent, snap?: AccountSnapshot, excludeOrderId?: number): Promise<{ ctx: RiskContext; symbol: SymbolInfo }> {
    const s = snap ?? (await this.snapshot());
    const symbol = await this.o.symbols.get(intent.symbol);
    await this.o.symbols.ensureQuotes([symbol.symbolId]);
    const q = this.o.symbols.getQuote(symbol.symbolId) ?? (await this.o.symbols.waitForQuote(symbol.symbolId, 3_000).catch(() => undefined));
    const pipValuePerUnit = await this.o.symbols.pipValuePerUnit(symbol, s.depositAssetId);
    const ctx: RiskContext = {
      now: s.now,
      equity: s.equity,
      balance: s.balance,
      depositAsset: s.depositAsset,
      dayStartBalance: s.dayStartBalance,
      realizedPnlToday: s.realizedPnlToday,
      unrealizedPnl: s.unrealizedPnl,
      symbol,
      pipValuePerUnit,
      quote: q ? { bid: q.bid, ask: q.ask } : undefined,
      avgSpread: this.o.symbols.spreads.average(symbol.symbolId, s.now),
      openExposures: s.exposures.filter((e) => e.id !== `order:${excludeOrderId}`),
      tradesTodayForSymbol:
        positionsOpenedToday(s.deals, symbol.symbolId) +
        pendingOrdersSince(
          this.o.client.state.getOrders().filter((o) => o.orderId !== excludeOrderId),
          symbol.symbolId,
          s.dayStart,
        ),
    };
    return { ctx, symbol };
  }

  /** Build context + evaluate. Rejections are always written to the event log. */
  async evaluate(
    intent: OrderIntent,
    opts: { record?: 'preview' | 'order'; idempotencyKey?: string | undefined; excludeOrderId?: number | undefined } = {},
  ): Promise<Decision & { symbol?: SymbolInfo; ctx?: RiskContext }> {
    let decision: Decision & { symbol?: SymbolInfo; ctx?: RiskContext };
    try {
      const { ctx, symbol } = await this.buildContext(intent, undefined, opts.excludeOrderId);
      decision = { ...evaluateOrder(intent, ctx, this.o.limits), symbol, ctx };
    } catch (err) {
      const reason = `context_unavailable: ${(err as Error).message}`;
      decision = { ok: false, reasons: [reason], checks: [{ rule: 'context_unavailable', ok: false, detail: (err as Error).message }] };
    }
    const data = { intent, ok: decision.ok, reasons: decision.reasons, sizing: decision.sizing };
    if (!decision.ok) this.o.events.record('risk_rejected', data, { symbol: intent.symbol, idempotencyKey: opts.idempotencyKey });
    else if (opts.record === 'preview') this.o.events.record('risk_preview', data, { symbol: intent.symbol });
    return decision;
  }

  private async dealsSince(from: number, to: number): Promise<Deal[]> {
    const out: Deal[] = [];
    let upper = to;
    for (let page = 0; page < 10; page++) {
      const res = await this.o.client.callAccount(PT.DEAL_LIST_REQ, { fromTimestamp: from, toTimestamp: upper, maxRows: 500 }, PT.DEAL_LIST_RES, DealListResSchema);
      out.push(...res.deal);
      if (!res.hasMore || res.deal.length === 0) break;
      upper = Math.min(...res.deal.map((d) => d.executionTimestamp)) - 1;
    }
    const seen = new Set<number>();
    return out.filter((d) => (seen.has(d.dealId) ? false : (seen.add(d.dealId), true)));
  }

  private async exposures(depositAssetId: number): Promise<OpenExposure[]> {
    const out: OpenExposure[] = [];
    const pipCache = new Map<number, number>();
    const pipValue = async (s: SymbolInfo) => {
      let v = pipCache.get(s.symbolId);
      if (v === undefined) {
        v = await this.o.symbols.pipValuePerUnit(s, depositAssetId);
        pipCache.set(s.symbolId, v);
      }
      return v;
    };
    const add = async (id: string, symbolId: number, side: 'BUY' | 'SELL', volume: number, entry: number | undefined, sl: number | undefined) => {
      const symbol = await this.o.symbols.getById(symbolId);
      const risk = exposureRisk({ id, symbol, side, units: volume / 100, entry, stopLoss: sl, pipValuePerUnit: await pipValue(symbol) });
      out.push({ id, symbol: symbol.key, baseAsset: symbol.baseAsset, quoteAsset: symbol.quoteAsset, side, risk });
    };
    for (const p of this.o.client.state.getPositions()) {
      await add(`position:${p.positionId}`, p.tradeData.symbolId, sideOf(p.tradeData.tradeSide), p.tradeData.volume, p.price, p.stopLoss);
    }
    for (const o of this.o.client.state.getOrders()) {
      if (o.orderType === OrderType.STOP_LOSS_TAKE_PROFIT) continue; // protection orders are not new risk
      const entry = orderEntry(o);
      await add(`order:${o.orderId}`, o.tradeData.symbolId, sideOf(o.tradeData.tradeSide), o.tradeData.volume, entry, orderStopLoss(o, entry));
    }
    return out;
  }
}

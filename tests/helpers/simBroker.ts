/**
 * Simulated cTrader demo server for tool-level tests: symbols, assets, spots,
 * trendbars, orders, positions, deals and execution events, speaking the same
 * envelope protocol as the real JSON API (through FakeTransport).
 */
import { EventEmitter } from 'node:events';
import { PT } from '../../src/ctrader/payloadTypes.js';
import type { Envelope } from '../../src/ctrader/schemas.js';
import type { Transport } from '../../src/ctrader/transport.js';

class SimTransport extends EventEmitter implements Transport {
  isOpen = false;
  constructor(private readonly sim: SimBroker) {
    super();
  }
  connect(): Promise<void> {
    this.isOpen = true;
    this.sim.transports.push(this);
    return Promise.resolve();
  }
  send(m: Envelope): void {
    if (!this.isOpen) throw new Error('not open');
    this.sim.sent.push(m);
    queueMicrotask(() => this.sim.handle(m, this));
  }
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    queueMicrotask(() => this.emit('close', 'closed'));
  }
  deliver(m: Envelope): void {
    if (this.isOpen) this.emit('message', m);
  }
}

interface SimSymbol {
  id: number;
  name: string;
  base: number;
  quote: number;
  digits: number;
  pipPosition: number;
  bid: number;
  ask: number;
}

const ACC = 1001;
const USD = 1, EUR = 2, GBP = 3, JPY = 4;

type Obj = Record<string, unknown>;

export class SimBroker {
  sent: Envelope[] = [];
  transports: SimTransport[] = [];
  balance = 10_000; // USD
  unrealized = new Map<number, number>(); // positionId -> USD
  orders = new Map<number, Obj>();
  positions = new Map<number, Obj>();
  deals: Obj[] = [];
  /** Final state of every order ever created, for ORDER_DETAILS. */
  orderHistory = new Map<number, Obj>();
  private nextOrderId = 100;
  private nextPositionId = 500;
  private nextDealId = 900;

  /** Next NEW_ORDER gets this ProtoOAOrderErrorEvent code. */
  rejectNextOrder: string | undefined;
  /** Do not answer the next trading request at all (timeout path). */
  silentNext = false;
  /** Market fills are pushed as a separate event without clientMsgId (as a real fill may be). */
  fillWithoutClientMsgId = true;

  symbols: SimSymbol[] = [
    { id: 1, name: 'EURUSD', base: EUR, quote: USD, digits: 5, pipPosition: 4, bid: 1.08, ask: 1.08008 },
    { id: 2, name: 'USDJPY', base: USD, quote: JPY, digits: 3, pipPosition: 2, bid: 150.0, ask: 150.012 },
    { id: 3, name: 'EURGBP', base: EUR, quote: GBP, digits: 5, pipPosition: 4, bid: 0.85, ask: 0.85008 },
    { id: 4, name: 'GBPUSD', base: GBP, quote: USD, digits: 5, pipPosition: 4, bid: 1.27, ask: 1.2701 },
  ];

  transportFactory = () => new SimTransport(this);

  get current(): SimTransport | undefined {
    return this.transports.at(-1);
  }

  count(pt: number): number {
    return this.sent.filter((m) => m.payloadType === pt).length;
  }

  lastSent(pt: number): Obj | undefined {
    return this.sent.filter((m) => m.payloadType === pt).at(-1)?.payload as Obj | undefined;
  }

  push(payloadType: number, payload: Obj): void {
    this.current?.deliver({ payloadType, payload });
  }

  setPrice(symbolId: number, bid: number, ask: number): void {
    const s = this.sym(symbolId);
    s.bid = bid;
    s.ask = ask;
    this.pushSpot(s);
  }

  /** Fill a resting limit order at its price (as the market would). `silent` = the event is lost. */
  fillLimit(orderId: number, silent = false): number {
    const o = this.orders.get(orderId)!;
    this.orders.delete(orderId);
    const td = o.tradeData as Obj;
    const positionId = this.nextPositionId++;
    const position = {
      positionId, tradeData: { ...td, openTimestamp: Date.now() }, positionStatus: 1, swap: 0, price: o.limitPrice,
      stopLoss: o.stopLoss, takeProfit: o.takeProfit, moneyDigits: 2, usedMargin: 10_000,
    };
    this.positions.set(positionId, position);
    const deal = this.deal(orderId, positionId, td, o.limitPrice as number);
    const filled = { ...o, orderStatus: 2, positionId, executionPrice: o.limitPrice };
    this.orderHistory.set(orderId, filled);
    if (!silent) this.push(PT.EXECUTION_EVENT, { ctidTraderAccountId: ACC, executionType: 3, order: filled, position, deal });
    return positionId;
  }

  /** Hit the SL/TP of a position at `price` (closing it). `silent` = the event is lost. */
  hitLevel(positionId: number, price: number, silent = false): void {
    const p = this.positions.get(positionId)!;
    this.closeVolume(p, (p.tradeData as Obj).volume as number, price, undefined, silent);
  }

  handle(m: Envelope, t: SimTransport): void {
    const reply = (payloadType: number, payload: Obj) => t.deliver({ payloadType, payload, clientMsgId: m.clientMsgId });
    const p = (m.payload ?? {}) as Obj;
    switch (m.payloadType) {
      case PT.HEARTBEAT_EVENT:
        return;
      case PT.APPLICATION_AUTH_REQ:
        return reply(PT.APPLICATION_AUTH_RES, {});
      case PT.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ:
        return reply(PT.GET_ACCOUNTS_BY_ACCESS_TOKEN_RES, { accessToken: 'x', ctidTraderAccount: [{ ctidTraderAccountId: ACC, isLive: false }] });
      case PT.ACCOUNT_AUTH_REQ:
        return reply(PT.ACCOUNT_AUTH_RES, { ctidTraderAccountId: ACC });
      case PT.TRADER_REQ:
        return reply(PT.TRADER_RES, { ctidTraderAccountId: ACC, trader: { ctidTraderAccountId: ACC, balance: Math.round(this.balance * 100), depositAssetId: USD, moneyDigits: 2 } });
      case PT.RECONCILE_REQ:
        return reply(PT.RECONCILE_RES, { ctidTraderAccountId: ACC, position: [...this.positions.values()], order: [...this.orders.values()] });
      case PT.ASSET_LIST_REQ:
        return reply(PT.ASSET_LIST_RES, { ctidTraderAccountId: ACC, asset: [[USD, 'USD'], [EUR, 'EUR'], [GBP, 'GBP'], [JPY, 'JPY']].map(([assetId, name]) => ({ assetId, name, digits: 2 })) });
      case PT.SYMBOLS_LIST_REQ:
        return reply(PT.SYMBOLS_LIST_RES, {
          ctidTraderAccountId: ACC,
          symbol: this.symbols.map((s) => ({ symbolId: s.id, symbolName: s.name.slice(0, 3) + '/' + s.name.slice(3), enabled: true, baseAssetId: s.base, quoteAssetId: s.quote })),
        });
      case PT.SYMBOL_BY_ID_REQ:
        return reply(PT.SYMBOL_BY_ID_RES, {
          ctidTraderAccountId: ACC,
          symbol: (p.symbolId as number[]).map((id) => {
            const s = this.sym(id);
            return { symbolId: id, digits: s.digits, pipPosition: s.pipPosition, minVolume: 100_000, maxVolume: 10_000_000_000, stepVolume: 100_000, lotSize: 10_000_000 };
          }),
        });
      case PT.SYMBOLS_FOR_CONVERSION_REQ:
        return reply(PT.SYMBOLS_FOR_CONVERSION_RES, { ctidTraderAccountId: ACC, symbol: this.path(p.firstAssetId as number, p.lastAssetId as number) });
      case PT.SUBSCRIBE_SPOTS_REQ: {
        reply(PT.SUBSCRIBE_SPOTS_RES, { ctidTraderAccountId: ACC });
        for (const id of p.symbolId as number[]) this.pushSpot(this.sym(id));
        return;
      }
      case PT.GET_POSITION_UNREALIZED_PNL_REQ:
        return reply(PT.GET_POSITION_UNREALIZED_PNL_RES, {
          ctidTraderAccountId: ACC,
          moneyDigits: 2,
          positionUnrealizedPnL: [...this.positions.keys()].map((id) => {
            const v = Math.round((this.unrealized.get(id) ?? 0) * 100);
            return { positionId: id, grossUnrealizedPnL: v, netUnrealizedPnL: v };
          }),
        });
      case PT.DEAL_LIST_REQ:
        return reply(PT.DEAL_LIST_RES, { ctidTraderAccountId: ACC, deal: this.deals, hasMore: false });
      case PT.ORDER_DETAILS_REQ: {
        const o = this.orders.get(p.orderId as number) ?? this.orderHistory.get(p.orderId as number);
        if (!o) return reply(PT.OA_ERROR_RES, { errorCode: 'ORDER_NOT_FOUND' });
        return reply(PT.ORDER_DETAILS_RES, { ctidTraderAccountId: ACC, order: o, deal: this.deals.filter((d) => d.orderId === p.orderId) });
      }
      case PT.DEAL_LIST_BY_POSITION_ID_REQ:
        return reply(PT.DEAL_LIST_BY_POSITION_ID_RES, { ctidTraderAccountId: ACC, deal: this.deals.filter((d) => d.positionId === p.positionId), hasMore: false });
      case PT.GET_TRENDBARS_REQ:
        return reply(PT.GET_TRENDBARS_RES, { ctidTraderAccountId: ACC, period: p.period, symbolId: p.symbolId, trendbar: this.trendbars(p) });
    }

    // ---- trading
    if (this.silentNext) {
      this.silentNext = false;
      return;
    }
    switch (m.payloadType) {
      case PT.NEW_ORDER_REQ: {
        if (this.rejectNextOrder) {
          const code = this.rejectNextOrder;
          this.rejectNextOrder = undefined;
          return reply(PT.ORDER_ERROR_EVENT, { ctidTraderAccountId: ACC, errorCode: code, description: 'simulated rejection' });
        }
        const s = this.sym(p.symbolId as number);
        const orderId = this.nextOrderId++;
        const tradeData = { symbolId: s.id, volume: p.volume, tradeSide: p.tradeSide, openTimestamp: Date.now(), label: p.label, comment: p.comment };
        if (p.orderType === 2) {
          const order = {
            orderId, tradeData, orderType: 2, orderStatus: 1, limitPrice: p.limitPrice, stopLoss: p.stopLoss, takeProfit: p.takeProfit,
            clientOrderId: p.clientOrderId, expirationTimestamp: p.expirationTimestamp, timeInForce: p.timeInForce,
          };
          this.orders.set(orderId, order);
          this.orderHistory.set(orderId, order);
          return reply(PT.EXECUTION_EVENT, { ctidTraderAccountId: ACC, executionType: 2, order });
        }
        // MARKET: accepted, then filled at ask (BUY) / bid (SELL)
        const buy = p.tradeSide === 1;
        const price = buy ? s.ask : s.bid;
        const rsl = (p.relativeStopLoss as number) / 1e5;
        const rtp = (p.relativeTakeProfit as number) / 1e5;
        const order = { orderId, tradeData, orderType: 1, orderStatus: 1, clientOrderId: p.clientOrderId, relativeStopLoss: p.relativeStopLoss, relativeTakeProfit: p.relativeTakeProfit };
        reply(PT.EXECUTION_EVENT, { ctidTraderAccountId: ACC, executionType: 2, order });
        const positionId = this.nextPositionId++;
        const r = (x: number) => Math.round(x * 10 ** s.digits) / 10 ** s.digits;
        const position = {
          positionId, tradeData, positionStatus: 1, swap: 0, price,
          stopLoss: r(buy ? price - rsl : price + rsl), takeProfit: r(buy ? price + rtp : price - rtp), moneyDigits: 2, usedMargin: 10_000,
        };
        this.positions.set(positionId, position);
        const fill = { ctidTraderAccountId: ACC, executionType: 3, order: { ...order, orderStatus: 2, positionId, executionPrice: price }, position, deal: this.deal(orderId, positionId, tradeData, price) };
        if (this.fillWithoutClientMsgId) setTimeout(() => this.push(PT.EXECUTION_EVENT, fill), 5);
        else reply(PT.EXECUTION_EVENT, fill);
        return;
      }
      case PT.AMEND_ORDER_REQ: {
        const o = this.orders.get(p.orderId as number);
        if (!o) return reply(PT.OA_ERROR_RES, { errorCode: 'ORDER_NOT_FOUND' });
        for (const k of ['limitPrice', 'stopLoss', 'takeProfit', 'expirationTimestamp'] as const) if (p[k] !== undefined) o[k] = p[k];
        if (p.volume !== undefined) (o.tradeData as Obj).volume = p.volume;
        return reply(PT.EXECUTION_EVENT, { ctidTraderAccountId: ACC, executionType: 4, order: o });
      }
      case PT.CANCEL_ORDER_REQ: {
        const o = this.orders.get(p.orderId as number);
        if (!o) return reply(PT.OA_ERROR_RES, { errorCode: 'ORDER_NOT_FOUND' });
        this.orders.delete(p.orderId as number);
        this.orderHistory.set(p.orderId as number, { ...o, orderStatus: 5 });
        return reply(PT.EXECUTION_EVENT, { ctidTraderAccountId: ACC, executionType: 5, order: { ...o, orderStatus: 5 } });
      }
      case PT.AMEND_POSITION_SLTP_REQ: {
        const pos = this.positions.get(p.positionId as number);
        if (!pos) return reply(PT.OA_ERROR_RES, { errorCode: 'POSITION_NOT_FOUND' });
        pos.stopLoss = p.stopLoss;
        pos.takeProfit = p.takeProfit;
        return reply(PT.EXECUTION_EVENT, { ctidTraderAccountId: ACC, executionType: 4, position: pos });
      }
      case PT.CLOSE_POSITION_REQ: {
        const pos = this.positions.get(p.positionId as number);
        if (!pos) return reply(PT.OA_ERROR_RES, { errorCode: 'POSITION_NOT_FOUND' });
        const s = this.sym((pos.tradeData as Obj).symbolId as number);
        const buy = (pos.tradeData as Obj).tradeSide === 1;
        this.closeVolume(pos, p.volume as number, buy ? s.bid : s.ask, reply);
        return;
      }
      default:
        return;
    }
  }

  private closeVolume(pos: Obj, volume: number, price: number, reply: ((pt: number, p: Obj) => void) | undefined, silent = false): void {
    const td = pos.tradeData as Obj;
    const orderId = this.nextOrderId++;
    const closing = { orderId, tradeData: { ...td, volume, tradeSide: td.tradeSide === 1 ? 2 : 1 }, orderType: 1, orderStatus: 1, closingOrder: true, positionId: pos.positionId };
    if (reply) reply(PT.EXECUTION_EVENT, { ctidTraderAccountId: ACC, executionType: 2, order: closing });
    const remaining = (td.volume as number) - volume;
    const dir = td.tradeSide === 1 ? 1 : -1;
    const gross = Math.round((price - (pos.price as number)) * dir * (volume / 100) * 100); // USD-quoted symbols only
    this.balance += gross / 100 - 3;
    const after = { ...pos, tradeData: { ...td, volume: remaining || volume }, positionStatus: remaining > 0 ? 1 : 2 };
    if (remaining > 0) this.positions.set(pos.positionId as number, after);
    else this.positions.delete(pos.positionId as number);
    const deal = {
      dealId: this.nextDealId++, orderId, positionId: pos.positionId, volume, filledVolume: volume, symbolId: td.symbolId,
      createTimestamp: Date.now(), executionTimestamp: Date.now(), executionPrice: price, tradeSide: closing.tradeData.tradeSide, dealStatus: 2,
      commission: -300, moneyDigits: 2,
      closePositionDetail: { entryPrice: pos.price, grossProfit: gross, swap: 0, commission: -300, balance: Math.round(this.balance * 100), moneyDigits: 2, closedVolume: volume },
    };
    this.deals.push(deal);
    if (!silent) setTimeout(() => this.push(PT.EXECUTION_EVENT, { ctidTraderAccountId: ACC, executionType: 3, order: { ...closing, orderStatus: 2 }, position: after, deal }), 5);
  }

  private deal(orderId: number, positionId: number, td: Obj, price: number): Obj {
    const d = {
      dealId: this.nextDealId++, orderId, positionId, volume: td.volume, filledVolume: td.volume, symbolId: td.symbolId,
      createTimestamp: Date.now(), executionTimestamp: Date.now(), executionPrice: price, tradeSide: td.tradeSide, dealStatus: 2, commission: -300, moneyDigits: 2,
    };
    this.deals.push(d);
    this.balance -= 3;
    return d;
  }

  private pushSpot(s: SimSymbol): void {
    this.push(PT.SPOT_EVENT, { ctidTraderAccountId: ACC, symbolId: s.id, bid: Math.round(s.bid * 1e5), ask: Math.round(s.ask * 1e5), timestamp: Date.now() });
  }

  private sym(id: number): SimSymbol {
    const s = this.symbols.find((x) => x.id === id);
    if (!s) throw new Error(`sim: unknown symbol ${id}`);
    return s;
  }

  /** Conversion chain between two assets (direct, or through USD). */
  private path(from: number, to: number): Obj[] {
    const light = (s: SimSymbol) => ({ symbolId: s.id, symbolName: s.name, baseAssetId: s.base, quoteAssetId: s.quote });
    const direct = this.symbols.find((s) => (s.base === from && s.quote === to) || (s.base === to && s.quote === from));
    if (direct) return [light(direct)];
    const a = this.symbols.find((s) => (s.base === from && s.quote === USD) || (s.base === USD && s.quote === from));
    const b = this.symbols.find((s) => (s.base === USD && s.quote === to) || (s.base === to && s.quote === USD));
    return a && b ? [light(a), light(b)] : [];
  }

  /** Deterministic zig-zag trendbars ending at `toTimestamp`. */
  private trendbars(p: Obj): Obj[] {
    const periodMin: Record<number, number> = { 1: 1, 5: 5, 7: 15, 8: 30, 9: 60, 10: 240, 12: 1440 };
    const step = (periodMin[p.period as number] ?? 60) * 60_000;
    const count = Math.min((p.count as number) ?? 100, 500);
    const end = Math.floor((p.toTimestamp as number) / step) * step;
    const out: Obj[] = [];
    for (let i = count - 1; i >= 0; i--) {
      const t = end - i * step;
      const k = t / step;
      const mid = 108_000 + Math.round(400 * Math.sin(k / 9) + 150 * Math.sin(k / 2.3));
      const low = mid - 30 - (k % 7) * 3;
      out.push({ volume: 100, low, deltaOpen: 20 + (k % 5) * 4, deltaClose: 25 + (k % 3) * 9, deltaHigh: 70 + (k % 4) * 6, utcTimestampInMinutes: t / 60_000 });
    }
    return out;
  }
}

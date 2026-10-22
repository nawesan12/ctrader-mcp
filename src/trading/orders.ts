import { killzoneAt } from '../analysis/smc.js';
import type { CTraderClient } from '../ctrader/client.js';
import { parsePayload } from '../ctrader/client.js';
import { CTraderApiError, CTraderDisconnectedError, CTraderTimeoutError } from '../ctrader/errors.js';
import { moneyFromProto, normalizeVolume, priceDistanceToRelative, roundTo, unitsToVolume } from '../ctrader/normalize.js';
import { ExecutionType, OrderType, PT, TimeInForce, TradeSide } from '../ctrader/payloadTypes.js';
import { ExecutionEventSchema, type ExecutionEvent, type Order, type Position } from '../ctrader/schemas.js';
import type { SymbolInfo, SymbolService } from '../ctrader/symbols.js';
import type { EventLog } from '../journal/events.js';
import type { TradeStore } from '../journal/trades.js';
import type { Logger } from '../logger.js';
import { evaluateAmend, type NewsEvent, type Sizing } from '../risk/engine.js';
import type { RiskService } from '../risk/context.js';
import { IdempotencyStore } from './idempotency.js';
import { Mutex } from './mutex.js';

export type Side = 'BUY' | 'SELL';

export interface PlaceLimitInput {
  symbol: string;
  side: Side;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  expiresAt?: string | undefined;
  label?: string | undefined;
  thesis: string;
  setup?: string | undefined;
  riskPct?: number | undefined;
  idempotencyKey: string;
}

export interface PlaceMarketInput {
  symbol: string;
  side: Side;
  stopLoss: number;
  takeProfit: number;
  label?: string | undefined;
  thesis: string;
  setup?: string | undefined;
  riskPct?: number | undefined;
  blockedUntil?: string | undefined;
  newsEvents?: NewsEvent[] | undefined;
  idempotencyKey: string;
}

export interface AmendOrderInput {
  orderId: number;
  entry?: number | undefined;
  stopLoss?: number | undefined;
  takeProfit?: number | undefined;
  expiresAt?: string | undefined;
  reason: string;
  idempotencyKey: string;
}

export interface AmendPositionInput {
  positionId: number;
  stopLoss: number;
  takeProfit: number;
  reason: string;
  idempotencyKey: string;
}

export interface ClosePositionInput {
  positionId: number;
  /** Units to close; omit for the whole position. */
  units?: number | undefined;
  reason: string;
  idempotencyKey: string;
}

export interface CancelOrderInput {
  orderId: number;
  reason: string;
  idempotencyKey: string;
}

/** What every state-changing tool returns. */
export interface ActionResult {
  ok: boolean;
  /** confirmed = backed by a ProtoOAExecutionEvent; unconfirmed = sent but not confirmed in time (state reconciled). */
  status: 'accepted' | 'filled' | 'replaced' | 'cancelled' | 'closed' | 'partially_closed' | 'rejected' | 'unconfirmed';
  duplicate?: boolean;
  reasons?: string[];
  tradeId?: number;
  order?: OrderView;
  position?: PositionView;
  sizing?: Sizing;
  message?: string;
}

export interface OrderView {
  orderId: number;
  symbol: string;
  side: Side;
  type: string;
  units: number;
  price: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  expiresAt: string | null;
  label: string | null;
}

export interface PositionView {
  positionId: number;
  symbol: string;
  side: Side;
  units: number;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  status: 'open' | 'closed';
}

export interface OrderServiceOptions {
  client: Pick<CTraderClient, 'request' | 'reconcile' | 'state' | 'accountId' | 'on' | 'off'>;
  risk: Pick<RiskService, 'evaluate'>;
  symbols: Pick<SymbolService, 'get' | 'getById' | 'getQuote' | 'ensureQuotes' | 'waitForQuote'>;
  trades: TradeStore;
  events: EventLog;
  idempotency: IdempotencyStore;
  logger: Logger;
  tz: string;
  confirmTimeoutMs?: number;
  now?: () => number;
}

const ORDER_TYPE_NAME: Record<number, string> = { 1: 'MARKET', 2: 'LIMIT', 3: 'STOP', 4: 'STOP_LOSS_TAKE_PROFIT', 5: 'MARKET_RANGE', 6: 'STOP_LIMIT' };
const side = (n: number): Side => (n === TradeSide.BUY ? 'BUY' : 'SELL');

type Verdict = 'ok' | 'fail' | undefined;

export class OrderService {
  private readonly mutex = new Mutex();
  private readonly now: () => number;
  private readonly confirmTimeoutMs: number;
  private readonly log: Logger;

  constructor(private readonly o: OrderServiceOptions) {
    this.now = o.now ?? Date.now;
    this.confirmTimeoutMs = o.confirmTimeoutMs ?? 15_000;
    this.log = o.logger.child({ component: 'orders' });
  }

  // ------------------------------------------------------------------ public tools

  placeLimit(input: PlaceLimitInput): Promise<ActionResult> {
    return this.guarded('place_limit_order', input, async () => {
      const expiresAtMs = input.expiresAt !== undefined ? Date.parse(input.expiresAt) : undefined;
      if (expiresAtMs !== undefined && !(expiresAtMs > this.now() + 60_000)) {
        return this.reject(input, ['expiresAt: must be a valid ISO time at least 1 minute in the future']);
      }
      const decision = await this.o.risk.evaluate(
        { symbol: input.symbol, side: input.side, orderType: 'LIMIT', entry: input.entry, stopLoss: input.stopLoss, takeProfit: input.takeProfit, riskPct: input.riskPct },
        { record: 'order', idempotencyKey: input.idempotencyKey },
      );
      if (!decision.ok || !decision.sizing || !decision.symbol) return { ok: false, status: 'rejected', reasons: decision.reasons, sizing: decision.sizing };
      const sz = decision.sizing;
      const symbol = decision.symbol;
      const tradeId = this.o.trades.insert({
        idempotencyKey: input.idempotencyKey, symbol: symbol.key, side: input.side, orderType: 'LIMIT', entryPlanned: sz.entry,
        stopLoss: sz.stopLoss, takeProfit: sz.takeProfit, units: sz.units, riskAmount: sz.riskAmount, depositCurrency: decision.ctx?.depositAsset ?? '',
        thesis: input.thesis, setup: input.setup ?? null, killzone: killzoneAt(this.now(), this.o.tz) ?? null, label: input.label ?? null,
      });
      const payload = {
        ctidTraderAccountId: this.o.client.accountId,
        symbolId: symbol.symbolId,
        orderType: OrderType.LIMIT,
        tradeSide: input.side === 'BUY' ? TradeSide.BUY : TradeSide.SELL,
        volume: sz.volume,
        limitPrice: sz.entry,
        stopLoss: sz.stopLoss,
        takeProfit: sz.takeProfit,
        timeInForce: expiresAtMs !== undefined ? TimeInForce.GOOD_TILL_DATE : TimeInForce.GOOD_TILL_CANCEL,
        ...(expiresAtMs !== undefined ? { expirationTimestamp: expiresAtMs } : {}),
        ...(input.label ? { label: input.label } : {}),
        comment: commentFrom(input.setup, input.thesis),
        clientOrderId: input.idempotencyKey,
      };
      return this.submitNewOrder(payload, input, symbol, sz, tradeId, (ev, first) => {
        if (isRejected(ev, first)) return 'fail';
        return ev.order?.orderId === first.order?.orderId && ev.executionType === ExecutionType.ORDER_ACCEPTED ? 'ok' : undefined;
      });
    });
  }

  placeMarket(input: PlaceMarketInput): Promise<ActionResult> {
    return this.guarded('place_market_order', input, async () => {
      const decision = await this.o.risk.evaluate(
        {
          symbol: input.symbol, side: input.side, orderType: 'MARKET', stopLoss: input.stopLoss, takeProfit: input.takeProfit,
          riskPct: input.riskPct, blockedUntil: input.blockedUntil, newsEvents: input.newsEvents,
        },
        { record: 'order', idempotencyKey: input.idempotencyKey },
      );
      if (!decision.ok || !decision.sizing || !decision.symbol) return { ok: false, status: 'rejected', reasons: decision.reasons, sizing: decision.sizing };
      const sz = decision.sizing;
      const symbol = decision.symbol;
      const tradeId = this.o.trades.insert({
        idempotencyKey: input.idempotencyKey, symbol: symbol.key, side: input.side, orderType: 'MARKET', entryPlanned: sz.entry,
        stopLoss: sz.stopLoss, takeProfit: sz.takeProfit, units: sz.units, riskAmount: sz.riskAmount, depositCurrency: decision.ctx?.depositAsset ?? '',
        thesis: input.thesis, setup: input.setup ?? null, killzone: killzoneAt(this.now(), this.o.tz) ?? null, label: input.label ?? null,
      });
      // MARKET orders do not accept absolute SL/TP: send the distances (1/100000 of price),
      // so the risk distance is preserved even if the fill slips.
      const payload = {
        ctidTraderAccountId: this.o.client.accountId,
        symbolId: symbol.symbolId,
        orderType: OrderType.MARKET,
        tradeSide: input.side === 'BUY' ? TradeSide.BUY : TradeSide.SELL,
        volume: sz.volume,
        relativeStopLoss: priceDistanceToRelative(roundTo(Math.abs(sz.entry - sz.stopLoss), symbol.digits)),
        relativeTakeProfit: priceDistanceToRelative(roundTo(Math.abs(sz.takeProfit - sz.entry), symbol.digits)),
        ...(input.label ? { label: input.label } : {}),
        comment: commentFrom(input.setup, input.thesis),
        clientOrderId: input.idempotencyKey,
      };
      return this.submitNewOrder(payload, input, symbol, sz, tradeId, (ev, first) => {
        if (isRejected(ev, first)) return 'fail';
        const sameOrder = ev.order?.orderId === first.order?.orderId;
        return sameOrder && ev.executionType === ExecutionType.ORDER_FILLED ? 'ok' : undefined;
      });
    });
  }

  amendOrder(input: AmendOrderInput): Promise<ActionResult> {
    return this.guarded('amend_order', input, async () => {
      const current = this.o.client.state.getOrder(input.orderId);
      if (!current || current.orderType !== OrderType.LIMIT) return this.reject(input, [`order ${input.orderId} is not an open LIMIT order`]);
      const symbol = await this.o.symbols.getById(current.tradeData.symbolId);
      const entry = input.entry ?? current.limitPrice;
      const sl = input.stopLoss ?? current.stopLoss;
      const tp = input.takeProfit ?? current.takeProfit;
      const decision = await this.o.risk.evaluate(
        { symbol: symbol.key, side: side(current.tradeData.tradeSide), orderType: 'LIMIT', entry, stopLoss: sl, takeProfit: tp },
        { record: 'order', idempotencyKey: input.idempotencyKey, excludeOrderId: input.orderId },
      );
      if (!decision.ok || !decision.sizing) return { ok: false, status: 'rejected', reasons: decision.reasons, sizing: decision.sizing };
      const sz = decision.sizing;
      // Never increase the size of an existing order: keep the smaller of current and re-computed.
      const volume = Math.min(current.tradeData.volume, sz.volume);
      const expiresAtMs = input.expiresAt !== undefined ? Date.parse(input.expiresAt) : undefined;
      if (expiresAtMs !== undefined && !(expiresAtMs > this.now() + 60_000)) {
        return this.reject(input, ['expiresAt: must be a valid ISO time at least 1 minute in the future']);
      }
      const payload = {
        ctidTraderAccountId: this.o.client.accountId,
        orderId: input.orderId,
        volume,
        limitPrice: sz.entry,
        stopLoss: sz.stopLoss,
        takeProfit: sz.takeProfit,
        ...(expiresAtMs !== undefined ? { expirationTimestamp: expiresAtMs } : {}),
      };
      this.o.events.record('amend_request', { input, payload }, { symbol: symbol.key, idempotencyKey: input.idempotencyKey });
      const r = await this.confirm(PT.AMEND_ORDER_REQ, payload, (ev) => {
        if (ev.order?.orderId !== input.orderId) return undefined;
        if (ev.executionType === ExecutionType.ORDER_REJECTED) return 'fail';
        return ev.executionType === ExecutionType.ORDER_REPLACED ? 'ok' : undefined;
      });
      return this.finish(r, symbol, 'replaced', { sizing: { ...sz, volume, units: volume / 100 } });
    });
  }

  amendPosition(input: AmendPositionInput): Promise<ActionResult> {
    return this.guarded('amend_position_sl_tp', input, async () => {
      const pos = this.o.client.state.getPosition(input.positionId);
      if (!pos) return this.reject(input, [`position ${input.positionId} is not open`]);
      const symbol = await this.o.symbols.getById(pos.tradeData.symbolId);
      const q = await this.quote(symbol);
      if (!q) return this.reject(input, ['no live quote: cannot validate the new SL/TP']);
      const newSl = roundTo(input.stopLoss, symbol.digits);
      const newTp = roundTo(input.takeProfit, symbol.digits);
      const d = evaluateAmend({ side: side(pos.tradeData.tradeSide), currentStopLoss: pos.stopLoss, newStopLoss: newSl, newTakeProfit: newTp, bid: q.bid, ask: q.ask });
      if (!d.ok) {
        this.o.events.record('risk_rejected', { input, reasons: d.reasons }, { symbol: symbol.key, idempotencyKey: input.idempotencyKey });
        return { ok: false, status: 'rejected', reasons: d.reasons };
      }
      const payload = { ctidTraderAccountId: this.o.client.accountId, positionId: input.positionId, stopLoss: newSl, takeProfit: newTp };
      this.o.events.record('amend_request', { input, payload }, { symbol: symbol.key, idempotencyKey: input.idempotencyKey });
      const r = await this.confirm(PT.AMEND_POSITION_SLTP_REQ, payload, (ev) => {
        if (ev.position?.positionId !== input.positionId) return undefined;
        if (ev.executionType === ExecutionType.ORDER_REJECTED) return 'fail';
        const p = ev.position;
        return near(p.stopLoss, newSl) && near(p.takeProfit, newTp) ? 'ok' : undefined;
      });
      return this.finish(r, symbol, 'replaced');
    });
  }

  closePosition(input: ClosePositionInput): Promise<ActionResult> {
    return this.guarded('close_position', input, async () => {
      const pos = this.o.client.state.getPosition(input.positionId);
      if (!pos) return this.reject(input, [`position ${input.positionId} is not open`]);
      const symbol = await this.o.symbols.getById(pos.tradeData.symbolId);
      let volume = pos.tradeData.volume;
      if (input.units !== undefined) {
        const v = normalizeVolume(unitsToVolume(input.units), { stepVolume: symbol.stepVolume, minVolume: symbol.minVolume });
        if (!v.ok) return this.reject(input, [`units: ${v.reason}`]);
        volume = Math.min(v.volume, pos.tradeData.volume);
        const rest = pos.tradeData.volume - volume;
        if (rest > 0 && symbol.minVolume !== undefined && rest < symbol.minVolume) {
          return this.reject(input, [`units: the remaining ${rest / 100} units would be below the minimum ${symbol.minVolume / 100}; close the whole position`]);
        }
      }
      const full = volume === pos.tradeData.volume;
      if (full) this.o.trades.setCloseReason(input.positionId, input.reason);
      const payload = { ctidTraderAccountId: this.o.client.accountId, positionId: input.positionId, volume };
      this.o.events.record('close_request', { input, payload }, { symbol: symbol.key, idempotencyKey: input.idempotencyKey });
      let closingOrderId: number | undefined;
      const r = await this.confirm(PT.CLOSE_POSITION_REQ, payload, (ev, first) => {
        closingOrderId ??= first.order?.orderId;
        if (ev.position?.positionId !== input.positionId && ev.order?.orderId !== closingOrderId) return undefined;
        if (ev.executionType === ExecutionType.ORDER_REJECTED || ev.executionType === ExecutionType.ORDER_CANCELLED) return 'fail';
        return ev.executionType === ExecutionType.ORDER_FILLED ? 'ok' : undefined;
      });
      return this.finish(r, symbol, full ? 'closed' : 'partially_closed');
    });
  }

  cancelOrder(input: CancelOrderInput): Promise<ActionResult> {
    return this.guarded('cancel_order', input, async () => {
      const ord = this.o.client.state.getOrder(input.orderId);
      if (!ord) return this.reject(input, [`order ${input.orderId} is not pending`]);
      const symbol = await this.o.symbols.getById(ord.tradeData.symbolId);
      const payload = { ctidTraderAccountId: this.o.client.accountId, orderId: input.orderId };
      this.o.events.record('cancel_request', { input, payload }, { symbol: symbol.key, idempotencyKey: input.idempotencyKey });
      const r = await this.confirm(PT.CANCEL_ORDER_REQ, payload, (ev) => {
        if (ev.order?.orderId !== input.orderId) return undefined;
        if (ev.executionType === ExecutionType.ORDER_CANCEL_REJECTED) return 'fail';
        return ev.executionType === ExecutionType.ORDER_CANCELLED ? 'ok' : undefined;
      });
      return this.finish(r, symbol, 'cancelled');
    });
  }

  // ------------------------------------------------------------------ internals

  /** Idempotency + serialisation + error mapping around every state-changing tool. */
  private async guarded<I extends { idempotencyKey: string }>(tool: string, input: I, fn: () => Promise<ActionResult>): Promise<ActionResult> {
    return this.mutex.run(async () => {
      const { idempotencyKey, ...request } = input;
      const claim = this.o.idempotency.claim<ActionResult>(idempotencyKey, tool, request);
      if (claim.kind === 'duplicate') return { ...claim.result, duplicate: true };
      if (claim.kind === 'in_progress') {
        return { ok: false, status: 'unconfirmed', duplicate: true, message: 'a request with this idempotencyKey is still being processed' };
      }
      let result: ActionResult;
      try {
        result = await fn();
      } catch (err) {
        if (err instanceof CTraderDisconnectedError) {
          // Nothing reached the broker if we were not connected when sending: allow a retry with the same key.
          this.o.idempotency.release(idempotencyKey);
          return { ok: false, status: 'rejected', reasons: [`broker_unavailable: ${err.message}`] };
        }
        result = { ok: false, status: 'rejected', reasons: [`error: ${(err as Error).message}`] };
      }
      this.o.idempotency.complete(idempotencyKey, result);
      return result;
    });
  }

  private reject(input: { idempotencyKey: string }, reasons: string[]): ActionResult {
    this.o.events.record('order_rejected', { input, reasons }, { idempotencyKey: input.idempotencyKey });
    return { ok: false, status: 'rejected', reasons };
  }

  private async submitNewOrder(
    payload: Record<string, unknown>,
    input: PlaceLimitInput | PlaceMarketInput,
    symbol: SymbolInfo,
    sizing: Sizing,
    tradeId: number,
    final: (ev: ExecutionEvent, first: ExecutionEvent) => Verdict,
  ): Promise<ActionResult> {
    this.o.events.record('order_request', { input, payload, sizing, tradeId }, { symbol: symbol.key, idempotencyKey: input.idempotencyKey });
    let r: ConfirmResult;
    try {
      r = await this.confirm(PT.NEW_ORDER_REQ, payload, final);
    } catch (err) {
      this.o.trades.update(tradeId, { status: 'rejected', rejectReason: `not sent: ${(err as Error).message}` });
      throw err;
    }

    if (r.kind === 'error') {
      this.o.trades.update(tradeId, { status: 'rejected', rejectReason: r.reason });
      this.o.events.record('order_rejected', { tradeId, reason: r.reason }, { symbol: symbol.key, idempotencyKey: input.idempotencyKey });
      return { ok: false, status: 'rejected', reasons: [r.reason], tradeId, sizing };
    }
    if (r.kind === 'unconfirmed') {
      const found = this.o.client.state.getOrders().find((o) => o.clientOrderId === input.idempotencyKey);
      this.o.trades.update(tradeId, { status: found ? 'pending' : 'unconfirmed', orderId: found?.orderId });
      return {
        ok: false, status: 'unconfirmed', tradeId, sizing,
        order: found ? orderView(found, symbol) : undefined,
        message: 'sent but not confirmed in time; state was reconciled. Check get_orders/get_positions before retrying with a NEW key.',
      };
    }
    const ev = r.event;
    this.o.events.record('execution', ev, { symbol: symbol.key, idempotencyKey: input.idempotencyKey });
    if (r.verdict === 'fail') {
      const reason = `broker: ${ev.errorCode ?? ExecutionTypeName(ev.executionType)}`;
      this.o.trades.update(tradeId, { status: 'rejected', rejectReason: reason, orderId: ev.order?.orderId });
      return { ok: false, status: 'rejected', reasons: [reason], tradeId, sizing };
    }
    const filled = ev.executionType === ExecutionType.ORDER_FILLED;
    this.o.trades.update(tradeId, {
      orderId: ev.order?.orderId,
      ...(filled
        ? { status: 'open', positionId: ev.position?.positionId, entry: ev.position?.price ?? ev.order?.executionPrice, openedAt: new Date(this.now()).toISOString(),
            stopLoss: ev.position?.stopLoss, takeProfit: ev.position?.takeProfit, initialStopLoss: ev.position?.stopLoss, units: ev.position ? ev.position.tradeData.volume / 100 : undefined,
            // The fill event can reach the journal listener before orderId is stored: book the opening commission here.
            pnl: ev.deal?.commission !== undefined ? moneyFromProto(ev.deal.commission, ev.deal.moneyDigits) : undefined }
        : { status: 'pending' }),
    });
    return {
      ok: true,
      status: filled ? 'filled' : 'accepted',
      tradeId,
      sizing,
      order: ev.order && !filled ? orderView(ev.order, symbol) : undefined,
      position: ev.position ? positionView(ev.position, symbol) : undefined,
    };
  }

  private finish(r: ConfirmResult, symbol: SymbolInfo, okStatus: ActionResult['status'], extra: Partial<ActionResult> = {}): ActionResult {
    if (r.kind === 'error') return { ok: false, status: 'rejected', reasons: [r.reason], ...extra };
    if (r.kind === 'unconfirmed') return { ok: false, status: 'unconfirmed', message: 'sent but not confirmed in time; state was reconciled, check get_orders/get_positions', ...extra };
    this.o.events.record('execution', r.event, { symbol: symbol.key });
    if (r.verdict === 'fail') return { ok: false, status: 'rejected', reasons: [`broker: ${r.event.errorCode ?? ExecutionTypeName(r.event.executionType)}`], ...extra };
    return {
      ok: true,
      status: okStatus,
      order: r.event.order && !r.event.order.closingOrder ? orderView(r.event.order, symbol) : undefined,
      position: r.event.position ? positionView(r.event.position, symbol) : undefined,
      ...extra,
    };
  }

  /**
   * Send a trading request and wait until an execution event satisfies
   * `final`. Events are buffered from BEFORE the send so a fast fill is never
   * missed. On timeout the account is reconciled and the result is
   * 'unconfirmed' (never retried automatically: that could duplicate orders).
   */
  private async confirm(payloadType: number, payload: object, final: (ev: ExecutionEvent, first: ExecutionEvent) => Verdict): Promise<ConfirmResult> {
    const buffer: ExecutionEvent[] = [];
    const onExec = (ev: ExecutionEvent) => buffer.push(ev);
    this.o.client.on('execution', onExec);
    try {
      let first: ExecutionEvent;
      try {
        const env = await this.o.client.request(payloadType, payload, PT.EXECUTION_EVENT, { timeoutMs: this.confirmTimeoutMs });
        first = parsePayload(ExecutionEventSchema, env, 'execution event');
      } catch (err) {
        if (err instanceof CTraderApiError) return { kind: 'error', reason: `${err.errorCode}${err.description ? `: ${err.description}` : ''}` };
        if (err instanceof CTraderTimeoutError) return this.unconfirmed();
        if (err instanceof CTraderDisconnectedError && err.sent) return this.unconfirmed();
        throw err;
      }
      const deadline = this.now() + this.confirmTimeoutMs;
      for (;;) {
        for (const ev of [first, ...buffer]) {
          const v = final(ev, first);
          if (v) return { kind: 'done', verdict: v, event: ev };
        }
        if (this.now() > deadline) return this.unconfirmed();
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      this.o.client.off('execution', onExec);
    }
  }

  private async unconfirmed(): Promise<ConfirmResult> {
    try {
      await this.o.client.reconcile();
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'reconcile after unconfirmed request failed');
    }
    return { kind: 'unconfirmed' };
  }

  private async quote(symbol: SymbolInfo) {
    await this.o.symbols.ensureQuotes([symbol.symbolId]);
    return this.o.symbols.getQuote(symbol.symbolId) ?? (await this.o.symbols.waitForQuote(symbol.symbolId, 3_000).catch(() => undefined));
  }
}

type ConfirmResult = { kind: 'done'; verdict: 'ok' | 'fail'; event: ExecutionEvent } | { kind: 'error'; reason: string } | { kind: 'unconfirmed' };

function isRejected(ev: ExecutionEvent, first: ExecutionEvent): boolean {
  const same = ev.order?.orderId === undefined || ev.order.orderId === first.order?.orderId;
  return same && (ev.executionType === ExecutionType.ORDER_REJECTED || ev.executionType === ExecutionType.ORDER_CANCELLED || ev.executionType === ExecutionType.ORDER_EXPIRED);
}

function near(a: number | undefined, b: number): boolean {
  return a !== undefined && Math.abs(a - b) < 1e-9 + Math.abs(b) * 1e-12;
}

function ExecutionTypeName(t: number): string {
  return Object.entries(ExecutionType).find(([, v]) => v === t)?.[0] ?? String(t);
}

/** Broker comment: short, setup first. The full thesis lives in the journal. */
function commentFrom(setup: string | undefined, thesis: string): string {
  return `${setup ? `[${setup}] ` : ''}${thesis}`.slice(0, 100);
}

export function orderView(o: Order, symbol: SymbolInfo): OrderView {
  return {
    orderId: o.orderId,
    symbol: symbol.key,
    side: side(o.tradeData.tradeSide),
    type: ORDER_TYPE_NAME[o.orderType] ?? String(o.orderType),
    units: o.tradeData.volume / 100,
    price: o.limitPrice ?? o.stopPrice ?? null,
    stopLoss: o.stopLoss ?? null,
    takeProfit: o.takeProfit ?? null,
    expiresAt: o.expirationTimestamp ? new Date(o.expirationTimestamp).toISOString() : null,
    label: o.tradeData.label ?? null,
  };
}

export function positionView(p: Position, symbol: SymbolInfo): PositionView {
  return {
    positionId: p.positionId,
    symbol: symbol.key,
    side: side(p.tradeData.tradeSide),
    units: p.tradeData.volume / 100,
    entry: p.price ?? null,
    stopLoss: p.stopLoss ?? null,
    takeProfit: p.takeProfit ?? null,
    status: p.positionStatus === 2 ? 'closed' : 'open',
  };
}

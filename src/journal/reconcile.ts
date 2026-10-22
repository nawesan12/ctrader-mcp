import type { CTraderClient } from '../ctrader/client.js';
import { moneyFromProto } from '../ctrader/normalize.js';
import { OrderStatus, PT } from '../ctrader/payloadTypes.js';
import { DealListResSchema, OrderDetailsResSchema, type Deal } from '../ctrader/schemas.js';
import type { SymbolService } from '../ctrader/symbols.js';
import type { Logger } from '../logger.js';
import { realizedFromDeals } from '../risk/context.js';
import { inferCloseReason, type TradeStore } from './trades.js';

export interface JournalReconcilerOptions {
  client: Pick<CTraderClient, 'callAccount' | 'state'>;
  trades: TradeStore;
  symbols: Pick<SymbolService, 'cached'>;
  logger: Logger;
  now?: () => number;
}

/**
 * Makes the journal agree with the broker after anything we may have missed
 * (server down while an SL/TP hit or a limit filled, dropped events...).
 * It only queries the broker for trades whose state disagrees with the
 * in-memory account state, so a normal run costs zero requests.
 */
export class JournalReconciler {
  private running: Promise<number> | undefined;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly o: JournalReconcilerOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.logger.child({ component: 'journal-reconcile' });
  }

  /** Single-flight; returns the number of trades corrected. */
  run(): Promise<number> {
    this.running ??= this.doRun().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async doRun(): Promise<number> {
    let fixed = 0;
    const openOrders = new Set(this.o.client.state.getOrders().map((o) => o.orderId));
    const openPositions = new Map(this.o.client.state.getPositions().map((p) => [p.positionId, p]));

    for (const t of [...this.o.trades.list({ status: 'pending', limit: 500 }), ...this.o.trades.list({ status: 'unconfirmed', limit: 500 })]) {
      if (t.orderId === null) continue;
      if (openOrders.has(t.orderId)) {
        if (t.status === 'unconfirmed') {
          this.o.trades.update(t.id, { status: 'pending' });
          fixed++;
        }
        continue;
      }
      try {
        const res = await this.o.client.callAccount(PT.ORDER_DETAILS_REQ, { orderId: t.orderId }, PT.ORDER_DETAILS_RES, OrderDetailsResSchema);
        const status = res.order.orderStatus;
        if (status === OrderStatus.FILLED && res.deal.length > 0) {
          const first = [...res.deal].sort((a, b) => a.executionTimestamp - b.executionTimestamp)[0]!;
          this.o.trades.update(t.id, {
            status: 'open',
            positionId: first.positionId,
            entry: first.executionPrice,
            openedAt: new Date(first.executionTimestamp).toISOString(),
            pnl: first.commission !== undefined ? moneyFromProto(first.commission, first.moneyDigits) : undefined,
          });
          fixed++;
        } else if (status === OrderStatus.CANCELLED || status === OrderStatus.EXPIRED || status === OrderStatus.REJECTED) {
          const map = { [OrderStatus.CANCELLED]: 'cancelled', [OrderStatus.EXPIRED]: 'expired', [OrderStatus.REJECTED]: 'rejected' } as const;
          this.o.trades.update(t.id, { status: map[status], closedAt: new Date(res.order.utcLastUpdateTimestamp ?? this.now()).toISOString() });
          fixed++;
        }
      } catch (err) {
        this.log.warn({ tradeId: t.id, orderId: t.orderId, err: (err as Error).message }, 'could not reconcile pending trade');
      }
    }

    for (const t of this.o.trades.list({ status: 'open', limit: 500 })) {
      if (t.positionId === null) continue;
      const live = openPositions.get(t.positionId);
      if (live) {
        // keep SL/TP current (e.g. changed from the cTrader app)
        if (live.stopLoss !== undefined && live.stopLoss !== t.stopLoss) {
          this.o.trades.update(t.id, { stopLoss: live.stopLoss, takeProfit: live.takeProfit });
          fixed++;
        }
        continue;
      }
      try {
        const from = Date.parse(t.createdAt) - 86_400_000;
        const res = await this.o.client.callAccount(
          PT.DEAL_LIST_BY_POSITION_ID_REQ,
          { positionId: t.positionId, fromTimestamp: from, toTimestamp: this.now() },
          PT.DEAL_LIST_BY_POSITION_ID_RES,
          DealListResSchema,
        );
        const closes = res.deal.filter((d) => d.closePositionDetail).sort((a, b) => a.executionTimestamp - b.executionTimestamp);
        if (closes.length === 0) continue;
        const last = closes.at(-1)!;
        const pnl = realizedFromDeals(res.deal);
        this.o.trades.update(t.id, {
          status: 'closed',
          pnl,
          rMultiple: t.riskAmount > 0 ? Math.round((pnl / t.riskAmount) * 100) / 100 : undefined,
          exitPrice: last.executionPrice,
          closedAt: new Date(last.executionTimestamp).toISOString(),
          closeReason: t.closeReason ?? inferCloseReason(t, last.executionPrice, this.pipPosition(last)),
        });
        fixed++;
      } catch (err) {
        this.log.warn({ tradeId: t.id, positionId: t.positionId, err: (err as Error).message }, 'could not reconcile open trade');
      }
    }
    if (fixed > 0) this.log.info({ fixed }, 'journal reconciled with broker history');
    return fixed;
  }

  private pipPosition(d: Deal): number | undefined {
    return this.o.symbols.cached(d.symbolId)?.pipPosition;
  }
}

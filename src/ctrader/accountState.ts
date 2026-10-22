import { OrderStatus, PositionStatus } from './payloadTypes.js';
import type { ExecutionEvent, Order, Position, ReconcileRes } from './schemas.js';

/**
 * In-memory view of open positions and pending orders. Execution events keep
 * it current; a full ProtoOAReconcileRes replaces it (on connect and every 5 min)
 * so any missed event is corrected.
 */
export class AccountState {
  private readonly positions = new Map<number, Position>();
  private readonly orders = new Map<number, Order>();
  lastReconcileAt: number | undefined;

  applyReconcile(res: ReconcileRes, now = Date.now()): { positionsChanged: number; ordersChanged: number } {
    const before = { p: snapshot(this.positions), o: snapshot(this.orders) };
    this.positions.clear();
    this.orders.clear();
    for (const p of res.position) this.positions.set(p.positionId, p);
    for (const o of res.order) this.orders.set(o.orderId, o);
    this.lastReconcileAt = now;
    return {
      positionsChanged: diffCount(before.p, snapshot(this.positions)),
      ordersChanged: diffCount(before.o, snapshot(this.orders)),
    };
  }

  applyExecution(ev: ExecutionEvent): void {
    if (ev.position) {
      if (ev.position.positionStatus === PositionStatus.OPEN) this.positions.set(ev.position.positionId, ev.position);
      else if (ev.position.positionStatus === PositionStatus.CLOSED) this.positions.delete(ev.position.positionId);
    }
    if (ev.order) {
      // Only pending (accepted, non-closing, non-market-fill) orders are kept.
      if (ev.order.orderStatus === OrderStatus.ACCEPTED && !ev.order.closingOrder && isPendingType(ev.order)) {
        this.orders.set(ev.order.orderId, ev.order);
      } else {
        this.orders.delete(ev.order.orderId);
      }
    }
  }

  getPositions(): Position[] {
    return [...this.positions.values()];
  }

  getOrders(): Order[] {
    return [...this.orders.values()];
  }

  getPosition(id: number): Position | undefined {
    return this.positions.get(id);
  }

  getOrder(id: number): Order | undefined {
    return this.orders.get(id);
  }
}

function isPendingType(o: Order): boolean {
  // MARKET (1) and MARKET_RANGE (5) orders never rest on the book.
  return o.orderType !== 1 && o.orderType !== 5;
}

function snapshot<T>(m: Map<number, T>): Map<number, string> {
  return new Map([...m].map(([k, v]) => [k, JSON.stringify(v)]));
}

function diffCount(a: Map<number, string>, b: Map<number, string>): number {
  let n = 0;
  for (const [k, v] of a) if (b.get(k) !== v) n++;
  for (const k of b.keys()) if (!a.has(k)) n++;
  return n;
}

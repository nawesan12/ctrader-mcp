import type { DB } from '../db/database.js';
import { moneyFromProto, pipSize } from '../ctrader/normalize.js';
import { ExecutionType, PositionStatus } from '../ctrader/payloadTypes.js';
import type { Deal, ExecutionEvent } from '../ctrader/schemas.js';

export type TradeStatus = 'submitted' | 'pending' | 'open' | 'closed' | 'cancelled' | 'expired' | 'rejected' | 'unconfirmed';

export interface Trade {
  id: number;
  idempotencyKey: string | null;
  orderId: number | null;
  positionId: number | null;
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: 'LIMIT' | 'MARKET';
  status: TradeStatus;
  entryPlanned: number | null;
  entry: number | null;
  stopLoss: number;
  takeProfit: number;
  initialStopLoss: number;
  units: number;
  riskAmount: number;
  depositCurrency: string;
  thesis: string;
  setup: string | null;
  killzone: string | null;
  label: string | null;
  createdAt: string;
  openedAt: string | null;
  closedAt: string | null;
  exitPrice: number | null;
  pnl: number | null;
  rMultiple: number | null;
  closeReason: string | null;
  rejectReason: string | null;
}

export type NewTrade = Pick<
  Trade,
  'idempotencyKey' | 'symbol' | 'side' | 'orderType' | 'entryPlanned' | 'stopLoss' | 'takeProfit' | 'units' | 'riskAmount' | 'depositCurrency' | 'thesis' | 'setup' | 'killzone' | 'label'
>;

const COLS: Record<keyof Trade, string> = {
  id: 'id',
  idempotencyKey: 'idempotency_key',
  orderId: 'order_id',
  positionId: 'position_id',
  symbol: 'symbol',
  side: 'side',
  orderType: 'order_type',
  status: 'status',
  entryPlanned: 'entry_planned',
  entry: 'entry',
  stopLoss: 'stop_loss',
  takeProfit: 'take_profit',
  initialStopLoss: 'initial_stop_loss',
  units: 'units',
  riskAmount: 'risk_amount',
  depositCurrency: 'deposit_currency',
  thesis: 'thesis',
  setup: 'setup',
  killzone: 'killzone',
  label: 'label',
  createdAt: 'created_at',
  openedAt: 'opened_at',
  closedAt: 'closed_at',
  exitPrice: 'exit_price',
  pnl: 'pnl',
  rMultiple: 'r_multiple',
  closeReason: 'close_reason',
  rejectReason: 'reject_reason',
};
const SELECT = `SELECT ${Object.entries(COLS)
  .map(([k, c]) => `${c} AS ${k}`)
  .join(', ')} FROM trades`;

export interface SymbolLookup {
  (symbolId: number): { key: string; pipPosition: number } | undefined;
}

/** Trade journal: one row per order sent through the MCP tools. */
export class TradeStore {
  /** Close reasons supplied by close_position, consumed when the close is confirmed. */
  private readonly pendingCloseReasons = new Map<number, string>();

  constructor(
    private readonly db: DB,
    private readonly now: () => number = Date.now,
  ) {}

  insert(t: NewTrade): number {
    const r = this.db
      .prepare(
        `INSERT INTO trades (idempotency_key, symbol, side, order_type, status, entry_planned, stop_loss, take_profit, initial_stop_loss,
           units, risk_amount, deposit_currency, thesis, setup, killzone, label, created_at)
         VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.idempotencyKey, t.symbol, t.side, t.orderType, t.entryPlanned, t.stopLoss, t.takeProfit, t.stopLoss,
        t.units, t.riskAmount, t.depositCurrency, t.thesis, t.setup, t.killzone, t.label, new Date(this.now()).toISOString(),
      );
    return Number(r.lastInsertRowid);
  }

  update(id: number, patch: Partial<Omit<Trade, 'id'>>): void {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as Array<[keyof Trade, unknown]>;
    if (entries.length === 0) return;
    const sql = `UPDATE trades SET ${entries.map(([k]) => `${COLS[k]} = ?`).join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...entries.map(([, v]) => v), id);
  }

  get(id: number): Trade | undefined {
    return this.db.prepare(`${SELECT} WHERE id = ?`).get(id) as Trade | undefined;
  }

  byOrder(orderId: number): Trade | undefined {
    return this.db.prepare(`${SELECT} WHERE order_id = ? ORDER BY id DESC LIMIT 1`).get(orderId) as Trade | undefined;
  }

  byPosition(positionId: number): Trade | undefined {
    return this.db.prepare(`${SELECT} WHERE position_id = ? ORDER BY id DESC LIMIT 1`).get(positionId) as Trade | undefined;
  }

  list(filter: { since?: string; until?: string; symbol?: string; status?: TradeStatus; limit?: number } = {}): Trade[] {
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      where.push(clause);
      args.push(value);
    };
    if (filter.since) add('created_at >= ?', filter.since);
    if (filter.until) add('created_at < ?', filter.until);
    if (filter.symbol) add('symbol = ?', filter.symbol);
    if (filter.status) add('status = ?', filter.status);
    const sql = `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, filter.limit ?? 200) as Trade[];
  }

  setCloseReason(positionId: number, reason: string): void {
    this.pendingCloseReasons.set(positionId, reason);
  }

  /** Keep rows in sync with broker executions (fills, cancels, expiries, closes). */
  onExecution(ev: ExecutionEvent, lookup: SymbolLookup): void {
    const at = new Date(this.now()).toISOString();
    const order = ev.order;
    const position = ev.position;

    if (order && !order.closingOrder) {
      const t = this.byOrder(order.orderId);
      if (t) {
        if (ev.executionType === ExecutionType.ORDER_FILLED || ev.executionType === ExecutionType.ORDER_PARTIAL_FILL) {
          if (t.status !== 'open' && t.status !== 'closed') {
            this.update(t.id, {
              status: 'open',
              positionId: position?.positionId ?? order.positionId ?? t.positionId ?? undefined,
              entry: position?.price ?? order.executionPrice ?? t.entry ?? undefined,
              units: position ? position.tradeData.volume / 100 : t.units,
              openedAt: at,
              pnl: ev.deal ? openingCommission(ev.deal) : undefined,
            });
          }
        } else if (ev.executionType === ExecutionType.ORDER_CANCELLED && t.status === 'pending') {
          this.update(t.id, { status: 'cancelled', closedAt: at });
        } else if (ev.executionType === ExecutionType.ORDER_EXPIRED && t.status === 'pending') {
          this.update(t.id, { status: 'expired', closedAt: at });
        } else if (ev.executionType === ExecutionType.ORDER_REPLACED && t.status === 'pending') {
          this.update(t.id, {
            entryPlanned: order.limitPrice ?? undefined,
            stopLoss: order.stopLoss ?? undefined,
            takeProfit: order.takeProfit ?? undefined,
            units: order.tradeData.volume / 100,
          });
        }
      }
    }

    if (position) {
      const t = this.byPosition(position.positionId);
      if (!t) return;
      if (ev.executionType === ExecutionType.ORDER_REPLACED && position.positionStatus === PositionStatus.OPEN) {
        this.update(t.id, { stopLoss: position.stopLoss ?? undefined, takeProfit: position.takeProfit ?? undefined });
      }
      const closing = ev.deal?.closePositionDetail;
      if (ev.deal && closing && (ev.executionType === ExecutionType.ORDER_FILLED || ev.executionType === ExecutionType.ORDER_PARTIAL_FILL)) {
        const realized =
          moneyFromProto(closing.grossProfit + closing.swap + closing.commission + (closing.pnlConversionFee ?? 0), closing.moneyDigits ?? ev.deal.moneyDigits);
        const pnl = (t.pnl ?? 0) + realized;
        const fullyClosed = position.positionStatus === PositionStatus.CLOSED;
        const exit = ev.deal.executionPrice;
        const sym = lookup(position.tradeData.symbolId);
        this.update(t.id, {
          pnl,
          rMultiple: t.riskAmount > 0 ? round(pnl / t.riskAmount, 2) : undefined,
          ...(fullyClosed
            ? {
                status: 'closed' as const,
                closedAt: at,
                exitPrice: exit,
                closeReason: this.pendingCloseReasons.get(position.positionId) ?? inferCloseReason(t, exit, sym?.pipPosition),
              }
            : {}),
        });
        if (fullyClosed) this.pendingCloseReasons.delete(position.positionId);
      }
    }
  }
}

function openingCommission(d: Deal): number | undefined {
  return d.commission !== undefined ? moneyFromProto(d.commission, d.moneyDigits) : undefined;
}

function inferCloseReason(t: Trade, exit: number | undefined, pipPosition: number | undefined): string {
  if (exit === undefined || pipPosition === undefined) return 'external';
  const tol = pipSize(pipPosition);
  if (Math.abs(exit - t.stopLoss) <= tol) return t.stopLoss === t.initialStopLoss ? 'stop_loss' : 'trailing_or_breakeven_stop';
  if (Math.abs(exit - t.takeProfit) <= tol) return 'take_profit';
  return 'external';
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

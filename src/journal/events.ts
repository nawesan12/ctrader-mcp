import type { DB } from '../db/database.js';

/** Audit trail: every request, rejection and execution is appended here. */
export type EventKind =
  | 'risk_preview'
  | 'risk_rejected'
  | 'order_request'
  | 'order_rejected'
  | 'execution'
  | 'amend_request'
  | 'close_request'
  | 'cancel_request';

export interface EventRow {
  id: number;
  ts: string;
  kind: EventKind;
  symbol: string | null;
  idempotencyKey: string | null;
  data: unknown;
}

export class EventLog {
  private readonly insert;

  constructor(private readonly db: DB) {
    this.insert = db.prepare('INSERT INTO events (ts, kind, symbol, idempotency_key, data) VALUES (?, ?, ?, ?, ?)');
  }

  record(kind: EventKind, data: unknown, opts: { symbol?: string | undefined; idempotencyKey?: string | undefined; at?: Date } = {}): number {
    const r = this.insert.run((opts.at ?? new Date()).toISOString(), kind, opts.symbol ?? null, opts.idempotencyKey ?? null, JSON.stringify(data));
    return Number(r.lastInsertRowid);
  }

  list(filter: { kind?: EventKind; since?: Date; limit?: number } = {}): EventRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.kind) {
      where.push('kind = ?');
      args.push(filter.kind);
    }
    if (filter.since) {
      where.push('ts >= ?');
      args.push(filter.since.toISOString());
    }
    const sql = `SELECT id, ts, kind, symbol, idempotency_key AS idempotencyKey, data FROM events
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, filter.limit ?? 100) as Array<Omit<EventRow, 'data'> & { data: string }>;
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) as unknown }));
  }
}

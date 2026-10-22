import type { DB } from '../db/database.js';
import { zonedDayKey } from '../time.js';

export interface DailyStat {
  day: string;
  startBalance: number | null;
  endBalance: number | null;
  tradesOpened: number;
  tradesClosed: number;
  wins: number;
  losses: number;
  pnl: number;
  rSum: number;
  rejections: number;
}

/**
 * One row per NY trading day. Balances come from account snapshots (first
 * snapshot of the day = start, latest = end); the rest is rebuilt from the
 * trades and events tables so it can always be recomputed from the journal.
 */
export class DailyStats {
  constructor(
    private readonly db: DB,
    private readonly tz: string,
    private readonly now: () => number = Date.now,
  ) {}

  recordBalance(balance: number, at = this.now()): void {
    const day = zonedDayKey(at, this.tz);
    this.db
      .prepare(
        `INSERT INTO daily_stats (day, start_balance, end_balance, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET start_balance = COALESCE(daily_stats.start_balance, excluded.start_balance),
           end_balance = excluded.end_balance, updated_at = excluded.updated_at`,
      )
      .run(day, balance, balance, new Date(at).toISOString());
  }

  /** Recompute trade counters for every day present in the journal. */
  rebuild(): void {
    type Row = { opened_at: string | null; closed_at: string | null; status: string; pnl: number | null; r_multiple: number | null };
    const trades = this.db.prepare('SELECT opened_at, closed_at, status, pnl, r_multiple FROM trades').all() as Row[];
    const rejections = this.db.prepare("SELECT ts FROM events WHERE kind IN ('risk_rejected', 'order_rejected')").all() as Array<{ ts: string }>;
    const agg = new Map<string, Omit<DailyStat, 'day' | 'startBalance' | 'endBalance'>>();
    const get = (day: string) => {
      let a = agg.get(day);
      if (!a) {
        a = { tradesOpened: 0, tradesClosed: 0, wins: 0, losses: 0, pnl: 0, rSum: 0, rejections: 0 };
        agg.set(day, a);
      }
      return a;
    };
    for (const t of trades) {
      if (t.opened_at) get(zonedDayKey(Date.parse(t.opened_at), this.tz)).tradesOpened++;
      if (t.status === 'closed' && t.closed_at && t.pnl !== null) {
        const a = get(zonedDayKey(Date.parse(t.closed_at), this.tz));
        a.tradesClosed++;
        a.pnl += t.pnl;
        a.rSum += t.r_multiple ?? 0;
        if (t.pnl > 0) a.wins++;
        else a.losses++;
      }
    }
    for (const e of rejections) get(zonedDayKey(Date.parse(e.ts), this.tz)).rejections++;

    const upsert = this.db.prepare(
      `INSERT INTO daily_stats (day, trades_opened, trades_closed, wins, losses, pnl, r_sum, rejections, updated_at)
       VALUES (@day, @tradesOpened, @tradesClosed, @wins, @losses, @pnl, @rSum, @rejections, @updatedAt)
       ON CONFLICT(day) DO UPDATE SET trades_opened = excluded.trades_opened, trades_closed = excluded.trades_closed,
         wins = excluded.wins, losses = excluded.losses, pnl = excluded.pnl, r_sum = excluded.r_sum,
         rejections = excluded.rejections, updated_at = excluded.updated_at`,
    );
    const updatedAt = new Date(this.now()).toISOString();
    this.db.transaction(() => {
      for (const [day, a] of agg) upsert.run({ day, ...a, pnl: round2(a.pnl), rSum: round2(a.rSum), updatedAt });
    })();
  }

  list(sinceDay?: string, limit = 60): DailyStat[] {
    return this.db
      .prepare(
        `SELECT day, start_balance AS startBalance, end_balance AS endBalance, trades_opened AS tradesOpened, trades_closed AS tradesClosed,
           wins, losses, pnl, r_sum AS rSum, rejections FROM daily_stats WHERE day >= ? ORDER BY day DESC LIMIT ?`,
      )
      .all(sinceDay ?? '0000-00-00', limit) as DailyStat[];
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100;

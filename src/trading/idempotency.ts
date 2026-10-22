import { createHash } from 'node:crypto';
import type { DB } from '../db/database.js';

export const IDEMPOTENCY_WINDOW_MS = 10 * 60_000;

export class IdempotencyConflictError extends Error {
  override name = 'IdempotencyConflictError';
}

export type Claim<T> = { kind: 'new' } | { kind: 'duplicate'; result: T } | { kind: 'in_progress' };

/**
 * Remembers state-changing requests by key for 10 minutes. A repeated key with
 * the same request returns the stored result instead of acting twice; the same
 * key with a different request is an error. Results survive restarts.
 */
export class IdempotencyStore {
  constructor(
    private readonly db: DB,
    private readonly now: () => number = Date.now,
  ) {}

  static hash(tool: string, request: unknown): string {
    return createHash('sha256').update(tool).update('\0').update(stableStringify(request)).digest('hex');
  }

  claim<T>(key: string, tool: string, request: unknown): Claim<T> {
    const hash = IdempotencyStore.hash(tool, request);
    const now = this.now();
    return this.db.transaction((): Claim<T> => {
      const row = this.db.prepare('SELECT tool, request_hash, status, result, created_at FROM idempotency WHERE key = ?').get(key) as
        | { tool: string; request_hash: string; status: 'pending' | 'done'; result: string | null; created_at: number }
        | undefined;
      if (row && now - row.created_at < IDEMPOTENCY_WINDOW_MS) {
        if (row.tool !== tool || row.request_hash !== hash) {
          throw new IdempotencyConflictError(`idempotencyKey "${key}" was already used for a different request (${row.tool}) in the last 10 minutes`);
        }
        if (row.status === 'pending') return { kind: 'in_progress' };
        return { kind: 'duplicate', result: JSON.parse(row.result ?? 'null') as T };
      }
      this.db
        .prepare(
          `INSERT INTO idempotency (key, tool, request_hash, status, result, created_at) VALUES (?, ?, ?, 'pending', NULL, ?)
           ON CONFLICT(key) DO UPDATE SET tool = excluded.tool, request_hash = excluded.request_hash, status = 'pending', result = NULL, created_at = excluded.created_at`,
        )
        .run(key, tool, hash, now);
      return { kind: 'new' };
    })();
  }

  complete(key: string, result: unknown): void {
    this.db.prepare("UPDATE idempotency SET status = 'done', result = ? WHERE key = ?").run(JSON.stringify(result), key);
  }

  /** Forget a claim whose request never reached the broker, so it can be retried. */
  release(key: string): void {
    this.db.prepare("DELETE FROM idempotency WHERE key = ? AND status = 'pending'").run(key);
  }

  purgeExpired(): number {
    return this.db.prepare('DELETE FROM idempotency WHERE created_at < ?').run(this.now() - IDEMPOTENCY_WINDOW_MS).changes;
  }
}

/** JSON with sorted keys, so logically equal requests hash the same. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x)}`).join(',')}}`;
}

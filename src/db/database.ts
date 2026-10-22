import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

/** Migrations are append-only: never edit an applied entry, add a new one. */
const MIGRATIONS: string[] = [
  `CREATE TABLE tokens (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     salt BLOB NOT NULL,
     iv BLOB NOT NULL,
     tag BLOB NOT NULL,
     ciphertext BLOB NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE symbols (
     symbol_id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     data TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE assets (
     asset_id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     data TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  `CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL,
     kind TEXT NOT NULL,
     symbol TEXT,
     idempotency_key TEXT,
     data TEXT NOT NULL
   );
   CREATE INDEX events_ts ON events (ts);
   CREATE INDEX events_kind_ts ON events (kind, ts);`,
  `CREATE TABLE idempotency (
     key TEXT PRIMARY KEY,
     tool TEXT NOT NULL,
     request_hash TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending', 'done')),
     result TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE trades (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     idempotency_key TEXT UNIQUE,
     order_id INTEGER,
     position_id INTEGER,
     symbol TEXT NOT NULL,
     side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
     order_type TEXT NOT NULL CHECK (order_type IN ('LIMIT', 'MARKET')),
     status TEXT NOT NULL CHECK (status IN ('submitted', 'pending', 'open', 'closed', 'cancelled', 'expired', 'rejected', 'unconfirmed')),
     entry_planned REAL,
     entry REAL,
     stop_loss REAL NOT NULL,
     take_profit REAL NOT NULL,
     initial_stop_loss REAL NOT NULL,
     units REAL NOT NULL,
     risk_amount REAL NOT NULL,
     deposit_currency TEXT NOT NULL,
     thesis TEXT NOT NULL,
     setup TEXT,
     killzone TEXT,
     label TEXT,
     created_at TEXT NOT NULL,
     opened_at TEXT,
     closed_at TEXT,
     exit_price REAL,
     pnl REAL,
     r_multiple REAL,
     close_reason TEXT,
     reject_reason TEXT
   );
   CREATE INDEX trades_order ON trades (order_id);
   CREATE INDEX trades_position ON trades (position_id);
   CREATE INDEX trades_created ON trades (created_at);`,
  `CREATE TABLE daily_stats (
     day TEXT PRIMARY KEY,
     start_balance REAL,
     end_balance REAL,
     trades_opened INTEGER NOT NULL DEFAULT 0,
     trades_closed INTEGER NOT NULL DEFAULT 0,
     wins INTEGER NOT NULL DEFAULT 0,
     losses INTEGER NOT NULL DEFAULT 0,
     pnl REAL NOT NULL DEFAULT 0,
     r_sum REAL NOT NULL DEFAULT 0,
     rejections INTEGER NOT NULL DEFAULT 0,
     updated_at TEXT NOT NULL
   );`,
  `CREATE TABLE oauth_clients (
     client_id TEXT PRIMARY KEY,
     data TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER
   );
   CREATE TABLE oauth_pending (
     id_hash TEXT PRIMARY KEY,
     client_id TEXT NOT NULL,
     params TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE oauth_codes (
     code_hash TEXT PRIMARY KEY,
     client_id TEXT NOT NULL,
     code_challenge TEXT NOT NULL,
     redirect_uri TEXT NOT NULL,
     resource TEXT,
     scopes TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE oauth_tokens (
     token_hash TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
     client_id TEXT NOT NULL,
     scopes TEXT NOT NULL,
     resource TEXT,
     expires_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX oauth_tokens_client ON oauth_tokens (client_id);`,
];

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

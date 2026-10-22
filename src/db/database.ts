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

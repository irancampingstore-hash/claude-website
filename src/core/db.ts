import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { decrypt, encrypt } from "./crypto.js";

export type Row = Record<string, unknown>;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  grants TEXT NOT NULL DEFAULT '{}',
  api_key_hash TEXT,
  api_key_prefix TEXT,
  password_hash TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_prefix ON users(api_key_prefix);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id TEXT,
  client TEXT,
  tool TEXT NOT NULL,
  connector TEXT,
  outcome TEXT NOT NULL,
  duration_ms INTEGER,
  args TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  author TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  info TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ig_scheduled (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  run_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_by TEXT,
  result TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ig_sched_due ON ig_scheduled(status, run_at);

CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inbox_status ON inbox(status, ts);
`;

export class Db {
  readonly raw: DatabaseSync;

  constructor(dataDirOrPath: string, private readonly secret: string) {
    const path = dataDirOrPath === ":memory:" ? ":memory:" : join(dataDirOrPath, "hub.sqlite");
    this.raw = new DatabaseSync(path);
    this.raw.exec(SCHEMA);
  }

  run(sql: string, ...params: Array<string | number | null | bigint>): void {
    this.raw.prepare(sql).run(...params);
  }

  get<T = Row>(sql: string, ...params: Array<string | number | null | bigint>): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: Array<string | number | null | bigint>): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  setSecret(key: string, value: string): void {
    this.run(
      "INSERT INTO secrets(key, value, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
      key,
      encrypt(this.secret, value),
      Date.now(),
    );
  }

  getSecret(key: string): string | undefined {
    const row = this.get<{ value: string }>("SELECT value FROM secrets WHERE key = ?", key);
    if (!row) return undefined;
    try {
      return decrypt(this.secret, row.value);
    } catch {
      return undefined;
    }
  }

  deleteSecret(key: string): void {
    this.run("DELETE FROM secrets WHERE key = ?", key);
  }

  listSecretKeys(prefix: string): string[] {
    return this.all<{ key: string }>("SELECT key FROM secrets WHERE key LIKE ? ORDER BY key", `${prefix}%`).map((r) => r.key);
  }

  close(): void {
    this.raw.close();
  }
}

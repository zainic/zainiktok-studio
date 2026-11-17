import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export function createStore(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'studio.sqlite'));
  db.pragma('busy_timeout = 5000');
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, filename TEXT NOT NULL,
      mime TEXT NOT NULL, size INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'upload', source_url TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY, video_id TEXT NOT NULL REFERENCES videos(id),
      title TEXT NOT NULL, caption TEXT NOT NULL DEFAULT '',
      scheduled_at INTEGER NOT NULL, privacy TEXT NOT NULL DEFAULT 'SELF_ONLY',
      disable_comment INTEGER NOT NULL DEFAULT 0,
      disable_duet INTEGER NOT NULL DEFAULT 0,
      disable_stitch INTEGER NOT NULL DEFAULT 0,
      brand_content INTEGER NOT NULL DEFAULT 0,
      brand_organic INTEGER NOT NULL DEFAULT 0,
      is_aigc INTEGER NOT NULL DEFAULT 0,
      consent INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'scheduled',
      publish_id TEXT, last_status_at INTEGER,
      error TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS posts_due ON posts(status,scheduled_at);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS account (
      id INTEGER PRIMARY KEY CHECK (id=1), open_id TEXT NOT NULL,
      scopes TEXT NOT NULL, token_blob TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
  `);
  const q = (sql, ...args) => db.prepare(sql).all(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  return { db, q, one, run,
    getSetting(key, otherwise='') { return one('SELECT value FROM settings WHERE key=?',key)?.value ?? otherwise; },
    setSetting(key,value) { run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,value); }
  };
}

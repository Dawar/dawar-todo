import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export class Store {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS bots(id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, thread_id TEXT UNIQUE, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, id TEXT NOT NULL, bot_id TEXT, json TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS records_bot ON records(kind,bot_id);
      CREATE UNIQUE INDEX IF NOT EXISTS manager_thread_mapping
        ON records(json_extract(json, '$.threadId')) WHERE kind='managerWorker';
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, json TEXT NOT NULL);`);
  }
  bots() {
    return this.db
      .prepare("SELECT json FROM bots")
      .all()
      .map((r) => JSON.parse(r.json));
  }
  bot(id) {
    const row = this.db.prepare("SELECT json FROM bots WHERE id=?").get(id);
    if (!row) throw new Error("Bot not found.");
    return JSON.parse(row.json);
  }
  saveBot(bot) {
    this.db
      .prepare(
        "INSERT INTO bots VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET slug=excluded.slug,thread_id=excluded.thread_id,json=excluded.json",
      )
      .run(bot.id, bot.slug, bot.threadId, JSON.stringify(bot));
    return bot;
  }
  get(kind, id) {
    const row = this.db
      .prepare("SELECT json FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? JSON.parse(row.json) : null;
  }
  list(kind, botId) {
    return (
      botId
        ? this.db
            .prepare("SELECT json FROM records WHERE kind=? AND bot_id=?")
            .all(kind, botId)
        : this.db.prepare("SELECT json FROM records WHERE kind=?").all(kind)
    ).map((r) => JSON.parse(r.json));
  }
  put(kind, record) {
    this.db
      .prepare(
        "INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET bot_id=excluded.bot_id,json=excluded.json",
      )
      .run(kind, record.id, record.botId ?? null, JSON.stringify(record));
    return record;
  }
  remove(kind, id) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
  }
  meta(key, value) {
    if (value !== undefined)
      this.db
        .prepare("INSERT OR REPLACE INTO meta VALUES(?,?)")
        .run(key, JSON.stringify(value));
    const row = this.db.prepare("SELECT json FROM meta WHERE key=?").get(key);
    return row ? JSON.parse(row.json) : null;
  }
  operation(id) {
    const r = this.db.prepare("SELECT * FROM operations WHERE id=?").get(id);
    return r
      ? {
          ...JSON.parse(r.json),
          id: r.id,
          fingerprint: r.fingerprint,
          status: r.status,
        }
      : null;
  }
  saveOperation(id, fingerprint, status, data) {
    this.db
      .prepare(
        "INSERT INTO operations VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,json=excluded.json",
      )
      .run(id, fingerprint, status, JSON.stringify(data));
  }
  uncertainOperations() {
    return this.db
      .prepare(
        "SELECT * FROM operations WHERE status IN ('dispatching','uncertain')",
      )
      .all()
      .map((r) => ({
        ...JSON.parse(r.json),
        id: r.id,
        fingerprint: r.fingerprint,
        status: r.status,
      }));
  }
  event(event) {
    const result = this.db
      .prepare("INSERT INTO events(json) VALUES(?)")
      .run(JSON.stringify(event));
    const seq = Number(result.lastInsertRowid);
    if (seq % 1000 === 0)
      this.db.prepare("DELETE FROM events WHERE seq < ?").run(seq - 10000);
    return { seq, ...event };
  }
  cursor() {
    return Number(
      this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events").get()
        .seq,
    );
  }
  replay(after) {
    return this.db
      .prepare(
        "SELECT seq,json FROM events WHERE seq>? ORDER BY seq LIMIT 10000",
      )
      .all(after)
      .map((r) => ({ seq: Number(r.seq), ...JSON.parse(r.json) }));
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}

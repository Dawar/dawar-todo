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
      CREATE INDEX IF NOT EXISTS history_attachment_path ON records(bot_id,json_extract(json,'$.path'),id)
        WHERE kind='attachment' AND json_extract(json,'$.ready')=1;
      CREATE INDEX IF NOT EXISTS history_attachment_item ON records(bot_id,json_extract(json,'$.provenance.turnId'),json_extract(json,'$.provenance.itemId'),COALESCE(json_extract(json,'$.provenance.threadId'),''),id)
        WHERE kind='attachment' AND json_extract(json,'$.ready')=1 AND json_extract(json,'$.artifact')=1;
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
  unconfirmedSettings(botId, since) {
    // Older bridges used status=failed for some transport/local exceptions;
    // only a proven rejected outcome makes those settings safe to supersede.
    return Boolean(this.db.prepare(`SELECT 1 FROM operations
      WHERE status <> 'done' AND COALESCE(json_extract(json,'$.outcome'),'uncertain') <> 'rejected'
      AND json_extract(json,'$.method')='bots.update' AND json_extract(json,'$.botId')=?
      AND json_extract(json,'$.createdAt')>=?
      AND (json_type(json,'$.params.mode') IS NOT NULL OR json_type(json,'$.params.model') IS NOT NULL
        OR json_type(json,'$.params.effort') IS NOT NULL OR json_type(json,'$.params.serviceTier') IS NOT NULL)
      LIMIT 1`).get(botId, since));
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
    const depth = this.transactionDepth ?? 0;
    const mark = this.commitCallbacks?.length ?? 0;
    this.commitCallbacks ??= [];
    this.db.exec(depth ? `SAVEPOINT nested_${depth}` : "BEGIN IMMEDIATE");
    this.transactionDepth = depth + 1;
    let result;
    try {
      result = fn();
      if (result && typeof result.then === "function")
        throw new Error("Store transactions must be synchronous.");
      this.db.exec(depth ? `RELEASE nested_${depth}` : "COMMIT");
    } catch (e) {
      this.db.exec(depth ? `ROLLBACK TO nested_${depth}; RELEASE nested_${depth}` : "ROLLBACK");
      this.commitCallbacks.length = mark;
      throw e;
    } finally {
      this.transactionDepth = depth;
    }
    // Publication happens only after the durable commit. A listener failure
    // must not attempt to roll back an already committed transaction.
    if (!depth) {
      const callbacks = this.commitCallbacks.splice(0);
      let failure;
      for (const callback of callbacks) try { callback(); } catch (error) { failure ??= error; }
      if (failure) throw failure;
    }
    return result;
  }
  afterCommit(callback) {
    if (this.transactionDepth) this.commitCallbacks.push(callback);
    else callback();
  }
  close() {
    this.db.close();
  }
}

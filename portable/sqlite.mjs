import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// The application keeps its D1 SQL and asynchronous interface. The portable
// adapter executes each batch synchronously in one local SQLite transaction.
export function privateDatabase(path) {
  path = resolve(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  return db;
}

export class LocalD1 {
  constructor(path) { this.path = resolve(path); this.sqlite = privateDatabase(path); }
  prepare(sql) { return new LocalStatement(this, sql); }
  async batch(statements) {
    if (!Array.isArray(statements) || statements.some(s => s.database !== this)) throw Error('Foreign SQLite batch.');
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(s => s.execute());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  async exec(sql) { this.sqlite.exec(sql); return { count: 0, duration: 0 }; }
  withSession() { return this; }
  getBookmark() { return null; }
  async snapshot(path) {
    await backup(this.sqlite, path);
    chmodSync(path, 0o600);
    return statSync(path).size;
  }
  close() { this.sqlite.close(); }
}

class LocalStatement {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values) {
    return new LocalStatement(this.database, this.sql, values.map(v => v instanceof ArrayBuffer ? new Uint8Array(v) : v));
  }
  execute() {
    const statement = this.database.sqlite.prepare(this.sql);
    const before = this.database.sqlite.prepare('SELECT total_changes() AS n').get().n;
    const results = statement.columns().length ? statement.all(...this.values) : (statement.run(...this.values), []);
    const after = this.database.sqlite.prepare('SELECT total_changes() AS n, last_insert_rowid() AS id').get();
    return { results, success: true, meta: { changes: after.n - before, last_row_id: after.id, duration: 0 } };
  }
  async first(column) {
    const row = this.database.sqlite.prepare(this.sql).get(...this.values) ?? null;
    if (column && row && !Object.hasOwn(row, column)) throw Error('Unknown SQLite result column.');
    return column && row ? row[column] : row;
  }
  async all() { return this.execute(); }
  async run() { return this.execute(); }
  async raw(options) {
    const statement = this.database.sqlite.prepare(this.sql); statement.setReturnArrays(true);
    const rows = statement.all(...this.values);
    return options?.columnNames ? [statement.columns().map(c => c.name), ...rows] : rows;
  }
}

import { DatabaseSync, backup, constants as sql } from 'node:sqlite';
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
  constructor(path,{writer=null}={}) {
    this.path=resolve(path);this.sqlite=privateDatabase(path);this.writer=writer;
    this.permitWrite=false;this.executionDepth=0;this.managedTransaction=false;this.needsWrite=false;
    if(writer){
      if(typeof this.sqlite.setAuthorizer!=='function'){this.sqlite.close();throw Error('Fenced application SQLite requires Node 24.10 or newer in the Node 24 line.');}
      this.sqlite.setAuthorizer((action,a,b)=>this.authorize(action,a,b));
    }
  }
  authorize(action,a,b) {
    if([sql.SQLITE_ATTACH,sql.SQLITE_DETACH].includes(action))return sql.SQLITE_DENY;
    if([sql.SQLITE_TRANSACTION,sql.SQLITE_SAVEPOINT].includes(action))return this.managedTransaction?sql.SQLITE_OK:sql.SQLITE_DENY;
    if(action===sql.SQLITE_PRAGMA){
      const name=String(a).toLowerCase();
      if(['table_info','table_xinfo','table_list','index_list','index_info','index_xinfo','foreign_key_list','database_list','collation_list','compile_options'].includes(name))return sql.SQLITE_OK;
      if(['user_version','schema_version','application_id'].includes(name)&&b===null)return sql.SQLITE_OK;
      if(!['optimize','user_version','application_id'].includes(name))return sql.SQLITE_DENY;
    }else if([sql.SQLITE_SELECT,sql.SQLITE_READ,sql.SQLITE_FUNCTION,sql.SQLITE_RECURSIVE].includes(action))return sql.SQLITE_OK;
    if(this.permitWrite)return sql.SQLITE_OK;
    this.needsWrite=true;return sql.SQLITE_DENY;
  }
  transaction(work,{write=true}={}) {
    const command=value=>{this.managedTransaction=true;try{this.sqlite.exec(value);}finally{this.managedTransaction=false;}};
    command(write?'BEGIN IMMEDIATE':'BEGIN');
    try {const result=work();if(this.permitWrite)this.writer.assertWriter();command('COMMIT');return result;}
    catch(error){if(this.sqlite.isTransaction)command('ROLLBACK');throw error;}
  }
  protected(work) {
    if(!this.writer||this.executionDepth)return work();
    this.needsWrite=false;this.executionDepth++;
    try {
      try{return this.transaction(work,{write:false});}catch(error){if(!this.needsWrite)throw error;}
      // The authorizer rejected the mutation before any effect. Reprepare only
      // after the separate control lock and exact writer proof are acquired.
      return this.writer.runSync(()=>{this.permitWrite=true;try{return this.transaction(work);}finally{this.permitWrite=false;}});
    }finally{this.executionDepth--;this.needsWrite=false;}
  }
  prepare(sql) { return new LocalStatement(this, sql); }
  async batch(statements) {
    if (!Array.isArray(statements) || statements.some(s => s.database !== this)) throw Error('Foreign SQLite batch.');
    return this.writer?this.protected(()=>statements.map(s=>s.execute())):this.transaction(()=>statements.map(s=>s.execute()));
  }
  async exec(sql) {return this.protected(()=>{this.sqlite.exec(sql);return {count:0,duration:0};});}
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
    return this.database.protected(()=>this.executeAuthorized());
  }
  executeAuthorized() {
    const statement = this.database.sqlite.prepare(this.sql);
    const before = this.database.sqlite.prepare('SELECT total_changes() AS n').get().n;
    const results = statement.columns().length ? statement.all(...this.values) : (statement.run(...this.values), []);
    const after = this.database.sqlite.prepare('SELECT total_changes() AS n, last_insert_rowid() AS id').get();
    return { results, success: true, meta: { changes: after.n - before, last_row_id: after.id, duration: 0 } };
  }
  async first(column) {
    const row = this.database.protected(()=>this.database.sqlite.prepare(this.sql).get(...this.values) ?? null);
    if (column && row && !Object.hasOwn(row, column)) throw Error('Unknown SQLite result column.');
    return column && row ? row[column] : row;
  }
  async all() { return this.execute(); }
  async run() { return this.execute(); }
  async raw(options) {
    return this.database.protected(()=>{
      const statement=this.database.sqlite.prepare(this.sql);statement.setReturnArrays(true);
      const rows=statement.all(...this.values);
      return options?.columnNames?[statement.columns().map(c=>c.name),...rows]:rows;
    });
  }
}

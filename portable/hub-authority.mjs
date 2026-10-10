import { readPrivate } from './private-file.mjs';
import { id } from './protocol.mjs';
import { constants as sql } from 'node:sqlite';

export function controlWriteGuard(db,{writeScope,transactionScope}) {
  if(typeof db.setAuthorizer!=='function')throw Error('Fenced control SQLite requires Node 24.10+.');
  const authorize=(action,table)=>{
    if([sql.SQLITE_SELECT,sql.SQLITE_READ,sql.SQLITE_FUNCTION,sql.SQLITE_RECURSIVE].includes(action))return sql.SQLITE_OK;
    if([sql.SQLITE_TRANSACTION,sql.SQLITE_SAVEPOINT].includes(action))return transactionScope()?sql.SQLITE_OK:sql.SQLITE_DENY;
    if(action===sql.SQLITE_PRAGMA&&['table_info','table_xinfo','table_list','index_list','index_info','index_xinfo','foreign_key_list'].includes(String(table).toLowerCase()))return sql.SQLITE_OK;
    if([sql.SQLITE_INSERT,sql.SQLITE_UPDATE,sql.SQLITE_DELETE].includes(action)&&table!=='portable_authority'&&writeScope())return sql.SQLITE_OK;
    return sql.SQLITE_DENY;
  };
  // SQLite expires retained prepared statements when the authorizer is set.
  // Refresh at each transaction boundary, including failures and nested work.
  const refresh=()=>db.setAuthorizer(authorize);refresh();return refresh;
}

export function hubActivation(config) {
  if(!config.hub?.activationReceipt)return null;
  const r=JSON.parse(readPrivate(config.hub.activationReceipt,16384));
  if(r.kind!=='portable-hub-activation'||r.executionEnabled!==true||!id(r.writerId)||!Number.isSafeInteger(r.epoch)||r.epoch<1
    ||!/^[a-f0-9]{40}$/.test(r.source)||r.source!==config.hub.source)throw Error('Exact reviewed hub activation receipt required.');
  return Object.freeze(r);
}

// Separate processes share the control DB lock, never a live remote SQLite
// filesystem. Hold it only across synchronous local commits, not awaited work.
export class HubWriteAuthority {
  constructor(db,authority) {this.db=db;this.authority=authority?Object.freeze({...authority}):null;this.depth=0;this.closed=false;}
  assertWriter() {
    let r;
    try {r=this.db.prepare('SELECT writer_id,epoch,frozen FROM portable_authority WHERE id=1').get();}catch { /* Uninitialized staging has no write authority. */ }
    if(this.closed||!this.authority||!r||r.frozen!==0||r.writer_id!==this.authority.writerId||r.epoch!==this.authority.epoch)
      throw Object.assign(Error('Local writes require the exact active hub writer and an open write fence.'),{outcome:'not-sent'});
  }
  runSync(work) {
    if(this.depth){this.assertWriter();return this.synchronous(work);}
    if(this.closed||this.db.isTransaction)throw Error('Foreign or closed hub authority transaction.');
    this.refreshControlGuard?.();
    this.command('BEGIN IMMEDIATE');this.depth++;
    try {this.assertWriter();const result=this.synchronous(work);this.assertWriter();this.command('COMMIT');return result;}
    catch(error){if(this.db.isTransaction)this.command('ROLLBACK');throw error;}
    finally {this.depth--;this.refreshControlGuard?.();}
  }
  command(sql) {this.managedTransaction=true;try{this.db.exec(sql);}finally{this.managedTransaction=false;}}
  synchronous(work) {
    const result=work();
    if(result&&typeof result.then==='function')throw Error('Do not await work under the hub writer lock.');
    return result;
  }
  close() {this.closed=true;}
}

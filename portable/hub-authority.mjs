import { readPrivate } from './private-file.mjs';
import { id } from './protocol.mjs';

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
    this.db.exec('BEGIN IMMEDIATE');this.depth++;
    try {this.assertWriter();const result=this.synchronous(work);this.assertWriter();this.db.exec('COMMIT');return result;}
    catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw error;}
    finally {this.depth--;}
  }
  synchronous(work) {
    const result=work();
    if(result&&typeof result.then==='function')throw Error('Do not await work under the hub writer lock.');
    return result;
  }
  close() {this.closed=true;}
}

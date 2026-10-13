import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, readFileSync,mkdirSync,lstatSync } from 'node:fs';
import { readPrivate, savePrivate } from './private-file.mjs';
import {privateDatabase} from './sqlite.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const blocked = message => Object.assign(Error(message), { deploymentBlocked: true });
const phases = ['prepared','draining','backup-verified','stop-intent','old-process-exited','start-intent','healthy','finalized'];
const stamp = () => new Date().toISOString();
const processStart = pid => { try { const text=readFileSync(`/proc/${pid}/stat`,'utf8'); return text.slice(text.lastIndexOf(')')+2).split(' ')[19]; } catch { return null; } };

// Controller runs outside native turns. All effects have a durable intent and
// exact operation identity. Adapter reconciliation may observe completion; it
// may NEVER repeat an ambiguous stop/start, restore a DB or replay native input.
export async function runDeployment(spec, adapter, { clock=Date.now, sleep=ms=>new Promise(r=>setTimeout(r,ms)) }={}) {
  if(spec.version!==1||spec.kind!=='portable-deployment'||!/^[A-Za-z0-9:_-]{10,180}$/.test(spec.operationId??'')||
     !/^[a-f0-9]{40}$/.test(spec.source??'')||!Number.isSafeInteger(spec.waitSeconds)||spec.waitSeconds<60||spec.waitSeconds>900)
    throw blocked('Invalid exact deployment identity or bounded deadline.');
  const path=join(spec.receiptDirectory,'transaction.json');
  const fingerprint=hash(spec);
  const identity={pid:process.pid,start:processStart(process.pid),nonce:randomUUID()};
  if(!identity.start)throw blocked('Controller process identity is unavailable.');
  const directory=spec.controllerDirectory??spec.receiptDirectory;
  for(const path of [directory,spec.receiptDirectory]){
    mkdirSync(path,{recursive:true,mode:0o700});const s=lstatSync(path);
    if(!s.isDirectory()||s.isSymbolicLink()||s.mode&0o077||process.getuid&&s.uid!==process.getuid())throw blocked('Deployment directories must be private and owned by this user.');
  }
  const lockPath=join(directory,'controller.sqlite');
  if(existsSync(lockPath)){const s=lstatSync(lockPath);if(!s.isFile()||s.isSymbolicLink()||s.mode&0o077||process.getuid&&s.uid!==process.getuid())throw blocked('Original controller database is unsafe.');}
  const lock=privateDatabase(lockPath);
  lock.exec('CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY,operation_id TEXT,fingerprint TEXT,pid INTEGER,start TEXT,nonce TEXT); CREATE TABLE IF NOT EXISTS history(nonce TEXT PRIMARY KEY,pid INTEGER,start TEXT,started_at TEXT,ended_at TEXT);CREATE TABLE IF NOT EXISTS transactions(id TEXT PRIMARY KEY,fingerprint TEXT,receipt_directory TEXT,phase TEXT)');
  try{
    lock.exec('BEGIN IMMEDIATE');const original=lock.prepare('SELECT * FROM owner WHERE id=1').get();
    if(original&&(original.operation_id!==spec.operationId||original.fingerprint!==fingerprint||processStart(original.pid)===original.start))
      throw blocked('An original controller may still be running. Inspect its operation.');
    const registered=lock.prepare('SELECT * FROM transactions WHERE id=?').get(spec.operationId);
    if(registered&&(registered.fingerprint!==fingerprint||registered.receipt_directory!==spec.receiptDirectory||registered.phase!=='preparing'&&!existsSync(path)))
      throw blocked('The original deployment identity or receipt changed; no alternate receipt path is allowed.');
    lock.prepare("INSERT OR IGNORE INTO transactions VALUES(?,?,?,'preparing')").run(spec.operationId,fingerprint,spec.receiptDirectory);
    lock.prepare('INSERT OR REPLACE INTO owner VALUES(1,?,?,?,?,?)').run(spec.operationId,fingerprint,identity.pid,identity.start,identity.nonce);
    lock.prepare('INSERT INTO history VALUES(?,?,?,?,NULL)').run(identity.nonce,identity.pid,identity.start,stamp());lock.exec('COMMIT');
  }catch(error){if(lock.isTransaction)lock.exec('ROLLBACK');lock.close();throw error;}
  let row;
  const save=next=>{row=next;savePrivate(path,JSON.stringify(row,null,2)+'\n');lock.prepare('UPDATE transactions SET phase=? WHERE id=? AND fingerprint=?').run(row.phase,spec.operationId,fingerprint);};
  const event=(phase,data={})=>save({...row,phase,events:[...row.events,{phase,at:stamp(),...data}]});
  try {
    if(existsSync(path)){
      const original=JSON.parse(readPrivate(path));
      if(original.fingerprint!==fingerprint||!phases.includes(original.phase)||original.operationId!==spec.operationId)throw blocked('Original deployment input or phase changed.');
      row=original;
      if(['expired-before-stop','blocked-before-stop'].includes(row.outcome))return row;
    }else{
      await adapter.preflight(spec);
      save({version:1,operationId:spec.operationId,fingerprint,source:spec.source,phase:'prepared',
        createdAt:stamp(),deadline:clock()+spec.waitSeconds*1000,events:[{phase:'prepared',at:stamp(),controller:identity}]});
    }
    if(row.phase==='finalized')return row;
    const state=await adapter.reconcile(spec,row);
    if(state.newHealthy){
      if(!row.events.some(e=>e.phase==='start-intent'))throw blocked('A new writer appeared without the original start intent.');
      event('healthy',{reconciled:true,proof:state.proof});
    }else if(state.foreignWriter)throw blocked('Actual writer differs from the original old/target process.');
    if(['prepared','draining'].includes(row.phase)){
      if(row.phase==='prepared')event('draining',{intent:true});
      // begin must reconcile the SAME original hold; deadline is never renewed.
      if(!row.hold)save({...row,hold:await adapter.prepareHold(spec,row)});
      const hold=await adapter.begin(spec,row);save({...row,hold});
      let idle;
      while(clock()<row.deadline-45000){
        idle=await adapter.observe(spec,row);
        if(idle.safe)break;
        await sleep(Math.min(3000,Math.max(1,row.deadline-45000-clock())));
      }
      if(!idle?.safe||clock()>=row.deadline-45000){
        await adapter.release(spec,row);
        save({...row,outcome:'expired-before-stop',reason:'Work remained active or uncertain; only this operation\'s hold was released.'});return row;
      }
      save({...row,idle});
      const frozen=await adapter.freezeBackup(spec,row);save({...row,frozen});
      const backup=await adapter.backup(spec,row);
      if(backup.verified!==true)throw blocked('Private backup was not verified.');
      event('backup-verified',{backup});
    }
    if(row.phase==='backup-verified'){
      const proof=await adapter.seal(spec,row);
      if(proof.safe!==true||clock()>=row.deadline-25000)throw blocked('Fresh idle claim is unavailable within the original deadline.');
      event('stop-intent',{proof,maximumActualStops:1});
      await adapter.stop(spec,row);
    }
    if(row.phase==='stop-intent'){
      const result=await adapter.waitOldExit(spec,row);
      if(result.oldExited!==true)throw blocked('Original stop is pending or uncertain; no stop was repeated.');
      event('old-process-exited',{proof:result});
    }
    if(row.phase==='old-process-exited'){
      // prepareStart is reversible config/code staging. The old process must
      // be absent; it cannot restore application/control databases.
      await adapter.prepareStart(spec,row);
      event('start-intent',{maximumActualStarts:1});
      await adapter.start(spec,row);
    }
    if(row.phase==='start-intent'){
      const result=await adapter.waitHealthy(spec,row);
      if(result.newHealthy!==true)throw blocked('Original start is pending or uncertain; no start was repeated.');
      event('healthy',{proof:result.proof});
    }
    if(row.phase==='healthy'){
      await adapter.finalize(spec,row);
      event('finalized',{outcome:'healthy'});
      save({...row,outcome:'healthy'});
    }
    return row;
  }catch(error){
    if(row){
      const beforeStop=['prepared','draining','backup-verified'].includes(row.phase);
      let released=false;
      if(beforeStop)try{await adapter.release(spec,row);released=true;}catch{/* Retain actual hold identity; never claim release. */}
      save({...row,lastFailure:{at:stamp(),category:error.deploymentBlocked?'blocked':'adapter-failure',beforeStop,released},
        outcome:beforeStop?'blocked-before-stop':'reconciliation-required'});
    }
    throw error;
  }finally{
    lock.prepare('DELETE FROM owner WHERE nonce=?').run(identity.nonce);
    lock.prepare('UPDATE history SET ended_at=? WHERE nonce=?').run(stamp(),identity.nonce);lock.close();
  }
}

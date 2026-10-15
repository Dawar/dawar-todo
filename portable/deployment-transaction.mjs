import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, readFileSync,mkdirSync,lstatSync } from 'node:fs';
import { readPrivate, savePrivate } from './private-file.mjs';
import {privateDatabase} from './sqlite.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const blocked = message => Object.assign(Error(message), { deploymentBlocked: true });
export const phases = ['prepared','draining','backup-verified','stop-intent','old-process-exited','start-intent','healthy','rollback-intent','rolled-back','finalized'];
const afterStop = phase => phases.indexOf(phase) >= phases.indexOf('stop-intent');
const stamp = () => new Date().toISOString();
const processStart = pid => { try { const text=readFileSync(`/proc/${pid}/stat`,'utf8'); return text.slice(text.lastIndexOf(')')+2).split(' ')[19]; } catch { return null; } };
export const convergenceDefaults = Object.freeze({ stopWindowSeconds: 240, healthWindowSeconds: 300, startupGraceSeconds: 30 });

// A receipt names the step and a short reason. Adapter messages are written
// for operators; anything credential-shaped is removed and the text bounded.
export function failureReason(error) {
  return String(error?.message || 'Unknown deployment failure.')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/([A-Z_]*(SECRET|TOKEN|PASSWORD|KEY)[A-Z_]*=)\S+/g, '$1[redacted]')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 300);
}

// Controller runs outside native turns. All effects have a durable intent and
// exact operation identity. Before stop-intent the drain deadline governs and
// any doubt releases the hold. From stop-intent on the controller is forward
// only: it waits for the old exit, starts the target, and if the target is not
// healthy within a bounded window it restores the before-configs and starts the
// previous release. It never leaves the service stopped, never restores an
// application/control database and never replays native input.
export async function runDeployment(spec, adapter, { clock=Date.now, sleep=ms=>new Promise(r=>setTimeout(r,ms)) }={}) {
  if(spec.version!==1||spec.kind!=='portable-deployment'||!/^[A-Za-z0-9:_-]{10,180}$/.test(spec.operationId??'')||
     !/^[a-f0-9]{40}$/.test(spec.source??'')||!Number.isSafeInteger(spec.waitSeconds)||spec.waitSeconds<60||spec.waitSeconds>900)
    throw blocked('Invalid exact deployment identity or bounded deadline.');
  const convergence={...convergenceDefaults,...spec.convergence};
  if(Object.entries(convergence).some(([key,n])=>!Object.hasOwn(convergenceDefaults,key)||!Number.isSafeInteger(n)||n<1||n>3600)||convergence.startupGraceSeconds>=convergence.healthWindowSeconds)
    throw blocked('Invalid bounded convergence windows.');
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
  let row,step='preflight';
  const save=next=>{row=next;savePrivate(path,JSON.stringify(row,null,2)+'\n');lock.prepare('UPDATE transactions SET phase=? WHERE id=? AND fingerprint=?').run(row.phase,spec.operationId,fingerprint);};
  const event=(phase,data={})=>save({...row,phase,events:[...row.events,{phase,at:stamp(),...data}]});
  const failure=(error,extra={})=>({at:stamp(),step,category:error?.deploymentBlocked?'blocked':'adapter-failure',message:failureReason(error),...extra});
  // Post-stop failures are recorded and the controller keeps converging.
  const note=error=>save({...row,lastFailure:failure(error,{beforeStop:false,released:false}),failures:[...(row.failures??[]),failure(error)].slice(-20)});
  const eventAt=phase=>Date.parse([...row.events].reverse().find(e=>e.phase===phase)?.at??'')||clock();
  const rollback=async cause=>{
    if(row.phase!=='rollback-intent')event('rollback-intent',{cause:cause?{step:cause.step,message:cause.message}:null,maximumActualStarts:1});
    const until=eventAt('rollback-intent')+convergence.stopWindowSeconds*1000+convergence.healthWindowSeconds*1000;
    // Restores only the configuration files and the hub writer source this
    // operation changed; data written by either release is kept.
    step='rollback';try{await adapter.rollback(spec,row,{until});}catch(error){note(error);}
    step='wait-previous-healthy';let result;
    try{result=await adapter.waitPreviousHealthy(spec,row,{until});}catch(error){note(error);result={healthy:false};}
    step='ensure-running';try{await adapter.ensureRunning(spec,row);}catch(error){note(error);}
    event('rolled-back',{healthy:result.healthy===true,proof:result.proof??null});
    save({...row,outcome:result.healthy===true?'rolled-back':'rollback-unhealthy'});
    return row;
  };
  const converge=async()=>{
    if(row.phase==='rollback-intent')return rollback(null);
    if(row.phase==='stop-intent'){
      step='wait-old-exit';
      // A failed observation (systemctl timeout, /proc race) is retried
      // within the window; it is never a reason to stop converging.
      const observeExit=async until=>{for(;;){try{return await adapter.waitOldExit(spec,row,{until});}catch(error){note(error);if(clock()>=until)throw error;await sleep(2000);}}};
      let result=await observeExit(eventAt('stop-intent')+convergence.stopWindowSeconds*1000);
      if(result.oldExited!==true){
        // The drain was proven idle before stop-intent. A process that ignores
        // its stop past TimeoutStopSec plus margin is killed, once.
        step='escalate-stop';
        if(!row.escalatedAt){save({...row,escalatedAt:stamp()});await adapter.escalateStop(spec,row);}
        step='wait-old-exit';
        result=await observeExit(clock()+60000);
      }
      if(result.oldExited!==true)throw blocked('The original process did not exit after stop and one escalation; nothing else was started while it runs.');
      event('old-process-exited',{proof:result});
    }
    if(row.phase==='old-process-exited'){
      // prepareStart is reversible config/code staging. The old process must
      // be absent; it cannot restore application/control databases.
      step='prepare-start';
      try{await adapter.prepareStart(spec,row,{until:clock()+convergence.healthWindowSeconds*1000});}catch(error){note(error);return rollback(row.lastFailure);}
      event('start-intent',{maximumActualStarts:1});
      step='start';
      try{await adapter.start(spec,row);}catch(error){note(error);return rollback(row.lastFailure);}
    }
    if(row.phase==='start-intent'){
      step='wait-healthy';
      const started=eventAt('start-intent');let result;
      try{result=await adapter.waitHealthy(spec,row,{until:started+convergence.healthWindowSeconds*1000,graceUntil:started+convergence.startupGraceSeconds*1000});}
      catch(error){result={newHealthy:false,reason:failureReason(error)};}
      if(result.newHealthy!==true){note(Object.assign(Error(result.reason??'Target release was not healthy within its bounded window.'),{deploymentBlocked:true}));return rollback(row.lastFailure);}
      event('healthy',{proof:result.proof});
    }
    if(row.phase==='healthy'){
      step='finalize';
      await adapter.finalize(spec,row);
      event('finalized',{outcome:'healthy'});
      // Transient post-stop notes stay in `failures`; a healthy receipt has no lastFailure.
      save({...row,lastFailure:undefined,outcome:'healthy'});
    }
    return row;
  };
  try {
    if(existsSync(path)){
      const original=JSON.parse(readPrivate(path));
      if(original.fingerprint!==fingerprint||!phases.includes(original.phase)||original.operationId!==spec.operationId)throw blocked('Original deployment input or phase changed.');
      row=original;
      if(['expired-before-stop','blocked-before-stop'].includes(row.outcome))return row;
    }else{
      await adapter.preflight(spec);
      save({version:1,operationId:spec.operationId,fingerprint,source:spec.source,phase:'prepared',
        createdAt:stamp(),deadline:clock()+spec.waitSeconds*1000,convergence,events:[{phase:'prepared',at:stamp(),controller:identity}]});
    }
    if(['finalized','rolled-back'].includes(row.phase))return row;
    step='reconcile';
    const state=await adapter.reconcile(spec,row);
    if(state.newHealthy&&!row.events.some(e=>e.phase==='start-intent'))throw blocked('A new writer appeared without the original start intent.');
    if(state.newHealthy&&row.phase==='start-intent')event('healthy',{reconciled:true,proof:state.proof});
    // After stop-intent a foreign-looking writer may be the target starting up;
    // convergence decides, within its bounded windows.
    else if(state.foreignWriter&&!afterStop(row.phase))throw blocked('Actual writer differs from the original old/target process.');
    if(['prepared','draining'].includes(row.phase)){
      step='begin-drain';
      if(row.phase==='prepared')event('draining',{intent:true});
      // begin must reconcile the SAME original hold; deadline is never renewed.
      if(!row.hold)save({...row,hold:await adapter.prepareHold(spec,row)});
      const hold=await adapter.begin(spec,row);save({...row,hold});
      step='observe-drain';
      let idle;
      while(clock()<row.deadline-45000){
        idle=await adapter.observe(spec,row);
        save({...row,lastObservation:idle,observedAt:stamp()});
        if(idle.safe)break;
        await sleep(Math.min(3000,Math.max(1,row.deadline-45000-clock())));
      }
      if(!idle?.safe||clock()>=row.deadline-45000){
        step='release-hold';
        await adapter.release(spec,row);
        save({...row,outcome:'expired-before-stop',reason:'Work remained active or uncertain; only this operation\'s hold was released.',
          lastFailure:{at:stamp(),step:'observe-drain',category:'expired',message:failureReason({message:idle?.reason??'Drain was not idle before its deadline.'}),beforeStop:true,released:true}});return row;
      }
      save({...row,idle});
      step='freeze-backup';
      const frozen=await adapter.freezeBackup(spec,row);save({...row,frozen});
      step='backup';
      const backup=await adapter.backup(spec,row);
      if(backup.verified!==true)throw blocked('Private backup was not verified.');
      event('backup-verified',{backup});
    }
    if(row.phase==='backup-verified'){
      step='seal';
      const proof=await adapter.seal(spec,row);
      if(proof.safe!==true||clock()>=row.deadline-25000)throw blocked('Fresh idle claim is unavailable within the original deadline.');
      event('stop-intent',{proof,maximumActualStops:1});
      step='stop';
      // The stop request itself may fail ambiguously; convergence observes
      // the actual process instead of repeating it.
      try{await adapter.stop(spec,row);}catch(error){note(error);}
    }
    // The drain deadline no longer applies: from here we only converge.
    return await converge();
  }catch(error){
    if(row){
      const beforeStop=!afterStop(row.phase);
      let released=false;
      if(beforeStop)try{await adapter.release(spec,row);released=true;}catch{/* Retain actual hold identity; never claim release. */}
      else try{await adapter.ensureRunning(spec,row);}catch{/* Recorded below; the receipt says reconciliation is required. */}
      save({...row,lastFailure:failure(error,{beforeStop,released}),
        outcome:beforeStop?'blocked-before-stop':'reconciliation-required'});
    }
    throw error;
  }finally{
    lock.prepare('DELETE FROM owner WHERE nonce=?').run(identity.nonce);
    lock.prepare('UPDATE history SET ended_at=? WHERE nonce=?').run(stamp(),identity.nonce);lock.close();
  }
}

import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {digest} from './protocol.mjs';

const contexts=new AsyncLocalStorage();
const failed=()=>Object.assign(Error('The exact local writer admission or drain could not be confirmed.'),{outcome:'not-sent'});
const kinds=new Set(['artifact-register','object-put','object-request','object-copy','object-upload','object-cleanup','voice-request','voice-tick']);
const binding=a=>({writerId:a?.writerId,epoch:a?.epoch,source:a?.source??''});
const same=(r,a)=>r&&r.writer_id===a.writerId&&r.epoch===a.epoch&&r.source===a.source;
const validState=r=>r&&['open','draining','frozen'].includes(r.phase)&&Number.isSafeInteger(r.generation)&&r.generation>=0&&Number.isSafeInteger(r.deadline)&&
  (r.phase==='open'?r.operation_id===null&&r.deadline===0:typeof r.operation_id==='string'&&r.operation_id.length>0&&r.generation>0&&r.deadline>0);

// Installation schema, before runtime control authorization is attached. Work
// rows describe asynchronous lifetimes, NOT successful business operations.
// An unclean exit leaves active rows. Neither PID death nor age settles them.
export class LocalWorkAdmission {
  constructor(writer){
    this.writer=writer;this.db=writer.db;this.expected=Object.freeze(binding(writer.authority));this.live=new Set();
    this.db.exec(`CREATE TABLE IF NOT EXISTS portable_async_admission(
      id INTEGER PRIMARY KEY CHECK(id=1),writer_id TEXT NOT NULL,epoch INTEGER NOT NULL,source TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('open','draining','frozen')),generation INTEGER NOT NULL,operation_id TEXT,deadline INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS portable_async_work(
      id TEXT PRIMARY KEY,writer_id TEXT NOT NULL,epoch INTEGER NOT NULL,source TEXT NOT NULL,kind TEXT NOT NULL,
      fingerprint TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','settled','unknown')),pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS portable_async_drains(
      id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,generation INTEGER NOT NULL,deadline INTEGER NOT NULL,state TEXT NOT NULL);`);
    let r;try{r=this.db.prepare('SELECT writer_id,epoch,frozen FROM portable_authority WHERE id=1').get();}catch{/* Unactivated site staging has no control authority yet. */}
    if(writer.authority&&r?.writer_id===this.expected.writerId&&r.epoch===this.expected.epoch&&r.frozen===0)
      this.db.prepare("INSERT OR IGNORE INTO portable_async_admission VALUES(1,?,?,?,'open',0,NULL,0)").run(this.expected.writerId,this.expected.epoch,this.expected.source);
  }
  current(){return this.db.prepare('SELECT * FROM portable_async_admission WHERE id=1').get();}
  scope(){const s=contexts.getStore();return s?.owner===this?s:null;}
  bind(factory){
    const scope=this.scope();if(!scope||typeof factory!=='function')throw failed();
    // Incoming Node streams can invoke callbacks from their upstream context.
    // Capture only the actual admitted lifetime, never a new admission grant.
    return (...args)=>contexts.run(scope,()=>{this.writer.assertWriter();return factory(...args);});
  }
  assertWriteScope(){
    const row=this.current();if(!same(row,this.expected)||!validState(row))throw failed();
    const scope=this.scope();
    if(scope&&(scope.closed||!this.live.has(scope)))throw failed();
    if(row.phase==='open')return;
    if(row.phase!=='draining'||!scope)throw failed();
    const work=this.db.prepare('SELECT * FROM portable_async_work WHERE id=?').get(scope.id);
    if(!same(work,this.expected)||work.state!=='active'||work.fingerprint!==scope.fingerprint)throw failed();
  }
  keep(promise){
    const scope=this.scope();this.writer.assertWriter();
    if(!scope||scope.closed||!this.live.has(scope)||!promise||typeof promise.then!=='function'||scope.pending.size>=1024)throw failed();
    const task=Promise.resolve(promise);scope.pending.add(task);
    void task.then(()=>scope.pending.delete(task),()=>scope.pending.delete(task));return task;
  }
  unknown(){
    const scope=this.scope();this.writer.assertWriter();
    if(!scope||scope.closed||!this.live.has(scope))throw failed();scope.unknown=true;
  }
  async start(kind,factory){
    if(!kinds.has(kind)||typeof factory!=='function')throw failed();
    const parent=this.scope();
    if(parent){
      this.writer.assertWriter();
      const task=this.keep(Promise.resolve().then(factory));
      try{return {value:await task,failed:false,settled:Promise.resolve()};}
      catch(error){return {error,failed:true,settled:Promise.resolve()};}
    }
    const id=randomUUID(),fingerprint=digest(JSON.stringify({...this.expected,id,kind,pid:process.pid}));
    this.writer.admitting=true;
    try{this.writer.runSync(()=>{
      const row=this.current();if(!same(row,this.expected)||row.phase!=='open')throw failed();
      if(this.db.prepare("SELECT count(*) AS n FROM portable_async_work WHERE state<>'settled'").get().n>=1024||this.db.prepare('SELECT count(*) AS n FROM portable_async_work').get().n>=100000)throw failed();
      this.db.prepare("INSERT INTO portable_async_work VALUES(?,?,?,?,?,?,'active',?)").run(id,this.expected.writerId,this.expected.epoch,this.expected.source,kind,fingerprint,process.pid);
    });}finally{this.writer.admitting=false;}
    const scope={owner:this,id,fingerprint,pending:new Set(),closed:false,unknown:false};this.live.add(scope);
    let result,error,failedWork=false;
    try{result=await contexts.run(scope,factory);}catch(e){error=e;failedWork=true;}
    // Upgrades can return their HTTP response before a socket closes. Their
    // captured scope stays live, durably active, until all retained work ends.
    const settled=(async()=>{
      while(scope.pending.size){await Promise.allSettled([...scope.pending]);await Promise.resolve();}
      scope.closed=true;
      try{this.writer.settleWork(()=>{
      const row=this.current(),old=this.db.prepare('SELECT * FROM portable_async_work WHERE id=?').get(id);
      if(!same(row,this.expected)||!same(old,this.expected)||old.state!=='active'||old.fingerprint!==fingerprint||old.pid!==process.pid)throw failed();
      const changed=this.db.prepare("UPDATE portable_async_work SET state=? WHERE id=? AND fingerprint=? AND state='active'").run(scope.unknown?'unknown':'settled',id,fingerprint);
      if(changed.changes!==1)throw failed();
      });}finally{this.live.delete(scope);}
    })();
    // A caller must observe settlement separately when it publishes an early
    // response. No asynchronous settlement failure becomes implicit success.
    return {value:result,error,failed:failedWork,settled};
  }
  async run(kind,factory){
    const result=await this.start(kind,factory);await result.settled;
    if(result.failed)throw result.error;return result.value;
  }
}

// Private controller for the NEW portable hub only. It cannot restart or
// qualify d011, alter a native claim, or prove any external/native writer idle.
// Holds have no automatic expiry release. Only this same operation can release.
export class LocalWriterDrain {
  constructor(db,expected){
    if(!expected||Object.keys(expected).sort().join(',')!=='epoch,source,writerId'||typeof expected.writerId!=='string'||!expected.writerId||!Number.isSafeInteger(expected.epoch)||expected.epoch<1||!/^[a-f0-9]{40}$/.test(expected.source))throw failed();
    this.db=db;this.expected=Object.freeze({...expected});
  }
  transaction(factory){
    if(this.db.isTransaction)throw failed();this.db.exec('BEGIN IMMEDIATE');
    try{const result=factory();if(result?.then)throw failed();this.db.exec('COMMIT');return result;}
    catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}
  }
  state(){
    const row=this.db.prepare('SELECT * FROM portable_async_admission WHERE id=1').get();
    const a=this.db.prepare('SELECT * FROM portable_authority WHERE id=1').get();
    if(!same(row,this.expected)||!validState(row)||a?.writer_id!==this.expected.writerId||a.epoch!==this.expected.epoch||a.frozen!==(row.phase==='frozen'?1:0))throw failed();
    return row;
  }
  original(operationId){
    const row=this.state(),r=this.db.prepare('SELECT * FROM portable_async_drains WHERE id=?').get(operationId);
    if(!r||row.operation_id!==operationId||r.generation!==row.generation||r.deadline!==row.deadline||r.state!==row.phase||r.fingerprint!==digest(JSON.stringify({...this.expected,operationId,deadline:row.deadline})))throw failed();
    return row;
  }
  begin(operationId,deadline){
    if(typeof operationId!=='string'||!operationId||operationId.length>1024||operationId.includes('\0')||!Number.isSafeInteger(deadline)||deadline<=Date.now()||deadline-Date.now()>900000)throw failed();
    this.transaction(()=>{
      const row=this.state(),prior=this.db.prepare('SELECT * FROM portable_async_drains WHERE id=?').get(operationId);
      if(prior){if(prior.deadline!==deadline||prior.fingerprint!==digest(JSON.stringify({...this.expected,operationId,deadline})))throw failed();this.original(operationId);return;}
      if(row.phase!=='open'||row.generation>=Number.MAX_SAFE_INTEGER)throw failed();
      const fingerprint=digest(JSON.stringify({...this.expected,operationId,deadline})),generation=row.generation+1;
      this.db.prepare("INSERT INTO portable_async_drains VALUES(?,?,?,?,'draining')").run(operationId,fingerprint,generation,deadline);
      this.db.prepare("UPDATE portable_async_admission SET phase='draining',generation=?,operation_id=?,deadline=? WHERE id=1").run(generation,operationId,deadline);
    });return this.observe(operationId);
  }
  observe(operationId){
    const row=this.original(operationId),counts={active:0,unknown:0,settled:0};
    const foreign=this.db.prepare("SELECT count(*) AS n FROM portable_async_work WHERE state<>'settled' AND (writer_id<>? OR epoch<>? OR source<>? OR kind NOT IN ('artifact-register','object-put','object-request','object-copy','object-upload','object-cleanup','voice-request','voice-tick'))").get(this.expected.writerId,this.expected.epoch,this.expected.source).n;
    for(const r of this.db.prepare('SELECT state,count(*) AS n FROM portable_async_work GROUP BY state').all()){
      if(!Object.hasOwn(counts,r.state)||!Number.isSafeInteger(r.n))throw failed();counts[r.state]=r.n;
    }
    if(foreign)throw failed();
    return {kind:'portable-local-writer-drain',...this.expected,operationId,generation:row.generation,deadline:row.deadline,observedAt:Date.now(),
      phase:row.phase,status:row.deadline<=Date.now()?'expired':counts.active||counts.unknown?'busy':row.phase==='frozen'?'frozen':'ready',...counts,
      nativeAndExternalCoverage:false};
  }
  freeze(operationId){
    this.transaction(()=>{
      const row=this.original(operationId),p=this.observe(operationId);
      if(p.status!=='ready'&&p.status!=='frozen'||p.active||p.unknown)throw failed();
      if(row.phase==='frozen')return;
      this.db.prepare('UPDATE portable_authority SET frozen=1 WHERE id=1').run();
      this.db.prepare("UPDATE portable_async_admission SET phase='frozen' WHERE id=1").run();
      this.db.prepare("UPDATE portable_async_drains SET state='frozen' WHERE id=?").run(operationId);
    });return this.observe(operationId);
  }
  release(operationId){
    return this.transaction(()=>{
      const prior=this.db.prepare('SELECT * FROM portable_async_drains WHERE id=?').get(operationId);
      if(prior?.state==='released'){
        const row=this.state();if(prior.fingerprint!==digest(JSON.stringify({...this.expected,operationId,deadline:prior.deadline})))throw failed();
        return {released:true,reconciled:true,operationId,generation:prior.generation,currentPhase:row.phase};
      }
      const row=this.original(operationId);
      this.db.prepare('UPDATE portable_authority SET frozen=0 WHERE id=1').run();
      this.db.prepare("UPDATE portable_async_admission SET phase='open',operation_id=NULL,deadline=0 WHERE id=1").run();
      this.db.prepare("UPDATE portable_async_drains SET state='released' WHERE id=?").run(operationId);
      return {released:true,operationId,generation:row.generation};
    });
  }
}

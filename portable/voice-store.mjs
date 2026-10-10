import {mkdirSync,lstatSync,openSync,fstatSync,closeSync,constants} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {privateDatabase} from './sqlite.mjs';
const failure=()=>Error('Original local voice state or effect receipt is unavailable; retain its identity.');
const hash=v=>createHash('sha256').update(v).digest('hex');
const text=v=>{if(typeof v!=='string'||!v||v.includes('\0')||Buffer.byteLength(v)>1024)throw failure();return v;};
const encode=v=>{const s=JSON.stringify(v);if(typeof s!=='string'||Buffer.byteLength(s)>1024*1024)throw failure();return s;};
const storageKey=v=>{if(!['sip-call','sip-voice-readback-v1'].includes(v))throw failure();return v;};

export class VoiceStore {
  constructor(path,{source,assertWriter,writeSync}) {
    if(!/^[a-f0-9]{40}$/.test(source)||typeof assertWriter!=='function'||typeof writeSync!=='function')throw failure();
    path=resolve(path);mkdirSync(dirname(path),{recursive:true,mode:0o700});
    const parent=lstatSync(dirname(path));if(!parent.isDirectory()||parent.isSymbolicLink()||parent.mode&0o077||process.getuid&&parent.uid!==process.getuid())throw failure();
    const fd=openSync(path,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);let before;
    try{before=fstatSync(fd);if(!before.isFile()||before.mode&0o077||process.getuid&&before.uid!==process.getuid())throw failure();}finally{closeSync(fd);}
    this.db=privateDatabase(path);const after=lstatSync(path);if(after.isSymbolicLink()||after.ino!==before.ino||after.dev!==before.dev){this.db.close();throw failure();}
    this.source=source;this.assertWriter=assertWriter;this.writeSync=writeSync;this.current=new Set();this.closed=false;
    this.writeSync(()=>{this.assertWriter();this.db.exec(`CREATE TABLE IF NOT EXISTS voice_objects(id TEXT PRIMARY KEY,alarm_at INTEGER,alarm_generation INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS voice_values(object_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(object_id,key));
      CREATE TABLE IF NOT EXISTS voice_effects(id TEXT PRIMARY KEY,object_id TEXT NOT NULL,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','terminal','unknown')),response TEXT);
      CREATE INDEX IF NOT EXISTS voice_effect_scope ON voice_effects(object_id,state);
      CREATE INDEX IF NOT EXISTS voice_due_alarm ON voice_objects(alarm_at,id);`);this.assertWriter();});
  }
  transaction(fn){
    if(this.closed||this.db.isTransaction||typeof fn!=='function')throw failure();
    // The shared control lock precedes this short voice transaction. Freeze
    // cannot cross the assertions; no provider call or promise runs under it.
    return this.writeSync(()=>{this.assertWriter();this.db.exec('BEGIN IMMEDIATE');
      try{const v=fn();if(v&&typeof v.then==='function')throw failure();this.assertWriter();this.db.exec('COMMIT');return v;}
      catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}});
  }
  object(id){text(id);this.transaction(()=>{if(!this.db.prepare('SELECT 1 FROM voice_objects WHERE id=?').get(id)&&this.db.prepare('SELECT count(*) n FROM voice_objects').get().n>=1024)throw failure();this.db.prepare('INSERT OR IGNORE INTO voice_objects(id)VALUES(?)').run(id);});return id;}
  storage(id){text(id);return {
    get:async key=>{storageKey(key);if(this.closed)throw failure();const r=this.db.prepare('SELECT value FROM voice_values WHERE object_id=? AND key=?').get(id,key);return r?JSON.parse(r.value):undefined;},
    put:async values=>{if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).length>2)throw failure();const rows=Object.entries(values).map(([key,value])=>[storageKey(key),encode(value)]);this.transaction(()=>{if(!this.db.prepare('SELECT 1 FROM voice_objects WHERE id=?').get(id))throw failure();for(const [key,value] of rows)this.db.prepare('INSERT INTO voice_values VALUES(?,?,?) ON CONFLICT(object_id,key)DO UPDATE SET value=excluded.value').run(id,key,value);if(this.db.prepare('SELECT coalesce(sum(length(CAST(value AS BLOB))),0) n FROM voice_values').get().n>64*1024*1024)throw failure();});},
    setAlarm:async at=>{if(!Number.isSafeInteger(at)||at<0||at>Date.now()+900000)throw failure();this.transaction(()=>{const r=this.db.prepare('SELECT * FROM voice_objects WHERE id=?').get(id);if(!r||r.alarm_generation>=Number.MAX_SAFE_INTEGER)throw failure();this.db.prepare('UPDATE voice_objects SET alarm_at=?,alarm_generation=alarm_generation+1 WHERE id=?').run(at,id);});},
    deleteAlarm:async()=>this.transaction(()=>{this.db.prepare('UPDATE voice_objects SET alarm_at=NULL WHERE id=?').run(id);}),
  };}
  begin({objectId,kind,operationId=randomUUID(),payload,alarm}) {
    text(objectId);text(kind);text(operationId);const fingerprint=hash(encode({version:1,source:this.source,objectId,kind,operationId,payload}));
    const result=this.transaction(()=>{
      const prior=this.db.prepare('SELECT * FROM voice_effects WHERE id=?').get(operationId);
      if(prior){if(prior.fingerprint!==fingerprint||prior.object_id!==objectId||prior.state!=='terminal'||prior.response===null)throw failure();return {reconciled:true,response:JSON.parse(prior.response)};}
      const pending=this.db.prepare("SELECT id FROM voice_effects WHERE object_id=? AND state<>'terminal'").all(objectId);
      if(pending.some(r=>!this.current.has(r.id))||this.db.prepare('SELECT count(*) n FROM voice_effects').get().n>=100000)throw failure();
      if(alarm){const row=this.db.prepare('SELECT * FROM voice_objects WHERE id=?').get(objectId);if(!row||row.alarm_at!==alarm.at||row.alarm_generation!==alarm.generation)throw failure();this.db.prepare('UPDATE voice_objects SET alarm_at=NULL WHERE id=? AND alarm_at=? AND alarm_generation=?').run(objectId,alarm.at,alarm.generation);}
      this.db.prepare("INSERT INTO voice_effects VALUES(?,?,?,?,'active',NULL)").run(operationId,objectId,kind,fingerprint);return {reconciled:false};
    });if(!result.reconciled)this.current.add(operationId);return {...result,operationId,fingerprint};
  }
  settle(operationId,fingerprint,state,response=null){
    if(!['terminal','unknown'].includes(state))throw failure();const value=response===null?null:encode(response);if(value&&Buffer.byteLength(value)>32768)throw failure();
    this.transaction(()=>{const r=this.db.prepare('SELECT * FROM voice_effects WHERE id=?').get(operationId);if(!r||r.fingerprint!==fingerprint||!this.current.has(operationId)||r.state!=='active')throw failure();this.db.prepare('UPDATE voice_effects SET state=?,response=? WHERE id=? AND state=\'active\'').run(state,value,operationId);});this.current.delete(operationId);
  }
  due(now=Date.now()){if(this.closed)throw failure();return this.db.prepare('SELECT * FROM voice_objects WHERE alarm_at<=? ORDER BY alarm_at,id LIMIT 64').all(now);}
  admissible(id){text(id);if(this.closed)throw failure();return this.db.prepare("SELECT id,state FROM voice_effects WHERE object_id=? AND state<>'terminal'").all(id).every(r=>r.state==='active'&&this.current.has(r.id));}
  lastMinute(){if(this.closed)throw failure();const r=this.db.prepare("SELECT id FROM voice_effects WHERE kind='minute' ORDER BY id DESC LIMIT 1").get();if(!r)return null;const at=Number(r.id.slice('minute:'.length));if(!/^minute:[0-9]{13}$/.test(r.id)||!Number.isSafeInteger(at))throw failure();return at;}
  counts(){if(this.closed)throw failure();const counts={activeEffects:0,unknownEffects:0,activeCalls:0,dueAlarms:0};for(const r of this.db.prepare("SELECT state,count(*) n FROM voice_effects WHERE state<>'terminal' GROUP BY state").all())counts[r.state==='active'?'activeEffects':'unknownEffects']=r.n;for(const r of this.db.prepare("SELECT value FROM voice_values WHERE key='sip-call'").all()){const value=JSON.parse(r.value);if(value?.ended!==true)counts.activeCalls++;}counts.dueAlarms=this.db.prepare('SELECT count(*) n FROM voice_objects WHERE alarm_at<=?').get(Date.now()).n;return counts;}
  close(){const counts=this.counts();if(counts.activeEffects||counts.activeCalls||counts.unknownEffects)throw failure();this.closed=true;this.db.close();}
}

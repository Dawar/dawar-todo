import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { fingerprint } from './protocol.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const methods=new Set(['teams.save','teams.assign','teams.reorder','teams.orderBots','teams.memory','teams.delete']);
const kind='portableLegacyTeamReceipt';

/** First compatible combined startup only, after the reviewed exclusive cutover.
 * No native history, queues or settings are copied. Preserve original rows/IDs. */
export function adoptLegacyTeams(controls,owner,source){
 if(!source||!controls.authority||controls.store.meta('portable-team-authority'))return;
 controls.assertWriter();
 const node=controls.hub.node(source.nodeId);
 if(node.owner!==owner)throw Error('Legacy teams belong to another node owner.');
 const stat=lstatSync(source.path);
 if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw Error('Legacy team source must be a private regular SQLite file.');
 const db=new DatabaseSync(source.path,{readOnly:true});let teams,placements,operations;
 try{
  db.exec('BEGIN');
  const rows=db.prepare("SELECT json FROM records WHERE kind='team' ORDER BY id LIMIT 65").all();
  if(rows.length>64)throw Error('Legacy team catalog exceeds its migration bound.');
  teams=rows.map(row=>{
   const t=JSON.parse(row.json);
   if(!/^team-[a-f0-9]{32}$/.test(t.id??'')||!Number.isSafeInteger(t.revision)||t.revision<1||typeof t.memory!=='string'||t.memory.length>64000)throw Error('Invalid original team record.');
   const old=controls.store.get('team',t.id);
   if(old&&(old.revision>t.revision||old.revision===t.revision&&fingerprint(old)!==fingerprint(t)))throw Error('Canonical team changed before first adoption; preserve both originals.');
   return {value:t,raw:row.json};
  });
  placements=controls.hub.db.prepare('SELECT bot_id FROM portable_placements WHERE owner=? AND node_id=? ORDER BY bot_id').all(owner,source.nodeId).map(({bot_id})=>{
   const r=db.prepare("SELECT json_extract(json,'$.teamId') teamId,json_extract(json,'$.teamOrder') teamOrder FROM bots WHERE id=?").get(bot_id);
   if(!r)throw Error('Original team bot is absent from its assigned native store.');
   if(r.teamId!=null&&!teams.some(t=>t.value.id===r.teamId&&!t.value.deletedAt))throw Error('Original team membership has no active team.');
   return {id:bot_id,teamId:r.teamId??null,teamOrder:r.teamOrder??0};
  });
  operations=db.prepare("SELECT id,fingerprint,status,json FROM operations WHERE json_extract(json,'$.localOnly')='team-v1' ORDER BY id LIMIT 4097").all();
  if(operations.length>4096||operations.reduce((n,r)=>n+Buffer.byteLength(r.json),0)>128*1024*1024)throw Error('Original team receipts exceed the migration bound.');
  for(const r of operations){
   const op=JSON.parse(r.json);
   if(!methods.has(op.method)||r.status!=='done'||!op.result||typeof op.params!=='object')throw Error('Original team acceptance remains unconfirmed.');
   const hash=digest(JSON.stringify({method:op.method,botId:op.botId,params:op.params}));
   if(hash!==r.fingerprint)throw Error('Original team receipt fingerprint changed.');
   const old=controls.store.db.prepare('SELECT fingerprint,status,json FROM operations WHERE id=?').get(r.id);
   if(old&&(old.fingerprint!==r.fingerprint||old.status!==r.status||old.json!==r.json))throw Error('Original team receipt conflicts with a retained hub operation.');
  }
  db.exec('COMMIT');
 }finally{db.close();}
 controls.store.transaction(()=>{
  controls.assertWriter();
  for(const t of teams)controls.store.put('team',t.value);
  for(const p of placements)controls.store.saveBot({...controls.store.bot(p.id),teamId:p.teamId,teamOrder:p.teamOrder});
  for(const r of operations){
   const op=JSON.parse(r.json);
   controls.store.db.prepare('INSERT OR IGNORE INTO operations(id,fingerprint,status,json) VALUES(?,?,?,?)').run(r.id,r.fingerprint,r.status,r.json);
   controls.store.put(kind,{id:r.id,owner,originalFingerprint:r.fingerprint,rawSHA256:digest(r.json),requestHash:fingerprint({method:op.method,botId:op.botId??null,params:op.params}),botId:op.botId??null});
  }
  controls.store.meta('portable-team-authority',{version:1,nodeId:source.nodeId,adoptedAt:new Date().toISOString(),teams:teams.length,receipts:operations.length,sourceHash:fingerprint({teams:teams.map(t=>digest(t.raw)),placements,operations:operations.map(r=>[r.id,r.fingerprint,digest(r.json)])})});
 });
}

export function originalTeamReceipt(controls,owner,request,caller,prior){
 const proof=controls.store.get(kind,request.operationId);
 if(!proof||proof.owner!==owner||proof.originalFingerprint!==prior.fingerprint||prior.status!=='done')return false;
 const raw=controls.store.db.prepare('SELECT json FROM operations WHERE id=?').get(request.operationId)?.json;
 if(digest(raw??'')!==proof.rawSHA256||fingerprint({method:request.method,botId:request.botId??null,params:request.params})!==proof.requestHash)return false;
 return proof.botId?caller.kind==='authenticated-node-tool'&&caller.botId===proof.botId:caller.kind==='owner';
}

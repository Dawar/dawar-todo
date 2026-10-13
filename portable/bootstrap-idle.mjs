import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {openSync,readSync,closeSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {readPrivate} from './private-file.mjs';
import {MaintenanceTerminalProof} from '../bot-bridge/maintenance-terminal-proof.mjs';
import {passiveLegacyManagerRejections} from '../bot-bridge/legacy-manager-rejections.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function bootstrapAuthority(spec){
  const b=spec.compatibilityBootstrap;
  if(!b||!isAbsolute(b.nativeControlPath??'')||!isAbsolute(b.authorityPath??'')||!isAbsolute(b.transportScript??''))throw Error('Invalid compatibility bootstrap configuration.');
  const bytes=readPrivate(b.authorityPath);
  if(hash(bytes)!==b.authoritySHA256)throw Error('Original bootstrap authority changed.');
  const a=JSON.parse(bytes),n=a.nativeHuman;
  if(!n||!isAbsolute(n.rollout??'')||!Number.isSafeInteger(n.offset)||n.offset<0)throw Error('Original native owner locator missing.');
  const fd=openSync(n.rollout,'r'),buffer=Buffer.alloc(65536);let length;
  try{length=readSync(fd,buffer,0,buffer.length,n.offset);}finally{closeSync(fd);}
  const newline=buffer.indexOf(10),raw=buffer.subarray(0,newline<0?length:newline);
  if(hash(raw)!==n.rawSHA256)throw Error('Original owner record differs.');
  const record=JSON.parse(raw),p=record.payload,text=(p.content??[]).filter(c=>['input_text','text'].includes(c.type)).map(c=>c.text).join('\n');
  if(record.type!=='response_item'||p.role!=='user'||p.id!==n.id||hash(text)!==n.textSHA256||
      /^(\[Verified DawarTodo source|\[Named peer|\[Scheduled work)/.test(text)||
      !text.includes('eliminate or streamline the guard')||!text.includes('eliminate repeated approvals'))throw Error('Standing owner development/recovery authority is unavailable.');
  return {ownerMessageId:n.id,authoritySHA256:b.authoritySHA256,installedSealClaim:false};
}

// Compatibility installation for an older runtime that cannot classify its
// retained historical records. Never changes receipts or calls native work.
// The installed admission hold stays in force; fresh RAM counts are combined
// with registered native metadata and byte-exact terminal/refusal evidence.
export async function bootstrapIdle(spec,status){
  bootstrapAuthority(spec);
  const db=new DatabaseSync(spec.compatibilityBootstrap.nativeControlPath,{readOnly:true});
  try{
    db.exec('PRAGMA query_only=ON');
    const bots=db.prepare('SELECT json FROM bots').all().map(r=>JSON.parse(r.json));
    const store={db,bots:()=>bots},terminal=new MaintenanceTerminalProof(store),before=terminal.snapshot();
    if(!before) return {safe:false,reason:'Retained native metadata is not available.'};
    const legacy=passiveLegacyManagerRejections(store);
    const counts={...status.counts};
    const expected=legacy.length+before.input.accepted.length;
    if(counts.acceptedOrUnknown!==expected||counts.pendingInput!==before.input.questions.length)
      return {safe:false,counts,reason:'A new or genuinely unknown operation remains.'};
    counts.acceptedOrUnknown-=expected;counts.pendingInput-=before.input.questions.length;
    if(Object.values(counts).some(value=>!Number.isSafeInteger(value)||value!==0))return {safe:false,counts,reason:'Current managed work, tools or volatile state remains.'};
    const threads=new Set(bots.filter(b=>b.threadId&&!b.archived&&!b.deletedAt).map(b=>b.threadId));
    for(const r of db.prepare("SELECT json FROM records WHERE kind IN ('managerWorker','runLane','collaborationContext') AND (json_extract(json,'$.activeTurnId') IS NOT NULL OR json_extract(json,'$.status')='running')").all()){
      const row=JSON.parse(r.json);if(row.threadId)threads.add(row.threadId);
    }
    if(threads.size>1000)return {safe:false,reason:'Registered native scope exceeds its bound.'};
    const history=new DatabaseSync(join(homedir(),'.codex','thread_history_1.sqlite'),{readOnly:true});
    let active;
    try{const query=history.prepare("SELECT count(*) n FROM thread_turns WHERE thread_id=? AND status NOT IN ('completed','failed','interrupted')");active=[...threads].reduce((n,id)=>n+query.get(id).n,0);}finally{history.close();}
    if(active)return {safe:false,counts,registeredNativeActive:active,reason:'Registered native turns are still active.'};
    const native=await terminal.read(before.input,6000),after=terminal.snapshot();
    if(!terminal.matches(before,native)||!terminal.fresh(native)||before.fingerprint!==after?.fingerprint)
      return {safe:false,reason:'Native terminal evidence changed during observation.'};
    return {safe:true,counts,registeredThreads:threads.size,registeredNativeActive:0,
      retainedRefusals:legacy,retainedTerminalInputs:native.terminalInputs,retainedPassiveQuestions:native.passiveQuestions,
      originalFingerprint:before.fingerprint,observedAt:Date.now(),installedSealClaim:false,
      permission:'standing-owner-approved-compatibility-installation'};
  }catch{return {safe:false,reason:'Current native metadata is incomplete or changed; waiting within the original drain.'};}
  finally{db.close();}
}

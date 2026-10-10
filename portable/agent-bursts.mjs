import {fingerprint,id} from './protocol.mjs';
import {burstSource} from './hub-bursts.mjs';
import {prepareReply,ownedReply} from '../bot-bridge/message-replies.mjs';

const rejected=message=>Object.assign(Error(message),{outcome:'rejected'});
const uncertain=message=>Object.assign(Error(message),{outcome:'uncertain'});
const defer=message=>Object.assign(Error(message),{outcome:'not-sent',deferred:true});
const now=()=>new Date().toISOString();

export function settleAgentBurst(runtime,command,result){
  const {batch,messages}=JSON.parse(command.payload).params,store=runtime.store,turnId=result?.turn?.id??result?.turnId;
  if(!id(turnId))throw uncertain('Native burst response lacks the original turn identity.');
  return store.transaction(()=>{
    const b=store.get('messageBurst',batch.id),op=store.operation(batch.id);
    if(op?.portableFingerprint!==command.fingerprint||!op.portableBurst||op.botId!==batch.botId||b?.threadId!==batch.threadId||b.revision!==batch.revision||fingerprint(b.messageIds)!==fingerprint(batch.messageIds)||messages.some(m=>fingerprint(burstSource(store.get('burstMessage',m.id)??{}))!==fingerprint(m)))throw uncertain('Original burst source changed before positive settlement.');
    store.saveOperation(op.id,op.fingerprint,'done',{...op,result,error:null});store.put('messageBurst',{...b,state:'sent',turnId,error:null});
    for(const m of messages)store.put('burstMessage',{...store.get('burstMessage',m.id),state:'sent',turnId});
    return result;
  });
}

export async function admitBurstCommand(transport,command,payload){
  const {runtime,journal}=transport,store=runtime.store,{batch,messages,files,controlRevision}=payload.params??{},bot=store.bot(command.bot_id);
  if(payload.method!=='portable.burstDispatch'||!batch||batch.id!==command.operation_id||batch.botId!==bot.id||batch.threadId!==bot.threadId||batch.state!=='pending'||!Number.isSafeInteger(batch.revision)||batch.revision<1||!Number.isSafeInteger(controlRevision)||controlRevision<1||!Array.isArray(batch.messageIds)||!Array.isArray(messages)||!messages.length||messages.length>200||messages.some(m=>!m||typeof m!=='object')||fingerprint(messages.map(m=>m.id))!==fingerprint(batch.messageIds)||new Set(batch.messageIds).size!==messages.length||!Array.isArray(files)||files.length>12||files.some(f=>!f||typeof f!=='object')||new Set(files.map(f=>f.id)).size!==files.length)
    throw rejected('Original burst is outside the assigned conversation.');
  if(messages.some(m=>!id(m.id)||m.botId!==bot.id||m.batchId!==batch.id||typeof m.text!=='string'||m.text.length>200000||!Array.isArray(m.attachmentIds)||m.attachmentIds.some(fid=>!files.some(f=>f.id===fid)))||messages.reduce((n,m)=>n+m.text.length,0)>200000||messages.reduce((n,m)=>n+m.attachmentIds.length,0)>12||files.some(f=>!messages.some(m=>m.attachmentIds.includes(f.id))))throw rejected('Original burst text or registered files are invalid.');
  return runtime.lock(bot.id,()=>runtime.maintenance.admit(async()=>{
    const prior=store.operation(command.operation_id);
    if(prior){
      if(prior.botId!==bot.id||prior.method!=='turn.send'||prior.portableFingerprint!==command.fingerprint||!prior.portableBurst)throw uncertain('Original burst receipt conflicts; no second send.');
      if(prior.status==='done')return settleAgentBurst(runtime,command,prior.result);
      if(prior.outcome==='rejected')throw rejected(prior.error??'Original burst was rejected.');
      const result=await runtime.reconcileOperation(prior);if(result)return settleAgentBurst(runtime,command,result);
      throw uncertain('Original burst native acceptance remains unconfirmed.');
    }
    const assertControl=()=>{
      const c=journal.currentControl(command),b=store.bot(bot.id);
      if(!c)throw defer('Assigned node controls are offline or stale.');
      if(c.stopped||c.revision!==controlRevision)throw rejected('A newer Stop or control supersedes this burst.');
      if(b.threadId!==batch.threadId||b.archived||b.archiving||b.deletedAt)throw rejected('Original burst conversation changed.');
    };
    assertControl();let input=[],localMessages=[];
    try{
      if(!await runtime.reconcileCurrentActivity(bot.id))throw defer('Current native activity must reconcile before this burst.');
      const current=store.bot(bot.id),work=runtime.primary.work(current);
      if(!['ready','working'].includes(work.state))throw defer('Current native work or questions require attention first.');
      const queue=await runtime.codex.call('thread/queue/list',{threadId:bot.threadId,cursor:null,limit:100});
      if(!Array.isArray(queue?.data)||queue.data.length||queue.nextCursor)throw defer('Original native queued input must settle before this burst.');
      for(const f of files){
        if(!id(f.id)||!/^[a-f0-9]{64}$/.test(f.sha256??'')||!Number.isSafeInteger(f.size)||f.size<0)throw rejected('Invalid original registered file manifest.');
        if(!store.get('attachment',f.id)&&runtime.storage)await runtime.storage.importAttachment(current,f.id);
        const a=runtime.owned('attachment',f.id,bot.id);if(!a.ready||a.sha256!==f.sha256||a.size!==f.size)throw rejected('Original registered file checksum changed.');
      }
      for(const m of messages){
        const old=store.get('burstMessage',m.id);
        const retry=old&&batch.supersedes===old.batchId&&old.state==='failed'&&store.operation(old.batchId)?.outcome==='rejected'&&store.get('messageBurst',old.batchId)?.state==='failed'&&fingerprint({...burstSource(old),batchId:batch.id})===fingerprint(m);
        if(old&&!retry&&(fingerprint(burstSource(old))!==fingerprint(m)||!['pending','paused'].includes(old.state)))throw uncertain('Original local burst source changed or has already crossed admission.');
        if(m.reply){
          if(!store.get('replyReference',m.reply.id)){
            const result=await prepareReply(runtime,current,m.reply);if(!result.reply||fingerprint(result.reply)!==fingerprint(m.reply))throw rejected('Original quoted native source changed.');
          }ownedReply(runtime,current,m.reply);
        }
        const value=await runtime.messageInput(current,{text:m.text,attachments:m.attachmentIds,reply:m.reply});input.push(...value);localMessages.push({...m,input:value});assertControl();
      }
      if(input.filter(p=>p.type==='localImage').length>6)throw rejected('Original burst exceeds the six-image native boundary.');
      assertControl();
    }catch(error){if(!error.deferred&&error.outcome!=='uncertain')error.outcome='rejected';throw error;}
    const params={text:messages.map(m=>m.text).filter(Boolean).join('\n\n'),attachments:messages.flatMap(m=>m.attachmentIds)},attempt={started:false,rejected:false,beforeDispatch:assertControl};
    journal.prepare(command.operation_id);
    try{store.transaction(()=>{
      assertControl();if(store.operation(command.operation_id))throw uncertain('Original receipt appeared during preparation.');
      if(batch.supersedes){const old=store.get('messageBurst',batch.supersedes);if(old){if(store.operation(old.id)?.outcome!=='rejected'||old.state!=='failed')throw uncertain('Retained previous burst is not definitely rejected.');store.put('messageBurst',{...old,supersededBy:batch.id});}}
      store.put('messageBurst',{...batch,state:'dispatching',params,dueAt:null});
      for(const m of localMessages)store.put('burstMessage',{...m,state:'dispatching',turnId:null});
      if(messages.some(m=>m.reply))store.put('messageReply',{id:batch.id,botId:bot.id,threadId:bot.threadId,parts:messages});
      store.put('queuedAttachments',{id:batch.id,botId:bot.id,attachmentIds:params.attachments,immutable:true});
      store.saveOperation(batch.id,command.fingerprint,'dispatching',{method:'turn.send',botId:bot.id,params,portableFingerprint:command.fingerprint,portableBurst:true,createdAt:now()});
    });}catch(error){if(!store.operation(command.operation_id))error.outcome='rejected';throw error;}
    try{
      const result=await runtime.send(store.bot(bot.id),params,batch.id,null,attempt,false,null,input);
      return settleAgentBurst(runtime,command,result);
    }catch(error){
      const op=store.operation(batch.id);if(op?.status==='done')return op.result;
      const unknown=attempt.started&&!attempt.rejected;
      store.transaction(()=>{
        if(op?.portableFingerprint!==command.fingerprint)throw uncertain('Original burst receipt changed; retain uncertainty.');
        store.saveOperation(op.id,op.fingerprint,unknown?'uncertain':'failed',{...op,outcome:unknown?'uncertain':'rejected',error:error.message});
        store.put('messageBurst',{...store.get('messageBurst',batch.id),state:unknown?'uncertain':'failed',error:error.message});
        for(const m of messages)store.put('burstMessage',{...store.get('burstMessage',m.id),state:unknown?'uncertain':'failed'});
      });error.outcome=unknown?'uncertain':'rejected';throw error;
    }
  }));
}

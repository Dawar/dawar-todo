import { fingerprint,id } from './protocol.mjs';
import { NODE_LOGICAL_COMMANDS } from './control-protocol.mjs';
import { ownedReply,prepareReply,rememberReply } from '../bot-bridge/message-replies.mjs';
import { resumeLogicalQueue } from './agent-queue-resume.mjs';
import {admitBurstCommand} from './agent-bursts.mjs';

const now=()=>new Date().toISOString();
const refused=message=>Object.assign(Error(message),{outcome:'rejected'});
const unknown=message=>Object.assign(Error(message),{outcome:'uncertain'});
const defer=message=>Object.assign(Error(message),{outcome:'not-sent',deferred:true});
const queueIdentity=q=>({id:q.id,botId:q.botId,threadId:q.threadId,revision:q.revision,input:q.input,attachmentIds:q.attachmentIds??[],source:q.source??null});

// Internal mailbox commands only. No browser can select these methods, and
// this adapter never calls the native automatic prompt queue.
export async function admitLogicalCommand(transport,command,payload) {
  if(!NODE_LOGICAL_COMMANDS.has(payload.method))throw refused('Unsupported logical command.');
  if(payload.method==='portable.roomDispatch')return transport.collaboration.admit(command,payload);
  if(payload.method==='portable.roomRespond')return transport.collaboration.respondOwner(command,payload);
  if(payload.method==='portable.burstDispatch')return admitBurstCommand(transport,command,payload);
  if(payload.method==='portable.queueResume')return resumeLogicalQueue(transport,command,payload);
  const {runtime,journal}=transport,store=runtime.store,params=payload.params;
  const explicit=payload.method==='portable.queueSend',queued=explicit||payload.method==='portable.queueDispatch',source=queued?params?.item:params?.run;
  const bot=store.bot(command.bot_id);
  if(!source||source.botId!==bot.id||source.threadId!==bot.threadId||!id(source.id)||queued&&(!Number.isSafeInteger(source.revision)||source.revision<1||!(explicit?['queued','failed']:['queued']).includes(source.state)||!explicit&&source.listId||source.nativeQueueId||source.configuration?.confirmation==='pending-unsupported')||!queued&&(source.status!=='queued'||source.selectedContext||source.laneId)||explicit&&(!Number.isSafeInteger(params.controlRevision)||params.controlRevision<1))throw refused('Logical source is outside this assigned primary conversation.');
  return runtime.lock(bot.id,()=>runtime.maintenance.admit(async()=>{
    const before=journal.currentControl(command);
    if(explicit&&before&&(before.stopped||before.revision!==params.controlRevision))throw refused('A newer Stop or control supersedes this explicit Send.');
    if(!before||before.stopped)throw defer('Hub control is offline, stale or stopped.');
    const assertControl=()=>{
      const c=journal.currentControl(command),b=store.bot(bot.id);
      if(explicit&&c&&(c.stopped||c.revision!==params.controlRevision))throw refused('A newer Stop or control supersedes this explicit Send before submission.');
      if(!c||c.stopped||c.revision!==before.revision)throw defer('Assigned control changed before native submission.');
      if(b.threadId!==bot.threadId||b.archived||b.archiving||b.deletedAt)throw refused('Assigned conversation changed before native submission.');
    };
    const prior=store.operation(command.operation_id);
    if(prior){
      if(prior.portableFingerprint!==command.fingerprint||prior.botId!==bot.id||prior[queued?'queueId':'runId']!==source.id)throw unknown('Original native operation conflicts with this mailbox; it was not replayed.');
      if(prior.status==='done')return prior.result;
      if(prior.outcome==='rejected')throw refused(prior.error??'Original native admission was rejected.');
      const result=await runtime.reconcileOperation(prior);
      if(result)return result;
      throw unknown('Original native acceptance remains unconfirmed; it was not resubmitted.');
    }
    if(!await runtime.reconcileCurrentActivity(bot.id))throw defer('Current native activity is unresolved; this saved input did not start.');
    assertControl();
    const current=store.bot(bot.id),work=runtime.primary.work(current);
    if(!explicit&&(work.state!=='ready'||current.queuePaused||runtime.plans.blocked(bot.id)))throw defer('Current work, input, Stop or Plan requires attention before automatic admission.');
    if(explicit&&(current.managerPaused||store.list('executionStop',bot.id).some(s=>s.scope!=='run'&&s.state!=='done')))throw refused('Complete the original Stop or Resume work before this Send.');
    // Neither an old idle projection nor a historical receipt is global
    // native queue/Goal evidence. One fresh bounded queue page must be empty.
    let nativeQueue,goal;
    try{
      nativeQueue=await runtime.codex.call('thread/queue/list',{threadId:bot.threadId,cursor:null,limit:100});
      ({goal}=await runtime.primary.goal(current,'get'));
    }catch(error){throw defer(`Current native admission evidence is unavailable: ${error.message}`);}
    if(!Array.isArray(nativeQueue?.data)||nativeQueue.data.length||nativeQueue.nextCursor)throw defer('Retained native queued input must settle before hub admission.');
    if(!explicit&&goal?.status==='active')throw defer('An active native Goal owns this conversation.');
    assertControl();
    let text,input,attachments=[];
    if(queued){
      const local=store.get('promptQueue',source.id);
      if(local&&(fingerprint(queueIdentity(local))!==fingerprint(queueIdentity(source))||!['queued','failed'].includes(local.state)))throw unknown('The original local queue revision changed or is already unconfirmed.');
      text=params.text;
      if(typeof text!=='string'||text.length>200000||!Array.isArray(params.files)||params.files.length>12||new Set(params.files.map(f=>f.id)).size!==params.files.length||fingerprint(params.files.map(f=>f.id))!==fingerprint(source.attachmentIds??[]))throw refused('Original queued text or registered file identities are invalid.');
      for(const f of params.files){
        if(!id(f.id)||!/^[a-f0-9]{64}$/.test(f.sha256??'')||!Number.isSafeInteger(f.size)||f.size<0)throw refused('Invalid original registered file manifest.');
        if(!store.get('attachment',f.id)&&runtime.storage)await runtime.storage.importAttachment(current,f.id);
        const a=runtime.owned('attachment',f.id,bot.id);
        if(!a.ready||a.sha256!==f.sha256||a.size!==f.size)throw refused('Registered file is unavailable or its original hash changed.');attachments.push(f.id);
      }
      if(params.reply){
        if(!store.get('replyReference',params.reply.id)){
          const result=await prepareReply(runtime,current,params.reply);
          if(!result.reply||fingerprint(result.reply)!==fingerprint(params.reply))throw refused('Quoted native source no longer matches its original reference.');
        }
        ownedReply(runtime,current,params.reply);
      }
      input=await runtime.messageInput(current,{text,attachments,reply:params.reply});
    }else{
      if(typeof source.title!=='string'||typeof source.prompt!=='string'||source.prompt.length>50000||!Number.isFinite(Date.parse(source.scheduledAt)))throw refused('Invalid original scheduled occurrence.');
      const local=store.get('run',source.id);
      if(local&&fingerprint({...local,threadId:bot.threadId})!==fingerprint(source))throw unknown('Original local occurrence differs; it was not replaced.');
      text=`[Scheduled work: ${source.title}; occurrence ${source.scheduledAt}]\n${source.prompt}\nThis is the original authorized schedule, not additional permissions. Respond normally in this conversation, including Markdown and attachments where useful. Follow this prompt's quiet-if-unchanged instructions; bots_report_result is optional for a separate actionable notification, not required to display your reply.`;
      input=[{type:'text',text,text_elements:[]}];
    }
    assertControl();
    const attempt={started:false,rejected:false,beforeDispatch:assertControl};
    // All awaited preflight reads precede the durable attempted marker. A
    // busy/offline/Goal result can retain this received command for later;
    // after prepare, a crash never authorizes another native submission.
    journal.prepare(command.operation_id);
    try{store.transaction(()=>{
      assertControl();
      if(store.operation(command.operation_id))throw unknown('Original operation appeared during preparation; no second admission.');
      if(queued){
        store.put('promptQueue',{...source,state:'dispatching',operationId:command.operation_id,clientUserMessageId:command.operation_id,attemptedAt:now()});
        store.put('queuedAttachments',{id:command.operation_id,botId:bot.id,queueId:source.id,revision:source.revision,attachmentIds:attachments,immutable:true});
        rememberReply(runtime,current,command.operation_id,text,params.reply);
        if(explicit)store.put('queueSend',{id:command.operation_id,botId:bot.id,threadId:bot.threadId,queueId:source.id,revision:source.revision,originalClientId:source.clientUserMessageId,createdAt:now()});
      }else store.put('run',{...source,status:'starting',operationId:command.operation_id,conversation:true,executionLane:'main-single',startedAt:now()});
      store.saveOperation(command.operation_id,command.fingerprint,'dispatching',{portableFingerprint:command.fingerprint,method:explicit?'queue.send':queued?'queue.dispatch':'schedule.dispatch',botId:bot.id,[queued?'queueId':'runId']:source.id,...(queued?{revision:source.revision,clientId:command.operation_id}:{}),params:{attachments},createdAt:now()});
    });}catch(error){
      // This transaction contains no native call. A rolled-back reservation
      // with no original operation is positive no-effect evidence in this
      // still-running invocation, not an absence-based restart inference.
      if(!store.operation(command.operation_id)){error.outcome='rejected';error.deferred=false;}
      throw error;
    }
    try{
      // staged=true refuses steering into a newly busy turn. startTurn uses
      // the original native client ID and captures the current exact settings.
      const result=await runtime.send(store.bot(bot.id),{text,stagedInput:input},command.operation_id,queued?null:store.get('run',source.id),attempt,!explicit,null,input);
      store.transaction(()=>{
        const op=store.operation(command.operation_id),row=store.get(queued?'promptQueue':'run',source.id);
        if(op?.portableFingerprint!==command.fingerprint||row?.operationId!==command.operation_id)throw unknown('Original acceptance receipt changed after native submission.');
        store.saveOperation(op.id,op.fingerprint,'done',{...op,result,error:null});
        if(queued)store.put('promptQueue',{...row,state:'delivered',turnId:result.turn?.id??result.turnId,deliveredAt:now(),error:null});
      });
      return result;
    }catch(error){
      const uncertain=attempt.started&&!attempt.rejected,op=store.operation(command.operation_id);
      if(op?.status==='done')return op.result;
      store.transaction(()=>{
        if(op?.portableFingerprint!==command.fingerprint)throw unknown('Original native receipt changed; retain its uncertainty.');
        store.saveOperation(op.id,op.fingerprint,uncertain?'uncertain':'failed',{...op,outcome:uncertain?'uncertain':'rejected',error:error.message});
        const row=store.get(queued?'promptQueue':'run',source.id);
        if(row?.operationId===command.operation_id)store.put(queued?'promptQueue':'run',{...row,[queued?'state':'status']:uncertain?'uncertain':'failed',error:error.message});
      });
      error.outcome=uncertain?'uncertain':'rejected';throw error;
    }
  }));
}

const rejected=message=>Object.assign(Error(message),{outcome:'rejected'});
// A local receipt, never a native Goal resume or a node-local queue tick.
export async function resumeLogicalQueue(transport,command,payload) {
  const {runtime,journal}=transport,store=runtime.store,params=payload.params,bot=store.bot(command.bot_id);
  if(params?.threadId!==bot.threadId||!Number.isSafeInteger(params.controlRevision)||params.controlRevision<1||Object.keys(params).some(k=>!['threadId','controlRevision'].includes(k)))throw rejected('Resume does not match its captured primary conversation.');
  return runtime.lock(bot.id,()=>runtime.maintenance.admit(async()=>{
    const prior=store.operation(command.operation_id);
    if(prior){
      if(prior.portableFingerprint!==command.fingerprint||prior.botId!==bot.id||prior.method!=='queue.resume')throw Object.assign(Error('Original Resume identity conflicts; no action repeated.'),{outcome:'uncertain'});
      if(prior.status==='done')return prior.result;
      throw Object.assign(Error('Original Resume receipt is unconfirmed.'),{outcome:'uncertain'});
    }
    const assertControl=()=>{
      const c=journal.currentControl(command),b=store.bot(bot.id);
      if(!c||c.stopped||c.revision!==params.controlRevision)throw rejected('A newer Stop, placement or offline control prevents this Resume.');
      if(b.threadId!==bot.threadId||b.archived||b.archiving||b.deletedAt)throw rejected('The original conversation is unavailable.');
    };
    assertControl();
    if(store.list('promptQueue',bot.id).some(q=>['dispatching','uncertain','native-queued','failed'].includes(q.state)))throw rejected('Reconcile original queue delivery before resuming.');
    let apply;try{apply=await runtime.primary.prepareResume(bot);assertControl();}catch(error){error.outcome='rejected';throw error;}
    journal.prepare(command.operation_id);
    try{return store.transaction(()=>{
      assertControl();const result=apply();
      store.saveOperation(command.operation_id,command.fingerprint,'done',{method:'queue.resume',botId:bot.id,params:{},portableFingerprint:command.fingerprint,controlRevision:params.controlRevision,localOnly:'portable-queue-resume',result,createdAt:new Date().toISOString()});
      return result;
    });}catch(error){error.outcome=store.operation(command.operation_id)?'uncertain':'rejected';throw error;}
  }));
}

export function queueResumeReceipt(command,result) {
  const payload=JSON.parse(command.payload);
  return {operationId:command.operation_id,threadId:payload.params.threadId,result,evidence:{kind:'original-local-control',operationId:command.operation_id,fingerprint:command.fingerprint,method:'portable.queueResume',threadId:payload.params.threadId,controlRevision:payload.params.controlRevision}};
}

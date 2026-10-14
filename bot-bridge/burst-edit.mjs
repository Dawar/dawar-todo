// Owner-local, synchronous reservations. Native input/receipt authority is never
// changed by the display/editor handoff. Called in ordinary local transactions.
const fail = text => { throw Error(text); };
const keys = (v, allowed) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => allowed.includes(k));
const changed = (runtime,botId,threadId,operationId) => {
  runtime.emitEvent('burst.edit',{threadId,operationId},botId);
  runtime.store.afterCommit(()=>runtime.bursts.arm(botId));
};
export function checkoutBurst(runtime, bot, p, operationId) {
  if (!keys(p, ['threadId','controlRevision','destinationId','batches']) || typeof p.threadId !== 'string' || !p.threadId ||
      typeof p.destinationId !== 'string' || !/^[a-zA-Z0-9:_-]{10,100}$/.test(p.destinationId) ||
      !Number.isSafeInteger(p.controlRevision) || p.controlRevision < 0 || !Array.isArray(p.batches) || !p.batches.length || p.batches.length > 200 ||
      p.batches.some(b => !keys(b,['id','revision']) || typeof b.id !== 'string' || !b.id || b.id.length > 200 || !Number.isSafeInteger(b.revision) || b.revision < 1) || new Set(p.batches.map(b => b.id)).size !== p.batches.length) fail('Select the exact unsent blast and its current revisions.');
  const current = runtime.store.bot(bot.id);
  if (current.threadId !== p.threadId || current.deletedAt || current.archived || current.archiving) fail('This conversation changed. Nothing was taken out of delivery.');
  if ((runtime.store.get('burstControl',bot.id)?.revision ?? 0) !== p.controlRevision) fail('The blast control changed. Review its current state.');
  const batches = p.batches.map(source => {
    const b = runtime.store.get('messageBurst', source.id), plan = runtime.store.get('planExecution',source.id);
    if (b?.botId !== bot.id || b.threadId !== p.threadId || b.revision !== source.revision || b.supersededBy ||
        !['pending','preparing','paused'].includes(b.state) || runtime.store.operation(b.id) || runtime.hub?.db.prepare('SELECT 1 FROM portable_mailbox WHERE operation_id=?').get(b.id) || plan?.dispatchFence || plan?.turnId || !Array.isArray(b.messageIds) || !b.messageIds.length)
      fail('A blast changed or already began delivery. It was not returned to the editor.');
    return b;
  });
  const all = runtime.bursts.batches(bot.id).filter(b => ['pending','preparing','paused'].includes(b.state));
  if (all.length !== batches.length || all.some(b => !batches.some(selected => selected.id === b.id))) fail('New unsent messages arrived. Refresh before editing the whole blast.');
  batches.sort((a,b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const sources = batches.flatMap(b => b.messageIds.map(id => {
    const m = runtime.store.get('burstMessage', id);
    if (m?.botId !== bot.id || m.batchId !== b.id || m.state !== 'pending' || m.dismissed || typeof m.text !== 'string' || !Array.isArray(m.attachmentIds)) fail('The original message source is unavailable. Nothing was moved.');
    return m;
  }));
  if (!sources.length || sources.length > 200 || new Set(sources.map(m => m.id)).size !== sources.length || sources.reduce((n,m)=>n+Buffer.byteLength(m.text),0)>1024*1024) fail('The blast exceeds the original pending limits.');
  const blocked=reason=>{
    for(const b of batches)runtime.store.put('messageBurst',{...b,state:'paused',dueAt:null,revision:b.revision+1});
    changed(runtime,bot.id,p.threadId,operationId);
    return {blocked:{operationId,botId:bot.id,params:p,held:true,reason}};
  };
  const attachments=[];
  for(const id of new Set(sources.flatMap(m=>m.attachmentIds))) {
    let f;try{f=runtime.owned('attachment',id,bot.id);}catch{return blocked('Blast held: a registered file is unavailable. Restore the file before Edit, or use its original Send recovery.');}
    if(f?.id!==id||f.botId!==bot.id||!f.ready||f.deletedAt)return blocked('Blast held: a registered file is unavailable. Restore the file before Edit, or use its original Send recovery.');
    attachments.push(f);
  }
  const checkout = {operationId,botId:bot.id,params:p,messages:sources.map(({id,botId,text,attachmentIds,createdAt,batchId,turnId,reply})=>({id,botId,text,attachmentIds,createdAt,batchId,turnId,state:'editing',...(reply?{reply}:{})})),attachments};
  if (Buffer.byteLength(JSON.stringify(checkout))>1024*1024-4096) return blocked('Blast held: the complete Edit receipt exceeds the transport bound. Original messages and files remain saved; Send now remains deliberate.');
  for (const b of batches) runtime.store.put('messageBurst',{...b,state:'editing',dueAt:null,revision:b.revision+1,editOperationId:operationId,editDestinationId:p.destinationId});
  for (const m of sources) runtime.store.put('burstMessage',{...m,state:'editing',editOperationId:operationId});
  changed(runtime,bot.id,p.threadId,operationId);
  return {checkout};
}
export function readBurstCheckout(runtime, bot, p) {
  if (!keys(p,['operationId','threadId','destinationId']) || typeof p.operationId !== 'string') fail('The original Edit receipt is required.');
  const op=runtime.store.operation(p.operationId), r=op?.result?.checkout;
  if (op?.method !== 'bursts.checkout' || op.botId !== bot.id || op.status !== 'done' || r?.botId !== bot.id ||
      r.params.threadId !== p.threadId || r.params.destinationId !== p.destinationId || runtime.store.bot(bot.id).threadId !== p.threadId) fail('This Edit belongs to its original conversation and browser draft.');
  return {checkout:r};
}
export function commitBurstCheckout(runtime,bot,p) {
  const {checkout:r}=readBurstCheckout(runtime,bot,p);
  for (const m of r.messages) {
    const source=runtime.store.get('burstMessage',m.id), b=runtime.store.get('messageBurst',m.batchId);
    if (source?.botId!==bot.id || source.editOperationId!==r.operationId || !['editing','edited'].includes(source.state) ||
        b?.botId!==bot.id || b.editOperationId!==r.operationId || !['editing','edited'].includes(b.state)) fail('The original Edit source changed. Keep its saved draft and receipt.');
  }
  for (const m of r.messages) runtime.store.put('burstMessage',{...runtime.store.get('burstMessage',m.id),state:'edited',editedAt:new Date().toISOString()});
  for (const b of r.params.batches) runtime.store.put('messageBurst',{...runtime.store.get('messageBurst',b.id),state:'edited',dueAt:null});
  changed(runtime,bot.id,r.params.threadId,r.operationId);
  return {operationId:r.operationId,botId:bot.id,threadId:r.params.threadId,destinationId:r.params.destinationId,committed:true};
}

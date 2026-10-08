import { createHash } from 'node:crypto';
import { enqueuePrompt } from './prompt-queue.mjs';
import { ownedList } from './queue-lists.mjs';

/** Called within the local acceptance transaction: no await/native dispatch. */
export function queueHeldBurst(runtime, bot, params, operationId) {
  const {threadId, controlRevision, messages, listId = null} = params;
  if (Object.keys(params).some(key => !['threadId','controlRevision','messages','listId'].includes(key)) ||
      typeof threadId !== 'string' || !threadId || !Number.isSafeInteger(controlRevision) || controlRevision < 1 ||
      !Array.isArray(messages) || !messages.length || messages.length > 200 || messages.some(value => !value ||
        Object.keys(value).some(key => !['id','batchId','revision'].includes(key)) ||
        typeof value.id !== 'string' || !value.id || value.id.length > 200 || typeof value.batchId !== 'string' || !value.batchId ||
        !Number.isSafeInteger(value.revision) || value.revision < 1) || new Set(messages.map(value => value.id)).size !== messages.length)
    throw Error('Select the exact held messages and their current revisions.');
  const current = runtime.store.bot(bot.id), control = runtime.store.get('burstControl', bot.id);
  if (current.deletedAt || current.archived || current.archiving || current.threadId !== threadId)
    throw Error('This conversation changed. The original messages remain held.');
  if (!control?.paused || control.revision !== controlRevision)
    throw Error('The burst hold changed. Pause and review the original messages again.');
  ownedList(runtime, bot.id, listId);
  const selected = messages.map(source => {
    const message = runtime.store.get('burstMessage', source.id), batch = runtime.store.get('messageBurst', source.batchId);
    const reservation = batch && runtime.store.operation(batch.id), plan = batch && runtime.store.get('planExecution', batch.id);
    if (message?.botId !== bot.id || message.batchId !== source.batchId || message.state !== 'pending' ||
        batch?.botId !== bot.id || batch.threadId !== threadId || batch.state !== 'paused' || batch.supersededBy ||
        batch.revision !== source.revision || !batch.messageIds.includes(source.id) || reservation || plan?.dispatchFence || plan?.turnId)
      throw Error('A selected message changed or already began delivery. Nothing was queued; refresh the held messages.');
    if (!Array.isArray(message.input) || !Array.isArray(message.attachmentIds)) throw Error('The saved message input is unavailable. Nothing was queued.');
    for (const id of message.attachmentIds) {
      const file = runtime.store.get('attachment', id);
      if (file?.botId !== bot.id || !file.ready || file.deletedAt) throw Error('A saved attachment is unavailable. The original messages remain held.');
    }
    return {message, batch};
  });
  // The browser cannot reorder or replace the accepted message text/files.
  selected.sort((a,b) => (a.batch.sequence ?? 0) - (b.batch.sequence ?? 0) ||
    a.batch.messageIds.indexOf(a.message.id) - b.batch.messageIds.indexOf(b.message.id));
  // Reuse ordinary queue storage/reply registration, but publish this atomic
  // transfer once. A 200-message selection must not trigger 200 queue refetches.
  const queueRuntime = {store:runtime.store, emitEvent:() => {}, publicQueued:(_bot,item) => ({id:item.id})};
  let position = Math.max(0, Number(runtime.store.db.prepare(`SELECT COALESCE(MAX(json_extract(json,'$.position')),0) n
    FROM records WHERE kind='promptQueue' AND bot_id=? AND COALESCE(json_extract(json,'$.listId'),'')=?
    AND json_extract(json,'$.state') IN ('queued','dispatching','uncertain','failed')`).get(bot.id,listId ?? '').n));
  if (!Number.isSafeInteger(position + selected.length)) throw Error('Queue ordering is unavailable. The original messages remain held.');
  const items = selected.map(({message, batch}) => {
    const id = `burst-queue:${createHash('sha256').update(JSON.stringify([operationId,message.id])).digest('hex')}`;
    if (runtime.store.get('promptQueue', id)) throw Error('Queue identity already exists without its confirmed transfer receipt. Reconcile the original action.');
    const source = {kind:'burst', operationId, burstMessageId:message.id, batchId:batch.id, sourceRevision:batch.revision};
    enqueuePrompt(queueRuntime, current, {text:message.text, attachments:message.attachmentIds, reply:message.reply, listId}, id, message.input, source, ++position);
    runtime.store.put('burstMessage', {...message, state:'queued', queueId:id, queueOperationId:operationId, queuedAt:new Date().toISOString()});
    return {messageId:message.id, queueId:id};
  });
  for (const batch of new Map(selected.map(value => [value.batch.id,value.batch])).values()) {
    const removed = new Set(selected.filter(value => value.batch.id === batch.id).map(value => value.message.id));
    const remaining = batch.messageIds.filter(id => !removed.has(id));
    runtime.store.put('messageBurst', {...batch, messageIds:remaining, revision:batch.revision+1,
      state:remaining.length?'paused':'queued', dueAt:null, queueOperationId:operationId,
      queuedMessageIds:[...(batch.queuedMessageIds ?? []),...removed]});
  }
  runtime.emitEvent('queue',{},bot.id);
  runtime.bursts.publish(bot.id);
  return {...runtime.bursts.read(current), transfer:{operationId, botId:bot.id, threadId, controlRevision, listId, items}};
}

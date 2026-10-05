import { copyReplyReceipt } from './message-replies.mjs';
import { finishLocalOperation } from './prompt-queue.mjs';

const now = () => new Date().toISOString();
function selected(runtime, bot, params) {
  if (typeof params.id !== 'string' || !params.id || params.id.length > 200 || Object.keys(params).some(key => !['id', 'expectedRevision'].includes(key)))
    throw Error('Choose one saved queued message to send.');
  const item = runtime.store.get('promptQueue', params.id);
  if (!item || item.botId !== bot.id || item.threadId !== bot.threadId)
    throw Error('This queued message is not in this conversation. Refresh the queue.');
  if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 1 || item.revision !== params.expectedRevision)
    throw Error('This message changed. Refresh the queue before sending it.');
  if (!['queued', 'failed'].includes(item.state) || item.nativeQueueId)
    throw Error('This message may already be starting. Refresh to check its original delivery.');
  if (bot.archived || bot.archiving) throw Error('Restore this bot first.');
  return item;
}

/** A human per-item Send, not a list flush. Runs under the existing bot lock.
 * Native-accepted input is never removed/recreated. Freeze before a native call,
 * then reconcile its exact receipt rather than repeating unknown delivery.
 */
export async function sendQueuedPrompt(runtime, bot, params, operationId, attempt) {
  const original = selected(runtime, bot, params);
  const savedReply = runtime.store.get('messageReply', original.clientUserMessageId);
  if (savedReply && (savedReply.botId !== bot.id || savedReply.threadId !== bot.threadId))
    throw Error('The saved message belongs to another conversation.');
  const savedFiles = runtime.store.get('queuedAttachments', original.clientUserMessageId);
  if (savedFiles && savedFiles.botId !== bot.id) throw Error('The saved files belong to another bot.');
  const attachments = [...(original.attachmentIds ?? savedFiles?.attachmentIds ?? [])];
  // Legacy local records lack a plain-text receipt. Never silently drop their
  // file inputs when registered attachment metadata is unavailable.
  if (!attachments.length && original.input.some(part => part.type !== 'text' || part.text.startsWith('Attached file: ')))
    throw Error('The saved files could not be resolved. Edit this message to recover them before sending.');
  const text = savedReply?.text ?? original.input.filter(part => part.type === 'text' && !part.text.startsWith('Attached file: ')).map(part => part.text).join('\n');
  // Revalidate/materialize the original file IDs and exact reply on the bridge.
  // Browser supplies only the record ID/revision, never replacement content.
  const input = await runtime.messageInput(bot, { text, attachments, reply: savedReply?.reply });
  runtime.store.transaction(() => {
    const currentBot = runtime.store.bot(bot.id);
    if (currentBot.threadId !== bot.threadId) throw Error('This conversation changed while preparing the message. Refresh the queue.');
    const current = selected(runtime, currentBot, params);
    // This durable metadata receipt proves reservation and survives queue
    // checkout/Stop history. Its absence after a restart proves no native call
    // could have happened; the outer RPC journal alone is not a send receipt.
    runtime.store.put('queueSend', { id: operationId, botId: bot.id, threadId: bot.threadId,
      queueId: original.id, revision: original.revision, originalClientId: original.clientUserMessageId, createdAt: now() });
    copyReplyReceipt(runtime, bot, original.clientUserMessageId, operationId);
    runtime.store.put('queuedAttachments', { id: operationId, botId: bot.id, queueId: original.id,
      revision: original.revision, attachmentIds: attachments, immutable: true });
    runtime.store.put('promptQueue', { ...current, input, attachmentIds: attachments, state: 'dispatching',
      operationId, clientUserMessageId: operationId, dispatchKind: 'send-now', attemptedAt: now(), error: null });
    runtime.emitEvent('queue', {}, bot.id);
  });
  try {
    // Normal human Send: start an idle thread or steer the current turn, with
    // existing answer/Plan/current-activity/Stop fencing unchanged.
    const result = await runtime.send(runtime.store.bot(bot.id), { text, attachments }, operationId, null, attempt, false, null, input);
    if (!result?.turn?.id && !result?.turnId) throw Error('Send acknowledgement has no matching turn.');
    return runtime.store.transaction(() => {
      runtime.store.put('promptQueue', { ...runtime.store.get('promptQueue', original.id),
        state: 'delivered', turnId: result.turn?.id ?? result.turnId, deliveredAt: now(), error: null });
      finishLocalOperation(runtime.store, operationId, result);
      runtime.emitEvent('queue', {}, bot.id);
      return result;
    });
  } catch (error) {
    if (runtime.store.operation(operationId)?.status === 'done') return runtime.store.operation(operationId).result;
    const uncertain = attempt.started && !attempt.rejected;
    runtime.store.transaction(() => {
      const current = runtime.store.get('promptQueue', original.id);
      // Unknown outcomes stay frozen under the same ID. Only proven no-submit
      // or rejection restores the original queued input for another human Send.
      runtime.store.put('promptQueue', uncertain ? { ...current, state: 'uncertain', error: error.message }
        : { ...original, state: 'failed', error: error.message });
      runtime.emitEvent('queue', {}, bot.id);
    });
    throw error;
  }
}

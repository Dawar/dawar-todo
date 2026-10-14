import type { BurstQueueParams } from '../../lib/burst-queue';
import type { BurstState } from './single-thread-contract';
import { retainedBatches, validBurstState } from './burst-state';

export function captureHeldBurst(value: BurstState, botId: string, threadId: string): Omit<BurstQueueParams,'listId'> {
  if (!validBurstState(value,botId) || value.paused !== true || value.threadId !== threadId ||
      !Number.isSafeInteger(value.controlRevision) || (value.controlRevision ?? 0) < 1 || value.batches === undefined)
    throw Error('The server hold could not be verified. These messages remain saved; refresh delivery.');
  const batches = retainedBatches(value);
  if (batches.some(batch => ['dispatching','uncertain','preparing'].includes(batch.state)))
    throw Error('Earlier delivery already began or is unconfirmed. No message was queued again; the remaining messages stay paused.');
  const messages = batches.filter(batch => batch.state === 'paused').flatMap(batch => {
    if (!Number.isSafeInteger(batch.revision) || (batch.revision ?? 0) < 1) throw Error('Held message revisions are unavailable. Nothing was queued.');
    return batch.messageIds.map(id => {
      if (!value.messages.some(message => message.id === id && message.batchId === batch.id && message.state === 'pending'))
        throw Error('Held messages changed. Nothing was queued; refresh delivery.');
      return {id,batchId:batch.id,revision:batch.revision!};
    });
  });
  if (!messages.length || messages.length > 200 || new Set(messages.map(message => message.id)).size !== messages.length)
    throw Error('No confirmed unsent messages remain to queue. Delivery may already have begun.');
  return {threadId,controlRevision:value.controlRevision!,messages};
}

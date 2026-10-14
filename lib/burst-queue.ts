/** Owner-only local transfer. The server resolves all source text/files. */
export type BurstQueueParams = {threadId: string; controlRevision: number; messages: {id: string; batchId: string; revision: number}[]; listId: string | null};
export type BurstQueueReceipt = {operationId: string; botId: string; threadId: string; controlRevision: number; listId: string | null; items: {messageId: string; queueId: string}[]};
export function validBurstQueueReceipt(value: unknown, operationId: string, botId: string, params: BurstQueueParams): value is BurstQueueReceipt {
  const receipt = value as BurstQueueReceipt | null;
  if (!receipt || receipt.operationId !== operationId || receipt.botId !== botId || receipt.threadId !== params.threadId ||
      receipt.controlRevision !== params.controlRevision || receipt.listId !== params.listId || !Array.isArray(receipt.items) || receipt.items.length !== params.messages.length) return false;
  const ids = new Set(receipt.items.map(item => item?.messageId)), queues = new Set(receipt.items.map(item => item?.queueId));
  return ids.size === params.messages.length && queues.size === params.messages.length && params.messages.every(message => ids.has(message.id)) &&
    receipt.items.every(item => typeof item.queueId === 'string' && /^burst-queue:[a-f0-9]{64}$/.test(item.queueId));
}

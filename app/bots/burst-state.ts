import type { Burst, BurstMessage, BurstState } from './single-thread-contract';

// The server admits at most 200 pending messages (therefore 200 open batches),
// plus at most 50 recent sent records. Keep every open batch, not just `burst`.
const MAX_RECORDS = 250;
export type SavedBurstState = BurstState & { preview?: { messageCount: number; truncatedTextIds: string[] } };
export const retainedBatches = (value: BurstState | null): Burst[] => value?.batches ?? (value?.burst ? [value.burst] : []);
export function validBurstState(value: BurstState, botId: string) {
  return Array.isArray(value?.messages) && value.messages.length <= MAX_RECORDS && value.messages.every(message => message.botId === botId)
    && (value.attachments === undefined || Array.isArray(value.attachments) && value.attachments.length <= 3000 && value.attachments.every(file => file.botId === botId))
    && (!value.burst || value.burst.botId === botId) && (value.batches === undefined || Array.isArray(value.batches))
    && retainedBatches(value).length <= MAX_RECORDS && retainedBatches(value).every(batch => batch.botId === botId && Array.isArray(batch.messageIds) && batch.messageIds.length <= 200);
}
export function pendingMessageCount(value: SavedBurstState | null) {
  const dismissed = new Set(value?.messages.filter(message => message.dismissed || message.state === 'discarded').map(message => message.id));
  const ids = new Set(retainedBatches(value).filter(batch => !['sent', 'discarded'].includes(batch.state)).flatMap(batch => batch.messageIds).filter(id => !dismissed.has(id)));
  for (const message of value?.messages ?? []) if (!message.dismissed && !['sent', 'discarded'].includes(message.state)) ids.add(message.id);
  return Math.max(ids.size, value?.preview?.messageCount ?? 0);
}
/** Disposable previews, never the submitted inputs/receipts. Metadata/counts for
 * every retained batch survive even when most message bodies are not cached. */
export function savedBurstState(value: SavedBurstState): SavedBurstState {
  const truncated = new Set(value.preview?.truncatedTextIds ?? []);
  const retained = [...value.messages.filter(message => message.state !== 'sent').slice(0, 24), ...value.messages.filter(message => message.state === 'sent').slice(-12)];
  const messages = retained.map(message => {
    if (message.text.length <= 2000) return message;
    truncated.add(message.id); return { ...message, text: message.text.slice(0, 2000) };
  });
  const fileIds = new Set(messages.flatMap(message => message.attachmentIds));
  return { threadId:value.threadId, controlRevision:value.controlRevision, paused: value.paused, burst: value.burst, batches: value.batches, messages, attachments: value.attachments?.filter(file => fileIds.has(file.id)),
    preview: { messageCount: pendingMessageCount(value), truncatedTextIds: messages.filter(message => truncated.has(message.id)).map(message => message.id) } };
}

/** A positive submit receipt is enough to show staging, never native delivery.
 * A later event/read remains authoritative and cannot be rolled back by ACK. */
export function acknowledgedBurst(value: SavedBurstState | null, result: unknown, botId: string, threadId: string): SavedBurstState | null {
  if (!result || typeof result !== 'object' || value?.threadId && value.threadId !== threadId) return value;
  const { message, burst } = result as { message?: BurstMessage; burst?: Burst };
  if (!message || !burst || message.botId !== botId || burst.botId !== botId || typeof message.id !== 'string'
    || typeof burst.id !== 'string' || message.batchId !== burst.id || typeof message.text !== 'string'
    || !Number.isFinite(Date.parse(message.createdAt)) || !Array.isArray(message.attachmentIds) || !message.attachmentIds.every(id => typeof id === 'string')
    || !Array.isArray(burst.messageIds) || !burst.messageIds.includes(message.id) || !Number.isSafeInteger(burst.revision)
    || !['pending', 'paused'].includes(burst.state) || message.state !== 'pending') return value;
  if (value?.messages.some(saved => saved.id === message.id)) return value;
  const batches = retainedBatches(value), previous = batches.find(saved => saved.id === burst.id);
  // Never replace dispatch, terminal, uncertainty or a newer pause revision.
  if (previous && (!['pending', 'paused'].includes(previous.state) || (previous.revision ?? 0) >= (burst.revision ?? 0)
    || previous.messageIds.some(id => !burst.messageIds.includes(id)))) return value;
  const next: SavedBurstState = { ...value, threadId, messages: [...value?.messages ?? [], message],
    batches: previous ? batches.map(saved => saved.id === burst.id ? burst : saved) : [...batches, burst],
    burst: burst, paused: value?.paused === true || burst.state === 'paused' };
  return validBurstState(next, botId) ? next : value;
}

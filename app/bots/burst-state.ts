import type { Burst, BurstState } from './single-thread-contract';

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
  const messages = value.messages.filter(message => message.state !== 'sent').slice(0, 24).map(message => {
    if (message.text.length <= 2000) return message;
    truncated.add(message.id); return { ...message, text: message.text.slice(0, 2000) };
  });
  const fileIds = new Set(messages.flatMap(message => message.attachmentIds));
  return { burst: value.burst, batches: value.batches, messages, attachments: value.attachments?.filter(file => fileIds.has(file.id)),
    preview: { messageCount: pendingMessageCount(value), truncatedTextIds: messages.filter(message => truncated.has(message.id)).map(message => message.id) } };
}

import { humanInput } from '../../lib/bot-conversation';
import { historyKey, type HistoryEntry } from '../../lib/bot-history-view';
import type { BotBurstMessage } from '../../lib/bots-types';
import { orderedHistory, reconcileHistory } from './history-reconcile';

/** Positions describe this bounded loaded chronology, never the full thread. */
export type MessageTick = {
  id: string; key: string; partId?: string;
  preview: string; seconds: number | null; position: number;
};
export type HumanMessageTick = MessageTick & { entry: HistoryEntry; partId?: string };
type TickMessage = Pick<BotBurstMessage, 'id' | 'botId' | 'text' | 'createdAt'> & { state?: string; dismissed?: boolean };
const preview = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Message with attachments';
const time = (seconds: number | null | undefined) => typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds : null;

export function humanMessageTicks(entries: HistoryEntry[], context: HistoryEntry[], botId: string, threadId: string | null | undefined,
  parts: (entry: HistoryEntry) => TickMessage[] | undefined = entry => entry.replyMessages) {
  // Native/client identity reconciles provisional and context aliases. Equal
  // text is never deduplication, and unaccepted composer/queue rows are absent.
  const loaded = reconcileHistory(orderedHistory(entries, context, false, Infinity)).entries.filter(entry => threadId && entry.sourceThreadId === threadId);
  const result: HumanMessageTick[] = [];
  loaded.forEach((entry, index) => {
    if (!entry.item || !humanInput(entry.item) || entry.type !== 'userMessage' || entry.peer || entry.peerAlias || entry.status === 'received') return;
    const key = historyKey(entry.turnId, entry.id);
    const messages = parts(entry)?.filter(message => message.botId === botId && !message.dismissed && message.state !== 'discarded');
    if (messages?.length) {
      const seen = new Set<string>();
      messages.forEach((message, part) => {
        if (seen.has(message.id)) return; seen.add(message.id);
        result.push({ id: JSON.stringify([key, message.id]), key, entry, partId: message.id,
          preview: preview(message.text), seconds: time(Date.parse(message.createdAt) / 1000),
          position: (index + part / messages.length) / Math.max(1, loaded.length) });
      });
    } else if (entry.item.type === 'userMessage') result.push({ id: JSON.stringify([key]), key, entry,
      preview: preview(entry.item.content.flatMap(part => part.type === 'text' && !part.text.startsWith('Attached file: ') ? [part.text] : []).join(' ')),
      seconds: time(entry.messageAt ?? entry.startedAt), position: index / Math.max(1, loaded.length) });
  });
  return { ticks: result, order: new Map(loaded.map((entry, index) => [historyKey(entry.turnId, entry.id), index / Math.max(1, loaded.length)])) };
}

/** Authenticated room post provenance, never native or bot authorship guesses. */
export function roomHumanMessageTicks(posts: import('../../lib/bot-collaboration').CollaborationPost[], roomId: string) {
  const loaded = [...new Map(posts.filter(post => post.roomId === roomId).map(post => [post.id, post])).values()];
  const key = (post: typeof loaded[number]) => JSON.stringify([roomId, post.id]);
  return { ticks: loaded.flatMap((post, index): MessageTick[] => post.author.kind === 'owner' ? [{ id: key(post), key: key(post),
    preview: preview(post.text), seconds: time(Date.parse(post.createdAt) / 1000), position: index / Math.max(1, loaded.length) }] : []),
    order: new Map(loaded.map((post, index) => [key(post), index / Math.max(1, loaded.length)])) };
}

/** One nonoverlapping hit target per slot; dense messages keep exact choices. */
export function tickBuckets<T extends MessageTick>(ticks: T[], slots: number) {
  const groups = new Map<number, T[]>();
  const count = Math.max(1, Math.floor(slots));
  for (const tick of ticks) {
    const slot = Math.min(count - 1, Math.floor(tick.position * count));
    const group = groups.get(slot) ?? []; group.push(tick); groups.set(slot, group);
  }
  return [...groups].map(([slot, ticks]) => ({ slot, ticks }));
}

export function tickLabel(tick: MessageTick) {
  const date = tick.seconds === null ? 'Time unavailable' : new Date(tick.seconds * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `${date} · ${tick.preview}`;
}

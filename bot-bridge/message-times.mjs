import { displayReplyItem, replyMetadata } from "./message-replies.mjs";
// Arrival metadata supplements native history without changing its authority.
// Indexed exact identity lookups, never a transcript/event scan.
const key = (threadId, turnId, itemId) => JSON.stringify([threadId, turnId, itemId]);
export function recordMessageTime(runtime, botId, data) {
  let p = data.params;
  if (botId && p?.turn?.items) {
    const bot = runtime.store.bot(botId), threadId = p.threadId ?? bot.threadId;
    const replyByClientId = Object.fromEntries(p.turn.items.flatMap(item => item.type === "userMessage" ? [[item.clientId, replyMetadata(runtime, bot, threadId, item)]] : []));
    data = { ...data, replyByClientId, params: { ...p, turn: { ...p.turn, items: p.turn.items.map(item => displayReplyItem(runtime, bot, threadId, item)) } } };
    p = data.params;
  }
  const item = p?.item;
  if (!botId || !['item/started', 'item/completed'].includes(data.method) ||
      !['userMessage', 'agentMessage'].includes(item?.type) ||
      typeof p.threadId !== 'string' || typeof p.turnId !== 'string' || typeof item.id !== 'string') return data;
  const id = key(p.threadId, p.turnId, item.id);
  let record = runtime.store.get('messageTime', id);
  if (!record) record = runtime.store.put('messageTime', { id, botId, at: Date.now() / 1000 });
  const operatorSegmentId = item.type === "userMessage" ? runtime.operator?.origin(botId, item.clientId) : null;
  const bot = runtime.store.bot(botId);
  return { ...data, params: { ...p, item: displayReplyItem(runtime, bot, p.threadId, item) }, ...replyMetadata(runtime, bot, p.threadId, item), messageAt: record.at, ...(operatorSegmentId ? { operatorSegmentId } : {}) };
}
export function withMessageTime(runtime, bot, threadId, entry) {
  if (!entry || !['userMessage', 'agentMessage'].includes(entry.type)) return entry;
  const record = runtime.store.get('messageTime', key(threadId, entry.turnId, entry.id));
  const operatorSegmentId = entry.item?.type === 'userMessage' ? runtime.operator?.origin(bot.id, entry.item.clientId) : null;
  const enriched = { ...entry, ...replyMetadata(runtime, bot, threadId, entry.item), ...(operatorSegmentId ? { operatorSegmentId } : {}) };
  return record?.botId === bot.id ? { ...enriched, messageAt: record.at, timeBasis: 'received' } : enriched;
}

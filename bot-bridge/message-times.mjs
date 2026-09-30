// Arrival metadata supplements native history without changing its authority.
// Indexed exact identity lookups, never a transcript/event scan.
const key = (threadId, turnId, itemId) => JSON.stringify([threadId, turnId, itemId]);
export function recordMessageTime(runtime, botId, data) {
  const p = data.params, item = p?.item;
  if (!botId || !['item/started', 'item/completed'].includes(data.method) ||
      !['userMessage', 'agentMessage'].includes(item?.type) ||
      typeof p.threadId !== 'string' || typeof p.turnId !== 'string' || typeof item.id !== 'string') return data;
  const id = key(p.threadId, p.turnId, item.id);
  let record = runtime.store.get('messageTime', id);
  if (!record) record = runtime.store.put('messageTime', { id, botId, at: Date.now() / 1000 });
  return { ...data, messageAt: record.at };
}
export function withMessageTime(runtime, bot, threadId, entry) {
  if (!entry || !['userMessage', 'agentMessage'].includes(entry.type)) return entry;
  const record = runtime.store.get('messageTime', key(threadId, entry.turnId, entry.id));
  return record?.botId === bot.id ? { ...entry, messageAt: record.at, timeBasis: 'received' } : entry;
}

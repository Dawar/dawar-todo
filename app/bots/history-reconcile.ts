import { conversationItem, historyKey, type HistoryEntry } from '../../lib/bot-history-view';

const clientId = (entry: HistoryEntry) => entry.item?.type === 'userMessage' ? entry.item.clientId || null : null;
const provisional = (entry: HistoryEntry) => entry.id.startsWith('client:');
export function preserveUserIdentity(old: HistoryEntry, next: HistoryEntry): HistoryEntry {
  if (old.item?.type !== 'userMessage' || next.item?.type !== 'userMessage') return next;
  if (next.item.clientId && next.item.content.length) return next;
  return { ...next, item: { ...next.item, clientId: next.item.clientId || old.item.clientId, content: next.item.content.length ? next.item.content : old.item.content } };
}
/** Weave chronological pages at shared native/client identities. Incoming order
 * is authoritative; entries known only locally stay beside the next shared
 * anchor. In particular, a newly expanded older prefix is never appended. */
export function orderedHistory(old: HistoryEntry[], incoming: HistoryEntry[], prepend: boolean, preserveAfter: number) {
  const keys = new Map(old.map((entry, index) => [historyKey(entry.turnId, entry.id), index]));
  const clients = new Map(old.flatMap((entry, index) => { const id = clientId(entry); return id ? [[id, index] as const] : []; }));
  const matches = incoming.map(entry => keys.get(historyKey(entry.turnId, entry.id)) ?? (clientId(entry) ? clients.get(clientId(entry)!) : undefined));
  const matched = new Set(matches.filter(index => index !== undefined));
  if (!matched.size) return prepend ? [...incoming, ...old] : [...old, ...incoming];
  const before = new Map<number, HistoryEntry[]>(); let pending: HistoryEntry[] = [];
  old.forEach((entry, index) => {
    if (matched.has(index)) { before.set(index, pending); pending = []; }
    else pending.push(entry);
  });
  const tail = pending, result: HistoryEntry[] = []; pending = [];
  incoming.forEach((entry, index) => {
    const at = matches[index];
    if (at === undefined) { pending.push(entry); return; }
    const prior = old[at];
    let winner = reconcileHistory([prior, entry]).entries[0];
    if ((prior.updatedSeq ?? 0) > preserveAfter) {
      // Keep newer live content, but still adopt a canonical native identity.
      const item = preserveUserIdentity(winner, prior).item;
      winner = { ...prior, id: winner.id, turnId: winner.turnId, item: item ? { ...item, id: winner.id } : winner.item };
    }
    result.push(...(before.get(at) ?? []), ...pending, prior, winner);
    before.delete(at); pending = [];
  });
  return [...result, ...pending, ...tail];
}
/** Identity is scoped by the owning BotTimeline. Equal text is never identity. */
export function reconcileHistory(values: HistoryEntry[]) {
  const entries: HistoryEntry[] = [], keys = new Map<string, number>(), clients = new Map<string, number>(), aliases = new Map<string, string>();
  for (const entry of values) {
    const key = historyKey(entry.turnId, entry.id), client = clientId(entry);
    const index = keys.get(key) ?? (client ? clients.get(client) : undefined);
    if (index === undefined) { keys.set(key, entries.length); if (client) clients.set(client, entries.length); entries.push(entry); continue; }
    const old = entries[index], oldKey = historyKey(old.turnId, old.id);
    // A late provisional replay must never replace an authoritative native ID.
    const winner = !provisional(old) && provisional(entry) ? old : preserveUserIdentity(old, entry);
    const winnerKey = historyKey(winner.turnId, winner.id);
    if (oldKey !== winnerKey) aliases.set(oldKey, winnerKey);
    if (key !== winnerKey) aliases.set(key, winnerKey);
    entries[index] = winner; keys.set(key, index); keys.set(oldKey, index);
    if (client) clients.set(client, index);
  }
  return { entries, aliases };
}
export function conversationEntries(entries: HistoryEntry[]) {
  return entries.filter((entry) => conversationItem(entry.type) && entry.id !== 'live-turn-diff' || (entry.turnStatus ?? entry.status) === 'inProgress').filter((entry) => entry.item?.type !== 'reasoning' || (entry.turnStatus ?? entry.status) === 'inProgress' || entry.item.summary.some((text) => text.trim())).map((entry) => entry.item?.type === 'reasoning' && entry.item.content.length ? { ...entry, item: { ...entry.item, content: [] } } : entry);
}

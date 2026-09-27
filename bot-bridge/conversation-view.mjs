import { CONVERSATION_TURNS, conversationItem, projectHistoryItem, historyKey } from '../lib/bot-history-view.ts';
import { historyAttachmentSelectors, readHistoryAttachmentMetadata } from './history-attachments.mjs';

// Native still reads full turns. Only this application projection crosses the
// weak browser link; no assumption about Codex's unverified summary semantics.
export const CONVERSATION_ITEMS = 256, CONVERSATION_BYTES = 192 * 1024;
export async function conversationViewPage(runtime, bot, cursor) {
  let position = { native: null, before: null };
  if (cursor) {
    try {
      if (typeof cursor !== 'string' || cursor.length > 8192) throw new Error();
      position = JSON.parse(cursor);
      if (position.native !== null && typeof position.native !== 'string' || position.before !== null && typeof position.before !== 'string') throw new Error();
    } catch { throw new Error('Invalid conversation cursor.'); }
  }
  if (position.after) {
    if (typeof position.after !== "string" || position.after.length > 500) throw new Error("Invalid conversation anchor.");
    return conversationViewAfter(runtime, bot, position.after);
  }
  let page, all, start;
  do {
    page = await runtime.historyPage(bot.threadId, position.native, CONVERSATION_TURNS);
    all = page.data.flatMap((turn) => {
      const scheduled = turn.items.some((item) => item.type === 'userMessage' && item.clientId?.startsWith('schedule:'));
      return [...turn.items].reverse().map((item) => ({ turn, item, scheduled }));
    });
    start = position.before ? all.findIndex(({ turn, item }) => historyKey(turn.id, item.id) === position.before) + 1 : 0;
    if (!position.before || start) break;
    position.native = page.nextCursor;
    if (!position.native) throw new Error('This conversation anchor is unavailable. Reload to reconnect its pages.');
  } while (position.native);
  const entries = [], turnIds = new Set(); let bytes = 0, index = start, partialTurn = false, olderCursor = null, pages = 1;
  while (true) {
    for (; index < all.length; index++) {
      const { turn, item, scheduled } = all[index];
      if (turn.status !== 'inProgress' && (!conversationItem(item.type) || item.type === 'reasoning' && !item.summary.some((text) => text.trim()))) continue;
      const entry = projectHistoryItem(turn, item, scheduled), size = Buffer.byteLength(JSON.stringify(entry));
      if (!turnIds.has(turn.id) && turnIds.size >= CONVERSATION_TURNS || entries.length && (entries.length >= CONVERSATION_ITEMS || bytes + size > CONVERSATION_BYTES - 26 * 1024)) break;
      entries.push(entry); turnIds.add(turn.id); bytes += size;
    }
    if (index < all.length) {
      partialTurn = all[index].turn.id === all[index - 1]?.turn.id;
      olderCursor = JSON.stringify({ native: position.native, before: index ? historyKey(all[index - 1].turn.id, all[index - 1].item.id) : null });
      break;
    }
    olderCursor = page.nextCursor ? JSON.stringify({ native: page.nextCursor, before: null }) : null;
    if (!page.nextCursor || turnIds.size >= CONVERSATION_TURNS || pages >= 2) break;
    // An anchor inside a native page can leave fewer than 25 earlier turns.
    // Fill from one adjacent page; never scan an empty history indefinitely.
    position.native = page.nextCursor;
    page = await runtime.historyPage(bot.threadId, position.native, CONVERSATION_TURNS); pages++;
    all = page.data.flatMap((turn) => {
      const scheduled = turn.items.some((item) => item.type === 'userMessage' && item.clientId?.startsWith('schedule:'));
      return [...turn.items].reverse().map((item) => ({ turn, item, scheduled }));
    });
    index = 0;
  }
  // Tool-produced files survive even though their bodies/descriptors are omitted.
  const selectors = historyAttachmentSelectors(entries);
  selectors.turns = [...turnIds];
  const attachments = readHistoryAttachmentMetadata(runtime, bot, selectors, CONVERSATION_BYTES - bytes - Buffer.byteLength(olderCursor ?? '') - 8192);
  return { entries: entries.reverse(), turnIds: [...turnIds].reverse(), partialTurn, olderCursor, attachments, complete: !olderCursor && entries.every((entry) => entry.complete) };
}

/** Move forward across an evicted range without backfilling the entire gap.
 * Native pagination is descending, so locating an old anchor can still require
 * native scans. Retain only one bounded projected page from those scans. */
async function conversationViewAfter(runtime, bot, after) {
  let cursor = null, newerExists = false, bytes = 0;
  // Descending native scan, bounded oldest/nearest projected tail. Empty pages
  // must not replace it; dropped newer entries must outlive native cursors.
  const nearest = [], counts = new Map();
  do {
    const page = await runtime.historyPage(bot.threadId, cursor, CONVERSATION_TURNS);
    for (const turn of page.data) {
      const scheduled = turn.items.some((item) => item.type === 'userMessage' && item.clientId?.startsWith('schedule:'));
      for (let index = turn.items.length - 1; index >= 0; index--) {
        const item = turn.items[index];
        if (historyKey(turn.id, item.id) === after) {
          const entries = nearest.slice().reverse().map(value => value.entry), turnIds = [...new Set(entries.map(entry => entry.turnId))];
          const selectors = historyAttachmentSelectors(entries); selectors.turns = turnIds;
          const first = entries[0], last = entries.at(-1);
          return { entries, turnIds, attachments: readHistoryAttachmentMetadata(runtime, bot, selectors),
            olderCursor: first ? JSON.stringify({ native: null, before: historyKey(first.turnId, first.id) }) : null,
            newerCursor: last && newerExists ? JSON.stringify({ native: null, before: null, after: historyKey(last.turnId, last.id) }) : null,
            complete: false };
        }
        if (turn.status !== 'inProgress' && (!conversationItem(item.type) || item.type === 'reasoning' && !item.summary.some(text => text.trim()))) continue;
        const entry = projectHistoryItem(turn, item, scheduled), size = Buffer.byteLength(JSON.stringify(entry));
        nearest.push({ entry, size }); bytes += size; counts.set(turn.id, (counts.get(turn.id) ?? 0) + 1);
        while (nearest.length > 1 && (nearest.length > CONVERSATION_ITEMS || counts.size > CONVERSATION_TURNS || bytes > CONVERSATION_BYTES - 26 * 1024)) {
          const dropped = nearest.shift(); bytes -= dropped.size;
          const count = counts.get(dropped.entry.turnId) - 1;
          if (count) counts.set(dropped.entry.turnId, count); else counts.delete(dropped.entry.turnId);
          newerExists = true;
        }
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  throw new Error('This conversation anchor is unavailable. Reload to reconnect its pages.');
}

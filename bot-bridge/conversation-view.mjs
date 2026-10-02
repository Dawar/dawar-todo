import { displayReplyItem } from "./message-replies.mjs";
import { withMessageTime } from "./message-times.mjs";
import { CONVERSATION_TURNS, historyKey } from '../lib/bot-history-view.ts';
import { turnAudience, projectConversationItem } from '../lib/bot-conversation.ts';
import { historyAttachmentSelectors, readHistoryAttachmentMetadata } from './history-attachments.mjs';

// Native still reads full turns. This bounded application projection, not the
// number of scheduled native turns scanned, determines the conversation budget.
export const CONVERSATION_ITEMS = 256, CONVERSATION_BYTES = 192 * 1024;
const ENTRY_BYTES = CONVERSATION_BYTES - 42 * 1024;
function projection(runtime, bot) {
  // Exact per-native-turn metadata lookups use the runtime's additive indexes.
  // Do not enumerate the native thread (or every run) to discover follow-ups.
  const primary = runtime.store.db.prepare(`SELECT id, json_extract(json,'$.conversation') AS conversation FROM records WHERE kind='run' AND kind IN ('run','runTurn')
    AND bot_id=? AND json_extract(json,'$.turnId')=? LIMIT 1`);
  const continuation = runtime.store.db.prepare(`SELECT json_extract(c.json,'$.runId') AS runId, json_extract(r.json,'$.conversation') AS conversation FROM records c
    JOIN records r ON r.kind='run' AND r.id=json_extract(c.json,'$.runId') AND r.bot_id=c.bot_id
    WHERE c.kind='runTurn' AND c.kind IN ('run','runTurn') AND c.bot_id=? AND json_extract(c.json,'$.turnId')=?
      AND json_extract(c.json,'$.status') IN ('running','completed','failed','interrupted')
      AND (json_extract(c.json,'$.threadId') IS NULL OR json_extract(c.json,'$.threadId')=?) LIMIT 1`);
  // Older services have no runs.turns discovery route. Keep their unknown
  // continuations visible even if an unpublished receipt happens to exist.
  const hasDiscovery = typeof runtime.scheduledContext === 'function';
  const activityTurns = new Map(); let activityBytes = 0;
  const rows = (page) => page.data.flatMap(turn => {
    const run = primary.get(bot.id, turn.id) ?? (hasDiscovery ? continuation.get(bot.id, turn.id, bot.threadId) : undefined);
    const audience = turnAudience(turn.items, run?.id ?? run?.runId, run?.conversation === 1);
    if (audience.kind === 'activity' && !activityTurns.has(turn.id)) {
      const value = { turnId: turn.id, runId: audience.runId, ...(turn.status === 'inProgress' ? { active: true } : {}) }, size = Buffer.byteLength(JSON.stringify(value));
      if (activityTurns.size < 128 && activityBytes + size < 8192) { activityTurns.set(turn.id, value); activityBytes += size; }
    }
    return [...turn.items].reverse().map(item => ({ turn, item, audience }));
  });
  const finish = (entries, fields) => {
    const turnIds = [...new Set(entries.map(entry => entry.turnId))];
    const selectors = historyAttachmentSelectors(entries); selectors.turns = turnIds;
    const value = { entries, turnIds, activityTurns: [...activityTurns.values()], ...fields };
    // Tool-produced file metadata follows visible turns without tool bodies.
    return { ...value, attachments: readHistoryAttachmentMetadata(runtime, bot, selectors,
      CONVERSATION_BYTES - Buffer.byteLength(JSON.stringify(value)) - 2048) };
  };
  return { rows, finish };
}
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
    if (typeof position.after !== 'string' || position.after.length > 500) throw new Error('Invalid conversation anchor.');
    return conversationViewAfter(runtime, bot, position.after);
  }
  let hinted = false;
  if (position.native === null && position.before && runtime.historyReads) {
    const location = runtime.historyReads.location(bot.threadId, position.before.split(':')[0]);
    if (location?.cursor) { position.native = location.cursor; hinted = true; }
  }
  const view = projection(runtime, bot), visited = new Set();
  let scannedPages = 0;
  const read = async () => {
    if (visited.has(position.native)) throw new Error('Native history pagination made no progress. Reopen the conversation.');
    visited.add(position.native);
    scannedPages++;
    return runtime.historyPage(bot.threadId, position.native, CONVERSATION_TURNS);
  };
  let page, all, start;
  do {
    try { page = await read(); }
    catch (error) {
      if (!hinted) throw error;
      hinted = false; position.native = null; visited.clear(); continue;
    }
    all = view.rows(page);
    start = position.before ? all.findIndex(({ turn, item }) => historyKey(turn.id, item.id) === position.before) + 1 : 0;
    if (!position.before || start) break;
    if (hinted) { hinted = false; position.native = null; visited.clear(); continue; }
    position.native = page.nextCursor;
    if (!position.native) throw new Error('This conversation anchor is unavailable. Reload to reconnect its pages.');
  } while (position.native);
  const entries = [], turnIds = new Set(), findings = new Set();
  let bytes = 0, index = start, partialTurn = false, olderCursor = null;
  while (true) {
    for (; index < all.length; index++) {
      const { turn, item, audience } = all[index];
      const entry = withMessageTime(runtime, bot, bot.threadId, projectConversationItem(turn, displayReplyItem(runtime, bot, bot.threadId, item), audience));
      if (!entry || entry.findingId && findings.has(entry.findingId)) continue;
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (!turnIds.has(turn.id) && turnIds.size >= CONVERSATION_TURNS || entries.length && (entries.length >= CONVERSATION_ITEMS || bytes + size > ENTRY_BYTES)) break;
      entries.push(entry); turnIds.add(turn.id); bytes += size;
      if (entry.findingId) findings.add(entry.findingId);
    }
    if (index < all.length) {
      partialTurn = all[index].turn.id === entries.at(-1)?.turnId;
      olderCursor = JSON.stringify({ native: position.native, before: index ? historyKey(all[index - 1].turn.id, all[index - 1].item.id) : null });
      break;
    }
    olderCursor = page.nextCursor ? JSON.stringify({ native: page.nextCursor, before: null }) : null;
    if (!page.nextCursor || turnIds.size >= CONVERSATION_TURNS || scannedPages >= 4) break;
    // Empty legacy pages do not consume conversational slots, but each RPC is
    // bounded. The remaining exact native cursor stays accessible to the UI.
    position.native = page.nextCursor; page = await read(); all = view.rows(page); index = 0;
  }
  return view.finish(entries.reverse(), { partialTurn, olderCursor, complete: !olderCursor && entries.every(entry => entry.complete) });
}

/** Descending native scans retain only the nearest bounded newer projection.
 * Empty/routine pages never erase it or masquerade as the true latest edge. */
async function conversationViewAfter(runtime, bot, after) {
  const view = projection(runtime, bot), visited = new Set();
  let cursor = null, newerExists = false, bytes = 0;
  const nearest = [], counts = new Map();
  do {
    if (visited.has(cursor)) throw new Error('Native history pagination made no progress. Reopen the conversation.');
    visited.add(cursor);
    const page = await runtime.historyPage(bot.threadId, cursor, CONVERSATION_TURNS);
    for (const { turn, item, audience } of view.rows(page)) {
      if (historyKey(turn.id, item.id) === after) {
        const entries = nearest.slice().reverse().map(value => value.entry), first = entries[0], last = entries.at(-1);
        return view.finish(entries, {
          olderCursor: first ? JSON.stringify({ native: null, before: historyKey(first.turnId, first.id) }) : null,
          newerCursor: last && newerExists ? JSON.stringify({ native: null, before: null, after: historyKey(last.turnId, last.id) }) : null,
          complete: false });
      }
      const entry = withMessageTime(runtime, bot, bot.threadId, projectConversationItem(turn, displayReplyItem(runtime, bot, bot.threadId, item), audience));
      if (!entry) continue;
      const size = Buffer.byteLength(JSON.stringify(entry));
      nearest.push({ entry, size }); bytes += size; counts.set(turn.id, (counts.get(turn.id) ?? 0) + 1);
      while (nearest.length > 1 && (nearest.length > CONVERSATION_ITEMS || counts.size > CONVERSATION_TURNS || bytes > ENTRY_BYTES)) {
        const dropped = nearest.shift(); bytes -= dropped.size;
        const count = counts.get(dropped.entry.turnId) - 1;
        if (count) counts.set(dropped.entry.turnId, count); else counts.delete(dropped.entry.turnId);
        newerExists = true;
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  throw new Error('This conversation anchor is unavailable. Reload to reconnect its pages.');
}

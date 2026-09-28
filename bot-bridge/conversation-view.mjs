import { CONVERSATION_TURNS, historyKey } from '../lib/bot-history-view.ts';
import { turnAudience, projectConversationItem } from '../lib/bot-conversation.ts';
import { historyAttachmentSelectors, readHistoryAttachmentMetadata } from './history-attachments.mjs';

// Native still reads full turns. This bounded application projection, not the
// number of scheduled native turns scanned, determines the conversation budget.
export const CONVERSATION_ITEMS = 256, CONVERSATION_BYTES = 192 * 1024;
const ENTRY_BYTES = CONVERSATION_BYTES - 42 * 1024;
function projection(runtime, bot) {
  const runs = new Map(runtime.store.list('run', bot.id).filter(run => run.turnId).map(run => [run.turnId, run.id]));
  const activityTurns = new Map(); let activityBytes = 0;
  const rows = (page) => page.data.flatMap(turn => {
    const audience = turnAudience(turn.items, runs.get(turn.id));
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
  const view = projection(runtime, bot), visited = new Set();
  const read = async () => {
    if (visited.has(position.native)) throw new Error('Native history pagination made no progress. Reopen the conversation.');
    visited.add(position.native);
    return runtime.historyPage(bot.threadId, position.native, CONVERSATION_TURNS);
  };
  let page, all, start;
  do {
    page = await read(); all = view.rows(page);
    start = position.before ? all.findIndex(({ turn, item }) => historyKey(turn.id, item.id) === position.before) + 1 : 0;
    if (!position.before || start) break;
    position.native = page.nextCursor;
    if (!position.native) throw new Error('This conversation anchor is unavailable. Reload to reconnect its pages.');
  } while (position.native);
  const entries = [], turnIds = new Set(), findings = new Set();
  let bytes = 0, index = start, partialTurn = false, olderCursor = null;
  while (true) {
    for (; index < all.length; index++) {
      const { turn, item, audience } = all[index];
      const entry = projectConversationItem(turn, item, audience);
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
    if (!page.nextCursor || turnIds.size >= CONVERSATION_TURNS) break;
    // Routine scheduled/empty turns consume no conversational slots. Continue
    // natively until 25 useful turns, payload safety bounds, or true exhaustion.
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
      const entry = projectConversationItem(turn, item, audience);
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

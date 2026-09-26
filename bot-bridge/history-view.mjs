import { createHash } from 'node:crypto';
import { projectHistoryItem, HISTORY_WINDOW, historyKey } from '../lib/bot-history-view.ts';

const MAX_PAGE_BYTES = 96 * 1024;
const encode = JSON.stringify;
function decode(cursor) {
  if (!cursor) return { native: null, before: null };
  if (typeof cursor !== 'string' || cursor.length > 8192) throw new Error('Invalid history cursor.');
  try {
    const value = JSON.parse(cursor);
    if ((value.native !== null && typeof value.native !== 'string') || (value.before !== null && typeof value.before !== 'string')) throw new Error();
    return value;
  } catch { throw new Error('Invalid history cursor.'); }
}

/** Explicit projection of full native items. Does not assume native summary semantics. */
export async function historyViewPage(runtime, bot, cursor = null) {
  const position = decode(cursor);
  let page, all, start = 0;
  do {
    page = await runtime.historyPage(bot.threadId, position.native);
    all = [];
    for (const turn of page.data) {
      const scheduled = turn.items.some((item) => item.type === 'userMessage' && item.clientId?.startsWith('schedule:'));
      for (let i = turn.items.length - 1; i >= 0; i--) all.push({ turn, item: turn.items[i], scheduled });
    }
    if (!position.before) break;
    start = all.findIndex(({ turn, item }) => historyKey(turn.id, item.id) === position.before) + 1;
    if (start) break;
    position.native = page.nextCursor;
    if (!position.native) throw new Error('History anchor is no longer available. Refresh the latest messages.');
  } while (position.native);
  const entries = []; let bytes = 0, index = start;
  for (; index < all.length && entries.length < HISTORY_WINDOW; index++) {
    const { turn, item, scheduled } = all[index];
    const entry = projectHistoryItem(turn, item, scheduled);
    const length = Buffer.byteLength(JSON.stringify(entry));
    if (entries.length && bytes + length > MAX_PAGE_BYTES) break;
    entries.push(entry); bytes += length;
  }
  const olderCursor = index < all.length ? encode({ native: position.native, before: historyKey(all[index - 1].turn.id, all[index - 1].item.id) })
    : page.nextCursor ? encode({ native: page.nextCursor, before: null }) : null;
  const paths = new Set(entries.flatMap((entry) => entry.item?.type === 'userMessage'
    ? entry.item.content.flatMap((part) => part.type === 'localImage' ? [part.path] : []) : []));
  const attachments = runtime.store.list('attachment', bot.id).filter((a) => a.ready && paths.has(a.path)).map((a) => runtime.publicAttachment(a));
  return { entries: entries.reverse(), olderCursor, attachments, complete: !olderCursor && entries.every((e) => e.complete) };
}

export function historyRevision(runtime, bot) {
  return `${runtime.epoch}:${bot.threadId}:${bot.updatedAt}:${runtime.historyVersions?.get(bot.id) ?? 0}`;
}

export async function readHistoryView(runtime, bot, params) {
  const revision = historyRevision(runtime, bot), eventCursor = runtime.store.cursor();
  if (!params.cursor && params.revision === revision) return { kind: 'unchanged', revision, eventCursor };
  if (!params.cursor && params.revision?.startsWith(`${runtime.epoch}:${bot.threadId}:`) && Number.isSafeInteger(params.after) && params.after >= 0) {
    const replay = runtime.store.replay(params.after);
    const contiguous = !replay.length ? params.after === eventCursor : replay[0].seq === params.after + 1;
    const events = replay.filter((e) => e.botId === bot.id && ['codex', 'attachment', 'history.refresh'].includes(e.type));
    if (contiguous && !events.some((e) => e.type !== 'codex') && Buffer.byteLength(JSON.stringify(events)) < MAX_PAGE_BYTES)
      return { kind: 'events', revision, eventCursor, events };
  }
  const page = await historyViewPage(runtime, bot, params.cursor ?? null);
  return { kind: 'page', ...page, revision, eventCursor };
}

export async function readHistoryDetail(runtime, bot, params) {
  if (typeof params.turnId !== 'string' || typeof params.itemId !== 'string' || params.turnId.length > 200 || params.itemId.length > 200)
    throw new Error('Invalid history item.');
  const offset = params.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid detail offset.');
  // Native history remains the source for all details, including a single huge turn.
  let cursor = null, item;
  do {
    const page = await runtime.historyPage(bot.threadId, cursor);
    item = page.data.find((turn) => turn.id === params.turnId)?.items.find((entry) => entry.id === params.itemId);
    cursor = page.nextCursor;
  } while (!item && cursor);
  if (!item) throw new Error('This history item is not available from the native thread.');
  const json = JSON.stringify(item), version = createHash('sha256').update(json).digest('hex');
  if (params.version && params.version !== version) throw new Error('The item changed while loading. Open its details again.');
  const next = Math.min(json.length, offset + 12_288);
  if (offset > json.length) throw new Error('Invalid detail offset.');
  return { json: json.slice(offset, next), nextOffset: next < json.length ? next : null, totalLength: json.length, version };
}

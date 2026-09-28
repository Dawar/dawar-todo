import { conversationViewPage } from './conversation-view.mjs';
import { createHash } from 'node:crypto';
import { projectHistoryItem, HISTORY_WINDOW, historyKey } from '../lib/bot-history-view.ts';
import { historyAttachmentSelectors, readHistoryAttachmentMetadata, HISTORY_ATTACHMENT_BYTES } from './history-attachments.mjs';

const details = new WeakMap();
const DETAIL_TTL = 30_000, DETAIL_BYTES = 32 * 1024 * 1024;
function detailCache(runtime) {
  let cache = details.get(runtime);
  if (!cache) { cache = new Map(); details.set(runtime, cache); }
  for (const [key, item] of cache) if (item.expires < Date.now()) cache.delete(key);
  return cache;
}
const MAX_PAGE_BYTES = 96 * 1024;
// Leave room for bounded attachment metadata, two context excerpts and envelope.
const MAX_ENTRY_BYTES = MAX_PAGE_BYTES - HISTORY_ATTACHMENT_BYTES - 12 * 1024;
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
export async function historyViewPage(runtime, bot, cursor = null, turnId = null, target = null) {
  const position = decode(cursor);
  if (target?.runId && position.turnId && position.turnId !== target.turnId) throw new Error('History cursor belongs to another run part.');
  turnId ??= position.turnId;
  if (turnId != null && (typeof turnId !== 'string' || turnId.length > 200)) throw new Error('Invalid turn id.');
  let page, all, start = 0;
  do {
    page = await runtime.historyPage(target?.threadId ?? bot.threadId, position.native);
    all = [];
    if (turnId && !page.data.some((turn) => turn.id === turnId)) {
      position.native = page.nextCursor;
      if (position.native) continue;
      throw new Error('This turn is not available in native conversation history.');
    }
    for (const turn of page.data) {
      if (turnId && turn.id !== turnId) continue;
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
    if (entries.length && bytes + length > MAX_ENTRY_BYTES) break;
    entries.push(entry); bytes += length;
  }
  const olderCursor = index < all.length ? encode({ native: position.native, before: historyKey(all[index - 1].turn.id, all[index - 1].item.id), ...(turnId ? { turnId } : {}) })
    : !turnId && page.nextCursor ? encode({ native: page.nextCursor, before: null }) : null;
  const contextEntries = [];
  if (!cursor && !entries.some((entry) => !entry.scheduled && ['userMessage', 'agentMessage'].includes(entry.type))) {
    const types = new Set();
    for (const { turn, item, scheduled } of all) {
      if (scheduled || !['userMessage', 'agentMessage'].includes(item.type) || types.has(item.type)) continue;
      types.add(item.type);
      const entry = projectHistoryItem(turn, item, scheduled);
      if (entry.item.type === 'agentMessage') { entry.item.text = entry.item.text.slice(0, 4096); entry.complete = false; }
      else { entry.item.content = [{ type: 'text', text: item.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n').slice(0, 4096), text_elements: [] }]; entry.complete = false; }
      contextEntries.push(entry);
      if (contextEntries.length === 2) break;
    }
    contextEntries.reverse();
  }
  const metadataBudget = MAX_PAGE_BYTES - bytes - Buffer.byteLength(JSON.stringify(contextEntries)) - Buffer.byteLength(olderCursor ?? '') - 2048;
  const selectors = historyAttachmentSelectors([...entries, ...contextEntries]);
  if (turnId) selectors.turns = [turnId];
  const attachments = readHistoryAttachmentMetadata(runtime, bot, selectors, metadataBudget, target);
  return { entries: entries.reverse(), contextEntries, olderCursor, attachments, complete: !olderCursor && entries.every((e) => e.complete) };
}

export function historyRevision(runtime, bot) {
  return `${runtime.epoch}:${bot.threadId}:${bot.updatedAt}:${runtime.historyVersions?.get(bot.id) ?? 0}`;
}
function detailRevision(runtime, bot) {
  return `${runtime.epoch}:${bot.threadId}:${bot.updatedAt}:${runtime.historyContentVersions?.get(bot.id) ?? 0}`;
}

export async function readHistoryView(runtime, bot, params) {
  const target = runtime.resolveHistoryTarget(bot, params);
  const context = { laneId: target.laneId, runId: target.runId, threadId: target.threadId };
  if (target.runId) {
    if (!target.turnId || params.projection === 'conversation') throw new Error('Select an available recorded run part.');
    // The resolver authorizes this exact original/continuation part. Neither an
    // inner native cursor nor coincidentally equal turn IDs can widen its scope.
    let cursor = null;
    if (params.cursor) {
      if (typeof params.cursor !== 'string' || params.cursor.length > 12288) throw new Error('Invalid run history cursor.');
      let value;
      try { value = JSON.parse(params.cursor); } catch { throw new Error('Invalid run history cursor.'); }
      if (value.scope !== target.versionKey || value.turnId !== target.turnId || typeof value.cursor !== 'string') throw new Error('History cursor belongs to another run part.');
      cursor = value.cursor;
    }
    const eventCursor = runtime.store.cursor();
    // A global sequence conservatively invalidates an explicitly opened run;
    // it never wakes main history or polls an unopened transcript.
    const revision = `${runtime.epoch}:${target.versionKey}:${target.updatedAt}:${eventCursor}:run-view-v1`;
    if (!cursor && params.revision === revision) return { kind: 'unchanged', context, revision, eventCursor };
    const page = await historyViewPage(runtime, bot, cursor, target.turnId, target);
    return { kind: 'page', ...page, context, turnIds: [target.turnId], revision, eventCursor,
      olderCursor: page.olderCursor ? JSON.stringify({ scope: target.versionKey, turnId: target.turnId, cursor: page.olderCursor }) : null };
  }
  const revision = historyRevision(runtime, bot) + (params.projection === "conversation" ? ":conversation-v4" : ""), eventCursor = runtime.store.cursor();
  let attributionUnchanged = true;
  if (params.projection === 'conversation' && params.after !== eventCursor) {
    // Schedule receipts can change without native content changing. Inspect
    // only event metadata; a replay gap forces projection rather than trusting
    // a cached audience. No native scan is used to enumerate continuations.
    const first = Number.isSafeInteger(params.after) && params.after >= 0
      ? runtime.store.db.prepare('SELECT seq FROM events WHERE seq>? ORDER BY seq LIMIT 1').get(params.after) : null;
    attributionUnchanged = first?.seq === params.after + 1 && !runtime.store.db.prepare(`SELECT 1 FROM events
      WHERE seq>? AND json_extract(json,'$.type')='schedules' AND json_extract(json,'$.botId')=? LIMIT 1`).get(params.after, bot.id);
  }
  if (!params.cursor && !params.turnId && params.revision === revision && attributionUnchanged) return { kind: 'unchanged', context, revision, eventCursor };
  if (params.projection !== 'conversation' && !params.cursor && !params.turnId && params.revision?.startsWith(`${runtime.epoch}:${bot.threadId}:`) && Number.isSafeInteger(params.after) && params.after >= 0) {
    const replay = runtime.store.replay(params.after);
    const contiguous = !replay.length ? params.after === eventCursor : replay[0].seq === params.after + 1;
    const events = replay.filter((e) => e.botId === bot.id && ['codex', 'attachment', 'history.refresh'].includes(e.type));
    if (contiguous && !events.some((e) => !['codex', 'attachment'].includes(e.type) && !(e.type === 'history.refresh' && e.data?.reason === 'large-native-event')) && Buffer.byteLength(JSON.stringify(events)) < MAX_PAGE_BYTES)
      return { kind: 'events', context, revision, eventCursor, events };
  }
  const page = params.projection === "conversation" ? await conversationViewPage(runtime, bot, params.cursor ?? null) : await historyViewPage(runtime, bot, params.cursor ?? null, params.turnId ?? null);
  return { kind: 'page', ...page, context, revision, eventCursor };
}

export async function readHistoryDetail(runtime, bot, params) {
  const target = runtime.resolveHistoryTarget(bot, params);
  const context = { laneId: target.laneId, runId: target.runId, threadId: target.threadId };
  const revisionForDetail = () => target.runId ? `${runtime.epoch}:${target.versionKey}:${target.updatedAt}:${runtime.store.cursor()}` : detailRevision(runtime, bot);
  if (typeof params.turnId !== 'string' || typeof params.itemId !== 'string' || params.turnId.length > 200 || params.itemId.length > 200)
    throw new Error('Invalid history item.');
  if (target.runId && target.turnId !== params.turnId) throw new Error('The selected item belongs to another run part.');
  const offset = params.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid detail offset.');
  const key = JSON.stringify([bot.id, target.runId ? target.versionKey : bot.threadId, params.turnId, params.itemId, params.projection ?? "native"]), cache = detailCache(runtime);
  let cached = cache.get(key);
  if (cached && (params.version ? cached.version !== params.version : cached.revision !== revisionForDetail())) cached = undefined;
  if (!cached) {
    // One native lookup/serialization per detail version, shared by requests.
    const pendingKey = `${key}:pending`, existing = cache.get(pendingKey);
    const promise = existing?.promise ?? (async () => {
      const revision = revisionForDetail(), eventCursor = runtime.store.cursor();
      let cursor = null, item = !target.runId && runtime.historySupplements?.get(`${bot.id}:${params.turnId}:${params.itemId}`);
      if (!item && ['live-turn-diff', 'live-turn-plan'].includes(params.itemId)) throw new Error('This live aggregate has expired. Individual commands and file changes remain in native history.');
      if (!item) do {
        const page = await runtime.historyPage(target.threadId, cursor);
        item = page.data.find((turn) => turn.id === params.turnId)?.items.find((entry) => entry.id === params.itemId);
        cursor = page.nextCursor;
      } while (!item && cursor);
      if (!item) throw new Error('This history item is not available from the native thread.');
      // The ordinary chat detail route never transfers private reasoning content.
      if ((target.runId || params.projection === 'conversation') && item.type === 'reasoning') item = { ...item, content: [] };
      const json = JSON.stringify(item), version = createHash('sha256').update(target.runId ? `${target.versionKey}:${params.turnId}:${params.itemId}:${json}` : json).digest('hex');
      const selectors = historyAttachmentSelectors([{ turnId: params.turnId, id: item.id, item }]);
      const value = { json, version, selectors, eventCursor, revision, expires: Date.now() + DETAIL_TTL };
      cache.set(key, value);
      let bytes = 0;
      for (const [other, entry] of [...cache].reverse()) if (entry.json) {
        bytes += Buffer.byteLength(entry.json);
        // A single oversized item remains recoverable, and expires promptly.
        if (other !== key && (bytes > DETAIL_BYTES || cache.size > 5)) cache.delete(other);
      }
      return value;
    })();
    if (!existing) cache.set(pendingKey, { promise, expires: Date.now() + DETAIL_TTL });
    try { cached = await promise; } finally { cache.delete(pendingKey); }
  }
  if (params.version && params.version !== cached.version) throw new Error('The item changed while loading. Open its details again.');
  // Metadata can arrive after native completion. Re-query it independently of
  // the text hash, including conditional detail hits, without native/file I/O.
  const attachments = offset === 0 ? readHistoryAttachmentMetadata(runtime, bot, cached.selectors, HISTORY_ATTACHMENT_BYTES, target) : undefined;
  if (offset === 0 && params.knownVersion === cached.version) return { context, notModified: true, json: '', nextOffset: null, totalLength: cached.json.length, version: cached.version, eventCursor: cached.eventCursor, attachments };
  const next = Math.min(cached.json.length, offset + 48 * 1024);
  if (offset > cached.json.length) throw new Error('Invalid detail offset.');
  return { context, json: cached.json.slice(offset, next), nextOffset: next < cached.json.length ? next : null,
    totalLength: cached.json.length, version: cached.version, eventCursor: cached.eventCursor,
    ...(offset === 0 ? { attachments } : {}) };
}

export function readHistoryAttachments(runtime, bot, params) {
  const list = runtime.store.list('attachment', bot.id).filter((item) => item.ready && item.artifact).reverse();
  const index = params.cursor ? list.findIndex((item) => item.id === params.cursor) + 1 : 0;
  if (params.cursor && !index) throw new Error('Attachment cursor unavailable. Reopen files.');
  const page = list.slice(index, index + 20);
  return { attachments: page.map((item) => runtime.publicAttachment(item)), nextCursor: index + page.length < list.length ? page.at(-1).id : null };
}

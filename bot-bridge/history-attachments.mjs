import { artifactMetadata } from './artifact-library.mjs';

export const HISTORY_ATTACHMENT_BYTES = 24 * 1024;
export const HISTORY_ATTACHMENT_LIMIT = 64;
const MAX_SELECTORS = 64, PER_ITEM = 7;
const validKey = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;

/** Retain only bounded selectors, never native bodies, in the detail cache. */
export function historyAttachmentSelectors(entries) {
  const ids = new Set(), paths = new Set(), items = new Map();
  for (const { turnId, id, item } of entries) {
    if (items.size < MAX_SELECTORS && validKey(turnId) && validKey(id)) items.set(JSON.stringify([turnId, id]), [turnId, id]);
    if (item?.type === 'userMessage') for (const part of item.content) {
      if (part.type === 'localImage' && typeof part.path === 'string' && part.path.length <= 4096 && paths.size < MAX_SELECTORS) paths.add(part.path);
    }
    if (item?.type === 'agentMessage' && ids.size < MAX_SELECTORS) {
      // IDs produced by uploads/publication are UUIDs or artifact-<hex>. Never
      // interpret local paths, arbitrary markdown URLs or truncated ID prefixes.
      const links = /bot-artifact:([a-zA-Z0-9_-]{1,200})(?=$|[\s\])}<>"'])/g;
      for (const match of item.text.matchAll(links)) {
        ids.add(match[1]);
        if (ids.size === MAX_SELECTORS) break;
      }
    }
  }
  return { ids: [...ids], paths: [...paths], items: [...items.values()] };
}

/** Metadata only: indexed lookups, bounded rows/bytes, no library/file reads. */
export function readHistoryAttachmentMetadata(runtime, bot, selectors, byteBudget = HISTORY_ATTACHMENT_BYTES, target = null) {
  byteBudget = Math.min(HISTORY_ATTACHMENT_BYTES, byteBudget);
  if (byteBudget <= 2) return [];
  const threadId = target?.threadId ?? bot.threadId;
  const isolated = target?.kind === 'scheduled-run';
  const db = runtime.store.db, attachments = new Map(); let bytes = 2;
  const add = (row, inputPath = false, explicit = false, publication = null) => {
    if (!row || attachments.size >= HISTORY_ATTACHMENT_LIMIT) return;
    const stored = JSON.parse(row.json), a = publication ? { ...stored, provenance: publication } : stored;
    if (publication && !stored.artifact) return;
    if (a.botId !== bot.id || !a.ready || attachments.has(a.id) && !publication) return;
    if (isolated && !explicit && a.provenance?.threadId !== threadId) return;
    const metadata = artifactMetadata(a, bot);
    const value = { ...metadata, provenance: { ...metadata.provenance, ...(a.provenance?.runId ? { runId: a.provenance.runId } : {}), ...(a.provenance?.laneId ? { laneId: a.provenance.laneId } : {}) }, ...(a.artifact ? { artifact: true } : {}),
      // Paths are only disclosed for a localImage already in this owned item.
      ...(inputPath ? { path: a.path } : attachments.get(a.id)?.path ? { path: attachments.get(a.id).path } : {}) };
    const size = Buffer.byteLength(JSON.stringify(value)) + 1;
    const previous = attachments.get(a.id), previousSize = previous ? Buffer.byteLength(JSON.stringify(previous)) + 1 : 0;
    if (bytes - previousSize + size > byteBudget) return;
    attachments.set(a.id, value); bytes += size - previousSize;
    return a.id;
  };
  // Input lookups come first so a repeated explicit ID cannot remove its path.
  const path = db.prepare("SELECT json FROM records INDEXED BY history_attachment_path WHERE kind='attachment' AND json_extract(json,'$.ready')=1 AND bot_id=? AND json_extract(json,'$.path')=? ORDER BY id LIMIT 1");
  for (const value of selectors.paths) add(path.get(bot.id, value), true);
  const id = db.prepare("SELECT json FROM records WHERE kind='attachment' AND id=? AND bot_id=? AND json_extract(json,'$.ready')=1");
  for (const value of selectors.ids) add(id.get(value, bot.id), false, true);
  // This exact index/schema is owned by the lane backend. LIMIT applies to
  // its context range before validation/point reads; never scan the library.
  const publicationItem = db.prepare(`SELECT json FROM records INDEXED BY artifact_publication_context WHERE kind='artifactPublication'
    AND bot_id=? AND json_extract(json,'$.provenance.threadId')=?
    AND json_extract(json,'$.provenance.turnId')=? AND json_extract(json,'$.provenance.itemId')=? LIMIT ?`);
  const publicationTurn = db.prepare(`SELECT json FROM records INDEXED BY artifact_publication_context WHERE kind='artifactPublication'
    AND bot_id=? AND json_extract(json,'$.provenance.threadId')=? AND json_extract(json,'$.provenance.turnId')=? LIMIT ?`);
  const addPublication = (row, turnId, itemId) => {
    const alias = JSON.parse(row.json), p = alias.provenance;
    if (alias.botId !== bot.id || !validKey(alias.attachmentId) || p?.threadId !== threadId || p.turnId !== turnId || !validKey(p.itemId) || itemId && p.itemId !== itemId) return;
    if (target?.runId && (p.runId !== target.runId || p.laneId !== target.laneId)) return;
    // Use selected publication context on the response only. The deduplicated
    // attachment, original bytes, preview version and stored provenance stay put.
    return add(id.get(alias.attachmentId, bot.id), false, false, p);
  };
  const item = db.prepare(`SELECT id,json FROM records INDEXED BY history_attachment_item WHERE kind='attachment'
    AND json_extract(json,'$.ready')=1 AND json_extract(json,'$.artifact')=1 AND bot_id=?
    AND json_extract(json,'$.provenance.turnId')=? AND json_extract(json,'$.provenance.itemId')=?
    AND COALESCE(json_extract(json,'$.provenance.threadId'),'')=? ORDER BY id LIMIT ?`);
  for (const [turnId, itemId] of selectors.items) {
    if (attachments.size >= HISTORY_ATTACHMENT_LIMIT || bytes >= byteBudget) break;
    const selected = new Set();
    for (const row of publicationItem.all(bot.id, threadId, turnId, itemId, PER_ITEM)) {
      const value = addPublication(row, turnId, itemId); if (value) selected.add(value);
    }
    // Two exact index ranges keep LIMIT bounded even for a very large item.
    // An IN across both threads would sort all matches before applying LIMIT.
    const rows = (isolated ? [threadId] : ['', threadId]).flatMap((sourceThread) => item.all(bot.id, turnId, itemId, sourceThread, PER_ITEM));
    rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const row of rows.slice(0, PER_ITEM)) {
      if (selected.size >= PER_ITEM) break;
      const value = add(row); if (value) selected.add(value);
    }
  }
  if (selectors.turns?.length) {
    const turn = db.prepare(`SELECT json FROM records INDEXED BY history_attachment_item WHERE kind='attachment'
      AND json_extract(json,'$.ready')=1 AND json_extract(json,'$.artifact')=1 AND bot_id=?
      AND json_extract(json,'$.provenance.turnId')=? ${isolated ? "AND COALESCE(json_extract(json,'$.provenance.threadId'),'')=?" : ''} LIMIT 64`);
    for (const turnId of selectors.turns.slice(0, 25)) {
      if (attachments.size >= HISTORY_ATTACHMENT_LIMIT || bytes >= byteBudget) break;
      for (const row of publicationTurn.all(bot.id, threadId, turnId, HISTORY_ATTACHMENT_LIMIT)) addPublication(row, turnId);
      for (const row of isolated ? turn.all(bot.id, turnId, threadId) : turn.all(bot.id, turnId)) {
        const sourceThread = JSON.parse(row.json).provenance?.threadId;
        if (sourceThread === threadId || !isolated && !sourceThread) add(row);
      }
    }
  }
  return [...attachments.values()];
}

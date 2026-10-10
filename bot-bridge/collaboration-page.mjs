import { createHash } from 'node:crypto';

const integer = value => Number.isSafeInteger(value) && value >= 0;
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Additive recent pages. Scope tokens are positions, never authorization. */
export function recentCollaborationPage(store, kind, botId, params, predicate = '1', args = [], project = x => x) {
  const index = { collaborationPost: 'collaboration_recent_posts', collaborationResult: 'collaboration_recent_results' }[kind];
  if (!index) throw Error('Recent paging is supported only for room posts and result inboxes.');
  const { view, cursor, limit = 20 } = params;
  if (!['latest', 'older', 'newer'].includes(view) || !Number.isSafeInteger(limit) || limit < 1 || limit > 40)
    throw Error('Invalid recent room page.');
  const scope = createHash('sha256').update(JSON.stringify([kind, botId, predicate, args])).digest('hex');
  const token = (direction, edge, until = null) => encode({ v: 1, scope, direction, edge, until });
  let position = null;
  if (view === 'latest') {
    if (cursor != null) throw Error('Latest starts a fresh bounded page; keep the original continuation separately.');
  } else {
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) throw Error('Invalid recent room cursor.');
    try { position = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw Error('Invalid recent room cursor.'); }
    if (!position || Object.keys(position).some(key => !['v', 'scope', 'direction', 'edge', 'until'].includes(key)) ||
        position.v !== 1 || position.scope !== scope || position.direction !== view || !integer(position.edge) ||
        (position.until !== null && (!integer(position.until) || position.edge > position.until)) ||
        view === 'older' && position.until === null)
      throw Error('Recent cursor belongs to another scope or direction.');
  }
  // Closed producer kinds/indices; actual predicates/args remain server-owned.
  // Exact scope keys + implicit index rowid keep tail/range reads off old logs.
  const table = `records INDEXED BY ${index}`;
  const base = `kind='${kind}'${botId == null ? '' : ' AND bot_id=?'} AND ${predicate}`;
  const values = [...(botId == null ? [] : [botId]), ...args];
  const maximum = () => store.db.prepare(`SELECT rowid n FROM ${table} WHERE ${base} ORDER BY rowid DESC LIMIT 1`).get(...values)?.n ?? 0;
  const highWater = position?.until ?? Math.max(position?.edge ?? 0, maximum());
  if (!integer(highWater)) throw Error('Room watermark cannot be represented safely.');
  const newer = view === 'newer';
  const edgeClause = view === 'latest' ? '' : ` AND rowid${newer ? '>' : '<'}?`;
  const rows = store.db.prepare(`SELECT rowid,json FROM ${table} WHERE ${base} AND rowid<=?${edgeClause} ORDER BY rowid ${newer ? 'ASC' : 'DESC'} LIMIT ?`)
    .all(...values, highWater, ...(position ? [position.edge] : []), limit + 1);
  const items = []; let bytes = 0;
  // Reserve envelope/room/cursor space inside the existing 96 KiB ceiling.
  const budget = 92 * 1024;
  for (const row of rows.slice(0, limit)) {
    const item = { ...project(JSON.parse(row.json)), order: String(row.rowid) };
    const size = Buffer.byteLength(JSON.stringify(item));
    if (items.length && bytes + size > budget) break;
    if (size > budget) throw Error('This retained record exceeds the bounded room page. Its original bytes were kept.');
    items.push(item); bytes += size;
  }
  const more = rows.length > items.length;
  const edge = items.length ? Number(items.at(-1).order) : position?.edge ?? highWater;
  if (newer) {
    const next = more ? token('newer', edge, highWater) : null;
    return { items, view, highWater: String(highWater), nextCursor: next, complete: !more,
      newerCursor: next ?? token('newer', highWater) };
  }
  const olderCursor = more ? token('older', edge, highWater) : null;
  // Rendering is chronological even though selecting the tail/older is DESC.
  return { items: items.reverse(), view, highWater: String(highWater), nextCursor: olderCursor, complete: !more,
    olderCursor, newerCursor: token('newer', highWater) };
}

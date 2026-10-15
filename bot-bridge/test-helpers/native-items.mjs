// Test-only fake of native `thread/items/list` over a list of fake turns.
// Since f7f4e98 exact item reads use it (lib/codex-protocol/v2/ThreadItemsListParams.ts):
// the cursor is an opaque offset string or an exclusive { type: 'item', itemId }
// anchor within the requested turn; the default direction is ascending.
export function nativeItemsPage(turns, { turnId = null, cursor = null, limit = 20, sortDirection = 'asc' } = {}) {
  const entries = turns.filter((t) => !turnId || t.id === turnId).flatMap((t) => t.items.map((item) => ({ turnId: t.id, item })));
  if (sortDirection === 'desc') entries.reverse();
  let start = 0;
  if (cursor && typeof cursor === 'object') {
    const anchor = entries.findIndex((e) => e.item.id === cursor.itemId);
    if (anchor < 0) throw new Error('Unknown item anchor.');
    start = anchor + 1;
  } else if (typeof cursor === 'string') start = Number(cursor);
  const size = limit ?? 20, data = entries.slice(start, start + size);
  return { data, nextCursor: start + size < entries.length ? String(start + size) : null, backwardsCursor: null };
}

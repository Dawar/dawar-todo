import { historyBefore, historyKey, type HistoryEntry, type HistoryGap, type HistoryPosition } from "../../lib/bot-history-view";

export const VISIBLE_TURNS = 25, VISIBLE_ENTRIES = 256, VISIBLE_BODY_BYTES = 256 * 1024;
export const CACHE_ENTRIES = 2000, CACHE_BYTES = 4 * 1024 * 1024, CACHE_TURNS = 100;

const sizes = new WeakMap<HistoryEntry, number>();
export function entryBytes(entry: HistoryEntry) {
  let size = sizes.get(entry);
  if (size === undefined) { size = new TextEncoder().encode(JSON.stringify(entry)).length; sizes.set(entry, size); }
  return size;
}
/** Twenty-five native turns, with independent raw-item/byte safety bounds. */
export function historyWindow(entries: HistoryEntry[], end = entries.length, gaps: HistoryGap[] = []) {
  end = Math.min(end, entries.length);
  const boundaries = new Set(gaps.map((gap) => gap.before));
  let first = end, bytes = 0; const turns = new Set<string>();
  while (first > 0 && end - first < VISIBLE_ENTRIES) {
    const entry = entries[first - 1], size = entryBytes(entry);
    if (!turns.has(entry.turnId) && turns.size >= VISIBLE_TURNS || first < end && bytes + size > VISIBLE_BODY_BYTES) break;
    turns.add(entry.turnId); bytes += size; first--;
    if (boundaries.has(historyKey(entry.turnId, entry.id))) break;
  }
  return { first, last: end, bytes, turns: turns.size };
}
/** Shift half a window, leaving the visible edge mounted through the change. */
export function windowEndAround(entries: HistoryEntry[], anchor: number, gaps: HistoryGap[] = []) {
  let end = anchor + 1, bytes = entryBytes(entries[anchor]); const turns = new Set([entries[anchor].turnId]);
  while (end < entries.length && end - anchor < VISIBLE_ENTRIES / 2) {
    const entry = entries[end], size = entryBytes(entry);
    if (gaps.some((gap) => gap.before === historyKey(entry.turnId, entry.id))) break;
    if (!turns.has(entry.turnId) && turns.size >= 12 || bytes + size > VISIBLE_BODY_BYTES / 2) break;
    turns.add(entry.turnId); bytes += size; end++;
  }
  return end;
}

/** Interior gaps need two retained, ordered endpoints. Eviction/removal widens
 * them to the nearest surviving boundaries, or moves them to the older edge. */
export function historyBoundaries(entries: HistoryEntry[], gaps: HistoryGap[], olderCursor: string | null, previous = entries) {
  if (!entries.length) return { gaps: [], olderCursor };
  const key = (entry: HistoryEntry) => historyKey(entry.turnId, entry.id);
  const indices = new Map(entries.map((entry, index) => [key(entry), index]));
  const prior = new Map(previous.map((entry, index) => [key(entry), index]));
  const kept = previous.filter(entry => indices.has(key(entry)));
  const valid = new Map<string, HistoryGap>();
  for (const gap of gaps) {
    let before = indices.get(gap.before), stop = indices.get(gap.stop);
    const oldBefore = prior.get(gap.before), oldStop = prior.get(gap.stop);
    if (before === undefined && oldBefore !== undefined) {
      const next = kept.find(entry => prior.get(key(entry))! >= oldBefore);
      if (next) before = indices.get(key(next));
    }
    if (stop === undefined && oldStop !== undefined) {
      const preceding = kept.findLast(entry => prior.get(key(entry))! <= oldStop);
      if (preceding) stop = indices.get(key(preceding));
    }
    // Older caches can already have lost an endpoint; conservatively retain
    // the reachable interval between adjacent surviving entries.
    if (before === undefined && stop !== undefined && oldBefore === undefined && stop + 1 < entries.length) before = stop + 1;
    if (stop === undefined && before !== undefined && oldStop === undefined && before > 0) stop = before - 1;
    if (before === undefined) continue;
    if (stop === undefined) { olderCursor = historyBefore(entries[0]); continue; }
    if (stop >= before) continue; // Already crossed/reconciled; never invert.
    const right = key(entries[before]), left = key(entries[stop]);
    valid.set(right, { before: right, stop: left, cursor: right === gap.before && left === gap.stop ? gap.cursor : historyBefore(entries[before]) });
  }
  return { gaps: [...valid.values()], olderCursor };
}

/** Keep a contiguous recent tail plus a distant reading range, with explicit gaps. */
export function retainHistory(entries: HistoryEntry[], position: HistoryPosition, gaps: HistoryGap[], olderCursor: string | null, count: number, bytes: number) {
  const tail = (remainingCount: number, remainingBytes: number) => {
    let start = entries.length, used = 0; const turns = new Set<string>();
    while (start > 0 && entries.length - start < remainingCount) {
      const entry = entries[start - 1], size = entryBytes(entry);
      if (!turns.has(entry.turnId) && turns.size >= CACHE_TURNS) break;
      turns.add(entry.turnId);
      if (start < entries.length && used + size > remainingBytes) break;
      used += size; start--;
    }
    return start;
  };
  let start = tail(count, bytes);
  if (start === 0) return { entries, ...historyBoundaries(entries, gaps, olderCursor) };
  const anchor = !position.following ? entries.findIndex((entry) => historyKey(entry.turnId, entry.id) === position.anchor) : -1;
  let retained = entries.slice(start);
  if (anchor >= 0 && anchor < start) {
    const window = historyWindow(entries, windowEndAround(entries, anchor, gaps), gaps);
    const from = window.first, to = window.last;
    const used = entries.slice(from, to).reduce((sum, entry) => sum + entryBytes(entry), 0);
    start = tail(count - (to - from), bytes - used);
    retained = [...entries.slice(from, Math.min(to, start)), ...entries.slice(start)];
  }

  const kept = new Set(retained.map((entry) => historyKey(entry.turnId, entry.id)));
  const boundaries = historyBoundaries(retained, gaps, retained[0] !== entries[0] ? historyBefore(retained[0]) : olderCursor, entries);
  const savedGaps = new Map(boundaries.gaps.map((gap) => [gap.before, gap]));
  let previous = -1;
  for (let index = 0; index < entries.length; index++) {
    const key = historyKey(entries[index].turnId, entries[index].id);
    if (!kept.has(key)) continue;
    if (previous >= 0 && index > previous + 1) savedGaps.set(key, { before: key, stop: historyKey(entries[previous].turnId, entries[previous].id), cursor: historyBefore(entries[index]) });
    previous = index;
  }
  return { entries: retained, gaps: [...savedGaps.values()], olderCursor: boundaries.olderCursor };
}

const attachmentSelectors = new WeakMap<HistoryEntry, { paths: string[]; ids: string[] }>();
const attachmentSizes = new WeakMap<object, number>();
/** Disposable metadata follows retained text; the artifact library stays complete. */
export function retainedAttachments(entries: HistoryEntry[], attachments: import('../../lib/bots-types').BotAttachment[]) {
  const turns = new Set(entries.map((entry) => entry.turnId)), paths = new Set<string>(), ids = new Set<string>();
  for (const entry of entries) {
    let selectors = attachmentSelectors.get(entry);
    if (!selectors) {
      selectors = { paths: [], ids: [] };
      if (entry.item?.type === 'userMessage') for (const input of entry.item.content) if (input.type === 'localImage') selectors.paths.push(input.path);
      if (entry.item?.type === 'agentMessage') for (const match of entry.item.text.matchAll(/bot-artifact:([a-zA-Z0-9_-]+)/g)) selectors.ids.push(match[1]);
      attachmentSelectors.set(entry, selectors);
    }
    selectors.paths.forEach((path) => paths.add(path)); selectors.ids.forEach((id) => ids.add(id));
  }
  const recent = new Set(attachments.slice(-64).map((file) => file.id));
  const selected = attachments.filter((file) => recent.has(file.id) || ids.has(file.id) || paths.has(file.path ?? '') || turns.has((file as typeof file & { provenance?: { turnId?: string } }).provenance?.turnId ?? ''));
  selected.sort((a, b) => Number(ids.has(b.id) || paths.has(b.path ?? '')) - Number(ids.has(a.id) || paths.has(a.path ?? '')));
  let bytes = 0;
  return selected.filter((file, index) => { let size = attachmentSizes.get(file); if (size === undefined) { size = new TextEncoder().encode(JSON.stringify(file)).length; attachmentSizes.set(file, size); } bytes += size; return index < 512 && bytes <= 256 * 1024; });
}

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
  if (start === 0) return { entries, gaps, olderCursor };
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
  const savedGaps = new Map(gaps.filter((gap) => kept.has(gap.before)).map((gap) => [gap.before, gap]));
  let previous = -1;
  for (let index = 0; index < entries.length; index++) {
    const key = historyKey(entries[index].turnId, entries[index].id);
    if (!kept.has(key)) continue;
    if (previous >= 0 && index > previous + 1) savedGaps.set(key, { before: key, stop: historyKey(entries[previous].turnId, entries[previous].id), cursor: historyBefore(entries[index]) });
    previous = index;
  }
  return { entries: retained, gaps: [...savedGaps.values()], olderCursor: retained[0] !== entries[0] ? historyBefore(retained[0]) : olderCursor };
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

import type { HistoryEntry } from '../../lib/bot-history-view';
import type { SecureRequest } from '../../lib/secure-input';

export type ConversationGroup = { kind: string; entries: HistoryEntry[]; secure?: SecureRequest };

/** Insert description-only cards in the loaded timeline range. Native history,
 * cursors, reply targets and persistence remain native-only. An older request
 * appears when its part of history is loaded, never at the latest-message tail. */
export function secureTimelineGroups(groups: ConversationGroup[], requests: SecureRequest[], entries: HistoryEntry[], first: number, last: number, olderCursor: string | null): ConversationGroup[] {
  const at = (entry: HistoryEntry) => entry.messageAt ?? entry.startedAt ?? Infinity;
  const lower = first > 0 || olderCursor ? entries[first] ? at(entries[first]) : Infinity : -Infinity;
  const upper = last < entries.length ? at(entries[last]) : Infinity;
  const result = [...groups];
  for (const request of [...requests].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    const time = Date.parse(request.createdAt) / 1000;
    if (!Number.isFinite(time) || time < lower || time >= upper) continue;
    const next = result.findIndex(group => group.secure ? Date.parse(group.secure.createdAt) / 1000 > time : at(group.entries[0]) > time);
    result.splice(next < 0 ? result.length : next, 0, { kind: `secure:${request.id}`, entries: [], secure: request });
  }
  return result;
}

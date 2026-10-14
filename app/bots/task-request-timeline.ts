import type { TaskRequest } from '../../lib/task-requests';
import type { HistoryEntry } from '../../lib/bot-history-view';
import type { ConversationGroup } from './secure-input-timeline';
/** UI cards only; no native history item, cursor or reply identity is invented. */
export function taskRequestGroups(groups: ConversationGroup[], requests: TaskRequest[], entries: HistoryEntry[], first: number, last: number, olderCursor: string | null): ConversationGroup[] {
    const at = (e: HistoryEntry) => e.messageAt ?? e.startedAt ?? Infinity;
    const lower = first > 0 || olderCursor ? entries[first] ? at(entries[first]) : Infinity : -Infinity;
    const upper = last < entries.length ? at(entries[last]) : Infinity, result = [...groups];
    const time = (g: ConversationGroup) => g.taskRequest ? Date.parse(g.taskRequest.createdAt) / 1000 : g.secure ? Date.parse(g.secure.createdAt) / 1000 : g.entries[0] ? at(g.entries[0]) : Infinity;
    for (const request of [...requests].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
        const created = Date.parse(request.createdAt) / 1000;
        if (!Number.isFinite(created) || created < lower || created >= upper)
            continue;
        const index = result.findIndex(g => time(g) > created);
        result.splice(index < 0 ? result.length : index, 0, { kind: `task-request:${request.id}`, entries: [], taskRequest: request });
    }
    return result;
}

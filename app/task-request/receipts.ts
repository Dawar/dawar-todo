import type { TaskRequest } from '../../lib/task-requests';
const terminal = new Set(['native-accepted', 'response-sent', 'needs-review', 'private-unavailable']);
/** Old mutation receipts must not overwrite a newer visible submission or terminal delivery. */
export function mergeFormReceipt<T extends TaskRequest>(old: T | null, next: T): T {
    if (!old || old.id !== next.id)
        return next;
    if (old.revision > next.revision)
        return old;
    if (old.submission && next.submission && old.submission.id === next.submission.id) {
        if (old.submission.revision > next.submission.revision)
            return { ...next, submission: old.submission };
        if (old.submission.revision === next.submission.revision && terminal.has(old.submission.status) && !terminal.has(next.submission.status))
            return { ...next, submission: old.submission };
    }
    return next;
}

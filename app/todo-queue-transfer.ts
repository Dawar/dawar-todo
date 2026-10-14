import type { TaskQueueExportReceipt, TaskQueueSource } from '../lib/task-queue-export';
import type { TaskQueueBinding, TaskDelegation } from '../lib/task-queue-delegation';
export type TaskTransferItem = {
    todoId: number;
    exportOperationId: string;
    queueOperationId: string;
    dispositionOperationId: string;
    source?: TaskQueueSource;
    sourceRevision?: string;
    queueParams?: {
        taskExportId: string;
        taskSource: {
            todoId: number;
            revision: string;
            exportOperationId: string;
        };
        listId: string | null;
    };
    queueRequested?: boolean;
    rejected?: boolean;
    accepted?: TaskQueueBinding;
    delegation?: TaskDelegation;
    active?: boolean;
    error?: string;
};
export type TaskTransfer = {
    version: 1;
    id: string;
    owner: string;
    botId: string;
    listId: string | null;
    items: TaskTransferItem[];
    createdAt: string;
};
const prefix = (owner: string) => `dawar-todo-queue:v1:${encodeURIComponent(owner)}:`;
export function saveTransfer(value: TaskTransfer) { const key = prefix(value.owner) + value.id; const json = JSON.stringify({ ...value, items: value.items.map(item => { const saved = { ...item }; delete saved.source; return saved; }) }); localStorage.setItem(key, json); if (localStorage.getItem(key) !== json)
    throw Error('Save the transfer intent before queueing. Keep this site’s storage.'); }
export function readTransfers(owner: string): TaskTransfer[] {
    return Object.keys(localStorage).filter(k => k.startsWith(prefix(owner))).map(k => {
        const v = JSON.parse(localStorage.getItem(k)!) as TaskTransfer;
        if (v.version !== 1 || v.owner !== owner || k !== prefix(owner) + v.id || typeof v.botId !== 'string' || v.listId !== null && typeof v.listId !== 'string' || !Array.isArray(v.items) || !v.items.length || v.items.length > 100
            || v.items.some(i => !Number.isSafeInteger(i.todoId) || i.todoId < 1 || [i.queueOperationId, i.exportOperationId, i.dispositionOperationId].some(id => typeof id !== 'string' || !/^[\w:-]{10,180}$/.test(id))))
            throw Error('A saved task transfer needs recovery. Keep this site’s storage.');
        if (v.items.some(i => i.queueRequested && !i.queueParams || i.queueParams && (i.queueParams.listId !== v.listId || i.queueParams.taskSource?.todoId !== i.todoId || i.queueParams.taskSource?.revision !== i.sourceRevision || i.queueParams.taskSource?.exportOperationId !== i.exportOperationId || !/^task-export:[a-f0-9]{64}$/.test(i.queueParams.taskExportId))))
            throw Error("Original task transfer identity needs recovery. Keep this site’s storage.");
        return v;
    }).filter(v => v.items.some(i => !i.delegation && !i.rejected)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export function createTransfer(owner: string, botId: string, listId: string | null, ids: number[]): TaskTransfer {
    if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => id < 1))
        throw Error('Select up to 100 saved tasks.');
    return { version: 1, id: crypto.randomUUID(), owner, botId, listId, createdAt: new Date().toISOString(), items: ids.map(todoId => ({ todoId,
            exportOperationId: `todo-export:${crypto.randomUUID()}`, queueOperationId: `todo-queue:${crypto.randomUUID()}`, dispositionOperationId: `todo-delegate:${crypto.randomUUID()}` })) };
}
export type TransferServices = {
    currentOwner: () => string;
    guard: (id: number, source?: TaskQueueSource) => Promise<void>;
    source: (id: number, bot: string) => Promise<TaskQueueSource>;
    export: (id: number, bot: string, source: TaskQueueSource, operationId: string) => Promise<TaskQueueExportReceipt>;
    add: (bot: string, params: {
        taskExportId: string;
        taskSource: {
            todoId: number;
            revision: string;
            exportOperationId: string;
        };
        listId: string | null;
    }, operationId: string) => Promise<{
        taskSource?: TaskQueueBinding;
    }>;
    confirm: (bot: string, params: {
        taskExportId: string;
        queueOperationId: string;
    }, operationId: string) => Promise<{
        delegation: TaskDelegation;
        active: boolean;
    }>;
    persist: (transfer: TaskTransfer) => void;
    changed: () => void;
};
/** Each original item is independently recoverable; confirmed ones never add again. */
export async function runTransfer(transfer: TaskTransfer, services: TransferServices) {
    const owner = () => { if (services.currentOwner() !== transfer.owner)
        throw Error('Reopen this transfer as its original owner.'); };
    owner();
    services.persist(transfer);
    for (const item of transfer.items) {
        owner();
        if (item.delegation || item.rejected)
            continue;
        try {
            if (!item.queueRequested && !item.accepted) {
                await services.guard(item.todoId);
                owner();
                if (!item.source) {
                    item.source = await services.source(item.todoId, transfer.botId);
                    owner();
                    if (item.sourceRevision && item.sourceRevision !== item.source.revision) {
                        item.rejected = true;
                        throw Error("Source changed before any queue submission. The task stays active; select its current version explicitly.");
                    }
                    item.sourceRevision = item.source.revision;
                    services.persist(transfer);
                }
                await services.guard(item.todoId, item.source);
                owner();
                if (!item.queueParams) {
                    const r = await services.export(item.todoId, transfer.botId, item.source, item.exportOperationId);
                    owner();
                    if (r.operationId !== item.exportOperationId || r.botId !== transfer.botId || r.source.todoId !== item.todoId || r.source.revision !== item.source.revision)
                        throw Error('Original export receipt differs from this task transfer.');
                    item.queueParams = { taskExportId: r.taskExportId, taskSource: { todoId: item.todoId, revision: r.source.revision, exportOperationId: item.exportOperationId }, listId: transfer.listId };
                    services.persist(transfer);
                }
            }
            if (!item.accepted) {
                if (!item.queueRequested) {
                    await services.guard(item.todoId, item.source);
                    owner();
                }
                const params = item.queueParams;
                if (!params)
                    throw Error('Original task export receipt is unavailable.');
                // Persist before request; reload/lost ACK sends the exact original params.
                item.queueRequested = true;
                services.persist(transfer);
                owner();
                let result: {
                    taskSource?: TaskQueueBinding;
                };
                try {
                    result = await services.add(transfer.botId, params, item.queueOperationId);
                }
                catch (e) {
                    if ((e as {
                        outcome?: string;
                    }).outcome === "rejected")
                        item.rejected = true;
                    throw e;
                }
                owner();
                const a = result.taskSource;
                if (!a || a.queueOperationId !== item.queueOperationId || a.taskExportId !== params.taskExportId || a.botId !== transfer.botId || a.todoId !== item.todoId || a.listId !== transfer.listId || a.revision !== params.taskSource.revision)
                    throw Error('Original queue acceptance is unconfirmed. Retain the same operation.');
                item.accepted = a;
                services.persist(transfer);
            }
            const result = await services.confirm(transfer.botId, { taskExportId: item.accepted.taskExportId, queueOperationId: item.queueOperationId }, item.dispositionOperationId);
            owner();
            const d = result.delegation;
            if (d.version !== 1 || d.operationId !== item.dispositionOperationId || d.queueOperationId !== item.queueOperationId || d.taskExportId !== item.accepted.taskExportId || d.botId !== transfer.botId || d.listId !== transfer.listId || d.todoId !== item.todoId || d.sourceRevision !== item.accepted.revision || typeof result.active !== "boolean")
                throw Error("Original task-list confirmation is unverified. Keep the accepted queue receipt.");
            item.delegation = result.delegation;
            item.active = result.active;
            item.error = result.active ? 'Queued. The newer source task remains active.' : undefined;
            services.persist(transfer);
            services.changed();
        }
        catch (error) {
            item.error = error instanceof Error ? error.message : 'Awaiting original transfer confirmation.';
            services.persist(transfer);
        }
        services.changed();
    }
}

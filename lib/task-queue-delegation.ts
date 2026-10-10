export type TaskQueueBinding = {
    kind: 'todo';
    version: 1;
    taskExportId: string;
    todoId: number;
    revision: string;
    exportOperationId: string;
    queueOperationId: string;
    botId: string;
    listId: string | null;
};
export type TaskDelegation = {
    version: 1;
    operationId: string;
    queueOperationId: string;
    taskExportId: string;
    todoId: number;
    sourceRevision: string;
    botId: string;
    listId: string | null;
    confirmedAt: string;
};

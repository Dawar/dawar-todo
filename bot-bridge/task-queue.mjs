// Owner task imports extend the ordinary local queue; no native execution here.
export async function taskQueueInput(runtime, bot, params, operationId) {
    if (!runtime.storage || bot.archived || bot.archiving || bot.deletedAt)
        throw Error('Task queue destination is unavailable.');
    const { receipt, sourceCurrent } = await runtime.storage.resolveTaskExport(bot, params.taskExportId);
    const expected = params.taskSource;
    if (!sourceCurrent)
        throw Error('The source task changed. Retain the original transfer and review the newer task.');
    if (!expected || expected.todoId !== receipt.source.todoId || expected.revision !== receipt.source.revision || expected.exportOperationId !== receipt.operationId)
        throw Error('Task export identity differs from the original transfer.');
    if (params.text !== undefined || params.attachments !== undefined || params.reply !== undefined)
        throw Error('Task imports use the confirmed export content and files.');
    const source = { kind: 'todo', version: 1, taskExportId: receipt.taskExportId, todoId: receipt.source.todoId,
        revision: receipt.source.revision, exportOperationId: receipt.operationId, queueOperationId: operationId,
        botId: bot.id, listId: params.listId ?? null };
    const text = `${receipt.source.title}\n\n${receipt.source.notes}\n\nSource task: [Open original task](/?task=${receipt.source.todoId})`;
    const attachments = receipt.files.map(file => file.attachmentId);
    const input = await runtime.messageInput(bot, { text, attachments });
    const fresh = await runtime.storage.resolveTaskExport(bot, params.taskExportId);
    if (!fresh.sourceCurrent || fresh.receipt.source.revision !== receipt.source.revision)
        throw Error("Task changed during file preparation. The original transfer is retained.");
    const current = runtime.store.bot(bot.id);
    if (current.archived || current.archiving || current.deletedAt)
        throw Error('Task queue destination changed during preparation.');
    return { input, params: { ...params, text, attachments }, source };
}
export async function confirmTaskQueue(runtime, botId, params, operationId) {
    const accepted = runtime.store.operation(params.queueOperationId);
    const source = accepted?.result?.taskSource;
    if (!(accepted?.result?.queuedSubmission?.id || accepted?.result?.consumedTurnId) || accepted?.status !== 'done' || accepted.method !== 'queue.add' || accepted.botId !== botId || !source || source.kind !== 'todo'
        || source.queueOperationId !== params.queueOperationId || source.botId !== botId || source.taskExportId !== params.taskExportId)
        throw Error('A positive original task queue acceptance receipt is required. The task remains active.');
    if (!runtime.storage)
        throw Error('Task queue confirmation is unavailable. Retain the original accepted receipt.');
    // Private service validates the immutable export, current source and same-ID
    // disposition. Never resolve/re-add the queue item to recover this step.
    const result = await runtime.storage.call('taskQueueDelegate', { operationId, queueOperationId: params.queueOperationId, botId,
        taskExportId: source.taskExportId, todoId: source.todoId, sourceRevision: source.revision, listId: source.listId });
    if (result.delegation?.queueOperationId !== params.queueOperationId || result.delegation?.operationId !== operationId
        || result.delegation?.taskExportId !== source.taskExportId || result.delegation?.botId !== botId
        || result.delegation?.todoId !== source.todoId || result.delegation?.sourceRevision !== source.revision || result.delegation?.listId !== source.listId || result.delegation?.version !== 1 || typeof result.active !== "boolean")
        throw Error('Task delegation acknowledgement does not match the original transfer.');
    return { delegation: result.delegation, active: result.active };
}

import {
  readTodoMutationReceipt,
  reorderTodos,
  saveTodoMutationReceipt,
} from "../../../../db/todos";

const RECEIPT_KIND = "reorder";

export async function PATCH(request: Request) {
  const startedAt = Date.now();
  try {
    const payload = (await request.json()) as {
      orderedIds?: unknown;
      operationId?: unknown;
    };
    if (!Array.isArray(payload.orderedIds)) {
      return Response.json({ error: "A complete task order is required." }, { status: 400 });
    }
    const operationId = typeof payload.operationId === "string" ? payload.operationId.trim() : "";
    if (!/^[0-9a-f-]{36}$/i.test(operationId)) {
      return Response.json({ error: "A valid reorder operation identifier is required." }, { status: 400 });
    }
    const replay = await readTodoMutationReceipt<Awaited<ReturnType<typeof reorderTodos>>>(operationId, RECEIPT_KIND);
    if (replay) {
      console.info("[todo-api] task reorder replayed", {
        operationId,
        requested: payload.orderedIds.length,
        durationMs: Date.now() - startedAt,
      });
      return Response.json(replay);
    }
    const result = await reorderTodos(payload.orderedIds.map(Number));
    const stored = await saveTodoMutationReceipt(operationId, RECEIPT_KIND, result);
    console.info("[todo-api] task order persisted", {
      operationId,
      requested: payload.orderedIds.length,
      returned: result.todos.length,
      changed: result.changedIds.length,
      changedIds: result.changedIds,
      durationMs: Date.now() - startedAt,
    });
    return Response.json(stored);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The task order could not be saved.";
    const inputError = /task|order|invalid|duplicate|limited|exist|required|choose/i.test(message);
    console.error("[todo-api] task reorder failed", {
      durationMs: Date.now() - startedAt,
      error,
    });
    return Response.json({ error: message }, { status: inputError ? 400 : 500 });
  }
}

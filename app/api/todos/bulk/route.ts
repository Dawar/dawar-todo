import { BulkTodoAction, bulkUpdateTodos, mergeTodos } from "../../../../db/todos";

const actions = new Set<BulkTodoAction>(["complete", "archive", "snooze", "unsnooze", "reproject", "delete"]);

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const payload = (await request.json()) as {
      ids?: unknown;
      action?: BulkTodoAction | "merge";
      project?: unknown;
    };
    if (!Array.isArray(payload.ids)) {
      return Response.json({ error: "Choose one or more tasks." }, { status: 400 });
    }
    const ids = payload.ids.map(Number);
    if (payload.action === "merge") {
      const result = await mergeTodos(ids);
      console.info("[todo-api] bulk merged", {
        sourceCount: result.ids.length,
        mergedId: result.todo.id,
        durationMs: Date.now() - startedAt,
      });
      return Response.json(result);
    }
    if (!payload.action || !actions.has(payload.action)) {
      return Response.json({ error: "Choose a valid bulk action." }, { status: 400 });
    }
    const project = payload.project == null ? null : String(payload.project).trim() || null;
    if (project && project.length > 120) {
      return Response.json({ error: "Project names are limited to 120 characters." }, { status: 400 });
    }
    const result = await bulkUpdateTodos(ids, payload.action, { project });
    console.info("[todo-api] bulk action", {
      action: payload.action,
      count: result.ids.length,
      durationMs: Date.now() - startedAt,
    });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The bulk action could not be completed.";
    const inputError = /Choose|limited|selected tasks|project/i.test(message);
    console.error("[todo-api] bulk action failed", { error, durationMs: Date.now() - startedAt });
    return Response.json({ error: message }, { status: inputError ? 400 : 500 });
  }
}

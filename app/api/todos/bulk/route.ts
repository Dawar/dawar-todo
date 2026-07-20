import { adjustSnoozedTodos, BulkTodoAction, bulkUpdateTodos, mergeTodos, type SnoozePreset } from "../../../../db/todos";

const actions = new Set<BulkTodoAction>(["complete", "snooze", "unsnooze", "reproject", "delete"]);
const snoozePresets = new Set<SnoozePreset>(["15m", "30m", "1h", "2h", "8pm"]);

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const payload = (await request.json()) as {
      ids?: unknown;
      action?: BulkTodoAction | "merge" | "adjust_snooze";
      project?: unknown;
      snoozePreset?: unknown;
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
    if (payload.action === "adjust_snooze") {
      const snoozePreset = String(payload.snoozePreset ?? "") as SnoozePreset;
      if (!snoozePresets.has(snoozePreset)) {
        return Response.json({ error: "Choose a valid snooze adjustment." }, { status: 400 });
      }
      const result = await adjustSnoozedTodos(ids, snoozePreset);
      console.info("[todo-api] snooze adjusted", {
        preset: snoozePreset,
        requested: ids.length,
        changed: result.ids.length,
        snoozedUntil: result.snoozedUntil,
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
    const inputError = /Choose|limited|selected tasks|project|snooze/i.test(message);
    console.error("[todo-api] bulk action failed", { error, durationMs: Date.now() - startedAt });
    return Response.json({ error: message }, { status: inputError ? 400 : 500 });
  }
}

import {
  adjustSnoozedTodos,
  adjustSnoozedTodosToLocalDateTime,
  BulkTodoAction,
  bulkUpdateTodos,
  mergeTodos,
  readTodoMutationReceipt,
  saveTodoMutationReceipt,
  type SnoozePreset,
} from "../../../../db/todos";
import { isQuickSnoozePreset } from "../../../../lib/snooze-presets";
import { stopUrgentAlertForTodo } from "../../../../db/urgent-alerts";

const actions = new Set<BulkTodoAction>(["complete", "reopen", "snooze", "unsnooze", "reproject", "delete"]);

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const payload = (await request.json()) as {
      ids?: unknown;
      action?: BulkTodoAction | "merge" | "adjust_snooze";
      project?: unknown;
      snoozePreset?: unknown;
      snoozedLocal?: unknown;
      operationId?: unknown;
    };
    if (!Array.isArray(payload.ids)) {
      return Response.json({ error: "Choose one or more tasks." }, { status: 400 });
    }
    const ids = payload.ids.map(Number);
    const operationId = typeof payload.operationId === "string" ? payload.operationId.trim() : "";
    if (operationId && !/^[0-9a-f-]{36}$/i.test(operationId)) {
      return Response.json({ error: "A valid mutation operation identifier is required." }, { status: 400 });
    }
    const receiptKind = `bulk:${String(payload.action ?? "unknown")}`;
    if (operationId) {
      const replay = await readTodoMutationReceipt<Record<string, unknown>>(operationId, receiptKind);
      if (replay) {
        console.info("[todo-api] bulk mutation replayed", {
          operationId,
          action: payload.action ?? null,
          requested: ids.length,
          durationMs: Date.now() - startedAt,
        });
        return Response.json(replay);
      }
    }
    if (payload.action === "merge") {
      const result = await mergeTodos(ids);
      await Promise.all(result.ids.map((id) => stopUrgentAlertForTodo(id, "merged")));
      console.info("[todo-api] bulk merged", {
        sourceCount: result.ids.length,
        mergedId: result.todo.id,
        durationMs: Date.now() - startedAt,
      });
      return Response.json(operationId
        ? await saveTodoMutationReceipt(operationId, receiptKind, result)
        : result);
    }
    if (payload.action === "adjust_snooze") {
      const snoozePreset = String(payload.snoozePreset ?? "") as SnoozePreset;
      const snoozedLocal = String(payload.snoozedLocal ?? "").trim();
      if (!isQuickSnoozePreset(snoozePreset) && snoozePreset !== "8pm" && !snoozedLocal) {
        return Response.json({ error: "Choose a valid snooze adjustment." }, { status: 400 });
      }
      const result = snoozedLocal
        ? await adjustSnoozedTodosToLocalDateTime(ids, snoozedLocal)
        : await adjustSnoozedTodos(ids, snoozePreset);
      console.info("[todo-api] snooze adjusted", {
        mode: snoozedLocal ? "custom" : "preset",
        preset: snoozedLocal ? null : snoozePreset,
        localDateTime: snoozedLocal || null,
        requested: ids.length,
        changed: result.ids.length,
        snoozedUntil: result.snoozedUntil,
        durationMs: Date.now() - startedAt,
      });
      return Response.json(operationId
        ? await saveTodoMutationReceipt(operationId, receiptKind, result)
        : result);
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
    return Response.json(operationId
      ? await saveTodoMutationReceipt(operationId, receiptKind, result)
      : result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The bulk action could not be completed.";
    const inputError = /Choose|limited|selected tasks|project|snooze|date|time|future|daylight/i.test(message);
    console.error("[todo-api] bulk action failed", { error, durationMs: Date.now() - startedAt });
    return Response.json({ error: message }, { status: inputError ? 400 : 500 });
  }
}

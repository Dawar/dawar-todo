import { env } from "cloudflare:workers";
import { createTodo, ensureTodoDatabase, listTodos } from "../../../db/todos";
import { scheduleAttachmentCleanup } from "../../../db/attachments";
import { processRecurringTodos } from "../../../worker/recurring";

let lastRecurrenceSyncMinute = "";

export async function GET() {
  const startedAt = Date.now();
  try {
    await ensureTodoDatabase();
    const now = new Date();
    const recurrenceMinute = new Date(Math.floor(now.valueOf() / 60_000) * 60_000).toISOString();
    const recurrence = recurrenceMinute === lastRecurrenceSyncMinute
      ? null
      : await processRecurringTodos(env.DB, now, {
        catchUp: true,
        source: "todo-list-sync",
      });
    lastRecurrenceSyncMinute = recurrenceMinute;
    const todos = await listTodos();
    await scheduleAttachmentCleanup();
    console.info("[todo-api] list", {
      count: todos.length,
      recurringReopened: recurrence?.reopened ?? 0,
      recurrenceSkipped: recurrence === null || Boolean("skipped" in recurrence && recurrence.skipped),
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ todos, serverTime: new Date().toISOString() }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    console.error("[todo-api] list failed", error);
    return Response.json({ error: "Your tasks could not be loaded." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      title?: string;
      notes?: string;
      priority?: number;
      dueDate?: string | null;
      project?: string | null;
      context?: string | null;
      recurrenceCron?: string | null;
      status?: unknown;
      draftToken?: string;
      attachmentIds?: string[];
      clientId?: string;
    };
    const title = payload.title?.trim() ?? "";
    if (!title) return Response.json({ error: "A task title is required." }, { status: 400 });
    if (title.length > 2000) return Response.json({ error: "Keep the task under 2,000 characters." }, { status: 400 });

    const priority = Number.isInteger(payload.priority) && Number(payload.priority) >= 1 && Number(payload.priority) <= 4
      ? Number(payload.priority)
      : 3;
    if (payload.status !== undefined && payload.status !== "open") {
      return Response.json({ error: "New tasks must be open." }, { status: 400 });
    }
    const project = payload.project?.trim() || null;
    const todo = await createTodo({
      title,
      notes: payload.notes?.trim(),
      priority,
      dueDate: payload.dueDate || null,
      project,
      context: payload.context?.trim() || null,
      recurrenceCron: payload.recurrenceCron,
      draftToken: payload.draftToken,
      attachmentIds: Array.isArray(payload.attachmentIds) ? payload.attachmentIds.map(String) : undefined,
      clientId: payload.clientId,
    });
    console.info("[todo-api] created", {
      id: todo.id,
      status: todo.status,
      project: todo.project,
      priority: todo.priority,
      titleLength: title.length,
      attachmentCount: todo.attachmentCount,
      clientId: todo.clientId,
      recurrenceCron: todo.recurrenceCron,
    });
    return Response.json({ todo }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The task could not be added.";
    const inputError = /task|attached|attachment|image|audio|video|media|file|document|archive|limited|invalid|available|required|cron|minute|hour|month|weekday/i.test(message);
    console.error("[todo-api] create failed", error);
    return Response.json({ error: message }, { status: inputError ? 400 : 500 });
  }
}

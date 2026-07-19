import { createTodo, listTodos } from "../../../db/todos";
import { scheduleAttachmentCleanup } from "../../../db/attachments";

export async function GET() {
  const startedAt = Date.now();
  try {
    const todos = await listTodos();
    await scheduleAttachmentCleanup();
    console.info("[todo-api] list", { count: todos.length, durationMs: Date.now() - startedAt });
    return Response.json({ todos });
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
    });
    return Response.json({ todo }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The task could not be added.";
    const inputError = /task|attached|attachment|image|audio|video|media|limited|invalid|available|required/i.test(message);
    console.error("[todo-api] create failed", error);
    return Response.json({ error: message }, { status: inputError ? 400 : 500 });
  }
}

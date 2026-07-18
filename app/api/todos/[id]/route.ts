import { TodoStatus, TodoUpdate, updateTodo } from "../../../../db/todos";

const statuses = new Set<TodoStatus>(["open", "completed", "archived"]);

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: idParam } = await context.params;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Invalid task." }, { status: 400 });

  try {
    const payload = (await request.json()) as TodoUpdate;
    const update: TodoUpdate = {};
    if (payload.title !== undefined) {
      const title = String(payload.title).trim();
      if (!title) return Response.json({ error: "A task title is required." }, { status: 400 });
      update.title = title;
    }
    if (payload.notes !== undefined) update.notes = String(payload.notes).trim();
    if (payload.status !== undefined) {
      if (!statuses.has(payload.status)) return Response.json({ error: "Invalid status." }, { status: 400 });
      update.status = payload.status;
    }
    if (payload.priority !== undefined) {
      const priority = Number(payload.priority);
      if (!Number.isInteger(priority) || priority < 1 || priority > 4) {
        return Response.json({ error: "Invalid priority." }, { status: 400 });
      }
      update.priority = priority;
    }
    if (payload.dueDate !== undefined) update.dueDate = payload.dueDate || null;
    if (payload.project !== undefined) update.project = payload.project?.trim() || null;
    if (payload.context !== undefined) update.context = payload.context?.trim() || null;

    const result = await updateTodo(id, update);
    if (!result) return Response.json({ error: "Task not found." }, { status: 404 });
    console.info("[todo-api] updated", {
      id,
      fields: Object.keys(update),
      status: result.todo.status,
      undoable: Boolean(result.undoToken),
    });
    return Response.json(result);
  } catch (error) {
    console.error("[todo-api] update failed", { id, error });
    return Response.json({ error: "The task could not be updated." }, { status: 500 });
  }
}

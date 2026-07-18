import { createTodo, listTodos, type TodoStatus } from "../../../db/todos";

export async function GET() {
  const startedAt = Date.now();
  try {
    const todos = await listTodos();
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
      status?: TodoStatus;
    };
    const title = payload.title?.trim() ?? "";
    if (!title) return Response.json({ error: "A task title is required." }, { status: 400 });
    if (title.length > 2000) return Response.json({ error: "Keep the task under 2,000 characters." }, { status: 400 });

    const priority = Number.isInteger(payload.priority) && Number(payload.priority) >= 1 && Number(payload.priority) <= 4
      ? Number(payload.priority)
      : 3;
    const status = payload.status ?? "open";
    if (status !== "open" && status !== "archived") {
      return Response.json({ error: "New tasks can only be open or archived." }, { status: 400 });
    }
    const project = payload.project?.trim() || null;
    if (status === "archived" && !project) {
      return Response.json({ error: "Choose a project before adding an archived note." }, { status: 400 });
    }
    const todo = await createTodo({
      title,
      status,
      notes: payload.notes?.trim(),
      priority,
      dueDate: payload.dueDate || null,
      project,
      context: payload.context?.trim() || null,
    });
    console.info("[todo-api] created", {
      id: todo.id,
      status: todo.status,
      project: todo.project,
      priority: todo.priority,
      titleLength: title.length,
    });
    return Response.json({ todo }, { status: 201 });
  } catch (error) {
    console.error("[todo-api] create failed", error);
    return Response.json({ error: "The task could not be added." }, { status: 500 });
  }
}

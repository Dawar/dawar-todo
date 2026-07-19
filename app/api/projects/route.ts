import { createTodoProject, deleteTodoProject, listTodoProjects, type ProjectDeleteMode } from "../../../db/todos";

export async function GET() {
  const startedAt = Date.now();
  try {
    const projects = await listTodoProjects();
    console.info("[todo-api] projects listed", { count: projects.length, durationMs: Date.now() - startedAt });
    return Response.json({ projects });
  } catch (error) {
    console.error("[todo-api] project list failed", error);
    return Response.json({ error: "Your projects could not be loaded." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { name?: string };
    const name = payload.name?.trim() ?? "";
    if (!name) return Response.json({ error: "A project name is required." }, { status: 400 });
    if (name.length > 120) {
      return Response.json({ error: "Project names are limited to 120 characters." }, { status: 400 });
    }
    const project = await createTodoProject(name);
    console.info("[todo-api] project created", { project, nameLength: project.length });
    return Response.json({ project }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The project could not be created.";
    const duplicate = message.includes("already exists");
    console.error("[todo-api] project create failed", { duplicate, error });
    return Response.json({ error: message }, { status: duplicate ? 409 : 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const payload = (await request.json()) as {
      name?: string;
      mode?: ProjectDeleteMode;
      targetProject?: string | null;
    };
    const name = payload.name?.trim() ?? "";
    if (!name) return Response.json({ error: "A project name is required." }, { status: 400 });
    if (payload.mode !== "reassign" && payload.mode !== "delete") {
      return Response.json({ error: "Choose whether to move or delete this project's notes." }, { status: 400 });
    }
    const result = await deleteTodoProject(name, payload.mode, payload.targetProject);
    console.info("[todo-api] project deleted", result);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The project could not be deleted.";
    const missing = message.includes("no longer exists");
    const invalid = message.startsWith("Choose");
    console.error("[todo-api] project delete failed", { missing, invalid, error });
    return Response.json({ error: message }, { status: missing ? 404 : invalid ? 400 : 500 });
  }
}

import {
  assistantUserKey,
  readAssistantThread,
  readAssistantWorkspace,
  updateAssistantThreadState,
  updateAssistantWorkspace,
  type AssistantNavigatorView,
} from "../../../db/assistant";
import { listTodos, listTodoProjects } from "../../../db/todos";

const views = new Set<AssistantNavigatorView>(["open", "snoozed", "done", "all"]);

export async function GET(request: Request) {
  const startedAt = Date.now();
  const userKey = assistantUserKey(request);
  try {
    const [todos, projects] = await Promise.all([listTodos(), listTodoProjects()]);
    const workspace = await readAssistantWorkspace(userKey, todos);
    const requestedId = Number(new URL(request.url).searchParams.get("taskId"));
    const selectedTodoId = Number.isInteger(requestedId) && todos.some((todo) => todo.id === requestedId)
      ? requestedId
      : workspace.selectedTodoId;
    const thread = selectedTodoId ? await readAssistantThread(userKey, selectedTodoId) : null;
    console.info("[todo-assistant-api] workspace loaded", {
      userKey,
      selectedTodoId,
      taskCount: todos.length,
      projectCount: projects.length,
      messageCount: thread?.messages.length ?? 0,
      durationMs: Date.now() - startedAt,
    });
    return Response.json(
      { todos, projects, workspace: { ...workspace, selectedTodoId }, thread },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[todo-assistant-api] workspace load failed", { userKey, durationMs: Date.now() - startedAt, error });
    return Response.json({ error: "The assistant workspace could not be loaded." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const startedAt = Date.now();
  const userKey = assistantUserKey(request);
  try {
    const payload = await request.json() as {
      selectedTodoId?: unknown;
      navigatorView?: unknown;
      taskId?: unknown;
      draftText?: unknown;
      draftAttachmentIds?: unknown;
      paused?: unknown;
    };
    let workspace = null;
    let thread = null;
    if (payload.selectedTodoId !== undefined || payload.navigatorView !== undefined) {
      const selectedTodoId = payload.selectedTodoId === null ? null : Number(payload.selectedTodoId);
      if (payload.selectedTodoId !== undefined && selectedTodoId !== null && (!Number.isInteger(selectedTodoId) || selectedTodoId < 1)) {
        return Response.json({ error: "Invalid selected task." }, { status: 400 });
      }
      const navigatorView = payload.navigatorView === undefined ? undefined : String(payload.navigatorView) as AssistantNavigatorView;
      if (navigatorView !== undefined && !views.has(navigatorView)) {
        return Response.json({ error: "Invalid navigator view." }, { status: 400 });
      }
      workspace = await updateAssistantWorkspace(userKey, { selectedTodoId, navigatorView });
    }
    if (payload.draftText !== undefined || payload.draftAttachmentIds !== undefined || payload.paused !== undefined) {
      const taskId = Number(payload.taskId);
      if (!Number.isInteger(taskId) || taskId < 1) return Response.json({ error: "Invalid task." }, { status: 400 });
      if (payload.draftText !== undefined && typeof payload.draftText !== "string") {
        return Response.json({ error: "Invalid assistant draft." }, { status: 400 });
      }
      if (payload.paused !== undefined && typeof payload.paused !== "boolean") {
        return Response.json({ error: "Invalid pause state." }, { status: 400 });
      }
      if (payload.draftAttachmentIds !== undefined && !Array.isArray(payload.draftAttachmentIds)) {
        return Response.json({ error: "Invalid assistant attachment draft." }, { status: 400 });
      }
      thread = await updateAssistantThreadState(userKey, taskId, {
        draftText: payload.draftText as string | undefined,
        draftAttachmentIds: payload.draftAttachmentIds as string[] | undefined,
        paused: payload.paused as boolean | undefined,
      });
    }
    console.info("[todo-assistant-api] workspace state updated", {
      userKey,
      workspaceChanged: Boolean(workspace),
      threadChanged: Boolean(thread),
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ workspace, thread });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Assistant state could not be saved.";
    console.error("[todo-assistant-api] workspace state update failed", { userKey, durationMs: Date.now() - startedAt, error });
    return Response.json({ error: message }, { status: /not found|invalid/i.test(message) ? 400 : 500 });
  }
}

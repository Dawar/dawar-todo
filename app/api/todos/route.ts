import { env, waitUntil } from "cloudflare:workers";
import { createTodo, listTodos } from "../../../db/todos";
import { runTodoReadMaintenance } from "../../../db/maintenance";
import { dispatchTodoPushNotifications } from "../../../db/push-notifications";
import { createUrgentAlertCampaign, processUrgentAlertQueue } from "../../../db/urgent-alerts";
import { apiTokenActorFromRequest } from "../../../lib/request-actor";
import { validateTaskDescription } from "../../../lib/task-description";

export async function GET() {
  const startedAt = Date.now();
  try {
    const recurrence = await runTodoReadMaintenance("legacy-list");
    const todos = await listTodos();
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
    const notes = validateTaskDescription(String(payload.notes ?? ""));

    const priority = Number.isInteger(payload.priority) && Number(payload.priority) >= 1 && Number(payload.priority) <= 4
      ? Number(payload.priority)
      : 3;
    if (payload.status !== undefined && payload.status !== "open") {
      return Response.json({ error: "New tasks must be open." }, { status: 400 });
    }
    const project = payload.project?.trim() || null;
    const originDeviceId = request.headers.get("X-Dawar-Device-Id")?.trim() || null;
    const apiActor = apiTokenActorFromRequest(request);
    const todo = await createTodo({
      title,
      notes,
      priority,
      dueDate: payload.dueDate || null,
      project,
      context: payload.context?.trim() || null,
      recurrenceCron: payload.recurrenceCron,
      draftToken: payload.draftToken,
      attachmentIds: Array.isArray(payload.attachmentIds) ? payload.attachmentIds.map(String) : undefined,
      clientId: payload.clientId,
      originDeviceId,
      sourceKind: apiActor ? "api-token" : "site",
      urgentAlert: apiActor && priority === 1 ? {
        userKey: apiActor.userKey,
        sourceTokenId: apiActor.id,
        sourceAgentName: apiActor.name,
      } : undefined,
    });
    const urgentAlert = apiActor && todo.priority === 1 && todo.sourceKind === "api-token"
      ? await createUrgentAlertCampaign({
        todoId: todo.id,
        userKey: apiActor.userKey,
        sourceTokenId: apiActor.id,
        sourceAgentName: apiActor.name,
      })
      : null;
    console.info("[todo-api] created", {
      id: todo.id,
      status: todo.status,
      project: todo.project,
      priority: todo.priority,
      titleLength: title.length,
      attachmentCount: todo.attachmentCount,
      clientId: todo.clientId,
      recurrenceCron: todo.recurrenceCron,
      originSuppressionAvailable: Boolean(originDeviceId),
      actorKind: apiActor?.kind ?? "owner",
      urgentAlertId: urgentAlert?.id ?? null,
    });
    waitUntil(dispatchTodoPushNotifications(env.DB, env, new Date()).catch((pushError) => {
      console.error("[todo-push] immediate created-task delivery failed; scheduled retry retained", {
        todoId: todo.id,
        error: pushError instanceof Error ? pushError.message : String(pushError),
      });
    }));
    if (urgentAlert) {
      waitUntil(processUrgentAlertQueue(new Date(), undefined, [urgentAlert.id]).catch((urgentError) => {
        console.error("[todo-urgent-alert] immediate dispatch failed; scheduled retry retained", {
          escalationId: urgentAlert.id,
          todoId: todo.id,
          error: urgentError instanceof Error ? urgentError.message : String(urgentError),
        });
      }));
    }
    return Response.json({ todo, ...(urgentAlert ? { urgentAlert } : {}) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The task could not be added.";
    const inputError = /task|attached|attachment|image|audio|video|media|file|document|archive|limited|invalid|available|required|cron|minute|hour|month|weekday/i.test(message);
    console.error("[todo-api] create failed", error);
    return Response.json({ error: message }, { status: inputError ? 400 : 500 });
  }
}

import { waitUntil } from "cloudflare:workers";
import { readTodoSyncDelta } from "../../../db/todos";
import { runTodoReadMaintenance } from "../../../db/maintenance";

export async function GET(request: Request) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const after = Number(url.searchParams.get("after") ?? 0);
  if (!Number.isInteger(after) || after < 0) {
    return Response.json({ error: "Use a non-negative sync revision." }, { status: 400 });
  }
  try {
    waitUntil(runTodoReadMaintenance("sync").catch((error) => {
      console.error("[todo-sync] background maintenance deferred", { error });
    }));
    const delta = await readTodoSyncDelta(after);
    console.info("[todo-sync] delta served", {
      after,
      revision: delta.revision,
      reset: delta.reset,
      resetReason: delta.reset ? delta.reason : null,
      changedTodos: delta.todos.length,
      deletedTodos: delta.reset ? 0 : delta.deletedIds.length,
      projectsIncluded: delta.reset || Boolean(delta.projects),
      settingsIncluded: delta.reset || Boolean(delta.settings),
      captureDraftIncluded: delta.reset || Object.prototype.hasOwnProperty.call(delta, "captureDraft"),
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ ...delta, serverTime: new Date().toISOString() }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    console.error("[todo-sync] delta failed", {
      after,
      durationMs: Date.now() - startedAt,
      error,
    });
    return Response.json({ error: "Your tasks could not be synchronized." }, { status: 500 });
  }
}

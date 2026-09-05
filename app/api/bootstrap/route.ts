import { waitUntil } from "cloudflare:workers";
import { readTodoBootstrap } from "../../../db/todos";
import { runTodoReadMaintenance } from "../../../db/maintenance";

export async function GET() {
  const startedAt = Date.now();
  try {
    waitUntil(runTodoReadMaintenance("bootstrap").catch((error) => {
      console.error("[todo-sync] background maintenance deferred", { error });
    }));
    const snapshot = await readTodoBootstrap();
    console.info("[todo-sync] bootstrap served", {
      todos: snapshot.todos.length,
      projects: snapshot.projects.length,
      captureDraftLength: snapshot.captureDraft?.text.length ?? 0,
      captureDraftVersion: snapshot.captureDraft?.version ?? null,
      revision: snapshot.revision,
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ ...snapshot, serverTime: new Date().toISOString() }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    console.error("[todo-sync] bootstrap failed", {
      durationMs: Date.now() - startedAt,
      error,
    });
    return Response.json({ error: "Your tasks could not be loaded." }, { status: 500 });
  }
}

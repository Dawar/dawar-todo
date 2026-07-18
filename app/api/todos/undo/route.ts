import { undoTodoAction } from "../../../../db/todos";

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const payload = (await request.json()) as { undoToken?: string };
    const undoToken = String(payload.undoToken ?? "");
    const result = await undoTodoAction(undoToken);
    console.info("[todo-api] action undone", {
      restored: result.restored,
      durationMs: Date.now() - startedAt,
    });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "That action could not be undone.";
    const expired = /expired|already used|invalid/i.test(message);
    console.error("[todo-api] undo failed", { error, durationMs: Date.now() - startedAt });
    return Response.json({ error: message }, { status: expired ? 409 : 500 });
  }
}

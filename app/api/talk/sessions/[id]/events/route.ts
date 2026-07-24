import { appendTalkMessage } from "../../../../../../db/talk";
import { noStoreHeaders, talkErrorResponse, talkUserKey } from "../../../../../../lib/talk-http";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const startedAt = Date.now();
  const { id: sessionId } = await context.params;
  try {
    const userKey = talkUserKey(request);
    const payload = await request.json() as {
      realtimeItemId?: unknown;
      role?: unknown;
      content?: unknown;
      focusedTodoId?: unknown;
      metadata?: unknown;
    };
    const role = String(payload.role ?? "");
    if (!["user", "assistant", "tool", "system"].includes(role)) {
      return Response.json({ error: "Invalid transcript role." }, { status: 400, headers: noStoreHeaders });
    }
    const focusedTodoId = payload.focusedTodoId === null || payload.focusedTodoId === undefined
      ? null
      : Number(payload.focusedTodoId);
    const result = await appendTalkMessage({
      userKey,
      sessionId,
      realtimeItemId: String(payload.realtimeItemId ?? ""),
      role: role as "user" | "assistant" | "tool" | "system",
      content: String(payload.content ?? ""),
      focusedTodoId,
      metadata: payload.metadata && typeof payload.metadata === "object"
        ? payload.metadata as Record<string, unknown>
        : {},
    });
    console.info("[todo-talk-api] transcript event accepted", {
      sessionId,
      role,
      replayed: result.replayed,
      durationMs: Date.now() - startedAt,
    });
    return Response.json(result, { status: result.replayed ? 200 : 201, headers: noStoreHeaders });
  } catch (error) {
    console.error("[todo-talk-api] transcript event failed", {
      sessionId,
      durationMs: Date.now() - startedAt,
      error,
    });
    return talkErrorResponse(error, "The Talk transcript could not be saved.");
  }
}

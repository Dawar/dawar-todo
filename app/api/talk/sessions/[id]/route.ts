import {
  endTalkSession,
  heartbeatTalkSession,
  updateTalkFocus,
} from "../../../../../db/talk";
import { noStoreHeaders, talkErrorResponse, talkUserKey } from "../../../../../lib/talk-http";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const startedAt = Date.now();
  const { id: sessionId } = await context.params;
  try {
    const userKey = talkUserKey(request);
    const payload = await request.json() as {
      action?: unknown;
      focusedTodoId?: unknown;
      reason?: unknown;
    };
    const action = String(payload.action ?? "heartbeat");
    if (action === "end") {
      const result = await endTalkSession(userKey, sessionId, String(payload.reason ?? "ended"));
      return Response.json(result, { headers: noStoreHeaders });
    }
    if (action === "focus") {
      const focusedTodoId = payload.focusedTodoId === null ? null : Number(payload.focusedTodoId);
      if (focusedTodoId !== null && (!Number.isInteger(focusedTodoId) || focusedTodoId < 1)) {
        return Response.json({ error: "Invalid task." }, { status: 400, headers: noStoreHeaders });
      }
      const result = await updateTalkFocus(userKey, sessionId, focusedTodoId);
      return Response.json(result, { headers: noStoreHeaders });
    }
    if (action !== "heartbeat") {
      return Response.json({ error: "Invalid Talk session action." }, { status: 400, headers: noStoreHeaders });
    }
    const focusedTodoId = payload.focusedTodoId === undefined
      ? undefined
      : payload.focusedTodoId === null
        ? null
        : Number(payload.focusedTodoId);
    const result = await heartbeatTalkSession(userKey, sessionId, focusedTodoId);
    console.info("[todo-talk-api] heartbeat accepted", {
      sessionId,
      focusedTodoId: focusedTodoId ?? null,
      durationMs: Date.now() - startedAt,
    });
    return Response.json(result, { headers: noStoreHeaders });
  } catch (error) {
    console.warn("[todo-talk-api] session update rejected", {
      sessionId,
      durationMs: Date.now() - startedAt,
      error,
    });
    return talkErrorResponse(error, "The Talk session could not be updated.");
  }
}

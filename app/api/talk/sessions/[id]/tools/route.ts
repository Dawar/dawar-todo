import {
  beginTalkToolCall,
  completeTalkToolCall,
} from "../../../../../../db/talk";
import { noStoreHeaders, talkErrorResponse, talkUserKey } from "../../../../../../lib/talk-http";
import { dispatchTalkTool } from "../../../../../../lib/talk-tools";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const startedAt = Date.now();
  const { id: sessionId } = await context.params;
  let userKey = "";
  let callId = "";
  let name = "";
  try {
    userKey = talkUserKey(request);
    const payload = await request.json() as {
      callId?: unknown;
      name?: unknown;
      arguments?: unknown;
    };
    callId = String(payload.callId ?? "").trim();
    name = String(payload.name ?? "").trim();
    if (!name || name.length > 120) {
      return Response.json({ error: "Invalid Talk tool." }, { status: 400, headers: noStoreHeaders });
    }
    const args = payload.arguments && typeof payload.arguments === "object" && !Array.isArray(payload.arguments)
      ? payload.arguments as Record<string, unknown>
      : {};
    const argumentsJson = JSON.stringify(args);
    if (argumentsJson.length > 100_000) {
      return Response.json({ error: "Talk tool arguments are too large." }, { status: 400, headers: noStoreHeaders });
    }
    const existing = await beginTalkToolCall({
      userKey,
      sessionId,
      callId,
      name,
      argumentsJson,
    });
    if (existing.replayed && existing.result) {
      console.info("[todo-talk-api] idempotent tool replay returned", {
        sessionId,
        callId,
        name,
        failed: existing.failed,
        durationMs: Date.now() - startedAt,
      });
      if (existing.failed) {
        return Response.json(
          { error: String(existing.result.error ?? "That Talk action previously failed."), replayed: true },
          { status: 409, headers: noStoreHeaders },
        );
      }
      return Response.json({ result: existing.result, replayed: true }, { headers: noStoreHeaders });
    }
    if (existing.replayed && existing.pending) {
      return Response.json(
        { error: "That Talk action is already processing.", replayed: true },
        { status: 409, headers: noStoreHeaders },
      );
    }
    const result = await dispatchTalkTool({ userKey, sessionId, callId, name, arguments: args });
    await completeTalkToolCall({
      userKey,
      sessionId,
      callId,
      result,
      undoToken: typeof result.undoToken === "string" ? result.undoToken : null,
    });
    console.info("[todo-talk-api] tool call succeeded", {
      sessionId,
      callId,
      name,
      undoAvailable: Boolean(result.undoToken),
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ result, replayed: false }, { headers: noStoreHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Talk could not complete that action.";
    if (userKey && callId) {
      await completeTalkToolCall({
        userKey,
        sessionId,
        callId,
        result: { error: message },
        failed: true,
      }).catch(() => undefined);
    }
    console.error("[todo-talk-api] tool call failed", {
      sessionId,
      callId,
      name,
      durationMs: Date.now() - startedAt,
      error,
    });
    return talkErrorResponse(error, "Talk could not complete that action.");
  }
}

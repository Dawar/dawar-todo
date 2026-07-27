import {
  appendTalkMessage,
  beginTalkToolCall,
  completeTalkToolCall,
  endTalkSession,
  heartbeatTalkSession,
  listTalkHistory,
  resolveSystemTalkThread,
} from "../../../../../../db/talk";
import { endTalkPhoneCall } from "../../../../../../db/talk-phone";
import { getTodoSettings } from "../../../../../../db/todos";
import { buildSharedAssistantContext } from "../../../../../../lib/assistant-context";
import {
  authenticatePhoneBridgeRequest,
  phoneBridgeError,
  phoneBridgeHeaders,
} from "../../../../../../lib/talk-phone-bridge";
import {
  hashedSafetyIdentifier,
  mintRealtimeClientSecret,
  talkInstructions,
} from "../../../../../../lib/talk-runtime";
import { dispatchTalkTool, type TalkToolResult } from "../../../../../../lib/talk-tools";

type BridgePayload = {
  action?: unknown;
  callSid?: unknown;
  focusedTodoId?: unknown;
  realtimeItemId?: unknown;
  role?: unknown;
  content?: unknown;
  metadata?: unknown;
  callId?: unknown;
  name?: unknown;
  arguments?: unknown;
  status?: unknown;
  reason?: unknown;
  transport?: unknown;
};

function resultSummary(result: TalkToolResult, fallback: string) {
  const message = typeof result.message === "string" ? result.message : null;
  const readback = typeof result.readback === "string" ? result.readback : null;
  return (message || readback || fallback).slice(0, 40_000);
}

function optionalFocusedTodoId(value: unknown) {
  if (value === null) return null;
  if (value === undefined) return undefined;
  const todoId = Number(value);
  if (!Number.isInteger(todoId) || todoId < 1) throw new Error("The focused task is invalid.");
  return todoId;
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  let callSid = "";
  let action = "";
  let toolName = "";
  try {
    const payload = await request.json() as BridgePayload;
    callSid = String(payload.callSid ?? "").trim();
    action = String(payload.action ?? "").trim();
    const authenticated = await authenticatePhoneBridgeRequest(request, callSid);
    if (!authenticated) throw new Error("The phone relay authorization is invalid or expired.");
    const { userKey, talkSessionId } = authenticated;
    const focusedTodoId = optionalFocusedTodoId(payload.focusedTodoId);
    const transport = payload.transport === "twilio-openai-sip"
      ? "twilio-openai-sip"
      : "twilio-phone-relay";

    if (action === "heartbeat") {
      const result = await heartbeatTalkSession(userKey, talkSessionId, focusedTodoId);
      return Response.json(result, { headers: phoneBridgeHeaders });
    }

    if (action === "message") {
      const role = String(payload.role ?? "");
      if (!["user", "assistant", "tool"].includes(role)) {
        throw new Error("The transcript role is invalid.");
      }
      const result = await appendTalkMessage({
        userKey,
        sessionId: talkSessionId,
        realtimeItemId: `phone-${talkSessionId}-${String(payload.realtimeItemId ?? "")}`.slice(0, 200),
        role: role as "user" | "assistant" | "tool",
        content: String(payload.content ?? ""),
        focusedTodoId: focusedTodoId ?? null,
        metadata: {
          transport,
          ...(payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
            ? payload.metadata as Record<string, unknown>
            : {}),
        },
      });
      return Response.json(result, { headers: phoneBridgeHeaders });
    }

    if (action === "tool") {
      const callId = String(payload.callId ?? "").trim();
      toolName = String(payload.name ?? "").trim();
      const args = payload.arguments && typeof payload.arguments === "object" && !Array.isArray(payload.arguments)
        ? payload.arguments as Record<string, unknown>
        : {};
      if (!callId || !toolName) throw new Error("The tool call is invalid.");
      const existing = await beginTalkToolCall({
        userKey,
        sessionId: talkSessionId,
        callId,
        name: toolName,
        argumentsJson: JSON.stringify(args),
      });
      if (existing.replayed && existing.result) {
        return Response.json(existing.result, { headers: phoneBridgeHeaders });
      }
      if (existing.replayed && existing.pending) {
        return Response.json(
          { error: "That action is already processing." },
          { status: 409, headers: phoneBridgeHeaders },
        );
      }
      try {
        const result = await dispatchTalkTool({
          userKey,
          sessionId: talkSessionId,
          callId,
          name: toolName,
          arguments: args,
        });
        await completeTalkToolCall({
          userKey,
          sessionId: talkSessionId,
          callId,
          result,
          undoToken: typeof result.undoToken === "string" ? result.undoToken : null,
        });
        await appendTalkMessage({
          userKey,
          sessionId: talkSessionId,
          realtimeItemId: `phone-${talkSessionId}-tool-${callId}`.slice(0, 200),
          role: "tool",
          content: resultSummary(result, toolName),
          focusedTodoId: typeof result.focusedTodoId === "number"
            ? result.focusedTodoId
            : focusedTodoId ?? null,
          metadata: {
            transport,
            tool: toolName,
            undoToken: result.undoToken ?? null,
            sources: result.sources ?? [],
          },
        });
        if (typeof result.focusedTodoId === "number" || result.focusedTodoId === null) {
          await heartbeatTalkSession(userKey, talkSessionId, result.focusedTodoId);
        }
        console.info("[todo-talk-phone-bridge] tool completed", {
          callSid,
          talkSessionId,
          callId,
          name: toolName,
          undoAvailable: Boolean(result.undoToken),
          durationMs: Date.now() - startedAt,
        });
        return Response.json(result, { headers: phoneBridgeHeaders });
      } catch (error) {
        const message = error instanceof Error ? error.message : "That action did not complete.";
        await completeTalkToolCall({
          userKey,
          sessionId: talkSessionId,
          callId,
          result: { error: message },
          failed: true,
        }).catch(() => undefined);
        throw error;
      }
    }

    if (action === "rollover") {
      await heartbeatTalkSession(userKey, talkSessionId, focusedTodoId);
      const phoneThread = await resolveSystemTalkThread(userKey, "phone");
      const [context, history, safetyIdentifier, settings] = await Promise.all([
        buildSharedAssistantContext(userKey, focusedTodoId ?? phoneThread.focusedTodoId, phoneThread.summary),
        listTalkHistory(userKey, { limit: 40, threadId: phoneThread.id }),
        hashedSafetyIdentifier(userKey),
        getTodoSettings(),
      ]);
      const recent = history.messages
        .slice(-20)
        .map((message) => `${message.role}: ${message.content.replace(/\s+/g, " ").slice(0, 400)}`)
        .join("\n");
      const secret = await mintRealtimeClientSecret({
        safetyIdentifier,
        instructions: `${talkInstructions(context)}\n\nRECENT PHONE CONVERSATION\n${recent}`,
        audioFormat: "pcmu",
        voice: settings.realtimeVoice,
      });
      console.info("[todo-talk-phone-bridge] realtime credential rolled over", {
        callSid,
        talkSessionId,
        focusedTodoId: focusedTodoId ?? null,
        historyCount: history.messages.length,
        durationMs: Date.now() - startedAt,
      });
      return Response.json({
        clientSecret: secret.value,
        expiresAt: secret.expiresAt,
        model: secret.model,
        voice: secret.voice,
      }, { headers: phoneBridgeHeaders });
    }

    if (action === "end") {
      const reason = String(payload.reason ?? "ended").trim().slice(0, 80) || "ended";
      const status = payload.status === "completed" ? "completed" : "failed";
      await Promise.all([
        endTalkSession(userKey, talkSessionId, `phone-${reason}`),
        endTalkPhoneCall(callSid, status, reason),
      ]);
      return Response.json({ ended: true }, { headers: phoneBridgeHeaders });
    }

    throw new Error("The phone relay action is invalid.");
  } catch (error) {
    console.error("[todo-talk-phone-bridge] relay event failed", {
      callSid: callSid || null,
      action: action || null,
      toolName: toolName || null,
      durationMs: Date.now() - startedAt,
      error,
    });
    return phoneBridgeError(error, "The phone relay event failed.");
  }
}

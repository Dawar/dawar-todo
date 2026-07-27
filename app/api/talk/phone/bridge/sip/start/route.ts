import {
  attachTalkSessionToPhoneCall,
  connectTalkPhoneSip,
} from "../../../../../../../db/talk-phone";
import {
  chooseTalkFocus,
  heartbeatTalkSession,
  listTalkHistory,
  readTalkWorkspace,
  resolveSystemTalkThread,
  startTalkSession,
} from "../../../../../../../db/talk";
import { getTodoSettings, listTodos } from "../../../../../../../db/todos";
import { buildSharedAssistantContext } from "../../../../../../../lib/assistant-context";
import {
  phoneBridgeError,
  phoneBridgeHeaders,
  talkPhoneBridgeToken,
} from "../../../../../../../lib/talk-phone-bridge";
import {
  hashedSafetyIdentifier,
  realtimeSessionConfig,
  talkInstructions,
  talkRuntimeConfig,
  withRecentTalkHistory,
} from "../../../../../../../lib/talk-runtime";

type StartPayload = {
  callSid?: unknown;
  providerCallId?: unknown;
};

export async function POST(request: Request) {
  const startedAt = Date.now();
  let callSid = "";
  let providerCallId = "";
  let talkSessionId = "";
  try {
    const rawToken = talkPhoneBridgeToken(request);
    const payload = await request.json() as StartPayload;
    callSid = String(payload.callSid ?? "").trim();
    providerCallId = String(payload.providerCallId ?? "").trim();
    if (!rawToken) throw new Error("The direct SIP request is unauthorized.");

    const authenticated = await connectTalkPhoneSip({
      callSid,
      rawToken,
      providerCallId,
    });
    if (!authenticated) throw new Error("The direct SIP call token is invalid or expired.");
    const userKey = authenticated.userKey;
    const [todos, workspace, settings] = await Promise.all([
      listTodos(),
      readTalkWorkspace(userKey),
      getTodoSettings(),
    ]);
    const phoneThread = await resolveSystemTalkThread(userKey, "phone");
    const focusedTodoId = chooseTalkFocus(
      todos,
      phoneThread.focusedTodoId ?? workspace.lastFocusedTodoId,
    );
    const { model, voice } = talkRuntimeConfig(settings.realtimeVoice);

    if (authenticated.talkSessionId) {
      try {
        await heartbeatTalkSession(userKey, authenticated.talkSessionId, focusedTodoId);
        talkSessionId = authenticated.talkSessionId;
      } catch {
        talkSessionId = "";
      }
    }
    if (!talkSessionId) {
      const session = await startTalkSession({
        userKey,
        model,
        voice,
        focusedTodoId,
        threadId: phoneThread.id,
        transport: "phone-sip",
      });
      talkSessionId = session.id;
      await attachTalkSessionToPhoneCall(callSid, talkSessionId);
    }

    const [context, history, safetyIdentifier] = await Promise.all([
      buildSharedAssistantContext(userKey, focusedTodoId, phoneThread.summary),
      listTalkHistory(userKey, { threadId: phoneThread.id, limit: 40 }),
      hashedSafetyIdentifier(userKey),
    ]);
    const session = realtimeSessionConfig({
      instructions: withRecentTalkHistory(talkInstructions(context), history.messages),
      voice,
    });
    console.info("[todo-talk-phone-bridge] direct SIP session prepared", {
      callSid,
      providerCallId,
      talkSessionId,
      threadId: phoneThread.id,
      focusedTodoId,
      model,
      voice,
      taskCount: context.tasks.length,
      memoryCount: context.memories.length,
      durationMs: Date.now() - startedAt,
    });
    return Response.json({
      talkSessionId,
      providerCallId,
      focusedTodoId,
      safetyIdentifier,
      session,
    }, { headers: phoneBridgeHeaders });
  } catch (error) {
    console.error("[todo-talk-phone-bridge] direct SIP session preparation failed", {
      callSid: callSid || null,
      providerCallId: providerCallId || null,
      talkSessionId: talkSessionId || null,
      durationMs: Date.now() - startedAt,
      error,
    });
    return phoneBridgeError(error, "The direct SIP call could not start.");
  }
}

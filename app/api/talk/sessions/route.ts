import {
  chooseTalkFocus,
  endTalkSession,
  listTalkHistory,
  readTalkWorkspace,
  startTalkSession,
} from "../../../../db/talk";
import { getTodoSettings, listTodos } from "../../../../db/todos";
import { buildSharedAssistantContext } from "../../../../lib/assistant-context";
import { noStoreHeaders, talkErrorResponse, talkUserKey } from "../../../../lib/talk-http";
import {
  hashedSafetyIdentifier,
  mintRealtimeClientSecret,
  talkInstructions,
  talkRuntimeConfig,
} from "../../../../lib/talk-runtime";

export async function POST(request: Request) {
  const startedAt = Date.now();
  let userKey = "";
  let sessionId: string | null = null;
  try {
    userKey = talkUserKey(request);
    const [todos, workspace, settings] = await Promise.all([
      listTodos(),
      readTalkWorkspace(userKey),
      getTodoSettings(),
    ]);
    const focusedTodoId = chooseTalkFocus(todos, workspace.lastFocusedTodoId);
    const { model, voice } = talkRuntimeConfig(settings.realtimeVoice);
    const session = await startTalkSession({ userKey, model, voice, focusedTodoId });
    sessionId = session.id;
    const [context, history, safetyIdentifier] = await Promise.all([
      buildSharedAssistantContext(userKey, focusedTodoId),
      listTalkHistory(userKey, { limit: 80 }),
      hashedSafetyIdentifier(userKey),
    ]);
    const secret = await mintRealtimeClientSecret({
      safetyIdentifier,
      instructions: talkInstructions(context),
      voice,
    });
    console.info("[todo-talk-api] session started", {
      sessionId,
      focusedTodoId,
      model: secret.model,
      voice: secret.voice,
      taskCount: context.tasks.length,
      memoryCount: context.memories.length,
      historyCount: history.messages.length,
      replacedSession: Boolean(session.replacedSessionId),
      durationMs: Date.now() - startedAt,
    });
    return Response.json({
      sessionId,
      clientSecret: secret.value,
      expiresAt: secret.expiresAt,
      model: secret.model,
      voice: secret.voice,
      focusedTodoId,
      focusedTodo: context.focusedTodo,
      history: history.messages,
      nextHistoryCursor: history.nextCursor,
      offline: false,
    }, { headers: noStoreHeaders });
  } catch (error) {
    if (sessionId && userKey) {
      await endTalkSession(userKey, sessionId, "startup-failed").catch(() => undefined);
    }
    console.error("[todo-talk-api] session start failed", {
      sessionId,
      durationMs: Date.now() - startedAt,
      error,
    });
    return talkErrorResponse(error, "Talk could not start.");
  }
}

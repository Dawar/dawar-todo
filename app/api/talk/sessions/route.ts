import {
  chooseTalkFocus,
  endTalkSession,
  listTalkHistory,
  readTalkThread,
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
  withRecentTalkHistory,
} from "../../../../lib/talk-runtime";

export async function POST(request: Request) {
  const startedAt = Date.now();
  let userKey = "";
  let sessionId: string | null = null;
  try {
    userKey = talkUserKey(request);
    const payload = await request.json().catch(() => ({})) as { threadId?: unknown };
    const requestedThreadId = String(payload.threadId ?? "").trim();
    const [todos, workspace, settings] = await Promise.all([
      listTodos(),
      readTalkWorkspace(userKey),
      getTodoSettings(),
    ]);
    const thread = requestedThreadId ? await readTalkThread(userKey, requestedThreadId) : null;
    const focusedTodoId = thread
      ? thread.focusedTodoId
      : chooseTalkFocus(todos, workspace.lastFocusedTodoId);
    const { model, voice } = talkRuntimeConfig(settings.realtimeVoice);
    const session = await startTalkSession({
      userKey,
      model,
      voice,
      focusedTodoId,
      threadId: thread?.id ?? null,
      transport: "browser",
    });
    sessionId = session.id;
    const [context, history, safetyIdentifier] = await Promise.all([
      buildSharedAssistantContext(userKey, focusedTodoId, thread?.summary),
      listTalkHistory(userKey, { limit: 100, threadId: session.threadId }),
      hashedSafetyIdentifier(userKey),
    ]);
    const secret = await mintRealtimeClientSecret({
      safetyIdentifier,
      instructions: withRecentTalkHistory(talkInstructions(context), history.messages),
      voice,
    });
    console.info("[todo-talk-api] session started", {
      sessionId,
      threadId: session.threadId,
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
      threadId: session.threadId,
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

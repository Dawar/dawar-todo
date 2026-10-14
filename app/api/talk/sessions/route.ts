import { botsOwner } from '../../../../lib/bots-auth';
import { env } from 'cloudflare:workers';
import { openOperator, operatorInstructions, operatorToolDefinitions, endOperator } from '../../../../lib/operator-server';
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
  talkToolDefinitions,
  withRecentTalkHistory,
} from "../../../../lib/talk-runtime";

export async function POST(request: Request) {
  const startedAt = Date.now();
  let userKey = "";
  let sessionId: string | null = null;
  try {
    userKey = talkUserKey(request);
    const payload = await request.json().catch(() => ({})) as { threadId?: unknown; operator?: unknown; botId?: unknown };
    const useOperator = payload.operator === true;
    if (useOperator) botsOwner(request, env);
    if (payload.threadId !== undefined) return Response.json({ error: "Legacy Chat threads are retired. Start Operator from Bots." }, { status: 410, headers: noStoreHeaders });
    if (!useOperator) return Response.json({ error: "Start Operator from Bots." }, { status: 410, headers: noStoreHeaders });
    const [todos, workspace, settings] = await Promise.all([
      listTodos(),
      readTalkWorkspace(userKey),
      getTodoSettings(),
    ]);
    const focusedTodoId = chooseTalkFocus(todos, workspace.lastFocusedTodoId);
    const { model, voice } = talkRuntimeConfig(settings.realtimeVoice);
    const session = await startTalkSession({
      userKey,
      model,
      voice,
      focusedTodoId,
      transport: "browser-operator",
    });
    sessionId = session.id;
    const [context, history, safetyIdentifier] = await Promise.all([
      buildSharedAssistantContext(userKey, focusedTodoId, workspace.summary),
      listTalkHistory(userKey, { limit: 100, sessionId: session.id }),
      hashedSafetyIdentifier(userKey),
    ]);
    const operator = useOperator ? await openOperator(userKey, sessionId, typeof payload.botId === "string" ? payload.botId : null) : null;
    const secret = await mintRealtimeClientSecret({
      safetyIdentifier,
      instructions: operator ? operatorInstructions(operator) : withRecentTalkHistory(talkInstructions(context), history.messages),
      tools: operator ? operator.bot ? operatorToolDefinitions : [...operatorToolDefinitions, ...talkToolDefinitions] : undefined,
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
      operator,
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
      await endOperator(userKey, sessionId).catch(() => undefined);
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

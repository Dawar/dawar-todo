import {
  appendAssistantTurn,
  appendAssistantUserMessage,
  assistantUserKey,
  readAssistantThread,
  updateAssistantThreadState,
} from "../../../../db/assistant";
import { getTodo, getTodoSettings } from "../../../../db/todos";
import { generateAssistantTurn } from "../../../../lib/assistant-runtime";

export async function POST(request: Request) {
  const startedAt = Date.now();
  const userKey = assistantUserKey(request);
  let todoId: number | null = null;
  let clientId: string | null = null;
  try {
    const payload = await request.json() as {
      taskId?: unknown;
      text?: unknown;
      clientId?: unknown;
      attachmentIds?: unknown;
    };
    todoId = Number(payload.taskId);
    clientId = String(payload.clientId ?? "");
    const text = String(payload.text ?? "").trim();
    const attachmentIds = Array.isArray(payload.attachmentIds)
      ? [...new Set(payload.attachmentIds.map(String).filter((id) => /^[0-9a-f-]{36}$/i.test(id)))].slice(0, 12)
      : [];
    if (!Number.isInteger(todoId) || todoId < 1) return Response.json({ error: "Invalid task." }, { status: 400 });
    if (!/^[0-9a-f-]{36}$/i.test(clientId)) return Response.json({ error: "Invalid message identifier." }, { status: 400 });
    if (!text && !attachmentIds.length) return Response.json({ error: "Write a message or choose an attachment." }, { status: 400 });
    if (text.length > 20_000) return Response.json({ error: "Assistant messages are limited to 20,000 characters." }, { status: 400 });
    const todo = await getTodo(todoId);
    if (!todo) return Response.json({ error: "Task not found." }, { status: 404 });

    await updateAssistantThreadState(userKey, todoId, { paused: false });
    const saved = await appendAssistantUserMessage({ userKey, todoId, content: text, clientId, attachmentIds });
    let thread = await readAssistantThread(userKey, todoId);
    const userIndex = thread.messages.findIndex((message) => message.id === saved.message.id);
    if (saved.replayed && thread.messages.slice(userIndex + 1).some((message) => message.role === "assistant")) {
      console.info("[todo-assistant-api] completed message replay returned without duplicate generation", {
        userKey,
        todoId,
        clientId,
        durationMs: Date.now() - startedAt,
      });
      return Response.json({ thread, replayed: true }, { headers: { "Cache-Control": "no-store" } });
    }
    const settings = await getTodoSettings();
    const turn = await generateAssistantTurn({
      userKey,
      todo,
      thread,
      currentMessageId: saved.message.id,
      message: text,
      attachmentIds,
      timeZone: settings.snoozeTimeZone,
    });
    thread = await appendAssistantTurn({ userKey, todoId, ...turn });
    console.info("[todo-assistant-api] message completed", {
      userKey,
      todoId,
      clientId,
      replayed: saved.replayed,
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ thread, replayed: saved.replayed }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The assistant could not respond.";
    console.error("[todo-assistant-api] message failed", {
      userKey,
      todoId,
      clientId,
      durationMs: Date.now() - startedAt,
      error,
    });
    const status = /not configured/i.test(message) ? 503 : /not found|invalid|limited|choose|attachment/i.test(message) ? 400 : 502;
    return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}

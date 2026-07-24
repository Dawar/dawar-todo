import {
  appendAssistantTurn,
  assistantUserKey,
  consumeAssistantProposal,
  readAssistantProposal,
  readAssistantThread,
  skipAssistantQuestion,
  updateAssistantThreadState,
} from "../../../../db/assistant";
import { getTodo, getTodoSettings, updateTodo, type TodoUpdate } from "../../../../db/todos";
import { generateAssistantTurn } from "../../../../lib/assistant-runtime";

export async function POST(request: Request) {
  const startedAt = Date.now();
  const userKey = assistantUserKey(request);
  let todoId: number | null = null;
  try {
    const payload = await request.json() as {
      taskId?: unknown;
      action?: unknown;
      messageId?: unknown;
    };
    todoId = Number(payload.taskId);
    const action = String(payload.action ?? "");
    if (!Number.isInteger(todoId) || todoId < 1) return Response.json({ error: "Invalid task." }, { status: 400 });
    const todo = await getTodo(todoId);
    if (!todo) return Response.json({ error: "Task not found." }, { status: 404 });

    if (action === "pause" || action === "resume") {
      const thread = await updateAssistantThreadState(userKey, todoId, { paused: action === "pause" });
      console.info("[todo-assistant-api] guidance state changed", {
        userKey,
        todoId,
        action,
        durationMs: Date.now() - startedAt,
      });
      return Response.json({ thread });
    }

    if (action === "skip") {
      await skipAssistantQuestion(userKey, todoId);
      const thread = await readAssistantThread(userKey, todoId);
      const settings = await getTodoSettings();
      const turn = await generateAssistantTurn({
        userKey,
        todo,
        thread,
        currentMessageId: "",
        message: "I skipped the previous question. Do not repeat or rephrase it. Continue with the next highest-value question, or tell me the task is actionable.",
        attachmentIds: [],
        timeZone: settings.snoozeTimeZone,
      });
      const updatedThread = await appendAssistantTurn({ userKey, todoId, ...turn });
      console.info("[todo-assistant-api] question skip completed", {
        userKey,
        todoId,
        durationMs: Date.now() - startedAt,
      });
      return Response.json({ thread: updatedThread });
    }

    if (action === "apply" || action === "dismiss") {
      const messageId = String(payload.messageId ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(messageId)) return Response.json({ error: "Invalid proposal." }, { status: 400 });
      const proposal = await readAssistantProposal(userKey, todoId, messageId);
      if (!proposal) return Response.json({ error: "That proposal is no longer available." }, { status: 404 });
      if (action === "dismiss") {
        await consumeAssistantProposal(userKey, todoId, messageId);
        const thread = await readAssistantThread(userKey, todoId);
        console.info("[todo-assistant-api] proposal dismissed", {
          userKey,
          todoId,
          messageId,
          durationMs: Date.now() - startedAt,
        });
        return Response.json({ thread });
      }
      const result = await updateTodo(todoId, proposal.patch as TodoUpdate, { recordUndo: true });
      if (!result) return Response.json({ error: "Task not found." }, { status: 404 });
      await consumeAssistantProposal(userKey, todoId, messageId);
      const thread = await readAssistantThread(userKey, todoId);
      console.info("[todo-assistant-api] confirmed proposal applied", {
        userKey,
        todoId,
        messageId,
        fields: Object.keys(proposal.patch),
        appliedFields: result.appliedFields,
        undoAvailable: Boolean(result.undoToken),
        durationMs: Date.now() - startedAt,
      });
      return Response.json({ thread, todo: result.todo, undoToken: result.undoToken, appliedFields: result.appliedFields });
    }

    return Response.json({ error: "Invalid assistant action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The assistant action could not be completed.";
    console.error("[todo-assistant-api] action failed", { userKey, todoId, durationMs: Date.now() - startedAt, error });
    return Response.json({ error: message }, { status: /not found|invalid|available|recurring|snooz|cron/i.test(message) ? 400 : 500 });
  }
}

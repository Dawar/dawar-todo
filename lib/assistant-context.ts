import { readAssistantThread, type AssistantThread } from "../db/assistant";
import { listTodoAttachments } from "../db/attachments";
import { listAssistantMemories, readTalkWorkspace } from "../db/talk";
import {
  getTodo,
  getTodoSettings,
  listTodoProjects,
  listTodos,
  type Todo,
} from "../db/todos";

export type SharedAssistantContext = {
  generatedAt: string;
  timeZone: string;
  focusedTodo: Todo | null;
  tasks: Array<Pick<
    Todo,
    | "id"
    | "title"
    | "notes"
    | "status"
    | "priority"
    | "dueDate"
    | "project"
    | "context"
    | "completedAt"
    | "snoozedUntil"
    | "recurrenceCron"
    | "pinned"
    | "attachmentCount"
    | "updatedAt"
  >>;
  projects: string[];
  focusedThread: AssistantThread | null;
  focusedAttachments: Array<{
    id: string;
    fileName: string;
    mimeType: string;
    kind: string;
    byteSize: number;
    durationMs: number;
  }>;
  memories: Array<{
    id: string;
    scope: "global" | "task";
    todoId: number | null;
    kind: string;
    content: string;
    provenance: Record<string, unknown>;
  }>;
  previousSummary: string;
};

export async function buildSharedAssistantContext(
  userKey: string,
  focusedTodoId?: number | null,
): Promise<SharedAssistantContext> {
  const [todos, projects, settings, workspace] = await Promise.all([
    listTodos(),
    listTodoProjects(),
    getTodoSettings(),
    readTalkWorkspace(userKey),
  ]);
  const selectedId = focusedTodoId ?? workspace.lastFocusedTodoId;
  const focusedTodo = selectedId ? await getTodo(selectedId) : null;
  const [focusedThread, focusedAttachments, memories] = await Promise.all([
    focusedTodo ? readAssistantThread(userKey, focusedTodo.id) : Promise.resolve(null),
    focusedTodo ? listTodoAttachments(focusedTodo.id) : Promise.resolve([]),
    listAssistantMemories(userKey, { todoId: focusedTodo?.id ?? null, limit: 30 }),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    timeZone: settings.snoozeTimeZone,
    focusedTodo,
    tasks: todos.slice(0, 300).map((todo) => ({
      id: todo.id,
      title: todo.title,
      notes: todo.notes.slice(0, 4_000),
      status: todo.status,
      priority: todo.priority,
      dueDate: todo.dueDate,
      project: todo.project,
      context: todo.context,
      completedAt: todo.completedAt,
      snoozedUntil: todo.snoozedUntil,
      recurrenceCron: todo.recurrenceCron,
      pinned: todo.pinned,
      attachmentCount: todo.attachmentCount,
      updatedAt: todo.updatedAt,
    })),
    projects,
    focusedThread,
    focusedAttachments: focusedAttachments.map((attachment) => ({
      id: attachment.id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      kind: attachment.kind,
      byteSize: attachment.byteSize,
      durationMs: attachment.durationMs,
    })),
    memories: memories.map((memory) => ({
      id: memory.id,
      scope: memory.scope,
      todoId: memory.todoId,
      kind: memory.kind,
      content: memory.content,
      provenance: memory.provenance,
    })),
    previousSummary: workspace.summary,
  };
}

import { env } from "cloudflare:workers";
import { ensureTodoDatabase, getTodo, type Todo } from "./todos";

export type AssistantNavigatorView = "open" | "snoozed" | "done" | "all";

export type AssistantQuestion = {
  key: string;
  prompt: string;
  options: string[];
  inputMode: "text" | "long_text" | "link" | "attachment" | "confirmation";
  attachmentKind: "any" | "image" | "file" | "audio" | null;
};

export type AssistantUnderstanding = {
  userFacts: string[];
  attachmentFacts: Array<{ attachmentId: string; fact: string }>;
  inferences: string[];
  unresolved: string[];
  nextAction: string | null;
};

export type AssistantProposalPatch = {
  title?: string;
  notes?: string;
  project?: string | null;
  context?: string | null;
  priority?: number;
  dueDate?: string | null;
  pinned?: boolean;
  recurrenceCron?: string | null;
  status?: "open" | "completed";
  snoozedUntil?: string | null;
};

export type AssistantProposal = {
  summary: string;
  requiresConfirmation: true;
  patch: AssistantProposalPatch;
};

export type AssistantSource = {
  title: string;
  url: string;
};

export type AssistantMessage = {
  id: string;
  todoId: number;
  role: "user" | "assistant";
  kind: "message" | "question" | "acknowledgement" | "offline";
  content: string;
  question: AssistantQuestion | null;
  proposal: AssistantProposal | null;
  sources: AssistantSource[];
  attachmentIds: string[];
  clientId: string | null;
  createdAt: string;
};

export type AssistantThread = {
  todoId: number;
  paused: boolean;
  draftText: string;
  draftAttachmentIds: string[];
  currentQuestion: AssistantQuestion | null;
  skippedQuestionKeys: string[];
  understanding: AssistantUnderstanding | null;
  messages: AssistantMessage[];
};

type WorkspaceRow = {
  selected_todo_id: number | null;
  navigator_view: AssistantNavigatorView;
};

type ThreadRow = {
  todo_id: number;
  paused: number;
  draft_text: string;
  draft_attachment_ids_json: string;
  current_question_json: string | null;
  skipped_question_keys_json: string;
  understanding_json: string | null;
};

type MessageRow = {
  id: string;
  todo_id: number;
  role: "user" | "assistant";
  kind: "message" | "question" | "acknowledgement" | "offline";
  content: string;
  question_json: string | null;
  proposal_json: string | null;
  sources_json: string | null;
  attachment_ids_json: string;
  client_id: string | null;
  created_at: string;
};

function database() {
  if (!env.DB) throw new Error("The todo database is unavailable.");
  return env.DB;
}

function safeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapMessage(row: MessageRow): AssistantMessage {
  return {
    id: row.id,
    todoId: row.todo_id,
    role: row.role,
    kind: row.kind,
    content: row.content,
    question: safeJson<AssistantQuestion | null>(row.question_json, null),
    proposal: safeJson<AssistantProposal | null>(row.proposal_json, null),
    sources: safeJson<AssistantSource[]>(row.sources_json, []),
    attachmentIds: safeJson<string[]>(row.attachment_ids_json, []),
    clientId: row.client_id,
    createdAt: row.created_at,
  };
}

export function assistantUserKey(request: Request) {
  return request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase() || "local-development";
}

export async function readAssistantWorkspace(userKey: string, todos: Todo[]) {
  await ensureTodoDatabase();
  const row = await database().prepare(`
    SELECT selected_todo_id, navigator_view
    FROM todo_assistant_workspaces
    WHERE user_key = ?
  `).bind(userKey).first<WorkspaceRow>();
  const selectedTodoId = row?.selected_todo_id && todos.some((todo) => todo.id === row.selected_todo_id)
    ? row.selected_todo_id
    : todos.find((todo) => todo.status === "open" && !todo.snoozedUntil)?.id ?? todos[0]?.id ?? null;
  return {
    selectedTodoId,
    navigatorView: row?.navigator_view ?? "open" as AssistantNavigatorView,
  };
}

export async function updateAssistantWorkspace(
  userKey: string,
  input: { selectedTodoId?: number | null; navigatorView?: AssistantNavigatorView },
) {
  await ensureTodoDatabase();
  const current = await database().prepare(`
    SELECT selected_todo_id, navigator_view
    FROM todo_assistant_workspaces
    WHERE user_key = ?
  `).bind(userKey).first<WorkspaceRow>();
  const selectedTodoId = input.selectedTodoId === undefined ? current?.selected_todo_id ?? null : input.selectedTodoId;
  const navigatorView = input.navigatorView ?? current?.navigator_view ?? "open";
  await database().prepare(`
    INSERT INTO todo_assistant_workspaces (user_key, selected_todo_id, navigator_view, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(user_key) DO UPDATE SET
      selected_todo_id = excluded.selected_todo_id,
      navigator_view = excluded.navigator_view,
      updated_at = excluded.updated_at
  `).bind(userKey, selectedTodoId, navigatorView).run();
  console.info("[todo-assistant] workspace state saved", { userKey, selectedTodoId, navigatorView });
  return { selectedTodoId, navigatorView };
}

async function ensureThread(userKey: string, todoId: number) {
  await ensureTodoDatabase();
  if (!await getTodo(todoId)) throw new Error("Task not found.");
  await database().prepare(`
    INSERT OR IGNORE INTO todo_assistant_threads (user_key, todo_id)
    VALUES (?, ?)
  `).bind(userKey, todoId).run();
}

export async function readAssistantThread(userKey: string, todoId: number): Promise<AssistantThread> {
  await ensureThread(userKey, todoId);
  const db = database();
  const [threadResult, messageResult] = await db.batch([
    db.prepare(`
      SELECT todo_id, paused, draft_text, current_question_json,
             draft_attachment_ids_json, skipped_question_keys_json, understanding_json
      FROM todo_assistant_threads
      WHERE user_key = ? AND todo_id = ?
    `).bind(userKey, todoId),
    db.prepare(`
      SELECT id, todo_id, role, kind, content, question_json, proposal_json,
             sources_json, attachment_ids_json, client_id, created_at
      FROM todo_assistant_messages
      WHERE user_key = ? AND todo_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT 200
    `).bind(userKey, todoId),
  ]) as [D1Result<ThreadRow>, D1Result<MessageRow>];
  const row = threadResult.results[0]!;
  return {
    todoId,
    paused: Boolean(row.paused),
    draftText: row.draft_text,
    draftAttachmentIds: safeJson<string[]>(row.draft_attachment_ids_json, []),
    currentQuestion: safeJson<AssistantQuestion | null>(row.current_question_json, null),
    skippedQuestionKeys: safeJson<string[]>(row.skipped_question_keys_json, []),
    understanding: safeJson<AssistantUnderstanding | null>(row.understanding_json, null),
    messages: messageResult.results.map(mapMessage),
  };
}

export async function updateAssistantThreadState(
  userKey: string,
  todoId: number,
  input: { draftText?: string; draftAttachmentIds?: string[]; paused?: boolean },
) {
  await ensureThread(userKey, todoId);
  const fields: string[] = [];
  const values: unknown[] = [];
  if (input.draftText !== undefined) {
    fields.push("draft_text = ?");
    values.push(input.draftText.slice(0, 20_000));
  }
  if (input.draftAttachmentIds !== undefined) {
    const ids = [...new Set(input.draftAttachmentIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))].slice(0, 12);
    fields.push("draft_attachment_ids_json = ?");
    values.push(JSON.stringify(ids));
  }
  if (input.paused !== undefined) {
    fields.push("paused = ?");
    values.push(input.paused ? 1 : 0);
  }
  if (fields.length) {
    await database().prepare(`
      UPDATE todo_assistant_threads
      SET ${fields.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_key = ? AND todo_id = ?
    `).bind(...values, userKey, todoId).run();
  }
  console.info("[todo-assistant] thread state saved", {
    userKey,
    todoId,
    draftLength: input.draftText?.length,
    draftAttachmentCount: input.draftAttachmentIds?.length,
    paused: input.paused,
  });
  return readAssistantThread(userKey, todoId);
}

export async function appendAssistantUserMessage(input: {
  userKey: string;
  todoId: number;
  content: string;
  clientId: string;
  attachmentIds: string[];
}) {
  await ensureThread(input.userKey, input.todoId);
  const existing = await database().prepare(`
    SELECT id, todo_id, role, kind, content, question_json, proposal_json,
           sources_json, attachment_ids_json, client_id, created_at
    FROM todo_assistant_messages
    WHERE user_key = ? AND client_id = ?
  `).bind(input.userKey, input.clientId).first<MessageRow>();
  if (existing) {
    console.info("[todo-assistant] idempotent message replay resolved", {
      userKey: input.userKey,
      todoId: input.todoId,
      clientId: input.clientId,
      messageId: existing.id,
    });
    return { message: mapMessage(existing), replayed: true };
  }
  const id = crypto.randomUUID();
  await database().batch([
    database().prepare(`
      INSERT INTO todo_assistant_messages (
        id, user_key, todo_id, role, kind, content, attachment_ids_json, client_id
      ) VALUES (?, ?, ?, 'user', 'message', ?, ?, ?)
    `).bind(id, input.userKey, input.todoId, input.content, JSON.stringify(input.attachmentIds), input.clientId),
    database().prepare(`
      UPDATE todo_assistant_threads
      SET draft_text = '', draft_attachment_ids_json = '[]', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_key = ? AND todo_id = ?
    `).bind(input.userKey, input.todoId),
  ]);
  const row = await database().prepare(`
    SELECT id, todo_id, role, kind, content, question_json, proposal_json,
           sources_json, attachment_ids_json, client_id, created_at
    FROM todo_assistant_messages WHERE id = ?
  `).bind(id).first<MessageRow>();
  console.info("[todo-assistant] user message persisted", {
    userKey: input.userKey,
    todoId: input.todoId,
    messageId: id,
    clientId: input.clientId,
    contentLength: input.content.length,
    attachmentCount: input.attachmentIds.length,
  });
  return { message: mapMessage(row!), replayed: false };
}

export async function appendAssistantTurn(input: {
  userKey: string;
  todoId: number;
  content: string;
  question: AssistantQuestion | null;
  proposal: AssistantProposal | null;
  understanding: AssistantUnderstanding;
  sources: AssistantSource[];
}) {
  await ensureThread(input.userKey, input.todoId);
  const id = crypto.randomUUID();
  const kind = input.question ? "question" : input.proposal ? "acknowledgement" : "message";
  await database().batch([
    database().prepare(`
      INSERT INTO todo_assistant_messages (
        id, user_key, todo_id, role, kind, content, question_json,
        proposal_json, sources_json, attachment_ids_json
      ) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?, '[]')
    `).bind(
      id,
      input.userKey,
      input.todoId,
      kind,
      input.content,
      input.question ? JSON.stringify(input.question) : null,
      input.proposal ? JSON.stringify(input.proposal) : null,
      JSON.stringify(input.sources),
    ),
    database().prepare(`
      UPDATE todo_assistant_threads
      SET current_question_json = ?,
          understanding_json = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_key = ? AND todo_id = ?
    `).bind(
      input.question ? JSON.stringify(input.question) : null,
      JSON.stringify(input.understanding),
      input.userKey,
      input.todoId,
    ),
  ]);
  console.info("[todo-assistant] assistant turn persisted", {
    userKey: input.userKey,
    todoId: input.todoId,
    messageId: id,
    kind,
    hasQuestion: Boolean(input.question),
    optionCount: input.question?.options.length ?? 0,
    hasProposal: Boolean(input.proposal),
    sourceCount: input.sources.length,
    understanding: {
      userFacts: input.understanding.userFacts.length,
      attachmentFacts: input.understanding.attachmentFacts.length,
      inferences: input.understanding.inferences.length,
      unresolved: input.understanding.unresolved.length,
    },
  });
  return readAssistantThread(input.userKey, input.todoId);
}

export async function skipAssistantQuestion(userKey: string, todoId: number) {
  await ensureThread(userKey, todoId);
  const row = await database().prepare(`
    SELECT current_question_json, skipped_question_keys_json
    FROM todo_assistant_threads WHERE user_key = ? AND todo_id = ?
  `).bind(userKey, todoId).first<Pick<ThreadRow, "current_question_json" | "skipped_question_keys_json">>();
  const current = safeJson<AssistantQuestion | null>(row?.current_question_json, null);
  const skipped = safeJson<string[]>(row?.skipped_question_keys_json, []);
  const nextSkipped = current?.key ? [...new Set([...skipped, current.key])].slice(-50) : skipped;
  await database().prepare(`
    UPDATE todo_assistant_threads
    SET current_question_json = NULL,
        skipped_question_keys_json = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE user_key = ? AND todo_id = ?
  `).bind(JSON.stringify(nextSkipped), userKey, todoId).run();
  console.info("[todo-assistant] question skipped", {
    userKey,
    todoId,
    questionKey: current?.key ?? null,
    skippedCount: nextSkipped.length,
  });
  return { question: current, skippedQuestionKeys: nextSkipped };
}

export async function readAssistantProposal(userKey: string, todoId: number, messageId: string) {
  const row = await database().prepare(`
    SELECT proposal_json
    FROM todo_assistant_messages
    WHERE id = ? AND user_key = ? AND todo_id = ? AND role = 'assistant'
  `).bind(messageId, userKey, todoId).first<{ proposal_json: string | null }>();
  return safeJson<AssistantProposal | null>(row?.proposal_json, null);
}

export async function consumeAssistantProposal(userKey: string, todoId: number, messageId: string) {
  const result = await database().prepare(`
    UPDATE todo_assistant_messages
    SET proposal_json = NULL
    WHERE id = ? AND user_key = ? AND todo_id = ? AND role = 'assistant'
  `).bind(messageId, userKey, todoId).run();
  console.info("[todo-assistant] proposal consumed", {
    userKey,
    todoId,
    messageId,
    changed: Number(result.meta.changes ?? 0),
  });
}

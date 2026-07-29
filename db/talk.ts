import { env } from "cloudflare:workers";
import { ensureTodoDatabase, getTodo, type Todo } from "./todos";

export type TalkSessionStatus = "active" | "ended" | "replaced";
export type TalkMessageRole = "user" | "assistant" | "tool" | "system";
export type TalkMemoryScope = "global" | "task";
export type TalkThreadKind = "phone" | "general" | "custom";

export type TalkThread = {
  id: string;
  kind: TalkThreadKind;
  title: string;
  focusedTodoId: number | null;
  summary: string;
  draftText: string;
  deletedAt: string | null;
  lastMessageAt: string | null;
  preview: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type TalkMessage = {
  id: string;
  sessionId: string;
  threadId: string | null;
  realtimeItemId: string;
  role: TalkMessageRole;
  content: string;
  focusedTodoId: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type AssistantMemory = {
  id: string;
  scope: TalkMemoryScope;
  todoId: number | null;
  kind: string;
  content: string;
  provenance: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type WorkspaceRow = {
  active_session_id: string | null;
  last_focused_todo_id: number | null;
  summary: string;
};

type SessionRow = {
  id: string;
  user_key: string;
  thread_id: string | null;
  transport: string;
  model: string;
  voice: string;
  status: TalkSessionStatus;
  last_activity_at: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
};

type MessageRow = {
  id: string;
  session_id: string;
  thread_id: string | null;
  realtime_item_id: string;
  role: TalkMessageRole;
  content: string;
  focused_todo_id: number | null;
  metadata_json: string;
  created_at: string;
};

type MemoryRow = {
  id: string;
  scope: TalkMemoryScope;
  todo_id: number | null;
  kind: string;
  content: string;
  provenance_json: string;
  created_at: string;
  updated_at: string;
};

type ToolCallRow = {
  call_id: string;
  session_id: string;
  user_key: string;
  thread_id: string | null;
  name: string;
  arguments_json: string;
  status: string;
  result_json: string | null;
  undo_token: string | null;
};

type ThreadRow = {
  id: string;
  user_key: string;
  kind: TalkThreadKind;
  system_key: string | null;
  title: string;
  focused_todo_id: number | null;
  summary: string;
  draft_text: string;
  delete_token: string | null;
  deleted_at: string | null;
  purge_after: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
  preview?: string | null;
  message_count?: number;
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

function mapMessage(row: MessageRow): TalkMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    threadId: row.thread_id,
    realtimeItemId: row.realtime_item_id,
    role: row.role,
    content: row.content,
    focusedTodoId: row.focused_todo_id,
    metadata: safeJson(row.metadata_json, {}),
    createdAt: row.created_at,
  };
}

function mapThread(row: ThreadRow): TalkThread {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    focusedTodoId: row.focused_todo_id,
    summary: row.summary,
    draftText: row.draft_text,
    deletedAt: row.deleted_at,
    lastMessageAt: row.last_message_at,
    preview: row.preview ?? "",
    messageCount: Number(row.message_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMemory(row: MemoryRow): AssistantMemory {
  return {
    id: row.id,
    scope: row.scope,
    todoId: row.todo_id,
    kind: row.kind,
    content: row.content,
    provenance: safeJson(row.provenance_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validUuid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

export function chooseTalkFocus(todos: Todo[], preferredId?: number | null) {
  if (preferredId && todos.some((todo) => todo.id === preferredId)) return preferredId;
  const now = Date.now();
  const candidates = todos
    .filter((todo) => todo.status === "open" && (!todo.snoozedUntil || new Date(todo.snoozedUntil).valueOf() <= now))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.priority !== b.priority) return a.priority - b.priority;
      const dueA = a.dueDate ? new Date(a.dueDate).valueOf() : Number.POSITIVE_INFINITY;
      const dueB = b.dueDate ? new Date(b.dueDate).valueOf() : Number.POSITIVE_INFINITY;
      if (dueA !== dueB) return dueA - dueB;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  return candidates[0]?.id ?? todos[0]?.id ?? null;
}

async function ensureTalkThreads(userKey: string) {
  await ensureTodoDatabase();
  const startedAt = Date.now();
  const db = database();
  const phoneId = crypto.randomUUID();
  const generalId = crypto.randomUUID();
  await db.batch([
    db.prepare(`
      INSERT OR IGNORE INTO todo_talk_threads (
        id, user_key, kind, system_key, title
      ) VALUES (?, ?, 'phone', 'phone', 'Phone Calls')
    `).bind(phoneId, userKey),
    db.prepare(`
      INSERT OR IGNORE INTO todo_talk_threads (
        id, user_key, kind, system_key, title
      ) VALUES (?, ?, 'general', 'general', 'General')
    `).bind(generalId, userKey),
  ]);
  const systemThreads = await db.prepare(`
    SELECT id, system_key
    FROM todo_talk_threads
    WHERE user_key = ? AND system_key IN ('phone', 'general')
  `).bind(userKey).all<{ id: string; system_key: string }>();
  const phoneThreadId = systemThreads.results.find((row) => row.system_key === "phone")?.id;
  const generalThreadId = systemThreads.results.find((row) => row.system_key === "general")?.id;
  if (!phoneThreadId || !generalThreadId) throw new Error("Talk threads could not be initialized.");

  await db.batch([
    db.prepare(`
      UPDATE todo_talk_messages
      SET thread_id = ?
      WHERE user_key = ? AND thread_id IS NULL
        AND COALESCE(json_extract(metadata_json, '$.transport'), '') LIKE 'twilio%'
    `).bind(phoneThreadId, userKey),
    db.prepare(`
      UPDATE todo_talk_messages
      SET thread_id = ?
      WHERE user_key = ? AND thread_id IS NULL
    `).bind(generalThreadId, userKey),
    db.prepare(`
      UPDATE todo_talk_sessions
      SET thread_id = COALESCE((
            SELECT messages.thread_id
            FROM todo_talk_messages AS messages
            WHERE messages.session_id = todo_talk_sessions.id
              AND messages.thread_id IS NOT NULL
            LIMIT 1
          ), ?),
          transport = CASE
            WHEN EXISTS (
              SELECT 1 FROM todo_talk_messages AS messages
              WHERE messages.session_id = todo_talk_sessions.id
                AND COALESCE(json_extract(messages.metadata_json, '$.transport'), '') LIKE 'twilio%'
            ) THEN 'phone'
            ELSE transport
          END
      WHERE user_key = ? AND thread_id IS NULL
    `).bind(generalThreadId, userKey),
    db.prepare(`
      UPDATE todo_talk_tool_calls
      SET thread_id = (
        SELECT sessions.thread_id
        FROM todo_talk_sessions AS sessions
        WHERE sessions.id = todo_talk_tool_calls.session_id
      )
      WHERE user_key = ? AND thread_id IS NULL
    `).bind(userKey),
    db.prepare(`
      UPDATE todo_talk_threads
      SET summary = COALESCE(NULLIF(summary, ''), (
            SELECT summary FROM todo_talk_workspaces WHERE user_key = ?
          ), ''),
          last_message_at = COALESCE(last_message_at, (
            SELECT MAX(created_at) FROM todo_talk_messages
            WHERE thread_id = todo_talk_threads.id
          ))
      WHERE id = ?
    `).bind(userKey, generalThreadId),
  ]);

  const legacyThreads = await db.prepare(`
    SELECT assistant.user_key, assistant.todo_id, assistant.draft_text,
           assistant.understanding_json, todos.title
    FROM todo_assistant_threads AS assistant
    INNER JOIN todos ON todos.id = assistant.todo_id
    WHERE assistant.user_key = ?
  `).bind(userKey).all<{
    user_key: string;
    todo_id: number;
    draft_text: string;
    understanding_json: string | null;
    title: string;
  }>();
  let importedThreads = 0;
  let importedMessages = 0;
  for (const legacy of legacyThreads.results) {
    const threadId = crypto.randomUUID();
    const inserted = await db.prepare(`
      INSERT OR IGNORE INTO todo_talk_threads (
        id, user_key, kind, system_key, title, focused_todo_id, draft_text, summary
      ) VALUES (?, ?, 'custom', ?, ?, ?, ?, ?)
    `).bind(
      threadId,
      userKey,
      `assistant:${legacy.todo_id}`,
      legacy.title.slice(0, 120),
      legacy.todo_id,
      legacy.draft_text,
      legacy.understanding_json ?? "",
    ).run();
    if (!Number(inserted.meta.changes ?? 0)) continue;
    importedThreads += 1;
    const sessionId = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO todo_talk_sessions (
        id, user_key, thread_id, transport, model, voice, status,
        ended_at, end_reason
      ) VALUES (?, ?, ?, 'legacy-assistant', 'legacy-assistant', 'marin', 'ended',
        strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'assistant-migration')
    `).bind(sessionId, userKey, threadId).run();
    const messages = await db.prepare(`
      SELECT id, role, kind, content, question_json, proposal_json,
             sources_json, attachment_ids_json, created_at
      FROM todo_assistant_messages
      WHERE user_key = ? AND todo_id = ?
      ORDER BY created_at ASC, id ASC
    `).bind(userKey, legacy.todo_id).all<{
      id: string;
      role: "user" | "assistant";
      kind: string;
      content: string;
      question_json: string | null;
      proposal_json: string | null;
      sources_json: string | null;
      attachment_ids_json: string;
      created_at: string;
    }>();
    if (messages.results.length) {
      const statements = messages.results.map((message) => db.prepare(`
        INSERT OR IGNORE INTO todo_talk_messages (
          id, session_id, user_key, thread_id, realtime_item_id, role,
          content, focused_todo_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        sessionId,
        userKey,
        threadId,
        `legacy-assistant-${message.id}`.slice(0, 200),
        message.role,
        message.content || (message.role === "user" ? "Shared attachments" : "Assistant response"),
        legacy.todo_id,
        JSON.stringify({
          legacyAssistant: true,
          kind: message.kind,
          question: safeJson(message.question_json, null),
          proposal: safeJson(message.proposal_json, null),
          sources: safeJson(message.sources_json, []),
          attachmentIds: safeJson(message.attachment_ids_json, []),
        }),
        message.created_at,
      ));
      const results = await db.batch(statements);
      importedMessages += results.reduce((total, result) => total + Number(result.meta.changes ?? 0), 0);
      await db.prepare(`
        UPDATE todo_talk_threads
        SET last_message_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
      `).bind(messages.results.at(-1)!.created_at, threadId).run();
    }
  }
  await db.batch([
    db.prepare(`
      DELETE FROM todo_talk_messages
      WHERE thread_id IN (
        SELECT id FROM todo_talk_threads
        WHERE user_key = ? AND purge_after IS NOT NULL
          AND purge_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
      )
    `).bind(userKey),
    db.prepare(`
      DELETE FROM todo_talk_tool_calls
      WHERE thread_id IN (
        SELECT id FROM todo_talk_threads
        WHERE user_key = ? AND purge_after IS NOT NULL
          AND purge_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
      )
    `).bind(userKey),
    db.prepare(`
      DELETE FROM todo_talk_sessions
      WHERE thread_id IN (
        SELECT id FROM todo_talk_threads
        WHERE user_key = ? AND purge_after IS NOT NULL
          AND purge_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
      )
    `).bind(userKey),
    db.prepare(`
      DELETE FROM todo_talk_threads
      WHERE user_key = ? AND purge_after IS NOT NULL
        AND purge_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).bind(userKey),
  ]);
  console.info("[todo-talk] threaded workspace ready", {
    userKey,
    phoneThreadId,
    generalThreadId,
    importedThreads,
    importedMessages,
    durationMs: Date.now() - startedAt,
  });
  return { phoneThreadId, generalThreadId };
}

export async function listTalkThreads(userKey: string) {
  await ensureTalkThreads(userKey);
  const result = await database().prepare(`
    SELECT threads.*,
      COALESCE((
        SELECT content FROM todo_talk_messages
        WHERE thread_id = threads.id
        ORDER BY created_at DESC, id DESC LIMIT 1
      ), '') AS preview,
      (SELECT COUNT(*) FROM todo_talk_messages WHERE thread_id = threads.id) AS message_count
    FROM todo_talk_threads AS threads
    WHERE user_key = ? AND deleted_at IS NULL
    ORDER BY CASE kind WHEN 'phone' THEN 0 WHEN 'general' THEN 1 ELSE 2 END,
      COALESCE(last_message_at, updated_at) DESC
  `).bind(userKey).all<ThreadRow>();
  return result.results.map(mapThread);
}

export async function readTalkThread(userKey: string, threadId: string, includeDeleted = false) {
  await ensureTalkThreads(userKey);
  if (!validUuid(threadId)) throw new Error("That conversation is invalid.");
  const row = await database().prepare(`
    SELECT threads.*,
      COALESCE((
        SELECT content FROM todo_talk_messages
        WHERE thread_id = threads.id
        ORDER BY created_at DESC, id DESC LIMIT 1
      ), '') AS preview,
      (SELECT COUNT(*) FROM todo_talk_messages WHERE thread_id = threads.id) AS message_count
    FROM todo_talk_threads AS threads
    WHERE id = ? AND user_key = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"}
  `).bind(threadId, userKey).first<ThreadRow>();
  if (!row) throw new Error("Conversation not found.");
  return mapThread(row);
}

export async function resolveSystemTalkThread(userKey: string, systemKey: "phone" | "general") {
  const ids = await ensureTalkThreads(userKey);
  return readTalkThread(userKey, systemKey === "phone" ? ids.phoneThreadId : ids.generalThreadId);
}

export async function createTalkThread(userKey: string, title = "New conversation") {
  await ensureTalkThreads(userKey);
  const id = crypto.randomUUID();
  const cleanTitle = title.trim().replace(/\s+/g, " ").slice(0, 120) || "New conversation";
  await database().prepare(`
    INSERT INTO todo_talk_threads (id, user_key, kind, title)
    VALUES (?, ?, 'custom', ?)
  `).bind(id, userKey, cleanTitle).run();
  console.info("[todo-talk] custom thread created", { userKey, threadId: id, titleLength: cleanTitle.length });
  return readTalkThread(userKey, id);
}

export async function updateTalkThread(
  userKey: string,
  threadId: string,
  input: { title?: string; focusedTodoId?: number | null; draftText?: string },
) {
  const current = await readTalkThread(userKey, threadId);
  const title = input.title === undefined
    ? current.title
    : input.title.trim().replace(/\s+/g, " ").slice(0, 120) || current.title;
  const focusedTodoId = input.focusedTodoId === undefined ? current.focusedTodoId : input.focusedTodoId;
  if (focusedTodoId !== null && !await getTodo(focusedTodoId)) throw new Error("Task not found.");
  const draftText = input.draftText === undefined ? current.draftText : input.draftText.slice(0, 20_000);
  await database().prepare(`
    UPDATE todo_talk_threads
    SET title = ?, focused_todo_id = ?, draft_text = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND user_key = ? AND deleted_at IS NULL
  `).bind(title, focusedTodoId, draftText, threadId, userKey).run();
  console.info("[todo-talk] thread updated", {
    userKey,
    threadId,
    titleChanged: title !== current.title,
    focusChanged: focusedTodoId !== current.focusedTodoId,
    draftLength: draftText.length,
  });
  return readTalkThread(userKey, threadId);
}

export async function deleteTalkThread(userKey: string, threadId: string) {
  const current = await readTalkThread(userKey, threadId);
  if (current.kind !== "custom") throw new Error("System conversations cannot be deleted.");
  const deleteToken = crypto.randomUUID();
  const result = await database().prepare(`
    UPDATE todo_talk_threads
    SET delete_token = ?,
        deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        purge_after = strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND user_key = ? AND deleted_at IS NULL
  `).bind(deleteToken, threadId, userKey).run();
  if (!Number(result.meta.changes ?? 0)) throw new Error("Conversation not found.");
  console.info("[todo-talk] custom thread soft deleted", { userKey, threadId, deleteToken });
  return { threadId, undoToken: deleteToken };
}

export async function restoreTalkThread(userKey: string, deleteToken: string) {
  if (!validUuid(deleteToken)) throw new Error("That conversation undo is invalid.");
  const row = await database().prepare(`
    SELECT id FROM todo_talk_threads
    WHERE user_key = ? AND delete_token = ? AND deleted_at IS NOT NULL
  `).bind(userKey, deleteToken).first<{ id: string }>();
  if (!row) throw new Error("That conversation undo has expired or was already used.");
  await database().prepare(`
    UPDATE todo_talk_threads
    SET delete_token = NULL, deleted_at = NULL, purge_after = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND user_key = ?
  `).bind(row.id, userKey).run();
  console.info("[todo-talk] custom thread restored", { userKey, threadId: row.id });
  return readTalkThread(userKey, row.id);
}

export async function readTalkWorkspace(userKey: string) {
  await ensureTodoDatabase();
  const row = await database().prepare(`
    SELECT active_session_id, last_focused_todo_id, summary
    FROM todo_talk_workspaces
    WHERE user_key = ?
  `).bind(userKey).first<WorkspaceRow>();
  return {
    activeSessionId: row?.active_session_id ?? null,
    lastFocusedTodoId: row?.last_focused_todo_id ?? null,
    summary: row?.summary ?? "",
  };
}

export async function startTalkSession(input: {
  userKey: string;
  model: string;
  voice: string;
  focusedTodoId: number | null;
  threadId?: string | null;
  transport?: string;
}) {
  await ensureTodoDatabase();
  const fallback = await resolveSystemTalkThread(
    input.userKey,
    input.transport?.startsWith("phone") ? "phone" : "general",
  );
  const thread = input.threadId ? await readTalkThread(input.userKey, input.threadId) : fallback;
  const focusedTodoId = input.focusedTodoId ?? thread.focusedTodoId;
  if (focusedTodoId !== null && !await getTodo(focusedTodoId)) {
    throw new Error("The selected task no longer exists.");
  }
  const db = database();
  const previous = await db.prepare(`
    SELECT active_session_id
    FROM todo_talk_workspaces
    WHERE user_key = ?
  `).bind(input.userKey).first<{ active_session_id: string | null }>();
  const id = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [];
  if (previous?.active_session_id) {
    statements.push(db.prepare(`
      UPDATE todo_talk_sessions
      SET status = 'replaced',
          ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          end_reason = 'newer-session'
      WHERE id = ? AND user_key = ? AND status = 'active'
    `).bind(previous.active_session_id, input.userKey));
  }
  statements.push(
    db.prepare(`
      INSERT INTO todo_talk_sessions (id, user_key, thread_id, transport, model, voice)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, input.userKey, thread.id, input.transport?.trim().slice(0, 40) || "browser", input.model, input.voice),
    db.prepare(`
      INSERT INTO todo_talk_workspaces (
        user_key, active_session_id, last_focused_todo_id, updated_at
      ) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(user_key) DO UPDATE SET
        active_session_id = excluded.active_session_id,
        last_focused_todo_id = COALESCE(excluded.last_focused_todo_id, todo_talk_workspaces.last_focused_todo_id),
        updated_at = excluded.updated_at
    `).bind(input.userKey, id, focusedTodoId),
  );
  await db.batch(statements);
  console.info("[todo-talk] session lease acquired", {
    sessionId: id,
    replacedSessionId: previous?.active_session_id ?? null,
    threadId: thread.id,
    transport: input.transport?.trim().slice(0, 40) || "browser",
    focusedTodoId,
    model: input.model,
    voice: input.voice,
  });
  return { id, threadId: thread.id, focusedTodoId, replacedSessionId: previous?.active_session_id ?? null };
}

export async function assertActiveTalkSession(userKey: string, sessionId: string) {
  if (!validUuid(sessionId)) throw new Error("That Talk session is invalid.");
  await ensureTodoDatabase();
  const row = await database().prepare(`
    SELECT sessions.*
    FROM todo_talk_sessions AS sessions
    INNER JOIN todo_talk_workspaces AS workspaces
      ON workspaces.user_key = sessions.user_key
      AND workspaces.active_session_id = sessions.id
    WHERE sessions.id = ? AND sessions.user_key = ? AND sessions.status = 'active'
      AND sessions.last_activity_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 seconds')
  `).bind(sessionId, userKey).first<SessionRow>();
  if (!row) {
    const db = database();
    await db.batch([
      db.prepare(`
        UPDATE todo_talk_sessions
        SET status = 'ended',
            ended_at = COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            end_reason = COALESCE(end_reason, 'heartbeat-expired')
        WHERE id = ? AND user_key = ? AND status = 'active'
          AND last_activity_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 seconds')
      `).bind(sessionId, userKey),
      db.prepare(`
        UPDATE todo_talk_workspaces
        SET active_session_id = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE user_key = ? AND active_session_id = ?
          AND EXISTS (
            SELECT 1 FROM todo_talk_sessions
            WHERE id = ? AND status = 'ended' AND end_reason = 'heartbeat-expired'
          )
      `).bind(userKey, sessionId, sessionId),
    ]);
    throw new Error("This Talk session was replaced or ended.");
  }
  return row;
}

export async function heartbeatTalkSession(
  userKey: string,
  sessionId: string,
  focusedTodoId?: number | null,
) {
  await assertActiveTalkSession(userKey, sessionId);
  if (focusedTodoId !== undefined && focusedTodoId !== null && !await getTodo(focusedTodoId)) {
    throw new Error("The selected task no longer exists.");
  }
  const db = database();
  await db.batch([
    db.prepare(`
      UPDATE todo_talk_sessions
      SET last_activity_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND user_key = ? AND status = 'active'
    `).bind(sessionId, userKey),
    db.prepare(`
      UPDATE todo_talk_workspaces
      SET last_focused_todo_id = COALESCE(?, last_focused_todo_id),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_key = ? AND active_session_id = ?
    `).bind(focusedTodoId ?? null, userKey, sessionId),
    ...(focusedTodoId === undefined ? [] : [
      db.prepare(`
        UPDATE todo_talk_threads
        SET focused_todo_id = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = (
          SELECT thread_id FROM todo_talk_sessions
          WHERE id = ? AND user_key = ?
        )
      `).bind(focusedTodoId, sessionId, userKey),
    ]),
  ]);
  return { active: true, focusedTodoId: focusedTodoId ?? null };
}

export async function updateTalkFocus(userKey: string, sessionId: string, todoId: number | null) {
  await assertActiveTalkSession(userKey, sessionId);
  if (todoId !== null && !await getTodo(todoId)) throw new Error("Task not found.");
  const db = database();
  await db.batch([
    db.prepare(`
      UPDATE todo_talk_workspaces
      SET last_focused_todo_id = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_key = ? AND active_session_id = ?
    `).bind(todoId, userKey, sessionId),
    db.prepare(`
      UPDATE todo_talk_threads
      SET focused_todo_id = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = (
        SELECT thread_id FROM todo_talk_sessions
        WHERE id = ? AND user_key = ?
      )
    `).bind(todoId, sessionId, userKey),
  ]);
  console.info("[todo-talk] task focus changed", { sessionId, todoId });
  return { focusedTodoId: todoId };
}

export async function endTalkSession(userKey: string, sessionId: string, reason: string) {
  await ensureTodoDatabase();
  const cleanReason = reason.trim().slice(0, 80) || "ended";
  const db = database();
  const [sessionResult] = await db.batch([
    db.prepare(`
      UPDATE todo_talk_sessions
      SET status = CASE WHEN status = 'active' THEN 'ended' ELSE status END,
          ended_at = COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          end_reason = COALESCE(end_reason, ?)
      WHERE id = ? AND user_key = ?
    `).bind(cleanReason, sessionId, userKey),
    db.prepare(`
      UPDATE todo_talk_workspaces
      SET active_session_id = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_key = ? AND active_session_id = ?
    `).bind(userKey, sessionId),
  ]);
  const recent = await db.prepare(`
    SELECT role, content
    FROM todo_talk_messages
    WHERE user_key = ? AND session_id = ? AND role IN ('user', 'assistant', 'tool')
    ORDER BY created_at DESC
    LIMIT 30
  `).bind(userKey, sessionId).all<{ role: string; content: string }>();
  if (recent.results.length) {
    const summary = recent.results.reverse()
      .map((message) => `${message.role}: ${message.content.replace(/\s+/g, " ").slice(0, 500)}`)
      .join("\n")
      .slice(-8_000);
    await db.batch([
      db.prepare(`
        UPDATE todo_talk_workspaces
        SET summary = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE user_key = ?
      `).bind(summary, userKey),
      db.prepare(`
        UPDATE todo_talk_threads
        SET summary = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = (
          SELECT thread_id FROM todo_talk_sessions
          WHERE id = ? AND user_key = ?
        )
      `).bind(summary, sessionId, userKey),
    ]);
  }
  console.info("[todo-talk] session ended", {
    sessionId,
    reason: cleanReason,
    changed: Number(sessionResult.meta.changes ?? 0),
  });
  return { ended: true };
}

export async function appendTalkMessage(input: {
  userKey: string;
  sessionId: string;
  realtimeItemId: string;
  role: TalkMessageRole;
  content: string;
  focusedTodoId?: number | null;
  metadata?: Record<string, unknown>;
}) {
  await assertActiveTalkSession(input.userKey, input.sessionId);
  const realtimeItemId = input.realtimeItemId.trim();
  if (!realtimeItemId || realtimeItemId.length > 200) throw new Error("That transcript event is invalid.");
  const content = input.content.trim().slice(0, 40_000);
  if (!content) throw new Error("Empty transcript events are not stored.");
  const db = database();
  const id = crypto.randomUUID();
  const session = await db.prepare(`
    SELECT thread_id FROM todo_talk_sessions
    WHERE id = ? AND user_key = ?
  `).bind(input.sessionId, input.userKey).first<{ thread_id: string | null }>();
  const result = await db.prepare(`
    INSERT OR IGNORE INTO todo_talk_messages (
      id, session_id, user_key, thread_id, realtime_item_id, role, content,
      focused_todo_id, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    input.sessionId,
    input.userKey,
    session?.thread_id ?? null,
    realtimeItemId,
    input.role,
    content,
    input.focusedTodoId ?? null,
    JSON.stringify(input.metadata ?? {}),
  ).run();
  const row = await db.prepare(`
    SELECT id, session_id, thread_id, realtime_item_id, role, content,
           focused_todo_id, metadata_json, created_at
    FROM todo_talk_messages
    WHERE user_key = ? AND realtime_item_id = ?
  `).bind(input.userKey, realtimeItemId).first<MessageRow>();
  if (row?.thread_id) {
    const autoTitle = input.role === "user"
      ? content.replace(/\s+/g, " ").slice(0, 56)
      : "";
    await db.prepare(`
      UPDATE todo_talk_threads
      SET last_message_at = ?,
          title = CASE
            WHEN kind = 'custom' AND title = 'New conversation' AND ? <> '' THEN ?
            ELSE title
          END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND user_key = ?
    `).bind(row.created_at, autoTitle, autoTitle, row.thread_id, input.userKey).run();
  }
  console.info("[todo-talk] finalized transcript stored", {
    sessionId: input.sessionId,
    realtimeItemId,
    role: input.role,
    contentLength: content.length,
    focusedTodoId: input.focusedTodoId ?? null,
    replayed: !Number(result.meta.changes ?? 0),
  });
  return { message: mapMessage(row!), replayed: !Number(result.meta.changes ?? 0) };
}

export async function appendTalkSystemReceipt(input: {
  userKey: string;
  systemKey: "phone" | "general";
  eventId: string;
  content: string;
  focusedTodoId?: number | null;
  metadata?: Record<string, unknown>;
}) {
  await ensureTodoDatabase();
  const thread = await resolveSystemTalkThread(input.userKey, input.systemKey);
  const content = input.content.trim().slice(0, 40_000);
  const eventId = input.eventId.trim().slice(0, 200);
  if (!content || !eventId) throw new Error("That system receipt is invalid.");
  const db = database();
  const id = crypto.randomUUID();
  const result = await db.prepare(`
    INSERT OR IGNORE INTO todo_talk_messages (
      id, session_id, user_key, thread_id, realtime_item_id, role, content,
      focused_todo_id, metadata_json
    ) VALUES (?, ?, ?, ?, ?, 'assistant', ?, ?, ?)
  `).bind(
    id,
    `system-${input.systemKey}`,
    input.userKey,
    thread.id,
    eventId,
    content,
    input.focusedTodoId ?? null,
    JSON.stringify(input.metadata ?? {}),
  ).run();
  const row = await db.prepare(`
    SELECT id, session_id, thread_id, realtime_item_id, role, content,
           focused_todo_id, metadata_json, created_at
    FROM todo_talk_messages
    WHERE user_key = ? AND realtime_item_id = ?
  `).bind(input.userKey, eventId).first<MessageRow>();
  if (row && Number(result.meta.changes ?? 0)) {
    await db.prepare(`
      UPDATE todo_talk_threads
      SET last_message_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND user_key = ?
    `).bind(row.created_at, thread.id, input.userKey).run();
  }
  console.info("[todo-talk] system receipt stored", {
    userKey: input.userKey,
    systemKey: input.systemKey,
    eventId,
    focusedTodoId: input.focusedTodoId ?? null,
    replayed: !Number(result.meta.changes ?? 0),
  });
  return { message: row ? mapMessage(row) : null, replayed: !Number(result.meta.changes ?? 0) };
}

export async function listTalkHistory(
  userKey: string,
  input: { before?: string | null; limit?: number; threadId?: string | null } = {},
) {
  await ensureTalkThreads(userKey);
  const limit = Math.max(1, Math.min(100, Number(input.limit ?? 60)));
  const before = input.before?.trim() || null;
  const threadId = input.threadId?.trim() || null;
  if (threadId) await readTalkThread(userKey, threadId);
  const db = database();
  const result = before && threadId
    ? await db.prepare(`
        SELECT id, session_id, thread_id, realtime_item_id, role, content,
               focused_todo_id, metadata_json, created_at
        FROM todo_talk_messages
        WHERE user_key = ? AND thread_id = ? AND created_at < ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).bind(userKey, threadId, before, limit + 1).all<MessageRow>()
    : before
    ? await db.prepare(`
        SELECT id, session_id, thread_id, realtime_item_id, role, content,
               focused_todo_id, metadata_json, created_at
        FROM todo_talk_messages
        WHERE user_key = ? AND created_at < ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
    `).bind(userKey, before, limit + 1).all<MessageRow>()
    : threadId
    ? await db.prepare(`
        SELECT id, session_id, thread_id, realtime_item_id, role, content,
               focused_todo_id, metadata_json, created_at
        FROM todo_talk_messages
        WHERE user_key = ? AND thread_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).bind(userKey, threadId, limit + 1).all<MessageRow>()
    : await db.prepare(`
        SELECT id, session_id, thread_id, realtime_item_id, role, content,
               focused_todo_id, metadata_json, created_at
        FROM todo_talk_messages
        WHERE user_key = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).bind(userKey, limit + 1).all<MessageRow>();
  const hasMore = result.results.length > limit;
  const page = result.results.slice(0, limit);
  return {
    messages: page.map(mapMessage).reverse(),
    nextCursor: hasMore ? page.at(-1)?.created_at ?? null : null,
  };
}

export async function searchTalkHistory(
  userKey: string,
  input: { query: string; todoId?: number | null; limit?: number },
) {
  await ensureTalkThreads(userKey);
  const query = input.query.trim().slice(0, 300);
  if (!query) return [];
  const limit = Math.max(1, Math.min(30, Number(input.limit ?? 12)));
  const clauses = [
    "messages.user_key = ?",
    "messages.content LIKE ? ESCAPE '\\'",
    "threads.deleted_at IS NULL",
  ];
  const values: Array<string | number> = [
    userKey,
    `%${query.replace(/[\\%_]/g, "\\$&")}%`,
  ];
  if (input.todoId !== undefined && input.todoId !== null) {
    clauses.push("messages.focused_todo_id = ?");
    values.push(input.todoId);
  }
  values.push(limit);
  const result = await database().prepare(`
    SELECT messages.id, messages.session_id, messages.realtime_item_id,
           messages.role, messages.content, messages.thread_id,
           messages.focused_todo_id, messages.metadata_json, messages.created_at
    FROM todo_talk_messages AS messages
    INNER JOIN todo_talk_threads AS threads ON threads.id = messages.thread_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY messages.created_at DESC
    LIMIT ?
  `).bind(...values).all<MessageRow>();
  return result.results.map(mapMessage);
}

async function memoryDedupeKey(scope: TalkMemoryScope, todoId: number | null, content: string) {
  const normalized = `${scope}:${todoId ?? ""}:${content.trim().toLowerCase().replace(/\s+/g, " ")}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function listAssistantMemories(
  userKey: string,
  input: { todoId?: number | null; query?: string; limit?: number } = {},
) {
  await ensureTodoDatabase();
  const limit = Math.max(1, Math.min(50, Number(input.limit ?? 20)));
  const query = input.query?.trim().slice(0, 300) || null;
  const values: Array<string | number> = [userKey];
  const clauses = ["user_key = ?", "forgotten_at IS NULL"];
  if (input.todoId !== undefined) {
    clauses.push("(scope = 'global' OR todo_id = ?)");
    values.push(input.todoId ?? -1);
  }
  if (query) {
    clauses.push("content LIKE ? ESCAPE '\\'");
    values.push(`%${query.replace(/[\\%_]/g, "\\$&")}%`);
  }
  values.push(limit);
  const result = await database().prepare(`
    SELECT id, scope, todo_id, kind, content, provenance_json, created_at, updated_at
    FROM todo_assistant_memories
    WHERE ${clauses.join(" AND ")}
    ORDER BY updated_at DESC
    LIMIT ?
  `).bind(...values).all<MemoryRow>();
  return result.results.map(mapMemory);
}

export async function rememberAssistantFact(input: {
  userKey: string;
  scope: TalkMemoryScope;
  todoId?: number | null;
  content: string;
  kind?: string;
  provenance?: Record<string, unknown>;
}) {
  await ensureTodoDatabase();
  const content = input.content.trim();
  if (!content || content.length > 4_000) throw new Error("Memories must contain between 1 and 4,000 characters.");
  const todoId = input.scope === "task" ? Number(input.todoId) : null;
  if (input.scope === "task") {
    if (!Number.isInteger(todoId) || todoId === null || todoId < 1 || !await getTodo(todoId)) {
      throw new Error("A valid task is required for task-specific memory.");
    }
  }
  const dedupeKey = await memoryDedupeKey(input.scope, todoId, content);
  const id = crypto.randomUUID();
  const db = database();
  await db.prepare(`
    INSERT INTO todo_assistant_memories (
      id, user_key, scope, todo_id, kind, content, provenance_json, dedupe_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_key, dedupe_key) DO UPDATE SET
      content = excluded.content,
      kind = excluded.kind,
      provenance_json = excluded.provenance_json,
      forgotten_at = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).bind(
    id,
    input.userKey,
    input.scope,
    todoId,
    input.kind?.trim().slice(0, 80) || "fact",
    content,
    JSON.stringify(input.provenance ?? {}),
    dedupeKey,
  ).run();
  const row = await db.prepare(`
    SELECT id, scope, todo_id, kind, content, provenance_json, created_at, updated_at
    FROM todo_assistant_memories
    WHERE user_key = ? AND dedupe_key = ?
  `).bind(input.userKey, dedupeKey).first<MemoryRow>();
  console.info("[todo-talk] memory saved", {
    scope: input.scope,
    todoId,
    kind: row?.kind ?? "fact",
    contentLength: content.length,
  });
  return mapMemory(row!);
}

export async function forgetAssistantMemories(
  userKey: string,
  input: { ids?: string[]; query?: string; todoId?: number | null },
) {
  await ensureTodoDatabase();
  const ids = [...new Set((input.ids ?? []).filter(validUuid))].slice(0, 50);
  const query = input.query?.trim().slice(0, 300) || null;
  if (!ids.length && !query) throw new Error("Choose which memory should be forgotten.");
  const clauses = ["user_key = ?", "forgotten_at IS NULL"];
  const values: Array<string | number> = [userKey];
  if (ids.length) {
    clauses.push(`id IN (${ids.map(() => "?").join(", ")})`);
    values.push(...ids);
  }
  if (query) {
    clauses.push("content LIKE ? ESCAPE '\\'");
    values.push(`%${query.replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (input.todoId !== undefined) {
    clauses.push("todo_id = ?");
    values.push(input.todoId ?? -1);
  }
  const result = await database().prepare(`
    UPDATE todo_assistant_memories
    SET forgotten_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE ${clauses.join(" AND ")}
  `).bind(...values).run();
  const forgotten = Number(result.meta.changes ?? 0);
  console.info("[todo-talk] memories forgotten", { forgotten, requestedIds: ids.length, hasQuery: Boolean(query) });
  return { forgotten };
}

export async function beginTalkToolCall(input: {
  userKey: string;
  sessionId: string;
  callId: string;
  name: string;
  argumentsJson: string;
}) {
  await assertActiveTalkSession(input.userKey, input.sessionId);
  if (!input.callId.trim() || input.callId.length > 200) throw new Error("That tool call is invalid.");
  const db = database();
  const session = await db.prepare(`
    SELECT thread_id FROM todo_talk_sessions
    WHERE id = ? AND user_key = ?
  `).bind(input.sessionId, input.userKey).first<{ thread_id: string | null }>();
  const inserted = await db.prepare(`
    INSERT OR IGNORE INTO todo_talk_tool_calls (
      call_id, session_id, user_key, thread_id, name, arguments_json, status
    ) VALUES (?, ?, ?, ?, ?, ?, 'running')
  `).bind(input.callId, input.sessionId, input.userKey, session?.thread_id ?? null, input.name, input.argumentsJson).run();
  const row = await db.prepare(`
    SELECT call_id, session_id, user_key, thread_id, name, arguments_json, status, result_json, undo_token
    FROM todo_talk_tool_calls
    WHERE call_id = ? AND user_key = ?
  `).bind(input.callId, input.userKey).first<ToolCallRow>();
  if (!row || row.session_id !== input.sessionId || row.name !== input.name || row.arguments_json !== input.argumentsJson) {
    throw new Error("That tool call identifier was already used for a different operation.");
  }
  return {
    replayed: !Number(inserted.meta.changes ?? 0),
    pending: row.status === "running",
    failed: row.status === "failed",
    result: safeJson<Record<string, unknown> | null>(row.result_json, null),
    undoToken: row.undo_token,
  };
}

export async function completeTalkToolCall(input: {
  userKey: string;
  sessionId: string;
  callId: string;
  result: Record<string, unknown>;
  undoToken?: string | null;
  failed?: boolean;
}) {
  const resultJson = JSON.stringify(input.result);
  if (resultJson.length > 100_000) throw new Error("That tool result is too large.");
  await database().prepare(`
    UPDATE todo_talk_tool_calls
    SET status = ?,
        result_json = ?,
        undo_token = ?,
        completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE call_id = ? AND session_id = ? AND user_key = ?
  `).bind(
    input.failed ? "failed" : "completed",
    resultJson,
    input.undoToken ?? null,
    input.callId,
    input.sessionId,
    input.userKey,
  ).run();
  console.info("[todo-talk] tool call completed", {
    sessionId: input.sessionId,
    callId: input.callId,
    failed: Boolean(input.failed),
    undoAvailable: Boolean(input.undoToken),
    resultBytes: resultJson.length,
  });
  return input.result;
}

export async function readTalkToolCall(userKey: string, callId: string) {
  await ensureTodoDatabase();
  const row = await database().prepare(`
    SELECT call_id, session_id, user_key, thread_id, name, arguments_json, status, result_json, undo_token
    FROM todo_talk_tool_calls
    WHERE call_id = ? AND user_key = ?
  `).bind(callId, userKey).first<ToolCallRow>();
  return row ? {
    callId: row.call_id,
    sessionId: row.session_id,
    name: row.name,
    arguments: safeJson<Record<string, unknown>>(row.arguments_json, {}),
    status: row.status,
    result: safeJson<Record<string, unknown> | null>(row.result_json, null),
    undoToken: row.undo_token,
  } : null;
}

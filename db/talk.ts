import { env } from "cloudflare:workers";
import { ensureTodoDatabase, getTodo, type Todo } from "./todos";

export type TalkSessionStatus = "active" | "ended" | "replaced";
export type TalkMessageRole = "user" | "assistant" | "tool" | "system";
export type TalkMemoryScope = "global" | "task";

export type TalkMessage = {
  id: string;
  sessionId: string;
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
  name: string;
  arguments_json: string;
  status: string;
  result_json: string | null;
  undo_token: string | null;
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
    realtimeItemId: row.realtime_item_id,
    role: row.role,
    content: row.content,
    focusedTodoId: row.focused_todo_id,
    metadata: safeJson(row.metadata_json, {}),
    createdAt: row.created_at,
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
}) {
  await ensureTodoDatabase();
  if (input.focusedTodoId !== null && !await getTodo(input.focusedTodoId)) {
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
      INSERT INTO todo_talk_sessions (id, user_key, model, voice)
      VALUES (?, ?, ?, ?)
    `).bind(id, input.userKey, input.model, input.voice),
    db.prepare(`
      INSERT INTO todo_talk_workspaces (
        user_key, active_session_id, last_focused_todo_id, updated_at
      ) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(user_key) DO UPDATE SET
        active_session_id = excluded.active_session_id,
        last_focused_todo_id = COALESCE(excluded.last_focused_todo_id, todo_talk_workspaces.last_focused_todo_id),
        updated_at = excluded.updated_at
    `).bind(input.userKey, id, input.focusedTodoId),
  );
  await db.batch(statements);
  console.info("[todo-talk] session lease acquired", {
    sessionId: id,
    replacedSessionId: previous?.active_session_id ?? null,
    focusedTodoId: input.focusedTodoId,
    model: input.model,
    voice: input.voice,
  });
  return { id, replacedSessionId: previous?.active_session_id ?? null };
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
  ]);
  return { active: true, focusedTodoId: focusedTodoId ?? null };
}

export async function updateTalkFocus(userKey: string, sessionId: string, todoId: number | null) {
  await assertActiveTalkSession(userKey, sessionId);
  if (todoId !== null && !await getTodo(todoId)) throw new Error("Task not found.");
  await database().prepare(`
    UPDATE todo_talk_workspaces
    SET last_focused_todo_id = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE user_key = ? AND active_session_id = ?
  `).bind(todoId, userKey, sessionId).run();
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
    await db.prepare(`
      UPDATE todo_talk_workspaces
      SET summary = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_key = ?
    `).bind(summary, userKey).run();
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
  const result = await db.prepare(`
    INSERT OR IGNORE INTO todo_talk_messages (
      id, session_id, user_key, realtime_item_id, role, content,
      focused_todo_id, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    input.sessionId,
    input.userKey,
    realtimeItemId,
    input.role,
    content,
    input.focusedTodoId ?? null,
    JSON.stringify(input.metadata ?? {}),
  ).run();
  const row = await db.prepare(`
    SELECT id, session_id, realtime_item_id, role, content,
           focused_todo_id, metadata_json, created_at
    FROM todo_talk_messages
    WHERE user_key = ? AND realtime_item_id = ?
  `).bind(input.userKey, realtimeItemId).first<MessageRow>();
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

export async function listTalkHistory(
  userKey: string,
  input: { before?: string | null; limit?: number } = {},
) {
  await ensureTodoDatabase();
  const limit = Math.max(1, Math.min(100, Number(input.limit ?? 60)));
  const before = input.before?.trim() || null;
  const db = database();
  const result = before
    ? await db.prepare(`
        SELECT id, session_id, realtime_item_id, role, content,
               focused_todo_id, metadata_json, created_at
        FROM todo_talk_messages
        WHERE user_key = ? AND created_at < ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).bind(userKey, before, limit + 1).all<MessageRow>()
    : await db.prepare(`
        SELECT id, session_id, realtime_item_id, role, content,
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
  await ensureTodoDatabase();
  const query = input.query.trim().slice(0, 300);
  if (!query) return [];
  const limit = Math.max(1, Math.min(30, Number(input.limit ?? 12)));
  const clauses = ["user_key = ?", "content LIKE ? ESCAPE '\\'"];
  const values: Array<string | number> = [
    userKey,
    `%${query.replace(/[\\%_]/g, "\\$&")}%`,
  ];
  if (input.todoId !== undefined && input.todoId !== null) {
    clauses.push("focused_todo_id = ?");
    values.push(input.todoId);
  }
  values.push(limit);
  const result = await database().prepare(`
    SELECT id, session_id, realtime_item_id, role, content,
           focused_todo_id, metadata_json, created_at
    FROM todo_talk_messages
    WHERE ${clauses.join(" AND ")}
    ORDER BY created_at DESC
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
  const inserted = await db.prepare(`
    INSERT OR IGNORE INTO todo_talk_tool_calls (
      call_id, session_id, user_key, name, arguments_json, status
    ) VALUES (?, ?, ?, ?, ?, 'running')
  `).bind(input.callId, input.sessionId, input.userKey, input.name, input.argumentsJson).run();
  const row = await db.prepare(`
    SELECT call_id, session_id, user_key, name, arguments_json, status, result_json, undo_token
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
    SELECT call_id, session_id, user_key, name, arguments_json, status, result_json, undo_token
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

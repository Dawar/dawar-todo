import { env } from "cloudflare:workers";
import { importedTodos } from "./imported-todos";
import {
  type AttachmentRow,
  attachmentSnapshotsForTodos,
  claimDraftAttachments,
  restoreAttachmentStatements,
} from "./attachments";

type StoredTodoStatus = "open" | "completed" | "archived";
export type TodoStatus = "open" | "completed";
export type BulkTodoAction = "complete" | "snooze" | "unsnooze" | "reproject" | "delete";
export type ProjectDeleteMode = "reassign" | "delete";

type TodoRow = {
  id: number;
  title: string;
  notes: string;
  status: StoredTodoStatus;
  priority: number;
  due_date: string | null;
  project: string | null;
  context: string | null;
  source_kind: string | null;
  source_id: number | null;
  client_id: string | null;
  completed_at: string | null;
  snoozed_until: string | null;
  created_at: string;
  updated_at: string;
  attachment_count?: number;
};

type UndoSnapshot = {
  todos: TodoRow[];
  attachments?: AttachmentRow[];
  createdSourceKind?: string;
};

export type Todo = {
  id: number;
  title: string;
  notes: string;
  status: TodoStatus;
  priority: number;
  dueDate: string | null;
  project: string | null;
  context: string | null;
  sourceKind: string | null;
  sourceId: number | null;
  clientId: string | null;
  completedAt: string | null;
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
  attachmentCount: number;
};

export type TodoUpdate = Partial<
  Pick<Todo, "title" | "notes" | "priority" | "dueDate" | "project" | "context" | "snoozedUntil">
> & { status?: TodoStatus };

export type TodoSettings = {
  snoozeTimeZone: string;
  snoozeWakeHour: number;
};

let initialization: Promise<void> | null = null;

function database() {
  if (!env.DB) throw new Error("The todo database is unavailable.");
  return env.DB;
}

function mapTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    status: row.status === "archived" ? "open" : row.status,
    priority: row.priority,
    dueDate: row.due_date,
    project: row.project,
    context: row.context,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    clientId: row.client_id,
    completedAt: row.completed_at,
    snoozedUntil: row.snoozed_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachmentCount: Number(row.attachment_count ?? 0),
  };
}

export async function ensureTodoDatabase() {
  if (initialization) return initialization;

  initialization = (async () => {
    const db = database();
    await db.batch([
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','archived')),
          priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
          due_date TEXT,
          project TEXT,
          context TEXT,
          source_kind TEXT,
          source_id INTEGER,
          client_id TEXT,
          completed_at TEXT,
          snoozed_until TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
      db.prepare("CREATE INDEX IF NOT EXISTS todos_status_idx ON todos(status)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todos_project_idx ON todos(project)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todos_due_date_idx ON todos(due_date)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS todos_source_idx ON todos(source_kind, source_id)"),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_action_history (
          id TEXT PRIMARY KEY NOT NULL,
          snapshot TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_attachments (
          id TEXT PRIMARY KEY NOT NULL,
          todo_id INTEGER,
          draft_token TEXT,
          original_key TEXT NOT NULL UNIQUE,
          display_key TEXT NOT NULL UNIQUE,
          thumbnail_key TEXT NOT NULL UNIQUE,
          file_name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          kind TEXT NOT NULL DEFAULT 'image',
          duration_ms INTEGER NOT NULL DEFAULT 0,
          upload_state TEXT NOT NULL DEFAULT 'ready',
          sort_order INTEGER NOT NULL DEFAULT 0,
          expires_at TEXT,
          deleted_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
    ]);

    const columns = await db.prepare("PRAGMA table_info(todos)").all<{ name: string }>();
    if (!columns.results.some((column) => column.name === "snoozed_until")) {
      await db.prepare("ALTER TABLE todos ADD COLUMN snoozed_until TEXT").run();
      console.info("[todo-db] added snoozed_until compatibility column");
    }
    await db.prepare("CREATE INDEX IF NOT EXISTS todos_snoozed_until_idx ON todos(snoozed_until)").run();
    await db.prepare("CREATE INDEX IF NOT EXISTS todo_action_history_created_at_idx ON todo_action_history(created_at)").run();
    const attachmentColumns = await db.prepare("PRAGMA table_info(todo_attachments)").all<{ name: string }>();
    if (!attachmentColumns.results.some((column) => column.name === "upload_state")) {
      await db.prepare("ALTER TABLE todo_attachments ADD COLUMN upload_state TEXT NOT NULL DEFAULT 'ready'").run();
      console.info("[todo-db] added attachment upload state compatibility column");
    }
    if (!attachmentColumns.results.some((column) => column.name === "kind")) {
      await db.prepare("ALTER TABLE todo_attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'image'").run();
      console.info("[todo-db] added attachment kind compatibility column");
    }
    if (!attachmentColumns.results.some((column) => column.name === "duration_ms")) {
      await db.prepare("ALTER TABLE todo_attachments ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0").run();
      console.info("[todo-db] added attachment duration compatibility column");
    }
    const todoColumns = await db.prepare("PRAGMA table_info(todos)").all<{ name: string }>();
    if (!todoColumns.results.some((column) => column.name === "client_id")) {
      await db.prepare("ALTER TABLE todos ADD COLUMN client_id TEXT").run();
      console.info("[todo-db] added offline sync client id compatibility column");
    }
    await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS todos_client_id_idx ON todos(client_id)").run();
    await db.batch([
      db.prepare("CREATE INDEX IF NOT EXISTS todo_attachments_todo_id_idx ON todo_attachments(todo_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_attachments_draft_token_idx ON todo_attachments(draft_token)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_attachments_expires_at_idx ON todo_attachments(expires_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_attachments_deleted_at_idx ON todo_attachments(deleted_at)"),
    ]);

    await db.batch([
      db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('snooze_timezone', 'America/Toronto')"),
      db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('snooze_wake_hour', '8')"),
    ]);

    const total = await db.prepare("SELECT COUNT(*) AS count FROM todos").first<{ count: number }>();
    const existingTotal = Number(total?.count ?? 0);
    const seedVersion = await db
      .prepare("SELECT value FROM app_settings WHERE key = 'seed_version'")
      .first<{ value: string }>();
    let inserted = 0;
    if (!seedVersion && existingTotal === 0) {
      const seed = db.prepare(`
        INSERT OR IGNORE INTO todos (
          title, notes, status, priority, due_date, project, context,
          source_kind, source_id, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const results = await db.batch(
        importedTodos.map((todo) =>
          seed.bind(
            todo.title,
            todo.notes,
            todo.status,
            todo.priority,
            todo.dueDate,
            todo.project || null,
            todo.context || null,
            todo.sourceKind,
            todo.sourceId,
            todo.completedAt,
            todo.createdAt,
            todo.updatedAt,
          ),
        ),
      );
      inserted = results.reduce((sum, result) => sum + Number(result.meta.changes ?? 0), 0);
    }
    if (!seedVersion) {
      await db.prepare("INSERT INTO app_settings (key, value) VALUES ('seed_version', '1')").run();
    }

    const archiveStatusVersion = await db
      .prepare("SELECT value FROM app_settings WHERE key = 'archive_status_to_open_v1'")
      .first<{ value: string }>();
    let archivedConverted = 0;
    if (!archiveStatusVersion) {
      const results = await db.batch([
        db.prepare(`
          UPDATE todos
          SET status = 'open',
              completed_at = NULL,
              snoozed_until = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE status = 'archived'
        `),
        db.prepare("INSERT INTO app_settings (key, value) VALUES ('archive_status_to_open_v1', '1')"),
      ]);
      archivedConverted = Number(results[0].meta.changes ?? 0);
      console.info("[todo-db] legacy archives converted to open tasks", {
        changed: archivedConverted,
        retainedProjectAssignments: true,
      });
    }

    const projectBackfill = await db.prepare(`
      INSERT OR IGNORE INTO todo_projects (name)
      SELECT DISTINCT trim(project)
      FROM todos
      WHERE project IS NOT NULL AND trim(project) <> ''
    `).run();
    const registeredProjects = await db.prepare("SELECT COUNT(*) AS count FROM todo_projects").first<{ count: number }>();
    console.info("[todo-db] project registry ready", {
      imported: Number(projectBackfill.meta.changes ?? 0),
      total: Number(registeredProjects?.count ?? 0),
    });

    console.info("[todo-db] ready", {
      inserted,
      total: existingTotal + inserted,
      imported: importedTodos.length,
      seedSkipped: Boolean(seedVersion) || existingTotal > 0,
      archivedConverted,
    });
  })().catch((error) => {
    initialization = null;
    throw error;
  });

  return initialization;
}

export async function listTodos(): Promise<Todo[]> {
  await ensureTodoDatabase();
  const result = await database()
    .prepare(`
      SELECT todos.*,
        (SELECT COUNT(*) FROM todo_attachments
         WHERE todo_attachments.todo_id = todos.id
           AND todo_attachments.upload_state = 'ready'
           AND todo_attachments.deleted_at IS NULL) AS attachment_count
      FROM todos
      ORDER BY updated_at DESC, id DESC
    `)
    .all<TodoRow>();
  return result.results.map(mapTodo);
}

export async function listTodoProjects(): Promise<string[]> {
  await ensureTodoDatabase();
  const result = await database()
    .prepare("SELECT name FROM todo_projects ORDER BY name COLLATE NOCASE ASC")
    .all<{ name: string }>();
  return result.results.map((row) => row.name);
}

export async function createTodoProject(inputName: string): Promise<string> {
  await ensureTodoDatabase();
  const name = inputName.trim();
  if (!name) throw new Error("A project name is required.");
  if (name.length > 120) throw new Error("Project names are limited to 120 characters.");
  const result = await database()
    .prepare("INSERT OR IGNORE INTO todo_projects (name) VALUES (?)")
    .bind(name)
    .run();
  if (!Number(result.meta.changes ?? 0)) throw new Error("A project with that name already exists.");
  console.info("[todo-db] project created", { name, nameLength: name.length });
  return name;
}

export async function deleteTodoProject(
  inputName: string,
  mode: ProjectDeleteMode,
  inputTargetProject?: string | null,
) {
  await ensureTodoDatabase();
  const name = inputName.trim();
  const targetProject = inputTargetProject?.trim() || null;
  if (!name) throw new Error("A project name is required.");
  if (mode !== "reassign" && mode !== "delete") throw new Error("Choose what should happen to this project's notes.");
  if (mode === "reassign" && !targetProject) throw new Error("Choose a project for these notes.");
  if (targetProject === name) throw new Error("Choose a different project for these notes.");

  const db = database();
  const existing = await db.prepare("SELECT name FROM todo_projects WHERE name = ?").bind(name).first<{ name: string }>();
  if (!existing) throw new Error("That project no longer exists.");
  if (targetProject) {
    const target = await db.prepare("SELECT name FROM todo_projects WHERE name = ?").bind(targetProject).first<{ name: string }>();
    if (!target) throw new Error("The destination project no longer exists.");
  }

  const beforeResult = await db
    .prepare("SELECT * FROM todos WHERE project = ? ORDER BY id")
    .bind(name)
    .all<TodoRow>();
  const before = beforeResult.results;
  const attachmentBefore = mode === "delete"
    ? await attachmentSnapshotsForTodos(before.map((todo) => todo.id))
    : [];
  const undoToken = before.length > 0 && before.length <= 200 ? crypto.randomUUID() : null;
  const statements = [
    db.prepare("DELETE FROM todo_action_history WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')"),
    ...(undoToken
      ? [db.prepare("INSERT INTO todo_action_history (id, snapshot) VALUES (?, ?)")
        .bind(undoToken, JSON.stringify({ todos: before, attachments: attachmentBefore } satisfies UndoSnapshot))]
      : []),
    ...(mode === "delete" && before.length
      ? [db.prepare(`
        UPDATE todo_attachments
        SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE todo_id IN (${placeholders(before.length)}) AND deleted_at IS NULL
      `).bind(...before.map((todo) => todo.id))]
      : []),
    mode === "reassign"
      ? db.prepare("UPDATE todos SET project = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE project = ?").bind(targetProject, name)
      : db.prepare("DELETE FROM todos WHERE project = ?").bind(name),
    db.prepare("DELETE FROM todo_projects WHERE name = ?").bind(name),
  ];
  await db.batch(statements);
  console.info("[todo-db] project deleted", {
    name,
    mode,
    targetProject,
    affected: before.length,
    attachmentsAffected: attachmentBefore.length,
    undoAvailable: Boolean(undoToken),
  });
  return { project: name, mode, targetProject, affected: before.length, undoToken };
}

export async function createTodo(input: {
  title: string;
  notes?: string;
  priority?: number;
  dueDate?: string | null;
  project?: string | null;
  context?: string | null;
  draftToken?: string;
  attachmentIds?: string[];
  clientId?: string;
}): Promise<Todo> {
  await ensureTodoDatabase();
  const clientId = input.clientId?.trim() || null;
  if (clientId && !/^[0-9a-f-]{36}$/i.test(clientId)) throw new Error("That offline task identifier is invalid.");
  const project = input.project?.trim() || null;
  if (project?.length && project.length > 120) throw new Error("Project names are limited to 120 characters.");
  const db = database();
  if (clientId) {
    const existing = await db.prepare(`
      SELECT todos.*,
        (SELECT COUNT(*) FROM todo_attachments
         WHERE todo_attachments.todo_id = todos.id
           AND todo_attachments.upload_state = 'ready'
           AND todo_attachments.deleted_at IS NULL) AS attachment_count
      FROM todos WHERE client_id = ?
    `).bind(clientId).first<TodoRow>();
    if (existing) {
      console.info("[todo-db] idempotent offline create replay resolved", { clientId, id: existing.id, attachmentCount: Number(existing.attachment_count ?? 0) });
      return mapTodo(existing);
    }
  }
  if (project) {
    await db.prepare("INSERT OR IGNORE INTO todo_projects (name) VALUES (?)").bind(project).run();
  }
  const row = await db
    .prepare(`
      ${clientId ? "INSERT OR IGNORE" : "INSERT"} INTO todos (title, notes, status, priority, due_date, project, context, source_kind, client_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'site', ?)
      RETURNING *
    `)
    .bind(
      input.title,
      input.notes ?? "",
      "open",
      input.priority ?? 3,
      input.dueDate ?? null,
      project,
      input.context ?? null,
      clientId,
    )
    .first<TodoRow>();
  if (!row && clientId) {
    const replay = await db.prepare(`
      SELECT todos.*,
        (SELECT COUNT(*) FROM todo_attachments
         WHERE todo_attachments.todo_id = todos.id
           AND todo_attachments.upload_state = 'ready'
           AND todo_attachments.deleted_at IS NULL) AS attachment_count
      FROM todos WHERE client_id = ?
    `).bind(clientId).first<TodoRow>();
    if (replay) {
      console.info("[todo-db] concurrent offline create replay resolved", { clientId, id: replay.id, attachmentCount: Number(replay.attachment_count ?? 0) });
      return mapTodo(replay);
    }
  }
  if (!row) throw new Error("The task could not be created.");
  try {
    const attachmentCount = await claimDraftAttachments(row.id, input.draftToken, input.attachmentIds);
    console.info("[todo-db] task created", { id: row.id, clientId, attachmentCount });
    return mapTodo({ ...row, attachment_count: attachmentCount });
  } catch (error) {
    await db.prepare("DELETE FROM todos WHERE id = ?").bind(row.id).run();
    console.error("[todo-db] task attachment claim failed; task rolled back", { id: row.id, error });
    throw error;
  }
}

export async function updateTodo(id: number, update: TodoUpdate): Promise<{ todo: Todo; undoToken: string | null } | null> {
  await ensureTodoDatabase();
  const columnByField: Record<keyof TodoUpdate, string> = {
    title: "title",
    notes: "notes",
    status: "status",
    priority: "priority",
    dueDate: "due_date",
    project: "project",
    context: "context",
    snoozedUntil: "snoozed_until",
  };
  const entries = (Object.entries(update) as [keyof TodoUpdate, TodoUpdate[keyof TodoUpdate]][])
    .filter(([, value]) => value !== undefined);
  if (!entries.length) {
    const todo = await getTodo(id);
    return todo ? { todo, undoToken: null } : null;
  }

  const db = database();
  const before = await db.prepare("SELECT * FROM todos WHERE id = ?").bind(id).first<TodoRow>();
  if (!before) return null;
  const undoToken = crypto.randomUUID();

  const values = entries.map(([, value]) => value);
  const setters = entries.map(([field]) => `${columnByField[field]} = ?`);
  if (update.status === "completed") {
    setters.push("completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')", "snoozed_until = NULL");
  } else if (update.status === "open") {
    setters.push("completed_at = NULL");
  }
  setters.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");

  const statements = [
    db.prepare("DELETE FROM todo_action_history WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')"),
    db.prepare("INSERT INTO todo_action_history (id, snapshot) VALUES (?, ?)")
      .bind(undoToken, JSON.stringify({ todos: [before] } satisfies UndoSnapshot)),
    ...(typeof update.project === "string" && update.project.trim()
      ? [db.prepare("INSERT OR IGNORE INTO todo_projects (name) VALUES (?)").bind(update.project.trim())]
      : []),
    db.prepare(`UPDATE todos SET ${setters.join(", ")} WHERE id = ?`).bind(...values, id),
  ];
  await db.batch(statements);
  const todo = await getTodo(id);
  if (!todo) throw new Error("The updated task could not be loaded.");
  console.info("[todo-db] task details updated", {
    id,
    fields: entries.map(([field]) => field),
    undoToken,
  });
  return { todo, undoToken };
}

export async function getTodo(id: number): Promise<Todo | null> {
  await ensureTodoDatabase();
  const row = await database().prepare(`
    SELECT todos.*,
      (SELECT COUNT(*) FROM todo_attachments
       WHERE todo_attachments.todo_id = todos.id
         AND todo_attachments.upload_state = 'ready'
         AND todo_attachments.deleted_at IS NULL) AS attachment_count
    FROM todos WHERE todos.id = ?
  `).bind(id).first<TodoRow>();
  return row ? mapTodo(row) : null;
}

function placeholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function normalizedIds(ids: number[]) {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (!unique.length) throw new Error("Choose at least one task.");
  if (unique.length > 200) throw new Error("Bulk actions are limited to 200 tasks at a time.");
  return unique;
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value])) as Record<string, string>;
}

function zonedDateToUtc(year: number, month: number, day: number, hour: number, timeZone: string) {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  const offsetAt = (timestamp: number) => {
    const values = zonedParts(new Date(timestamp), timeZone);
    return Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    ) - timestamp;
  };
  let result = guess - offsetAt(guess);
  result = guess - offsetAt(result);
  return new Date(result);
}

export async function getTodoSettings(): Promise<TodoSettings> {
  await ensureTodoDatabase();
  const result = await database()
    .prepare("SELECT key, value FROM app_settings WHERE key IN ('snooze_timezone', 'snooze_wake_hour')")
    .all<{ key: string; value: string }>();
  const values = Object.fromEntries(result.results.map((row) => [row.key, row.value]));
  return {
    snoozeTimeZone: values.snooze_timezone || "America/Toronto",
    snoozeWakeHour: Number(values.snooze_wake_hour ?? 8),
  };
}

export async function updateTodoSettings(settings: TodoSettings): Promise<TodoSettings> {
  await ensureTodoDatabase();
  const db = database();
  await db.batch([
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('snooze_timezone', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(settings.snoozeTimeZone),
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('snooze_wake_hour', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(String(settings.snoozeWakeHour)),
  ]);
  console.info("[todo-db] settings updated", settings);
  return settings;
}

export async function nextSnoozeUntil() {
  const settings = await getTodoSettings();
  const today = zonedParts(new Date(), settings.snoozeTimeZone);
  const nextDate = new Date(Date.UTC(
    Number(today.year),
    Number(today.month) - 1,
    Number(today.day) + 1,
  ));
  return zonedDateToUtc(
    nextDate.getUTCFullYear(),
    nextDate.getUTCMonth() + 1,
    nextDate.getUTCDate(),
    settings.snoozeWakeHour,
    settings.snoozeTimeZone,
  ).toISOString();
}

export async function bulkUpdateTodos(
  inputIds: number[],
  action: BulkTodoAction,
  options: { project?: string | null } = {},
) {
  await ensureTodoDatabase();
  const ids = normalizedIds(inputIds);
  const db = database();
  const inClause = placeholders(ids.length);
  const beforeResult = await db.prepare(`SELECT * FROM todos WHERE id IN (${inClause})`).bind(...ids).all<TodoRow>();
  const beforeById = new Map(beforeResult.results.map((row) => [row.id, row]));
  const before = ids.map((id) => beforeById.get(id)).filter((row): row is TodoRow => Boolean(row));
  if (!before.length) throw new Error("The selected tasks no longer exist.");
  const undoToken = crypto.randomUUID();
  const attachmentBefore = action === "delete" ? await attachmentSnapshotsForTodos(ids) : [];
  const project = typeof options.project === "string" ? options.project.trim() || null : null;
  if (project && project.length > 120) throw new Error("Project names are limited to 120 characters.");
  let sql: string;
  let values: Array<string | number | null> = ids;

  if (action === "complete") {
    sql = `UPDATE todos SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), snoozed_until = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (${inClause})`;
  } else if (action === "reproject") {
    sql = `UPDATE todos SET project = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (${inClause})`;
    values = [project, ...ids];
  } else if (action === "snooze") {
    const until = await nextSnoozeUntil();
    sql = `UPDATE todos SET status = 'open', completed_at = NULL, snoozed_until = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (${inClause})`;
    values = [until, ...ids];
  } else if (action === "unsnooze") {
    sql = `UPDATE todos SET status = 'open', completed_at = NULL, snoozed_until = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (${inClause})`;
  } else {
    sql = `DELETE FROM todos WHERE id IN (${inClause})`;
  }

  const statements = [
    db.prepare("DELETE FROM todo_action_history WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')"),
    db.prepare("INSERT INTO todo_action_history (id, snapshot) VALUES (?, ?)")
      .bind(undoToken, JSON.stringify({ todos: before, attachments: attachmentBefore } satisfies UndoSnapshot)),
    ...(project && action === "reproject"
      ? [db.prepare("INSERT OR IGNORE INTO todo_projects (name) VALUES (?)").bind(project)]
      : []),
    ...(action === "delete" ? [db.prepare(`
      UPDATE todo_attachments
      SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE todo_id IN (${inClause}) AND deleted_at IS NULL
    `).bind(...ids)] : []),
    db.prepare(sql).bind(...values),
  ];
  const results = await db.batch(statements);
  const result = results.at(-1)!;
  if (action === "delete") {
    console.info("[todo-db] bulk delete", { requested: ids.length, changed: result.meta.changes, attachments: attachmentBefore.length, undoToken });
    return { ids, todos: [], snoozedUntil: null, undoToken };
  }
  const updated = await db.prepare(`
    SELECT todos.*,
      (SELECT COUNT(*) FROM todo_attachments
       WHERE todo_attachments.todo_id = todos.id
         AND todo_attachments.upload_state = 'ready'
         AND todo_attachments.deleted_at IS NULL) AS attachment_count
    FROM todos WHERE todos.id IN (${inClause})
  `).bind(...ids).all<TodoRow>();
  const todos = updated.results.map(mapTodo);
  console.info("[todo-db] bulk action", {
    action,
    requested: ids.length,
    changed: result.meta.changes,
    project: action === "reproject" ? project : undefined,
    snoozedUntil: action === "snooze" ? todos[0]?.snoozedUntil : null,
    undoToken,
  });
  return { ids, todos, snoozedUntil: action === "snooze" ? todos[0]?.snoozedUntil ?? null : null, undoToken };
}

export async function mergeTodos(inputIds: number[]) {
  await ensureTodoDatabase();
  const ids = normalizedIds(inputIds);
  if (ids.length < 2) throw new Error("Choose at least two tasks to merge.");
  const db = database();
  const inClause = placeholders(ids.length);
  const result = await db.prepare(`SELECT * FROM todos WHERE id IN (${inClause})`).bind(...ids).all<TodoRow>();
  const byId = new Map(result.results.map((row) => [row.id, row]));
  const rows = ids.map((id) => byId.get(id)).filter((row): row is TodoRow => Boolean(row));
  if (rows.length < 2) throw new Error("At least two selected tasks must still exist.");
  const attachmentBefore = await attachmentSnapshotsForTodos(ids);

  const shared = (field: "project" | "context") => {
    const first = rows[0][field];
    return rows.every((row) => row[field] === first) ? first : null;
  };
  const dueDates = rows.map((row) => row.due_date).filter((value): value is string => Boolean(value)).sort();
  const undoToken = crypto.randomUUID();
  const createdSourceKind = `merge:${undoToken}`;
  const mergedNotes = [
    `Merged from ${rows.length} tasks:`,
    "",
    ...rows.flatMap((row) => [
      `• ${row.title}`,
      ...(row.notes ? row.notes.split("\n").map((line) => `  ${line}`) : []),
      "",
    ]),
  ].join("\n").trim();

  const inserted = await db.prepare(`
      INSERT INTO todos (title, notes, status, priority, due_date, project, context, source_kind)
      VALUES (?, ?, 'open', ?, ?, ?, ?, ?)
      RETURNING *
    `).bind(
      rows[0].title,
      mergedNotes,
      Math.min(...rows.map((row) => row.priority)),
      dueDates[0] ?? null,
      shared("project"),
      shared("context"),
      createdSourceKind,
    ).first<TodoRow>();
  if (!inserted) throw new Error("The merged task could not be created.");
  try {
    await db.batch([
      db.prepare("DELETE FROM todo_action_history WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')"),
      db.prepare("INSERT INTO todo_action_history (id, snapshot) VALUES (?, ?)")
        .bind(undoToken, JSON.stringify({ todos: rows, attachments: attachmentBefore, createdSourceKind } satisfies UndoSnapshot)),
      ...attachmentBefore.map((attachment, sortOrder) => db.prepare(`
        UPDATE todo_attachments
        SET todo_id = ?, sort_order = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND deleted_at IS NULL
      `).bind(inserted.id, sortOrder, attachment.id)),
      db.prepare(`DELETE FROM todos WHERE id IN (${inClause})`).bind(...ids),
    ]);
  } catch (error) {
    await db.prepare("DELETE FROM todos WHERE id = ?").bind(inserted.id).run();
    console.error("[todo-db] merge failed after insert", { sourceIds: ids, mergedId: inserted.id, error });
    throw error;
  }
  console.info("[todo-db] merged", {
    sourceIds: ids,
    mergedId: inserted.id,
    sourceCount: rows.length,
    attachmentsMoved: attachmentBefore.length,
    undoToken,
  });
  return { todo: mapTodo({ ...inserted, attachment_count: attachmentBefore.length }), ids, undoToken };
}

export async function undoTodoAction(undoToken: string) {
  await ensureTodoDatabase();
  if (!/^[0-9a-f-]{36}$/i.test(undoToken)) throw new Error("That undo action is invalid.");
  const db = database();
  const history = await db
    .prepare("SELECT snapshot FROM todo_action_history WHERE id = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')")
    .bind(undoToken)
    .first<{ snapshot: string }>();
  if (!history) throw new Error("That undo action has expired or was already used.");

  const snapshot = JSON.parse(history.snapshot) as UndoSnapshot;
  const attachmentSnapshot = Array.isArray(snapshot.attachments) ? snapshot.attachments : [];
  if (!Array.isArray(snapshot.todos) || snapshot.todos.length > 200 || attachmentSnapshot.length > 2_400 || (!snapshot.todos.length && !attachmentSnapshot.length)) {
    throw new Error("That undo action could not be restored safely.");
  }
  const restore = db.prepare(`
    INSERT INTO todos (
      id, title, notes, status, priority, due_date, project, context,
      source_kind, source_id, client_id, completed_at, snoozed_until, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      notes = excluded.notes,
      status = excluded.status,
      priority = excluded.priority,
      due_date = excluded.due_date,
      project = excluded.project,
      context = excluded.context,
      source_kind = excluded.source_kind,
      source_id = excluded.source_id,
      client_id = excluded.client_id,
      completed_at = excluded.completed_at,
      snoozed_until = excluded.snoozed_until,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `);
  const normalizedTodos = snapshot.todos.map((row) => row.status === "archived"
    ? { ...row, status: "open" as const, completed_at: null, snoozed_until: null }
    : row);
  const statements = [
    ...(snapshot.createdSourceKind
      ? [
        db.prepare(`
          UPDATE todo_attachments
          SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE todo_id IN (SELECT id FROM todos WHERE source_kind = ?) AND deleted_at IS NULL
        `).bind(snapshot.createdSourceKind),
        db.prepare("DELETE FROM todos WHERE source_kind = ?").bind(snapshot.createdSourceKind),
      ]
      : []),
    ...[...new Set(normalizedTodos.map((row) => row.project).filter((project): project is string => Boolean(project?.trim())))]
      .map((project) => db.prepare("INSERT OR IGNORE INTO todo_projects (name) VALUES (?)").bind(project)),
    ...normalizedTodos.map((row) => restore.bind(
      row.id,
      row.title,
      row.notes,
      row.status,
      row.priority,
      row.due_date,
      row.project,
      row.context,
      row.source_kind,
      row.source_id,
      row.client_id ?? null,
      row.completed_at,
      row.snoozed_until,
      row.created_at,
      row.updated_at,
    )),
    ...restoreAttachmentStatements(db, attachmentSnapshot),
    db.prepare("DELETE FROM todo_action_history WHERE id = ?").bind(undoToken),
  ];
  await db.batch(statements);
  const todos = await listTodos();
  console.info("[todo-db] action undone", {
    undoToken,
    restored: normalizedTodos.length,
    restoredAttachments: attachmentSnapshot.length,
    removedCreatedTask: Boolean(snapshot.createdSourceKind),
    normalizedLegacyArchives: snapshot.todos.filter((row) => row.status === "archived").length,
  });
  return { todos, restored: normalizedTodos.length, restoredAttachments: attachmentSnapshot.length };
}

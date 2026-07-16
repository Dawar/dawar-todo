import { env } from "cloudflare:workers";
import { importedTodos } from "./imported-todos";

export type TodoStatus = "open" | "completed" | "archived";

type TodoRow = {
  id: number;
  title: string;
  notes: string;
  status: TodoStatus;
  priority: number;
  due_date: string | null;
  project: string | null;
  context: string | null;
  source_kind: string | null;
  source_id: number | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
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
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TodoUpdate = Partial<
  Pick<Todo, "title" | "notes" | "status" | "priority" | "dueDate" | "project" | "context">
>;

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
    status: row.status,
    priority: row.priority,
    dueDate: row.due_date,
    project: row.project,
    context: row.context,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
          completed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
      db.prepare("CREATE INDEX IF NOT EXISTS todos_status_idx ON todos(status)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todos_project_idx ON todos(project)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todos_due_date_idx ON todos(due_date)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS todos_source_idx ON todos(source_kind, source_id)"),
    ]);

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
    const inserted = results.reduce((total, result) => total + Number(result.meta.changes ?? 0), 0);
    const total = await db.prepare("SELECT COUNT(*) AS count FROM todos").first<{ count: number }>();
    console.info("[todo-db] ready", { inserted, total: total?.count ?? 0, imported: importedTodos.length });
  })().catch((error) => {
    initialization = null;
    throw error;
  });

  return initialization;
}

export async function listTodos(): Promise<Todo[]> {
  await ensureTodoDatabase();
  const result = await database()
    .prepare("SELECT * FROM todos ORDER BY updated_at DESC, id DESC")
    .all<TodoRow>();
  return result.results.map(mapTodo);
}

export async function createTodo(input: {
  title: string;
  notes?: string;
  priority?: number;
  dueDate?: string | null;
  project?: string | null;
  context?: string | null;
}): Promise<Todo> {
  await ensureTodoDatabase();
  const row = await database()
    .prepare(`
      INSERT INTO todos (title, notes, priority, due_date, project, context, source_kind)
      VALUES (?, ?, ?, ?, ?, ?, 'site')
      RETURNING *
    `)
    .bind(
      input.title,
      input.notes ?? "",
      input.priority ?? 3,
      input.dueDate ?? null,
      input.project ?? null,
      input.context ?? null,
    )
    .first<TodoRow>();
  if (!row) throw new Error("The task could not be created.");
  return mapTodo(row);
}

export async function updateTodo(id: number, update: TodoUpdate): Promise<Todo | null> {
  await ensureTodoDatabase();
  const columnByField: Record<keyof TodoUpdate, string> = {
    title: "title",
    notes: "notes",
    status: "status",
    priority: "priority",
    dueDate: "due_date",
    project: "project",
    context: "context",
  };
  const entries = (Object.entries(update) as [keyof TodoUpdate, TodoUpdate[keyof TodoUpdate]][])
    .filter(([, value]) => value !== undefined);
  if (!entries.length) return getTodo(id);

  const values = entries.map(([, value]) => value);
  const setters = entries.map(([field]) => `${columnByField[field]} = ?`);
  if (update.status === "completed") {
    setters.push("completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  } else if (update.status === "open") {
    setters.push("completed_at = NULL");
  }
  setters.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");

  const row = await database()
    .prepare(`UPDATE todos SET ${setters.join(", ")} WHERE id = ? RETURNING *`)
    .bind(...values, id)
    .first<TodoRow>();
  return row ? mapTodo(row) : null;
}

export async function getTodo(id: number): Promise<Todo | null> {
  await ensureTodoDatabase();
  const row = await database().prepare("SELECT * FROM todos WHERE id = ?").bind(id).first<TodoRow>();
  return row ? mapTodo(row) : null;
}

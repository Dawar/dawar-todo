import { env } from "cloudflare:workers";
import { ensureTodoDatabase } from "./todos";

const CALENDAR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CALENDAR_FEED_LIMIT = 20;

type CalendarFeedRow = {
  id: string;
  name: string;
  token: string;
  created_at: string;
  updated_at: string;
};

export type CalendarFeed = {
  id: string;
  name: string;
  token: string;
  path: string;
  createdAt: string;
  updatedAt: string;
};

export type CalendarTodo = {
  id: number;
  title: string;
  notes: string;
  status: "open" | "completed";
  priority: number;
  dueDate: string;
  project: string | null;
  context: string | null;
  createdAt: string;
  updatedAt: string;
};

type CalendarTodoRow = {
  id: number;
  title: string;
  notes: string;
  status: "open" | "completed" | "archived";
  priority: number;
  due_date: string;
  project: string | null;
  context: string | null;
  created_at: string;
  updated_at: string;
};

function database() {
  if (!env.DB) throw new Error("The todo database is unavailable.");
  return env.DB;
}

function calendarPath(token: string) {
  return `/calendar/${token}.ics`;
}

function mapFeed(row: CalendarFeedRow): CalendarFeed {
  return {
    id: row.id,
    name: row.name,
    token: row.token,
    path: calendarPath(row.token),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function normalizedFeedName(value: string) {
  const name = value.trim();
  if (!name) throw new Error("A calendar name is required.");
  if (name.length > 80) throw new Error("Calendar names are limited to 80 characters.");
  return name;
}

export async function listCalendarFeeds(): Promise<CalendarFeed[]> {
  await ensureTodoDatabase();
  const result = await database().prepare(`
    SELECT id, name, token, created_at, updated_at
    FROM todo_calendar_feeds
    WHERE revoked_at IS NULL
    ORDER BY created_at DESC
  `).all<CalendarFeedRow>();
  return result.results.map(mapFeed);
}

export async function createCalendarFeed(inputName: string): Promise<CalendarFeed> {
  await ensureTodoDatabase();
  const name = normalizedFeedName(inputName);
  const db = database();
  const active = await db.prepare("SELECT COUNT(*) AS count FROM todo_calendar_feeds WHERE revoked_at IS NULL").first<{ count: number }>();
  if (Number(active?.count ?? 0) >= CALENDAR_FEED_LIMIT) throw new Error(`You can keep up to ${CALENDAR_FEED_LIMIT} active calendar links.`);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const id = crypto.randomUUID();
    const token = randomToken();
    try {
      const row = await db.prepare(`
        INSERT INTO todo_calendar_feeds (id, name, token)
        VALUES (?, ?, ?)
        RETURNING id, name, token, created_at, updated_at
      `).bind(id, name, token).first<CalendarFeedRow>();
      if (!row) throw new Error("The calendar link could not be created.");
      console.info("[todo-db] calendar feed created", { id, nameLength: name.length, attempt });
      return mapFeed(row);
    } catch (error) {
      if (attempt === 3) throw error;
      console.warn("[todo-db] calendar token collision; retrying", { attempt });
    }
  }
  throw new Error("The calendar link could not be created.");
}

export async function regenerateCalendarFeed(id: string): Promise<CalendarFeed | null> {
  await ensureTodoDatabase();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("That calendar link is invalid.");
  const db = database();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const token = randomToken();
    try {
      const row = await db.prepare(`
        UPDATE todo_calendar_feeds
        SET token = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND revoked_at IS NULL
        RETURNING id, name, token, created_at, updated_at
      `).bind(token, id).first<CalendarFeedRow>();
      if (!row) return null;
      console.info("[todo-db] calendar feed regenerated", { id, attempt });
      return mapFeed(row);
    } catch (error) {
      if (attempt === 3) throw error;
      console.warn("[todo-db] regenerated calendar token collision; retrying", { id, attempt });
    }
  }
  return null;
}

export async function revokeCalendarFeed(id: string): Promise<boolean> {
  await ensureTodoDatabase();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("That calendar link is invalid.");
  const result = await database().prepare(`
    UPDATE todo_calendar_feeds
    SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND revoked_at IS NULL
  `).bind(id).run();
  const revoked = Number(result.meta.changes ?? 0) > 0;
  console.info("[todo-db] calendar feed revoked", { id, revoked });
  return revoked;
}

export async function findCalendarFeedByToken(token: string): Promise<CalendarFeed | null> {
  await ensureTodoDatabase();
  if (!CALENDAR_TOKEN_PATTERN.test(token)) return null;
  const row = await database().prepare(`
    SELECT id, name, token, created_at, updated_at
    FROM todo_calendar_feeds
    WHERE token = ? AND revoked_at IS NULL
  `).bind(token).first<CalendarFeedRow>();
  return row ? mapFeed(row) : null;
}

export async function listDatedCalendarTodos(): Promise<CalendarTodo[]> {
  await ensureTodoDatabase();
  const result = await database().prepare(`
    SELECT id, title, notes, status, priority, due_date, project, context, created_at, updated_at
    FROM todos
    WHERE due_date IS NOT NULL AND trim(due_date) <> ''
    ORDER BY due_date ASC, id ASC
  `).all<CalendarTodoRow>();
  return result.results.map((row) => ({
    id: row.id,
    title: row.title,
    notes: row.notes,
    status: row.status === "completed" ? "completed" : "open",
    priority: row.priority,
    dueDate: row.due_date,
    project: row.project,
    context: row.context,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

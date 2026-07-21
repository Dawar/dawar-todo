import { cronMatchesDate } from "../lib/cron.ts";

type RecurringTodoRow = {
  id: number;
  status: "open" | "completed" | "archived";
  recurrence_cron: string;
  recurrence_last_fired_at: string | null;
};

async function ensureRecurringColumns(db: D1Database) {
  const columns = await db.prepare("PRAGMA table_info(todos)").all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "recurrence_cron")) {
    await db.prepare("ALTER TABLE todos ADD COLUMN recurrence_cron TEXT").run();
    console.info("[todo-recurring] added recurrence_cron compatibility column");
  }
  if (!columns.results.some((column) => column.name === "recurrence_last_fired_at")) {
    await db.prepare("ALTER TABLE todos ADD COLUMN recurrence_last_fired_at TEXT").run();
    console.info("[todo-recurring] added recurrence_last_fired_at compatibility column");
  }
  await db.prepare("CREATE INDEX IF NOT EXISTS todos_recurrence_cron_idx ON todos(recurrence_cron)").run();
}

export async function processRecurringTodos(db: D1Database, scheduledAt = new Date()) {
  const startedAt = Date.now();
  const firedAt = new Date(Math.floor(scheduledAt.valueOf() / 60_000) * 60_000).toISOString();

  try {
    await ensureRecurringColumns(db);
    const setting = await db
      .prepare("SELECT value FROM app_settings WHERE key = 'snooze_timezone'")
      .first<{ value: string }>();
    const timeZone = setting?.value || "America/Toronto";
    const result = await db.prepare(`
      SELECT id, status, recurrence_cron, recurrence_last_fired_at
      FROM todos
      WHERE recurrence_cron IS NOT NULL AND trim(recurrence_cron) <> ''
      ORDER BY id
    `).all<RecurringTodoRow>();

    const due: RecurringTodoRow[] = [];
    let invalid = 0;
    let alreadyFired = 0;
    for (const todo of result.results) {
      if (todo.recurrence_last_fired_at && todo.recurrence_last_fired_at >= firedAt) {
        alreadyFired += 1;
        continue;
      }
      try {
        if (cronMatchesDate(todo.recurrence_cron, scheduledAt, timeZone)) due.push(todo);
      } catch (error) {
        invalid += 1;
        console.error("[todo-recurring] invalid stored schedule skipped", {
          id: todo.id,
          expression: todo.recurrence_cron,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const updates = due.map((todo) => db.prepare(`
      UPDATE todos
      SET status = CASE WHEN status = 'completed' THEN 'open' ELSE status END,
          completed_at = CASE WHEN status = 'completed' THEN NULL ELSE completed_at END,
          snoozed_until = NULL,
          recurrence_last_fired_at = ?,
          updated_at = CASE WHEN status = 'completed' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE updated_at END
      WHERE id = ?
        AND recurrence_cron = ?
        AND (recurrence_last_fired_at IS NULL OR recurrence_last_fired_at < ?)
    `).bind(firedAt, todo.id, todo.recurrence_cron, firedAt));
    const updateResults = updates.length ? await db.batch(updates) : [];
    const changed = updateResults.reduce((total, update) => total + Number(update.meta.changes ?? 0), 0);
    const reopened = due.reduce((total, todo, index) => (
      total + (todo.status === "completed" && Number(updateResults[index]?.meta.changes ?? 0) > 0 ? 1 : 0)
    ), 0);

    console.info("[todo-recurring] interval processed", {
      scheduledAt: scheduledAt.toISOString(),
      firedAt,
      timeZone,
      checked: result.results.length,
      due: due.length,
      changed,
      reopened,
      alreadyOpen: Math.max(0, changed - reopened),
      alreadyFired,
      invalid,
      durationMs: Date.now() - startedAt,
    });
    return { checked: result.results.length, due: due.length, changed, reopened, alreadyFired, invalid, firedAt, timeZone };
  } catch (error) {
    console.error("[todo-recurring] interval failed", {
      scheduledAt: scheduledAt.toISOString(),
      firedAt,
      durationMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }
}

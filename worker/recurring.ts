import { cronMatchesDate, latestCronOccurrence } from "../lib/cron.ts";
import { queueTodoPushEvent } from "../db/push-notifications.ts";

type RecurringTodoRow = {
  id: number;
  title: string;
  status: "open" | "completed" | "archived";
  recurrence_cron: string;
  recurrence_last_fired_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type RecurrenceSource = "scheduled" | "todo-list-sync";

type RecurrenceOptions = {
  catchUp?: boolean;
  source?: RecurrenceSource;
};

export async function processRecurringTodos(
  db: D1Database,
  scheduledAt = new Date(),
  options: RecurrenceOptions = {},
) {
  const startedAt = Date.now();
  const firedAt = new Date(Math.floor(scheduledAt.valueOf() / 60_000) * 60_000).toISOString();
  const source = options.source ?? "scheduled";

  try {
    if (options.catchUp) {
      const guard = await db.prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES ('recurrence_sync_minute', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
        WHERE app_settings.value < excluded.value
      `).bind(firedAt).run();
      if (!Number(guard.meta.changes ?? 0)) {
        return { checked: 0, due: 0, changed: 0, reopened: 0, alreadyFired: 0, invalid: 0, firedAt, timeZone: null, skipped: true };
      }
    }
    const setting = await db
      .prepare("SELECT value FROM app_settings WHERE key = 'snooze_timezone'")
      .first<{ value: string }>();
    const timeZone = setting?.value || "America/Toronto";
    const result = await db.prepare(`
      SELECT id, title, status, recurrence_cron, recurrence_last_fired_at, completed_at, created_at, updated_at
      FROM todos
      WHERE recurrence_cron IS NOT NULL AND trim(recurrence_cron) <> ''
      ORDER BY id
    `).all<RecurringTodoRow>();

    const due: Array<{ todo: RecurringTodoRow; occurrence: string }> = [];
    let invalid = 0;
    let alreadyFired = 0;
    for (const todo of result.results) {
      try {
        if (options.catchUp) {
          const anchorValues = [
            todo.recurrence_last_fired_at,
            todo.status === "completed" ? todo.completed_at : null,
            todo.recurrence_last_fired_at ? null : todo.updated_at || todo.created_at,
          ].filter((value): value is string => Boolean(value));
          const anchor = anchorValues.length
            ? new Date(Math.max(...anchorValues.map((value) => new Date(value).valueOf())))
            : null;
          const occurrence = latestCronOccurrence(todo.recurrence_cron, scheduledAt, timeZone, anchor);
          if (occurrence) due.push({ todo, occurrence: occurrence.toISOString() });
          else if (todo.recurrence_last_fired_at && todo.recurrence_last_fired_at >= firedAt) alreadyFired += 1;
        } else {
          if (todo.recurrence_last_fired_at && todo.recurrence_last_fired_at >= firedAt) {
            alreadyFired += 1;
            continue;
          }
          if (cronMatchesDate(todo.recurrence_cron, scheduledAt, timeZone)) due.push({ todo, occurrence: firedAt });
        }
      } catch (error) {
        invalid += 1;
        console.error("[todo-recurring] invalid stored schedule skipped", {
          id: todo.id,
          expression: todo.recurrence_cron,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const updates = due.map(({ todo, occurrence }) => db.prepare(`
      UPDATE todos
      SET status = CASE WHEN status = 'completed' THEN 'open' ELSE status END,
          completed_at = CASE WHEN status = 'completed' THEN NULL ELSE completed_at END,
          snoozed_until = NULL,
          recurrence_last_fired_at = ?,
          updated_at = CASE WHEN status = 'completed' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE updated_at END
      WHERE id = ?
        AND recurrence_cron = ?
        AND (recurrence_last_fired_at IS NULL OR recurrence_last_fired_at < ?)
        AND (status <> 'completed' OR completed_at IS NULL OR completed_at < ?)
    `).bind(occurrence, todo.id, todo.recurrence_cron, occurrence, occurrence));
    const updateResults = updates.length ? await db.batch(updates) : [];
    const changed = updateResults.reduce((total, update) => total + Number(update.meta.changes ?? 0), 0);
    const reopened = due.reduce((total, { todo }, index) => (
      total + (todo.status === "completed" && Number(updateResults[index]?.meta.changes ?? 0) > 0 ? 1 : 0)
    ), 0);
    const reopenedEvents = due.filter(({ todo }, index) => (
      todo.status === "completed" && Number(updateResults[index]?.meta.changes ?? 0) > 0
    ));
    let pushEventsQueued = 0;
    for (const { todo, occurrence } of reopenedEvents) {
      try {
        const queued = await queueTodoPushEvent(db, {
          type: "recurrence_reopened",
          todoId: todo.id,
          title: todo.title || "Recurring task",
          eventId: `recurrence:${todo.id}:${occurrence}`,
          createdAt: scheduledAt,
        });
        if (queued) pushEventsQueued += 1;
      } catch (error) {
        console.error("[todo-push] recurring task notification could not be queued", {
          todoId: todo.id,
          occurrence,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    console.info("[todo-recurring] interval processed", {
      scheduledAt: scheduledAt.toISOString(),
      firedAt,
      source,
      catchUp: Boolean(options.catchUp),
      timeZone,
      checked: result.results.length,
      due: due.length,
      changed,
      reopened,
      alreadyOpen: Math.max(0, changed - reopened),
      alreadyFired,
      invalid,
      pushEventsQueued,
      durationMs: Date.now() - startedAt,
    });
    return { checked: result.results.length, due: due.length, changed, reopened, alreadyFired, invalid, firedAt, timeZone, pushEventsQueued };
  } catch (error) {
    console.error("[todo-recurring] interval failed", {
      scheduledAt: scheduledAt.toISOString(),
      firedAt,
      source,
      catchUp: Boolean(options.catchUp),
      durationMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }
}

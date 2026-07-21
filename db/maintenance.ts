import { env, waitUntil } from "cloudflare:workers";
import { processRecurringTodos } from "../worker/recurring";
import { scheduleAttachmentCleanup } from "./attachments";
import { ensureTodoDatabase } from "./todos";

let lastRecurrenceAttemptMinute = "";

export async function runTodoReadMaintenance(source: "bootstrap" | "sync" | "legacy-list") {
  await ensureTodoDatabase();
  const startedAt = Date.now();
  const now = new Date();
  const recurrenceMinute = new Date(Math.floor(now.valueOf() / 60_000) * 60_000).toISOString();
  const shouldCheckRecurrence = recurrenceMinute !== lastRecurrenceAttemptMinute;
  if (shouldCheckRecurrence) lastRecurrenceAttemptMinute = recurrenceMinute;

  if (source === "sync") {
    if (shouldCheckRecurrence) {
      waitUntil(processRecurringTodos(env.DB, now, { catchUp: true, source: "todo-list-sync" }).catch((error) => {
        console.error("[todo-maintenance] background recurrence check failed", {
          recurrenceMinute,
          error,
        });
      }));
      console.info("[todo-maintenance] background recurrence check scheduled", {
        source,
        recurrenceMinute,
        durationMs: Date.now() - startedAt,
      });
    }
    return null;
  }

  const [recurrence] = await Promise.all([
    shouldCheckRecurrence
      ? processRecurringTodos(env.DB, now, { catchUp: true, source: "todo-list-sync" })
      : Promise.resolve(null),
    scheduleAttachmentCleanup(),
  ]);
  if (shouldCheckRecurrence || source !== "sync") {
    console.info("[todo-maintenance] read maintenance checked", {
      source,
      recurrenceMinute,
      recurrenceSkippedInIsolate: !shouldCheckRecurrence,
      recurringReopened: recurrence?.reopened ?? 0,
      durationMs: Date.now() - startedAt,
    });
  }
  return recurrence;
}

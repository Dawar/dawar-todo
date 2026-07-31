import { env, waitUntil } from "cloudflare:workers";
import { processRecurringTodos } from "../worker/recurring";
import { scheduleAttachmentCleanup } from "./attachments";
import { dispatchTodoPushNotifications } from "./push-notifications";
import { ensureTodoDatabase, wakeExpiredSnoozedTodos } from "./todos";

let lastRecurrenceAttemptMinute = "";
let lastPushDispatchAttemptMinute = "";

export async function runTodoReadMaintenance(source: "bootstrap" | "sync" | "legacy-list") {
  await ensureTodoDatabase();
  const startedAt = Date.now();
  const now = new Date();
  const recurrenceMinute = new Date(Math.floor(now.valueOf() / 60_000) * 60_000).toISOString();
  const shouldCheckRecurrence = recurrenceMinute !== lastRecurrenceAttemptMinute;
  const shouldDispatchPush = recurrenceMinute !== lastPushDispatchAttemptMinute;
  if (shouldCheckRecurrence) lastRecurrenceAttemptMinute = recurrenceMinute;
  if (shouldDispatchPush) lastPushDispatchAttemptMinute = recurrenceMinute;
  const wokenSnoozeIds = await wakeExpiredSnoozedTodos(now);

  if (source === "sync") {
    if (shouldDispatchPush) {
      waitUntil(dispatchTodoPushNotifications(env.DB, env, now).catch((error) => {
        console.error("[todo-maintenance] background push dispatch failed", {
          recurrenceMinute,
          error,
        });
      }));
    }
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
        snoozedWoken: wokenSnoozeIds.length,
        pushDispatchScheduled: shouldDispatchPush,
        durationMs: Date.now() - startedAt,
      });
    } else if (wokenSnoozeIds.length) {
      console.info("[todo-maintenance] expired snoozes reconciled", {
        source,
        recurrenceMinute,
        snoozedWoken: wokenSnoozeIds.length,
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
      snoozedWoken: wokenSnoozeIds.length,
      pushDispatchScheduled: shouldDispatchPush,
      durationMs: Date.now() - startedAt,
    });
  }
  return recurrence;
}

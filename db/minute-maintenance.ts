import { dispatchTodoPushNotifications, type PushEnvironment } from "./push-notifications";
import {
  ensureTodoDatabase,
  wakeExpiredSnoozedTodosInDatabase,
} from "./todos";
import {
  cleanupTalkPhoneRecordingSources,
  processTalkPhoneRecordingQueue,
} from "./talk-phone-recordings";
import { processRecurringTodos } from "../worker/recurring";

export type MinuteMaintenanceEnvironment = PushEnvironment & {
  DB: D1Database;
};

export async function runTodoMinuteMaintenance(
  environment: MinuteMaintenanceEnvironment,
  scheduledAt = new Date(),
  source = "scheduled",
) {
  const startedAt = Date.now();
  await ensureTodoDatabase();

  const result = {
    recurring: null as Awaited<ReturnType<typeof processRecurringTodos>> | null,
    snoozedWoken: 0,
    push: null as Awaited<ReturnType<typeof dispatchTodoPushNotifications>> | null,
    recordings: null as Awaited<ReturnType<typeof processTalkPhoneRecordingQueue>> | null,
    recordingCleanupCompleted: false,
  };

  try {
    result.recurring = await processRecurringTodos(environment.DB, scheduledAt, {
      source: "scheduled",
    });
  } catch (error) {
    console.error("[todo-maintenance] recurring processing failed", { source, error });
  }

  try {
    const wokenIds = await wakeExpiredSnoozedTodosInDatabase(environment.DB, scheduledAt);
    result.snoozedWoken = wokenIds.length;
  } catch (error) {
    console.error("[todo-maintenance] snooze wake failed", { source, error });
  }

  try {
    result.recordings = await processTalkPhoneRecordingQueue(scheduledAt);
  } catch (error) {
    console.error("[todo-maintenance] phone recording processing failed", { source, error });
  }

  try {
    result.push = await dispatchTodoPushNotifications(environment.DB, environment, scheduledAt);
  } catch (error) {
    console.error("[todo-maintenance] push dispatch failed", { source, error });
  }

  try {
    await cleanupTalkPhoneRecordingSources();
    result.recordingCleanupCompleted = true;
  } catch (error) {
    console.error("[todo-maintenance] phone recording cleanup failed", { source, error });
  }

  console.info("[todo-maintenance] minute completed", {
    source,
    scheduledAt: scheduledAt.toISOString(),
    snoozedWoken: result.snoozedWoken,
    pushEvents: result.push?.events ?? 0,
    pushSent: result.push?.sent ?? 0,
    durationMs: Date.now() - startedAt,
  });
  return result;
}

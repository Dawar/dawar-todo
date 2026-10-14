import type { OfflineTaskAction, OfflineTodoMutation, QueuedAttachment } from "./offline-store";

export function taskActionRetryDelay(actions: OfflineTaskAction[], mutations: OfflineTodoMutation[], now: number) {
  const blocked = new Set(mutations.filter((mutation) => mutation.rejected).map((mutation) => mutation.todoId));
  let delay = Infinity;
  for (const action of actions) {
    if (action.taskIds.some((id) => blocked.has(id))) {
      action.taskIds.forEach((id) => blocked.add(id)); continue;
    }
    const due = Date.parse(action.nextAttemptAt) - now;
    delay = Math.min(delay, Math.max(500, due));
    if (due > 0) action.taskIds.forEach((id) => blocked.add(id));
  }
  return delay;
}
export function uploadWaitingForTaskAction(upload: QueuedAttachment, actions: OfflineTaskAction[]) {
  return actions.some((action) => action.taskIds.includes(upload.todoId)
    && (action.body.action === "merge" || (!action.undoRequested && action.optimisticDeletedIds?.includes(upload.todoId))));
}

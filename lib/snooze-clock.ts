export type SnoozeClockTodo = {
  id: number;
  status: "open" | "completed";
  snoozedUntil: string | null;
};

export function snoozeWakeTime(value: string | null) {
  if (!value) return null;
  const wakeAt = new Date(value).valueOf();
  return Number.isFinite(wakeAt) ? wakeAt : null;
}

export function isActivelySnoozed(todo: Pick<SnoozeClockTodo, "status" | "snoozedUntil">, now: number) {
  const wakeAt = snoozeWakeTime(todo.snoozedUntil);
  return todo.status === "open" && wakeAt !== null && wakeAt > now;
}

export function nextSnoozeWakeAt(todos: readonly SnoozeClockTodo[], now: number) {
  let nextWakeAt: number | null = null;
  for (const todo of todos) {
    if (todo.status !== "open") continue;
    const wakeAt = snoozeWakeTime(todo.snoozedUntil);
    if (wakeAt === null || wakeAt <= now) continue;
    if (nextWakeAt === null || wakeAt < nextWakeAt) nextWakeAt = wakeAt;
  }
  return nextWakeAt;
}

export function expiredSnoozeIds(todos: readonly SnoozeClockTodo[], now: number) {
  return todos.flatMap((todo) => {
    if (todo.status !== "open") return [];
    const wakeAt = snoozeWakeTime(todo.snoozedUntil);
    return wakeAt !== null && wakeAt <= now ? [todo.id] : [];
  });
}

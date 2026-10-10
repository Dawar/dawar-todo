"use client";

// React mounts many rows in one commit. Writing and measuring each row inside
// its layout effect forced a full layout per title. Batch writes, then reads,
// then writes in one microtask before paint; keep every row mounted/focusable.
const pending = new Set<HTMLTextAreaElement>();
let scheduled = false;
export function scheduleTitleSize(element: HTMLTextAreaElement | null) {
  if (!element) return;
  pending.add(element);
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const elements = [...pending].filter((entry) => entry.isConnected);
    pending.clear();
    for (const entry of elements) entry.style.height = "auto";
    const heights = elements.map((entry) => entry.scrollHeight);
    elements.forEach((entry, index) => { entry.style.height = `${heights[index]}px`; });
  });
}

/** Rows with no time-sensitive badge/action need no minute-clock render. */
export function taskRowClock(todo: { snoozedUntil: string | null; recurrenceCron: string | null; dueDate: string | null }, now: number) {
  if (todo.snoozedUntil || todo.recurrenceCron) return now;
  // Due highlighting changes at local midnight, not every minute.
  if (todo.dueDate) { const day = new Date(now); day.setHours(0, 0, 0, 0); return day.valueOf(); }
  return 0;
}

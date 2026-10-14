"use client";

// React mounts many rows in one commit. Writing and measuring each row inside
// its layout effect forced a full layout per title. Batch writes, then reads,
// then writes in one microtask before paint; keep every row mounted/focusable.
const pending = new Set<HTMLTextAreaElement>();
let scheduled = false;
const observedWidths = new Map<HTMLTextAreaElement, number>();
let widthObserver: ResizeObserver | null = null;
let resizeFrame: number | null = null;
const resizedTitles = new Set<HTMLTextAreaElement>();

/** One observer for all mounted rows; height-only changes never reschedule. */
export function observeTitleSize(element: HTMLTextAreaElement | null) {
  if (!element || typeof ResizeObserver === "undefined") return;
  if (!widthObserver) widthObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const target = entry.target as HTMLTextAreaElement;
      if (!observedWidths.has(target) || observedWidths.get(target) === entry.contentRect.width) continue;
      observedWidths.set(target, entry.contentRect.width);
      resizedTitles.add(target);
    }
    if (resizedTitles.size && resizeFrame === null) resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      for (const target of resizedTitles) if (observedWidths.has(target)) scheduleTitleSize(target);
      resizedTitles.clear();
    });
  });
  observedWidths.set(element, element.clientWidth);
  widthObserver.observe(element);
  return () => {
    observedWidths.delete(element);
    resizedTitles.delete(element);
    widthObserver?.unobserve(element);
    if (!observedWidths.size) {
      widthObserver?.disconnect();
      widthObserver = null;
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = null;
    }
  };
}

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

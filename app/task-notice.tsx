"use client";

import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ActionIcon } from "./action-icon";
import { quickSnoozeLabel, type QuickSnoozePreset } from "../lib/snooze-presets";

export type TaskNoticeState = {
  tone: "success" | "error";
  text: string;
  taskPreview?: string;
  operationId?: string;
  pendingUndo?: boolean;
  undoRequested?: boolean;
  undoToken?: string;
  snoozeIds?: number[];
  snoozedUntil?: string;
  dismissAt?: number;
};

export function TaskNotice({ notice, bulkActionsVisible, undoing, adjusting, paused = false, presets, onUndo, onDismiss, onSnooze, onCustomSnooze }: {
  notice: TaskNoticeState;
  bulkActionsVisible: boolean;
  undoing: boolean;
  adjusting: boolean;
  paused?: boolean;
  presets: QuickSnoozePreset[];
  onUndo: () => void;
  onDismiss: () => void;
  onSnooze: (preset: QuickSnoozePreset) => void;
  onCustomSnooze: () => void;
}) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const lifetime = useRef<{ notice: TaskNoticeState; remaining: number } | null>(null);
  useEffect(() => {
    if (lifetime.current?.notice !== notice) {
      const duration = notice.snoozeIds?.length ? 15_000 : notice.undoToken ? 8_000 : 5_000;
      lifetime.current = { notice, remaining: notice.dismissAt === undefined ? duration : Math.max(0, notice.dismissAt - Date.now()) };
    }
    if (paused || hovered || focused || undoing || adjusting || notice.tone === "error") return;
    const entry = lifetime.current, started = performance.now();
    const timer = window.setTimeout(onDismiss, entry.remaining);
    return () => {
      window.clearTimeout(timer);
      entry.remaining = Math.max(0, entry.remaining - (performance.now() - started));
    };
  }, [notice, paused, hovered, focused, undoing, adjusting, onDismiss]);
  return <section data-task-notice data-bulk-actions-visible={bulkActionsVisible} aria-label="Task notification" className="task-notice-safe-bottom pointer-events-none fixed inset-x-0 z-[60] mx-auto w-[calc(100%-2rem)] max-w-lg motion-safe:transition-[bottom] motion-safe:duration-200">
    <div onPointerEnter={event => { if (event.pointerType === "mouse") setHovered(true); }} onPointerLeave={() => setHovered(false)} onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }} className={cn("task-notice-surface pointer-events-auto rounded-lg border p-3 text-sm shadow-lg", notice.tone === "error" ? "border-destructive" : "border-border")}>
      <div className="flex items-start gap-2">
        <div role={notice.tone === "error" ? "alert" : "status"} className="min-w-0 flex-1 py-2">
          <p className={cn("break-words font-medium", notice.tone === "error" && "text-[var(--toast-error)]")}>{notice.text}</p>
          {notice.taskPreview && <p className="mt-1 truncate text-[13px] text-[var(--toast-muted)]" title={notice.taskPreview}>{notice.taskPreview}</p>}
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={onDismiss} className="shrink-0" aria-label="Dismiss notification"><ActionIcon name="close" /></Button>
      </div>
      {(notice.operationId || notice.undoToken) && <Button type="button" variant="outline" size="sm" onClick={onUndo} disabled={undoing || notice.undoRequested}><ActionIcon name="undo" />{undoing || notice.undoRequested ? "Undoing…" : "Undo"}</Button>}
      {notice.snoozeIds && notice.snoozeIds.length > 0 && <div role="group" aria-label="Adjust snooze time" className="mt-2 flex gap-2 overflow-x-auto p-1">
        {presets.map(preset => <Button key={preset} type="button" variant="secondary" size="sm" className="shrink-0" onClick={() => onSnooze(preset)} disabled={adjusting}>{quickSnoozeLabel(preset)}</Button>)}
        <Button type="button" variant="secondary" size="sm" className="shrink-0" onClick={onCustomSnooze} disabled={adjusting}><ActionIcon name="calendar" />Custom</Button>
      </div>}
    </div>
  </section>;
}

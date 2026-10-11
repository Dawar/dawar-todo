"use client";

import { Button } from "@/components/ui/button";
import { ActionIcon, type ActionIconName } from "./action-icon";
import type { Todo } from "./task-model";

type BulkAction = "complete" | "unsnooze" | "snooze" | "assign" | "merge" | "delete";

export function TaskBulkActions({ count, todos, snoozedView, busy, onAction, onQueue, onCancel }: {
  count: number;
  todos: Todo[];
  snoozedView: boolean;
  busy: boolean;
  onAction: (action: BulkAction) => void;
  onQueue: () => void;
  onCancel: () => void;
}) {
  const hasOpen = todos.some(todo => todo.status === "open");
  const actions: { action: BulkAction; label: string; icon: ActionIconName; disabled?: boolean }[] = [
    ...(hasOpen ? [{ action: "complete" as const, label: "Done", icon: "done" as const }] : []),
    ...(snoozedView && hasOpen
      ? [{ action: "unsnooze" as const, label: "Wake", icon: "wake" as const }]
      : todos.some(todo => todo.status === "open" && !todo.recurrenceCron)
        ? [{ action: "snooze" as const, label: "Snooze", icon: "snooze" as const }] : []),
    ...(todos.some(todo => todo.status === "completed") ? [{ action: "unsnooze" as const, label: "Open", icon: "open" as const }] : []),
    { action: "assign", label: "Assign project", icon: "move" },
    { action: "merge", label: "Merge", icon: "merge", disabled: count < 2 },
    { action: "delete", label: "Delete", icon: "delete" },
  ];
  return <section data-bulk-actions aria-label="Selected task actions" className="bulk-actions-safe-bottom pointer-events-none fixed inset-x-0 z-40 mx-auto w-[calc(100%-1rem)] max-w-4xl sm:w-[calc(100%-2rem)]">
    <div className="pointer-events-auto rounded-lg border border-border bg-card p-2 shadow-lg">
      <div className="mb-1 flex items-center justify-between gap-3 px-1">
        <span role="status" className="text-sm font-medium">{count} selected</span>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}><ActionIcon name="cancel" />Cancel</Button>
      </div>
      <div role="group" aria-label="Actions" className="flex gap-2 overflow-x-auto p-1">
        <Button type="button" variant="outline" className="shrink-0" onClick={onQueue}><ActionIcon name="forward" />Queue to bot</Button>
        {actions.map(({ action, label, icon, disabled }) => <Button key={label} type="button" variant={action === "delete" ? "destructive" : "outline"} className="shrink-0" disabled={busy || disabled} onClick={() => onAction(action)}><ActionIcon name={icon} />{label}</Button>)}
      </div>
    </div>
  </section>;
}

"use client";

import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { ControlledDialog } from "@/components/ui/controlled-dialog";
import { ActionIcon } from "./action-icon";

type View = "open" | "snoozed" | "done" | "all";
const views: [View, string][] = [["open","Open"],["snoozed","Snoozed"],["done","Done"],["all","All"]];
const priorities = <><option value="">All priorities</option><option value="1">Urgent</option><option value="2">High</option><option value="3">Normal</option><option value="4">Low</option></>;

export function TaskListControls({ view, counts, onView, query, onQuery, searchRef, priority, onPriority, pins, pinCount, pinLimit, onPins, filterCount, onFilters }: {
  view: View; counts: Record<View, number>; onView: (view: View) => void;
  query: string; onQuery: (value: string) => void; searchRef: RefObject<HTMLInputElement | null>;
  priority: string; onPriority: (value: string) => void; pins: boolean; pinCount: number; pinLimit: number;
  onPins: () => void; filterCount: number; onFilters: () => void;
}) {
  return <div className="mb-3 space-y-3">
    <div role="group" aria-label="Task views" className="grid grid-cols-4 gap-1 rounded-lg border border-border bg-card p-1">
      {views.map(([id,label]) => <Button key={id} type="button" variant="ghost" aria-pressed={view === id} onClick={() => onView(id)} className="h-auto min-h-11 min-w-0 flex-col gap-0.5 px-1 py-1.5 text-[13px] aria-pressed:bg-accent aria-pressed:text-accent-foreground sm:h-9 sm:min-h-9 sm:flex-row sm:gap-2 sm:px-3 sm:text-sm">{label}<span className="rounded bg-muted px-1.5 text-xs font-normal">{counts[id]}</span></Button>)}
    </div>
    <div className="flex min-w-0 gap-2">
      <div className="relative min-w-0 flex-1"><ActionIcon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/><Input ref={searchRef} value={query} onChange={event => onQuery(event.target.value)} aria-label="Search tasks" placeholder="Search tasks" className="pl-9"/></div>
      {view === "open" && <Button type="button" variant="outline" onClick={onPins} aria-pressed={pins} aria-label={pins ? "Turn off the separate pinned list" : "Turn on the separate pinned list"} title={pins ? "Mix pinned tasks into their natural order" : "Show pinned tasks in a separate list"} className="shrink-0 gap-1 px-2 aria-pressed:border-primary aria-pressed:bg-accent"><ActionIcon name="pin"/><span className="hidden sm:inline">Pins</span><span className="text-xs font-normal">{pinCount}/{pinLimit}</span></Button>}
      <Button type="button" variant="outline" size="icon" onClick={onFilters} aria-label={`Filters${filterCount ? `, ${filterCount} active` : ""}`} className="relative shrink-0 sm:hidden"><ActionIcon name="filters"/>{filterCount > 0 && <span className="absolute right-0 top-0 rounded-full bg-primary px-1 text-xs text-primary-foreground">{filterCount}</span>}</Button>
      <NativeSelect value={priority} onChange={event => onPriority(event.target.value)} aria-label="Filter by priority" className="hidden w-auto sm:block">{priorities}</NativeSelect>
    </div>
  </div>;
}

export function TaskFiltersDialog({ priority, onPriority, count, onClose }: { priority: string; onPriority: (value: string) => void; count: number; onClose: () => void }) {
  return <ControlledDialog title="Filters" onClose={onClose} onEscapeKeyDown={event => event.stopPropagation()} className="max-w-sm">
    <label className="grid gap-2 text-sm font-medium">Priority<NativeSelect autoFocus value={priority} onChange={event => onPriority(event.target.value)}>{priorities}</NativeSelect></label>
    <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" onClick={() => onPriority("")}>Reset</Button><Button type="button" onClick={onClose}>Show {count} {count === 1 ? "task" : "tasks"}</Button></div>
  </ControlledDialog>;
}

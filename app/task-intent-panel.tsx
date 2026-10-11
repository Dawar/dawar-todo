"use client";
import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { taskSync } from "./task-sync";
import { retryOfflineTaskIntent, type OfflineStoredAttachment } from "./offline-store";
import { taskStore } from "./task-store";

const changeLabels: Record<string, string> = {
  title: "Title", notes: "Notes", project: "Project", context: "Context",
  priority: "Priority", status: "Status", dueDate: "Due date",
  recurrenceCron: "Recurring schedule", snoozedUntil: "Snoozed until",
  pinned: "Pinned", sortOrder: "List position", deleted: "Deleted",
  deletedLocally: "Removed on this device", completedAt: "Completed at",
};
function SavedValue({ name, value }: { name: string; value: unknown }) {
  if (value === null || value === undefined || value === "") return <span className="text-muted-foreground">Not set</span>;
  if (typeof value === "boolean") return <>{value ? "Yes" : "No"}</>;
  if (name === "priority" && typeof value === "number") return <>{({ 1: "Urgent", 2: "High", 3: "Normal", 4: "Low" } as Record<number, string>)[value] ?? String(value)}</>;
  if (name === "status" && value === "completed") return <>Done</>;
  if (name === "status" && value === "open") return <>Open</>;
  if (Array.isArray(value)) return <ul className="list-inside list-disc space-y-1">{value.map((item, index) => <li key={index}><SavedValue name="" value={item} /></li>)}</ul>;
  if (typeof value === "object") return <SavedChanges changes={value as Record<string, unknown>} />;
  return <>{String(value)}</>;
}
function SavedChanges({ changes }: { changes: Record<string, unknown> }) {
  return <dl className="space-y-3">{Object.entries(changes).map(([name, value]) => <div key={name} className="min-w-0">
    <dt className="text-[13px] font-medium text-muted-foreground">{changeLabels[name] ?? name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ")}</dt>
    <dd className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground"><SavedValue name={name} value={value} /></dd>
  </div>)}</dl>;
}

export function TaskIntentPanel() {
  const state = useSyncExternalStore(taskSync.subscribe, taskSync.getSnapshot, taskSync.getSnapshot);
  const [error, setError] = useState("");
  const rows = [
    ...state.rejectedCreates.map((record) => ({ kind: "create" as const, id: record.clientId, title: record.title, status: record.rejected!.status, files: record.attachments, intent: { title: record.title, notes: record.notes, project: record.project, status: record.status, priority: record.priority, dueDate: record.dueDate, context: record.context, recurrenceCron: record.recurrenceCron, deletedLocally: Boolean(record.deleted) } })),
    ...state.mutations.filter((mutation) => mutation.rejected).map((mutation) => ({ kind: "edit" as const, id: mutation.todoId, title: taskStore.getById(mutation.todoId)?.title ?? "Unavailable task", status: mutation.rejected!.status, files: [] as OfflineStoredAttachment[], intent: mutation.patch })),
  ];
  if (!rows.length) return null;
  async function retry(kind: "create" | "edit", id: string | number) {
    try { await retryOfflineTaskIntent(kind, id); setError(""); } catch { setError("Could not save the retry. Your rejected change remains on this device."); }
  }
  function saveOriginal(file: OfflineStoredAttachment) {
    const url = URL.createObjectURL(file.blob); const link = document.createElement("a");
    link.href = url; link.download = file.fileName; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return <aside className="mx-auto my-3 min-w-0 max-w-5xl [overflow-wrap:anywhere] rounded-lg border border-warning-foreground/25 bg-warning p-4 text-sm text-foreground" aria-label="Task changes needing attention">
    <strong>{rows.length} task {rows.length === 1 ? "change needs" : "changes need"} attention</strong>
    <p className="mt-1 text-muted-foreground">Your changes are saved on this device. Edit the task or retry to sync them.</p>
    {rows.map((row) => <details key={`${row.kind}:${row.id}`} className="mt-2">
      <summary className="min-h-11 cursor-pointer rounded-md py-3 font-medium focus-visible:outline-2 focus-visible:outline-ring">{row.title} · {row.status === 404 ? "Task unavailable" : "Couldn’t sync"}</summary>
      <details className="mb-2 text-muted-foreground"><summary className="min-h-11 cursor-pointer rounded-md py-3 focus-visible:outline-2 focus-visible:outline-ring">Saved change</summary><div className="max-h-72 overflow-auto rounded-md border border-border bg-card p-3"><SavedChanges changes={row.intent} /></div></details>
      {row.files.map((file) => <p key={file.localId} className="break-words">
        {file.blob?.size ? <Button variant="link" type="button" className="h-auto min-h-11 max-w-full justify-start whitespace-normal break-words px-0 text-left" onClick={() => saveOriginal(file)}>Save {file.fileName}</Button> : `${file.fileName}: original bytes unavailable`}
      </p>)}
      <Button variant="outline" type="button" onClick={() => void retry(row.kind, row.id)}>Retry</Button>
    </details>)}
    {error && <p className="mt-3 text-destructive" role="alert">{error}</p>}
  </aside>;
}

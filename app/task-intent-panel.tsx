"use client";
import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { taskSync } from "./task-sync";
import { retryOfflineTaskIntent, type OfflineStoredAttachment } from "./offline-store";
import { taskStore } from "./task-store";

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
      <details className="mb-2 text-muted-foreground"><summary className="min-h-11 cursor-pointer rounded-md py-3 focus-visible:outline-2 focus-visible:outline-ring">Saved change</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-[13px]">{JSON.stringify(row.intent, null, 2)}</pre></details>
      {row.files.map((file) => <p key={file.localId} className="break-words">
        {file.blob?.size ? <Button variant="link" type="button" className="h-auto min-h-11 max-w-full justify-start whitespace-normal break-words px-0 text-left" onClick={() => saveOriginal(file)}>Save {file.fileName}</Button> : `${file.fileName}: original bytes unavailable`}
      </p>)}
      <Button variant="outline" type="button" onClick={() => void retry(row.kind, row.id)}>Retry</Button>
    </details>)}
    {error && <p className="mt-3 text-destructive" role="alert">{error}</p>}
  </aside>;
}

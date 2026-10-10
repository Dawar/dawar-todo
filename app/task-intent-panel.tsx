"use client";
import { useState, useSyncExternalStore } from "react";
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
  return <aside className="mx-auto my-3 min-w-0 max-w-5xl [overflow-wrap:anywhere] rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm" aria-label="Task changes needing attention">
    <strong>{rows.length} task {rows.length === 1 ? "change needs" : "changes need"} attention</strong>
    <p>These changes remain on this device. Edit the task to correct it, or retry. Later actions on the same task wait; other tasks continue syncing.</p>
    {rows.map((row) => <details key={`${row.kind}:${row.id}`} className="mt-2">
      <summary>{row.title} · {row.status === 404 ? "Target unavailable" : `Rejected (HTTP ${row.status})`}</summary>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap p-2">{JSON.stringify(row.intent, null, 2)}</pre>
      {row.files.map((file) => <p key={file.localId} className="break-words">
        {file.blob?.size ? <button type="button" className="max-w-full break-words text-left underline" onClick={() => saveOriginal(file)}>Save {file.fileName}</button> : `${file.fileName}: original bytes unavailable`}
      </p>)}
      <button type="button" className="underline" onClick={() => void retry(row.kind, row.id)}>Retry this change</button>
    </details>)}
    {error && <p role="alert">{error}</p>}
  </aside>;
}

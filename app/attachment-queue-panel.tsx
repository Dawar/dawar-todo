"use client";
import { useEffect, useState } from "react";
import { listQueuedAttachments, retryQueuedAttachments, replaceQueuedAttachmentBytes, type QueuedAttachment } from "./offline-store";
import { subscribeOfflineChanges } from "./offline-events";
import { attachmentQueueCounts, attachmentLeaseExpiry, attachmentQueueMessage, hasAttachmentBytes } from "./attachment-queue";

export function AttachmentQueuePanel({ count, states }: { count: number; states: Record<string, number> }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<QueuedAttachment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let active = true;
    let generation = 0;
    const reload = () => {
      const version = ++generation;
      void listQueuedAttachments().then((items) => { if (active && version === generation) { setRows(items); setLoaded(true); setNow(Date.now()); } })
        .catch(() => { if (active) setError("Attachment storage could not be read. Try opening this panel again."); });
    };
    reload();
    const unsubscribe = subscribeOfflineChanges(reload);
    const reconcileClock = () => { setNow(Date.now()); reload(); };
    document.addEventListener("visibilitychange", reconcileClock);
    window.addEventListener("online", reconcileClock);
    window.addEventListener("offline", reconcileClock);
    return () => { active = false; unsubscribe(); document.removeEventListener("visibilitychange", reconcileClock); window.removeEventListener("online", reconcileClock); window.removeEventListener("offline", reconcileClock); };
  }, [open]);
  useEffect(() => {
    if (document.visibilityState === "hidden") return;
    // Counts also age while closed/offline. Expiry is a one-shot wake; blocked
    // queues do not gain a periodic timer merely to refresh the banner.
    const leaseExpiry = Math.min(...rows.map(attachmentLeaseExpiry).filter(at => at > now));
    const countdown = open && navigator.onLine && rows.some(row => Number.isFinite(row.nextAttemptAt) && row.nextAttemptAt > now);
    const delay = Math.min(leaseExpiry - now, countdown ? 1_000 : Infinity);
    if (!Number.isFinite(delay)) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(1, delay));
    return () => window.clearTimeout(timer);
  }, [open, rows, now]);
  const action = async (fn: () => Promise<unknown>) => {
    setError("");
    try { await fn(); } catch (error) { setError(error instanceof Error ? error.message : "Recovery could not finish."); }
  };
  const saveFile = (row: QueuedAttachment) => {
    const url = URL.createObjectURL(row.blob);
    const link = document.createElement("a"); link.href = url; link.download = row.fileName; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const currentStates = loaded ? attachmentQueueCounts(rows, now) : states;
  const active = (currentStates.uploading ?? 0) + (currentStates.claiming ?? 0) + (currentStates.checking ?? 0);
  const blocked = (currentStates.blocked ?? 0) + (currentStates["missing-bytes"] ?? 0) + (currentStates.interrupted ?? 0);
  return <div className="mx-auto max-w-5xl px-4 pt-2 text-xs text-[#69716c] sm:px-6">
    <p role="status">{loaded ? rows.length : count} attachment{(loaded ? rows.length : count) === 1 ? "" : "s"} pending · {active} in progress · {blocked} need attention</p>
    <p>Transfers resume while the app is open and connected.</p>
    <div className="flex flex-wrap gap-4 py-2">
      <button type="button" className="underline" onClick={() => void action(() => retryQueuedAttachments())}>Retry uploads</button>
      <button type="button" className="underline" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Close attachment recovery" : "Review attachments"}</button>
    </div>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {open && <ul aria-label="Pending attachment recovery" className="space-y-3 rounded-xl border p-3">
      {rows.map((row) => <li key={row.localId} className="min-w-0 break-words border-b pb-3 [overflow-wrap:anywhere] last:border-0">
        <p className="font-semibold">{row.fileName || "Attachment"}</p>
        <p>{hasAttachmentBytes(row) ? `${row.blob.size.toLocaleString()} bytes saved on this device` : "No local file bytes available"}</p>
        <p>{attachmentQueueMessage(row, now)}</p>
        <div className="mt-2 flex flex-wrap gap-4">
          <button type="button" className="underline" disabled={attachmentLeaseExpiry(row) > now} onClick={() => void action(() => retryQueuedAttachments(row.localId))}>Retry this attachment</button>
          {hasAttachmentBytes(row) ? <button type="button" className="underline" onClick={() => saveFile(row)}>Save local file</button>
            : <label className="min-w-0 w-full max-w-full underline">Choose original file<input type="file" className="block min-w-0 w-full max-w-full" disabled={attachmentLeaseExpiry(row) > now} onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void action(() => replaceQueuedAttachmentBytes(row.localId, file));
              event.target.value = "";
            }} /></label>}
        </div>
      </li>)}
    </ul>}
  </div>;
}

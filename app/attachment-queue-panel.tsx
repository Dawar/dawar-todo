"use client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { useEffect, useId, useState } from "react";
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
  return <AttachmentQueueView count={loaded ? rows.length : count} active={active} blocked={blocked} open={open} loaded={loaded} rows={rows} error={error} now={now} onToggle={() => setOpen(!open)} onRetry={(id) => void action(() => retryQueuedAttachments(id))} onSave={saveFile} onReplace={(row, file) => void action(() => replaceQueuedAttachmentBytes(row.localId, file))} />;
}

export function AttachmentQueueView({count, active, blocked, open, loaded, rows, error, now, onToggle, onRetry, onSave, onReplace}: {
  count: number; active: number; blocked: number; open: boolean; loaded: boolean;
  rows: QueuedAttachment[]; error: string; now: number;
  onToggle: () => void; onRetry: (id?: string) => void;
  onSave: (row: QueuedAttachment) => void;
  onReplace: (row: QueuedAttachment, file: File) => void;
}) {
  const panelId = useId();
  return <section aria-label="Attachment transfers" className="mx-auto max-w-5xl px-4 pt-3 sm:px-6">
    <Card className="p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p role="status" className="font-medium">{count} attachment{count === 1 ? "" : "s"} pending</p>
          <p className="mt-1 text-[13px] text-muted-foreground">{active} in progress · {blocked} need attention</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => onRetry()}>Retry uploads</Button>
          <Button type="button" variant="ghost" aria-expanded={open} aria-controls={panelId} onClick={onToggle}>{open ? "Hide details" : "Review attachments"}</Button>
        </div>
      </div>
      <p className="mt-2 text-[13px] text-muted-foreground">Transfers resume while the app is open and connected.</p>
      {error && <p role="alert" className="mt-3 break-words rounded-md bg-destructive/10 p-3 text-destructive">{error}</p>}
      {open && <div id={panelId} className="mt-4 border-t border-border pt-4">
        {!loaded ? <p role="status" className="text-muted-foreground">Loading attachments…</p> : rows.length === 0 ? <p className="text-muted-foreground">No pending attachments.</p> : <ul aria-label="Pending attachment recovery" className="space-y-4">
          {rows.map((row) => <li key={row.localId} className="min-w-0 break-words border-b border-border pb-4 [overflow-wrap:anywhere] last:border-0 last:pb-0">
            <p className="font-medium">{row.fileName || "Attachment"}</p>
            <p className="mt-1 text-[13px] text-muted-foreground">{hasAttachmentBytes(row) ? `${row.blob.size.toLocaleString()} bytes saved on this device` : "No local file bytes available"}</p>
            <p className="mt-1 text-[13px] text-muted-foreground">{attachmentQueueMessage(row, now)}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={attachmentLeaseExpiry(row) > now} onClick={() => onRetry(row.localId)}>Retry attachment</Button>
              {hasAttachmentBytes(row) ? <Button type="button" variant="ghost" onClick={() => onSave(row)}>Save local file</Button>
                : <label className="grid w-full min-w-0 gap-2 text-sm font-medium">Choose original file<Input type="file" disabled={attachmentLeaseExpiry(row) > now} onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onReplace(row, file);
                  event.target.value = "";
                }} /></label>}
            </div>
          </li>)}
        </ul>}
      </div>}
    </Card>
  </section>;
}

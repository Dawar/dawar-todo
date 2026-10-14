"use client";
import type { QueuedAttachment } from "./offline-store";

export function hasAttachmentBytes(row: QueuedAttachment) {
  return row.blob instanceof Blob && row.blob.size > 0;
}

export function attachmentLeaseExpiry(row: QueuedAttachment) {
  return row.leaseToken && Number.isFinite(row.leaseUntil) ? row.leaseUntil! : 0;
}

export function attachmentQueueState(row: QueuedAttachment, now = Date.now()) {
  if (attachmentLeaseExpiry(row) > now) return row.phase ?? "checking";
  if (row.state === "blocked" || row.nextAttemptAt === Infinity) return "blocked";
  if (row.cancelled) return "removing";
  if (!hasAttachmentBytes(row) && !row.remoteAttachmentId) return "missing-bytes";
  if (row.phase && row.leaseToken) return "interrupted";
  return row.nextAttemptAt > now ? "retry" : "queued";
}

export function attachmentQueueCounts(rows: QueuedAttachment[], now = Date.now()) {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const state = attachmentQueueState(row, now); counts[state] = (counts[state] ?? 0) + 1; return counts;
  }, {});
}

export function attachmentQueueMessage(row: QueuedAttachment, now = Date.now()) {
  const state = attachmentQueueState(row, now);
  if (state === "checking") return "Checking whether the server already saved this attachment…";
  if (state === "claiming") return "Linking the saved draft attachment…";
  if (state === "uploading") return "Upload request in progress. Keep the app open to finish.";
  if (state === "removing") return "Removal pending confirmation.";
  if (state === "interrupted") return "Previous attempt interrupted; checking again when the app is open.";
  if (state === "missing-bytes" || row.reason === "missing-bytes") return "Local file bytes are missing. Choose the original file to recover.";
  if (row.reason === "target-missing") return "Task unavailable. Retry to check, or save this file and add it to the correct task.";
  if (row.reason === "auth") return "Sign in again, then retry. Local bytes are retained.";
  if (state === "blocked") return row.error || "Needs attention. Retry to check the server; local bytes are retained.";
  if (state === "retry") return `${row.error || "Attempt did not finish."} Retry in ${Math.max(1, Math.ceil((row.nextAttemptAt - now) / 1000))}s while the app is open.`;
  return "Queued; resumes while the app is open and connected.";
}

export function attachmentQueueDiagnostic(row: QueuedAttachment, now = Date.now()) {
  const state = attachmentQueueState(row, now);
  return {
    state, reason: row.reason ?? (row.nextAttemptAt === Infinity ? "legacy" : null),
    phase: row.phase ?? null,
    serverPhase: ["identity", "image-binding", "image-info", "image-transform", "prepare", "storage", "finalize"].includes(row.serverPhase ?? "") ? row.serverPhase : null,
    transport: row.transport ?? null, imageBindingAvailable: row.imageBindingAvailable ?? null,
    kind: row.kind,
    ageMs: Number.isFinite(Date.parse(row.createdAt)) ? Math.max(0, now - Date.parse(row.createdAt)) : null,
    attempts: row.attempts, lastStatus: row.lastStatus ?? null,
    lastAttemptAgeMs: row.lastAttemptAt ? Math.max(0, now - row.lastAttemptAt) : null,
    retryInMs: Number.isFinite(row.nextAttemptAt) ? Math.max(0, row.nextAttemptAt - now) : null,
    automaticRetry: state !== "blocked" && state !== "missing-bytes",
    leaseRemainingMs: Math.max(0, attachmentLeaseExpiry(row) - now),
    bytesPresent: hasAttachmentBytes(row), bytes: row.blob instanceof Blob ? row.blob.size : 0,
    remoteIdentityPresent: Boolean(row.remoteAttachmentId), draftIdentityPresent: Boolean(row.draftToken),
    localTarget: row.todoId < 1, cancelled: Boolean(row.cancelled),
  };
}

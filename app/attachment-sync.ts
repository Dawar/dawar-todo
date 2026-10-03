"use client";
import type { AttachmentRecovery } from "../lib/attachment-recovery";
import {
  acquireQueuedAttachment, updateQueuedAttachment, finishQueuedAttachment, resolveTaskId,
  type QueuedAttachment,
} from "./offline-store";
import { hasAttachmentBytes } from "./attachment-queue";
import { request, retryableSyncError, syncRetryDelay } from "./sync-request";
import { uploadTaskAttachmentMultipart, uploadTaskAttachment } from "./attachment-upload-client";
import { recordSyncDiagnostic } from "./sync-diagnostics";
import { documentBuild } from "./pwa-lifecycle";

class BlockedAttachment extends Error {
  constructor(public reason: QueuedAttachment["reason"], message: string) { super(message); }
}

/** One durable attempt. A response lost after commit is reconciled before sending bytes. */
export async function syncQueuedAttachment(localId: string) {
  let row = await acquireQueuedAttachment(localId);
  if (!row) return null;
  const lease = row.leaseToken!;
  const update = async (patch: Partial<QueuedAttachment>) => {
    const current = await updateQueuedAttachment(localId, lease, patch);
    if (!current) throw new Error("Attachment ownership changed.");
    row = current;
  };
  const phase = (phase: QueuedAttachment["phase"]) => update({ phase, leaseUntil: Date.now() + 120_000 });
  const inspect = () => request<AttachmentRecovery>("/api/attachments/recovery", {
    method: "POST", body: JSON.stringify({ todoId: row!.todoId,
      ids: [...new Set([localId, row!.remoteAttachmentId].filter(Boolean))], draftToken: row!.draftToken }),
  });
  recordSyncDiagnostic("attachment-attempt", { build: documentBuild, recoveryProtocol: 2, kind: row.kind, attempt: row.attempts, bytesPresent: hasAttachmentBytes(row) });
  try {
    const resolved = await resolveTaskId(row.todoId);
    if (resolved < 1) throw new BlockedAttachment("target-missing", "Waiting for the task to synchronize. Retry after the task appears.");
    if (resolved !== row.todoId) await update({ todoId: resolved });
    const recovery = await inspect();
    if (!Array.isArray(recovery.files)) throw new Error("Recovery response unavailable.");
    recordSyncDiagnostic("attachment-recovery-checked", { imageCapability: recovery.imageProcessingAvailable === true ? "available" : recovery.imageProcessingAvailable === false ? "unavailable" : "unknown" });
    const ready = recovery.files.find((file) => file.state === "ready" && file.todoId !== null);
    // Re-read cancellation intent after every network wait through the lease update.
    await phase("checking");
    if (row.cancelled) {
      // Never erase the bytes on a generic 404. Removal must be checked against
      // the stable IDs, including a draft that was claimed before a lost reply.
      await phase("removing");
      await request(`/api/todos/${row.todoId}/attachments/${localId}?discard=1`, { method: "DELETE" });
      for (const file of recovery.files) {
        if (file.state === "missing" || file.state === "deleted") continue;
        if (file.todoId === null) throw new BlockedAttachment("rejected", "Draft removal needs attention. Local bytes are retained.");
        await phase("removing");
        const endpoint = `/api/todos/${file.todoId}/attachments/${file.id}`;
        try { await request(endpoint, { method: "DELETE" }); }
        catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
        await request(`${endpoint}?discard=1`, { method: "DELETE" });
      }
      const checked = await inspect();
      if (!checked.files.every((file) => file.state === "missing" || file.state === "deleted")) throw new Error("Removal has not been confirmed.");
      await finishQueuedAttachment(localId, lease, true);
      return row.todoId;
    }
    if (ready) {
      if (await finishQueuedAttachment(localId, lease)) {
        recordSyncDiagnostic("attachment-reconciled", { movedTarget: ready.todoId !== row.todoId });
        return ready.todoId;
      }
      await update({ leaseToken: undefined, leaseUntil: undefined, phase: undefined, nextAttemptAt: 0 });
      return null;
    }
    if (!recovery.targetExists) throw new BlockedAttachment("target-missing", "Task unavailable. Save the local file to recover it on another task, or retry after restoring the task.");
    if (recovery.files.some((file) => file.state === "deleted")) throw new BlockedAttachment("rejected", "The server attachment was removed. Save the local file before adding it again.");
    const draft = recovery.files.find((file) => file.id === row!.remoteAttachmentId && file.state === "draft");
    if (draft && row.draftToken) {
      await phase("claiming");
      // Only a verified missing/expired draft permits a new upload. A generic
      // claim 400 may be capacity, validation or a server error, not expiry.
      await request(`/api/todos/${row.todoId}/attachments/claim`, { method: "POST", body: JSON.stringify({ draftToken: row.draftToken, attachmentIds: [draft.id] }) });
    } else {
      if (recovery.files.some((file) => file.state === "uploading" && file.todoId !== row!.todoId)) {
        throw new BlockedAttachment("rejected", "An upload with this identity belongs to another target. Save the local file or retry to reconcile it.");
      }
      if (!hasAttachmentBytes(row)) throw new BlockedAttachment("missing-bytes", "Local file bytes are missing. Choose the original file to recover.");
      // Only a positive capability permits server image processing. Retain a
      // prior explicit rejection across retries even if another worker says yes.
      const knownUnavailable = row.imageBindingAvailable === false || (row.lastStatus === 503 && row.serverPhase === "image-binding");
      const browserImage = row.kind === "image" && (recovery.imageProcessingAvailable !== true || knownUnavailable);
      await update({ transport: browserImage ? "browser" : "multipart",
        imageBindingAvailable: knownUnavailable ? false : recovery.imageProcessingAvailable });
      await phase("uploading");
      if (row.cancelled) throw new Error("Removal requested; checking on the next attempt.");
      const uploadRequest: typeof request = async <T,>(path: string, options?: Parameters<typeof request>[1]) => {
        const current = await updateQueuedAttachment(localId, lease, { leaseUntil: Date.now() + 120_000 });
        if (!current || current.cancelled) throw new Error("Upload ownership changed; local intent retained.");
        return request<T>(path, options);
      };
      const input = { file: new File([row.blob], row.fileName, { type: row.mimeType }), kind: row.kind,
        durationMs: row.durationMs, endpoint: `/api/todos/${row.todoId}/attachments`, request: uploadRequest, clientUploadId: localId };
      const browserUpload = async (reason: string) => {
        await update({ transport: "browser" });
        recordSyncDiagnostic("attachment-browser-fallback", { reason });
        // Stable ID means a lost finalize response reconciles as the same file.
        await uploadTaskAttachment({ ...input, discard: async () => undefined });
      };
      if (browserImage) {
        await browserUpload(recovery.imageProcessingAvailable === false || row.imageBindingAvailable === false ? "image-binding-unavailable" : "image-capability-unknown");
      } else {
        try { await uploadTaskAttachmentMultipart(input); }
        catch (error) {
          const unavailable = error as { code?: string; phase?: string; status?: number };
          if (row.kind !== "image" || unavailable.code !== "image-processing-unavailable" || unavailable.phase !== "image-binding" || unavailable.status !== 503) throw error;
          // This typed failure occurs before preparation/storage. Retry through
          // the stable-ID JSON path, never discard or manufacture a new identity.
          await update({ imageBindingAvailable: false, lastStatus: 503, serverPhase: "image-binding" });
          await browserUpload("multipart-image-binding-unavailable");
        }
      }
    }
    if (!await finishQueuedAttachment(localId, lease)) {
      await update({ leaseToken: undefined, leaseUntil: undefined, phase: undefined, nextAttemptAt: 0 });
      return null;
    }
    recordSyncDiagnostic("attachment-finished", { kind: row.kind, attempts: row.attempts });
    return row.todoId;
  } catch (error) {
    const status = (error as { status?: number }).status;
    const blocked = error instanceof BlockedAttachment || !retryableSyncError(error) || status === 401 || status === 403;
    const reason = error instanceof BlockedAttachment ? error.reason : status === 401 || status === 403 ? "auth" : status === 404 ? "target-missing" : blocked ? "rejected" : status ? "server" : "transport";
    // Fixed text: backend/storage messages can contain private URLs or file names.
    const message = error instanceof BlockedAttachment ? error.message : reason === "auth" ? "Sign in again, then retry." : status === 404 ? "The upload target is unavailable. Retry to check or save the local file." : blocked ? `Upload rejected${status ? ` (HTTP ${status})` : ""}. Retry to check or save the local file.` : "Upload could not be confirmed; local bytes are retained.";
    const delay = blocked ? Infinity : syncRetryDelay(row.attempts);
    const deferred = await updateQueuedAttachment(localId, lease, { state: blocked ? "blocked" : "retry", reason, error: message,
      lastStatus: status, serverPhase: (error as { phase?: string }).phase ?? row.serverPhase, nextAttemptAt: Date.now() + delay, leaseToken: undefined, leaseUntil: undefined, phase: undefined });
    recordSyncDiagnostic(deferred ? "attachment-deferred" : "attachment-ownership-changed", { reason: reason ?? null, status: status ?? null, attempts: row.attempts, automaticRetry: Boolean(deferred) && !blocked });
    return null;
  }
}

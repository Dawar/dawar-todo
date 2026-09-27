/* eslint-disable @next/next/no-img-element -- Staged local bytes use browser object URLs. */
import { useLayoutEffect, useRef } from "react";
import { Paperclip, X } from "lucide-react";
import type { BotComposer } from "./composer-controller";
import { botComposers } from "./composer-service";

function LocalPreview({ file }: { file?: File }) {
  const image = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    if (!file || !image.current) return;
    const element = image.current;
    const url = URL.createObjectURL(file);
    element.src = url;
    return () => { element.removeAttribute("src"); URL.revokeObjectURL(url); };
  }, [file]);
  return file ? <img ref={image} alt="" /> : <Paperclip size={18} aria-hidden="true" />;
}
export function ComposerAttachments({ composer }: { composer: BotComposer }) {
  if (!composer.draft.files.length) return null;
  return <div className="bots-upload-list" role="group" aria-label="Attachments to send">
    {composer.draft.files.map((file, index) => {
      const image = file.mimeType.startsWith("image/");
      const percent = composer.progress.get(file.id);
      const status = file.error ? "Upload needs retry" : percent !== undefined ? `${percent}%` : !file.remote ? composer.dirty ? "Saving file…" : "Saved locally · awaiting upload" : !file.hasBytes ? "Offline copy unavailable" : "";
      return <span key={`${composer.owner}:${composer.botId}:${file.id}`} className={image ? "bots-upload-image" : undefined} title={[file.name, file.error || status].filter(Boolean).join(" · ")}>
        {image ? <LocalPreview file={composer.files.get(file.id)} /> : file.name}
        {status && <span className={image ? "bots-upload-progress" : undefined}>{status}</span>}
        <button type="button" aria-label={`Remove ${image ? `image ${index + 1}: ` : ""}${file.name}`} onClick={() => composer.removeFile(file.id)}><X size={13} aria-hidden="true" /></button>
      </span>;
    })}
  </div>;
}
export function ComposerStatus({ composer, error }: { composer: BotComposer | null; error: string }) {
  const storageError = error || composer?.storageError || botComposers.error;
  const operation = composer?.operation;
  const uploadErrors = composer?.draft.files.filter((f) => f.error) ?? [];
  const missingCopies = composer?.draft.files.some((f) => !f.hasBytes);
  const otherFailures = botComposers.unsavedElsewhere.filter((c) => c !== composer);
  const needsAttention = Boolean(storageError || otherFailures.length || composer?.actionError || uploadErrors.length || missingCopies || operation || composer?.recoveries.length);
  const status = storageError ? "Draft not saved · Review recovery" : !composer?.ready ? "Recovering draft…" : composer.saved ? "Draft saved on this device" : "Saving draft… Keep this tab open.";
  return <div className="bots-draft-status" aria-live="polite"><details className="bots-recovery-details" open={needsAttention}>
    <summary>{status}{needsAttention && <strong> · {uploadErrors.length ? `${uploadErrors.length} upload(s) need attention` : "Review status"}</strong>}</summary>
    <div className="bots-recovery-content">
    {storageError ? <div role="alert">{storageError} <button type="button" onClick={() => { void composer?.retry(); void botComposers.recoverOwner(); }}>Retry saving / recovery</button></div>
      : <span>{!composer?.ready ? "Recovering draft…" : composer.saved ? "Draft saved on this device" : "Saving draft… Keep this tab open."}</span>}
    {otherFailures.length > 0 && <div role="alert">{otherFailures.length} other bot draft(s) could not save. Keep this tab open. <button type="button" onClick={() => otherFailures.forEach((c) => { void c.retry(); })}>Retry saving all</button></div>}
    {composer?.actionError && <div role="alert">{composer.actionError}</div>}
    {uploadErrors.length > 0 && <div role="alert">{uploadErrors.map((f) => `${f.name}: ${f.error}`).join(" · ")} Your staged files are retained. <button type="button" onClick={() => void composer?.retry()}>Retry uploads</button> <button type="button" onClick={() => void composer?.restartFailedUploads()}>Restart failed transfers</button></div>}
    {missingCopies && <div>Older attachments have server references only. Connect to recover their offline copies. <button type="button" onClick={() => void composer?.retry()}>Recover files</button></div>}
    {operation && <div>{composer?.sendingNow ? "Waiting for send acknowledgement…" : operation.error || "Submitted message awaits acknowledgement."} <button type="button" disabled={composer?.sendingNow} onClick={() => void composer?.send()}>Check same send</button></div>}
    {composer && composer.recoveries.length > 0 && <label>Another tab’s draft was also saved. Recover version: <select aria-label="Recover conflicting draft" value={composer.record.active.startsWith("recovered:") ? composer.record.active : ""} onChange={(event) => composer.select(event.target.value)}>
      <option value="">Choose saved version</option>{composer.recoveries.map((slot, index) => <option key={slot} value={slot}>Saved version {index + 1}</option>)}
    </select></label>}
    {composer && composer.record.active !== "normal" && !composer.draft.queueId && <button type="button" onClick={() => composer.select("normal")}>Return to normal draft</button>}
    </div></details>
  </div>;
}

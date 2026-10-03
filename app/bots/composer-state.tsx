/* eslint-disable @next/next/no-img-element -- Staged local bytes use browser object URLs. */
import { useLayoutEffect, useRef } from "react";
import { Paperclip, X } from "lucide-react";
import type { BotComposer } from "./composer-controller";
import { UploadThumbnail } from "./upload-thumbnail";
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
      const status = file.error && !file.remote?.ready ? "Upload needs retry" : percent !== undefined ? `${percent}%` : !file.remote ? composer.dirty ? "Saving file…" : "Saved locally · awaiting upload" : "";
      return <span key={`${composer.owner}:${file.id}`} className={image ? "bots-upload-image" : undefined} title={[file.name, file.error || status].filter(Boolean).join(" · ")}>
        {image ? composer.files.has(file.id) ? <LocalPreview file={composer.files.get(file.id)} /> : file.remote?.ready ? <UploadThumbnail botId={file.remote.botId} attachmentId={file.remote.id} online /> : <LocalPreview /> : file.name}
        {status && <span className={image ? "bots-upload-progress" : undefined}>{status}</span>}
        <button type="button" disabled={Boolean(composer.draft.queueSource && !composer.draft.queueSource.removed)} aria-label={`Remove ${image ? `image ${index + 1}: ` : ""}${file.name}`} onClick={() => composer.removeFile(file.id)}><X size={13} aria-hidden="true" /></button>
      </span>;
    })}
  </div>;
}
export function ComposerStatus({ composer, error }: { composer: BotComposer | null; error: string }) {
  const storageError = error || composer?.storageError || botComposers.error;
  const operation = composer?.operation;
  const uploadErrors = composer?.draft.files.filter(file=>file.error && !file.remote?.ready) ?? [];
  const detail = storageError || composer?.actionError || (operation && !composer?.sendingNow ? operation.error : "") || uploadErrors.map(file=>`${file.name}: ${file.error}`).join(" · ");
  if (!detail) return null;
  return <div className="bots-draft-status" role="alert"><span>{detail}</span>
    <button type="button" disabled={composer?.sendingNow} onClick={()=>{
      if (operation) void composer?.send();
      else { void composer?.retry(); void botComposers.recoverOwner(); }
    }}>Retry</button>
  </div>;
}

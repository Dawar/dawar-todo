/* eslint-disable @next/next/no-img-element -- Staged local bytes use browser object URLs. */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Paperclip, X } from "lucide-react";
import type { BotComposer } from "./composer-controller";
import { UploadThumbnail } from "./upload-thumbnail";
import { botComposers } from "./composer-service";
import { botsClient } from "./client";
import { ArtifactViewer } from "./artifact-viewer";
import type { StagedFile } from "./draft-store";
import type { GalleryItem } from "./artifact-source";
import "./artifact-gallery.css";

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
function ComposerAttachment({ composer, file, index }: { composer: BotComposer; file: StagedFile; index: number }) {
      const [open, setOpen] = useState(false), [error, setError] = useState("");
      const close = useCallback(() => setOpen(false), []);
      const image = file.mimeType.startsWith("image/");
      const pdf = file.mimeType === "application/pdf" || /\.pdf$/i.test(file.name);
      const percent = composer.progress.get(file.id);
      const status = file.error && !file.remote?.ready ? "Upload needs retry" : percent !== undefined ? `${percent}%` : !file.remote ? composer.dirty ? "Saving file…" : "Saved locally · awaiting upload" : "";
      const item: GalleryItem = useMemo(() => ({ id: file.id, botId: composer.botId, name: file.name, mimeType: pdf ? "application/pdf" : file.mimeType, size: file.size, ready: false,
        botName: botsClient.snapshot?.bots.find(bot => bot.id === composer.botId)?.name ?? "Bot", createdAt: null }), [file.id, file.name, file.mimeType, file.size, composer.botId, pdf]);
      const initialSubmission = useMemo(() => composer.record.botId === composer.botId && composer.record.active === "normal" ? { documentFileId: file.id } : undefined, [composer.record.botId, composer.record.active, composer.botId, file.id]);
      const view = async () => {
        await composer.open();
        if (!composer.canUseOwner) { setError("Sign back in as this file's owner to open it."); return; }
        if (!composer.files.has(file.id) && !file.remote?.ready) { setError("The saved file is unavailable. Retry file recovery before opening it."); return; }
        setError(""); setOpen(true);
      };
      return <><span className={image ? "bots-upload-image" : undefined} title={[file.name, file.error || status].filter(Boolean).join(" · ")}>
        {image ? composer.files.has(file.id) ? <LocalPreview file={composer.files.get(file.id)} /> : file.remote?.ready ? <UploadThumbnail botId={file.remote.botId} attachmentId={file.remote.id} online /> : <LocalPreview /> : pdf ? <button type="button" className="bots-pdf-draft-open" aria-label={`Open ${file.name}`} onClick={() => void view()}>{file.name}</button> : file.name}
        {status && <span className={image ? "bots-upload-progress" : undefined}>{status}</span>}
        <button type="button" disabled={Boolean(composer.draft.queueSource && !composer.draft.queueSource.removed)} aria-label={`Remove ${image ? `image ${index + 1}: ` : ""}${file.name}`} onClick={() => composer.removeFile(file.id)}><X size={13} aria-hidden="true" /></button>
      </span>{error && <span role="alert">{error}</span>}{open && createPortal(<ArtifactViewer item={item} owner={composer.owner} online={botsClient.online || botsClient.storageCatalogAvailable} originalFile={composer.files.get(file.id)} sourceAttachment={file.remote} initialSubmission={initialSubmission} onClose={close} />, document.body)}</>;
}
export function ComposerAttachments({ composer }: { composer: BotComposer }) {
  if (!composer.draft.files.length) return null;
  return <div className="bots-upload-list" role="group" aria-label="Attachments to send">
    {composer.draft.files.map((file, index) => <ComposerAttachment key={`${composer.owner}:${file.id}`} composer={composer} file={file} index={index} />)}
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

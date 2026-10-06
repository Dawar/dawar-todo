/* eslint-disable @next/next/no-img-element -- Staged local bytes use browser object URLs. */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
function ComposerAttachment({ composer, file, index, online }: { composer: BotComposer; file: StagedFile; index: number; online: boolean }) {
  const [open, setOpen] = useState(false), [error, setError] = useState("");
  const close = useCallback(() => setOpen(false), []);
  const image = file.mimeType.startsWith("image/");
  const pdf = !image && (file.mimeType === "application/pdf" || /\.pdf$/i.test(file.name));
  const percent = composer.progress.get(file.id);
  const locked = Boolean(composer.draft.queueSource && !composer.draft.queueSource.removed);
  const status = file.error && !file.remote?.ready ? "Upload needs retry" : percent !== undefined ? `${percent}%` : !file.remote ? composer.dirty ? "Saving file…" : "Saved locally · awaiting upload" : "";
  const item: GalleryItem = useMemo(() => ({ id: file.id, botId: composer.botId, name: file.name, mimeType: pdf ? "application/pdf" : file.mimeType, size: file.size, ready: false,
    botName: botsClient.snapshot?.bots.find(bot => bot.id === composer.botId)?.name ?? "Bot", createdAt: null }), [file.id, file.name, file.mimeType, file.size, composer.botId, pdf]);
  // Only the existing ordinary main PDF draft can add initial feedback. Run,
  // recovered and queue-edit previews never gain a review-send entry point.
  const canReview = pdf && composer.record.botId === composer.botId && composer.record.active === "normal" && !locked && !composer.draft.queueId && !composer.operation && !composer.committing;
  const initialSubmission = useMemo(() => canReview ? { documentFileId: file.id } : undefined, [canReview, file.id]);
  const view = () => {
    if (!composer.canUseOwner) { setError("Sign back in as this file's owner to open it."); return; }
    if (!composer.files.has(file.id) && !file.remote?.ready) { setError("The saved file is unavailable. Retry file recovery before opening it."); return; }
    setError(""); setOpen(true);
  };
  const thumbnail = composer.files.has(file.id) ? <LocalPreview file={composer.files.get(file.id)} /> : file.remote?.ready ? <UploadThumbnail botId={file.remote.botId} attachmentId={file.remote.id} online={online} /> : <LocalPreview />;
  return <><span className={image ? "bots-upload-image" : undefined} title={[file.name, file.error || status].filter(Boolean).join(" · ")}>
    {image || pdf ? <button type="button" className="bots-attachment-open" aria-label={`Open ${file.name}`} aria-haspopup="dialog" onClick={view}>{image ? thumbnail : file.name}</button> : file.name}
    {status && <span className={image ? "bots-upload-progress" : undefined}>{status}</span>}
    <button type="button" disabled={locked} aria-label={`Remove ${image ? `image ${index + 1}: ` : ""}${file.name}`} onClick={() => composer.removeFile(file.id)}><X size={13} aria-hidden="true" /></button>
  </span>{error && <span role="alert">{error}</span>}{open && createPortal(<ArtifactViewer item={item} owner={composer.owner} online={online} originalFile={composer.files.get(file.id)} sourceAttachment={file.remote} initialSubmission={initialSubmission} readOnly={!canReview} onClose={close} />, document.body)}</>;
}
export function ComposerAttachments({ composer }: { composer: BotComposer }) {
  const owner = useSyncExternalStore(botsClient.subscribe, () => botsClient.owner, () => "");
  const online = useSyncExternalStore(botsClient.subscribe, () => botsClient.online || botsClient.storageCatalogAvailable, () => false);
  if (owner !== composer.owner || !composer.draft.files.length) return null;
  // Stable within ordinary typing/upload progress, replaced on owner/bot/run,
  // slot or queue checkout changes. Removal unmounts the file and cancels reads.
  const scope = JSON.stringify([composer.owner, composer.botId, composer.record.botId, composer.record.active, composer.draft.queueId, composer.draft.queueRevision, composer.draft.queueSource]);
  return <div className="bots-upload-list" role="group" aria-label="Attachments to send">
    {composer.draft.files.map((file, index) => <ComposerAttachment key={`${scope}:${file.id}`} composer={composer} file={file} index={index} online={online} />)}
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

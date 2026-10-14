/* eslint-disable @next/next/no-img-element */
"use client";
import { Button } from "@/components/ui/button";
import { ActionIcon } from "./action-icon";
import { formatDuration, formatFileSize } from "./attachment-format";
import type { OfflineAttachmentKind } from "./offline-store";

type Media = {id: string; kind: OfflineAttachmentKind; fileName: string; byteSize: number; durationMs: number; originalUrl: string; audioUrl: string; videoUrl: string; thumbnailUrl: string};
export function TaskAttachmentMedia({attachment, disabled, onDelete, onView}: {attachment: Media; disabled: boolean; onDelete: () => void; onView: () => void}) {
  if (attachment.kind === "audio" || attachment.kind === "file") return <div className="col-span-full min-w-0 rounded-lg border border-border bg-card p-3">
    <div className="flex min-w-0 items-start gap-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-muted text-primary"><ActionIcon name={attachment.kind === "audio" ? "mic" : "file"} /></span>
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm font-medium [overflow-wrap:anywhere]">{attachment.fileName}</p>
        <p className="mt-1 text-[13px] text-muted-foreground">{attachment.kind === "audio" ? formatDuration(attachment.durationMs) : formatFileSize(attachment.byteSize)}</p>
      </div>
    </div>
    {attachment.kind === "audio" && <audio controls preload="metadata" src={attachment.audioUrl} className="mt-3 h-10 w-full" aria-label={attachment.fileName} />}
    <div className="mt-2 flex flex-wrap justify-end gap-1">
      <Button asChild variant="ghost" size="icon"><a href={attachment.originalUrl} download={attachment.fileName} aria-label={`Download ${attachment.fileName}`} title="Download"><ActionIcon name="download" /></a></Button>
      <Button type="button" variant="ghost" size="icon" onClick={onDelete} disabled={disabled} className="text-muted-foreground hover:text-destructive" aria-label={`Delete ${attachment.fileName}`} title="Delete"><ActionIcon name="delete" /></Button>
    </div>
  </div>;
  return <div className={`group/media relative min-w-0 overflow-hidden rounded-lg border border-border bg-muted ${attachment.kind === "video" ? "col-span-full" : "aspect-square"}`}>
    {attachment.kind === "image" ? <button type="button" onClick={onView} className="h-full w-full focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring" aria-label={`View image: ${attachment.fileName}`}><img src={attachment.thumbnailUrl} alt={attachment.fileName} className="h-full w-full object-cover" /></button>
      : <video controls preload="metadata" src={attachment.videoUrl} className="aspect-video w-full object-contain" aria-label={attachment.fileName} />}
    <Button type="button" variant="ghost" size="icon" onClick={onDelete} disabled={disabled} aria-label={`Delete ${attachment.kind}: ${attachment.fileName}`} title={`Delete ${attachment.kind}`} className="absolute right-1 top-1 bg-black/65 text-white hover:bg-destructive hover:text-destructive-foreground focus-visible:ring-white sm:opacity-0 sm:group-hover/media:opacity-100 sm:group-focus-within/media:opacity-100"><ActionIcon name="delete" /></Button>
  </div>;
}

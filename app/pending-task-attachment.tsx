/* eslint-disable @next/next/no-img-element */
"use client";
import { Button } from "@/components/ui/button";
import { ActionIcon } from "./action-icon";
import { formatDuration, formatFileSize } from "./attachment-format";
import type { OfflineAttachmentKind } from "./offline-store";

type PendingMedia = {kind: OfflineAttachmentKind; file: File; previewUrl: string; durationMs: number; status: "staged" | "uploading" | "ready" | "error" | "offline"; error: string};
export function PendingTaskAttachment({item, onRetry, onRemove}: {item: PendingMedia; onRetry: () => void; onRemove: () => void}) {
  const uploading = item.status === "uploading";
  const failed = item.status === "error";
  const message = uploading ? "Uploading…" : item.error || (item.status === "offline" ? "Queued for upload." : failed ? "Upload failed. Try again." : "Waiting to upload.");
  return <div className="col-span-full min-w-0 overflow-hidden rounded-lg border border-border bg-card p-3">
    <div className="flex min-w-0 items-start gap-3">
      {item.kind === "image" ? <img src={item.previewUrl} alt="" className="h-14 w-14 shrink-0 rounded-md object-cover" /> : item.kind === "video" ? <video src={item.previewUrl} muted className="h-14 w-14 shrink-0 rounded-md object-cover" /> : <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-muted text-primary"><ActionIcon name={item.kind === "file" ? "file" : "mic"} /></span>}
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm font-medium [overflow-wrap:anywhere]">{item.file.name}</p>
        <p className="mt-1 text-[13px] text-muted-foreground">{item.kind === "audio" ? formatDuration(item.durationMs) : formatFileSize(item.file.size)}</p>
        <p role="status" className={`mt-1 break-words text-[13px] [overflow-wrap:anywhere] ${failed ? "text-destructive" : "text-muted-foreground"}`}>{message}</p>
      </div>
    </div>
    {!uploading && <div className="mt-3 flex flex-wrap justify-end gap-2">
      <Button type="button" variant="outline" onClick={onRetry} aria-label={`Retry ${item.file.name}`}><ActionIcon name="retry" />Retry</Button>
      <Button type="button" variant="ghost" onClick={onRemove} aria-label={`Remove ${item.file.name}`} className="text-muted-foreground hover:text-destructive"><ActionIcon name="close" />Remove</Button>
    </div>}
  </div>;
}

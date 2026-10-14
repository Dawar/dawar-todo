/* eslint-disable @next/next/no-img-element */
"use client";

import { useRef, useState } from "react";
import { ControlledDialog } from "@/components/ui/controlled-dialog";
import { Button } from "@/components/ui/button";
import { ActionIcon } from "./action-icon";

type ViewerImage = {fileName: string; displayUrl: string; originalUrl: string};
export function TaskImageViewer({ attachment, index, count, copyState, disabled = false, onClose, onCopy, onDelete, onNavigate }: {
  attachment: ViewerImage; index: number; count: number;
  copyState: "idle" | "copying" | "copied" | "error";
  disabled?: boolean;
  onClose: () => void; onCopy: () => void; onDelete: () => void; onNavigate: (delta: number) => void;
}) {
  const viewerGesture = useRef<number | null>(null);
  const [imageState, setImageState] = useState({url: attachment.displayUrl, status: "loading"});
  const status = imageState.url === attachment.displayUrl ? imageState.status : "loading";
  return <ControlledDialog aria-label={`Image viewer: ${attachment.fileName}`} title={<span className="block truncate" title={attachment.fileName}>{attachment.fileName}</span>} onClose={onClose} className="flex h-[calc(100dvh-2rem)] max-w-6xl flex-col gap-3 overflow-hidden p-3 sm:p-5" onEscapeKeyDown={event => event.stopPropagation()} onKeyDown={event => {
    event.stopPropagation();
    if (count > 1 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) { event.preventDefault(); onNavigate(event.key === "ArrowLeft" ? -1 : 1); }
  }}>
    <div className="relative flex min-h-0 flex-1 touch-pan-y items-center justify-center overflow-hidden rounded-md bg-muted" onPointerDown={event => { if (event.pointerType === "touch") viewerGesture.current = event.clientX; }} onPointerCancel={() => { viewerGesture.current = null; }} onPointerUp={event => {
      const start = viewerGesture.current; viewerGesture.current = null;
      if (start === null || count < 2) return;
      const delta = event.clientX - start;
      if (Math.abs(delta) >= 50) onNavigate(delta < 0 ? 1 : -1);
    }}>
      <button type="button" tabIndex={-1} aria-label="Close image viewer" onClick={onClose} className="absolute inset-0 cursor-zoom-out" />
      {status === "loading" && <p role="status" className="absolute text-sm text-muted-foreground">Loading image…</p>}
      {status === "error" && <p role="alert" className="relative px-5 text-center text-sm text-destructive">Image unavailable. You can still try downloading the original.</p>}
      <img key={attachment.displayUrl} src={attachment.displayUrl} alt={attachment.fileName} onLoad={() => setImageState({url: attachment.displayUrl, status: "ready"})} onError={() => setImageState({url: attachment.displayUrl, status: "error"})} className={`relative max-h-full max-w-full object-contain ${status === "error" ? "hidden" : ""}`} />
    </div>
    {copyState !== "idle" && <p role="status" className="text-[13px] text-muted-foreground">{copyState === "copying" ? "Copying image…" : copyState === "copied" ? "Copied to clipboard" : "Copy unavailable. Use the image menu or download the original."}</p>}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-1">
        <Button type="button" variant="ghost" size="icon" onClick={onCopy} disabled={copyState === "copying"} aria-label="Copy image" title="Copy image"><ActionIcon name="copy" /></Button>
        <Button asChild variant="ghost" size="icon"><a href={attachment.originalUrl} download={attachment.fileName} aria-label="Download original" title="Download original"><ActionIcon name="download" /></a></Button>
        <Button type="button" variant="ghost" size="icon" onClick={onDelete} disabled={disabled} className="text-destructive hover:text-destructive" aria-label="Delete image" title="Delete image"><ActionIcon name="delete" /></Button>
      </div>
      {count > 1 && <div className="flex items-center gap-1" aria-label="Image navigation">
        <Button type="button" variant="outline" size="icon" onClick={() => onNavigate(-1)} aria-label="Previous image"><ActionIcon name="previous" /></Button>
        <span role="status" className="min-w-10 text-center text-[13px] text-muted-foreground">{index + 1} / {count}</span>
        <Button type="button" variant="outline" size="icon" onClick={() => onNavigate(1)} aria-label="Next image"><ActionIcon name="next" /></Button>
      </div>}
    </div>
  </ControlledDialog>;
}

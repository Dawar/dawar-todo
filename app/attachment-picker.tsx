"use client";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ControlledDialog } from "@/components/ui/controlled-dialog";
import { ActionIcon } from "./action-icon";
import { GENERIC_FILE_ACCEPT } from "../lib/attachment-files";
const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,.heic,.heif";
const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm";
const MEDIA_ACCEPT = `${IMAGE_ACCEPT},${VIDEO_ACCEPT}`;

export function AttachmentPicker({ disabled, onFiles, onRecord, onAssignProject, label, showLabel = false }: {
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  onRecord: () => void;
  onAssignProject?: () => void;
  label: string;
  showLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const libraryRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  function selected(input: HTMLInputElement) {
    const files = [...(input.files ?? [])];
    input.value = "";
    setOpen(false);
    if (files.length) onFiles(files);
  }
  return <div className="relative shrink-0">
    <Button type="button" variant="ghost" size={showLabel ? "default" : "icon"} disabled={disabled} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open && !disabled} aria-label={label} title={label} className="text-primary">
      <ActionIcon name={showLabel ? "attachment" : "add"} />
      {showLabel && <span>Add attachment</span>}
    </Button>
    {open && !disabled && <ControlledDialog title="Add an attachment" onClose={() => setOpen(false)} className="max-w-sm" onKeyDown={(event) => event.stopPropagation()} onEscapeKeyDown={(event) => event.stopPropagation()}>
      <div className="grid gap-1">
        <Button type="button" variant="ghost" onClick={() => libraryRef.current?.click()} className="h-12 justify-start whitespace-normal text-left sm:h-11"><ActionIcon name="image" />Choose photos or videos</Button>
        <Button type="button" variant="ghost" onClick={() => fileRef.current?.click()} className="h-12 justify-start sm:h-11"><ActionIcon name="file" />Choose files</Button>
        <Button type="button" variant="ghost" onClick={() => { setOpen(false); onRecord(); }} className="h-12 justify-start sm:h-11"><ActionIcon name="mic" />Record voice memo</Button>
        {onAssignProject && <Button type="button" variant="ghost" onClick={() => { setOpen(false); onAssignProject(); }} className="h-12 justify-start sm:h-11"><ActionIcon name="move" />Assign project</Button>}
      </div>
      <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
    </ControlledDialog>}
    <input ref={libraryRef} type="file" accept={MEDIA_ACCEPT} multiple className="sr-only" tabIndex={-1} onChange={(event) => selected(event.currentTarget)} />
    <input ref={fileRef} type="file" accept={GENERIC_FILE_ACCEPT} multiple className="sr-only" tabIndex={-1} onChange={(event) => selected(event.currentTarget)} />
  </div>;
}

/* eslint-disable @next/next/no-img-element */
"use client";

import {
  ClipboardEvent as ReactClipboardEvent,
  FormEvent,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { ActionIcon, type ActionIconName } from "./action-icon";
import { copyTextToClipboard } from "./copy-to-clipboard";
import { SiteHeader } from "./site-header";
import {
  deleteOfflineTodo,
  loadCachedServerState,
  listOfflineTodos,
  persistOfflineStorage,
  saveOfflineTodo,
  saveCachedServerState,
  type OfflineAttachmentKind,
  type OfflineTodoRecord,
} from "./offline-store";

type TodoStatus = "open" | "completed";
type View = "open" | "snoozed" | "all" | "projects";
type TaskListView = Exclude<View, "projects">;
type Sort = "smart" | "priority" | "due" | "newest" | "oldest" | "az";
type TodoAction = "complete" | "snooze" | "unsnooze" | "delete";
type ExecutableTodoAction = TodoAction;
type Notice = { tone: "success" | "error"; text: string; undoToken?: string } | null;

type Todo = {
  id: number;
  title: string;
  notes: string;
  status: TodoStatus;
  priority: number;
  dueDate: string | null;
  project: string | null;
  context: string | null;
  sourceKind: string | null;
  sourceId: number | null;
  completedAt: string | null;
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
  attachmentCount: number;
  clientId: string | null;
  offline?: boolean;
};

type TodoAttachment = {
  id: string;
  todoId: number | null;
  fileName: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
  kind: OfflineAttachmentKind;
  durationMs: number;
  sortOrder: number;
  thumbnailUrl: string;
  displayUrl: string;
  originalUrl: string;
  audioUrl: string;
  videoUrl: string;
  createdAt: string;
};

type PendingAttachment = {
  localId: string;
  file: File;
  previewUrl: string;
  kind: OfflineAttachmentKind;
  durationMs: number;
  status: "uploading" | "ready" | "error" | "offline";
  attachment: TodoAttachment | null;
  error: string;
};

type TodoDraft = Pick<Todo, "title" | "notes" | "priority"> & {
  dueDate: string;
  project: string;
  context: string;
};

type ProjectDialogState = {
  ids: number[];
  selection: string;
  newProject: string;
  openedFromDetails: boolean;
};

type ProjectDeleteDialogState = {
  name: string;
  mode: "reassign" | "delete";
  targetProject: string;
};

const CREATE_PROJECT = "__create_project__";
const UNASSIGNED_PROJECT = "__unassigned_project__";

const viewLabels: Record<View, string> = {
  open: "Open",
  snoozed: "Snoozed",
  all: "All",
  projects: "Projects",
};

const priorityLabels: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Normal",
  4: "Low",
};

function request<T>(path: string, options?: RequestInit): Promise<T> {
  const formData = typeof FormData !== "undefined" && options?.body instanceof FormData;
  return fetch(path, {
    ...options,
    headers: options?.body && !formData ? { "Content-Type": "application/json", ...(options.headers ?? {}) } : options?.headers,
  }).then(async (response) => {
    const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || "Something went wrong.");
    return payload;
  });
}

const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,.heic,.heif";
const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm";
const MEDIA_ACCEPT = `${IMAGE_ACCEPT},${VIDEO_ACCEPT}`;
const MAX_ATTACHMENTS = 12;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const MAX_AUDIO_DURATION_MS = 30 * 60 * 1000;
const MAX_VIDEO_DURATION_MS = 60 * 60 * 1000;
const MAX_IMAGE_PIXELS = 100_000_000;

type PreparedAttachmentUpload = {
  uploadId: string;
  uploads: {
    original: PrivatePostTarget;
    display: PrivatePostTarget;
    thumbnail: PrivatePostTarget;
  };
};

type PreparedMediaUpload = {
  uploadId: string;
  uploads: { original: PrivatePostTarget };
};

type PrivatePostTarget = { url: string; fields: Record<string, string> };
type OptimizedImage = { blob: Blob; mimeType: "image/webp" | "image/jpeg"; format: "webp" | "jpeg" };

function uploadMimeType(file: File) {
  const supplied = file.type.toLowerCase().trim();
  const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"].includes(supplied)) return supplied;
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension && ["png", "webp", "gif", "heic", "heif"].includes(extension)) return `image/${extension}`;
  return null;
}

async function decodedImage(file: File) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return {
        source: bitmap as CanvasImageSource,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => bitmap.close(),
      };
    } catch {
      // Safari's native image element can decode HEIC even where createImageBitmap cannot.
    }
  }
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  image.src = objectUrl;
  try {
    await image.decode();
    return {
      source: image as CanvasImageSource,
      width: image.naturalWidth,
      height: image.naturalHeight,
      cleanup: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

async function encodedImageFormat(blob: Blob) {
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg" as const;
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "webp" as const;
  return null;
}

function canvasBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("This browser could not optimize the image.")), mimeType, quality);
  });
}

async function canvasOptimizedImage(source: CanvasImageSource, width: number, height: number, maxDimension: number, quality: number): Promise<OptimizedImage> {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  const outputWidth = Math.max(1, Math.round(width * scale));
  const outputHeight = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("This browser cannot process images.");
  context.drawImage(source, 0, 0, outputWidth, outputHeight);
  const webp = await canvasBlob(canvas, "image/webp", quality);
  if (await encodedImageFormat(webp) === "webp") {
    return { blob: webp, mimeType: "image/webp", format: "webp" };
  }

  // Safari may return PNG bytes when WebP was requested. JPEG canvas output is
  // universal, so flatten transparency onto white and use it as the optimized fallback.
  context.globalCompositeOperation = "destination-over";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, outputWidth, outputHeight);
  context.globalCompositeOperation = "source-over";
  const jpeg = await canvasBlob(canvas, "image/jpeg", quality);
  if (await encodedImageFormat(jpeg) !== "jpeg") throw new Error("This browser could not create a compatible optimized image.");
  return { blob: jpeg, mimeType: "image/jpeg", format: "jpeg" };
}

async function imageVariants(file: File) {
  const decoded = await decodedImage(file).catch(() => {
    throw new Error("This image format cannot be read on this device.");
  });
  try {
    const { width, height, source } = decoded;
    if (!width || !height || width * height > MAX_IMAGE_PIXELS) throw new Error("That image is too large to process.");
    const startedAt = performance.now();
    const [display, thumbnail] = await Promise.all([
      canvasOptimizedImage(source, width, height, 2048, 0.82),
      canvasOptimizedImage(source, width, height, 480, 0.75),
    ]);
    console.info("[todo-ui] image variants prepared", {
      inputBytes: file.size,
      displayBytes: display.blob.size,
      thumbnailBytes: thumbnail.blob.size,
      displayFormat: display.format,
      thumbnailFormat: thumbnail.format,
      width,
      height,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return { display, thumbnail, width, height };
  } finally {
    decoded.cleanup();
  }
}

async function postPrivateVariant(target: PrivatePostTarget, body: Blob) {
  const form = new FormData();
  Object.entries(target.fields).forEach(([name, value]) => form.append(name, value));
  form.append("file", body, "upload");
  const response = await fetch(target.url, { method: "POST", mode: "no-cors", body: form });
  if (response.type !== "opaque" && !response.ok) throw new Error(`Private storage rejected an upload (${response.status}).`);
}

function normalizedMediaMimeType(file: File, kind: "audio" | "video") {
  const supplied = file.type.toLowerCase().split(";", 1)[0].trim();
  const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (kind === "audio") {
    if (supplied === "audio/x-wav") return "audio/wav";
    if (["audio/mp4", "audio/webm", "audio/ogg", "audio/mpeg", "audio/wav"].includes(supplied)) return supplied;
    if (extension === "m4a") return "audio/mp4";
    if (extension === "mp3") return "audio/mpeg";
    if (extension && ["webm", "ogg", "wav"].includes(extension)) return `audio/${extension}`;
    throw new Error("Voice memos must be MP4, WebM, Ogg, MP3, or WAV audio.");
  }
  if (["video/mp4", "video/quicktime", "video/webm"].includes(supplied)) return supplied;
  if (extension === "mov") return "video/quicktime";
  if (extension && ["mp4", "webm"].includes(extension)) return `video/${extension}`;
  throw new Error("Videos must be MP4, MOV, or WebM files.");
}

function mediaDuration(file: File, kind: "audio" | "video") {
  return new Promise<number>((resolve, reject) => {
    const media = document.createElement(kind);
    const objectUrl = URL.createObjectURL(file);
    const cleanup = () => {
      media.removeAttribute("src");
      media.load();
      URL.revokeObjectURL(objectUrl);
    };
    const finish = () => {
      const durationMs = Math.round(media.duration * 1000);
      cleanup();
      if (!Number.isFinite(durationMs) || durationMs < 1) reject(new Error(`This ${kind} file's duration could not be read.`));
      else resolve(durationMs);
    };
    media.preload = "metadata";
    media.onloadedmetadata = finish;
    media.onerror = () => {
      cleanup();
      reject(new Error(`This ${kind} file cannot be read on this device.`));
    };
    media.src = objectUrl;
  });
}

async function uploadPrivateMedia(
  file: File,
  kind: "audio" | "video",
  durationMs: number,
  endpoint: string,
  target: Record<string, string>,
  discard: (uploadId: string) => Promise<unknown>,
) {
  const mimeType = normalizedMediaMimeType(file, kind);
  const prepared = await request<PreparedMediaUpload>(endpoint, {
    method: "POST",
    body: JSON.stringify({
      ...target,
      kind,
      fileName: file.name || (kind === "audio" ? "Voice memo" : "Video"),
      mimeType,
      byteSize: file.size,
    }),
  });
  try {
    await postPrivateVariant(prepared.uploads.original, file);
    return await request<{ attachment: TodoAttachment }>(endpoint, {
      method: "PATCH",
      body: JSON.stringify({ ...target, kind, uploadId: prepared.uploadId, durationMs }),
    });
  } catch (error) {
    await discard(prepared.uploadId).catch((discardError) => {
      console.error("[todo-ui] incomplete media cleanup failed", { uploadId: prepared.uploadId, kind, discardError });
    });
    throw error;
  }
}

async function uploadPrivateImage(
  file: File,
  endpoint: string,
  target: Record<string, string>,
  discard: (uploadId: string) => Promise<unknown>,
) {
  const mimeType = uploadMimeType(file);
  if (!mimeType) throw new Error("Choose a JPEG, PNG, WebP, GIF, HEIC, or HEIF image.");
  const variants = await imageVariants(file);
  const prepared = await request<PreparedAttachmentUpload>(endpoint, {
    method: "POST",
    body: JSON.stringify({
      ...target,
      fileName: file.name || "image",
      mimeType,
      byteSize: file.size,
      displayMimeType: variants.display.mimeType,
      thumbnailMimeType: variants.thumbnail.mimeType,
    }),
  });
  try {
    const uploads = await Promise.allSettled([
      postPrivateVariant(prepared.uploads.original, file),
      postPrivateVariant(prepared.uploads.display, variants.display.blob),
      postPrivateVariant(prepared.uploads.thumbnail, variants.thumbnail.blob),
    ]);
    const failed = uploads.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    return await request<{ attachment: TodoAttachment }>(endpoint, {
      method: "PATCH",
      body: JSON.stringify({ ...target, uploadId: prepared.uploadId, width: variants.width, height: variants.height }),
    });
  } catch (error) {
    await discard(prepared.uploadId).catch((discardError) => {
      console.error("[todo-ui] incomplete image cleanup failed", { uploadId: prepared.uploadId, discardError });
    });
    throw error;
  }
}

function AttachmentPicker({
  disabled,
  onFiles,
  onRecord,
  label,
  showLabel = false,
}: {
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  onRecord: () => void;
  label: string;
  showLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const libraryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, [open]);

  function selected(input: HTMLInputElement) {
    const files = [...(input.files ?? [])];
    input.value = "";
    setOpen(false);
    if (files.length) onFiles(files);
  }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        className={classNames(
          "inline-flex h-10 items-center justify-center gap-2 rounded-xl text-[#216e4e] transition hover:bg-[#eaf3ed] focus-visible:outline-2 focus-visible:outline-[#216e4e] disabled:opacity-40",
          showLabel ? "px-3 text-sm font-semibold" : "w-10",
        )}
      >
        <ActionIcon name={showLabel ? "attachment" : "add"} className="h-5 w-5" />
        {showLabel && <span>Add attachment</span>}
      </button>

      {open && (
        <>
          <button type="button" aria-label="Close attachment menu" onClick={() => setOpen(false)} className="fixed inset-0 z-[65] hidden cursor-default sm:block" />
          <div role="menu" className="absolute left-0 top-full z-[70] mt-2 hidden w-56 rounded-xl border border-black/[0.08] bg-white p-1.5 shadow-xl sm:block">
            <button type="button" role="menuitem" onClick={() => libraryRef.current?.click()} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-[#303632] hover:bg-[#f2f5f2]">
              <ActionIcon name="image" />Choose photos or videos
            </button>
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onRecord(); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-[#303632] hover:bg-[#f2f5f2]">
              <ActionIcon name="mic" />Record voice memo
            </button>
          </div>

          <div className="fixed inset-0 z-[70] flex items-end sm:hidden">
            <button type="button" aria-label="Close attachment menu" onClick={() => setOpen(false)} className="absolute inset-0 bg-black/35" />
            <div role="menu" className="relative w-full rounded-t-3xl bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 shadow-2xl">
              <p className="mb-3 px-1 text-sm font-semibold text-[#303632]">Add an attachment</p>
              <button type="button" role="menuitem" onClick={() => libraryRef.current?.click()} className="flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[16px] font-semibold text-[#303632] hover:bg-[#f2f5f2]">
                <ActionIcon name="image" className="h-5 w-5 text-[#216e4e]" />Choose photos or videos
              </button>
              <button type="button" role="menuitem" onClick={() => { setOpen(false); onRecord(); }} className="flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[16px] font-semibold text-[#303632] hover:bg-[#f2f5f2]">
                <ActionIcon name="mic" className="h-5 w-5 text-[#216e4e]" />Record voice memo
              </button>
              <button type="button" onClick={() => setOpen(false)} className="mt-2 h-12 w-full rounded-xl bg-[#f1f2f0] text-[16px] font-semibold text-[#59615c]">Cancel</button>
            </div>
          </div>
        </>
      )}

      <input ref={libraryRef} type="file" accept={MEDIA_ACCEPT} multiple className="sr-only" tabIndex={-1} onChange={(event) => selected(event.currentTarget)} />
    </div>
  );
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function VoiceMemoRecorder({ onClose, onAttach }: { onClose: () => void; onAttach: (file: File, durationMs: number) => void }) {
  const [phase, setPhase] = useState<"idle" | "recording" | "review">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [recording, setRecording] = useState<{ file: File; url: string; durationMs: number } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const cancelledRef = useRef(false);
  const recordingUrlRef = useRef<string | null>(null);

  function releaseStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAtRef.current), 250);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => () => {
    cancelledRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
  }, []);

  async function start() {
    setError("");
    if (!("MediaRecorder" in window) || !navigator.mediaDevices?.getUserMedia) {
      setError("Voice recording is not supported by this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
      const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        if (cancelledRef.current) {
          releaseStream();
          return;
        }
        const durationMs = Math.max(1, Date.now() - startedAtRef.current);
        const recordedType = recorder.mimeType.split(";", 1)[0] || "audio/webm";
        const extension = recordedType === "audio/mp4" ? "m4a" : recordedType === "audio/ogg" ? "ogg" : "webm";
        const blob = new Blob(chunksRef.current, { type: recordedType });
        const file = new File([blob], `Voice memo ${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`, { type: recordedType });
        const url = URL.createObjectURL(file);
        recordingUrlRef.current = url;
        setRecording({ file, url, durationMs });
        setElapsed(durationMs);
        setPhase("review");
        releaseStream();
        console.info("[todo-ui] voice memo recorded", { bytes: file.size, mimeType: recordedType, durationMs });
      };
      recorder.start(1000);
      startedAtRef.current = Date.now();
      setElapsed(0);
      setPhase("recording");
      console.info("[todo-ui] voice recording started", { mimeType: recorder.mimeType });
    } catch (cause) {
      releaseStream();
      setError(cause instanceof DOMException && cause.name === "NotAllowedError" ? "Microphone access was not allowed." : "The microphone could not be started.");
      console.error("[todo-ui] voice recording start failed", cause);
    }
  }

  function stop() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  function rerecord() {
    if (recording) URL.revokeObjectURL(recording.url);
    recordingUrlRef.current = null;
    setRecording(null);
    setElapsed(0);
    setPhase("idle");
    void start();
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="voice-recorder-title">
      <button type="button" onClick={onClose} aria-label="Close voice recorder" className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />
      <div className="relative w-full rounded-t-3xl bg-white p-5 shadow-2xl sm:max-w-md sm:rounded-3xl sm:p-6">
        <div className="flex items-center justify-between">
          <h3 id="voice-recorder-title" className="text-lg font-semibold text-[#202522]">Voice memo</h3>
          <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full bg-[#f1f2f0] text-[#4f5752]" aria-label="Close"><ActionIcon name="close" /></button>
        </div>
        <div className="my-7 text-center">
          <div className={classNames("mx-auto mb-4 grid h-20 w-20 place-items-center rounded-full", phase === "recording" ? "animate-pulse bg-red-100 text-red-700" : "bg-[#eaf3ed] text-[#216e4e]")}>
            <ActionIcon name={phase === "recording" ? "stop" : "mic"} className="h-9 w-9" />
          </div>
          <p className="font-mono text-3xl font-semibold tabular-nums text-[#202522]">{formatDuration(elapsed)}</p>
          <p className="mt-2 text-sm text-[#7b837e]">{phase === "idle" ? "Ready when you are" : phase === "recording" ? "Recording…" : "Review before attaching"}</p>
        </div>
        {recording && <audio controls src={recording.url} className="mb-5 w-full" preload="metadata" />}
        {error && <p role="alert" className="mb-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {phase === "idle" ? (
          <button type="button" onClick={() => void start()} className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#216e4e] text-sm font-semibold text-white"><ActionIcon name="mic" />Start recording</button>
        ) : phase === "recording" ? (
          <button type="button" onClick={stop} className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-red-700 text-sm font-semibold text-white"><ActionIcon name="stop" />Finish recording</button>
        ) : (
          <div className="flex gap-2">
            <button type="button" onClick={rerecord} className="h-12 flex-1 rounded-xl bg-[#f1f2f0] text-sm font-semibold text-[#59615c]">Re-record</button>
            <button type="button" onClick={() => { if (recording) onAttach(recording.file, recording.durationMs); }} disabled={!recording || recording.file.size > MAX_AUDIO_BYTES || recording.durationMs > MAX_AUDIO_DURATION_MS} className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-[#216e4e] text-sm font-semibold text-white disabled:opacity-50"><ActionIcon name="attachment" />Attach</button>
          </div>
        )}
      </div>
    </div>
  );
}

function isTodayOrOverdue(value: string | null) {
  if (!value) return false;
  const due = new Date(value);
  if (Number.isNaN(due.valueOf())) return false;
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return due <= end;
}

function isSnoozed(todo: Todo, now: number) {
  return todo.status === "open" && Boolean(todo.snoozedUntil) && new Date(todo.snoozedUntil as string).valueOf() > now;
}

function dueLabel(value: string) {
  const due = new Date(value);
  if (Number.isNaN(due.valueOf())) return value;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).valueOf();
  const date = new Date(due.getFullYear(), due.getMonth(), due.getDate()).valueOf();
  const day = 86_400_000;
  if (date < today) return `Overdue · ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(due)}`;
  if (date === today) return "Due today";
  if (date === today + day) return "Due tomorrow";
  return `Due ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(due)}`;
}

function snoozeLabel(value: string) {
  const wake = new Date(value);
  if (Number.isNaN(wake.valueOf())) return "Snoozed";
  return `Wakes ${new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(wake)}`;
}

function dateInputValue(value: string | null) {
  return value?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
}

function compareSmart(a: Todo, b: Todo) {
  const aDue = a.dueDate ? new Date(a.dueDate).valueOf() : Number.POSITIVE_INFINITY;
  const bDue = b.dueDate ? new Date(b.dueDate).valueOf() : Number.POSITIVE_INFINITY;
  if (aDue !== bDue) return aDue - bDue;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return new Date(b.updatedAt).valueOf() - new Date(a.updatedAt).valueOf();
}

function matchesView(todo: Todo, view: View, now: number) {
  const snoozed = isSnoozed(todo, now);
  if (view === "open") return todo.status === "open" && !snoozed;
  if (view === "snoozed") return snoozed;
  if (view === "all") return todo.status === "open" || todo.status === "completed";
  return false;
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function offlineRecordTodo(record: OfflineTodoRecord): Todo {
  return {
    id: record.localId,
    clientId: record.clientId,
    title: record.title,
    notes: record.notes,
    status: "open",
    priority: 3,
    dueDate: null,
    project: null,
    context: null,
    sourceKind: "offline",
    sourceId: null,
    completedAt: null,
    snoozedUntil: null,
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
    attachmentCount: record.attachments.length,
    offline: true,
  };
}

function todoActionIcon(action: TodoAction | "assign", label: string): ActionIconName {
  if (action === "complete") return "done";
  if (action === "snooze") return "snooze";
  if (action === "delete") return "delete";
  if (action === "assign") return "move";
  if (label === "Wake") return "wake";
  if (label === "Open") return "open";
  return "restore";
}

function TaskRow({
  todo,
  selected,
  now,
  onSelect,
  onAction,
  onProject,
  onOpen,
}: {
  todo: Todo;
  selected: boolean;
  now: number;
  onSelect: (todo: Todo) => void;
  onAction: (todo: Todo, action: TodoAction, source: "hover" | "swipe") => void;
  onProject: (todo: Todo, source: "hover" | "swipe") => void;
  onOpen: (todo: Todo) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [swipeWidth, setSwipeWidth] = useState(1);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{ startX: number; startY: number; width: number } | null>(null);
  const offsetRef = useRef(0);
  const suppressOpenRef = useRef(false);
  const pending = todo.id < 0;
  const snoozed = isSnoozed(todo, now);
  const primaryAction: { action: TodoAction; label: string; icon: ActionIconName } = todo.status === "open"
    ? { action: "complete", label: "Done", icon: "done" }
    : { action: "unsnooze", label: "Open", icon: "open" };
  const leftSecondaryAction: { action: TodoAction; label: string; icon: ActionIconName } = todo.status === "completed"
    ? primaryAction
    : snoozed
      ? { action: "unsnooze", label: "Wake", icon: "wake" }
      : { action: "snooze", label: "Snooze", icon: "snooze" };
  const swipeRatio = Math.abs(offset) / swipeWidth;
  const longSwipe = swipeRatio >= 0.5;
  const revealAction = offset < 0
    ? (longSwipe ? leftSecondaryAction.label : primaryAction.label)
    : (longSwipe ? "Delete" : "Assign project");
  const revealIcon: ActionIconName = offset < 0
    ? (longSwipe ? leftSecondaryAction.icon : primaryAction.icon)
    : (longSwipe ? "delete" : "move");
  const revealClass = offset < 0
    ? longSwipe && (leftSecondaryAction.icon === "snooze" || leftSecondaryAction.icon === "wake") ? "bg-amber-500" : "bg-[#216e4e]"
    : longSwipe ? "bg-red-600" : "bg-slate-500";

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (pending || event.pointerType !== "touch") return;
    if ((event.target as HTMLElement).closest("input, [data-row-action], a, select, textarea")) return;
    suppressOpenRef.current = false;
    const width = event.currentTarget.getBoundingClientRect().width;
    gesture.current = {
      startX: event.clientX,
      startY: event.clientY,
      width,
    };
    setSwipeWidth(width);
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active) return;
    const deltaX = event.clientX - active.startX;
    const deltaY = event.clientY - active.startY;
    if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 10) {
      gesture.current = null;
      setDragging(false);
      offsetRef.current = 0;
      setOffset(0);
      return;
    }
    const limit = active.width * 0.62;
    if (Math.abs(deltaX) > 8) suppressOpenRef.current = true;
    const nextOffset = Math.max(-limit, Math.min(limit, deltaX));
    offsetRef.current = nextOffset;
    setOffset(nextOffset);
  }

  function finishSwipe() {
    const active = gesture.current;
    gesture.current = null;
    setDragging(false);
    if (!active) {
      setOffset(0);
      return;
    }
    const completedOffset = offsetRef.current;
    const ratio = Math.abs(completedOffset) / active.width;
    const direction = Math.sign(completedOffset);
    offsetRef.current = 0;
    setOffset(0);
    if (ratio < 0.18 || direction === 0) return;
    if (direction < 0) onAction(todo, ratio >= 0.5 ? leftSecondaryAction.action : primaryAction.action, "swipe");
    else if (ratio >= 0.5) onAction(todo, "delete", "swipe");
    else onProject(todo, "swipe");
  }

  function cancelSwipe() {
    gesture.current = null;
    offsetRef.current = 0;
    setDragging(false);
    setOffset(0);
  }

  const hoverActions: Array<{ action: TodoAction | "assign"; label: string; icon: ActionIconName }> = [
    primaryAction,
    ...(todo.status === "open" ? [leftSecondaryAction] : []),
    { action: "assign", label: "Assign project", icon: "move" },
    { action: "delete", label: "Delete", icon: "delete" },
  ];

  return (
    <li className={classNames("group relative overflow-hidden", selected && "ring-1 ring-inset ring-[#216e4e]/30")}>
      <div className={classNames("absolute inset-0 flex items-center justify-between px-5 text-sm font-semibold text-white md:hidden", revealClass)} aria-hidden="true">
        <span className={classNames("inline-flex items-center gap-2 transition-opacity", offset > 0 ? "opacity-100" : "opacity-0")}><ActionIcon name={revealIcon} />{revealAction}</span>
        <span className={classNames("inline-flex items-center gap-2 transition-opacity", offset < 0 ? "opacity-100" : "opacity-0")}><ActionIcon name={revealIcon} />{revealAction}</span>
      </div>
      <div
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={finishSwipe}
        onPointerCancel={cancelSwipe}
        style={{ transform: `translateX(${offset}px)` }}
        className={classNames(
          "relative flex min-h-[72px] touch-pan-y items-start gap-3 bg-white px-4 py-4 hover:bg-[#fafbf9] sm:px-5",
          !dragging && "transition-transform duration-200 ease-out",
          selected && "bg-[#f3f8f5] hover:bg-[#f3f8f5]",
        )}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onSelect(todo)}
          disabled={pending || todo.offline}
          aria-label={`Select: ${todo.title}`}
          className={classNames("mt-0.5 h-5 w-5 shrink-0 cursor-pointer rounded border-[#9da6a0] accent-[#216e4e] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e]", pending && "animate-pulse")}
        />
        <button
          type="button"
          onClick={() => {
            if (suppressOpenRef.current) {
              suppressOpenRef.current = false;
              return;
            }
            onOpen(todo);
          }}
          disabled={pending}
          aria-label={`Open details: ${todo.title}`}
          className="min-w-0 flex-1 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#216e4e] disabled:cursor-default"
        >
          <div className="flex min-w-0 items-start gap-2">
            <p className={classNames("min-w-0 flex-1 whitespace-pre-wrap text-[15px] leading-5 text-[#202522]", todo.status === "completed" && "text-[#8b928e] line-through")}>{todo.title}</p>
            {todo.attachmentCount > 0 && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#eef2ef] px-1.5 py-0.5 text-[10px] font-medium text-[#68716b]"><ActionIcon name="attachment" className="h-3 w-3" />{todo.attachmentCount}</span>}
          </div>
          {todo.notes && <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs leading-5 text-[#7c847f]">{todo.notes}</p>}
          {(todo.project || todo.context || todo.dueDate || todo.priority <= 2 || snoozed || todo.offline) && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#747c77]">
              {todo.priority <= 2 && <span className={classNames("rounded-full px-2 py-0.5 font-medium", todo.priority === 1 ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700")}>{priorityLabels[todo.priority]}</span>}
              {todo.project && <span className="rounded-full bg-[#f0f2ef] px-2 py-0.5">{todo.project}</span>}
              {todo.context && <span>{todo.context}</span>}
              {todo.dueDate && <span className={classNames(isTodayOrOverdue(todo.dueDate) && todo.status === "open" && !snoozed && "font-medium text-red-600")}>{dueLabel(todo.dueDate)}</span>}
              {snoozed && todo.snoozedUntil && <span className="font-medium text-amber-700">{snoozeLabel(todo.snoozedUntil)}</span>}
              {todo.offline && <span className="inline-flex items-center gap-1 font-medium text-amber-700"><ActionIcon name="retry" className="h-3 w-3" />Waiting to sync</span>}
            </div>
          )}
        </button>
        {!pending && !todo.offline && (
          <div className="hidden shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 md:flex">
            {hoverActions.map(({ action, label, icon }) => (
              <button
                key={action}
                type="button"
                data-row-action
                onClick={() => action === "assign" ? onProject(todo, "hover") : onAction(todo, action, "hover")}
                aria-label={`${label}: ${todo.title}`}
                title={label}
                className={classNames(
                  "grid h-9 w-9 place-items-center rounded-lg text-[#69716c] transition hover:bg-[#eef0ed] hover:text-[#252a27] focus-visible:outline-2 focus-visible:outline-[#216e4e]",
                  (action === "complete" || action === "unsnooze") && "hover:bg-emerald-50 hover:text-emerald-700",
                  action === "snooze" && "hover:bg-amber-50 hover:text-amber-700",
                  action === "delete" && "hover:bg-red-50 hover:text-red-700",
                )}
              >
                <ActionIcon name={icon} className="h-[18px] w-[18px]" />
                <span className="sr-only">{label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

export default function Home() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("open");
  const [registeredProjects, setRegisteredProjects] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("");
  const [priority, setPriority] = useState("");
  const [sort, setSort] = useState<Sort>("smart");
  const [newTitle, setNewTitle] = useState("");
  const [captureDraftToken, setCaptureDraftToken] = useState(() => crypto.randomUUID());
  const [captureAttachments, setCaptureAttachments] = useState<PendingAttachment[]>([]);
  const [adding, setAdding] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<TodoDraft | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [detailAttachments, setDetailAttachments] = useState<TodoAttachment[]>([]);
  const [detailUploads, setDetailUploads] = useState<PendingAttachment[]>([]);
  const [voiceTarget, setVoiceTarget] = useState<"capture" | "detail" | null>(null);
  const [online, setOnline] = useState(true);
  const [offlineCount, setOfflineCount] = useState(0);
  const [imageDropActive, setImageDropActive] = useState(false);
  const [loadingAttachments, setLoadingAttachments] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [projectDialog, setProjectDialog] = useState<ProjectDialogState | null>(null);
  const [projectDialogError, setProjectDialogError] = useState("");
  const [savingProject, setSavingProject] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectError, setNewProjectError] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectDeleteDialog, setProjectDeleteDialog] = useState<ProjectDeleteDialogState | null>(null);
  const [projectDeleteError, setProjectDeleteError] = useState("");
  const [deletingProject, setDeletingProject] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const captureRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const viewerGesture = useRef<number | null>(null);
  const imageDropDepth = useRef(0);
  const syncingOfflineRef = useRef(false);
  const overlayOpen = editingId !== null || projectDialog !== null || newProjectOpen || projectDeleteDialog !== null || filtersOpen || viewerIndex !== null || voiceTarget !== null;

  const routeDroppedAttachments = useEffectEvent((files: File[]) => {
    const destination = editingId !== null ? "task" : "quick-add";
    if (editingId !== null) void queueDetailAttachments(files);
    else {
      void queueCaptureAttachments(files);
      captureRef.current?.focus();
    }
    console.info("[todo-ui] dropped attachments routed", {
      destination,
      count: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    });
  });

  useEffect(() => {
    let active = true;
    const load = async () => {
      const [offlineRecords, cachedState] = await Promise.all([
        listOfflineTodos().catch((error) => {
          console.error("[todo-offline] queue load failed", error);
          return [];
        }),
        loadCachedServerState<Todo>().catch((error) => {
          console.error("[todo-offline] cached state load failed", error);
          return null;
        }),
      ]);
      const server = await Promise.all([
        request<{ todos: Todo[] }>("/api/todos"),
        request<{ projects: string[] }>("/api/projects"),
      ]).catch((error) => {
        console.warn("[todo-ui] server load unavailable", { online: navigator.onLine, error });
        return null;
      });
      if (!active) return;
      const loaded = server?.[0].todos ?? cachedState?.todos ?? [];
      const loadedProjects = server?.[1].projects ?? cachedState?.projects ?? [];
      const serverClientIds = new Set(loaded.map((todo) => todo.clientId).filter(Boolean));
      const pendingRecords = offlineRecords.filter((record) => !serverClientIds.has(record.clientId));
      const alreadySynced = offlineRecords.filter((record) => serverClientIds.has(record.clientId));
      await Promise.all(alreadySynced.map((record) => deleteOfflineTodo(record.clientId))).catch((error) => {
        console.error("[todo-offline] reconciled queue cleanup failed", error);
      });
      if (!active) return;
      setTodos([...pendingRecords.map(offlineRecordTodo), ...loaded]);
      setOfflineCount(pendingRecords.length);
      setRegisteredProjects(loadedProjects);
      if (server) void saveCachedServerState(loaded, loadedProjects);
      if (!server) setNotice({ tone: "success", text: pendingRecords.length ? "Offline — showing tasks waiting to sync." : "Offline — new tasks will sync when you reconnect." });
      console.info("[todo-ui] loaded", {
        count: loaded.length,
        offlinePending: pendingRecords.length,
        reconciled: alreadySynced.length,
        projects: loadedProjects.length,
        open: loaded.filter((todo) => todo.status === "open").length,
        completed: loaded.filter((todo) => todo.status === "completed").length,
        snoozed: loaded.filter((todo) => isSnoozed(todo, Date.now())).length,
      });
    };
    void load()
      .catch((error: Error) => active && setNotice({ tone: "error", text: error.message }))
      .finally(() => active && setLoading(false));
    void persistOfflineStorage();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (online && offlineCount > 0) void syncOfflineQueue();
  }, [online, offlineCount]);

  useEffect(() => {
    const updateConnection = () => {
      const next = navigator.onLine;
      setOnline(next);
      console.info("[todo-offline] connection changed", { online: next });
    };
    updateConnection();
    window.addEventListener("online", updateConnection);
    window.addEventListener("offline", updateConnection);
    return () => {
      window.removeEventListener("online", updateConnection);
      window.removeEventListener("offline", updateConnection);
    };
  }, []);

  useEffect(() => {
    if (!loading) void saveCachedServerState(todos.filter((todo) => !todo.offline), registeredProjects).catch((error) => {
      console.error("[todo-offline] server snapshot update failed", error);
    });
  }, [loading, registeredProjects, todos]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.undoToken ? 8_000 : 5_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      const imageCount = detailAttachments.filter((attachment) => attachment.kind === "image").length;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key.toLowerCase() === "n" && !typing) {
        event.preventDefault();
        captureRef.current?.focus();
      }
      if (event.key === "Escape" && voiceTarget !== null) {
        setVoiceTarget(null);
      } else if (event.key === "Escape" && viewerIndex !== null) {
        setViewerIndex(null);
      } else if (event.key === "ArrowLeft" && viewerIndex !== null && imageCount > 1) {
        setViewerIndex((current) => current === null ? null : (current - 1 + imageCount) % imageCount);
      } else if (event.key === "ArrowRight" && viewerIndex !== null && imageCount > 1) {
        setViewerIndex((current) => current === null ? null : (current + 1) % imageCount);
      } else if (event.key === "Escape" && projectDeleteDialog !== null) {
        setProjectDeleteDialog(null);
        setProjectDeleteError("");
      } else if (event.key === "Escape" && newProjectOpen) {
        setNewProjectOpen(false);
        setNewProjectName("");
        setNewProjectError("");
      } else if (event.key === "Escape" && projectDialog !== null) {
        setProjectDialog(null);
        setProjectDialogError("");
      } else if (event.key === "Escape" && editingId !== null) {
        setEditingId(null);
        setEditDraft(null);
      } else if (event.key === "Escape" && target === searchRef.current) {
        setQuery("");
        searchRef.current?.blur();
      } else if (event.key === "Escape" && filtersOpen) {
        setFiltersOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [detailAttachments, editingId, filtersOpen, newProjectOpen, projectDeleteDialog, projectDialog, viewerIndex, voiceTarget]);

  useEffect(() => {
    if (!overlayOpen) return;
    const body = document.body;
    const previousOverflow = body.style.overflow;
    const previousPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
    return () => {
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPaddingRight;
    };
  }, [overlayOpen]);

  useEffect(() => {
    const includesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const dragEnter = (event: DragEvent) => {
      if (!includesFiles(event)) return;
      event.preventDefault();
      imageDropDepth.current += 1;
      setImageDropActive(true);
    };
    const dragOver = (event: DragEvent) => {
      if (!includesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const dragLeave = () => {
      if (imageDropDepth.current === 0) return;
      imageDropDepth.current = Math.max(0, imageDropDepth.current - 1);
      if (imageDropDepth.current === 0) setImageDropActive(false);
    };
    const resetDrag = () => {
      imageDropDepth.current = 0;
      setImageDropActive(false);
    };
    const drop = (event: DragEvent) => {
      if (!includesFiles(event)) return;
      event.preventDefault();
      const files = [...(event.dataTransfer?.files ?? [])];
      resetDrag();
      if (!files.length) return;
      routeDroppedAttachments(files);
    };
    window.addEventListener("dragenter", dragEnter);
    window.addEventListener("dragover", dragOver);
    window.addEventListener("dragleave", dragLeave);
    window.addEventListener("drop", drop);
    window.addEventListener("dragend", resetDrag);
    return () => {
      window.removeEventListener("dragenter", dragEnter);
      window.removeEventListener("dragover", dragOver);
      window.removeEventListener("dragleave", dragLeave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("dragend", resetDrag);
    };
  }, []);

  const projects = useMemo(
    () => [...new Set([
      ...registeredProjects,
      ...todos.map((todo) => todo.project).filter((value): value is string => Boolean(value)),
    ])].sort((a, b) => a.localeCompare(b)),
    [registeredProjects, todos],
  );

  const projectOptions = useMemo(() => {
    const projectCounts = new Map<string, { open: number; snoozed: number; done: number }>(
      registeredProjects.map((name) => [name, { open: 0, snoozed: 0, done: 0 }]),
    );
    todos.forEach((todo) => {
      if (!todo.project) return;
      const counts = projectCounts.get(todo.project) ?? { open: 0, snoozed: 0, done: 0 };
      if (todo.status === "completed") counts.done += 1;
      else if (isSnoozed(todo, now)) counts.snoozed += 1;
      else counts.open += 1;
      projectCounts.set(todo.project, counts);
    });
    return [...projectCounts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [registeredProjects, todos, now]);

  const counts = useMemo(() => ({
    open: todos.filter((todo) => matchesView(todo, "open", now)).length,
    snoozed: todos.filter((todo) => matchesView(todo, "snoozed", now)).length,
    all: todos.filter((todo) => matchesView(todo, "all", now)).length,
    projects: projectOptions.length,
  }), [projectOptions.length, todos, now]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const projectFilterApplies = view === "open" || view === "snoozed" || view === "all";
    const rows = todos.filter((todo) => {
      const searchable = [todo.title, todo.notes, todo.project, todo.context].filter(Boolean).join(" ").toLowerCase();
      return matchesView(todo, view, now)
        && (!needle || searchable.includes(needle))
        && (!projectFilterApplies || !project || (project === UNASSIGNED_PROJECT ? !todo.project : todo.project === project))
        && (!priority || todo.priority === Number(priority));
    });
    return [...rows].sort((a, b) => {
      if (sort === "priority") return a.priority - b.priority || compareSmart(a, b);
      if (sort === "due") return (a.dueDate ? new Date(a.dueDate).valueOf() : Infinity) - (b.dueDate ? new Date(b.dueDate).valueOf() : Infinity);
      if (sort === "newest") return new Date(b.createdAt).valueOf() - new Date(a.createdAt).valueOf();
      if (sort === "oldest") return new Date(a.createdAt).valueOf() - new Date(b.createdAt).valueOf();
      if (sort === "az") return a.title.localeCompare(b.title);
      return compareSmart(a, b);
    });
  }, [todos, view, query, project, priority, sort, now]);

  const selectedIds = useMemo(() => [...selected], [selected]);
  const selectedTodos = useMemo(() => todos.filter((todo) => selected.has(todo.id)), [selected, todos]);
  const allVisibleSelected = filtered.length > 0 && filtered.every((todo) => selected.has(todo.id));
  const projectFilterApplies = view === "open" || view === "snoozed" || view === "all";
  const filtersActive = Boolean(query || (projectFilterApplies && project) || priority || sort !== "smart");
  const mobileFilterCount = Number(Boolean(project) && projectFilterApplies) + Number(Boolean(priority)) + Number(sort !== "smart");
  const editingTodo = editingId === null ? null : todos.find((todo) => todo.id === editingId) ?? null;
  const imageAttachments = detailAttachments.filter((attachment) => attachment.kind === "image");
  const viewerAttachment = viewerIndex === null ? null : imageAttachments[viewerIndex] ?? null;

  function resizeCapture(textarea: HTMLTextAreaElement) {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 120 ? "auto" : "hidden";
  }

  function clipboardImages(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    return [...event.clipboardData.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
  }

  function selectedAttachmentKind(file: File): "image" | "video" | null {
    if (uploadMimeType(file)) return "image";
    try {
      normalizedMediaMimeType(file, "video");
      return "video";
    } catch {
      return null;
    }
  }

  function validateSelectedAttachments(files: File[], existingCount: number) {
    const slots = Math.max(0, MAX_ATTACHMENTS - existingCount);
    if (!slots) {
      setNotice({ tone: "error", text: `Tasks are limited to ${MAX_ATTACHMENTS} attachments.` });
      return [];
    }
    const accepted = files.slice(0, slots).filter((file) => {
      const kind = selectedAttachmentKind(file);
      if (!kind) {
        setNotice({ tone: "error", text: "Choose a supported photo or video." });
        return false;
      }
      const maximumBytes = kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
      if (file.size > maximumBytes) {
        setNotice({ tone: "error", text: `${file.name || `A ${kind}`} is larger than ${kind === "image" ? "20 MB" : "250 MB"}.` });
        return false;
      }
      return true;
    });
    if (files.length > slots) setNotice({ tone: "error", text: `Only ${MAX_ATTACHMENTS} attachments can be added to a task.` });
    return accepted;
  }

  async function pendingAttachments(files: File[]) {
    const items: PendingAttachment[] = [];
    for (const file of files) {
      const kind = selectedAttachmentKind(file);
      if (!kind) continue;
      let durationMs = 0;
      if (kind === "video") {
        try {
          durationMs = await mediaDuration(file, "video");
        } catch (error) {
          setNotice({ tone: "error", text: error instanceof Error ? error.message : "That video could not be read." });
          console.error("[todo-ui] selected video metadata failed", { bytes: file.size, mimeType: file.type, error });
          continue;
        }
      }
      if (kind === "video" && durationMs > MAX_VIDEO_DURATION_MS) {
        setNotice({ tone: "error", text: `${file.name || "That video"} is longer than 60 minutes.` });
        continue;
      }
      items.push({
        localId: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
        kind,
        durationMs,
        status: navigator.onLine ? "uploading" : "offline",
        attachment: null,
        error: "",
      });
    }
    return items;
  }

  async function uploadCaptureAttachment(item: PendingAttachment, draftToken: string) {
    try {
      const endpoint = "/api/attachments/drafts";
      const discard = (uploadId: string) => request(`/api/attachments/drafts/${uploadId}?discard=1`, {
        method: "DELETE",
        body: JSON.stringify({ draftToken }),
      });
      const { attachment } = item.kind === "image"
        ? await uploadPrivateImage(item.file, endpoint, { draftToken }, discard)
        : await uploadPrivateMedia(item.file, item.kind, item.durationMs, endpoint, { draftToken }, discard);
      setCaptureAttachments((current) => current.map((candidate) => candidate.localId === item.localId
        ? { ...candidate, status: "ready", attachment, error: "" }
        : candidate));
      console.info("[todo-ui] draft attachment uploaded", { attachmentId: attachment.id, kind: item.kind, bytes: attachment.byteSize });
    } catch (error) {
      const wentOffline = !navigator.onLine;
      const message = error instanceof Error ? error.message : "The attachment could not be uploaded.";
      setCaptureAttachments((current) => current.map((candidate) => candidate.localId === item.localId
        ? { ...candidate, status: wentOffline ? "offline" : "error", error: wentOffline ? "Waiting for a connection" : message }
        : candidate));
      console.error("[todo-ui] draft attachment upload failed", { localId: item.localId, kind: item.kind, bytes: item.file.size, wentOffline, error });
    }
  }

  async function queueCaptureAttachments(inputFiles: File[]) {
    const files = validateSelectedAttachments(inputFiles, captureAttachments.length);
    if (!files.length) return;
    const items = await pendingAttachments(files);
    if (!items.length) return;
    setCaptureAttachments((current) => [...current, ...items]);
    console.info("[todo-ui] capture attachments queued", { count: items.length, online: navigator.onLine, kinds: items.map((item) => item.kind), totalBytes: files.reduce((sum, file) => sum + file.size, 0) });
    if (!navigator.onLine) return;
    void (async () => {
      for (const item of items) await uploadCaptureAttachment(item, captureDraftToken);
    })();
  }

  function queueCaptureVoice(file: File, durationMs: number) {
    if (captureAttachments.length >= MAX_ATTACHMENTS) {
      setNotice({ tone: "error", text: `Tasks are limited to ${MAX_ATTACHMENTS} attachments.` });
      return;
    }
    const item: PendingAttachment = {
      localId: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
      kind: "audio",
      durationMs,
      status: navigator.onLine ? "uploading" : "offline",
      attachment: null,
      error: "",
    };
    setCaptureAttachments((current) => [...current, item]);
    setVoiceTarget(null);
    if (navigator.onLine) void uploadCaptureAttachment(item, captureDraftToken);
    console.info("[todo-ui] voice memo queued", { destination: "quick-add", bytes: file.size, durationMs, online: navigator.onLine });
  }

  function retryCaptureAttachment(item: PendingAttachment) {
    setCaptureAttachments((current) => current.map((candidate) => candidate.localId === item.localId
      ? { ...candidate, status: "uploading", error: "" }
      : candidate));
    void uploadCaptureAttachment({ ...item, status: "uploading", error: "" }, captureDraftToken);
  }

  async function removeCaptureAttachment(item: PendingAttachment) {
    if (item.status === "uploading") return;
    if (item.attachment) {
      try {
        await request(`/api/attachments/drafts/${item.attachment.id}`, {
          method: "DELETE",
          body: JSON.stringify({ draftToken: captureDraftToken }),
        });
      } catch (error) {
        setNotice({ tone: "error", text: error instanceof Error ? error.message : "The attachment could not be removed." });
        return;
      }
    }
    URL.revokeObjectURL(item.previewUrl);
    setCaptureAttachments((current) => current.filter((candidate) => candidate.localId !== item.localId));
  }

  async function loadTaskAttachments(todoId: number) {
    setLoadingAttachments(true);
    setAttachmentError("");
    try {
      const { attachments } = await request<{ attachments: TodoAttachment[] }>(`/api/todos/${todoId}/attachments`);
      setDetailAttachments(attachments);
      console.info("[todo-ui] task gallery loaded", { todoId, count: attachments.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The attachments could not be loaded.";
      setAttachmentError(message);
      console.error("[todo-ui] task gallery load failed", { todoId, error });
    } finally {
      setLoadingAttachments(false);
    }
  }

  async function uploadDetailAttachment(todoId: number, item: PendingAttachment) {
    try {
      const endpoint = `/api/todos/${todoId}/attachments`;
      const discard = (uploadId: string) => request(`${endpoint}/${uploadId}?discard=1`, { method: "DELETE" });
      const { attachment } = item.kind === "image"
        ? await uploadPrivateImage(item.file, endpoint, {}, discard)
        : await uploadPrivateMedia(item.file, item.kind, item.durationMs, endpoint, {}, discard);
      setDetailUploads((current) => {
        const found = current.find((candidate) => candidate.localId === item.localId);
        if (found) URL.revokeObjectURL(found.previewUrl);
        return current.filter((candidate) => candidate.localId !== item.localId);
      });
      setDetailAttachments((current) => [...current, attachment]);
      setTodos((current) => current.map((todo) => todo.id === todoId ? { ...todo, attachmentCount: todo.attachmentCount + 1 } : todo));
      console.info("[todo-ui] task attachment uploaded", { todoId, attachmentId: attachment.id, kind: item.kind, bytes: attachment.byteSize });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The attachment could not be uploaded.";
      setDetailUploads((current) => current.map((candidate) => candidate.localId === item.localId
        ? { ...candidate, status: "error", error: message }
        : candidate));
      console.error("[todo-ui] task attachment upload failed", { todoId, localId: item.localId, kind: item.kind, bytes: item.file.size, error });
    }
  }

  async function queueDetailAttachments(inputFiles: File[]) {
    if (!editingTodo) return;
    if (!navigator.onLine) {
      setNotice({ tone: "error", text: "Attachments can be added to a new offline task. Existing tasks need a connection." });
      return;
    }
    const files = validateSelectedAttachments(inputFiles, detailAttachments.length + detailUploads.length);
    if (!files.length) return;
    const items = await pendingAttachments(files);
    setDetailUploads((current) => [...current, ...items]);
    const todoId = editingTodo.id;
    void (async () => {
      for (const item of items) await uploadDetailAttachment(todoId, item);
    })();
  }

  function queueDetailVoice(file: File, durationMs: number) {
    if (!editingTodo) return;
    if (!navigator.onLine) {
      setVoiceTarget(null);
      setNotice({ tone: "error", text: "Attachments can be added to a new offline task. Existing tasks need a connection." });
      return;
    }
    const item: PendingAttachment = {
      localId: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
      kind: "audio",
      durationMs,
      status: "uploading",
      attachment: null,
      error: "",
    };
    setDetailUploads((current) => [...current, item]);
    setVoiceTarget(null);
    void uploadDetailAttachment(editingTodo.id, item);
    console.info("[todo-ui] voice memo queued", { destination: "task", todoId: editingTodo.id, bytes: file.size, durationMs });
  }

  function retryDetailAttachment(item: PendingAttachment) {
    if (!editingTodo) return;
    setDetailUploads((current) => current.map((candidate) => candidate.localId === item.localId
      ? { ...candidate, status: "uploading", error: "" }
      : candidate));
    void uploadDetailAttachment(editingTodo.id, { ...item, status: "uploading", error: "" });
  }

  function removeDetailUpload(item: PendingAttachment) {
    if (item.status === "uploading") return;
    URL.revokeObjectURL(item.previewUrl);
    setDetailUploads((current) => current.filter((candidate) => candidate.localId !== item.localId));
  }

  async function deleteDetailAttachment(attachment: TodoAttachment) {
    if (!editingTodo || syncing) return;
    setSyncing(true);
    try {
      const result = await request<{ attachmentId: string; undoToken: string }>(`/api/todos/${editingTodo.id}/attachments/${attachment.id}`, { method: "DELETE" });
      setDetailAttachments((current) => current.filter((item) => item.id !== attachment.id));
      setTodos((current) => current.map((todo) => todo.id === editingTodo.id
        ? { ...todo, attachmentCount: Math.max(0, todo.attachmentCount - 1) }
        : todo));
      setViewerIndex(null);
      setNotice({ tone: "success", text: `${attachment.kind === "audio" ? "Voice memo" : attachment.kind === "video" ? "Video" : "Image"} deleted.`, undoToken: result.undoToken });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The attachment could not be deleted." });
    } finally {
      setSyncing(false);
    }
  }

  function resetCapture() {
    setNewTitle("");
    captureAttachments.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    setCaptureAttachments([]);
    setCaptureDraftToken(crypto.randomUUID());
    if (captureRef.current) {
      captureRef.current.style.height = "auto";
      captureRef.current.style.overflowY = "hidden";
    }
  }

  async function syncOfflineQueue() {
    if (syncingOfflineRef.current || !navigator.onLine) return;
    syncingOfflineRef.current = true;
    const startedAt = Date.now();
    try {
      const records = await listOfflineTodos();
      if (!records.length) {
        setOfflineCount(0);
        return;
      }
      console.info("[todo-offline] sync started", { count: records.length });
      const { todos: currentServerTodos } = await request<{ todos: Todo[] }>("/api/todos");
      const byClientId = new Map(currentServerTodos.map((todo) => [todo.clientId, todo]));
      let synced = 0;
      for (const record of records) {
        try {
          let todo = byClientId.get(record.clientId);
          if (!todo) {
            const draftToken = crypto.randomUUID();
            const attachmentIds: string[] = [];
            for (const stored of record.attachments) {
              const file = new File([stored.blob], stored.fileName, { type: stored.mimeType, lastModified: new Date(record.createdAt).valueOf() });
              const endpoint = "/api/attachments/drafts";
              const discard = (uploadId: string) => request(`/api/attachments/drafts/${uploadId}?discard=1`, {
                method: "DELETE",
                body: JSON.stringify({ draftToken }),
              });
              const uploaded = stored.kind === "image"
                ? await uploadPrivateImage(file, endpoint, { draftToken }, discard)
                : await uploadPrivateMedia(file, stored.kind, stored.durationMs, endpoint, { draftToken }, discard);
              attachmentIds.push(uploaded.attachment.id);
              console.info("[todo-offline] attachment synchronized", { clientId: record.clientId, kind: stored.kind, attachmentId: uploaded.attachment.id, bytes: stored.blob.size });
            }
            const created = await request<{ todo: Todo }>("/api/todos", {
              method: "POST",
              body: JSON.stringify({
                clientId: record.clientId,
                title: record.title,
                notes: record.notes,
                status: "open",
                project: null,
                draftToken: attachmentIds.length ? draftToken : undefined,
                attachmentIds,
              }),
            });
            todo = created.todo;
          }
          await deleteOfflineTodo(record.clientId);
          setTodos((current) => [todo as Todo, ...current.filter((item) => item.clientId !== record.clientId && item.id !== todo?.id)]);
          synced += 1;
          setOfflineCount(Math.max(0, records.length - synced));
          console.info("[todo-offline] task synchronized", { clientId: record.clientId, id: todo.id, attachments: record.attachments.length });
        } catch (error) {
          console.error("[todo-offline] task sync failed", { clientId: record.clientId, online: navigator.onLine, error });
          if (!navigator.onLine) setOnline(false);
          break;
        }
      }
      if (synced > 0) setNotice({ tone: "success", text: `${synced} offline ${synced === 1 ? "task" : "tasks"} synced.` });
      console.info("[todo-offline] sync finished", { requested: records.length, synced, durationMs: Date.now() - startedAt });
    } catch (error) {
      console.error("[todo-offline] sync pass failed", { durationMs: Date.now() - startedAt, error });
    } finally {
      syncingOfflineRef.current = false;
    }
  }

  async function addTodo(event: FormEvent) {
    event.preventDefault();
    const title = newTitle.trim();
    const attachmentsReady = captureAttachments.every((item) => (item.status === "ready" && item.attachment) || item.status === "offline");
    if (!title || adding || !attachmentsReady) return;
    const temporaryId = -Date.now();
    const clientId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const optimistic: Todo = {
      id: temporaryId,
      clientId,
      title,
      notes: "",
      status: "open",
      priority: 3,
      dueDate: null,
      project: null,
      context: null,
      sourceKind: "site",
      sourceId: null,
      completedAt: null,
      snoozedUntil: null,
      createdAt,
      updatedAt: createdAt,
      attachmentCount: captureAttachments.length,
      offline: !navigator.onLine || captureAttachments.some((item) => item.status === "offline"),
    };
    setProject("");
    setView("open");
    console.info("[todo-ui] quick add routed to unfiltered open view", {
      previousProjectFilter: project || null,
    });
    setTodos((current) => [optimistic, ...current]);
    setAdding(true);
    setSyncing(true);
    setNotice(null);
    try {
      if (optimistic.offline) {
        await saveOfflineTodo({
          clientId,
          localId: temporaryId,
          title,
          notes: "",
          createdAt,
          attachments: captureAttachments.map((item) => ({
            localId: item.localId,
            kind: item.kind,
            fileName: item.file.name,
            mimeType: item.file.type,
            durationMs: item.durationMs,
            blob: item.file,
          })),
        });
        setOfflineCount((count) => count + 1);
        resetCapture();
        setNotice({ tone: "success", text: "Saved offline. It will sync automatically when you reconnect." });
        console.info("[todo-offline] quick add completed locally", { clientId, localId: temporaryId, attachments: captureAttachments.length });
        return;
      }
      const { todo } = await request<{ todo: Todo }>("/api/todos", {
        method: "POST",
        body: JSON.stringify({
          clientId,
          title,
          status: "open",
          project: null,
          draftToken: captureAttachments.length ? captureDraftToken : undefined,
          attachmentIds: captureAttachments.map((item) => item.attachment?.id).filter(Boolean),
        }),
      });
      setTodos((current) => current.map((item) => item.id === temporaryId ? todo : item));
      resetCapture();
      console.info("[todo-ui] created", {
        id: todo.id,
        status: todo.status,
        project: todo.project,
        titleLength: title.length,
        lines: title.split("\n").length,
        attachmentCount: todo.attachmentCount,
      });
    } catch (error) {
      if (!navigator.onLine || error instanceof TypeError) {
        try {
          await saveOfflineTodo({
            clientId,
            localId: temporaryId,
            title,
            notes: "",
            createdAt,
            attachments: captureAttachments.map((item) => ({
              localId: item.localId,
              kind: item.kind,
              fileName: item.file.name,
              mimeType: item.file.type,
              durationMs: item.durationMs,
              blob: item.file,
            })),
          });
          setTodos((current) => current.map((item) => item.id === temporaryId ? { ...item, offline: true, sourceKind: "offline" } : item));
          setOfflineCount((count) => count + 1);
          resetCapture();
          setNotice({ tone: "success", text: "The connection dropped, so this task was saved offline." });
          console.warn("[todo-offline] online create fell back to local queue", { clientId, localId: temporaryId, attachments: captureAttachments.length, error });
          return;
        } catch (offlineError) {
          console.error("[todo-offline] create fallback storage failed", { clientId, offlineError });
        }
      }
      setTodos((current) => current.filter((item) => item.id !== temporaryId));
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The task could not be added." });
    } finally {
      setAdding(false);
      setSyncing(false);
      captureRef.current?.focus();
    }
  }

  function applyOptimisticAction(current: Todo[], ids: number[], action: ExecutableTodoAction, actionAt: string) {
    const idSet = new Set(ids);
    if (action === "delete") return current.filter((todo) => !idSet.has(todo.id));
    const temporarySnooze = new Date(new Date(actionAt).valueOf() + 36 * 60 * 60 * 1000).toISOString();
    return current.map((todo) => {
      if (!idSet.has(todo.id)) return todo;
      if (action === "complete") return { ...todo, status: "completed" as const, completedAt: actionAt, snoozedUntil: null };
      if (action === "snooze") return { ...todo, status: "open" as const, completedAt: null, snoozedUntil: temporarySnooze };
      return { ...todo, status: "open" as const, completedAt: null, snoozedUntil: null };
    });
  }

  async function performAction(ids: number[], action: ExecutableTodoAction | "merge") {
    if (!ids.length || syncing) return;
    if (ids.some((id) => id < 1)) {
      setNotice({ tone: "error", text: "That offline task will be actionable as soon as it syncs." });
      return;
    }
    const previous = todos;
    const actionAt = new Date().toISOString();
    setSyncing(true);
    setNotice(null);
    if (action !== "merge") setTodos((current) => applyOptimisticAction(current, ids, action, actionAt));
    try {
      if (action === "merge") {
        const result = await request<{ todo: Todo; ids: number[]; undoToken: string }>("/api/todos/bulk", {
          method: "POST",
          body: JSON.stringify({ ids, action }),
        });
        const sourceIds = new Set(result.ids);
        setTodos((current) => [
          result.todo,
          ...current.filter((todo) => !sourceIds.has(todo.id)),
        ]);
        setNotice({ tone: "success", text: `Merged ${result.ids.length} tasks.`, undoToken: result.undoToken });
        console.info("[todo-ui] merged", { sourceIds: result.ids, mergedId: result.todo.id });
      } else {
        const result = await request<{ todos: Todo[]; ids: number[]; snoozedUntil: string | null; undoToken: string }>("/api/todos/bulk", {
          method: "POST",
          body: JSON.stringify({ ids, action }),
        });
        if (action !== "delete") {
          const updates = new Map(result.todos.map((todo) => [todo.id, todo]));
          setTodos((current) => current.map((todo) => updates.get(todo.id) ?? todo));
        }
        const openedCompleted = action === "unsnooze" && ids.every((id) => previous.find((todo) => todo.id === id)?.status === "completed");
        const wokeSnoozed = action === "unsnooze" && ids.every((id) => {
          const todo = previous.find((item) => item.id === id);
          return todo ? isSnoozed(todo, new Date(actionAt).valueOf()) : false;
        });
        const label = action === "complete" ? "Done" : action === "snooze" ? "Snoozed until tomorrow" : action === "unsnooze" ? openedCompleted ? "Opened" : wokeSnoozed ? "Woke" : "Restored to Open" : "Deleted";
        setNotice({ tone: "success", text: `${label}: ${ids.length} ${ids.length === 1 ? "task" : "tasks"}.`, undoToken: result.undoToken });
        console.info("[todo-ui] action completed", { action, ids, snoozedUntil: result.snoozedUntil });
      }
      setSelected((current) => {
        const next = new Set(current);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    } catch (error) {
      setTodos(previous);
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The action could not be completed." });
      console.error("[todo-ui] action failed", { action, ids, error });
    } finally {
      setSyncing(false);
    }
  }

  async function undoAction(undoToken: string) {
    if (undoing) return;
    setUndoing(true);
    try {
      const result = await request<{ todos: Todo[]; restored: number; restoredAttachments?: number }>("/api/todos/undo", {
        method: "POST",
        body: JSON.stringify({ undoToken }),
      });
      setTodos(result.todos);
      const { projects: refreshedProjects } = await request<{ projects: string[] }>("/api/projects");
      setRegisteredProjects(refreshedProjects);
      setSelected(new Set());
      if (editingId !== null) void loadTaskAttachments(editingId);
      const restoredLabel = result.restored > 0
        ? `${result.restored} ${result.restored === 1 ? "task" : "tasks"} restored`
        : `${result.restoredAttachments ?? 0} ${(result.restoredAttachments ?? 0) === 1 ? "image" : "images"} restored`;
      setNotice({ tone: "success", text: `Undone: ${restoredLabel}.` });
      console.info("[todo-ui] action undone", { restored: result.restored, restoredAttachments: result.restoredAttachments ?? 0 });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "That action could not be undone." });
      console.error("[todo-ui] undo failed", error);
    } finally {
      setUndoing(false);
    }
  }

  function openProjectAssignment(ids: number[], source: "bulk" | "hover" | "swipe" | "details") {
    const taskProjects = todos
      .filter((todo) => ids.includes(todo.id))
      .map((todo) => todo.project || UNASSIGNED_PROJECT);
    const sharedProject = new Set(taskProjects).size === 1 ? taskProjects[0] : "";
    setProjectDialog({ ids, selection: sharedProject, newProject: "", openedFromDetails: source === "details" });
    setProjectDialogError("");
    console.info("[todo-ui] project assignment opened", { ids, source, sharedProject: sharedProject || null });
  }

  function closeProjectAssignment() {
    if (savingProject) return;
    setProjectDialog(null);
    setProjectDialogError("");
  }

  async function saveProjectAssignment(event: FormEvent) {
    event.preventDefault();
    if (!projectDialog || savingProject) return;
    if (!projectDialog.selection) {
      setProjectDialogError("Choose a project or select Unassigned.");
      return;
    }
    const projectName = projectDialog.selection === CREATE_PROJECT
      ? projectDialog.newProject.trim()
      : projectDialog.selection === UNASSIGNED_PROJECT
        ? null
        : projectDialog.selection.trim() || null;
    if (projectDialog.selection === CREATE_PROJECT && !projectName) {
      setProjectDialogError("Enter a name for the new project.");
      return;
    }
    if (projectName && projectName.length > 120) {
      setProjectDialogError("Project names are limited to 120 characters.");
      return;
    }

    const { ids, openedFromDetails } = projectDialog;
    setSavingProject(true);
    setProjectDialogError("");
    setNotice(null);
    try {
      const result = await request<{ todos: Todo[]; ids: number[]; undoToken: string }>("/api/todos/bulk", {
        method: "POST",
        body: JSON.stringify({ ids, action: "reproject", project: projectName }),
      });
      const updates = new Map(result.todos.map((todo) => [todo.id, todo]));
      setTodos((current) => current.map((todo) => updates.get(todo.id) ?? todo));
      if (projectName) {
        setRegisteredProjects((current) => [...new Set([...current, projectName])].sort((a, b) => a.localeCompare(b)));
      }
      if (openedFromDetails && ids.length === 1) {
        setEditDraft((current) => current ? { ...current, project: projectName ?? "" } : current);
      }
      setSelected((current) => {
        const next = new Set(current);
        ids.forEach((id) => next.delete(id));
        return next;
      });
      setProjectDialog(null);
      const location = projectName || "Unassigned";
      setNotice({
        tone: "success",
        text: `Assigned to ${location}: ${ids.length} ${ids.length === 1 ? "task" : "tasks"}.`,
        undoToken: result.undoToken,
      });
      console.info("[todo-ui] project assignment saved", {
        ids,
        project: projectName,
        preservedTaskState: result.todos.map((todo) => ({ id: todo.id, status: todo.status, snoozedUntil: todo.snoozedUntil })),
        returnedToDetails: openedFromDetails,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The project could not be assigned.";
      setProjectDialogError(message);
      console.error("[todo-ui] project assignment failed", { ids, project: projectName, error });
    } finally {
      setSavingProject(false);
    }
  }

  function openTaskDetails(todo: Todo) {
    if (todo.id < 1 || todo.offline) {
      setNotice({ tone: "success", text: "That task is saved offline and will be editable after it syncs." });
      return;
    }
    setEditingId(todo.id);
    setEditDraft({
      title: todo.title,
      notes: todo.notes,
      priority: todo.priority,
      dueDate: dateInputValue(todo.dueDate),
      project: todo.project ?? "",
      context: todo.context ?? "",
    });
    setDetailAttachments([]);
    setDetailUploads([]);
    setViewerIndex(null);
    void loadTaskAttachments(todo.id);
    console.info("[todo-ui] task details opened", { id: todo.id, status: todo.status, attachmentCount: todo.attachmentCount });
  }

  function closeTaskDetails() {
    setEditingId(null);
    setEditDraft(null);
    setViewerIndex(null);
    setAttachmentError("");
    detailUploads.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    setDetailUploads([]);
  }

  async function saveTaskDetails(event: FormEvent) {
    event.preventDefault();
    if (!editingTodo || !editDraft || savingEdit) return;
    const title = editDraft.title.trim();
    if (!title) {
      setNotice({ tone: "error", text: "A task title is required." });
      return;
    }
    setSavingEdit(true);
    setNotice(null);
    try {
      const result = await request<{ todo: Todo; undoToken: string }>(`/api/todos/${editingTodo.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title,
          notes: editDraft.notes,
          priority: editDraft.priority,
          dueDate: editDraft.dueDate || null,
          context: editDraft.context || null,
        }),
      });
      setTodos((current) => current.map((todo) => todo.id === result.todo.id ? result.todo : todo));
      closeTaskDetails();
      setNotice({ tone: "success", text: "Task details saved.", undoToken: result.undoToken });
      console.info("[todo-ui] task details saved", {
        id: result.todo.id,
        titleLength: result.todo.title.length,
        notesLength: result.todo.notes.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The task details could not be saved.";
      setNotice({ tone: "error", text: message });
      console.error("[todo-ui] task details save failed", { id: editingTodo.id, error });
    } finally {
      setSavingEdit(false);
    }
  }

  function taskAction(todo: Todo, action: TodoAction, source: "hover" | "swipe" | "details") {
    console.info("[todo-ui] task action requested", { id: todo.id, action, source });
    void performAction([todo.id], action);
  }

  function assignTaskProject(todo: Todo, source: "hover" | "swipe") {
    openProjectAssignment([todo.id], source);
  }

  function detailAction(action: TodoAction) {
    if (!editingTodo) return;
    const todo = editingTodo;
    closeTaskDetails();
    taskAction(todo, action, "details");
  }

  async function copyTaskDetails() {
    if (!editDraft) return;
    const text = [editDraft.title.trim(), editDraft.notes.trim()].filter(Boolean).join("\n\n");
    try {
      await copyTextToClipboard(text);
      setNotice({ tone: "success", text: "Task title and notes copied." });
      console.info("[todo-ui] task details copied", { titleLength: editDraft.title.trim().length, notesLength: editDraft.notes.trim().length });
    } catch (error) {
      console.error("[todo-ui] task details copy failed", { error });
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The task could not be copied." });
    }
  }

  function bulkAction(action: TodoAction | "merge" | "assign") {
    if (action === "merge" && selectedIds.length < 2) {
      setNotice({ tone: "error", text: "Select at least two tasks to merge." });
      return;
    }
    if (action === "assign") {
      openProjectAssignment(selectedIds, "bulk");
      return;
    }
    const targetIds = action === "complete" || action === "snooze"
      ? selectedTodos.filter((todo) => todo.status === "open").map((todo) => todo.id)
      : action === "unsnooze"
        ? selectedTodos.filter((todo) => todo.status === "completed" || isSnoozed(todo, now)).map((todo) => todo.id)
        : selectedIds;
    void performAction(targetIds, action);
  }

  function toggleSelected(todo: Todo) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(todo.id)) next.delete(todo.id);
      else next.add(todo.id);
      return next;
    });
  }

  function toggleVisible() {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) filtered.forEach((todo) => next.delete(todo.id));
      else filtered.forEach((todo) => next.add(todo.id));
      return next;
    });
  }

  function chooseView(next: View) {
    setView(next);
    setSelected(new Set());
    setFiltersOpen(false);
    console.info("[todo-ui] view changed", { view: next, retainedProjectFilter: project || null });
  }

  function openProjectTasks(name: string, destinationView: TaskListView = "open", source: "card" | "shortcut" = "card") {
    setProject(name);
    setView(destinationView);
    setSelected(new Set());
    setFiltersOpen(false);
    console.info("[todo-ui] project opened as filtered task list", {
      project: name,
      destinationView,
      source,
    });
  }

  function openNewProjectDialog() {
    setNewProjectName("");
    setNewProjectError("");
    setNewProjectOpen(true);
    console.info("[todo-ui] new project dialog opened");
  }

  function closeNewProjectDialog() {
    if (creatingProject) return;
    setNewProjectOpen(false);
    setNewProjectName("");
    setNewProjectError("");
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();
    if (creatingProject) return;
    const name = newProjectName.trim();
    if (!name) {
      setNewProjectError("A project name is required.");
      return;
    }
    setCreatingProject(true);
    setNewProjectError("");
    try {
      const result = await request<{ project: string }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setRegisteredProjects((current) => [...new Set([...current, result.project])].sort((a, b) => a.localeCompare(b)));
      setNewProjectOpen(false);
      setNewProjectName("");
      setNotice({ tone: "success", text: `${result.project} created.` });
      console.info("[todo-ui] project created", { project: result.project, remainedOnProjectsView: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The project could not be created.";
      setNewProjectError(message);
      console.error("[todo-ui] project create failed", { name, error });
    } finally {
      setCreatingProject(false);
    }
  }

  function openProjectDeleteDialog(name: string) {
    const alternatives = registeredProjects.filter((projectName) => projectName !== name);
    setProjectDeleteDialog({ name, mode: alternatives.length ? "reassign" : "delete", targetProject: alternatives[0] ?? "" });
    setProjectDeleteError("");
    console.info("[todo-ui] project delete dialog opened", {
      project: name,
      projectTasks: todos.filter((todo) => todo.project === name).length,
      reassignTargets: alternatives.length,
    });
  }

  function closeProjectDeleteDialog() {
    if (deletingProject) return;
    setProjectDeleteDialog(null);
    setProjectDeleteError("");
  }

  async function deleteProject(event: FormEvent) {
    event.preventDefault();
    if (!projectDeleteDialog || deletingProject) return;
    if (projectDeleteDialog.mode === "reassign" && !projectDeleteDialog.targetProject) {
      setProjectDeleteError("Choose a destination project.");
      return;
    }
    const dialog = projectDeleteDialog;
    setDeletingProject(true);
    setProjectDeleteError("");
    try {
      const result = await request<{
        project: string;
        mode: "reassign" | "delete";
        targetProject: string | null;
        affected: number;
        undoToken: string | null;
      }>("/api/projects", {
        method: "DELETE",
        body: JSON.stringify({
          name: dialog.name,
          mode: dialog.mode,
          targetProject: dialog.mode === "reassign" ? dialog.targetProject : null,
        }),
      });
      setRegisteredProjects((current) => current.filter((name) => name !== result.project));
      setTodos((current) => result.mode === "delete"
        ? current.filter((todo) => todo.project !== result.project)
        : current.map((todo) => todo.project === result.project
          ? { ...todo, project: result.targetProject, updatedAt: new Date().toISOString() }
          : todo));
      setProjectDeleteDialog(null);
      setNotice({
        tone: "success",
        text: result.mode === "delete"
          ? `${result.project} and ${result.affected} ${result.affected === 1 ? "task" : "tasks"} deleted.`
          : `${result.project} deleted; ${result.affected} ${result.affected === 1 ? "task" : "tasks"} moved to ${result.targetProject}.`,
        undoToken: result.undoToken ?? undefined,
      });
      console.info("[todo-ui] project deleted", { ...result, affectedAllTaskStates: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The project could not be deleted.";
      setProjectDeleteError(message);
      console.error("[todo-ui] project delete failed", { dialog, error });
    } finally {
      setDeletingProject(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f6f7f5] text-[#1d211f]">
      <SiteHeader current="todos" />
      {(!online || offlineCount > 0) && (
        <div className="pointer-events-none fixed right-3 top-[4.25rem] z-40 rounded-full bg-[#202522] px-3 py-1.5 text-xs font-semibold text-white shadow-lg" role="status" aria-live="polite">
          {!online ? `Offline${offlineCount ? ` · ${offlineCount} queued` : ""}` : `${offlineCount} waiting to sync`}
        </div>
      )}
      {imageDropActive && (
        <div className="pointer-events-none fixed inset-0 z-[100] grid place-items-center bg-[#153d2d]/25 p-5 backdrop-blur-[2px]" role="status" aria-live="polite">
          <div className="flex max-w-sm items-center gap-3 rounded-2xl border border-[#216e4e]/25 bg-white px-5 py-4 text-base font-semibold text-[#216e4e] shadow-2xl">
            <ActionIcon name="attachment" className="h-6 w-6" />
            Drop photos or videos to attach to {editingTodo ? "this task" : "the new task"}
          </div>
        </div>
      )}
      <div className="mx-auto max-w-5xl px-4 pb-28 pt-5 sm:px-6 sm:pt-7">
        <form onSubmit={addTodo} className="mb-5 rounded-2xl border border-black/[0.07] bg-white p-2 shadow-[0_10px_35px_rgba(30,45,36,0.07)] sm:p-3">
          <div className="flex items-end gap-2">
            <div className="flex min-w-0 flex-1 items-start gap-2 px-1 py-2 sm:px-2">
              <AttachmentPicker label="Add attachment" onFiles={(files) => void queueCaptureAttachments(files)} onRecord={() => setVoiceTarget("capture")} disabled={captureAttachments.length >= MAX_ATTACHMENTS} />
              <textarea
                ref={captureRef}
                value={newTitle}
                onChange={(event) => { setNewTitle(event.target.value); resizeCapture(event.currentTarget); }}
                onPaste={(event) => {
                  const files = clipboardImages(event);
                  if (files.length) void queueCaptureAttachments(files);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                rows={1}
                placeholder="Add a task…"
                aria-label="Add a task"
                maxLength={2000}
                className="min-h-10 max-h-[120px] min-w-0 flex-1 resize-none overflow-hidden bg-transparent py-2 text-[16px] leading-6 text-[#151816] outline-none placeholder:text-[#929994]"
              />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="hidden text-[10px] text-[#929994] sm:block">⌘↵ add</span>
              <button
                type="submit"
                disabled={!newTitle.trim() || adding || captureAttachments.some((item) => item.status === "uploading" || item.status === "error")}
                className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#216e4e] px-4 text-sm font-semibold text-white transition hover:bg-[#195d41] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e] disabled:cursor-not-allowed disabled:opacity-40 sm:px-6"
              >
                <ActionIcon name="add" />
                {adding ? "Adding…" : "Add"}
              </button>
            </div>
          </div>

          {captureAttachments.length > 0 && (
            <div className="flex gap-2 overflow-x-auto border-t border-black/[0.06] px-2 pb-1 pt-2 sm:px-3" aria-label="Attachments to add">
              {captureAttachments.map((item) => (
                <div key={item.localId} className={classNames("relative h-16 shrink-0 overflow-hidden rounded-xl bg-[#eef0ed] ring-1 ring-black/[0.06]", item.kind === "audio" ? "w-44" : "w-16")} title={item.error || item.file.name}>
                  {item.kind === "image" ? <img src={item.previewUrl} alt="" className="h-full w-full object-cover" /> : item.kind === "video" ? <video src={item.previewUrl} muted className="h-full w-full object-cover" /> : <div className="flex h-full items-center gap-2 px-3 text-xs font-semibold text-[#455049]"><ActionIcon name="mic" className="h-5 w-5 text-[#216e4e]" /><span>Voice memo<br /><span className="font-normal text-[#7b837e]">{formatDuration(item.durationMs)}</span></span></div>}
                  {item.status === "uploading" && <span className="absolute inset-0 grid place-items-center bg-black/40 text-[10px] font-semibold text-white">Uploading…</span>}
                  {item.status === "offline" && <span className="absolute inset-x-0 bottom-0 bg-amber-700/90 px-1 py-0.5 text-center text-[9px] font-semibold text-white">Saved offline</span>}
                  {item.status === "error" && (
                    <button type="button" onClick={() => retryCaptureAttachment(item)} aria-label={`Retry ${item.file.name}`} title="Retry upload" className="absolute inset-0 grid place-items-center bg-red-900/65 text-white"><ActionIcon name="retry" /></button>
                  )}
                  {item.status !== "uploading" && (
                    <button type="button" onClick={() => void removeCaptureAttachment(item)} aria-label={`Remove ${item.file.name}`} title="Remove attachment" className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-black/65 text-white hover:bg-red-700"><ActionIcon name="close" className="h-3.5 w-3.5" /></button>
                  )}
                </div>
              ))}
              <span className="self-center whitespace-nowrap px-1 text-[11px] text-[#7c847f]">{captureAttachments.length}/{MAX_ATTACHMENTS}</span>
            </div>
          )}
        </form>

        <section aria-labelledby="tasks-heading">
          <div className="mb-3 flex gap-1 overflow-x-auto rounded-xl border border-black/[0.06] bg-white p-1 shadow-sm">
            {(Object.keys(viewLabels) as View[]).map((item) => (
              <button
                key={item}
                onClick={() => chooseView(item)}
                className={classNames(
                  "flex min-w-max flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-[#216e4e]",
                  view === item ? "bg-[#eaf3ed] text-[#195d41]" : "text-[#69716c] hover:bg-[#f6f7f5] hover:text-[#252a27]",
                )}
              >
                {viewLabels[item]}
                <span className={classNames("rounded-full px-1.5 py-0.5 text-[11px]", view === item ? "bg-white/80" : "bg-[#f1f2f0]")}>{counts[item]}</span>
              </button>
            ))}
          </div>

          {view === "projects" ? (
            <div>
              <div className="mb-4 flex items-center justify-between gap-3 px-1">
                <div>
                  <h2 id="tasks-heading" className="text-lg font-semibold text-[#202522]">Projects</h2>
                  <p className="mt-0.5 text-sm text-[#7c847f]">Open a project to see its active tasks.</p>
                </div>
                <button
                  type="button"
                  onClick={openNewProjectDialog}
                  className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl bg-[#216e4e] px-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#195d41] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e]"
                >
                  <ActionIcon name="create-project" />
                  <span>New project</span>
                </button>
              </div>

              {loading ? (
                <div role="status" aria-label="Loading projects" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {[0, 1, 2].map((item) => <div key={item} className="h-32 animate-pulse rounded-2xl bg-white shadow-sm" />)}
                </div>
              ) : projectOptions.length ? (
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {projectOptions.map(([name, projectCounts]) => {
                    const count = projectCounts.open + projectCounts.snoozed + projectCounts.done;
                    return (
                      <li key={name} className="group relative overflow-hidden rounded-2xl border border-black/[0.07] bg-white shadow-[0_8px_28px_rgba(30,45,36,0.05)] transition hover:-translate-y-0.5 hover:border-[#216e4e]/20 hover:shadow-[0_12px_34px_rgba(30,45,36,0.09)]">
                        <button
                          type="button"
                          onClick={() => openProjectTasks(name)}
                          className="flex min-h-32 w-full items-start gap-3 p-5 pr-40 text-left focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[#216e4e]"
                          aria-label={`Open ${name}, ${count} ${count === 1 ? "task" : "tasks"}`}
                        >
                          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[#eaf3ed] text-[#216e4e]">
                            <ActionIcon name="folder" className="h-6 w-6" />
                          </span>
                          <span className="min-w-0 pt-0.5">
                            <span className="block break-words text-[15px] font-semibold text-[#252a27]">{name}</span>
                            <span className="mt-1 block text-xs text-[#7c847f]">{projectCounts.open} open · {projectCounts.snoozed} snoozed · {projectCounts.done} done</span>
                          </span>
                        </button>
                        <div className="absolute right-3 top-3 flex items-center gap-0.5 rounded-xl bg-white/95 p-0.5 shadow-sm ring-1 ring-black/[0.05]">
                          {([
                            ["open", "view-open", `View open tasks in ${name}`],
                            ["snoozed", "snooze", `View snoozed tasks in ${name}`],
                            ["all", "view-all", `View all tasks in ${name}`],
                          ] as const).map(([destinationView, icon, label]) => (
                            <button
                              key={destinationView}
                              type="button"
                              onClick={() => openProjectTasks(name, destinationView, "shortcut")}
                              aria-label={label}
                              title={label}
                              className="grid h-8 w-8 place-items-center rounded-lg text-[#65706a] transition hover:bg-[#eaf3ed] hover:text-[#216e4e] focus-visible:outline-2 focus-visible:outline-[#216e4e]"
                            >
                              <ActionIcon name={icon} />
                            </button>
                          ))}
                          <button
                            type="button"
                            onClick={() => openProjectDeleteDialog(name)}
                            aria-label={`Delete project: ${name}`}
                            title="Delete project"
                            className="grid h-8 w-8 place-items-center rounded-lg text-[#8a918d] transition hover:bg-red-50 hover:text-red-700 focus-visible:outline-2 focus-visible:outline-red-600"
                          >
                            <ActionIcon name="delete" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="rounded-2xl border border-dashed border-black/[0.12] bg-white px-6 py-14 text-center">
                  <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[#eaf3ed] text-[#216e4e]"><ActionIcon name="folder" className="h-6 w-6" /></span>
                  <p className="mt-4 font-medium text-[#303632]">No projects yet.</p>
                  <p className="mt-1 text-sm text-[#7c847f]">Create a project, then assign tasks whenever useful.</p>
                </div>
              )}
            </div>
          ) : (
          <>
          <div className={classNames("mb-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2", projectFilterApplies ? "sm:grid-cols-[minmax(220px,1fr)_auto_auto_auto]" : "sm:grid-cols-[minmax(220px,1fr)_auto_auto]")}>
            <label className="flex h-10 items-center gap-2 rounded-xl border border-black/[0.08] bg-white px-3 shadow-sm focus-within:border-[#216e4e]/50 focus-within:ring-3 focus-within:ring-[#216e4e]/10">
              <ActionIcon name="search" className="h-4 w-4 shrink-0 text-[#7c847f]" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search tasks"
                aria-label="Search tasks"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[#929994]"
              />
              <kbd className="hidden rounded border border-black/10 bg-[#f6f7f5] px-1.5 py-0.5 text-[10px] text-[#7c847f] sm:block">/</kbd>
            </label>
            <button
              type="button"
              onClick={() => setFiltersOpen(true)}
              className={classNames(
                "flex h-10 items-center gap-2 rounded-xl border bg-white px-3 text-sm font-medium shadow-sm transition focus-visible:outline-2 focus-visible:outline-[#216e4e] sm:hidden",
                mobileFilterCount ? "border-[#216e4e]/30 text-[#195d41]" : "border-black/[0.08] text-[#4f5752]",
              )}
              aria-label={`Filters${mobileFilterCount ? `, ${mobileFilterCount} active` : ""}`}
            >
              <ActionIcon name="filters" className="h-4 w-4" />
              <span>Filters</span>
              {mobileFilterCount > 0 && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[#216e4e] px-1 text-[10px] text-white">{mobileFilterCount}</span>}
            </button>
            {projectFilterApplies && <select value={project} onChange={(event) => setProject(event.target.value)} aria-label="Filter by project" className="hidden h-10 rounded-xl border border-black/[0.08] bg-white px-3 text-sm text-[#4f5752] shadow-sm outline-none focus:border-[#216e4e]/50 sm:block">
              <option value="">All projects</option>
              <option value={UNASSIGNED_PROJECT}>Unassigned</option>
              {projects.map((name) => <option key={name}>{name}</option>)}
            </select>}
            <select value={priority} onChange={(event) => setPriority(event.target.value)} aria-label="Filter by priority" className="hidden h-10 rounded-xl border border-black/[0.08] bg-white px-3 text-sm text-[#4f5752] shadow-sm outline-none focus:border-[#216e4e]/50 sm:block">
              <option value="">All priorities</option>
              <option value="1">Urgent</option>
              <option value="2">High</option>
              <option value="3">Normal</option>
              <option value="4">Low</option>
            </select>
            <select value={sort} onChange={(event) => setSort(event.target.value as Sort)} aria-label="Sort tasks" className="hidden h-10 rounded-xl border border-black/[0.08] bg-white px-3 text-sm text-[#4f5752] shadow-sm outline-none focus:border-[#216e4e]/50 sm:block">
              <option value="smart">Smart sort</option>
              <option value="priority">Priority</option>
              <option value="due">Due date</option>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="az">A–Z</option>
            </select>
          </div>

          {filtersOpen && (
            <div className="fixed inset-0 z-50 sm:hidden" role="dialog" aria-modal="true" aria-labelledby="mobile-filters-title">
              <button type="button" aria-label="Close filters" onClick={() => setFiltersOpen(false)} className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" />
              <div className="absolute inset-x-0 bottom-0 rounded-t-3xl bg-white px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 shadow-2xl">
                <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-black/15" aria-hidden="true" />
                <div className="mb-5 flex items-center justify-between">
                  <div>
                    <h3 id="mobile-filters-title" className="text-lg font-semibold text-[#202522]">Filters & sorting</h3>
                    <p className="mt-0.5 text-xs text-[#7c847f]">Narrow the list without losing workspace.</p>
                  </div>
                  <button type="button" onClick={() => setFiltersOpen(false)} className="grid h-9 w-9 place-items-center rounded-full bg-[#f1f2f0] text-[#4f5752]" aria-label="Close filters" title="Close"><ActionIcon name="close" /></button>
                </div>

                <div className="space-y-4">
                  {projectFilterApplies && <label className="block">
                    <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Project</span>
                    <select value={project} onChange={(event) => setProject(event.target.value)} className="h-12 w-full rounded-xl border border-black/[0.1] bg-white px-3 text-sm text-[#303632] outline-none focus:border-[#216e4e]/50">
                      <option value="">All projects</option>
                      <option value={UNASSIGNED_PROJECT}>Unassigned</option>
                      {projects.map((name) => <option key={name}>{name}</option>)}
                    </select>
                  </label>}
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Priority</span>
                    <select value={priority} onChange={(event) => setPriority(event.target.value)} className="h-12 w-full rounded-xl border border-black/[0.1] bg-white px-3 text-sm text-[#303632] outline-none focus:border-[#216e4e]/50">
                      <option value="">All priorities</option>
                      <option value="1">Urgent</option>
                      <option value="2">High</option>
                      <option value="3">Normal</option>
                      <option value="4">Low</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Sort</span>
                    <select value={sort} onChange={(event) => setSort(event.target.value as Sort)} className="h-12 w-full rounded-xl border border-black/[0.1] bg-white px-3 text-sm text-[#303632] outline-none focus:border-[#216e4e]/50">
                      <option value="smart">Smart sort</option>
                      <option value="priority">Priority</option>
                      <option value="due">Due date</option>
                      <option value="newest">Newest</option>
                      <option value="oldest">Oldest</option>
                      <option value="az">A–Z</option>
                    </select>
                  </label>
                </div>

                <div className="mt-6 grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => { if (projectFilterApplies) setProject(""); setPriority(""); setSort("smart"); }} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-black/[0.08] text-sm font-semibold text-[#4f5752]"><ActionIcon name="restore" />Reset</button>
                  <button type="button" onClick={() => setFiltersOpen(false)} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[#216e4e] text-sm font-semibold text-white"><ActionIcon name="done" />Show {filtered.length} {filtered.length === 1 ? "task" : "tasks"}</button>
                </div>
              </div>
            </div>
          )}

          <div className="mb-2 flex items-center justify-between px-1">
            <div className="flex items-center gap-3">
              <h2 id="tasks-heading" className="text-sm font-semibold text-[#373d39]">{viewLabels[view]} tasks</h2>
              {filtered.length > 0 && <button onClick={toggleVisible} className="inline-flex items-center gap-1.5 text-xs font-medium text-[#216e4e] hover:underline"><ActionIcon name={allVisibleSelected ? "cancel" : "select"} className="h-3.5 w-3.5" />{allVisibleSelected ? "Clear selection" : "Select visible"}</button>}
            </div>
            <div className="flex items-center gap-3 text-xs text-[#7c847f]">
              <span>{syncing ? "Saving…" : `${filtered.length} ${filtered.length === 1 ? "item" : "items"}`}</span>
              {filtersActive && <button onClick={() => { setQuery(""); if (projectFilterApplies) setProject(""); setPriority(""); setSort("smart"); }} className="inline-flex items-center gap-1 font-medium text-[#216e4e] hover:underline"><ActionIcon name="cancel" className="h-3.5 w-3.5" />Clear filters</button>}
            </div>
          </div>

          <p className="mb-2 px-1 text-[11px] text-[#8a918d] md:hidden">Swipe left: done/open · keep swiping to snooze/wake · Swipe right: assign project / delete</p>

          <div className="overflow-hidden rounded-2xl border border-black/[0.07] bg-white shadow-[0_8px_30px_rgba(30,45,36,0.05)]">
            {loading ? (
              <div role="status" className="space-y-1 p-2" aria-label="Loading tasks">
                {[0, 1, 2, 3, 4].map((item) => <div key={item} className="h-[72px] animate-pulse rounded-xl bg-[#f3f4f2]" />)}
              </div>
            ) : filtered.length ? (
              <ul className="divide-y divide-black/[0.055]">
                {filtered.map((todo) => (
                  <TaskRow
                    key={todo.id}
                    todo={todo}
                    selected={selected.has(todo.id)}
                    now={now}
                    onSelect={toggleSelected}
                    onAction={taskAction}
                    onProject={assignTaskProject}
                    onOpen={openTaskDetails}
                  />
                ))}
              </ul>
            ) : (
              <div className="px-6 py-14 text-center">
                <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-[#eaf3ed] text-xl text-[#216e4e]">✓</div>
                <p className="font-medium text-[#303632]">{filtersActive ? "No tasks match those filters." : view === "snoozed" ? "Nothing is snoozed." : "You’re clear."}</p>
                <p className="mt-1 text-sm text-[#7c847f]">{filtersActive ? "Try clearing a filter or changing the search." : view === "snoozed" ? "Snoozed tasks return here until their wake time." : "Add the next thing when it appears."}</p>
              </div>
            )}
          </div>
          </>
          )}
        </section>

        <footer className="mt-5 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-[#858c87]">
          <span>Private · saved automatically</span>
          <span className="hidden sm:inline"><kbd className="rounded border border-black/10 bg-white px-1.5 py-0.5">N</kbd> new task &nbsp; <kbd className="rounded border border-black/10 bg-white px-1.5 py-0.5">/</kbd> search</span>
        </footer>
      </div>

      {selectedIds.length > 0 && (
        <div
          className="pointer-events-none fixed inset-x-0 z-40 mx-auto w-[calc(100%-1rem)] max-w-4xl sm:w-[calc(100%-2rem)]"
          style={{ bottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
          aria-label="Bulk task actions"
        >
          <div className="pointer-events-auto flex items-center gap-1.5 overflow-x-auto rounded-2xl border border-[#216e4e]/20 bg-[#eaf3ed]/95 p-2 shadow-[0_16px_50px_rgba(23,61,42,0.2)] backdrop-blur-xl sm:gap-2">
            <span className="min-w-max px-2 text-sm font-semibold text-[#195d41]">{selectedIds.length} selected</span>
            {selectedTodos.some((todo) => todo.status === "open") && <button type="button" onClick={() => bulkAction("complete")} disabled={syncing} className="inline-flex min-w-max items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-[#216e4e] shadow-sm hover:bg-[#f8fbf9] disabled:opacity-50"><ActionIcon name="done" />Done</button>}
            {view === "snoozed" && selectedTodos.some((todo) => todo.status === "open") ? (
              <button type="button" onClick={() => bulkAction("unsnooze")} disabled={syncing} className="inline-flex min-w-max items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-[#216e4e] shadow-sm hover:bg-[#f8fbf9] disabled:opacity-50"><ActionIcon name="wake" />Wake</button>
            ) : selectedTodos.some((todo) => todo.status === "open") ? (
              <button type="button" onClick={() => bulkAction("snooze")} disabled={syncing} className="inline-flex min-w-max items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-amber-700 shadow-sm hover:bg-amber-50 disabled:opacity-50"><ActionIcon name="snooze" />Snooze</button>
            ) : null}
            {selectedTodos.some((todo) => todo.status === "completed") && <button type="button" onClick={() => bulkAction("unsnooze")} disabled={syncing} className="inline-flex min-w-max items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-[#4f5752] shadow-sm hover:bg-[#f8f9f8] disabled:opacity-50"><ActionIcon name="open" />Open</button>}
            <button type="button" onClick={() => bulkAction("assign")} disabled={syncing} className="inline-flex min-w-max items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm hover:bg-slate-50 disabled:opacity-50"><ActionIcon name="move" />Assign project</button>
            <button type="button" onClick={() => bulkAction("merge")} disabled={syncing || selectedIds.length < 2} className="inline-flex min-w-max items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-violet-700 shadow-sm hover:bg-violet-50 disabled:opacity-40"><ActionIcon name="merge" />Merge</button>
            <button type="button" onClick={() => bulkAction("delete")} disabled={syncing} className="inline-flex min-w-max items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-red-700 shadow-sm hover:bg-red-50 disabled:opacity-50"><ActionIcon name="delete" />Delete</button>
            <button type="button" onClick={() => setSelected(new Set())} className="ml-auto inline-flex min-w-max items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-[#69716c] hover:bg-black/[0.04]"><ActionIcon name="cancel" />Cancel</button>
          </div>
        </div>
      )}

      {newProjectOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-x-hidden sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="new-project-title">
          <button type="button" aria-label="Close new project dialog" onClick={closeNewProjectDialog} className="absolute inset-0 bg-black/35 backdrop-blur-[2px]" />
          <form onSubmit={createProject} className="relative w-full max-w-full overflow-x-hidden rounded-t-3xl bg-white px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5 shadow-2xl sm:max-w-md sm:rounded-3xl sm:p-6">
            <div className="flex min-w-0 items-start justify-between gap-4">
              <div className="min-w-0">
                <span className="mb-3 grid h-11 w-11 place-items-center rounded-xl bg-[#eaf3ed] text-[#216e4e]"><ActionIcon name="create-project" className="h-6 w-6" /></span>
                <h3 id="new-project-title" className="text-lg font-semibold text-[#202522]">Create project</h3>
                <p className="mt-1 text-sm leading-5 text-[#7c847f]">Add a project you can assign tasks to and filter by.</p>
              </div>
              <button type="button" onClick={closeNewProjectDialog} disabled={creatingProject} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#f1f2f0] text-[#4f5752] hover:bg-[#e8eae7] disabled:opacity-50" aria-label="Close new project dialog" title="Close"><ActionIcon name="close" /></button>
            </div>
            <label className="mt-5 block min-w-0">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Project name</span>
              <input
                autoFocus
                value={newProjectName}
                onChange={(event) => { setNewProjectName(event.target.value); setNewProjectError(""); }}
                placeholder="e.g. Reference, Home, Work"
                maxLength={120}
                className="h-12 w-full min-w-0 max-w-full rounded-xl border border-black/[0.1] px-3 text-[16px] outline-none focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10"
              />
            </label>
            {newProjectError && <p role="alert" className="mt-3 text-sm font-medium text-red-700">{newProjectError}</p>}
            <div className="mt-6 flex items-center justify-end gap-2">
              <button type="button" onClick={closeNewProjectDialog} disabled={creatingProject} className="inline-flex h-11 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-[#69716c] hover:bg-[#f3f4f2] disabled:opacity-50"><ActionIcon name="cancel" />Cancel</button>
              <button type="submit" disabled={creatingProject || !newProjectName.trim()} className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#216e4e] px-5 text-sm font-semibold text-white hover:bg-[#195d41] disabled:opacity-50"><ActionIcon name="create-project" />{creatingProject ? "Creating…" : "Create project"}</button>
            </div>
          </form>
        </div>
      )}

      {projectDeleteDialog && (() => {
        const noteCount = todos.filter((todo) => todo.project === projectDeleteDialog.name).length;
        const alternatives = registeredProjects.filter((name) => name !== projectDeleteDialog.name);
        return (
          <div className="fixed inset-0 z-50 flex items-end justify-center overflow-x-hidden sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="delete-project-title">
            <button type="button" aria-label="Close delete project dialog" onClick={closeProjectDeleteDialog} className="absolute inset-0 bg-black/35 backdrop-blur-[2px]" />
            <form onSubmit={deleteProject} className="relative max-h-[92dvh] w-full max-w-full overflow-x-hidden overflow-y-auto rounded-t-3xl bg-white px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5 shadow-2xl sm:max-w-md sm:rounded-3xl sm:p-6">
              <div className="flex min-w-0 items-start justify-between gap-4">
                <div className="min-w-0">
                  <span className="mb-3 grid h-11 w-11 place-items-center rounded-xl bg-red-50 text-red-700"><ActionIcon name="delete" className="h-5 w-5" /></span>
                  <h3 id="delete-project-title" className="break-words text-lg font-semibold text-[#202522]">Delete {projectDeleteDialog.name}?</h3>
                  <p className="mt-1 text-sm leading-5 text-[#7c847f]">{noteCount ? `This project contains ${noteCount} ${noteCount === 1 ? "task" : "tasks"}. Choose what happens to them.` : "This project is empty and can be safely removed."}</p>
                </div>
                <button type="button" onClick={closeProjectDeleteDialog} disabled={deletingProject} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#f1f2f0] text-[#4f5752] hover:bg-[#e8eae7] disabled:opacity-50" aria-label="Close delete project dialog" title="Close"><ActionIcon name="close" /></button>
              </div>

              {noteCount > 0 && (
                <fieldset className="mt-5 space-y-2">
                  <legend className="sr-only">Choose what happens to project tasks</legend>
                  <label className={classNames("block rounded-2xl border p-4 transition", projectDeleteDialog.mode === "reassign" ? "border-[#216e4e]/35 bg-[#f3f8f5]" : "border-black/[0.09]") }>
                    <span className="flex items-start gap-3">
                      <input
                        type="radio"
                        name="delete-project-mode"
                        checked={projectDeleteDialog.mode === "reassign"}
                        disabled={!alternatives.length}
                        onChange={() => setProjectDeleteDialog((current) => current ? { ...current, mode: "reassign", targetProject: current.targetProject || alternatives[0] || "" } : current)}
                        className="mt-0.5 h-4 w-4 accent-[#216e4e]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-[#303632]">Move tasks to another project</span>
                        <span className="mt-0.5 block text-xs leading-5 text-[#7c847f]">Keep every task and reassign it before removing this project.</span>
                      </span>
                    </span>
                    {projectDeleteDialog.mode === "reassign" && alternatives.length > 0 && (
                      <select
                        autoFocus
                        value={projectDeleteDialog.targetProject}
                        onChange={(event) => { setProjectDeleteDialog((current) => current ? { ...current, targetProject: event.target.value } : current); setProjectDeleteError(""); }}
                        className="mt-3 h-11 w-full rounded-xl border border-black/[0.1] bg-white px-3 text-sm text-[#303632] outline-none focus:border-[#216e4e]/50"
                        aria-label="Destination project"
                      >
                        {alternatives.map((name) => <option key={name} value={name}>{name}</option>)}
                      </select>
                    )}
                    {!alternatives.length && <span className="mt-2 block pl-7 text-xs text-[#8a918d]">Create another project first to use this option.</span>}
                  </label>

                  <label className={classNames("flex items-start gap-3 rounded-2xl border p-4 transition", projectDeleteDialog.mode === "delete" ? "border-red-300 bg-red-50" : "border-black/[0.09]")}>
                    <input type="radio" name="delete-project-mode" checked={projectDeleteDialog.mode === "delete"} onChange={() => setProjectDeleteDialog((current) => current ? { ...current, mode: "delete" } : current)} className="mt-0.5 h-4 w-4 accent-red-700" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-red-800">Delete the tasks too</span>
                      <span className="mt-0.5 block text-xs leading-5 text-red-700/75">Remove the project and all {noteCount} {noteCount === 1 ? "task" : "tasks"} assigned to it.</span>
                    </span>
                  </label>
                </fieldset>
              )}

              {projectDeleteError && <p role="alert" className="mt-3 text-sm font-medium text-red-700">{projectDeleteError}</p>}
              <div className="mt-6 flex items-center justify-end gap-2">
                <button type="button" onClick={closeProjectDeleteDialog} disabled={deletingProject} className="inline-flex h-11 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-[#69716c] hover:bg-[#f3f4f2] disabled:opacity-50"><ActionIcon name="cancel" />Cancel</button>
                <button type="submit" disabled={deletingProject || (noteCount > 0 && projectDeleteDialog.mode === "reassign" && !projectDeleteDialog.targetProject)} className="inline-flex h-11 items-center gap-2 rounded-xl bg-red-700 px-5 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50"><ActionIcon name="delete" />{deletingProject ? "Deleting…" : projectDeleteDialog.mode === "delete" && noteCount > 0 ? "Delete project & tasks" : "Delete project"}</button>
              </div>
            </form>
          </div>
        );
      })()}

      {projectDialog && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center overflow-x-hidden sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
          <button type="button" aria-label="Close project assignment" onClick={closeProjectAssignment} className="absolute inset-0 bg-black/35 backdrop-blur-[2px]" />
          <form onSubmit={saveProjectAssignment} className="relative max-h-[92dvh] w-full max-w-full overflow-x-hidden overflow-y-auto rounded-t-3xl bg-white px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5 shadow-2xl sm:max-w-md sm:rounded-3xl sm:p-6">
            <div className="flex min-w-0 items-start justify-between gap-4">
              <div className="min-w-0">
                <h3 id="project-dialog-title" className="text-lg font-semibold text-[#202522]">Assign project</h3>
                <p className="mt-1 text-sm leading-5 text-[#7c847f]">
                  Assign {projectDialog.ids.length === 1 ? "this task" : `these ${projectDialog.ids.length} tasks`} to an existing or new project, or leave {projectDialog.ids.length === 1 ? "it" : "them"} unassigned.
                </p>
              </div>
              <button type="button" onClick={closeProjectAssignment} disabled={savingProject} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#f1f2f0] text-[#4f5752] hover:bg-[#e8eae7] disabled:opacity-50" aria-label="Close project assignment" title="Close"><ActionIcon name="close" /></button>
            </div>

            <label className="mt-5 block min-w-0">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Project</span>
              <select
                autoFocus
                value={projectDialog.selection}
                onChange={(event) => {
                  setProjectDialog((current) => current ? { ...current, selection: event.target.value } : current);
                  setProjectDialogError("");
                }}
                className="h-12 w-full min-w-0 max-w-full rounded-xl border border-black/[0.1] bg-white px-3 text-sm text-[#303632] outline-none focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10"
              >
                <option value="">Choose a project…</option>
                <option value={UNASSIGNED_PROJECT}>Unassigned</option>
                {projects.map((name) => <option key={name} value={name}>{name}</option>)}
                <option value={CREATE_PROJECT}>Create a new project…</option>
              </select>
            </label>

            {projectDialog.selection === CREATE_PROJECT && (
              <label className="mt-3 block min-w-0">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">New project name</span>
                <input
                  value={projectDialog.newProject}
                  onChange={(event) => {
                    setProjectDialog((current) => current ? { ...current, newProject: event.target.value } : current);
                    setProjectDialogError("");
                  }}
                  placeholder="e.g. Reference, Home, Work"
                  maxLength={120}
                  className="h-12 w-full min-w-0 max-w-full rounded-xl border border-black/[0.1] px-3 text-[16px] outline-none focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10"
                />
              </label>
            )}

            {projectDialogError && <p role="alert" className="mt-3 text-sm font-medium text-red-700">{projectDialogError}</p>}

            <div className="mt-6 flex items-center justify-end gap-2">
              <button type="button" onClick={closeProjectAssignment} disabled={savingProject} className="inline-flex h-11 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-[#69716c] hover:bg-[#f3f4f2] disabled:opacity-50"><ActionIcon name="cancel" />Cancel</button>
              <button type="submit" disabled={savingProject || !projectDialog.selection || (projectDialog.selection === CREATE_PROJECT && !projectDialog.newProject.trim())} className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#216e4e] px-5 text-sm font-semibold text-white hover:bg-[#195d41] disabled:opacity-50">
                <ActionIcon name="move" />
                {savingProject ? "Saving…" : "Assign project"}
              </button>
            </div>
          </form>
        </div>
      )}

      {editingTodo && editDraft && (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-x-hidden sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="task-details-title">
          <button type="button" aria-label="Close task details" onClick={closeTaskDetails} className="absolute inset-0 bg-black/35 backdrop-blur-[2px]" />
          <form onSubmit={saveTaskDetails} className="relative flex max-h-[92dvh] w-full max-w-full flex-col overflow-hidden overflow-x-hidden rounded-t-3xl bg-white shadow-2xl sm:max-w-2xl sm:rounded-3xl">
            <div className="flex min-w-0 items-center justify-between border-b border-black/[0.07] px-5 py-4 sm:px-6">
              <h3 id="task-details-title" className="min-w-0 text-lg font-semibold text-[#202522]">Task details</h3>
              <div className="flex shrink-0 items-center gap-1">
                <button type="button" onClick={() => void copyTaskDetails()} className="grid h-9 w-9 place-items-center rounded-full bg-[#f1f2f0] text-[#4f5752] hover:bg-[#e8eae7]" aria-label="Copy task title and notes" title="Copy task"><ActionIcon name="copy" /></button>
                <button type="button" onClick={closeTaskDetails} className="grid h-9 w-9 place-items-center rounded-full bg-[#f1f2f0] text-[#4f5752] hover:bg-[#e8eae7]" aria-label="Close task details" title="Close"><ActionIcon name="close" /></button>
              </div>
            </div>

            <div className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto px-5 py-5 sm:px-6">
              <label className="block min-w-0">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Task</span>
                <textarea
                  autoFocus
                  value={editDraft.title}
                  onChange={(event) => setEditDraft((current) => current ? { ...current, title: event.target.value } : current)}
                  onPaste={(event) => {
                    const files = clipboardImages(event);
                    if (files.length) void queueDetailAttachments(files);
                  }}
                  rows={4}
                  maxLength={2000}
                  className="min-h-28 w-full min-w-0 max-w-full resize-y rounded-xl border border-black/[0.1] bg-white px-3 py-2.5 text-[16px] leading-6 text-[#202522] outline-none focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10"
                />
              </label>

              <label className="mt-4 block min-w-0">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Notes</span>
                <textarea
                  value={editDraft.notes}
                  onChange={(event) => setEditDraft((current) => current ? { ...current, notes: event.target.value } : current)}
                  onPaste={(event) => {
                    const files = clipboardImages(event);
                    if (files.length) void queueDetailAttachments(files);
                  }}
                  rows={5}
                  placeholder="Add context, links, or next steps…"
                  maxLength={10000}
                  className="min-h-28 w-full min-w-0 max-w-full resize-y rounded-xl border border-black/[0.1] bg-white px-3 py-2.5 text-sm leading-6 text-[#303632] outline-none placeholder:text-[#a0a6a2] focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10"
                />
              </label>

              <section className="mt-4 min-w-0" aria-labelledby="task-attachments-heading">
                <div className="mb-2 flex min-w-0 items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h4 id="task-attachments-heading" className="text-xs font-semibold uppercase tracking-wide text-[#69716c]">Attachments</h4>
                    <p className="mt-0.5 text-xs text-[#929994]">{detailAttachments.length + detailUploads.length}/{MAX_ATTACHMENTS} attached</p>
                  </div>
                  <AttachmentPicker
                    label="Add attachment to task"
                    showLabel
                    onFiles={(files) => void queueDetailAttachments(files)}
                    onRecord={() => setVoiceTarget("detail")}
                    disabled={detailAttachments.length + detailUploads.length >= MAX_ATTACHMENTS}
                  />
                </div>

                {loadingAttachments ? (
                  <div role="status" aria-label="Loading attachments" className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {[0, 1, 2].map((item) => <div key={item} className="aspect-square animate-pulse rounded-xl bg-[#eef0ed]" />)}
                  </div>
                ) : attachmentError ? (
                  <div className="flex items-center justify-between gap-3 rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700">
                    <span>{attachmentError}</span>
                    <button type="button" onClick={() => void loadTaskAttachments(editingTodo.id)} className="inline-flex items-center gap-1.5 font-semibold"><ActionIcon name="retry" />Retry</button>
                  </div>
                ) : detailAttachments.length || detailUploads.length ? (
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {detailAttachments.map((attachment) => attachment.kind === "audio" ? (
                      <div key={attachment.id} className="group/media col-span-full flex min-w-0 items-center gap-3 rounded-xl bg-[#f3f5f2] p-3 ring-1 ring-black/[0.06]">
                        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#e3efe7] text-[#216e4e]"><ActionIcon name="mic" className="h-5 w-5" /></span>
                        <div className="min-w-0 flex-1"><p className="mb-1 truncate text-xs font-semibold text-[#4d5650]">{attachment.fileName} · {formatDuration(attachment.durationMs)}</p><audio controls preload="metadata" src={attachment.audioUrl} className="h-9 w-full" /></div>
                        <a href={attachment.originalUrl} download={attachment.fileName} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[#69716c] hover:bg-white" aria-label={`Download ${attachment.fileName}`}><ActionIcon name="download" /></a>
                        <button type="button" onClick={() => void deleteDetailAttachment(attachment)} disabled={syncing} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[#69716c] hover:bg-red-50 hover:text-red-700" aria-label={`Delete ${attachment.fileName}`}><ActionIcon name="delete" /></button>
                      </div>
                    ) : (
                      <div key={attachment.id} className="group/media relative aspect-square min-w-0 overflow-hidden rounded-xl bg-[#eef0ed] ring-1 ring-black/[0.06]">
                        {attachment.kind === "image" ? (
                          <button type="button" onClick={() => setViewerIndex(imageAttachments.findIndex((image) => image.id === attachment.id))} className="h-full w-full focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[#216e4e]" aria-label={`View image: ${attachment.fileName}`}>
                            <img src={attachment.thumbnailUrl} alt={attachment.fileName} className="h-full w-full object-cover" />
                          </button>
                        ) : <video controls preload="metadata" src={attachment.videoUrl} className="h-full w-full object-cover" />}
                        <button type="button" onClick={() => void deleteDetailAttachment(attachment)} disabled={syncing} aria-label={`Delete ${attachment.kind}: ${attachment.fileName}`} title={`Delete ${attachment.kind}`} className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full bg-black/65 text-white opacity-100 hover:bg-red-700 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-50 sm:opacity-0 sm:group-hover/media:opacity-100 sm:group-focus-within/media:opacity-100">
                          <ActionIcon name="delete" className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                    {detailUploads.map((item) => (
                      <div key={item.localId} className={classNames("relative min-w-0 overflow-hidden rounded-xl bg-[#eef0ed] ring-1 ring-black/[0.06]", item.kind === "audio" ? "col-span-full h-16" : "aspect-square")} title={item.error || item.file.name}>
                        {item.kind === "image" ? <img src={item.previewUrl} alt="" className="h-full w-full object-cover" /> : item.kind === "video" ? <video src={item.previewUrl} muted className="h-full w-full object-cover" /> : <div className="flex h-full items-center gap-2 px-4 text-sm font-semibold text-[#455049]"><ActionIcon name="mic" className="text-[#216e4e]" />Voice memo · {formatDuration(item.durationMs)}</div>}
                        {item.status === "uploading" ? (
                          <span className="absolute inset-0 grid place-items-center bg-black/45 text-xs font-semibold text-white">Uploading…</span>
                        ) : (
                          <>
                            <button type="button" onClick={() => retryDetailAttachment(item)} aria-label={`Retry ${item.file.name}`} className="absolute inset-0 grid place-items-center bg-red-900/65 text-white"><ActionIcon name="retry" className="h-5 w-5" /></button>
                            <button type="button" onClick={() => removeDetailUpload(item)} aria-label={`Remove ${item.file.name}`} title="Remove failed upload" className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full bg-black/65 text-white hover:bg-red-700"><ActionIcon name="close" className="h-3.5 w-3.5" /></button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-black/[0.1] px-4 py-5 text-center text-sm text-[#8a918d]">No attachments yet.</div>
                )}
              </section>

              <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="block min-w-0">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Project</span>
                  <button
                    type="button"
                    onClick={() => openProjectAssignment([editingTodo.id], "details")}
                    disabled={savingEdit}
                    aria-label={`Assign project. Current project: ${editDraft.project || "Unassigned"}`}
                    className="flex h-11 w-full min-w-0 max-w-full items-center justify-between gap-3 rounded-xl border border-black/[0.1] bg-white px-3 text-left text-[16px] text-[#303632] outline-none hover:bg-[#fafbf9] focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10 disabled:opacity-60"
                  >
                    <span className="min-w-0 truncate">{editDraft.project || "Unassigned"}</span>
                    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold text-[#216e4e]"><ActionIcon name="move" />Change</span>
                  </button>
                </div>
                <label className="block min-w-0">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Context</span>
                  <input value={editDraft.context} onChange={(event) => setEditDraft((current) => current ? { ...current, context: event.target.value } : current)} placeholder="No context" className="h-11 w-full min-w-0 max-w-full rounded-xl border border-black/[0.1] px-3 text-sm outline-none focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10" />
                </label>
                <label className="block min-w-0">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Priority</span>
                  <select value={editDraft.priority} onChange={(event) => setEditDraft((current) => current ? { ...current, priority: Number(event.target.value) } : current)} className="h-11 w-full min-w-0 max-w-full rounded-xl border border-black/[0.1] bg-white px-3 text-sm outline-none focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10">
                    <option value="1">Urgent</option>
                    <option value="2">High</option>
                    <option value="3">Normal</option>
                    <option value="4">Low</option>
                  </select>
                </label>
                <label className="block min-w-0">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Due date</span>
                  <input type="date" value={editDraft.dueDate} onChange={(event) => setEditDraft((current) => current ? { ...current, dueDate: event.target.value } : current)} className="h-11 w-full min-w-0 max-w-full rounded-xl border border-black/[0.1] bg-white px-3 text-sm outline-none focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10" />
                </label>
              </div>

              <div className="mt-5 border-t border-black/[0.07] pt-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#69716c]">Quick actions</p>
                <div className="flex min-w-0 flex-wrap gap-2">
                  {editingTodo.status === "completed" ? (
                    <button type="button" onClick={() => detailAction("unsnooze")} disabled={syncing || savingEdit} className="inline-flex min-w-max items-center gap-2 rounded-xl bg-[#eaf3ed] px-3 py-2.5 text-sm font-semibold text-[#195d41] disabled:opacity-50"><ActionIcon name={todoActionIcon("unsnooze", "Open")} />Open</button>
                  ) : (
                    <button type="button" onClick={() => detailAction("complete")} disabled={syncing || savingEdit} className="inline-flex min-w-max items-center gap-2 rounded-xl bg-[#eaf3ed] px-3 py-2.5 text-sm font-semibold text-[#195d41] disabled:opacity-50"><ActionIcon name={todoActionIcon("complete", "Done")} />Done</button>
                  )}
                  {editingTodo.status === "open" && (isSnoozed(editingTodo, now) ? (
                    <button type="button" onClick={() => detailAction("unsnooze")} disabled={syncing || savingEdit} className="inline-flex min-w-max items-center gap-2 rounded-xl bg-[#eaf3ed] px-3 py-2.5 text-sm font-semibold text-[#195d41] disabled:opacity-50"><ActionIcon name={todoActionIcon("unsnooze", "Wake")} />Wake</button>
                  ) : (
                    <button type="button" onClick={() => detailAction("snooze")} disabled={syncing || savingEdit} className="inline-flex min-w-max items-center gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm font-semibold text-amber-700 disabled:opacity-50"><ActionIcon name={todoActionIcon("snooze", "Snooze")} />Snooze</button>
                  ))}
                  <button type="button" onClick={() => openProjectAssignment([editingTodo.id], "details")} disabled={syncing || savingEdit} className="inline-flex min-w-max items-center gap-2 rounded-xl bg-slate-100 px-3 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50"><ActionIcon name={todoActionIcon("assign", "Assign project")} />Assign project</button>
                  <button type="button" onClick={() => detailAction("delete")} disabled={syncing || savingEdit} className="inline-flex min-w-max items-center gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-sm font-semibold text-red-700 disabled:opacity-50"><ActionIcon name={todoActionIcon("delete", "Delete")} />Delete</button>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-black/[0.07] bg-white px-5 py-3 sm:px-6">
              <button type="button" onClick={closeTaskDetails} disabled={savingEdit} className="inline-flex h-11 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-[#69716c] hover:bg-[#f3f4f2] disabled:opacity-50"><ActionIcon name="cancel" />Cancel</button>
              <button type="submit" disabled={savingEdit || !editDraft.title.trim()} className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#216e4e] px-5 text-sm font-semibold text-white hover:bg-[#195d41] disabled:opacity-50"><ActionIcon name="save" />{savingEdit ? "Saving…" : "Save changes"}</button>
            </div>
          </form>
        </div>
      )}

      {voiceTarget && (
        <VoiceMemoRecorder
          onClose={() => setVoiceTarget(null)}
          onAttach={(file, durationMs) => voiceTarget === "detail" ? queueDetailVoice(file, durationMs) : queueCaptureVoice(file, durationMs)}
        />
      )}

      {viewerAttachment && viewerIndex !== null && (
        <div
          className="fixed inset-0 z-[80] flex touch-pan-y items-center justify-center overflow-hidden bg-black/92 p-3 sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label={`Image viewer: ${viewerAttachment.fileName}`}
          onPointerDown={(event) => { if (event.pointerType === "touch") viewerGesture.current = event.clientX; }}
          onPointerUp={(event) => {
            const start = viewerGesture.current;
            viewerGesture.current = null;
            if (start === null || imageAttachments.length < 2) return;
            const delta = event.clientX - start;
            if (Math.abs(delta) < 50) return;
            setViewerIndex((current) => current === null ? null : delta < 0
              ? (current + 1) % imageAttachments.length
              : (current - 1 + imageAttachments.length) % imageAttachments.length);
          }}
        >
          <button type="button" onClick={() => setViewerIndex(null)} aria-label="Close image viewer" className="absolute inset-0 cursor-zoom-out" />
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 pb-8 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6">
            <span className="min-w-0 truncate text-sm font-medium text-white/85">{viewerAttachment.fileName}</span>
            <div className="pointer-events-auto flex shrink-0 items-center gap-1">
              <a href={viewerAttachment.originalUrl} download={viewerAttachment.fileName} className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20" aria-label="Download original" title="Download original"><ActionIcon name="download" className="h-5 w-5" /></a>
              <button type="button" onClick={() => void deleteDetailAttachment(viewerAttachment)} className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white hover:bg-red-600" aria-label="Delete image" title="Delete image"><ActionIcon name="delete" className="h-5 w-5" /></button>
              <button type="button" onClick={() => setViewerIndex(null)} className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20" aria-label="Close image viewer" title="Close"><ActionIcon name="close" className="h-5 w-5" /></button>
            </div>
          </div>

          <img src={viewerAttachment.displayUrl} alt={viewerAttachment.fileName} className="pointer-events-none relative max-h-full max-w-full object-contain" />

          {imageAttachments.length > 1 && (
            <>
              <button type="button" onClick={() => setViewerIndex((viewerIndex - 1 + imageAttachments.length) % imageAttachments.length)} aria-label="Previous image" className="absolute left-3 top-1/2 hidden h-12 w-12 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white hover:bg-black/70 sm:grid"><ActionIcon name="previous" className="h-6 w-6" /></button>
              <button type="button" onClick={() => setViewerIndex((viewerIndex + 1) % imageAttachments.length)} aria-label="Next image" className="absolute right-3 top-1/2 hidden h-12 w-12 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white hover:bg-black/70 sm:grid"><ActionIcon name="next" className="h-6 w-6" /></button>
              <span className="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] rounded-full bg-black/55 px-3 py-1.5 text-xs font-semibold text-white/90">{viewerIndex + 1} / {imageAttachments.length}</span>
            </>
          )}
        </div>
      )}

      {notice && (
        <div
          className="pointer-events-none fixed inset-x-0 z-[60] mx-auto w-[calc(100%-2rem)] max-w-md transition-[bottom] duration-200"
          style={{ bottom: selectedIds.length > 0 ? "max(5.25rem, calc(env(safe-area-inset-bottom) + 5rem))" : "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <div
            role={notice.tone === "error" ? "alert" : "status"}
            className={classNames(
              "pointer-events-auto flex min-h-14 items-center gap-3 rounded-2xl px-4 py-3 text-sm text-white shadow-[0_16px_50px_rgba(0,0,0,0.24)]",
              notice.tone === "error" ? "bg-red-700" : "bg-[#202522]",
            )}
          >
            <span className="min-w-0 flex-1 font-medium">{notice.text}</span>
            {notice.undoToken && (
              <button
                type="button"
                onClick={() => { setNotice(null); void undoAction(notice.undoToken as string); }}
                disabled={undoing}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 font-semibold text-[#8ee0b5] transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-50"
              >
                <ActionIcon name="undo" />
                {undoing ? "Undoing…" : "Undo"}
              </button>
            )}
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notification" title="Dismiss" className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/65 hover:bg-white/10 hover:text-white"><ActionIcon name="close" /></button>
          </div>
        </div>
      )}
    </main>
  );
}

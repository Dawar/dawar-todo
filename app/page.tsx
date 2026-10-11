/* eslint-disable @next/next/no-img-element */
"use client";

import {
  ClipboardEvent as ReactClipboardEvent,
  FormEvent,
  PointerEvent as ReactPointerEvent,
  memo,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { TodoForward } from "./todo-forward-picker";
import { TodoQueue, type QueueRequest } from "./todo-queue-picker";
import type { TaskQueueSource } from "../lib/task-queue-export";
import { registerPwaUpdateGuard } from "./pwa-update";
import { todoCopyText } from "./todo-forward";
import { TaskCaptureSession, TaskCaptureGate } from "./task-capture";
import { TaskImageViewer } from "./task-image-viewer";
import { TaskNotice, type TaskNoticeState } from "./task-notice";
import { TaskBulkActions } from "./task-bulk-actions";
import { TaskIntentPanel } from "./task-intent-panel";
import { taskRowClock } from "./task-title-layout";
import { useTaskList, useTask, taskStore } from "./task-store";
import { taskSync, type TaskSyncEvent } from "./task-sync";
import { useStableCallback } from "./use-stable-callback";
import { taskKey, createLocalTaskId, offlineRecordTodo, type Todo, type TodoSettings, type CaptureDraft, type BootstrapResponse, type SyncResponse } from "./task-model";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { attachmentFileMimeType } from "../lib/attachment-files";
import { uploadTaskAttachmentMultipart } from "./attachment-upload-client";
import { ActionIcon, type ActionIconName } from "./action-icon";
import { currentOpenTaskCount, updateNativeAppBadge } from "./app-badge";
import { copyTextToClipboard } from "./copy-to-clipboard";
import { cronValidationError } from "../lib/cron";
import { headersWithDeviceId } from "./device-id";
import { request, retryableSyncError, syncFailureKind, syncRetryDelay } from "./sync-request";
import {
  expiredSnoozeIds,
  isActivelySnoozed,
  nextSnoozeWakeAt,
} from "../lib/snooze-clock";
import {
  DEFAULT_QUICK_SNOOZE_PRESETS,
  quickSnoozeDurationMs,
  type QuickSnoozePreset,
} from "../lib/snooze-presets";
import type { RealtimeVoice } from "../lib/ai-preferences";
import { snoozeLabel } from "../lib/snooze-label";
import { zonedDateTimeInputValue, zonedLocalDateTimeToUtc } from "../lib/zoned-date-time";
import { AttachmentQueuePanel } from "./attachment-queue-panel";
import { attachmentQueueMessage, hasAttachmentBytes } from "./attachment-queue";
import { SiteHeader } from "./site-header";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PendingTaskAttachment, CaptureAttachments } from "./pending-task-attachment";
import { VoiceMemoRecorder } from "./voice-memo-recorder";
import { Skeleton } from "@/components/ui/skeleton";
import { TaskAttachmentMedia } from "./task-attachment-media";
import { AttachmentPicker } from "./attachment-picker";
import { TaskDetailFields } from "./task-detail-fields";
import { TaskRow, SnoozeStatusBadge } from "./task-row";
import { TaskListControls, TaskFiltersDialog } from "./task-list-controls";
import { ProjectBrowser } from "./project-browser";
import { CreateProjectDialog, CustomSnoozeDialog, AssignProjectDialog, DeleteProjectDialog } from "./task-dialogs";
import { KeyboardShortcutsDialog } from "./keyboard-shortcuts-dialog";
import { PullGesturePill } from "./pull-to-refresh";
import { MarkdownPreview } from "./markdown-preview";
import { createSyncHealth, liveSyncDelay, type ConnectionQuality } from "./sync-health";
import { recordSyncDiagnostic } from "./sync-diagnostics";
import { MAX_TASK_DESCRIPTION_LENGTH } from "../lib/task-description";
import { MAX_PINNED_TASKS, PIN_LIST_PREFERENCE_KEY } from "../lib/task-pins";
import {
  appendOfflineTodoAttachments,
  queueTaskAttachments,
  listQueuedAttachments,
  retryQueuedAttachments,
  cancelQueuedAttachment,
  deferOfflineTaskAction,
  deleteOfflineTodo,
  deleteOfflineTodoAttachment,
  deleteOfflineTodoByLocalId,
  deleteOfflineTodoMutation,
  deleteOfflineTaskAction,
  getOfflineTodoByLocalId,
  loadCachedServerState,
  listOfflineTodos,
  listOfflineTaskActions,
  listOfflineTodoMutations,
  markOfflineTodoAttachmentUploaded,
  markOfflineTaskActionUndo,
  persistOfflineStorage,
  saveOfflineCaptureDraft,
  saveOfflineTaskAction,
  saveOfflineTodoMutation,
  saveCachedServerState,
  updateOfflineTodo,
  type OfflineAttachmentKind,
  type OfflineTaskAction,
  type OfflineTodoRecord,
} from "./offline-store";

type View = "open" | "snoozed" | "done" | "all";
type TaskListView = View;
type TodoAction = "complete" | "snooze" | "unsnooze" | "delete";
type ExecutableTodoAction = TodoAction;
type SnoozePreset = QuickSnoozePreset;
type SnoozeAdjustment = { preset: SnoozePreset } | { localDateTime: string };
type Notice = TaskNoticeState | null;


type OptimisticOperation = {
  ids: number[];
  previous: Todo[];
  action: ExecutableTodoAction | "merge" | "pin" | "project";
  undoRequested: boolean;
  settled: boolean;
  undoToken?: string;
  snoozeAdjustment?: SnoozeAdjustment;
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
  status: "staged" | "uploading" | "ready" | "error" | "offline";
  attachment: TodoAttachment | null;
  error: string;
};

type TodoDraft = Pick<Todo, "title" | "notes" | "priority"> & {
  dueDate: string;
  project: string;
  context: string;
  recurrenceCron: string;
};

type AutosaveField = "title" | "notes" | "priority" | "dueDate" | "context" | "recurrenceCron";
type AutosavePatch = Partial<Record<AutosaveField, string | number | null>>;
type EditSaveState = "saved" | "saving" | "offline" | "error";
type PersistTaskDraft = (
  todoId: number,
  draft: TodoDraft,
  source: "debounce" | "close" | "retry",
  baselineOverride?: TodoDraft,
) => Promise<void>;

type ProjectDialogState = {
  ids: number[];
  selection: string;
  newProject: string;
  openedFromDetails: boolean;
  captureDraft: boolean;
};

type ProjectDeleteDialogState = {
  name: string;
  mode: "reassign" | "delete";
  targetProject: string;
};

type CustomSnoozeDialogState = {
  ids: number[];
  operationId?: string;
  localDateTime: string;
  error: string;
};

type TaskDialogPullGesture = {
  startX: number;
  startY: number;
  active: boolean;
  startedInScrollArea: boolean;
};

const CREATE_PROJECT = "__create_project__";
const UNASSIGNED_PROJECT = "__unassigned_project__";

const viewLabels: Record<View, string> = {
  open: "Open",
  snoozed: "Snoozed",
  done: "Done",
  all: "All",
};


const AUTOSAVE_FIELDS: AutosaveField[] = ["title", "notes", "priority", "dueDate", "context", "recurrenceCron"];

function todoDraft(todo: Todo): TodoDraft {
  return {
    title: todo.title,
    notes: todo.notes,
    priority: todo.priority,
    dueDate: dateInputValue(todo.dueDate),
    project: todo.project ?? "",
    context: todo.context ?? "",
    recurrenceCron: todo.recurrenceCron ?? "",
  };
}

function normalizedDraftField(draft: TodoDraft, field: AutosaveField) {
  // Preserve the exact textarea value while autosaving. Trimming here made a
  // server round-trip erase a just-typed trailing space or newline.
  if (field === "title" || field === "notes") return draft[field];
  if (field === "priority") return draft.priority;
  if (field === "dueDate") return draft.dueDate || null;
  if (field === "context") return draft.context.trim() || null;
  return draft.recurrenceCron.trim() || null;
}

function changedDraftPatch(draft: TodoDraft, baseline: TodoDraft) {
  const patch: AutosavePatch = {};
  for (const field of AUTOSAVE_FIELDS) {
    const current = normalizedDraftField(draft, field);
    if (current !== normalizedDraftField(baseline, field)) patch[field] = current;
  }
  return patch;
}

function patchTodo(todo: Todo, patch: Record<string, unknown>) {
  return {
    ...todo,
    ...(patch as Partial<Todo>),
    ...(Object.keys(patch).length ? { queueDelegation: null } : {}),
    ...(patch.title !== undefined ? { title: String(patch.title) } : {}),
    ...(patch.notes !== undefined ? { notes: String(patch.notes) } : {}),
    ...(patch.priority !== undefined ? { priority: Number(patch.priority) } : {}),
    ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate ? String(patch.dueDate) : null } : {}),
    ...(patch.context !== undefined ? { context: patch.context ? String(patch.context) : null } : {}),
    ...(patch.recurrenceCron !== undefined ? { recurrenceCron: patch.recurrenceCron ? String(patch.recurrenceCron) : null, snoozedUntil: patch.recurrenceCron ? null : todo.snoozedUntil } : {}),
    ...(patch.sortOrder !== undefined ? { sortOrder: Number(patch.sortOrder) } : {}),
  };
}

const MAX_ATTACHMENTS = 12;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_AUDIO_DURATION_MS = 30 * 60 * 1000;
const MAX_VIDEO_DURATION_MS = 60 * 60 * 1000;
const MAX_IMAGE_PIXELS = 100_000_000;
const SYNC_STATUS_DELAY_MS = 5_000;
const TASK_SORT_ORDER_STEP = 1024;
const TASK_REORDER_EDGE_SCROLL_ZONE_PX = 88;
const TASK_REORDER_MAX_SCROLL_PX = 18;

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

async function decodedImage(file: Blob) {
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

async function clipboardPng(imageUrl: string) {
  const response = await fetch(imageUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`The image could not be loaded (${response.status}).`);
  const blob = await response.blob();
  if (blob.type === "image/png") return blob;
  const decoded = await decodedImage(blob).catch(() => {
    throw new Error("This image cannot be copied by this browser.");
  });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("This browser cannot prepare the image clipboard.");
    context.drawImage(decoded.source, 0, 0, decoded.width, decoded.height);
    return await canvasBlob(canvas, "image/png", 1);
  } finally {
    decoded.cleanup();
  }
}

async function copyImageToClipboard(imageUrl: string) {
  if (!window.isSecureContext || !navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image clipboard access is unavailable.");
  }
  const png = clipboardPng(imageUrl);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
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

const imageVariantPromises = new WeakMap<File, ReturnType<typeof prepareImageVariants>>();

async function prepareImageVariants(file: File) {
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

function imageVariants(file: File) {
  const existing = imageVariantPromises.get(file);
  if (existing) return existing;
  const prepared = prepareImageVariants(file).catch((error) => {
    imageVariantPromises.delete(file);
    throw error;
  });
  imageVariantPromises.set(file, prepared);
  return prepared;
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

function normalizedFileMimeType(file: File) {
  return attachmentFileMimeType(file.name, file.type);
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
  kind: "audio" | "video" | "file",
  durationMs: number,
  endpoint: string,
  target: Record<string, string>,
  discard: (uploadId: string) => Promise<unknown>,
) {
  const mimeType = kind === "file" ? normalizedFileMimeType(file) : normalizedMediaMimeType(file, kind);
  const prepared = await request<PreparedMediaUpload>(endpoint, {
    method: "POST",
    body: JSON.stringify({
      ...target,
      kind,
      fileName: file.name || (kind === "audio" ? "Voice memo" : kind === "video" ? "Video" : "File"),
      mimeType,
      byteSize: file.size,
    }),
  });
  try {
    await postPrivateVariant(prepared.uploads.original, file);
    return await request<{ attachment: TodoAttachment }>(endpoint, {
      method: "PATCH",
      body: JSON.stringify({ ...target, kind, uploadId: prepared.uploadId, durationMs: kind === "file" ? 0 : durationMs }),
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


function isSnoozed(todo: Todo, now: number) {
  return isActivelySnoozed(todo, now);
}


function optimisticSnoozeUntil(preset: SnoozePreset, now = new Date()) {
  return new Date(now.valueOf() + quickSnoozeDurationMs(preset)).toISOString();
}

function restoreOptimisticTasks(current: Todo[], previous: Todo[], ids: number[]) {
  const restoreIds = new Set(ids);
  const currentById = new Map(current.map((todo) => [todo.id, todo]));
  const previousIds = new Set(previous.map((todo) => todo.id));
  const restored = previous.flatMap((todo) => {
    if (restoreIds.has(todo.id)) return [todo];
    const latest = currentById.get(todo.id);
    return latest ? [latest] : [];
  });
  current.forEach((todo) => {
    if (!previousIds.has(todo.id)) restored.push(todo);
  });
  return restored;
}

function dateInputValue(value: string | null) {
  return value?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
}

function canonicalSortOrder(todo: Todo) {
  return Number.isFinite(todo.sortOrder)
    ? todo.sortOrder
    : Number.MAX_SAFE_INTEGER;
}

function compareCanonicalOrder(a: Todo, b: Todo) {
  return canonicalSortOrder(a) - canonicalSortOrder(b) || b.id - a.id;
}

function reorderCanonicalTodos(
  current: Todo[],
  movedId: number,
  targetId: number,
  placement: "before" | "after",
) {
  const ordered = [...current].sort(compareCanonicalOrder);
  const movedIndex = ordered.findIndex((todo) => todo.id === movedId);
  if (movedIndex < 0 || movedId === targetId) return current;
  const [moved] = ordered.splice(movedIndex, 1);
  const targetIndex = ordered.findIndex((todo) => todo.id === targetId);
  if (targetIndex < 0) return current;
  ordered.splice(targetIndex + (placement === "after" ? 1 : 0), 0, moved);
  let serverIndex = 0;
  const orderById = new Map<number, number>();
  for (const todo of ordered) {
    if (todo.id < 1 || todo.offline) continue;
    orderById.set(todo.id, serverIndex * TASK_SORT_ORDER_STEP);
    serverIndex += 1;
  }
  return current.map((todo) => {
    const sortOrder = orderById.get(todo.id);
    return sortOrder === undefined || sortOrder === todo.sortOrder ? todo : { ...todo, sortOrder };
  });
}

function matchesView(todo: Todo, view: View, now: number) {
  const snoozed = isSnoozed(todo, now);
  if (view === "open") return !todo.queueDelegation && todo.status === "open" && !snoozed;
  if (view === "snoozed") return !todo.queueDelegation && snoozed;
  if (view === "done") return todo.status === "completed";
  if (view === "all") return todo.status === "open" || todo.status === "completed";
  return false;
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

const DIALOG_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "audio[controls]",
  "video[controls]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function dialogFocusableElements(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR)]
    .filter((element) => element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0);
}


function offlineTaskPatch(todo: Todo) {
  return {
    title: todo.title,
    notes: todo.notes,
    status: todo.status,
    priority: todo.priority,
    dueDate: todo.dueDate,
    project: todo.project,
    context: todo.context,
    completedAt: todo.completedAt,
    snoozedUntil: todo.snoozedUntil,
    recurrenceCron: todo.recurrenceCron,
    recurrenceLastFiredAt: todo.recurrenceLastFiredAt,
    pinned: todo.pinned,
    sortOrder: todo.sortOrder,
    sourceKind: todo.sourceKind,
    sourceId: todo.sourceId,
  } satisfies Partial<OfflineTodoRecord>;
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

const SubscribedTaskRow = memo(function SubscribedTaskRow(props: React.ComponentProps<typeof TaskRow>) {
  const current = useTask(taskKey(props.todo));
  return current ? <TaskRow {...props} todo={current} now={taskRowClock(current, props.now)} /> : null;
});

function resizeCapture(textarea: HTMLTextAreaElement) {
  textarea.style.overflowY = "hidden";
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

export default function Home() {
  const [loading, setLoading] = useState(true);
  const [todos, setTodos] = useTaskList();
  const [taskListAnimationRef, setTaskListAnimations] = useAutoAnimate<HTMLUListElement>({
    duration: 180,
    easing: "cubic-bezier(0.2, 0.75, 0.25, 1)",
  });
  const [view, setView] = useState<View>("open");
  const [registeredProjects, setRegisteredProjects] = useState<string[]>([]);
  const [scheduleTimeZone, setScheduleTimeZone] = useState("America/Toronto");
  const [quickSnoozePresets, setQuickSnoozePresets] = useState<QuickSnoozePreset[]>(DEFAULT_QUICK_SNOOZE_PRESETS);
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("");
  const [priority, setPriority] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [captureProject, setCaptureProject] = useState("");
  const [captureDraftToken, setCaptureDraftToken] = useState(() => crypto.randomUUID());
  const [captureAttachments, setCaptureAttachments] = useState<PendingAttachment[]>([]);
  const captureFilesRef = useRef<PendingAttachment[]>([]);
  const captureProjectRef = useRef("");
  const captureTokenRef = useRef(captureDraftToken);
  const captureSession = useRef<TaskCaptureSession | null>(null);
  if (!captureSession.current) captureSession.current = new TaskCaptureSession();
  const [captureReady, setCaptureReady] = useState(false);
  const [captureSaveState, setCaptureSaveState] = useState("Loading draft…");
  const captureSaveSequence = useRef(0);
  const captureGate = useRef(new TaskCaptureGate());
  const [capturePreparing, setCapturePreparing] = useState(false);
  const captureMounted = useRef(false);
  const [recognizingCaptureTitle, setRecognizingCaptureTitle] = useState(false);
  const [adding, setAdding] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [adjustingSnooze, setAdjustingSnooze] = useState<SnoozePreset | "custom" | null>(null);
  const [customSnoozeDialog, setCustomSnoozeDialog] = useState<CustomSnoozeDialogState | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [pinListEnabled, setPinListEnabled] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [queueRequest, setQueueRequest] = useState<QueueRequest | null>(null);
  const [editDraft, setEditDraft] = useState<TodoDraft | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editSaveState, setEditSaveState] = useState<EditSaveState>("saved");
  const [editSaveMessage, setEditSaveMessage] = useState("Saved automatically");
  const [descriptionPreview, setDescriptionPreview] = useState(false);
  const [detailAttachments, setDetailAttachments] = useState<TodoAttachment[]>([]);
  const [detailUploads, setDetailUploads] = useState<PendingAttachment[]>([]);
  const voiceReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const [voiceTarget, setVoiceTarget] = useState<"capture" | "detail" | null>(null);
  const [online, setOnline] = useState(true);
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality>("online");
  const [offlineCount, setOfflineCount] = useState(0);
  const [offlineEditCount, setOfflineEditCount] = useState(0);
  const [offlineActionCount, setOfflineActionCount] = useState(0);
  const [showPendingSyncStatus, setShowPendingSyncStatus] = useState(false);
  const [imageDropActive, setImageDropActive] = useState(false);
  const [loadingAttachments, setLoadingAttachments] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [viewerCopyState, setViewerCopyState] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const [projectSelectorOpen, setProjectSelectorOpen] = useState(false);
  const projectReturnFocusRef = useRef<HTMLElement | null>(null);
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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [inlineEditingId, setInlineEditingId] = useState<number | null>(null);
  const [reorderingId, setReorderingId] = useState<number | null>(null);
  const [reorderTargetId, setReorderTargetId] = useState<number | null>(null);
  const [taskDialogPullDistance, setTaskDialogPullDistance] = useState(0);
  const [taskDialogPullReady, setTaskDialogPullReady] = useState(false);
  const [taskDialogPulling, setTaskDialogPulling] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const captureRef = useRef<HTMLTextAreaElement>(null);
  const newTitleRef = useRef("");
  const captureDraftClientIdRef = useRef(crypto.randomUUID());
  const captureDraftRef = useRef<CaptureDraft | null>(null);
  const prepareUpdateRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => registerPwaUpdateGuard("todo-input", () => prepareUpdateRef.current()), []);
  const captureDraftSaveTimerRef = useRef<number | null>(null);
  const captureDraftInFlightRef = useRef(false);
  const queuedCaptureDraftRef = useRef<CaptureDraft | null>(null);
  const pendingRemoteCaptureDraftRef = useRef<CaptureDraft | null>(null);
  const captureDraftClockRef = useRef(0);
  const captureTitleRecognitionRef = useRef<{ requestId: number; localId: string } | null>(null);
  const captureTitleRecognitionSequenceRef = useRef(0);
  const persistCaptureDraftRef = useRef<((draft: CaptureDraft, source: string) => Promise<void>) | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const imageDropDepth = useRef(0);
  const editingIdRef = useRef<number | null>(null);
  const editDraftRef = useRef<TodoDraft | null>(null);
  const editBaselineRef = useRef<TodoDraft | null>(null);
  const taskDialogRef = useRef<HTMLFormElement>(null);
  const taskDialogReturnFocusRef = useRef<HTMLElement | null>(null);
  const taskDialogReturnTodoIdRef = useRef<number | null>(null);
  const taskDialogScrollRef = useRef<HTMLDivElement>(null);
  const taskDialogGestureRef = useRef<TaskDialogPullGesture | null>(null);
  const taskDialogRawPullRef = useRef(0);
  const autosaveTimerRef = useRef<number | null>(null);
  const autosaveInFlightRef = useRef(false);
  const queuedAutosaveRef = useRef<{ todoId: number; draft: TodoDraft; baseline: TodoDraft } | null>(null);
  const activeEditFieldRef = useRef<AutosaveField | null>(null);
  const activeEditFocusValueRef = useRef<string | number | null>(null);
  const deferredRemoteEditFieldsRef = useRef<Map<AutosaveField, TodoDraft[AutosaveField]>>(new Map());
  const syncOfflineQueueRef = useRef<(() => Promise<void>) | null>(null);
  const persistTaskDraftRef = useRef<PersistTaskDraft | null>(null);
  const closeTaskDetailsRef = useRef<() => void>(() => undefined);
  const pendingTodoPatchesRef = useRef<Map<number, Record<string, unknown>>>(new Map());
  const inlineTitleTimersRef = useRef<Map<string, number>>(new Map());
  const inlineTitleLastValidRef = useRef<Map<string, string>>(new Map());
  const pendingActionPatchesRef = useRef<Map<number, Record<string, unknown>>>(new Map());
  const pendingDeletedIdsRef = useRef<Set<number>>(new Set());
  const pendingCompletionIdsRef = useRef<Set<number>>(new Set());
  const optimisticOperationsRef = useRef<Map<string, OptimisticOperation>>(new Map());
  const [uploadCount, setUploadCount] = useState(0);
  const [uploadStates, setUploadStates] = useState<Record<string, number>>({});
  const lastLiveSnapshotRef = useRef("");
  const syncWakeTimerRef = useRef<number | null>(null);
  const syncWakeAtRef = useRef(0);
  const reorderGestureRef = useRef<{
    todoId: number;
    allowedIds: Set<number>;
    initialTodos: Todo[];
    targetId: number | null;
    placement: "before" | "after";
    startClientY: number;
    latestClientX: number;
    latestClientY: number;
    previewElement: HTMLElement;
    sourceRowElement: HTMLElement;
    animationFrameId: number | null;
    startedAt: number;
    moveEvents: number;
    targetChanges: number;
    autoScrollFrames: number;
    autoScrollActive: boolean;
  } | null>(null);
  const reorderPreviewRef = useRef<Todo[] | null>(null);
  const reorderAnimationRestoreFrameRef = useRef<number | null>(null);
  const lastAppBadgeCountRef = useRef<number | null>(null);
  const deepLinkedTaskOpenedRef = useRef(false);
  const [detailAttachmentPickerOpen, setDetailAttachmentPickerOpen] = useState(false);
  const taskDialogNestedOverlayOpen = detailAttachmentPickerOpen || queueRequest !== null || projectDialog !== null || viewerIndex !== null || voiceTarget !== null || customSnoozeDialog !== null;
  const overlayOpen = editingId !== null || projectSelectorOpen || projectDialog !== null || newProjectOpen || projectDeleteDialog !== null || filtersOpen || viewerIndex !== null || voiceTarget !== null || shortcutsOpen || customSnoozeDialog !== null;

  useEffect(() => () => {
    inlineTitleTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    inlineTitleTimersRef.current.clear();
    if (syncWakeTimerRef.current !== null) window.clearTimeout(syncWakeTimerRef.current);
    syncWakeTimerRef.current = null;
    syncWakeAtRef.current = 0;
    const reorderGesture = reorderGestureRef.current;
    if (reorderGesture && reorderGesture.animationFrameId !== null) window.cancelAnimationFrame(reorderGesture.animationFrameId);
    reorderGesture?.previewElement.remove();
    if (reorderGesture?.sourceRowElement) reorderGesture.sourceRowElement.style.opacity = "";
    if (reorderAnimationRestoreFrameRef.current !== null) window.cancelAnimationFrame(reorderAnimationRestoreFrameRef.current);
    reorderAnimationRestoreFrameRef.current = null;
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(PIN_LIST_PREFERENCE_KEY);
      if (stored === "off") setPinListEnabled(false);
      console.info("[todo-ui] pin list preference loaded", {
        enabled: stored !== "off",
        stored: stored ?? "default",
      });
    } catch (error) {
      console.warn("[todo-ui] pin list preference unavailable", { error });
    }
  }, []);

  function rebuildPendingActionState(actions: OfflineTaskAction[]) {
    const patches = new Map<number, Record<string, unknown>>();
    const deletedIds = new Set<number>();
    for (const action of actions) {
      if (action.undoRequested) continue;
      for (const [rawId, patch] of Object.entries(action.optimisticPatches ?? {})) {
        const id = Number(rawId);
        patches.set(id, { ...(patches.get(id) ?? {}), ...patch });
      }
      for (const id of action.optimisticDeletedIds ?? []) deletedIds.add(id);
    }
    pendingActionPatchesRef.current = patches;
    pendingDeletedIdsRef.current = deletedIds;
    console.info("[todo-offline] optimistic action overlay rebuilt", {
      queuedActions: actions.length,
      patchedTasks: patches.size,
      deletedTasks: deletedIds.size,
    });
  }

  function applyPendingOverlays(todo: Todo) {
    return patchTodo(
      patchTodo(todo, pendingTodoPatchesRef.current.get(todo.id) ?? {}),
      pendingActionPatchesRef.current.get(todo.id) ?? {},
    );
  }

  function reconcileRemoteEditDraft(remoteTodo: Todo, source: string) {
    const currentDraft = editDraftRef.current;
    const baseline = editBaselineRef.current;
    if (!currentDraft || !baseline || editingIdRef.current !== remoteTodo.id) return;
    const remoteDraft = todoDraft(remoteTodo);
    const nextDraft = { ...currentDraft };
    const nextBaseline = { ...baseline };
    let changed = false;
    for (const field of [...AUTOSAVE_FIELDS, "project" as const]) {
      if (currentDraft[field] !== baseline[field]) continue;
      if (field === activeEditFieldRef.current) {
        deferredRemoteEditFieldsRef.current.set(field, remoteDraft[field]);
        console.info("[todo-sync] remote field deferred during active editing", {
          todoId: remoteTodo.id,
          field,
          source,
        });
        continue;
      }
      nextDraft[field] = remoteDraft[field] as never;
      nextBaseline[field] = remoteDraft[field] as never;
      if (nextDraft[field] !== currentDraft[field]) changed = true;
    }
    editBaselineRef.current = nextBaseline;
    editDraftRef.current = nextDraft;
    if (changed) setEditDraft(nextDraft);
  }

  function applyRemoteCaptureDraft(remoteDraft: CaptureDraft | null, source: "bootstrap" | "poll" | "reconnect" | "mutation") {
    if (!remoteDraft) return;
    const localDraft = captureDraftRef.current;
    if (localDraft && remoteDraft.version <= localDraft.version) return;
    if (!captureReady || captureFilesRef.current.length || document.activeElement === captureRef.current) {
      pendingRemoteCaptureDraftRef.current = remoteDraft;
      console.info("[todo-sync] remote Quick Add draft deferred during active typing", {
        source,
        remoteVersion: remoteDraft.version,
        localVersion: localDraft?.version ?? null,
        remoteTextLength: remoteDraft.text.length,
        localTextLength: localDraft?.text.length ?? newTitleRef.current.length,
      });
      return;
    }
    captureDraftRef.current = remoteDraft;
    newTitleRef.current = remoteDraft.text;
    setNewTitle(remoteDraft.text);
    void checkpointCapture().catch(() => undefined);
    void saveOfflineCaptureDraft({ key: "quick-add", ...remoteDraft }).catch((error) => {
      console.error("[todo-offline] remote Quick Add draft cache failed", { source, error });
    });
    window.requestAnimationFrame(() => {
      if (captureRef.current) resizeCapture(captureRef.current);
    });
    console.info("[todo-sync] remote Quick Add draft applied", {
      source,
      version: remoteDraft.version,
      textLength: remoteDraft.text.length,
    });
  }

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

  const applyLiveSnapshot = useStableCallback((remoteTodos: Todo[], source: "initial" | "poll" | "reconnect" | "snooze-wake") => {
    const pendingPatches = pendingTodoPatchesRef.current;
    const missingOrderIds = remoteTodos
      .filter((todo) => !Number.isFinite(todo.sortOrder))
      .map((todo) => todo.id);
    if (missingOrderIds.length) {
      console.warn("[todo-order] remote snapshot contained tasks without canonical order", {
        source,
        count: missingOrderIds.length,
        ids: missingOrderIds.slice(0, 20),
      });
    }
    const resolved = remoteTodos
      .filter((todo) => !pendingDeletedIdsRef.current.has(todo.id))
      .map(applyPendingOverlays);
    const activeId = editingIdRef.current;
    const remoteTodo = activeId === null ? null : resolved.find((todo) => todo.id === activeId) ?? null;
    if (remoteTodo) {
      reconcileRemoteEditDraft(remoteTodo, source);
    } else if (activeId !== null && activeId > 0 && !remoteTodo && !pendingPatches.has(activeId)) {
      if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
      setEditingId(null);
      setEditDraft(null);
      editingIdRef.current = null;
      editDraftRef.current = null;
      editBaselineRef.current = null;
      detailUploads.forEach((item) => URL.revokeObjectURL(item.previewUrl));
      setDetailUploads([]);
      setNotice({ tone: "error", text: "This task was deleted on another device." });
      console.warn("[todo-sync] open task removed by remote snapshot", { todoId: activeId, source });
    }
    const signature = resolved.map((todo) => `${todo.id}:${todo.updatedAt}:${todo.attachmentCount}:${todo.sortOrder}`).join("|");
    const changed = signature !== lastLiveSnapshotRef.current;
    lastLiveSnapshotRef.current = signature;
    if (source !== "poll" || changed) {
      console.info("[todo-sync] server snapshot applied", {
        source,
        remote: remoteTodos.length,
        pendingEdits: pendingPatches.size,
        editingId: activeId,
      });
    }
  });

  const applyLiveDelta = useStableCallback((remoteTodos: Todo[], deletedIds: number[], source: "poll" | "reconnect" | "snooze-wake") => {
    if (!remoteTodos.length && !deletedIds.length) return;
    const pendingPatches = pendingTodoPatchesRef.current;
    const missingOrderIds = remoteTodos
      .filter((todo) => !Number.isFinite(todo.sortOrder))
      .map((todo) => todo.id);
    if (missingOrderIds.length) {
      console.warn("[todo-order] remote delta contained tasks without canonical order", {
        source,
        count: missingOrderIds.length,
        ids: missingOrderIds.slice(0, 20),
      });
    }
    // The store retains rejected edits when a target disappears. Never discard
    // those operations from a view callback; the recovery panel owns their UI.
    const changed = remoteTodos
      .filter((todo) => !pendingDeletedIdsRef.current.has(todo.id))
      .map(applyPendingOverlays);
    const changedById = new Map(changed.map((todo) => [todo.id, todo]));
    const deleted = new Set(deletedIds);
    const activeId = editingIdRef.current;
    const remoteTodo = activeId === null ? null : changedById.get(activeId) ?? null;
    if (remoteTodo) {
      reconcileRemoteEditDraft(remoteTodo, source);
    } else if (activeId !== null && deleted.has(activeId) && !pendingPatches.has(activeId)) {
      if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
      setEditingId(null);
      setEditDraft(null);
      editingIdRef.current = null;
      editDraftRef.current = null;
      editBaselineRef.current = null;
      detailUploads.forEach((item) => URL.revokeObjectURL(item.previewUrl));
      setDetailUploads([]);
      setNotice({ tone: "error", text: "This task was deleted on another device." });
      console.warn("[todo-sync] open task removed by remote delta", { todoId: activeId, source });
    }
  });

  const refreshLiveData = useEffectEvent(async (_source: string) => { taskSync.wake(); });

  const reconcileTaskClock = useEffectEvent((source: "focus" | "visibility" | "online") => {
    const reconciledAt = Date.now();
    const expiredIds = expiredSnoozeIds(todos, reconciledAt);
    setNow(reconciledAt);
    console.info("[todo-snooze] task clock reconciled", {
      source,
      reconciledAt: new Date(reconciledAt).toISOString(),
      expiredIds,
    });
  });

  const hydrateCapture = useStableCallback(() => {
    if (captureGate.current.ready) return; // Activity reveal must preserve current unsaved input.
    setCaptureSaveState("Loading draft…");
    void captureSession.current!.load().then((stored) => {
      if (!captureMounted.current || captureGate.current.ready) return;
      captureTokenRef.current = stored.token;
      setCaptureDraftToken(stored.token);
      captureProjectRef.current = stored.project;
      setCaptureProject(stored.project);
      const items: PendingAttachment[] = stored.attachments.map((item) => ({
        localId: item.localId, kind: item.kind, durationMs: item.durationMs,
        file: new File([item.blob], item.fileName, { type: item.mimeType }),
        previewUrl: URL.createObjectURL(item.blob), status: "staged", attachment: null, error: "",
      }));
      captureFilesRef.current = items; setCaptureAttachments(items);
      const draft = stored.draft;
      if (draft) { captureDraftRef.current = draft; newTitleRef.current = draft.text; setNewTitle(draft.text); }
      captureGate.current.hydrate();
      setCaptureReady(true); setCaptureSaveState("Draft saved on this device");
    }).catch(() => { if (captureMounted.current) setCaptureSaveState("Draft could not be loaded. Keep this page open and retry storage."); });
  });
  useEffect(() => {
    captureMounted.current = true;
    hydrateCapture();
    void persistOfflineStorage();
    return () => { captureMounted.current = false; };
  }, [hydrateCapture]);

  const receiveSyncEvent = useStableCallback((event: TaskSyncEvent) => {
    if (event.type === "remote") {
      const result = event.result;
      if (result.reset) applyLiveSnapshot(result.todos, "poll");
      else applyLiveDelta(result.todos, result.deletedIds, "poll");
      return;
    }
    if (event.type === "edit") {
      const { mutation, ...result } = event;
          if (editingIdRef.current === mutation.todoId && editDraftRef.current) {
            const serverDraft = todoDraft(result.todo);
            const currentDraft = editDraftRef.current;
            const previousBaseline = editBaselineRef.current ?? serverDraft;
            const nextDraft = { ...currentDraft };
            const nextBaseline = { ...serverDraft };
            for (const field of AUTOSAVE_FIELDS) {
              if (field === activeEditFieldRef.current) {
                deferredRemoteEditFieldsRef.current.set(field, serverDraft[field]);
                nextBaseline[field] = previousBaseline[field] as never;
                continue;
              }
              const queuedValue = mutation.patch[field];
              const hasQueuedValue = Object.prototype.hasOwnProperty.call(mutation.patch, field);
              const changedAfterQueue = hasQueuedValue
                ? normalizedDraftField(currentDraft, field) !== queuedValue
                : normalizedDraftField(currentDraft, field) !== normalizedDraftField(previousBaseline, field);
              if (!changedAfterQueue) nextDraft[field] = serverDraft[field] as never;
            }
            editBaselineRef.current = nextBaseline;
            editDraftRef.current = nextDraft;
            if (JSON.stringify(nextDraft) !== JSON.stringify(currentDraft)) setEditDraft(nextDraft);
            setEditSaveState("saved");
            setEditSaveMessage(result.appliedFields.length < Object.keys(mutation.patch).length ? "Synced · newer remote changes kept" : "Saved automatically");
          }
      return;
    }
    if (event.type === "promoted") {
      const { localId, todo } = event;
      setSelected((current) => current.has(localId) ? new Set([...current].map((id) => id === localId ? todo.id : id)) : current);
      setInlineEditingId((current) => current === localId ? todo.id : current);
      if (editingIdRef.current === localId) {
        editingIdRef.current = todo.id; setEditingId(todo.id);
        void loadTaskAttachments(todo.id);
      }
      return;
    }
    if (event.type === "action") {
      const { action, result } = event;
      if (!action.undoRequested) setNotice((current) => current?.operationId === action.operationId ? { ...current, pendingUndo: false, undoToken: result.undoToken, snoozedUntil: result.snoozedUntil ?? current.snoozedUntil } : current);
      optimisticOperationsRef.current.delete(action.operationId);
      action.taskIds.forEach((id) => pendingCompletionIdsRef.current.delete(id));
      return;
    }
    if (event.type === "attachment") {
      if (editingIdRef.current === event.todoId) void loadTaskAttachments(event.todoId);
      return;
    }
    setNotice({ tone: "error", text: event.message });
    if (event.action) {
      optimisticOperationsRef.current.delete(event.action.operationId);
      event.action.taskIds.forEach((id) => pendingCompletionIdsRef.current.delete(id));
    }
  });
  const receiveSyncState = useStableCallback(() => {
    const state = taskSync.getSnapshot();
    const activeId = editingIdRef.current;
    const activeTodo = activeId === null ? undefined : taskStore.getById(activeId);
    if (activeTodo && activeTodo.id !== activeId) { editingIdRef.current = activeTodo.id; setEditingId(activeTodo.id); }
    if (activeTodo) reconcileRemoteEditDraft(activeTodo, "resume");
    setSelected((current) => {
      const next = new Set([...current].map((id) => taskStore.getById(id)?.id ?? id));
      return next.size === current.size && [...next].every((id) => current.has(id)) ? current : next;
    });
    setLoading(state.loading); setOnline(navigator.onLine); setConnectionQuality(state.quality);
    setOfflineCount(state.creates); setOfflineEditCount(state.edits); setOfflineActionCount(state.actions);
    setUploadCount(state.uploads); setUploadStates(state.uploadStates);
    pendingTodoPatchesRef.current = new Map(state.mutations.map((mutation) => [mutation.todoId, mutation.patch]));
    rebuildPendingActionState(state.pendingActions);
    setRegisteredProjects((current) => JSON.stringify(current) === JSON.stringify(state.projects) ? current : state.projects);
    if (state.settings) {
      setScheduleTimeZone(state.settings.snoozeTimeZone);
      setQuickSnoozePresets((current) => JSON.stringify(current) === JSON.stringify(state.settings!.snoozeQuickPresets) ? current : state.settings!.snoozeQuickPresets ?? DEFAULT_QUICK_SNOOZE_PRESETS);
    }
    if (Object.hasOwn(state, "captureDraft")) applyRemoteCaptureDraft(state.captureDraft ?? null, "poll");
  });
  useEffect(() => {
    const offState = taskSync.subscribe(receiveSyncState);
    const offEvents = taskSync.onEvent(receiveSyncEvent);
    receiveSyncState();
    return () => { offState(); offEvents(); };
  }, [receiveSyncState, receiveSyncEvent]);

  useEffect(() => {
    if (loading) return;
    if (offlineCount > 0 || offlineEditCount > 0 || offlineActionCount > 0) {
      void syncOfflineQueueRef.current?.();
    }
    if (online && captureDraftRef.current) void persistCaptureDraftRef.current?.(captureDraftRef.current, "reconnect");
  }, [loading, online, offlineCount, offlineEditCount, offlineActionCount]);


  useEffect(() => () => {
    if (captureDraftSaveTimerRef.current !== null) window.clearTimeout(captureDraftSaveTimerRef.current);
  }, []);

  useEffect(() => {
    editingIdRef.current = editingId;
  }, [editingId]);

  useEffect(() => {
    editDraftRef.current = editDraft;
  }, [editDraft]);


  useEffect(() => {
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
    if (editingId === null || !editDraft || !editBaselineRef.current) return;
    const patch = changedDraftPatch(editDraft, editBaselineRef.current);
    if (!Object.keys(patch).length) {
      if (!autosaveInFlightRef.current) {
        setEditSaveState("saved");
        setEditSaveMessage("Saved automatically");
      }
      return;
    }
    if (patch.title !== undefined && !String(patch.title).trim()) {
      setEditSaveState("error");
      setEditSaveMessage("A task title is required.");
      return;
    }
    const pendingRecurrenceError = patch.recurrenceCron !== undefined ? cronValidationError(editDraft.recurrenceCron) : null;
    if (pendingRecurrenceError) {
      setEditSaveState("error");
      setEditSaveMessage(pendingRecurrenceError);
      return;
    }
    setEditSaveState("saving");
    setEditSaveMessage("Saving changes…");
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      void persistTaskDraftRef.current?.(editingId, editDraft, "debounce");
    }, 700);
    return () => {
      if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    };
  }, [editDraft, editingId]);

  useEffect(() => {
    const flush = () => {
      const id = editingIdRef.current;
      const draft = editDraftRef.current;
      if (id !== null && draft && editBaselineRef.current) void persistTaskDraftRef.current?.(id, draft, "close", editBaselineRef.current);
    };
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("dawar-before-navigation", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => { flush(); window.removeEventListener("dawar-before-navigation", flush); window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", hidden); };
  }, []);

  useEffect(() => {
    if (editingId === null) return;
    const dialog = taskDialogRef.current;
    if (!dialog) return;
    const narrowViewport = window.matchMedia("(max-width: 767px)");
    const coarsePointer = window.matchMedia("(pointer: coarse)");
    const enabled = () => narrowViewport.matches && coarsePointer.matches;
    const triggerDistance = 150;
    const intentDistance = 8;
    const maxDialogOffset = 88;

    const resetGesture = () => {
      taskDialogGestureRef.current = null;
      taskDialogRawPullRef.current = 0;
      setTaskDialogPulling(false);
      setTaskDialogPullReady(false);
      setTaskDialogPullDistance(0);
    };

    const onTouchStart = (event: TouchEvent) => {
      if (!enabled() || event.touches.length !== 1) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, button, a, audio, video, [contenteditable='true'], [data-no-dialog-pull]")) return;
      const scrollArea = taskDialogScrollRef.current;
      const startedInScrollArea = Boolean(scrollArea && target && scrollArea.contains(target));
      if (startedInScrollArea && (scrollArea?.scrollTop ?? 0) > 0) return;
      const touch = event.touches[0];
      taskDialogGestureRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        active: false,
        startedInScrollArea,
      };
      taskDialogRawPullRef.current = 0;
    };

    const onTouchMove = (event: TouchEvent) => {
      const gesture = taskDialogGestureRef.current;
      if (!gesture || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const deltaX = touch.clientX - gesture.startX;
      const deltaY = touch.clientY - gesture.startY;
      if (!gesture.active) {
        if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < intentDistance) return;
        if (deltaY <= 0 || Math.abs(deltaX) >= deltaY || (gesture.startedInScrollArea && (taskDialogScrollRef.current?.scrollTop ?? 0) > 0)) {
          resetGesture();
          return;
        }
        gesture.active = true;
        setTaskDialogPulling(true);
        console.info("[todo-ui] task dialog pull-to-close started", { todoId: editingId });
      }
      if (gesture.startedInScrollArea && (taskDialogScrollRef.current?.scrollTop ?? 0) > 0) {
        resetGesture();
        return;
      }
      if (event.cancelable) event.preventDefault();
      const rawDistance = Math.max(0, deltaY);
      taskDialogRawPullRef.current = rawDistance;
      setTaskDialogPullReady(rawDistance >= triggerDistance);
      setTaskDialogPullDistance(Math.min(maxDialogOffset, rawDistance * 0.42));
    };

    const finishGesture = (cancelled: boolean) => {
      const gesture = taskDialogGestureRef.current;
      const rawDistance = taskDialogRawPullRef.current;
      if (!gesture?.active || cancelled || rawDistance < triggerDistance) {
        if (gesture?.active) {
          console.info("[todo-ui] task dialog pull-to-close cancelled", {
            todoId: editingId,
            pullDistance: Math.round(rawDistance),
            reason: cancelled ? "touch-cancelled" : "below-threshold",
          });
        }
        resetGesture();
        return;
      }
      console.info("[todo-ui] task dialog pull-to-close triggered", {
        todoId: editingId,
        pullDistance: Math.round(rawDistance),
      });
      resetGesture();
      closeTaskDetailsRef.current();
    };

    const onTouchEnd = () => finishGesture(false);
    const onTouchCancel = () => finishGesture(true);
    dialog.addEventListener("touchstart", onTouchStart, { passive: true });
    dialog.addEventListener("touchmove", onTouchMove, { passive: false });
    dialog.addEventListener("touchend", onTouchEnd, { passive: true });
    dialog.addEventListener("touchcancel", onTouchCancel, { passive: true });
    console.info("[todo-ui] task dialog pull-to-close ready", {
      todoId: editingId,
      enabled: enabled(),
      triggerDistance,
    });
    return () => {
      dialog.removeEventListener("touchstart", onTouchStart);
      dialog.removeEventListener("touchmove", onTouchMove);
      dialog.removeEventListener("touchend", onTouchEnd);
      dialog.removeEventListener("touchcancel", onTouchCancel);
      resetGesture();
    };
  }, [editingId]);

  useEffect(() => {
    if (editingId === null) return;
    const dialog = taskDialogRef.current;
    if (!dialog) return;
    const openedTodoId = editingId;
    const origin = taskDialogReturnFocusRef.current;
    const focusFrame = window.requestAnimationFrame(() => {
      dialog.focus({ preventScroll: true });
      console.info("[todo-dialog-focus] task dialog focused", {
        todoId: openedTodoId,
        target: "dialog",
        avoidedInputFocus: true,
      });
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      const fallbackTodoId = taskDialogReturnTodoIdRef.current ?? openedTodoId;
      taskDialogReturnFocusRef.current = null;
      taskDialogReturnTodoIdRef.current = null;
      window.requestAnimationFrame(() => {
        const fallback = document.querySelector<HTMLElement>(
          `[data-task-row-id="${fallbackTodoId}"] textarea[data-inline-title]`,
        );
        const target = origin?.isConnected ? origin : fallback;
        target?.focus({ preventScroll: true });
        console.info("[todo-dialog-focus] task dialog focus restored", {
          todoId: fallbackTodoId,
          restored: Boolean(target),
          usedFallback: target === fallback,
        });
      });
    };
  }, [editingId]);

  useEffect(() => {
    if (editingId === null || taskDialogNestedOverlayOpen) return;
    const dialog = taskDialogRef.current;
    if (!dialog) return;
    const focusFrame = window.requestAnimationFrame(() => {
      if (!dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true });
    });
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      const focusable = dialogFocusableElements(dialog);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === dialog || active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", trapFocus, true);
    console.info("[todo-dialog-focus] task dialog focus trap enabled", {
      todoId: editingId,
      focusableCount: dialogFocusableElements(dialog).length,
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", trapFocus, true);
    };
  }, [editingId, taskDialogNestedOverlayOpen]);

  const pendingSyncCount = offlineCount + offlineEditCount + offlineActionCount;
  const hasPendingSync = pendingSyncCount > 0;

  useEffect(() => {
    if (connectionQuality !== "online" || !hasPendingSync) {
      setShowPendingSyncStatus(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setShowPendingSyncStatus(true);
      console.info("[todo-offline] pending synchronization indicator shown", {
        delayMs: SYNC_STATUS_DELAY_MS,
      });
    }, SYNC_STATUS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [connectionQuality, hasPendingSync]);


  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (loading) return;
    let active = true;
    let timer: number | null = null;
    const scheduleNextWake = () => {
      if (!active) return;
      const scheduledAt = Date.now();
      const wakeAt = nextSnoozeWakeAt(todos, scheduledAt);
      if (wakeAt === null) return;
      const delayMs = Math.min(Math.max(0, wakeAt - scheduledAt) + 50, 2_147_000_000);
      console.info("[todo-snooze] next live wake scheduled", {
        wakeAt: new Date(wakeAt).toISOString(),
        delayMs,
      });
      timer = window.setTimeout(() => {
        const firedAt = Date.now();
        const expiredIds = expiredSnoozeIds(todos, firedAt);
        setNow(firedAt);
        void refreshLiveData("snooze-wake");
        console.info("[todo-snooze] live wake fired", {
          scheduledWakeAt: new Date(wakeAt).toISOString(),
          firedAt: new Date(firedAt).toISOString(),
          driftMs: firedAt - wakeAt,
          expiredIds,
        });
        scheduleNextWake();
      }, delayMs);
    };
    scheduleNextWake();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [loading, todos]);

  useEffect(() => {
    if (loading) return;
    const openCount = currentOpenTaskCount(todos, now);
    if (lastAppBadgeCountRef.current === openCount) return;
    lastAppBadgeCountRef.current = openCount;
    void updateNativeAppBadge(openCount, "task-state").then((result) => {
      if (result.supported && !result.updated && lastAppBadgeCountRef.current === openCount) {
        lastAppBadgeCountRef.current = null;
      }
    });
  }, [loading, now, todos]);

  useEffect(() => {
    if (!notice || customSnoozeDialog) return;
    const defaultDuration = notice.snoozeIds?.length ? 15_000 : notice.undoToken ? 8_000 : 5_000;
    const duration = notice.dismissAt === undefined ? defaultDuration : Math.max(0, notice.dismissAt - Date.now());
    const timer = window.setTimeout(() => setNotice(null), duration);
    return () => window.clearTimeout(timer);
  }, [customSnoozeDialog, notice]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector(".todo-queue-dialog")) return;
      const target = event.target as HTMLElement;
      const typing = Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
      const imageCount = detailAttachments.filter((attachment) => attachment.kind === "image").length;
      const undoShortcut = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "z";
      if (undoShortcut && !typing) {
        if (notice && (notice.operationId || notice.undoToken) && !undoing && !notice.undoRequested) {
          event.preventDefault();
          requestNoticeUndo(notice);
          console.info("[todo-shortcuts] undo requested", {
            source: event.metaKey ? "command-z" : "control-z",
            optimistic: Boolean(notice.operationId),
            tokenReady: Boolean(notice.undoToken),
          });
        }
        return;
      }
      if (event.key === "?" && !typing && !overlayOpen && window.matchMedia("(min-width: 768px)").matches) {
        event.preventDefault();
        setShortcutsOpen((current) => {
          console.info("[todo-shortcuts] shortcut guide toggled", { open: !current, source: "question-mark" });
          return !current;
        });
        return;
      }
      if (shortcutsOpen && event.key !== "Escape") return;
      if (event.key === "/" && !typing && !overlayOpen) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key.toLowerCase() === "n" && !typing && !overlayOpen) {
        event.preventDefault();
        captureRef.current?.focus();
      }
      if (event.key === "Escape" && customSnoozeDialog !== null) {
        setCustomSnoozeDialog(null);
        console.info("[todo-ui] custom snooze dialog closed", { source: "escape" });
      } else if (event.key === "Escape" && shortcutsOpen) {
        setShortcutsOpen(false);
        console.info("[todo-shortcuts] shortcut guide closed", { source: "escape" });
      } else if (event.key === "Escape" && voiceTarget !== null) {
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
      } else if (event.key === "Escape" && projectSelectorOpen) {
        setProjectSelectorOpen(false);
        console.info("[todo-ui] project selector closed", { source: "escape", selectedProject: project || null });
      } else if (event.key === "Escape" && projectDialog !== null) {
        setProjectDialog(null);
        setProjectDialogError("");
      } else if (event.key === "Escape" && editingId !== null) {
        closeTaskDetailsRef.current();
      } else if (event.key === "Escape" && target === searchRef.current) {
        setQuery("");
        searchRef.current?.blur();
      } else if (event.key === "Escape" && filtersOpen) {
        setFiltersOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [customSnoozeDialog, detailAttachments, editingId, filtersOpen, newProjectOpen, notice, overlayOpen, project, projectDeleteDialog, projectDialog, projectSelectorOpen, shortcutsOpen, undoing, viewerIndex, voiceTarget]);

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
      if (!todo.project || todo.queueDelegation && todo.status !== "completed") return;
      const counts = projectCounts.get(todo.project) ?? { open: 0, snoozed: 0, done: 0 };
      if (todo.status === "completed") counts.done += 1;
      else if (isSnoozed(todo, now)) counts.snoozed += 1;
      else counts.open += 1;
      projectCounts.set(todo.project, counts);
    });
    return [...projectCounts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [registeredProjects, todos, now]);

  const unassignedProjectCounts = useMemo(() => {
    const counts = { open: 0, snoozed: 0, done: 0 };
    todos.forEach((todo) => {
      if (todo.project || todo.queueDelegation && todo.status !== "completed") return;
      if (todo.status === "completed") counts.done += 1;
      else if (isSnoozed(todo, now)) counts.snoozed += 1;
      else counts.open += 1;
    });
    return counts;
  }, [todos, now]);

  const counts = useMemo(() => {
    const scopedTodos = todos.filter((todo) => !project || (project === UNASSIGNED_PROJECT ? !todo.project : todo.project === project));
    return {
      open: scopedTodos.filter((todo) => matchesView(todo, "open", now)).length,
      snoozed: scopedTodos.filter((todo) => matchesView(todo, "snoozed", now)).length,
      done: scopedTodos.filter((todo) => matchesView(todo, "done", now)).length,
      all: scopedTodos.filter((todo) => matchesView(todo, "all", now)).length,
    };
  }, [todos, now, project]);

  const deferredQuery = useDeferredValue(query);
  const filtered = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    const rows = todos.filter((todo) => {
      const searchable = [todo.title, todo.notes, todo.project, todo.context].filter(Boolean).join(" ").toLowerCase();
      return (matchesView(todo, view, now) || Boolean(needle && todo.queueDelegation))
        && (!needle || todo.id === inlineEditingId || searchable.includes(needle))
        && (!project || (project === UNASSIGNED_PROJECT ? !todo.project : todo.project === project))
        && (!priority || todo.priority === Number(priority));
    });
    return [...rows].sort(compareCanonicalOrder);
  }, [todos, view, deferredQuery, project, priority, now, inlineEditingId]);

  const pinnedTaskCount = todos.filter((todo) => todo.pinned && !todo.queueDelegation).length;
  const pinnedOpenTodos = view === "open" && pinListEnabled ? filtered.filter((todo) => todo.pinned && !todo.queueDelegation) : [];
  const regularOpenTodos = view === "open" && pinListEnabled ? filtered.filter((todo) => !todo.pinned || todo.queueDelegation) : filtered;
  const displayedTodos = view === "open" && pinListEnabled ? [...pinnedOpenTodos, ...regularOpenTodos] : filtered;

  const selectedIds = useMemo(() => [...selected], [selected]);
  const selectedTodos = useMemo(() => todos.filter((todo) => selected.has(todo.id)), [selected, todos]);
  const allVisibleSelected = filtered.length > 0 && filtered.every((todo) => selected.has(todo.id));
  const filtersActive = Boolean(query || priority);
  const mobileFilterCount = Number(Boolean(priority));
  const editingTodo = editingId === null ? null : todos.find((todo) => todo.id === editingId) ?? null;

  useEffect(() => {
    if (deepLinkedTaskOpenedRef.current || todos.length === 0) return;
    const rawTaskId = new URLSearchParams(window.location.search).get("task");
    if (!rawTaskId) {
      deepLinkedTaskOpenedRef.current = true;
      return;
    }
    const taskId = Number(rawTaskId);
    const linkedTask = Number.isInteger(taskId) ? todos.find((todo) => todo.id === taskId) : null;
    if (!linkedTask) return;
    deepLinkedTaskOpenedRef.current = true;
    openTaskDetails(linkedTask);
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("task");
    window.history.replaceState(window.history.state, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
    console.info("[todo-ui] urgent task link opened", { todoId: linkedTask.id });
  }, [todos]);
  const imageAttachments = detailAttachments.filter((attachment) => attachment.kind === "image");
  const viewerAttachment = viewerIndex === null ? null : imageAttachments[viewerIndex] ?? null;
  const recurrenceError = cronValidationError(editDraft?.recurrenceCron);

  useEffect(() => {
    setViewerCopyState("idle");
  }, [viewerAttachment?.id]);

  useLayoutEffect(() => {
    if (captureRef.current) resizeCapture(captureRef.current);
  }, [newTitle]);

  useLayoutEffect(() => {
    const textarea = captureRef.current;
    if (!textarea) return;
    let frame: number | null = null;
    const scheduleResize = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        resizeCapture(textarea);
      });
    };
    // Ignore height notifications from our own sizing, and resize outside the
    // observer delivery so width reflow cannot create a feedback loop.
    let width = 0;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      scheduleResize();
    });
    observer?.observe(textarea);
    if (!observer) window.addEventListener("resize", scheduleResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", scheduleResize);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, []);

  async function persistCaptureDraft(draft: CaptureDraft, source: string) {
    if (!navigator.onLine) {
      console.info("[todo-offline] Quick Add draft retained locally", {
        source,
        version: draft.version,
        textLength: draft.text.length,
      });
      return;
    }
    if (captureDraftInFlightRef.current) {
      if (!queuedCaptureDraftRef.current || draft.version > queuedCaptureDraftRef.current.version) {
        queuedCaptureDraftRef.current = draft;
      }
      return;
    }
    captureDraftInFlightRef.current = true;
    const startedAt = Date.now();
    try {
      const result = await request<{ captureDraft: CaptureDraft; applied: boolean }>("/api/capture-draft", {
        method: "PATCH",
        body: JSON.stringify({
          text: draft.text,
          updatedAt: draft.updatedAt,
          clientId: draft.clientId,
        }),
      });
      if (result.captureDraft.version > (captureDraftRef.current?.version ?? "")) {
        applyRemoteCaptureDraft(result.captureDraft, "mutation");
      }
      console.info("[todo-sync] Quick Add draft synchronized", {
        source,
        applied: result.applied,
        requestedVersion: draft.version,
        returnedVersion: result.captureDraft.version,
        textLength: draft.text.length,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      console.warn("[todo-sync] Quick Add draft synchronization deferred", {
        source,
        version: draft.version,
        textLength: draft.text.length,
        browserOnline: navigator.onLine,
        durationMs: Date.now() - startedAt,
        error,
      });
    } finally {
      captureDraftInFlightRef.current = false;
      const queued = queuedCaptureDraftRef.current;
      queuedCaptureDraftRef.current = null;
      if (queued && queued.version > draft.version) void persistCaptureDraft(queued, "coalesced");
    }
  }

  persistCaptureDraftRef.current = persistCaptureDraft;

  async function checkpointCapture() {
    const sequence = ++captureSaveSequence.current;
    setCaptureSaveState("Saving draft on this device…");
    try {
      await captureSession.current!.save({
        token: captureTokenRef.current, project: captureProjectRef.current,
        draft: captureDraftRef.current ? { key: "quick-add", ...captureDraftRef.current } : null,
        attachments: captureFilesRef.current.map((item) => ({ localId: item.localId, kind: item.kind,
          fileName: item.file.name, mimeType: item.file.type, durationMs: item.durationMs, blob: item.file,
          remoteAttachmentId: item.attachment?.id })),
      });
      if (sequence === captureSaveSequence.current) setCaptureSaveState("Draft saved on this device");
    } catch (error) {
      setCaptureSaveState("Draft not saved. Keep this page open; retry or copy text and save each file.");
      throw error;
    }
  }

  function updateCaptureProject(value: string) {
    if (!captureGate.current.ready || captureGate.current.adding || captureDraftToken !== captureTokenRef.current) return;
    captureProjectRef.current = value; setCaptureProject(value);
    void checkpointCapture().catch(() => undefined);
  }

  function updateCaptureTitle(text: string, source: "typing" | "task-created" | "image-recognition") {
    const nextClock = Math.max(Date.now(), captureDraftClockRef.current + 1);
    captureDraftClockRef.current = nextClock;
    const updatedAt = new Date(nextClock).toISOString();
    const clientId = captureDraftClientIdRef.current;
    const draft: CaptureDraft = {
      text,
      updatedAt,
      clientId,
      version: `${updatedAt}|${clientId}`,
    };
    newTitleRef.current = text;
    captureDraftRef.current = draft;
    pendingRemoteCaptureDraftRef.current = null;
    setNewTitle(text);
    void checkpointCapture().catch(() => undefined);
    void saveOfflineCaptureDraft({ key: "quick-add", ...draft }).catch((error) => {
      console.error("[todo-offline] Quick Add draft save failed", { source, textLength: text.length, error });
    });
    if (captureDraftSaveTimerRef.current !== null) window.clearTimeout(captureDraftSaveTimerRef.current);
    captureDraftSaveTimerRef.current = window.setTimeout(() => {
      captureDraftSaveTimerRef.current = null;
      void persistCaptureDraft(draft, source);
    }, source === "task-created" ? 0 : 500);
  }

  function flushCaptureDraft() {
    if (captureDraftSaveTimerRef.current !== null) {
      window.clearTimeout(captureDraftSaveTimerRef.current);
      captureDraftSaveTimerRef.current = null;
    }
    const localDraft = captureDraftRef.current;
    if (localDraft) void persistCaptureDraft(localDraft, "blur");
    const pendingRemote = pendingRemoteCaptureDraftRef.current;
    pendingRemoteCaptureDraftRef.current = null;
    if (pendingRemote) {
      window.setTimeout(() => applyRemoteCaptureDraft(pendingRemote, "poll"), 0);
    }
  }

  function updateEditDraftField<K extends keyof TodoDraft>(field: K, value: TodoDraft[K]) {
    const current = editDraftRef.current;
    if (!current) return;
    const next = { ...current, [field]: value };
    editDraftRef.current = next;
    setEditDraft(next);
  }

  function focusEditDraftField(field: AutosaveField) {
    const draft = editDraftRef.current;
    if (!draft) return;
    activeEditFieldRef.current = field;
    activeEditFocusValueRef.current = normalizedDraftField(draft, field);
    deferredRemoteEditFieldsRef.current.delete(field);
    console.info("[todo-inline-edit] details field editing started", {
      todoId: editingIdRef.current,
      field,
    });
  }

  function blurEditDraftField(field: AutosaveField) {
    if (activeEditFieldRef.current !== field) return;
    const draft = editDraftRef.current;
    const baseline = editBaselineRef.current;
    const deferredRemoteValue = deferredRemoteEditFieldsRef.current.get(field);
    const hadDeferredRemote = deferredRemoteEditFieldsRef.current.has(field);
    const focusValue = activeEditFocusValueRef.current;
    activeEditFieldRef.current = null;
    activeEditFocusValueRef.current = null;
    deferredRemoteEditFieldsRef.current.delete(field);
    if (!draft || !baseline || !hadDeferredRemote) return;

    const userChanged = normalizedDraftField(draft, field) !== focusValue;
    const nextBaseline = { ...baseline, [field]: deferredRemoteValue };
    editBaselineRef.current = nextBaseline;
    if (!userChanged) {
      const nextDraft = { ...draft, [field]: deferredRemoteValue };
      editDraftRef.current = nextDraft;
      setEditDraft(nextDraft);
    } else if (editingIdRef.current !== null) {
      void persistTaskDraftRef.current?.(editingIdRef.current, draft, "retry", nextBaseline);
    }
    console.info("[todo-sync] deferred remote field resolved after editing", {
      todoId: editingIdRef.current,
      field,
      resolution: userChanged ? "local-edit-kept" : "remote-edit-applied",
    });
  }

  function clipboardAttachments(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    return [...event.clipboardData.items]
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
  }

  function selectedAttachmentKind(file: File): "image" | "video" | "file" | null {
    if (uploadMimeType(file)) return "image";
    try {
      normalizedMediaMimeType(file, "video");
      return "video";
    } catch {
      try {
        normalizedFileMimeType(file);
        return "file";
      } catch {
        return null;
      }
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
        setNotice({ tone: "error", text: "Choose a supported photo, video, document, text file, or archive." });
        return false;
      }
      const maximumBytes = kind === "image" ? MAX_IMAGE_BYTES : kind === "video" ? MAX_VIDEO_BYTES : MAX_FILE_BYTES;
      if (file.size > maximumBytes) {
        setNotice({ tone: "error", text: `${file.name || `A ${kind}`} is larger than ${kind === "image" ? "20 MB" : kind === "video" ? "250 MB" : "100 MB"}.` });
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
        status: "staged",
        attachment: null,
        error: "",
      });
    }
    return items;
  }

  async function recognizeCaptureImage(item: PendingAttachment) {
    if (item.kind !== "image" || newTitleRef.current.trim() || !navigator.onLine || captureTitleRecognitionRef.current) return;
    const requestId = ++captureTitleRecognitionSequenceRef.current;
    captureTitleRecognitionRef.current = { requestId, localId: item.localId };
    setRecognizingCaptureTitle(true);
    const startedAt = performance.now();
    console.info("[todo-ui] quick add image recognition started", {
      requestId,
      inputBytes: item.file.size,
      mimeType: item.file.type,
    });
    try {
      const variants = await imageVariants(item.file);
      if (captureTitleRecognitionRef.current?.requestId !== requestId) return;
      const form = new FormData();
      form.append(
        "image",
        variants.thumbnail.blob,
        `quick-add.${variants.thumbnail.format === "jpeg" ? "jpg" : "webp"}`,
      );
      const result = await request<{ title: string }>("/api/assistant/capture-title", {
        method: "POST",
        body: form,
      });
      if (captureTitleRecognitionRef.current?.requestId !== requestId) return;
      if (newTitleRef.current.trim()) {
        console.info("[todo-ui] quick add image title skipped after user input", {
          requestId,
          suggestedLength: result.title.length,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return;
      }
      updateCaptureTitle(result.title, "image-recognition");
      window.requestAnimationFrame(() => {
        if (captureRef.current) resizeCapture(captureRef.current);
      });
      console.info("[todo-ui] quick add image title applied", {
        requestId,
        outputLength: result.title.length,
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      console.warn("[todo-ui] quick add image recognition unavailable", {
        requestId,
        inputBytes: item.file.size,
        durationMs: Math.round(performance.now() - startedAt),
        error,
      });
    } finally {
      if (captureTitleRecognitionRef.current?.requestId === requestId) {
        captureTitleRecognitionRef.current = null;
        setRecognizingCaptureTitle(false);
      }
    }
  }

  async function queueCaptureAttachments(inputFiles: File[]) {
    await captureGate.current.prepare(async () => {
      setCapturePreparing(true);
      setCaptureSaveState("Preparing files for this device…");
      try {
        const files = validateSelectedAttachments(inputFiles, captureAttachments.length);
        if (!files.length) { setCaptureSaveState("No files added."); return; }
        const items = await pendingAttachments(files);
        if (!items.length) { setCaptureSaveState("No files added."); return; }
        captureFilesRef.current = [...captureFilesRef.current, ...items];
        setCaptureAttachments(captureFilesRef.current);
        try { await checkpointCapture(); } catch { return; }
        console.info("[todo-offline] capture attachments staged locally", { count: items.length, browserOnlineHint: navigator.onLine, kinds: items.map((item) => item.kind), totalBytes: files.reduce((sum, file) => sum + file.size, 0) });
        const recognitionTarget = items.find((item) => item.kind === "image");
        if (recognitionTarget && !newTitleRef.current.trim()) void recognizeCaptureImage(recognitionTarget);
      } finally { setCapturePreparing(captureGate.current.preparing > 1); }
    });
  }

  async function queueCaptureVoice(file: File, durationMs: number) {
    await captureGate.current.prepare(async () => {
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
        status: "staged",
        attachment: null,
        error: "",
      };
      captureFilesRef.current = [...captureFilesRef.current, item];
      setCaptureAttachments(captureFilesRef.current);
      setVoiceTarget(null);
      try { await checkpointCapture(); } catch { return; }
      console.info("[todo-offline] voice memo staged locally", { destination: "quick-add", bytes: file.size, durationMs, browserOnlineHint: navigator.onLine });
    });
  }

  function retryCaptureAttachment() {
    void checkpointCapture().catch(() => undefined);
  }

  async function removeCaptureAttachment(item: PendingAttachment) {
    if (!captureGate.current.ready || captureGate.current.adding) return;
    if (item.status === "uploading" || item.status === "offline") return;
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
    if (captureTitleRecognitionRef.current?.localId === item.localId) {
      captureTitleRecognitionSequenceRef.current += 1;
      captureTitleRecognitionRef.current = null;
      setRecognizingCaptureTitle(false);
      console.info("[todo-ui] quick add image recognition cancelled", { localId: item.localId });
    }
    captureFilesRef.current = captureFilesRef.current.filter((candidate) => candidate.localId !== item.localId);
    setCaptureAttachments(captureFilesRef.current);
    try { await checkpointCapture(); } catch { return; }
    URL.revokeObjectURL(item.previewUrl);
  }

  async function loadTaskAttachments(todoId: number) {
    setLoadingAttachments(true);
    setAttachmentError("");
    try {
      const allQueued = (await listQueuedAttachments()).filter((upload) => upload.todoId === todoId && !upload.cancelled);
      const queued = allQueued.filter(hasAttachmentBytes);
      if (allQueued.length !== queued.length) setAttachmentError("Some local file bytes are missing. Open Review attachments to recover them.");
      setDetailUploads((current) => {
        const pending = new Set(queued.map((upload) => upload.localId));
        for (const item of current) if (!pending.has(item.localId)) URL.revokeObjectURL(item.previewUrl);
        return queued.map((upload) => ({
          ...(current.find((item) => item.localId === upload.localId) ?? {
            localId: upload.localId, file: new File([upload.blob], upload.fileName, { type: upload.mimeType }), previewUrl: URL.createObjectURL(upload.blob), kind: upload.kind, durationMs: upload.durationMs, attachment: null,
          }), status: (upload.leaseUntil ?? 0) > Date.now() ? "uploading" : upload.error ? "error" : "offline", error: attachmentQueueMessage(upload),
        }));
      });
      if (!navigator.onLine) return;
      const { attachments } = await request<{ attachments: TodoAttachment[] }>(`/api/todos/${todoId}/attachments`);
      setDetailAttachments((current) => {
        current
          .filter((attachment) => attachment.id.startsWith("local:"))
          .forEach((attachment) => URL.revokeObjectURL(attachment.originalUrl));
        return attachments;
      });
      console.info("[todo-ui] task gallery loaded", { todoId, count: attachments.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The attachments could not be loaded.";
      setAttachmentError(message);
      console.error("[todo-ui] task gallery load failed", { todoId, error });
    } finally {
      setLoadingAttachments(false);
    }
  }

  async function loadLocalTaskAttachments(todoId: number) {
    setLoadingAttachments(true);
    setAttachmentError("");
    try {
      const record = await getOfflineTodoByLocalId(todoId);
      const attachments = (record?.attachments ?? []).map((attachment, index) => {
        const objectUrl = URL.createObjectURL(attachment.blob);
        return {
          id: `local:${attachment.localId}`,
          todoId,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          byteSize: attachment.blob.size,
          width: 0,
          height: 0,
          kind: attachment.kind,
          durationMs: attachment.durationMs,
          sortOrder: index,
          thumbnailUrl: objectUrl,
          displayUrl: objectUrl,
          originalUrl: objectUrl,
          audioUrl: objectUrl,
          videoUrl: objectUrl,
          createdAt: record?.createdAt ?? new Date().toISOString(),
        } satisfies TodoAttachment;
      });
      setDetailAttachments((current) => {
        current
          .filter((attachment) => attachment.id.startsWith("local:"))
          .forEach((attachment) => URL.revokeObjectURL(attachment.originalUrl));
        return attachments;
      });
      console.info("[todo-offline] local task gallery loaded", { todoId, count: attachments.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The local attachments could not be loaded.";
      setAttachmentError(message);
      console.error("[todo-offline] local task gallery load failed", { todoId, error });
    } finally {
      setLoadingAttachments(false);
    }
  }

  async function uploadDetailAttachment(todoId: number, item: PendingAttachment) {
    try {
      await queueTaskAttachments(todoId, [{ localId: item.localId, kind: item.kind, fileName: item.file.name, mimeType: item.file.type, durationMs: item.durationMs, blob: item.file }]);
      await retryQueuedAttachments(item.localId);
      setDetailUploads((current) => current.map((candidate) => candidate.localId === item.localId ? { ...candidate, status: "offline", error: "Queued; resumes while the app is open and connected." } : candidate));
    } catch (error) {
      setDetailUploads((current) => current.map((candidate) => candidate.localId === item.localId ? { ...candidate, status: "error", error: error instanceof Error ? error.message : "The attachment could not be saved on this device." } : candidate));
    }
  }

  async function queueDetailAttachments(inputFiles: File[]) {
    if (!editingTodo) return;
    const files = validateSelectedAttachments(inputFiles, detailAttachments.length + detailUploads.length);
    if (!files.length) return;
    const items = await pendingAttachments(files);
    if (editingTodo.id < 1) {
      await appendOfflineTodoAttachments(editingTodo.id, items.map((item) => ({
        localId: item.localId,
        kind: item.kind,
        fileName: item.file.name,
        mimeType: item.file.type,
        durationMs: item.durationMs,
        blob: item.file,
      })));
      items.forEach((item) => URL.revokeObjectURL(item.previewUrl));
      setTodos((current) => current.map((todo) => todo.id === editingTodo.id
        ? { ...todo, attachmentCount: todo.attachmentCount + items.length }
        : todo));
      void loadLocalTaskAttachments(editingTodo.id);
      console.info("[todo-offline] attachments added to local task", {
        todoId: editingTodo.id,
        count: items.length,
        totalBytes: items.reduce((sum, item) => sum + item.file.size, 0),
      });
      return;
    }
    setDetailUploads((current) => [...current, ...items]);
    const todoId = editingTodo.id;
    void (async () => {
      for (const item of items) await uploadDetailAttachment(todoId, item);
    })();
  }

  function queueDetailVoice(file: File, durationMs: number) {
    if (!editingTodo) return;
    if (editingTodo.id < 1) {
      const localId = crypto.randomUUID();
      void appendOfflineTodoAttachments(editingTodo.id, [{
        localId,
        kind: "audio",
        fileName: file.name,
        mimeType: file.type,
        durationMs,
        blob: file,
      }]).then(() => {
        setTodos((current) => current.map((todo) => todo.id === editingTodo.id
          ? { ...todo, attachmentCount: todo.attachmentCount + 1 }
          : todo));
        void loadLocalTaskAttachments(editingTodo.id);
      });
      setVoiceTarget(null);
      console.info("[todo-offline] voice memo added to local task", { todoId: editingTodo.id, bytes: file.size, durationMs });
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
    if (editingTodo.id < 1 && attachment.id.startsWith("local:")) {
      const localAttachmentId = attachment.id.slice("local:".length);
      await deleteOfflineTodoAttachment(editingTodo.id, localAttachmentId);
      URL.revokeObjectURL(attachment.originalUrl);
      setDetailAttachments((current) => current.filter((item) => item.id !== attachment.id));
      setTodos((current) => current.map((todo) => todo.id === editingTodo.id
        ? { ...todo, attachmentCount: Math.max(0, todo.attachmentCount - 1) }
        : todo));
      setViewerIndex(null);
      setNotice({ tone: "success", text: "Attachment removed from local task." });
      return;
    }
    setSyncing(true);
    try {
      const result = await request<{ attachmentId: string; undoToken: string }>(`/api/todos/${editingTodo.id}/attachments/${attachment.id}`, { method: "DELETE" });
      setDetailAttachments((current) => current.filter((item) => item.id !== attachment.id));
      setTodos((current) => current.map((todo) => todo.id === editingTodo.id
        ? { ...todo, attachmentCount: Math.max(0, todo.attachmentCount - 1) }
        : todo));
      setViewerIndex(null);
      setNotice({ tone: "success", text: `${attachment.kind === "audio" ? "Voice memo" : attachment.kind === "video" ? "Video" : attachment.kind === "file" ? "File" : "Image"} deleted.`, undoToken: result.undoToken });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The attachment could not be deleted." });
    } finally {
      setSyncing(false);
    }
  }

  function resetCapture() {
    captureTitleRecognitionSequenceRef.current += 1;
    captureTitleRecognitionRef.current = null;
    setRecognizingCaptureTitle(false);
    captureTokenRef.current = captureSession.current!.snapshot().token;
    captureFilesRef.current = [];
    captureProjectRef.current = "";
    updateCaptureTitle("", "task-created");
    setCaptureProject("");
    captureAttachments.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    setCaptureAttachments([]);
    setCaptureDraftToken(captureTokenRef.current);
    if (captureRef.current) {
      captureRef.current.style.height = "auto";
      captureRef.current.style.overflowY = "hidden";
    }
  }

  function scheduleOfflineQueueSync(_reason: string, delayMs = 0) { taskSync.wake(delayMs); }
  syncOfflineQueueRef.current = taskSync.refresh;

  async function addTodo(event: FormEvent) {
    event.preventDefault();
    const title = newTitle.trim();
    const attachmentsReady = captureAttachments.every((item) => item.status === "staged" || (item.status === "ready" && item.attachment) || item.status === "offline");
    if (!title || adding || !captureReady || !attachmentsReady || voiceTarget === "capture" || projectDialog?.captureDraft || !captureGate.current.beginAdd()) return;
    // A late image-title suggestion must not change intent during consumption.
    captureTitleRecognitionSequenceRef.current++;
    captureTitleRecognitionRef.current = null;
    const temporaryId = createLocalTaskId();
    const clientId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const sortOrder = Math.min(0, ...todos.map(canonicalSortOrder)) - TASK_SORT_ORDER_STEP;
    const optimistic: Todo = {
      id: temporaryId,
      clientId,
      title,
      notes: "",
      status: "open",
      priority: 3,
      dueDate: null,
      project: captureProject || null,
      context: null,
      sourceKind: "site",
      sourceId: null,
      completedAt: null,
      snoozedUntil: null,
      recurrenceCron: null,
      recurrenceLastFiredAt: null,
      pinned: false,
      sortOrder,
      createdAt,
      updatedAt: createdAt,
      attachmentCount: captureAttachments.length,
      offline: true,
    };
    setTodos((current) => [optimistic, ...current]);
    setAdding(true);
    setNotice(null);
    try {
      await checkpointCapture();
      await captureSession.current!.consume({
        clientId,
        localId: temporaryId,
        title,
        notes: "",
        status: "open",
        priority: 3,
        dueDate: null,
        project: captureProject || null,
        context: null,
        completedAt: null,
        snoozedUntil: null,
        recurrenceCron: null,
        recurrenceLastFiredAt: null,
        pinned: false,
        sortOrder,
        sourceKind: "site",
        sourceId: null,
        createdAt,
        updatedAt: createdAt,
        draftToken: captureDraftToken,
        attachments: captureAttachments.map((item) => ({
          localId: item.localId,
          kind: item.kind,
          fileName: item.file.name,
          mimeType: item.file.type,
          durationMs: item.durationMs,
          blob: item.file,
          remoteAttachmentId: item.attachment?.id,
        })),
      });
      setOfflineCount((count) => count + 1);
      resetCapture();
      setNotice({ tone: "success", text: "Added.", taskPreview: title });
      console.info("[todo-offline] quick add committed locally", {
        clientId,
        localId: temporaryId,
        project: captureProject || null,
        titleLength: title.length,
        lines: title.split("\n").length,
        attachments: captureAttachments.length,
        alreadyUploadedAttachments: captureAttachments.filter((item) => item.attachment).length,
      });
      void syncOfflineQueueRef.current?.();
    } catch (error) {
      setTodos((current) => current.filter((item) => item.id !== temporaryId));
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "This device could not save the task." });
      console.error("[todo-offline] quick add local commit failed", { clientId, localId: temporaryId, error });
    } finally {
      setAdding(false);
      captureGate.current.endAdd();
      captureRef.current?.focus();
    }
  }

  function applyOptimisticAction(current: Todo[], ids: number[], action: ExecutableTodoAction, actionAt: string) {
    const idSet = new Set(ids);
    if (action === "delete") return current.filter((todo) => !idSet.has(todo.id));
    const temporarySnooze = new Date(new Date(actionAt).valueOf() + 36 * 60 * 60 * 1000).toISOString();
    return current.map((todo) => {
      if (!idSet.has(todo.id)) return todo;
      if (action === "complete") return { ...todo, status: "completed" as const, completedAt: actionAt, snoozedUntil: null, pinned: false };
      if (action === "snooze") return { ...todo, status: "open" as const, completedAt: null, snoozedUntil: temporarySnooze, pinned: false };
      return { ...todo, status: "open" as const, completedAt: null, snoozedUntil: null };
    });
  }

  async function performAction(ids: number[], action: ExecutableTodoAction | "merge") {
    ids = ids.map((id) => taskStore.getById(id)?.id ?? id);
    if (!ids.length) return;
    if (ids.some((id) => pendingCompletionIdsRef.current.has(id))) return;
    const previous = todos;
    const taskPreview = ids.length === 1 ? previous.find((todo) => todo.id === ids[0])?.title : undefined;
    if (action === "merge" && ids.some((id) => id < 1)) {
      setNotice({ tone: "error", text: "New offline tasks must sync before they can be merged.", taskPreview });
      return;
    }
    const actionAt = new Date().toISOString();
    const operationId = crypto.randomUUID();
    const localIds = ids.filter((id) => id < 1);
    const remoteIds = ids.filter((id) => id > 0);
    const openedCompleted = action === "unsnooze" && ids.every((id) => previous.find((todo) => todo.id === id)?.status === "completed");
    const wokeSnoozed = action === "unsnooze" && ids.every((id) => {
      const todo = previous.find((item) => item.id === id);
      return todo ? isSnoozed(todo, new Date(actionAt).valueOf()) : false;
    });
    const optimisticLabel = action === "merge"
      ? "Merging"
      : action === "complete"
        ? "Done"
        : action === "snooze"
          ? "Snoozed until tomorrow"
          : action === "unsnooze"
            ? openedCompleted ? "Opened" : wokeSnoozed ? "Woke" : "Restored to Open"
            : "Deleted";
    if (action === "complete") ids.forEach((id) => pendingCompletionIdsRef.current.add(id));
    optimisticOperationsRef.current.set(operationId, {
      ids,
      previous,
      action,
      undoRequested: false,
      settled: false,
    });
    setNotice({
      tone: "success",
      text: `${optimisticLabel}: ${ids.length} ${ids.length === 1 ? "task" : "tasks"}${action === "merge" ? "…" : "."}`,
      taskPreview,
      operationId,
      pendingUndo: remoteIds.length > 0,
      snoozeIds: action === "snooze" ? ids : undefined,
      snoozedUntil: action === "snooze" ? new Date(new Date(actionAt).valueOf() + 36 * 60 * 60 * 1000).toISOString() : undefined,
      dismissAt: Date.now() + (action === "snooze" ? 15_000 : 8_000),
    });
    console.info("[todo-ui] local-first action applied", {
      action,
      ids,
      localIds,
      remoteIds,
      operationId,
      taskPreview: Boolean(taskPreview),
    });
    if (action !== "merge") setTodos((current) => applyOptimisticAction(current, ids, action, actionAt));

    try {
      if (localIds.length && action !== "merge") {
        const optimisticById = new Map(
          applyOptimisticAction(previous, localIds, action, actionAt).map((todo) => [todo.id, todo]),
        );
        for (const id of localIds) {
          if (action === "delete") {
            await deleteOfflineTodoByLocalId(id);
          } else {
            const optimisticTodo = optimisticById.get(id);
            if (optimisticTodo) await updateOfflineTodo(id, offlineTaskPatch(optimisticTodo));
          }
        }
        setOfflineCount((await listOfflineTodos()).length);
      }

      if (remoteIds.length) {
        const optimisticPatches: Record<string, Record<string, unknown>> = {};
        if (action !== "merge" && action !== "delete") {
          const optimisticById = new Map(
            applyOptimisticAction(previous, remoteIds, action, actionAt).map((todo) => [todo.id, todo]),
          );
          for (const id of remoteIds) {
            const optimisticTodo = optimisticById.get(id);
            if (!optimisticTodo) continue;
            optimisticPatches[String(id)] = {
              status: optimisticTodo.status,
              completedAt: optimisticTodo.completedAt,
              snoozedUntil: optimisticTodo.snoozedUntil,
              pinned: optimisticTodo.pinned,
              updatedAt: actionAt,
            };
          }
        }
        const queued = await saveOfflineTaskAction({
          operationId,
          path: "/api/todos/bulk",
          method: "POST",
          body: { ids: remoteIds, action },
          taskIds: remoteIds,
          kind: "bulk",
          optimisticPatches,
          optimisticDeletedIds: action === "delete" ? remoteIds : [],
          createdAt: actionAt,
        });
        const queuedActions = await listOfflineTaskActions();
        rebuildPendingActionState(queuedActions);
        setOfflineActionCount(queuedActions.length);
        console.info("[todo-offline] task action committed to durable outbox", {
          operationId,
          action,
          taskIds: remoteIds,
          queueAttempts: queued.attempts,
        });
        void syncOfflineQueueRef.current?.();
      } else {
        const operation = optimisticOperationsRef.current.get(operationId);
        if (operation) operation.settled = true;
        optimisticOperationsRef.current.delete(operationId);
        ids.forEach((id) => pendingCompletionIdsRef.current.delete(id));
      }
      setSelected((current) => {
        const next = new Set(current);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    } catch (error) {
      setTodos((current) => restoreOptimisticTasks(current, previous, ids));
      setNotice((current) => current?.operationId === operationId ? {
        ...current,
        tone: "error",
        text: error instanceof Error ? error.message : "The action could not be completed.",
        pendingUndo: false,
      } : current);
      await deleteOfflineTaskAction(operationId).catch(() => undefined);
      optimisticOperationsRef.current.delete(operationId);
      ids.forEach((id) => pendingCompletionIdsRef.current.delete(id));
      console.error("[todo-offline] task action local commit failed", { action, ids, operationId, error });
    }
  }

  async function persistSnoozeAdjustment(
    ids: number[],
    adjustment: SnoozeAdjustment,
    operationId: string | undefined,
    undoToken: string | undefined,
    rollbackTodos: Todo[],
  ) {
    try {
      const localIds = ids.filter((id) => id < 1);
      const remoteIds = ids.filter((id) => id > 0);
      const optimisticById = new Map(todos.filter((todo) => ids.includes(todo.id)).map((todo) => [todo.id, todo]));
      for (const id of localIds) {
        const todo = optimisticById.get(id);
        if (todo) await updateOfflineTodo(id, offlineTaskPatch(todo));
      }
      if (remoteIds.length) {
        const adjustmentOperationId = crypto.randomUUID();
        const optimisticPatches = Object.fromEntries(remoteIds.map((id) => [
          String(id),
          { snoozedUntil: optimisticById.get(id)?.snoozedUntil ?? null },
        ]));
        await saveOfflineTaskAction({
          operationId: adjustmentOperationId,
          path: "/api/todos/bulk",
          method: "POST",
          body: {
            ids: remoteIds,
            action: "adjust_snooze",
            ...("preset" in adjustment
              ? { snoozePreset: adjustment.preset }
              : { snoozedLocal: adjustment.localDateTime }),
          },
          taskIds: remoteIds,
          kind: "bulk",
          optimisticPatches,
          createdAt: new Date().toISOString(),
        });
        const actions = await listOfflineTaskActions();
        rebuildPendingActionState(actions);
        setOfflineActionCount(actions.length);
        void syncOfflineQueueRef.current?.();
      }
      setNow(Date.now());
      console.info("[todo-offline] snooze adjustment committed locally", {
        adjustment,
        requestedIds: ids,
        localIds,
        remoteIds,
        operationId: operationId ?? null,
        retainedUndo: Boolean(undoToken),
      });
    } catch (error) {
      const rollback = new Map(rollbackTodos.map((todo) => [todo.id, todo]));
      setTodos((current) => current.map((todo) => rollback.get(todo.id) ?? todo));
      const message = error instanceof Error ? error.message : "The snooze time could not be adjusted.";
      setNotice((current) => {
        if (operationId && current?.operationId !== operationId) return current;
        return {
          tone: "error",
          text: message,
          taskPreview: current?.taskPreview,
          operationId: current?.operationId,
          undoToken: undoToken ?? current?.undoToken,
          snoozeIds: current?.snoozeIds ?? ids,
          snoozedUntil: current?.snoozedUntil,
        };
      });
      console.error("[todo-offline] snooze adjustment local commit failed", { adjustment, ids, operationId: operationId ?? null, error });
    } finally {
      setAdjustingSnooze(null);
    }
  }

  async function adjustSnooze(ids: number[], preset: SnoozePreset, operationId?: string) {
    if (!ids.length || adjustingSnooze) return;
    const adjustment: SnoozeAdjustment = { preset };
    const dismissAt = Date.now() + 1_500;
    const optimisticUntil = optimisticSnoozeUntil(preset);
    const rollbackTodos = todos.filter((todo) => ids.includes(todo.id));
    setAdjustingSnooze(preset);
    setTodos((current) => current.map((todo) => ids.includes(todo.id) ? { ...todo, snoozedUntil: optimisticUntil, pinned: false } : todo));
    setNow(Date.now());
    setNotice((current) => current ? {
      ...current,
      text: `${snoozeLabel(optimisticUntil, Date.now(), scheduleTimeZone)}: ${ids.length} ${ids.length === 1 ? "task" : "tasks"}.`,
      snoozeIds: ids,
      snoozedUntil: optimisticUntil,
      dismissAt,
    } : current);

    const operation = operationId ? optimisticOperationsRef.current.get(operationId) : undefined;
    if (operation && !operation.settled) {
      operation.snoozeAdjustment = adjustment;
      console.info("[todo-ui] snooze adjustment chained behind optimistic action", { preset, ids, operationId });
    }
    await persistSnoozeAdjustment(ids, adjustment, operationId, notice?.undoToken, rollbackTodos);
  }

  function openCustomSnooze(ids: number[], operationId?: string) {
    if (!ids.length || adjustingSnooze) return;
    const suggestedWake = new Date(Date.now() + 60 * 60 * 1000);
    suggestedWake.setUTCMinutes(Math.ceil(suggestedWake.getUTCMinutes() / 15) * 15, 0, 0);
    const localDateTime = zonedDateTimeInputValue(suggestedWake, scheduleTimeZone);
    setCustomSnoozeDialog({ ids, operationId, localDateTime, error: "" });
    setNotice((current) => current ? { ...current, dismissAt: undefined } : current);
    console.info("[todo-ui] custom snooze dialog opened", {
      ids,
      operationId: operationId ?? null,
      timeZone: scheduleTimeZone,
      suggestedLocalDateTime: localDateTime,
    });
  }

  function closeCustomSnooze(source: "backdrop" | "button" | "cancel") {
    if (!customSnoozeDialog) return;
    console.info("[todo-ui] custom snooze dialog closed", {
      source,
      count: customSnoozeDialog.ids.length,
      operationId: customSnoozeDialog.operationId ?? null,
    });
    setCustomSnoozeDialog(null);
  }

  async function saveCustomSnooze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!customSnoozeDialog || adjustingSnooze) return;
    let optimisticUntil: string;
    try {
      const wake = zonedLocalDateTimeToUtc(customSnoozeDialog.localDateTime, scheduleTimeZone);
      if (wake.valueOf() <= Date.now()) throw new Error("Choose a future date and time.");
      optimisticUntil = wake.toISOString();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Choose a valid date and time.";
      setCustomSnoozeDialog((current) => current ? { ...current, error: message } : current);
      console.warn("[todo-ui] custom snooze validation rejected", {
        localDateTime: customSnoozeDialog.localDateTime,
        timeZone: scheduleTimeZone,
        error: message,
      });
      return;
    }

    const { ids, operationId, localDateTime } = customSnoozeDialog;
    const adjustment: SnoozeAdjustment = { localDateTime };
    const rollbackTodos = todos.filter((todo) => ids.includes(todo.id));
    const dismissAt = Date.now() + 1_500;
    setCustomSnoozeDialog(null);
    setAdjustingSnooze("custom");
    setTodos((current) => current.map((todo) => ids.includes(todo.id) ? { ...todo, snoozedUntil: optimisticUntil, pinned: false } : todo));
    setNow(Date.now());
    setNotice((current) => current ? {
      ...current,
      text: `${snoozeLabel(optimisticUntil, Date.now(), scheduleTimeZone)}: ${ids.length} ${ids.length === 1 ? "task" : "tasks"}.`,
      snoozeIds: ids,
      snoozedUntil: optimisticUntil,
      dismissAt,
    } : current);

    const operation = operationId ? optimisticOperationsRef.current.get(operationId) : undefined;
    if (operation && !operation.settled) {
      operation.snoozeAdjustment = adjustment;
      console.info("[todo-ui] custom snooze adjustment chained behind optimistic action", {
        ids,
        operationId,
        localDateTime,
        optimisticUntil,
        timeZone: scheduleTimeZone,
      });
    }
    console.info("[todo-ui] custom snooze adjustment submitted", {
      ids,
      operationId: operationId ?? null,
      localDateTime,
      optimisticUntil,
      timeZone: scheduleTimeZone,
    });
    await persistSnoozeAdjustment(ids, adjustment, operationId, notice?.undoToken, rollbackTodos);
  }

  function requestNoticeUndo(currentNotice: NonNullable<Notice>) {
    if (undoing || currentNotice.undoRequested) return;
    const operation = currentNotice.operationId
      ? optimisticOperationsRef.current.get(currentNotice.operationId)
      : undefined;
    if (operation) {
      operation.undoRequested = true;
      const restorableIds = operation.ids.filter((id) => id > 0);
      setTodos((current) => restoreOptimisticTasks(current, operation.previous, restorableIds));
      if (currentNotice.operationId) {
        void markOfflineTaskActionUndo(currentNotice.operationId)
          .then(async (queued) => {
            if (!queued) return;
            const actions = await listOfflineTaskActions();
            rebuildPendingActionState(actions);
            setOfflineActionCount(actions.length);
            void syncOfflineQueueRef.current?.();
          })
          .catch((error) => {
            console.error("[todo-offline] queued undo persistence failed", {
              operationId: currentNotice.operationId,
              error,
            });
          });
      }
      setNotice((current) => current && current.operationId === currentNotice.operationId ? {
        ...current,
        text: "Undone locally · syncing",
        undoRequested: true,
        dismissAt: Date.now() + 8_000,
      } : current);
      console.info("[todo-ui] optimistic undo queued", {
        operationId: currentNotice.operationId,
        action: operation.action,
        ids: operation.ids,
        tokenReady: Boolean(operation.undoToken),
      });
      return;
    }
    if (currentNotice.undoToken) {
      setNotice(null);
      void undoAction(currentNotice.undoToken);
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
      try {
        const { todos: remoteTodos } = await request<{ todos: Todo[]; serverTime: string }>(`/api/todos?undo-reconcile=${Date.now()}`, { cache: "no-store" });
        const pendingPatches = pendingTodoPatchesRef.current;
        setTodos((current) => [
          ...current.filter((todo) => todo.offline),
          ...remoteTodos.map((todo) => patchTodo(todo, pendingPatches.get(todo.id) ?? {})),
        ]);
        console.warn("[todo-ui] failed undo reconciled from server", { remote: remoteTodos.length, error });
      } catch (reconcileError) {
        console.error("[todo-ui] undo and reconciliation failed", { error, reconcileError });
      }
    } finally {
      setUndoing(false);
    }
  }

  function openProjectAssignment(ids: number[], source: "bulk" | "hover" | "swipe" | "details") {
    projectReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const taskProjects = todos
      .filter((todo) => ids.includes(todo.id))
      .map((todo) => todo.project || UNASSIGNED_PROJECT);
    const sharedProject = new Set(taskProjects).size === 1 ? taskProjects[0] : "";
    setProjectDialog({ ids, selection: sharedProject, newProject: "", openedFromDetails: source === "details", captureDraft: false });
    setProjectDialogError("");
    console.info("[todo-ui] project assignment opened", { ids, source, sharedProject: sharedProject || null });
  }

  function openCaptureProjectAssignment(opener?: HTMLButtonElement | null) {
    projectReturnFocusRef.current = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setProjectDialog({
      ids: [],
      selection: captureProject || UNASSIGNED_PROJECT,
      newProject: "",
      openedFromDetails: false,
      captureDraft: true,
    });
    setProjectDialogError("");
    console.info("[todo-ui] quick add project assignment opened", {
      currentProject: captureProject || null,
      hasTitle: Boolean(newTitle.trim()),
      attachments: captureAttachments.length,
    });
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

    const { ids, openedFromDetails, captureDraft } = projectDialog;
    if (captureDraft && (!captureGate.current.ready || captureGate.current.adding)) {
      setProjectDialogError("Wait for the current capture to finish saving, then assign the project."); return;
    }
    setSavingProject(true);
    setProjectDialogError("");
    setNotice(null);
    try {
      if (captureDraft) {
        const stagedProject = projectName;
        updateCaptureProject(stagedProject ?? "");
        if (stagedProject) {
          setRegisteredProjects((current) => [...new Set([...current, stagedProject as string])].sort((a, b) => a.localeCompare(b)));
        }
        setProjectDialog(null);
        setNotice({
          tone: "success",
          text: stagedProject ? `New task will be assigned to ${stagedProject}.` : "New task will be unassigned.",
        });
        console.info("[todo-ui] quick add project staged", {
          project: stagedProject,
          createdProject: projectDialog.selection === CREATE_PROJECT,
          online,
          preservedTitleLength: newTitle.length,
          preservedAttachments: captureAttachments.length,
        });
        return;
      }
      const operationId = crypto.randomUUID();
      const previous = todos;
      const localIds = ids.filter((id) => id < 1);
      const remoteIds = ids.filter((id) => id > 0);
      setTodos((current) => current.map((todo) => ids.includes(todo.id) ? { ...todo, project: projectName } : todo));
      for (const id of localIds) {
        await updateOfflineTodo(id, { project: projectName });
      }
      if (remoteIds.length) {
        optimisticOperationsRef.current.set(operationId, {
          ids: remoteIds,
          previous,
          action: "project",
          undoRequested: false,
          settled: false,
        });
        const optimisticPatches = Object.fromEntries(remoteIds.map((id) => [String(id), { project: projectName }]));
        await saveOfflineTaskAction({
          operationId,
          path: "/api/todos/bulk",
          method: "POST",
          body: { ids: remoteIds, action: "reproject", project: projectName },
          taskIds: remoteIds,
          kind: "bulk",
          optimisticPatches,
          createdAt: new Date().toISOString(),
        });
        const actions = await listOfflineTaskActions();
        rebuildPendingActionState(actions);
        setOfflineActionCount(actions.length);
        void syncOfflineQueueRef.current?.();
      }
      if (projectName) {
        setRegisteredProjects((current) => [...new Set([...current, projectName])].sort((a, b) => a.localeCompare(b)));
      }
      if (openedFromDetails && ids.length === 1) {
        setEditDraft((current) => current ? { ...current, project: projectName ?? "" } : current);
        if (editDraftRef.current) editDraftRef.current = { ...editDraftRef.current, project: projectName ?? "" };
        if (editBaselineRef.current) editBaselineRef.current = { ...editBaselineRef.current, project: projectName ?? "" };
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
        taskPreview: ids.length === 1 ? todos.find((todo) => todo.id === ids[0])?.title : undefined,
        operationId: remoteIds.length ? operationId : undefined,
        pendingUndo: remoteIds.length > 0,
      });
      console.info("[todo-offline] project assignment committed locally", {
        ids,
        localIds,
        remoteIds,
        project: projectName,
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
    const activeElement = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
    const rowFallback = document.querySelector<HTMLElement>(
      `[data-task-row-id="${todo.id}"] textarea[data-inline-title]`,
    );
    taskDialogReturnFocusRef.current = activeElement ?? rowFallback;
    taskDialogReturnTodoIdRef.current = todo.id;
    const draft = todoDraft(todo);
    editingIdRef.current = todo.id;
    editDraftRef.current = draft;
    editBaselineRef.current = draft;
    activeEditFieldRef.current = null;
    activeEditFocusValueRef.current = null;
    deferredRemoteEditFieldsRef.current.clear();
    setEditingId(todo.id);
    setEditDraft(draft);
    setEditSaveState("saved");
    setEditSaveMessage("Saved automatically");
    setDescriptionPreview(false);
    setDetailAttachments([]);
    setDetailUploads([]);
    setViewerIndex(null);
    setTaskDialogPullDistance(0);
    setTaskDialogPullReady(false);
    setTaskDialogPulling(false);
    if (todo.id > 0) void loadTaskAttachments(todo.id);
    else void loadLocalTaskAttachments(todo.id);
    console.info("[todo-ui] task details opened", {
      id: todo.id,
      status: todo.status,
      attachmentCount: todo.attachmentCount,
      localOnly: todo.id < 1 || Boolean(todo.offline),
      focusOrigin: activeElement?.getAttribute("aria-label") ?? (rowFallback ? "task-row-fallback" : "none"),
    });
  }

  function closeTaskDetails() {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const activeId = editingIdRef.current;
    const draft = editDraftRef.current;
    const baseline = editBaselineRef.current;
    if (activeId !== null && draft && baseline) void persistTaskDraft(activeId, draft, "close", baseline);
    setEditingId(null);
    setEditDraft(null);
    setDescriptionPreview(false);
    editingIdRef.current = null;
    editDraftRef.current = null;
    editBaselineRef.current = null;
    activeEditFieldRef.current = null;
    activeEditFocusValueRef.current = null;
    deferredRemoteEditFieldsRef.current.clear();
    taskDialogGestureRef.current = null;
    taskDialogRawPullRef.current = 0;
    setTaskDialogPullDistance(0);
    setTaskDialogPullReady(false);
    setTaskDialogPulling(false);
    setViewerIndex(null);
    setAttachmentError("");
    detailAttachments
      .filter((attachment) => attachment.id.startsWith("local:"))
      .forEach((attachment) => URL.revokeObjectURL(attachment.originalUrl));
    setDetailAttachments([]);
    detailUploads.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    setDetailUploads([]);
  }

  async function persistTaskDraft(
    todoId: number,
    draft: TodoDraft,
    source: "debounce" | "close" | "retry",
    baselineOverride?: TodoDraft,
  ) {
    const baseline = baselineOverride ?? editBaselineRef.current;
    if (!baseline) return;
    const patch = changedDraftPatch(draft, baseline);
    if (!Object.keys(patch).length) return;
    if (patch.title !== undefined && !String(patch.title).trim()) {
      if (editingIdRef.current === todoId) {
        setEditSaveState("error");
        setEditSaveMessage("A task title is required.");
      }
      return;
    }
    const scheduleError = patch.recurrenceCron !== undefined ? cronValidationError(String(patch.recurrenceCron ?? "")) : null;
    if (scheduleError) {
      if (editingIdRef.current === todoId) {
        setEditSaveState("error");
        setEditSaveMessage(scheduleError);
      }
      return;
    }

    const existingPending = pendingTodoPatchesRef.current.get(todoId) ?? {};
    pendingTodoPatchesRef.current.set(todoId, { ...existingPending, ...patch });
    setTodos((current) => current.map((todo) => todo.id === todoId ? patchTodo(todo, patch) : todo));
    if (autosaveInFlightRef.current) {
      queuedAutosaveRef.current = { todoId, draft: { ...draft }, baseline: { ...baseline } };
      console.info("[todo-sync] autosave coalesced behind active request", { todoId, source, fields: Object.keys(patch) });
      return;
    }

    autosaveInFlightRef.current = true;
    setSavingEdit(true);
    if (editingIdRef.current === todoId) {
      setEditSaveState("saving");
      setEditSaveMessage("Saving locally…");
    }
    const timestamp = new Date().toISOString();
    const fieldTimestamps = Object.fromEntries(Object.keys(patch).map((field) => [field, timestamp]));
    const startedAt = Date.now();

    try {
      if (todoId < 1) {
        const updated = await updateOfflineTodo(todoId, patch as Partial<OfflineTodoRecord>);
        if (!updated) throw new Error("The local task could not be found.");
        pendingTodoPatchesRef.current.delete(todoId);
        if (editingIdRef.current === todoId) {
          editBaselineRef.current = { ...draft };
          setEditSaveState("offline");
          setEditSaveMessage("Saved on this device · syncing task");
        }
        console.info("[todo-offline] local task details updated", {
          todoId,
          source,
          fields: Object.keys(patch),
          durationMs: Date.now() - startedAt,
        });
      } else {
        const record = await saveOfflineTodoMutation(todoId, patch, fieldTimestamps);
        pendingTodoPatchesRef.current.set(todoId, record.patch);
        setOfflineEditCount((await listOfflineTodoMutations()).length);
        if (editingIdRef.current === todoId) {
          editBaselineRef.current = { ...draft };
          setEditSaveState(connectionQuality === "online" ? "saving" : "offline");
          setEditSaveMessage(connectionQuality === "online" ? "Saved locally · syncing" : "Saved locally · waiting to sync");
        }
        console.info("[todo-offline] autosave committed to durable outbox", {
          todoId,
          source,
          mutationId: record.mutationId,
          fields: Object.keys(patch),
          connectionQuality,
          durationMs: Date.now() - startedAt,
        });
        void syncOfflineQueueRef.current?.();
      }
    } catch (error) {
      if (editingIdRef.current === todoId) {
        setEditSaveState("error");
        setEditSaveMessage(error instanceof Error ? error.message : "Changes could not be saved locally.");
      }
      console.error("[todo-offline] autosave local commit failed", { todoId, source, fields: Object.keys(patch), error });
    } finally {
      autosaveInFlightRef.current = false;
      setSavingEdit(false);
      const queued = queuedAutosaveRef.current;
      queuedAutosaveRef.current = null;
      if (queued) void persistTaskDraft(queued.todoId, queued.draft, "retry", editBaselineRef.current ?? queued.baseline);
    }
  }

  async function persistInlineTitle(todoId: number, title: string, source: "input" | "debounce" | "blur" | "restore") {
    if (!title.trim()) return;
    const startedAt = Date.now();
    const original = taskStore.getById(todoId);
    const key = original ? taskKey(original) : undefined;
    try {
      if (todoId < 1) {
        const updated = await updateOfflineTodo(todoId, { title });
        if (!updated) throw new Error("The local task could not be found.");
        if (key && source !== "input") taskStore.clearDraft(key, { title });
        console.info("[todo-inline-edit] local title saved", {
          todoId,
          source,
          titleLength: title.length,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      const timestamp = new Date().toISOString();
      const record = await saveOfflineTodoMutation(todoId, { title }, { title: timestamp });
      pendingTodoPatchesRef.current.set(todoId, record.patch);
      if (key && source !== "input") taskStore.clearDraft(key, { title });
      taskSync.wake(350);
      console.info("[todo-inline-edit] title committed to durable outbox", {
        todoId,
        source,
        mutationId: record.mutationId,
        titleLength: title.length,
        connectionQuality,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "The task title could not be saved locally.",
        taskPreview: title,
      });
      console.error("[todo-inline-edit] title local commit failed", {
        todoId,
        source,
        titleLength: title.length,
        durationMs: Date.now() - startedAt,
        error,
      });
    }
  }

  function scheduleInlineTitleSave(todo: Todo, title: string) {
    const existingTimer = inlineTitleTimersRef.current.get(taskKey(todo));
    if (existingTimer !== undefined) window.clearTimeout(existingTimer);
    inlineTitleTimersRef.current.delete(taskKey(todo));
    if (!title.trim()) return;
    const timer = window.setTimeout(() => {
      inlineTitleTimersRef.current.delete(taskKey(todo));
      void persistInlineTitle(todo.id, title, "debounce");
    }, 700);
    inlineTitleTimersRef.current.set(taskKey(todo), timer);
  }

  function updateInlineTitle(todo: Todo, title: string) {
    if (!inlineTitleLastValidRef.current.has(taskKey(todo)) && todo.title.trim()) {
      inlineTitleLastValidRef.current.set(taskKey(todo), todo.title);
    }
    if (title.trim()) inlineTitleLastValidRef.current.set(taskKey(todo), title);
    if (todo.id > 0) {
      const pending = pendingTodoPatchesRef.current.get(todo.id) ?? {};
      pendingTodoPatchesRef.current.set(todo.id, { ...pending, title });
    }
    taskStore.setDraft(taskKey(todo), { title });
    if (title.trim()) void persistInlineTitle(todo.id, title, "input");
    scheduleInlineTitleSave(todo, title);
  }

  function focusInlineTitle(todo: Todo) {
    if (todo.title.trim()) inlineTitleLastValidRef.current.set(taskKey(todo), todo.title);
    setInlineEditingId(todo.id);
    console.info("[todo-inline-edit] title editing started", {
      todoId: todo.id,
      titleLength: todo.title.length,
      localOnly: todo.id < 1 || Boolean(todo.offline),
      view,
    });
  }

  function navigateInlineTitle(todo: Todo, direction: "previous" | "next") {
    const currentIndex = displayedTodos.findIndex((item) => item.id === todo.id);
    const targetIndex = currentIndex + (direction === "next" ? 1 : -1);
    const targetTodo = currentIndex < 0 ? null : displayedTodos[targetIndex] ?? null;
    if (!targetTodo) {
      console.info("[todo-inline-edit] title boundary has no adjacent task", {
        todoId: todo.id,
        direction,
        view,
        visibleTasks: displayedTodos.length,
      });
      return false;
    }

    const target = document.querySelector<HTMLTextAreaElement>(
      `[data-task-row-id="${targetTodo.id}"] textarea[data-inline-title]`,
    );
    if (!target) {
      console.warn("[todo-inline-edit] adjacent title textarea was not found", {
        todoId: todo.id,
        targetTodoId: targetTodo.id,
        direction,
        view,
      });
      return false;
    }

    target.focus({ preventScroll: true });
    const cursor = direction === "next" ? 0 : target.value.length;
    target.setSelectionRange(cursor, cursor);
    target.scrollIntoView({ block: "nearest", behavior: "smooth" });
    console.info("[todo-inline-edit] cursor moved to adjacent task", {
      todoId: todo.id,
      targetTodoId: targetTodo.id,
      direction,
      targetIndex,
      cursor,
      targetTitleLength: target.value.length,
      view,
    });
    return true;
  }

  function blurInlineTitle(todo: Todo, title: string) {
    const existingTimer = inlineTitleTimersRef.current.get(taskKey(todo));
    if (existingTimer !== undefined) window.clearTimeout(existingTimer);
    inlineTitleTimersRef.current.delete(taskKey(todo));
    if (!title.trim()) {
      const restoredTitle = inlineTitleLastValidRef.current.get(taskKey(todo)) || "Untitled task";
      if (todo.id > 0) {
        const pending = pendingTodoPatchesRef.current.get(todo.id) ?? {};
        pendingTodoPatchesRef.current.set(todo.id, { ...pending, title: restoredTitle });
      }
      taskStore.setDraft(taskKey(todo), { title: restoredTitle });
      setNotice({ tone: "error", text: "A task title is required.", taskPreview: restoredTitle });
      void persistInlineTitle(todo.id, restoredTitle, "restore");
      console.warn("[todo-inline-edit] empty title restored", {
        todoId: todo.id,
        restoredLength: restoredTitle.length,
      });
    } else {
      void persistInlineTitle(todo.id, title, "blur");
    }
    inlineTitleLastValidRef.current.delete(taskKey(todo));
    setInlineEditingId(null);
  }

  function reorderScope(todo: Todo) {
    const scope = view === "open" && pinListEnabled
      ? todo.pinned ? pinnedOpenTodos : regularOpenTodos
      : filtered;
    return scope.filter((item) => item.id > 0 && !item.offline);
  }

  async function persistCanonicalTaskOrder(
    nextTodos: Todo[],
    movedTodoId: number,
    source: "drag",
    rollback: Todo[],
  ) {
    const ordered = [...nextTodos].filter((todo) => todo.id > 0).sort(compareCanonicalOrder);
    const orderedIds = ordered.map((todo) => todo.id);
    const operationId = crypto.randomUUID();
    try {
      await saveOfflineTaskAction({
        operationId,
        path: "/api/todos/reorder",
        method: "PATCH",
        body: { orderedIds },
        taskIds: [movedTodoId],
        kind: "reorder",
        optimisticPatches: Object.fromEntries(
          ordered.map((todo) => [String(todo.id), { sortOrder: todo.sortOrder }]),
        ),
        createdAt: new Date().toISOString(),
      });
      const actions = await listOfflineTaskActions();
      rebuildPendingActionState(actions);
      setOfflineActionCount(actions.length);
      void syncOfflineQueueRef.current?.();
      console.info("[todo-order] reorder committed to durable outbox", {
        operationId,
        movedTodoId,
        source,
        orderedTasks: orderedIds.length,
        queuedActions: actions.length,
        connectionQuality,
      });
    } catch (error) {
      setTodos(rollback);
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "The task order could not be saved locally.",
      });
      console.error("[todo-order] reorder local commit failed", {
        movedTodoId,
        source,
        orderedTasks: orderedIds.length,
        error,
      });
    }
  }

  function startTaskReorder(todo: Todo, event: ReactPointerEvent<HTMLButtonElement>) {
    if (todo.id < 1 || todo.offline) return;
    if (reorderGestureRef.current) {
      console.warn("[todo-order] concurrent drag start ignored", {
        activeTodoId: reorderGestureRef.current.todoId,
        requestedTodoId: todo.id,
        pointerType: event.pointerType,
      });
      return;
    }
    event.preventDefault();
    const sourceRow = event.currentTarget.closest<HTMLElement>("[data-task-row-id]");
    if (!sourceRow) {
      console.warn("[todo-order] drag start skipped because the source row was unavailable", {
        todoId: todo.id,
        pointerType: event.pointerType,
      });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const scope = reorderScope(todo);
    const sourceBounds = sourceRow.getBoundingClientRect();
    const previewElement = sourceRow.cloneNode(true) as HTMLElement;
    previewElement.removeAttribute("data-task-row-id");
    previewElement.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
    previewElement.setAttribute("aria-hidden", "true");
    Object.assign(previewElement.style, {
      position: "fixed",
      left: `${sourceBounds.left}px`,
      top: `${sourceBounds.top}px`,
      width: `${sourceBounds.width}px`,
      height: `${sourceBounds.height}px`,
      zIndex: "200",
      pointerEvents: "none",
      margin: "0",
      overflow: "hidden",
      borderRadius: "12px",
      opacity: "0.98",
      boxShadow: "0 18px 45px rgba(25, 55, 38, 0.22)",
      transform: "translate3d(0, 0, 0)",
      transition: "none",
      willChange: "transform",
      contain: "layout paint",
    });
    document.body.appendChild(previewElement);
    sourceRow.style.opacity = "0.12";
    if (reorderAnimationRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(reorderAnimationRestoreFrameRef.current);
      reorderAnimationRestoreFrameRef.current = null;
    }
    setTaskListAnimations(false);
    reorderGestureRef.current = {
      todoId: todo.id,
      allowedIds: new Set(scope.map((item) => item.id)),
      initialTodos: todos,
      targetId: null,
      placement: "before",
      startClientY: event.clientY,
      latestClientX: event.clientX,
      latestClientY: event.clientY,
      previewElement,
      sourceRowElement: sourceRow,
      animationFrameId: null,
      startedAt: performance.now(),
      moveEvents: 0,
      targetChanges: 0,
      autoScrollFrames: 0,
      autoScrollActive: false,
    };
    reorderPreviewRef.current = todos;
    setReorderingId(todo.id);
    setReorderTargetId(null);
    console.info("[todo-order] drag started", {
      todoId: todo.id,
      view,
      scopedTasks: scope.length,
      pointerType: event.pointerType,
      previewWidth: Math.round(sourceBounds.width),
      previewHeight: Math.round(sourceBounds.height),
      listAnimationsPaused: true,
    });
  }

  function updateTaskReorderTarget(
    gesture: NonNullable<typeof reorderGestureRef.current>,
    clientX: number,
    clientY: number,
    source: "pointer" | "auto-scroll",
  ) {
    const row = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-task-row-id]");
    const targetId = Number(row?.dataset.taskRowId);
    if (!Number.isInteger(targetId) || targetId === gesture.todoId || !gesture.allowedIds.has(targetId) || !row) return;
    const bounds = row.getBoundingClientRect();
    const placement = clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    if (gesture.targetId === targetId && gesture.placement === placement) return;
    gesture.targetId = targetId;
    gesture.placement = placement;
    gesture.targetChanges += 1;
    setReorderTargetId(targetId);
    setTodos((current) => {
      const next = reorderCanonicalTodos(current, gesture.todoId, targetId, placement);
      reorderPreviewRef.current = next;
      return next;
    });
    console.debug("[todo-order] drag target changed", {
      todoId: gesture.todoId,
      targetId,
      placement,
      source,
      targetChanges: gesture.targetChanges,
    });
  }

  function taskReorderScrollSpeed(clientY: number) {
    const viewportHeight = window.innerHeight;
    const zone = Math.min(TASK_REORDER_EDGE_SCROLL_ZONE_PX, viewportHeight * 0.18);
    if (clientY < zone) {
      return -Math.ceil(((zone - Math.max(0, clientY)) / zone) * TASK_REORDER_MAX_SCROLL_PX);
    }
    if (clientY > viewportHeight - zone) {
      return Math.ceil(((Math.min(viewportHeight, clientY) - (viewportHeight - zone)) / zone) * TASK_REORDER_MAX_SCROLL_PX);
    }
    return 0;
  }

  function scheduleTaskReorderFrame() {
    const gesture = reorderGestureRef.current;
    if (!gesture || gesture.animationFrameId !== null) return;
    gesture.animationFrameId = window.requestAnimationFrame(() => {
      const active = reorderGestureRef.current;
      if (!active) return;
      active.animationFrameId = null;
      const deltaY = active.latestClientY - active.startClientY;
      active.previewElement.style.transform = `translate3d(0, ${deltaY}px, 0)`;
      const scrollSpeed = taskReorderScrollSpeed(active.latestClientY);
      if (scrollSpeed !== 0) {
        const previousScrollY = window.scrollY;
        window.scrollBy(0, scrollSpeed);
        const scrolled = window.scrollY - previousScrollY;
        if (scrolled !== 0) {
          active.autoScrollFrames += 1;
          if (!active.autoScrollActive) {
            active.autoScrollActive = true;
            console.info("[todo-order] drag edge auto-scroll started", {
              todoId: active.todoId,
              direction: scrolled < 0 ? "up" : "down",
              pointerY: Math.round(active.latestClientY),
            });
          }
          updateTaskReorderTarget(active, active.latestClientX, active.latestClientY, "auto-scroll");
          scheduleTaskReorderFrame();
          return;
        }
      }
      if (active.autoScrollActive) {
        active.autoScrollActive = false;
        console.info("[todo-order] drag edge auto-scroll stopped", {
          todoId: active.todoId,
          frames: active.autoScrollFrames,
        });
      }
    });
  }

  function moveTaskReorder(event: ReactPointerEvent<HTMLButtonElement>) {
    const gesture = reorderGestureRef.current;
    if (!gesture) return;
    event.preventDefault();
    gesture.latestClientX = event.clientX;
    gesture.latestClientY = event.clientY;
    gesture.moveEvents += 1;
    scheduleTaskReorderFrame();
    updateTaskReorderTarget(gesture, event.clientX, event.clientY, "pointer");
  }

  function finishTaskReorder(event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) {
    const gesture = reorderGestureRef.current;
    if (!gesture) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const preview = reorderPreviewRef.current ?? gesture.initialTodos;
    if (gesture.animationFrameId !== null) window.cancelAnimationFrame(gesture.animationFrameId);
    gesture.previewElement.remove();
    gesture.sourceRowElement.style.opacity = "";
    reorderGestureRef.current = null;
    reorderPreviewRef.current = null;
    setReorderingId(null);
    setReorderTargetId(null);
    reorderAnimationRestoreFrameRef.current = window.requestAnimationFrame(() => {
      reorderAnimationRestoreFrameRef.current = null;
      setTaskListAnimations(true);
    });
    const durationMs = Math.round(performance.now() - gesture.startedAt);
    if (cancelled || gesture.targetId === null) {
      if (cancelled) setTodos(gesture.initialTodos);
      console.info("[todo-order] drag finished without reorder", {
        todoId: gesture.todoId,
        cancelled,
        durationMs,
        moveEvents: gesture.moveEvents,
        targetChanges: gesture.targetChanges,
        autoScrollFrames: gesture.autoScrollFrames,
        listAnimationsRestoring: true,
      });
      return;
    }
    console.info("[todo-order] drag preview committed", {
      todoId: gesture.todoId,
      targetId: gesture.targetId,
      placement: gesture.placement,
      durationMs,
      moveEvents: gesture.moveEvents,
      targetChanges: gesture.targetChanges,
      autoScrollFrames: gesture.autoScrollFrames,
      listAnimationsRestoring: true,
    });
    void persistCanonicalTaskOrder(preview, gesture.todoId, "drag", gesture.initialTodos);
  }

  persistTaskDraftRef.current = persistTaskDraft;
  prepareUpdateRef.current = async () => {
    // Editing values can be intentionally invalid. Keep that editor open,
    // rather than force a save or discard it during an unrelated app update.
    if (editingIdRef.current !== null) throw Error("Close the task editor after saving before refreshing.");
    if (captureGate.current.adding || voiceTarget) throw Error("Finish the current capture before refreshing.");
    if (captureGate.current.ready) await checkpointCapture();
    else if (captureDraftRef.current?.text || captureFilesRef.current.length) throw Error("Wait for your capture draft to finish loading before refreshing.");
  };
  closeTaskDetailsRef.current = closeTaskDetails;

  function taskAction(todo: Todo, action: TodoAction, source: "hover" | "swipe" | "details") {
    if (action === "snooze" && todo.recurrenceCron) {
      setNotice({ tone: "error", text: "Recurring tasks cannot be snoozed.", taskPreview: todo.title });
      console.warn("[todo-ui] recurring task snooze blocked", { id: todo.id, source, recurrenceCron: todo.recurrenceCron });
      return;
    }
    console.info("[todo-ui] task action requested", { id: todo.id, action, source });
    void performAction([todo.id], action);
  }

  async function togglePin(todo: Todo) {
    todo = taskStore.getById(todo.id) ?? todo;
    if (view !== "open") return;
    const pinned = !todo.pinned;
    if (pinned && pinnedTaskCount >= MAX_PINNED_TASKS) {
      setNotice({
        tone: "error",
        text: `You can pin up to ${MAX_PINNED_TASKS} tasks. Unpin one first.`,
        taskPreview: todo.title,
        dismissAt: Date.now() + 6_000,
      });
      console.warn("[todo-ui] pin limit blocked", {
        todoId: todo.id,
        pinnedTasks: pinnedTaskCount,
        maximumPinnedTasks: MAX_PINNED_TASKS,
      });
      return;
    }
    const operationId = crypto.randomUUID();
    const previous = todos;
    optimisticOperationsRef.current.set(operationId, { ids: [todo.id], previous, action: "pin", undoRequested: false, settled: false });
    setNotice({ tone: "success", text: pinned ? "Task pinned." : "Task unpinned.", taskPreview: todo.title, operationId, pendingUndo: todo.id > 0, dismissAt: Date.now() + 8_000 });
    setTodos((current) => current.map((item) => item.id === todo.id ? { ...item, pinned } : item));
    try {
      if (todo.id < 1) {
        await updateOfflineTodo(todo.id, { pinned });
        optimisticOperationsRef.current.delete(operationId);
        setNotice((current) => current?.operationId === operationId ? { ...current, pendingUndo: false } : current);
      } else {
        await saveOfflineTaskAction({
          operationId,
          path: `/api/todos/${todo.id}`,
          method: "PATCH",
          body: { pinned },
          taskIds: [todo.id],
          kind: "task-patch",
          optimisticPatches: { [String(todo.id)]: { pinned } },
          createdAt: new Date().toISOString(),
        });
        const actions = await listOfflineTaskActions();
        rebuildPendingActionState(actions);
        setOfflineActionCount(actions.length);
        void syncOfflineQueueRef.current?.();
      }
      console.info("[todo-offline] task pin committed locally", { id: todo.id, pinned, view, operationId });
    } catch (error) {
      setTodos((current) => restoreOptimisticTasks(current, previous, [todo.id]));
      setNotice((current) => current?.operationId === operationId ? { ...current, tone: "error", text: error instanceof Error ? error.message : "The pin could not be changed.", pendingUndo: false } : current);
      optimisticOperationsRef.current.delete(operationId);
      console.error("[todo-offline] task pin local commit failed", { id: todo.id, pinned, error });
    }
  }

  function togglePinList() {
    setPinListEnabled((current) => {
      const enabled = !current;
      try {
        window.localStorage.setItem(PIN_LIST_PREFERENCE_KEY, enabled ? "on" : "off");
      } catch (error) {
        console.warn("[todo-ui] pin list preference could not be saved", { enabled, error });
      }
      console.info("[todo-ui] pin list toggled", {
        enabled,
        pinnedTasks: pinnedTaskCount,
        behavior: enabled ? "dedicated-section" : "canonical-order",
      });
      return enabled;
    });
  }

  async function acknowledgeUrgentAlert(todo: Todo) {
    if (todo.id < 1 || todo.offline) return;
    try {
      const response = await fetch(`/api/todos/${todo.id}/urgent-alert/ack`, {
        method: "POST",
        headers: headersWithDeviceId(),
      });
      const payload = await response.json().catch(() => ({})) as { acknowledged?: boolean; error?: string };
      if (!response.ok) throw new Error(payload.error || "The urgent alert could not be acknowledged.");
      setNotice({
        tone: "success",
        text: payload.acknowledged ? "Urgent calls and texts acknowledged." : "This urgent alert was already handled.",
        taskPreview: todo.title,
        dismissAt: Date.now() + 5_000,
      });
      console.info("[todo-urgent-alert-ui] in-app acknowledgement processed", {
        todoId: todo.id,
        acknowledged: Boolean(payload.acknowledged),
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "The urgent alert could not be acknowledged.",
        taskPreview: todo.title,
      });
    }
  }

  function editTaskDetails(todo: Todo, source: "hover" | "swipe") {
    console.info("[todo-ui] task edit requested", { id: todo.id, source });
    openTaskDetails(todo);
  }

  function detailAction(action: TodoAction) {
    if (!editingTodo) return;
    const todo = editingTodo;
    closeTaskDetails();
    taskAction(todo, action, "details");
  }

  async function copyTaskDetails() {
    if (!editDraft) return;
    const text = todoCopyText(editDraft.title, editDraft.notes);
    try {
      await copyTextToClipboard(text);
      setNotice({ tone: "success", text: "Task title and notes copied." });
      console.info("[todo-ui] task details copied", { titleLength: editDraft.title.trim().length, notesLength: editDraft.notes.trim().length });
    } catch (error) {
      console.error("[todo-ui] task details copy failed", { error });
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The task could not be copied." });
    }
  }

  async function copyViewerImage() {
    if (!viewerAttachment || viewerCopyState === "copying") return;
    const startedAt = Date.now();
    setViewerCopyState("copying");
    try {
      await copyImageToClipboard(viewerAttachment.displayUrl);
      setViewerCopyState("copied");
      console.info("[todo-ui] lightbox image copied", {
        attachmentId: viewerAttachment.id,
        sourceMimeType: viewerAttachment.mimeType,
        width: viewerAttachment.width,
        height: viewerAttachment.height,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      setViewerCopyState("error");
      console.warn("[todo-ui] lightbox clipboard copy unavailable; native copy remains available", {
        attachmentId: viewerAttachment.id,
        durationMs: Date.now() - startedAt,
        error,
      });
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
      ? selectedTodos.filter((todo) => todo.status === "open" && (action !== "snooze" || !todo.recurrenceCron)).map((todo) => todo.id)
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
    const changedAt = Date.now();
    setNow(changedAt);
    setView(next);
    setSelected(new Set());
    setFiltersOpen(false);
    console.info("[todo-ui] view changed", {
      view: next,
      retainedProjectFilter: project || null,
      expiredSnoozes: expiredSnoozeIds(todos, changedAt),
    });
  }

  function openProjectSelector() {
    setProjectSelectorOpen(true);
    setFiltersOpen(false);
    console.info("[todo-ui] project selector opened", {
      selectedProject: project || null,
      view,
      projectCount: projectOptions.length,
    });
  }

  function closeProjectSelector(source: "backdrop" | "button" | "selection") {
    setProjectSelectorOpen(false);
    console.info("[todo-ui] project selector closed", { source, selectedProject: project || null, view });
  }

  function selectProjectFilter(name: string) {
    setProject(name);
    setSelected(new Set());
    setProjectSelectorOpen(false);
    console.info("[todo-ui] project filter selected from header", {
      project: name === UNASSIGNED_PROJECT ? "unassigned" : name || null,
      retainedView: view,
    });
  }

  function openProjectTasks(name: string, destinationView: TaskListView, source: "selector-footer" | "project-created" = "selector-footer") {
    setProject(name);
    setView(destinationView);
    setSelected(new Set());
    setFiltersOpen(false);
    setProjectSelectorOpen(false);
    console.info("[todo-ui] project opened as filtered task list", {
      project: name,
      destinationView,
      source,
    });
  }

  function openNewProjectDialog() {
    setNewProjectName("");
    setNewProjectError("");
    setProjectSelectorOpen(false);
    setNewProjectOpen(true);
    console.info("[todo-ui] new project dialog opened", { source: "project-selector", retainedView: view });
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
      setProject(result.project);
      setNewProjectOpen(false);
      setNewProjectName("");
      setNotice({ tone: "success", text: `${result.project} created.` });
      console.info("[todo-ui] project created", { project: result.project, selectedAsProjectFilter: true, retainedView: view });
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
    setProjectSelectorOpen(false);
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
      if (project === result.project) setProject(result.mode === "reassign" ? result.targetProject ?? "" : "");
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

  const stable_toggleSelected = useStableCallback(toggleSelected);
  const stable_taskAction = useStableCallback(taskAction);
  const stable_queueTask = useStableCallback((todo: Todo) => setQueueRequest({ id: crypto.randomUUID(), todoIds: [todo.id] }));
  const closeQueue = useStableCallback(() => setQueueRequest(null));
  const queueGuard = useStableCallback(async (id: number, source?: TaskQueueSource) => {
    const current = taskStore.getById(id);
    if (!current || current.id < 1 || current.offline) throw Error("Save and sync this task before queueing.");
    if (pendingTodoPatchesRef.current.has(id) || pendingActionPatchesRef.current.has(id) || pendingDeletedIdsRef.current.has(id)
        || Object.keys(taskStore.getDraft(taskKey(current)) ?? {}).length) throw Error("Wait for pending task changes to save before queueing.");
    if (editingIdRef.current === id && (autosaveInFlightRef.current || editSaveState !== "saved" || loadingAttachments
      || editDraftRef.current && editBaselineRef.current && Object.keys(changedDraftPatch(editDraftRef.current, editBaselineRef.current)).length
      || detailUploads.some(file => file.status !== "ready"))) throw Error("Save the task and finish its files before queueing. Your draft is retained.");
    const [mutations, uploads, actions] = await Promise.all([listOfflineTodoMutations(), listQueuedAttachments(), listOfflineTaskActions()]);
    if (mutations.some(m => m.todoId === id) || uploads.some(file => file.todoId === id && !file.cancelled)
      || actions.some(action => action.taskIds.includes(id))) throw Error("Sync pending task changes/files before queueing.");
    const latest = taskStore.getById(id);
    if (source && (!latest || latest.title !== source.title || latest.notes !== source.notes || latest.updatedAt !== source.updatedAt || latest.attachmentCount !== source.files.length))
      throw Error("The saved task differs from your selection. Save/reload it before queueing; retain the original transfer.");
    if (source && editingIdRef.current === id && (detailAttachments.length !== source.files.length || detailAttachments.some(file => !source.files.some(f => f.id === file.id && f.name === file.fileName && f.size === file.byteSize && f.mimeType === file.mimeType))))
      throw Error("Task files changed. Reload their confirmed state before queueing.");
  });
  const queueChanged = useStableCallback(() => taskSync.wake());
  const stable_editTaskDetails = useStableCallback(editTaskDetails);
  const stable_togglePin = useStableCallback(togglePin);
  const stable_acknowledgeUrgentAlert = useStableCallback(acknowledgeUrgentAlert);
  const stable_updateInlineTitle = useStableCallback(updateInlineTitle);
  const stable_blurInlineTitle = useStableCallback(blurInlineTitle);
  const stable_focusInlineTitle = useStableCallback(focusInlineTitle);
  const stable_navigateInlineTitle = useStableCallback(navigateInlineTitle);
  const stable_startTaskReorder = useStableCallback(startTaskReorder);
  const stable_moveTaskReorder = useStableCallback(moveTaskReorder);
  const stable_finishTaskReorder = useStableCallback(finishTaskReorder);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <TodoForward request={null} onClose={() => {}} />
      <TodoQueue request={queueRequest} onClose={closeQueue} guard={queueGuard} onChanged={queueChanged} />
      <SiteHeader
        current="todos"
        projectLabel={project === UNASSIGNED_PROJECT ? "Unassigned" : project || "Dawar Todo"}
        onProjectClick={openProjectSelector}
        onKeyboardHelp={() => {
          setShortcutsOpen(true);
          console.info("[todo-shortcuts] shortcut guide opened", { source: "header" });
        }}
      />
      {(connectionQuality !== "online" || showPendingSyncStatus) && (
        <div className="pointer-events-none fixed right-3 top-[4.25rem] z-40 rounded-full bg-[#202522] px-3 py-1.5 text-xs font-semibold text-white shadow-lg" role="status" aria-live="polite">
          {connectionQuality === "offline"
            ? `Offline${pendingSyncCount ? ` · ${pendingSyncCount} queued` : ""}`
            : connectionQuality === "degraded"
              ? `Reconnecting${pendingSyncCount ? ` · ${pendingSyncCount} saved on this device` : ""}`
              : connectionQuality === "auth" ? "Sign in again to sync · changes stay on this device"
              : connectionQuality === "unavailable" ? "Sync temporarily unavailable · retrying"
              : `${pendingSyncCount} changes saved on this device`}
        </div>
      )}
      <TaskIntentPanel />
      {uploadCount > 0 && <AttachmentQueuePanel count={uploadCount} states={uploadStates} />}
      {imageDropActive && (
        <div className="pointer-events-none fixed inset-0 z-[100] grid place-items-center bg-primary/20 p-5 backdrop-blur-[2px]" role="status" aria-live="polite">
          <div className="flex max-w-sm items-center gap-3 rounded-lg border border-primary/25 bg-card px-5 py-4 text-base font-medium text-primary shadow-lg">
            <ActionIcon name="attachment" className="h-6 w-6" />
            Drop attachments to add to {editingTodo ? "this task" : "the new task"}
          </div>
        </div>
      )}
      <div className="mx-auto max-w-5xl px-4 pb-56 pt-5 sm:px-6 sm:pb-40 sm:pt-7">
        {(captureSaveState.startsWith("Draft could not be loaded") || captureSaveState.startsWith("Draft not saved")) && <div className="mb-3 rounded-lg border border-destructive/30 bg-card p-3">
          <p role="alert" className="break-words text-sm text-destructive">{captureSaveState}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {captureSaveState.startsWith("Draft could not be loaded") && <Button type="button" variant="outline" onClick={hydrateCapture}>Retry loading draft</Button>}
            {captureSaveState.startsWith("Draft not saved") && <Button type="button" variant="outline" onClick={() => void checkpointCapture().catch(() => undefined)}>Retry saving</Button>}
            {captureAttachments.map(item => <Button asChild variant="outline" key={item.localId} className="h-auto min-h-11 max-w-full whitespace-normal py-2 text-left"><a href={item.previewUrl} download={item.file.name} className="[overflow-wrap:anywhere]">Save {item.file.name}</a></Button>)}
          </div>
        </div>}

        <form onSubmit={addTodo} className="mb-5 rounded-lg border border-border bg-card p-2 shadow-sm sm:p-3">
          <div className="flex items-end gap-2">
            <div className="flex min-w-0 flex-1 items-start gap-2 px-1 py-2 sm:px-2">
              <AttachmentPicker
                label="Add attachment or assign project"
                disabled={!captureReady || adding}
                onFiles={(files) => void queueCaptureAttachments(files)}
                onRecord={(opener) => { voiceReturnFocusRef.current = opener; setVoiceTarget("capture"); }}
                onAssignProject={openCaptureProjectAssignment}
              />
              <Textarea
                ref={captureRef}
                disabled={!captureReady || adding}
                value={newTitle}
                onChange={(event) => updateCaptureTitle(event.target.value, "typing")}
                onBlur={flushCaptureDraft}
                onPaste={(event) => {
                  const files = clipboardAttachments(event);
                  if (files.length) void queueCaptureAttachments(files);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                rows={1}
                placeholder={recognizingCaptureTitle ? "Reading image…" : "Add a task…"}
                aria-label="Add a task"
                aria-busy={recognizingCaptureTitle}
                maxLength={2000}
                className="min-h-10 min-w-0 flex-1 resize-none overflow-hidden border-0 px-1 py-2 text-base leading-6 shadow-none sm:text-base"
              />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="hidden text-xs text-muted-foreground sm:block">⌘↵ add</span>
              <Button
                type="submit"
                disabled={!captureReady || capturePreparing || !newTitle.trim() || adding || voiceTarget === "capture" || Boolean(projectDialog?.captureDraft) || captureAttachments.some((item) => item.status === "uploading" || item.status === "error")}
                className="shrink-0"
              >
                <ActionIcon name="add" />
                {adding ? "Adding…" : "Add"}
              </Button>
            </div>
          </div>

          {captureProject && <div className="mt-2 flex min-w-0 items-center gap-1 border-t border-border px-1 pt-2">
            <Button type="button" variant="secondary" onClick={() => openCaptureProjectAssignment()} className="min-w-0 max-w-full" title={`Change project from ${captureProject}`}><ActionIcon name="folder" /><span className="truncate">{captureProject}</span></Button>
            <Button type="button" variant="ghost" size="icon" disabled={!captureReady || adding} onClick={() => { updateCaptureProject(""); console.info("[todo-ui] quick add project removed"); }} aria-label={`Remove ${captureProject} from new task`} className="shrink-0 text-muted-foreground"><ActionIcon name="close" /></Button>
          </div>}

          {captureAttachments.length > 0 && <CaptureAttachments items={captureAttachments} limit={MAX_ATTACHMENTS} disabled={!captureReady || adding} onRetry={retryCaptureAttachment} onRemove={item => void removeCaptureAttachment(item)} />}

        </form>

        <section aria-labelledby="tasks-heading">
          <TaskListControls view={view} counts={counts} onView={chooseView} query={query} onQuery={setQuery} searchRef={searchRef} priority={priority} onPriority={setPriority} pins={pinListEnabled} pinCount={pinnedTaskCount} pinLimit={MAX_PINNED_TASKS} onPins={togglePinList} filterCount={mobileFilterCount} onFilters={() => setFiltersOpen(true)} />
          {filtersOpen && <TaskFiltersDialog priority={priority} onPriority={setPriority} count={filtered.length} onClose={() => setFiltersOpen(false)} />}

          <div className="mb-2 flex items-center justify-between px-1">
            <div className="flex items-center gap-3">
              <h2 id="tasks-heading" className="text-sm font-semibold text-foreground">{viewLabels[view]} tasks</h2>
              {filtered.length > 0 && <button onClick={toggleVisible} className="inline-flex items-center gap-1.5 text-xs font-medium text-[#216e4e] hover:underline"><ActionIcon name={allVisibleSelected ? "cancel" : "select"} className="h-3.5 w-3.5" />{allVisibleSelected ? "Clear selection" : "Select visible"}</button>}
            </div>
            <div className="flex items-center gap-3 text-[13px] text-muted-foreground">
              <span>{syncing ? "Saving…" : `${filtered.length} ${filtered.length === 1 ? "item" : "items"}`}</span>
              {filtersActive && <button onClick={() => { setQuery(""); setPriority(""); }} className="inline-flex items-center gap-1 font-medium text-[#216e4e] hover:underline"><ActionIcon name="cancel" className="h-3.5 w-3.5" />Clear filters</button>}
            </div>
          </div>

          <div
            data-task-list-surface
            className="-mx-4 overflow-hidden border-y border-border bg-card shadow-sm sm:mx-0 sm:rounded-lg sm:border"
          >
            {loading ? (
              <div role="status" className="space-y-1 p-2" aria-label="Loading tasks">
                {[0, 1, 2, 3, 4].map((item) => <div key={item} className="h-[72px] motion-safe:animate-pulse rounded-md bg-muted" />)}
              </div>
            ) : filtered.length ? (
              <ul ref={taskListAnimationRef} className="divide-y divide-border">
                {pinnedOpenTodos.length > 0 && (
                  <li className="flex items-center justify-between bg-accent px-4 py-2 text-xs font-medium text-accent-foreground sm:px-5">
                    <span className="inline-flex items-center gap-1.5"><ActionIcon name="pin" className="h-3.5 w-3.5" />Pinned</span>
                    <span>{pinnedOpenTodos.length}</span>
                  </li>
                )}
                {pinnedOpenTodos.map((todo) => (
                  <SubscribedTaskRow
                    key={taskKey(todo)}
                    todo={todo}
                    selected={selected.has(todo.id)}
                    now={now}
                    timeZone={scheduleTimeZone}
                    onSelect={stable_toggleSelected}
                    onAction={stable_taskAction}
                    onEdit={stable_editTaskDetails}
                    onQueue={stable_queueTask}
                    onPin={stable_togglePin}
                    onAcknowledgeUrgent={stable_acknowledgeUrgentAlert}
                    onTitleChange={stable_updateInlineTitle}
                    onTitleBlur={stable_blurInlineTitle}
                    onTitleFocus={stable_focusInlineTitle}
                    onTitleArrowNavigate={stable_navigateInlineTitle}
                    onReorderStart={stable_startTaskReorder}
                    onReorderMove={stable_moveTaskReorder}
                    onReorderEnd={stable_finishTaskReorder}
                    showPin
                    reordering={reorderingId === todo.id}
                    reorderTarget={reorderTargetId === todo.id}
                  />
                ))}
                {pinnedOpenTodos.length > 0 && regularOpenTodos.length > 0 && (
                  <li className="flex items-center justify-between bg-muted px-4 py-2 text-xs font-medium text-muted-foreground sm:px-5">
                    <span>Open</span>
                    <span>{regularOpenTodos.length}</span>
                  </li>
                )}
                {regularOpenTodos.map((todo) => (
                  <SubscribedTaskRow
                    key={taskKey(todo)}
                    todo={todo}
                    selected={selected.has(todo.id)}
                    now={now}
                    timeZone={scheduleTimeZone}
                    onSelect={stable_toggleSelected}
                    onAction={stable_taskAction}
                    onEdit={stable_editTaskDetails}
                    onQueue={stable_queueTask}
                    onPin={stable_togglePin}
                    onAcknowledgeUrgent={stable_acknowledgeUrgentAlert}
                    onTitleChange={stable_updateInlineTitle}
                    onTitleBlur={stable_blurInlineTitle}
                    onTitleFocus={stable_focusInlineTitle}
                    onTitleArrowNavigate={stable_navigateInlineTitle}
                    onReorderStart={stable_startTaskReorder}
                    onReorderMove={stable_moveTaskReorder}
                    onReorderEnd={stable_finishTaskReorder}
                    showPin={view === "open"}
                    reordering={reorderingId === todo.id}
                    reorderTarget={reorderTargetId === todo.id}
                  />
                ))}
              </ul>
            ) : (
              <div className="px-6 py-14 text-center">
                <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-accent text-xl text-primary">✓</div>
                <p className="font-medium text-foreground">{filtersActive ? "No tasks match those filters." : view === "snoozed" ? "Nothing is snoozed." : view === "done" ? "Nothing is done yet." : "You’re clear."}</p>
                <p className="mt-1 text-sm text-muted-foreground">{filtersActive ? "Try clearing a filter or changing the search." : view === "snoozed" ? "Snoozed tasks return here until their wake time." : view === "done" ? "Completed tasks will collect here." : "Add the next thing when it appears."}</p>
              </div>
            )}
          </div>
        </section>

      </div>

      {selectedIds.length > 0 && <TaskBulkActions count={selectedIds.length} todos={selectedTodos} snoozedView={view === "snoozed"} busy={syncing} onAction={bulkAction} onQueue={() => setQueueRequest({ id: crypto.randomUUID(), todoIds: displayedTodos.filter(todo => selected.has(todo.id)).map(todo => todo.id) })} onCancel={() => setSelected(new Set())} />}

      {customSnoozeDialog && <CustomSnoozeDialog count={customSnoozeDialog.ids.length} value={customSnoozeDialog.localDateTime} error={customSnoozeDialog.error} timeZone={scheduleTimeZone} busy={adjustingSnooze !== null} onValue={value => setCustomSnoozeDialog(current => current ? { ...current, localDateTime: value, error: "" } : current)} onClose={() => closeCustomSnooze("button")} onSubmit={saveCustomSnooze} />}

      {shortcutsOpen && <KeyboardShortcutsDialog onClose={() => {
        setShortcutsOpen(false);
        console.info("[todo-shortcuts] shortcut guide closed", { source: "button" });
      }} />}

      {projectSelectorOpen && <ProjectBrowser selected={project} total={todos.length} unassigned={unassignedProjectCounts} unassignedValue={UNASSIGNED_PROJECT} projects={projectOptions} loading={loading} onSelect={selectProjectFilter} onView={openProjectTasks} onCreate={openNewProjectDialog} onDelete={openProjectDeleteDialog} onClose={() => closeProjectSelector("button")} />}

      {newProjectOpen && <CreateProjectDialog name={newProjectName} error={newProjectError} busy={creatingProject} onName={value => { setNewProjectName(value); setNewProjectError(""); }} onClose={closeNewProjectDialog} onSubmit={createProject} />}

      {projectDeleteDialog && <DeleteProjectDialog name={projectDeleteDialog.name} count={todos.filter(todo => todo.project === projectDeleteDialog.name).length} alternatives={registeredProjects.filter(name => name !== projectDeleteDialog.name)} mode={projectDeleteDialog.mode} target={projectDeleteDialog.targetProject} error={projectDeleteError} busy={deletingProject} onMode={mode => setProjectDeleteDialog(current => current ? { ...current, mode, targetProject: mode === "reassign" ? current.targetProject || registeredProjects.filter(name => name !== current.name)[0] || "" : current.targetProject } : current)} onTarget={targetProject => { setProjectDeleteDialog(current => current ? { ...current, targetProject } : current); setProjectDeleteError(""); }} onClose={closeProjectDeleteDialog} onSubmit={deleteProject} />}

      {projectDialog && <AssignProjectDialog returnFocus={projectReturnFocusRef.current} count={projectDialog.ids.length} capture={Boolean(projectDialog.captureDraft)} selection={projectDialog.selection} newName={projectDialog.newProject} projects={projects} createValue={CREATE_PROJECT} unassignedValue={UNASSIGNED_PROJECT} error={projectDialogError} busy={savingProject} onSelection={selection => { setProjectDialog(current => current ? { ...current, selection } : current); setProjectDialogError(""); }} onName={newProject => { setProjectDialog(current => current ? { ...current, newProject } : current); setProjectDialogError(""); }} onClose={closeProjectAssignment} onSubmit={saveProjectAssignment} />}

      {editingTodo && editDraft && (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-x-hidden sm:items-center sm:p-5">
          <button type="button" aria-label="Close task details" onClick={closeTaskDetails} className="absolute inset-0 bg-black/35 backdrop-blur-[2px]" />
          <div
            data-no-pull-refresh
            aria-hidden={taskDialogPullDistance <= 0}
            className="pointer-events-none absolute inset-x-0 top-[calc(env(safe-area-inset-top)+0.5rem)] z-[60] flex justify-center md:hidden"
            style={{
              opacity: taskDialogPullDistance > 0 ? Math.min(1, taskDialogPullDistance / 18) : 0,
              transform: `translate3d(0, ${Math.min(16, taskDialogPullDistance - 44)}px, 0)`,
            }}
          >
            <PullGesturePill
              label={taskDialogPullReady ? "Release to close" : "Pull to close"}
              icon="down"
              rotation={taskDialogPullReady ? 180 : 0}
            />
          </div>
          <form
            ref={taskDialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-details-title"
            onSubmit={(event) => event.preventDefault()}
            className={classNames(
              "relative flex max-h-[92dvh] w-full max-w-full flex-col overflow-hidden overflow-x-hidden rounded-t-lg border border-border bg-card shadow-lg outline-none sm:max-w-2xl sm:rounded-lg",
              taskDialogPulling ? "transition-none" : "transition-transform duration-150 ease-out motion-reduce:transition-none",
            )}
            style={{ transform: `translate3d(0, ${taskDialogPullDistance}px, 0)` }}
          >
            <div className="relative flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 pb-4 pt-5 sm:px-6 sm:py-4">
              <span className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-black/15 sm:hidden" aria-hidden="true" />
              <h3 id="task-details-title" className="min-w-0 text-lg font-semibold text-foreground">Task details</h3>
              <div className="flex shrink-0 items-center gap-1">
                {editingTodo?.queueLastTransfer && <a className="text-xs text-primary" href={`/bots?bot=${encodeURIComponent(editingTodo.queueLastTransfer.botId)}`}>Queued to bot · source retained</a>}
                <Button variant="ghost" type="button" onClick={() => { if (editingId !== null) setQueueRequest({ id: crypto.randomUUID(), todoIds: [editingId] }); }} size="icon" className="shrink-0 text-muted-foreground" aria-label="Queue task to a bot" title="Queue to bot"><ActionIcon name="forward" /></Button>
                <Button variant="ghost" type="button" onClick={() => void copyTaskDetails()} size="icon" className="shrink-0 text-muted-foreground" aria-label="Copy task title and description" title="Copy task"><ActionIcon name="copy" /></Button>
                <Button variant="ghost" type="button" onClick={closeTaskDetails} size="icon" className="shrink-0 text-muted-foreground" aria-label="Close task details" title="Close"><ActionIcon name="close" /></Button>
              </div>
            </div>

            <div ref={taskDialogScrollRef} className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto px-4 py-5 sm:px-6">
              {isSnoozed(editingTodo, now) && editingTodo.snoozedUntil && (
                <div className="mb-4">
                  <SnoozeStatusBadge value={editingTodo.snoozedUntil} now={now} timeZone={scheduleTimeZone} />
                </div>
              )}
              <div className="block min-w-0">
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-muted-foreground">Description</span>
                  <Button variant="ghost"
                    type="button"
                    onClick={() => setDescriptionPreview((current) => !current)}
                    aria-pressed={descriptionPreview}
                    size="sm" className="text-primary"
                  >
                    <ActionIcon name={descriptionPreview ? "edit" : "preview"} className="h-3.5 w-3.5" />
                    {descriptionPreview ? "Edit" : "Preview"}
                  </Button>
                </div>
                {descriptionPreview ? (
                  <MarkdownPreview value={editDraft.notes} />
                ) : (
                  <Textarea
                    aria-label="Description"
                    value={editDraft.notes}
                    onChange={(event) => updateEditDraftField("notes", event.target.value)}
                    onFocus={() => focusEditDraftField("notes")}
                    onBlur={() => blurEditDraftField("notes")}
                    onPaste={(event) => {
                      const files = clipboardAttachments(event);
                      if (files.length) void queueDetailAttachments(files);
                    }}
                    rows={5}
                    placeholder="Add context, links, next steps, or Markdown…"
                    maxLength={MAX_TASK_DESCRIPTION_LENGTH}
                    className="min-h-28 resize-y leading-6"
                  />
                )}
              </div>

              <section className="mt-4 min-w-0" aria-labelledby="task-attachments-heading">
                <div className="mb-2 flex min-w-0 items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h4 id="task-attachments-heading" className="text-sm font-medium text-muted-foreground">Attachments</h4>
                    <p className="mt-0.5 text-xs text-muted-foreground">{detailAttachments.length + detailUploads.length}/{MAX_ATTACHMENTS} attached</p>
                  </div>
                  <AttachmentPicker
                    label="Add attachment to task"
                    onOpenChange={setDetailAttachmentPickerOpen}
                    showLabel
                    onFiles={(files) => void queueDetailAttachments(files)}
                    onRecord={(opener) => { voiceReturnFocusRef.current = opener; setVoiceTarget("detail"); }}
                    disabled={detailAttachments.length + detailUploads.length >= MAX_ATTACHMENTS}
                  />
                </div>

                {loadingAttachments ? (
                  <div role="status" aria-label="Loading attachments" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {[0, 1, 2].map((item) => <Skeleton key={item} className="aspect-square rounded-lg" />)}
                  </div>
                ) : attachmentError ? (
                  <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                    <span className="min-w-0 break-words">{attachmentError}</span>
                    <Button type="button" variant="outline" onClick={() => void loadTaskAttachments(editingTodo.id)}><ActionIcon name="retry" />Retry</Button>
                  </div>
                ) : detailAttachments.length || detailUploads.length ? (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {detailAttachments.map((attachment) => <TaskAttachmentMedia key={attachment.id} attachment={attachment} disabled={syncing} onDelete={() => void deleteDetailAttachment(attachment)} onView={() => setViewerIndex(imageAttachments.findIndex((image) => image.id === attachment.id))} />)}
                    {detailUploads.map((item) => <PendingTaskAttachment key={item.localId} item={item} onRetry={() => retryDetailAttachment(item)} onRemove={() => removeDetailUpload(item)} />)}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">No attachments yet.</div>
                )}
              </section>

              <TaskDetailFields taskId={editingTodo.id} editDraft={editDraft} savingEdit={savingEdit} recurrenceError={recurrenceError} scheduleTimeZone={scheduleTimeZone} onAssignProject={() => openProjectAssignment([editingTodo.id], "details")} updateEditDraftField={updateEditDraftField} />

              <div className="mt-5 border-t border-border pt-4">
                <p className="mb-2 text-sm font-medium text-muted-foreground">Quick actions</p>
                <div className="flex min-w-0 flex-wrap gap-2">
                  {editingTodo.status === "completed" ? (
                    <Button variant="ghost" type="button" onClick={() => detailAction("unsnooze")} disabled={syncing || savingEdit} className="border border-border"><ActionIcon name={todoActionIcon("unsnooze", "Open")} />Open</Button>
                  ) : (
                    <Button variant="ghost" type="button" onClick={() => detailAction("complete")} disabled={syncing || savingEdit} className="border border-border"><ActionIcon name={todoActionIcon("complete", "Done")} />Done</Button>
                  )}
                  {editingTodo.status === "open" && !editDraft.recurrenceCron.trim() && (isSnoozed(editingTodo, now) ? (
                    <Button variant="ghost" type="button" onClick={() => detailAction("unsnooze")} disabled={syncing || savingEdit} className="border border-border"><ActionIcon name={todoActionIcon("unsnooze", "Wake")} />Wake</Button>
                  ) : (
                    <Button variant="ghost" type="button" onClick={() => detailAction("snooze")} disabled={syncing || savingEdit} className="border border-border"><ActionIcon name={todoActionIcon("snooze", "Snooze")} />Snooze</Button>
                  ))}
                  {view === "open" && <Button variant="ghost" type="button" onClick={() => void togglePin(editingTodo)} disabled={syncing || savingEdit} className="border border-border"><ActionIcon name={editingTodo.pinned ? "unpin" : "pin"} />{editingTodo.pinned ? "Unpin" : "Pin"}</Button>}
                  <Button variant="ghost" type="button" onClick={() => openProjectAssignment([editingTodo.id], "details")} disabled={syncing || savingEdit} className="border border-border"><ActionIcon name={todoActionIcon("assign", "Assign project")} />Assign project</Button>
                  <Button variant="ghost" type="button" onClick={() => detailAction("delete")} disabled={syncing || savingEdit} className="border border-border text-destructive hover:text-destructive"><ActionIcon name={todoActionIcon("delete", "Delete")} />Delete</Button>
                </div>
              </div>
            </div>

            <div className="flex min-h-14 items-center justify-between gap-3 border-t border-border bg-background px-5 py-3 sm:px-6" aria-live="polite">
              <span className={classNames(
                "inline-flex min-w-0 items-center gap-2 text-sm font-medium",
                editSaveState === "error" ? "text-red-700" : editSaveState === "offline" ? "text-amber-700" : "text-muted-foreground",
              )}>
                <span className={classNames("h-2 w-2 shrink-0 rounded-full", editSaveState === "saving" ? "animate-pulse bg-[#216e4e]" : editSaveState === "error" ? "bg-red-600" : editSaveState === "offline" ? "bg-amber-500" : "bg-emerald-600")} />
                <span className="truncate">{editSaveMessage}</span>
              </span>
              {editSaveState === "error" && (
                <Button variant="ghost" type="button" onClick={() => { if (editingIdRef.current && editDraftRef.current && editBaselineRef.current) void persistTaskDraft(editingIdRef.current, editDraftRef.current, "retry", editBaselineRef.current); }} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-red-700 hover:bg-red-50"><ActionIcon name="retry" />Retry</Button>
              )}
            </div>
          </form>
        </div>
      )}

      {voiceTarget && (
        <VoiceMemoRecorder
          maxBytes={MAX_AUDIO_BYTES}
          maxDurationMs={MAX_AUDIO_DURATION_MS}
          returnFocus={voiceReturnFocusRef.current}
          onClose={() => setVoiceTarget(null)}
          onAttach={(file, durationMs) => voiceTarget === "detail" ? queueDetailVoice(file, durationMs) : queueCaptureVoice(file, durationMs)}
        />
      )}

      {viewerAttachment && viewerIndex !== null && <TaskImageViewer attachment={viewerAttachment} index={viewerIndex} count={imageAttachments.length} copyState={viewerCopyState} onClose={() => setViewerIndex(null)} onCopy={() => void copyViewerImage()} onDelete={() => void deleteDetailAttachment(viewerAttachment)} onNavigate={delta => setViewerIndex(current => current === null ? null : (current + delta + imageAttachments.length) % imageAttachments.length)} />}

      {notice && <TaskNotice notice={notice} bulkActionsVisible={selectedIds.length > 0} undoing={undoing} adjusting={adjustingSnooze !== null} presets={quickSnoozePresets} onUndo={() => requestNoticeUndo(notice)} onDismiss={() => setNotice(null)} onSnooze={preset => void adjustSnooze(notice.snoozeIds as number[], preset, notice.operationId)} onCustomSnooze={() => openCustomSnooze(notice.snoozeIds as number[], notice.operationId)} />}

    </main>
  );
}

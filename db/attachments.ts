import { waitUntil } from "../lib/source-writer-work";
import { createS3Storage, readStoragePrefix, storageResponseMetadata } from "../lib/s3-storage";
import { uploadStorageBlob, type StoragePostTarget } from '../lib/storage-upload';
import { attachmentErrorDetails, type AttachmentPhase } from "../lib/attachment-errors";
import type { AttachmentRecovery } from "../lib/attachment-recovery";
import { env } from "cloudflare:workers";
import { attachmentFileExtension, attachmentFileMimeType, detectAttachmentFileFormat } from "../lib/attachment-files";

export const MAX_ATTACHMENTS_PER_TASK = 12;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_AUDIO_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_AUDIO_DURATION_MS = 30 * 60 * 1000;
export const MAX_VIDEO_ATTACHMENT_BYTES = 250 * 1024 * 1024;
export const MAX_VIDEO_DURATION_MS = 60 * 60 * 1000;
export const MAX_FILE_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100_000_000;
const DRAFT_LIFETIME_HOURS = 24;
const DELETED_RETENTION_DAYS = 7;
const CLEANUP_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

type RuntimeEnv = {
  DB: D1Database;
  S3_ACCESS_KEY: string;
  S3_ACCESS_KEY_ID: string;
  S3_BUCKET: string;
  S3_ENDPOINT_URL: string;
  IMAGES: ImagesBinding;
};

let cachedStorage: ReturnType<typeof createS3Storage> | null = null;
function storage() { return cachedStorage ??= createS3Storage(runtime()); }
let nextCleanupCheckAt = 0;

export type AttachmentRow = {
  id: string;
  todo_id: number | null;
  draft_token: string | null;
  original_key: string;
  display_key: string;
  thumbnail_key: string;
  file_name: string;
  mime_type: string;
  byte_size: number;
  width: number;
  height: number;
  kind: "image" | "audio" | "video" | "file";
  duration_ms: number;
  upload_state: "uploading" | "ready";
  sort_order: number;
  expires_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TodoAttachment = {
  id: string;
  todoId: number | null;
  fileName: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
  kind: "image" | "audio" | "video" | "file";
  durationMs: number;
  sortOrder: number;
  thumbnailUrl: string;
  displayUrl: string;
  originalUrl: string;
  audioUrl: string;
  videoUrl: string;
  createdAt: string;
};

function runtime() {
  return env as unknown as RuntimeEnv;
}

function database() {
  const db = runtime().DB;
  if (!db) throw new Error("The attachment database is unavailable.");
  return db;
}

function normalizedFormat(value: string) {
  const format = value.toLowerCase().replace(/^image\//, "");
  if (format === "jpg") return "jpeg";
  return format;
}

function cleanFileName(value: string) {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (cleaned || "image").slice(0, 180);
}

function validateDraftToken(value: string) {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error("That attachment draft is invalid.");
  return value;
}

function storageUrl(key?: string, query?: Record<string, string>) { return storage().storageUrl(key, query); }
function storageFetch(url: URL, init?: RequestInit) { return storage().storageFetch(url, init); }
function deleteKeys(keys: string[]) { return storage().deleteKeys(keys); }
function signedObjectUrl(key: string, name?: string) { return storage().signedObjectUrl(key, name); }
function signedPostTarget(key: string, type: string, max: number) { return storage().signedPostTarget(key, type, max); }
function storageResponseError(stage: string, response: Response) { return storage().storageResponseError(stage, response); }

async function mapAttachment(row: AttachmentRow): Promise<TodoAttachment> {
  const kind = row.kind ?? "image";
  const [originalUrl, inlineOriginalUrl] = await Promise.all([
    signedObjectUrl(row.original_key, row.file_name),
    kind === "audio" || kind === "video" ? signedObjectUrl(row.original_key) : Promise.resolve(""),
  ]);
  const [thumbnailUrl, displayUrl] = kind === "image"
    ? await Promise.all([
        signedObjectUrl(row.thumbnail_key),
        signedObjectUrl(row.display_key),
      ])
    : ["", ""];
  return {
    id: row.id,
    todoId: row.todo_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    kind,
    durationMs: Number(row.duration_ms ?? 0),
    sortOrder: row.sort_order,
    thumbnailUrl,
    displayUrl,
    originalUrl,
    audioUrl: kind === "audio" ? inlineOriginalUrl : "",
    videoUrl: kind === "video" ? inlineOriginalUrl : "",
    createdAt: row.created_at,
  };
}

type UploadTarget = { todoId: number } | { draftToken: string };

type PrepareUploadInput = {
  clientUploadId?: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  displayMimeType?: string;
  thumbnailMimeType?: string;
};

type FinalizeUploadInput = {
  width: number;
  height: number;
};

type PrepareMediaUploadInput = {
  clientUploadId?: string;
  kind: "audio" | "video" | "file";
  fileName: string;
  mimeType: string;
  byteSize: number;
};

export type DirectAttachmentUploadInput = {
  clientUploadId?: string;
  fileName: string;
  mimeType: string;
  file: Blob;
  kind?: "image" | "audio" | "video" | "file";
  durationMs?: number;
};

type FinalizeMediaUploadInput = {
  durationMs: number;
};

function normalizedMimeType(value: string, fileName: string) {
  const supplied = value.toLowerCase().trim();
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const inferred = extension === "jpg" || extension === "jpeg" ? "image/jpeg"
    : extension && ["png", "webp", "gif", "heic", "heif"].includes(extension) ? `image/${extension}`
      : "";
  const mimeType = supplied || inferred;
  const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"]);
  if (!allowed.has(mimeType)) throw new Error("Use a JPEG, PNG, WebP, GIF, HEIC, or HEIF image.");
  return mimeType;
}

function extensionForMimeType(mimeType: string) {
  return mimeType === "image/jpeg" ? "jpg" : mimeType.replace("image/", "");
}

function normalizedDerivativeMimeType(value: string | undefined) {
  const mimeType = value?.toLowerCase().trim() || "image/webp";
  if (mimeType !== "image/webp" && mimeType !== "image/jpeg") {
    throw new Error("Optimized images must be WebP or JPEG.");
  }
  return mimeType;
}

function derivativeFormatForKey(key: string) {
  if (/\.webp$/i.test(key)) return "webp";
  if (/\.(?:jpe?g)$/i.test(key)) return "jpeg";
  return null;
}

function normalizedAudioMimeType(value: string, fileName = "") {
  const supplied = value.toLowerCase().split(";", 1)[0].trim();
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const inferred = extension === "m4a" || extension === "mp4" ? "audio/mp4"
    : extension === "mp3" ? "audio/mpeg"
      : extension && ["webm", "ogg", "wav"].includes(extension) ? `audio/${extension}`
        : "";
  if ((!supplied || supplied === "application/octet-stream") && inferred) return inferred;
  if (supplied === "audio/x-wav") return "audio/wav";
  if (["audio/mp4", "audio/webm", "audio/ogg", "audio/mpeg", "audio/wav"].includes(supplied)) return supplied;
  throw new Error("Voice memos must be MP4, WebM, Ogg, MP3, or WAV audio.");
}

function audioExtension(mimeType: string) {
  if (mimeType === "audio/mp4") return "m4a";
  if (mimeType === "audio/mpeg") return "mp3";
  return mimeType.replace("audio/", "");
}

function expectedAudioFormat(mimeType: string) {
  if (mimeType === "audio/mp4") return "mp4";
  if (mimeType === "audio/mpeg") return "mpeg";
  return mimeType.replace("audio/", "");
}

function normalizedVideoMimeType(value: string, fileName = "") {
  const supplied = value.toLowerCase().split(";", 1)[0].trim();
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const inferred = extension === "mov" ? "video/quicktime"
    : extension && ["mp4", "webm"].includes(extension) ? `video/${extension}`
      : "";
  if ((!supplied || supplied === "application/octet-stream") && inferred) return inferred;
  if (["video/mp4", "video/quicktime", "video/webm"].includes(supplied)) return supplied;
  throw new Error("Videos must be MP4, MOV, or WebM files.");
}

function videoExtension(mimeType: string) {
  if (mimeType === "video/quicktime") return "mov";
  return mimeType.replace("video/", "");
}

function expectedVideoFormat(mimeType: string) {
  if (mimeType === "video/quicktime" || mimeType === "video/mp4") return "mp4";
  return "webm";
}

function normalizedFileMimeType(value: string, fileName: string) {
  return attachmentFileMimeType(fileName, value);
}

function expectedFileFormat(fileName: string) {
  const extension = attachmentFileExtension(fileName);
  if (extension === "pdf") return "pdf";
  if (["docx", "xlsx", "pptx", "odt", "ods", "odp", "zip"].includes(extension)) return "zip";
  if (["doc", "xls", "ppt"].includes(extension)) return "compound";
  if (extension === "7z") return "7z";
  if (extension === "rtf") return "rtf";
  return "text";
}

function attachmentObjectKeys(row: AttachmentRow) {
  return (row.kind ?? "image") === "image"
    ? [row.original_key, row.display_key, row.thumbnail_key]
    : [row.original_key];
}

function targetValues(target: UploadTarget) {
  const isDraft = "draftToken" in target;
  return {
    isDraft,
    draftToken: isDraft ? validateDraftToken(target.draftToken) : null,
    todoId: isDraft ? null : target.todoId,
  };
}

function uploadIdentity(inputId?: string) {
  if (inputId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(inputId)) throw new Error("That file upload identifier is invalid.");
  return inputId || crypto.randomUUID();
}
function validateUploadReplay(row: AttachmentRow, target: UploadTarget, fileName: string, mimeType: string, byteSize: number, kind: string) {
  const { todoId, draftToken } = targetValues(target);
  if (row.todo_id !== todoId || row.draft_token !== draftToken || row.deleted_at || row.file_name !== fileName || row.mime_type !== mimeType || Number(row.byte_size) !== byteSize || row.kind !== kind) {
    throw new Error("That file upload identifier is already used or the attachment was removed.");
  }
}

export async function prepareTodoAttachmentUpload(
  input: PrepareUploadInput,
  target: UploadTarget,
) {
  const startedAt = Date.now();
  const byteSize = Number(input.byteSize);
  if (!Number.isInteger(byteSize) || byteSize < 1) throw new Error("That image is empty.");
  if (byteSize > MAX_ATTACHMENT_BYTES) throw new Error("Images are limited to 20 MB each.");
  const fileName = cleanFileName(input.fileName);
  const mimeType = normalizedMimeType(input.mimeType, fileName);
  const displayMimeType = normalizedDerivativeMimeType(input.displayMimeType);
  const thumbnailMimeType = normalizedDerivativeMimeType(input.thumbnailMimeType);
  const db = database();
  const { isDraft, draftToken, todoId } = targetValues(target);
  if (todoId !== null) {
    const todo = await db.prepare("SELECT id FROM todos WHERE id = ?").bind(todoId).first<{ id: number }>();
    if (!todo) throw new Error("Task not found.");
  }
  const id = uploadIdentity(input.clientUploadId);
  const existing = input.clientUploadId ? await db.prepare("SELECT * FROM todo_attachments WHERE id = ?").bind(id).first<AttachmentRow>() : null;
  if (existing) validateUploadReplay(existing, target, fileName, mimeType, byteSize, "image");
  const count = todoId === null
    ? await db.prepare("SELECT COUNT(*) AS count FROM todo_attachments WHERE draft_token = ? AND deleted_at IS NULL").bind(draftToken).first<{ count: number }>()
    : await db.prepare("SELECT COUNT(*) AS count FROM todo_attachments WHERE todo_id = ? AND deleted_at IS NULL").bind(todoId).first<{ count: number }>();
  if (!existing && Number(count?.count ?? 0) >= MAX_ATTACHMENTS_PER_TASK) {
    throw new Error(`Tasks are limited to ${MAX_ATTACHMENTS_PER_TASK} attachments.`);
  }

  const base = `todo-images/${id}`;
  const originalKey = `${base}/original.${extensionForMimeType(mimeType)}`;
  const displayKey = `${base}/display.${extensionForMimeType(displayMimeType)}`;
  const thumbnailKey = `${base}/thumb.${extensionForMimeType(thumbnailMimeType)}`;
  try {
    const nextOrder = Number(count?.count ?? 0);
    const expiresAt = new Date(Date.now() + DRAFT_LIFETIME_HOURS * 60 * 60 * 1000).toISOString();
    const inserted = await db.prepare(`
      INSERT OR IGNORE INTO todo_attachments (
        id, todo_id, draft_token, original_key, display_key, thumbnail_key,
        file_name, mime_type, byte_size, width, height, upload_state, sort_order, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'uploading', ?, ?)
      RETURNING *
    `).bind(
      id,
      todoId,
      draftToken,
      originalKey,
      displayKey,
      thumbnailKey,
      fileName,
      mimeType,
      byteSize,
      nextOrder,
      expiresAt,
    ).first<AttachmentRow>();
    let row = inserted ?? await db.prepare("SELECT * FROM todo_attachments WHERE id = ?").bind(id).first<AttachmentRow>();
    if (!row) throw new Error("The image upload could not be prepared.");
    validateUploadReplay(row, target, fileName, mimeType, byteSize, "image");
    if (row.upload_state === "uploading" && (row.display_key !== displayKey || row.thumbnail_key !== thumbnailKey)) {
      // Safari may change WebP to JPEG on retry. Change only an unfinished row,
      // then sign the persisted keys. A concurrent ready result is immutable.
      row = await db.prepare(`
        UPDATE todo_attachments SET display_key = ?, thumbnail_key = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND upload_state = 'uploading' AND deleted_at IS NULL
          AND display_key = ? AND thumbnail_key = ? AND todo_id IS ? AND draft_token IS ?
        RETURNING *
      `).bind(displayKey, thumbnailKey, id, row.display_key, row.thumbnail_key, todoId, draftToken).first<AttachmentRow>()
        ?? await db.prepare("SELECT * FROM todo_attachments WHERE id = ?").bind(id).first<AttachmentRow>();
      if (!row) throw new Error("The image upload could not be prepared.");
      validateUploadReplay(row, target, fileName, mimeType, byteSize, "image");
    }
    if (row.upload_state === "ready") return { uploadId: id, attachment: await mapAttachment(row) };
    if (row.display_key !== displayKey || row.thumbnail_key !== thumbnailKey) {
      throw new Error("The image upload preparation was superseded; retry it.");
    }
    const [originalUpload, displayUpload, thumbnailUpload] = await Promise.all([
      signedPostTarget(row.original_key, mimeType, byteSize),
      signedPostTarget(row.display_key, displayMimeType, 8 * 1024 * 1024),
      signedPostTarget(row.thumbnail_key, thumbnailMimeType, 2 * 1024 * 1024),
    ]);
    console.info("[todo-attachments] direct upload prepared", {
      attachmentId: id,
      todoId,
      draft: isDraft,
      bytes: byteSize,
      displayMimeType,
      thumbnailMimeType,
      durationMs: Date.now() - startedAt,
    });
    return {
      uploadId: id,
      uploads: { original: originalUpload, display: displayUpload, thumbnail: thumbnailUpload },
    };
  } catch (error) {
    if (!input.clientUploadId) await db.prepare("DELETE FROM todo_attachments WHERE id = ? AND upload_state = 'uploading'").bind(id).run().catch(() => undefined);
    console.error("[todo-attachments] upload preparation failed", {
      attachmentId: id,
      todoId,
      draft: isDraft,
      bytes: byteSize,
      durationMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }
}

function detectedImageFormat(bytes: Uint8Array) {
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "webp";
  if (bytes.length >= 12 && ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4).toLowerCase();
    if (["heic", "heix", "hevc", "hevx", "heim", "heis"].includes(brand)) return "heic";
    if (["heif", "mif1", "msf1"].includes(brand)) return "heif";
  }
  return null;
}

async function firstBytes(key: string) {
  const response = await storageFetch(storageUrl(key), { method: "GET", headers: { Range: "bytes=0-" }, signal: AbortSignal.timeout(30000) });
  return readStoragePrefix(response);
}

function inspectedImageDimensions(bytes: Uint8Array, format: string) {
  const big16 = (offset: number) => (bytes[offset] << 8) | bytes[offset + 1];
  const little16 = (offset: number) => bytes[offset] | (bytes[offset + 1] << 8);
  const big32 = (offset: number) => ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  if (format === "png" && bytes.length >= 24) return { width: big32(16), height: big32(20) };
  if (format === "gif" && bytes.length >= 10) return { width: little16(6), height: little16(8) };
  if (format === "webp" && bytes.length >= 30) {
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (chunk === "VP8X") {
      const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
      return { width, height };
    }
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
      const height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
      return { width, height };
    }
    if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: little16(26) & 0x3fff, height: little16(28) & 0x3fff };
    }
  }
  if (format === "jpeg") {
    const sizeMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset];
      if (sizeMarkers.has(marker)) return { width: big16(offset + 6), height: big16(offset + 4) };
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 1; continue; }
      if (offset + 2 >= bytes.length) break;
      const length = big16(offset + 1);
      if (length < 2) break;
      offset += length + 1;
    }
  }
  return null;
}

export async function finalizeTodoAttachmentUpload(
  id: string,
  input: FinalizeUploadInput,
  target: UploadTarget,
) {
  const startedAt = Date.now();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("That image upload is invalid.");
  const width = Number(input.width);
  const height = Number(input.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS) {
    throw new Error("That image is too large to process.");
  }
  const db = database();
  const { draftToken, todoId } = targetValues(target);
  const row = todoId === null
    ? await db.prepare("SELECT * FROM todo_attachments WHERE id = ? AND draft_token = ? AND todo_id IS NULL AND deleted_at IS NULL").bind(id, draftToken).first<AttachmentRow>()
    : await db.prepare("SELECT * FROM todo_attachments WHERE id = ? AND todo_id = ? AND deleted_at IS NULL").bind(id, todoId).first<AttachmentRow>();
  if (!row) throw new Error("That image upload is no longer available.");
  if (row.upload_state === "ready") return mapAttachment(row);
  const readyCount = todoId === null
    ? await db.prepare("SELECT COUNT(*) AS count FROM todo_attachments WHERE draft_token = ? AND upload_state = 'ready' AND deleted_at IS NULL").bind(draftToken).first<{ count: number }>()
    : await db.prepare("SELECT COUNT(*) AS count FROM todo_attachments WHERE todo_id = ? AND upload_state = 'ready' AND deleted_at IS NULL").bind(todoId).first<{ count: number }>();
  if (Number(readyCount?.count ?? 0) >= MAX_ATTACHMENTS_PER_TASK) {
    throw new Error(`Tasks are limited to ${MAX_ATTACHMENTS_PER_TASK} images.`);
  }
  try {
    // A single bounded GET provides the prefix and total size. Do not request
    // beyond small thumbnails or depend on the provider's inconsistent HEAD.
    const [original, display, thumbnail] = await Promise.all([
      firstBytes(row.original_key),
      firstBytes(row.display_key),
      firstBytes(row.thumbnail_key),
    ]);
    const { bytes: originalBytes, size: originalSize } = original;
    const { bytes: displayBytes, size: displaySize } = display;
    const { bytes: thumbnailBytes, size: thumbnailSize } = thumbnail;
    if (originalSize < 1 || originalSize > MAX_ATTACHMENT_BYTES || displaySize < 1 || displaySize > 8 * 1024 * 1024 || thumbnailSize < 1 || thumbnailSize > 2 * 1024 * 1024) {
      throw new Error("One or more uploaded image files has an invalid size.");
    }
    if (originalSize !== row.byte_size) throw new Error("The original image upload is incomplete.");
    const expected = normalizedFormat(row.mime_type);
    const originalFormat = detectedImageFormat(originalBytes);
    if (!originalFormat || (expected !== originalFormat && !(expected === "heif" && originalFormat === "heic") && !(expected === "heic" && originalFormat === "heif"))) {
      throw new Error("The uploaded file is not the expected image type.");
    }
    const expectedDisplayFormat = derivativeFormatForKey(row.display_key);
    const expectedThumbnailFormat = derivativeFormatForKey(row.thumbnail_key);
    const displayFormat = detectedImageFormat(displayBytes);
    const thumbnailFormat = detectedImageFormat(thumbnailBytes);
    if (!expectedDisplayFormat || !expectedThumbnailFormat || displayFormat !== expectedDisplayFormat || thumbnailFormat !== expectedThumbnailFormat) {
      throw new Error("The optimized image files are invalid.");
    }
    const originalDimensions = inspectedImageDimensions(originalBytes, originalFormat);
    const displayDimensions = inspectedImageDimensions(displayBytes, displayFormat);
    const thumbnailDimensions = inspectedImageDimensions(thumbnailBytes, thumbnailFormat);
    const reportedDimensionsMatch = !originalDimensions
      || (originalDimensions.width === width && originalDimensions.height === height)
      || (originalDimensions.width === height && originalDimensions.height === width);
    if (!reportedDimensionsMatch) throw new Error("The uploaded image dimensions do not match the source.");
    if (!displayDimensions || Math.max(displayDimensions.width, displayDimensions.height) > 2048) {
      throw new Error("The viewer image has invalid dimensions.");
    }
    if (!thumbnailDimensions || Math.max(thumbnailDimensions.width, thumbnailDimensions.height) > 480) {
      throw new Error("The thumbnail image has invalid dimensions.");
    }
    const finalized = await db.prepare(`
      UPDATE todo_attachments
      SET width = ?, height = ?, byte_size = ?, upload_state = 'ready',
          expires_at = CASE WHEN todo_id IS NULL THEN expires_at ELSE NULL END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND upload_state = 'uploading' AND deleted_at IS NULL
        AND display_key = ? AND thumbnail_key = ?
        AND (todo_id IS NULL OR EXISTS (SELECT 1 FROM todos WHERE todos.id = todo_attachments.todo_id))
      RETURNING *
    `).bind(width, height, originalSize, id, row.display_key, row.thumbnail_key).first<AttachmentRow>();
    if (!finalized) {
      const current = await db.prepare("SELECT * FROM todo_attachments WHERE id = ?").bind(id).first<AttachmentRow>();
      if (current?.upload_state === "ready" && !current.deleted_at) return mapAttachment(current);
      throw new Error("The uploaded image could not be finalized; its preparation changed.");
    }
    console.info("[todo-attachments] direct upload finalized", {
      attachmentId: id,
      todoId,
      bytes: originalSize,
      displayBytes: displaySize,
      thumbnailBytes: thumbnailSize,
      displayFormat,
      thumbnailFormat,
      width,
      height,
      displayWidth: displayDimensions.width,
      displayHeight: displayDimensions.height,
      thumbnailWidth: thumbnailDimensions.width,
      thumbnailHeight: thumbnailDimensions.height,
      durationMs: Date.now() - startedAt,
    });
    return mapAttachment(finalized);
  } catch (error) {
    // An overlapping request may have committed this ID. Never delete its
    // objects on an uncertain failure; retry the same ID or let expiry clean it.
    console.error("[todo-attachments] direct upload finalize failed", { attachmentId: id, todoId, durationMs: Date.now() - startedAt, error });
    throw error;
  }
}

function detectedMediaFormat(bytes: Uint8Array) {
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  if (bytes.length >= 12 && ascii(4, 4) === "ftyp") return "mp4";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm";
  if (bytes.length >= 4 && ascii(0, 4) === "OggS") return "ogg";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "wav";
  if (bytes.length >= 3 && ascii(0, 3) === "ID3") return "mpeg";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "mpeg";
  return null;
}

export async function prepareTodoMediaAttachmentUpload(
  input: PrepareMediaUploadInput,
  target: UploadTarget,
) {
  const startedAt = Date.now();
  const byteSize = Number(input.byteSize);
  const kind = input.kind;
  const maximumBytes = kind === "audio" ? MAX_AUDIO_ATTACHMENT_BYTES : kind === "video" ? MAX_VIDEO_ATTACHMENT_BYTES : MAX_FILE_ATTACHMENT_BYTES;
  if (!Number.isInteger(byteSize) || byteSize < 1) throw new Error(`That ${kind} file is empty.`);
  if (byteSize > maximumBytes) throw new Error(kind === "audio" ? "Voice memos are limited to 50 MB." : kind === "video" ? "Videos are limited to 250 MB." : "Files are limited to 100 MB.");
  const fileName = cleanFileName(input.fileName || (kind === "audio" ? "voice memo" : kind === "video" ? "video" : "file"));
  const mimeType = kind === "audio" ? normalizedAudioMimeType(input.mimeType, fileName) : kind === "video" ? normalizedVideoMimeType(input.mimeType, fileName) : normalizedFileMimeType(input.mimeType, fileName);
  const db = database();
  const { isDraft, draftToken, todoId } = targetValues(target);
  if (todoId !== null) {
    const todo = await db.prepare("SELECT id FROM todos WHERE id = ?").bind(todoId).first<{ id: number }>();
    if (!todo) throw new Error("Task not found.");
  }
  const id = uploadIdentity(input.clientUploadId);
  const existing = input.clientUploadId ? await db.prepare("SELECT * FROM todo_attachments WHERE id = ?").bind(id).first<AttachmentRow>() : null;
  if (existing) validateUploadReplay(existing, target, fileName, mimeType, byteSize, kind);
  const count = todoId === null
    ? await db.prepare("SELECT COUNT(*) AS count FROM todo_attachments WHERE draft_token = ? AND deleted_at IS NULL").bind(draftToken).first<{ count: number }>()
    : await db.prepare("SELECT COUNT(*) AS count FROM todo_attachments WHERE todo_id = ? AND deleted_at IS NULL").bind(todoId).first<{ count: number }>();
  if (!existing && Number(count?.count ?? 0) >= MAX_ATTACHMENTS_PER_TASK) throw new Error(`Tasks are limited to ${MAX_ATTACHMENTS_PER_TASK} attachments.`);

  const extension = kind === "audio" ? audioExtension(mimeType) : kind === "video" ? videoExtension(mimeType) : attachmentFileExtension(fileName);
  // Keep every non-image object in the established media prefix. The private
  // Spaces credential is already exercised there by audio and video uploads;
  // a separate todo-files prefix caused browser-prepared file objects to be
  // rejected or become unreadable during finalization in production.
  const base = `todo-media/${id}`;
  const originalKey = `${base}/original.${extension}`;
  const displayKey = `${base}/no-display`;
  const thumbnailKey = `${base}/no-thumbnail`;
  const expiresAt = new Date(Date.now() + DRAFT_LIFETIME_HOURS * 60 * 60 * 1000).toISOString();
  try {
    const inserted = await db.prepare(`
      INSERT OR IGNORE INTO todo_attachments (
        id, todo_id, draft_token, original_key, display_key, thumbnail_key,
        file_name, mime_type, byte_size, width, height, kind, duration_ms,
        upload_state, sort_order, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, 'uploading', ?, ?)
      RETURNING *
    `).bind(
      id, todoId, draftToken, originalKey, displayKey, thumbnailKey,
      fileName, mimeType, byteSize, kind, Number(count?.count ?? 0), expiresAt,
    ).first<AttachmentRow>();
    const row = inserted ?? await db.prepare("SELECT * FROM todo_attachments WHERE id = ?").bind(id).first<AttachmentRow>();
    if (row) validateUploadReplay(row, target, fileName, mimeType, byteSize, kind);
    if (!row) throw new Error(`The ${kind} upload could not be prepared.`);
    const originalUpload = await signedPostTarget(originalKey, mimeType, maximumBytes);
    console.info("[todo-attachments] original attachment upload prepared", {
      attachmentId: id,
      todoId,
      draft: isDraft,
      kind,
      mimeType,
      bytes: byteSize,
      durationMs: Date.now() - startedAt,
    });
    return { uploadId: id, uploads: { original: originalUpload } };
  } catch (error) {
    if (!input.clientUploadId) await db.prepare("DELETE FROM todo_attachments WHERE id = ? AND upload_state = 'uploading'").bind(id).run().catch(() => undefined);
    console.error("[todo-attachments] original attachment upload preparation failed", { attachmentId: id, todoId, kind, bytes: byteSize, error });
    throw error;
  }
}

export async function finalizeTodoMediaAttachmentUpload(
  id: string,
  input: FinalizeMediaUploadInput,
  target: UploadTarget,
) {
  const startedAt = Date.now();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("That media upload is invalid.");
  const requestedDurationMs = Math.round(Number(input.durationMs));
  const db = database();
  const { draftToken, todoId } = targetValues(target);
  const row = todoId === null
    ? await db.prepare("SELECT * FROM todo_attachments WHERE id = ? AND draft_token = ? AND todo_id IS NULL AND deleted_at IS NULL").bind(id, draftToken).first<AttachmentRow>()
    : await db.prepare("SELECT * FROM todo_attachments WHERE id = ? AND todo_id = ? AND deleted_at IS NULL").bind(id, todoId).first<AttachmentRow>();
  if (!row || !(["audio", "video", "file"] as const).includes(row.kind as "audio" | "video" | "file")) throw new Error("That attachment upload is no longer available.");
  if (row.upload_state === "ready") return mapAttachment(row);
  const durationMs = row.kind === "file" ? 0 : requestedDurationMs;
  if (row.kind !== "file" && (!Number.isInteger(durationMs) || durationMs < 1)) throw new Error("The media duration could not be read.");
  const maximumBytes = row.kind === "audio" ? MAX_AUDIO_ATTACHMENT_BYTES : row.kind === "video" ? MAX_VIDEO_ATTACHMENT_BYTES : MAX_FILE_ATTACHMENT_BYTES;
  const maximumDuration = row.kind === "audio" ? MAX_AUDIO_DURATION_MS : MAX_VIDEO_DURATION_MS;
  if (row.kind !== "file" && durationMs > maximumDuration) throw new Error(row.kind === "audio" ? "Voice memos are limited to 30 minutes." : "Videos are limited to 60 minutes.");
  try {
    const { bytes, size: actualBytes } = await firstBytes(row.original_key);
    if (actualBytes < 1 || actualBytes > maximumBytes || actualBytes !== row.byte_size) throw new Error("The media upload is incomplete.");
    const actualFormat = row.kind === "file" ? detectAttachmentFileFormat(bytes) : detectedMediaFormat(bytes);
    const expectedFormat = row.kind === "audio" ? expectedAudioFormat(row.mime_type) : row.kind === "video" ? expectedVideoFormat(row.mime_type) : expectedFileFormat(row.file_name);
    if (!actualFormat || actualFormat !== expectedFormat) throw new Error(`The uploaded file is not the expected ${row.kind} type.`);
    const finalized = await db.prepare(`
      UPDATE todo_attachments
      SET duration_ms = ?, byte_size = ?, upload_state = 'ready',
          expires_at = CASE WHEN todo_id IS NULL THEN expires_at ELSE NULL END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND upload_state = 'uploading' AND deleted_at IS NULL
        AND (todo_id IS NULL OR EXISTS (SELECT 1 FROM todos WHERE todos.id = todo_attachments.todo_id))
      RETURNING *
    `).bind(durationMs, actualBytes, id).first<AttachmentRow>();
    if (!finalized) {
      const current = await db.prepare("SELECT * FROM todo_attachments WHERE id = ?").bind(id).first<AttachmentRow>();
      if (current?.upload_state === "ready" && !current.deleted_at) return mapAttachment(current);
      throw new Error("The media upload could not be finalized.");
    }
    console.info("[todo-attachments] original attachment upload finalized", {
      attachmentId: id,
      todoId,
      kind: row.kind,
      mimeType: row.mime_type,
      bytes: actualBytes,
      mediaDurationMs: durationMs,
      durationMs: Date.now() - startedAt,
    });
    return mapAttachment(finalized);
  } catch (error) {
    // An overlapping request may have committed this ID. Never delete its
    // objects on an uncertain failure; retry the same ID or let expiry clean it.
    console.error("[todo-attachments] original attachment upload finalize failed", {
      attachmentId: id,
      todoId,
      kind: row.kind,
      durationMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
      error,
    });
    throw error;
  }
}

type PreparedStorageTarget = StoragePostTarget;

function directAttachmentKind(input: DirectAttachmentUploadInput) {
  if (input.kind) return input.kind;
  const mimeType = input.mimeType.toLowerCase().split(";", 1)[0].trim();
  if (mimeType.startsWith("image/")) return "image" as const;
  if (mimeType.startsWith("audio/")) return "audio" as const;
  if (mimeType.startsWith("video/")) return "video" as const;
  return "file" as const;
}

function attachmentBlob(bytes: ArrayBuffer, mimeType: string) {
  return new Blob([bytes], { type: mimeType });
}

async function uploadPreparedStorageTarget(target: PreparedStorageTarget, body: Blob) {
  const response = await uploadStorageBlob(fetch,target,body);
  if (!response.ok) throw await storageResponseError("Private attachment upload", response);
}

async function optimizedImageBlob(source: Blob, width: number, quality: number) {
  const images = runtime().IMAGES;
  if (!images) throw new Error("Image processing is temporarily unavailable.");
  const output = await images
    .input(source.stream())
    .transform({ width, fit: "scale-down" })
    .output({ format: "image/webp", quality });
  const response = output.response();
  if (!response.ok) throw new Error("The image could not be optimized.");
  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength) throw new Error("The optimized image is empty.");
  return attachmentBlob(bytes, "image/webp");
}

/**
 * Agent-oriented single-request upload. The browser keeps using the presigned
 * prepare/upload/finalize flow so large payloads bypass the Worker, while API
 * clients can send one multipart file and let the server do every storage step.
 */
export async function uploadTodoAttachmentDirect(todoId: number, input: DirectAttachmentUploadInput) {
  const startedAt = Date.now();
  const kind = directAttachmentKind(input);
  const fileName = cleanFileName(input.fileName);
  const byteSize = input.file.size;
  console.info("[todo-attachments] direct API upload requested", {
    todoId,
    kind,
    bytes: byteSize,
    suppliedMimeType: input.mimeType.toLowerCase().split(";", 1)[0],
  });

  let phase: AttachmentPhase = "identity";
  try {
    if (!await database().prepare("SELECT id FROM todos WHERE id = ?").bind(todoId).first()) throw new Error("Task not found.");
    if (input.clientUploadId) {
      const id = uploadIdentity(input.clientUploadId);
      const existing = await database().prepare("SELECT * FROM todo_attachments WHERE id = ?").bind(id).first<AttachmentRow>();
      if (existing) {
        const mime = kind === "image" ? normalizedMimeType(input.mimeType, fileName) : kind === "audio" ? normalizedAudioMimeType(input.mimeType, fileName) : kind === "video" ? normalizedVideoMimeType(input.mimeType, fileName) : normalizedFileMimeType(input.mimeType, fileName);
        validateUploadReplay(existing, { todoId }, fileName, mime, byteSize, kind);
        if (existing.upload_state === "ready") return mapAttachment(existing);
      }
    }

    if (kind === "image") {
      if (byteSize < 1) throw new Error("That image is empty.");
      if (byteSize > MAX_ATTACHMENT_BYTES) throw new Error("Images are limited to 20 MB each.");
      const mimeType = normalizedMimeType(input.mimeType, fileName);
      const source = input.file.type === mimeType ? input.file : new Blob([input.file], { type: mimeType });
      phase = "image-binding";
      const images = runtime().IMAGES;
      if (!imageProcessingAvailable()) throw Object.assign(new Error("Image processing is temporarily unavailable."), { code: "image-processing-unavailable" });
      phase = "image-info";
      const info = await images.info(source.stream());
      if (!("width" in info) || !Number.isInteger(info.width) || !Number.isInteger(info.height) || info.width < 1 || info.height < 1 || info.width * info.height > MAX_IMAGE_PIXELS) {
        throw new Error("That image is too large to process.");
      }
      const expectedFormat = normalizedFormat(mimeType);
      const inspectedFormat = normalizedFormat(info.format);
      if (expectedFormat !== inspectedFormat && !(expectedFormat === "heif" && inspectedFormat === "heic") && !(expectedFormat === "heic" && inspectedFormat === "heif")) {
        throw new Error("The uploaded file is not the expected image type.");
      }
      phase = "image-transform";
      const [display, thumbnail] = await Promise.all([
        optimizedImageBlob(source, 2048, 82),
        optimizedImageBlob(source, 480, 75),
      ]);
      phase = "prepare";
      const prepared = await prepareTodoAttachmentUpload({
        clientUploadId: input.clientUploadId,
        fileName,
        mimeType,
        byteSize,
        displayMimeType: "image/webp",
        thumbnailMimeType: "image/webp",
      }, { todoId });
      if (prepared.attachment) return prepared.attachment;
      try {
        phase = "storage";
        await Promise.all([
          uploadPreparedStorageTarget(prepared.uploads.original, source),
          uploadPreparedStorageTarget(prepared.uploads.display, display),
          uploadPreparedStorageTarget(prepared.uploads.thumbnail, thumbnail),
        ]);
        phase = "finalize";
        const attachment = await finalizeTodoAttachmentUpload(prepared.uploadId, {
          width: info.width,
          height: info.height,
        }, { todoId });
        console.info("[todo-attachments] direct API upload completed", {
          todoId,
          attachmentId: attachment.id,
          kind,
          bytes: byteSize,
          displayBytes: display.size,
          thumbnailBytes: thumbnail.size,
          width: info.width,
          height: info.height,
          durationMs: Date.now() - startedAt,
        });
        return attachment;
      } catch (error) {
        await (!input.clientUploadId ? discardTodoAttachmentUpload(todoId, prepared.uploadId) : Promise.resolve()).catch((cleanupError) => {
          console.error("[todo-attachments] direct API image cleanup failed", { todoId, attachmentId: prepared.uploadId, cleanupError });
        });
        console.error("[todo-attachments] direct API upload failed", { todoId, attachmentId: prepared.uploadId, kind, bytes: byteSize, durationMs: Date.now() - startedAt, error });
        throw error;
      }
    }

    phase = "prepare";
    const prepared = await prepareTodoMediaAttachmentUpload({
      clientUploadId: input.clientUploadId,
      kind,
      fileName,
      mimeType: input.mimeType,
      byteSize,
    }, { todoId });
    try {
      const normalizedMime = kind === "audio" ? normalizedAudioMimeType(input.mimeType, fileName)
        : kind === "video" ? normalizedVideoMimeType(input.mimeType, fileName)
          : normalizedFileMimeType(input.mimeType, fileName);
      const source = input.file.type === normalizedMime ? input.file : new Blob([input.file], { type: normalizedMime });
      phase = "storage";
      await uploadPreparedStorageTarget(prepared.uploads.original, source);
      phase = "finalize";
      const attachment = await finalizeTodoMediaAttachmentUpload(prepared.uploadId, {
        durationMs: kind === "file" ? 0 : Number(input.durationMs),
      }, { todoId });
      console.info("[todo-attachments] direct API upload completed", {
        todoId,
        attachmentId: attachment.id,
        kind,
        bytes: byteSize,
        mediaDurationMs: attachment.durationMs,
        durationMs: Date.now() - startedAt,
      });
      return attachment;
    } catch (error) {
      await (!input.clientUploadId ? discardTodoAttachmentUpload(todoId, prepared.uploadId) : Promise.resolve()).catch((cleanupError) => {
        console.error("[todo-attachments] direct API attachment cleanup failed", { todoId, attachmentId: prepared.uploadId, kind, cleanupError });
      });
      console.error("[todo-attachments] direct API upload failed", { todoId, attachmentId: prepared.uploadId, kind, bytes: byteSize, durationMs: Date.now() - startedAt, error });
      throw error;
    }
  } catch (error) {
    const tagged = error instanceof Error ? Object.assign(error, { attachmentPhase: phase }) : Object.assign(new Error("Attachment service failed."), { attachmentPhase: phase });
    console.error("[todo-attachments] direct upload phase failed", {
      ...attachmentErrorDetails(tagged), kind, bytes: byteSize,
      imageBindingAvailable: imageProcessingAvailable(), durationMs: Date.now() - startedAt,
    });
    throw tagged;
  }
}

export async function listTodoAttachments(todoId: number) {
  const result = await database().prepare(`
    SELECT * FROM todo_attachments
    WHERE todo_id = ? AND upload_state = 'ready' AND deleted_at IS NULL
    ORDER BY sort_order ASC, created_at ASC
  `).bind(todoId).all<AttachmentRow>();
  return Promise.all(result.results.map(mapAttachment));
}

export async function deleteDraftAttachment(id: string, draftToken: string) {
  validateDraftToken(draftToken);
  const db = database();
  const row = await db.prepare(`
    SELECT * FROM todo_attachments
    WHERE id = ? AND draft_token = ? AND todo_id IS NULL AND deleted_at IS NULL
  `).bind(id, draftToken).first<AttachmentRow>();
  if (!row) return false;
  await deleteKeys(attachmentObjectKeys(row));
  await db.prepare("DELETE FROM todo_attachments WHERE id = ?").bind(id).run();
  console.info("[todo-attachments] draft removed", { attachmentId: id });
  return true;
}

export async function discardTodoAttachmentUpload(todoId: number, id: string) {
  uploadIdentity(id);
  const db = database();
  // Reserve cancellation even before a slow multipart request has inserted its
  // row. INSERT OR IGNORE never changes a ready attachment or another target.
  const key = `todo-media/${id}/cancelled`;
  await db.prepare(`
    INSERT OR IGNORE INTO todo_attachments (
      id, todo_id, original_key, display_key, thumbnail_key, file_name, mime_type,
      byte_size, width, height, kind, upload_state, deleted_at
    ) VALUES (?, ?, ?, ?, ?, 'cancelled', 'application/octet-stream', 0, 0, 0, 'file', 'uploading', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).bind(id, todoId, `${key}/original`, `${key}/display`, `${key}/thumbnail`).run();
  // Persist the tombstone before touching storage. A late finalize cannot turn
  // it ready and a late prepare cannot reuse the same stable identity.
  const row = await db.prepare(`
    UPDATE todo_attachments SET deleted_at = COALESCE(deleted_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND todo_id = ? AND upload_state = 'uploading'
    RETURNING *
  `).bind(id, todoId).first<AttachmentRow>();
  if (!row) return false;
  await deleteKeys(attachmentObjectKeys(row));
  console.info("[todo-attachments] incomplete task upload discarded", { attachmentId: id, todoId });
  return true;
}

export async function deleteTodoAttachment(todoId: number, id: string) {
  const db = database();
  const row = await db.prepare(`
    SELECT * FROM todo_attachments
    WHERE id = ? AND todo_id = ? AND upload_state = 'ready' AND deleted_at IS NULL
  `).bind(id, todoId).first<AttachmentRow>();
  if (!row) return null;
  const undoToken = crypto.randomUUID();
  await db.batch([
    db.prepare("DELETE FROM todo_action_history WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')"),
    db.prepare("INSERT INTO todo_action_history (id, snapshot) VALUES (?, ?)")
      .bind(undoToken, JSON.stringify({ todos: [], attachments: [row] })),
    db.prepare("UPDATE todo_attachments SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").bind(id),
  ]);
  console.info("[todo-attachments] soft deleted", { attachmentId: id, todoId, undoToken });
  return { attachmentId: id, undoToken };
}

export async function claimDraftAttachments(todoId: number, draftToken: string | undefined, inputIds: string[] | undefined) {
  const ids = [...new Set((inputIds ?? []).filter((id) => /^[0-9a-f-]{36}$/i.test(id)))];
  if (!ids.length) return 0;
  if (ids.length > MAX_ATTACHMENTS_PER_TASK) throw new Error(`Tasks are limited to ${MAX_ATTACHMENTS_PER_TASK} attachments.`);
  const token = validateDraftToken(draftToken ?? "");
  const db = database();
  const placeholders = ids.map(() => "?").join(", ");
  const available = await db.prepare(`
    SELECT id, todo_id FROM todo_attachments
    WHERE id IN (${placeholders}) AND upload_state = 'ready' AND deleted_at IS NULL
      AND (todo_id = ? OR (draft_token = ? AND todo_id IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')))
  `).bind(...ids, todoId, token).all<{ id: string; todo_id: number | null }>();
  if (available.results.length !== ids.length) throw new Error("One or more attachments are no longer available.");
  const unclaimed = available.results.filter((row) => row.todo_id === null);
  if (!unclaimed.length) return ids.length;
  const count = await db.prepare("SELECT COUNT(*) AS count FROM todo_attachments WHERE todo_id = ? AND deleted_at IS NULL").bind(todoId).first<{ count: number }>();
  if (Number(count?.count ?? 0) + unclaimed.length > MAX_ATTACHMENTS_PER_TASK) throw new Error(`Tasks are limited to ${MAX_ATTACHMENTS_PER_TASK} attachments.`);
  await db.batch(unclaimed.map((row, index) => db.prepare(`
    UPDATE todo_attachments SET todo_id = ?, draft_token = NULL, expires_at = NULL, sort_order = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND draft_token = ? AND todo_id IS NULL AND upload_state = 'ready' AND deleted_at IS NULL
  `).bind(todoId, Number(count?.count ?? 0) + index, row.id, token)));
  const linked = await db.prepare(`SELECT COUNT(*) AS count FROM todo_attachments WHERE id IN (${placeholders}) AND todo_id = ? AND deleted_at IS NULL`).bind(...ids, todoId).first<{ count: number }>();
  if (Number(linked?.count ?? 0) !== ids.length) throw new Error("The attachments could not be linked to the task.");
  return ids.length;
}

export async function attachmentSnapshotsForTodos(todoIds: number[], includeUploading = false) {
  if (!todoIds.length) return [];
  const placeholders = todoIds.map(() => "?").join(", ");
  const result = await database().prepare(`
    SELECT * FROM todo_attachments
    WHERE todo_id IN (${placeholders}) AND ${includeUploading ? "1 = 1" : "upload_state = 'ready'"} AND deleted_at IS NULL
    ORDER BY todo_id, sort_order, created_at
  `).bind(...todoIds).all<AttachmentRow>();
  return result.results;
}

export function restoreAttachmentStatements(db: D1Database, rows: AttachmentRow[]) {
  const restore = db.prepare(`
    INSERT INTO todo_attachments (
      id, todo_id, draft_token, original_key, display_key, thumbnail_key,
      file_name, mime_type, byte_size, width, height, kind, duration_ms,
      upload_state, sort_order, expires_at, deleted_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      todo_id = excluded.todo_id,
      draft_token = excluded.draft_token,
      kind = excluded.kind,
      duration_ms = CASE WHEN todo_attachments.upload_state = 'ready' THEN todo_attachments.duration_ms ELSE excluded.duration_ms END,
      upload_state = CASE WHEN todo_attachments.upload_state = 'ready' THEN 'ready' ELSE excluded.upload_state END,
      sort_order = excluded.sort_order,
      expires_at = CASE WHEN todo_attachments.upload_state = 'ready' AND excluded.todo_id IS NOT NULL THEN NULL ELSE excluded.expires_at END,
      deleted_at = excluded.deleted_at,
      updated_at = excluded.updated_at
  `);
  return rows.map((row) => restore.bind(
    row.id,
    row.todo_id,
    row.draft_token,
    row.original_key,
    row.display_key,
    row.thumbnail_key,
    row.file_name,
    row.mime_type,
    row.byte_size,
    row.width,
    row.height,
    row.kind ?? "image",
    row.duration_ms ?? 0,
    row.upload_state ?? "ready",
    row.sort_order,
    row.expires_at,
    row.deleted_at,
    row.created_at,
    row.updated_at,
  ));
}

async function cleanupExpiredAttachments() {
  const db = database();
  const result = await db.prepare(`
    SELECT * FROM todo_attachments
    WHERE (expires_at IS NOT NULL AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
           AND (todo_id IS NULL OR upload_state = 'uploading'))
       OR (deleted_at IS NOT NULL AND deleted_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-${DELETED_RETENTION_DAYS} days'))
    ORDER BY COALESCE(deleted_at, expires_at) ASC
    LIMIT 100
  `).all<AttachmentRow>();
  let removed = 0;
  for (const row of result.results) {
    try {
      await deleteKeys(attachmentObjectKeys(row));
      await db.prepare("DELETE FROM todo_attachments WHERE id = ?").bind(row.id).run();
      removed += 1;
    } catch (error) {
      console.error("[todo-attachments] cleanup item failed", { attachmentId: row.id, error });
    }
  }
  console.info("[todo-attachments] cleanup finished", { found: result.results.length, removed });
}

export async function scheduleAttachmentCleanup() {
  if (Date.now() < nextCleanupCheckAt) return;
  nextCleanupCheckAt = Date.now() + CLEANUP_CHECK_INTERVAL_MS;
  const db = database();
  const now = new Date();
  const cutoff = new Date(now.valueOf() - 24 * 60 * 60 * 1000).toISOString();
  const guard = await db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('attachment_cleanup_at', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    WHERE app_settings.value <= ?
  `).bind(now.toISOString(), cutoff).run();
  if (!Number(guard.meta.changes ?? 0)) return;
  console.info("[todo-attachments] cleanup lease acquired", {
    cutoff,
    nextIsolateCheckAt: new Date(nextCleanupCheckAt).toISOString(),
  });
  waitUntil(() => cleanupExpiredAttachments().catch((error) => {
    console.error("[todo-attachments] cleanup failed", error);
  }));
}

/** Reconcile an uncertain response without retransmitting bytes or issuing signed URLs. */
export async function inspectAttachmentRecovery(todoId: number, ids: string[], draftToken?: string): Promise<AttachmentRecovery> {
  const db = database();
  const target = await db.prepare("SELECT id FROM todos WHERE id = ?").bind(todoId).first();
  const files: AttachmentRecovery["files"] = [];
  for (const id of [...new Set(ids)]) {
    const row = await db.prepare("SELECT * FROM todo_attachments WHERE id = ?").bind(id).first<AttachmentRow>();
    if (!row) { files.push({ id, state: "missing", todoId: null }); continue; }
    if (row.deleted_at) { files.push({ id, state: "deleted", todoId: row.todo_id }); continue; }
    if (row.todo_id === null) {
      const validDraft = Boolean(draftToken && row.draft_token === draftToken && row.expires_at && Date.parse(row.expires_at) > Date.now());
      files.push({ id, state: validDraft ? row.upload_state === "ready" ? "draft" : "uploading" : "missing", todoId: null });
    } else {
      files.push({ id, state: row.upload_state, todoId: row.todo_id });
    }
  }
  return { targetExists: Boolean(target), files };
}

export function imageProcessingAvailable() {
  return typeof runtime().IMAGES?.info === "function" && typeof runtime().IMAGES?.input === "function";
}

/** Bounded read-only support probe for an existing task upload. No object data is returned. */
export async function inspectTaskUploadStorage(todoId: number, id: string) {
  const row = await database().prepare("SELECT * FROM todo_attachments WHERE id = ? AND todo_id = ? AND deleted_at IS NULL AND upload_state = 'uploading'").bind(id, todoId).first<AttachmentRow>();
  if (!row) return null;
  const slots = row.kind === "image" ? [["original", row.original_key], ["display", row.display_key], ["thumbnail", row.thumbnail_key]] : [["original", row.original_key]];
  return Promise.all(slots.map(async ([slot, key]) => {
    const response = await storage().signedStorageResponse(storageUrl(key), { headers: { Range: "bytes=0-" }, signal: AbortSignal.timeout(10000) });
    const prefix = await storageResponseMetadata(response);
    if (!response.ok) return { slot, bytes: null, prefix };
    const object = await readStoragePrefix(response);
    const format = row.kind === "image" ? detectedImageFormat(object.bytes) : null;
    const dimensions = format ? inspectedImageDimensions(object.bytes, format) : null;
    return { slot, bytes: object.size, prefix, dimensions };
  }));
}

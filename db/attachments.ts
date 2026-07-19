import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env, waitUntil } from "cloudflare:workers";

export const MAX_ATTACHMENTS_PER_TASK = 12;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100_000_000;
const DRAFT_LIFETIME_HOURS = 24;
const DELETED_RETENTION_DAYS = 7;
const SIGNED_URL_SECONDS = 60 * 60;

type ImageInfo = {
  format: string;
  fileSize: number;
  width: number;
  height: number;
};

type RuntimeEnv = {
  DB: D1Database;
  S3_ACCESS_KEY: string;
  S3_ACCESS_KEY_ID: string;
  S3_BUCKET: string;
  S3_CDN_URL: string;
  S3_ENDPOINT_URL: string;
  IMAGES: {
    info(stream: ReadableStream): Promise<ImageInfo>;
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number; anim?: boolean }): Promise<{ response(): Response }>;
      };
    };
  };
};

let cachedStorageConfig: { bucket: string; cdnHost: string | null; client: S3Client } | null = null;

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
  sortOrder: number;
  thumbnailUrl: string;
  displayUrl: string;
  originalUrl: string;
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

function storageConfig() {
  if (cachedStorageConfig) return cachedStorageConfig;
  const current = runtime();
  const missing = [
    "S3_ACCESS_KEY",
    "S3_ACCESS_KEY_ID",
    "S3_BUCKET",
    "S3_ENDPOINT_URL",
  ].filter((key) => !current[key as keyof RuntimeEnv]);
  if (missing.length) throw new Error(`Image storage is missing ${missing.join(", ")}.`);
  const endpoint = /^https?:\/\//i.test(current.S3_ENDPOINT_URL)
    ? current.S3_ENDPOINT_URL
    : `https://${current.S3_ENDPOINT_URL}`;
  cachedStorageConfig = {
    bucket: current.S3_BUCKET,
    cdnHost: current.S3_CDN_URL?.replace(/^https?:\/\//i, "").replace(/\/$/, "") || null,
    client: new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: false,
      credentials: {
        accessKeyId: current.S3_ACCESS_KEY_ID,
        secretAccessKey: current.S3_ACCESS_KEY,
      },
    }),
  };
  return cachedStorageConfig;
}

function streamFor(bytes: Uint8Array) {
  return new Blob([bytes.slice().buffer as ArrayBuffer]).stream();
}

function normalizedFormat(value: string) {
  const format = value.toLowerCase().replace(/^image\//, "");
  if (format === "jpg") return "jpeg";
  return format;
}

function mimeForFormat(format: string) {
  const normalized = normalizedFormat(format);
  if (normalized === "jpeg") return "image/jpeg";
  if (normalized === "heic") return "image/heic";
  if (normalized === "heif") return "image/heif";
  return `image/${normalized}`;
}

function extensionForFormat(format: string) {
  const normalized = normalizedFormat(format);
  return normalized === "jpeg" ? "jpg" : normalized;
}

function cleanFileName(value: string) {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (cleaned || "image").slice(0, 180);
}

function validateDraftToken(value: string) {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error("That image draft is invalid.");
  return value;
}

async function transform(bytes: Uint8Array, width: number, quality: number) {
  const result = await runtime().IMAGES
    .input(streamFor(bytes))
    .transform({ width, height: width, fit: "scale-down" })
    .output({ format: "image/webp", quality, anim: false });
  return new Uint8Array(await result.response().arrayBuffer());
}

async function deleteKeys(keys: string[]) {
  if (!keys.length) return;
  const { bucket, client } = storageConfig();
  await client.send(new DeleteObjectsCommand({
    Bucket: bucket,
    Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
  }));
}

async function signedObjectUrl(key: string, downloadName?: string) {
  const { bucket, cdnHost, client } = storageConfig();
  const signed = await getSignedUrl(client, new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(downloadName
      ? { ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}` }
      : {}),
  }), { expiresIn: SIGNED_URL_SECONDS });
  if (!cdnHost) return signed;
  const url = new URL(signed);
  url.hostname = cdnHost.startsWith(`${bucket}.`) ? cdnHost : `${bucket}.${cdnHost}`;
  return url.toString();
}

async function mapAttachment(row: AttachmentRow): Promise<TodoAttachment> {
  const [thumbnailUrl, displayUrl, originalUrl] = await Promise.all([
    signedObjectUrl(row.thumbnail_key),
    signedObjectUrl(row.display_key),
    signedObjectUrl(row.original_key, row.file_name),
  ]);
  return {
    id: row.id,
    todoId: row.todo_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    sortOrder: row.sort_order,
    thumbnailUrl,
    displayUrl,
    originalUrl,
    createdAt: row.created_at,
  };
}

export async function uploadTodoAttachment(
  file: File,
  target: { todoId: number } | { draftToken: string },
) {
  const startedAt = Date.now();
  if (!(file instanceof File)) throw new Error("Choose an image to upload.");
  if (file.size < 1) throw new Error("That image is empty.");
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error("Images are limited to 20 MB each.");
  const db = database();
  const isDraft = "draftToken" in target;
  const draftToken = isDraft ? validateDraftToken(target.draftToken) : null;
  const todoId = isDraft ? null : target.todoId;
  if (todoId !== null) {
    const todo = await db.prepare("SELECT id FROM todos WHERE id = ?").bind(todoId).first<{ id: number }>();
    if (!todo) throw new Error("Task not found.");
  }
  const count = todoId === null
    ? await db.prepare("SELECT COUNT(*) AS count FROM todo_attachments WHERE draft_token = ? AND deleted_at IS NULL").bind(draftToken).first<{ count: number }>()
    : await db.prepare("SELECT COUNT(*) AS count FROM todo_attachments WHERE todo_id = ? AND deleted_at IS NULL").bind(todoId).first<{ count: number }>();
  if (Number(count?.count ?? 0) >= MAX_ATTACHMENTS_PER_TASK) {
    throw new Error(`Tasks are limited to ${MAX_ATTACHMENTS_PER_TASK} images.`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = await runtime().IMAGES.info(streamFor(bytes));
  const format = normalizedFormat(info.format);
  const allowed = new Set(["jpeg", "png", "webp", "gif", "heic", "heif"]);
  if (!allowed.has(format)) throw new Error("Use a JPEG, PNG, WebP, GIF, HEIC, or HEIF image.");
  if (!Number.isFinite(info.width) || !Number.isFinite(info.height) || info.width * info.height > MAX_IMAGE_PIXELS) {
    throw new Error("That image is too large to process.");
  }

  const [display, thumbnail] = await Promise.all([
    transform(bytes, 2048, 82),
    transform(bytes, 480, 75),
  ]);
  const id = crypto.randomUUID();
  const base = `todo-images/${id}`;
  const originalKey = `${base}/original.${extensionForFormat(format)}`;
  const displayKey = `${base}/display.webp`;
  const thumbnailKey = `${base}/thumb.webp`;
  const keys = [originalKey, displayKey, thumbnailKey];
  const { bucket, client } = storageConfig();
  try {
    await Promise.all([
      client.send(new PutObjectCommand({ Bucket: bucket, Key: originalKey, Body: bytes, ContentType: mimeForFormat(format) })),
      client.send(new PutObjectCommand({ Bucket: bucket, Key: displayKey, Body: display, ContentType: "image/webp" })),
      client.send(new PutObjectCommand({ Bucket: bucket, Key: thumbnailKey, Body: thumbnail, ContentType: "image/webp" })),
    ]);
    const nextOrder = Number(count?.count ?? 0);
    const expiresAt = isDraft ? new Date(Date.now() + DRAFT_LIFETIME_HOURS * 60 * 60 * 1000).toISOString() : null;
    const row = await db.prepare(`
      INSERT INTO todo_attachments (
        id, todo_id, draft_token, original_key, display_key, thumbnail_key,
        file_name, mime_type, byte_size, width, height, sort_order, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).bind(
      id,
      todoId,
      draftToken,
      originalKey,
      displayKey,
      thumbnailKey,
      cleanFileName(file.name),
      mimeForFormat(format),
      file.size,
      info.width,
      info.height,
      nextOrder,
      expiresAt,
    ).first<AttachmentRow>();
    if (!row) throw new Error("The uploaded image could not be saved.");
    console.info("[todo-attachments] uploaded", {
      attachmentId: id,
      todoId,
      draft: isDraft,
      bytes: file.size,
      width: info.width,
      height: info.height,
      format,
      durationMs: Date.now() - startedAt,
    });
    return mapAttachment(row);
  } catch (error) {
    try {
      await deleteKeys(keys);
    } catch (cleanupError) {
      console.error("[todo-attachments] partial upload cleanup failed", { attachmentId: id, cleanupError });
    }
    console.error("[todo-attachments] upload failed", {
      attachmentId: id,
      todoId,
      draft: isDraft,
      bytes: file.size,
      durationMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }
}

export async function listTodoAttachments(todoId: number) {
  const result = await database().prepare(`
    SELECT * FROM todo_attachments
    WHERE todo_id = ? AND deleted_at IS NULL
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
  await deleteKeys([row.original_key, row.display_key, row.thumbnail_key]);
  await db.prepare("DELETE FROM todo_attachments WHERE id = ?").bind(id).run();
  console.info("[todo-attachments] draft removed", { attachmentId: id });
  return true;
}

export async function deleteTodoAttachment(todoId: number, id: string) {
  const db = database();
  const row = await db.prepare(`
    SELECT * FROM todo_attachments
    WHERE id = ? AND todo_id = ? AND deleted_at IS NULL
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
  if (ids.length > MAX_ATTACHMENTS_PER_TASK) throw new Error(`Tasks are limited to ${MAX_ATTACHMENTS_PER_TASK} images.`);
  const token = validateDraftToken(draftToken ?? "");
  const db = database();
  const placeholders = ids.map(() => "?").join(", ");
  const result = await db.prepare(`
    SELECT id FROM todo_attachments
    WHERE id IN (${placeholders}) AND draft_token = ? AND todo_id IS NULL
      AND deleted_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).bind(...ids, token).all<{ id: string }>();
  if (result.results.length !== ids.length) throw new Error("One or more attached images are no longer available.");
  const statements = ids.map((id, sortOrder) => db.prepare(`
    UPDATE todo_attachments
    SET todo_id = ?, draft_token = NULL, expires_at = NULL, sort_order = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND draft_token = ? AND todo_id IS NULL AND deleted_at IS NULL
  `).bind(todoId, sortOrder, id, token));
  const updates = await db.batch(statements);
  if (updates.some((update) => Number(update.meta.changes ?? 0) !== 1)) {
    await db.batch(ids.map((id, sortOrder) => db.prepare(`
      UPDATE todo_attachments
      SET todo_id = NULL, draft_token = ?, expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','+24 hours'), sort_order = ?
      WHERE id = ? AND todo_id = ?
    `).bind(token, sortOrder, id, todoId)));
    throw new Error("The attached images could not be linked to the task.");
  }
  console.info("[todo-attachments] draft claimed", { todoId, attachmentIds: ids, count: ids.length });
  return ids.length;
}

export async function attachmentSnapshotsForTodos(todoIds: number[]) {
  if (!todoIds.length) return [];
  const placeholders = todoIds.map(() => "?").join(", ");
  const result = await database().prepare(`
    SELECT * FROM todo_attachments
    WHERE todo_id IN (${placeholders}) AND deleted_at IS NULL
    ORDER BY todo_id, sort_order, created_at
  `).bind(...todoIds).all<AttachmentRow>();
  return result.results;
}

export function restoreAttachmentStatements(db: D1Database, rows: AttachmentRow[]) {
  const restore = db.prepare(`
    INSERT INTO todo_attachments (
      id, todo_id, draft_token, original_key, display_key, thumbnail_key,
      file_name, mime_type, byte_size, width, height, sort_order,
      expires_at, deleted_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      todo_id = excluded.todo_id,
      draft_token = excluded.draft_token,
      sort_order = excluded.sort_order,
      expires_at = excluded.expires_at,
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
    WHERE (todo_id IS NULL AND expires_at IS NOT NULL AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       OR (deleted_at IS NOT NULL AND deleted_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-${DELETED_RETENTION_DAYS} days'))
    ORDER BY COALESCE(deleted_at, expires_at) ASC
    LIMIT 100
  `).all<AttachmentRow>();
  let removed = 0;
  for (const row of result.results) {
    try {
      await deleteKeys([row.original_key, row.display_key, row.thumbnail_key]);
      await db.prepare("DELETE FROM todo_attachments WHERE id = ?").bind(row.id).run();
      removed += 1;
    } catch (error) {
      console.error("[todo-attachments] cleanup item failed", { attachmentId: row.id, error });
    }
  }
  console.info("[todo-attachments] cleanup finished", { found: result.results.length, removed });
}

export async function scheduleAttachmentCleanup() {
  const db = database();
  const setting = await db.prepare("SELECT value FROM app_settings WHERE key = 'attachment_cleanup_at'").first<{ value: string }>();
  const lastRun = setting?.value ? new Date(setting.value).valueOf() : 0;
  if (Number.isFinite(lastRun) && Date.now() - lastRun < 24 * 60 * 60 * 1000) return;
  await db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('attachment_cleanup_at', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(new Date().toISOString()).run();
  waitUntil(cleanupExpiredAttachments().catch((error) => {
    console.error("[todo-attachments] cleanup failed", error);
  }));
}

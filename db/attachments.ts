import { AwsClient } from "aws4fetch";
import { env, waitUntil } from "cloudflare:workers";

export const MAX_ATTACHMENTS_PER_TASK = 12;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100_000_000;
const DRAFT_LIFETIME_HOURS = 24;
const DELETED_RETENTION_DAYS = 7;
const SIGNED_URL_SECONDS = 60 * 60;

type RuntimeEnv = {
  DB: D1Database;
  S3_ACCESS_KEY: string;
  S3_ACCESS_KEY_ID: string;
  S3_BUCKET: string;
  S3_ENDPOINT_URL: string;
};

type StorageConfig = { bucket: string; endpoint: URL; client: AwsClient };
type CorsRule = {
  ID?: string;
  AllowedHeaders?: string[];
  AllowedMethods: string[];
  AllowedOrigins: string[];
  ExposeHeaders?: string[];
  MaxAgeSeconds?: number;
};

let cachedStorageConfig: StorageConfig | null = null;
let uploadCorsReady: Promise<void> | null = null;

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
  const endpointValue = /^https?:\/\//i.test(current.S3_ENDPOINT_URL)
    ? current.S3_ENDPOINT_URL
    : `https://${current.S3_ENDPOINT_URL}`;
  const endpointUrl = new URL(endpointValue);
  const bucketPrefix = `${current.S3_BUCKET}.`;
  if (endpointUrl.hostname.startsWith(bucketPrefix)) endpointUrl.hostname = endpointUrl.hostname.slice(bucketPrefix.length);
  endpointUrl.pathname = "/";
  endpointUrl.search = "";
  endpointUrl.hash = "";
  const endpointRegion = endpointUrl.hostname.endsWith(".digitaloceanspaces.com")
    ? endpointUrl.hostname.split(".")[0]
    : "us-east-1";
  cachedStorageConfig = {
    bucket: current.S3_BUCKET,
    endpoint: endpointUrl,
    client: new AwsClient({
      service: "s3",
      region: endpointRegion,
      retries: 2,
      accessKeyId: current.S3_ACCESS_KEY_ID,
      secretAccessKey: current.S3_ACCESS_KEY,
    }),
  };
  console.info("[todo-attachments] private storage configured", { region: endpointRegion, virtualHosted: true });
  return cachedStorageConfig;
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
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error("That image draft is invalid.");
  return value;
}

function storageUrl(key?: string, query?: Record<string, string>) {
  const { bucket, endpoint } = storageConfig();
  const url = new URL(endpoint);
  url.hostname = `${bucket}.${url.hostname}`;
  url.pathname = key ? `/${key.split("/").map(encodeURIComponent).join("/")}` : "/";
  Object.entries(query ?? {}).forEach(([name, value]) => url.searchParams.set(name, value));
  return url;
}

async function storageFetch(url: URL, init?: RequestInit) {
  const response = await storageConfig().client.fetch(url, init);
  if (!response.ok) throw await storageResponseError("Private image storage", response);
  return response;
}

async function storageResponseError(stage: string, response: Response) {
  const body = await response.text().catch(() => "");
  const code = body.match(/<Code>([^<]+)<\/Code>/i)?.[1] ?? null;
  console.error("[todo-attachments] storage request failed", {
    stage,
    status: response.status,
    code,
    requestId: response.headers.get("x-amz-request-id"),
  });
  return new Error(`${stage} returned ${response.status}${code ? ` (${code})` : ""}.`);
}

async function deleteKeys(keys: string[]) {
  await Promise.all(keys.map(async (key) => {
    const response = await storageConfig().client.fetch(storageUrl(key), { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw await storageResponseError("Private image cleanup", response);
  }));
}

async function signedObjectUrl(key: string, downloadName?: string) {
  const url = storageUrl(key, {
    "X-Amz-Expires": String(SIGNED_URL_SECONDS),
    ...(downloadName ? { "response-content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}` } : {}),
  });
  const signed = await storageConfig().client.sign(url, { method: "GET", aws: { signQuery: true } });
  return signed.url;
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

type UploadTarget = { todoId: number } | { draftToken: string };

type PrepareUploadInput = {
  fileName: string;
  mimeType: string;
  byteSize: number;
};

type FinalizeUploadInput = {
  width: number;
  height: number;
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

function xmlText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function decodedXmlText(value: string) {
  return value.replaceAll("&apos;", "'").replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

function xmlValues(block: string, tag: string) {
  return [...block.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "gi"))]
    .map((match) => decodedXmlText(match[1].trim()));
}

function parseCorsRules(xml: string): CorsRule[] {
  return [...xml.matchAll(/<CORSRule>([\s\S]*?)<\/CORSRule>/gi)].map((match) => {
    const block = match[1];
    const maxAge = Number(xmlValues(block, "MaxAgeSeconds")[0]);
    return {
      ID: xmlValues(block, "ID")[0],
      AllowedHeaders: xmlValues(block, "AllowedHeader"),
      AllowedMethods: xmlValues(block, "AllowedMethod"),
      AllowedOrigins: xmlValues(block, "AllowedOrigin"),
      ExposeHeaders: xmlValues(block, "ExposeHeader"),
      ...(Number.isInteger(maxAge) ? { MaxAgeSeconds: maxAge } : {}),
    };
  });
}

function corsXml(rules: CorsRule[]) {
  const tags = (name: string, values?: string[]) => (values ?? []).map((value) => `<${name}>${xmlText(value)}</${name}>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${rules.map((rule) => `<CORSRule>${rule.ID ? `<ID>${xmlText(rule.ID)}</ID>` : ""}${tags("AllowedOrigin", rule.AllowedOrigins)}${tags("AllowedMethod", rule.AllowedMethods)}${tags("AllowedHeader", rule.AllowedHeaders)}${tags("ExposeHeader", rule.ExposeHeaders)}${rule.MaxAgeSeconds === undefined ? "" : `<MaxAgeSeconds>${rule.MaxAgeSeconds}</MaxAgeSeconds>`}</CORSRule>`).join("")}</CORSConfiguration>`;
}

async function ensureUploadCors(origin: string) {
  if (uploadCorsReady) return uploadCorsReady;
  uploadCorsReady = (async () => {
    const { client } = storageConfig();
    const allowedOrigins = new Set([
      "https://dawar-todo.dawar185924.chatgpt.site",
      "https://work.dawar.ca",
      ...(origin.startsWith("https://") ? [origin] : []),
    ]);
    const corsUrl = storageUrl(undefined, { cors: "" });
    const current = await client.fetch(corsUrl, { method: "GET" });
    let rules: CorsRule[];
    if (current.ok) rules = parseCorsRules(await current.text());
    else if (current.status === 404) rules = [];
    else throw await storageResponseError("Image storage CORS lookup", current);
    const ruleId = "dawar-todo-private-upload";
    const existing = rules.find((rule) => rule.ID === ruleId);
    const desiredOrigins = [...new Set([...(existing?.AllowedOrigins ?? []), ...allowedOrigins])];
    const alreadyConfigured = existing
      && desiredOrigins.every((value) => existing.AllowedOrigins?.includes(value))
      && existing.AllowedMethods?.includes("PUT")
      && existing.AllowedHeaders?.includes("*");
    if (!alreadyConfigured) {
      const nextRule = {
        ID: ruleId,
        AllowedOrigins: desiredOrigins,
        AllowedMethods: ["PUT"],
        AllowedHeaders: ["*"],
        ExposeHeaders: ["ETag"],
        MaxAgeSeconds: 3600,
      };
      const response = await client.fetch(corsUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/xml" },
        body: corsXml([...rules.filter((rule) => rule.ID !== ruleId), nextRule]),
      });
      if (!response.ok) throw await storageResponseError("Image storage CORS update", response);
      console.info("[todo-attachments] upload CORS configured", { origins: desiredOrigins.length });
    }
  })().catch((error) => {
    uploadCorsReady = null;
    throw error;
  });
  return uploadCorsReady;
}

function targetValues(target: UploadTarget) {
  const isDraft = "draftToken" in target;
  return {
    isDraft,
    draftToken: isDraft ? validateDraftToken(target.draftToken) : null,
    todoId: isDraft ? null : target.todoId,
  };
}

async function signedPutUrl(key: string, contentType: string) {
  const url = storageUrl(key, { "X-Amz-Expires": String(15 * 60) });
  const request = await storageConfig().client.sign(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    aws: { signQuery: true, allHeaders: true },
  });
  return request.url;
}

export async function prepareTodoAttachmentUpload(
  input: PrepareUploadInput,
  target: UploadTarget,
  origin: string,
) {
  const startedAt = Date.now();
  const byteSize = Number(input.byteSize);
  if (!Number.isInteger(byteSize) || byteSize < 1) throw new Error("That image is empty.");
  if (byteSize > MAX_ATTACHMENT_BYTES) throw new Error("Images are limited to 20 MB each.");
  const fileName = cleanFileName(input.fileName);
  const mimeType = normalizedMimeType(input.mimeType, fileName);
  const db = database();
  const { isDraft, draftToken, todoId } = targetValues(target);
  if (todoId !== null) {
    const todo = await db.prepare("SELECT id FROM todos WHERE id = ?").bind(todoId).first<{ id: number }>();
    if (!todo) throw new Error("Task not found.");
  }
  const count = todoId === null
    ? await db.prepare("SELECT COUNT(*) AS count FROM todo_attachments WHERE draft_token = ? AND upload_state = 'ready' AND deleted_at IS NULL").bind(draftToken).first<{ count: number }>()
    : await db.prepare("SELECT COUNT(*) AS count FROM todo_attachments WHERE todo_id = ? AND upload_state = 'ready' AND deleted_at IS NULL").bind(todoId).first<{ count: number }>();
  if (Number(count?.count ?? 0) >= MAX_ATTACHMENTS_PER_TASK) {
    throw new Error(`Tasks are limited to ${MAX_ATTACHMENTS_PER_TASK} images.`);
  }

  await ensureUploadCors(origin);
  const id = crypto.randomUUID();
  const base = `todo-images/${id}`;
  const originalKey = `${base}/original.${extensionForMimeType(mimeType)}`;
  const displayKey = `${base}/display.webp`;
  const thumbnailKey = `${base}/thumb.webp`;
  try {
    const nextOrder = Number(count?.count ?? 0);
    const expiresAt = new Date(Date.now() + DRAFT_LIFETIME_HOURS * 60 * 60 * 1000).toISOString();
    const row = await db.prepare(`
      INSERT INTO todo_attachments (
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
    if (!row) throw new Error("The image upload could not be prepared.");
    const [originalUrl, displayUrl, thumbnailUrl] = await Promise.all([
      signedPutUrl(originalKey, mimeType),
      signedPutUrl(displayKey, "image/webp"),
      signedPutUrl(thumbnailKey, "image/webp"),
    ]);
    console.info("[todo-attachments] direct upload prepared", {
      attachmentId: id,
      todoId,
      draft: isDraft,
      bytes: byteSize,
      durationMs: Date.now() - startedAt,
    });
    return { uploadId: id, putUrls: { original: originalUrl, display: displayUrl, thumbnail: thumbnailUrl } };
  } catch (error) {
    await db.prepare("DELETE FROM todo_attachments WHERE id = ? AND upload_state = 'uploading'").bind(id).run().catch(() => undefined);
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
  const response = await storageFetch(storageUrl(key), { method: "GET", headers: { Range: "bytes=0-65535" } });
  return new Uint8Array(await response.arrayBuffer());
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
  const keys = [row.original_key, row.display_key, row.thumbnail_key];
  try {
    const [originalHead, displayHead, thumbnailHead, originalBytes, displayBytes, thumbnailBytes] = await Promise.all([
      storageFetch(storageUrl(row.original_key), { method: "HEAD" }),
      storageFetch(storageUrl(row.display_key), { method: "HEAD" }),
      storageFetch(storageUrl(row.thumbnail_key), { method: "HEAD" }),
      firstBytes(row.original_key),
      firstBytes(row.display_key),
      firstBytes(row.thumbnail_key),
    ]);
    const originalSize = Number(originalHead.headers.get("content-length") ?? 0);
    const displaySize = Number(displayHead.headers.get("content-length") ?? 0);
    const thumbnailSize = Number(thumbnailHead.headers.get("content-length") ?? 0);
    if (originalSize < 1 || originalSize > MAX_ATTACHMENT_BYTES || displaySize < 1 || displaySize > 8 * 1024 * 1024 || thumbnailSize < 1 || thumbnailSize > 2 * 1024 * 1024) {
      throw new Error("One or more uploaded image files has an invalid size.");
    }
    const expected = normalizedFormat(row.mime_type);
    const originalFormat = detectedImageFormat(originalBytes);
    if (!originalFormat || (expected !== originalFormat && !(expected === "heif" && originalFormat === "heic") && !(expected === "heic" && originalFormat === "heif"))) {
      throw new Error("The uploaded file is not the expected image type.");
    }
    if (detectedImageFormat(displayBytes) !== "webp" || detectedImageFormat(thumbnailBytes) !== "webp") {
      throw new Error("The optimized image files are invalid.");
    }
    const originalDimensions = inspectedImageDimensions(originalBytes, originalFormat);
    const displayDimensions = inspectedImageDimensions(displayBytes, "webp");
    const thumbnailDimensions = inspectedImageDimensions(thumbnailBytes, "webp");
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
      WHERE id = ? AND upload_state = 'uploading'
      RETURNING *
    `).bind(width, height, originalSize, id).first<AttachmentRow>();
    if (!finalized) throw new Error("The uploaded image could not be finalized.");
    console.info("[todo-attachments] direct upload finalized", {
      attachmentId: id,
      todoId,
      bytes: originalSize,
      displayBytes: displaySize,
      thumbnailBytes: thumbnailSize,
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
    try {
      await deleteKeys(keys);
      await db.prepare("DELETE FROM todo_attachments WHERE id = ? AND upload_state = 'uploading'").bind(id).run();
    } catch (cleanupError) {
      console.error("[todo-attachments] invalid direct upload cleanup failed", { attachmentId: id, cleanupError });
    }
    console.error("[todo-attachments] direct upload finalize failed", { attachmentId: id, todoId, durationMs: Date.now() - startedAt, error });
    throw error;
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
  await deleteKeys([row.original_key, row.display_key, row.thumbnail_key]);
  await db.prepare("DELETE FROM todo_attachments WHERE id = ?").bind(id).run();
  console.info("[todo-attachments] draft removed", { attachmentId: id });
  return true;
}

export async function discardTodoAttachmentUpload(todoId: number, id: string) {
  const db = database();
  const row = await db.prepare(`
    SELECT * FROM todo_attachments
    WHERE id = ? AND todo_id = ? AND upload_state = 'uploading' AND deleted_at IS NULL
  `).bind(id, todoId).first<AttachmentRow>();
  if (!row) return false;
  await deleteKeys([row.original_key, row.display_key, row.thumbnail_key]);
  await db.prepare("DELETE FROM todo_attachments WHERE id = ? AND upload_state = 'uploading'").bind(id).run();
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
  if (ids.length > MAX_ATTACHMENTS_PER_TASK) throw new Error(`Tasks are limited to ${MAX_ATTACHMENTS_PER_TASK} images.`);
  const token = validateDraftToken(draftToken ?? "");
  const db = database();
  const placeholders = ids.map(() => "?").join(", ");
  const result = await db.prepare(`
    SELECT id FROM todo_attachments
    WHERE id IN (${placeholders}) AND draft_token = ? AND todo_id IS NULL
      AND upload_state = 'ready' AND deleted_at IS NULL
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).bind(...ids, token).all<{ id: string }>();
  if (result.results.length !== ids.length) throw new Error("One or more attached images are no longer available.");
  const statements = ids.map((id, sortOrder) => db.prepare(`
    UPDATE todo_attachments
    SET todo_id = ?, draft_token = NULL, expires_at = NULL, sort_order = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND draft_token = ? AND todo_id IS NULL
      AND upload_state = 'ready' AND deleted_at IS NULL
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
    WHERE todo_id IN (${placeholders}) AND upload_state = 'ready' AND deleted_at IS NULL
    ORDER BY todo_id, sort_order, created_at
  `).bind(...todoIds).all<AttachmentRow>();
  return result.results;
}

export function restoreAttachmentStatements(db: D1Database, rows: AttachmentRow[]) {
  const restore = db.prepare(`
    INSERT INTO todo_attachments (
      id, todo_id, draft_token, original_key, display_key, thumbnail_key,
      file_name, mime_type, byte_size, width, height, upload_state, sort_order,
      expires_at, deleted_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      todo_id = excluded.todo_id,
      draft_token = excluded.draft_token,
      upload_state = excluded.upload_state,
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

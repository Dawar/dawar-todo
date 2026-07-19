import { env, waitUntil } from "cloudflare:workers";

export const MAX_ATTACHMENTS_PER_TASK = 12;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_AUDIO_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_AUDIO_DURATION_MS = 30 * 60 * 1000;
export const MAX_VIDEO_ATTACHMENT_BYTES = 250 * 1024 * 1024;
export const MAX_VIDEO_DURATION_MS = 60 * 60 * 1000;
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

type StorageConfig = { bucket: string; endpoint: URL; region: string };

let cachedStorageConfig: StorageConfig | null = null;

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
  kind: "image" | "audio" | "video";
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
  kind: "image" | "audio" | "video";
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
  // DigitalOcean's JavaScript S3 guidance uses the AWS-compatible signing
  // region while the physical Spaces region remains encoded in the endpoint.
  const signingRegion = endpointUrl.hostname.endsWith(".digitaloceanspaces.com")
    ? "us-east-1"
    : endpointRegion;
  cachedStorageConfig = {
    bucket: current.S3_BUCKET,
    endpoint: endpointUrl,
    region: signingRegion,
  };
  console.info("[todo-attachments] private storage configured", {
    endpointRegion,
    signingRegion,
    virtualHosted: true,
  });
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
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error("That attachment draft is invalid.");
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

async function signedStorageResponse(url: URL, init?: RequestInit) {
  const method = init?.method ?? "GET";
  const { bucket, endpoint } = storageConfig();
  const serverUrl = new URL(url);
  serverUrl.hostname = endpoint.hostname;
  serverUrl.pathname = `/${encodeURIComponent(bucket)}${url.pathname}`;
  const request = await signedHeaderRequest(serverUrl, method, init?.headers);
  return fetch(request);
}

async function storageFetch(url: URL, init?: RequestInit) {
  const response = await signedStorageResponse(url, init);
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
  await Promise.all([...new Set(keys.filter(Boolean))].map(async (key) => {
    const response = await signedStorageResponse(storageUrl(key), { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw await storageResponseError("Private image cleanup", response);
  }));
}

async function signedObjectUrl(key: string, downloadName?: string) {
  const url = storageUrl(key, {
    ...(downloadName ? { "response-content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}` } : {}),
  });
  return signedQueryUrl(url, "GET", SIGNED_URL_SECONDS);
}

async function mapAttachment(row: AttachmentRow): Promise<TodoAttachment> {
  const kind = row.kind ?? "image";
  const [originalUrl, inlineOriginalUrl] = await Promise.all([
    signedObjectUrl(row.original_key, row.file_name),
    kind === "image" ? Promise.resolve("") : signedObjectUrl(row.original_key),
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
  kind: "audio" | "video";
  fileName: string;
  mimeType: string;
  byteSize: number;
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

function normalizedAudioMimeType(value: string) {
  const supplied = value.toLowerCase().split(";", 1)[0].trim();
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

function normalizedVideoMimeType(value: string) {
  const supplied = value.toLowerCase().split(";", 1)[0].trim();
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

function hmac(key: string | ArrayBuffer, value: string) {
  const bytes = typeof key === "string" ? new TextEncoder().encode(key) : key;
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    .then((cryptoKey) => crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)));
}

function hex(value: ArrayBuffer) {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function awsEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function signatureKey(date: string, region: string) {
  return hmac(`AWS4${runtime().S3_ACCESS_KEY}`, date)
    .then((dateKey) => hmac(dateKey, region))
    .then((regionKey) => hmac(regionKey, "s3"))
    .then((serviceKey) => hmac(serviceKey, "aws4_request"));
}

async function sha256Hex(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function signedHeaderRequest(input: URL, method: string, inputHeaders?: HeadersInit) {
  const current = runtime();
  const { region } = storageConfig();
  const url = new URL(input);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const payloadHash = await sha256Hex("");
  const headers = new Headers(inputHeaders);
  headers.set("x-amz-content-sha256", payloadHash);
  headers.set("x-amz-date", amzDate);
  const canonicalPath = url.pathname.split("/").map((segment) => {
    try { return awsEncode(decodeURIComponent(segment)); } catch { return awsEncode(segment); }
  }).join("/");
  const canonicalQuery = [...url.searchParams]
    .map(([name, value]) => [awsEncode(name), awsEncode(value)] as const)
    .sort(([nameA, valueA], [nameB, valueB]) => nameA < nameB ? -1 : nameA > nameB ? 1 : valueA < valueB ? -1 : valueA > valueB ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = [
    `host:${url.host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    "",
  ].join("\n");
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const signature = hex(await hmac(await signatureKey(date, region), stringToSign));
  headers.set("Authorization", `AWS4-HMAC-SHA256 Credential=${current.S3_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
  return new Request(url, { method, headers });
}

async function signedQueryUrl(input: URL, method: string, expires: number) {
  const current = runtime();
  const { region } = storageConfig();
  const url = new URL(input);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${current.S3_ACCESS_KEY_ID}/${scope}`);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", String(expires));
  url.searchParams.set("X-Amz-SignedHeaders", "host");
  const canonicalPath = url.pathname.split("/").map((segment) => {
    try { return awsEncode(decodeURIComponent(segment)); } catch { return awsEncode(segment); }
  }).join("/");
  const canonicalQuery = [...url.searchParams]
    .map(([name, value]) => [awsEncode(name), awsEncode(value)] as const)
    .sort(([nameA, valueA], [nameB, valueB]) => nameA < nameB ? -1 : nameA > nameB ? 1 : valueA < valueB ? -1 : valueA > valueB ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath,
    canonicalQuery,
    `host:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const requestHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRequest));
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(requestHash)].join("\n");
  url.searchParams.set("X-Amz-Signature", hex(await hmac(await signatureKey(date, region), stringToSign)));
  return url.toString().replaceAll("+", "%20");
}

async function signedPostTarget(key: string, contentType: string, maximumBytes: number) {
  const current = runtime();
  const { bucket, endpoint, region } = storageConfig();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const credential = `${current.S3_ACCESS_KEY_ID}/${date}/${region}/s3/aws4_request`;
  const fields = {
    key,
    "Content-Type": contentType,
    success_action_status: "204",
    "x-amz-algorithm": "AWS4-HMAC-SHA256",
    "x-amz-credential": credential,
    "x-amz-date": amzDate,
  };
  const policy = btoa(JSON.stringify({
    expiration: new Date(now.valueOf() + 15 * 60 * 1000).toISOString(),
    conditions: [
      { bucket },
      { key },
      { "Content-Type": contentType },
      { success_action_status: "204" },
      { "x-amz-algorithm": fields["x-amz-algorithm"] },
      { "x-amz-credential": credential },
      { "x-amz-date": amzDate },
      ["content-length-range", 1, maximumBytes],
    ],
  }));
  const signingKey = await signatureKey(date, region);
  return {
    url: new URL(`https://${bucket}.${endpoint.hostname}/`).toString(),
    fields: { ...fields, policy, "x-amz-signature": hex(await hmac(signingKey, policy)) },
  };
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
  const count = todoId === null
    ? await db.prepare("SELECT COUNT(*) AS count FROM todo_attachments WHERE draft_token = ? AND deleted_at IS NULL").bind(draftToken).first<{ count: number }>()
    : await db.prepare("SELECT COUNT(*) AS count FROM todo_attachments WHERE todo_id = ? AND deleted_at IS NULL").bind(todoId).first<{ count: number }>();
  if (Number(count?.count ?? 0) >= MAX_ATTACHMENTS_PER_TASK) {
    throw new Error(`Tasks are limited to ${MAX_ATTACHMENTS_PER_TASK} attachments.`);
  }

  const id = crypto.randomUUID();
  const base = `todo-images/${id}`;
  const originalKey = `${base}/original.${extensionForMimeType(mimeType)}`;
  const displayKey = `${base}/display.${extensionForMimeType(displayMimeType)}`;
  const thumbnailKey = `${base}/thumb.${extensionForMimeType(thumbnailMimeType)}`;
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
    const [originalUpload, displayUpload, thumbnailUpload] = await Promise.all([
      signedPostTarget(originalKey, mimeType, byteSize),
      signedPostTarget(displayKey, displayMimeType, 8 * 1024 * 1024),
      signedPostTarget(thumbnailKey, thumbnailMimeType, 2 * 1024 * 1024),
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
    // Read probes run first because Spaces returns a useful XML error body for GET,
    // while a failing HEAD response is bodyless and much harder to diagnose.
    const [originalBytes, displayBytes, thumbnailBytes] = await Promise.all([
      firstBytes(row.original_key),
      firstBytes(row.display_key),
      firstBytes(row.thumbnail_key),
    ]);
    const [originalHead, displayHead, thumbnailHead] = await Promise.all([
      storageFetch(storageUrl(row.original_key), { method: "HEAD" }),
      storageFetch(storageUrl(row.display_key), { method: "HEAD" }),
      storageFetch(storageUrl(row.thumbnail_key), { method: "HEAD" }),
    ]);
    const originalSize = Number(originalHead.headers.get("content-length") ?? 0);
    const displaySize = Number(displayHead.headers.get("content-length") ?? 0);
    const thumbnailSize = Number(thumbnailHead.headers.get("content-length") ?? 0);
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
  const maximumBytes = kind === "audio" ? MAX_AUDIO_ATTACHMENT_BYTES : MAX_VIDEO_ATTACHMENT_BYTES;
  if (!Number.isInteger(byteSize) || byteSize < 1) throw new Error(`That ${kind} file is empty.`);
  if (byteSize > maximumBytes) throw new Error(kind === "audio" ? "Voice memos are limited to 50 MB." : "Videos are limited to 250 MB.");
  const fileName = cleanFileName(input.fileName || (kind === "audio" ? "voice memo" : "video"));
  const mimeType = kind === "audio" ? normalizedAudioMimeType(input.mimeType) : normalizedVideoMimeType(input.mimeType);
  const db = database();
  const { isDraft, draftToken, todoId } = targetValues(target);
  if (todoId !== null) {
    const todo = await db.prepare("SELECT id FROM todos WHERE id = ?").bind(todoId).first<{ id: number }>();
    if (!todo) throw new Error("Task not found.");
  }
  const count = todoId === null
    ? await db.prepare("SELECT COUNT(*) AS count FROM todo_attachments WHERE draft_token = ? AND deleted_at IS NULL").bind(draftToken).first<{ count: number }>()
    : await db.prepare("SELECT COUNT(*) AS count FROM todo_attachments WHERE todo_id = ? AND deleted_at IS NULL").bind(todoId).first<{ count: number }>();
  if (Number(count?.count ?? 0) >= MAX_ATTACHMENTS_PER_TASK) throw new Error(`Tasks are limited to ${MAX_ATTACHMENTS_PER_TASK} attachments.`);

  const id = crypto.randomUUID();
  const extension = kind === "audio" ? audioExtension(mimeType) : videoExtension(mimeType);
  const base = `todo-media/${id}`;
  const originalKey = `${base}/original.${extension}`;
  const displayKey = `${base}/no-display`;
  const thumbnailKey = `${base}/no-thumbnail`;
  const expiresAt = new Date(Date.now() + DRAFT_LIFETIME_HOURS * 60 * 60 * 1000).toISOString();
  try {
    const row = await db.prepare(`
      INSERT INTO todo_attachments (
        id, todo_id, draft_token, original_key, display_key, thumbnail_key,
        file_name, mime_type, byte_size, width, height, kind, duration_ms,
        upload_state, sort_order, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, 'uploading', ?, ?)
      RETURNING *
    `).bind(
      id, todoId, draftToken, originalKey, displayKey, thumbnailKey,
      fileName, mimeType, byteSize, kind, Number(count?.count ?? 0), expiresAt,
    ).first<AttachmentRow>();
    if (!row) throw new Error(`The ${kind} upload could not be prepared.`);
    const originalUpload = await signedPostTarget(originalKey, mimeType, maximumBytes);
    console.info("[todo-attachments] media upload prepared", {
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
    await db.prepare("DELETE FROM todo_attachments WHERE id = ? AND upload_state = 'uploading'").bind(id).run().catch(() => undefined);
    console.error("[todo-attachments] media upload preparation failed", { attachmentId: id, todoId, kind, bytes: byteSize, error });
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
  const durationMs = Math.round(Number(input.durationMs));
  if (!Number.isInteger(durationMs) || durationMs < 1) throw new Error("The media duration could not be read.");
  const db = database();
  const { draftToken, todoId } = targetValues(target);
  const row = todoId === null
    ? await db.prepare("SELECT * FROM todo_attachments WHERE id = ? AND draft_token = ? AND todo_id IS NULL AND deleted_at IS NULL").bind(id, draftToken).first<AttachmentRow>()
    : await db.prepare("SELECT * FROM todo_attachments WHERE id = ? AND todo_id = ? AND deleted_at IS NULL").bind(id, todoId).first<AttachmentRow>();
  if (!row || (row.kind !== "audio" && row.kind !== "video")) throw new Error("That media upload is no longer available.");
  if (row.upload_state === "ready") return mapAttachment(row);
  const maximumBytes = row.kind === "audio" ? MAX_AUDIO_ATTACHMENT_BYTES : MAX_VIDEO_ATTACHMENT_BYTES;
  const maximumDuration = row.kind === "audio" ? MAX_AUDIO_DURATION_MS : MAX_VIDEO_DURATION_MS;
  if (durationMs > maximumDuration) throw new Error(row.kind === "audio" ? "Voice memos are limited to 30 minutes." : "Videos are limited to 60 minutes.");
  try {
    const [bytes, head] = await Promise.all([
      firstBytes(row.original_key),
      storageFetch(storageUrl(row.original_key), { method: "HEAD" }),
    ]);
    const actualBytes = Number(head.headers.get("content-length") ?? 0);
    if (actualBytes < 1 || actualBytes > maximumBytes || actualBytes !== row.byte_size) throw new Error("The media upload is incomplete.");
    const actualFormat = detectedMediaFormat(bytes);
    const expectedFormat = row.kind === "audio" ? expectedAudioFormat(row.mime_type) : expectedVideoFormat(row.mime_type);
    if (!actualFormat || actualFormat !== expectedFormat) throw new Error(`The uploaded file is not the expected ${row.kind} type.`);
    const finalized = await db.prepare(`
      UPDATE todo_attachments
      SET duration_ms = ?, byte_size = ?, upload_state = 'ready',
          expires_at = CASE WHEN todo_id IS NULL THEN expires_at ELSE NULL END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND upload_state = 'uploading'
      RETURNING *
    `).bind(durationMs, actualBytes, id).first<AttachmentRow>();
    if (!finalized) throw new Error("The media upload could not be finalized.");
    console.info("[todo-attachments] media upload finalized", {
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
    try {
      await deleteKeys(attachmentObjectKeys(row));
      await db.prepare("DELETE FROM todo_attachments WHERE id = ? AND upload_state = 'uploading'").bind(id).run();
    } catch (cleanupError) {
      console.error("[todo-attachments] invalid media cleanup failed", { attachmentId: id, cleanupError });
    }
    console.error("[todo-attachments] media upload finalize failed", { attachmentId: id, todoId, kind: row.kind, durationMs: Date.now() - startedAt, error });
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
  await deleteKeys(attachmentObjectKeys(row));
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
  await deleteKeys(attachmentObjectKeys(row));
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
  if (ids.length > MAX_ATTACHMENTS_PER_TASK) throw new Error(`Tasks are limited to ${MAX_ATTACHMENTS_PER_TASK} attachments.`);
  const token = validateDraftToken(draftToken ?? "");
  const db = database();
  const placeholders = ids.map(() => "?").join(", ");
  const result = await db.prepare(`
    SELECT id FROM todo_attachments
    WHERE id IN (${placeholders}) AND draft_token = ? AND todo_id IS NULL
      AND upload_state = 'ready' AND deleted_at IS NULL
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).bind(...ids, token).all<{ id: string }>();
  if (result.results.length !== ids.length) throw new Error("One or more attachments are no longer available.");
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
    throw new Error("The attachments could not be linked to the task.");
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
      file_name, mime_type, byte_size, width, height, kind, duration_ms,
      upload_state, sort_order, expires_at, deleted_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      todo_id = excluded.todo_id,
      draft_token = excluded.draft_token,
      kind = excluded.kind,
      duration_ms = excluded.duration_ms,
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

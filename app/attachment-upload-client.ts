"use client";

import type { TodoAttachment } from "../db/attachments";
import { attachmentFileMimeType } from "../lib/attachment-files";

export type BrowserAttachmentKind = "image" | "audio" | "video" | "file";

type PrivatePostTarget = {
  url: string;
  fields: Record<string, string>;
};

type PreparedImageUpload = {
  uploadId: string;
  uploads: {
    original: PrivatePostTarget;
    display: PrivatePostTarget;
    thumbnail: PrivatePostTarget;
  };
};

type PreparedMediaUpload = {
  uploadId: string;
  uploads: {
    original: PrivatePostTarget;
  };
};

type OptimizedImage = {
  blob: Blob;
  mimeType: "image/webp" | "image/jpeg";
  format: "webp" | "jpeg";
};

type JsonRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

const MAX_IMAGE_PIXELS = 100_000_000;

function imageMimeType(file: File) {
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
      // Safari can decode HEIC through an image element when createImageBitmap cannot.
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

function canvasBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("This browser could not optimize the image.")),
      mimeType,
      quality,
    );
  });
}

async function encodedImageFormat(blob: Blob) {
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg" as const;
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "webp" as const;
  return null;
}

async function optimizedImage(
  source: CanvasImageSource,
  width: number,
  height: number,
  maxDimension: number,
  quality: number,
): Promise<OptimizedImage> {
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

  // Safari may return PNG bytes for a requested WebP. Flatten transparency and
  // use JPEG so the storage validator receives bytes matching the declared type.
  context.globalCompositeOperation = "destination-over";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, outputWidth, outputHeight);
  context.globalCompositeOperation = "source-over";
  const jpeg = await canvasBlob(canvas, "image/jpeg", quality);
  if (await encodedImageFormat(jpeg) !== "jpeg") {
    throw new Error("This browser could not create a compatible optimized image.");
  }
  return { blob: jpeg, mimeType: "image/jpeg", format: "jpeg" };
}

async function imageVariants(file: File) {
  const decoded = await decodedImage(file).catch(() => {
    throw new Error("This image format cannot be read on this device.");
  });
  try {
    const { width, height, source } = decoded;
    if (!width || !height || width * height > MAX_IMAGE_PIXELS) {
      throw new Error("That image is too large to process.");
    }
    const startedAt = performance.now();
    const [display, thumbnail] = await Promise.all([
      optimizedImage(source, width, height, 2048, 0.82),
      optimizedImage(source, width, height, 480, 0.75),
    ]);
    console.info("[todo-attachment-client] image variants prepared", {
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

async function uploadStorageObject(target: PrivatePostTarget, body: Blob) {
  const form = new FormData();
  Object.entries(target.fields).forEach(([name, value]) => form.append(name, value));
  form.append("file", body, "upload");
  const response = await fetch(target.url, { method: "POST", mode: "no-cors", body: form });
  if (response.type !== "opaque" && !response.ok) {
    throw new Error(`Private storage rejected an upload (${response.status}).`);
  }
}

function mediaMimeType(file: File, kind: "audio" | "video") {
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
    media.preload = "metadata";
    media.onloadedmetadata = () => {
      const durationMs = Math.round(media.duration * 1000);
      cleanup();
      if (!Number.isFinite(durationMs) || durationMs < 1) {
        reject(new Error(`This ${kind} file's duration could not be read.`));
      } else {
        resolve(durationMs);
      }
    };
    media.onerror = () => {
      cleanup();
      reject(new Error(`This ${kind} file cannot be read on this device.`));
    };
    media.src = objectUrl;
  });
}

export async function uploadTaskAttachment(input: {
  file: File;
  kind: BrowserAttachmentKind;
  durationMs?: number;
  endpoint: string;
  request: JsonRequest;
  discard: (uploadId: string) => Promise<unknown>;
}) {
  const startedAt = performance.now();
  const { file, kind, endpoint, request, discard } = input;
  console.info("[todo-attachment-client] browser upload started", {
    endpoint,
    kind,
    bytes: file.size,
    suppliedMimeType: file.type,
  });
  try {
    if (kind === "image") {
      const mimeType = imageMimeType(file);
      if (!mimeType) throw new Error("Choose a JPEG, PNG, WebP, GIF, HEIC, or HEIF image.");
      const variants = await imageVariants(file);
      const prepared = await request<PreparedImageUpload>(endpoint, {
        method: "POST",
        body: JSON.stringify({
          kind,
          fileName: file.name || "image",
          mimeType,
          byteSize: file.size,
          displayMimeType: variants.display.mimeType,
          thumbnailMimeType: variants.thumbnail.mimeType,
        }),
      });
      try {
        const uploads = await Promise.allSettled([
          uploadStorageObject(prepared.uploads.original, file),
          uploadStorageObject(prepared.uploads.display, variants.display.blob),
          uploadStorageObject(prepared.uploads.thumbnail, variants.thumbnail.blob),
        ]);
        const failed = uploads.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed) throw failed.reason;
        const payload = await request<{ attachment: TodoAttachment }>(endpoint, {
          method: "PATCH",
          body: JSON.stringify({
            kind,
            uploadId: prepared.uploadId,
            width: variants.width,
            height: variants.height,
          }),
        });
        console.info("[todo-attachment-client] browser upload completed", {
          endpoint,
          attachmentId: payload.attachment.id,
          kind,
          bytes: file.size,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return payload.attachment;
      } catch (error) {
        await discard(prepared.uploadId).catch((discardError) => {
          console.error("[todo-attachment-client] incomplete image cleanup failed", {
            endpoint,
            attachmentId: prepared.uploadId,
            discardError,
          });
        });
        throw error;
      }
    }

    const mimeType = kind === "file" ? attachmentFileMimeType(file.name, file.type) : mediaMimeType(file, kind);
    const durationMs = kind === "file"
      ? 0
      : input.durationMs && input.durationMs > 0
        ? input.durationMs
        : await mediaDuration(file, kind);
    const prepared = await request<PreparedMediaUpload>(endpoint, {
      method: "POST",
      body: JSON.stringify({
        kind,
        fileName: file.name || (kind === "audio" ? "Voice memo" : kind === "video" ? "Video" : "File"),
        mimeType,
        byteSize: file.size,
      }),
    });
    try {
      await uploadStorageObject(prepared.uploads.original, file);
      const payload = await request<{ attachment: TodoAttachment }>(endpoint, {
        method: "PATCH",
        body: JSON.stringify({
          kind,
          uploadId: prepared.uploadId,
          durationMs,
        }),
      });
      console.info("[todo-attachment-client] browser upload completed", {
        endpoint,
        attachmentId: payload.attachment.id,
        kind,
        bytes: file.size,
        mediaDurationMs: durationMs,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return payload.attachment;
    } catch (error) {
      await discard(prepared.uploadId).catch((discardError) => {
        console.error("[todo-attachment-client] incomplete media cleanup failed", {
          endpoint,
          attachmentId: prepared.uploadId,
          kind,
          discardError,
        });
      });
      throw error;
    }
  } catch (error) {
    console.error("[todo-attachment-client] browser upload failed", {
      endpoint,
      kind,
      bytes: file.size,
      durationMs: Math.round(performance.now() - startedAt),
      error,
    });
    throw error;
  }
}

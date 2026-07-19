import { ensureTodoDatabase } from "../../../../db/todos";
import {
  finalizeTodoAttachmentUpload,
  finalizeTodoMediaAttachmentUpload,
  prepareTodoAttachmentUpload,
  prepareTodoMediaAttachmentUpload,
  scheduleAttachmentCleanup,
} from "../../../../db/attachments";

type DraftUploadPayload = {
  draftToken?: string;
  uploadId?: string;
  fileName?: string;
  mimeType?: string;
  byteSize?: number;
  displayMimeType?: string;
  thumbnailMimeType?: string;
  width?: number;
  height?: number;
  kind?: "image" | "audio" | "video";
  durationMs?: number;
};

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    await ensureTodoDatabase();
    const payload = await request.json() as DraftUploadPayload;
    const kind = payload.kind ?? "image";
    if (!(["image", "audio", "video"] as const).includes(kind)) throw new Error("That attachment type is invalid.");
    const target = { draftToken: String(payload.draftToken ?? "") };
    const prepared = kind === "image"
      ? await prepareTodoAttachmentUpload({
          fileName: String(payload.fileName ?? ""),
          mimeType: String(payload.mimeType ?? ""),
          byteSize: Number(payload.byteSize),
          displayMimeType: payload.displayMimeType,
          thumbnailMimeType: payload.thumbnailMimeType,
        }, target)
      : await prepareTodoMediaAttachmentUpload({
          kind,
          fileName: String(payload.fileName ?? ""),
          mimeType: String(payload.mimeType ?? ""),
          byteSize: Number(payload.byteSize),
        }, target);
    await scheduleAttachmentCleanup();
    console.info("[todo-api] draft attachment upload prepared", {
      uploadId: prepared.uploadId,
      bytes: Number(payload.byteSize),
      kind,
      durationMs: Date.now() - startedAt,
    });
    return Response.json(prepared, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The image upload could not be prepared.";
    const inputError = /choose|image|audio|video|media|voice|limited|invalid|large|available|duration/i.test(message);
    console.error("[todo-api] draft attachment preparation failed", { durationMs: Date.now() - startedAt, error });
    return Response.json({ error: message }, { status: inputError ? 400 : 500 });
  }
}

export async function PATCH(request: Request) {
  const startedAt = Date.now();
  try {
    await ensureTodoDatabase();
    const payload = await request.json() as DraftUploadPayload;
    const kind = payload.kind ?? "image";
    if (!(["image", "audio", "video"] as const).includes(kind)) throw new Error("That attachment type is invalid.");
    const target = { draftToken: String(payload.draftToken ?? "") };
    const attachment = kind === "image"
      ? await finalizeTodoAttachmentUpload(String(payload.uploadId ?? ""), {
          width: Number(payload.width),
          height: Number(payload.height),
        }, target)
      : await finalizeTodoMediaAttachmentUpload(String(payload.uploadId ?? ""), {
          durationMs: Number(payload.durationMs),
        }, target);
    console.info("[todo-api] draft attachment finalized", {
      attachmentId: attachment.id,
      kind: attachment.kind,
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ attachment });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The image upload could not be finalized.";
    const inputError = /image|audio|video|media|voice|limited|invalid|large|available|expected|duration/i.test(message);
    console.error("[todo-api] draft attachment finalization failed", { durationMs: Date.now() - startedAt, error });
    return Response.json({ error: message }, { status: inputError ? 400 : 500 });
  }
}

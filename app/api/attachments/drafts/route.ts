import { ensureTodoDatabase } from "../../../../db/todos";
import {
  finalizeTodoAttachmentUpload,
  prepareTodoAttachmentUpload,
  scheduleAttachmentCleanup,
} from "../../../../db/attachments";

type DraftUploadPayload = {
  draftToken?: string;
  uploadId?: string;
  fileName?: string;
  mimeType?: string;
  byteSize?: number;
  width?: number;
  height?: number;
};

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    await ensureTodoDatabase();
    const payload = await request.json() as DraftUploadPayload;
    const prepared = await prepareTodoAttachmentUpload({
      fileName: String(payload.fileName ?? ""),
      mimeType: String(payload.mimeType ?? ""),
      byteSize: Number(payload.byteSize),
    }, { draftToken: String(payload.draftToken ?? "") }, new URL(request.url).origin);
    await scheduleAttachmentCleanup();
    console.info("[todo-api] draft attachment upload prepared", {
      uploadId: prepared.uploadId,
      bytes: Number(payload.byteSize),
      durationMs: Date.now() - startedAt,
    });
    return Response.json(prepared, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The image upload could not be prepared.";
    const inputError = /choose|image|limited|invalid|large|available/i.test(message);
    console.error("[todo-api] draft attachment preparation failed", { durationMs: Date.now() - startedAt, error });
    return Response.json({ error: message }, { status: inputError ? 400 : 500 });
  }
}

export async function PATCH(request: Request) {
  const startedAt = Date.now();
  try {
    await ensureTodoDatabase();
    const payload = await request.json() as DraftUploadPayload;
    const attachment = await finalizeTodoAttachmentUpload(String(payload.uploadId ?? ""), {
      width: Number(payload.width),
      height: Number(payload.height),
    }, { draftToken: String(payload.draftToken ?? "") });
    console.info("[todo-api] draft attachment finalized", {
      attachmentId: attachment.id,
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ attachment });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The image upload could not be finalized.";
    const inputError = /image|limited|invalid|large|available|expected/i.test(message);
    console.error("[todo-api] draft attachment finalization failed", { durationMs: Date.now() - startedAt, error });
    return Response.json({ error: message }, { status: inputError ? 400 : 500 });
  }
}

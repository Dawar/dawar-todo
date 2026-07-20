import {
  finalizeTodoAttachmentUpload,
  finalizeTodoMediaAttachmentUpload,
  listTodoAttachments,
  prepareTodoAttachmentUpload,
  prepareTodoMediaAttachmentUpload,
  scheduleAttachmentCleanup,
} from "../../../../../db/attachments";
import { ensureTodoDatabase, getTodo } from "../../../../../db/todos";

function todoId(value: string) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

type TaskUploadPayload = {
  uploadId?: string;
  fileName?: string;
  mimeType?: string;
  byteSize?: number;
  displayMimeType?: string;
  thumbnailMimeType?: string;
  width?: number;
  height?: number;
  kind?: "image" | "audio" | "video" | "file";
  durationMs?: number;
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: value } = await context.params;
  const id = todoId(value);
  if (!id) return Response.json({ error: "Invalid task." }, { status: 400 });
  try {
    await ensureTodoDatabase();
    if (!await getTodo(id)) return Response.json({ error: "Task not found." }, { status: 404 });
    const attachments = await listTodoAttachments(id);
    await scheduleAttachmentCleanup();
    console.info("[todo-api] attachments listed", { todoId: id, count: attachments.length });
    return Response.json({ attachments });
  } catch (error) {
    console.error("[todo-api] attachment list failed", { todoId: id, error });
    return Response.json({ error: "The attachments could not be loaded." }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: value } = await context.params;
  const id = todoId(value);
  if (!id) return Response.json({ error: "Invalid task." }, { status: 400 });
  const startedAt = Date.now();
  try {
    await ensureTodoDatabase();
    const payload = await request.json() as TaskUploadPayload;
    const kind = payload.kind ?? "image";
    if (!(["image", "audio", "video", "file"] as const).includes(kind)) throw new Error("That attachment type is invalid.");
    const target = { todoId: id };
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
    console.info("[todo-api] task attachment upload prepared", {
      todoId: id,
      uploadId: prepared.uploadId,
      bytes: Number(payload.byteSize),
      kind,
      durationMs: Date.now() - startedAt,
    });
    return Response.json(prepared, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The image upload could not be prepared.";
    const status = /not found/i.test(message) ? 404 : /choose|image|audio|video|media|voice|file|document|archive|limited|large|duration|match/i.test(message) ? 400 : 500;
    console.error("[todo-api] task attachment preparation failed", { todoId: id, durationMs: Date.now() - startedAt, error });
    return Response.json({ error: message }, { status });
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: value } = await context.params;
  const id = todoId(value);
  if (!id) return Response.json({ error: "Invalid task." }, { status: 400 });
  const startedAt = Date.now();
  try {
    await ensureTodoDatabase();
    const payload = await request.json() as TaskUploadPayload;
    const kind = payload.kind ?? "image";
    if (!(["image", "audio", "video", "file"] as const).includes(kind)) throw new Error("That attachment type is invalid.");
    const target = { todoId: id };
    const attachment = kind === "image"
      ? await finalizeTodoAttachmentUpload(String(payload.uploadId ?? ""), {
          width: Number(payload.width),
          height: Number(payload.height),
        }, target)
      : await finalizeTodoMediaAttachmentUpload(String(payload.uploadId ?? ""), {
          durationMs: Number(payload.durationMs),
        }, target);
    console.info("[todo-api] task attachment finalized", {
      todoId: id,
      attachmentId: attachment.id,
      kind: attachment.kind,
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ attachment });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The image upload could not be finalized.";
    const status = /not found|available/i.test(message) ? 404 : /image|audio|video|media|voice|file|document|archive|limited|invalid|large|expected|duration|match/i.test(message) ? 400 : 500;
    console.error("[todo-api] task attachment finalization failed", { todoId: id, durationMs: Date.now() - startedAt, error });
    return Response.json({ error: message }, { status });
  }
}
